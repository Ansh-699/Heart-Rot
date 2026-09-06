// The side rooms, photographed without a chain: the lobby with the local seat on each door's
// threshold (its doorway glowing), then each room with the local seat at its exit and two
// allies on its floor. Proves the side filter, the hints, the arches and the rooms' text.
//   PW_HOME=... DIST=/tmp/looksright-dist OUT=<dir> node scripts/spike/looksright/fire/rooms.mjs
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
const probe = () => pg.evaluate(() => ({
  room: document.querySelectorAll('.secret-room').length,
  labels: [...document.querySelectorAll('.secret-label')].map((t) => t.textContent),
  texts: document.querySelectorAll('.room-text').length,
  you: document.querySelectorAll('.room-text.is-you').length,
  glyphs: document.querySelectorAll('.secret-room use[href^="#crypt-"]').length,
  hint: document.querySelector('.hud-hint')?.textContent ?? null,
  arch: (() => { const r = document.querySelector('rect.gate-wanted'); return r ? { x: r.getAttribute('x'), y: r.getAttribute('y') } : null; })(),
  zone: window.__store.getState().players?.slots[0]?.zone,
}));
const out = {};
// Seat 0 is the local seat. The three thresholds, in the lobby: west door, east door, stairs.
for (const [name, x, y] of [['west', 80, 704], ['east', 928, 704], ['stairs', 512, 880]]) {
  await pg.evaluate(([x, y]) => window.__scene('lobby', { at: [[x, y, 2, true], [400, 832, 0, true], [560, 832, 1, true]] }), [x, y]);
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForTimeout(500);
  out[`lobby-${name}`] = await probe();
  await pg.screenshot({ path: path.join(OUT, `lobby-${name}.png`) });
}
for (const name of ['secret', 'keep', 'crypt']) {
  await pg.evaluate((n) => window.__scene(n, { seats: 3 }), name);
  await pg.waitForTimeout(900);
  out[name] = await probe();
  await pg.screenshot({ path: path.join(OUT, `room-${name}.png`) });
}
console.log(JSON.stringify({ ...out, errors }, null, 1));
await b.close(); srv.close();
