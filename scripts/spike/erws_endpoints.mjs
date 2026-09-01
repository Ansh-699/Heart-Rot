/**
 * ERWS-ENDPOINTS — TCP-connect and getSlot round trip to all four devnet ER validators.
 *
 * The submit hop is one round trip and write-to-visible is the same round trip, so the
 * cheapest latency lever in the whole system is picking the validator with the shortest
 * RTT. From India devnet-tee measures ~32 ms closer than devnet-as on both metrics.
 *
 * Run: node scripts/spike/erws_endpoints.mjs
 */
import dns from 'node:dns'; dns.setDefaultResultOrder('ipv4first');
import dnsp from 'node:dns/promises'; import net from 'node:net';
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p/100*s.length))];};
const hosts=['devnet-as.magicblock.app','devnet-tee.magicblock.app','devnet-eu.magicblock.app','devnet-us.magicblock.app'];
for(const h of hosts){
  const ips=(await dnsp.resolve4(h).catch(()=>[]));
  const t=[];
  for(let i=0;i<25;i++){const t0=process.hrtime.bigint();
    await new Promise(r=>{const s=net.connect({host:ips[0],port:443},()=>{t.push(Number(process.hrtime.bigint()-t0)/1e6);s.destroy();r();});s.on('error',()=>{s.destroy();r();});s.setTimeout(3000,()=>{s.destroy();r();});});}
  // app RTT: getSlot on a warm keep-alive connection
  const rtts=[];
  for(let i=0;i<20;i++){const t0=process.hrtime.bigint();
    try{ await fetch('https://'+h+'/',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:i,method:'getSlot'})}).then(r=>r.text());
      rtts.push(Number(process.hrtime.bigint()-t0)/1e6);}catch{}}
  rtts.shift();
  console.log(h.padEnd(30), 'tcp n='+t.length+' p50='+(t.length?pct(t,50).toFixed(1):'-')+' min='+(t.length?Math.min(...t).toFixed(1):'-'),
    '| getSlot n='+rtts.length+' p50='+(rtts.length?pct(rtts,50).toFixed(1):'-')+' min='+(rtts.length?Math.min(...rtts).toFixed(1):'-'));
}
