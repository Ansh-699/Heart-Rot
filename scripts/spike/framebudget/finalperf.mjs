// THROWAWAY. (a) renders g3 with the rim term removed, so the rim band can be isolated.
// (b) measures the frame cost of the whole proposal against the shipped build.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';
const DIR=path.resolve('dist'); const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8767,r));
const TONE='grayscale(0.7) sepia(0.6) hue-rotate(195deg) saturate(0.5) brightness(0.55) contrast(1.6)';
const RIM='drop-shadow(-3px -3px 0 rgb(159 232 255 / 0.30))';
const ORB=`.hr-boss-vent{fill:#04121a!important;fill-opacity:1!important;stroke:#9fe8ff!important;
 stroke-opacity:0.75!important;stroke-width:calc(var(--core-r)*0.15)!important;opacity:1!important;
 filter:drop-shadow(0 0 16px rgb(111 227 255/0.35))!important}`;
const PROP=`.hr-boss-grade{filter:${TONE} ${RIM}!important}`+ORB;
const NORIM=`.hr-boss-grade{filter:${TONE}!important}`+ORB;
const inject=async(pg,spill)=>pg.evaluate((sp)=>{
  const v=document.querySelector('.hr-boss-vent'); if(!v) return null;
  const R=+v.getAttribute('r'),cx=+v.getAttribute('cx'),cy=+v.getAttribute('cy');
  v.style.setProperty('--core-r',R);
  if(sp){const ns='http://www.w3.org/2000/svg';const d=document.createElementNS(ns,'defs');
    d.innerHTML=`<radialGradient id="orbspill" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${R*2.6}">
      <stop offset="0" stop-color="#9fe8ff" stop-opacity="0.20"/>
      <stop offset="0.4" stop-color="#6fe3ff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#6fe3ff" stop-opacity="0"/></radialGradient>`;
    v.parentNode.insertBefore(d,v);
    const c=document.createElementNS(ns,'circle');
    c.setAttribute('cx',cx);c.setAttribute('cy',cy);c.setAttribute('r',R*2.6);
    c.setAttribute('fill','url(#orbspill)');v.parentNode.insertBefore(c,v);}
  return R;},spill);

const b=await chromium.launch({channel:'chrome',headless:false, args: [...QUIET_ARGS] });
// (a) the rim-off companion shot
{ const pg=await b.newPage({viewport:{width:1024,height:1024}});
  await pg.goto('http://127.0.0.1:8767/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  await pg.evaluate(o=>window.__run(o),{layer:'full',knights:0,knightArt:false,bullets:0,frames:60,feedHz:0.0001});
  await pg.waitForTimeout(300); await inject(pg,1); await pg.addStyleTag({content:NORIM});
  await pg.waitForTimeout(250); await pg.screenshot({path:'fix2/g3norim.png'}); await pg.close(); }
// (b) perf: shipped vs proposal, boss layer alone and full arena, 6x throttle
const out=[];
for(let rep=0;rep<8;rep++){
 const names=rep%2?['prop','shipped']:['shipped','prop'];
 for(const L of [{layer:'boss',knights:0,bullets:0},{layer:'full',knights:20,bullets:32}])
 for(const n of names){
  const pg=await b.newPage({viewport:{width:1024,height:1024}});
  const cdp=await pg.context().newCDPSession(pg);
  await pg.goto('http://127.0.0.1:8767/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  if(n==='prop'){ await inject(pg,1); await pg.addStyleTag({content:PROP}); }
  await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
  const r=await pg.evaluate(o=>window.__run(o),{...L,knightArt:false,frames:400,feedHz:20});
  const row={variant:n,layer:L.layer,rep,p50:r.commitP50,p95:r.commitP95,max:r.commitMax,busy:r.busyPct,over:r.overPct};
  out.push(row); console.log(JSON.stringify(row)); await pg.close();
 }}
fs.writeFileSync('finalperf.json',JSON.stringify(out,null,1));
await b.close(); srv.close();
