/**
 * `sessionInit`, minus Privy — the Worker's join path replayed against the live chain
 * with a throwaway identity, every step timed, every throw printed in full. Then the
 * seat is released again with `leave_seat`, so the probe leaves no footprint.
 *
 *   pnpm exec tsx scripts/ops/joinprobe.ts
 *
 * Exists because the Worker's 500 carries only a correlation ref and the stored logs are
 * behind an API token this machine does not hold. The chain is not behind anything.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  matchPdas,
  leaderboardPda,
  decodeLeaderboard,
  decodeArena,
  decodePlayers,
  freeSeats,
  claimSeat,
  leaveSeat,
  sendInstructions,
  confirmSignature,
  createRpc,
  getDelegationStatus,
  connectMatch,
} from '../../packages/client/src/index';
import { createSolanaRpc, createKeyPairSignerFromBytes, address, generateKeyPairSigner } from '@solana/kit';

const BASE = 'https://rpc.magicblock.app/devnet';
const ROUTER = 'https://devnet-router.magicblock.app/';
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as never;
const VALIDATOR = address('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const PHASE_LOBBY = 0;
const ER_CONFIRM_MS = 15_000;

const t0 = performance.now();
const at = (): string => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const log = (m: string): void => console.log(`${at()}  ${m}`);

const base = createSolanaRpc(BASE);
async function acct(rpc: { getAccountInfo: typeof base.getAccountInfo }, a: unknown): Promise<Uint8Array | null> {
  const r = await rpc.getAccountInfo(a as never, { encoding: 'base64' }).send();
  return r.value ? Uint8Array.from(Buffer.from((r.value.data as string[])[0], 'base64')) : null;
}

const treasury = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[]),
);
const session = await generateKeyPairSigner();
const identity = crypto.getRandomValues(new Uint8Array(32));

try {
  // ---- openArena ---------------------------------------------------------
  const lbd = await acct(base, await leaderboardPda(PROGRAM));
  const head = lbd ? decodeLeaderboard(lbd).lastArenaId : 1n;
  log(`head ${head}`);
  let open: { arenaId: bigint; incarnation: number } | null = null;
  for (let step = 0; step < 76 && open === null; step++) {
    const arenaId = head + BigInt(step);
    const pdas = await matchPdas(PROGRAM, arenaId);
    const status = await getDelegationStatus(pdas.arena, ROUTER);
    const rpc = status.isDelegated ? createRpc(status.fqdn) : base;
    const data = await acct(rpc as never, pdas.arena);
    let phase = 'ABSENT';
    let inc = 0;
    if (data) {
      try {
        const a = decodeArena(data);
        phase = String(a.phase);
        inc = a.incarnation;
      } catch (e) {
        phase = `UNDECODABLE(${(e as Error).message})`;
      }
    }
    log(`scan ${step} ${arenaId} delegated=${status.isDelegated} phase=${phase}`);
    if (phase === String(PHASE_LOBBY)) open = { arenaId, incarnation: inc };
  }
  if (!open) throw new Error('no_open_arena');

  // ---- ensureArena -------------------------------------------------------
  const pdas = await matchPdas(PROGRAM, open.arenaId);
  const onBase = await acct(base, pdas.arena);
  log(`ensure: base copy ${onBase ? `${onBase.length} B` : 'ABSENT'}`);
  const status = await getDelegationStatus(pdas.arena, ROUTER);
  log(`ensure: delegated=${status.isDelegated} fqdn=${status.fqdn ?? '-'}`);
  const conn = await connectMatch({
    baseUrl: BASE,
    routerUrl: ROUTER,
    accounts: [pdas.arena, pdas.boss, pdas.players],
    validatorIdentity: VALIDATOR,
    ownerProgram: PROGRAM,
  });
  log(`ensure: connected er=${conn.erFqdn}`);
  const er = conn.er;

  // ---- claim -------------------------------------------------------------
  const [arenaBytes, playersBytes] = await Promise.all([acct(er as never, pdas.arena), acct(er as never, pdas.players)]);
  if (!arenaBytes || !playersBytes) throw new Error('match accounts vanished mid-join');
  const arena = decodeArena(arenaBytes);
  const roster = decodePlayers(playersBytes);
  log(`claim: phase=${arena.phase} occupied=0b${arena.seatOccupied.toString(2)} roster=${roster.slots.filter((s) => s.occupied).map((s) => s.seat).join(',') || '-'}`);
  const free = freeSeats(arena.seatOccupied).filter((seat) => !roster.slots[seat]?.occupied);
  const seat = free[0];
  if (seat === undefined) throw new Error('arena_full');
  const ix = claimSeat({
    programId: PROGRAM,
    arena: pdas.arena,
    players: pdas.players,
    treasury: treasury.address,
    seat,
    skinId: 0,
    class: 1,
    sessionPubkey: session.address,
    identity,
  });
  const sig = await sendInstructions(er, treasury, [ix]);
  log(`claim: sent seat ${seat} ${sig}`);
  await confirmSignature(er, sig, { timeoutMs: ER_CONFIRM_MS });
  log('claim: confirmed');
  const settledBytes = await acct(er as never, pdas.players);
  if (!settledBytes) throw new Error('roster vanished after claim');
  const claimed = decodePlayers(settledBytes).slots.find(
    (slot) => slot.occupied && slot.identity.every((byte, i) => byte === identity[i]),
  );
  log(`claim: on roster = ${claimed ? `seat ${claimed.seat}` : 'NO'}`);
  if (!claimed) throw new Error('seat not on the roster after a confirmed claim');

  // ---- release -----------------------------------------------------------
  const rel = leaveSeat({
    programId: PROGRAM,
    arena: pdas.arena,
    players: pdas.players,
    treasury: treasury.address,
    seat: claimed.seat,
    identity,
  });
  const rsig = await sendInstructions(er, treasury, [rel]);
  await confirmSignature(er, rsig, { timeoutMs: ER_CONFIRM_MS });
  log(`release: seat ${claimed.seat} freed`);
} catch (error) {
  log(`THREW: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) console.log('cause:', cause);
  if (error instanceof Error && error.stack) console.log(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
}
