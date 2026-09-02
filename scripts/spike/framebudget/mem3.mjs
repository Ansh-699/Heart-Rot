// Renderer-process RSS per variant. `performance.memory` reads the JS heap only (~5 MB in
// every case here) and says nothing about path geometry or raster tiles, so walk /proc.
//
// RSS of the renderers belonging to THIS launch only: the box runs dozens of other Chrome
// renderers and summing every `--type=renderer` measures the desktop, not the game.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/package.json')('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'dist3');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index3.html' : q.url.split('?')[0]);
  if (!fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});

function scan() {
  const ppid = new Map(), cmd = new Map(), rss = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ppid.set(+d, +tail[1]);
      rss.set(+d, (+tail[21] * 4096) / 1048576);
      cmd.set(+d, fs.readFileSync(`/proc/${d}/cmdline`, 'utf8'));
    } catch { /* exited mid-scan */ }
  }
  return { ppid, cmd, rss };
}

function treeRssMB(roots) {
  const { ppid, cmd, rss } = scan();
  const mine = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const [pid, par] of ppid) if (mine.has(par) && !mine.has(pid)) { mine.add(pid); grew = true; }
  }
  let tree = 0, rend = 0;
  for (const pid of mine) {
    tree += rss.get(pid) || 0;
    if ((cmd.get(pid) || '').includes('--type=renderer')) rend += rss.get(pid) || 0;
  }
  return { treeMB: +tree.toFixed(1), rendererMB: +rend.toFixed(1), procs: mine.size };
}

const chromePids = () => {
  const out = new Set();
  const { cmd } = scan();
  for (const [pid, c] of cmd) if (/chrome|chromium/i.test(c)) out.add(pid);
  return out;
};

const VARIANTS = [
  ['room-arena-empty', { room: 'arena', knights: 0, bullets: 0, arrows: false, frames: 60 }],
  ['room-lobby-empty', { room: 'lobby', knights: 0, bullets: 0, arrows: false, frames: 60 }],
  ['boss-only', { layer: 'boss', frames: 60 }],
  ['arena-k20', { room: 'arena', knights: 20, bullets: 128, frames: 60 }],
  ['lobby-k20', { room: 'lobby', knights: 20, bullets: 128, frames: 60 }],
  ['arena-k20-feed714', { room: 'arena', knights: 20, bullets: 128, feedHz: 714, frames: 60 }],
  ['passage-k20', { room: 'passage', knights: 20, bullets: 128, feedHz: 714, frames: 200 }],
  ['arena-k20-nochrome', { room: 'arena', knights: 20, bullets: 128, feedHz: 714, frames: 60, hud: false, dev: false }],
];

const PORT = +(process.env.PORT || 8766);
await new Promise((r) => srv.listen(PORT, r));
for (const [name, o] of VARIANTS) {
  const pre = chromePids();
  const b = await chromium.launch({ channel: 'chrome', headless: false });
  const pg = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await pg.waitForFunction('window.__ready === true');
  const roots = [...chromePids()].filter((p) => !pre.has(p));
  const before = treeRssMB(roots);
  const r = await pg.evaluate((x) => window.__run(x), o);
  await pg.waitForTimeout(1500);   // let raster tiles settle
  const after = treeRssMB(roots);
  console.log(JSON.stringify({ name, nodes: r.nodes, jsHeapMB: r.jsHeapMB, before, after }));
  await b.close();
  await new Promise((z) => setTimeout(z, 500));
}
srv.close();
