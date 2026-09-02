// Cold first paint: navigation to first-contentful-paint, with the whole 869 KB bundle,
// the 332 KB temple and the 121 KB boss rig parsed for the first time. The `firstPaintMs`
// in the matrix is a RE-render (the module mounts before __run), so it is not this number.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/package.json')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUIET_ARGS } from '../launch.mjs';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist2');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index2.html':q.url.split('?')[0]);
 if(!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8803,r));
for (const cpu of [1,6]) for (let i=0;i<3;i++) {
  const b=await chromium.launch({channel:'chrome',headless:false, args: [...QUIET_ARGS] });
  const pg=await b.newPage({viewport:{width:1920,height:1080}});
  const cdp=await pg.context().newCDPSession(pg);
  if(cpu>1) await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
  await pg.goto('http://127.0.0.1:8803/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  const t=await pg.evaluate(()=>{
    const n=performance.getEntriesByType('navigation')[0];
    const p=Object.fromEntries(performance.getEntriesByType('paint').map(e=>[e.name,+e.startTime.toFixed(1)]));
    return {domInteractive:+n.domInteractive.toFixed(1),loadEnd:+n.loadEventEnd.toFixed(1),...p};
  });
  console.log(JSON.stringify({cpu,...t}));
  await b.close();
}
srv.close();
