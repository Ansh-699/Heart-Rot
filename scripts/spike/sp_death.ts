/**
 * SP-DEATH — the losing half of the loop, on real devnet.
 *
 * Nobody has ever, on chain, been killed by the boss. Every claim about combat in this
 * repo is inference from source: the unit tests that cover damage → death → respawn →
 * wipe hand-place bullets into the pool rather than letting the boss fire them, so the
 * one thing they cannot prove is that a volley the boss actually spawns ever reaches a
 * player. This spike makes the boss do it.
 *
 * Phase A (`--phase a`), one match:
 *   1. init_arena + delegate on base, start_match on the ER.
 *   2. Claim seats 0, 4 and 8 — all three share `map::ENTRANCES[0]`, the north door, so
 *      they land in one cluster and one volley can reach all of them.
 *   3. Walk them to the gate, `enter_gate`, then STAND STILL and watch HP.
 *   4. If nobody has died after `SPD_STILL_MS`, walk the cluster down the north corridor
 *      to within a few tiles of the boss and stand still there. Both outcomes are
 *      findings: "the entrance is survivable" is as real a result as "the boss kills".
 *   5. On the first death, immediately send `move` and `shoot` from the dead seat and
 *      record what the chain says (expected `Custom(8)` PlayerDead).
 *   6. Watch the respawn: hp back to hp_max, position back at `entrance_for(seat)`,
 *      measured against `RESPAWN_TICKS = 8`.
 *   7. Keep standing until the arena leaves `PHASE_FIGHTING`; record `outcome`.
 *   8. settle, then write the leaderboard on base and read the rows back.
 *
 * Phase B (`--phase b`), a second match: an arena nobody enters. `arena_occupants == 0`
 * makes a wipe structurally impossible, so the only end available is `enrage_at_tick`.
 * Watch it to tick 900 and read `outcome` — the point is that it is 3 (ENRAGE) and not
 * 2 (WIPE).
 *
 * Every instruction is built by `packages/client`, so a wrong hand-written encoder fails
 * here rather than in front of a player. The bullet pool is sampled against the client's
 * own generated `isWall`, which is how "volleys stay inside the dungeon" is checked
 * without restating the map.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp_death.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=$PWD/packages/client/src/index.ts \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=<tmp>/spd.mjs
 *   node <tmp>/spd.mjs --phase a --out <tmp>/spd-a.jsonl                   # death + respawn
 *   SPD_SEATS=0 SPD_STILL_MS=1 node <tmp>/spd.mjs --phase a --out <tmp>/spd-w.jsonl   # the WIPE
 *   node <tmp>/spd.mjs --phase b --out <tmp>/spd-b.jsonl                   # the ENRAGE
 *   node <tmp>/spd.mjs --settle-only <arenaId>      # recover a crashed run's crank
 *
 * Env: SPD_SEATS (default `0,4,8`), SPD_STILL_MS, SPD_FIGHT_MS, SPD_ENRAGE_MS.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
  type Signature,
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  MAP_ENTRANCES,
  OUTCOME_ENRAGE,
  OUTCOME_UNDECIDED,
  OUTCOME_WIPE,
  OUTCOME_WIN,
  PHASE_FIGHTING,
  PHASE_SETTLED,
  ZONE_ARENA,
  assertErIdentity,
  claimSeat,
  confirmSignature,
  connectMatch,
  createRpc,
  decodeArena,
  decodeBoss,
  decodeLeaderboard,
  decodePlayers,
  delegate,
  enterGate,
  getDelegationStatus,
  getRoutes,
  initArena,
  initLeaderboard,
  isWall,
  leaderboardPda,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
  shoot,
  startMatch,
  writeLeaderboard,
  type HeartrotRpc,
  type MatchConnections,
  type PlayerSlot,
} from '@heartrot/client';

// ---------------------------------------------------------------------------
// Constants mirrored from the program. Read, never invented.
// ---------------------------------------------------------------------------

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;

/** `player::GATE_MIN_*` / `GATE_MAX_*` — tiles 30..=33 on both axes, in arena units. */
const GATE_MIN = 30 * 16;
const GATE_MAX = 34 * 16 - 1;
/** `player::LOBBY_ENTRANCE` and `LOBBY_SPACING`. */
const LOBBY_ENTRANCE: readonly [number, number] = [28 * 16, 52 * 16];
const LOBBY_SPACING = 24;
const STEP = 16;
/** `tick::ENTRANCE_SPACING`. */
const ENTRANCE_SPACING = 24;
/** `state::MAX_SEATS`, needed for the entrance fan arithmetic below. */
const SEATS_TOTAL = 20;
/** `tick::RESPAWN_TICKS`, the number this spike measures the observed delay against. */
const RESPAWN_TICKS = 8;
/** `player::PLAYER_HP_MAX`. */
const PLAYER_HP_MAX = 100;
/** `error::HeartrotError::PlayerDead`. */
const ERR_PLAYER_DEAD = 8;

/** Cardinal directions of `player::MOVE_STEP`: N, E, S, W. */
const CARDINALS: readonly { dir: number; dx: number; dy: number }[] = [
  { dir: 0, dx: 0, dy: -STEP },
  { dir: 2, dx: STEP, dy: 0 },
  { dir: 4, dx: 0, dy: STEP },
  { dir: 6, dx: -STEP, dy: 0 },
];

/**
 * Seats 0, 4 and 8 all resolve to `ENTRANCES[0]` (`seat % 4`), so they respawn as one
 * cluster on the north wall and a single volley can be aimed at all three. Three rather
 * than one because a solo occupant's first death *is* the wipe — `live_n` hits 0 with
 * `arena_occupants` still 1 — so a respawn is unobservable in a one-player raid.
 *
 * `SPD_SEATS=0` inverts that and is how the wipe is driven: with one occupant the first
 * death is `live_n == 0` on the same tick, so `OUTCOME_WIPE` is deterministic instead of
 * needing three simultaneous deaths.
 */
const SEATS: readonly number[] = (process.env.SPD_SEATS ?? '0,4,8')
  .split(',')
  .map((n: string) => Number(n.trim()));

const STILL_MS = Number(process.env.SPD_STILL_MS ?? 60_000);
const FIGHT_MS = Number(process.env.SPD_FIGHT_MS ?? 240_000);
const ENRAGE_MS = Number(process.env.SPD_ENRAGE_MS ?? 430_000);
const POLL_MS = 1_200;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const outPath = arg('--out') ?? '/tmp/sp_death.jsonl';

/** kit upcasts RPC numerics to `bigint`, and `JSON.stringify` throws on those. */
const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${JSON.stringify(line, jsonSafe)}\n`);
  console.log(`${line.t} ${event} ${JSON.stringify(fields, jsonSafe)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function loadKeypairBytes(path: string): Uint8Array {
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
}

// ---------------------------------------------------------------------------
// Geometry the program owns, restated only where the client does not export it
// ---------------------------------------------------------------------------

/** `player::lobby_spawn`. */
function lobbySpawn(seat: number): [number, number] {
  const offset = (seat - SEATS_TOTAL / 2) * LOBBY_SPACING;
  return [
    Math.min(Math.max(LOBBY_ENTRANCE[0] + offset, 0), 1023),
    Math.min(Math.max(LOBBY_ENTRANCE[1], 0), 1023),
  ];
}

/** `tick::fans_along_x`. */
function fansAlongX(ex: number, ey: number): boolean {
  return Math.min(ey, 1024 - ey) <= Math.min(ex, 1024 - ex);
}

/**
 * `tick::entrance_for` — where `enter_gate` puts a seat and where a respawn returns it.
 * Restated here (from `MAP_ENTRANCES`, the generated door list, not from a second copy of
 * the doors) so the spike can assert the observed respawn position rather than trusting it.
 */
function entranceFor(seat: number): [number, number] {
  const doors = MAP_ENTRANCES.length;
  const [ex, ey] = MAP_ENTRANCES[seat % doors] as readonly [number, number];
  const offset = (Math.floor(seat / doors) - Math.floor(SEATS_TOTAL / doors / 2)) * ENTRANCE_SPACING;
  const clamp = (v: number): number => Math.min(Math.max(v, 0), 1023);
  return fansAlongX(ex, ey) ? [clamp(ex + offset), ey] : [ex, clamp(ey + offset)];
}

const onGate = (x: number, y: number): boolean =>
  x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;

/**
 * BFS over cardinal 16-unit steps, rejecting any step `player::move_player` would reject.
 * `STEP == TILE`, so every reachable point stays on the lattice the start sits on.
 */
function pathTo(
  x: number,
  y: number,
  isGoal: (px: number, py: number) => boolean,
): number[] | null {
  const key = (px: number, py: number): string => `${px},${py}`;
  const seen = new Map<string, { from: string; dir: number } | null>();
  seen.set(key(x, y), null);
  let frontier: [number, number][] = [[x, y]];

  for (let depth = 0; depth < 200 && frontier.length > 0; depth += 1) {
    const next: [number, number][] = [];
    for (const [cx, cy] of frontier) {
      for (const { dir, dx, dy } of CARDINALS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx > 1023 || ny > 1023 || isWall(nx, ny)) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.set(k, { from: key(cx, cy), dir });
        if (isGoal(nx, ny)) {
          const path: number[] = [];
          let cursor = k;
          for (;;) {
            const step = seen.get(cursor);
            if (step == null) break;
            path.push(step.dir);
            cursor = step.from;
          }
          return path.reverse();
        }
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Point blank, and the distance is not arbitrary. The fan offset is a tangent —
 * `k / SPREAD_DEN`, `SPREAD_DEN = 24` — so a bullet at fan slot `k` misses the aim point
 * by `range × |k| / 24` units against `PLAYER_HIT_RADIUS = 12`. At 3 tiles even `|k| = 3`
 * is inside the radius, so a kill there does not depend on which fan slot happened to
 * survive; at 15 tiles only `k = 0` can connect at all.
 *
 * **Where the boss is comes off the chain, not out of a constant here.** `init::BOSS_SPAWN`
 * moved from (512, 320) to the drawn `B` tile at (512, 512) *during this spike's runs*, and
 * a hardcoded copy sent one run to a spot it believed was 3 tiles from the boss and was
 * actually 15. `snapshot` already decodes `Boss`; use the x/y it read.
 */
const nearBoss =
  (bx: number, by: number) =>
  (x: number, y: number): boolean => {
    const dx = Math.abs(x - bx);
    const dy = Math.abs(y - by);
    return dx <= 48 && dy <= 48 && dx + dy >= 32;
  };

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function transfer(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: '11111111111111111111111111111111' as Address,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * The ER's rent rate is 6,960 lamports per (128 + len) byte and devnet's is 6,333, so an
 * account made rent-exempt through `Rent::get()` on base is ~9 % short inside the ER and
 * the cloner silently refuses it. SP2 found this; the program-side fix is still open, so
 * every spike tops the accounts up before `delegate`.
 */
const ER_LAMPORTS_PER_BYTE = 6_960n;

async function topUpForEr(
  base: HeartrotRpc,
  treasurySigner: Parameters<typeof sendInstructions>[1],
  accounts: readonly Address[],
): Promise<void> {
  const transfers: Instruction[] = [];
  for (const account of accounts) {
    const { value } = await base.getAccountInfo(account, { encoding: 'base64' }).send();
    if (value === null) throw new Error(`${account} does not exist on the base layer`);
    const space = BigInt(Buffer.from(value.data[0], 'base64').length);
    const needed = (128n + space) * ER_LAMPORTS_PER_BYTE;
    const have = BigInt(value.lamports);
    if (have < needed) transfers.push(transfer(treasurySigner.address, account, needed - have));
  }
  if (transfers.length === 0) return;
  const sig = await sendInstructions(base, treasurySigner, transfers);
  await confirmSignature(base, sig, { timeoutMs: 60_000 });
  log('er_rent_topup', { signature: sig, count: transfers.length });
}

function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

/**
 * Multi-signer send. The client's builders emit plain address metas, so kit's signer
 * discovery cannot find the session keys; this compiles the message and signs it with raw
 * key pairs. Used by every session-signed instruction here.
 */
async function sendSigned(
  rpc: HeartrotRpc,
  feePayer: Address,
  keyPairs: readonly CryptoKeyPair[],
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransaction([...keyPairs], compileTransaction(message));
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
  return getSignatureFromTransaction(signed);
}

/**
 * Wait for a signature and RETURN its error instead of throwing, because half the
 * observations here are rejections. `confirmSignature` from the client cannot be used for
 * either job on the ER: it demands `confirmed`/`finalized`, and it throws
 * `TypeError: Do not know how to serialize a BigInt` on any status carrying one (M6) —
 * the third spike in a row to route around that.
 */
async function erStatus(
  rpc: HeartrotRpc,
  signature: Signature,
  what: string,
  timeoutMs = 25_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status != null) {
      log('er_status', { what, signature, err: status.err, status: status.confirmationStatus });
      return status.err;
    }
    if (Date.now() >= deadline) {
      log('er_status_missing', { what, signature });
      return undefined;
    }
    await sleep(300);
  }
}

async function erOk(rpc: HeartrotRpc, signature: Signature, what: string, timeoutMs = 25_000) {
  const err = await erStatus(rpc, signature, what, timeoutMs);
  if (err != null) throw new Error(`${what} failed: ${JSON.stringify(err, jsonSafe)}`);
  if (err === undefined) throw new Error(`${what} never appeared`);
}

// ---------------------------------------------------------------------------
// Reading the world
// ---------------------------------------------------------------------------

type Snapshot = {
  tick: number;
  phase: number;
  outcome: number;
  aliveCount: number;
  activeBullets: number;
  /** Active bullets standing on a solid tile, per the client's generated wall bitboard. */
  bulletsInWalls: number;
  bulletsOffMap: number;
  targetSeat: number;
  bossX: number;
  bossY: number;
  ventOpen: number;
  coreHp: number;
  shellHp: number;
  slots: PlayerSlot[];
};

async function snapshot(
  rpc: HeartrotRpc,
  arena: Address,
  boss: Address,
  players: Address,
): Promise<Snapshot> {
  const { value } = await rpc
    .getMultipleAccounts([arena, boss, players], { encoding: 'base64' })
    .send();
  const bytes = value.map((v) => {
    if (v === null) throw new Error('an account vanished from the ER');
    return Uint8Array.from(Buffer.from(v.data[0], 'base64'));
  });
  const a = decodeArena(bytes[0] as Uint8Array);
  const b = decodeBoss(bytes[1] as Uint8Array);
  const p = decodePlayers(bytes[2] as Uint8Array);
  const live = a.bullets.filter((bl) => bl.active !== 0);
  return {
    tick: a.tick,
    phase: a.phase,
    outcome: a.outcome,
    aliveCount: a.aliveCount,
    activeBullets: live.length,
    bulletsInWalls: live.filter((bl) => isWall(bl.x, bl.y)).length,
    bulletsOffMap: live.filter((bl) => bl.x < 0 || bl.x > 1023 || bl.y < 0 || bl.y > 1023).length,
    targetSeat: b.targetSeat,
    bossX: b.x,
    bossY: b.y,
    ventOpen: b.ventOpen,
    coreHp: b.coreHp,
    shellHp: b.parts.reduce((s, hp) => s + hp, 0),
    slots: p.slots,
  };
}

const seatView = (s: Snapshot, seats: readonly number[]) =>
  seats.map((n) => {
    const slot = s.slots[n] as PlayerSlot;
    return {
      seat: n,
      hp: slot.hp,
      x: slot.x,
      y: slot.y,
      zone: slot.zone,
      deaths: slot.deaths,
      respawnAt: slot.respawnAtTick,
    };
  });

// ---------------------------------------------------------------------------
// Match setup
// ---------------------------------------------------------------------------

type Session = { seat: number; keyPair: CryptoKeyPair; address: Address; identity: Uint8Array };

async function openMatch(
  base: HeartrotRpc,
  treasury: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  arenaId: bigint,
): Promise<{ match: MatchConnections; arena: Address; boss: Address; players: Address }> {
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  log('match_pdas', { arenaId: arenaId.toString(), arena, boss, players });

  const initSig = await sendInstructions(base, treasury, [
    setComputeUnitLimit(400_000),
    initArena({
      programId: PROGRAM_ID,
      payer: treasury.address,
      arena,
      boss,
      players,
      arenaId,
      incarnation: 1,
      validatorIdentity: DEVNET_AS_IDENTITY,
      crankAuthority: treasury.address,
    }),
  ]);
  await confirmSignature(base, initSig, { timeoutMs: 60_000 });
  log('init_arena', { signature: initSig });

  await topUpForEr(base, treasury, [arena, boss, players]);

  const delegateSig = await sendInstructions(base, treasury, [
    setComputeUnitLimit(1_400_000),
    await delegate({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmSignature(base, delegateSig, { timeoutMs: 60_000 });
  log('delegate', { signature: delegateSig });

  // `connectMatch` first, because exercising the real client is the point. Its phase 2
  // cannot succeed — the ER clones a delegated account when a transaction first
  // references it, not when it is delegated (SP2) — so the fallback keeps the two checks
  // that actually prevent the wrong-ER failure and lets `start_match` prove the clone.
  let match: MatchConnections;
  try {
    match = await connectMatch({
      baseUrl: BASE_URL,
      accounts: [arena, boss, players],
      validatorIdentity: DEVNET_AS_IDENTITY,
      ownerProgram: PROGRAM_ID,
      timeoutMs: 30_000,
    });
    log('connected', { via: 'connectMatch', erFqdn: match.erFqdn });
  } catch (error) {
    log('connect_match_failed', { error: String(error) });
    const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
    if (route === undefined) throw new Error('no route for devnet-as');
    const er = createRpc(route.fqdn);
    await assertErIdentity(er, DEVNET_AS_IDENTITY);
    for (;;) {
      const statuses = await Promise.all([arena, boss, players].map((a) => getDelegationStatus(a)));
      if (statuses.every((s) => s.delegationRecord?.authority === DEVNET_AS_IDENTITY)) break;
      await sleep(500);
    }
    match = { base, er, erFqdn: route.fqdn, validatorIdentity: DEVNET_AS_IDENTITY };
    log('connected', { via: 'fallback', erFqdn: match.erFqdn });
  }

  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await erOk(match.er, startSig, 'start_match');
  const armed = await snapshot(match.er, arena, boss, players);
  log('start_match', {
    signature: startSig,
    tick: armed.tick,
    phase: armed.phase,
    bossXy: [armed.bossX, armed.bossY],
  });
  if (armed.phase !== PHASE_FIGHTING) {
    throw new Error(`start_match did not reach PHASE_FIGHTING: phase=${armed.phase}`);
  }
  return { match, arena, boss, players };
}

/** Claim, walk to the gate, and `enter_gate` every seat in `SEATS`. */
async function seatPlayers(
  match: MatchConnections,
  treasury: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  arena: Address,
  players: Address,
): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const seat of SEATS) {
    const keyPair = await generateKeyPair();
    sessions.push({
      seat,
      keyPair,
      address: await getAddressFromPublicKey(keyPair.publicKey),
      identity: crypto.getRandomValues(new Uint8Array(32)),
    });
  }

  const claimSig = await sendInstructions(
    match.er,
    treasury,
    sessions.map((s) =>
      claimSeat({
        programId: PROGRAM_ID,
        arena,
        players,
        treasury: treasury.address,
        seat: s.seat,
        skinId: s.seat % 4,
        sessionPubkey: s.address,
        identity: s.identity,
      }),
    ),
  );
  await erOk(match.er, claimSig, `claim_seat ${SEATS.join(',')}`);
  log('seats_claimed', {
    seats: SEATS,
    spawns: SEATS.map(lobbySpawn),
    entrances: SEATS.map(entranceFor),
  });

  await walk(match, treasury, arena, players, sessions, onGate, 'to_gate');

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slots = await readSlots(match.er, players);
    const pending = sessions.filter((s) => (slots[s.seat] as PlayerSlot).zone !== ZONE_ARENA);
    if (pending.length === 0) break;
    const sig = await sendSigned(
      match.er,
      treasury.address,
      [treasury.keyPair, ...pending.map((s) => s.keyPair)],
      pending.map((s) =>
        enterGate({ programId: PROGRAM_ID, arena, players, session: s.address, seat: s.seat }),
      ),
    );
    await erStatus(match.er, sig, `enter_gate x${pending.length}`);
    await sleep(800);
  }
  return sessions;
}

async function readSlots(rpc: HeartrotRpc, players: Address): Promise<PlayerSlot[]> {
  const { value } = await rpc.getAccountInfo(players, { encoding: 'base64' }).send();
  if (value === null) throw new Error('players vanished');
  return decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64'))).slots;
}

/** Move every session toward `isGoal`, one step per seat per tick, re-reading between rounds. */
async function walk(
  match: MatchConnections,
  treasury: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  arena: Address,
  players: Address,
  sessions: readonly Session[],
  isGoal: (x: number, y: number) => boolean,
  what: string,
): Promise<void> {
  for (let round = 0; round < 90; round += 1) {
    const slots = await readSlots(match.er, players);
    const pending = sessions.filter((s) => {
      const slot = slots[s.seat] as PlayerSlot;
      return slot.hp !== 0 && !isGoal(slot.x, slot.y);
    });
    if (pending.length === 0) {
      log('walk_done', { what, round });
      return;
    }
    const ixs: Instruction[] = [];
    const signers: CryptoKeyPair[] = [];
    for (const s of pending) {
      const slot = slots[s.seat] as PlayerSlot;
      const path = pathTo(slot.x, slot.y, isGoal);
      if (path === null || path.length === 0) {
        log('walk_unreachable', { what, seat: s.seat, x: slot.x, y: slot.y });
        continue;
      }
      ixs.push(
        movePlayer({
          programId: PROGRAM_ID,
          arena,
          players,
          session: s.address,
          seat: s.seat,
          dir: path[0] as number,
          seq: (round % 60_000) + 1,
        }),
      );
      signers.push(s.keyPair);
    }
    if (ixs.length === 0) return;
    try {
      await sendSigned(match.er, treasury.address, [treasury.keyPair, ...signers], ixs);
    } catch (error) {
      log('walk_send_failed', { what, round, error: String(error) });
    }
    if (round % 10 === 0) log('walk_progress', { what, round, pending: pending.length });
    await sleep(450);
  }
  log('walk_gave_up', { what });
}

// ---------------------------------------------------------------------------
// Phase A — stand still, die, respawn, wipe
// ---------------------------------------------------------------------------

type DeathRecord = { seat: number; tick: number; at: number; respawnAt: number };

async function phaseA(): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const base = createRpc(BASE_URL);
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { match, arena, boss, players } = await openMatch(base, treasury, arenaId);
  const sessions = await seatPlayers(match, treasury, arena, players);

  const entered = await snapshot(match.er, arena, boss, players);
  log('seats_entered', {
    tick: entered.tick,
    aliveCount: entered.aliveCount,
    targetSeat: entered.targetSeat,
    seats: seatView(entered, SEATS),
    expectedEntrances: SEATS.map(entranceFor),
  });

  // ---- the watch --------------------------------------------------------
  //
  // One loop for the whole fight. It never moves anybody: standing still is the
  // experiment. The single exception is the `advance` escalation, which fires once, and
  // only if the boss has failed to land a shot at the entrance.
  const deaths: DeathRecord[] = [];
  const respawns: { seat: number; deathTick: number; seenTick: number; x: number; y: number }[] = [];
  const hpAtEntry = new Map<number, number>(SEATS.map((s) => [s, PLAYER_HP_MAX]));
  let firstHitTick: number | null = null;
  let firstHitAt: number | null = null;
  let advanced = false;
  let probedDead = false;
  let bulletsInWallsMax = 0;
  let bulletsOffMapMax = 0;
  let bulletPeak = 0;

  const enteredAt = Date.now();
  const enteredTick = entered.tick;
  const deadline = Date.now() + FIGHT_MS;
  let final: Snapshot = entered;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const s = await snapshot(match.er, arena, boss, players);
    final = s;
    bulletsInWallsMax = Math.max(bulletsInWallsMax, s.bulletsInWalls);
    bulletsOffMapMax = Math.max(bulletsOffMapMax, s.bulletsOffMap);
    bulletPeak = Math.max(bulletPeak, s.activeBullets);

    for (const seat of SEATS) {
      const slot = s.slots[seat] as PlayerSlot;
      const before = hpAtEntry.get(seat) as number;
      if (slot.hp < before && firstHitTick === null) {
        firstHitTick = s.tick;
        firstHitAt = Date.now();
        log('first_blood', {
          seat,
          tick: s.tick,
          hp: slot.hp,
          secondsSinceEntry: (Date.now() - enteredAt) / 1000,
          ticksSinceEntry: s.tick - enteredTick,
        });
      }
      if (slot.hp === 0 && before !== 0) {
        deaths.push({
          seat,
          tick: s.tick,
          at: Date.now(),
          respawnAt: slot.respawnAtTick,
        });
        log('death', {
          seat,
          tick: s.tick,
          respawnAtTick: slot.respawnAtTick,
          deltaTicks: slot.respawnAtTick - s.tick,
          configuredRespawnTicks: RESPAWN_TICKS,
          deaths: slot.deaths,
          secondsSinceEntry: (Date.now() - enteredAt) / 1000,
          ticksSinceEntry: s.tick - enteredTick,
          aliveCount: s.aliveCount,
        });
      }
      if (slot.hp !== 0 && before === 0) {
        const last = [...deaths].reverse().find((d) => d.seat === seat);
        respawns.push({
          seat,
          deathTick: last?.tick ?? -1,
          seenTick: s.tick,
          x: slot.x,
          y: slot.y,
        });
        const [ex, ey] = entranceFor(seat);
        log('respawn', {
          seat,
          deathTick: last?.tick ?? -1,
          seenTick: s.tick,
          observedDelayTicks: last === undefined ? null : s.tick - last.tick,
          configuredRespawnTicks: RESPAWN_TICKS,
          hp: slot.hp,
          at: [slot.x, slot.y],
          expectedEntrance: [ex, ey],
          atEntrance: slot.x === ex && slot.y === ey,
        });
      }
      hpAtEntry.set(seat, slot.hp);
    }

    // The first corpse gets poked: a dead player must be unable to act.
    const corpse = SEATS.find((seat) => (s.slots[seat] as PlayerSlot).hp === 0);
    if (!probedDead && corpse !== undefined) {
      probedDead = true;
      await probeDeadPlayer(match, treasury, arena, boss, players, sessions, corpse);
    }

    if (s.phase !== PHASE_FIGHTING) {
      log('fight_over', {
        tick: s.tick,
        phase: s.phase,
        outcome: s.outcome,
        outcomeName: ['UNDECIDED', 'WIN', 'WIPE', 'ENRAGE'][s.outcome] ?? '?',
        seats: seatView(s, SEATS),
      });
      break;
    }

    if (Math.round((Date.now() - enteredAt) / POLL_MS) % 8 === 0) {
      log('watch', {
        tick: s.tick,
        aliveCount: s.aliveCount,
        activeBullets: s.activeBullets,
        bulletsInWalls: s.bulletsInWalls,
        targetSeat: s.targetSeat,
        seats: seatView(s, SEATS).map((v) => ({ seat: v.seat, hp: v.hp, xy: [v.x, v.y] })),
      });
    }

    // Escalation. If standing at the drawn entrance is simply safe, that is a finding in
    // its own right — and the fight still has to be shown to be losable, so the cluster
    // walks into the boss's face and stands still there instead.
    if (!advanced && deaths.length === 0 && Date.now() - enteredAt > STILL_MS) {
      advanced = true;
      log('entrance_survivable', {
        stillMs: STILL_MS,
        bossXy: [s.bossX, s.bossY],
        ticksStoodStill: s.tick - enteredTick,
        firstHitTick,
        activeBullets: s.activeBullets,
        targetSeat: s.targetSeat,
        seats: seatView(s, SEATS),
        note: 'nobody has died standing at entrance_for(); advancing on the boss',
      });
      await walk(match, treasury, arena, players, sessions, nearBoss(s.bossX, s.bossY), 'to_boss');
      const after = await snapshot(match.er, arena, boss, players);
      log('advanced', { tick: after.tick, seats: seatView(after, SEATS) });
      for (const seat of SEATS) hpAtEntry.set(seat, (after.slots[seat] as PlayerSlot).hp);
    }
  }

  log('phase_a_summary', {
    arenaId: arenaId.toString(),
    firstHitTick,
    secondsToFirstHit: firstHitAt === null ? null : (firstHitAt - enteredAt) / 1000,
    ticksToFirstHit: firstHitTick === null ? null : firstHitTick - enteredTick,
    deaths: deaths.map((d) => ({ seat: d.seat, tick: d.tick, respawnAt: d.respawnAt })),
    respawns,
    advanced,
    bulletPeak,
    bulletsInWallsMax,
    bulletsOffMapMax,
    finalPhase: final.phase,
    finalOutcome: final.outcome,
    isWipe: final.outcome === OUTCOME_WIPE,
    isWin: (final.outcome as number) === OUTCOME_WIN,
  });

  await endMatch(base, match, treasury, arena, boss, players, arenaId);
}

/** A dead seat must be unable to move or shoot. Both are sent; both errors are recorded. */
async function probeDeadPlayer(
  match: MatchConnections,
  treasury: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  arena: Address,
  boss: Address,
  players: Address,
  sessions: readonly Session[],
  seat: number,
): Promise<void> {
  const session = sessions.find((s) => s.seat === seat);
  if (session === undefined) return;
  const probe = async (what: string, ix: Instruction): Promise<unknown> => {
    try {
      const sig = await sendSigned(match.er, treasury.address, [treasury.keyPair, session.keyPair], [ix]);
      return await erStatus(match.er, sig, what, 15_000);
    } catch (error) {
      log('dead_probe_send_failed', { what, error: String(error) });
      return { sendError: String(error) };
    }
  };

  const moveErr = await probe(
    `dead_move seat ${seat}`,
    movePlayer({
      programId: PROGRAM_ID,
      arena,
      players,
      session: session.address,
      seat,
      dir: 4,
      seq: 60_001 % 60_000,
    }),
  );
  const shootErr = await probe(
    `dead_shoot seat ${seat}`,
    shoot({ programId: PROGRAM_ID, arena, boss, players, session: session.address, seat, dir: 4 }),
  );

  // The ER renders `Custom` as a **string** — `{"InstructionError":["0",{"Custom":"8"}]}` —
  // where base-layer devnet renders it as a number. A client matching on the number alone
  // silently fails to recognise its own error codes on the chain the game actually runs on.
  const isPlayerDead = (err: unknown): boolean =>
    new RegExp(`"Custom":"?${ERR_PLAYER_DEAD}"?`).test(JSON.stringify(err, jsonSafe) ?? '');
  log('dead_player_probe', {
    seat,
    moveErr,
    shootErr,
    expected: `Custom(${ERR_PLAYER_DEAD}) PlayerDead`,
    moveRejected: isPlayerDead(moveErr),
    shootRejected: isPlayerDead(shootErr),
  });
}

// ---------------------------------------------------------------------------
// Settlement and the leaderboard
// ---------------------------------------------------------------------------

async function endMatch(
  base: HeartrotRpc,
  match: MatchConnections,
  treasury: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  arena: Address,
  boss: Address,
  players: Address,
  arenaId: bigint,
): Promise<void> {
  const before = await snapshot(match.er, arena, boss, players);
  const settleSig = await sendInstructions(match.er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await erOk(match.er, settleSig, 'settle', 45_000);
  log('settle', {
    signature: settleSig,
    beforePhase: before.phase,
    beforeOutcome: before.outcome,
    beforeTick: before.tick,
  });

  // The commit has to land on base before the leaderboard can read it.
  let onBase: ReturnType<typeof decodeArena> | null = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(10_000);
    const { value } = await base.getAccountInfo(arena, { encoding: 'base64' }).send();
    if (value === null) continue;
    if (value.owner !== PROGRAM_ID) {
      log('post_settle_wait', { owner: value.owner });
      continue;
    }
    onBase = decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
    log('post_settle', {
      tick: onBase.tick,
      phase: onBase.phase,
      outcome: onBase.outcome,
      owner: value.owner,
    });
    if (onBase.phase === PHASE_SETTLED) break;
  }
  if (onBase === null || onBase.phase !== PHASE_SETTLED) {
    log('leaderboard_skipped', { reason: 'arena never came back settled on base' });
    return;
  }

  const leaderboard = await leaderboardPda(PROGRAM_ID);
  const { value: lbInfo } = await base.getAccountInfo(leaderboard, { encoding: 'base64' }).send();
  if (lbInfo === null) {
    const sig = await sendInstructions(base, treasury, [
      setComputeUnitLimit(400_000),
      initLeaderboard({ programId: PROGRAM_ID, payer: treasury.address, leaderboard }),
    ]);
    await confirmSignature(base, sig, { timeoutMs: 60_000 });
    log('init_leaderboard', { signature: sig, leaderboard });
  }

  const writeSig = await sendInstructions(base, treasury, [
    writeLeaderboard({ programId: PROGRAM_ID, payer: treasury.address, leaderboard, arena, players }),
  ]);
  await confirmSignature(base, writeSig, { timeoutMs: 60_000 });
  const { value: lbAfter } = await base.getAccountInfo(leaderboard, { encoding: 'base64' }).send();
  if (lbAfter === null) throw new Error('leaderboard vanished');
  const board = decodeLeaderboard(Uint8Array.from(Buffer.from(lbAfter.data[0], 'base64')));
  const ours = board.entries.filter((e) => e.arenaId === arenaId);
  log('leaderboard', {
    signature: writeSig,
    totalWritten: board.totalWritten,
    next: board.next,
    lastArenaId: board.lastArenaId.toString(),
    lastIncarnation: board.lastIncarnation,
    rowsForThisMatch: ours.map((e) => ({
      incarnation: e.incarnation,
      damageDealt: e.damageDealt,
      survived: e.survived,
    })),
    note:
      'LeaderboardEntry carries no outcome field; a wiped raid and a won raid differ only ' +
      'in `survived`, which is sampled from hp at settle time',
  });
}

// ---------------------------------------------------------------------------
// Phase B — the enrage deadline
// ---------------------------------------------------------------------------

async function phaseB(): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const base = createRpc(BASE_URL);
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { match, arena, boss, players } = await openMatch(base, treasury, arenaId);

  // Nobody enters. `arena_occupants == 0`, so `tick::step` cannot reach the wipe branch
  // at all and `enrage_at_tick` is the only ending available.
  const deadline = Date.now() + ENRAGE_MS;
  let final = await snapshot(match.er, arena, boss, players);
  while (Date.now() < deadline) {
    await sleep(10_000);
    final = await snapshot(match.er, arena, boss, players);
    log('enrage_watch', {
      tick: final.tick,
      phase: final.phase,
      outcome: final.outcome,
      aliveCount: final.aliveCount,
      activeBullets: final.activeBullets,
    });
    if (final.phase !== PHASE_FIGHTING) break;
  }
  log('phase_b_summary', {
    arenaId: arenaId.toString(),
    tick: final.tick,
    phase: final.phase,
    outcome: final.outcome,
    outcomeName: ['UNDECIDED', 'WIN', 'WIPE', 'ENRAGE'][final.outcome] ?? '?',
    isEnrage: final.outcome === OUTCOME_ENRAGE,
    isNotWipe: final.outcome !== OUTCOME_WIPE,
    isNotUndecided: final.outcome !== OUTCOME_UNDECIDED,
  });

  await endMatch(base, match, treasury, arena, boss, players, arenaId);
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  const before = await snapshot(er, arena, boss, players);
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await erOk(er, sig, 'settle', 45_000);
  log('settle_only', {
    arenaId: arenaId.toString(),
    arena,
    signature: sig,
    beforeTick: before.tick,
    beforePhase: before.phase,
    beforeOutcome: before.outcome,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const settleIndex = process.argv.indexOf('--settle-only');
  if (settleIndex !== -1) {
    await settleOnly(BigInt(process.argv[settleIndex + 1] as string));
    return;
  }
  const phase = arg('--phase') ?? 'a';
  log('start', { phase, programId: PROGRAM_ID, seats: SEATS });
  if (phase === 'b') await phaseB();
  else await phaseA();
  log('done', { phase });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    // kit renders RPC code -32003 as "Transaction signature verification failure" whatever
    // the server actually said, and the ER uses -32003 for cloner failures. The real
    // sentence is in `context`, so it is logged too.
    log('fatal', {
      error: String(error),
      context: (error as { context?: unknown }).context ?? null,
      cause: String((error as { cause?: unknown }).cause ?? ''),
      stack: (error as Error)?.stack,
    });
    process.exit(1);
  },
);
