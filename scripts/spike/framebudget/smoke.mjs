import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8742,r));
const b=await chromium.launch({channel:'chrome',headless:false});
const pg=await b.newPage({viewport:{width:1024,height:1024}});
pg.on('console',m=>{ if(m.type()==='error') console.log('CONSOLE ERR:',m.text()); });
pg.on('pageerror',e=>console.log('PAGE ERROR:',e.message));
await pg.goto('http://127.0.0.1:8742/',{waitUntil:'load'});
await pg.waitForFunction('window.__ready === true');
const r = await pg.evaluate(o=>window.__run(o),{knights:20,frames:200,knightArt:true,feedHz:714});
console.log(JSON.stringify(r,null,1));
await pg.screenshot({path:'smoke.png'});
// non-blank check
const px = await pg.evaluate(()=>({svg:document.querySelectorAll('svg *').length, paths:document.querySelectorAll('path').length, uses:document.querySelectorAll('use').length, gs:document.querySelectorAll('g').length}));
console.log(JSON.stringify(px));
await b.close(); srv.close();
