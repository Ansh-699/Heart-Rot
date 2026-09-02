# decode-verify — is the decode/p95 regression real?

**Verdict: there was no decode regression. There was a single-run gate.**

The archer change adds one `getUint8` per slot to `decodePlayers`. Measured directly, that
byte costs somewhere between −385 ns and +280 ns per call across six independent
benchmark runs — the sign flips run to run, so it is zero within the instrument's
resolution. Its worst-case contribution to the twenty-seat ER row is **0.125 ms/s**
against a reported regression of **+2.7 ms/s**.

The reported regression is bigger than *all the decoding the client does*. Total
parse+decode work at twenty seats, timed in isolation on the same machine, is
**1.35–2.42 ms/s**. You cannot add 2.7 ms/s of decoder cost to a 1.7 ms/s decoder. The
number came from somewhere else, and that somewhere is the instrument: two ER runs of
identical code, taken nine minutes apart in the same sitting, reproduce the same
"regression" with no code change at all.

The p95 finding is the same story and worse. The candidate moved 20-seat p95 144 → 162.5.
Identical code, run against itself, moved it 144 → **245.5**.

Nothing needed fixing on the decode path, and nothing was fixed there. What closed this is
`er_guard_cmp.mjs::requirePair`, which now **refuses** the exact command that produced the
finding.

Not deployed, not measurable on chain today — see §6.

---

## 1. Reproducing the finding, and killing it

`er_guard_cmp.mjs` now refuses a one-run arm outright:

```
$ node scripts/spike/er_guard_cmp.mjs pair-base-1 pair-cand-1
refusing to gate: the baseline arm "pair-base-1" is a single run.
```

Forced through anyway (pass each label twice — pooling a run with itself leaves every mean
and every spread untouched, so this is exactly the arithmetic the original finding used):

| gate | 20-seat p50 | 20-seat p95 | 20-seat decode | result |
|---|---|---|---|---|
| `cand-1` vs `base-1` — the reported finding | 127 → 128.5 | 144 → **162.5** | 3.8 → **6.5** | FAIL 4/20 |
| `base-2` vs `base-1` — **identical code** | 127 → **135** | 144 → **245.5** | 3.8 → **6.6** | FAIL 8/20 |
| `cand-1,cand-2` vs `base-1,base-2` — pooled | 131 → 131.5 | 194.8 → 272.5 | 5.2 → 5.8 | **PASS 20/20** |

Row 2 is the whole answer. Two runs of the *same* code, against the *same* deployed
program, from the *same* working tree, nine minutes apart, produce a larger decode
"regression" (+2.7) and a p95 "regression" five and a half times larger (+101.5 vs +18.5)
than the candidate did. Every failure the single-run form found is smaller than the drift
it finds between two runs that cannot possibly differ.

Pooled — the form the tool now requires — the candidate passes all twenty checks, and the
number the user actually feels, p50, is flat: **131 → 131.5 ms, +0.5 against a limit of 18**.

## 2. What the decoders actually cost

`scripts/spike/decode_bench.ts`. No network, no sends, no websocket: the six **real
payloads** the two ER arms left on devnet, read back by address from the `start` line of
each run.

```
pair-base-1  arena 9JDa8yZZ…  boss 9QYHEjrT…  players 6Z42xCNH…   (program JCfWB9…)
pair-cand-1  arena 5Td4szPn…  boss 1s9N9SGj…  players FqZ7JFk5…   (program AawgMt…)
```

Both `Players` accounts are 1,924 bytes with all twenty seats occupied; both `Arena`
accounts 1,200; both `Boss` 50. **The payload sizes are identical between arms** — the
archer change added no bytes to any account, so the base64 hop costs the same on both
sides, which the `notification bytes/s` gate independently confirms (1,567,189 →
1,559,694 B/s, −0.5%).

Median of 22 blocks × 20,000 calls, every subject warmed before any is timed:

| subject | ns/call | calls/s |
|---|---:|---:|
| `decodeBoss` (50 B) | 126 | 7,900,000 |
| `decodeArena` (1,200 B) | 1,513 | 661,000 |
| `decodePlayers` (1,924 B, 20 seats) | 2,266 | 441,000 |
| base64 → bytes, 1,924 B | 2,915 | 343,000 |
| **parse + `decodePlayers`** | **4,150** | **241,000** |
| parse + `decodeArena` | 3,681 | 272,000 |
| parse + `decodeBoss` | 1,681 | 595,000 |

The base64 hop is the larger half on `Players` (2,915 ns vs 2,266 ns), as
`perf_20seats.ts`'s own header says. It did not change.

## 3. The one byte the archer change added

`decode_bench.ts` carries a copy of `decodePlayers` with the single `classAim:` line
removed and *nothing else* changed — same `open` checks, same `isZero` occupancy scan,
same two 32-byte slices. The copy is asserted field-by-field equal to the shipped decoder
on both real payloads before it is timed, so the delta is that one `getUint8 × 20` and
nothing else.

Six runs, both arms:

```
  +23 ns   -21 ns   +54 ns   -108 ns   -367 ns   +280 ns
```

Mean −23 ns, sign flips four times, worst magnitude 385 ns against a per-call figure of
~2,300 ns. **The byte is free at this resolution.** Twenty extra byte reads costing ~1 ns
each is what the hardware should do, and it is what the hardware does.

Taking the most hostile of those six (+280 ns) and pretending it is signal:

```
280 ns × 312 non-duplicate Players frames/s = 0.087 ms/s
```

At the absolute pessimistic bound (+400 ns) it is **0.125 ms/s** — 4.6% of the +2.7 ms/s
that was reported.

## 4. The accounting asked for

At `pair-cand-1`'s own recorded twenty-seat frame rates (Players 329.9/s at 5.4%
duplicate, Arena 329.9/s at 97.0%, Boss 10/s at 0%), the measured per-call costs predict:

```
predicted decodeMsPerSec = 1.35 … 2.42 ms/s   (five bench runs)
recorded  decodeMsPerSec = 6.85 ms/s
```

| where the reported +2.7 ms/s came from | ms/s | share |
|---|---:|---:|
| real cost of the `classAim` byte (hostile bound) | ≤ 0.13 | ≤ 5% |
| real cost of anything else in the change | 0 | 0% |
| instrument artefact — single-run arm | ≥ 2.57 | ≥ 95% |
| **recovered by a fix to the decode path** | **0 — none was needed** | |

The +2.7 ms/s exceeds the total real decode cost (1.35–2.42 ms/s), so it cannot be
decoder work under any attribution.

## 5. Why `decodeMsPerSec` over-reports, and why it drifts

Two mechanisms, both measured here rather than asserted.

**It is a mean over a heavy tail.** `decodeMsPerSec` is a *sum* of per-frame `decodeUs`,
so it is driven by the mean, and the distribution is not symmetric: at twenty seats
`pair-cand-1` recorded Players p50 10.0 µs against p95 27.9 µs. A run with a few more GC
pauses lands a much larger sum with an unchanged median. That is why the row is 2–4× the
isolated bench floor while the *p50* per-call figures sit within 1.0–1.5× of it.

**Its drift is common-mode across decoders the change never touched.** `decodeArena` is
the control: the archer change did not touch it and its bytes did not change. Twenty-seat
`decodeUsP50`, both blocks per run averaged:

| run | arena µs | players µs | boss µs | decode ms/s |
|---|---:|---:|---:|---:|
| pair-base-1 | 2.96 | 6.42 | 1.51 | 3.82 |
| pair-base-2 | 5.48 | 9.58 | 3.27 | 6.57 |
| pair-cand-1 | 4.81 | 9.58 | 7.18 | 6.54 |
| pair-cand-2 | 4.22 | 7.68 | 2.54 | 5.12 |
| **base pooled** | 4.22 | 8.00 | 2.39 | 5.20 |
| **cand pooled** | 4.51 | 8.63 | 4.86 | 5.83 |
| **cand / base** | **1.07** | **1.08** | 2.03 | 1.12 |

`decodeArena` and `decodePlayers` move by the *same* 7–8% between arms. And between the
two identical-code base runs, the untouched `decodeArena` moved **1.85×** — more than
`decodePlayers` did (1.49×). A whole run is fast or a whole run is slow; the harness
process is concurrently `JSON.parse`-ing ~700 notifications/s and signing and POSTing
twenty seats of transactions, and the `hrtime` window around the decode catches the
scheduler doing that. Nothing about that is attributable to a decoder.

The same effect is visible in the offline bench: run it while a `tsc` is running and every
row inflates ~50% together, including `decodeBoss`, which touches 50 bytes.

## 6. What could NOT be measured, and why

**A fresh paired ER run is not possible on this tree without a deploy.** Two independent
blockers, both verified:

1. **The base arm has no client.** `instructions.ts:492` is `alloc(IX_CLAIM_SEAT, 67)` with
   `data[67] = p.class` — 68 bytes on the wire. The deployed live program
   (`JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`) takes 67. A base-arm run from this
   tree dies at `claim_seat` with `InvalidInstructionData`. Reconstructing a 66-byte-arg
   client means editing product code, which this task may not do.
2. **The candidate arm would measure stale program bytes.** The candidate program
   `AawgMtVunJcfGmmESfpzxnvy8SZmXJUBsmLAcShwHodZ` is still live on devnet — all three of
   its accounts read back fine — but it was deployed from `heartrot.so`
   `sha256 548e004f…`, and the current build is `a155707b…`. Running against it today
   would not measure the tree that is about to ship.

So the on-chain arm needs the deploy first. What it needs is a **paired, interleaved,
two-runs-per-arm** sitting after the program is up:

```
./scripts/spike/er_guard.sh post-1 && ./scripts/spike/er_guard.sh post-2
node scripts/spike/er_guard_cmp.mjs pair-cand-1,pair-cand-2 post-1,post-2
```

Everything in §§2–5 is machine-local and needed no chain, and it is the half that actually
answers "did the decoder get slower".

## 7. One thing worth knowing about the gate that now passes

The pooled p95 check at twenty seats passed with `delta +77.8 / limit 354`. That limit is
`2 × the baseline pair's own 177 ms spread`, on a 195 ms baseline — the gate is currently
wide enough that it would not catch a genuine doubling of p95. That is the spread-derived
limit working as designed (a constant limit fires on a noisy evening), but it means
**p95 PASS at twenty seats is presently weak evidence, and p50 is the row carrying the
verdict.** p50 is tight (`limit 18` on a 131 ms baseline) and flat at +0.5 ms.

## 8. Reproducing this

```
node scripts/spike/er_guard_cmp.mjs pair-base-1,pair-base-1 pair-base-2,pair-base-2
node scripts/spike/er_guard_cmp.mjs pair-cand-1,pair-cand-2 pair-base-1,pair-base-2

node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/decode_bench.ts --bundle --platform=node --format=esm \
  --alias:@heartrot/client=./packages/client/src/index.ts \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=/tmp/decode_bench.mjs && node /tmp/decode_bench.mjs
```

Payloads are checked in at `scripts/spike/decodebench/{base,cand}-{arena,boss,players}.b64`;
re-fetch them with `getAccountInfo` on the addresses in §2 if devnet ever prunes them.

Gates re-run this session on the tree as measured: `app` tsc 0, `packages/client` tsc 0,
`worker` tsc 0.
