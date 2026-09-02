// Throwaway driver for the passage proof. Headed system Chrome on :0 so rAF is real vsync
// and WAAPI runs on a real compositor. One fresh browser per case.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = +(process.env.PORT || 8761);
await new Promise((r) => srv.listen(PORT, r));

const ZONE_ARENA = 1, ZONE_LOBBY = 0;
const PHASE_MUSTERING = 1, PHASE_FIGHTING = 2;

async function open({ reduced = false } = {}) {
  const b = await chromium.launch({
    channel: 'chrome',
    headless: false,
    // Chrome throttles rAF in an occluded or backgrounded window, which silently turns a
    // per-frame sampler into a 50-190 ms one. Measured: without these the same case ran at
    // 12 frames/1.7 s.
    args: [
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-position=-32000,-32000',
    ],
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  if (reduced) await pg.emulateMedia({ reducedMotion: 'reduce' });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await pg.bringToFront();
  await pg.waitForFunction('window.__ready === true');
  return { b, ctx, pg, errs };
}

const out = {};
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v).slice(0, 400)); };

// --- helpers over a sample array ------------------------------------------
function digest(sam) {
  const cuts = [];
  for (let i = 1; i < sam.length; i++) if (sam[i].room !== sam[i - 1].room) cuts.push({ t: sam[i].t, from: sam[i - 1].room, to: sam[i].room, flat: sam[i].flat, mouthA: sam[i].mouthA, self: sam[i].self });
  const gone = sam.filter((s) => !s.self);
  const tfs = [...new Set(sam.map((s) => s.tf))];
  return {
    frames: sam.length,
    spanMs: sam[sam.length - 1].t,
    medianFrameMs: +(sam[sam.length - 1].t / (sam.length - 1)).toFixed(2),
    selfMissingFrames: gone.length,
    selfMissingAt: gone.slice(0, 8).map((s) => s.t),
    cuts,
    firstFlatFull: sam.find((s) => s.flat >= 0.99)?.t ?? null,
    lastFlatFull: [...sam].reverse().find((s) => s.flat >= 0.99)?.t ?? null,
    distinctTransforms: tfs.length,
    seatsMin: Math.min(...sam.map((s) => s.seats)),
    seatsMax: Math.max(...sam.map((s) => s.seats)),
    // frames between the room cut and the veil clearing back to transparent
    endFlat: sam[sam.length - 1].flat,
    endRoom: sam[sam.length - 1].room,
    endSelf: sam[sam.length - 1].self,
  };
}

// Move the local seat every frame so a FROZEN hold is observable as an unchanging
// transform and a released one as a moving one.
const WALK = `(async () => {
  let stop = false;
  const walk = () => { if (stop) return; window.__hr.push(Math.floor(Math.random()*4)); requestAnimationFrame(walk); };
  requestAnimationFrame(walk);
  window.__stopWalk = () => { stop = true; };
})()`;

// ---------------------------------------------------------------------------
// A. the passage, per frame
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open();
  await pg.evaluate(WALK);
  const commit = await pg.evaluate(([z]) => window.__hr.setSync({ zone: z }), [ZONE_ARENA]);
  log('A.commitSample', commit);
  await pg.evaluate(() => window.__hr.set({ zone: 0 }));
  await pg.waitForTimeout(2500);
  const sam = await pg.evaluate(([z]) => window.__hr.run(1700, [{ at: 0, p: { zone: z } }]), [ZONE_ARENA]);
  log('A.digest', digest(sam));
  out['A.samples'] = sam;
  log('A.errors', errs);
  await b.close();
}

// ---------------------------------------------------------------------------
// B. a phase change fired DURING the cover
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open();
  await pg.evaluate(WALK);
  const sam = await pg.evaluate(([z, ph]) => window.__hr.run(1700, [
    { at: 0, p: { zone: z } },
    { at: 120, p: { phase: ph } },
    { at: 240, p: { phase: ph, tick: 7 } },
  ]), [ZONE_ARENA, PHASE_FIGHTING]);
  log('B.digest', digest(sam));
  out['B.samples'] = sam;
  log('B.errors', errs);
  await b.close();
}

// ---------------------------------------------------------------------------
// C. a feed resync fired DURING the cover
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open();
  await pg.evaluate(WALK);
  const sam = await pg.evaluate(([z]) => window.__hr.run(1700, [
    { at: 0, p: { zone: z } },
    { at: 150, p: { epoch: 1 } },
  ]), [ZONE_ARENA]);
  log('C.digest', digest(sam));
  log('C.errors', errs);
  await b.close();
}

// ---------------------------------------------------------------------------
// D. release 2 — effect cleanup. Tear the tree down mid-cover.
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open();
  await pg.evaluate(WALK);
  const before = await pg.evaluate(([z]) => window.__hr.run(300, [{ at: 0, p: { zone: z } }]), [ZONE_ARENA]);
  const midAnims = await pg.evaluate(() => window.__hr.anims());
  await pg.evaluate(() => window.__hr.set({ mode: 'none' }));
  await pg.waitForTimeout(100);
  const afterAnims = await pg.evaluate(() => window.__hr.anims());
  await pg.evaluate(() => window.__hr.set({ mode: 'passage' }));
  await pg.waitForTimeout(400);
  const back = await pg.evaluate(() => window.__hr.run(500));
  log('D', {
    coverUpAtTeardown: before[before.length - 1].flat,
    animsDuringCover: midAnims,
    animsAfterUnmount: afterAnims,
    remountRoom: back[back.length - 1].room,
    remountSelf: back[back.length - 1].self,
    remountDistinctTransforms: new Set(back.map((s) => s.tf)).size,
    errors: errs,
  });
  await b.close();
}

// ---------------------------------------------------------------------------
// E. release 3 — the 1000 ms wall-clock ceiling, isolated on the real Arena
//    with a hold that is never released.
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open();
  await pg.evaluate(([z]) => window.__hr.set({ mode: 'arena', room: 'arena', zone: z }), [ZONE_ARENA]);
  await pg.waitForTimeout(300);
  await pg.evaluate(WALK);
  // Hold goes up and the sampler starts in the SAME task, so `frozenForMs` is measured
  // against `heldAt` and not against a round trip.
  // `run`'s t0 is its first rAF, so every t below is measured from at most one frame after
  // `heldAt`.
  const sam = await pg.evaluate(() => { window.__hr.holdNow(); return window.__hr.run(2000); });
  const first = sam[0].tf;
  const move = sam.find((s) => s.tf !== first);
  log('E', {
    frames: sam.length,
    medianFrameMs: +(sam[sam.length - 1].t / (sam.length - 1)).toFixed(2),
    firstSampleAtMs: sam[0].t,
    frozenUntilMs: move ? move.t : null,
    distinctTransformsAfterRelease: new Set(sam.filter((s) => move && s.t >= move.t).map((s) => s.tf)).size,
    selfMissingFrames: sam.filter((s) => !s.self).length,
    errors: errs,
  });
  await b.close();
}

// ---------------------------------------------------------------------------
// F. the ceiling with the document HIDDEN across it
// ---------------------------------------------------------------------------
{
  const { b, ctx, pg, errs } = await open();
  await pg.evaluate(([z]) => window.__hr.set({ mode: 'arena', room: 'arena', zone: z, hold: true }), [ZONE_ARENA]);
  await pg.waitForTimeout(200);
  await pg.evaluate(WALK);
  const t0 = await pg.evaluate(() => { window.__t0 = performance.now(); return document.visibilityState; });
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await other.waitForTimeout(1600);
  await pg.bringToFront();
  const vis = await pg.evaluate(() => ({ vis: document.visibilityState, since: performance.now() - window.__t0 }));
  const sam = await pg.evaluate(() => window.__hr.run(600));
  log('F', {
    startVisibility: t0,
    visibilityOnReturn: vis,
    framesAfterReturn: sam.length,
    distinctTransformsAfterReturn: new Set(sam.map((s) => s.tf)).size,
    selfPresent: sam.every((s) => s.self),
    errors: errs,
  });
  await b.close();
}

// ---------------------------------------------------------------------------
// G. the whole passage with the tab hidden mid-cover
// ---------------------------------------------------------------------------
{
  const { b, ctx, pg, errs } = await open();
  await pg.evaluate(WALK);
  await pg.evaluate(([z]) => window.__hr.set({ zone: z }), [ZONE_ARENA]);
  await pg.waitForTimeout(120);
  const mid = await pg.evaluate(() => window.__hr.sample());
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await other.waitForTimeout(1800);
  await pg.bringToFront();
  const sam = await pg.evaluate(() => window.__hr.run(900));
  log('G', {
    atHide: mid,
    onReturnFirst: sam[0],
    onReturnLast: sam[sam.length - 1],
    selfMissingFrames: sam.filter((s) => !s.self).length,
    distinctTransforms: new Set(sam.map((s) => s.tf)).size,
    animsLeft: await pg.evaluate(() => window.__hr.anims()),
    errors: errs,
  });
  await b.close();
}

// ---------------------------------------------------------------------------
// H. the sampler's own falsification, and the PRE-FIX filter
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open();
  const before = await pg.evaluate(() => window.__hr.sample());
  // Real Arena, room still room A, local seat already ZONE_ARENA, `hold` explicitly FALSE.
  // Pre-fix this unmounted the knight; today `Arena.crossing` derives the hold itself.
  const crossing = await pg.evaluate(([z]) => window.__hr.setSync({ mode: 'arena', room: 'lobby', zone: z, hold: false }), [ZONE_ARENA]);
  await pg.waitForTimeout(250);
  const settled = await pg.evaluate(() => window.__hr.sample());
  // The pure R3 filter on the same slots, with and without the hold seat.
  const pure = await pg.evaluate(() => window.__hr.prefix());
  // And the falsification: can this sampler report an ABSENT local knight at all?
  const gone = await pg.evaluate(() => window.__hr.setSync({ occ: false }));
  const back = await pg.evaluate(() => window.__hr.setSync({ occ: true }));
  const none = await pg.evaluate(() => window.__hr.setSync({ mode: 'none' }));
  log('H', { before, crossingCommit: crossing, crossingSettled: settled, pureFilter: pure, unoccupied: gone, reoccupied: back, unmounted: none, errors: errs });
  await b.close();
}

// ---------------------------------------------------------------------------
// I. reduced motion — the short cover still owns the cut
// ---------------------------------------------------------------------------
{
  const { b, pg, errs } = await open({ reduced: true });
  await pg.evaluate(WALK);
  const sam = await pg.evaluate(([z, ph]) => window.__hr.run(700, [
    { at: 0, p: { zone: z } },
    { at: 33, p: { phase: ph } },
  ]), [ZONE_ARENA, PHASE_FIGHTING]);
  log('I.digest', digest(sam));
  out['I.samples'] = sam;
  log('I.errors', errs);
  await b.close();
}

fs.writeFileSync(path.join(HERE, 'results.json'), JSON.stringify(out, null, 1));
srv.close();
console.log('WROTE results.json');
