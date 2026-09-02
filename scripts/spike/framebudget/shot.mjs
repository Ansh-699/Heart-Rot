import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';
const DIR = path.resolve('dist');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const srv = http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8761,r));
const b = await chromium.launch({ channel:'chrome', headless:false, args: [...QUIET_ARGS] });
const pg = await b.newPage({ viewport:{width:1024,height:1024} });
await pg.goto('http://127.0.0.1:8761/',{waitUntil:'load'});
await pg.waitForFunction('window.__ready === true');
pg.evaluate(o=>window.__run(o), { layer:'full', knights:20, knightArt:true, bullets:0, frames:120, feedHz:20 });
await pg.waitForTimeout(2500);
await pg.screenshot({ path: process.env.OUT || 'shot.png' });
await b.close(); srv.close();
