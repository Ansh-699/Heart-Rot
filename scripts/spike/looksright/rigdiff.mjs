// Throwaway (A10 verify): the plan's art check — pixel diff inside BOSS_CROP with and
// without the boss rig, on a full shell, must be ~0. Same dist and route as shoot.mjs,
// but every animation is PAUSED AT t=0 first: the breathe is scale(1)..scale(1.014)
// about the feet and a plain screenshot lands at a random phase, which reads as a few
// screen pixels of crown displacement and hides the question being asked.
//   cd scripts/spike/looksright && ../../../app/node_modules/.bin/vite build
//   PW_HOME=... node rigdiff.mjs   -> writes rig-on.png / rig-off.png to OUT (default scratch)
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';

const DIR = '/tmp/looksright-dist';
const OUT = process.env.OUT || '.';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = 8913;
await new Promise((r) => srv.listen(PORT, r));

const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
try {
  const pg = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
  await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
  const scene = () => pg.evaluate(() => window.__scene('arena', { seats: 1, bullets: 0 }));
  await scene(); await pg.waitForTimeout(2200); await scene(); await pg.waitForTimeout(1400);
  await pg.addStyleTag({ content: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}' });
  const paused = await pg.evaluate(() => {
    const all = document.getAnimations();
    for (const a of all) { a.pause(); a.currentTime = 0; }
    return all.length;
  });
  await pg.waitForTimeout(300);
  const geom = await pg.evaluate(() => {
    const m = document.querySelector('#stage svg #camera').getScreenCTM();
    return { a: m.a, e: m.e, f: m.f, rig: document.querySelectorAll('.hr-boss').length };
  });
  await pg.screenshot({ path: path.join(OUT, 'rig-on.png'), timeout: 15000 });
  await pg.addStyleTag({ content: '.hr-boss{display:none!important}' });
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, 'rig-off.png'), timeout: 15000 });
  console.log(JSON.stringify({ paused, ...geom, errs }));
} finally { await b.close(); srv.close(); }
