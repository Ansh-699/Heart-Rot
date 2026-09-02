/**
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

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;
const SYSTEM_ID = '11111111111111111111111111111111' as Address;
const ER_LAMPORTS_PER_BYTE = 6_960n;

const STEP = 16;
const MAP_MAX_XY = 63 * 16 + 15;

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
const MAX_SEATS = 20;

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

    // base64 -> bytes -> the shipped decoder, timed together, because that whole path is
    // what the browser runs per notification.
    const t0 = process.hrtime.bigint();
    const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
    let decoded: ReturnType<typeof decodePlayers> | null = null;
    if (kind === 'players') decoded = decodePlayers(bytes);
    else if (kind === 'arena') decodeArena(bytes);
    else decodeBoss(bytes);
    const decodeUs = Number(process.hrtime.bigint() - t0) / 1000;

    const duplicate = lastPayload.get(kind) === encoded;
    lastPayload.set(kind, encoded);
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

  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, startSig, 'start_match');
  log('start_match', { signature: startSig });

  // ---- claim every seat --------------------------------------------------
  // Session keys are the production non-extractable WebCrypto pairs signed by the
  // production `createSessionSigner`, so every `move` below carries one signature from a
  // zero-SOL key exactly as it does in the browser (D6).
  const claimed: { index: number; session: Address; signer: Seat['signer'] }[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    const keyPair = await generateKeyPair();
    const session = await getAddressFromPublicKey(keyPair.publicKey);
    const signer = createSessionSigner({ address: session, keyPair } as unknown as Session);
    const sig = await sendInstructions(match.er, treasury, [
      claimSeat({
        programId: PROGRAM_ID,
        arena,
        players,
        treasury: treasury.address,
        seat,
        skinId: seat % 3,
        sessionPubkey: session,
        identity: Uint8Array.from(randomBytes(32)),
      }),
    ]);
    await confirmEr(match.er, sig, `claim_seat ${seat}`);
    claimed.push({ index: seat, session, signer });
  }
  log('claimed', { seats: claimed.length });

  // ---- a walkable axis per seat -----------------------------------------
  // Oscillating between two adjacent floor tiles keeps every send accepted; a wall would
  // come back `BlockedByWall` and silently stop that seat's clock without failing.
  const roster = await readPlayers(match.er, players);
  const cardinals: readonly { dir: number; dx: number; dy: number }[] = [
    { dir: 0, dx: 0, dy: -STEP },
    { dir: 2, dx: STEP, dy: 0 },
    { dir: 4, dx: 0, dy: STEP },
    { dir: 6, dx: -STEP, dy: 0 },
  ];
  const seats: Seat[] = claimed.map(({ index, session, signer }) => {
    const spawn = roster.slots[index];
    if (spawn === undefined) throw new Error(`seat ${index} missing after claim`);
    const walkable = cardinals.find((c) => {
      const nx = spawn.x + c.dx;
      const ny = spawn.y + c.dy;
      return nx >= 0 && ny >= 0 && nx <= MAP_MAX_XY && ny <= MAP_MAX_XY && !isWall(nx, ny);
    });
    if (walkable === undefined) throw new Error(`seat ${index} is walled in`);
    return {
      index,
      session,
      signer,
      dirs: [walkable.dir, (walkable.dir + 4) % 8],
      seq: 0,
      sent: 0,
      failed: 0,
      sendAt: new Map(),
      blockOf: new Map(),
    };
  });

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
    await Promise.all(drivers);
    block.to = now();
    blocks.push(block);
    log('block_done', {
      label,
      seats: count,
      periodMs,
      arenaWritable,
      durationMs: block.to - block.from,
      framesSoFar: frames.length,
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
