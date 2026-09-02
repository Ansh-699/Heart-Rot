/**
 * DECODE-BENCH — throwaway. Answers one question the ER gate cannot: what does a
 * notification's parse+decode actually COST, in nanoseconds, on the shipped decoders.
 *
 * `er_guard`'s `decodeMsPerSec` row is a PRODUCT — (frames/s that survive the dedupe) x
 * (ns per parse+decode) — measured inside a live websocket feed on a machine that is also
 * signing and sending twenty seats' worth of transactions. It moves for reasons that have
 * nothing to do with the decoder. This file removes every one of those reasons: same
 * process, no network, no sends, the six REAL payloads the two arms of the paired run
 * actually left on devnet, read back by address from the `start` line of each run.
 *
 *   docs/perf/er-guard/pair-base-1/fight.jsonl  start.arena/boss/players  (program JCfWB9…)
 *   docs/perf/er-guard/pair-cand-1/fight.jsonl  start.arena/boss/players  (program AawgMt…)
 *
 * Three things are timed, each on the same JIT footing:
 *
 *   parse      Buffer.from(b64,'base64') -> Uint8Array, the hop `subscribe.ts` pays before
 *              the decoder. er_guard times it INSIDE the decode row, so it is charged here
 *              too, separately, because it is the larger half.
 *   shipped    decodePlayers / decodeArena / decodeBoss straight out of @heartrot/client.
 *   noClassAim a byte-for-byte copy of decodePlayers with the single `classAim:` line
 *              removed — the ONLY thing the archer run added to this path. The copy is
 *              proved equivalent against the shipped decoder before it is timed, so the
 *              difference between the two rows is the cost of that one `getUint8` and
 *              nothing else.
 *
 * Run:  node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *         scripts/spike/decode_bench.ts --bundle --platform=node --format=esm \
 *         --alias:@heartrot/client=./packages/client/src/index.ts \
 *         --outfile=/tmp/decode_bench.mjs && node /tmp/decode_bench.mjs
 */

import { readFileSync } from 'node:fs';

import {
  LAYOUT_VERSION,
  MAX_SEATS,
  PLAYERS,
  PLAYER_SLOT,
  decodeArena,
  decodeBoss,
  decodePlayers,
} from '@heartrot/client';

// The bundle runs from /tmp, so the payload directory is named absolutely rather than
// relative to the bundle. `HR_DECODEBENCH` overrides it.
const DIR =
  process.env.HR_DECODEBENCH ??
  '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/decodebench/';

// --- the control decoder --------------------------------------------------
// Copy of `layout.ts::decodePlayers` minus `classAim`. Everything else, including the
// `isZero` occupancy scan and both 32-byte `slice`s, is identical on purpose: the
// question is what ONE added byte read costs, not what a leaner decoder would cost.
function decodePlayersNoClassAim(data: Uint8Array): { bump: number; slots: unknown[] } {
  const o = PLAYERS.offsets;
  const p = PLAYER_SLOT.offsets;
  // `layout.ts::open`, inlined: the control must pay every check the shipped one pays.
  if (data.length < PLAYERS.size) throw new Error('Players: short');
  if (data[0] !== PLAYERS.discriminator) throw new Error('Players: discriminator');
  if (data[1] !== LAYOUT_VERSION) throw new Error('Players: layout version');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const slots: unknown[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    const s = o.slots + seat * PLAYER_SLOT.size;
    const sessionPubkey = data.slice(s + p.session_pubkey, s + p.session_pubkey + 32);
    slots.push({
      seat,
      occupied: !sessionPubkey.every((x) => x === 0),
      zone: v.getUint8(s + p.zone),
      facing: v.getUint8(s + p.facing),
      skinId: v.getUint8(s + p.skin_id),
      x: v.getInt16(s + p.x, true),
      y: v.getInt16(s + p.y, true),
      hp: v.getUint16(s + p.hp, true),
      hpMax: v.getUint16(s + p.hp_max, true),
      lastMoveSeq: v.getUint16(s + p.last_move_seq, true),
      deaths: v.getUint16(s + p.deaths, true),
      respawnAtTick: v.getUint32(s + p.respawn_at_tick, true),
      lastShotTick: v.getUint32(s + p.last_shot_tick, true),
      lastMoveTick: v.getUint32(s + p.last_move_tick, true),
      damageDealt: v.getUint32(s + p.damage_dealt, true),
      sessionPubkey,
      identity: data.slice(s + p.identity, s + p.identity + 32),
    });
  }
  return { bump: v.getUint8(o.bump), slots };
}

// --- timing ---------------------------------------------------------------
// Median of TRIALS blocks of ITERS calls. Median, not mean: one GC pause inside one block
// should not become the answer. The first block of every subject is discarded — a cold
// `decodePlayers` measured 46.7 µs against 6.2 µs warm in perf_20seats.ts, which is V8's
// tiering, not the client.
const ITERS = 20_000;
const TRIALS = 11;

let sink: unknown;

interface Subject {
  readonly name: string;
  readonly fn: () => unknown;
  readonly blocks: number[];
}

/**
 * EVERY subject is warmed before ANY is timed, and the timing pass is then repeated in a
 * second sweep. Timing subjects one at a time in declaration order does not work here:
 * the first run of this file put `base decodePlayers noClassAim` at 3,812 ns with a
 * 3,710 ns block spread while the identical `cand` row — same function, different bytes —
 * came out at 2,420 ns with a 166 ns spread. That is V8 tiering the freshly-declared
 * function up while it is being measured, not a property of the bytes.
 */
function run(subjects: Subject[]): void {
  for (const s of subjects) for (let i = 0; i < ITERS; i++) sink = s.fn();
  for (let sweep = 0; sweep < 2; sweep++) {
    for (const s of subjects) {
      for (let t = 0; t < TRIALS; t++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < ITERS; i++) sink = s.fn();
        s.blocks.push(Number(process.hrtime.bigint() - t0) / ITERS);
      }
    }
  }
}

function bench(name: string, fn: () => unknown): Subject {
  return { name, fn, blocks: [] };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

// --- payloads -------------------------------------------------------------
const arms = ['base', 'cand'] as const;
const kinds = ['arena', 'boss', 'players'] as const;
const b64: Record<string, string> = {};
const raw: Record<string, Uint8Array> = {};
for (const arm of arms) {
  for (const kind of kinds) {
    const s = readFileSync(`${DIR}${arm}-${kind}.b64`, 'utf8').trim();
    b64[`${arm}-${kind}`] = s;
    raw[`${arm}-${kind}`] = Uint8Array.from(Buffer.from(s, 'base64'));
  }
}

// --- equivalence proof, before any timing ---------------------------------
// If the control decoder is not the shipped one minus `classAim`, the delta below is
// measuring the copy, not the byte. Assert it on real data rather than trusting the diff.
for (const arm of arms) {
  const shipped = decodePlayers(raw[`${arm}-players`]!);
  const control = decodePlayersNoClassAim(raw[`${arm}-players`]!) as {
    slots: Record<string, unknown>[];
  };
  for (let i = 0; i < MAX_SEATS; i++) {
    const a = shipped.slots[i]! as unknown as Record<string, unknown>;
    const b = control.slots[i]!;
    if (!('classAim' in a) || 'classAim' in b) throw new Error('control is not classAim-free');
    for (const k of Object.keys(b)) {
      const x = a[k];
      const y = b[k];
      const same =
        x instanceof Uint8Array && y instanceof Uint8Array
          ? x.length === y.length && x.every((v, j) => v === y[j]!)
          : x === y;
      if (!same) throw new Error(`control diverges at seat ${i} field ${k}`);
    }
  }
}

// --- what is actually in these payloads -----------------------------------
for (const arm of arms) {
  const p = decodePlayers(raw[`${arm}-players`]!);
  const occ = p.slots.filter((s) => s.occupied).length;
  const classes = new Set(p.slots.filter((s) => s.occupied).map((s) => s.classAim >> 7));
  const aims = new Set(p.slots.filter((s) => s.occupied).map((s) => s.classAim & 0x7f));
  console.log(
    JSON.stringify({
      event: 'payload',
      arm,
      players: raw[`${arm}-players`]!.length,
      arena: raw[`${arm}-arena`]!.length,
      boss: raw[`${arm}-boss`]!.length,
      b64Players: b64[`${arm}-players`]!.length,
      occupied: occ,
      classes: [...classes],
      distinctAimCodes: aims.size,
    }),
  );
}

// --- the bench ------------------------------------------------------------
const rows: Subject[] = [];
for (const arm of arms) {
  const pb = b64[`${arm}-players`]!;
  const ab = b64[`${arm}-arena`]!;
  const bb = b64[`${arm}-boss`]!;
  const p = raw[`${arm}-players`]!;
  const a = raw[`${arm}-arena`]!;
  const b = raw[`${arm}-boss`]!;

  rows.push(bench(`${arm} parse players (1924B)`, () => Uint8Array.from(Buffer.from(pb, 'base64'))));
  rows.push(bench(`${arm} parse arena   (1200B)`, () => Uint8Array.from(Buffer.from(ab, 'base64'))));
  rows.push(bench(`${arm} parse boss    (  50B)`, () => Uint8Array.from(Buffer.from(bb, 'base64'))));
  rows.push(bench(`${arm} decodePlayers`, () => decodePlayers(p)));
  rows.push(bench(`${arm} decodePlayers noClassAim`, () => decodePlayersNoClassAim(p)));
  rows.push(bench(`${arm} decodeArena`, () => decodeArena(a)));
  rows.push(bench(`${arm} decodeBoss`, () => decodeBoss(b)));
  rows.push(
    bench(`${arm} parse+decode players`, () =>
      decodePlayers(Uint8Array.from(Buffer.from(pb, 'base64'))),
    ),
  );
  rows.push(
    bench(`${arm} parse+decode arena`, () => decodeArena(Uint8Array.from(Buffer.from(ab, 'base64')))),
  );
  rows.push(
    bench(`${arm} parse+decode boss`, () => decodeBoss(Uint8Array.from(Buffer.from(bb, 'base64')))),
  );
}

run(rows);

console.log(`\n  ns/call (median of ${TRIALS * 2} blocks x ${ITERS})   calls/s        p10..p90`);
for (const r of rows) {
  const s = [...r.blocks].sort((a, b) => a - b);
  const ns = median(r.blocks);
  console.log(
    `  ${r.name.padEnd(30)} ${Math.round(ns).toString().padStart(8)}  ` +
      `${Math.round(1e9 / ns).toLocaleString('en-US').padStart(12)}  ` +
      `${Math.round(s[Math.floor(s.length * 0.1)]!)}..${Math.round(s[Math.floor(s.length * 0.9)]!)} ns`,
  );
}

const find = (n: string) => median(rows.find((r) => r.name === n)!.blocks);
const withA = find('cand decodePlayers');
const without = find('cand decodePlayers noClassAim');
console.log(
  `\n  classAim byte: ${Math.round(withA)} ns vs ${Math.round(without)} ns per decodePlayers ` +
    `= ${(withA - without).toFixed(1)} ns (${(((withA - without) / without) * 100).toFixed(1)}%)`,
);

// What the ER row would have to be, given these costs and the frame rates the run recorded.
// pair-cand-1 block "20": players 329.9 f/s at 5.4% duplicate, arena 329.9 at 97.0%,
// boss 10.0 at 0% — read straight out of its table event.
const feed = [
  { kind: 'players', fps: 329.9, dup: 0.054 },
  { kind: 'arena', fps: 329.9, dup: 0.97 },
  { kind: 'boss', fps: 10.0, dup: 0.0 },
] as const;
let msPerSec = 0;
for (const f of feed) {
  const ns = find(`cand parse+decode ${f.kind}`);
  msPerSec += (f.fps * (1 - f.dup) * ns) / 1e6;
}
console.log(
  `  predicted decodeMsPerSec at pair-cand-1's twenty-seat frame rates: ${msPerSec.toFixed(2)} ms/s` +
    `  (the run recorded 6.85)`,
);
