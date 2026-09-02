// THROWAWAY. Screenshots the shipped boss under candidate grade chains injected as CSS.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';
const DIR=path.resolve('dist'); const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8764,r));
const C=JSON.parse(fs.readFileSync(process.env.CAND||'cand.json','utf8'));
const OUT=process.env.OUTDIR||'grade'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch({channel:'chrome',headless:false, args: [...QUIET_ARGS] });
for(const [name,css] of Object.entries(C)){
  const pg=await b.newPage({viewport:{width:1024,height:1024}});
  await pg.goto('http://127.0.0.1:8764/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  if(css) await pg.addStyleTag({content:css});
  await pg.evaluate(o=>window.__run(o),{layer:'full',knights:0,knightArt:false,bullets:0,frames:60,feedHz:0.0001});
  await pg.waitForTimeout(350);
  await pg.screenshot({path:path.join(OUT,name+'.png')});
  console.log('shot',name);
  await pg.close();
}
await b.close(); srv.close();
