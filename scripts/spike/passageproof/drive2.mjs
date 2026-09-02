// Pass 2: every passage case warmed up first (the FIRST passage in a page pays a ~160 ms
// cold commit that shifts every timestamp), 3 reps each, plus the hidden-document cases
// instrumented to PROVE the document actually went hidden and that rAF stopped.
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
const PORT = +(process.env.PORT || 8762);
await new Promise((r) => srv.listen(PORT, r));

const ARENA = 1, LOBBY = 0, MUSTERING = 1, FIGHTING = 2;

async function open({ reduced = false } = {}) {
  const b = await chromium.launch({
    channel: 'chrome', headless: false,
    args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
           '--disable-features=CalculateNativeWinOcclusion', '--window-position=-32000,-32000'],
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  if (reduced) await pg.emulateMedia({ reducedMotion: 'reduce' });
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e)));
  pg.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errs.push(m.text()); });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await pg.bringToFront();
  await pg.waitForFunction('window.__ready === true');
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
  return {
    frames: sam.length,
    spanMs: sam.at(-1).t,
    frameMs: +(sam.at(-1).t / (sam.length - 1)).toFixed(2),
    // R1: the local knight is in the document on every frame of the beat.
    selfMissingFrames: sam.filter((s) => !s.self).length,
    // R1: and it does not move until it is covered.
    frozenTf: pre[0]?.tf ?? null,
    frozenFrames: cutI < 0 ? sam.length : cutI,
    tfChangesBeforeCut: pre.filter((x, i) => i > 0 && x.tf !== pre[i - 1].tf).length,
    firstMoveMs: jumpI < 0 ? null : sam[jumpI].t,
    firstMoveVeil: jumpI < 0 ? null : { flat: sam[jumpI].flat, mouthA: sam[jumpI].mouthA },
    veilAtFrameBeforeMove: jumpI > 0 ? sam[jumpI - 1].flat : null,
    // R2: exactly one cut, and when.
    cuts: sam.filter((x, i) => i > 0 && x.room !== sam[i - 1].room).map((x, _, __) => x.room).length,
    cutMs: cutI < 0 ? null : sam[cutI].t,
    cutVeil: cutI < 0 ? null : sam[cutI].flat,
    coverStartMs: sam.find((s) => s.flat > 0.02 || s.mouthA > 0.02)?.t ?? null,
    maxFlat: Math.max(...sam.map((s) => s.flat)),
    endRoom: sam.at(-1).room,
    endSelf: sam.at(-1).self,
    endFlat: sam.at(-1).flat,
  };
}

const CASES = [
  { name: 'plain', reduced: false, ms: 1500, script: (z) => [{ at: 0, p: { zone: z } }] },
  { name: 'phase@200', reduced: false, ms: 1500, script: (z) => [{ at: 0, p: { zone: z } }, { at: 200, p: { phase: FIGHTING } }] },
  { name: 'phase@350', reduced: false, ms: 1500, script: (z) => [{ at: 0, p: { zone: z } }, { at: 350, p: { phase: FIGHTING, tick: 9 } }] },
  { name: 'epoch@200', reduced: false, ms: 1500, script: (z) => [{ at: 0, p: { zone: z } }, { at: 200, p: { epoch: 3 } }] },
  { name: 'zoneback@200', reduced: false, ms: 1500, script: (z) => [{ at: 0, p: { zone: z } }, { at: 200, p: { zone: LOBBY } }] },
  { name: 'reduced', reduced: true, ms: 900, script: (z) => [{ at: 0, p: { zone: z } }] },
  { name: 'reduced+phase@40', reduced: true, ms: 900, script: (z) => [{ at: 0, p: { zone: z } }, { at: 40, p: { phase: FIGHTING } }] },
];

const out = {};
for (const c of CASES) {
  const reps = [];
  for (let r = 0; r < 3; r++) {
    const { b, pg, errs } = await open({ reduced: c.reduced });
    await pg.evaluate(WALK);
    await warm(pg);
    const sam = await pg.evaluate(([ms, script]) => window.__hr.run(ms, script), [c.ms, c.script(ARENA)]);
    const a = analyse(sam);
    a.errors = errs;
    reps.push(a);
    if (r === 0) out[c.name + '.samples'] = sam;
    await b.close();
  }
  out[c.name] = reps;
  console.log(c.name, JSON.stringify(reps.map((r) => ({
    fr: r.frames, dt: r.frameMs, miss: r.selfMissingFrames, frozen: r.frozenFrames,
    moves: r.tfChangesBeforeCut, move: r.firstMoveMs, moveVeil: r.firstMoveVeil,
    cut: r.cutMs, cuts: r.cuts, coverStart: r.coverStartMs, endRoom: r.endRoom, endSelf: r.endSelf, err: r.errors,
  }))));
}

// ---------------------------------------------------------------------------
// Hidden document, instrumented.
// ---------------------------------------------------------------------------

/** Ceiling alone: `hold` is set true and NOTHING ever releases it but HOLD_CEILING_MS. */
{
  const { b, ctx, pg, errs } = await open();
  await pg.evaluate(([z]) => window.__hr.set({ mode: 'arena', room: 'arena', zone: z }), [ARENA]);
  await pg.waitForTimeout(400);
  await pg.evaluate(WALK);
  const f0 = await pg.evaluate(() => { window.__hr.holdNow(); return window.__frames(); });
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await other.waitForTimeout(1700);
  const fHidden = await pg.evaluate(() => window.__frames());
  await pg.bringToFront();
  await pg.waitForTimeout(50);
  const sam = await pg.evaluate(() => window.__hr.run(600));
  out.ceilingHidden = {
    visLog: await pg.evaluate(() => window.__vis),
    framesWhileHidden: fHidden - f0,
    selfMissing: sam.filter((s) => !s.self).length,
    distinctTfAfterReturn: new Set(sam.map((s) => s.tf)).size,
    framesAfterReturn: sam.length,
    errors: errs,
  };
  console.log('ceilingHidden', JSON.stringify(out.ceilingHidden));
  await b.close();
}

/** Ceiling alone, VISIBLE: how long the freeze actually lasts. */
{
  const { b, pg, errs } = await open();
  await pg.evaluate(([z]) => window.__hr.set({ mode: 'arena', room: 'arena', zone: z }), [ARENA]);
  await pg.waitForTimeout(400);
  await pg.evaluate(WALK);
  const sam = await pg.evaluate(() => { window.__hr.holdNow(); return window.__hr.run(2000); });
  const first = sam[0].tf;
  const move = sam.find((s) => s.tf !== first);
  out.ceilingVisible = {
    firstSampleMs: sam[0].t, frozenUntilMs: move?.t ?? null,
    frameMs: +(sam.at(-1).t / (sam.length - 1)).toFixed(2),
    selfMissing: sam.filter((s) => !s.self).length,
    tfAfter: new Set(sam.filter((s) => move && s.t >= move.t).map((s) => s.tf)).size,
    errors: errs,
  };
  console.log('ceilingVisible', JSON.stringify(out.ceilingVisible));
  await b.close();
}

/** The whole passage with the tab hidden from inside the cover. */
{
  const { b, ctx, pg, errs } = await open();
  await pg.evaluate(WALK);
  await warm(pg);
  const f0 = await pg.evaluate(([z]) => { window.__hr.set({ zone: z }); return window.__frames(); }, [ARENA]);
  await pg.waitForTimeout(150);
  const atHide = await pg.evaluate(() => window.__hr.sample());
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await other.waitForTimeout(1800);
  const fHidden = await pg.evaluate(() => window.__frames());
  await pg.bringToFront();
  await pg.waitForTimeout(50);
  const sam = await pg.evaluate(() => window.__hr.run(800));
  out.passageHidden = {
    visLog: await pg.evaluate(() => window.__vis),
    atHide, framesWhileHidden: fHidden - f0,
    onReturn: sam[0], onEnd: sam.at(-1),
    selfMissing: sam.filter((s) => !s.self).length,
    distinctTf: new Set(sam.map((s) => s.tf)).size,
    animsLeft: await pg.evaluate(() => window.__hr.anims()),
    errors: errs,
  };
  console.log('passageHidden', JSON.stringify(out.passageHidden).slice(0, 700));
  await b.close();
}

/** Baseline for `animsLeft`: a healthy beat, run to completion, visible throughout. */
{
  const { b, pg, errs } = await open();
  await pg.evaluate(WALK);
  await warm(pg);
  await pg.evaluate(([z]) => window.__hr.set({ zone: z }), [ARENA]);
  await pg.waitForTimeout(2000);
  out.animsAfterHealthyBeat = { anims: await pg.evaluate(() => window.__hr.anims()), errors: errs };
  console.log('animsAfterHealthyBeat', JSON.stringify(out.animsAfterHealthyBeat));
  await b.close();
}

/** Cleanup release: tear the tree down mid-cover. */
{
  const { b, pg, errs } = await open();
  await pg.evaluate(WALK);
  await warm(pg);
  await pg.evaluate(([z]) => window.__hr.set({ zone: z }), [ARENA]);
  await pg.waitForTimeout(220);
  const mid = await pg.evaluate(() => ({ s: window.__hr.sample(), anims: window.__hr.anims() }));
  await pg.evaluate(() => window.__hr.set({ mode: 'none' }));
  await pg.waitForTimeout(120);
  const after = await pg.evaluate(() => window.__hr.anims());
  await pg.evaluate(() => window.__hr.set({ mode: 'passage' }));
  await pg.waitForTimeout(500);
  const back = await pg.evaluate(() => window.__hr.run(500));
  out.cleanup = {
    midCover: mid, animsAfterUnmount: after,
    remount: { room: back.at(-1).room, self: back.at(-1).self, distinctTf: new Set(back.map((s) => s.tf)).size },
    errors: errs,
  };
  console.log('cleanup', JSON.stringify(out.cleanup).slice(0, 500));
  await b.close();
}

fs.writeFileSync(path.join(HERE, 'results2.json'), JSON.stringify(out, null, 1));
srv.close();
console.log('WROTE results2.json');
