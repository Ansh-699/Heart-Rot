/**
 * SP2 — the crank compute ceiling, observed against real devnet.
 *
 * Research derived a 400,000 CU ceiling for the crank transaction from Agave's
 * builtin-costs table (neither `Magic111…` nor `Crank111…` is a builtin, so both
 * classify `NotBuiltin`: 2 × 200,000). Nothing had ever observed it. This does.
 *
 * What it actually does, in order:
 *   1. `init_arena` + `delegate` on the base layer, `start_match` on the ER — the real
 *      client's builders, so a bug in the hand-written encoders fails here.
 *   2. Watches an EMPTY arena tick unattended for 5 minutes. Empty is deliberate: with
 *      nobody in `ZONE_ARENA` the boss has no target, spawns no volley, and the match
 *      cannot wipe itself into `PHASE_SETTLING` — so `Arena.tick` monotonicity is a
 *      clean test of the crank rather than a test of the fight.
 *   3. Fills all 20 seats, walks them from the lobby spawn to the gate block, and
 *      `enter_gate`s them, which turns the volley on. Then watches a LOADED arena.
 *   4. Reads the literal `consumed X of Y` line out of the crank's own transaction logs
 *      via `logsSubscribe`, for both the empty and the loaded phase.
 *   5. `settle` — cancels the task so it does not tick forever against a dead arena.
 *
 * Everything is logged as JSONL to `--out`; the markdown write-up is written by hand
 * from that file.
 *
 * Run:
 *   node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp2_crank.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=packages/client/src/index.ts --outfile=<tmp>/sp2.mjs
 *   node <tmp>/sp2.mjs --out <tmp>/sp2.jsonl
 */

import { readFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
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
  MAX_SEATS,
  PHASE_FIGHTING,
  ZONE_ARENA,
  assertErIdentity,
  claimSeat,
  confirmSignature,
  connectMatch,
  createRpc,
  decodeArena,
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
  startMatch,
  type HeartrotRpc,
  type MatchConnections,
} from '@heartrot/client';

// ---------------------------------------------------------------------------
// Constants that mirror the program. Read, never invented.
// ---------------------------------------------------------------------------

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;

/** `player::GATE_MIN_*`/`GATE_MAX_*` — tiles 30..=33 on both axes, in arena units. */
const GATE_MIN = 30 * 16;
const GATE_MAX = 34 * 16 - 1;
/** `player::LOBBY_ENTRANCE` and `LOBBY_SPACING`. */
const LOBBY_ENTRANCE: readonly [number, number] = [28 * 16, 52 * 16];
const LOBBY_SPACING = 24;
/** `player::STEP` — cardinal moves only, so every walk stays on one 16-unit lattice. */
const STEP = 16;
/** Cardinal directions of `player::MOVE_STEP`: N, E, S, W. */
const CARDINALS: readonly { dir: number; dx: number; dy: number }[] = [
  { dir: 0, dx: 0, dy: -STEP },
  { dir: 2, dx: STEP, dy: 0 },
  { dir: 4, dx: 0, dy: STEP },
  { dir: 6, dx: -STEP, dy: 0 },
];

/**
 * Two runs, not one. `init_arena` sets `enrage_at_tick = 900` — six minutes — and the
 * tick handler flips the arena to `PHASE_SETTLING` there, after which the crank still
 * fires but `Arena.tick` stops. A five-minute unattended watch plus the ~90 s it takes to
 * walk twenty seats from the lobby spawn to the gate does not fit inside 900 ticks, so
 * the monotonicity run and the loaded-CU run are separate matches, selected by env:
 *
 *   SP2_EMPTY_MS=300000 SP2_SEATS=0   — the unattended monotonicity + empty-tick CU
 *   SP2_EMPTY_MS=15000  SP2_LOADED_MS=150000 — twenty seats in the arena, loaded CU
 */
const EMPTY_WATCH_MS = Number(process.env.SP2_EMPTY_MS ?? 300_000);
const LOADED_WATCH_MS = Number(process.env.SP2_LOADED_MS ?? 120_000);
const WANT_SEATS = process.env.SP2_SEATS !== '0';
const SAMPLE_MS = 10_000;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/sp2.jsonl' : (process.argv[i + 1] as string);
})();

/** kit upcasts RPC numerics to `bigint`, and `JSON.stringify` throws on those. */
const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${JSON.stringify(line, jsonSafe)}\n`);
  console.log(`${line.t} ${event} ${JSON.stringify(fields, jsonSafe)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function loadKeypairBytes(path: string): Uint8Array {
  return Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * System `Transfer`, hand-encoded. Used only by the ER rent top-up below.
 */
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
 * The ER validator refuses to clone an account whose escrowed lamports are below **its**
 * rent-exempt minimum, and its rent rate is not devnet's. Devnet charges 6,333 lamports
 * per (128 + len) byte; the ER charges the stock 6,960. So an account `init_arena`
 * created rent-exempt through `Rent::get()` on the base layer is ~9 % short inside the
 * ER, and every ER transaction touching it is rejected — as
 * `Cloner error: … InsufficientFundsForRent`, wrapped in RPC code -32003, which kit
 * renders as the wholly unrelated "Transaction signature verification failure".
 *
 * Topping the accounts up before `delegate` is the spike's workaround. The program-side
 * fix belongs in `init_arena`; see `docs/spikes/sp2.md`.
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
    const space = BigInt(value.data[0].length === 0 ? 0 : Buffer.from(value.data[0], 'base64').length);
    const needed = (128n + space) * ER_LAMPORTS_PER_BYTE;
    const have = BigInt(value.lamports);
    log('er_rent_check', {
      account,
      space: space.toString(),
      have: have.toString(),
      erNeeds: needed.toString(),
    });
    if (have < needed) transfers.push(transfer(treasurySigner.address, account, needed - have));
  }
  if (transfers.length === 0) return;
  const sig = await sendInstructions(base, treasurySigner, transfers);
  await confirmSignature(base, sig, { timeoutMs: 60_000 });
  log('er_rent_topup', { signature: sig, count: transfers.length });
}

/** `SetComputeUnitLimit` — hand-encoded; there is no compute-budget dependency here. */
function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

/**
 * Multi-signer send. The client's builders emit plain address metas, so kit's
 * signer-discovery cannot find the twenty session keys; this compiles the message and
 * signs it with raw key pairs instead. Used only for `enter_gate` and `move`, which are
 * the only instructions with a signer that is not the fee payer.
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
  const signed = await signTransaction(keyPairs, compileTransaction(message));
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
  return getSignatureFromTransaction(signed);
}

/**
 * Confirm on the ER. `confirmSignature` from the client demands
 * `confirmed`/`finalized`; the ER runs one validator with no consensus and may report
 * something else forever, which is itself worth observing — so this records whatever
 * `confirmationStatus` it actually saw instead of insisting.
 */
async function confirmEr(
  rpc: HeartrotRpc,
  signature: Signature,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status != null) {
      if (status.err !== null) {
        throw new Error(`${what} (${signature}) failed: ${JSON.stringify(status.err)}`);
      }
      log('er_confirmed', { what, signature, status: status.confirmationStatus });
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what} (${signature}) never appeared in getSignatureStatuses`);
    }
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Walking the lobby
// ---------------------------------------------------------------------------

const onGate = (x: number, y: number): boolean =>
  x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;

/**
 * BFS from `(x, y)` to the gate block over cardinal 16-unit steps, rejecting any step
 * `player::move_player` would reject. Cardinals only: `STEP == TILE`, so every reachable
 * point stays on the lattice the start sits on and the search space is one tile grid.
 * Returns the direction sequence, or `null` if the gate is unreachable that way.
 */
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

// ---------------------------------------------------------------------------
// Crank log capture
// ---------------------------------------------------------------------------

type ConsumedLine = { at: number; program: string; consumed: number; of: number; sig: string };

/**
 * `logsSubscribe` on the ER, filtered to our program. The crank transaction is
 * `[noop, ExecuteCrank]` and we never build it, so its logs are the only place the
 * compute numbers are readable at all.
 */
function watchCrankLogs(wsUrl: string, sink: ConsumedLine[]): { close: () => void } {
  let socket = new WebSocket(wsUrl);
  let closed = false;

  const wire = (ws: WebSocket): void => {
    ws.onopen = (): void => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [PROGRAM_ID] }, { commitment: 'processed' }],
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
      if (value.err != null) log('crank_tx_err', { signature: value.signature, err: value.err });
      for (const line of value.logs) {
        const m = /^Program (\S+) consumed (\d+) of (\d+) compute units$/.exec(line);
        if (m === null) continue;
        sink.push({
          at: Date.now(),
          program: m[1] as string,
          consumed: Number(m[2]),
          of: Number(m[3]),
          sig: value.signature ?? '',
        });
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

function summarize(lines: readonly ConsumedLine[], from: number, to: number, phase: string): void {
  const window = lines.filter((l) => l.at >= from && l.at <= to);
  const byProgram = new Map<string, number[]>();
  for (const l of window) {
    const list = byProgram.get(l.program) ?? [];
    list.push(l.consumed);
    byProgram.set(l.program, list);
  }
  for (const [program, values] of byProgram) {
    values.sort((a, b) => a - b);
    const of = window.find((l) => l.program === program)?.of ?? 0;
    log('cu_summary', {
      phase,
      program,
      samples: values.length,
      min: values[0],
      median: values[Math.floor(values.length / 2)],
      max: values[values.length - 1],
      of,
    });
  }
  const sample = window.slice(-6);
  log('cu_raw_tail', { phase, sample });
}

/**
 * Fallback and cross-check for `logsSubscribe`: pull real crank signatures off the arena
 * account and read `meta.logMessages` out of the transactions themselves. If the ER
 * serves neither, the compute numbers are unobtainable and that is the finding.
 */
async function fetchCrankTxLogs(rpc: HeartrotRpc, arena: Address, limit: number): Promise<void> {
  let signatures: readonly { signature: string }[];
  try {
    signatures = await rpc.getSignaturesForAddress(arena, { limit }).send();
  } catch (error) {
    log('get_signatures_unsupported', { error: String(error) });
    return;
  }
  log('crank_signatures', { count: signatures.length, sample: signatures.slice(0, 3) });
  for (const { signature } of signatures.slice(0, 3)) {
    try {
      const tx = await rpc
        .getTransaction(signature as Signature, {
          maxSupportedTransactionVersion: 0,
          encoding: 'json',
        })
        .send();
      log('crank_tx', {
        signature,
        err: tx?.meta?.err ?? null,
        computeUnitsConsumed: tx?.meta?.computeUnitsConsumed ?? null,
        logs: tx?.meta?.logMessages ?? null,
      });
    } catch (error) {
      log('get_transaction_unsupported', { signature, error: String(error) });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Sampling the arena
// ---------------------------------------------------------------------------

async function readArena(
  rpc: HeartrotRpc,
  arena: Address,
): Promise<{ tick: number; phase: number; aliveCount: number; activeBullets: number }> {
  const { value } = await rpc.getAccountInfo(arena, { encoding: 'base64' }).send();
  if (value === null) throw new Error('arena vanished');
  const raw = Uint8Array.from(Buffer.from(value.data[0], 'base64'));
  const decoded = decodeArena(raw);
  return {
    tick: decoded.tick,
    phase: decoded.phase,
    aliveCount: decoded.aliveCount,
    activeBullets: decoded.bullets.filter((b) => b.active !== 0).length,
  };
}

/** Sample `tick` on a fixed cadence and assert it never goes backwards. */
async function watchTicks(
  rpc: HeartrotRpc,
  arena: Address,
  durationMs: number,
  phase: string,
): Promise<{ first: number; last: number; samples: number; regressions: number; stalls: number }> {
  const deadline = Date.now() + durationMs;
  const start = await readArena(rpc, arena);
  log('tick_sample', { phase, ...start });
  let previous = start.tick;
  let regressions = 0;
  let stalls = 0;
  let samples = 1;
  while (Date.now() < deadline) {
    await sleep(SAMPLE_MS);
    const now = await readArena(rpc, arena);
    samples += 1;
    if (now.tick < previous) regressions += 1;
    if (now.tick === previous) stalls += 1;
    log('tick_sample', { phase, ...now, delta: now.tick - previous });
    previous = now.tick;
  }
  return { first: start.tick, last: previous, samples, regressions, stalls };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `--self-test`: every seat's lobby spawn can actually reach the gate under the exact
 * arithmetic `player::move_player` applies. Run before spending five minutes on chain —
 * a seat that cannot walk to the gate never enters the arena and the loaded phase would
 * silently measure an empty tick.
 */
function selfTest(): void {
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    let x = Math.min(
      Math.max(LOBBY_ENTRANCE[0] + (seat - MAX_SEATS / 2) * LOBBY_SPACING, 0),
      1023,
    );
    let y = LOBBY_ENTRANCE[1];
    if (isWall(x, y)) throw new Error(`seat ${seat} spawns in a wall at ${x},${y}`);
    const path = pathToGate(x, y);
    if (path === null) throw new Error(`seat ${seat} cannot reach the gate from ${x},${y}`);
    for (const dir of path) {
      const step = CARDINALS.find((c) => c.dir === dir);
      if (step === undefined) throw new Error(`bad direction ${dir}`);
      const nx = Math.min(Math.max(x + step.dx, 0), 1023);
      const ny = Math.min(Math.max(y + step.dy, 0), 1023);
      if (isWall(nx, ny)) throw new Error(`seat ${seat} walks into a wall at ${nx},${ny}`);
      x = nx;
      y = ny;
    }
    if (!onGate(x, y)) throw new Error(`seat ${seat} path ends off the gate at ${x},${y}`);
    console.log(`seat ${seat}: ${path.length} moves to the gate`);
  }
  console.log('self-test ok');
}

/**
 * `--settle-only <arenaId>`: cancel the crank and undelegate an arena a crashed run left
 * armed. A task nobody cancels ticks for its full 4,500 iterations — half an hour of
 * writes against an abandoned match — so every aborted run needs this.
 */
async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`),
  );
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  const before = await readArena(er, arena);
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(er, sig, 'settle', 40_000);
  log('settle_only', { arenaId: arenaId.toString(), arena, signature: sig, before });
}

async function main(): Promise<void> {
  if (process.argv.includes('--self-test')) {
    selfTest();
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
    treasury: treasury.address,
    arenaId: arenaId.toString(),
    arena,
    boss,
    players,
  });

  const base = createRpc(BASE_URL);

  // ---- 1. base layer: create and delegate --------------------------------
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

  // `connectMatch` is tried first because exercising the real client is the point. Its
  // phase 2 — poll the ER until it reports the account cloned — cannot succeed here: the
  // ER clones a delegated account when a transaction first *references* it, not when it
  // is delegated, so `getAccountInfo` on the ER answers `null` forever until something is
  // sent. Observed, not assumed: see `docs/spikes/sp2.md`. The fallback keeps phase 1
  // (the delegation record really names our validator) and `assertErIdentity` (we are
  // really talking to that validator), which are the two checks that prevent the
  // wrong-ER failure mode; the clone is then proven by `start_match` landing.
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
      const statuses = await Promise.all(
        [arena, boss, players].map((a) => getDelegationStatus(a)),
      );
      if (statuses.every((s) => s.delegationRecord?.authority === DEVNET_AS_IDENTITY)) break;
      await sleep(500);
    }
    match = {
      base,
      er,
      erFqdn: route.fqdn,
      validatorIdentity: DEVNET_AS_IDENTITY,
    };
    log('connected', { via: 'fallback', erFqdn: match.erFqdn });
  }

  const consumed: ConsumedLine[] = [];
  const logs = watchCrankLogs(match.erFqdn.replace(/^https/, 'wss'), consumed);

  // ---- 2. arm the crank ---------------------------------------------------
  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, startSig, 'start_match');
  const armed = await readArena(match.er, arena);
  log('start_match', { signature: startSig, ...armed });
  if (armed.phase !== PHASE_FIGHTING) {
    throw new Error(`start_match did not reach PHASE_FIGHTING: phase=${armed.phase}`);
  }

  // ---- 3. five unattended minutes on an empty arena -----------------------
  const emptyFrom = Date.now();
  const empty = await watchTicks(match.er, arena, EMPTY_WATCH_MS, 'empty');
  log('empty_phase', { ...empty, elapsedMs: Date.now() - emptyFrom });
  summarize(consumed, emptyFrom, Date.now(), 'empty');
  await fetchCrankTxLogs(match.er, arena, 5);

  // ---- 4. twenty seats, walked to the gate --------------------------------
  //
  // Skipped when the arena is no longer `Fighting`: past `enrage_at_tick` the tick
  // handler returns before `step`, so seats would be claimed into a match that can no
  // longer move and the loaded phase would measure the same no-op the empty phase did.
  const armedStill = await readArena(match.er, arena);
  if (WANT_SEATS && armedStill.phase === PHASE_FIGHTING) {
  const sessions: { seat: number; keyPair: CryptoKeyPair; address: Address }[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat += 1) {
    const keyPair = await generateKeyPair();
    sessions.push({ seat, keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) });
  }

  for (let from = 0; from < MAX_SEATS; from += 5) {
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
          identity: crypto.getRandomValues(new Uint8Array(32)),
        }),
      ),
    );
    await confirmEr(match.er, sig, `claim_seat ${from}..${from + batch.length - 1}`);
  }
  log('seats_claimed', { count: MAX_SEATS });

  // Walk. One move per seat per tick is the on-chain rate limit, so a round is one
  // instruction per seat and rounds are paced at the crank interval. Positions are
  // re-read from `Players` between rounds rather than assumed, so a dropped transaction
  // costs one extra round instead of stranding a seat off its path.
  for (let round = 0; round < 60; round += 1) {
    const { value } = await match.er.getAccountInfo(players, { encoding: 'base64' }).send();
    if (value === null) throw new Error('players vanished');
    const slots = decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64'))).slots;
    const pending = sessions.filter((s) => {
      const slot = slots[s.seat];
      return slot !== undefined && slot.zone !== ZONE_ARENA && !onGate(slot.x, slot.y);
    });
    if (pending.length === 0) {
      log('walk_done', { round });
      break;
    }
    if (round % 10 === 0) {
      log('walk_progress', { round, pending: pending.length });
    }
    // Seven signers per transaction: eight signatures plus the message stays inside the
    // 1,232-byte packet, and the whole batch is 11 keys against the ~38-key ceiling.
    for (let from = 0; from < pending.length; from += 7) {
      const batch = pending.slice(from, from + 7);
      const ixs: Instruction[] = [];
      for (const s of batch) {
        const slot = slots[s.seat];
        if (slot === undefined) continue;
        const path = pathToGate(slot.x, slot.y);
        if (path === null || path.length === 0) {
          log('walk_unreachable', { seat: s.seat, x: slot.x, y: slot.y });
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
            seq: round + 1,
          }),
        );
      }
      if (ixs.length === 0) continue;
      try {
        await sendSigned(
          match.er,
          treasury.address,
          [treasury.keyPair, ...batch.map((s) => s.keyPair)],
          ixs,
        );
      } catch (error) {
        log('walk_send_failed', { round, error: String(error) });
      }
    }
    await sleep(500);
  }

  // `enter_gate` — same batching, and the same session signers.
  for (let attempt = 0; attempt < 6; attempt += 1) {
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
          treasury.address,
          [treasury.keyPair, ...batch.map((s) => s.keyPair)],
          batch.map((s) =>
            enterGate({ programId: PROGRAM_ID, arena, players, session: s.address, seat: s.seat }),
          ),
        );
        await confirmEr(match.er, sig, `enter_gate x${batch.length}`);
      } catch (error) {
        log('enter_gate_failed', { attempt, error: String(error) });
      }
    }
    await sleep(1_000);
  }

  const loadedStart = await readArena(match.er, arena);
  log('seats_entered', { ...loadedStart });

  // ---- 5. the loaded tick -------------------------------------------------
  const loadedFrom = Date.now();
  const loaded = await watchTicks(match.er, arena, LOADED_WATCH_MS, 'loaded');
  log('loaded_phase', { ...loaded, elapsedMs: Date.now() - loadedFrom });
  summarize(consumed, loadedFrom, Date.now(), 'loaded');
  await fetchCrankTxLogs(match.er, arena, 5);
  } else {
    log('seats_skipped', { wantSeats: WANT_SEATS, ...armedStill });
  }
  summarize(consumed, 0, Date.now(), 'whole-run');

  // ---- 6. settle: cancel the task -----------------------------------------
  const beforeSettle = await readArena(match.er, arena);
  const settleSig = await sendInstructions(match.er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmEr(match.er, settleSig, 'settle', 40_000);
  log('settle', { signature: settleSig, before: beforeSettle });

  // The task is cancelled, so `tick` must stop moving. Read the arena back off the BASE
  // layer: `settle` undelegates, so the ER's copy is gone by now.
  await sleep(20_000);
  for (let i = 0; i < 3; i += 1) {
    const { value } = await base.getAccountInfo(arena, { encoding: 'base64' }).send();
    if (value === null) {
      log('post_settle_missing');
    } else {
      const decoded = decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
      log('post_settle', { tick: decoded.tick, phase: decoded.phase, owner: value.owner });
    }
    await sleep(10_000);
  }

  logs.close();
  log('done');
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    // kit renders RPC code -32003 as "Transaction signature verification failure"
    // whatever the server actually said, and the ER uses -32003 for cloner failures. The
    // real sentence is in `context`, so it is logged too.
    log('fatal', {
      error: String(error),
      context: (error as { context?: unknown }).context ?? null,
      cause: String((error as { cause?: unknown }).cause ?? ''),
      stack: (error as Error)?.stack,
    });
    process.exit(1);
  },
);
