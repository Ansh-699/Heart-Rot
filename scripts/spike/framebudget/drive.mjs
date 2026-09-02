// Throwaway driver for the frame-budget harness.
//
// FRESH BROWSER PER CASE. docs/perf/render-scale.md §2 records that reusing one page pinned
// every case after the first heavy one to ~55 fps — a compositor-state artefact, not a
// result. Any re-run that reuses a page will reproduce the fake cliff.
//
// Headed system Chrome on X11 :0, so vsync and the GPU compositor are real.
import { createRequire } from 'node:module';
// playwright lives in the npx cache, not in this workspace; resolve it by path rather than
// installing a dependency for a throwaway harness.
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchQuiet } from '../launch.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});

const CASES = JSON.parse(fs.readFileSync(process.env.CASES || path.join(path.dirname(DIR), 'cases.json'), 'utf8'));
const REPS = +(process.env.REPS || 3);
const OUT = process.env.OUT || path.join(path.dirname(DIR), 'results.json');
const PORT = +(process.env.PORT || 8741);

const out = [];
await new Promise((r) => srv.listen(PORT, r));
for (let rep = 0; rep < REPS; rep++) {
  const list = rep % 2 ? [...CASES].reverse() : CASES;   // order effects show up as disagreement
  for (const c of list) {
    const b = await launchQuiet(chromium, { headless: false });
    try {
      const pg = await b.newPage({ viewport: { width: 1024, height: 1024 } });
      const cdp = await pg.context().newCDPSession(pg);
      await cdp.send('Performance.enable');
      await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
      await pg.waitForFunction('window.__ready === true');
      if (c.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: c.cpu });
      const m0 = await cdp.send('Performance.getMetrics');
      const r = await pg.evaluate((o) => window.__run(o), c.opts);
      const m1 = await cdp.send('Performance.getMetrics');
      const d = (k) => {
        const a = m0.metrics.find((x) => x.name === k), z = m1.metrics.find((x) => x.name === k);
        return a && z ? +(z.value - a.value).toFixed(2) : null;
      };
      Object.assign(r, {
        name: c.name, cpu: c.cpu || 1, rep,
        recalcStyle: d('RecalcStyleCount'), layout: d('LayoutCount'),
        styleMs: d('RecalcStyleDuration'), layoutMs: d('LayoutDuration'),
        scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'),
      });
      out.push(r);
      console.log(JSON.stringify(r));
      await pg.close();
    } catch (e) {
      console.error('CASE FAILED', c.name, e.message);
    }
    await b.close();
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
srv.close();
