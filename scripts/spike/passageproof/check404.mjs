import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/package.json')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUIET_ARGS } from '../launch.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)); const DIR = path.join(HERE, 'dist');
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { console.log('404:', q.url); s.writeHead(404); return s.end(); }
  s.writeHead(200); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(8765, r));
const b = await chromium.launch({ channel: 'chrome', headless: true, args: [...QUIET_ARGS] });
const pg = await b.newPage();
await pg.goto('http://127.0.0.1:8765/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true');
await b.close(); srv.close();
