/**
 * Throwaway cold-cache load harness (spec task: bundle).
 *
 * Serves a `dist` over loopback the way Cloudflare Workers static assets do — brotli when
 * the client asks for it, gzip otherwise, and `no-store`, which is what the live worker
 * actually sends today — then drives headless Chrome over CDP with a cold cache and an
 * emulated link, and reports FCP / LCP / DCL / load / TTI-lite plus the bytes pulled.
 *
 *   node scripts/spike/bundle_load.mjs app/dist-art-full app/dist-art-temple-boss
 *
 * Third-party origins are blocked so the number is this bundle and nothing else: the login
 * screen otherwise reaches Privy, whose latency is not ours to measure.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';

const DISTS = process.argv.slice(2);
const REPS = Number(process.env.REPS ?? 5);
const PORT = 8123, CDP = 9444;

const CONDS = {
  lan:  null,
  '4g': { latency: 85,  downloadThroughput: 9_000_000 / 8, uploadThroughput: 3_000_000 / 8 },
  '3g': { latency: 300, downloadThroughput: 1_600_000 / 8, uploadThroughput:   750_000 / 8 },
};
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.map': 'application/json' };

let ROOT = DISTS[0];
/**
 * Every navigation gets its own URL prefix, `/r<n>/assets/...`, rewritten into index.html
 * on the way out. Nothing else defeats Chrome's in-memory cache reliably: a fresh tab,
 * `Network.clearBrowserCache`, `setCacheDisabled(true)` and `cache-control: no-store` all
 * still let reps 2 and 3 answer the entry chunk with `encodedBodySize` 0 - and the entry
 * chunk is the only file that differs between the builds under test, so the A/B measured
 * everything except the thing being measured. Unique URLs cannot be cache hits.
 */
let RUN = 0;
/**
 * Compressing 3 MB at brotli q11 per navigation is slower than the page load, so results
 * are memoised — but the key MUST include the file's identity, not just its bytes. Keying
 * on `length + first 32 bytes` served the FIRST dist's `index.html` for every later dist
 * (every build's html opens with the same 32 bytes and is the same length), so the browser
 * was handed the wrong chunk list, every name 404'd back to index.html, and the second
 * build measured 539.6 KiB instead of 667.8 — one chunk light, exactly the file under test.
 */
const cache = new Map();
const encode = (file, buf, how) => {
  const k = `${how}:${file}:${buf.length}`;
  if (!cache.has(k)) cache.set(k, how === 'br'
    ? brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
    : gzipSync(buf, { level: 9 }));
  return cache.get(k);
};

const server = createServer((req, res) => {
  const path = req.url.split('?')[0].replace(/^\/r\d+\//, '/');
  let file = join(ROOT, path === '/' ? 'index.html' : path);
  if (path !== '/' && (!existsSync(file) || statSync(file).isDirectory())) {
    res.writeHead(404).end();            // never fall back to index.html: an SPA fallback on
    return;                              // a missing chunk turns a harness bug into a number
  }
  let raw = readFileSync(file);
  if (file.endsWith('index.html')) raw = Buffer.from(raw.toString().replaceAll('="/', `="/r${RUN}/`));
  const ae = req.headers['accept-encoding'] ?? '';
  const how = ae.includes('br') ? 'br' : ae.includes('gzip') ? 'gzip' : null;
  // index.html carries a per-navigation prefix, so it is never memoised.
  const body = how ? (file.endsWith('index.html')
    ? encode(`${file}#${RUN}`, raw, how) : encode(file, raw, how)) : raw;
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    ...(how ? { 'content-encoding': how } : {}),
    'cache-control': 'no-store',
  });
  res.end(body);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = join(tmpdir(), 'heartrot-bundle-prof');
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1280,900',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  'about:blank',
], { stdio: 'ignore' });

async function ws() {
  for (let i = 0; i < 80; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()).webSocketDebuggerUrl; }
    catch { await sleep(250); }
  }
  throw new Error('chrome did not come up');
}
const sock = new WebSocket(await ws());
await new Promise((r) => sock.addEventListener('open', r, { once: true }));
let id = 0; const waiters = new Map();
sock.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiters.has(msg.id)) { waiters.get(msg.id)(msg.result ?? msg.error); waiters.delete(msg.id); }
  // CDP events are not consumed: everything read back comes from Runtime.evaluate against
  // the page's own PerformanceObserver buffer, so buffering events here would only leak.
});
const send = (method, params = {}, sessionId) =>
  new Promise((r) => { const i = ++id; waiters.set(i, r); sock.send(JSON.stringify({ id: i, method, params, sessionId })); });

const PROBE = `
(() => {
  window.__m = { long: [], fcp: 0, lcp: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__m.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__m.long.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
})();`;

async function once(dist, cond, cpu) {
  ROOT = dist;
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Page.enable'); await S('Network.enable'); await S('Runtime.enable');
  try {
  await S('Network.clearBrowserCache');
  await S('Network.setCacheDisabled', { cacheDisabled: true });
  await S('Network.setBlockedURLs', { urls: ['*google*', '*privy*', '*walletconnect*', '*reown*', '*coinbase*', '*sentry*', '*moonpay*'] });
  await S('Emulation.setCPUThrottlingRate', { rate: cpu });
  await S('Network.emulateNetworkConditions', {
    offline: false, latency: cond?.latency ?? 0,
    downloadThroughput: cond?.downloadThroughput ?? -1, uploadThroughput: cond?.uploadThroughput ?? -1,
  });
  await S('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  RUN++;
  await S('Page.navigate', { url: `http://127.0.0.1:${PORT}/?r=${RUN}` });

  const READ = `(() => { const n = performance.getEntriesByType('navigation')[0];
    if (!n || !n.loadEventEnd) return null;
    const rs = performance.getEntriesByType('resource');
    let t = Math.max(n.loadEventEnd, __m.fcp);
    for (const [s, d] of __m.long) if (s + d > t && s < t + 500) t = s + d;
    return { fcp: __m.fcp, lcp: __m.lcp, dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd, tti: t,
      reqs: rs.length + 1,
      enc: rs.reduce((a, r) => a + (r.encodedBodySize || 0), 0) + (n.encodedBodySize || 0),
      dec: rs.reduce((a, r) => a + (r.decodedBodySize || 0), 0) + (n.decodedBodySize || 0),
      longMs: __m.long.reduce((a, [, d]) => a + d, 0) }; })()`;

  // Fixed settle after `load`, not an idle detector: several chunks arrive via dynamic
  // import after the load event and the blocked third-party origins keep retrying, so a
  // quiet-network detector never fires. A constant settle is comparable across builds.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if ((await S('Runtime.evaluate', { expression: READ, returnByValue: true })).result.value) break;
    if (Date.now() > deadline) throw new Error('load never fired for ' + dist);
    await sleep(100);
  }
  await sleep(2500);
  if (process.env.DEBUG_LIST) {
    const l = (await S('Runtime.evaluate', { expression:
      `JSON.stringify(performance.getEntriesByType('resource').map(e=>[e.name.split('/').pop(),e.encodedBodySize]))`,
      returnByValue: true })).result.value;
    console.error(dist, cond ? 'thr' : 'lan', JSON.parse(l).sort((a,b)=>b[1]-a[1]).slice(0,6));
  }
  return (await S('Runtime.evaluate', { expression: READ, returnByValue: true })).result.value;
  } finally { await send('Target.closeTarget', { targetId }); }
}

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('dist                     cond  cpu   n   FCP    LCP    DCL   load   TTI   reqs  enc KiB  dec KiB  longMs');
for (const dist of DISTS)
  for (const [name, cond] of Object.entries(CONDS))
    for (const cpu of name === '3g' ? [1, 4] : [1]) {
      const runs = [];
      await once(dist, cond, cpu);   // warmup: first navigation of a condition pays Chrome's own
      for (let i = 0; i < REPS; i++) runs.push(await once(dist, cond, cpu));
      const p = (k) => med(runs.map((r) => r[k])).toFixed(0).padStart(6);
      console.log(dist.split('/').pop().padEnd(24), name.padEnd(5), String(cpu).padEnd(4),
        String(REPS).padStart(2), p('fcp'), p('lcp'), p('dcl'), p('load'), p('tti'),
        String(med(runs.map(r => r.reqs))).padStart(5),
        (med(runs.map(r => r.enc)) / 1024).toFixed(1).padStart(8),
        (med(runs.map(r => r.dec)) / 1024).toFixed(1).padStart(8),
        med(runs.map(r => r.longMs)).toFixed(0).padStart(7));
    }
chrome.kill(); server.close(); process.exit(0);
