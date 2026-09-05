// Record the fire in motion: a slam wind-up cranked at 10 Hz with a volley in the air, then the landing.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST, OUT = process.env.OUT; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 594 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1280, height: 594 } } });
const pg = await ctx.newPage();
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.addStyleTag({ content: '.dev,.errorbar,[class*=telemetry]{display:none!important}' });
const S = { seats: 20, ring: true, fury: true };
// ticks 930..975: the volley in the air throughout (bullets regenerate per tick), the slam
// telegraph from 945, landing at 960, then the floor quiet.
for (let t = 930; t <= 975; t++) {
  const bullets = t < 946 ? 10 : t < 962 ? 10 - ((t - 946) % 4 === 3 ? 3 : 0) : 8;
  await pg.evaluate(([t, o]) => window.__scene('arena', { ...o, tick: t }), [t, { ...S, bullets }]);
  await pg.waitForTimeout(100);
}
await pg.waitForTimeout(400);
await ctx.close(); await b.close(); srv.close();
const v = fs.readdirSync(OUT).find((f) => f.endsWith('.webm')); fs.renameSync(path.join(OUT, v), path.join(OUT, 'fire.webm')); console.log('video ok');
