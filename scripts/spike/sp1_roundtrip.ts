/**
 * SP1 — delegate → ER write → commit → undelegate, against real devnet.
 *
 * Everything the program is reached through comes from `packages/client`: if a
 * hand-written encoder is wrong, it is wrong here too. The only things built locally are
 * a ComputeBudget instruction (no builder exists and none should), a signer-attaching
 * adapter (the client's builders emit bare `AccountMeta`, and kit collects signers off
 * the metas), and the two deliberate negative tests, which have to be malformed on
 * purpose and therefore cannot come from a builder.
 *
 * Run:
 *   node node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp1_roundtrip.ts --bundle --platform=node --format=esm --outfile=<out>.mjs
 *   node <out>.mjs
 */

import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compressTransactionMessageUsingAddressLookupTables,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
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
  ARENA,
  BOSS,
  DELEGATION_PROGRAM_ID,
  DEVNET_AS_IDENTITY,
  MAP_TILE,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_SETTLED,
  ROUTER_ENDPOINT,
  claimSeat,
  confirmSignature,
  createRpc,
  decodeArena,
  decodePlayers,
  delegate,
  getDelegationStatus,
  getRoutes,
  initArena,
  initLeaderboard,
  isWall,
  leaderboardPda,
  matchPdas,
  movePlayer,
  PLAYERS,
  SYSTEM_PROGRAM_ID,
  sendInstructions,
  settle,
  startMatch,
  type HeartrotRpc,
} from '../../packages/client/src/index';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROGRAM_ID = address('JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5');
const BASE_RPC = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = address('ComputeBudget111111111111111111111111111111');
const TREASURY_KEY = `${homedir()}/.config/heartrot/treasury.json`;
const MOVE_SAMPLES = 25;

/**
 * Which ER to pin the arena to. Defaults to devnet-as, the region the app ships on.
 * Override with `SP1_VALIDATOR=<identity>` to run the whole round trip — delegate, ER
 * write, crank, commit, undelegate — against a different region and read its
 * write-to-visible p50 off step 6. That is the only way to prove a region works: RTT
 * alone does not tell you whether its cloner and its crank scheduler serve this program.
 */
const VALIDATOR = address(process.env.SP1_VALIDATOR ?? DEVNET_AS_IDENTITY);
const SEAT = 0;

const decodeAddress = getAddressDecoder();

/** Which URL an RPC object talks to — `rawExplain` needs it and kit does not expose it. */
const rpcUrls = new WeakMap<object, string>();
function rpcFor(url: string): HeartrotRpc {
  const rpc = createRpc(url);
  rpcUrls.set(rpc as object, url);
  return rpc;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1_000_000n);

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

type Row = { step: string; keys: number; sig?: string; ms?: number; note?: string };
const log: Row[] = [];
const surprises: string[] = [];

function say(...parts: unknown[]): void {
  console.log(...parts);
}

function surprise(s: string): void {
  surprises.push(s);
  say('  !! ' + s);
}

/**
 * Total account keys a v0 transaction with no ALT will carry: fee payer, every
 * instruction account, every program id. Computed from the same inputs the message
 * compiler sees, rather than by re-implementing `sendInstructions` to peek at the
 * compiled message.
 */
function keyCount(feePayer: Address, ixs: readonly Instruction[]): number {
  const keys = new Set<string>([feePayer]);
  for (const ix of ixs) {
    keys.add(ix.programAddress);
    for (const a of ix.accounts ?? []) keys.add(a.address);
  }
  return keys.size;
}

/** Attach real signer objects to the metas the client's builders emit as bare addresses. */
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

/**
 * Plain System transfer. Used to lift a freshly created PDA from the *base* layer's
 * rent-exempt minimum to the ER's, which are not the same number — see step [1b].
 */
function systemTransfer(from: TransactionSigner, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const v = new DataView(data.buffer);
  v.setUint32(0, 2, true); // System: Transfer
  v.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  } as Instruction;
}

function computeBudget(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

/**
 * `@solana/kit` maps JSON-RPC `-32003` to the canned string "Transaction signature
 * verification failure" and throws away the server's own message — which on the ER is
 * where the real reason lives. This rebuilds an identical transaction and raw-POSTs it
 * purely to read that message back. Diagnostic only; the product send path above is
 * still the client's.
 */
async function rawExplain(url: string, feePayer: TransactionSigner, ixs: readonly Instruction[]): Promise<string> {
  try {
    const rpc = createRpc(url);
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const msg = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const signed = await signTransactionMessageWithSigners(msg);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sendTransaction',
        params: [getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: true }],
      }),
    });
    const body = (await res.json()) as { error?: { code: number; message: string }; result?: string };
    return body.error ? `${body.error.code}: ${body.error.message}` : `accepted on retry (${body.result})`;
  } catch (e) {
    return `(rawExplain failed: ${String(e)})`;
  }
}

async function txLogs(rpc: HeartrotRpc, sig: string): Promise<string> {
  try {
    const tx = await (rpc as never as {
      getTransaction: (s: string, c: unknown) => { send: () => Promise<unknown> };
    })
      .getTransaction(sig, { maxSupportedTransactionVersion: 0, encoding: 'json' })
      .send();
    const meta = (tx as { meta?: { logMessages?: string[] } } | null)?.meta;
    return meta?.logMessages?.join('\n  ') ?? '(no logs)';
  } catch (e) {
    return `(getTransaction failed: ${String(e)})`;
  }
}

/**
 * Send through the client's own `sendInstructions` + `confirmSignature`, record the key
 * count, and surface the real error. `confirmSignature` only accepts confirmed/finalized;
 * if the ER never reports that, the fallback below is the finding, not a workaround.
 */
async function send(
  rpc: HeartrotRpc,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
  step: string,
  timeoutMs = 30_000,
): Promise<string> {
  const keys = keyCount(feePayer.address, ixs);
  const t0 = now();
  const sig = await sendInstructions(rpc, feePayer, ixs);
  try {
    await confirmSignature(rpc, sig, { timeoutMs, pollMs: 200 });
  } catch (e) {
    const msg = String(e);
    if (msg.includes('not confirmed within the timeout')) {
      const { value } = await rpc.getSignatureStatuses([sig]).send();
      surprise(
        `${step}: confirmSignature timed out; raw status = ${JSON.stringify(value[0])} — ` +
          `the client only accepts confirmed/finalized`,
      );
    }
    const url = rpcUrls.get(rpc as object);
    if (url !== undefined) say(`  server said: ${await rawExplain(url, feePayer, ixs)}`);
    say(`  logs for ${step}:\n  ${await txLogs(rpc, sig)}`);
    throw e;
  }
  const ms = now() - t0;
  log.push({ step, keys, sig, ms });
  say(`  ${step}: ${keys} keys, ${ms}ms, ${sig}`);
  return sig;
}

async function readAccount(rpc: HeartrotRpc, a: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  if (value === null) return null;
  return new Uint8Array(Buffer.from(value.data[0], 'base64'));
}

async function ownerOf(rpc: HeartrotRpc, a: Address): Promise<string | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  return value === null ? null : (value.owner as string);
}

async function lamportsOf(rpc: HeartrotRpc, a: Address): Promise<bigint> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  return value === null ? 0n : BigInt(value.lamports);
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(TREASURY_KEY, 'utf8')) as number[]),
  );
  const session = await generateKeyPairSigner(); // never funded, never airdropped
  const arenaId = BigInt(process.env.SP1_ARENA_ID ?? Date.now());
  const identity = new Uint8Array(createHash('sha256').update('sp1-spike').digest());

  say(`program   ${PROGRAM_ID}`);
  say(`treasury  ${treasury.address}`);
  say(`session   ${session.address}  (zero SOL, freshly generated)`);
  say(`arena_id  ${arenaId}`);

  const base = rpcFor(BASE_RPC);
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const leaderboard = await leaderboardPda(PROGRAM_ID);
  say(`arena ${arena}\nboss  ${boss}\nplayers ${players}\nleaderboard ${leaderboard}`);

  // -- 1. base-layer init ---------------------------------------------------
  say('\n[1] base layer init');
  if ((await readAccount(base, leaderboard)) === null) {
    await send(base, treasury, [initLeaderboard({ programId: PROGRAM_ID, payer: treasury.address, leaderboard })], 'init_leaderboard');
  } else {
    say('  leaderboard already exists, skipping init_leaderboard');
  }

  await send(
    base,
    treasury,
    [
      initArena({
        programId: PROGRAM_ID,
        payer: treasury.address,
        arena,
        boss,
        players,
        arenaId,
        incarnation: 1,
        validatorIdentity: VALIDATOR,
        crankAuthority: treasury.address,
      }),
    ],
    'init_arena',
  );

  {
    const a = decodeArena((await readAccount(base, arena))!);
    if (a.phase !== PHASE_LOBBY) surprise(`arena phase after init is ${a.phase}, expected LOBBY`);
    const vid = decodeAddress.decode(a.validatorIdentity);
    say(`  arena.validator_identity = ${vid}, crank_task_id = ${a.crankTaskId}`);
    if (vid !== VALIDATOR) surprise(`validator_identity round-tripped as ${vid}`);
  }

  // -- 1b. rent top-up ------------------------------------------------------
  // `init_arena` creates each PDA at the *base* layer's rent-exempt minimum, read from
  // the Rent sysvar. The ER's cloner enforces a different (higher) schedule, and an
  // account below it can never be cloned. See docs/spikes/sp1.md.
  say('\n[1b] rent top-up for the ER cloner');
  const topUps: Instruction[] = [];
  for (const [name, acct, want] of [
    ['arena', arena, ARENA.rentExemptLamports],
    ['boss', boss, BOSS.rentExemptLamports],
    ['players', players, PLAYERS.rentExemptLamports],
  ] as const) {
    const have = await lamportsOf(base, acct);
    const deficit = want - have;
    say(`  ${name}: base has ${have}, layout.ts wants ${want}, deficit ${deficit}`);
    if (deficit > 0n) topUps.push(systemTransfer(treasury, acct, deficit));
  }
  if (topUps.length > 0) {
    await send(base, treasury, topUps, 'rent_topup');
  } else {
    say('  no top-up needed');
  }

  // -- 2. delegate ----------------------------------------------------------
  say('\n[2] delegate');
  const delegateIx = await delegate({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players });
  await send(base, treasury, [computeBudget(1_400_000), delegateIx], 'delegate');
  const tDelegated = now();

  // -- 3. resolve the ER, prove ownership both sides -------------------------
  say('\n[3] router + ownership');
  const routes = await getRoutes(ROUTER_ENDPOINT);
  const route = routes.find((r) => r.identity === VALIDATOR);
  if (route === undefined) throw new Error(`${VALIDATOR} absent from getRoutes`);
  say(`  route ${route.identity} -> ${route.fqdn} (${route.countryCode}, ${route.blockTimeMs}ms blocks)`);
  const er = rpcFor(route.fqdn);
  const { identity: erIdentity } = await er.getIdentity().send();
  say(`  ER getIdentity = ${erIdentity}`);
  if (erIdentity !== VALIDATOR) surprise(`ER identity is ${erIdentity}`);

  for (const [name, acct] of [['arena', arena], ['boss', boss], ['players', players]] as const) {
    const st = await getDelegationStatus(acct, ROUTER_ENDPOINT);
    say(`  ${name}: isDelegated=${st.isDelegated} authority=${st.delegationRecord?.authority} fqdn=${st.fqdn}`);
    if (st.delegationRecord?.authority !== VALIDATOR) {
      surprise(`${name} delegation authority is ${st.delegationRecord?.authority}`);
    }
    const baseOwner = await ownerOf(base, acct);
    if (baseOwner !== DELEGATION_PROGRAM_ID) surprise(`${name} base owner is ${baseOwner}, expected delegation program`);
    say(`  ${name}: base owner ${baseOwner}`);
  }

  // -- 4. first accepted ER write, zero-SOL session key -----------------------
  say('\n[4] first ER write (claim_seat) — retrying until the ER accepts it');
  const claimIx = withSigners(
    claimSeat({
      programId: PROGRAM_ID,
      arena,
      players,
      treasury: treasury.address,
      seat: SEAT,
      skinId: 1,
      sessionPubkey: session.address,
      identity,
    }),
    [treasury],
  );

  let erWriteGap = -1;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await send(er, session, [claimIx], `claim_seat (attempt ${attempts})`, 20_000);
      erWriteGap = now() - tDelegated;
      break;
    } catch (e) {
      if (now() - tDelegated > 60_000) throw e;
      if (attempts === 1) say(`  attempt 1 rejected: ${String(e).slice(0, 200)}`);
      if (attempts === 1) say(`  server said: ${await rawExplain(route.fqdn, session, [claimIx])}`);
      await sleep(250);
    }
  }
  say(`  confirmed-delegate -> first-accepted-ER-write: ${erWriteGap}ms over ${attempts} attempt(s)`);

  for (const [name, acct] of [['arena', arena], ['boss', boss], ['players', players]] as const) {
    const o = await ownerOf(er, acct);
    say(`  ${name}: ER owner ${o}`);
    if (o !== PROGRAM_ID) surprise(`${name} ER owner is ${o}, expected the program`);
  }

  const sessionBase = await lamportsOf(base, session.address);
  const sessionEr = await lamportsOf(er, session.address);
  say(`  session lamports: base=${sessionBase} er=${sessionEr}`);
  if (sessionBase !== 0n || sessionEr !== 0n) surprise('session key is not actually empty');

  // -- 5. read the write back off the ER -------------------------------------
  say('\n[5] read back from the ER');
  const seated = decodePlayers((await readAccount(er, players))!);
  const slot = seated.slots[SEAT]!;
  const seatedKey = decodeAddress.decode(slot.sessionPubkey);
  say(`  seat ${SEAT}: occupied=${slot.occupied} session=${seatedKey} pos=(${slot.x},${slot.y}) hp=${slot.hp}`);
  if (seatedKey !== session.address) surprise(`seat 0 holds ${seatedKey}, not the session key`);
  const erArena = decodeArena((await readAccount(er, arena))!);
  say(`  arena.seat_occupied = 0b${erArena.seatOccupied.toString(2)}, tick = ${erArena.tick}`);

  // -- 6. latency samples, all signed by the zero-SOL session key -------------
  say(`\n[6] ${MOVE_SAMPLES} move samples (phase LOBBY, rate limit is the ER slot clock)`);
  const dirs: [number, number] = pickOpenAxis(slot.x, slot.y);
  say(`  oscillating between dir ${dirs[0]} and dir ${dirs[1]} from (${slot.x},${slot.y})`);

  const latencies: number[] = [];
  let moveKeys = 0;
  for (let i = 0; i < MOVE_SAMPLES; i++) {
    const seq = i + 1;
    const ix = movePlayer({
      programId: PROGRAM_ID,
      arena,
      players,
      session: session.address,
      seat: SEAT,
      dir: dirs[i % 2]!,
      seq,
    });
    moveKeys = keyCount(session.address, [ix]);
    const t0 = now();
    await sendInstructions(er, session, [ix]);
    for (;;) {
      const p = decodePlayers((await readAccount(er, players))!);
      if (p.slots[SEAT]!.lastMoveSeq === seq) break;
      if (now() - t0 > 15_000) throw new Error(`move seq ${seq} never became visible`);
      await sleep(10);
    }
    latencies.push(now() - t0);
  }
  latencies.sort((a, b) => a - b);
  say(`  move tx: ${moveKeys} keys`);
  say(
    `  write-to-visible ms: min=${latencies[0]} p50=${pct(latencies, 50)} ` +
      `p95=${pct(latencies, 95)} max=${latencies[latencies.length - 1]} n=${latencies.length}`,
  );
  log.push({ step: 'move x' + MOVE_SAMPLES, keys: moveKeys, ms: pct(latencies, 50), note: 'p50' });

  // -- 7. start_match, and does the crank actually tick? ----------------------
  say('\n[7] start_match + crank observation');
  let crankTicks = -1;
  try {
    await send(er, treasury, [startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players })], 'start_match');
    const t0 = decodeArena((await readAccount(er, arena))!);
    say(`  phase=${t0.phase} tick=${t0.tick} crank_task_id=${t0.crankTaskId}`);
    if (t0.phase !== PHASE_FIGHTING) surprise(`phase after start_match is ${t0.phase}`);
    await sleep(10_000);
    const t1 = decodeArena((await readAccount(er, arena))!);
    crankTicks = t1.tick - t0.tick;
    say(`  after 10s: tick=${t1.tick} (+${crankTicks}); expected ~25 at 400ms`);
    if (crankTicks === 0) surprise('the boss_tick crank never fired — arena.tick did not advance in 10s');
  } catch (e) {
    surprise(`start_match failed: ${String(e).slice(0, 400)}`);
  }

  // -- 8. settle: commit + undelegate ----------------------------------------
  say('\n[8] settle (commit_and_undelegate)');
  const settleIx = withSigners(
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
    [treasury],
  );
  await send(er, session, [computeBudget(400_000), settleIx], 'settle', 40_000);

  say('  waiting for the accounts to land back on base...');
  const tSettle = now();
  let backOnBase = false;
  for (;;) {
    const owners = await Promise.all([ownerOf(base, arena), ownerOf(base, boss), ownerOf(base, players)]);
    if (owners.every((o) => o === PROGRAM_ID)) {
      backOnBase = true;
      break;
    }
    if (now() - tSettle > 90_000) {
      surprise(`undelegate did not complete in 90s; base owners = ${owners.join(', ')}`);
      break;
    }
    await sleep(1000);
  }
  if (backOnBase) {
    say(`  all three back on base after ${now() - tSettle}ms`);
    const a = decodeArena((await readAccount(base, arena))!);
    const p = decodePlayers((await readAccount(base, players))!);
    say(`  base arena: phase=${a.phase} tick=${a.tick} seat_occupied=0b${a.seatOccupied.toString(2)}`);
    say(`  base seat 0: pos=(${p.slots[SEAT]!.x},${p.slots[SEAT]!.y}) last_move_seq=${p.slots[SEAT]!.lastMoveSeq}`);
    if (a.phase !== PHASE_SETTLED) surprise(`base phase after settle is ${a.phase}, expected SETTLED`);
    if (p.slots[SEAT]!.lastMoveSeq !== MOVE_SAMPLES) {
      surprise(`ER moves did not survive the commit: last_move_seq=${p.slots[SEAT]!.lastMoveSeq}`);
    }
  }

  // -- 9. negative test: address lookup table on the ER -----------------------
  say('\n[9] negative: v0 transaction carrying an address lookup table');
  const fakeTable = decodeAddress.decode(new Uint8Array(randomBytes(32)));
  const altIx = movePlayer({
    programId: PROGRAM_ID, arena, players, session: session.address, seat: SEAT, dir: dirs[0]!, seq: 1,
  });
  for (const [label, rpc] of [['ER', er], ['base', base]] as const) {
    try {
      const { value: bh } = await rpc.getLatestBlockhash().send();
      const msg = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(session, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
        (m) => appendTransactionMessageInstructions([altIx], m),
        (m) => compressTransactionMessageUsingAddressLookupTables(m, { [fakeTable]: [arena] }),
      );
      const signed = await signTransactionMessageWithSigners(msg);
      await rpc
        .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: true })
        .send();
      surprise(`${label} ACCEPTED a transaction carrying an ALT (${getSignatureFromTransaction(signed)})`);
    } catch (e) {
      say(`  ${label} rejected the ALT transaction: ${String(e).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }

  // -- 10. negative test: 40 account keys on the ER ---------------------------
  say('\n[10] negative: 40-key transaction on the ER');
  const padded: Instruction = {
    ...altIx,
    accounts: [
      ...(altIx.accounts ?? []),
      ...Array.from({ length: 36 }, () => ({
        address: decodeAddress.decode(new Uint8Array(randomBytes(32))),
        role: AccountRole.READONLY,
      })),
    ],
  } as Instruction;
  const n = keyCount(session.address, [padded]);
  say(`  built a transaction with ${n} total account keys`);
  try {
    const sig = await sendInstructions(er, session, [padded]);
    surprise(`ER ACCEPTED a ${n}-key transaction (${sig})`);
    await confirmSignature(er, sig, { timeoutMs: 10_000 }).catch((e) =>
      say(`  ...but it did not confirm: ${String(e).slice(0, 200)}`),
    );
  } catch (e) {
    say(`  ER rejected the ${n}-key transaction: ${String(e).replace(/\s+/g, ' ').slice(0, 400)}`);
  }

  // -- summary --------------------------------------------------------------
  say('\n=== SUMMARY ===');
  say(`arena_id ${arenaId}`);
  for (const r of log) say(`  ${r.step.padEnd(28)} keys=${String(r.keys).padStart(2)} ${r.ms ?? ''}ms ${r.sig ?? ''}`);
  say(`write-to-visible p50=${pct(latencies, 50)}ms p95=${pct(latencies, 95)}ms n=${latencies.length}`);
  say(`delegate->first ER write: ${erWriteGap}ms`);
  say(`crank ticks in 10s: ${crankTicks}`);
  say(surprises.length === 0 ? 'no surprises' : `SURPRISES:\n  - ${surprises.join('\n  - ')}`);
}

/**
 * Pick an opposite direction pair whose two endpoints are both floor, using the client's
 * generated wall table — the same table the chain rejects a step against.
 */
function pickOpenAxis(x: number, y: number): [number, number] {
  const step = MAP_TILE;
  const pairs: [number, number, number, number][] = [
    [2, 6, step, 0], // E / W
    [4, 0, 0, step], // S / N
  ];
  for (const [a, b, dx, dy] of pairs) {
    if (!isWall(x + dx, y + dy) && !isWall(x, y)) return [a, b];
  }
  throw new Error(`no open axis from (${x},${y})`);
}

await main();
