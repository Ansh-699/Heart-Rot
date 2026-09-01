/**
 * SP-LOAD — latency, compute and acceptance under real concurrent load, on real devnet.
 *
 * Every previous number in this project was measured in isolation: one player moving,
 * one at a time, waiting for each write to become visible before sending the next. That
 * measures the network. It does not measure the game, because every write in this design
 * targets the same three fat accounts and the interesting question is what happens when
 * twenty seats write to `Players` at once.
 *
 * What it does, in order:
 *   1. `init_arena` + ER-rent top-up + `delegate` on the base layer, `start_match` on
 *      the ER. Real client builders throughout, so a wrong encoder fails here.
 *   2. Claims twenty seats, walks them to the gate and `enter_gate`s them, so the boss
 *      has targets and the volley is live. (Lifted from `sp2_crank.ts`; the walk is the
 *      only way into `ZONE_ARENA`.)
 *   3. A silent control window (`SPL_QUIET_MS`) with the seats in the arena and nothing
 *      being sent, which is the only way to check that the crank compute samples arrive
 *      one per `Arena.tick` rather than mixed with another arena's crank.
 *   4. Two load phases, both driving all twenty seats CONCURRENTLY — fire-and-forget
 *      sends on independent per-seat timers, never one-at-a-time:
 *        PACED      — move every 400 ms, shoot every 800 ms. Exactly the in-program
 *                     limiter's own cadence: what a perfectly behaved client gets.
 *        AGGRESSIVE — move and shoot every 150 ms. What a real client sending on input
 *                     rather than on the tick clock produces.
 *   5. Three independent latency instruments on every transaction:
 *        send -> accepted  the `sendTransaction` POST returning
 *        send -> executed  the transaction's own logs arriving over `logsSubscribe`
 *        send -> visible   a poller reading the write back out of `Players`
 *      Only the third is comparable to the 405 ms single-player baseline, and it is
 *      measured with the same instrument: poll the account, look for the echo.
 *   6. Compute, split by who spent it. `logsSubscribe` reports `consumed X of Y` for
 *      every transaction mentioning the program — ours and the crank's alike — so the
 *      run keeps the set of signatures it sent and calls everything else a crank tick.
 *      That yields a real distribution for `move`, for `shoot` and for the loaded crank,
 *      rather than one number for the crank alone.
 *   7. Acceptance. `getSignatureStatuses` on every signature sent, bucketed by error
 *      code, so `Custom(7) = RateLimited` is counted rather than inferred.
 *   8. The unresolved SP1 probe, re-run: a 40-account-key transaction on the ER, now
 *      polled for an actual confirmation status instead of dying in the BigInt defect.
 *   9. `settle` — cancels the crank task. An abandoned task ticks for its full
 *      iteration count, so every abort needs `--settle-only <arenaId>`.
 *
 * JSONL to `--out`; the markdown is written by hand from it.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp_load.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=packages/client/src/index.ts \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=<tmp>/sp_load.mjs
 *   SPL_QUIET_MS=40000 SPL_PACED_MS=60000 SPL_AGGRESSIVE_MS=60000 \
 *     node <tmp>/sp_load.mjs --out <tmp>/sp_load.jsonl
 *
 * `--key-sweep` runs the account-key ceiling probe alone and needs no arena.
 * `--settle-only <arenaId>` cancels the crank task an aborted run left armed — always,
 * because an uncancelled task ticks for its full 4,500 iterations.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPair,
  getAddressEncoder,
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
  MAX_SEATS,
  PHASE_FIGHTING,
  ZONE_ARENA,
  assertErIdentity,
  claimSeat,
  confirmSignature,
  connectMatch,
  createRpc,
  decodeArena,
  decodeBoss,
  decodePlayers,
  delegate,
  enterGate,
  getDelegationStatus,
  getRoutes,
  initArena,
  isWall,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
  shoot,
  startMatch,
  stringifyWithBigints,
  type HeartrotRpc,
  type MatchConnections,
} from '@heartrot/client';

// ---------------------------------------------------------------------------
// Constants mirrored from the program. Read, never invented.
// ---------------------------------------------------------------------------

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;

/** `player::GATE_MIN_*`/`GATE_MAX_*` — tiles 30..=33 on both axes, in arena units. */
const GATE_MIN = 30 * 16;
const GATE_MAX = 34 * 16 - 1;
/** `player::STEP` — cardinal moves only, so every walk stays on one 16-unit lattice. */
const STEP = 16;
const CARDINALS: readonly { dir: number; dx: number; dy: number }[] = [
  { dir: 0, dx: 0, dy: -STEP },
  { dir: 2, dx: STEP, dy: 0 },
  { dir: 4, dx: 0, dy: STEP },
  { dir: 6, dx: -STEP, dy: 0 },
];

/** `shoot::SHOT_COOLDOWN_TICKS = 1` → one accepted shot every two ticks. */
const SHOT_COOLDOWN_TICKS = 1;
/** `player::move_player` refuses a second move in the same tick. */
const MOVE_COOLDOWN_TICKS = 1;
/** The crank's scheduled interval, from `settle::CRANK_INTERVAL_MS`-equivalent research. */
const TICK_MS = 400;

/** `HeartrotError::RateLimited`. The one rejection this spike is counting. */
const ERR_RATE_LIMITED = 7;
/** `HeartrotError::BlockedByWall`. Should be zero: the client predicts it. */
const ERR_BLOCKED_BY_WALL = 14;

const PACED_MS = Number(process.env.SPL_PACED_MS ?? 50_000);
const AGGRESSIVE_MS = Number(process.env.SPL_AGGRESSIVE_MS ?? 50_000);
const SEATS = Math.min(Number(process.env.SPL_SEATS ?? MAX_SEATS), MAX_SEATS);
/** Independent read loops on `Players`. More loops, finer visibility sampling. */
const POLLERS = Number(process.env.SPL_POLLERS ?? 3);
/** A silent window after the seats are in, to count crank ticks against crank samples. */
const QUIET_MS = Number(process.env.SPL_QUIET_MS ?? 0);

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/sp_load.jsonl' : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${stringifyWithBigints(line)}\n`);
  console.log(`${line.t} ${event} ${stringifyWithBigints(fields)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Date.now();

function loadKeypairBytes(path: string): Uint8Array {
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over an already-sorted array. */
function pct(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

function stats(values: readonly number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? null,
  };
}

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

/** See `sp2_crank.ts`: the ER's rent rate is 6,960/byte, devnet's is 6,333. */
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

/**
 * `SetComputeUnitLimit`, hand-encoded, doubling as the uniqueness nonce.
 *
 * Two shots from the same seat in the same direction under the same blockhash compile to
 * byte-identical messages, hence identical signatures, and the node silently deduplicates
 * the second — which would show up as a phantom "dropped" transaction and quietly corrupt
 * the acceptance rate this spike exists to measure. Varying the declared limit varies the
 * message. It costs nothing: ER fees are zero and the limit is never approached.
 */
function computeBudgetNonce(n: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, 250_000 + (n % 150_000), true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

/**
 * Multi-signer send against a cached blockhash.
 *
 * The client's builders emit plain address metas, so kit's signer discovery cannot find a
 * session key; this compiles the message and signs it with raw key pairs. The blockhash is
 * cached rather than fetched per transaction because a `getLatestBlockhash` round trip in
 * front of every send would add the very latency the run is measuring.
 */
async function signSigned(
  blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
  feePayer: Address,
  keyPairs: readonly CryptoKeyPair[],
  instructions: readonly Instruction[],
): Promise<{ wire: string; signature: Signature }> {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransaction(keyPairs, compileTransaction(message));
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
  };
}

async function postWire(rpc: HeartrotRpc, wire: string): Promise<void> {
  await rpc
    .sendTransaction(wire as Parameters<HeartrotRpc['sendTransaction']>[0], {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
}

async function sendSigned(
  rpc: HeartrotRpc,
  blockhash: Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0],
  feePayer: Address,
  keyPairs: readonly CryptoKeyPair[],
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { wire, signature } = await signSigned(blockhash, feePayer, keyPairs, instructions);
  await postWire(rpc, wire);
  return signature;
}

/**
 * Confirm on the ER, recording whatever `confirmationStatus` it reports rather than
 * insisting on `confirmed` — one validator with no consensus need not produce one.
 */
async function confirmEr(
  rpc: HeartrotRpc,
  signature: Signature,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status != null) {
      if (status.err !== null) {
        throw new Error(`${what} (${signature}) failed: ${stringifyWithBigints(status.err)}`);
      }
      return;
    }
    if (now() >= deadline) {
      throw new Error(`${what} (${signature}) never appeared in getSignatureStatuses`);
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Walking the lobby (from sp2_crank.ts — the only route into ZONE_ARENA)
// ---------------------------------------------------------------------------

const onGate = (x: number, y: number): boolean =>
  x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;

function pathToGate(x: number, y: number): number[] | null {
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
        if (onGate(nx, ny)) {
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
 * Firing stations: a ring of radius `STATION_R` around the boss spawn, keeping only the
 * octants whose station is floor under the client's own generated wall table. Two of the
 * eight are inside the east and west walls of the boss chamber — the first run parked
 * every seat against the outer wall instead and 73 % of its moves came back
 * `Custom(14) BlockedByWall`, which measured the driver rather than the chain.
 */
const STATION_R = 120;
const BOSS_SPAWN: readonly [number, number] = [512, 320];
const STATIONS: readonly { oct: number; x: number; y: number }[] = (() => {
  const unit: readonly [number, number][] = [
    [0, -1], [0.7071, -0.7071], [1, 0], [0.7071, 0.7071],
    [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071],
  ];
  const out: { oct: number; x: number; y: number }[] = [];
  for (let oct = 0; oct < 8; oct += 1) {
    const [ux, uy] = unit[oct] as readonly [number, number];
    const x = Math.round(BOSS_SPAWN[0] + ux * STATION_R);
    const y = Math.round(BOSS_SPAWN[1] + uy * STATION_R);
    if (!isWall(x, y)) out.push({ oct, x, y });
  }
  return out;
})();

const clampXY = (v: number): number => Math.min(Math.max(v, 0), 1023);

/**
 * One cardinal step toward `(tx, ty)` that the client's wall table says is open, or
 * `null` when the seat is boxed in.
 *
 * The chain clamps before it tests, so this clamps before it tests. Cardinals only:
 * `MOVE_STEP`'s diagonals are `STEP_DIAG`, which is not `TILE`, and a diagonal walk
 * leaves the 16-unit lattice the wall table is sampled on.
 */
function stepToward(x: number, y: number, tx: number, ty: number): number | null {
  const options = CARDINALS.map(({ dir, dx, dy }) => {
    const nx = clampXY(x + dx);
    const ny = clampXY(y + dy);
    return { dir, nx, ny, cost: Math.abs(nx - tx) + Math.abs(ny - ty) };
  }).filter((o) => !isWall(o.nx, o.ny));
  if (options.length === 0) return null;
  options.sort((a, b) => a.cost - b.cost);
  return (options[0] as { dir: number }).dir;
}

/** Inverse of the client's `octantStep`: a vector to the eight-way direction byte. */
function dirToward(dx: number, dy: number): number {
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (sx === 0 && sy === 0) return 0;
  if (sx === 0) return sy < 0 ? 0 : 4;
  if (sy === 0) return sx > 0 ? 2 : 6;
  if (sx > 0) return sy < 0 ? 1 : 3;
  return sy < 0 ? 7 : 5;
}

// ---------------------------------------------------------------------------
// The transaction ledger — one row per send, filled in by three observers
// ---------------------------------------------------------------------------

type Kind = 'move' | 'shoot';

type Row = {
  seat: number;
  kind: Kind;
  phase: string;
  seq: number;
  /** The signature, once the RPC accepted it. Empty when the send itself failed. */
  sig: string;
  tSend: number;
  /** `sendTransaction` returned. */
  tAccepted: number | null;
  /** The transaction's own logs arrived over `logsSubscribe`. */
  tExecuted: number | null;
  /** A poller read the write back out of `Players`. */
  tVisible: number | null;
  /** True when the poller saw this exact `seq`, false when it saw a later one. */
  visibleExact: boolean;
  /** `getSignatureStatuses` answered. */
  tStatus: number | null;
  /** `null` = accepted, a number = `Custom(n)`, a string = anything else. */
  err: number | string | null;
  cu: number | null;
  sendError: string | null;
};

const rows = new Map<string, Row>();
/**
 * `PlayerSlot.last_move_seq` per seat, continued across phases.
 *
 * Restarting at 1 in the second phase made the poller resolve every fresh row instantly:
 * the chain still held the first phase's last sequence, which is `>=` any new one, so
 * `write-to-visible` picked up 4 ms samples that never happened. Whatever measures a
 * monotonic echo has to be monotonic itself.
 */
const seqOf = new Map<number, number>();
/** Signatures this run sent, so a `consumed` line from anything else is the crank. */
const oursBySig = new Set<string>();

// ---------------------------------------------------------------------------
// Observer 1 — logsSubscribe: execution timestamps and every CU number
// ---------------------------------------------------------------------------

type CrankCu = { at: number; consumed: number; of: number; sig: string };

/**
 * Signatures already recorded as a crank tick. The ER delivers the same `logsSubscribe`
 * notification for a transaction more than once — run 2 logged 479 crank samples across
 * 77 s while `Arena.tick` advanced 192, i.e. ~2.5 deliveries per tick — and counting each
 * delivery inflates `n` and reweights the percentiles toward whichever transactions the
 * validator happened to repeat.
 */
const crankSeen = new Set<string>();

/**
 * Subscribe on **this arena**, not on the program.
 *
 * `mentions: [PROGRAM_ID]` catches every arena this program owns, and abandoned arenas
 * keep ticking: a crank task runs for its full 4,500 iterations unless `settle` cancels
 * it, so a spike that crashed hours ago is still spending compute on this validator. A
 * silent 60 s control window measured 150 ticks of *this* arena against 338 program
 * `consumed` lines — 2.25 per tick — and the surplus was other matches' cranks, mixed
 * into this run's compute distribution at their own bullet load. Every instruction this
 * spike sends carries the arena account, so filtering on it loses nothing.
 */
function watchLogs(wsUrl: string, arena: Address, crank: CrankCu[]): { close: () => void } {
  let socket = new WebSocket(wsUrl);
  let closed = false;

  const wire = (ws: WebSocket): void => {
    ws.onopen = (): void => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [arena] }, { commitment: 'processed' }],
        }),
      );
      log('logs_subscribe_sent', { wsUrl });
    };
    ws.onmessage = (ev: MessageEvent): void => {
      let msg: {
        result?: unknown;
        error?: unknown;
        params?: { result?: { value?: { signature?: string; logs?: string[]; err?: unknown } } };
      };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.error !== undefined) {
        log('logs_subscribe_error', { error: msg.error });
        return;
      }
      if (msg.result !== undefined && msg.params === undefined) {
        log('logs_subscribe_ok', { subscription: msg.result });
        return;
      }
      const value = msg.params?.result?.value;
      if (value?.logs === undefined) return;
      const at = now();
      const sig = value.signature ?? '';
      const row = rows.get(sig);
      // Only the program's own line. The crank transaction also carries a `Crank111…`
      // line, and counting both would double every crank sample.
      let consumed: number | null = null;
      for (const line of value.logs) {
        const m = /^Program (\S+) consumed (\d+) of (\d+) compute units$/.exec(line);
        if (m === null || m[1] !== PROGRAM_ID) continue;
        consumed = Number(m[2]);
        if (row === undefined && !oursBySig.has(sig) && !crankSeen.has(sig)) {
          crankSeen.add(sig);
          crank.push({ at, consumed, of: Number(m[3]), sig });
        }
      }
      if (row !== undefined) {
        row.tExecuted ??= at;
        row.cu ??= consumed;
      }
    };
    ws.onclose = (): void => {
      if (closed) return;
      log('logs_ws_closed_reconnecting');
      setTimeout(() => {
        if (closed) return;
        socket = new WebSocket(wsUrl);
        wire(socket);
      }, 1_000);
    };
    ws.onerror = (): void => {
      log('logs_ws_error');
    };
  };
  wire(socket);
  return {
    close: (): void => {
      closed = true;
      socket.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Observer 2 — the visibility poller
// ---------------------------------------------------------------------------

/**
 * Pending moves per seat, oldest first. A poller that reads `last_move_seq = S` resolves
 * every pending row with `seq <= S`: the row for exactly `S` is an exact observation, and
 * an older one whose window the poller missed is resolved at the same timestamp and
 * flagged inexact — which can only ever *overstate* its latency, never understate it.
 */
const pendingMoves: Row[][] = [];

/** Gaps between consecutive reads, i.e. the instrument's own granularity. */
const pollGaps: number[] = [];

/**
 * Live seat positions, written by whichever poller read last. The steering needs these
 * fresh: an accepted move relocates a seat by 16 units and a stale position aims the next
 * step at a wall the seat has already left.
 */
const seatPos: [number, number][] = [];

async function pollVisibility(
  rpc: HeartrotRpc,
  players: Address,
  stop: () => boolean,
): Promise<void> {
  let last = now();
  while (!stop()) {
    try {
      const { value } = await rpc.getAccountInfo(players, { encoding: 'base64' }).send();
      const at = now();
      pollGaps.push(at - last);
      last = at;
      if (value === null) continue;
      const slots = decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64'))).slots;
      for (let seat = 0; seat < SEATS; seat += 1) {
        const slot = slots[seat];
        if (slot !== undefined) seatPos[seat] = [slot.x, slot.y];
        const observed = slot?.lastMoveSeq;
        if (observed === undefined) continue;
        const queue = pendingMoves[seat];
        if (queue === undefined) continue;
        while (queue.length > 0) {
          const row = queue[0] as Row;
          if (row.seq > observed) break;
          row.tVisible = at;
          row.visibleExact = row.seq === observed;
          queue.shift();
        }
      }
    } catch (error) {
      log('poll_error', { error: String(error).slice(0, 200) });
      await sleep(200);
    }
  }
}

// ---------------------------------------------------------------------------
// Observer 3 — the status poller: the acceptance ledger
// ---------------------------------------------------------------------------

/** `getSignatureStatuses` takes at most 256 signatures per call. */
const STATUS_BATCH = 200;

function classify(err: unknown): number | string {
  // kit hands back `{ InstructionError: [<index>, { Custom: <code> }] }` with bigints.
  const ie = (err as { InstructionError?: unknown } | null)?.InstructionError;
  if (Array.isArray(ie) && ie.length === 2) {
    const detail = ie[1] as unknown;
    const custom = (detail as { Custom?: unknown } | null)?.Custom;
    if (typeof custom === 'bigint' || typeof custom === 'number') return Number(custom);
    return String(typeof detail === 'string' ? detail : stringifyWithBigints(detail));
  }
  return stringifyWithBigints(err);
}

async function pollStatuses(rpc: HeartrotRpc, stop: () => boolean): Promise<void> {
  while (!stop()) {
    const open = [...rows.values()].filter(
      (r) => r.tStatus === null && r.sendError === null && now() - r.tSend < 45_000,
    );
    if (open.length === 0) {
      await sleep(300);
      continue;
    }
    const batch = open.slice(0, STATUS_BATCH);
    const sigs = batch.map((r) => r.sig as Signature);
    try {
      const { value } = await rpc.getSignatureStatuses(sigs).send();
      const at = now();
      for (let i = 0; i < batch.length; i += 1) {
        const status = value[i];
        if (status == null) continue;
        const row = batch[i] as Row;
        row.tStatus = at;
        row.err = status.err === null ? null : classify(status.err);
      }
    } catch (error) {
      log('status_poll_error', { error: String(error).slice(0, 200) });
    }
    await sleep(400);
  }
}

// ---------------------------------------------------------------------------
// The load driver
// ---------------------------------------------------------------------------

type Session = { seat: number; keyPair: CryptoKeyPair; address: Address };

/**
 * Drive every seat concurrently for `durationMs`.
 *
 * One independent timer per seat per instruction kind, all firing without waiting for
 * anything — which is the whole point. Serialising on the previous write's confirmation,
 * as SP1 did, measures a round trip; this measures twenty writers contending for one
 * `Players` account.
 */
async function drivePhase(cfg: {
  rpc: HeartrotRpc;
  phase: string;
  durationMs: number;
  moveEveryMs: number;
  shootEveryMs: number;
  sessions: readonly Session[];
  treasury: { address: Address; keyPair: CryptoKeyPair };
  arena: Address;
  boss: Address;
  players: Address;
  blockhash: () => Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0];
  bossPos: () => readonly [number, number];
  seatPos: (seat: number) => readonly [number, number];
  /** Set once the arena leaves `PHASE_FIGHTING`; every further send would be `Custom(6)`. */
  fightOver: () => boolean;
}): Promise<{ from: number; to: number; attempts: number; predictedOpen: number; boxedIn: number }> {
  const from = now();
  const deadline = from + cfg.durationMs;
  let nonce = 0;
  // Counted independently of the ledger: a duplicate signature would silently overwrite a
  // row, and the gap between this and `rows.size` is the only way to see that happen.
  let attempts = 0;
  /** Moves whose destination the client's wall table called floor. */
  let predictedOpen = 0;
  /** Sends skipped because every cardinal was a wall. */
  let boxedIn = 0;

  const send = async (session: Session, kind: Kind): Promise<void> => {
    const n = (nonce += 1);
    let ix: Instruction;
    let seq = 0;
    if (kind === 'move') {
      seq = (seqOf.get(session.seat) ?? 0) + 1;
      seqOf.set(session.seat, seq);
      // Walk to this seat's firing station and hold it. Holding is not standing still:
      // a seat already on its station steps off and back, which is what a real player
      // dodging a volley does and what keeps `move` under measurement.
      const [px, py] = cfg.seatPos(session.seat);
      const station = STATIONS[session.seat % STATIONS.length] as { x: number; y: number };
      const far = Math.abs(px - station.x) + Math.abs(py - station.y) > 24;
      const target = far
        ? station
        : { x: station.x + (n % 2 === 0 ? 32 : -32), y: station.y };
      const dir = stepToward(px, py, target.x, target.y);
      if (dir === null) {
        boxedIn += 1;
        return;
      }
      ix = movePlayer({
        programId: PROGRAM_ID,
        arena: cfg.arena,
        players: cfg.players,
        session: session.address,
        seat: session.seat,
        dir,
        seq,
      });
      predictedOpen += 1;
    } else {
      const [px, py] = cfg.seatPos(session.seat);
      const [bx, by] = cfg.bossPos();
      ix = shoot({
        programId: PROGRAM_ID,
        arena: cfg.arena,
        boss: cfg.boss,
        players: cfg.players,
        session: session.address,
        seat: session.seat,
        dir: dirToward(bx - px, by - py),
      });
    }

    const tSend = now();
    const row: Row = {
      seat: session.seat,
      kind,
      phase: cfg.phase,
      seq,
      sig: '',
      tSend,
      tAccepted: null,
      tExecuted: null,
      tVisible: null,
      visibleExact: false,
      tStatus: null,
      err: null,
      cu: null,
      sendError: null,
    };
    try {
      // Sign, register, *then* post. The ER's log notification for a transaction can
      // reach `watchLogs` before its own `sendTransaction` POST has returned — measured:
      // execute p50 133 ms against accept p50 125 ms — and a row registered after the
      // POST is not in the ledger when its log arrives, so the transaction is counted as
      // somebody else's and lands in the crank's compute distribution. The first run
      // attributed roughly 770 of its own sends to the crank that way and reported a
      // crank p50 of 3,551 CU that was mostly `move` and `shoot`.
      const { wire, signature } = await signSigned(
        cfg.blockhash(),
        cfg.treasury.address,
        [cfg.treasury.keyPair, session.keyPair],
        [computeBudgetNonce(n), ix],
      );
      row.sig = signature;
      oursBySig.add(signature);
      rows.set(signature, row);
      if (kind === 'move') (pendingMoves[session.seat] as Row[]).push(row);
      await postWire(cfg.rpc, wire);
      row.tAccepted = now();
    } catch (error) {
      row.sendError = String(error).slice(0, 200);
      row.tAccepted = now();
      // Keyed on something unique so it still lands in the ledger and is counted as a
      // rejection rather than vanishing.
      rows.set(`send-failed-${cfg.phase}-${n}`, row);
    }
  };

  const loops: Promise<void>[] = [];
  for (const session of cfg.sessions) {
    for (const [kind, everyMs] of [
      ['move', cfg.moveEveryMs],
      ['shoot', cfg.shootEveryMs],
    ] as const) {
      loops.push(
        (async () => {
          // Stagger, so twenty seats do not all fire on the same millisecond and the
          // measurement becomes a study of one burst instead of sustained load.
          await sleep(Math.floor((everyMs * session.seat) / cfg.sessions.length));
          while (now() < deadline && !cfg.fightOver()) {
            const t = now();
            attempts += 1;
            void send(session, kind).catch((error: unknown) => {
              log('driver_error', { phase: cfg.phase, error: String(error).slice(0, 160) });
            });
            const slack = everyMs - (now() - t);
            if (slack > 0) await sleep(slack);
          }
        })(),
      );
    }
  }
  await Promise.all(loops);
  // Let the last sends resolve through all three observers before the window closes.
  await sleep(6_000);
  return { from, to: now(), attempts, predictedOpen, boxedIn };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(
  phase: string,
  crank: readonly CrankCu[],
  window: { from: number; to: number; attempts: number; predictedOpen: number; boxedIn: number },
): void {
  const mine = [...rows.values()].filter((r) => r.phase === phase);
  log('ledger_integrity', {
    phase,
    attempts: window.attempts,
    rows: mine.length,
    note: 'a shortfall means two sends compiled to the same signature',
  });
  const wallRejects = [...rows.values()].filter(
    (r) => r.phase === phase && r.kind === 'move' && r.err === ERR_BLOCKED_BY_WALL,
  ).length;
  log('map_agreement', {
    phase,
    clientSaidOpen: window.predictedOpen,
    chainSaidWall: wallRejects,
    boxedIn: window.boxedIn,
    note: 'every move sent had a destination the client wall table called floor; a nonzero chainSaidWall is a client/chain map divergence',
  });
  for (const kind of ['move', 'shoot'] as const) {
    const k = mine.filter((r) => r.kind === kind);
    const accepted = k.filter((r) => r.err === null && r.tStatus !== null);
    const rateLimited = k.filter((r) => r.err === ERR_RATE_LIMITED);
    const otherErr = k.filter(
      (r) => r.err !== null && r.err !== ERR_RATE_LIMITED && r.tStatus !== null,
    );
    const noStatus = k.filter((r) => r.tStatus === null && r.sendError === null);
    const sendFailed = k.filter((r) => r.sendError !== null);

    const byCode = new Map<string, number>();
    for (const r of k) {
      if (r.err === null || r.tStatus === null) continue;
      const key = String(r.err);
      byCode.set(key, (byCode.get(key) ?? 0) + 1);
    }

    log('acceptance', {
      phase,
      kind,
      sent: k.length,
      accepted: accepted.length,
      rateLimited: rateLimited.length,
      otherErr: otherErr.length,
      noStatus: noStatus.length,
      sendFailed: sendFailed.length,
      acceptedPct: k.length === 0 ? null : Math.round((accepted.length / k.length) * 1000) / 10,
      errorCodes: Object.fromEntries(byCode),
    });

    const dur = (window.to - window.from) / 1000;
    log('throughput', {
      phase,
      kind,
      sentPerSec: Math.round((k.length / dur) * 10) / 10,
      acceptedPerSec: Math.round((accepted.length / dur) * 10) / 10,
      acceptedPerSeatPerSec: Math.round((accepted.length / dur / SEATS) * 100) / 100,
    });

    log('latency_accept', {
      phase,
      kind,
      ...stats(k.filter((r) => r.tAccepted !== null).map((r) => (r.tAccepted as number) - r.tSend)),
    });
    log('latency_execute', {
      phase,
      kind,
      note: 'send -> the transaction own logs arrived over logsSubscribe',
      ...stats(
        k.filter((r) => r.tExecuted !== null).map((r) => (r.tExecuted as number) - r.tSend),
      ),
    });
    if (kind === 'move') {
      const visible = k.filter((r) => r.tVisible !== null && r.err === null);
      log('latency_write_to_visible', {
        phase,
        kind,
        note: 'accepted moves only; exact = the poller saw this exact seq',
        exact: stats(
          visible.filter((r) => r.visibleExact).map((r) => (r.tVisible as number) - r.tSend),
        ),
        all: stats(visible.map((r) => (r.tVisible as number) - r.tSend)),
      });
    }
    log('cu_self', {
      phase,
      kind,
      note: 'the program own consumed line on our transactions, rejections included',
      ...stats(k.filter((r) => r.cu !== null).map((r) => r.cu as number)),
    });
    log('cu_self_accepted', {
      phase,
      kind,
      ...stats(accepted.filter((r) => r.cu !== null).map((r) => r.cu as number)),
    });
  }

  const window_ = crank.filter((c) => c.at >= window.from && c.at <= window.to);
  log('cu_crank', {
    phase,
    note: 'transactions mentioning the program that this run did not send',
    of: window_[0]?.of ?? null,
    ...stats(window_.map((c) => c.consumed)),
    headroomPct:
      window_.length === 0
        ? null
        : Math.round((1 - Math.max(...window_.map((c) => c.consumed)) / 400_000) * 1000) / 10,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function readArena(rpc: HeartrotRpc, arena: Address) {
  const { value } = await rpc.getAccountInfo(arena, { encoding: 'base64' }).send();
  if (value === null) throw new Error('arena vanished');
  return decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
}

// ---------------------------------------------------------------------------
// The account-key ceiling, settled
// ---------------------------------------------------------------------------

/**
 * The static account keys of a compiled v0 message, in order.
 *
 * Hand-parsed rather than imported: the layout is three header bytes, a shortvec count,
 * then that many 32-byte keys, and the one fact needed here — *where the program id
 * sits* — is not exposed by anything the client already depends on.
 */
function staticKeysOf(messageBytes: Uint8Array): string[] {
  let offset = 1 + 3; // version byte (v0), then the three-byte header
  let count = 0;
  let shift = 0;
  for (;;) {
    const byte = messageBytes[offset] as number;
    offset += 1;
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    keys.push(Buffer.from(messageBytes.slice(offset, offset + 32)).toString('hex'));
    offset += 32;
  }
  return keys;
}

/**
 * `--key-sweep`: how many account keys does this ER actually take, and is the limit on
 * the *count* or on the program id's *index*?
 *
 * SP1 built a 40-key transaction, saw it accepted, and could not read the result. Run 1
 * of this spike saw a 41-key transaction reach `finalized` and fail with the program's
 * own `Custom(14)` — it executed. Run 2 built the same 41 keys and was refused with
 * `unsupported program id index 39; max supported is 37`. The only thing that differed
 * between the two was the 36 randomly generated padding keys, which is the clue: the
 * ceiling is not on the number of keys, it is on where the program id lands once the
 * message is compiled.
 *
 * So the sweep controls that directly. `padHigh` pads with addresses that sort *after*
 * the program id, which keeps its index low; `padLow` pads with addresses that sort
 * *before* it, which pushes its index to the end. Same key count, two different program
 * id indices, and the ER's answer to each is recorded next to the index actually
 * compiled into the message.
 *
 * Needs no arena and no delegation: verification runs before execution, so a bare
 * `SetComputeUnitLimit` with padding accounts asks the question on its own.
 */
async function keySweep(): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  await assertErIdentity(er, DEVNET_AS_IDENTITY);

  const pool: Address[] = [];
  while (pool.length < 200) {
    pool.push(await getAddressFromPublicKey((await generateKeyPair()).publicKey));
  }
  const below = pool.filter((a) => a < COMPUTE_BUDGET_ID).sort();
  const above = pool.filter((a) => a > COMPUTE_BUDGET_ID).sort();
  log('key_sweep_pool', { below: below.length, above: above.length });

  const computeBudgetHex = Buffer.from(getAddressEncoder().encode(COMPUTE_BUDGET_ID)).toString('hex');
  const { value: blockhash } = await er.getLatestBlockhash().send();
  for (const arrangement of ['padHigh', 'padLow'] as const) {
    const source = arrangement === 'padHigh' ? above : below;
    for (let pad = 32; pad <= 42; pad += 1) {
      if (pad > source.length) break;
      const ix: Instruction = {
        ...setComputeUnitLimit(200_000),
        accounts: source.slice(0, pad).map((address) => ({ address, role: AccountRole.READONLY })),
      };
      const { wire, signature } = await signSigned(blockhash, treasury.address, [treasury.keyPair], [ix]);
      const keys = staticKeysOf(Buffer.from(wire, 'base64').subarray(65));
      const programIndex = keys.indexOf(computeBudgetHex);
      let accepted = true;
      let error: string | null = null;
      try {
        await postWire(er, wire);
      } catch (e) {
        accepted = false;
        error = String(e).replace(/\s+/g, ' ').slice(0, 200);
      }
      log('key_sweep', {
        arrangement,
        pad,
        totalKeys: keys.length,
        programIndexFromKeys: programIndex,
        accepted,
        error,
        signature: accepted ? signature : null,
      });
      await sleep(120);
    }
  }
}

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(er, sig, 'settle', 40_000);
  log('settle_only', { arenaId: arenaId.toString(), arena, signature: sig });
}

async function main(): Promise<void> {
  if (process.argv.includes('--key-sweep')) {
    await keySweep();
    return;
  }
  const settleIndex = process.argv.indexOf('--settle-only');
  if (settleIndex !== -1) {
    await settleOnly(BigInt(process.argv[settleIndex + 1] as string));
    return;
  }

  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  log('start', {
    programId: PROGRAM_ID,
    arenaId: arenaId.toString(),
    arena,
    boss,
    players,
    seats: SEATS,
    stations: STATIONS,
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
    log('connected', { via: 'connectMatch', erFqdn: match.erFqdn });
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
    log('connected', { via: 'fallback', erFqdn: match.erFqdn });
  }

  const crankCu: CrankCu[] = [];
  const logs = watchLogs(match.erFqdn.replace(/^https/, 'wss'), arena, crankCu);

  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, startSig, 'start_match');
  const armed = await readArena(match.er, arena);
  log('start_match', {
    signature: startSig,
    phase: armed.phase,
    tick: armed.tick,
    enrageAtTick: armed.enrageAtTick,
    budgetSeconds: ((armed.enrageAtTick - armed.tick) * TICK_MS) / 1000,
  });
  if (armed.phase !== PHASE_FIGHTING) {
    throw new Error(`start_match did not reach PHASE_FIGHTING: phase=${armed.phase}`);
  }

  // ---- seats -------------------------------------------------------------
  const sessions: Session[] = [];
  for (let seat = 0; seat < SEATS; seat += 1) {
    const keyPair = await generateKeyPair();
    sessions.push({ seat, keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) });
    pendingMoves.push([]);
  }

  const tSeats = now();
  for (let from = 0; from < SEATS; from += 5) {
    const batch = sessions.slice(from, from + 5);
    const sig = await sendInstructions(
      match.er,
      treasury,
      batch.map((s) =>
        claimSeat({
          programId: PROGRAM_ID,
          arena,
          players,
          treasury: treasury.address,
          seat: s.seat,
          skinId: s.seat % 4,
          sessionPubkey: s.address,
          identity: Uint8Array.from(randomBytes(32)),
        }),
      ),
    );
    await confirmEr(match.er, sig, `claim_seat ${from}`);
  }
  log('seats_claimed', { count: SEATS, ms: now() - tSeats });

  // A blockhash cache, refreshed in the background. Every load send reads it.
  let blockhash = (await match.er.getLatestBlockhash().send()).value;
  let stopped = false;
  const blockhashLoop = (async () => {
    while (!stopped) {
      await sleep(4_000);
      try {
        blockhash = (await match.er.getLatestBlockhash().send()).value;
      } catch (error) {
        log('blockhash_refresh_failed', { error: String(error).slice(0, 120) });
      }
    }
  })();

  // ---- walk to the gate and enter ----------------------------------------
  const tWalk = now();
  for (let round = 0; round < 60; round += 1) {
    const { value } = await match.er.getAccountInfo(players, { encoding: 'base64' }).send();
    if (value === null) throw new Error('players vanished');
    const slots = decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64'))).slots;
    const pending = sessions.filter((s) => {
      const slot = slots[s.seat];
      return slot !== undefined && slot.zone !== ZONE_ARENA && !onGate(slot.x, slot.y);
    });
    if (pending.length === 0) {
      log('walk_done', { round, ms: now() - tWalk });
      break;
    }
    if (round % 10 === 0) log('walk_progress', { round, pending: pending.length });
    for (let from = 0; from < pending.length; from += 7) {
      const batch = pending.slice(from, from + 7);
      const ixs: Instruction[] = [];
      for (const s of batch) {
        const slot = slots[s.seat];
        if (slot === undefined) continue;
        const path = pathToGate(slot.x, slot.y);
        if (path === null || path.length === 0) continue;
        ixs.push(
          movePlayer({
            programId: PROGRAM_ID,
            arena,
            players,
            session: s.address,
            seat: s.seat,
            dir: path[0] as number,
            seq: round + 1,
          }),
        );
      }
      if (ixs.length === 0) continue;
      try {
        await sendSigned(
          match.er,
          blockhash,
          treasury.address,
          [treasury.keyPair, ...batch.map((s) => s.keyPair)],
          ixs,
        );
      } catch (error) {
        log('walk_send_failed', { round, error: String(error).slice(0, 160) });
      }
    }
    await sleep(500);
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { value } = await match.er.getAccountInfo(players, { encoding: 'base64' }).send();
    if (value === null) throw new Error('players vanished');
    const slots = decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64'))).slots;
    const pending = sessions.filter((s) => slots[s.seat]?.zone !== ZONE_ARENA);
    if (pending.length === 0) break;
    for (let from = 0; from < pending.length; from += 7) {
      const batch = pending.slice(from, from + 7);
      try {
        const sig = await sendSigned(
          match.er,
          blockhash,
          treasury.address,
          [treasury.keyPair, ...batch.map((s) => s.keyPair)],
          batch.map((s) =>
            enterGate({ programId: PROGRAM_ID, arena, players, session: s.address, seat: s.seat }),
          ),
        );
        await confirmEr(match.er, sig, `enter_gate x${batch.length}`);
      } catch (error) {
        log('enter_gate_failed', { attempt, error: String(error).slice(0, 200) });
      }
    }
    await sleep(1_000);
  }

  const entered = await readArena(match.er, arena);
  log('seats_entered', {
    aliveCount: entered.aliveCount,
    tick: entered.tick,
    phase: entered.phase,
    ticksToEnrage: entered.enrageAtTick - entered.tick,
    walkMs: now() - tWalk,
  });

  // ---- a live mirror of positions, so shots aim at the boss ----------------
  // The boss barely moves and the arena phase changes once, so one slow loop covers both.
  // Seat positions come off the visibility pollers instead — they read `Players` every
  // ~120 ms anyway and the steering needs that freshness.
  let bossPos: readonly [number, number] = BOSS_SPAWN;
  let fightOver = false;
  const mirror = (async () => {
    while (!stopped) {
      try {
        const [b, a] = await Promise.all([
          match.er.getAccountInfo(boss, { encoding: 'base64' }).send(),
          match.er.getAccountInfo(arena, { encoding: 'base64' }).send(),
        ]);
        if (b.value !== null) {
          const decoded = decodeBoss(Uint8Array.from(Buffer.from(b.value.data[0], 'base64')));
          bossPos = [decoded.x, decoded.y];
        }
        if (a.value !== null) {
          const decoded = decodeArena(Uint8Array.from(Buffer.from(a.value.data[0], 'base64')));
          if (decoded.phase !== PHASE_FIGHTING && !fightOver) {
            fightOver = true;
            log('fight_over', { phase: decoded.phase, outcome: decoded.outcome, tick: decoded.tick });
          }
        }
      } catch (error) {
        log('mirror_error', { error: String(error).slice(0, 120) });
      }
      await sleep(1_000);
    }
  })();

  // A control window with twenty seats in the arena and nothing being sent. The loaded
  // windows see roughly twice as many program-invoking transactions as `Arena.tick`
  // advances, and this is the only way to tell a crank that fires more often than it
  // ticks apart from load traffic leaking into the crank's sample set.
  if (QUIET_MS > 0) {
    const from = now();
    const before = await readArena(match.er, arena);
    await sleep(QUIET_MS);
    const after = await readArena(match.er, arena);
    const window_ = crankCu.filter((c) => c.at >= from && c.at <= now());
    log('quiet_control', {
      elapsedMs: now() - from,
      tickDelta: after.tick - before.tick,
      crankSamples: window_.length,
      samplesPerTick:
        after.tick === before.tick
          ? null
          : Math.round((window_.length / (after.tick - before.tick)) * 100) / 100,
      ...stats(window_.map((c) => c.consumed)),
    });
  }

  for (let seat = 0; seat < SEATS; seat += 1) seatPos.push([...BOSS_SPAWN]);
  const pollers = Array.from({ length: POLLERS }, () =>
    pollVisibility(match.er, players, () => stopped),
  );
  const statuses = pollStatuses(match.er, () => stopped);

  const driverArgs = {
    rpc: match.er,
    sessions,
    treasury: { address: treasury.address, keyPair: treasury.keyPair },
    arena,
    boss,
    players,
    blockhash: () => blockhash,
    bossPos: () => bossPos,
    seatPos: (seat: number) => seatPos[seat] ?? BOSS_SPAWN,
    fightOver: () => fightOver,
  };

  // ---- phase PACED --------------------------------------------------------
  log('phase_begin', {
    phase: 'paced',
    moveEveryMs: MOVE_COOLDOWN_TICKS * TICK_MS,
    shootEveryMs: (SHOT_COOLDOWN_TICKS + 1) * TICK_MS,
  });
  const pacedWindow = await drivePhase({
    ...driverArgs,
    phase: 'paced',
    durationMs: PACED_MS,
    moveEveryMs: MOVE_COOLDOWN_TICKS * TICK_MS,
    shootEveryMs: (SHOT_COOLDOWN_TICKS + 1) * TICK_MS,
  });
  const afterPaced = await readArena(match.er, arena);
  log('phase_end', {
    phase: 'paced',
    tick: afterPaced.tick,
    phaseByte: afterPaced.phase,
    outcome: afterPaced.outcome,
    aliveCount: afterPaced.aliveCount,
    activeBullets: afterPaced.bullets.filter((b) => b.active !== 0).length,
  });
  report('paced', crankCu, pacedWindow);

  // ---- phase AGGRESSIVE ---------------------------------------------------
  log('phase_begin', { phase: 'aggressive', moveEveryMs: 150, shootEveryMs: 150 });
  const aggWindow = await drivePhase({
    ...driverArgs,
    phase: 'aggressive',
    durationMs: AGGRESSIVE_MS,
    moveEveryMs: 150,
    shootEveryMs: 150,
  });
  const afterAgg = await readArena(match.er, arena);
  log('phase_end', {
    phase: 'aggressive',
    tick: afterAgg.tick,
    phaseByte: afterAgg.phase,
    outcome: afterAgg.outcome,
    aliveCount: afterAgg.aliveCount,
    activeBullets: afterAgg.bullets.filter((b) => b.active !== 0).length,
  });
  report('aggressive', crankCu, aggWindow);

  log('poll_granularity', { note: 'gaps between consecutive Players reads, ms', ...stats(pollGaps) });

  // ---- fight state: did the combat model actually run? --------------------
  {
    const { value: bv } = await match.er.getAccountInfo(boss, { encoding: 'base64' }).send();
    const { value: pv } = await match.er.getAccountInfo(players, { encoding: 'base64' }).send();
    if (bv !== null) {
      const b = decodeBoss(Uint8Array.from(Buffer.from(bv.data[0], 'base64')));
      log('boss_state', {
        parts: b.parts,
        partsMax: b.partsMax,
        ventOpen: b.ventOpen,
        coreHp: b.coreHp,
        coreHpMax: b.coreHpMax,
        targetSeat: b.targetSeat,
      });
    }
    if (pv !== null) {
      const slots = decodePlayers(Uint8Array.from(Buffer.from(pv.data[0], 'base64'))).slots;
      log('player_state', {
        deaths: slots.slice(0, SEATS).map((s) => s.deaths),
        hp: slots.slice(0, SEATS).map((s) => s.hp),
        damageDealt: slots.slice(0, SEATS).map((s) => s.damageDealt),
      });
    }
  }

  // ---- the SP1 leftover: 40 account keys on the ER ------------------------
  {
    const probeIx = movePlayer({
      programId: PROGRAM_ID,
      arena,
      players,
      session: (sessions[0] as Session).address,
      seat: 0,
      dir: 0,
      seq: 65_000,
    });
    // Real generated addresses: kit will not take arbitrary bytes as an `Address`, and a
    // padding key that is not a valid public key would be rejected for the wrong reason.
    const filler = await Promise.all(
      Array.from({ length: 36 }, async () =>
        getAddressFromPublicKey((await generateKeyPair()).publicKey),
      ),
    );
    const padded: Instruction = {
      ...probeIx,
      accounts: [
        ...(probeIx.accounts ?? []),
        ...filler.map((address) => ({ address, role: AccountRole.READONLY })),
      ],
    };
    const keys = new Set<string>([
      treasury.address,
      PROGRAM_ID,
      ...(padded.accounts ?? []).map((a) => a.address),
    ]);
    log('key_probe_built', { totalKeys: keys.size });
    try {
      const sig = await sendSigned(
        match.er,
        blockhash,
        treasury.address,
        [treasury.keyPair, (sessions[0] as Session).keyPair],
        [padded],
      );
      log('key_probe_accepted_by_rpc', { totalKeys: keys.size, signature: sig });
      const deadline = now() + 30_000;
      let seen = false;
      for (;;) {
        const { value } = await match.er.getSignatureStatuses([sig]).send();
        const status = value[0];
        if (status != null) {
          log('key_probe_status', {
            totalKeys: keys.size,
            signature: sig,
            confirmationStatus: status.confirmationStatus,
            err: status.err === null ? null : classify(status.err),
          });
          seen = true;
          break;
        }
        if (now() >= deadline) break;
        await sleep(500);
      }
      if (!seen) {
        log('key_probe_no_status', {
          totalKeys: keys.size,
          signature: sig,
          note: 'accepted by the RPC, never appeared in getSignatureStatuses in 30s',
        });
      }
    } catch (error) {
      log('key_probe_rejected', {
        totalKeys: keys.size,
        error: String(error).replace(/\s+/g, ' ').slice(0, 400),
      });
    }
  }

  // ---- settle -------------------------------------------------------------
  stopped = true;
  await Promise.all([...pollers, statuses, blockhashLoop, mirror]);
  const before = await readArena(match.er, arena);
  try {
    const settleSig = await sendInstructions(match.er, treasury, [
      settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
    ]);
    await confirmEr(match.er, settleSig, 'settle', 40_000);
    log('settle', {
      signature: settleSig,
      tick: before.tick,
      phase: before.phase,
      outcome: before.outcome,
    });
  } catch (error) {
    log('settle_failed', {
      arenaId: arenaId.toString(),
      error: String(error).slice(0, 300),
      note: 'the crank task is STILL ARMED; re-run with --settle-only',
    });
  }

  logs.close();
  log('done', { arenaId: arenaId.toString(), rows: rows.size });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    log('fatal', {
      error: String(error),
      context: (error as { context?: unknown }).context ?? null,
      cause: String((error as { cause?: unknown }).cause ?? ''),
      stack: (error as Error)?.stack,
    });
    process.exit(1);
  },
);
