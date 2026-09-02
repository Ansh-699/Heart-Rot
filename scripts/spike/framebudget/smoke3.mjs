// Throwaway smoke: boot the v3 harness (scene + shipped HUD + DevPanel), run one short
// window per room, screenshot each, and dump console errors + what the page actually
// fetched. Nothing is trusted until these shots have been looked at.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist3');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index3.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = +(process.env.PORT || 8744);
await new Promise((r) => srv.listen(PORT, r));

const b = await chromium.launch({ channel: 'chrome', headless: false });
const pg = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const errs = [];
const urls = [];
pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
pg.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
pg.on('request', (r) => urls.push(r.url().replace(`http://127.0.0.1:${PORT}`, '')));
await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });

for (const room of ['arena', 'lobby', 'passage']) {
  const r = await pg.evaluate((o) => window.__run(o), { room, knights: 20, bullets: 14, frames: 90, feedHz: 714 });
  console.log(room, JSON.stringify({ seat: r.seat, storeStatus: r.storeStatus, hudNodes: r.hudNodes, nodes: r.nodes, p50: r.commitP50, mpx: r.stageMpx }));
  await pg.screenshot({ path: path.join(HERE, `shot3-${room}.png`) });
}
// One with the telemetry panel opened, to see it and price it later.
await pg.keyboard.press('Backquote');
await pg.evaluate((o) => window.__run(o), { room: 'arena', knights: 20, bullets: 14, frames: 60, feedHz: 714 });
await pg.screenshot({ path: path.join(HERE, 'shot3-devopen.png') });
console.log('ERRORS', JSON.stringify(errs.slice(0, 12), null, 1));
console.log('FETCHED', JSON.stringify(urls, null, 1));
await b.close();
srv.close();
