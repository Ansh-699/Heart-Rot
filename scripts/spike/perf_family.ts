/**
 * PERF-FAMILY — why the router looks fast from Node and slow from a browser.
 *
 * `perf_appath.ts` measures the router websocket and the pinned ER websocket at a p50
 * within a few ms of each other, and `docs/perf/notify.md` measured the router 32–40 ms
 * BEHIND. Both were run from the same house. The candidate explanation, already written
 * into `app/src/net/subscribe.ts`, is address family: the router is behind Cloudflare and
 * its IPv6 anycast is far from this ISP, while its IPv4 edge is close — and Node opens
 * sockets with Happy Eyeballs (`autoSelectFamily`, default true since Node 20), so Node
 * silently takes the fast family that a browser, following the OS resolver's AAAA-first
 * answer, does not.
 *
 * If that is right, the ER-websocket change is worth something in the browser and nothing
 * from Node, and no amount of Node measurement can show it. This script decides that by
 * timing a bare TCP connect per family per host — no TLS, no HTTP, so there is no server
 * work in the number, only the path.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_family.ts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/perf_family.mjs
 *   node /tmp/perf_family.mjs --out docs/perf/family-run1.jsonl
 */

import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';

const HOSTS = ['devnet-router.magicblock.app', 'devnet-as.magicblock.app'] as const;
const SAMPLES = Number(process.env.PF_SAMPLES ?? 40);

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/perf_family.jsonl' : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown>): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${JSON.stringify(line)}\n`);
  console.log(`${line.t} ${event} ${JSON.stringify(fields)}`);
}

function pct(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

function stats(values: readonly number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/** One bare TCP handshake to `host:443` on `address`. Rejects rather than reporting a 0. */
function connectMs(address: string, family: 4 | 6): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    // `autoSelectFamily: false` is the whole point: an explicit address and no Happy
    // Eyeballs, so the number belongs to the family named and to no other.
    const socket = connect({ host: address, port: 443, family, autoSelectFamily: false }, () => {
      const ms = performance.now() - t0;
      socket.destroy();
      resolve(ms);
    });
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

async function main(): Promise<void> {
  for (const host of HOSTS) {
    const addresses = await lookup(host, { all: true, verbatim: true });
    // `verbatim: true` is the resolver's own order — what a browser is handed and what it
    // tries first. Reporting it is half the finding.
    log('resolved', { host, verbatimOrder: addresses.map((a) => `${a.family}:${a.address}`) });

    for (const family of [4, 6] as const) {
      const address = addresses.find((a) => a.family === family)?.address;
      if (address === undefined) {
        log('connect', { host, family, note: 'no address of this family' });
        continue;
      }
      const samples: number[] = [];
      let errors = 0;
      for (let i = 0; i < SAMPLES; i += 1) {
        try {
          samples.push(await connectMs(address, family));
        } catch {
          errors += 1;
        }
      }
      log('connect', {
        host,
        family,
        address,
        errors,
        ms: stats(samples.map((m) => Math.round(m * 10) / 10)),
      });
    }
  }
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error).slice(0, 300) });
  process.exit(1);
});
