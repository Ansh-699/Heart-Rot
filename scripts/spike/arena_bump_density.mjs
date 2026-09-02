/**
 * The check behind `childBumpsCanonical` / `GRIND_STEPS` in `worker/src/routes.ts`.
 *
 * The grind declines an `arena_id` whose `Boss` and `Players` PDAs do not both land on
 * bump 255. That is only safe if eligible ids are DENSE — every declined id is one more
 * chain read on the join path, and a gap wider than `GRIND_STEPS` would make the scan
 * give up and answer `no_open_arena` with free ids sitting right behind the bound.
 *
 * So the assert is on the worst gap, not on the mean: the thing that breaks the Worker is
 * the tail. Run it after changing `PROGRAM_ID`, the seeds, or `GRIND_STEPS`.
 *
 *   node scripts/spike/arena_bump_density.mjs [count] [startId]
 *
 * Measured 2026-09-02, 4,000 ids from 1788266869 under JCfWB9zD…: 1,033 eligible
 * (25.8%), mean gap 3.87, p50 3, p95 10, worst 21.
 */

import assert from 'node:assert/strict';
import { getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';

// worker/wrangler.jsonc `vars.PROGRAM_ID`, and the three seeds from packages/client/src/layout.ts.
const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5';
const [SEED_ARENA, SEED_BOSS, SEED_PLAYERS] = ['arena', 'boss', 'players'];

// worker/src/routes.ts.
const GRIND_STEPS = 64;

const count = Number(process.argv[2] ?? 4000);
const start = BigInt(process.argv[3] ?? 1788266869);
const encoder = getAddressEncoder();

const u64le = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
};

const gaps = [];
let eligible = 0;
let previous = null;
let worst = 0;

for (let i = 0; i < count; i++) {
  const [arena] = await getProgramDerivedAddress({
    programAddress: PROGRAM_ID,
    seeds: [SEED_ARENA, u64le(start + BigInt(i))],
  });
  const key = encoder.encode(arena);
  const [[, boss], [, players]] = await Promise.all([
    getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [SEED_BOSS, key] }),
    getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: [SEED_PLAYERS, key] }),
  ]);
  if (boss !== 255 || players !== 255) continue;
  eligible++;
  if (previous !== null) gaps.push(i - previous);
  previous = i;
}

gaps.sort((a, b) => a - b);
worst = gaps.at(-1);
console.log({
  count,
  eligible,
  fraction: +(eligible / count).toFixed(3),
  meanGap: +(count / eligible).toFixed(2),
  p50: gaps[Math.floor(gaps.length * 0.5)],
  p95: gaps[Math.floor(gaps.length * 0.95)],
  worst,
});

assert.ok(eligible > 0, 'no arena id in the sample has both child bumps at 255');
assert.ok(
  worst < GRIND_STEPS,
  `worst eligible-id gap ${worst} is not under GRIND_STEPS ${GRIND_STEPS}: ` +
    'the Worker can walk off the end of its scan and answer no_open_arena',
);
console.log('ok');
