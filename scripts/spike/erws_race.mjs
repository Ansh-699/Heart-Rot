/**
 * ERWS-RACE — paired router-vs-ER account-notification race, no live match needed.
 *
 * Subscribes both sockets to the SAME six accounts that are delegated to MAS1Dt9 and
 * written continuously by MagicBlock's own pricing oracle, so every notification is an
 * identical write observed on two channels and the submit half cancels exactly. Keys on
 * pubkey|slot|payload; trims 3 s off each end so subscribe/close skew is not counted as
 * a dropped notification.
 *
 * ORDER=ipv4first  -> router resolves to its Cloudflare IPv4 edge  (router ~6 ms FASTER)
 * ORDER=verbatim   -> router resolves to its Cloudflare IPv6 edge  (router ~34 ms SLOWER)
 * That one variable is the whole router-vs-ER latency story. See docs/perf/research-er-ws.md.
 *
 * Run: ORDER=ipv4first node scripts/spike/erws_race.mjs
 */
import dns from 'node:dns'; dns.setDefaultResultOrder(process.env.ORDER||'ipv4first');
const ACCS=['2aiRcZjSxx93vXXtXfyjapb84NnAsGvUF5i2GxvdXKXL','EVsTMtBM6enQEFfzhFqoFtfBrmRT9Wwy9uGkdeeesZta','mNndkqaesfEDSbkzy8ATWjVqLtW84HQk7rdea3aYubN','9AVDXjKi8qMDGQmHmF5RRinFeP3iLXh1rpp2Q8xUPMde','CHF6AUTdTvAAtHaAaQ2r7s8v6TtFqMLJDL39gJpwE3zJ','HPoPRi99ntLXurXepk6ijehFweBG81NwPFa8niP2JNVV'];
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p/100*s.length))];};
function open(url,label){return new Promise((res,rej)=>{
  const ws=new WebSocket(url); const sub=new Map(); const first=new Map(); let frames=0,dup=0;
  ws.onopen=()=>{ACCS.forEach((a,i)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'accountSubscribe',params:[a,{encoding:'base64'}]})));
    setTimeout(()=>res({ws,first,label,st:()=>({frames,dup,subs:sub.size})}),1500);};
  ws.onerror=()=>rej(new Error('open '+label));
  ws.onmessage=e=>{const m=JSON.parse(e.data);
    if(m.id&&typeof m.result==='number'){sub.set(m.result,ACCS[m.id-1]);return;}
    if(m.method!=='accountNotification')return; frames++;
    const k=(sub.get(m.params.subscription)||'?')+'|'+m.params.result.context.slot+'|'+m.params.result.value.data[0];
    if(first.has(k)){dup++;return;} first.set(k,Number(process.hrtime.bigint())/1e6);};
});}
const A=await open('wss://devnet-as.magicblock.app/','ER');
const B=await open('wss://devnet-router.magicblock.app/','ROUTER');
await new Promise(r=>setTimeout(r,36000)); A.ws.close(); B.ws.close();
const ts=[...A.first.values(),...B.first.values()]; const lo=Math.min(...ts)+3000, hi=Math.max(...ts)-3000;
for(const m of [A.first,B.first]) for(const [k,t] of [...m]) if(t<lo||t>hi) m.delete(k);
console.log('order='+(process.env.ORDER||'ipv4first'));
console.log(' ER    uniq='+A.first.size, JSON.stringify(A.st()));
console.log(' ROUTER uniq='+B.first.size, JSON.stringify(B.st()));
const d=[]; for(const [k,t] of A.first) if(B.first.has(k)) d.push(B.first.get(k)-t);
if(d.length>10) console.log(' paired n='+d.length+'  ROUTER-ER  p50='+pct(d,50).toFixed(1)+'  p10='+pct(d,10).toFixed(1)+'  p90='+pct(d,90).toFixed(1)+'  ER-first%='+(100*d.filter(x=>x>0).length/d.length).toFixed(0));
else console.log(" paired n="+d.length);
let onlyA=0,onlyB=0; for(const k of A.first.keys()) if(!B.first.has(k)) onlyA++;
for(const k of B.first.keys()) if(!A.first.has(k)) onlyB++;
console.log(' ER-only='+onlyA+'  ROUTER-only='+onlyB);
