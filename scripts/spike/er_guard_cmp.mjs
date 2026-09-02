#!/usr/bin/env node
/**
 * ER-GUARD-CMP — reduce an `er_guard.sh` run to a table, and gate a candidate against a
 * stored baseline.
 *
 *   node scripts/spike/er_guard_cmp.mjs <label>                    # print one run
 *   node scripts/spike/er_guard_cmp.mjs <base1,base2> <cand1,cand2>   # gate; exit 1 on fail
 *
 * The gate takes TWO RUNS PER ARM and refuses one — see `requirePair`. Measured on the runs
 * checked in beside it, two runs of identical code fail 8 of 20 checks against each other.
 *
 * The palindrome (1 5 10 20 20 10 5 1) visits every seat count twice, minutes apart in
 * both directions. This folds each pair to its mean and reports the pair's SPREAD beside
 * it. That spread is the run's own noise floor, measured in the same run: any threshold
 * below it would fire on drift alone, and the gate prints both so the threshold can be
 * audited against the data it is supposed to sit above rather than against a guess.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'docs', 'perf', 'er-guard');
// `lobby` is kept only so the pre-2026-09-02 runs in docs/perf/ can still be read back.
// er_guard.sh no longer produces one — `start_match` refuses an empty pit (`NoRaiders`).
const MODES = ['fight', 'lobby'];

/**
 * A regression is a candidate worse than the baseline by more than the limit, and the
 * limit is not a constant — it is
 *
 *     max(floor, SPREAD_K x the baseline row's own palindrome spread)
 *
 * because a constant calibrated on a quiet evening fires on a noisy one. Measured
 * 2026-09-02: the same twenty-seat block that showed a 1 ms p95 spread on 2026-09-01
 * showed 44 ms the next morning, on identical code. A fixed 20 ms p95 gate would have
 * called that a regression. The floor is still there so a suspiciously quiet run cannot
 * produce a zero-width gate and pass anything.
 *
 * This only works if BEFORE and AFTER are run in the same sitting. They must be.
 */
const SPREAD_K = 2;
const GATE = [
  { key: 'p50', label: 'write-to-visible p50', abs: 5, unit: 'ms' },
  { key: 'p95', label: 'write-to-visible p95', abs: 15, unit: 'ms' },
  { key: 'ackRate', label: 'accepted moves', abs: 5, unit: 'pt', lowerIsWorse: true },
  { key: 'bytesPerSec', label: 'notification bytes/s', rel: 0.15, unit: 'B/s' },
  // "parse+decode", not "decode": the harness times `fromBase64` and the decoder together
  // because the browser runs them together, and the base64 hop is the LARGER of the two
  // (2,956 ns vs 1,655 ns on a 1,924-byte Players payload). The JSON key keeps the old name
  // so every run already under docs/perf/er-guard still reads back.
  { key: 'decodeMsPerSec', label: 'client parse+decode', rel: 0.3, unit: 'ms/s' },
];

/**
 * The PS_* knobs the run was driven with. Two runs that differ in any of them are two
 * different experiments, and comparing them is exactly the mistake `docs/spikes/sp-load.md`
 * made and admits to — a 405 ms solo baseline against a 200 ms twenty-seat run, where part
 * of the gap was that the two arms polled differently.
 */
function knobs(labels) {
  const all = labels.split(',').map((label) => {
    const path = join(DIR, label.trim(), 'env.txt');
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('PS_'))
      .sort()
      .join(' ');
  });
  if (all.some((k) => k === null)) return null;
  if (new Set(all).size > 1) {
    console.error(`refusing: the runs pooled as "${labels}" used different knobs`);
    process.exit(2);
  }
  return all[0];
}

/**
 * `labels` is one label or a comma-separated list of them, and a list is POOLED: every
 * block from every run lands in the same per-seat-count bucket.
 *
 * Two runs per arm, not one, and this is the whole reason the tool exists in this shape.
 * The palindrome measures drift WITHIN a run and reports 1–2 ms of p50 spread at twenty
 * seats. Measured 2026-09-02, two runs of identical code five minutes apart drifted
 * 7.5 ms at the same row — four times what the palindrome sees — and gating one against
 * the other reported seven regressions in code that had not changed. Pooling replicates
 * puts that drift inside the spread the limit is derived from, so the gate widens on a
 * noisy evening instead of crying wolf on one.
 */
function load(labels, mode) {
  const report = [];
  for (const label of labels.split(',')) {
    const path = join(DIR, label.trim(), `${mode}.jsonl`);
    if (!existsSync(path)) return null;
    const line = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.includes('"event":"table"'))
      .pop();
    if (line === undefined) throw new Error(`${path} has no table event — the run did not finish`);
    report.push(...JSON.parse(line).report);
  }

  // Fold: one row per seat count, mean of its blocks, plus their full spread.
  const rows = new Map();
  for (const b of report) {
    if (b.seats === 0) continue;
    const v = {
      p50: b.writeToVisibleAll.p50,
      p95: b.writeToVisibleAll.p95,
      ackRate: b.ackRate,
      bytesPerSec: b.bytesPerSec,
      decodeMsPerSec: b.decodeMsPerSec,
      framesPerSec: b.framesPerSec,
      n: b.writeToVisibleAll.n,
    };
    if (!rows.has(b.seats)) rows.set(b.seats, []);
    rows.get(b.seats).push(v);
  }
  return [...rows.entries()]
    .sort((a, c) => a[0] - c[0])
    .map(([seats, vs]) => {
      const out = { seats, visits: vs.length, n: vs.reduce((a, v) => a + v.n, 0) };
      void out.visits;
      for (const k of ['p50', 'p95', 'ackRate', 'bytesPerSec', 'decodeMsPerSec', 'framesPerSec']) {
        const xs = vs.map((v) => v[k]).filter((x) => typeof x === 'number');
        out[k] = xs.length === 0 ? null : xs.reduce((a, x) => a + x, 0) / xs.length;
        out[`${k}Spread`] = xs.length < 2 ? null : Math.max(...xs) - Math.min(...xs);
      }
      return out;
    });
}

const r1 = (x) => (x === null || x === undefined ? '  -  ' : (Math.round(x * 10) / 10).toString());

function show(label) {
  for (const mode of MODES) {
    const rows = load(label, mode);
    if (rows === null) continue;
    console.log(`\n${label} / ${mode}   (${rows[0]?.visits ?? 0} blocks per row; value ± spread)`);
    console.log('  seats  samples  p50 ms     p95 ms     ack %     KB/s       decode ms/s  frames/s');
    for (const r of rows) {
      console.log(
        `  ${String(r.seats).padStart(5)}  ${String(r.n).padStart(7)}  ` +
          `${(r1(r.p50) + '±' + r1(r.p50Spread)).padEnd(11)}` +
          `${(r1(r.p95) + '±' + r1(r.p95Spread)).padEnd(11)}` +
          `${(r1(r.ackRate) + '±' + r1(r.ackRateSpread)).padEnd(10)}` +
          `${(r1(r.bytesPerSec / 1024) + '±' + r1(r.bytesPerSecSpread / 1024)).padEnd(15)}` +
          `${(r1(r.decodeMsPerSec) + '±' + r1(r.decodeMsPerSecSpread)).padEnd(13)}` +
          `${r1(r.framesPerSec)}`,
      );
    }
  }
}

/**
 * Two runs per arm, REFUSED rather than merely recommended.
 *
 * `load`'s own header has said since it was written that gating one run against one run
 * "reported seven regressions in code that had not changed", and it was still the shape
 * everybody reached for, because nothing stopped them. Re-measured 2026-09-02 on the runs
 * checked in beside this file, and it is worse than the header says:
 *
 *     er_guard_cmp.mjs pair-base-1 pair-base-2               FAIL — 8 of 20
 *     er_guard_cmp.mjs pair-base-1,pair-base-2 \
 *                      pair-cand-1,pair-cand-2               PASS over 20
 *
 * The first of those compares a run to ANOTHER RUN OF THE SAME CODE and reports the twenty
 * seat decode row moving 3.8 -> 6.6 ms/s and p95 144 -> 245.5 ms. The second compares the
 * real base to the real candidate and reports nothing. Every "regression" the single-run
 * form finds at twenty seats is smaller than the drift it finds between two identical runs,
 * so a single-run arm cannot answer the question it is asked and must not be allowed to
 * look as though it did. A one-run arm is a report (`er_guard_cmp.mjs <label>`), never a
 * gate.
 */
function requirePair(label, which) {
  if (label.split(',').filter((l) => l.trim() !== '').length >= 2) return;
  console.error(`refusing to gate: the ${which} arm "${label}" is a single run.`);
  console.error('  Two runs per arm, interleaved in one sitting. Measured on the runs in');
  console.error('  docs/perf/er-guard: two runs of IDENTICAL code fail 8 of 20 checks');
  console.error('  against each other, and the same rows pass pooled. Pass a comma-separated');
  console.error('  pair, e.g.  er_guard_cmp.mjs base-1,base-2 cand-1,cand-2');
  console.error('  For a single run, print it instead:  er_guard_cmp.mjs <label>');
  process.exit(2);
}

function gate(baseLabel, candLabel) {
  requirePair(baseLabel, 'baseline');
  requirePair(candLabel, 'candidate');
  const kb = knobs(baseLabel);
  const kc = knobs(candLabel);
  if (kb !== null && kc !== null && kb !== kc) {
    console.error(`refusing to compare: the two runs used different knobs`);
    console.error(`  ${baseLabel}: ${kb}`);
    console.error(`  ${candLabel}: ${kc}`);
    process.exit(2);
  }
  let failed = 0;
  let compared = 0;
  for (const mode of MODES) {
    const base = load(baseLabel, mode);
    const cand = load(candLabel, mode);
    // Silent when neither side has the mode — `lobby` is normally absent now (§6.2).
    if (base === null && cand === null) continue;
    if (base === null || cand === null) {
      console.log(`\n${mode}: SKIPPED (missing ${base === null ? baseLabel : candLabel})`);
      continue;
    }
    console.log(`\n=== ${mode}: ${candLabel} vs ${baseLabel} ===`);
    for (const b of base) {
      const c = cand.find((x) => x.seats === b.seats);
      if (c === undefined) continue;
      for (const g of GATE) {
        if (b[g.key] === null || c[g.key] === null) continue;
        compared += 1;
        const delta = g.lowerIsWorse ? b[g.key] - c[g.key] : c[g.key] - b[g.key];
        const spread0 = b[`${g.key}Spread`] ?? 0;
        const limit = Math.max(g.abs ?? b[g.key] * g.rel, SPREAD_K * spread0);
        const bad = delta > limit;
        if (bad) failed += 1;
        console.log(
          `  ${bad ? 'FAIL' : 'ok  '} ${String(b.seats).padStart(2)} seats  ${g.label.padEnd(22)}` +
            `${r1(b[g.key])} -> ${r1(c[g.key])} ${g.unit}   ` +
            `delta ${delta > 0 ? '+' : ''}${r1(delta)} / limit ${r1(limit)} ` +
            `(baseline pair spread ${r1(spread0)})`,
        );
      }
    }
  }
  console.log(`\n${failed === 0 ? 'PASS' : `FAIL — ${failed} regression(s)`} over ${compared} checks`);
  return failed;
}

const [a, b] = process.argv.slice(2);
if (a === undefined) {
  console.error('usage: er_guard_cmp.mjs <labels> | er_guard_cmp.mjs <baseLabels> <candLabels>');
  console.error('  <labels> may be a comma-separated list; runs in a list are pooled.');
  process.exit(2);
}
if (b === undefined) show(a);
else process.exitCode = gate(a, b) === 0 ? 0 : 1;
