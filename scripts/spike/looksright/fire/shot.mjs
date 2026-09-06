// Photograph the fire: serve a looksright dist, set scenes through window.__scene, save PNGs.
//   DIST=/tmp/looksright-dist OUT=dir node shot.mjs [scene ...]
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { launchQuiet } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST, OUT = process.env.OUT; fs.mkdirSync(OUT, { recursive: true });
const W = +(process.env.W ?? 1840), H = +(process.env.H ?? 854);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await launchQuiet(chromium, { headless: process.env.HEADED ? false : true, channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const pg = await ctx.newPage();
const errors = []; pg.on('pageerror', (e) => errors.push(String(e))); pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.addStyleTag({ content: '.dev,.errorbar,.telemetry,.telemetry-pill,[class*=telemetry]{display:none!important}' });
// A wind-up photographed mid-way: crank it a tick at a time, 100 ms apart, as the chain does.
const crank = async (from, to, opts) => { for (let t = from; t <= to; t++) { await pg.evaluate(([t, o]) => window.__scene('arena', { ...o, tick: t }), [t, opts]); await pg.waitForTimeout(100); } };
// The reference frames one raider at the left of the pit; `at` is [x, y, skin, archer].
const ME = [[197, 386, 0, 0]];
const SLAM = 12 * 60 * 1 + 0; // any multiple of SLAM_PERIOD(60) is a landing tick; 960 lands.
const scenes = {
  // The volley, as the reference: one raider, fourteen fireballs in the air, then three
  // of them die so the impact bursts are in frame too.
  volley: async () => {
    await pg.evaluate(() => window.__scene('arena', { seats: 1, at: [[197, 386, 0, 0]], bullets: 14, tick: 900 }));
    await pg.waitForTimeout(900);
    await pg.evaluate(() => window.__scene('arena', { seats: 1, at: [[197, 386, 0, 0]], bullets: 11, tick: 901 }));
    await pg.waitForTimeout(140);
  },
  volley20: async () => {
    await pg.evaluate(() => window.__scene('arena', { seats: 20, ring: true, bullets: 16, fury: true, tick: 900 }));
    await pg.waitForTimeout(900);
    await pg.evaluate(() => window.__scene('arena', { seats: 20, ring: true, bullets: 12, fury: true, tick: 901 }));
    await pg.waitForTimeout(140);
  },
  // The slam wind-up at 0.4 s, 0.9 s and 1.4 s of its 1.5 s (landing tick 960).
  slam04: async () => { await crank(944, 949, { seats: 20, ring: true, bullets: 0 }); },
  slam09: async () => { await crank(944, 954, { seats: 20, ring: true, bullets: 0 }); },
  slam14: async () => { await crank(944, 959, { seats: 20, ring: true, bullets: 0 }); },
  // The landing: wind-up then the resolve tick, photographed 120 ms after.
  slamhit: async () => {
    await crank(944, 960, { seats: 20, ring: true, bullets: 0 }); await pg.waitForTimeout(60);
  },
};
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenes);
for (const name of want) {
  await scenes[name]();
  await pg.screenshot({ path: path.join(OUT, name + '.png') });
  console.log('shot', name);
}
// Optional: a short frame-time probe on the busiest scene.
if (process.env.PROBE) {
  await pg.evaluate(() => window.__scene('arena', { seats: 20, ring: true, bullets: 24, fury: true, tick: 954 }));
  await pg.waitForTimeout(300);
  const r = await pg.evaluate(() => new Promise((res) => { const t = []; let last = performance.now(); const f = () => { const n = performance.now(); t.push(n - last); last = n; if (t.length < 240) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); }));
  r.sort((a, b) => a - b); console.log('frame ms p50 %s p95 %s max %s', r[120].toFixed(2), r[228].toFixed(2), r[239].toFixed(2));
}
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
await ctx.close(); await b.close(); srv.close();
