/**
 * PERF-EXECUTE — how much of write-to-visible is execution and how much is waiting.
 *
 * The end-to-end number the game shows (p50 ~295 ms) is submit + execute + notify +
 * decode. SP-LOAD reported the odd fact that a transaction's own `logsSubscribe`
 * notification arrives *before* its `sendTransaction` POST returns (141 ms vs 124 ms),
 * which would mean the write path and the read path are independent and that shaving the
 * POST buys nothing. This spike settles that, on one clock, per transaction.
 *
 * Four timestamps per `move`, all from one process so all comparable:
 *
 *   tPost0  the POST is handed to the socket (message already built and signed, so no
 *           blockhash fetch is inside the window)
 *   tPost1  `sendTransaction` returns the signature
 *   tLog    the transaction's own `logsSubscribe` notification arrives (first delivery)
 *   tAcct   the `accountSubscribe` update on `Players` carrying this move's `seq` arrives
 *
 * Three sockets, all **direct to the ER**, never the router, so nothing here is measuring
 * a proxy hop. A fourth stream, `slotSubscribe`, timestamps every slot boundary locally,
 * which is what turns "the read path is slow" into "the read path is quantised": the ER
 * coalesces account notifications to one per account per 50 ms slot, and this measures
 * how much of the wait that actually is.
 *
 * No rent is spent: the script attaches to an arena that is already delegated and in
 * LOBBY, claims one free seat, and moves. `move` takes `Arena` read-only and needs no
 * match to be running.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_execute.ts --bundle --platform=node --format=esm \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_execute.mjs && node /tmp/perf_execute.mjs
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  MAP_TILE,
  PHASE_LOBBY,
  ROUTER_ENDPOINT,
  claimSeat,
  createRpc,
  decodeArena,
  decodeLeaderboard,
  decodePlayers,
  getDelegationStatus,
  getRoutes,
  isWall,
  leaderboardPda,
  matchPdas,
  movePlayer,
  sendInstructions,
  type HeartrotRpc,
} from '../../packages/client/src/index';

const PROGRAM_ID = address('JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5');
const BASE_RPC = 'https://api.devnet.solana.com';
const TREASURY_KEY = `${homedir()}/.config/heartrot/treasury.json`;

/** Move samples. The task asks for >=200; 260 leaves room for a few unlanded rows. */
const SAMPLES = 260;
/** Gap between sends. Two ER slots, so the program's per-slot limiter never rejects. */
const PACE_MS = 120;
/** Slot notifications collected before the move phase, for the cadence number. */
const SLOT_SAMPLES = 260;
/** Plain `getSlot` calls, for the application-level HTTP round trip floor. */
const RTT_SAMPLES = 120;
/** How many arena ids past the leaderboard head to scan for a delegated lobby. */
const ARENA_SCAN = 12;
/** How long the `cached` arm holds one blockhash before refreshing it in line. */
const BLOCKHASH_TTL_MS = 10_000;
/** Blockhash-expiry ladder: one send every this long, until the ER refuses. */
const EXPIRY_STEP_MS = 2_000;
const EXPIRY_STEPS = 40;
/** Sequence used by the duplicate-signature probe; above every sample's. */
const DUP_SEQ = SAMPLES + EXPIRY_STEPS + 10;

const OUT = 'docs/perf/execute-run.jsonl';

const now = (): number => Number(process.hrtime.bigint() / 1_000_000n);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (...p: unknown[]): void => console.log(...p);

function rec(kind: string, fields: Record<string, unknown>): void {
  appendFileSync(OUT, JSON.stringify({ kind, at: now(), ...fields }) + '\n');
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

type Stats = { n: number; min: number; p50: number; p90: number; p95: number; max: number; mean: number };

function stats(xs: readonly number[]): Stats {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p50: pct(s, 50),
    p90: pct(s, 90),
    p95: pct(s, 95),
    max: s[s.length - 1] ?? NaN,
    mean: s.length === 0 ? NaN : Math.round((sum / s.length) * 10) / 10,
  };
}

function line(label: string, s: Stats): string {
  return (
    `${label.padEnd(34)} n=${String(s.n).padStart(4)}  min=${String(s.min).padStart(6)}  ` +
    `p50=${String(s.p50).padStart(6)}  p90=${String(s.p90).padStart(6)}  ` +
    `p95=${String(s.p95).padStart(6)}  max=${String(s.max).padStart(6)}  mean=${s.mean}`
  );
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------

type Sub = { close: () => void };

/**
 * One subscription, one socket. Separate sockets rather than multiplexing: a 3 KB log
 * payload and a 6 KB account payload parsed on the same connection would push each
 * other's arrival timestamp around, which is precisely the quantity being measured.
 */
function subscribe(
  wsUrl: string,
  label: string,
  request: unknown,
  onNotify: (value: unknown, ctxSlot: number | null, at: number) => void,
): Sub {
  let closed = false;
  let socket = new WebSocket(wsUrl);

  const wire = (ws: WebSocket): void => {
    ws.onopen = (): void => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, ...(request as object) }));
    };
    ws.onmessage = (ev: MessageEvent): void => {
      const at = now();
      let msg: {
        error?: unknown;
        result?: unknown;
        params?: { result?: { context?: { slot?: number }; value?: unknown } };
      };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.error !== undefined) {
        say(`  !! ${label} subscribe error: ${JSON.stringify(msg.error)}`);
        return;
      }
      if (msg.params === undefined) return; // the subscription id
      const r = msg.params.result;
      if (r === undefined) return;
      // `slotNotification` puts its payload directly in `result`; the others wrap it in
      // `{context, value}`. Pass whichever is present.
      const value = (r as { value?: unknown }).value ?? r;
      onNotify(value, (r as { context?: { slot?: number } }).context?.slot ?? null, at);
    };
    ws.onclose = (): void => {
      if (closed) return;
      say(`  !! ${label} socket closed, reconnecting`);
      setTimeout(() => {
        if (closed) return;
        socket = new WebSocket(wsUrl);
        wire(socket);
      }, 500);
    };
    ws.onerror = (): void => {
      say(`  !! ${label} socket error`);
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
// Setup helpers
// ---------------------------------------------------------------------------

async function accountData(rpc: HeartrotRpc, a: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  return value === null ? null : new Uint8Array(Buffer.from(value.data[0], 'base64'));
}

function withSigners(ix: Instruction, signers: readonly TransactionSigner[]): Instruction {
  const by = new Map(signers.map((s) => [s.address as string, s]));
  return {
    ...ix,
    accounts: (ix.accounts ?? []).map((a) => {
      const s = by.get(a.address as string);
      const isSigner =
        a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER;
      return s !== undefined && isSigner ? { ...a, signer: s } : a;
    }),
  } as Instruction;
}

/** An opposite direction pair whose two endpoints are both floor, so the seat stays put. */
function pickOpenAxis(x: number, y: number): [number, number] {
  for (const [a, b, dx, dy] of [
    [2, 6, MAP_TILE, 0],
    [4, 0, 0, MAP_TILE],
  ] as const) {
    if (!isWall(x + dx, y + dy) && !isWall(x, y)) return [a, b];
  }
  throw new Error(`no open axis from (${x},${y})`);
}

/**
 * The first arena at or after the leaderboard head that is delegated to devnet-as and
 * still in LOBBY. Attaching to one costs nothing; creating one costs 0.067 SOL of rent
 * the treasury has barely one of left.
 */
async function findLobby(
  base: HeartrotRpc,
): Promise<{ arenaId: bigint; arena: Address; players: Address; erFqdn: string }> {
  const board = await accountData(base, await leaderboardPda(PROGRAM_ID));
  const last = board === null ? 0n : decodeLeaderboard(board).lastArenaId;
  const head = last > 0n ? last : 1n;
  for (let step = 0; step < ARENA_SCAN; step++) {
    const arenaId = head + BigInt(step);
    const { arena, players } = await matchPdas(PROGRAM_ID, arenaId);
    const status = await getDelegationStatus(arena, ROUTER_ENDPOINT);
    if (!status.isDelegated) continue;
    if (status.delegationRecord?.authority !== DEVNET_AS_IDENTITY) continue;
    if (status.fqdn === undefined) continue;
    const er = createRpc(status.fqdn);
    const data = await accountData(er, arena);
    if (data === null) continue;
    if (decodeArena(data).phase !== PHASE_LOBBY) continue;
    return { arenaId, arena, players, erFqdn: status.fqdn };
  }
  throw new Error(`no delegated LOBBY arena in ids ${head}..${head + BigInt(ARENA_SCAN - 1)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Row = {
  seq: number;
  sig: string;
  arm: 'cached' | 'fresh';
  /** Where the app's own `recordSend` fires: before anything, blockhash fetch included. */
  tCall: number;
  tPost0: number;
  tPost1: number;
  tLog?: number;
  tAcct?: number;
  logSlot?: number;
  acctSlot?: number;
  err?: unknown;
};

async function main(): Promise<void> {
  writeFileSync(OUT, '');
  const treasury = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(TREASURY_KEY, 'utf8')) as number[]),
  );
  const session = await generateKeyPairSigner();
  const base = createRpc(BASE_RPC);

  say(`program  ${PROGRAM_ID}`);
  say(`treasury ${treasury.address}`);
  say(`session  ${session.address}`);

  const { arenaId, arena, players, erFqdn } = await findLobby(base);
  say(`arena ${arenaId} ${arena}  players ${players}  ER ${erFqdn}`);

  // Pin. Reading a delegated account from the wrong ER returns frozen data silently, so
  // the route table and the endpoint's own identity both have to agree before anything
  // is measured against it.
  const route = (await getRoutes(ROUTER_ENDPOINT)).find((r) => r.fqdn === erFqdn);
  if (route === undefined) throw new Error(`${erFqdn} is not in getRoutes`);
  const er = createRpc(erFqdn);
  const { identity } = await er.getIdentity().send();
  if (identity !== DEVNET_AS_IDENTITY || route.identity !== DEVNET_AS_IDENTITY) {
    throw new Error(`ER identity mismatch: getIdentity=${identity} route=${route.identity}`);
  }
  const wsUrl = erFqdn.replace(/^https/, 'wss');
  say(`pinned to ${identity}, ws ${wsUrl}, block time ${route.blockTimeMs}ms`);
  rec('setup', { arenaId: arenaId.toString(), arena, players, erFqdn, identity });

  // -- claim a free seat ----------------------------------------------------
  const roster = decodePlayers((await accountData(er, players))!);
  const seat = roster.slots.findIndex((s) => !s.occupied);
  if (seat < 0) throw new Error('no free seat in this lobby');
  await sendInstructions(
    er,
    session,
    [
      withSigners(
        claimSeat({
          programId: PROGRAM_ID,
          arena,
          players,
          treasury: treasury.address,
          seat,
          skinId: 1,
          sessionPubkey: session.address,
          // Per-run, not a constant: the program seats one identity once, so a second
          // run against the same lobby with a fixed hash is refused.
          identity: new Uint8Array(
            createHash('sha256').update(`perf-execute:${session.address}`).digest(),
          ),
        }),
        [treasury],
      ),
    ],
  );
  for (let i = 0; ; i++) {
    const p = decodePlayers((await accountData(er, players))!);
    if (p.slots[seat]!.occupied) break;
    if (i > 40) throw new Error('claim_seat never became visible');
    await sleep(250);
  }
  const me = decodePlayers((await accountData(er, players))!).slots[seat]!;
  const dirs = pickOpenAxis(me.x, me.y);
  say(`seat ${seat} at (${me.x},${me.y}), oscillating dirs ${dirs[0]}/${dirs[1]}`);

  // -- HTTP round trip floor -------------------------------------------------
  // The submit half cannot be faster than one application-level round trip on the same
  // keep-alive connection this script sends over. Measured, not assumed: prior work
  // quoted a 196 ms ICMP-equivalent RTT that the 124 ms POST already contradicts.
  say(`\n[rtt] ${RTT_SAMPLES} getSlot calls`);
  const rtt: number[] = [];
  for (let i = 0; i < RTT_SAMPLES; i++) {
    const t0 = now();
    await er.getSlot().send();
    rtt.push(now() - t0);
    await sleep(25);
  }
  rec('rtt', { samples: rtt });
  say('  ' + line('getSlot round trip ms', stats(rtt)));

  // -- slot cadence ----------------------------------------------------------
  say(`\n[slots] ${SLOT_SAMPLES} slotSubscribe notifications`);
  const slotAt = new Map<number, number>();
  const slotArrivals: Array<{ slot: number; at: number }> = [];
  const slots = subscribe(
    wsUrl,
    'slot',
    { method: 'slotSubscribe', params: [] },
    (value, _ctx, at) => {
      const s = (value as { slot?: number }).slot;
      if (s === undefined) return;
      if (!slotAt.has(s)) slotAt.set(s, at);
      slotArrivals.push({ slot: s, at });
    },
  );
  for (let i = 0; i < 200 && slotArrivals.length < SLOT_SAMPLES; i++) await sleep(100);
  const gaps: number[] = [];
  for (let i = 1; i < slotArrivals.length; i++) {
    const d = slotArrivals[i]!.slot - slotArrivals[i - 1]!.slot;
    if (d === 1) gaps.push(slotArrivals[i]!.at - slotArrivals[i - 1]!.at);
  }
  rec('slot_gaps', { n: slotArrivals.length, gaps });
  say('  ' + line('consecutive slot gap ms', stats(gaps)));

  // -- the move phase --------------------------------------------------------
  const rows = new Map<string, Row>();
  const bySeq = new Map<number, Row>();

  const logs = subscribe(
    wsUrl,
    'logs',
    { method: 'logsSubscribe', params: [{ mentions: [arena] }, { commitment: 'processed' }] },
    (value, ctxSlot, at) => {
      const v = value as { signature?: string; err?: unknown };
      if (v.signature === undefined) return;
      const row = rows.get(v.signature);
      if (row === undefined || row.tLog !== undefined) return; // first delivery only
      row.tLog = at;
      row.logSlot = ctxSlot ?? undefined;
      row.err = v.err ?? null;
    },
  );

  const acct = subscribe(
    wsUrl,
    'account',
    {
      method: 'accountSubscribe',
      params: [players, { encoding: 'base64', commitment: 'processed' }],
    },
    (value, ctxSlot, at) => {
      const v = value as { data?: [string, string] };
      if (v.data === undefined) return;
      let seqSeen: number;
      try {
        seqSeen = decodePlayers(new Uint8Array(Buffer.from(v.data[0], 'base64'))).slots[seat]!
          .lastMoveSeq;
      } catch {
        return;
      }
      // Resolve every still-open row at or below the sequence this update carries: an
      // update can skip a seq when two moves land in one slot, and the skipped row was
      // observable at exactly this moment too.
      for (let s = seqSeen; s >= 1; s--) {
        const row = bySeq.get(s);
        if (row === undefined || row.tAcct !== undefined) break;
        row.tAcct = at;
        row.acctSlot = ctxSlot ?? undefined;
      }
    },
  );

  await sleep(1_000); // let both subscriptions be established

  // Two arms, interleaved sample by sample so they share the same network weather:
  //
  //   cached — blockhash held and refreshed in the background; the POST is the whole
  //            client-side cost.
  //   fresh  — exactly what the app does today: `getLatestBlockhash` awaited on every
  //            single move before the transaction can even be signed.
  //
  // `tCall` starts where the app's `recordSend` starts, so `tCall -> account update` is
  // the app's own write-to-visible definition, arm for arm.
  say(`\n[moves] ${SAMPLES} moves at ${PACE_MS}ms, arms interleaved`);
  let blockhash = (await er.getLatestBlockhash().send()).value;
  let blockhashAt = now();
  for (let i = 0; i < SAMPLES; i++) {
    const seq = i + 1;
    const fresh = i % 2 === 1;
    const tCall = now();
    if (fresh) {
      blockhash = (await er.getLatestBlockhash().send()).value;
      blockhashAt = now();
    } else if (now() - blockhashAt > BLOCKHASH_TTL_MS) {
      blockhash = (await er.getLatestBlockhash().send()).value;
      blockhashAt = now();
    }
    const ix = movePlayer({
      programId: PROGRAM_ID,
      arena,
      players,
      session: session.address,
      seat,
      dir: dirs[i % 4 < 2 ? 0 : 1]!,
      seq,
    });
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(session, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        (m) => appendTransactionMessageInstructions([ix], m),
      ),
    );
    const wire = getBase64EncodedWireTransaction(signed);
    const sig = getSignatureFromTransaction(signed);
    const row: Row = { seq, sig, arm: fresh ? 'fresh' : 'cached', tCall, tPost0: 0, tPost1: 0 };
    // Registered before the POST: the ER has been observed to deliver the notification
    // before `sendTransaction` returns, so a row created afterwards would miss it.
    rows.set(sig, row);
    bySeq.set(seq, row);
    row.tPost0 = now();
    await er.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send();
    row.tPost1 = now();
    await sleep(PACE_MS);
  }

  say('  draining notifications for 5s');
  await sleep(5_000);
  logs.close();
  acct.close();
  slots.close();

  // -- report ---------------------------------------------------------------
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  for (const r of all) rec('move', r as unknown as Record<string, unknown>);

  const cached = all.filter((r) => r.arm === 'cached');
  const freshArm = all.filter((r) => r.arm === 'fresh');
  const post = all.map((r) => r.tPost1 - r.tPost0);
  const withLog = all.filter((r) => r.tLog !== undefined);
  const withAcct = all.filter((r) => r.tAcct !== undefined);
  const sendToLog = withLog.map((r) => r.tLog! - r.tPost0);
  const postToLog = withLog.map((r) => r.tLog! - r.tPost1);
  const sendToAcct = withAcct.map((r) => r.tAcct! - r.tPost0);
  const logToAcct = all.filter((r) => r.tLog !== undefined && r.tAcct !== undefined)
    .map((r) => r.tAcct! - r.tLog!);
  const errs = withLog.filter((r) => r.err !== null && r.err !== undefined).length;

  // How much of the post->log wait is waiting for a slot boundary rather than executing:
  // for each row, the local arrival of the slot notification for the slot the log says
  // the transaction landed in.
  const slotSkew: number[] = [];
  for (const r of withLog) {
    const t = r.logSlot === undefined ? undefined : slotAt.get(r.logSlot);
    if (t !== undefined) slotSkew.push(r.tLog! - t);
  }

  const armStats = (arm: readonly Row[]): { call: Stats; post: Stats } => ({
    call: stats(arm.filter((r) => r.tAcct !== undefined).map((r) => r.tAcct! - r.tCall)),
    post: stats(arm.map((r) => r.tPost1 - r.tPost0)),
  });
  const A = armStats(cached);
  const B = armStats(freshArm);

  say('\n=== RESULTS ===');
  say('  ' + line('send: POST duration', stats(post)));
  say('  ' + line('tPost0 -> log arrives', stats(sendToLog)));
  say('  ' + line('tPost1 -> log arrives', stats(postToLog)));
  say('  ' + line('tPost0 -> account update', stats(sendToAcct)));
  say('  ' + line('log -> account update', stats(logToAcct)));
  say('  ' + line('log arrival vs its slot notif', stats(slotSkew)));
  say(`  logs seen ${withLog.length}/${all.length}, account acks ${withAcct.length}/${all.length}, errored ${errs}`);
  const negative = postToLog.filter((x) => x < 0).length;
  say(`  log arrived BEFORE the POST returned: ${negative}/${postToLog.length} rows`);
  say('\n--- arms: write-to-visible as the app defines it (tCall -> account update) ---');
  say('  ' + line('cached blockhash', A.call));
  say('  ' + line('fresh blockhash per move (app)', B.call));
  say('  ' + line('cached: POST duration', A.post));
  say('  ' + line('fresh: POST duration', B.post));

  rec('summary', {
    post: stats(post),
    sendToLog: stats(sendToLog),
    postToLog: stats(postToLog),
    sendToAcct: stats(sendToAcct),
    logToAcct: stats(logToAcct),
    slotSkew: stats(slotSkew),
    slotGap: stats(gaps),
    rtt: stats(rtt),
    armCachedCall: A.call,
    armFreshCall: B.call,
    armCachedPost: A.post,
    armFreshPost: B.post,
    negativePostToLog: negative,
    errored: errs,
    logsSeen: withLog.length,
    acctSeen: withAcct.length,
    n: all.length,
  });
  // The hazard a cached blockhash introduces, measured rather than assumed. `shoot` is
  // three bytes — tag, seat, dir — with no sequence number, so under one held blockhash
  // two shots in the same direction are the same transaction and carry the same
  // signature. `move` varies by `seq`, so this reproduces the collision with a repeated
  // seq instead and asks the ER what it does with the second copy.
  say('\n[dup] the same signed transaction sent twice under one blockhash');
  {
    const bh = (await er.getLatestBlockhash().send()).value;
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(session, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
        (m) =>
          appendTransactionMessageInstructions(
            [
              movePlayer({
                programId: PROGRAM_ID,
                arena,
                players,
                session: session.address,
                seat,
                dir: dirs[0]!,
                seq: DUP_SEQ,
              }),
            ],
            m,
          ),
      ),
    );
    const wire = getBase64EncodedWireTransaction(signed);
    const sig = getSignatureFromTransaction(signed);
    const results: string[] = [];
    for (let k = 0; k < 2; k++) {
      try {
        await er.sendTransaction(wire, { encoding: 'base64', skipPreflight: true }).send();
        results.push('accepted');
      } catch (e) {
        results.push(String(e).replace(/\s+/g, ' ').slice(0, 140));
      }
      await sleep(400);
    }
    say(`  signature ${sig}`);
    say(`  first send:  ${results[0]}`);
    say(`  second send: ${results[1]}`);
    rec('duplicate_send', { sig, results });
  }

  // Caching a blockhash is the lever the arms above price, so its ceiling has to be
  // measured, not guessed: hold ONE blockhash and send with it every 2 s until the ER
  // stops accepting it. The age at the first rejection is the refresh budget.
  say(`\n[expiry] holding one blockhash and sending every ${EXPIRY_STEP_MS}ms`);
  const held = (await er.getLatestBlockhash().send()).value;
  const heldAt = now();
  let lastOk = 0;
  let firstFail = -1;
  for (let k = 1; k <= EXPIRY_STEPS; k++) {
    const age = now() - heldAt;
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(session, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(held, m),
        (m) =>
          appendTransactionMessageInstructions(
            [
              movePlayer({
                programId: PROGRAM_ID,
                arena,
                players,
                session: session.address,
                seat,
                dir: dirs[k % 2]!,
                seq: SAMPLES + k,
              }),
            ],
            m,
          ),
      ),
    );
    let ok = true;
    let why = '';
    try {
      await er
        .sendTransaction(getBase64EncodedWireTransaction(signed), {
          encoding: 'base64',
          skipPreflight: true,
        })
        .send();
    } catch (e) {
      ok = false;
      why = String(e).replace(/\s+/g, ' ').slice(0, 120);
    }
    rec('expiry', { ageMs: age, ok, why });
    if (ok) lastOk = age;
    else if (firstFail < 0) {
      firstFail = age;
      say(`  first rejection at age ${age}ms: ${why}`);
      break;
    }
    await sleep(EXPIRY_STEP_MS);
  }
  say(`  last accepted age ${lastOk}ms, first rejected age ${firstFail}ms`);
  rec('expiry_summary', { lastOkMs: lastOk, firstFailMs: firstFail });

  say(`\nraw: ${OUT}`);
}

await main();
