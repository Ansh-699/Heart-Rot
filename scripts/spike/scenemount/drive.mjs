// Throwaway driver: does the arena survive the gate? (docs/review/render.md finding 1)
//
// Real Chrome, real React 19.2.8, the real App tree. The measurement is DOM identity:
// hold a reference to the SVG the renderer built during the LOBBY, flip the local seat's
// zone to ZONE_ARENA, and ask the browser whether that same element is still connected.
// A portal remount replaces every node under #stage, so the held node goes stale.
//
// Run (playwright lives in the npx cache, not this workspace; node_modules is a symlink to
// app/node_modules and without it vite cannot resolve react):
//   cd scripts/spike/scenemount && npx vite build \
//     && PW_HOME=/home/anshtyagi/.npm/_npx/9833c18b2d85bc59 node drive.mjs
//   ... SHOT=/tmp/fight.png to also write a screenshot of the fight framing.
//   ... devcheck.mjs does the other half: `npx vite` in app/ on :5211, then run it, which
//       is the only pass that executes every module's `import.meta.env.DEV` self-check.
//
// Proven discriminating: keying the #stage div on `screen` (the pre-fix defect) turns every
// identity assertion below false.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUIET_ARGS } from '../launch.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((q, s) => {
  const f = path.join(DIR, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'text/plain' });
  fs.createReadStream(f).pipe(s);
});
const PORT = +(process.env.PORT || 8749);
await new Promise((r) => srv.listen(PORT, r));

const b = await chromium.launch({ channel: 'chrome', headless: process.env.HEADED ? false : true, args: [...QUIET_ARGS] });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const logs = [];
pg.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
pg.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', null, { timeout: 20000 });

const result = await pg.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const store = window.__store;
  const { ZONE_ARENA, ZONE_LOBBY } = window.__ZONE;

  // Onboarding -> select -> lobby, through the real store actions.
  await store.signIn();
  await store.join();
  window.__world(ZONE_LOBBY);
  await sleep(400);

  const stage = document.getElementById('stage');
  const svgLobby = stage && stage.querySelector('svg');
  const sceneLobby = svgLobby && svgLobby.querySelector('#camera > g');
  const before = {
    screen: document.querySelector('.hud') ? 'arena' : 'lobby',
    hasStage: !!stage,
    svg: !!svgLobby,
    scenePaths: sceneLobby ? sceneLobby.querySelectorAll('path').length : 0,
  };

  // THE GATE. Nothing else changes: same arena account, same boss, one seat's zone byte.
  window.__world(ZONE_ARENA);
  await sleep(600);

  const stage2 = document.getElementById('stage');
  const svgAfter = stage2 && stage2.querySelector('svg');
  return {
    before,
    stageSameNode: stage === stage2,
    stageStillConnected: !!stage && stage.isConnected,
    svgSameNode: svgLobby === svgAfter,
    svgStillConnected: !!svgLobby && svgLobby.isConnected,
    sceneStillConnected: !!sceneLobby && sceneLobby.isConnected,
    scenePathsAfter: sceneLobby ? sceneLobby.querySelectorAll('path').length : 0,
    seatCountAfter: svgAfter ? svgAfter.querySelectorAll('#camera g[style*="will-change"]').length : 0,
    svgCountUnderStage: stage2 ? stage2.querySelectorAll('svg').length : 0,
  };
});

if (process.env.SHOT) {
  await pg.evaluate(() => window.__world(window.__ZONE.ZONE_ARENA, window.__PHASE.PHASE_FIGHTING));
  await new Promise((r) => setTimeout(r, 800));
  const stage = await pg.$('#stage');
  await stage.screenshot({ path: process.env.SHOT });
}
console.log(JSON.stringify(result, null, 2));
if (logs.length) console.log('--- page log ---\n' + logs.slice(0, 25).join('\n'));
const pass = result.stageSameNode && result.svgSameNode && result.svgStillConnected &&
             result.sceneStillConnected && result.svgCountUnderStage === 1;
console.log(pass ? 'PASS: the stage, the svg and SCENE all survived the gate — one mount.'
                 : 'FAIL: something under #stage was rebuilt at the gate.');
await b.close(); srv.close();
process.exit(pass ? 0 : 1);
