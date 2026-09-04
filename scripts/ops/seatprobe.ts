// Where are the seated raiders right now? Every live (delegated) arena's roster: seat, zone, x, y, hp.
import { matchPdas, leaderboardPda, decodeLeaderboard, decodeArena, decodePlayers, getDelegationStatus, createRpc } from '../../packages/client/src/index';
import { LOBBY_SPAWN_MIN_X, LOBBY_SPAWN_MAX_X, LOBBY_SPAWN_Y, LOBBY_TOP, LOBBY_BOT, GATES, PIT_TOP, PIT_BOT } from '../../packages/client/src/map';
import { createSolanaRpc } from '@solana/kit';
const base = createSolanaRpc('https://rpc.magicblock.app/devnet');
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as never;
async function acct(rpc: any, a: unknown): Promise<Uint8Array | null> { const r = await rpc.getAccountInfo(a as never, { encoding: 'base64' }).send(); return r.value ? Uint8Array.from(Buffer.from((r.value.data as string[])[0], 'base64')) : null; }
console.log('map: LOBBY_SPAWN x', LOBBY_SPAWN_MIN_X, '..', LOBBY_SPAWN_MAX_X, 'y', LOBBY_SPAWN_Y, ' LOBBY_TOP/BOT', LOBBY_TOP, LOBBY_BOT, ' PIT', PIT_TOP, PIT_BOT, ' GATES', JSON.stringify(GATES));
const lb = decodeLeaderboard((await acct(base, await leaderboardPda(PROGRAM)))!);
for (let step = 0; step < 50; step++) {
  const id = lb.lastArenaId + BigInt(step); const pdas = await matchPdas(PROGRAM, id);
  const st = await getDelegationStatus(pdas.arena, 'https://devnet-router.magicblock.app/');
  if (!st.isDelegated || !st.fqdn) continue;
  const rpc = createRpc(st.fqdn);
  const d = await acct(rpc, pdas.arena); const pd = await acct(rpc, pdas.players); if (!d || !pd) { console.log(id.toString(), 'delegated but unreadable'); continue; }
  const a = decodeArena(d); const roster = decodePlayers(pd);
  const seated = roster.slots.filter((s) => s.occupied).map((s) => `seat${s.seat} zone${s.zone} (${s.x},${s.y}) hp${s.hp}/${s.hpMax} skin${s.skinId} class${s.classAim >> 7} moveSeq${s.lastMoveSeq}`);
  console.log(`${id} phase=${a.phase} tick=${a.tick} difficulty=${a.difficulty} inc=${a.incarnation} seatOccupied=0b${a.seatOccupied.toString(2)} seated=[${seated.join(' | ') || '-'}]`);
}
