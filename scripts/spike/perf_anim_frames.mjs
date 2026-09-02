// Drive headless Chrome over CDP with node's built-in WebSocket. No deps.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Generated pages live outside the repo; only the harness is committed. */
const DIR = join(tmpdir(), 'heartrot-anim');



const CONDS = process.argv.slice(2);
const PORT = 9333;
const PROFILE = `${DIR}/prof`;

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check',
  '--window-size=1200,1200',
  '--hide-scrollbars',
  // real compositing cadence, not a virtual clock
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });

async function version() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); }
    catch { await sleep(250); }
  }
  throw new Error('chrome never came up:\n' + stderr);
}

const v = await version();
console.log('#', v.Browser, '| gpu:', process.env.GPU ?? 'default');

let id = 0;
function connect(url) {
  const ws = new WebSocket(url);
  const waiters = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
  });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  return {
    ready,
    send: (method, params = {}) => new Promise((res, rej) => {
      const n = ++id; waiters.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    }),
    close: () => ws.close(),
  };
}

const rows = [];
for (const cond of CONDS) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?file://${DIR}/${cond}.html`, { method: 'PUT' })).json();
  const c = connect(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Runtime.enable');
  let out = null;
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    const r = await c.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result||null)', returnByValue: true });
    if (r.result.value && r.result.value !== 'null') { out = JSON.parse(r.result.value); break; }
  }
  const sample = async () => (await c.send('Runtime.evaluate', {
    expression: "getComputedStyle(document.querySelector('#bossinner > g')).transform", returnByValue: true })).result.value;
  const s1 = await sample(); await sleep(220); const s2 = await sample();
  out.movedOffLoop = s1 !== s2;
  c.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  if (!out) { console.log(cond, 'NO RESULT'); continue; }
  rows.push(out);
  console.log(
    out.cond.padEnd(16),
    'boot', String(out.boot).padStart(5),
    'fps', String(out.fps).padStart(6),
    'p50', String(out.p50).padStart(6),
    'p95', String(out.p95).padStart(7),
    'max', String(out.max).padStart(8),
    '>20ms', String(out.over20ms).padStart(4),
    'nodes', String(out.nodes).padStart(5), 'partMoved', String(out.partMoved).padStart(6), 'moving', out.movedOffLoop,
  );
}
chrome.kill();
