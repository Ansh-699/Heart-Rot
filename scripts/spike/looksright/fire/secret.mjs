// The secret room, photographed without a chain: the lobby door's glow with the local seat
// on its threshold, then the chamber with three seats in ZONE_SECRET on its floor and the
// local seat at the exit (its door glowing). Proves the side filter, the hint and the arches.
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
const probe = () => pg.evaluate(() => ({
  room: document.querySelectorAll('.secret-room').length,
  knights: document.querySelectorAll('#camera .knight, #camera [data-seat]').length,
  labels: [...document.querySelectorAll('.secret-label')].map((t) => t.textContent),
  hint: document.querySelector('.hud-hint')?.textContent ?? null,
  arch: (() => { const r = document.querySelector('rect.gate-wanted'); return r ? { x: r.getAttribute('x'), y: r.getAttribute('y') } : null; })(),
  zone: window.__store.getState().players?.slots[0]?.zone,
}));
// Seat 0 is the local seat; (80, 704) is column 5, row 44: the lobby door's threshold. Seat 3
// stands INSIDE the room's block but in the lobby zone: still drawn, it is on this side.
await pg.evaluate(() => window.__scene('lobby', { at: [[80, 704, 2, true], [400, 832, 0, true], [560, 832, 1, true], [500, 720, 2, true]] }));
await pg.evaluate(() => document.fonts.ready);
await pg.waitForTimeout(700);
const lobby = await probe();
await pg.screenshot({ path: path.join(OUT, 'secret-door.png') });
// In the zone: the local seat at the entry/exit tile (656, 704), two allies on the floor.
await pg.evaluate(() => window.__scene('secret', { at: [[656, 704, 2, true], [400, 672, 0, true], [480, 752, 1, true]] }));
await pg.waitForTimeout(700);
const inside = await probe();
await pg.screenshot({ path: path.join(OUT, 'secret-room.png') });
// A step in from the door: the exit glow goes out, the room stays.
await pg.evaluate(() => window.__scene('secret', { at: [[640, 704, 2, true], [400, 672, 0, true], [480, 752, 1, true]] }));
await pg.waitForTimeout(400);
const stepped = await probe();
console.log(JSON.stringify({ lobby, inside, stepped, errors }, null, 1));
await b.close(); srv.close();
