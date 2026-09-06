// Photograph the telemetry panel open during a cranked fight in the harness.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { launchQuiet } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST, OUT = process.env.OUT; fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await launchQuiet(chromium, { headless: true, channel: 'chrome' });
const pg = await (await b.newContext({ viewport: { width: 1840, height: 854 } })).newPage();
const errors = []; pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.addStyleTag({ content: '.errorbar{display:none!important}' });
for (let t = 900; t <= 930; t++) { await pg.evaluate((k) => window.__scene('arena', { seats: 20, ring: true, bullets: 8, tick: k }), t); await pg.waitForTimeout(100); }
await pg.keyboard.press('Backquote'); await pg.waitForTimeout(400);
for (let t = 931; t <= 960; t++) { await pg.evaluate((k) => window.__scene('arena', { seats: 20, ring: true, bullets: 8, tick: k }), t); await pg.waitForTimeout(100); }
await pg.screenshot({ path: path.join(OUT, 'panel.png') });
const box = await pg.evaluate(() => { const r = document.querySelector('.dev')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null; });
console.log('panel box', box, errors.length ? errors.slice(0, 2) : 'no page errors');
await b.close(); srv.close();
