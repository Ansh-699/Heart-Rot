import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { launchQuiet } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await launchQuiet(chromium, { headless: !process.env.HEADED, channel: 'chrome' });
const pg = await (await b.newContext({ viewport: { width: 1840, height: 854 } })).newPage();
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.addStyleTag({ content: '.dev,.errorbar,[class*=telemetry]{display:none!important}' });
const probe = async (label, scene, css) => {
  const h = css ? await pg.addStyleTag({ content: css }) : null;
  await pg.evaluate((o) => window.__scene('arena', o), scene);
  await pg.waitForTimeout(400);
  const r = await pg.evaluate(() => new Promise((res) => { const t = []; let last = performance.now(); const f = () => { const n = performance.now(); t.push(n - last); last = n; if (t.length < 180) requestAnimationFrame(f); else res(t); }; requestAnimationFrame(f); }));
  r.sort((a, c) => a - c);
  console.log(label.padEnd(34), 'p50', r[90].toFixed(1).padStart(5), 'p95', r[171].toFixed(1).padStart(5), 'max', r[179].toFixed(1).padStart(5));
  if (h) await h.evaluate((el) => el.remove());
};
const S = { seats: 20, ring: true };
for (let k = 0; k < 2; k++) {
await probe('floor: 20 seats, nothing burning', { ...S, bullets: 0, tick: 900 });
await probe('24 comets', { ...S, bullets: 24, fury: true, tick: 900 });
await probe('slam wind-up only', { ...S, bullets: 0, tick: 954 });
await probe('slam wind-up + 12 bullets', { ...S, bullets: 12, fury: true, tick: 954 });
}
await b.close(); srv.close();
