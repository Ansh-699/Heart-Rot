// THROWAWAY. What each room's scene actually costs in DOM: node counts and total path
// `d` bytes, bucketed by the layer that owns them, plus the per-layer frame cost measured
// by hiding one layer at a time. Answers "name the single most expensive thing".
import { createRequire } from 'node:module';
const req = createRequire(process.env.PW_HOME + '/package.json');
const { chromium } = req('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUIET_ARGS } from '../launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist3');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index3.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = +(process.env.PORT || 8761);
await new Promise((r) => srv.listen(PORT, r));

const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
const pg = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true');

for (const room of ['lobby', 'arena']) {
  await pg.evaluate((o) => window.__run(o), { room, knights: 20, bullets: 14, frames: 60, feedHz: 714 });
  const inv = await pg.evaluate(() => {
    const svg = document.querySelector('#stage svg') || document.querySelector('svg');
    const rows = [];
    // One row per direct child group of the scene root, plus a whole-svg total.
    const walk = (el, depth, label) => {
      const paths = el.querySelectorAll('path');
      let d = 0, sub = 0;
      for (const p of paths) { const s = p.getAttribute('d') || ''; d += s.length; sub += (s.match(/[Mm]/g) || []).length; }
      rows.push({ label, depth, nodes: el.getElementsByTagName('*').length, paths: paths.length, dBytes: d, subpaths: sub });
    };
    walk(svg, 0, 'SVG TOTAL');
    const scan = (parent, depth, prefix) => {
      for (const c of parent.children) {
        if (c.tagName !== 'g') continue;
        const id = c.getAttribute('class') || c.getAttribute('id') || c.tagName;
        const n = c.getElementsByTagName('*').length;
        if (n < 8) continue;
        walk(c, depth, prefix + id);
        if (depth < 2) scan(c, depth + 1, prefix + '  ');
      }
    };
    scan(svg, 1, '');
    return rows;
  });
  console.log('=== ROOM', room);
  for (const r of inv) {
    console.log(`${''.padEnd(r.depth * 2)}${r.label.slice(0, 46).padEnd(48)} nodes=${String(r.nodes).padStart(5)} paths=${String(r.paths).padStart(5)} sub=${String(r.subpaths).padStart(6)} dB=${String(r.dBytes).padStart(7)}`);
  }
}
await pg.close();
await b.close();
srv.close();
