// A10 re-proof of the passage against the PAINTED rooms. drive3's passage cases and
// analysis, with three changes: it launches through scripts/spike/launch.mjs (CLAUDE.md:
// off-screen AND un-throttled; never `bringToFront`), it records the worst frame gap per
// run, and CPU=<n> applies Chrome's CPU throttle so the plan's "no frame > 16.7 ms at 6x"
// row can be read off. The hidden-document cases are not repeated here: nothing in this
// round touched the hold or its releases.
//
//   cd scripts/spike/passageproof
//   ../../../app/node_modules/.bin/vite build --mode development   # DEV asserts live
//   PW_HOME=... node drive5.mjs                                      # -> results5.json
//   ../../../app/node_modules/.bin/vite build && CPU=6 PW_HOME=... OUT=results5-cpu6.json node drive5.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/package.json')('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchQuiet } from '../launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = +(process.env.PORT || 8765);
const CPU = +(process.env.CPU || 1);
const REPS = +(process.env.REPS || 3);
const OUT = process.env.OUT || path.join(HERE, 'results5.json');
await new Promise((r) => srv.listen(PORT, r));

// Real values, read off packages/client/src/layout.ts.
const ARENA = 1, LOBBY = 0, MUSTERING = 6, FIGHTING = 1;

async function open({ reduced = false } = {}) {
  const b = await launchQuiet(chromium, { headless: false });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  if (reduced) await pg.emulateMedia({ reducedMotion: 'reduce' });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await pg.waitForFunction('window.__ready === true');
  if (CPU > 1) {
    const cdp = await ctx.newCDPSession(pg);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  }
  return { b, ctx, pg, errs };
}

const WALK = `(() => { const w = () => { window.__hr.push(Math.floor(Math.random()*4)); requestAnimationFrame(w); }; requestAnimationFrame(w); })()`;

/** One warmed passage: flip, let the beat finish, flip back, settle. */
async function warm(pg) {
  await pg.evaluate(([z]) => window.__hr.set({ zone: z }), [ARENA]);
  await pg.waitForTimeout(1800);
  await pg.evaluate(([z, ph]) => window.__hr.set({ zone: z, phase: ph, epoch: 0, tick: 0 }), [LOBBY, MUSTERING]);
  await pg.waitForTimeout(1200);
}

function analyse(sam) {
  const cutI = sam.findIndex((x, i) => i > 0 && x.room !== sam[i - 1].room);
  const jumpI = sam.findIndex((x, i) => i > 0 && x.tf !== sam[i - 1].tf);
  const pre = cutI < 0 ? sam : sam.slice(0, cutI);
  const gaps = sam.slice(1).map((x, i) => x.t - sam[i].t);
  return {
    frames: sam.length,
    spanMs: sam.at(-1).t,
    frameMs: +(sam.at(-1).t / (sam.length - 1)).toFixed(2),
    maxGapMs: +Math.max(...gaps).toFixed(1),
    gapsOver16_7: gaps.filter((g) => g > 16.7).length,
    // R1: the local knight is in the document on every frame, and frozen until covered.
    selfMissingFrames: sam.filter((s) => !s.self).length,
    frozenFrames: cutI < 0 ? sam.length : cutI,
    tfChangesBeforeCut: pre.filter((x, i) => i > 0 && x.tf !== pre[i - 1].tf).length,
    firstMoveMs: jumpI < 0 ? null : sam[jumpI].t,
    veilAtFrameBeforeMove: jumpI > 0 ? sam[jumpI - 1].flat : null,
    // R2: exactly one cut, under the veil.
    cuts: sam.filter((x, i) => i > 0 && x.room !== sam[i - 1].room).length,
    cutMs: cutI < 0 ? null : sam[cutI].t,
    cutVeil: cutI < 0 ? null : sam[cutI].flat,
    maxFlat: +Math.max(...sam.map((s) => s.flat)).toFixed(3),
    endRoom: sam.at(-1).room,
    endSelf: sam.at(-1).self,
    endFlat: sam.at(-1).flat,
  };
}

const CASES = [
  { name: 'long.plain', reduced: false, ms: 1700, script: (z) => [{ at: 0, p: { zone: z } }] },
  { name: 'long.phase@120', reduced: false, ms: 1700, script: (z) => [{ at: 0, p: { zone: z } }, { at: 120, p: { phase: FIGHTING } }] },
  { name: 'long.phase@300', reduced: false, ms: 1700, script: (z) => [{ at: 0, p: { zone: z } }, { at: 300, p: { phase: FIGHTING, tick: 9 } }] },
  { name: 'long.phase+tick@100,250,400', reduced: false, ms: 1700, script: (z) => [{ at: 0, p: { zone: z } }, { at: 100, p: { phase: FIGHTING } }, { at: 250, p: { tick: 4 } }, { at: 400, p: { tick: 8 } }] },
  { name: 'long.epoch@200', reduced: false, ms: 1700, script: (z) => [{ at: 0, p: { zone: z } }, { at: 200, p: { epoch: 3 } }] },
  { name: 'long.zoneback@200', reduced: false, ms: 1700, script: (z) => [{ at: 0, p: { zone: z } }, { at: 200, p: { zone: LOBBY } }] },
  { name: 'live.plain', reduced: false, open: FIGHTING, ms: 1200, script: (z) => [{ at: 0, p: { zone: z } }] },
  { name: 'live.phase@60', reduced: false, open: FIGHTING, ms: 1200, script: (z) => [{ at: 0, p: { zone: z } }, { at: 60, p: { tick: 5 } }] },
  { name: 'reduced', reduced: true, ms: 900, script: (z) => [{ at: 0, p: { zone: z } }] },
  { name: 'reduced.phase@40', reduced: true, ms: 900, script: (z) => [{ at: 0, p: { zone: z } }, { at: 40, p: { phase: FIGHTING } }] },
];

const out = { cpu: CPU, reps: REPS };
let totalFrames = 0;
for (const c of CASES) {
  const reps = [];
  for (let r = 0; r < REPS; r++) {
    const { b, pg, errs } = await open({ reduced: c.reduced });
    await pg.evaluate(WALK);
    await warm(pg);
    if (c.open !== undefined) { await pg.evaluate(([ph]) => window.__hr.set({ phase: ph }), [c.open]); await pg.waitForTimeout(300); }
    // The one node this beat BORROWS from room A, counted from outside the product's
    // DEV assert: exactly one portcullis, and it takes the LIFT (a transform animation)
    // during a long beat. Sampled at 300 ms, inside the 460 ms cover.
    const probe = pg.evaluate(() => new Promise((res) => setTimeout(() => {
      const all = document.querySelectorAll('#gate-portcullis');
      const anims = all[0] ? all[0].getAnimations().map((a) => a.playState) : [];
      res({ portcullis: all.length, portcullisAnims: anims });
    }, 300)));
    const sam = await pg.evaluate(([ms, script]) => window.__hr.run(ms, script), [c.ms, c.script(ARENA)]);
    const a = analyse(sam);
    Object.assign(a, await probe);
    a.errors = errs;
    reps.push(a);
    totalFrames += sam.length;
    if (r === 0) out[c.name + '.samples'] = sam;
    await b.close();
  }
  out[c.name] = reps;
  console.log(c.name, JSON.stringify(reps.map((r) => ({
    fr: r.frames, dt: r.frameMs, maxGap: r.maxGapMs, over: r.gapsOver16_7, miss: r.selfMissingFrames,
    frozen: r.frozenFrames, moves: r.tfChangesBeforeCut, move: r.firstMoveMs, cut: r.cutMs, cuts: r.cuts,
    cutVeil: r.cutVeil, endRoom: r.endRoom, endSelf: r.endSelf, gate: r.portcullis, gateAnim: r.portcullisAnims, err: r.errors,
  }))));
}
out.totalFrames = totalFrames;
console.log('total frames sampled', totalFrames, 'cpu', CPU);
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
srv.close();
