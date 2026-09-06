// Title cards for the showcase, rendered by Chrome with the site's own stylesheet so the
// wordmark is the site's wordmark: Silkscreen in --flesh on the site's ground.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { launchQuiet } from '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/launch.mjs';
const DIR = process.env.DIST, OUT = process.env.OUT; fs.mkdirSync(OUT, { recursive: true });
const css = fs.readdirSync(path.join(DIR, 'assets')).find((f) => f.endsWith('.css'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const page = (body, ground) => `<!doctype html><html><head><meta charset="utf-8"><style>@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
:root{--flesh:#d99aa8;--ink:#dde7f2;--pixel:Silkscreen,monospace;--mono:'IBM Plex Mono',ui-monospace,monospace}
html,body{margin:0;width:1920px;height:1080px;overflow:hidden;background:${ground}}
.card{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding-left:200px;color:var(--ink);white-space:nowrap}
.mark{font:700 128px var(--pixel);color:var(--flesh);letter-spacing:0.08em;line-height:1}
.rule{width:1000px;height:2px;background:color-mix(in srgb,var(--ink) 22%,transparent);margin:34px 0 30px}
.sub{font:30px var(--mono);letter-spacing:0.22em;text-transform:none;color:color-mix(in srgb,var(--ink) 72%,transparent)}
.url{font:38px var(--mono);letter-spacing:0.16em;color:var(--ink);margin-top:6px}
.lower{position:absolute;left:96px;bottom:84px;font:600 40px var(--mono);letter-spacing:0.3em;color:#f4efe6;text-shadow:0 2px 0 #000,0 0 14px rgba(0,0,0,.9)}
</style></head><body>${body}</body></html>`;
const srv = http.createServer((q, s) => { const u = q.url.split('?')[0]; if (u === '/') { s.setHeader('content-type', 'text/html'); return s.end(globalThis.__html); } const f = path.join(DIR, u); if (!fs.existsSync(f)) { s.statusCode = 404; return s.end(); } s.setHeader('content-type', MIME[path.extname(f)] ?? 'application/octet-stream'); fs.createReadStream(f).pipe(s); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const PORT = srv.address().port;
const b = await launchQuiet(chromium, { headless: true, channel: 'chrome' });
const pg = await (await b.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const shoot = async (name, body, ground, alpha) => {
  globalThis.__html = page(body, ground);
  await pg.goto('http://127.0.0.1:' + PORT + '/?' + name, { waitUntil: 'load' });
  await pg.evaluate(() => document.fonts.ready); await pg.waitForTimeout(300);
  await pg.screenshot({ path: path.join(OUT, name + '.png'), omitBackground: alpha });
  console.log('card', name, await pg.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family).join(',')));
};
await shoot('card-open', `<div class="card"><div class="mark">HEARTROT</div><div class="rule"></div><div class="sub">A co-op boss raid on Solana</div></div>`, '#0b0d12', false);
await shoot('card-end', `<div class="card" style="padding-left:1010px"><div class="mark">HEARTROT</div><div class="rule" style="width:760px"></div><div class="url">heartrot.ansht.workers.dev</div><div class="sub" style="font-size:24px;margin-top:18px">Solana devnet · play free in your browser</div></div>`, '#0b0d12', false);
const lowers = ['EVERY MOVE IS A TRANSACTION', 'EVERY ARROW IS A TRANSACTION', '20 RAIDERS. ONE BOSS.', '50 MS SLOTS ON MAGICBLOCK'];
for (const [i, t] of lowers.entries()) await shoot('lower-' + (i + 1), `<div class="lower">${t}</div>`, 'transparent', true);
await b.close(); srv.close();
