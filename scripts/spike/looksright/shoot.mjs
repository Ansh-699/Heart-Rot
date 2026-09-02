// Throwaway driver (task: looks-right). Serves /tmp/looksright-dist, drives the real store
// into each scene, and screenshots the stage. Fresh browser per case for the same reason
// framebudget/drive.mjs uses one: a reused page pins compositor state.
import { createRequire } from 'node:module';
const require_ = createRequire(process.env.PW_HOME + '/x.cjs');
const { chromium } = require_('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';

const DIR = '/tmp/looksright-dist';
const OUT = process.env.OUT || '/home/anshtyagi/Documents/pixel-artgame/docs/art/shipped';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = 8912;
await new Promise((r) => srv.listen(PORT, r));
fs.mkdirSync(OUT, { recursive: true });

const ALL = [
  { name: 'lobby-1920', room: 'lobby', vw: 1920, vh: 1080, opts: {} },
  { name: 'arena-1920', room: 'arena', vw: 1920, vh: 1080, opts: {} },
  { name: 'lobby-1366', room: 'lobby', vw: 1366, vh: 768, opts: {} },
  { name: 'arena-1366', room: 'arena', vw: 1366, vh: 768, opts: {} },
  { name: 'arena-1920-empty', room: 'arena', vw: 1920, vh: 1080, opts: { seats: 1, bullets: 0 } },
  { name: 'lobby-1920-empty', room: 'lobby', vw: 1920, vh: 1080, opts: { seats: 1 } },
  { name: 'arena-1920-hurt', room: 'arena', vw: 1920, vh: 1080, opts: { hurt: true, bullets: 24 } },
  // Plates. Each hides ONE shipped layer so a diff against the full frame gives that
  // layer's exact pixel mask. Nothing product-side changes; the style is injected here.
  { name: 'plate-arena-noboss', room: 'arena', vw: 1920, vh: 1080, opts: { seats: 1, bullets: 0 },
    css: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}'
       + '.hr-boss-breathe{display:none!important}' },
  { name: 'plate-lobby-noprops', room: 'lobby', vw: 1920, vh: 1080, opts: { seats: 1 },
    hideProps: true,
    css: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}' },
  { name: 'plate-lobby-nohud', room: 'lobby', vw: 1920, vh: 1080, opts: { seats: 20 },
    css: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}' },
  { name: 'plate-arena-nohud', room: 'arena', vw: 1920, vh: 1080, opts: { seats: 20 },
    css: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}' },
  { name: 'plate-arena-nohud-empty', room: 'arena', vw: 1920, vh: 1080, opts: { seats: 1, bullets: 0 },
    css: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}' },
  { name: 'plate-lobby-nohud-empty', room: 'lobby', vw: 1920, vh: 1080, opts: { seats: 1 },
    css: '.hud,.dev,.hr-hud,[class*="hud"],[class*="dev"],.errorbar{display:none!important}' },
];
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
const CASES = ONLY.length ? ALL.filter((c) => ONLY.includes(c.name)) : ALL;

const report = [];
for (const c of CASES) {
  const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
  try {
    const pg = await b.newPage({ viewport: { width: c.vw, height: c.vh }, deviceScaleFactor: 1 });
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
    // Onboarding -> select -> lobby, through the real store actions (scenemount's route).
    await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
    await pg.evaluate(([room, opts]) => window.__scene(room, opts), [c.room, c.opts]);
    await pg.waitForTimeout(2200); // let the passage/spawn beats settle
    // Re-push, so the passage's 1100 ms cover is over and the room is the steady state.
    await pg.evaluate(([room, opts]) => window.__scene(room, opts), [c.room, c.opts]);
    await pg.waitForTimeout(1400);
    // The shell's ErrorBar is `null` unless there is an error; the harness has no Worker,
    // so it is always up and eats 34.5 px of stage height that production does not.
    await pg.addStyleTag({ content: '.errorbar{display:none!important}' });
    if (c.css) await pg.addStyleTag({ content: c.css });
    if (c.hideProps) {
      // Props are the trailing children of the room's clip group; the wall mass is the last
      // consecutive run of direct <path> children before them (WaitingRoom.tsx rows 6/7).
      const cut = await pg.evaluate(() => {
        const g = document.querySelector('#waiting-room > g[clip-path]');
        if (!g) return -1;
        const kids = [...g.children];
        let last = -1;
        kids.forEach((k, i) => { if (k.tagName.toLowerCase() === 'path') last = i; });
        kids.slice(last + 1).forEach((k) => { k.style.display = 'none'; });
        return kids.length - (last + 1);
      });
      console.log(JSON.stringify({ propNodesHidden: cut }));
    }
    await pg.waitForTimeout(250);
    const geom = await pg.evaluate(() => {
      const stage = document.getElementById('stage');
      const svg = stage?.querySelector('svg');
      const cam = svg?.querySelector('#camera');
      const m = cam?.getScreenCTM?.();
      const sr = stage?.getBoundingClientRect();
      const vb = svg?.getAttribute('viewBox');
      const nodes = svg ? svg.querySelectorAll('*').length : -1;
      return {
        stage: sr && { x: +sr.x.toFixed(1), y: +sr.y.toFixed(1), w: +sr.width.toFixed(1), h: +sr.height.toFixed(1) },
        viewBox: vb, svgNodes: nodes,
        ctm: m && { a: +m.a.toFixed(5), d: +m.d.toFixed(5), e: +m.e.toFixed(2), f: +m.f.toFixed(2) },
        knightNodes: svg ? svg.querySelectorAll('[data-seat]').length : -1,
        camTransform: cam?.getAttribute('transform') ?? cam?.style?.transform ?? null,
      };
    });
    // Plain screenshot. `animations: 'disabled'` and `locator.screenshot` both hang here:
    // the torch flicker and the boss breathe are infinite WAAPI animations, so "stable"
    // never arrives.
    await pg.screenshot({ path: path.join(OUT, c.name + '.png'), timeout: 15000 });
    if (geom.stage) {
      await pg.screenshot({ path: path.join(OUT, c.name + '-stage.png'), clip: { x: geom.stage.x, y: geom.stage.y, width: geom.stage.w, height: geom.stage.h },
        timeout: 15000 });
    }
    report.push({ ...c, geom, pageErrors: errs.slice(0, 4) });
    console.log(JSON.stringify({ name: c.name, ...geom, errs: errs.slice(0, 2) }));
  } catch (e) { console.log(JSON.stringify({ name: c.name, failed: String(e).slice(0, 200) })); }
  finally { await b.close(); }
}
if (!ONLY.length) fs.writeFileSync(path.join(OUT, 'geometry.json'), JSON.stringify(report, null, 2));
srv.close();
