import { matchPdas, leaderboardPda, decodeLeaderboard, decodeArena, decodePlayers } from '../../packages/client/src/index';
import { createSolanaRpc } from '@solana/kit';

const BASE = 'https://rpc.magicblock.app/devnet';
const ROUTER = 'https://devnet-router.magicblock.app/';
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as any;

async function acct(url: string, a: any) {
  const r = await createSolanaRpc(url).getAccountInfo(a, { encoding: 'base64' }).send();
  return r.value ? Uint8Array.from(Buffer.from((r.value.data as any)[0], 'base64')) : null;
}
async function deleg(a: string) {
  const r = await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [a] }) });
  return (await r.json() as any).result;
}

const lbd = await acct(BASE, await leaderboardPda(PROGRAM));
const head = lbd ? decodeLeaderboard(lbd).lastArenaId : 1n;
for (let i = 0; i < 8; i++) {
  const id = head + BigInt(i);
  const p = await matchPdas(PROGRAM, id);
  const d = await deleg(p.arena);
  const fq = d?.isDelegated ? d.fqdn : null;
  const src = fq ?? BASE;
  const ab = await acct(src, p.arena);
  if (!ab) continue;
  const a = decodeArena(ab);
  if (a.phase !== 0 && a.phase !== 1) continue;
  const pb = await acct(src, p.players);
  console.log(`\narena ${id} phase=${a.phase} incarn=${a.incarnation} read=${fq ? 'ER' : 'base'}`);
  console.log(`  arena.seatOccupied bitmask = ${a.seatOccupied}`);
  if (!pb) { console.log('  players ABSENT'); continue; }
  const slots = decodePlayers(pb).slots;
  console.log('  slot0 keys:', Object.keys(slots[0] ?? {}).join(','));
  const occ = slots.map((s: any, i: number) => (s.occupied ? i : -1)).filter((i: number) => i >= 0);
  console.log('  occupied seats =', JSON.stringify(occ));
  for (const i of occ) {
    const s: any = slots[i];
    console.log(`    seat ${i}: hp=${s.hp} zone=${s.zone} x=${s.x} y=${s.y} skin=${s.skinId}`);
  }
}
