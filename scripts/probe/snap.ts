import { matchPdas, leaderboardPda, decodeLeaderboard, decodeArena, decodePlayers, decodeBoss } from '../../packages/client/src/index';
import { createSolanaRpc } from '@solana/kit';
const BASE='https://rpc.magicblock.app/devnet', ROUTER='https://devnet-router.magicblock.app/';
const PROGRAM='JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as any;
const rpcB=createSolanaRpc(BASE);
async function deleg(a:string){const r=await fetch(ROUTER,{method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getDelegationStatus',params:[a]})});return (await r.json() as any).result;}
const lb=await rpcB.getAccountInfo(await leaderboardPda(PROGRAM),{encoding:'base64'}).send();
const head=lb.value?decodeLeaderboard(Uint8Array.from(Buffer.from((lb.value.data as any)[0],'base64'))).lastArenaId:1n;
const id=head+3n; // the arena the fix opened
const p=await matchPdas(PROGRAM,id);
const d=await deleg(p.arena);
console.log('arena', id.toString(), 'delegated', !!d?.isDelegated, 'fqdn', d?.fqdn, 'authority', d?.authority);
const er=createSolanaRpc(d.fqdn);
// exactly what subscribe.ts snapshot() does
const { value } = await er.getMultipleAccounts([p.arena,p.boss,p.players],{encoding:'base64'}).send();
const names=['arena','boss','players'];
value.forEach((v:any,i:number)=>{
  if(!v){console.log(`  ${names[i]}: NULL from ER`);return;}
  const b=Uint8Array.from(Buffer.from(v.data[0],'base64'));
  if(i===0){const a=decodeArena(b);console.log(`  arena: phase=${a.phase} incarn=${a.incarnation} seatMask=${a.seatOccupied} tick=${a.tick}`);}
  if(i===1){const bo=decodeBoss(b);console.log(`  boss: core=${(bo as any).coreHp} vent=${(bo as any).ventOpen}`);}
  if(i===2){const s=decodePlayers(b).slots;const occ=s.map((x:any,j:number)=>x.occupied?j:-1).filter((j:number)=>j>=0);
    console.log(`  players: occupied=${JSON.stringify(occ)}`);
    for(const j of occ){const x:any=s[j];console.log(`    seat ${j} hp=${x.hp} x=${x.x} y=${x.y} zone=${x.zone}`);}}
});
