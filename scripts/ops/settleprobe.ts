/**
 * Replay the Worker's own `matchSettle` against settled WIN arenas, as the seat that
 * fought each one (identity read off the roster, fed to the auth stub through
 * `PROBE_IDENTITY_HEX`). Prints every step and any throw in full.
 *
 *   ONLY_ARENAS=<id,id,...> REPO=$PWD node <bundle>     # those arenas
 *   REPO=$PWD node <bundle>                              # the newest won arena in range
 *
 * Bundle with the recipe in scripts/ops/workerprobe.sh (routes.probe.ts + auth.probe.ts).
 * This is what found the settle 500: the route replayed a minute after the kill succeeds.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  matchPdas, leaderboardPda, decodeLeaderboard, decodeArena, decodePlayers, getDelegationStatus, createRpc,
} from '../../packages/client/src/index';
import { createSolanaRpc, getBase58Decoder } from '@solana/kit';
import { matchSettle } from './routes.probe';

const BASE = 'https://rpc.magicblock.app/devnet';
const ROUTER = 'https://devnet-router.magicblock.app/';
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as never;
const base = createSolanaRpc(BASE);
async function acct(rpc: { getAccountInfo: typeof base.getAccountInfo }, a: unknown): Promise<Uint8Array | null> {
  const r = await rpc.getAccountInfo(a as never, { encoding: 'base64' }).send();
  return r.value ? Uint8Array.from(Buffer.from((r.value.data as string[])[0], 'base64')) : null;
}
const t0 = performance.now();
const at = (): string => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`;

const lbd = await acct(base, await leaderboardPda(PROGRAM));
const lb = lbd ? decodeLeaderboard(lbd) : null;
console.log(`${at()}  head ${lb?.lastArenaId} lastInc ${lb?.lastIncarnation} written ${lb?.totalWritten}`);
const head = lb?.lastArenaId ?? 1n;
const only = process.env.ONLY_ARENAS ? process.env.ONLY_ARENAS.split(',').map((x) => BigInt(x)) : null;
const first = only ? only.reduce((a, b) => (a < b ? a : b)) : head;
const picks: { id: bigint; identity: Uint8Array }[] = [];
for (let step = 0; step < 60; step++) {
  const id = first + BigInt(step);
  if (only && !only.includes(id)) continue;
  const pdas = await matchPdas(PROGRAM, id);
  const st = await getDelegationStatus(pdas.arena, ROUTER);
  const rpc = st.isDelegated && st.fqdn ? createRpc(st.fqdn) : base;
  const d = await acct(rpc as never, pdas.arena);
  if (!d) continue;
  let a;
  try { a = decodeArena(d); } catch { console.log(`${at()}  ${id} undecodable`); continue; }
  const pd = await acct(rpc as never, pdas.players);
  const seated = pd ? decodePlayers(pd).slots.filter((s) => s.occupied) : [];
  console.log(`${at()}  ${id} deleg=${st.isDelegated} phase=${a.phase} outcome=${a.outcome} inc=${a.incarnation} tick=${a.tick} seated=${seated.map((s) => `${s.seat}:dmg${s.damageDealt}`).join(',') || '-'}`);
  if (a.phase === 3 && a.outcome === 1 && seated.length > 0) picks.push({ id, identity: seated[0]!.identity });
}
const wanted = only ? picks : picks.slice(-1);
if (wanted.length === 0) { console.log('nothing to replay'); process.exit(1); }

const devVars = Object.fromEntries(
  readFileSync(`${process.env.REPO}/worker/.dev.vars`, 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
);
const treasuryJson = JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[];
const env = {
  ...devVars,
  TREASURY_SECRET_KEY: getBase58Decoder().decode(Uint8Array.from(treasuryJson)),
  PROGRAM_ID: 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5',
  ROUTER_ENDPOINT: ROUTER,
  VALIDATOR_IDENTITY: 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57',
  BASE_RPC_URL: devVars.BASE_RPC_URL ?? BASE,
} as never;
const background: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void background.push(p.catch((e) => console.error('background:', e))) };

for (const pick of wanted) {
  console.log(`${at()}  replaying matchSettle on ${pick.id} as identity ${Buffer.from(pick.identity).toString('hex').slice(0, 16)}…`);
  process.env.PROBE_IDENTITY_HEX = Buffer.from(pick.identity).toString('hex');
  try {
    const res = await (matchSettle as unknown as (e: unknown, b: unknown, c: unknown) => Promise<Response>)(env, { privyToken: 'probe', arenaId: pick.id.toString() }, ctx);
    console.log(`${at()}  matchSettle ${pick.id} -> ${res.status} ${(await res.text()).slice(0, 160)}`);
  } catch (error) {
    console.log(`${at()}  matchSettle ${pick.id} THREW: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) console.log('cause:', cause instanceof Error ? `${cause.name}: ${cause.message}` : JSON.stringify(cause).slice(0, 400));
  }
}
await Promise.allSettled(background);
