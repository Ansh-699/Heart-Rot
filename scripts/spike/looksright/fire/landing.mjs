// The landing clip: 7 s of a furious fight at 1280x720 — comets leaving the thorns, a slam
// wind-up growing on a 10 Hz crank, a super from the local seat.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST, OUT = process.env.OUT; fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.woff2': 'font/woff2' };
const srv = http.createServer((q, s) => { const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
const pg = await ctx.newPage();
await pg.goto('http://127.0.0.1:' + PORT + '/', { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
await pg.addStyleTag({ content: '.dev,.errorbar,[class*=telemetry]{display:none!important}' });
// A calm fight at 10 Hz: six fireballs, the slam winding up over 945..960 and landing, then a super.
let t = 938;
const AR = () => pg.evaluate((k) => window.__scene('arena', { seats: 12, ring: true, bullets: 6, tick: k }), t);
await AR(); await pg.waitForTimeout(1500);
const iv = setInterval(() => { t++; AR().catch(() => {}); }, 100);
await pg.waitForTimeout(3400);
await pg.evaluate(() => window.__charge(1)); await pg.waitForTimeout(1300);
await pg.evaluate(() => window.__charge(2)); await pg.waitForTimeout(2200);
await pg.evaluate(() => { window.__charge(null); const s = window.__store.getState().players.slots[0]; const dx = 512 - s.x, dy = 352 - 108 - s.y, m = Math.max(Math.abs(dx), Math.abs(dy)); window.__fire({ seat: 0, x: s.x, y: s.y, dx: Math.round(dx / m * 127), dy: Math.round(dy / m * 127), tier: 2 }); });
await pg.waitForTimeout(2600); clearInterval(iv);
await ctx.close(); await b.close(); srv.close();
const v = fs.readdirSync(OUT).find((f) => f.endsWith('.webm')); fs.renameSync(path.join(OUT, v), path.join(OUT, 'raw.webm')); console.log('landing raw ok');
