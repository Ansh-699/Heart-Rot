/**
 * The four cold-path routes.
 *
 * Nothing here is on the gameplay path. `move`, `shoot` and `enter_gate` go browser → ER
 * directly, signed by the browser's session keypair; the Worker never sees them and could
 * not keep up if it did — its job on these routes costs whole seconds of devnet round
 * trips. `run_worker_first: ["/api/*"]` makes that structural rather than a convention.
 *
 * Almost all of the chain plumbing lives in `@heartrot/client`, which the browser also
 * imports: PDA derivation, the instruction ABI, the router calls, the delegation wait,
 * send and confirm. Two copies of an offset table or an account order is how the browser
 * and the Worker end up disagreeing about the same match, so there is exactly one. What
 * is left in this file is the part that is genuinely backend: the treasury key, which
 * arena is open, and what a request is allowed to ask for.
 */

import {
  address,
  createKeyPairSignerFromPrivateKeyBytes,
  getAddressEncoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  isAddress,
  type Address,
  type KeyPairSigner,
} from '@solana/kit';
import {
  OUTCOME_UNDECIDED,
  OUTCOME_WIN,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_ROLLING,
  PHASE_SETTLED,
  PHASE_SETTLING,
  SEED_BOSS,
  SEED_PLAYERS,
  TICK_MS,
  beginMuster,
  claimSeat,
  confirmSignature,
  connectMatch,
  createRpc,
  decodeArena,
  decodeLeaderboard,
  decodePlayers,
  delegate,
  freeSeats,
  getDelegationStatus,
  initArena,
  initLeaderboard,
  leaderboardPda,
  leaveSeat,
  matchPdas,
  nextIncarnation,
  rollDeadlineTick,
  rollSeed,
  sendInstructions,
  settle,
  type ArenaAccount,
  type DecodedTransactionError,
  type HeartrotRpc,
  writeLeaderboard,
} from '@heartrot/client';

import { identityFromDid, verifyPrivyToken } from './auth';
import type { Env } from './index';

const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');


/**
 * Selectable knight skins, from the reference sheet (game design spec §6). The program
 * does not range-check `skin_id` — it is a render hint, not an index into chain state —
 * so this is the cap, and it is applied server-side like every other client-supplied
 * number here.
 */
const SKIN_COUNT = 3;

/**
 * Selectable classes: knight (0) and archer (1), the two the class bit can name. Unlike
 * `skin_id` the program *does* range-check this — `claim_seat` refuses an unknown class with
 * `InvalidInstructionData` — so this constant exists to turn a version skew into a readable
 * 400 instead of a chain refusal, and it must never clamp. A clamp silently hands an archer
 * a knight's weapon, which from the outside is a balance bug with no error attached.
 */
const CLASS_COUNT = 2;

/**
 * Non-recoverable burn per match: 3 × 300,000 lamports of undelegation session charge
 * plus base-layer fees. Rent is recoverable on close and deliberately excluded — the
 * gauge answers "how many more matches can the treasury start", not "what is it worth".
 */
const LAMPORTS_PER_MATCH = 1_000_000n;

/**
 * `delegate` is three delegations in one instruction — ~12 CPIs and up to 1,924 bytes
 * copied per account — which does not fit the default 200,000 CU.
 */
const DELEGATE_CU = 600_000;

const BASE_CONFIRM_MS = 30_000;
const ER_CONFIRM_MS = 15_000;

/**
 * How long `Arena.tick` must provably stand still before `/api/match/settle` will end a
 * match the program still calls `Fighting`.
 *
 * `settle.rs` describes the crank interval as "a floor, not a guarantee — the scheduler
 * re-queues at `last_execution + interval`, so ticks drift under load rather than
 * catching up". Seconds of silence are therefore an ordinary hiccup, and settling is
 * irreversible: there is no instruction that returns a settled arena to the ER. So the
 * bar here is the same one the browser's own watchdog uses before it calls this route at
 * all — `TICK_STALL_HARD_MS` in app/src/net/subscribe.ts. That number lives on both
 * sides of a boundary the worker cannot import across; what must hold is the inequality,
 * not the equality: this may never be *shorter* than the client's watchdog, or the
 * client asks for a settle the Worker considers unproven and the match cannot end.
 */
const STALL_PROOF_MS = 45_000;

/** A healthy crank moves `tick` every `TICK_MS` (100 ms), so one sample spares the rest. */
const STALL_SAMPLE_MS = 5_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * The slice of Cloudflare's `ExecutionContext` the routes use.
 *
 * `waitUntil` is what keeps arena lifecycle off the player's request. Creating and
 * delegating an arena, and settling an abandoned one, are chain round trips measured in
 * tens of seconds; doing them inline is what produced "the server hit an error it did not
 * expect" — `connectMatch` alone polls up to 600 times across two 30 s phases. Handed to
 * `waitUntil` they run after the response is sent, on Cloudflare's clock rather than the
 * player's, and a failure costs a log line instead of a 500.
 */
export interface RouteContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Per-player, per-match state. Nothing between here and the browser may keep it.
      'cache-control': 'no-store',
    },
  });
}

/** A 400 the caller is allowed to read. Everything else surfaces as an opaque 500. */
export class BadRequest extends Error {}

// ---------------------------------------------------------------------------
// Per-request context
// ---------------------------------------------------------------------------

type Ctx = {
  env: Env;
  programId: Address;
  validatorIdentity: Address;
  treasury: KeyPairSigner;
  /** The paid provider. Every base-layer read and write. */
  base: HeartrotRpc;
};

/**
 * Built fresh per request. Nothing is cached in module scope: an RPC client holds a
 * transport and a signer holds a `CryptoKey`, and request-scoped objects parked in
 * globals are how one player's state ends up in another player's response.
 */
async function context(env: Env): Promise<Ctx> {
  const secret = getBase58Encoder().encode(env.TREASURY_SECRET_KEY);
  if (secret.length !== 64 && secret.length !== 32) {
    throw new Error('TREASURY_SECRET_KEY must be a base58 32- or 64-byte Ed25519 key');
  }

  return {
    env,
    programId: address(env.PROGRAM_ID),
    validatorIdentity: address(env.VALIDATOR_IDENTITY),
    // The 32-byte seed only: kit derives the public half through WebCrypto and the
    // resulting CryptoKey is non-extractable, so the treasury key cannot be read back
    // out of the isolate even by our own code. (workerd refuses `importKey("raw", …)`
    // for a *private* Ed25519 key — the obvious hand-rolled version passes in Node and
    // fails here. This is the path that works under workerd.)
    treasury: await createKeyPairSignerFromPrivateKeyBytes(secret.slice(0, 32)),
    base: createRpc(
      env.BASE_RPC_URL,
      env.BASE_RPC_TOKEN ? `Bearer ${env.BASE_RPC_TOKEN}` : undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function accountData(rpc: HeartrotRpc, account: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(account, { encoding: 'base64' }).send();
  if (!value) return null;
  const raw = atob(value.data[0]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Read an `Arena` from whichever layer currently holds it, and say where that is.
 *
 * A delegated account still exists on the base layer as a zero-byte husk owned by the
 * delegation program, so a base-layer read of a live match returns something that looks
 * like an account and decodes as nothing. Asking the router first is what keeps every
 * caller in this file from having to know which side of the boundary a match is on.
 */
async function readArena(
  c: Ctx,
  arena: Address,
): Promise<{ state: ArenaAccount | null; erFqdn?: string }> {
  const status = await getDelegationStatus(arena, c.env.ROUTER_ENDPOINT);
  // One expression decides both "which layer did this state come from" and "which layer
  // may be written to". Reporting `status.fqdn` on its own would be the same fact stored
  // twice: a router that answered `isDelegated: false` *with* an fqdn would have callers
  // reading the base layer and then sending to the ER.
  const erFqdn = status.isDelegated ? status.fqdn : undefined;
  const rpc = erFqdn === undefined ? c.base : createRpc(erFqdn);
  const data = await accountData(rpc, arena);
  if (!data) return { state: null, erFqdn };
  try {
    return { state: decodeArena(data), erFqdn };
  } catch {
    // Wrong discriminator or wrong version: a husk, or an account we must not touch.
    return { state: null, erFqdn };
  }
}

/**
 * Treasury health, tier 1 (healthy) to 4 (degraded). Tier 4 blocks every route that
 * spends. Players are never funded: ER fees are zero and the ER runs no fee-payer
 * validation at all, so a session keypair that has never existed on chain signs
 * gameplay all match. This measures only our own ability to start further matches.
 */
async function treasuryTier(c: Ctx): Promise<{ lamports: bigint; matches: number; tier: number }> {
  const { value: lamports } = await c.base.getBalance(c.treasury.address).send();
  const matches = Number(lamports / LAMPORTS_PER_MATCH);
  const tier = matches >= 100 ? 1 : matches >= 25 ? 2 : matches >= 5 ? 3 : 4;
  return { lamports, matches, tier };
}

// ---------------------------------------------------------------------------
// Which arena is open, and making it live
// ---------------------------------------------------------------------------

/**
 * Can this settled arena roll into its next incarnation? Pure, local, no network.
 *
 * Split out of the old `rollForward` so the scan can ask the question without paying for
 * the answer: only a win with a seed can roll, and both facts are already in the bytes the
 * scan just read.
 */
function rollable(settled: ArenaAccount): boolean {
  return settled.outcome === OUTCOME_WIN && rollSeed(settled) !== null;
}

/**
 * Roll a won arena into its next incarnation, in the background.
 *
 * This used to run inline inside `openArena`, which meant the first player to join after a
 * boss died paid for a `next_incarnation` transaction and its confirmation — up to 30 s,
 * uncaught — and got "the server hit an error it did not expect" if any of it slipped.
 * They are simply handed a different room now; this one becomes joinable for whoever comes
 * next.
 */
function rollForwardLater(
  c: Ctx,
  ctx: RouteContext,
  pdas: { arena: Address; boss: Address; players: Address },
): void {
  ctx.waitUntil(
    (async () => {
      try {
        const ix = nextIncarnation({
          programId: c.programId,
          // The program checks this against `init::TREASURY`, so the Worker is the only
          // thing that can advance a chain — a player cannot re-roll a boss on demand.
          payer: c.treasury.address,
          ...pdas,
          leaderboard: await leaderboardPda(c.programId),
        });
        await confirmSignature(c.base, await sendInstructions(c.base, c.treasury, [ix]), {
          timeoutMs: BASE_CONFIRM_MS,
        });
        console.log('rollForwardLater: rolled a settled win into its next incarnation');
      } catch {
        // Two joiners race here every time a raid wins, and the loser's tag 15 is refused
        // by `LOBBY -> LOBBY` being an illegal edge — the mutex working, not a failure.
      }
    })(),
  );
}

/**
 * Create and delegate an arena in the background so the next request finds it warm.
 *
 * The counterpart to the scan being read-only: something still has to build the room, and
 * this is the only place that does it. Reuses `ensureArena`, which is idempotent — it
 * checks for the account and the delegation record before sending either transaction.
 */
function warmArena(c: Ctx, ctx: RouteContext, arenaId: bigint): void {
  ctx.waitUntil(
    (async () => {
      try {
        const pdas = await matchPdas(c.programId, arenaId);
        await ensureArena(c, arenaId, 1, pdas);
        console.log(`warmArena: ${arenaId} is warm`);
      } catch (error) {
        console.error(`warmArena: ${arenaId} failed`, error);
      }
    })(),
  );
}

/**
 * How many arena ids past the leaderboard's head to consider before giving up. Each step
 * costs a router call and an RPC read, and every step past the first means that many
 * raids are running at once.
 *
 * Why this is not 3. A scan step is only reusable if the arena is absent, in the lobby, or
 * a settled WIN that can roll forward. Anything else — a settled loss, a match abandoned
 * mid-fight, one stranded in `SETTLING` on the ER — occupies its id permanently, because
 * `lastArenaId` only advances when a match actually writes to the leaderboard. Dead ids
 * therefore pile up at the head of the scan and never clear.
 *
 * With 3, three consecutive dead arenas from one afternoon of spike runs put the first
 * free id one step past the horizon and the Worker answered `no_open_arena` to every
 * player, forever, with a free slot sitting immediately behind the wall. Observed on
 * devnet: 1788266869 settled-enrage, 1788266870 stranded SETTLING on the ER, 1788266871
 * settled-enrage, 1788266872 absent and perfectly usable.
 *
 * The loop already creates an arena when it finds an absent id, so the width is the only
 * thing standing between a wall of dead matches and a working game. The common case still
 * returns on step 0 or 1; the wide bound is only paid when the head is genuinely blocked.
 *
 * This counts *occupied* ids only. Ids the loop declines to create at for their PDA bumps
 * are absent, not dead, and are bounded separately by `GRIND_STEPS` — otherwise the grind
 * would spend the dead-match budget and reintroduce the wall this width exists to clear.
 */
const ARENA_SCAN = 12;

/**
 * Extra steps the scan may take *past* `ARENA_SCAN` while walking over ids it declined to
 * create at. These cost a read each but cannot exhaust the scan, because the ids beyond
 * the last match are all absent and one in four is eligible.
 *
 * Measured over 4,000 consecutive ids under the deployed program id: 1,033 eligible
 * (25.8%), mean gap 3.87, p50 3, p95 10, worst 21. 64 is ~3x the worst gap observed, so
 * the walk is bounded by arithmetic rather than by hope — and it still terminates on the
 * declined id if the bound is somehow reached.
 */
const GRIND_STEPS = 64;

/**
 * Both child PDAs of this arena land on bump 255?
 *
 * `assert_pda` searches 255 downwards and costs ~1,500 CU per bump it rejects, so an
 * arena whose `Boss`/`Players` sit at 251/254 pays ~7,500 CU more than one at 255/255 —
 * in every instruction that still searches. `shoot` no longer does (it reads the stored
 * bump and hashes once), but `boss_tick` does, ten times a second for the whole match,
 * and so do `claim_seat`, `delegate`, `settle` and `roll`. Measured spread, identical
 * scenario: `boss_tick` 20-seat max 24,884 CU at 255/255 against 32,384 at 251/254
 * (docs/review/chain-cost.md).
 *
 * Which of the two a match gets is decided entirely by `arena_id`, and this is the only
 * code that has ever chosen one. Only the two *children* are ground: the arena's own bump
 * is searched once in `init_arena` and once in `delegate` and never again, and demanding
 * all three would cut the eligible fraction from 25.8% to 12.8% (measured) to save CU on
 * an instruction that already reserves 600,000.
 *
 * The seeds come from `@heartrot/client` rather than being retyped here, so the grind
 * cannot drift away from the derivation the program actually performs — a prediction of
 * the wrong seeds would be worse than no grind at all.
 */
async function childBumpsCanonical(programId: Address, arena: Address): Promise<boolean> {
  const key = getAddressEncoder().encode(arena);
  const [[, boss], [, players]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: programId, seeds: [SEED_BOSS, key] }),
    getProgramDerivedAddress({ programAddress: programId, seeds: [SEED_PLAYERS, key] }),
  ]);
  return boss === 255 && players === 255;
}

/**
 * The open arena, derived from chain state alone.
 *
 * `Leaderboard` carries `(last_arena_id, last_incarnation)` as its settle-time
 * idempotency key, which makes it the one durable counter this design already has. So
 * no KV, no config, and — the point — no client-supplied id decides which arena a
 * player joins or which one the treasury pays rent for.
 *
 * The scan starts *at* `last_arena_id` rather than after it, because incarnations advance
 * in place: a won raid's next boss is the same arena at N+1, not a new address. Only a
 * chain that has ended — a wipe, an enrage, or a roll the oracle never answered — moves
 * the scan on, and a raid already running on an id leaves the next one untouched.
 */
async function openArena(
  c: Ctx,
  ctx: RouteContext,
): Promise<{ arenaId: bigint; incarnation: number } | null> {
  const board = await accountData(c.base, await leaderboardPda(c.programId));
  // A leaderboard that exists but has recorded nothing reads `last_arena_id == 0`, which
  // is not an arena id at all — `arenaIdField` rejects 0 on the way in, so returning it
  // would make `/api/match/start` answer `wrong_arena` to the correct request forever.
  const last = board ? decodeLeaderboard(board).lastArenaId : 0n;
  const head = last > 0n ? last : 1n;

  // Two bounds, because they guard different things. `occupied` is the original
  // ARENA_SCAN budget: how many unusable *matches* to walk past before giving up. `step`
  // additionally bounds the ids declined for their bumps, which are not matches at all
  // and must not be able to starve the scan of its match budget.
  // One reap and one roll per request. A backlog is somebody else's join to pay for.
  let reaping = false;
  let rolling = false;
  // The first id that is free and canonical: what the Worker will warm if nothing here is
  // joinable. Remembered rather than created, so the scan stays read-only.
  let firstFree: bigint | null = null;
  for (let step = 0, occupied = 0; occupied < ARENA_SCAN && step < ARENA_SCAN + GRIND_STEPS; step++) {
    const arenaId = head + BigInt(step);
    const pdas = await matchPdas(c.programId, arenaId);
    const { state, erFqdn } = await readArena(c, pdas.arena);

    // Never played. `init_arena` will create it at incarnation 1 — the counter is
    // per-arena, so a fresh chain always starts at the base fight.
    //
    // Creation is the one and only moment an `arena_id` gets chosen, so it is the one
    // moment the child PDA bumps every later instruction pays for can be chosen. Declining
    // an id here leaves a permanent hole — nothing records the skip — and that is exactly
    // why the decision has to live inside this loop rather than in a grind helper that
    // returns an id to create at. A helper would create at `head + 3`, leave `head`
    // absent, and then answer the *next* player's request by walking off `head` again,
    // finding `head + 3` taken, and starting a second lobby at `head + 7`. The scan's
    // rendezvous property — every caller stops at the same arena — only survives if the
    // holes stay on the scan's path and get walked over identically every time.
    if (!state) {
      // NEVER CREATED INLINE. Creating an arena is `init_arena` + `delegate` +
      // `connectMatch`, which polls up to 600 times across two 30 s phases — 30-60 s of
      // chain round trips billed to whichever player's click happened to land here, and
      // uncaught, so any of it answers "the server hit an error it did not expect". That
      // is three separate 500s now, all the same shape. The id is remembered and the
      // Worker warms it in the background; this player is handed a warm arena or an
      // honest "try again in a moment".
      if (firstFree === null && (await childBumpsCanonical(c.programId, pdas.arena))) {
        firstFree = arenaId;
      }
      continue;
    }

    if (state.phase === PHASE_LOBBY) return { arenaId, incarnation: state.incarnation };

    if (state.phase === PHASE_SETTLED) {
      // A won arena can roll into its next incarnation — but that is a transaction, and
      // transactions do not belong on a join. This is the path a player takes immediately
      // after killing the boss, so it is the one most likely to be walked by someone
      // impatient, and `next_incarnation` plus a 30 s confirm is exactly the wait that
      // produced the 500 they saw. Roll it in the background and keep looking for a room
      // that is joinable right now.
      if (rollable(state) && !rolling) {
        rolling = true;
        rollForwardLater(c, ctx, pdas);
      }
      // TERMINAL, and it must not spend the budget.
      //
      // A settled arena that cannot roll forward is a loss: `rollForward` refuses locally
      // on `outcome !== OUTCOME_WIN`, with no transaction and no extra read, so this costs
      // nothing to identify. It can never be joined again, and one is produced by every
      // fight that ends in a wipe or an enrage — so counting it toward `occupied` makes the
      // budget shrink by one per lost raid, permanently.
      //
      // That is the wall this file has now hit twice: at ARENA_SCAN 3, and again at 12 with
      // ids 1788266869..80 dead and 1788266885 absent and perfectly usable one step past
      // the horizon. Widening the budget only postpones it, because the accumulator is
      // unbounded and the budget is not. Skipping for free removes the accumulator instead.
      continue;
    }

    // STRANDED, and reapable. An arena still delegated in `SETTLING` has finished its
    // fight and has nobody left to settle it — the only other caller of that route needs a
    // live seated player, and if one existed this arena would not be here. Hand it to the
    // background reaper (capped at one per request) and do not spend budget on it: it is
    // as terminal as a settled loss, it is just still holding its rent and its slot.
    //
    // This is the backstop, not the mechanism. `matchLeave` clears these at the moment the
    // last player goes; this catches the ones whose departure signal never arrived.
    if (state.phase === PHASE_SETTLING && erFqdn !== undefined) {
      if (!reaping) {
        reaping = true;
        reapOne(c, ctx, { arenaId, erFqdn });
      }
      continue;
    }

    // Busy, but not forever: fighting, mustering, mid-settlement or mid-roll. These free up
    // on their own, so they are what the budget is actually for — a bound on how many LIVE
    // raids to walk past before answering "come back in a moment".
    occupied++;
  }
  // Every id in the window is occupied by a match nobody can join. That is a real
  // operational state, not a transient one, so name the range that was tried — a bare
  // null here previously turned into an unexplainable 503 on the player's screen.
  console.warn(
    `openArena: ids ${head}..${head + BigInt(ARENA_SCAN + GRIND_STEPS - 1)} hold no joinable ` +
      `lobby; warming ${firstFree ?? 'nothing — no canonical id in range'}.`,
  );
  // Nothing to join *yet*. Warm the next one in the background so the retry lands, and
  // answer with the 503 the client already has copy for rather than a 500 it does not.
  if (firstFree !== null) warmArena(c, ctx, firstFree);
  return null;
}

/**
 * Make the match's three accounts exist and be live on the ER, and hand back the
 * connection to that ER. Idempotent; whichever player arrives first pays for it.
 *
 * Both writes are separate transactions because they sit on opposite sides of a state
 * machine, not out of caution: `delegate` refuses anything but `PHASE_LOBBY`, and it
 * zeroes the base-layer copy of all three accounts as it runs.
 */
async function ensureArena(
  c: Ctx,
  arenaId: bigint,
  incarnation: number,
  pdas: { arena: Address; boss: Address; players: Address },
): Promise<{ er: HeartrotRpc; erFqdn: string }> {
  if ((await accountData(c.base, pdas.arena)) === null) {
    const ix = initArena({
      programId: c.programId,
      payer: c.treasury.address,
      ...pdas,
      arenaId,
      incarnation,
      validatorIdentity: c.validatorIdentity,
      // The treasury is the crank authority, so the crank signer PDA the validator
      // presents to `boss_tick` derives from this key. It is also the only key
      // `delegate` and `settle` will accept.
      crankAuthority: c.treasury.address,
    });
    try {
      await confirmSignature(c.base, await sendInstructions(c.base, c.treasury, [ix]), {
        timeoutMs: BASE_CONFIRM_MS,
      });
    } catch (error) {
      // Two players can race here and the loser's `init` is rejected by the
      // discriminator-0 check. That is the correct outcome, not a failure — only
      // re-throw if the account genuinely is not there.
      if ((await accountData(c.base, pdas.arena)) === null) throw error;
    }
  }

  const status = await getDelegationStatus(pdas.arena, c.env.ROUTER_ENDPOINT);
  if (!status.isDelegated) {
    const ix = await delegate({ programId: c.programId, payer: c.treasury.address, ...pdas });
    try {
      await confirmSignature(
        c.base,
        await sendInstructions(c.base, c.treasury, [setComputeUnitLimit(DELEGATE_CU), ix]),
        { timeoutMs: BASE_CONFIRM_MS },
      );
    } catch (error) {
      const retry = await getDelegationStatus(pdas.arena, c.env.ROUTER_ENDPOINT);
      if (!retry.isDelegated) throw error;
    }
  }

  // Waits for all three delegation records to name *our* validator and for the ER to
  // have actually cloned them. Both halves matter: `isDelegated: true` can precede the
  // clone, and a transaction sent into that window fails with `InvalidWritableAccount`.
  const connections = await connectMatch({
    baseUrl: c.env.BASE_RPC_URL,
    baseAuthorization: c.env.BASE_RPC_TOKEN ? `Bearer ${c.env.BASE_RPC_TOKEN}` : undefined,
    routerUrl: c.env.ROUTER_ENDPOINT,
    accounts: [pdas.arena, pdas.boss, pdas.players],
    validatorIdentity: c.validatorIdentity,
    ownerProgram: c.programId,
  });
  return { er: connections.er, erFqdn: connections.erFqdn };
}

/**
 * `delegate` is the one instruction here that needs more than the default compute
 * budget. Hand-encoded rather than pulling in `@solana-program/compute-budget` for five
 * bytes: tag 2 is `SetComputeUnitLimit`, argument is a little-endian u32.
 */
function setComputeUnitLimit(units: number) {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_PROGRAM, accounts: [], data };
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | null)?.[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new BadRequest(`missing or malformed field: ${name}`);
  }
  return value;
}

/** u64 as a decimal string, the shape every `arenaId` crosses the wire in. */
function arenaIdField(body: unknown): bigint {
  const raw = field(body, 'arenaId');
  if (!/^[0-9]{1,20}$/.test(raw)) throw new BadRequest('arenaId is not a u64');
  const value = BigInt(raw);
  if (value === 0n || value > 0xffff_ffff_ffff_ffffn) throw new BadRequest('arenaId out of range');
  return value;
}

// ---------------------------------------------------------------------------
// POST /api/session/init
// ---------------------------------------------------------------------------

/**
 * Identity in; a seat and a routing bundle out.
 *
 * `erEndpoint` and `validatorIdentity` in the response are load-bearing, not
 * convenience. A client that resolves its own ER can land on a different validator than
 * the accounts were delegated to, and the wrong ER answers with a correctly-owned
 * account holding silently stale data — no error, no notifications, a motionless boss
 * that reads as a game bug rather than a config one.
 */
/**
 * The backstop for a departure signal that never arrived.
 *
 * `matchLeave` is the primary cleanup and it covers Exit and a closing tab. It cannot
 * cover a browser crash, a killed process or a lost network — `sendBeacon` is best effort
 * by definition. Without something behind it those arenas strand exactly as before, which
 * is the bug this whole change exists to remove.
 *
 * Deliberately NOT a timer. It is background work attached to a request the Worker is
 * already serving, capped at one arena so a join never pays for a backlog, and it runs in
 * `waitUntil` so the player's response has already gone. No cron, no polling, no schedule.
 */
function reapOne(c: Ctx, ctx: RouteContext, dead: { arenaId: bigint; erFqdn: string }): void {
  ctx.waitUntil(
    (async () => {
      try {
        const pdas = await matchPdas(c.programId, dead.arenaId);
        const er = createRpc(dead.erFqdn);
        const ix = settle({ programId: c.programId, payer: c.treasury.address, ...pdas });
        await confirmSignature(er, await sendInstructions(er, c.treasury, [ix]), {
          timeoutMs: ER_CONFIRM_MS,
        });
        console.log(`reapOne: settled stranded arena ${dead.arenaId}`);
      } catch (error) {
        console.error(`reapOne: ${dead.arenaId} failed`, error);
      }
    })(),
  );
}

/**
 * Make sure the arena AFTER the one we just handed out is created and delegated, so the
 * next player only has to claim a seat.
 *
 * This is the whole answer to the cold-start 500. `sessionInit` used to run `init_arena`,
 * `delegate` and `connectMatch` inline on the click of whichever player happened to arrive
 * when the scan reached fresh ground; that player paid ~30-60 s of chain round trips and
 * up to 600 polls inside one request, and any of it could time out or blow the subrequest
 * budget. Moved here, the cost lands on Cloudflare's background clock and the player who
 * triggered it has already been served.
 */
function prewarmNext(c: Ctx, ctx: RouteContext, after: bigint): void {
  ctx.waitUntil(
    (async () => {
      try {
        const arenaId = after + 1n;
        const pdas = await matchPdas(c.programId, arenaId);
        if ((await accountData(c.base, pdas.arena)) !== null) return; // already there
        if (!(await childBumpsCanonical(c.programId, pdas.arena))) return; // ids the scan skips
        await ensureArena(c, arenaId, 1, pdas);
        console.log(`prewarmNext: ${arenaId} is warm`);
      } catch (error) {
        // Never fatal: the inline fallback in sessionInit still creates on demand.
        console.error(`prewarmNext: after ${after} failed`, error);
      }
    })(),
  );
}

export async function sessionInit(env: Env, body: unknown, ctx: RouteContext): Promise<Response> {
  const token = field(body, 'privyToken');
  const sessionPubkey = field(body, 'sessionPubkey');
  if (!isAddress(sessionPubkey)) throw new BadRequest('sessionPubkey is not a valid address');

  const rawSkin = (body as Record<string, unknown>).skinId;
  const skinId = rawSkin === undefined ? 0 : rawSkin;
  if (typeof skinId !== 'number' || !Number.isInteger(skinId) || skinId < 0 || skinId >= SKIN_COUNT) {
    throw new BadRequest('skinId out of range');
  }

  // Defaulted only when absent: the archer (1) is the only class the client sends. 0 stays
  // in range because the chain still accepts it and live seats hold it. An out-of-range
  // value is refused, never clamped.
  const rawClass = (body as Record<string, unknown>).classId;
  const classId = rawClass === undefined ? 1 : rawClass;
  if (
    typeof classId !== 'number' ||
    !Number.isInteger(classId) ||
    classId < 0 ||
    classId >= CLASS_COUNT
  ) {
    throw new BadRequest('classId out of range');
  }

  const did = await verifyPrivyToken(token, env.PRIVY_APP_ID);
  const identity = await identityFromDid(did);

  const c = await context(env);
  const treasury = await treasuryTier(c);
  if (treasury.tier === 4) return json({ error: 'treasury_low', tier: treasury.tier }, 503);

  const open = await openArena(c, ctx);
  if (!open) return json({ error: 'no_open_arena' }, 503);
  const { arenaId, incarnation } = open;
  const pdas = await matchPdas(c.programId, arenaId);
  const { er, erFqdn } = await ensureArena(c, arenaId, incarnation, pdas);

  // The next player must not pay what this one just might have. Background, never inline.
  prewarmNext(c, ctx, arenaId);

  // Two attempts, because seat allocation is a read-then-write against state twenty
  // browsers are racing on. The program is the authority: a seat taken between our read
  // and our write is rejected on chain, and the retry re-reads the roster.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [arenaBytes, playersBytes] = await Promise.all([
      accountData(er, pdas.arena),
      accountData(er, pdas.players),
    ]);
    if (!arenaBytes || !playersBytes) throw new Error('match accounts vanished mid-join');

    const arena = decodeArena(arenaBytes);
    if (arena.phase !== PHASE_LOBBY) return json({ error: 'match_in_progress' }, 409);
    const roster = decodePlayers(playersBytes);

    // Idempotent on `identity`: a returning player whose browser storage was cleared
    // gets their seat back with the new session key written over the old one. Privy
    // identity is the durable record; the session keypair is not. Without this they are
    // locked out of their own seat for the rest of the match.
    const existing = roster.slots.find(
      (slot) => slot.occupied && slot.identity.every((byte, i) => byte === identity[i]),
    );
    // `seat_occupied` is a cache of `session_pubkey != 0`; the slots are the authority,
    // so a seat must be free in both before it is handed out.
    const free = freeSeats(arena.seatOccupied).filter((seat) => !roster.slots[seat]?.occupied);
    const seat = existing ? existing.seat : free[0];
    if (seat === undefined) return json({ error: 'arena_full' }, 409);

    const ix = claimSeat({
      programId: c.programId,
      arena: pdas.arena,
      players: pdas.players,
      treasury: c.treasury.address,
      seat,
      skinId,
      class: classId,
      sessionPubkey,
      identity,
    });

    try {
      await confirmSignature(er, await sendInstructions(er, c.treasury, [ix]), {
        timeoutMs: ER_CONFIRM_MS,
      });
    } catch (error) {
      // Translate the chain's own answer instead of calling it an unexpected server error.
      //
      // `matchStart` has always done this; this loop never did, so every on-chain refusal
      // of `claim_seat` — a seat taken between our read and our write, a match that
      // started in the same window — reached the player as "the server hit an error it did
      // not expect". A refusal is not a fault: it is the program working, and the copy for
      // it already exists.
      const code = refusalCode(error);
      if (code === SEAT_OCCUPIED && attempt === 1) return json({ error: 'seat_contended' }, 409);
      if (code === WRONG_PHASE) return json({ error: 'match_in_progress' }, 409);
      if (attempt === 1) throw error;
      continue;
    }

    // The seat is ours on the wire, but `join` keeps a *returning* identity's existing
    // slot whatever we asked for. Our roster read is one ER round trip old, so a second
    // tab joining under the same Privy identity in that window makes our pick and the
    // chain's disagree — and the browser would then sign every move with a seat whose
    // `session_pubkey` is someone else's, failing on chain forever. Read it back.
    const settledBytes = await accountData(er, pdas.players);
    if (!settledBytes) throw new Error('roster vanished after claim');
    const claimed = decodePlayers(settledBytes).slots.find(
      (slot) => slot.occupied && slot.identity.every((byte, i) => byte === identity[i]),
    );
    if (!claimed) throw new Error('seat not on the roster after a confirmed claim');

    return json({
      seat: claimed.seat,
      arenaId: arenaId.toString(),
      incarnation: arena.incarnation,
      arenaPda: pdas.arena,
      bossPda: pdas.boss,
      playersPda: pdas.players,
      programId: c.programId,
      erEndpoint: erFqdn,
      routerEndpoint: env.ROUTER_ENDPOINT,
      validatorIdentity: c.validatorIdentity,
      tickMs: TICK_MS,
    });
  }

  return json({ error: 'seat_contended' }, 409);
}

// ---------------------------------------------------------------------------
// POST /api/match/start
// ---------------------------------------------------------------------------

/**
 * Arms the match: delegates if that has not happened yet, then schedules the crank.
 *
 * `arenaId` is checked against the arena the Worker computes for itself rather than
 * trusted. Accepting it would let anyone burn ~0.0245 SOL of treasury rent per request
 * by naming ids nobody is playing.
 *
 * Budget 5–15 s for this route and show it in the UI. It is three sequential groups of
 * devnet round trips, and pretending otherwise produces a loader that looks broken.
 */
export async function matchStart(env: Env, body: unknown, ctx: RouteContext): Promise<Response> {
  const token = field(body, 'privyToken');
  const requested = arenaIdField(body);

  await verifyPrivyToken(token, env.PRIVY_APP_ID);

  const c = await context(env);
  const treasury = await treasuryTier(c);
  if (treasury.tier === 4) return json({ error: 'treasury_low', tier: treasury.tier }, 503);

  const open = await openArena(c, ctx);
  if (!open) return json({ error: 'no_open_arena' }, 503);
  const { arenaId, incarnation } = open;
  if (requested !== arenaId) {
    return json({ error: 'wrong_arena', arenaId: arenaId.toString() }, 409);
  }

  const pdas = await matchPdas(c.programId, arenaId);
  const { er, erFqdn } = await ensureArena(c, arenaId, incarnation, pdas);

  const before = await accountData(er, pdas.arena);
  if (!before) throw new Error('arena unreadable before start');
  if (decodeArena(before).phase !== PHASE_LOBBY) {
    return json({ error: 'already_started' }, 409);
  }

  // `begin_muster` flips the phase to Mustering, stamps `fight_at_tick`, and schedules
  // every iteration of the crank up front. It cannot be topped up later: `ScheduleTask`
  // needs a writable signer and a scheduled instruction may carry none, so a crank can
  // never re-arm itself or be re-armed from inside the ER. The crank is also what ends
  // the muster — `Arena::begin_fight` flips MUSTERING → FIGHTING at the deadline — so
  // no second request is owed from anybody.
  const ix = beginMuster({
    programId: c.programId,
    payer: c.treasury.address,
    ...pdas,
  });
  try {
    await confirmSignature(er, await sendInstructions(er, c.treasury, [ix]), {
      timeoutMs: ER_CONFIRM_MS,
    });
  } catch (error) {
    // `NoRaiders` means the caller raced its own `enter_gate`: the browser saw its zone
    // flip on a notification and posted here before the chain's copy of `Players` showed
    // anyone in the pit. Same class as the `already_started` above — a lost race, not a
    // fault — so it answers 409 and the store's `BENIGN_START` swallows it.
    if (refusalCode(error) === HEARTROT_NO_RAIDERS) {
      return json({ error: 'no_raiders' }, 409);
    }
    throw error;
  }

  const after = await accountData(er, pdas.arena);
  if (!after) throw new Error('arena unreadable after start');
  const arena = decodeArena(after);

  return json({
    arenaId: arenaId.toString(),
    crankTaskId: arena.crankTaskId.toString(),
    phase: 'mustering',
    // Both, and both honestly. `enrage_at_tick` is now stamped at the MUSTERING → FIGHTING
    // flip rather than at creation, so it is 0 here for every caller; `fight_at_tick` is
    // the deadline the countdown is drawn from, and without it the client would have to
    // wait for the next notification to know the window had opened at all.
    enrageAtTick: arena.enrageAtTick,
    fightAtTick: arena.fightAtTick,
    incarnation: arena.incarnation,
    erEndpoint: erFqdn,
    tickMs: TICK_MS,
  });
}

/** `HeartrotError::NoRaiders`. Branch on the code, never on the message. */
const HEARTROT_NO_RAIDERS = 19;

/**
 * The program's `Custom(n)` off a failed send.
 *
 * There is exactly one shape to read: `sendInstructions` is unconditionally
 * `skipPreflight`, so a rule refusal cannot surface at submit time — it comes back from
 * `confirmSignature`, which puts the whole `DecodedTransactionError` on `cause` for
 * precisely this. Anything else (a timeout, an RPC fault) has no `code` and falls through
 * to the 500, which is the right answer for it.
 */
/** `errors.ts` codes this route can answer for. Generated table, so these are its names. */
const SEAT_OCCUPIED = 4;
const WRONG_PHASE = 6;

function refusalCode(error: unknown): number | undefined {
  return (error as { cause?: DecodedTransactionError } | null)?.cause?.code;
}

// ---------------------------------------------------------------------------
// POST /api/match/leave
// ---------------------------------------------------------------------------

/**
 * A player is leaving — the Exit button, or their tab closing via `sendBeacon`.
 *
 * THIS IS THE FIX FOR THE LEAK THAT MADE THE GAME UNJOINABLE. Nothing on chain notices a
 * player walking away: their seat keeps `zone == ZONE_ARENA`, so `arena_occupants` stays
 * non-zero forever (`tick.rs`), and the wipe branch needs `live_n == 0 && pending_respawns
 * == 0` — which a dead seat never satisfies, because it re-stamps its own respawn every
 * cycle. So an abandoned raid runs the full six minutes to `OUTCOME_ENRAGE`, lands in
 * `SETTLING`, and stays there: the only other caller of `settle` requires a live seated
 * player, and that player is the one who left. Twelve of those in a row is a game nobody
 * can join, which is exactly what happened on devnet.
 *
 * Departure-driven, not a timer. The cleanup happens at the moment the last player goes.
 *
 * **Only when they are the last one out.** If any other seat is still claimed the raid
 * belongs to those players and this route does nothing — a leaver must never be able to
 * end a fight nineteen other people are in. That check is what lets us skip
 * `matchSettle`'s `STALL_PROOF_MS` crank-liveness window: this is not "the crank looks
 * dead", it is "there is nobody left to play", which is a fact about the roster and does
 * not need to be proven over five seconds.
 *
 * The settle runs in `ctx.waitUntil`, so the player's browser is not held open waiting for
 * a chain round trip it will never see the result of — a closing tab least of all.
 */
export async function matchLeave(env: Env, body: unknown, ctx: RouteContext): Promise<Response> {
  const token = field(body, 'privyToken');
  const arenaId = arenaIdField(body);

  const did = await verifyPrivyToken(token, env.PRIVY_APP_ID);
  const identity = await identityFromDid(did);

  const c = await context(env);
  const pdas = await matchPdas(c.programId, arenaId);
  const { state, erFqdn } = await readArena(c, pdas.arena);
  // Already gone, or already home: nothing to release. Not an error — a beacon that
  // arrives after someone else settled is the common case, not a fault.
  if (!state || erFqdn === undefined) return json({ released: false, reason: 'not_live' });

  const er = createRpc(erFqdn);
  const rosterBytes = await accountData(er, pdas.players);
  if (!rosterBytes) return json({ released: false, reason: 'not_live' });
  const roster = decodePlayers(rosterBytes);

  const mine = roster.slots.find(
    (slot) => slot.occupied && slot.identity.every((byte, i) => byte === identity[i]),
  );
  if (!mine) return json({ error: 'not_in_match' }, 403);

  // Everyone else. `occupied` is the authority (`session_pubkey != 0`), not `hp` — a
  // player waiting out a respawn has not left, and ending their raid because they happen
  // to be dead at this instant would be the same defect from the other direction.
  // RELEASE THE SEAT, always and first. This is the half that was missing: settling only
  // when the leaver was the last one out meant that with anyone else still in, the seat
  // stayed occupied and `ZONE_ARENA` forever — the other raiders kept seeing a motionless
  // archer they could not kill, and the leaver could not rejoin because their identity was
  // still sitting in an arena that was no longer a lobby.
  const release = leaveSeat({
    programId: c.programId,
    arena: pdas.arena,
    players: pdas.players,
    treasury: c.treasury.address,
    seat: mine.seat,
    identity,
  });
  try {
    await confirmSignature(er, await sendInstructions(er, c.treasury, [release]), {
      timeoutMs: ER_CONFIRM_MS,
    });
  } catch (error) {
    // The seat is the thing that matters and it did not come free. Say so rather than
    // reporting a release that did not happen — the client has already cleared its own
    // state, so a retry is the player pressing Exit again or the reaper catching it.
    console.error(`matchLeave: releasing seat ${mine.seat} of ${arenaId} failed`, error);
    return json({ released: false, reason: 'release_failed' }, 202);
  }

  const othersHold = roster.slots.some((slot) => slot.occupied && slot.seat !== mine.seat);
  if (othersHold) return json({ released: true, settled: false, reason: 'others_hold_seats' });

  // Last one out. A lobby arena has nothing to commit and `settle.rs` refuses it, but it
  // also has no crank and no fight — leaving it warm is correct, and it is the arena the
  // next player will be handed.
  if (state.phase === PHASE_LOBBY) {
    return json({ released: true, settled: false, reason: 'lobby_stays_warm' });
  }
  if (state.phase === PHASE_ROLLING) {
    // A VRF callback may still be in flight; committing now would strand it. `boss_tick`
    // abandons the roll on its own timeout and the arena becomes settleable.
    return json({ released: true, settled: false, reason: 'rolling' });
  }

  ctx.waitUntil(
    (async () => {
      try {
        const ix = settle({ programId: c.programId, payer: c.treasury.address, ...pdas });
        await confirmSignature(er, await sendInstructions(er, c.treasury, [ix]), {
          timeoutMs: ER_CONFIRM_MS,
        });
        console.log(`matchLeave: settled ${arenaId} after the last player left`);
      } catch (error) {
        // Best effort by construction. If this fails the arena is exactly as stranded as
        // it was before, and `openArena`'s reaper will find it on somebody else's join.
        console.error(`matchLeave: settle ${arenaId} failed`, error);
      }
    })(),
  );

  return json({ released: true, settled: true });
}

// ---------------------------------------------------------------------------
// POST /api/match/settle
// ---------------------------------------------------------------------------

/**
 * Ends a match and writes the leaderboard. Load-bearing rather than a fallback: it is
 * the only path that runs once the crank's ten-retry ladder has deleted the task, and
 * there is no RPC anywhere that reports whether a task is still alive.
 *
 * `reason` is advisory and is not read. What this route settles on is chain state: either
 * the program has already fixed an `outcome` — `Settling`, `Rolled`, `Settled`, whichever
 * of win, wipe and enrage it was — or the arena is still `Fighting` and `tick` has
 * provably stopped advancing. Trusting a client-supplied reason would let one player end
 * a raid for nineteen others. `Lobby` and `Rolling` are refused outright: the first has no
 * match to record, and the second must not leave the ER while a VRF callback is in flight.
 *
 * The response carries `outcome` and `nextIncarnation` because settlement is where the
 * two axes separate: `phase` is `Settled` either way, and only `outcome` says whether the
 * raid killed the core, and only a verified roll seed says the chain continues.
 *
 * `arenaId` is client-supplied and names any arena on the chain, so being logged in is
 * not enough on its own either: the caller must hold a seat in the match they are asking
 * to end.
 */
export async function matchSettle(env: Env, body: unknown): Promise<Response> {
  const token = field(body, 'privyToken');
  const arenaId = arenaIdField(body);

  const did = await verifyPrivyToken(token, env.PRIVY_APP_ID);
  const identity = await identityFromDid(did);

  const c = await context(env);
  const pdas = await matchPdas(c.programId, arenaId);

  const { state, erFqdn } = await readArena(c, pdas.arena);
  if (!state) return json({ error: 'no_such_match' }, 404);

  // Membership, from the same layer the arena was read from — the three accounts are
  // delegated and committed as one instruction, so they are never on opposite sides.
  // Everyone who reaches this route legitimately got here by holding a seat; a caller
  // who does not hold one is naming somebody else's match.
  const rosterBytes = await accountData(
    erFqdn === undefined ? c.base : createRpc(erFqdn),
    pdas.players,
  );
  if (!rosterBytes) return json({ error: 'no_such_match' }, 404);
  const seated = decodePlayers(rosterBytes).slots.some(
    (slot) => slot.occupied && slot.identity.every((byte, i) => byte === identity[i]),
  );
  if (!seated) return json({ error: 'not_in_match' }, 403);

  // A lobby arena has nothing to commit: it holds a roster and no match. Settling it
  // would write a leaderboard row of twenty untouched seats and burn the arena id, which
  // is a griefing primitive rather than a recovery path — and `settle.rs` says so too,
  // raising `WrongPhase` on `PHASE_LOBBY`. That refusal holds on *either* layer, so this
  // one must as well: a seated player who calls this route between `/session/init` and
  // `/match/start` finds the arena already delegated and still in the lobby, and without
  // this the Worker sends an instruction the program rejects and reports it as an opaque
  // 500 rather than the 409 it is.
  if (state.phase === PHASE_LOBBY) {
    return json({ error: 'nothing_to_settle' }, 409);
  }

  // A VRF request is in flight, and committing now is the one thing that must not happen
  // here: the callback would land on accounts the ER no longer holds, fail, and be
  // retried by the oracle for its whole 240-slot TTL. `ROLLING -> SETTLED` is not a legal
  // edge for exactly this reason, so there is nothing to send — `boss_tick` abandons the
  // roll after `ROLL_TIMEOUT_TICKS` and the arena drops back to a settleable state on its
  // own. Hand the client the wait rather than sending an instruction the program refuses.
  if (state.phase === PHASE_ROLLING) {
    const ticksLeft = Math.max(0, rollDeadlineTick(state) - state.tick) + 1;
    return json({ committed: false, phase: 'rolling', retryAfterMs: ticksLeft * TICK_MS }, 202);
  }

  if (erFqdn === undefined) {
    // Already home. `settle` is the only instruction that both ends a fight and
    // undelegates, so anything that is back on the base layer and *not* `Settled` was
    // committed by a bare tag 11 with the fight unfinished. There is no instruction that
    // sends it back to an ER, and `write_leaderboard` accepts only `Settled` — so this is
    // a stuck match, not a settleable one, and reporting it is all this route can do.
    if (state.phase !== PHASE_SETTLED) {
      return json({ error: 'not_settleable', phase: state.phase }, 409);
    }
  } else {
    const er = createRpc(erFqdn);

    if (state.phase === PHASE_FIGHTING) {
      // The chain still thinks this match is live, so the only legitimate reason to be
      // here is a dead crank, and `tick` advancing is the entire liveness signal that
      // exists. Watch it for the full `STALL_PROOF_MS`: a settle that races a crank that
      // was merely drifting ends a fight nineteen other people are still in, and cannot
      // be undone. A crank that is alive moves `tick` inside the first sample, so a live
      // match is refused in ~5 s and only a genuinely dead one pays the whole window.
      const deadline = Date.now() + STALL_PROOF_MS;
      do {
        await sleep(STALL_SAMPLE_MS);
        const again = await accountData(er, pdas.arena);
        if (!again) throw new Error('arena vanished mid-settle');
        const now = decodeArena(again);
        if (now.tick !== state.tick) return json({ error: 'match_live', tick: now.tick }, 409);
      } while (Date.now() < deadline);
    }

    // `settle` cancels the crank before committing — a task still armed when the
    // accounts leave the ER fires into undelegated accounts — then sets
    // `phase = Settled` and `commit_and_undelegate`s all three.
    const ix = settle({ programId: c.programId, payer: c.treasury.address, ...pdas });
    await confirmSignature(er, await sendInstructions(er, c.treasury, [ix]), {
      timeoutMs: ER_CONFIRM_MS,
    });
  }

  // Wait for the accounts to come home. This replaces the SDK's
  // `GetCommitmentSignature`, which scrapes two hardcoded English log prefixes and
  // *throws* on every failure path — and a throw there means "unknown", never "failed".
  // Ownership returning to our program is the state `write_leaderboard` actually needs,
  // and unlike a log string it is unambiguous.
  const deadline = Date.now() + 25_000;
  let settled: ArenaAccount | null = null;
  for (;;) {
    const base = await accountData(c.base, pdas.arena);
    if (base) {
      try {
        settled = decodeArena(base);
        break;
      } catch {
        // Still a delegated husk: zero bytes owned by the delegation program.
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(1_000);
  }
  // Unknown, not failed — 202, and the client polls. Re-entering this route is safe:
  // `settle` on an already-settled arena commits again and `write_leaderboard` no-ops
  // on a repeated `(arena_id, incarnation)`.
  if (!settled) return json({ committed: false, retryAfterMs: 2_000 }, 202);

  // A match that never produced a result has no row to write, and as of the muster that
  // state is REACHABLE: `MUSTERING → SETTLED` is the dead-crank recovery edge, and a
  // `Fighting` arena settled through the stall path above keeps `OUTCOME_UNDECIDED` too —
  // "the fight was cut short" is the honest record. `write_leaderboard` now refuses such
  // an arena outright (a row whose outcome byte is 0 is indistinguishable from an unwritten
  // row), so sending tag 10 here would turn a correct settle into a `MatchNotOver` throw,
  // a 500, and eight client retries against accounts that already came home. The accounts
  // ARE settled; there is simply nothing to record.
  if (settled.outcome === OUTCOME_UNDECIDED) {
    return json({
      committed: true,
      leaderboardWritten: false,
      outcome: settled.outcome,
      arenaId: settled.arenaId.toString(),
      incarnation: settled.incarnation,
    });
  }

  const leaderboard = await leaderboardPda(c.programId);
  if ((await accountData(c.base, leaderboard)) === null) {
    // Once per deployment. Doing it here rather than in a deploy script means the very
    // first settle in a fresh environment writes a row instead of 500ing on a missing
    // account.
    const ix = initLeaderboard({
      programId: c.programId,
      payer: c.treasury.address,
      leaderboard,
    });
    await confirmSignature(c.base, await sendInstructions(c.base, c.treasury, [ix]), {
      timeoutMs: BASE_CONFIRM_MS,
    });
  }

  // No argument block: the handler takes no `data` and reads `(arena_id, incarnation)`
  // off the `Arena` account it is handed. Tag 10 is absent from `ZERO_ARG_TAGS`, so a
  // trailing block would be ignored in silence rather than rejected — which is exactly
  // why it must not be sent. `incarnation` below is read state, not an argument.
  const ix = writeLeaderboard({
    programId: c.programId,
    payer: c.treasury.address,
    leaderboard,
    arena: pdas.arena,
    players: pdas.players,
  });
  const baseSignature = await sendInstructions(c.base, c.treasury, [ix]);
  await confirmSignature(c.base, baseSignature, { timeoutMs: BASE_CONFIRM_MS });

  return json({
    committed: true,
    baseSignature,
    leaderboardWritten: true,
    // Read off the committed account rather than inferred, which is the whole reason
    // `outcome` is a second axis: after settlement `phase` is `Settled` for a raid that
    // killed the core and for one that wiped alike, and the end screen has to tell them
    // apart. `OUTCOME_*` in `@heartrot/client`.
    outcome: settled.outcome,
    /**
     * The incarnation the next `/api/session/init` will seat players into, or `null`
     * when this raid chain ends here — a wipe, an enrage, or a win whose VRF roll the
     * oracle never answered. The Worker does not send tag 15 now: nothing carries an
     * incarnation forward except players coming back, and `openArena` rolls the arena
     * when the first one does, so a chain nobody returns to costs no transaction.
     */
    nextIncarnation:
      settled.outcome === OUTCOME_WIN && rollSeed(settled) !== null
        ? settled.incarnation + 1
        : null,
  });
}

// ---------------------------------------------------------------------------
// GET /api/faucet/status
// ---------------------------------------------------------------------------

/**
 * A treasury gauge, never a player-funding endpoint. Players need no SOL at all — ER
 * fees are zero and the ER's SVM has no fee-payer validation, so a session keypair that
 * has never existed on chain can sign for a whole match. There is nothing to airdrop
 * and no tier that hands anyone lamports.
 */
export async function faucetStatus(env: Env): Promise<Response> {
  const c = await context(env);
  const { lamports, matches, tier } = await treasuryTier(c);
  return json({
    treasury: c.treasury.address,
    treasuryLamports: lamports.toString(),
    estimatedMatches: matches,
    tier,
  });
}
