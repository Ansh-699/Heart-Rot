/**
 * PERF-APPATH — write-to-visible on the path the app actually runs, before and after,
 * in one run.
 *
 * Every other spike in `docs/perf/` measures a component. This one measures the product:
 * it drives the **production modules** — `sendInstructions` from `packages/client` and
 * `subscribeMatch` from `app/src/net/subscribe.ts` — and reports the same quantity
 * `app/src/net/metrics.ts` puts on the telemetry panel, computed by the same rule:
 *
 *     a `move` carries a u16 `seq`; the roster echoes it into `PlayerSlot.last_move_seq`;
 *     write-to-visible for send N is (arrival of the update carrying seq N) − (the moment
 *     the send was decided, stamped before anything network happens).
 *
 * Only the **exact** seq counts, exactly as `metrics.ts` does it: `last_move_seq` is a
 * high-water mark, so charging a superseded send with a later write's round trip reports a
 * number nobody measured. A seq that never surfaces on its own is counted and reported,
 * never imputed.
 *
 * ## Why both arms run in the same run
 *
 * The 295 ms / 525 ms this run has to beat were measured weeks ago on a different evening
 * of the same home ISP. Quoting a new number against them and calling the difference the
 * improvement charges the network's mood to the code. So both arms are driven here,
 * against the same match, the same seat and the same minute, alternating in blocks of
 * `BLOCK` sends:
 *
 *   | arm      | send                                   | feed                       |
 *   |----------|----------------------------------------|----------------------------|
 *   | `BEFORE` | fresh `getLatestBlockhash` per send     | router websocket           |
 *   | `AFTER`  | `sendInstructions` (cached blockhash)   | pinned ER websocket        |
 *
 * Both feeds are the SAME production `subscribeMatch`, one of them handed `wsUrl:
 * ROUTER_WS_ENDPOINT` to pin it back onto the router. So the only difference between the
 * two feeds is the one line this run is defending, and the feed code is not a stand-in.
 *
 * Both feeds observe every write, so the 2x2 falls out for free and the two levers can be
 * attributed separately rather than as one lump:
 *
 *   fresh-blockhash send seen on the ER feed  → the websocket lever alone
 *   cached-blockhash send seen on the router  → the blockhash lever alone
 *
 * ## Why the lobby and not a fight
 *
 * `move_clock` returns the ER slot in every phase, so a lobby seat may move once per 50 ms
 * slot exactly as a fighting seat may. `start_match` is still sent, so the crank rewrites
 * `Arena` and `Boss` every 100 ms and both three-account subscriptions carry the traffic a
 * real match puts on them. An empty arena is explicitly not a wipe
 * (`tick.rs::damage_kills_respawns_and_wipes`), so the match holds `Fighting` throughout.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_appath.ts --bundle --platform=node --format=esm \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_appath.mjs
 *   PA_SAMPLES=300 node /tmp/perf_appath.mjs --out docs/perf/appath-run1.jsonl
 *
 * `--settle-only <arenaId>` cancels the crank task an aborted run left armed. Always run
 * it after an abort: an abandoned task ticks for its full iteration count.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  AccountRole,
  createKeyPairSignerFromBytes,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  assertErIdentity,
  claimSeat,
  confirmSignature,
  connectMatch,
  createRpc,
  createSessionSigner,
  decodeArena,
  decodePlayers,
  delegate,
  getDelegationStatus,
  getRoutes,
  initArena,
  isWall,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
  startMatch,
  stringifyWithBigints,
  type HeartrotRpc,
  type MatchConnections,
  type Session,
} from '@heartrot/client';

import { ROUTER_WS_ENDPOINT, subscribeMatch } from '../../app/src/net/subscribe';

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;
const SYSTEM_ID = '11111111111111111111111111111111' as Address;

/** `sp2_crank.ts`: the ER charges 6,960 lamports/byte of rent, devnet 6,333. */
const ER_LAMPORTS_PER_BYTE = 6_960n;
/** `player::MOVE_STEP` — one 16-unit tile per cardinal step. */
const STEP = 16;
/** `map::MAP_MAX_XY`, restated so a step off the lattice is caught before it is sent. */
const MAP_MAX_XY = 63 * 16 + 15;

/** Samples per arm. Both arms get this many, so the run sends twice it. */
const SAMPLES = Number(process.env.PA_SAMPLES ?? 300);
/**
 * Consecutive sends in one arm before switching. Small enough that a 30 s network wobble
 * lands on both arms, large enough that the blockhash cache behaves as it does in play
 * (the first send of an `AFTER` block may find the cache stale and pay a refresh, which is
 * a real cost of the design and is deliberately left inside the numbers).
 */
const BLOCK = Number(process.env.PA_BLOCK ?? 25);
/**
 * Decide-to-decide pacing. The `BEFORE` arm spends a round trip on its blockhash before it
 * sends, so 250 ms keeps consecutive writes at least two ER slots apart in both arms —
 * `move_player` refuses a second move in the same slot and a refusal is not a round trip.
 */
const SEND_EVERY_MS = Number(process.env.PA_SEND_MS ?? 250);

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/perf_appath.jsonl' : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${stringifyWithBigints(line)}\n`);
  console.log(`${line.t} ${event} ${stringifyWithBigints(fields)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Date.now();

/**
 * `metrics.ts::percentile` — nearest-rank, restated rather than imported because the app's
 * copy is bound to its own sliding sample buffer. Same rule, so the numbers are comparable
 * to the panel's.
 */
function pct(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

function stats(values: readonly number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.length === 0 ? null : Math.round((sum / sorted.length) * 10) / 10,
  };
}

function histogram(values: readonly number[], bucket: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = String(Math.floor(v / bucket) * bucket);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function transfer(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_ID,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

async function topUpForEr(
  base: HeartrotRpc,
  treasury: Parameters<typeof sendInstructions>[1],
  accounts: readonly Address[],
): Promise<void> {
  const transfers: Instruction[] = [];
  for (const account of accounts) {
    const { value } = await base.getAccountInfo(account, { encoding: 'base64' }).send();
    if (value === null) throw new Error(`${account} does not exist on the base layer`);
    const space = BigInt(Buffer.from(value.data[0], 'base64').length);
    const needed = (128n + space) * ER_LAMPORTS_PER_BYTE;
    const have = BigInt(value.lamports);
    if (have < needed) transfers.push(transfer(treasury.address, account, needed - have));
  }
  if (transfers.length === 0) return;
  const sig = await sendInstructions(base, treasury, transfers);
  await confirmSignature(base, sig, { timeoutMs: 60_000 });
  log('er_rent_topup', { signature: sig, count: transfers.length });
}

async function confirmEr(rpc: HeartrotRpc, signature: string, what: string, timeoutMs = 25_000) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const { value } = await rpc
      .getSignatureStatuses([signature as Parameters<HeartrotRpc['getSignatureStatuses']>[0][0]])
      .send();
    const status = value[0];
    if (status != null) {
      if (status.err !== null) {
        throw new Error(`${what} (${signature}) failed: ${stringifyWithBigints(status.err)}`);
      }
      return;
    }
    if (now() >= deadline) throw new Error(`${what} (${signature}) never appeared`);
    await sleep(300);
  }
}

async function readPlayers(rpc: HeartrotRpc, players: Address) {
  const { value } = await rpc.getAccountInfo(players, { encoding: 'base64' }).send();
  if (value === null) throw new Error('players vanished');
  return decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
}

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

interface Feed {
  readonly name: string;
  /** seq -> the wall clock at which this feed first carried it. */
  readonly arrivals: Map<number, number>;
  playersUpdates: number;
  arenaUpdates: number;
  close(): void;
}

/**
 * One production `subscribeMatch`, wired to record when each `last_move_seq` first
 * arrived. `wsUrl` undefined lets it do what it does in the app: ask the pinned `rpc` for
 * its identity and resolve that identity's own websocket out of the router's routes table.
 * `wsUrl: ROUTER_WS_ENDPOINT` pins it back to the router, which is what shipped before.
 */
function openFeed(cfg: {
  name: string;
  rpc: HeartrotRpc;
  arena: Address;
  boss: Address;
  players: Address;
  seat: number;
  wsUrl?: string;
}): Feed {
  const feed: Feed = {
    name: cfg.name,
    arrivals: new Map(),
    playersUpdates: 0,
    arenaUpdates: 0,
    close: () => undefined,
  };
  let lastSeen = -1;
  const sub = subscribeMatch({
    rpc: cfg.rpc,
    arena: cfg.arena as never,
    boss: cfg.boss as never,
    players: cfg.players as never,
    ...(cfg.wsUrl === undefined ? {} : { wsUrl: cfg.wsUrl }),
    onArena: () => {
      feed.arenaUpdates += 1;
    },
    onBoss: () => undefined,
    onPlayers: (players) => {
      const at = now();
      feed.playersUpdates += 1;
      const slot = players.slots[cfg.seat];
      if (slot === undefined) return;
      // Strictly increasing: the snapshot on `open` and a watchdog resnapshot can both
      // replay a seq already recorded, and letting a re-read count as a fresh arrival
      // would time a write against a read that happened later for unrelated reasons.
      if (slot.lastMoveSeq <= lastSeen) return;
      lastSeen = slot.lastMoveSeq;
      if (!feed.arrivals.has(slot.lastMoveSeq)) feed.arrivals.set(slot.lastMoveSeq, at);
    },
    onHealth: (health) => {
      if (health === 'stalled' || health === 'dead') log('feed_health', { feed: cfg.name, health });
    },
  });
  feed.close = () => sub.close();
  return feed;
}

// ---------------------------------------------------------------------------
// The two send paths
// ---------------------------------------------------------------------------

/**
 * The `BEFORE` send: `getLatestBlockhash` on the critical path, then build, sign and post.
 *
 * This is `sendInstructions` as it stood before the cache — byte-identical transaction,
 * same signer, same `skipPreflight`, one extra serial round trip to Singapore in front of
 * it. Kept here rather than behind a flag in `packages/client` so the shipped send path
 * has exactly one shape and no branch a caller can get wrong.
 */
async function legacySend(
  rpc: HeartrotRpc,
  feePayer: Parameters<typeof sendInstructions>[1],
  instructions: readonly Instruction[],
): Promise<void> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  void getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadTreasury() {
  return createKeyPairSignerFromBytes(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
    ),
  );
}

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await loadTreasury();
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(er, sig, 'settle', 40_000);
  log('settle_only', { arenaId: arenaId.toString(), signature: sig });
}

async function main(): Promise<void> {
  const settleIndex = process.argv.indexOf('--settle-only');
  if (settleIndex !== -1) {
    await settleOnly(BigInt(process.argv[settleIndex + 1] as string));
    return;
  }

  const treasury = await loadTreasury();
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  log('start', {
    arenaId: arenaId.toString(),
    arena,
    boss,
    players,
    samplesPerArm: SAMPLES,
    block: BLOCK,
    sendEveryMs: SEND_EVERY_MS,
  });

  const base = createRpc(BASE_URL);

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

  let match: MatchConnections;
  try {
    match = await connectMatch({
      baseUrl: BASE_URL,
      accounts: [arena, boss, players],
      validatorIdentity: DEVNET_AS_IDENTITY,
      ownerProgram: PROGRAM_ID,
      timeoutMs: 30_000,
    });
  } catch (error) {
    log('connect_match_failed', { error: String(error).slice(0, 200) });
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
  }
  log('connected', { erFqdn: match.erFqdn, routerWs: ROUTER_WS_ENDPOINT });

  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, startSig, 'start_match');
  log('start_match', { signature: startSig });

  // The seat's key is a non-extractable WebCrypto Ed25519 pair and its signer is the
  // production `createSessionSigner`, so the fee payer here is a zero-SOL key exactly as
  // it is in the browser (D6) and the transaction carries one signature, not two.
  const seat = 0;
  const keyPair = await generateKeyPair();
  const session = await getAddressFromPublicKey(keyPair.publicKey);
  const signer = createSessionSigner({ address: session, keyPair } as unknown as Session);

  const claimSig = await sendInstructions(match.er, treasury, [
    claimSeat({
      programId: PROGRAM_ID,
      arena,
      players,
      treasury: treasury.address,
      seat,
      skinId: 0,
      sessionPubkey: session,
      identity: Uint8Array.from(randomBytes(32)),
    }),
  ]);
  await confirmEr(match.er, claimSig, 'claim_seat');
  log('claim_seat', { signature: claimSig, seat, session });

  // A walkable axis at the spawn tile. Oscillating between two adjacent floor tiles keeps
  // every send accepted; a wall would return `BlockedByWall` and silently stop the clock.
  const spawn = (await readPlayers(match.er, players)).slots[seat];
  if (spawn === undefined) throw new Error('seat 0 missing after claim');
  const cardinals: readonly { dir: number; dx: number; dy: number }[] = [
    { dir: 0, dx: 0, dy: -STEP },
    { dir: 2, dx: STEP, dy: 0 },
    { dir: 4, dx: 0, dy: STEP },
    { dir: 6, dx: -STEP, dy: 0 },
  ];
  const walkable = cardinals.find((c) => {
    const nx = spawn.x + c.dx;
    const ny = spawn.y + c.dy;
    return nx >= 0 && ny >= 0 && nx <= MAP_MAX_XY && ny <= MAP_MAX_XY && !isWall(nx, ny);
  });
  if (walkable === undefined) throw new Error(`seat ${seat} is walled in at ${spawn.x},${spawn.y}`);
  const dirs = [walkable.dir, (walkable.dir + 4) % 8];
  log('axis', { x: spawn.x, y: spawn.y, dirs });

  // ---- feeds -------------------------------------------------------------
  const erFeed = openFeed({ name: 'ER (shipped)', rpc: match.er, arena, boss, players, seat });
  const routerFeed = openFeed({
    name: 'ROUTER (was shipped)',
    rpc: match.er,
    arena,
    boss,
    players,
    seat,
    wsUrl: ROUTER_WS_ENDPOINT,
  });
  // `subscribeMatch` resolves its url, opens, subscribes and snapshots asynchronously with
  // no ready signal of its own; the first `Arena` update is the honest proof both sockets
  // are carrying traffic, and the crank supplies one every 100 ms.
  const feedsUp = await (async () => {
    const deadline = now() + 20_000;
    while (now() < deadline) {
      if (erFeed.arenaUpdates > 1 && routerFeed.arenaUpdates > 1) return true;
      await sleep(200);
    }
    return false;
  })();
  if (!feedsUp) throw new Error('one of the two feeds never carried an Arena update');
  log('feeds_live', { er: erFeed.arenaUpdates, router: routerFeed.arenaUpdates });

  // ---- the send loop -----------------------------------------------------
  /** seq -> the moment the send was decided. This is `recordSend`'s clock. */
  const sendAt = new Map<number, number>();
  /** seq -> which arm sent it. */
  const armOf = new Map<number, 'before' | 'after'>();
  const postMs: Record<'before' | 'after', number[]> = { before: [], after: [] };
  const failures: Record<'before' | 'after', number> = { before: 0, after: 0 };

  const total = SAMPLES * 2;
  for (let i = 0; i < total; i += 1) {
    const seq = i + 1;
    // Blocks alternate, so a slow minute lands on both arms rather than on one.
    const arm: 'before' | 'after' = Math.floor(i / BLOCK) % 2 === 0 ? 'after' : 'before';
    const dir = dirs[i % 2] as number;
    const ix = movePlayer({ programId: PROGRAM_ID, arena, players, session, seat, dir, seq });

    // Stamped exactly where `App.tsx` calls `recordSend(seq)`: before the send path is
    // entered, so whatever it does — including the `BEFORE` arm's blockhash round trip —
    // is inside the number, which is what the panel reports.
    const t0 = now();
    sendAt.set(seq, t0);
    armOf.set(seq, arm);
    const sent =
      arm === 'after'
        ? sendInstructions(match.er, signer, [ix]).then(() => undefined)
        : legacySend(match.er, signer, [ix]);
    void sent.then(
      () => postMs[arm].push(now() - t0),
      (error: unknown) => {
        failures[arm] += 1;
        if (failures[arm] <= 3) log('send_failed', { arm, seq, error: String(error).slice(0, 160) });
      },
    );

    const elapsed = now() - t0;
    if (elapsed < SEND_EVERY_MS) await sleep(SEND_EVERY_MS - elapsed);
    if (seq % 100 === 0) {
      log('progress', { seq, erAcked: erFeed.arrivals.size, routerAcked: routerFeed.arrivals.size });
    }
  }

  // Drain: nothing in flight is older than a couple of round trips.
  await sleep(4_000);
  erFeed.close();
  routerFeed.close();
  log('drained', {
    failures,
    postMs: { before: stats(postMs.before), after: stats(postMs.after) },
  });

  // ---- results -----------------------------------------------------------
  /** The 2x2. `feed` names where it was observed, `arm` names how it was sent. */
  const cell = (feed: Feed, arm: 'before' | 'after'): number[] => {
    const out: number[] = [];
    for (const [seq, at] of feed.arrivals) {
      if (armOf.get(seq) !== arm) continue;
      const sent = sendAt.get(seq);
      if (sent !== undefined) out.push(at - sent);
    }
    return out;
  };

  const beforeArm = cell(routerFeed, 'before');
  const afterArm = cell(erFeed, 'after');
  const wsOnly = cell(erFeed, 'before');
  const blockhashOnly = cell(routerFeed, 'after');

  log('headline', {
    BEFORE: { what: 'fresh blockhash per send, router websocket', writeToVisibleMs: stats(beforeArm) },
    AFTER: { what: 'cached blockhash, pinned ER websocket', writeToVisibleMs: stats(afterArm) },
  });
  log('levers', {
    wsLeverOnly: { what: 'fresh blockhash, ER websocket', writeToVisibleMs: stats(wsOnly) },
    blockhashLeverOnly: { what: 'cached blockhash, router websocket', writeToVisibleMs: stats(blockhashOnly) },
  });
  log('histograms', {
    BEFORE: histogram(beforeArm, 50),
    AFTER: histogram(afterArm, 50),
  });
  // Every sample, so the summary above can be recomputed — or pooled across runs — without
  // rerunning the spike. A percentile nobody can re-derive is an assertion, not evidence.
  log('raw', { BEFORE: beforeArm, AFTER: afterArm, wsLeverOnly: wsOnly, blockhashLeverOnly: blockhashOnly });

  // Paired, per seq: the same write observed on both feeds, so the submit half cancels
  // exactly and what is left is the websocket difference alone.
  const paired: number[] = [];
  let erFirst = 0;
  for (const [seq, at] of routerFeed.arrivals) {
    const other = erFeed.arrivals.get(seq);
    // `sendAt` is the filter, not merely a lookup: the snapshot each feed takes on `open`
    // carries the seat's `last_move_seq` as it already stands — 0 straight after
    // `claim_seat` — and that is a read, not a send, so it has no send time and must not
    // be counted as an acknowledgement.
    if (other === undefined || !sendAt.has(seq)) continue;
    paired.push(at - other);
    if (other < at) erFirst += 1;
  }
  log('paired_router_minus_er', {
    n: paired.length,
    erFirstShare: paired.length === 0 ? null : Math.round((erFirst / paired.length) * 100) / 100,
    deltaMs: stats(paired),
  });

  const ackedOf = (feed: Feed): number => {
    let n = 0;
    for (const seq of feed.arrivals.keys()) if (sendAt.has(seq)) n += 1;
    return n;
  };
  const seen = { er: ackedOf(erFeed), router: ackedOf(routerFeed) };
  const failed = failures.before + failures.after;
  log('summary', {
    sent: total,
    perArm: SAMPLES,
    failures,
    seqsAcked: seen,
    seqsNeverSeen: { er: total - seen.er - failed, router: total - seen.router - failed },
    playersUpdates: { er: erFeed.playersUpdates, router: routerFeed.playersUpdates },
    arena: await (async () => {
      const { value } = await match.er.getAccountInfo(arena, { encoding: 'base64' }).send();
      if (value === null) return null;
      const a = decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
      return { phase: a.phase, tick: a.tick };
    })(),
  });

  const settleSig = await sendInstructions(match.er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, settleSig, 'settle', 40_000);
  log('settled', { signature: settleSig, arenaId: arenaId.toString() });
  process.exit(0);
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error).slice(0, 400) });
  process.exit(1);
});
