// Throwaway driver, spec-17 edition. FRESH BROWSER PER CASE (render-scale §2: reusing one
// page pins every case after the first heavy one to a fake ~55 fps). Headed system Chrome
// on X11 :0 so vsync and the GPU compositor are real. Per-case viewport, because the room
// now fills the window and the window IS the rasterised area.
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchQuiet } from '../launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist2');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index2.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});

const CASES = JSON.parse(fs.readFileSync(process.env.CASES || path.join(HERE, 'cases17.json'), 'utf8'));
const REPS = +(process.env.REPS || 3);
const OUT = process.env.OUT || path.join(HERE, 'results17.json');
const PORT = +(process.env.PORT || 8743);

const out = [];
await new Promise((r) => srv.listen(PORT, r));
for (let rep = 0; rep < REPS; rep++) {
  const list = rep % 2 ? [...CASES].reverse() : CASES;
  for (const c of list) {
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
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
        name: c.name, cpu: c.cpu || 1, rep, vpW: vp.width, vpH: vp.height,
        reducedMotion: !!c.reducedMotion,
        recalcStyle: d('RecalcStyleCount'), layout: d('LayoutCount'),
        styleMs: d('RecalcStyleDuration'), layoutMs: d('LayoutDuration'),
        scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'),
      });
      out.push(r);
      console.log(JSON.stringify(r));
      if (process.env.SHOT) await pg.screenshot({ path: path.join(HERE, `shot-${c.name}.png`) });
      await pg.close();
      done = true;
    } catch (e) {
      // Headed Chrome on this box occasionally dies during its first launch of a session.
      // Retry rather than lose the cell: a missing case is a hole in the table nobody
      // notices, and a retried one is visible in the rep count.
      console.error('CASE FAILED', c.name, 'attempt', attempt, e.message);
    }
    await b.close();
    }
    if (!done) console.error('CASE DROPPED', c.name);
  }
}
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
srv.close();
