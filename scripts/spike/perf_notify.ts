/**
 * PERF-NOTIFY — how long the READ half of write-to-visible actually takes, and where.
 *
 * Prior work (`docs/spikes/sp-load.md`) split the 295 ms p50 into ~140 ms of submit +
 * execute and ~155 ms of "the notification getting back". This spike measures that second
 * half four ways AT ONCE, against the SAME writes, so the submit half is byte-identical
 * across channels and every comparison is paired rather than two runs an hour apart.
 *
 * The four channels, all live simultaneously on one `Players` account:
 *   R3   accountSubscribe over the ROUTER websocket, three accounts. What ships today.
 *   E3   accountSubscribe DIRECTLY to the ER's own websocket, three accounts.
 *   E1   accountSubscribe direct to the ER, `Players` ONLY. Isolates whether the
 *        one-notification-per-account-per-slot rule costs more when more accounts share
 *        the socket.
 *   POLL `getAccountInfo(Players)` in a tight staggered loop on the ER. The control for
 *        what the data path costs with no subscription at all.
 *   LOGS `logsSubscribe` direct to the ER, keyed by signature. Not a delivery channel —
 *        the decomposition instrument. Its arrival is when the validator executed the
 *        transaction, so account-arrival minus log-arrival is the coalescing rule's cost
 *        with the shared network path divided out. The router answers `logsSubscribe`
 *        `-32601`, so this can only be asked of the ER directly.
 *
 * The clock: a `move` carries a u16 `seq`, the program echoes it into
 * `PlayerSlot.last_move_seq`, so the first arrival on a channel carrying seq N is that
 * channel's write-to-visible time for send N. `sendAt` is stamped AFTER signing and
 * immediately before the `sendTransaction` POST, so local ed25519 is outside every number.
 *
 * Why the lobby and not a fight: `move_clock` returns the ER SLOT in every phase, so a
 * lobby seat may move once per 50 ms slot — the same rate limit a fighting seat gets. No
 * walk to the gate is needed. `start_match` is still sent, because it arms the crank and
 * the crank rewriting `Arena` and `Boss` every 100 ms is what makes R3/E3's three-account
 * subscription a realistic load instead of a socket with two silent channels on it. An
 * empty arena is explicitly not a wipe (`tick.rs` `damage_kills_respawns_and_wipes`), so
 * the match sits in `Fighting` for the whole run.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_notify.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=packages/client/src/index.ts \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_notify.mjs
 *   PN_SAMPLES=300 node /tmp/perf_notify.mjs --out /tmp/perf_notify.jsonl
 *
 * `--settle-only <arenaId>` cancels the crank task an aborted run left armed. Always run
 * it after an abort: an abandoned task ticks for its full iteration count.
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
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
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
} from '@heartrot/client';

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const ROUTER_WS = 'wss://devnet-router.magicblock.app/';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;
const SYSTEM_ID = '11111111111111111111111111111111' as Address;

/** `sp2_crank.ts`: the ER charges 6,960 lamports/byte of rent, devnet 6,333. */
const ER_LAMPORTS_PER_BYTE = 6_960n;
/** `player::MOVE_STEP` — one 16-unit tile per cardinal step. */
const STEP = 16;
/** `map::MAP_MAX_XY`, restated so a step off the lattice is caught before it is sent. */
const MAP_MAX_XY = 63 * 16 + 15;

const SAMPLES = Number(process.env.PN_SAMPLES ?? 300);
/** One move per ER slot is the on-chain limit; 150 ms leaves two slots of headroom. */
const SEND_EVERY_MS = Number(process.env.PN_SEND_MS ?? 150);
/**
 * Concurrent `getAccountInfo` loops for the POLL channel. One loop samples only once per
 * round trip (~200 ms India→Singapore), which would measure the sampler and not the data
 * path; four staggered loops bring the sampling interval to ~RTT/4 and the residual
 * sampling bias to ~RTT/8. That bias is reported rather than subtracted.
 */
const POLLERS = Number(process.env.PN_POLLERS ?? 4);

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/perf_notify.jsonl' : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${stringifyWithBigints(line)}\n`);
  console.log(`${line.t} ${event} ${stringifyWithBigints(fields)}`);
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
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.length === 0 ? null : Math.round((sum / sorted.length) * 10) / 10,
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
// Channels
// ---------------------------------------------------------------------------

interface Channel {
  readonly name: string;
  /** seq -> the wall clock at which this channel first carried it. */
  readonly arrivals: Map<number, number>;
  /** Wall clock of every `Players` observation that moved `last_move_seq`. */
  readonly seqSteps: number[];
  /** Every notification/response this channel received, `Players` or not. */
  frames: number;
  errors: number;
}

function makeChannel(name: string): Channel {
  return { name, arrivals: new Map(), seqSteps: [], frames: 0, errors: 0 };
}

/**
 * One `Players` observation reached `chan`. Records the first arrival of every seq the
 * channel has not seen — a single notification can acknowledge several sends, because the
 * ER coalesces writes within a slot and only the last seq of that slot survives on chain.
 * The intervening seqs are counted as coalesced-away, never as arrivals.
 */
function observe(chan: Channel, seq: number, at: number, lastSeen: { v: number }): void {
  chan.frames += 1;
  // Strictly increasing, not merely different: the POLL channel runs four loops in
  // parallel and a slow response can carry an older seq than one already recorded. `!=`
  // would let that stale frame count as a fresh step and corrupt the gap distribution.
  if (seq <= lastSeen.v) return;
  lastSeen.v = seq;
  chan.seqSteps.push(at);
  if (!chan.arrivals.has(seq)) chan.arrivals.set(seq, at);
}

/**
 * `accountSubscribe` on one websocket for a set of accounts, feeding `chan` every
 * `Players` update. Base64 explicitly: the ER's default encoding is base58.
 */
function openSubscription(cfg: {
  chan: Channel;
  wsUrl: string;
  accounts: readonly Address[];
  players: Address;
  seat: number;
  onReady: () => void;
}): { close(): void } {
  const ws = new WebSocket(cfg.wsUrl);
  const requestAccount = new Map<number, Address>();
  const subAccount = new Map<number, Address>();
  const lastSeen = { v: -1 };
  let acked = 0;

  ws.onopen = () => {
    cfg.accounts.forEach((address, i) => {
      requestAccount.set(i + 1, address);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'accountSubscribe',
          params: [address, { encoding: 'base64' }],
        }),
      );
    });
  };

  ws.onmessage = (event: MessageEvent) => {
    const at = now();
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { data?: string[] } } };
    };
    if (msg.error !== undefined) {
      cfg.chan.errors += 1;
      log('sub_error', { chan: cfg.chan.name, code: msg.error.code, message: msg.error.message });
      return;
    }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const account = requestAccount.get(msg.id);
      if (account !== undefined) subAccount.set(msg.result, account);
      acked += 1;
      if (acked === cfg.accounts.length) cfg.onReady();
      return;
    }
    if (msg.method !== 'accountNotification') return;
    const sub = msg.params?.subscription;
    const encoded = msg.params?.result?.value?.data?.[0];
    if (sub === undefined || encoded === undefined) return;
    if (subAccount.get(sub) !== cfg.players) {
      cfg.chan.frames += 1;
      return;
    }
    const slot = decodePlayers(Uint8Array.from(Buffer.from(encoded, 'base64'))).slots[cfg.seat];
    if (slot === undefined) return;
    observe(cfg.chan, slot.lastMoveSeq, at, lastSeen);
  };

  ws.onerror = () => {
    cfg.chan.errors += 1;
  };

  return {
    close() {
      ws.close();
    },
  };
}

/**
 * `logsSubscribe` on the ER, keyed by signature. This is the decomposition instrument: the
 * log notification for a transaction fires when the validator EXECUTES it, the account
 * notification fires when the slot's coalesced account update is flushed, and the
 * difference between the two on the same signature is the cost of the
 * one-notification-per-account-per-slot rule with the whole shared network path divided
 * out. `logsSubscribe` exists only on the ER — the router answers it `-32601`.
 */
function openLogs(cfg: {
  wsUrl: string;
  programId: Address;
  /** signature -> wall clock at which its logs arrived. */
  seen: Map<string, number>;
  onReady: () => void;
}): void {
  const ws = new WebSocket(cfg.wsUrl);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'logsSubscribe',
        params: [{ mentions: [cfg.programId] }, { commitment: 'processed' }],
      }),
    );
  };
  ws.onmessage = (event: MessageEvent) => {
    const at = now();
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { result?: { value?: { signature?: string } } };
    };
    if (msg.error !== undefined) {
      log('logs_error', { code: msg.error.code, message: msg.error.message });
      cfg.onReady();
      return;
    }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      cfg.onReady();
      return;
    }
    if (msg.method !== 'logsNotification') return;
    const signature = msg.params?.result?.value?.signature;
    if (signature !== undefined && !cfg.seen.has(signature)) cfg.seen.set(signature, at);
  };
  ws.onerror = () => undefined;
}

/**
 * The no-subscription control: `getAccountInfo` in a loop with no pacing beyond a stagger,
 * so the only thing between a write and its observation is one request/response.
 */
function openPollers(cfg: {
  chan: Channel;
  rpc: HeartrotRpc;
  players: Address;
  seat: number;
  stop: () => boolean;
}): Promise<void> {
  const lastSeen = { v: -1 };
  const gaps: number[] = [];
  const loops: Promise<void>[] = [];
  for (let i = 0; i < POLLERS; i += 1) {
    loops.push(
      (async () => {
        await sleep((SEND_EVERY_MS / POLLERS) * i);
        let previous = 0;
        while (!cfg.stop()) {
          try {
            const t0 = now();
            const { value } = await cfg.rpc
              .getAccountInfo(cfg.players, { encoding: 'base64' })
              .send();
            const at = now();
            if (previous !== 0) gaps.push(at - previous);
            previous = at;
            void t0;
            if (value === null) continue;
            const slot = decodePlayers(
              Uint8Array.from(Buffer.from(value.data[0], 'base64')),
            ).slots[cfg.seat];
            if (slot !== undefined) observe(cfg.chan, slot.lastMoveSeq, at, lastSeen);
          } catch {
            cfg.chan.errors += 1;
            await sleep(50);
          }
        }
      })(),
    );
  }
  return Promise.all(loops).then(() => {
    log('poll_sampling', { perLoopGapMs: stats(gaps) });
  });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Milliseconds between consecutive `Players` observations — the coalescing grid. */
function gapsOf(times: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i += 1) out.push((times[i] as number) - (times[i - 1] as number));
  return out;
}

/** How the gaps land relative to a 50 ms grid; a coalesced feed clusters near 0. */
function gridResidual(gaps: readonly number[]): Record<string, number | null> {
  return stats(gaps.map((g) => Math.abs(g - Math.round(g / 50) * 50)));
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
// Main
// ---------------------------------------------------------------------------

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
    ),
  );
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

  const treasury = await createKeyPairSignerFromBytes(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
    ),
  );
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  log('start', { arenaId: arenaId.toString(), arena, boss, players, samples: SAMPLES });

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
  const erWs = match.erFqdn.replace(/^https/, 'wss').replace(/^http:/, 'ws:');
  log('connected', { erFqdn: match.erFqdn, erWs, routerWs: ROUTER_WS });

  // The crank, so the three-account subscriptions carry the traffic they carry in a real
  // match. An arena with nobody in it ticks without wiping.
  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, startSig, 'start_match');
  log('start_match', { signature: startSig });

  const seat = 0;
  const keyPair = await generateKeyPair();
  const session = await getAddressFromPublicKey(keyPair.publicKey);
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

  // ---- channels ----------------------------------------------------------
  const chans = {
    R3: makeChannel('R3 router ws, 3 accounts'),
    E3: makeChannel('E3 direct ER ws, 3 accounts'),
    E1: makeChannel('E1 direct ER ws, players only'),
    POLL: makeChannel('POLL getAccountInfo on ER'),
  };
  const logArrivals = new Map<string, number>();
  let ready = 0;
  const allReady = new Promise<void>((resolve) => {
    const bump = () => {
      ready += 1;
      if (ready === 4) resolve();
    };
    openLogs({ wsUrl: erWs, programId: PROGRAM_ID, seen: logArrivals, onReady: bump });
    openSubscription({
      chan: chans.R3,
      wsUrl: ROUTER_WS,
      accounts: [arena, boss, players],
      players,
      seat,
      onReady: bump,
    });
    openSubscription({
      chan: chans.E3,
      wsUrl: erWs,
      accounts: [arena, boss, players],
      players,
      seat,
      onReady: bump,
    });
    openSubscription({
      chan: chans.E1,
      wsUrl: erWs,
      accounts: [players],
      players,
      seat,
      onReady: bump,
    });
  });
  await Promise.race([allReady, sleep(15_000)]);
  if (ready < 4) throw new Error(`only ${ready}/4 subscriptions acknowledged`);
  log('subscribed', { ready });

  let stopped = false;
  const polling = openPollers({
    chan: chans.POLL,
    rpc: match.er,
    players,
    seat,
    stop: () => stopped,
  });

  // ---- the send loop -----------------------------------------------------
  let blockhash = (await match.er.getLatestBlockhash().send()).value;
  const blockhashLoop = (async () => {
    while (!stopped) {
      await sleep(4_000);
      try {
        blockhash = (await match.er.getLatestBlockhash().send()).value;
      } catch {
        /* the cached one is good for ~2 min; a miss is not fatal */
      }
    }
  })();

  const sendAt = new Map<number, number>();
  /** seq -> the signature that carried it, so the logs channel can be joined by seq. */
  const seqSignature = new Map<number, string>();
  const signMs: number[] = [];
  const postMs: number[] = [];
  let failures = 0;

  for (let i = 0; i < SAMPLES; i += 1) {
    const seq = i + 1;
    const dir = dirs[i % 2] as number;
    const t0 = now();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(treasury.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          [movePlayer({ programId: PROGRAM_ID, arena, players, session, seat, dir, seq })],
          m,
        ),
    );
    const signed = await signTransaction([treasury.keyPair, keyPair], compileTransaction(message));
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = String(getSignatureFromTransaction(signed));
    const t1 = now();
    signMs.push(t1 - t0);
    sendAt.set(seq, t1);
    seqSignature.set(seq, signature);
    void match.er
      .sendTransaction(wire as Parameters<HeartrotRpc['sendTransaction']>[0], {
        encoding: 'base64',
        skipPreflight: true,
      })
      .send()
      .then(() => postMs.push(now() - t1))
      .catch((error: unknown) => {
        failures += 1;
        if (failures <= 3) log('send_failed', { seq, error: String(error).slice(0, 160) });
      });
    const elapsed = now() - t0;
    if (elapsed < SEND_EVERY_MS) await sleep(SEND_EVERY_MS - elapsed);
    if (seq % 50 === 0) {
      log('progress', {
        seq,
        R3: chans.R3.arrivals.size,
        E3: chans.E3.arrivals.size,
        E1: chans.E1.arrivals.size,
        POLL: chans.POLL.arrivals.size,
      });
    }
  }

  // Drain: nothing in flight is older than a couple of round trips.
  await sleep(3_000);
  stopped = true;
  await Promise.all([polling, blockhashLoop]);
  log('drained', { failures, signMs: stats(signMs), postMs: stats(postMs) });

  // ---- results -----------------------------------------------------------
  const names = ['R3', 'E3', 'E1', 'POLL'] as const;
  const latency: Record<string, number[]> = { R3: [], E3: [], E1: [], POLL: [] };
  for (const name of names) {
    for (const [seq, at] of chans[name].arrivals) {
      const sent = sendAt.get(seq);
      if (sent !== undefined) latency[name]?.push(at - sent);
    }
  }

  for (const name of names) {
    const chan = chans[name];
    log('channel', {
      chan: name,
      label: chan.name,
      acked: chan.arrivals.size,
      framesSeen: chan.frames,
      errors: chan.errors,
      writeToVisibleMs: stats(latency[name] as number[]),
      histogram: histogram(latency[name] as number[], 50),
    });
  }

  // Paired deltas: the same seq on two channels, so the submit half cancels exactly.
  const pairs: readonly (readonly [string, string])[] = [
    ['R3', 'E3'],
    ['E3', 'E1'],
    ['E3', 'POLL'],
    ['R3', 'POLL'],
  ];
  for (const [a, b] of pairs) {
    const deltas: number[] = [];
    let aFirst = 0;
    for (const [seq, at] of chans[a as keyof typeof chans].arrivals) {
      const other = chans[b as keyof typeof chans].arrivals.get(seq);
      if (other === undefined) continue;
      deltas.push(at - other);
      if (at < other) aFirst += 1;
    }
    log('paired', {
      pair: `${a}-${b}`,
      n: deltas.length,
      aFirstShare: deltas.length === 0 ? null : Math.round((aFirst / deltas.length) * 100) / 100,
      deltaMs: stats(deltas),
    });
  }

  // The decomposition. `logs` is when the ER told us it EXECUTED the transaction, so
  // `sendToExec` is submit + execute + one notification hop, and `execToVisible` is what
  // the account notification costs ON TOP of a notification the same socket already
  // delivered — which is the coalescing rule's price with the network divided out.
  const sendToExec: number[] = [];
  const execToVisible: Record<string, number[]> = { E1: [], E3: [], R3: [], POLL: [] };
  for (const [seq, sig] of seqSignature) {
    const sent = sendAt.get(seq);
    const logAt = logArrivals.get(sig);
    if (sent === undefined || logAt === undefined) continue;
    sendToExec.push(logAt - sent);
    for (const name of names) {
      const at = chans[name].arrivals.get(seq);
      if (at !== undefined) execToVisible[name]?.push(at - logAt);
    }
  }
  log('decomposition', {
    logsMatched: sendToExec.length,
    sendToExecMs: stats(sendToExec),
    execToVisibleMs: Object.fromEntries(names.map((n) => [n, stats(execToVisible[n] as number[])])),
  });

  // Coalescing: how the feed quantises. E1 sees every `Players` write with no other
  // account sharing its socket, so its gaps are the cleanest view of the slot grid.
  for (const name of names) {
    const gaps = gapsOf(chans[name].seqSteps);
    log('coalescing', {
      chan: name,
      gapMs: stats(gaps),
      gridResidual50: gridResidual(gaps),
      gapHistogram: histogram(gaps, 25),
    });
  }

  const coalescedAway = SAMPLES - (chans.E1.arrivals.size + failures);
  log('summary', {
    samplesSent: SAMPLES,
    sendFailures: failures,
    seqsNeverSeenOnE1: coalescedAway,
    arena: (await (async () => {
      const { value } = await match.er.getAccountInfo(arena, { encoding: 'base64' }).send();
      if (value === null) return null;
      const a = decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
      return { phase: a.phase, tick: a.tick };
    })()),
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
