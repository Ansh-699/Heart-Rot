// Same pages, but measure real renderer work: devtools.timeline trace events,
// summed by name. Answers "what does a 22,195-subpath static background cost
// while something animates on top of it".
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Generated pages live outside the repo; only the harness is committed. */
const DIR = join(tmpdir(), 'heartrot-anim');



const CONDS = process.argv.slice(2);
const PORT = 9334;

const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${DIR}/prof2`,
  '--no-first-run', '--no-default-browser-check', '--window-size=1200,1200', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

async function version() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  throw new Error('no chrome');
}
const v = await version();
console.log('#', v.Browser);

let id = 0;
function connect(url) {
  const ws = new WebSocket(url);
  const waiters = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== undefined) {
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result); }
    } else if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
    else if (m.method === 'Tracing.tracingComplete') ws.__done = true;
  });
  const ready = new Promise((res) => ws.addEventListener('open', res));
  return { ws, events, ready,
    send: (method, params = {}) => new Promise((res, rej) => {
      const n = ++id; waiters.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    }) };
}

for (const cond of CONDS) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const c = connect(t.webSocketDebuggerUrl);
  await c.ready;
  await c.send('Page.enable');
  await c.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline', 'blink', 'cc'] },
  });
  await c.send('Page.navigate', { url: `file://${DIR}/${cond}.html` });
  await sleep(7500);
  await c.send('Tracing.end');
  for (let i = 0; i < 60 && !c.ws.__done; i++) await sleep(200);

  const by = new Map();
  for (const e of c.events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number') continue;
    const k = e.name;
    const r = by.get(k) ?? { n: 0, us: 0 };
    r.n++; r.us += e.dur;
    by.set(k, r);
  }
  const pick = ['UpdateLayer', 'Paint', 'RasterTask', 'PaintSetup', 'UpdateLayerTree',
                'Layout', 'UpdateLayoutTree', 'FunctionCall', 'CommitLoad', 'Commit',
                'ParseHTML', 'DrawFrame', 'CompositeLayers'];
  const cells = pick.map((k) => {
    const r = by.get(k);
    return `${k}=${r ? `${r.n}/${(r.us / 1000).toFixed(0)}ms` : '-'}`;
  });
  console.log(cond.padEnd(16), cells.join(' '));
  c.ws.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
}
chrome.kill();
