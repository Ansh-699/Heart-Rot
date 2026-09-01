import { matchPdas, leaderboardPda, decodeLeaderboard, connectMatch } from '../../packages/client/src/index';
import { subscribeMatch } from '../../app/src/net/subscribe';
import { createSolanaRpc } from '@solana/kit';

const P='JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as any;
const VID='MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57' as any;
const rpc=createSolanaRpc('https://rpc.magicblock.app/devnet');
const lb=await rpc.getAccountInfo(await leaderboardPda(P),{encoding:'base64'}).send();
const head=decodeLeaderboard(Uint8Array.from(Buffer.from((lb.value as any).data[0],'base64'))).lastArenaId;
const pdas=await matchPdas(P, head+3n);

console.log('connectMatch…');
const { er, erFqdn } = await connectMatch({
  baseUrl:'https://rpc.magicblock.app/devnet',
  routerUrl:'https://devnet-router.magicblock.app/',
  accounts:[pdas.arena,pdas.boss,pdas.players],
  validatorIdentity:VID, ownerProgram:P,
});
console.log('  resolved erFqdn =', erFqdn);

const sub = subscribeMatch({
  rpc: er, arena:pdas.arena, boss:pdas.boss, players:pdas.players,
  onArena:(a:any)=>console.log('  onArena   phase',a.phase,'tick',a.tick,'seatMask',a.seatOccupied),
  onBoss:(b:any)=>console.log('  onBoss    core',b.coreHp),
  onPlayers:(p:any)=>{
    const occ=p.slots.map((s:any,i:number)=>s.occupied?i:-1).filter((i:number)=>i>=0);
    console.log('  onPlayers occupied =', JSON.stringify(occ));
  },
  onHealth:(h:any)=>console.log('  onHealth ', h),
});
setTimeout(()=>{ sub.close?.(); console.log('done'); process.exit(0); }, 9000);
