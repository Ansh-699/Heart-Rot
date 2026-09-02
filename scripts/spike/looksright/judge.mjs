// Throwaway (task: art-judge). Places knights WHERE THE CHAIN ACTUALLY PUTS THEM --
// `map.ts` LOBBY_SPAWN row, the aisle walk to the gate, the ten torch-pool centres, and
// the arena pit -- one skin per frame, plus a matching empty plate, so body-vs-floor
// contrast is a pixel diff at the real stands instead of over a synthetic grid.
import { createRequire } from 'node:module';
const require_ = createRequire(process.env.PW_HOME + '/x.cjs');
const { chromium } = require_('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';

const DIR = '/tmp/looksright-dist';
const OUT = '/home/anshtyagi/Documents/pixel-artgame/docs/art/shipped/judge';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = 8931;
await new Promise((r) => srv.listen(PORT, r));
fs.mkdirSync(OUT, { recursive: true });

// --- the real stands, straight out of packages/client/src/map.ts -----------------
const SPAWN_MIN_X = 208, SPAWN_MAX_X = 664, SPAWN_Y = 832;
const GATE_CX = 512;
// seat 0 is the local player and wears the chevron, so it is parked off-set and never
// measured; every measured seat is index >= 1.
const PARK = [1000, 1000, 0, 0];

const spawnRow = [PARK];
for (let i = 0; i < 19; i++) {
  spawnRow.push([Math.round(SPAWN_MIN_X + (i * (SPAWN_MAX_X - SPAWN_MIN_X)) / 18), SPAWN_Y, 0, 0]);
}
// the walk: straight up the aisle from the spawn row onto the gate block (y 608..639)
const walk = [PARK];
for (let i = 0; i < 12; i++) walk.push([GATE_CX + (i % 2 ? 26 : -26), 832 - i * 18, 0, 0]);
// A grid across the whole LOBBY floor (map.ts LOBBY_TOP 688 .. LOBBY_BOT 1007, cols 2..61
// => world x 32..991). Replaces the old typed torch-pool list, which was coordinates from
// a WaitingRoom that no longer types any.
const pools = [PARK];
for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) {
  if (pools.length >= 20) break;
  pools.push([90 + c * 210, 730 + r * 80, 0, 0]);
}
// arena pit: ZONE_ARENA y is PIT_TOP..PIT_BOT (384..655); entrances are y 512.
const pit = [PARK];
for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) { if (pit.length >= 20) break; pit.push([140 + c * 180, 400 + r * 62, 0, 0]); }

const SETS = { spawn: spawnRow, walk, pools, pit };
const HIDE = '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}';

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const CASES = [];
for (const [set, at] of Object.entries(SETS)) {
  const room = set === 'pit' ? 'arena' : 'lobby';
  for (const skin of [0, 1, 2]) {
    CASES.push({ name: `${set}-s${skin}`, room, at: at.map((p) => [p[0], p[1], skin, 0]) });
    CASES.push({ name: `${set}-s${skin}-arch`, room, at: at.map((p) => [p[0], p[1], skin, 1]) });
  }
  CASES.push({ name: `${set}-plate`, room, at: [PARK] });
}
// One big knight for a direct rim measurement: single seat, page zoomed 8x by CSS.
CASES.push({ name: 'rim-s0', room: 'lobby', at: [PARK, [512, 760, 0, 0]], zoom: 8 });
CASES.push({ name: 'rim-plate', room: 'lobby', at: [PARK], zoom: 8 });

const meta = [];
for (const c of (ONLY.length ? CASES.filter((x) => ONLY.some((o) => x.name.startsWith(o))) : CASES)) {
  const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
  try {
    const pg = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
    await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
    const opts = { at: c.at, bullets: 0 };
    await pg.evaluate(([room, o]) => window.__scene(room, o), [c.room, opts]);
    await pg.waitForTimeout(2200);
    await pg.evaluate(([room, o]) => window.__scene(room, o), [c.room, opts]);
    await pg.waitForTimeout(1400);
    await pg.addStyleTag({ content: HIDE });
    if (c.zoom) {
      await pg.evaluate((z) => {
        const svg = document.getElementById('stage').querySelector('svg');
        svg.style.transformOrigin = '0 0';
        svg.style.transform = `scale(${z})`;
      }, c.zoom);
    }
    await pg.waitForTimeout(300);
    const geom = await pg.evaluate(() => {
      const stage = document.getElementById('stage');
      const svg = stage?.querySelector('svg');
      const m = svg?.querySelector('#camera')?.getScreenCTM?.();
      const sr = stage?.getBoundingClientRect();
      return { stage: sr && { x: +sr.x.toFixed(1), y: +sr.y.toFixed(1), w: +sr.width.toFixed(1), h: +sr.height.toFixed(1) },
               ctm: m && { a: +m.a.toFixed(5), d: +m.d.toFixed(5), e: +m.e.toFixed(2), f: +m.f.toFixed(2) } };
    });
    await pg.screenshot({ path: path.join(OUT, c.name + '.png'), timeout: 15000 });
    meta.push({ name: c.name, room: c.room, at: c.at, zoom: c.zoom || 1, geom });
    console.log(c.name, JSON.stringify(geom.ctm));
  } catch (e) { console.log(c.name, 'FAILED', String(e).slice(0, 200)); }
  finally { await b.close(); }
}
{ const f = path.join(OUT, 'meta.json'); const old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : [];
  const byName = new Map(old.map((m) => [m.name, m])); meta.forEach((m) => byName.set(m.name, m));
  fs.writeFileSync(f, JSON.stringify([...byName.values()], null, 2)); }
srv.close();
