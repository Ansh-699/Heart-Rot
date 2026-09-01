/**
 * PERF-PAYLOAD — what a byte of account data costs in wall time on the real
 * India -> devnet-as return leg.
 *
 * The `program-cu` question is "could the hot path write a SMALLER account?".
 * `Players` is 1,924 B and every `move` rewrites it, so every subscriber gets a
 * 1,924 B account notification (2,568 B once base64'd, ~2,854 B with the JSON-RPC
 * envelope). A per-seat split would make that ~100 B. The only way that turns into
 * milliseconds is transmission time on the return leg, so measure the slope directly:
 * same warm keep-alive TLS connection, same RPC method, same server-side work, only
 * the response body size varies.
 *
 * Arms are interleaved sample by sample so drift in the link cancels.
 *
 *   node scripts/spike/perf_payload.mjs > /tmp/payload.json
 */
import { Agent, request } from 'node:https';
import { connect } from 'node:tls';

const HOST = 'devnet-as.magicblock.app';
// Still-delegated accounts from an earlier spike arena (read-only here; nothing is written).
const PLAYERS = 'HCAjgep88oR6XbUAr59Kyg8AednVJewM6CepKuozDLfC'; // 1,924 B
const ARENA = '5Anv1RGLGMVmMUz4XzH6XvdPUC4pbA82siRP6QtdvCF8'; // 1,200 B

const N = Number(process.env.PP_SAMPLES ?? 60);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });

function rpc(body) {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = request(
      {
        host: HOST,
        port: 443,
        path: '/',
        method: 'POST',
        agent,
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
        });
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          resolve({ ms, bytes });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const slice = (len) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'getAccountInfo',
  params: [PLAYERS, { encoding: 'base64', dataSlice: { offset: 0, length: len } }],
});
const multi = (k) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'getMultipleAccounts',
  params: [Array.from({ length: k }, () => PLAYERS), { encoding: 'base64' }],
});

/** Bare TCP connect handshake — one RTT with zero server work, the physics floor. */
function tcpRtt() {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const s = connect({ host: HOST, port: 443, servername: HOST }, () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      s.destroy();
      resolve(ms);
    });
    s.on('error', reject);
  });
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const stat = (xs) => ({
  n: xs.length,
  min: Math.round(Math.min(...xs) * 10) / 10,
  p50: Math.round((pct(xs, 50) ?? 0) * 10) / 10,
  p90: Math.round((pct(xs, 90) ?? 0) * 10) / 10,
  p95: Math.round((pct(xs, 95) ?? 0) * 10) / 10,
  max: Math.round((pct(xs, 100) ?? 0) * 10) / 10,
});

/** Least-squares slope of ms on bytes, and the intercept (the RTT with no payload). */
function fit(points) {
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.x, 0);
  const sy = points.reduce((a, p) => a + p.y, 0);
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0);
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return { msPerKB: Math.round(slope * 1024 * 1000) / 1000, interceptMs: Math.round(((sy - slope * sx) / n) * 10) / 10 };
}

const arms = [
  ['slice0', () => slice(0)],
  ['slice96', () => slice(96)], // one PlayerSlot: what a per-seat account would ship
  ['slice1200', () => slice(1200)], // Arena
  ['slice1924', () => slice(1924)], // Players, what ships today
  ['multi4', () => multi(4)],
  ['multi10', () => multi(10)],
  ['multi20', () => multi(20)],
];

const out = {};
for (const [name] of arms) out[name] = { ms: [], bytes: 0 };

// Warm the socket: TCP + TLS must be paid once and only once.
for (let i = 0; i < 15; i += 1) await rpc(slice(0));

for (let i = 0; i < N; i += 1) {
  for (const [name, make] of arms) {
    const r = await rpc(make());
    out[name].ms.push(r.ms);
    out[name].bytes = r.bytes;
  }
}

const rtts = [];
for (let i = 0; i < 25; i += 1) rtts.push(await tcpRtt());

const rows = arms.map(([name]) => ({
  arm: name,
  respBytes: out[name].bytes,
  ...stat(out[name].ms),
}));
console.log(
  JSON.stringify(
    {
      host: HOST,
      samplesPerArm: N,
      tcpConnectRttMs: stat(rtts),
      rows,
      fitP50: fit(rows.map((r) => ({ x: r.respBytes, y: r.p50 }))),
      fitP90: fit(rows.map((r) => ({ x: r.respBytes, y: r.p90 }))),
      arenaControl: ARENA,
    },
    null,
    2,
  ),
);
agent.destroy();
