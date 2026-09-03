import { leaderboardPda, decodeLeaderboard, matchPdas, decodeArena, decodePlayers, getDelegationStatus, createRpc } from '../../packages/client/src/index';
import { createSolanaRpc } from '@solana/kit';
const base = createSolanaRpc('https://rpc.magicblock.app/devnet');
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as never;
async function acct(rpc: any, a: unknown): Promise<Uint8Array | null> { const r = await rpc.getAccountInfo(a as never, { encoding: 'base64' }).send(); return r.value ? Uint8Array.from(Buffer.from((r.value.data as string[])[0], 'base64')) : null; }
const lb = decodeLeaderboard((await acct(base, await leaderboardPda(PROGRAM)))!);
console.log('head', lb.lastArenaId.toString(), 'lastInc', lb.lastIncarnation, 'next', lb.next, 'written', lb.totalWritten);
const rows = lb.entries.slice(0, Math.min(lb.totalWritten, lb.entries.length));
for (const [i, e] of rows.entries()) console.log(` row ${i}: arena ${e.arenaId} inc ${e.incarnation} dmg ${e.damageDealt} outcome ${e.outcome}`);
// the user's arena: beyond the 40-step window
const head = lb.lastArenaId;
for (let step = 40; step < 60; step++) {
  const id = head + BigInt(step); const pdas = await matchPdas(PROGRAM, id);
  const st = await getDelegationStatus(pdas.arena, 'https://devnet-router.magicblock.app/');
  const rpc = st.isDelegated ? createRpc(st.fqdn!) : base;
  const d = await acct(rpc, pdas.arena); if (!d) continue;
  let a; try { a = decodeArena(d); } catch { console.log(id.toString(), 'undecodable (husk?)'); continue; }
  const pd = await acct(rpc, pdas.players); let seated = '?';
  try { seated = pd ? decodePlayers(pd).slots.filter((s) => s.occupied).map((s) => `${s.seat}:dmg${s.damageDealt}`).join(',') : 'none'; } catch { seated = 'players undecodable'; }
  console.log(`${id} deleg=${st.isDelegated} phase=${a.phase} outcome=${a.outcome} inc=${a.incarnation} tick=${a.tick} seated=${seated}`);
}
