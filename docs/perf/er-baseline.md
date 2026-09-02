# er-baseline — what "do not degrade the ER speed" means as a number, and the instrument that proves it

Date: **2026-09-02**. Program: `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, devnet,
routed through `devnet-as.magicblock.app`.
Harness: `scripts/spike/er_guard.sh` → `scripts/spike/perf_20seats.ts` → `scripts/spike/er_guard_cmp.mjs`.
Raw: `docs/perf/er-guard/*/fight.jsonl`, knobs beside each in `env.txt`.

---

## The five things this document establishes

**1. A single before/after comparison cannot detect a latency regression on this network,
and the number everyone was about to use is unusable.** Two runs of *identical, unmodified*
code, five minutes apart, differ by **7.5 ms at p50 and 78 ms at p95** at twenty seats.
Gate one against the other with a fixed threshold and it reports **seven regressions in
code that did not change** (§2). The gate therefore pools **two runs per arm** and derives
its limit from the spread it observes rather than from a constant.

**2. Today's floor, on the shipped build, at twenty seats: write-to-visible p50 129.8 ms,
p95 270.5 ms, 80.5 % of moves accepted, 1,530 KB/s of notifications, 668 frames/s.**
Twenty-five thousand samples across four blocks in two runs. Today's line is 7 ms slower
at p50 and about twice as noisy at p95 as 2026-09-01's — which is why "reproduce it today"
was the right instruction (§2).

**3. Firing does not cost anything measurable, and that is the single most useful result
here.** `shoot` names `Arena`, `Boss` **and** `Players` all WRITABLE, where `move` names
only `Players` — so twenty seats holding the trigger is ~24 fully-serialising writes/s
landing on top of the crank's 10 `boss_tick`/s. Nobody had ever measured it, because the
harness had never fired a shot. With the shoot arm on, p50 at twenty seats moves **129.8 →
129.3 ms** — inside the 7.5 ms the network drifts on its own. What it does cost is
+10.3 % of notification bytes and +12.8 % of frames, which lands on the browser rather
than on the chain (§4).

**4. Two of the planned changes cost literally zero on the wire; a third costs 0.9 % and
should not be built.**
The archer class byte is free (`PlayerSlot._pad0` exists, offset 3, and the account does
not grow). Arrows placed in the existing `arena.bullets` pool are free — those 128 slots
are already inside every `Arena` notification. A *new* array in `Arena` is not free, and
§5 prices it at +13.7 KB/s and a delegated-account resize. §5 also names the one thing on
the list that can plausibly cost real latency, and it is not on the chain at all.

**5. The instrument was broken and is now fixed, twice.** Its hand-copied 64-row wall
bitboard had gone stale against a redrawn map, so it planned every step into a wall and
failed with "20 seats never reached the gate"; and its `lobby` mode is now refused by the
program itself. Both are §6. A harness that silently measures nothing is worse than none.

---

## 0. The instrument, and why it is the old one

`scripts/spike/perf_20seats.ts` already existed and already produced every number in
`docs/perf/twenty-seats.md`. It was not rewritten. BEFORE and AFTER have to be the same
instrument, and the cheapest way to guarantee that is to not build a second one.

What was added is a wrapper, `scripts/spike/er_guard.sh`, which does one job: it pins the
knobs. The sweep, the send period, the block length, the spam switch and the shoot period
are all environment variables with defaults, and a run driven with different ones is a
different experiment. `docs/spikes/sp-load.md` is this project's own record of what that
costs — it compared a 405 ms solo baseline against a 200 ms twenty-seat run and says in
its own text that part of the gap was that the two arms polled differently.

```
scripts/spike/er_guard.sh <label> [programId]     # ~5 min, writes docs/perf/er-guard/<label>/
node scripts/spike/er_guard_cmp.mjs <labels>      # print
node scripts/spike/er_guard_cmp.mjs <base> <cand> # gate; exit 1 on regression
```

Both label arguments accept a comma-separated list, and a list is pooled. `er_guard.sh`
writes the pinned knobs, the node version and the sha256 of `target/deploy/heartrot.so`
into `env.txt`, and `er_guard_cmp.mjs` **refuses to compare two runs whose knobs differ**.

### What it measures, per 20-second block

- **write-to-visible** — a `move` carries a u16 `seq`, the program echoes it into
  `PlayerSlot.last_move_seq`, and the sample is (arrival of the websocket frame carrying
  that exact seq) − (the moment the send was decided). Exact seq only: `last_move_seq` is
  a high-water mark, and charging a superseded send with a later write's round trip
  reports a round trip nobody made. Same rule as `app/src/net/metrics.ts`.
- **accepted moves** — acked ÷ sent for the block. Sends are `skipPreflight` and fire and
  forget, so a move the chain *refuses* looks identical to one it accepts from the
  sender's side; the only evidence of refusal is a seq that never surfaces.
- **notification bytes/s and frames/s** — the wire byte length of every message on one raw
  websocket carrying exactly what `app/src/net/subscribe.ts` opens: three
  `accountSubscribe`s on `Arena`, `Boss`, `Players`, `encoding: 'base64'`, pinned to the ER.
- **client parse+decode ms/s** — `fromBase64` **and** the shipped `decodeArena` /
  `decodeBoss` / `decodePlayers`, timed together with `hrtime` after a 20,000-iteration JIT
  warm-up, on the frames a browser would actually decode. Three things about that sentence
  are deliberate and each was once wrong in the harness:
  - *Together*, because the browser runs them together — `deliverEncoded` calls
    `deliver(kind, fromBase64(encoded))`. The base64 hop is the **larger** term: 2,956 ns
    against the decoder's 1,655 ns on a 1,924-byte `Players` payload. The row is named for
    its smaller half; the JSON key is still `decodeMsPerSec` so every stored run reads back.
  - *On the frames a browser would decode*, because `deliverEncoded` returns on a
    byte-identical payload **before** `fromBase64`. The harness used to decode every frame
    and compute `duplicate` afterwards, which charged the client for work it does not do —
    at twenty seats 390 of 769 notifications/s are byte-identical, so the row was roughly
    double.
  - Do not read this row alone; see the base-against-base command in §2.

### The sweep

`quiet 1 5 10 20 20 10 5 1`, 20 s a block, 6 s of silence between, one seat sending every
50 ms — the app's real cadence (`controls.ts` `MOVE_MS`). `quiet` is the crank ticking with
nobody sending. The palindrome is load-bearing: a monotonic ramp charges any drift in the
network's mood to the seat count, and visiting each count twice in opposite directions
makes drift cancel at the pair's mean.

Mode is always `fight`: twenty seats walked to the gate, through it, and into `ZONE_ARENA`
with a live boss volleying at them for the whole sweep. That is the mode that carries the
crank's swept-collision loop, which is where added projectiles would cost.

---

## 1. Today's baseline

Shipped build, `sha256(target/deploy/heartrot.so) = 417bcec791bb85eb…`, which is verified
byte-identical to what is on chain (§6.1). No `shoot` traffic — matching every number
banked before today.

Pooled over `base-2026-09-02` + `base-2026-09-02-b`, four blocks per row:

| seats | samples | write-to-visible p50 | p95 | accepted | KB/s | decode ms/s | frames/s |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1,308 | 135 ± 14 | 204.3 ± 133 | 82.0 % ± 26.8 | 125.8 ± 24.4 | 1.0 | 62.8 |
| 5 | 6,284 | 130 ± 10 | 197 ± 179 | 78.8 % ± 23.6 | 416.5 ± 101.7 | 1.9 | 188.1 |
| 10 | 12,755 | 129.8 ± 6 | 296 ± 180 | 80.1 % ± 11.6 | 799.8 ± 90 | 2.7 | 353.4 |
| **20** | **25,277** | **129.8 ± 9** | **270.5 ± 181** | **80.5 % ± 5.1** | **1,530.2 ± 111.3** | **3.8** | **668.4** |

± is the full spread across the four blocks, not a standard deviation.

**The shape from `twenty-seats.md` reproduces: twenty seats are not slower than one.**
129.8 ms p50 at twenty against 135 ms at one. `move` takes `Arena` READONLY, so concurrent
movers do not serialise on it, and at higher seat counts each ER slot is fuller so a send
waits less for the next one.

**The level does not reproduce, and that is the point of re-measuring.**

| | 2026-09-01 (fight) | 2026-09-02 (pooled) |
|---|---:|---:|
| p50 @ 20 | 122 ms | 129.8 ms |
| p95 @ 20 | 147 ms | 270.5 ms |
| accepted @ 20 | 94.2 % | 80.5 % |
| KB/s @ 20 | 1,763 | 1,530 |
| p50 @ 1 | 134.5 ms | 135 ms |

Same program, same harness, same twenty seats, one day apart: **+7.8 ms at p50, +123 ms at
p95, −13.7 points of acceptance.** Gating today's build against yesterday's numbers would
have reported eight regressions in code nobody touched — the tool prints exactly that if
asked (`er_guard_cmp.mjs prev-2026-09-01 base-2026-09-02`). Yesterday's numbers are kept in
`docs/perf/er-guard/prev-2026-09-01/` for shape, never for level.

### The crank-only floor

The `quiet` block — crank ticking, nobody sending:

| account | frames/s | wire B/s | payload B/frame | duplicate payloads |
|---|---:|---:|---:|---:|
| `Arena` | 10 | 18,900 | 1,600 (= 1,200 B base64) | 0 % |
| `Players` | 10 | 28,590 | 2,568 (= 1,924 B base64) | 100 % |
| `Boss` | 10 | 3,560 | 68 (= 50 B base64) | 94.5 % |
| **total** | **30** | **51,050** | | |

Both payload sizes land exactly on `state.rs`'s `size_of` assertions, which is what makes
§5's byte arithmetic something you can do on paper rather than guess at.

---

## 2. Why the threshold is not a constant

The obvious gate is "fail if p50 rose more than N ms". It does not work here, and the
reason is measured, not argued.

**Within a run**, the palindrome's two visits to the same seat count agree very closely.
2026-09-01: p50 spread 0–2 ms, p95 spread 1–8 ms. 2026-09-02 at twenty seats: p50 spread
1–2 ms. On that evidence a 5 ms p50 gate looks generous.

**Between two runs of identical code five minutes apart**, they do not:

| seats | p50 run A → run B | p95 A → B | accepted A → B | KB/s A → B |
|---:|---|---|---|---|
| 1 | 139.5 → 130.5 (**9.0**) | 233 → 175.5 (**57.5**) | 77.8 → 86.1 (**8.3 pt**) | +6.1 % |
| 5 | 133.5 → 126.5 (**7.0**) | 242.5 → 151.5 (**91**) | 73.1 → 84.6 (**11.5 pt**) | +12.7 % |
| 10 | 132.5 → 127 (**5.5**) | 273 → 319 (**46**) | 80.0 → 80.2 (0.2 pt) | −0.4 % |
| 20 | 133.5 → 126 (**7.5**) | 309.5 → 231.5 (**78**) | 80.1 → 81.0 (0.9 pt) | +1.0 % |

**Run-to-run drift on unchanged code is roughly four times the within-run spread at p50
and forty times it at p95.** The palindrome cancels drift *inside* a run; it cannot see
drift *between* runs, and BEFORE and AFTER are, necessarily, different runs.

Gating run B against run A with a fixed 5 ms / 15 ms / 5 pt rule reports **7 regressions
over 20 checks** on identical code. That is the false-positive rate a constant threshold
buys, and it is unusable: a gate that cries wolf gets ignored, and then it is not a gate.

### The rule

> **A regression is a candidate arm worse than the baseline arm, on the same metric and
> the same seat count, by more than `max(floor, 2 × the baseline arm's observed spread)`,
> where each arm is TWO runs pooled — four blocks per row — taken in the same sitting as
> the other arm.**

| metric | floor | why the floor |
|---|---|---|
| write-to-visible p50 | 5 ms | 10 % of the 50 ms ER slot: below this nothing a player can feel has changed |
| write-to-visible p95 | 15 ms | the tail is the noisiest thing measured; a smaller floor is noise |
| accepted moves | 5 pt | one point is ~4 refused moves per seat per block |
| notification bytes/s | 15 % | `Arena` growing by a whole new 128-slot array is +26.8 % on `Arena` and +0.9 % on the total (§5.3) — 15 % catches the former class of change |
| client parse+decode ms/s | 30 % | 3.8 ms/s of a 1,000 ms budget; it has to grow a lot before it matters. **Read this row last**: it is the noisiest of the five, and base-against-base moves it further than any candidate has (see below) |

`2 ×` the spread is what makes the gate adapt. Pooling replicates puts run-to-run drift
*inside* that spread, so on today's noisy morning the effective p50 limit at twenty seats
is 2 × 9 = **18 ms**, and on a quiet evening like 2026-09-01 it collapses to the 5 ms
floor. The gate is therefore honest about its own power: it does not claim to detect a
6 ms regression on a day when the network moves 9 ms on its own.

**Two consequences the Load phase must honour, or the number is worthless:**

1. **Two runs per arm.** `er_guard.sh base-X` then `er_guard.sh base-X-b`, and gate with
   `er_guard_cmp.mjs base-X,base-X-b cand-Y,cand-Y-b`.
2. **All four runs in one sitting**, interleaved if possible. Today's baseline is a
   *shape* reference and a *method* reference. Its levels are today's evening, and a
   candidate measured next week must be gated against a fresh baseline captured beside it.
   `er_guard.sh` is ~5 minutes; there is no excuse.

### The rule is now enforced, and here is the command that shows why

`er_guard_cmp.mjs` **refuses** a single-run arm as of 2026-09-02 (`requirePair`). It used
to only document the rule in a function header, and the single-run form stayed the one
everybody reached for, because nothing stopped them — and it produced a formal report of a
decode and p95 regression in the archer run that does not exist.

Both halves are reproducible from the runs checked in under `docs/perf/er-guard/`, in about
a second, with no network:

```
$ node scripts/spike/er_guard_cmp.mjs pair-base-1 pair-base-2
  FAIL 20 seats  client parse+decode   3.8 -> 6.6 ms/s     delta +2.7 / limit 1.1
  FAIL 20 seats  write-to-visible p95  144 -> 245.5 ms     delta +101.5 / limit 16
  FAIL — 8 regression(s) over 20 checks          # ...on IDENTICAL code, both arms base

$ node scripts/spike/er_guard_cmp.mjs pair-base-1,pair-base-2 pair-cand-1,pair-cand-2
  ok   20 seats  client parse+decode   5.2 -> 5.8 ms/s     delta +0.6 / limit 7.2
  ok   20 seats  write-to-visible p95  194.8 -> 272.5 ms   delta +77.8 / limit 354
  PASS over 20 checks                            # ...base vs the real archer candidate
```

Read those two together. **Base-against-base moves the twenty-seat decode row further
(3.8 → 6.6) than base-against-candidate does (5.2 → 5.8), and moves p95 further (144 →
245.5) than the candidate does (194.8 → 272.5).** Every "regression" the single-run form
reported for the archer work is smaller than the drift the same form finds between two runs
of code that did not change. Pooled — the only form the tool now accepts — the archer
candidate passes all twenty checks, at every seat count, on both metrics.

The lesson generalises past this one candidate: **before believing any row in this table,
run the base-against-base command.** It costs a second and it is the cheapest possible
answer to "is this row real".

---

## 3. What the gate is blind to, and what covers it

`er_guard` is a Node process. It never renders a frame. It therefore cannot see:

| blind spot | covered by |
|---|---|
| the browser's main thread delaying a send | `scripts/spike/framebudget/` (`docs/perf/frame-budget.md`) and `scripts/spike/perf_appath.ts` |
| React re-render cost per notification | `scripts/spike/framebudget/` |
| CU per instruction | `scripts/spike/cu/` (`docs/perf/chain-cost.md`) |
| bundle size / first paint | `scripts/spike/bundle_size.mjs`, `bundle_load.mjs` |

The first row is not a footnote. `app/src/input/controls.ts:381` pumps sends from
`setInterval(pump, 50)` — **on the main thread**, the same one the scene renders on.
`frame-budget.md` §4 measured that under a 6× CPU throttle at twenty seats the client
services ~62 notifications/s of the ~700 arriving and produces frames costing 11–17 ms.
Every over-budget frame is a `pump` that fires late, and a late pump is write-to-visible
the player actually feels. **A change that only makes the scene heavier will show as zero
in `er_guard` and as real lag in the game.** That is why §5's client rows point at the
frame-budget harness and not at this one.

---

## 4. The shoot arm — the biggest untested load, measured

`docs/perf/chain-cost.md` §5.2 records, without measuring it, that `shoot` takes a write
lock on `Arena` for no write:

| instruction | Arena | Boss | Players |
|---|---|---|---|
| `move` | READONLY | — | WRITABLE |
| `shoot` | **WRITABLE** | **WRITABLE** | **WRITABLE** |
| `boss_tick` | WRITABLE | WRITABLE | WRITABLE |

Twenty seats holding fire is one shot per 800 ms each (`shoot.rs`
`SHOT_COOLDOWN_TICKS = ticks_for(800) - 1 = 7`, compared strictly greater), so ~25
fully-serialising writes/s arriving alongside the crank's 10/s. Nothing in this repo had
ever measured it, for a simple reason: **the harness had never fired a single shot.**

`PS_SHOOT_MS` was added for exactly this. It gives every active seat its own fire loop at
850 ms — 850 and not 800, because the guard is `tick <= last_shot_tick + 7` and a period
sitting exactly on the boundary would measure the rate limiter instead of the load.

Shots are aimed **due south, away from the boss, and miss by construction.** 160 seconds of
sweep at ~24 accepted shots/s is ~3,800 shots; at `SHOT_DAMAGE` 40 a hitting arm would
strip the boss and flip the phase to `SETTLING` part-way through, ending the measurement
rather than loading it. A miss still costs the whole transaction, all three WRITABLE locks,
`octant`, the `raycast` walk (a full miss walks *further* than a hit — 16,699 CU against
12,527 for a 200-unit hit, `chain-cost.md` §3) and the `last_shot_tick` write. What it does
not cost is the `Boss` part write, so `Boss` notifications are understated by up to
24/s × 356 B = 8.5 KB/s against a 1,530 KB/s total — **0.5 %**.

### The result

Two runs with the arm on, pooled, against the two runs without — same evening, same
program, four runs inside forty minutes. 1,728 shots sent across the sweep, 5 POST failures.

| seats | p50 (no shoot → shoot) | p95 | accepted | KB/s | frames/s | decode ms/s |
|---:|---|---|---|---|---|---|
| 1 | 135 → 134.8 | 204.3 → 179.3 | 82.0 → 84.1 | 125.8 → 131.9 | 62.8 → 66.3 | 1.0 → 0.6 |
| 5 | 130 → 131.5 | 197 → 188.5 | 78.8 → 81.4 | 416.5 → 445.8 | 188.1 → 204.9 | 1.9 → 1.7 |
| 10 | 129.8 → 130.5 | 296 → 294.3 | 80.1 → 80.0 | 799.8 → 831 | 353.4 → 375.3 | 2.7 → 2.7 |
| **20** | **129.8 → 129.3** | **270.5 → 198.8** | **80.5 → 84.9** | **1,530.2 → 1,688.4** | **668.4 → 754.2** | **3.8 → 4.5** |

**Latency: nothing.** p50 at twenty seats moves 129.8 → 129.3 ms, against a run-to-run
drift of 7.5 ms on identical code (§2). Per run the four twenty-seat p50s are 133.5 and 126
without the arm, 128 and 130.5 with it — fully interleaved. **Twenty-four additional
fully-serialising writes per second, on the most write-locked instruction in the program,
are not detectable in write-to-visible at twenty seats.** That is the answer to the
question `chain-cost.md` §5.2 raised and could not settle.

**Notification traffic: a real, consistent increase.** +158 KB/s (+10.3 %) and
+86 frames/s (+12.8 %) at twenty seats. Per run, twenty seats: 1,522.5 and 1,538 KB/s
without the arm, 1,582.8 and 1,794 with it — **all four shoot runs sit above both no-shoot
runs on both metrics**, which on 2 × 2 runs is consistent separation rather than proof.
Twenty-four accepted shots a second each write `last_shot_tick` into `Players`, which
accounts for at most ~24 of the +86 frames/s; **the rest is unattributed** and worth one
`PS_PROBE=1` arm before anyone builds on this number.

**This is the one line that could still bite, and it bites the browser, not the chain.**
`frame-budget.md` §4 measured the client servicing ~62 notifications/s of ~700 at 6× CPU
throttle, and 629/s at 1×. Going 668 → 754 spends about 14 % of the 1× headroom on
notifications the player did not ask for. §5.5, not this document, is where that is caught.

**A note on the tool.** `er_guard_cmp.mjs` **refuses** to gate the shoot arm against the
no-shoot baseline — the two used different `PS_SHOOT_MS`, so they are two experiments and
comparing them as a before/after would be exactly the error `sp-load.md` made. The table
above is a deliberate side-by-side of two load shapes, read from two `show` invocations.
When the Load phase gates a candidate, **both arms must carry the same `PS_SHOOT_MS`**, and
the shoot-loaded arm should be run as its own pair because it is the load the finished
game will actually produce.

---

## 5. Every planned change, priced, with the measurement that catches it

Ordered by how much latency each can plausibly cost. "Free" below means *arithmetically*
free — the byte count does not change — not "assumed harmless".

### 5.1 The archer class byte — free, and provably so

`PlayerSlot` has an explicit `_pad0: u8` at offset 3 (`state.rs:859`), between `skin_id` at
2 and `x` at 4. A class id goes there with no field moving and no account growing:
`size_of::<PlayerSlot>() == 96` and `size_of::<Players>() == 1924` are const-asserts in
`state.rs` and both are reproduced on the wire above (2,568 base64 chars of `Players`
payload = 1,924 B). Every live devnet account already carries `0` in that byte, so **class
0 must be the default class** or every existing seat silently becomes an archer.

- **Notification cost:** zero. `Players` does not grow.
- **CU cost:** one branch in `shoot`. Against `move` at 2,049 CU and `shoot` at up to
  16,699 of a 399,700 ceiling, unmeasurable.
- **Catches it:** `cargo test -p heartrot` (the const-asserts), and the `bytes/s` row of
  the gate if `Players` ever does grow.

### 5.2 Arrows in the existing `arena.bullets` pool — free on the wire, not free in the tick

`Arena` already carries `bullets: [Bullet; 128]`, 8 bytes each, 1,024 of its 1,200 bytes,
and the crank already rewrites and republishes the whole account 10 times a second. **An
arrow that lives in a slot that is already there and already on the wire adds zero bytes
and zero frames.** `Bullet` also has its own `_pad0: u8` at offset 7 (`state.rs:326`) for
an owner tag, with `size_of::<Bullet>() == 8` asserted.

What it does cost is `boss_tick`. `chain-cost.md` §5.3: *"the whole tick is bullets"* — the
swept-collision loop over live bullets × arena players dominates every tick measurement,
and the redesign's win came entirely from shortening bullet lifetime. Worst tick today is
24,884 CU of 399,700 at twenty players (~32,000 on an arena whose child PDAs miss bump
255 — §5.1 of that document, worth 7,500 CU). Twenty archers at 1.25 Hz with a ~1.5 s
flight is roughly **35 more live bullets**, against a pool of 128 that a volley already
fills to `3 × (BASE_VOLLEY_BULLETS + 20)`.

Two things to get right, neither of them latency:

- **Tag the arrow and skip the player inner loop for it.** An arrow must not damage
  raiders. Rejecting it inside `bullet_hits` after the broad phase pays the full pair test;
  a tag checked before the `while i < live_n` loop pays nothing.
- **The pool is now shared.** `tick.rs:284` asserts
  `volleys_in_flight × (BASE_VOLLEY_BULLETS + MAX_SEATS) <= MAX_BULLETS`. Arrows invalidate
  that headroom argument, and a full pool **silently drops the spawn** (`spawn_volley`
  walks the cursor and gives up). Boss volleys starving because twenty archers filled the
  pool is a gameplay bug that looks like a chain bug.

- **Catches it:** `scripts/spike/cu/` re-run at twenty players with ~35 extra live bullets,
  against the 24,884 CU baseline. If `boss_tick` CU/s rises materially the gate's
  `frames/s` and `p95` rows are the downstream symptom, but CU is the direct measurement
  and it is cheap.

### 5.3 A *new* arrow array in `Arena` — not free; do not do this

128 arrows × 8 B = 1,024 B would take `Arena` from 1,200 to 2,224 B. Priced from the
measured floor: `Arena` payload goes 1,600 → 2,968 base64 chars, wire 1,890 → ~3,258 B, and
at the crank's 10 Hz that is **+13.7 KB/s per subscriber — +26.8 % on `Arena`, +0.9 % on
the 1,530 KB/s total.** The wire cost is small. The rest is not: the account is delegated,
the ER is topped up at 6,960 lamports per byte, `LAYOUT_VERSION` moves, and resizing a live
delegated account is a migration, not an edit. `decodeArena` grows with it.

**Recommendation: reuse `arena.bullets` (§5.2).** The wire cost of the whole feature is
then exactly zero.

### 5.4 Making the spacebar work — measured, and it costs nothing

This is not a code change with a *projected* cost; it is a **load** change, and §4 measured
it. Today `shoot` is sent at 0 Hz — `controls.ts:309` gates it on
`phase === PHASE_FIGHTING`, so the waiting area never sends one, and the chain-side
`arena.tick <= last_shot_tick + 7` refuses everything while the crank is not running
(`tick` is 0 and 0 ≤ 0 + 7 forever). After the fix, twenty seats holding fire is ~25/s of
the most write-locked instruction in the program.

The result is in §4. Note the harness's 850 ms period produces ~23.5 shots/s against the
client's tick-driven 25/s — **the arm under-loads by about 6 %**, which is the one place
this document's shoot number is optimistic.

### 5.5 A heavier scene — the real risk, and `er_guard` cannot see it

Deleting the follow camera removes work. Rendering a full-map SVG at higher fidelity, plus
arrows, adds it. `frame-budget.md`'s measured lever is the visible-bullet cap: 128 → 32
drawn bought −2.08 ms p50, −2.04 ms p95, 7.2 % → 4.6 % of frames over budget at 6× throttle.
**If arrows are drawn outside that cap, the cap's win is spent.** Whatever the arrow node
count is, it belongs inside the same 32.

- **Catches it:** `scripts/spike/framebudget/` at twenty knights, 6× throttle, at the
  measured 714 notifications/s — comparing against `docs/perf/frame-budget.md`'s 9.38 ms
  p50 / 14.92 ms p95 / 4.6 % over budget. And `scripts/spike/perf_appath.ts` for
  write-to-visible on the real app path, which is where a late `setInterval` pump shows up.

### 5.6 Client decode and the dedupe — already paid for, keep it

`app/src/net/subscribe.ts` now drops byte-identical payloads (it did not when
`twenty-seats.md` was written). It earns its keep: at the quiet floor, **100 % of `Players`
frames and 94.5 % of `Boss` frames repeat the previous payload byte for byte.** Decode is
3.8 ms/s at twenty seats — 0.4 % of one core. Anything that defeats the dedupe by writing a
counter into `Players` every tick would triple that and, worse, triple the React
re-renders, which `frame-budget.md` §4 costs at +4.94 ms p50 and −83 displayed fps at 6×.

- **Catches it:** the gate's `decode ms/s` row (30 % floor) and the `duplicatePct` column
  in the raw `byKind` output.

### 5.7 The free lever nobody has pulled

`chain-cost.md` §5.2: `fire()` takes `&mut Arena` and only ever *reads* `arena.tick`.
Flipping `shoot`'s Arena meta to READONLY is a three-line change with no CU cost and a
concurrency upside — twenty shooters would stop serialising on a 1,200-byte account they
do not write.

**This lever is mutually exclusive with §5.2.** An arrow allocated into `arena.bullets` is
a genuine `Arena` write, and the lever closes forever. §4 measured that the lock is not
currently costing anything at twenty seats, so **taking §5.2 and giving up §5.7 is the
right trade** — but it is a trade, and it should be made deliberately rather than
discovered later.

---

## 6. Two defects found in the instrument

### 6.1 The hand-copied map had gone stale — measured as "20 seats never reached the gate"

`perf_20seats.ts` carried a 64-row ASCII wall bitboard hand-extracted from
`solana program dump`, on the stated grounds that the deployed program was not this tree's
build. **That is no longer true**, and it was checked rather than assumed:

```
solana program dump JCfWB9…  →  122,720 B
head -c 115440              →  sha256 417bcec791bb85ebacaf62ab226d075b0fcc821066072117a5e721e03dde4f20
target/deploy/heartrot.so   →  sha256 417bcec791bb85ebacaf62ab226d075b0fcc821066072117a5e721e03dde4f20
tail -c +115441 | tr -d '\0' | wc -c  →  0
```

Byte for byte, plus zero padding. Meanwhile the map had been redrawn: the copy still had
the old pillared lobby and a gate at tiles 30–33 on **both** axes; the live map's gate is
x 480–543, y 608–639. Every planned step went into a wall, `BlockedByWall` came back
through a `skipPreflight` fire-and-forget send where it is invisible, and the run died
after 90 iterations of nobody moving.

Fixed by deleting the copy and importing `isWall` / `isWallTile` / `onGate` from
`@heartrot/client`, which `tools/gen_map.py` generates from the same
`assets/map/arena.json` as `programs/heartrot/src/map.rs`. This is the project's most
repeated defect — **one fact stored twice** — and it had been introduced into the
measurement harness on a justification that had since expired. `er_guard.sh` now records
the .so hash in `env.txt` beside every run, so the justification can be re-checked instead
of re-assumed.

### 6.2 `lobby` mode is now unrepresentable, so the 2026-09-01 lobby row cannot be reproduced

`PS_MODE=lobby` arms the match with every seat still in `ZONE_LOBBY`. The current program
refuses that: `start_match` is `begin_muster`, which calls `guards::assert_any_raider` and
returns `NoRaiders` (custom 19) over an empty pit.

```
2026-09-02T05:46:25Z  start_match … {"InstructionError":["0",{"Custom":"19"}]}
```

`docs/perf/twenty-lobby.jsonl` predates that guard. **Its p95 of 131 ms at twenty seats —
the best tail number in the tree, and the one quoted as the thing to protect — is not a
number this harness can produce again**, on any build, because the state it was measured in
is now unrepresentable. The number to protect is the *fight* one. `er_guard.sh` runs
`fight` only; `er_guard_cmp.mjs` still reads a `lobby.jsonl` if one is present so the old
runs remain readable.

---

## 7. What would invalidate this

- **A different route.** Everything here is `devnet-as`, from one home ISP in Ghaziabad.
  `docs/perf/research-geography.md` owns that variable; this document holds it fixed.
- **A different arena's bump luck.** `chain-cost.md` §5.1: an arena whose `boss`/`players`
  PDAs miss bump 255 costs +7,500 CU on every `shoot` and every `boss_tick`. `er_guard.sh`
  takes `arenaId` from the wall clock and does not grind it, so every run rolls fresh luck.
  It has not been observed to move write-to-visible — 24,884 vs 32,384 CU is 6.2 % vs 8.1 %
  of the ceiling and the tick is nowhere near compute-bound — but it is unmeasured, and it
  is a candidate explanation for run-to-run drift that §2 currently charges to the network.
- **The shoot arm misses on purpose.** §4 does not measure the `Boss` part write or
  `recompute_vent` under load. A candidate that makes *hits* dramatically more expensive
  would not be caught here.
- **`sendInstructions` failures are POST failures only.** Every run above reports
  `sendFailures: 0`, which means no HTTP error — not that the chain accepted anything. The
  acceptance number is the `accepted` column, and at 80 % it is telling you one move in
  five is being refused on today's network.
- **The pooled gate has not been null-tested, only sized.** The false-positive
  demonstration in §2 is a real one-run-vs-one-run comparison of identical code. The claim
  that pooling fixes it is arithmetic on that same data, not a second experiment: pooling
  the two no-shoot runs puts the 7.5 ms drift inside the row's spread (± 9 at twenty
  seats), which raises the limit to 2 × 9 = 18 ms — comfortably above the 7.5 ms drift it
  has to tolerate. A proper null test needs **four** baseline runs and two more pooled arms,
  which is twenty minutes nobody has spent yet. If the Load phase has the time, spending it
  there before trusting a marginal PASS is the right call.
- **Two runs per arm is the minimum that works today, not a proof.** It brings the p50
  gate to ~18 ms at twenty seats. If a change is expected to cost less than that and the
  question matters, the answer is more replicates, not a tighter constant.

---

## Appendix — reproducing

```bash
cd /home/anshtyagi/Documents/pixel-artgame

# baseline, two runs
bash scripts/spike/er_guard.sh base-$(date +%F)
bash scripts/spike/er_guard.sh base-$(date +%F)-b

# ... build the candidate, deploy it, then two more ...
bash scripts/spike/er_guard.sh cand-$(date +%F)      [candidateProgramId]
bash scripts/spike/er_guard.sh cand-$(date +%F)-b    [candidateProgramId]

# gate — exit 1 on regression
node scripts/spike/er_guard_cmp.mjs \
  base-$(date +%F),base-$(date +%F)-b \
  cand-$(date +%F),cand-$(date +%F)-b

# the shoot-loaded arm (both sides must use it, or the tool refuses to compare)
PS_SHOOT_MS=850 bash scripts/spike/er_guard.sh cand-shoot-$(date +%F)
```

A candidate program deployed to a fresh id is passed as the second argument, or via
`HR_PROGRAM_ID`. **It must be a build of this tree**: the walk plans against
`@heartrot/client`'s generated map, which is only the chain's map while §6.1 holds.

If a run aborts after `start_match`, an abandoned crank task ticks for its full 4,500
iterations. Cancel it with the `arenaId` from the run's `start` line:

```bash
node /tmp/er_guard.mjs --settle-only <arenaId>
```

Aborting *before* `start_match` leaves the three accounts delegated in `PHASE_LOBBY`, where
`settle` refuses with `WrongPhase` (custom 6). Nothing is ticking; only the rent and the ER
top-up are stranded. Two such arenas exist from this session: `1788327977`, `1788328056`.
