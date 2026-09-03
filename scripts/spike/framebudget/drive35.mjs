// The frame-budget driver for pass 3, and `drive34.mjs` with three additions:
//
//  1. a CPU PROFILE per case (CDP `Profiler`, 250 µs sampling) aggregated to self time by
//     function and to inclusive time for the named hot paths, so a bottleneck is a line in
//     a file and not a guess from the code — this is what turns "the fight is choppy" into
//     "X ms of every frame is Y";
//  2. the page's own long-task count and heap growth over the measured window (added to
//     `main3.tsx`'s `__run`), so a hitch the p95 averages away is still counted;
//  3. per-notification and per-frame ratios for the style/layout counters, which the raw
//     deltas hid behind the run length.
//
// Same method otherwise: fresh browser per case through `launch.mjs` (off-screen, full-rate
// rAF), per-case viewport and CPU throttle, case order reversed on odd reps. `PROFILE=0`
// skips the profiler — it costs ~5 % on the throttled arm and should be off for the
// headline numbers and on for attribution.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchQuiet } from '../launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, process.env.DIR || 'dist35');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index3.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});

const CASES = JSON.parse(fs.readFileSync(process.env.CASES || path.join(HERE, 'cases35.json'), 'utf8'));
const REPS = +(process.env.REPS || 1);
const OUT = process.env.OUT || path.join(HERE, 'results35.json');
const PORT = +(process.env.PORT || 8752);
const ARM = process.env.ARM || 'x';
const PROFILE = process.env.PROFILE !== '0';
/** `TRACE=1`: a devtools timeline trace, summed by event name, so the sampler's `(program)`
 *  bucket — style, layout, paint, raster — is attributed too. Heavier than the profiler;
 *  attribution runs only. */
const TRACE = process.env.TRACE === '1';
const TOP = +(process.env.TOP || 24);
/** Inclusive time is reported for these; self time for everything. */
const INCLUSIVE = (process.env.INCLUSIVE ||
  'frame,paint,step,deliverEncoded,fromBase64,decodePlayers,decodeArena,decodeBoss,setWorld,' +
  'performWorkOnRoot,commitRoot,renderRootSync,Arena,KnightBody,Shot,Card,Top,Hud,DevPanel,' +
  'visibleBullets,roomSeats,knightDrawOrder,foldTracks,useSeatInterpolation,sameSeat,advance,' +
  '(garbage collector),(program),(idle)').split(',');

/** Self and inclusive milliseconds by function, from one `Profiler.stop` payload. */
function aggregate(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = (n) => {
    const cf = n.callFrame;
    const file = cf.url ? cf.url.split('/').pop() : '';
    return `${cf.functionName || '(anonymous)'}${file ? ` ${file}:${cf.lineNumber + 1}` : ''}`;
  };
  const self = new Map();
  const incl = new Map();
  let total = 0;
  const { samples, timeDeltas } = profile;
  for (let i = 0; i < samples.length; i++) {
    const dt = timeDeltas[i] ?? 0;
    total += dt;
    const node = byId.get(samples[i]);
    if (!node) continue;
    const k = keyOf(node);
    self.set(k, (self.get(k) ?? 0) + dt);
    // Inclusive: every distinct function on the stack gets the sample once.
    const seen = new Set();
    for (let id = samples[i]; id !== undefined; id = parent.get(id)) {
      const fn = byId.get(id)?.callFrame.functionName || '(anonymous)';
      if (seen.has(fn)) continue;
      seen.add(fn);
      if (INCLUSIVE.includes(fn)) incl.set(fn, (incl.get(fn) ?? 0) + dt);
    }
  }
  const ms = (us) => +(us / 1000).toFixed(1);
  const pct = (us) => +((100 * us) / total).toFixed(1);
  return {
    profileMs: ms(total),
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, us]) => [k, ms(us), pct(us)]),
    inclusive: Object.fromEntries([...incl].sort((a, b) => b[1] - a[1]).map(([k, us]) => [k, [ms(us), pct(us)]])),
  };
}

/**
 * The rendering pipeline out of a trace: main-thread style/layout/paint and the
 * compositor's raster, in ms, by event name, plus every Layout that script FORCED (one
 * with a stack) bucketed by the innermost frame — the second style recalc per frame has to
 * come from somewhere, and this is what names it.
 */
function summarise(events) {
  const byName = new Map();
  const forced = new Map();
  let layouts = 0;
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur);
    if (e.name === 'Layout') {
      layouts++;
      const st = e.args?.beginData?.stackTrace;
      if (st && st.length > 0) {
        const f = st[0];
        const k = `${f.functionName || '(anonymous)'} ${(f.url || '').split('/').pop()}:${f.lineNumber}`;
        forced.set(k, (forced.get(k) ?? 0) + 1);
      }
    }
  }
  const ms = (us) => +(us / 1000).toFixed(1);
  const KEEP = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask', 'ImageDecodeTask', 'Commit', 'Layerize',
    'HitTest', 'FunctionCall', 'RunTask', 'RunMicrotasks', 'TimerFire', 'EventDispatch', 'Animation', 'MinorGC', 'MajorGC', 'ScheduleStyleRecalculation'];
  return {
    layouts,
    pipeline: Object.fromEntries(KEEP.filter((k) => byName.has(k)).map((k) => [k, ms(byName.get(k))])),
    forcedLayouts: [...forced].sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

const out = [];
await new Promise((r) => srv.listen(PORT, r));
for (let rep = 0; rep < REPS; rep++) {
  const list = rep % 2 ? [...CASES].reverse() : CASES;
  for (const c of list) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      // Real compositing and raster, so `headless: false` — and still off-screen.
      const b = await launchQuiet(chromium, { headless: false });
      try {
        const vp = c.viewport || { width: 1920, height: 1080 };
        const pg = await b.newPage({ viewport: vp });
        const cdp = await pg.context().newCDPSession(pg);
        await cdp.send('Performance.enable');
        pg.on('pageerror', (e) => console.error('PAGE ERROR', c.name, e.message));
        await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        await pg.waitForFunction('window.__ready === true');
        if (c.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: c.cpu });
        if (c.reducedMotion) await pg.emulateMedia({ reducedMotion: 'reduce' });
        const events = [];
        if (TRACE) {
          cdp.on('Tracing.dataCollected', (m) => events.push(...m.value));
          await cdp.send('Tracing.start', {
            categories: 'devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack',
            transferMode: 'ReportEvents',
          });
        }
        if (PROFILE) {
          await cdp.send('Profiler.enable');
          await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
          await cdp.send('Profiler.start');
        }
        const m0 = await cdp.send('Performance.getMetrics');
        const r = await pg.evaluate((o) => window.__run(o), c.opts);
        const m1 = await cdp.send('Performance.getMetrics');
        const prof = PROFILE ? aggregate((await cdp.send('Profiler.stop')).profile) : null;
        let trace = null;
        if (TRACE) {
          const complete = new Promise((res) => cdp.once('Tracing.tracingComplete', res));
          await cdp.send('Tracing.end');
          await complete;
          trace = summarise(events);
        }
        const d = (k) => {
          const a = m0.metrics.find((x) => x.name === k), z = m1.metrics.find((x) => x.name === k);
          return a && z ? +(z.value - a.value).toFixed(2) : null;
        };
        // The counters cover the whole `__run` (warm-up frames included), so the ratios are
        // against the run's own frame and update counts rather than the measured window's.
        const frames = r.frames + 40;
        Object.assign(r, {
          name: `${ARM}:${c.name}`, cpu: c.cpu || 1, rep, vpW: vp.width, vpH: vp.height,
          reducedMotion: !!c.reducedMotion,
          recalcStyle: d('RecalcStyleCount'), layout: d('LayoutCount'),
          styleMs: d('RecalcStyleDuration'), layoutMs: d('LayoutDuration'),
          scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'),
          recalcPerFrame: +(d('RecalcStyleCount') / frames).toFixed(2),
          layoutPerFrame: +(d('LayoutCount') / frames).toFixed(2),
          heapDeltaMB: +((d('JSHeapUsedSize') ?? 0) / 1048576).toFixed(1),
          ...(prof ? { profile: prof } : {}),
          ...(trace ? { trace } : {}),
        });
        out.push(r);
        const { profile, trace: tr, ...line } = r;
        console.log(JSON.stringify(line));
        if (tr) {
          console.log(`  trace: ${tr.layouts} layouts; ${Object.entries(tr.pipeline).map(([k, v]) => `${k} ${v}ms`).join(', ')}`);
          console.log(`  forced layouts by caller: ${tr.forcedLayouts.map(([k, n]) => `${k} x${n}`).join(' | ') || 'none'}`);
        }
        if (profile) {
          console.log(`  profile ${profile.profileMs} ms sampled; inclusive: ${Object.entries(profile.inclusive).map(([k, [ms, p]]) => `${k} ${ms}ms/${p}%`).join(', ')}`);
          for (const [k, ms, p] of profile.topSelf) console.log(`  ${String(ms).padStart(8)} ms ${String(p).padStart(5)} %  ${k}`);
        }
        await pg.close();
        done = true;
      } catch (e) {
        console.error('CASE FAILED', c.name, 'attempt', attempt, e.message);
      }
      await b.close();
    }
    if (!done) console.error('CASE DROPPED', c.name);
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
srv.close();
