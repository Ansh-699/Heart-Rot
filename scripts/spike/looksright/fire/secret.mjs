// The secret room, photographed without a chain: the door's glow with the local seat on the
// threshold, then the chamber open. Proves the store flag, the hint, the door cue and Escape.
//   PW_HOME=... DIST=/tmp/looksright-dist OUT=<dir> node scripts/spike/looksright/fire/secret.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { launchQuiet } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST ?? '/tmp/looksright-dist', OUT = process.env.OUT; fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const srv = http.createServer((q, s) => {
  let u = q.url.split('?')[0]; if (u === '/') u = '/index.html';
  const f = path.join(DIR, u); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); }
  s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await launchQuiet(chromium, { headless: true, channel: 'chrome' });
const pg = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const errors = []; pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await pg.waitForFunction(() => window.__ready === true);
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
// Seat 0 is the local seat; (80, 704) is column 5, row 44: the door's threshold.
await pg.evaluate(() => window.__scene('lobby', { at: [[80, 704, 2, true], [400, 832, 0, true], [560, 832, 1, true], [304, 768, 2, true]] }));
await pg.evaluate(() => document.fonts.ready);
await pg.waitForTimeout(700);
const glow = await pg.evaluate(() => { const r = document.querySelector('rect.gate-wanted'); return r ? { x: r.getAttribute('x'), y: r.getAttribute('y'), fill: r.getAttribute('fill') } : null; });
await pg.screenshot({ path: path.join(OUT, 'secret-door.png') });
await pg.evaluate(() => window.__store.setSecret(true));
await pg.waitForTimeout(600);
const open = await pg.evaluate(() => ({
  room: !!document.querySelector('.secret-room'),
  labels: [...document.querySelectorAll('.secret-label')].map((t) => t.textContent),
  caption: document.querySelector('.secret-caption')?.textContent ?? null,
  hint: document.querySelector('.hud-hint')?.textContent ?? null,
  glow: !!document.querySelector('rect.gate-wanted'),
  secret: window.__store.getState().secret,
  img: (() => { const i = document.querySelector('.secret-room image'); return i ? i.getAttribute('href') : null; })(),
}));
await pg.screenshot({ path: path.join(OUT, 'secret-room.png') });
await pg.keyboard.press('Escape'); await pg.waitForTimeout(150);
const afterEsc = await pg.evaluate(() => ({ secret: window.__store.getState().secret, room: !!document.querySelector('.secret-room'), glow: !!document.querySelector('rect.gate-wanted') }));
console.log(JSON.stringify({ glow, open, afterEsc, errors }, null, 1));
await b.close(); srv.close();
