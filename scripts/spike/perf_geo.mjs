/**
 * PERF-GEO — is Singapore the right ER region for a player in India?
 *
 * Enumerates every MagicBlock devnet ER from the router's own `getRoutes` table and
 * measures, from this machine, two numbers per region:
 *
 *   1. bare TCP connect RTT to :443 — SYN/SYN-ACK, no server work in it, the physics floor
 *   2. warm keep-alive `getSlot` POST RTT — the round trip the game actually pays
 *
 * Rounds are round-robin across regions so a transient link wobble hits every region
 * equally instead of tarring one. No repo imports: this measures the wire, not the SDK.
 *
 * Run: node scripts/spike/perf_geo.mjs [rounds]
 */

import { createConnection } from 'node:net';
import { Agent, request } from 'node:https';
import { writeFileSync, mkdirSync } from 'node:fs';

const ROUTER = 'https://devnet-router.magicblock.app/';
const ROUNDS = Number(process.argv[2] ?? 40);

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};
const r1 = (x) => Math.round(x * 10) / 10;
const stats = (xs) => ({
  n: xs.length,
  min: r1(Math.min(...xs)),
  p50: r1(pct(xs, 50)),
  p90: r1(pct(xs, 90)),
  p95: r1(pct(xs, 95)),
  max: r1(Math.max(...xs)),
});

const now = () => Number(process.hrtime.bigint()) / 1e6;

function tcpRtt(host) {
  return new Promise((resolve) => {
    const t0 = now();
    const s = createConnection({ host, port: 443 }, () => {
      const dt = now() - t0;
      s.destroy();
      resolve(dt);
    });
    s.setTimeout(8000, () => {
      s.destroy();
      resolve(null);
    });
    s.on('error', () => resolve(null));
  });
}

function rpc(agent, host, method, params = []) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve) => {
    const t0 = now();
    const req = request(
      {
        agent,
        host,
        port: 443,
        path: '/',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const dt = now() - t0;
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString());
          } catch {
            /* non-JSON body: report as a failure, not a fake sample */
          }
          resolve({ ms: dt, json });
        });
      },
    );
    req.setTimeout(8000, () => {
      req.destroy();
      resolve({ ms: null, json: null });
    });
    req.on('error', () => resolve({ ms: null, json: null }));
    req.end(body);
  });
}

async function main() {
  const routerHost = new URL(ROUTER).hostname;
  const agents = new Map();
  const routerAgent = new Agent({ keepAlive: true, maxSockets: 1 });

  const { json: routesJson } = await rpc(routerAgent, routerHost, 'getRoutes');
  const routes = routesJson?.result ?? [];
  if (routes.length === 0) throw new Error('getRoutes returned nothing');

  const regions = routes.map((r) => ({
    identity: r.identity,
    fqdn: r.fqdn,
    host: new URL(r.fqdn).hostname,
    countryCode: r.countryCode,
    blockTimeMs: r.blockTimeMs,
    baseFee: r.baseFee,
    tcp: [],
    slot: [],
  }));
  // The router itself is the fifth wire the app touches today.
  regions.push({
    identity: 'router',
    fqdn: ROUTER,
    host: routerHost,
    countryCode: 'anycast',
    tcp: [],
    slot: [],
  });

  for (const r of regions) {
    agents.set(r.host, new Agent({ keepAlive: true, maxSockets: 1 }));
  }

  // Identity check: prove each endpoint really is the validator the router names.
  for (const r of regions) {
    if (r.identity === 'router') continue;
    const { json } = await rpc(agents.get(r.host), r.host, 'getIdentity');
    r.reportedIdentity = json?.result?.identity ?? null;
    r.identityMatches = r.reportedIdentity === r.identity;
  }

  // Warm every keep-alive socket so round 1 is not a handshake.
  for (const r of regions) await rpc(agents.get(r.host), r.host, 'getSlot');

  for (let i = 0; i < ROUNDS; i++) {
    for (const r of regions) {
      const t = await tcpRtt(r.host);
      if (t !== null) r.tcp.push(t);
      const { ms } = await rpc(agents.get(r.host), r.host, 'getSlot');
      if (ms !== null) r.slot.push(ms);
    }
  }

  const out = regions.map((r) => ({
    identity: r.identity,
    fqdn: r.fqdn,
    host: r.host,
    countryCode: r.countryCode,
    blockTimeMs: r.blockTimeMs,
    reportedIdentity: r.reportedIdentity,
    identityMatches: r.identityMatches,
    tcp: stats(r.tcp),
    slot: stats(r.slot),
    raw: { tcp: r.tcp.map(r1), slot: r.slot.map(r1) },
  }));

  for (const r of out) {
    console.log(
      `${r.host.padEnd(32)} ${String(r.countryCode).padEnd(8)} tcp p50 ${String(r.tcp.p50).padStart(6)} (min ${r.tcp.min}, p95 ${r.tcp.p95})   getSlot p50 ${String(r.slot.p50).padStart(6)} (p95 ${r.slot.p95})  id=${r.identityMatches}`,
    );
  }

  mkdirSync('docs/perf', { recursive: true });
  const path = `docs/perf/geo-${process.env.RUN ?? 'a'}.json`;
  writeFileSync(path, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, regions: out }, null, 2));
  console.log(`\nwrote ${path}`);

  for (const a of agents.values()) a.destroy();
  routerAgent.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
