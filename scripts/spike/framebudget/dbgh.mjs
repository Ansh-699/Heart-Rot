import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist2');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css' };
const srv = http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index2.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8749,r));
const b = await chromium.launch({ channel:'chrome', headless:false });
const pg = await b.newPage({ viewport:{width:1920,height:1080} });
pg.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0,300)));
pg.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0,500)));
await pg.goto('http://127.0.0.1:8749/', { waitUntil:'load' });
await pg.waitForFunction('window.__ready === true');
const opts = JSON.parse(process.argv[2] || '{}');
console.log('RUNNING', JSON.stringify(opts));
try {
  const r = await Promise.race([
    pg.evaluate(o => window.__run(o), opts),
    new Promise((_,rej)=>setTimeout(()=>rej(new Error('TIMEOUT 60s')), 60000)),
  ]);
  console.log('RESULT', JSON.stringify(r));
} catch (e) { console.log('FAIL', e.message); }
await b.close(); srv.close();
