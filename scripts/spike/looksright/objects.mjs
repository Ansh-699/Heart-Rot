// Throwaway (task: art-judge). Enumerates every drawn SVG leaf in each room, in WORLD
// units via getBBox(), and classifies it against the walkable bitboard. Answers "count the
// obstacles on the playable floor" from the node graph rather than from a pixel heuristic.
import { createRequire } from 'node:module';
const require_ = createRequire(process.env.PW_HOME + '/x.cjs');
const { chromium } = require_('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';

const DIR = '/tmp/looksright-dist';
const OUT = '/home/anshtyagi/Documents/pixel-artgame/docs/art/shipped';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = 8913;
await new Promise((r) => srv.listen(PORT, r));

const out = {};
for (const room of ['lobby', 'arena']) {
  const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
  const pg = await b.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });
  await pg.evaluate(async () => { await window.__store.signIn(); await window.__store.join(); });
  await pg.evaluate(([r]) => window.__scene(r, { seats: 1, bullets: 0 }), [room]);
  await pg.waitForTimeout(2400);
  await pg.evaluate(([r]) => window.__scene(r, { seats: 1, bullets: 0 }), [room]);
  await pg.waitForTimeout(1400);
  out[room] = await pg.evaluate((roomName) => {
    const root = document.querySelector(roomName === 'lobby' ? '#waiting-room' : '#boss-arena')
      || document.querySelector('#camera');
    const svg = document.querySelector('#stage svg');
    // world = the svg's own user space (#camera rests at identity), so getBBox on any leaf
    // under it is already world units.
    const leaves = [];
    const walk = (n, chain) => {
      for (const k of n.children) {
        const tag = k.tagName.toLowerCase();
        const id = k.id || k.getAttribute('class') || '';
        const c = id ? chain.concat(id) : chain;
        if (tag === 'g' || tag === 'defs' || tag === 'clippath' || tag === 'lineargradient'
            || tag === 'radialgradient' || tag === 'filter' || tag === 'mask' || tag === 'pattern') {
          if (tag === 'g') walk(k, c);
          continue;
        }
        // getBBox() is the element's OWN user space and ignores every ancestor transform,
        // so a prop positioned by a translate on its group reads at the origin. The screen
        // rect mapped back through the svg root's CTM is the only correct world box.
        const r = k.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) continue;
        const M = svg.getScreenCTM();
        const w0 = { x: (r.left - M.e) / M.a, y: (r.top - M.f) / M.d };
        const w1 = { x: (r.right - M.e) / M.a, y: (r.bottom - M.f) / M.d };
        const cs = getComputedStyle(k);
        leaves.push({
          tag, chain: c.join('>'), id: k.id || null,
          x: +w0.x.toFixed(1), y: +w0.y.toFixed(1),
          w: +(w1.x - w0.x).toFixed(1), h: +(w1.y - w0.y).toFixed(1),
          fill: cs.fill, opacity: +cs.opacity, fillOpacity: +cs.fillOpacity, display: cs.display,
          d: (k.getAttribute('d') || '').length,
        });
      }
    };
    walk(root, [root.id || 'root']);
    return { rootId: root.id, total: leaves.length, leaves };
  }, room);
  console.log(room, out[room].rootId, out[room].total);
  await b.close();
}
fs.writeFileSync(path.join(OUT, 'objects.json'), JSON.stringify(out, null, 2));
srv.close();
