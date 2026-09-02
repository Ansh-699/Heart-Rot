/**
 * PERF-PARSE — the half of the client's per-notification cost that `perf_seats.ts` did
 * not time.
 *
 * `perf_seats.ts` starts its clock after `JSON.parse(event.data)` has already run, so its
 * `decodeMsPerSec` is base64 + the shipped decoder only. `app/src/net/subscribe.ts`'s
 * `onmessage` parses the whole websocket message first, and at twenty seats the feed is
 * 961 KB/s of JSON — so the parse could easily be the larger term. This measures both
 * halves on frames of exactly the sizes `seats-run1.jsonl` recorded, and multiplies them
 * by the frame rates the same run measured.
 *
 * No network. Frames are synthesised at the measured wire lengths, and the payloads are
 * real account bytes of the real sizes, so the parse and the decode both do the work they
 * do in the browser.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_parse.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=./packages/client/src/index.ts \
 *     --outfile=/tmp/perf_parse.mjs
 *   node /tmp/perf_parse.mjs
 */

import { randomBytes } from 'node:crypto';

import { decodeArena, decodeBoss, decodePlayers } from '@heartrot/client';

/** Byte sizes from `state.rs`'s layout asserts. */
const SIZES = { arena: 1200, boss: 50, players: 1924 } as const;
type Kind = keyof typeof SIZES;
const DISCRIMINATOR: Record<Kind, number> = { arena: 1, boss: 2, players: 3 };
const LAYOUT_VERSION = 1;

/**
 * Frames per second per account, at each seat count, straight out of
 * `docs/perf/seats-run1.jsonl`. `players` and `arena` are equal at every load because
 * every `move` emits one of each — which is the finding this table exists to cost.
 */
const RATES: readonly { seats: number; arena: number; players: number; boss: number }[] = [
  { seats: 0, arena: 10, players: 10, boss: 10 },
  { seats: 1, arena: 19.9, players: 19.9, boss: 10 },
  { seats: 5, arena: 56.6, players: 56.6, boss: 10 },
  { seats: 10, arena: 108.7, players: 108.7, boss: 10 },
  { seats: 20, arena: 205.7, players: 205.7, boss: 10 },
];

/** One account's bytes, valid enough that the shipped decoder accepts them. */
function accountBytes(kind: Kind): Uint8Array {
  const bytes = Uint8Array.from(randomBytes(SIZES[kind]));
  bytes[0] = DISCRIMINATOR[kind];
  bytes[1] = LAYOUT_VERSION;
  return bytes;
}

/** The websocket message the ER actually sends, around a base64 payload. */
function frame(account: string, encoded: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'accountNotification',
    params: {
      result: {
        context: { slot: 412_345_678 },
        value: {
          lamports: 13_920_000,
          data: [encoded, 'base64'],
          owner: 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5',
          executable: false,
          rentEpoch: 18_446_744_073_709_551_615,
          space: SIZES[account as Kind],
        },
      },
      subscription: 7,
    },
  });
}

function bench(label: string, iterations: number, fn: () => void): number {
  for (let i = 0; i < iterations; i += 1) fn(); // warm the JIT
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) fn();
  const us = Number(process.hrtime.bigint() - t0) / 1000 / iterations;
  process.stdout.write(`${label.padEnd(34)} ${us.toFixed(2)} us\n`);
  return us;
}

const N = 20_000;
const cost = {} as Record<Kind, { parse: number; decode: number; total: number; wire: number }>;

for (const kind of ['arena', 'boss', 'players'] as const) {
  const bytes = accountBytes(kind);
  const encoded = Buffer.from(bytes).toString('base64');
  const raw = frame(kind, encoded);
  const decoder = kind === 'players' ? decodePlayers : kind === 'arena' ? decodeArena : decodeBoss;

  process.stdout.write(`\n${kind}  ${SIZES[kind]} B raw, ${encoded.length} B base64, ${raw.length} B wire\n`);
  // `sink` exists so V8 cannot delete the call whose cost is the measurement.
  let sink = 0;
  const parse = bench('JSON.parse(event.data)', N, () => {
    sink += (JSON.parse(raw) as { params: { subscription: number } }).params.subscription;
  });
  const decode = bench('atob + shipped decoder', N, () => {
    sink += decoder(Uint8Array.from(Buffer.from(encoded, 'base64'))).version;
  });
  const total = bench('the whole onmessage path', N, () => {
    const msg = JSON.parse(raw) as { params: { result: { value: { data: string[] } } } };
    const encodedOut = msg.params.result.value.data[0] as string;
    sink += decoder(Uint8Array.from(Buffer.from(encodedOut, 'base64'))).version;
  });
  if (sink === -1) process.stdout.write('unreachable\n');
  cost[kind] = { parse, decode, total, wire: raw.length };
}

process.stdout.write('\nPer-second client cost at the frame rates seats-run1 measured:\n\n');
process.stdout.write('seats   frames/s     parse ms/s   decode ms/s   total ms/s   % of one core\n');
for (const r of RATES) {
  const frames = r.arena + r.players + r.boss;
  const parse = (r.arena * cost.arena.parse + r.players * cost.players.parse + r.boss * cost.boss.parse) / 1000;
  const decode =
    (r.arena * cost.arena.decode + r.players * cost.players.decode + r.boss * cost.boss.decode) / 1000;
  const total = (r.arena * cost.arena.total + r.players * cost.players.total + r.boss * cost.boss.total) / 1000;
  process.stdout.write(
    `${String(r.seats).padStart(5)}   ${frames.toFixed(1).padStart(8)}   ${parse.toFixed(2).padStart(10)}   ` +
      `${decode.toFixed(2).padStart(11)}   ${total.toFixed(2).padStart(10)}   ${(total / 10).toFixed(2).padStart(13)}\n`,
  );
}

process.stdout.write(
  '\nIf the duplicate Arena frames were dropped before parsing (95.2% of Arena frames at 20 seats):\n',
);
const twenty = RATES[RATES.length - 1] as (typeof RATES)[number];
const keptArena = twenty.arena * (1 - 0.952);
const saved =
  ((twenty.arena - keptArena) * cost.arena.total) / 1000;
process.stdout.write(
  `  arena frames/s ${twenty.arena} -> ${keptArena.toFixed(1)}, saving ${saved.toFixed(2)} ms/s of client CPU\n` +
    `  and ${(((twenty.arena - keptArena) * cost.arena.wire) / 1024).toFixed(0)} KB/s of parsing, though not of bandwidth.\n`,
);
