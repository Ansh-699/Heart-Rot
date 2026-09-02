/**
 * PERF-20SEATS — the same experiment as `perf_seats.ts`, re-run after the immortals
 * redesign, plus the one block `many-seats.md` says it could not do: a real FIGHT with
 * twenty raiders inside the pit.
 *
 * One difference from `perf_seats.ts`, and nothing else:
 *
 *  1. **`--mode fight`** walks every seat to the gate, sends `enter_gate`, and only then
 *     starts the match, so the whole sweep runs with twenty seats in `ZONE_ARENA` being
 *     shot at. `perf_seats.ts` measured twenty seats standing in the lobby, which its own
 *     "what would invalidate it" names as the gap.
 *
 * Original header follows.
 *
 * PERF-SEATS — what actually degrades as seats fill.
 *
 * The user's question is "movement feels good solo; is it smoother with many players?"
 * Every latency number banked so far (`docs/perf/RESULT.md`, `submit.md`, `notify.md`) is
 * ONE seat driven from Node. The only multi-seat number in the tree is
 * `docs/spikes/sp-load.md`'s 200 ms at twenty players against 405 ms solo, and that
 * document says itself that part of the gap is the instrument: the solo baseline polled
 * with one loop and a `sleep(10)`, the twenty-seat run polled with three loops and no
 * sleep. So it is not a controlled comparison and cannot answer the question.
 *
 * This does one thing the other spikes do not: **one arena, one websocket, one
 * instrument, one minute, and the seat count is the only variable.**
 *
 * ## The sweep
 *
 * Blocks of `PS_BLOCK_MS`, seat counts in a palindrome:
 *
 *     quiet(baseline) 1 5 10 20 20 10 5 1 spam20
 *
 * The palindrome is load-bearing. A monotonic 1→20 ramp charges any drift in the home
 * ISP's evening to the seat count; a palindrome makes drift cancel at the mean of each
 * pair. `quiet` is the crank alone with nobody sending, which is the floor under every
 * bytes/s figure. `spam20` is twenty seats at half the ER slot period, which is the only
 * way to answer whether a *rejected* move also emits an account notification —
 * `docs/perf/research-subscription-shape.md` lists that as unmeasured and says it changes
 * the load projection materially.
 *
 * Seat `0` is active in EVERY block. That is the cleanest comparison available: the same
 * seat, the same session key, the same walkable axis, at four different loads, minutes
 * apart in both directions. Both it and the all-active-seats aggregate are reported.
 *
 * ## The instrument
 *
 * One raw websocket carrying exactly what `app/src/net/subscribe.ts` opens — three
 * `accountSubscribe`s on `Arena`, `Boss`, `Players`, `encoding: 'base64'`, on the pinned
 * ER — and on every frame it records:
 *
 *   - the wire byte length of the websocket message, attributed to its account;
 *   - the wall clock of arrival, attributed to whichever block was live;
 *   - for all three kinds, the cost of the SHIPPED decoder (`decodePlayers`,
 *     `decodeArena`, `decodeBoss` from `packages/client`) on that frame, timed with
 *     `hrtime`. That is the client's real per-notification CPU, not a re-implementation.
 *
 * Write-to-visible uses the same rule as `app/src/net/metrics.ts` and `perf_appath.ts`:
 * a `move` carries a u16 `seq`, the program echoes it into `PlayerSlot.last_move_seq`,
 * and the sample is (arrival of the frame carrying seq N for that seat) − (the moment the
 * send was decided). Per seat, strictly increasing, exact seq only — `last_move_seq` is a
 * high-water mark and charging a superseded send with a later write's round trip reports a
 * round trip nobody made.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_seats.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=./packages/client/src/index.ts \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_seats.mjs
 *   node /tmp/perf_seats.mjs --out docs/perf/seats-run1.jsonl
 *
 * `--settle-only <arenaId>` cancels the crank task an aborted run left armed. ALWAYS run
 * it after an abort: an abandoned task ticks for its full 4,500 iterations.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  AccountRole,
  createKeyPairSignerFromBytes,
  generateKeyPair,
  getAddressFromPublicKey,
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
  decodeBoss,
  decodePlayers,
  delegate,
  getDelegationStatus,
  getRoutes,
  isWall,
  isWallTile,
  onGate,
  initArena,
  enterGate,
  matchPdas,
  movePlayer,
  shoot,
  sendInstructions,
  settle,
  startMatch,
  stringifyWithBigints,
  type HeartrotRpc,
  type MatchConnections,
  type Session,
} from '@heartrot/client';

/**
 * `HR_PROGRAM_ID` lets the AFTER run of `er_guard.sh` point this same instrument at a
 * candidate build deployed to a fresh id, so BEFORE and AFTER differ only in the program.
 * The walk below plans against `@heartrot/client`'s generated map, which is only the
 * chain's map while the deployed binary is this tree's build — so a candidate id must be
 * a build of THIS tree, not an older one.
 */
const PROGRAM_ID = (process.env.HR_PROGRAM_ID ??
  'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5') as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;
const SYSTEM_ID = '11111111111111111111111111111111' as Address;
const ER_LAMPORTS_PER_BYTE = 6_960n;

const STEP = 16;
const MAP_MAX_XY = 63 * 16 + 15;
const TILES = 64;

/**
 * The map and the gate box come from `@heartrot/client`, which `tools/gen_map.py`
 * generates from `assets/map/arena.json` — the same source `programs/heartrot/src/map.rs`
 * is generated from. This used to be a 64-line ASCII grid hand-extracted from the wall
 * bitboard of the deployed ELF, because the deployed program was not this tree's build.
 * It is now: `solana program dump` of `JCfWB9…` on 2026-09-02 is this tree's
 * `target/deploy/heartrot.so` byte for byte (sha256 417bcec7…, the dump's remaining
 * 7,280 bytes are zero padding), so the copy had no reason to exist and every reason not
 * to — it went stale the moment the map was redrawn, and a stale copy does not fail, it
 * plans every step into a wall and reports "20 seats never reached the gate".
 *
 * `er_guard.sh` records the .so hash beside every run. If it ever stops matching the
 * deployed id, this import is a lie again and the grid has to come from the chain.
 */
const wallTile = (tx: number, ty: number): boolean =>
  tx < 0 || ty < 0 || tx >= TILES || ty >= TILES || isWallTile(tx, ty);

const wallAt = (x: number, y: number): boolean => isWall(x, y);

/**
 * The first cardinal step of a shortest 4-connected tile path to the gate box, or null
 * when there is none. Re-planned from the seat's *authoritative* position every walk
 * iteration rather than dead-reckoned, so a refused step costs one iteration and not the
 * rest of the walk.
 */
function stepToGate(x: number, y: number): number | null {
  const start = (Math.floor(y / STEP) << 6) | Math.floor(x / STEP);
  const prev = new Int32Array(TILES * TILES).fill(-1);
  const first = new Int8Array(TILES * TILES).fill(-1);
  const queue: number[] = [start];
  prev[start] = start;
  // dir index -> (dx, dy) in tiles, using the game's `facing` encoding.
  const dirs: readonly (readonly [number, number, number])[] = [
    [0, 0, -1],
    [2, 1, 0],
    [4, 0, 1],
    [6, -1, 0],
  ];
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head] as number;
    const tx = cell & 63;
    const ty = cell >> 6;
    if (tx >= 30 && tx <= 33 && ty >= 30 && ty <= 33 && cell !== start) return first[cell] as number;
    for (const [dir, dx, dy] of dirs) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (wallTile(nx, ny)) continue;
      const next = (ny << 6) | nx;
      if (prev[next] !== -1) continue;
      prev[next] = cell;
      first[next] = cell === start ? dir : (first[cell] as number);
      queue.push(next);
    }
  }
  return null;
}

/** How long each seat-count block runs. */
const BLOCK_MS = Number(process.env.PS_BLOCK_MS ?? 20_000);
/** Silence between blocks, so a block's frames cannot bleed into its neighbour. */
const GAP_MS = Number(process.env.PS_GAP_MS ?? 6_000);
/** The crank-only control window at the start. */
const QUIET_MS = Number(process.env.PS_QUIET_MS ?? 20_000);
/**
 * Per-seat send period. 100 ms is two ER slots, so `move_clock`'s one-move-per-slot gate
 * accepts essentially all of them and the block measures latency rather than the limiter.
 */
const SEND_MS = Number(process.env.PS_SEND_MS ?? 100);
/** The spam block's period. 25 ms is half a slot, so ~50 % must be refused by design. */
const SPAM_MS = Number(process.env.PS_SPAM_MS ?? 25);
/**
 * Per-seat `shoot` period, or 0 for none. 0 is the default because every number banked
 * before 2026-09-02 was measured with a harness that fires nothing, and a default that
 * changed the load would silently invalidate them.
 *
 * `shoot` is the transaction that matters most and has never been under load: it names
 * `Arena`, `Boss` and `Players` all WRITABLE (`instructions.ts` §shoot), where `move`
 * names only `Players` writable and `Arena` read-only. Twenty seats holding fire is
 * ~24 fully-serialising writes/s arriving alongside the crank's 10 `boss_tick`/s, and
 * `shoot.rs`'s cooldown means that load only appears once the spacebar works at all.
 *
 * 850 ms, not 800: the guard is `arena.tick <= last_shot_tick + SHOT_COOLDOWN_TICKS`
 * with `SHOT_COOLDOWN_TICKS = ticks_for(800) - 1 = 7`, so the first accepted retry is
 * 800 ms after the last and a period of exactly 800 would sit on the boundary and be
 * refused about half the time. That would measure the limiter, not the load.
 */
const SHOOT_MS = Number(process.env.PS_SHOOT_MS ?? 0);
const MAX_SEATS = 20;

/**
 * `lobby` reproduces `perf_seats.ts` exactly: the match starts, every seat stays in
 * `ZONE_LOBBY`, and the only load on `Players` is the moves themselves. That is the run
 * `docs/perf/many-seats.md` reports, and it is here so the comparison is like for like.
 *
 * `fight` walks every seat onto the gate, sends `enter_gate`, and starts the match only
 * then, so the crank is simulating twenty live raiders — volleys aimed at them, bullets
 * colliding with them, deaths and respawns rewriting `Players` — for the whole sweep.
 */
const MODE = process.env.PS_MODE === 'fight' ? 'fight' : 'lobby';

/**
 * Each entry is a seat count, optionally suffixed `w` to declare `Arena` WRITABLE in the
 * `move` transaction instead of READONLY.
 *
 * That suffix is the whole point of the second run. `research-subscription-shape.md`
 * measured that naming an account READONLY in an ER transaction emits an account
 * notification for it carrying unchanged bytes, and that naming the same account WRITABLE
 * emits none — over five transactions, with no load. `move` only ever *reads* `Arena`
 * (`handlers/player.rs` takes `arena_ai.try_borrow()`, and `validate_pair` is passed
 * `false` for the writable requirement), so the role in the transaction can be flipped
 * without touching the program. That makes the experiment free: does WRITABLE kill the
 * redundant 380 KB/s, and does it serialise twenty concurrent movers the way the
 * read-only decision was taken to avoid?
 */
interface SweepEntry {
  readonly seats: number;
  readonly arenaWritable: boolean;
}

const SWEEP: readonly SweepEntry[] = (process.env.PS_SWEEP ?? '1,5,10,20,20,10,5,1')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => ({ seats: Number(s.replace(/w$/, '')), arenaWritable: s.endsWith('w') }))
  .filter((e) => Number.isFinite(e.seats) && e.seats > 0 && e.seats <= MAX_SEATS);

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? null : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = stringifyWithBigints({ t: new Date().toISOString(), event, ...fields });
  if (outPath !== null) appendFileSync(outPath, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Date.now();

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
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.length === 0 ? null : Math.round((sum / sorted.length) * 10) / 10,
  };
}

// ---------------------------------------------------------------------------
// Setup helpers — lifted verbatim from perf_appath.ts so the arena this measures is
// built by the same path the previous run's numbers were measured against.
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

function cuLimitData(units: number): Uint8Array {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return data;
}

function setComputeUnitLimit(units: number): Instruction {
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data: cuLimitData(units) };
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
// The feed
// ---------------------------------------------------------------------------

type AccountKind = 'arena' | 'boss' | 'players';

interface Frame {
  readonly at: number;
  readonly kind: AccountKind;
  /** Whole websocket message length, which is what the socket actually carried. */
  readonly wire: number;
  /** The base64 account payload inside it. */
  readonly payload: number;
  /** Microseconds spent in the shipped decoder for this frame. */
  readonly decodeUs: number;
  /**
   * This frame's base64 payload is byte-identical to the previous frame's for the same
   * account — the notification carried no new information at all. `movePlayer` names
   * `Arena` READONLY and `research-subscription-shape.md` measured that a read-only key
   * emits a notification anyway; this counts how much of the feed that is.
   */
  readonly duplicate: boolean;
}

/**
 * One websocket, three `accountSubscribe`s, `encoding: 'base64'` — the exact shape
 * `app/src/net/subscribe.ts` opens. Every frame is decoded with the shipped decoder
 * because that is what the browser pays; skipping the decode would measure a client
 * nobody ships.
 */
function openFeed(cfg: {
  wsUrl: string;
  arena: Address;
  boss: Address;
  players: Address;
  frames: Frame[];
  /** seat -> seq -> arrival. Written only on a strictly increasing seq for that seat. */
  arrivals: Map<number, number>[];
  /** Seeded from chain so a reused counter cannot swallow this run's first sends. */
  lastSeq: number[];
  /** Last `phase`/`tick` seen on an `Arena` frame — the run's proof the fight is live. */
  chain: { phase: number; tick: number };
  onReady: () => void;
}): { close(): void } {
  const ws = new WebSocket(cfg.wsUrl);
  const requestKind = new Map<number, AccountKind>();
  const subKind = new Map<number, AccountKind>();
  const lastPayload = new Map<AccountKind, string>();
  const specs: readonly { kind: AccountKind; account: Address }[] = [
    { kind: 'arena', account: cfg.arena },
    { kind: 'boss', account: cfg.boss },
    { kind: 'players', account: cfg.players },
  ];
  let acked = 0;

  ws.onopen = () => {
    specs.forEach((spec, i) => {
      requestKind.set(i + 1, spec.kind);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'accountSubscribe',
          params: [spec.account, { encoding: 'base64' }],
        }),
      );
    });
  };

  ws.onmessage = (event: MessageEvent) => {
    const at = now();
    const raw = String(event.data);
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { data?: string[] } } };
    };
    if (msg.error !== undefined) {
      log('sub_error', { code: msg.error.code, message: msg.error.message });
      return;
    }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const kind = requestKind.get(msg.id);
      if (kind !== undefined) subKind.set(msg.result, kind);
      acked += 1;
      if (acked === specs.length) cfg.onReady();
      return;
    }
    if (msg.method !== 'accountNotification') return;
    const sub = msg.params?.subscription;
    const encoded = msg.params?.result?.value?.data?.[0];
    if (sub === undefined || encoded === undefined) return;
    const kind = subKind.get(sub);
    if (kind === undefined) return;

    // THE DEDUPE COMES FIRST, because it comes first in the browser: `deliverEncoded`
    // (app/src/net/subscribe.ts) returns on a byte-identical payload BEFORE `fromBase64`
    // and before the decoder, so a duplicate costs a map lookup and nothing else. This used
    // to decode every frame and compute `duplicate` afterwards, which charged the client for
    // work it does not do — at twenty seats 390 of 769 notifications/s are byte-identical,
    // so the row was roughly double what a browser pays.
    //
    // Skipping the decode cannot lose an arrival: a byte-identical `Players` payload carries
    // the same `lastMoveSeq` for every seat, so the loop below would take `seq <= last` on
    // all twenty and record nothing. The shipped client does not decode these bytes either.
    const duplicate = lastPayload.get(kind) === encoded;
    lastPayload.set(kind, encoded);

    // base64 -> bytes -> the shipped decoder, timed TOGETHER and deliberately: the browser's
    // per-notification path is `deliver(kind, fromBase64(encoded))`, so the hop is part of
    // what a notification costs, not an artefact of this harness. It is the larger half —
    // measured 2,956 ns for a 1,924-byte Players payload against 1,655 ns for the decoder —
    // so the row is named for its smaller term. The JSON key stays `decodeUs` because every
    // run under docs/perf/er-guard is keyed on it and renaming it would orphan them; the
    // printed label in er_guard_cmp.mjs says "parse+decode".
    let decodeUs = 0;
    let decoded: ReturnType<typeof decodePlayers> | null = null;
    if (!duplicate) {
      const t0 = process.hrtime.bigint();
      const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
      if (kind === 'players') decoded = decodePlayers(bytes);
      else if (kind === 'arena') {
        const a = decodeArena(bytes);
        cfg.chain.phase = a.phase;
        cfg.chain.tick = a.tick;
      } else decodeBoss(bytes);
      decodeUs = Number(process.hrtime.bigint() - t0) / 1000;
    }
    cfg.frames.push({ at, kind, wire: raw.length, payload: encoded.length, decodeUs, duplicate });

    if (decoded === null) return;
    for (let seat = 0; seat < MAX_SEATS; seat += 1) {
      const slot = decoded.slots[seat];
      if (slot === undefined) continue;
      const seq = slot.lastMoveSeq;
      const last = cfg.lastSeq[seat] as number;
      if (seq <= last) continue;
      cfg.lastSeq[seat] = seq;
      const perSeat = cfg.arrivals[seat] as Map<number, number>;
      if (!perSeat.has(seq)) perSeat.set(seq, at);
    }
  };

  ws.onerror = () => log('ws_error');
  return { close: () => ws.close() };
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

async function erConnection() {
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  return { rpc: createRpc(route.fqdn), fqdn: route.fqdn };
}

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await loadTreasury();
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const { rpc: er } = await erConnection();
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(er, sig, 'settle', 40_000);
  log('settle_only', { arenaId: arenaId.toString(), signature: sig });
}

interface Seat {
  readonly index: number;
  readonly session: Address;
  readonly signer: Parameters<typeof sendInstructions>[1];
  readonly dirs: readonly number[];
  seq: number;
  sent: number;
  failed: number;
  /** `shoot` sends and their POST failures. Zero unless `PS_SHOOT_MS` is set. */
  shots: number;
  shotsFailed: number;
  /** seq -> the moment the send was decided. */
  readonly sendAt: Map<number, number>;
  /** seq -> the block it belongs to. */
  readonly blockOf: Map<number, number>;
}

interface Block {
  readonly label: string;
  readonly seats: number;
  readonly periodMs: number;
  readonly arenaWritable: boolean;
  from: number;
  to: number;
}

/**
 * `movePlayer` with `Arena`'s role flipped to WRITABLE. Everything else — instruction
 * data, key order, the signer — comes from the production builder untouched, so the only
 * difference on the wire is the one bit under test.
 */
function withWritableArena(ix: Instruction, arena: Address): Instruction {
  const accounts = (ix.accounts ?? []).map((a) =>
    a.address === arena ? { ...a, role: AccountRole.WRITABLE } : a,
  );
  return { ...ix, accounts };
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
    sweep: SWEEP,
    blockMs: BLOCK_MS,
    gapMs: GAP_MS,
    quietMs: QUIET_MS,
    sendMs: SEND_MS,
    spamMs: SPAM_MS,
    shootMs: SHOOT_MS,
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
    const { rpc: er, fqdn } = await erConnection();
    await assertErIdentity(er, DEVNET_AS_IDENTITY);
    for (;;) {
      const statuses = await Promise.all([arena, boss, players].map((a) => getDelegationStatus(a)));
      if (statuses.every((s) => s.delegationRecord?.authority === DEVNET_AS_IDENTITY)) break;
      await sleep(500);
    }
    match = { base, er, erFqdn: fqdn, validatorIdentity: DEVNET_AS_IDENTITY };
  }
  const erWs = match.erFqdn.replace(/^https/, 'wss').replace(/^http:/, 'ws:');
  log('connected', { erFqdn: match.erFqdn, erWs });

  async function armTheMatch(): Promise<void> {
    const startSig = await sendInstructions(match.er, treasury, [
      startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
    ]);
    await confirmEr(match.er, startSig, 'start_match');
    log('start_match', { signature: startSig, mode: MODE });
  }
  // In `lobby` the match is armed before the seats are claimed, exactly as `perf_seats.ts`
  // does it, so the crank has been ticking for the same stretch when the sweep opens. In
  // `fight` it has to wait: `enter_gate` is one-way and the walk to the gate is thirty-odd
  // moves per seat, which would otherwise be spent out of the fight's own tick budget.
  if (MODE === 'lobby') await armTheMatch();

  // ---- claim every seat --------------------------------------------------
  // Session keys are the production non-extractable WebCrypto pairs signed by the
  // production `createSessionSigner`, so every `move` below carries one signature from a
  // zero-SOL key exactly as it does in the browser (D6).
  const claimed: { index: number; session: Address; signer: Seat['signer'] }[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    const keyPair = await generateKeyPair();
    const session = await getAddressFromPublicKey(keyPair.publicKey);
    const signer = createSessionSigner({ address: session, keyPair } as unknown as Session);
    const ix = claimSeat({
      programId: PROGRAM_ID,
      arena,
      players,
      treasury: treasury.address,
      seat,
      skinId: seat % 3,
      // CLASS_KNIGHT. Every number banked in docs/perf/ was measured with the behaviour
      // class 0 names — 40 damage on an 800 ms period — because that is the only
      // behaviour the program had. Firing as the archer is a different experiment.
      class: 0,
      sessionPubkey: session,
      identity: Uint8Array.from(randomBytes(32)),
    });
    // The legacy program at JCfWB9… predates the class byte and length-checks the block:
    // `JOIN_DATA_LEN` is 66 there and 67 here, so this trims the appended byte back off.
    // Set HR_JOIN66=1 to measure the BEFORE arm against the deployed build without
    // reverting the client. Only `claim_seat` differs; `move`, the thing this harness
    // times, is byte-identical on both wires.
    if (process.env.HR_JOIN66 === '1') ix.data = ix.data.slice(0, ix.data.length - 1);
    const sig = await sendInstructions(match.er, treasury, [ix]);
    await confirmEr(match.er, sig, `claim_seat ${seat}`);
    claimed.push({ index: seat, session, signer });
  }
  log('claimed', { seats: claimed.length });

  // ---- a walkable axis per seat -----------------------------------------
  // Oscillating between two adjacent floor tiles keeps every send accepted; a wall would
  // come back `BlockedByWall` and silently stop that seat's clock without failing.
  const cardinals: readonly { dir: number; dx: number; dy: number }[] = [
    { dir: 0, dx: 0, dy: -STEP },
    { dir: 2, dx: STEP, dy: 0 },
    { dir: 4, dx: 0, dy: STEP },
    { dir: 6, dx: -STEP, dy: 0 },
  ];
  let roster = await readPlayers(match.er, players);
  const seats: Seat[] = claimed.map(({ index, session, signer }) => ({
    index,
    session,
    signer,
    dirs: [0, 4],
    seq: 0,
    sent: 0,
    failed: 0,
    shots: 0,
    shotsFailed: 0,
    sendAt: new Map(),
    blockOf: new Map(),
  }));

  /**
   * Re-pick each seat's two-tile axis from wherever it is standing NOW. Called once in
   * `lobby`, and again in `fight` after `enter_gate` has teleported every seat to an
   * arena entrance — the lobby axis would be a wall there.
   */
  function pickAxes(from: Awaited<ReturnType<typeof readPlayers>>): void {
    for (const seat of seats) {
      const slot = from.slots[seat.index];
      if (slot === undefined) throw new Error(`seat ${seat.index} missing`);
      const walkable = cardinals.find((c) => {
        const nx = slot.x + c.dx;
        const ny = slot.y + c.dy;
        return nx >= 0 && ny >= 0 && nx <= MAP_MAX_XY && ny <= MAP_MAX_XY && !wallAt(nx, ny);
      });
      if (walkable === undefined) throw new Error(`seat ${seat.index} is walled in`);
      (seat as { dirs: readonly number[] }).dirs = [walkable.dir, (walkable.dir + 4) % 8];
    }
  }
  pickAxes(roster);

  /** One `move` from a seat, fire and forget, outside any measured block. */
  function nudge(seat: Seat, dir: number): void {
    seat.seq += 1;
    void sendInstructions(match.er, seat.signer, [
      movePlayer({
        programId: PROGRAM_ID,
        arena,
        players,
        session: seat.session,
        seat: seat.index,
        dir,
        seq: seat.seq,
      }),
    ]).catch(() => {
      seat.failed += 1;
    });
  }

  if (MODE === 'fight') {
    // ---- walk everybody to the gate, then through it ---------------------
    // Re-planned from the authoritative roster every iteration. A step the chain refuses
    // (a wall the extracted bitboard has in the wrong bit order, a move that lost its ER
    // slot) simply does not move the seat, and the next iteration plans from where it
    // really is, so the walk is self-correcting and needs no blocked-set bookkeeping.
    for (let iteration = 0; iteration < 90; iteration += 1) {
      roster = await readPlayers(match.er, players);
      let walking = 0;
      for (const seat of seats) {
        const slot = roster.slots[seat.index];
        if (slot === undefined) continue;
        if (onGate(slot.x, slot.y)) continue;
        const dir = stepToGate(slot.x, slot.y);
        if (dir === null) throw new Error(`seat ${seat.index} cannot reach the gate`);
        walking += 1;
        nudge(seat, dir);
      }
      if (walking === 0) break;
      if (iteration % 10 === 0) log('walk', { iteration, walking });
      await sleep(220);
    }
    const stranded = seats.filter((s) => {
      const slot = roster.slots[s.index];
      return slot === undefined || !onGate(slot.x, slot.y);
    });
    if (stranded.length > 0) {
      throw new Error(`${stranded.length} seats never reached the gate`);
    }
    log('at_gate', { seats: seats.length });

    for (let round = 0; round < 6; round += 1) {
      for (const seat of seats) {
        const slot = roster.slots[seat.index];
        if (slot === undefined || slot.zone !== 0) continue;
        void sendInstructions(match.er, seat.signer, [
          enterGate({ programId: PROGRAM_ID, arena, players, session: seat.session, seat: seat.index }),
        ]).catch(() => {
          seat.failed += 1;
        });
      }
      await sleep(1_500);
      roster = await readPlayers(match.er, players);
      if (roster.slots.every((s, i) => i >= MAX_SEATS || s.zone !== 0)) break;
    }
    const outside = roster.slots.filter((s, i) => i < MAX_SEATS && s.zone === 0).length;
    if (outside > 0) throw new Error(`${outside} seats never entered the arena`);
    log('in_arena', { seats: MAX_SEATS });
    pickAxes(roster);
    await armTheMatch();
  }

  // ---- warm the decoders -------------------------------------------------
  // A cold `decodePlayers` measured 46.7 µs p50 in the first block and 6.2 µs in the
  // fourth on the same binary. That is V8's JIT, not the client: a browser that has been
  // in a match for ten seconds is warm. Warming here means every block below reports the
  // steady-state cost, so a block's decode figure is a function of its frame rate and not
  // of where it sits in the run.
  {
    const { value } = await match.er.getAccountInfo(players, { encoding: 'base64' }).send();
    if (value === null) throw new Error('players vanished before warmup');
    const p = Uint8Array.from(Buffer.from(value.data[0], 'base64'));
    const a = await match.er.getAccountInfo(arena, { encoding: 'base64' }).send();
    const b = await match.er.getAccountInfo(boss, { encoding: 'base64' }).send();
    if (a.value === null || b.value === null) throw new Error('arena or boss vanished before warmup');
    const ab = Uint8Array.from(Buffer.from(a.value.data[0], 'base64'));
    const bb = Uint8Array.from(Buffer.from(b.value.data[0], 'base64'));
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i += 1) {
      decodePlayers(p);
      decodeArena(ab);
      decodeBoss(bb);
    }
    log('decoders_warmed', {
      iterations: 20_000,
      usPerTriple: Math.round(Number(process.hrtime.bigint() - t0) / 1000 / 20_000 / 10) / 100,
    });
  }

  // ---- the feed ----------------------------------------------------------
  const frames: Frame[] = [];
  const chain = { phase: -1, tick: -1 };
  const arrivals: Map<number, number>[] = Array.from({ length: MAX_SEATS }, () => new Map());
  // Seed the high-water mark from chain. Seats are fresh here so it is 0, but reading it
  // rather than assuming it is what keeps this correct if the arena is ever reused.
  const lastSeq = Array.from({ length: MAX_SEATS }, (_, i) => roster.slots[i]?.lastMoveSeq ?? 0);
  let ready = false;
  const feed = openFeed({
    wsUrl: erWs,
    arena,
    boss,
    players,
    frames,
    arrivals,
    lastSeq,
    chain,
    onReady: () => {
      ready = true;
    },
  });
  const deadline = now() + 20_000;
  while (!ready && now() < deadline) await sleep(100);
  if (!ready) throw new Error('the feed never acknowledged all three subscriptions');
  // The crank writes `Arena` every 100 ms, so a live feed proves itself within a second.
  const framesDeadline = now() + 10_000;
  while (frames.length < 3 && now() < framesDeadline) await sleep(100);
  log('feed_live', { frames: frames.length });

  // ---- the sweep ---------------------------------------------------------
  const blocks: Block[] = [];

  const quiet: Block = {
    label: 'quiet',
    seats: 0,
    periodMs: 0,
    arenaWritable: false,
    from: now(),
    to: 0,
  };
  await sleep(QUIET_MS);
  quiet.to = now();
  blocks.push(quiet);
  log('block_done', { label: quiet.label, frames: frames.length });

  /** Drive `count` seats concurrently for `ms`, one independent timer each. */
  async function runBlock(
    label: string,
    count: number,
    periodMs: number,
    ms: number,
    arenaWritable = false,
  ) {
    const block: Block = { label, seats: count, periodMs, arenaWritable, from: now(), to: 0 };
    const stopAt = block.from + ms;
    // One independent fire loop per active seat, started with the block and stopped with
    // it. Separate from the move loop rather than folded into it: the periods are 50 ms
    // and 850 ms, and interleaving them by counter would make every 17th move late.
    const gunners =
      SHOOT_MS === 0
        ? []
        : seats.slice(0, count).map(async (seat) => {
            while (now() < stopAt) {
              const t0 = now();
              seat.shots += 1;
              void sendInstructions(match.er, seat.signer, [
                shoot({
                  programId: PROGRAM_ID,
                  arena,
                  boss,
                  players,
                  session: seat.session,
                  seat: seat.index,
                  // Due SOUTH — away from the boss, which sits north of the pit at
                  // BOSS_SPAWN. Every shot therefore misses by construction, and that is
                  // deliberate: 160 seconds of sweep at ~24 accepted shots/s is ~3,800
                  // shots, and at SHOT_DAMAGE 40 a hitting arm would strip the boss and
                  // flip the phase to SETTLING part-way through, which would end the
                  // measurement rather than load it.
                  //
                  // What a miss still costs is everything this is here to measure: the
                  // same transaction, the same WRITABLE locks on Arena, Boss and Players,
                  // the same `octant`, the same `raycast` walk (a miss walks FURTHER than
                  // a hit, so the CU is if anything conservative), and the same
                  // `last_shot_tick` write into Players. What it does not cost is the
                  // Boss part write, so Boss notifications are understated by up to
                  // ~24/s × 356 B = 8.5 KB/s against a 1.76 MB/s total — 0.5 %.
                  dx: 0,
                  dy: 1,
                }),
              ]).catch(() => {
                seat.shotsFailed += 1;
              });
              const spent = now() - t0;
              if (spent < SHOOT_MS) await sleep(SHOOT_MS - spent);
            }
          });
    const drivers = seats.slice(0, count).map(async (seat) => {
      let i = 0;
      while (now() < stopAt) {
        const t0 = now();
        seat.seq += 1;
        const seq = seat.seq;
        const dir = seat.dirs[i % 2] as number;
        i += 1;
        seat.sendAt.set(seq, t0);
        seat.blockOf.set(seq, blocks.length);
        seat.sent += 1;
        // Fire and forget: awaiting the POST would serialise this seat behind its own
        // round trip and turn a 100 ms cadence into a 227 ms one.
        const ix = movePlayer({
          programId: PROGRAM_ID,
          arena,
          players,
          session: seat.session,
          seat: seat.index,
          dir,
          seq,
        });
        void sendInstructions(match.er, seat.signer, [
          arenaWritable ? withWritableArena(ix, arena) : ix,
        ]).then(
          () => undefined,
          (error: unknown) => {
            seat.failed += 1;
            if (seat.failed <= 2) {
              log('send_failed', { seat: seat.index, seq, error: String(error).slice(0, 140) });
            }
          },
        );
        const elapsed = now() - t0;
        if (elapsed < periodMs) await sleep(periodMs - elapsed);
      }
    });
    await Promise.all([...drivers, ...gunners]);
    block.to = now();
    blocks.push(block);
    // One roster read, in the gap and never inside the block. In `fight` this is the only
    // honest way to say how much of the sweep was spent dead: a dead seat's `move` is
    // refused, so an acceptance rate is not a latency result unless the death count is
    // reported beside it.
    const after = await readPlayers(match.er, players);
    const rosterDeaths = after.slots
      .slice(0, MAX_SEATS)
      .reduce((a, sl) => a + (sl.deaths ?? 0), 0);
    const rosterAlive = after.slots
      .slice(0, MAX_SEATS)
      .filter((sl) => sl.zone !== 0 && sl.hp > 0).length;
    log('block_done', {
      label,
      seats: count,
      periodMs,
      arenaWritable,
      durationMs: block.to - block.from,
      framesSoFar: frames.length,
      phase: chain.phase,
      tick: chain.tick,
      deaths: rosterDeaths,
      alive: rosterAlive,
    });
    // The gap is quiet, and it is also the drain: nothing in flight when the next block
    // opens is older than a couple of round trips.
    await sleep(GAP_MS);
  }

  // ---- the notification-cause probe --------------------------------------
  // Run 2 showed that flipping `Arena` to WRITABLE does NOT suppress its redundant
  // notification, which contradicts `research-subscription-shape.md`'s five-send probe.
  // Before any spec recommends removing `Arena` from `move`'s account list, the other arm
  // of that probe has to be re-verified here rather than inherited: does a transaction
  // that does not name `Arena` at all leave it silent?
  //
  // The instructions are `ComputeBudget` setComputeUnitLimit, which ignores whatever
  // accounts are attached to it, so the ONLY difference between the arms is which keys the
  // compiled message carries and in what role.
  if (process.env.PS_PROBE === '1') {
    const arms: readonly { name: string; accounts: Instruction['accounts'] }[] = [
      { name: 'names-nothing', accounts: [] },
      { name: 'arena-readonly', accounts: [{ address: arena, role: AccountRole.READONLY }] },
      { name: 'arena-writable', accounts: [{ address: arena, role: AccountRole.WRITABLE }] },
      { name: 'players-readonly', accounts: [{ address: players, role: AccountRole.READONLY }] },
    ];
    for (const arm of arms) {
      // The crank writes `Arena` every 100 ms regardless, so the arm's own contribution is
      // (frames observed) − (frames the crank alone would have produced over the same
      // window). A quiet control window immediately before each arm measures that rate on
      // the spot rather than assuming 10/s.
      const ctrlFrom = now();
      await sleep(6_000);
      const ctrlTo = now();
      const ctrlArena = frames.filter(
        (f) => f.kind === 'arena' && f.at >= ctrlFrom && f.at < ctrlTo,
      ).length;

      const from = now();
      const sends = 10;
      for (let i = 0; i < sends; i += 1) {
        await sendInstructions(match.er, treasury, [
          { programAddress: COMPUTE_BUDGET_ID, accounts: arm.accounts, data: cuLimitData(400_000) },
        ]);
        await sleep(400);
      }
      await sleep(2_000);
      const to = now();
      const secs = (to - from) / 1000;
      const arenaFrames = frames.filter(
        (f) => f.kind === 'arena' && f.at >= from && f.at < to,
      ).length;
      const expectedFromCrank = (ctrlArena / ((ctrlTo - ctrlFrom) / 1000)) * secs;
      log('probe', {
        arm: arm.name,
        sends,
        seconds: Math.round(secs * 10) / 10,
        arenaFrames,
        crankBaselineFrames: Math.round(expectedFromCrank * 10) / 10,
        attributableToSends: Math.round((arenaFrames - expectedFromCrank) * 10) / 10,
      });
    }
  }

  for (const e of SWEEP) {
    await runBlock(
      `${e.seats}${e.arenaWritable ? 'w' : ''}`,
      e.seats,
      SEND_MS,
      BLOCK_MS,
      e.arenaWritable,
    );
  }
  if (process.env.PS_SKIP_SPAM !== '1') await runBlock('spam20', MAX_SEATS, SPAM_MS, BLOCK_MS);

  await sleep(4_000);
  feed.close();

  // ---- results -----------------------------------------------------------
  const framesIn = (b: Block, kind?: AccountKind) =>
    frames.filter((f) => f.at >= b.from && f.at < b.to && (kind === undefined || f.kind === kind));

  const report = blocks.map((b) => {
    const secs = (b.to - b.from) / 1000;
    const inBlock = framesIn(b);
    const wire = inBlock.reduce((a, f) => a + f.wire, 0);
    const decodeUs = inBlock.reduce((a, f) => a + f.decodeUs, 0);
    const blockIndex = blocks.indexOf(b);

    /** Write-to-visible for every send this block owns. */
    const perSeatMs = (only: readonly Seat[]) => {
      const out: number[] = [];
      for (const seat of only) {
        for (const [seq, at] of arrivals[seat.index] as Map<number, number>) {
          if (seat.blockOf.get(seq) !== blockIndex) continue;
          const sent = seat.sendAt.get(seq);
          if (sent !== undefined) out.push(at - sent);
        }
      }
      return out;
    };
    const active = seats.slice(0, b.seats);
    const seatZero = active.slice(0, 1);
    const sent = active.reduce((a, s) => a + [...s.blockOf.values()].filter((x) => x === blockIndex).length, 0);
    const acked = perSeatMs(active).length;

    return {
      label: b.label,
      seats: b.seats,
      periodMs: b.periodMs,
      arenaWritable: b.arenaWritable,
      seconds: Math.round(secs * 10) / 10,
      sent,
      acked,
      ackRate: sent === 0 ? null : Math.round((acked / sent) * 1000) / 10,
      framesPerSec: Math.round((inBlock.length / secs) * 10) / 10,
      byKind: (['arena', 'boss', 'players'] as const).map((k) => {
        const f = framesIn(b, k);
        return {
          kind: k,
          framesPerSec: Math.round((f.length / secs) * 10) / 10,
          bytesPerSec: Math.round(f.reduce((a, x) => a + x.wire, 0) / secs),
          payloadBytesPerSec: Math.round(f.reduce((a, x) => a + x.payload, 0) / secs),
          decodeUsP50: pct([...f.map((x) => x.decodeUs)].sort((a, c) => a - c), 50),
          decodeUsP95: pct([...f.map((x) => x.decodeUs)].sort((a, c) => a - c), 95),
          /** Share of this account's frames that repeated the previous frame byte for byte. */
          duplicatePct:
            f.length === 0 ? null : Math.round((f.filter((x) => x.duplicate).length / f.length) * 1000) / 10,
        };
      }),
      bytesPerSec: Math.round(wire / secs),
      /** The client's total decoding CPU, as a share of one core. */
      decodeMsPerSec: Math.round((decodeUs / 1000 / secs) * 100) / 100,
      writeToVisibleAll: stats(perSeatMs(active)),
      writeToVisibleSeat0: stats(perSeatMs(seatZero)),
    };
  });

  log('table', { report });
  log('totals', {
    frames: frames.length,
    sends: seats.reduce((a, s) => a + s.sent, 0),
    sendFailures: seats.reduce((a, s) => a + s.failed, 0),
    shootMs: SHOOT_MS,
    shots: seats.reduce((a, s) => a + s.shots, 0),
    shotFailures: seats.reduce((a, s) => a + s.shotsFailed, 0),
  });

  const settleSig = await sendInstructions(match.er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, settleSig, 'settle', 40_000);
  log('settled', { signature: settleSig, arenaId: arenaId.toString() });
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error).slice(0, 400) });
  process.exitCode = 1;
});
