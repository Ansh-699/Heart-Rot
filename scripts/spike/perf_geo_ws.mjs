/**
 * PERF-GEO-WS — the read wire, per region, without spending a lamport.
 *
 * Opens a websocket to each devnet ER at the same time and slotSubscribes. Measures the
 * upgrade handshake and the slot cadence each region actually delivers to this machine.
 * Cadence is the movement gate the game runs on (one move per ER slot), so a region with
 * a worse-than-50 ms grid is disqualified regardless of its RTT.
 *
 * Run: node scripts/spike/perf_geo_ws.mjs [seconds]
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const SECONDS = Number(process.argv[2] ?? 30);
const HOSTS = [
  ['devnet-as', 'wss://devnet-as.magicblock.app/'],
  ['devnet-tee', 'wss://devnet-tee.magicblock.app/'],
  ['devnet-eu', 'wss://devnet-eu.magicblock.app/'],
  ['devnet-us', 'wss://devnet-us.magicblock.app/'],
  ['router', 'wss://devnet-router.magicblock.app/'],
];

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (x) => Math.round(x * 10) / 10;
const now = () => Number(process.hrtime.bigint()) / 1e6;

function watch(name, url) {
  return new Promise((resolve) => {
    const t0 = now();
    const ws = new WebSocket(url);
    const rec = { name, url, openMs: null, subAckMs: null, slots: [], gaps: [], error: null };
    let last = null;
    let lastSlot = null;

    ws.onerror = (e) => {
      rec.error = String(e?.message ?? e);
    };
    ws.onopen = () => {
      rec.openMs = r1(now() - t0);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'slotSubscribe', params: [] }));
    };
    ws.onmessage = (ev) => {
      const t = now();
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.id === 1) {
        rec.subAckMs = r1(t - t0);
        return;
      }
      if (m.method !== 'slotNotification') return;
      const slot = m.params?.result?.slot;
      if (typeof slot !== 'number') return;
      // Only consecutive slots: a skipped slot is a gap in the ledger, not in delivery.
      if (last !== null && lastSlot !== null && slot === lastSlot + 1) rec.gaps.push(t - last);
      rec.slots.push(slot);
      last = t;
      lastSlot = slot;
    };

    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(rec);
    }, SECONDS * 1000 + 2000);
  });
}

const recs = await Promise.all(HOSTS.map(([n, u]) => watch(n, u)));
const out = recs.map((r) => ({
  name: r.name,
  url: r.url,
  wsOpenMs: r.openMs,
  subAckMs: r.subAckMs,
  notifications: r.slots.length,
  consecutiveGaps: r.gaps.length,
  gapMs:
    r.gaps.length > 0
      ? { p50: r1(pct(r.gaps, 50)), p90: r1(pct(r.gaps, 90)), p95: r1(pct(r.gaps, 95)), max: r1(Math.max(...r.gaps)) }
      : null,
  error: r.error,
}));

for (const r of out) {
  console.log(
    `${r.name.padEnd(12)} open ${String(r.wsOpenMs).padStart(6)} ms  subAck ${String(r.subAckMs).padStart(6)} ms  ` +
      `notifs ${String(r.notifications).padStart(4)}  gap p50 ${r.gapMs ? r.gapMs.p50 : '-'} p95 ${r.gapMs ? r.gapMs.p95 : '-'} max ${r.gapMs ? r.gapMs.max : '-'}` +
      (r.error ? `  ERR ${r.error}` : ''),
  );
}

mkdirSync('docs/perf', { recursive: true });
const path = `docs/perf/geo-ws-${process.env.RUN ?? 'a'}.json`;
writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), seconds: SECONDS, regions: out }, null, 2));
console.log(`\nwrote ${path}`);
