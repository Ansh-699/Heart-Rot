// The showcase take: lobby → fight → fury + slam → super → the beam → the kill → results.
// One 1920x1080 recording, beats logged against the recording's own clock.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST, OUT = process.env.OUT; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.jpg': 'image/jpeg' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
const T0 = Date.now(); const beats = {}; const beat = (n) => { beats[n] = +((Date.now() - T0) / 1000).toFixed(2); console.log('beat', n, beats[n]); };
const pg = await ctx.newPage();
const errors = []; pg.on('pageerror', (e) => errors.push(String(e)));
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.addStyleTag({ content: '.dev,.errorbar,[class*=telemetry]{display:none!important}' });
const wait = (ms) => pg.waitForTimeout(ms);
const scene = (which, o) => pg.evaluate(([w, o]) => window.__scene(w, o), [which, o]);
const fire = (tier, dx, dy) => pg.evaluate(([tier, dx, dy]) => { const s = window.__store.getState().players.slots[0]; window.__fire({ seat: 0, x: s.x, y: s.y, dx, dy, tier }); }, [tier, dx, dy]);
// A crank: the scene re-issued every 100 ms with the tick advancing, until stopped.
let tick = 0, opts = {}, iv = null;
const crank = (from, o) => { tick = from; opts = o; scene('arena', { ...opts, tick }).catch(() => {}); clearInterval(iv); iv = setInterval(() => { tick++; scene('arena', { ...opts, tick, bullets: typeof opts.bullets === 'function' ? opts.bullets(tick) : opts.bullets }).catch(() => {}); }, 100); };
const thin = (n) => (t) => n - ((t % 4) === 3 ? 3 : 0);

// 1. The waiting room: torches, embers, raiders idling, a practice arrow or two.
beat('lobby');
await scene('lobby', { seats: 12 });
await wait(2200); await fire(0, 127, 0); await wait(1300); await fire(1, 110, -60); await wait(2000);

// 2. The fight: the volley leaves the thorns, comets cross the pit, some land.
beat('fight');
crank(900, { seats: 20, ring: true, bullets: thin(10) });
await wait(7000);

// 3. Fury, and the hand: the slam winds up out of the lane's centre and lands.
beat('fury');
crank(936, { seats: 20, ring: true, fury: true, bullets: thin(14) });
await wait(6000);

// 4. The super: hold, hold longer, loose.
beat('super');
await pg.evaluate(() => window.__charge(1)); await wait(1300);
await pg.evaluate(() => window.__charge(2)); await wait(2100);
await pg.evaluate(() => { window.__charge(null); const s = window.__store.getState().players.slots[0]; const dx = 512 - s.x, dy = 352 - 108 - s.y, m = Math.max(Math.abs(dx), Math.abs(dy)); window.__fire({ seat: 0, x: s.x, y: s.y, dx: Math.round(dx / m * 127), dy: Math.round(dy / m * 127), tier: 2 }); });
await wait(1600);

// 5. The beam: half the floor catches from its centre, then the wall sweeps it.
beat('breaking');
crank(12 * 80, { seats: 20, ring: true, beam: 'warn', bullets: thin(8) });
await wait(6000);

// 6. The kill, then the verdict.
beat('kill');
clearInterval(iv);
await scene('arena', { seats: 20, ring: true, bullets: 0, phase: 2, outcome: 1, dead: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], tick: 12 * 80 + 60 });
await wait(4200);
beat('end');
await scene('arena', { seats: 20, ring: true, bullets: 0, phase: 3, outcome: 1, incarnation: 1, dead: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], tick: 12 * 80 + 100 });
await wait(3200);
beat('stop');
await ctx.close(); await b.close(); srv.close();
const v = fs.readdirSync(OUT).find((f) => f.endsWith('.webm')); fs.renameSync(path.join(OUT, v), path.join(OUT, 'take.webm'));
fs.writeFileSync(path.join(OUT, 'beats.json'), JSON.stringify(beats));
console.log('take ok', errors.length ? errors.slice(0, 3) : 'no page errors');
