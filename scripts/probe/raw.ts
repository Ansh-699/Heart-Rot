import { matchPdas, leaderboardPda, decodeLeaderboard } from '../../packages/client/src/index';
import { createSolanaRpc } from '@solana/kit';
const rpc=createSolanaRpc('https://rpc.magicblock.app/devnet');
const P='JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as any;
const lb=await rpc.getAccountInfo(await leaderboardPda(P),{encoding:'base64'}).send();
const head=decodeLeaderboard(Uint8Array.from(Buffer.from((lb.value as any).data[0],'base64'))).lastArenaId;
const p=await matchPdas(P, head+3n);
const r=await fetch('https://devnet-router.magicblock.app/',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getDelegationStatus',params:[p.arena]})});
console.log(JSON.stringify((await r.json() as any).result, null, 1));
