/**
 * PERF-PAYLOAD-PAIR — the two-arm half of perf_payload.mjs: 96 B vs 1,924 B of account
 * data on one warm socket, interleaved with the order alternating inside each pair.
 * This is the exact "would a per-seat Players account arrive sooner" question.
 *
 *   N=200 node scripts/spike/perf_payload_pair.mjs
 *
 * Result (docs/perf/research-program-cu.md): paired delta p50 +0.8 / +1.1 ms over two
 * runs of 200 pairs. The 2,432 bytes are worth about a millisecond.
 */
import { Agent, request } from 'node:https';
const HOST = 'devnet-as.magicblock.app';
const PLAYERS = 'HCAjgep88oR6XbUAr59Kyg8AednVJewM6CepKuozDLfC';
const N = Number(process.env.N ?? 200);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
function rpc(len) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
    params: [PLAYERS, { encoding: 'base64', dataSlice: { offset: 0, length: len } }] }));
  return new Promise((res, rej) => {
    const t0 = process.hrtime.bigint();
    const r = request({ host: HOST, port: 443, path: '/', method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (s) => {
      let b = 0; s.on('data', (c) => { b += c.length; });
      s.on('end', () => res({ ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: b })); });
    r.on('error', rej); r.end(payload);
  });
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const S = (xs) => ({ n: xs.length, min: +Math.min(...xs).toFixed(1), p50: +pct(xs, 50).toFixed(1),
  p90: +pct(xs, 90).toFixed(1), p95: +pct(xs, 95).toFixed(1) });
for (let i = 0; i < 15; i += 1) await rpc(0);
const small = [], big = [], diff = [];
let sb = 0, bb = 0;
for (let i = 0; i < N; i += 1) {
  // Alternate which arm goes first so ordering within a pair cannot bias the delta.
  const first = i % 2 === 0 ? 96 : 1924;
  const a = await rpc(first);
  const b = await rpc(first === 96 ? 1924 : 96);
  const [s, g] = first === 96 ? [a, b] : [b, a];
  small.push(s.ms); big.push(g.ms); diff.push(g.ms - s.ms); sb = s.bytes; bb = g.bytes;
}
console.log(JSON.stringify({ smallBytes: sb, bigBytes: bb, small: S(small), big: S(big),
  pairedDeltaMs: S(diff), bigFirstFraction: +(diff.filter((d) => d < 0).length / diff.length).toFixed(3),
  meanDeltaMs: +(diff.reduce((a, b) => a + b, 0) / diff.length).toFixed(2) }, null, 2));
agent.destroy();
