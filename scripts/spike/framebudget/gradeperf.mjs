// THROWAWAY. Is the boss grade cheaper on the ancestor or on the eleven part groups?
// Fresh browser per case (drive.mjs's own note: reusing a page pins every case after the
// first heavy one). Each variant is a <style> injected into the live page — no product
// file is modified.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const DIR = path.resolve('dist');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const srv = http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8763,r));

const G='grayscale(0.7) sepia(0.6) hue-rotate(185deg) saturate(1.6) brightness(0.32) drop-shadow(-2px -2px 0 rgb(159 232 255 / 0.25))';
const CSS={
  anc:      '',
  ancwc:    '.hr-boss-part{will-change:transform}',
  part:     `.hr-boss-grade{filter:none!important}.hr-boss-part{filter:${G}}`,
  partwc:   `.hr-boss-grade{filter:none!important}.hr-boss-part{filter:${G};will-change:transform}`,
  none:     '.hr-boss-grade{filter:none!important}',
};
const LAYERS=JSON.parse(process.env.LAYERS||'[{"layer":"boss","knights":0,"bullets":0},{"layer":"full","knights":20,"bullets":32}]');
const CPUS=JSON.parse(process.env.CPUS||'[1,6]');
const REPS=+(process.env.REPS||3);
const out=[];
const b=await chromium.launch({channel:'chrome',headless:false});
for(let rep=0;rep<REPS;rep++){
 const names=Object.keys(CSS); if(rep%2) names.reverse();
 for(const L of LAYERS) for(const cpu of CPUS) for(const name of names){
  const pg=await b.newPage({viewport:{width:1024,height:1024}});
  const cdp=await pg.context().newCDPSession(pg);
  await pg.goto('http://127.0.0.1:8763/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  if(CSS[name]) await pg.addStyleTag({content:CSS[name]});
  if(cpu>1) await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
  const r=await pg.evaluate(o=>window.__run(o),{...L,knightArt:false,frames:400,feedHz:20});
  const row={variant:name,layer:L.layer,knights:L.knights,cpu,rep,
    commitP50:r.commitP50,commitP95:r.commitP95,commitMax:r.commitMax,busyPct:r.busyPct,fps:r.fps,overPct:r.overPct};
  out.push(row); console.log(JSON.stringify(row));
  await pg.close();
 }
}
await b.close(); srv.close();
fs.writeFileSync(process.env.OUT||'gradeperf.json',JSON.stringify(out,null,1));
