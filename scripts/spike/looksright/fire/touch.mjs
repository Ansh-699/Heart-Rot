// touch-input: the virtual thumbstick and the fire finger, driven through CDP against the
// shipped `attachControls` on the real stage (`window.__attachControls` in ../main.tsx).
//   DIST=/tmp/looksright-touch-input PW_HOME=<playwright install dir> node touch.mjs
// Prints PASS/FAIL per assertion; exits 1 on any FAIL.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/x.cjs');
const { chromium } = (() => { try { return req('playwright'); } catch { return req('playwright-core'); } })();
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { launchQuiet } from '../../launch.mjs';
const DIR = process.env.DIST;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await launchQuiet(chromium, { headless: true });
const ctx = await b.newContext({ hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
const pg = await ctx.newPage();
const errors = []; pg.on('pageerror', (e) => errors.push(String(e))); pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });

let fails = 0;
const check = (ok, what, detail = '') => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + what + (detail ? '  [' + detail + ']' : '')); if (!ok) fails++; };

check(await pg.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the context is a coarse pointer');
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.evaluate(() => window.__scene('lobby', { seats: 3 }));
await pg.waitForSelector('#stage', { timeout: 10000 });
await pg.waitForTimeout(300);
// What the fingers land on: both must reach the stage, or the listeners never see them.
const under = await pg.evaluate(() => [[200, 250], [700, 250]].map(([x, y]) => { const e = document.elementFromPoint(x, y); return e ? (e.id || e.tagName.toLowerCase() + '.' + e.className) : null; }));
const stageRect = await pg.evaluate(() => { const r = document.getElementById('stage').getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); });
console.log('stage rect', stageRect, 'under fingers', under);
await pg.evaluate(() => { window.__log = []; window.__detach = window.__attachControls(window.__log); });

const cdp = await ctx.newCDPSession(pg);
const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
const logSince = async (t0) => (await pg.evaluate(() => window.__log)).filter((e) => e[0] >= t0);
const now = () => pg.evaluate(() => performance.now());

// 1. The thumb goes down on the left half and pushes north 60 px: walking, auto-repeated.
await touch('touchStart', [{ x: 200, y: 250, id: 1 }]);
const tWalk = await now();
await touch('touchMove', [{ x: 200, y: 190, id: 1 }]);
await pg.waitForTimeout(1000);
const tWalkEnd = await now();
{
  const moves = (await logSince(tWalk)).filter((e) => e[1] === 'move' && e[0] <= tWalkEnd);
  const gaps = moves.slice(1).map((e, i) => e[0] - moves[i][0]);
  check(moves.length >= 17 && moves.length <= 22, '~20 moves in a 1 s hold', String(moves.length));
  check(moves.every((e) => e[2] === 0), 'every move is north (0)', moves.map((e) => e[2]).join(','));
  check(gaps.every((g) => g >= 45 - 1), 'gaps >= 45 ms', 'min ' + Math.min(...gaps).toFixed(1));
}

// 2. Back inside the dead zone: standing still, the auto-repeat stops.
await touch('touchMove', [{ x: 200, y: 245, id: 1 }]);
await pg.waitForTimeout(120);
const tStill = await now();
await pg.waitForTimeout(400);
check((await logSince(tStill)).filter((e) => e[1] === 'move').length === 0, 'inside 12 px the moves stop');

// 3. Walking again, a second finger on the right half: one plain trigger, while walking.
await touch('touchMove', [{ x: 200, y: 190, id: 1 }]);
await pg.waitForTimeout(120);
const tFire = await now();
await touch('touchStart', [{ x: 200, y: 190, id: 1 }, { x: 700, y: 250, id: 2 }]);
await pg.waitForTimeout(60);
// 4. Finger 1 lifts: the stick releases, the hold stays down, nothing fires. CDP's
// `touchEnd` lists the points RELEASED, not the ones still down (probed: `[id 2]` lifted
// finger 2), so this names the thumb.
const tLift = await now();
await touch('touchEnd', [{ x: 200, y: 190, id: 1 }]);
await pg.waitForTimeout(1500);
const tRelease = await now();
{
  const trig = (await logSince(tFire)).filter((e) => e[1] === 'trigger' && e[0] < tLift);
  check(trig.length === 1 && trig[0][2] === 0, 'the second finger fires one tier 0 while walking', JSON.stringify(trig.map((e) => e[2])));
  const after = (await logSince(tLift)).filter((e) => e[1] === 'trigger');
  check(after.length === 0, 'lifting the thumb fires nothing', String(after.length));
  const walkStopped = (await logSince(tLift + 100)).filter((e) => e[1] === 'move').length === 0;
  check(walkStopped, 'lifting the thumb stops the walk');
  const charge = (await logSince(tLift)).filter((e) => e[1] === 'charge').map((e) => e[2]);
  check(charge.includes(1), 'the hold reaches charge 1 standing', charge.join(','));
}
// 5. Finger 2 lifts: the release fires the tier reached.
await touch('touchEnd', [{ x: 700, y: 250, id: 2 }]);
await pg.waitForTimeout(100);
{
  const trig = (await logSince(tRelease)).filter((e) => e[1] === 'trigger');
  check(trig.length === 1 && trig[0][2] === 1, 'lifting the fire finger fires tier 1', JSON.stringify(trig.map((e) => e[2])));
  const charge = (await logSince(tRelease)).filter((e) => e[1] === 'charge').map((e) => e[2]);
  check(charge.includes(null), 'the hold edge comes down', charge.join(','));
}

if (process.env.OUT) { fs.mkdirSync(process.env.OUT, { recursive: true }); await pg.screenshot({ path: path.join(process.env.OUT, 'touch-lobby.png') }); }
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
await pg.evaluate(() => window.__detach());
await ctx.close(); await b.close(); srv.close();
console.log(fails ? `FAIL ${fails}` : 'ALL PASS');
process.exit(fails ? 1 : 0);
