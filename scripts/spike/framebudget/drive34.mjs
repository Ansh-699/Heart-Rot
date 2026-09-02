// Throwaway driver for the render-cost A/B. `drive3.mjs` with two changes and nothing else:
//
//  1. it launches through `scripts/spike/launch.mjs` (CLAUDE.md: no harness may put a window
//     on the user's desktop, and off-screen is not free — the flags in there are what keep
//     rAF at full rate once Chrome thinks nobody can see the window);
//  2. `DIR` is an env var, so one sitting can alternate two prebuilt bundles — the control
//     and the candidate — instead of measuring them in two sittings the box's own load
//     drifts between.
//
// Everything else is drive3's method: fresh browser per case, per-case viewport, case order
// reversed on odd reps, `Emulation.setCPUThrottlingRate`, Performance metrics deltas.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchQuiet } from '../launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(HERE, process.env.DIR || 'dist3');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index3.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});

const CASES = JSON.parse(fs.readFileSync(process.env.CASES || path.join(HERE, 'cases34.json'), 'utf8'));
const REPS = +(process.env.REPS || 1);
const OUT = process.env.OUT || path.join(HERE, 'results34.json');
const PORT = +(process.env.PORT || 8752);
const ARM = process.env.ARM || 'x';

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
        await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
        await pg.waitForFunction('window.__ready === true');
        if (c.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: c.cpu });
        if (c.reducedMotion) await pg.emulateMedia({ reducedMotion: 'reduce' });
        const m0 = await cdp.send('Performance.getMetrics');
        const r = await pg.evaluate((o) => window.__run(o), c.opts);
        const m1 = await cdp.send('Performance.getMetrics');
        const d = (k) => {
          const a = m0.metrics.find((x) => x.name === k), z = m1.metrics.find((x) => x.name === k);
          return a && z ? +(z.value - a.value).toFixed(2) : null;
        };
        Object.assign(r, {
          name: `${ARM}:${c.name}`, cpu: c.cpu || 1, rep, vpW: vp.width, vpH: vp.height,
          reducedMotion: !!c.reducedMotion,
          recalcStyle: d('RecalcStyleCount'), layout: d('LayoutCount'),
          styleMs: d('RecalcStyleDuration'), layoutMs: d('LayoutDuration'),
          scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'),
        });
        out.push(r);
        console.log(JSON.stringify(r));
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
