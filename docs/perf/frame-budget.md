# frame-budget — the shipped scene, measured in a real browser

**Question.** `docs/perf/render-scale.md` costed the redesign before anyone built it and
predicted 2.2× headroom. The redesign is now built. Does the real `app/src/render` tree —
the real `temple.svg` layer, the real S=3 boss rig animating, twenty knights, 128 bullets,
both telegraphs firing — actually hold 60 fps at 1, 5, 10 and 20 players?

**Answer, in one line.** On the dev box, comfortably: 1.18 ms p50 / 1.98 ms p95 at twenty
knights, no frame over budget. Under a 6× CPU throttle, **no.** At twenty knights and the
real notification rate the shipped scene reads **11.46 ms p50 / 16.96 ms p95, 7.2 % of
frames over 16.7 ms, and the displayed rate falls from 144 fps to 61.** p95 headroom is
**0.98×**, not 2.2×.

**The art is not what costs it.** The 22,195-subpath temple costs **0.08 ms/frame**. The
S=3 boss rig — the one thing spec 11 §13 lists as risk 1, unmeasured — costs **2.00 ms p50
/ 3.10 ms p95** and is affordable; `--scale 2` is not needed. The knight art that has not
been generated yet costs **+1.30 ms p50**. What costs it is the **128-bullet layer**
(−2.94 ms p50 / −6.28 ms p95 when removed) sitting under a React tree that re-renders
**714 times a second** at twenty seats.

**The single thing to cut: the visible bullet count, 128 → 32.** Measured at the shipped
feed rate under 6× throttle it is worth **−2.08 ms p50, −2.04 ms p95**, takes over-budget
frames from **7.2 % to 4.6 %**, and lifts the notifications the client can actually service
from 61/s to 72/s. It is the lever spec §9.3 already sanctioned, and **its documented
trigger — "if p95 ever crosses ~12 ms" — has fired.** Cap *drawing* only; `MAX_BULLETS =
128` and `bullets_per_volley = 3 + alive_count` are chain facts.

---

## 1. What was actually measured — and one thing that could not be

The harness (`scripts/spike/framebudget/`, throwaway; **no product file was modified**)
mounts `app/src/render/Arena.tsx` itself — the shipped `SCENE`, `Boss`, `Knight`, `Spawn`,
`slamTelegraph`, `volleyTelegraph`, `useSeatInterpolation` and the real `createPredictor` —
against synthetic account objects with the decoder's exact shape. It is product code under
measurement, not a model of it.

**`tools/gen_knights.py` does not exist.** `app/src/render/Knight.tsx:29` draws
`<use href="#k0-rest">` against a `<defs>` block that has never been generated; there is no
`app/src/render/knights.gen.ts` and no `<defs>` anywhere in the tree carrying a `k*-rest`
id. Today twenty knights draw twenty shadow ellipses, one chevron and one ring, and nothing
else. That is the correct failure the file documents — but it means **"20 knights walking"
cannot be measured on the tree as it stands.**

So every table below has two rows per point:

- **shipped** — the tree exactly as it is, `<use>` resolving to nothing.
- **art** — the same tree with the knight `<defs>` injected. `scripts/spike/framebudget/knightdefs.py`
  emits them from the real `assets/sprites/knights.svg` following spec §8.2 for the two
  properties that decide raster cost: half resolution onto the 33 × 42 odd canvas, five
  poses × three skins. It produced **4,302 subpaths in 65,883 bytes**, against spec §8.2's
  independent "~65 KB of defs" estimate. It is a cost model, not the generator — the contact
  frames shear the leg band rather than being authored — so read the *delta* as the price of
  the art, not as a preview of it.

Both variants were screenshot-verified before any number was trusted: the temple paints, the
boss fills the top of the frame at S=3, bullets fly, knights appear in the pit in the `art`
variant and are absent in `shipped`.

### Method

- Playwright 1.63 driving **headed system Google Chrome on X11 `:0`**, viewport 1024 × 1024,
  dPR 1.0, 144 Hz display. **A fresh browser per case** — render-scale §2 records that
  reusing one page pins every case after the first heavy one to a fake ~55 fps.
- 5 reps per case, case order reversed on odd reps so an ordering effect shows up as
  disagreement. σ of p50 is reported and is ≤ 0.82 ms everywhere, ≤ 0.45 ms on the headline
  rows.
- 40 warm-up frames discarded, 400 kept.
- **Metric: `commitP50`/`commitP95`** — `performance.now()` at rAF entry to
  `performance.now()` in a `MessageChannel` task that runs after the frame commits, so it
  includes style, layout and paint commit. Identical to render-scale's, so the two are
  comparable.
- `cpu6` = `Emulation.setCPUThrottlingRate: 6`, the honest stand-in for a mid-range laptop.
  Treat cpu1 as "this box".

### The feed is modelled, and modelled twice-wrong-then-right

`subscribe.ts` decodes **one** account kind per message and calls `store.setWorld` with that
one; `App.tsx:252`'s `World` re-renders on any of the three and hands `<Arena>` two unchanged
references and one fresh object. Two harness bugs were found and fixed before the numbers
below, and both would have been believable:

1. **Rebuilding all three accounts per notification** overstates React's work by up to 3×.
   Fixed: the feed rotates one kind per notification on the measured 20-seat mix
   (Arena 50 % / Players 45 % / Boss 5 %).
2. **`setInterval` clamps to 4 ms** once nested, so a request for 714 notifications/s
   delivered **244/s on this box and 50/s under the throttle**. The first feed sweep was a
   measurement of the timer. Fixed: an unclamped `MessageChannel` pump, one macrotask per
   notification — which is also the shape a WebSocket delivers, so React cannot batch two
   into one render. Every table reports **`achievedHz`**, and where it falls short of the
   request that shortfall is itself the finding.

---

## 2. The curve — 1, 5, 10, 20 knights

Feed at 20 notifications/s (the crank's 10 Hz, every payload delivered twice, which is what
the Magic Router does). 128 bullets, both telegraphs live, the boss shell taking damage
across the run so the flinch and destruction one-shots actually fire.

| knights | cpu | variant | p50 | σ | p95 | max | frames > 16.7 ms | DOM nodes |
|---:|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | 1× | shipped | 0.90 | 0.06 | 1.42 | 2.9 | 0 % | 297 |
| 5 | 1× | shipped | 0.96 | 0.10 | 1.54 | 3.2 | 0 % | 320 |
| 10 | 1× | shipped | 0.96 | 0.08 | 1.50 | 2.1 | 0 % | 352 |
| **20** | 1× | shipped | **1.02** | 0.04 | **1.62** | 2.7 | 0 % | 407 |
| 1 | 1× | art | 0.96 | 0.10 | 1.60 | 2.3 | 0 % | 557 |
| 5 | 1× | art | 1.02 | 0.04 | 1.52 | 2.2 | 0 % | 580 |
| 10 | 1× | art | 1.10 | 0.11 | 1.62 | 2.8 | 0 % | 612 |
| **20** | 1× | **art** | **1.18** | 0.07 | **1.98** | 3.5 | 0 % | 667 |
| 1 | 6× | shipped | 5.44 | 0.31 | 9.08 | 19.0 | 0.1 % | 297 |
| 5 | 6× | shipped | 5.40 | 0.33 | 9.26 | 18.2 | 0.2 % | 320 |
| 10 | 6× | shipped | 5.74 | 0.34 | 9.56 | 27.3 | 0.2 % | 347 |
| **20** | 6× | shipped | **6.24** | 0.12 | **10.22** | 41.3 | 0.3 % | 402 |
| 1 | 6× | art | 5.46 | 0.14 | 9.24 | 21.3 | 0.3 % | 557 |
| 5 | 6× | art | 5.82 | 0.26 | 9.56 | 22.3 | 0.3 % | 580 |
| 10 | 6× | art | 6.42 | 0.20 | 10.46 | 25.5 | 0.5 % | 607 |
| **20** | 6× | **art** | **7.54** | 0.41 | **14.02** | 32.6 | **2.1 %** | 665 |

**The curve is nearly flat in knight count and render-scale was right about that.** 1 → 20
knights costs 0.22 ms at cpu1 and 2.08 ms at cpu6 with the art in. Least-squares slope over
the four `art`/cpu6 points is **0.109 ms per knight**, intercept 5.29 ms. Adding 4,302
subpaths of knight geometry is not what decides this frame — but note it is 1.7× the
0.065 ms/knight render-scale predicted, because a knight here is a real React component with
a WAAPI driver, an HP bar and a respawn arc, not a `<g>` a rAF loop translates.

**Where it already diverges from the prediction.** render-scale predicted 6.40 p50 / 7.90 p95
at 20 knights, cpu6. Measured: 7.54 / **14.02**. p50 is 18 % high — fine. **p95 is 77 % high**,
and that is the number the budget is set against. The gap is React: render-scale's harness
had no component tree and no reconciliation at all, only `el.style.transform` writes from one
rAF loop. The real Arena re-renders its whole subtree on every notification, and that render
lands inside a frame.

---

## 3. Attribution — what each element costs

20 knights, cpu6, full art, feed 20 Hz, 5 reps each. σ ≤ 0.41 ms throughout. Two layers were
measured **alone**, mounted in a bare `<svg>`, because neither can be switched off from
`Arena`'s props.

| scene | p50 | p95 | Δp50 vs full | Δp95 vs full | DOM nodes |
|---|---:|---:|---:|---:|---:|
| **full: temple + S=3 boss + 20 knights + 128 bullets + telegraphs** | **7.54** | **14.02** | — | — | 665 |
| bullets 128 → 64 | 6.34 | 10.84 | −1.20 | −3.18 | 603 |
| **bullets 128 → 32** | **5.34** | **10.44** | **−2.20** | **−3.58** | 571 |
| bullets 128 → 0 | 4.60 | 7.74 | **−2.94** | **−6.28** | 539 |
| knight art removed (the tree as it ships today) | 6.24 | 10.22 | −1.30 | −3.80 | 402 |
| `SCENE` alone — the 16-path, 22,195-subpath temple | **0.08** | 0.66 | −7.46 | −13.36 | 314 |
| `Boss` alone — the 13-group S=3 rig, animating | **2.00** | 3.10 | −5.54 | −10.92 | 363 |

Three findings, in order of how much work they save someone:

**1. Risk 1 in spec §13 is closed: S=3 is affordable.** The boss rig covering the top of a
1024-unit frame costs 2.00 ms p50 / 3.10 ms p95 at 6× throttle, with all thirteen part groups
promoted and animating. `gen_hitboxes.py --scale 2` is not needed and should not be reached
for. This is the measurement §13 asked for before §8.3 was built; §8.3 is already built and
it passes.

**2. The temple is free, again, on a second independent harness.** 0.08 ms p50. `Scene.tsx`'s
four barriers work: a module-scope `ReactElement` React never re-renders, no state-derived
props, `will-change: transform`, `pointer-events: none`. The cut of `tools/gen_temple.py`
(spec §12.4) was correct and there is nothing left to reconsider.

**3. The bullets are the cost, exactly as render-scale said, and now more so.** 128 bullets
are 40 % of p50 and 45 % of p95. render-scale measured the cap at −2.40 ms; here it is
−2.20 ms p50 but **−3.58 ms p95**, and p95 is what is failing.

### A negative result: the bullet `ref` closure is not the problem

`Arena.tsx:467` gives each of the 128 bullet `<line>`s an **inline arrow `ref`**, so every
ref has a new identity on every render, and the obvious hypothesis is that React detaches and
reattaches all 128 on every one of 714 notifications per second. A copy of the shipped file
with only that closure hoisted to stable per-slot identities
(`scripts/spike/framebudget/ArenaFixed.tsx`, byte-identical otherwise) was A/B'd against it,
5 reps each:

| case | shipped p50 | hoisted p50 | shipped p95 | hoisted p95 |
|---|---:|---:|---:|---:|
| feed 20 Hz, cpu1 | 1.24 | 1.20 | 1.74 | 2.06 |
| feed 20 Hz, cpu6 | 7.24 | 7.26 | 12.52 | 13.30 |
| feed 714 Hz, cpu1 | 2.30 | 2.60 | 3.38 | 3.56 |
| feed 714 Hz, cpu6 | 11.12 | 11.18 | 16.74 | 17.16 |

**Worth nothing, in either direction, at any point.** The bullet cost is raster and geometry,
not reconciliation. Do not spend a commit on it — that is the whole value of this row.

---

## 4. The feed rate — this is where 60 fps is actually lost

20 knights, full art, 128 bullets. `achievedHz` is what the pump actually delivered; where it
is below the request, the browser could not service the stream.

| requested Hz | cpu | p50 | σ | p95 | max | frames > 16.7 ms | displayed fps | achieved Hz |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 | 1× | 1.14 | 0.05 | 1.74 | 4.1 | 0 % | 142.8 | 10 |
| 20 | 1× | 1.36 | 0.14 | 2.34 | 5.2 | 0 % | 142.3 | 20 |
| 100 | 1× | 1.66 | 0.17 | 3.00 | 8.1 | 0 % | 142.2 | 100 |
| 372 | 1× | 2.50 | 0.34 | 4.00 | 9.3 | 0 % | 141.1 | 369 |
| **714** | 1× | **3.12** | 0.45 | **4.72** | 9.3 | **0 %** | 140.3 | **597** |
| 10 | 6× | 6.52 | 0.17 | 10.78 | 22.5 | 0.7 % | 115.5 | 10 |
| 20 | 6× | 7.84 | 0.74 | 13.80 | 26.0 | 1.6 % | 98.0 | 20 |
| 100 | 6× | 12.24 | 0.44 | 19.12 | 37.3 | 15.9 % | 61.8 | **62** |
| 372 | 6× | 11.98 | 0.80 | 18.80 | 40.9 | 14.9 % | 62.8 | **63** |
| **714** | 6× | **11.46** | 0.45 | **16.96** | 27.8 | **7.2 %** | **60.6** | **61** |

Read the `achievedHz` column first. **Under a 6× throttle the client services ~62
notifications per second no matter how many arrive.** 100, 372 and 714 are the same
measurement of a saturated main thread; their p50s differ by less than their own σ. At twenty
seats the shipped feed delivers 714/s (spec §9.4, measured), so **the client is processing
one notification in twelve and discarding the rest by falling behind.** Frames are still
produced — at 61 fps instead of 144 — but every one that carries a render costs 11–17 ms.

Two consequences the tables make concrete:

- **spec §9.4's `subscribe.ts` dedupe is not implemented.** `app/src/net/subscribe.ts` has no
  payload-string comparison anywhere: `handle()` decodes and calls `cfg.onArena` /
  `onBoss` / `onPlayers` unconditionally, and `store.setWorld` re-renders `World` on every
  one. It should still ship — at cpu1 it is worth taking 714 → 372 Hz, measured 3.12 → 2.50 ms
  p50, a 20 % main-thread saving, and it cannot cost anything. **But it does not fix the 6×
  machine**: 372 and 714 both saturate at ~62 Hz achieved and read the same frame time. The
  §9.4 claim that the dedupe is the thing to ship "and only this" is now measured, and it is
  necessary rather than sufficient.
- **§9.4's honest caveat is now closed.** It recorded the React re-render cost as "a traced
  mechanism with a measured rate, not a measured cost". The cost is **+4.94 ms p50 and
  +6.5 pp of over-budget frames** going from 10 Hz to the shipped rate at 6× throttle, and
  **−83 fps** displayed.

### The lever, at the rate that matters

| scene at 714 Hz | cpu | p50 | p95 | frames > 16.7 ms | fps | achieved Hz |
|---|---:|---:|---:|---:|---:|---:|
| full art, 128 bullets | 6× | 11.46 | 16.96 | 7.2 % | 60.6 | 61 |
| **full art, 32 visible bullets** | 6× | **9.38** | **14.92** | **4.6 %** | **71.4** | **72** |
| knight art removed, 128 bullets | 6× | 11.08 | 15.82 | 3.0 % | 76.9 | 77 |
| full art, 128 bullets | 1× | 2.30 | 3.38 | 0 % | 142.6 | 629 |
| full art, 32 visible bullets | 1× | 2.44 | 3.84 | 0 % | 141.8 | 635 |

Capping visible bullets to 32 buys **−2.08 ms p50, −2.04 ms p95, 7.2 % → 4.6 % of frames over
budget, and +18 % more of the feed serviced.** Nothing else on the list is worth half of it.
Dropping the knight art entirely buys less (−0.38 ms p50) and costs the game its characters.

---

## 5. First paint, build, memory

**Cold first paint** — navigation to `first-contentful-paint` over localhost, whole bundle
parsed for the first time including the 332 KB temple and the 121 KB boss rig, 3 samples:

| cpu | domInteractive | loadEventEnd | first-paint |
|---:|---:|---:|---:|
| 1× | 7.4 / 15.4 / 135.0 ms | 154 / 180 / 299 ms | **180 / 196 / 324 ms** |
| 6× | 51.9 / 55.2 / 58.7 ms | 290 / 293 / 297 ms | **312 / 320 / 324 ms** |

The 324 ms cpu1 outlier is the cold-cache first launch. Upper bound only: the harness bundle
is 869 KB and carries `ArenaFixed` and the knight defs the app does not.

**Steady-state re-render** (the `firstPaintMs` column in the raw results) is 3–17 ms at cpu1
and 19–63 ms at cpu6. That is a re-render, not a mount — `SCENE` is already in the DOM.

**Memory** — renderer-process RSS from `/proc`, scoped to the launched process tree
(`performance.memory` reads 4.4–8.3 MB for every variant including the empty one; it measures
the JS heap and is useless for this question). 3 samples each:

| variant | renderer RSS after |
|---|---|
| `SCENE` alone | 564.3 / 556.2 / 529.2 MB |
| `Boss` alone | 549.1 / 536.0 / 534.1 MB |
| shipped, 20 knights, 128 bullets | 448.7 / 454.3 / 450.1 MB |
| **full art, 20 knights, 128 bullets** | **449.7 / 452.1 / 448.4 MB** |
| full art, 20 knights, feed 714 Hz | 425.3 / 427.9 / 424.8 MB |

**The knight art costs no measurable memory** — 448–454 MB with and without it, three samples
each, the bands overlapping completely. The single-layer variants reading *higher* than the
full scene is reproducible and unexplained; they finish their 60 frames in ~0.4 s and are
likely measured before a GC the busier variants have already taken. Do not read an ordering
out of this table; read the band, 424–564 MB, and that memory does not discriminate between
any of these choices.

---

## 6. Verdict, and exactly what to cut

**On the dev box, and on anything like it, ship this as it stands.** 1.18 ms p50 / 1.98 ms
p95 at twenty knights with the art in, zero frames over budget, 597 of 714 notifications
serviced. Nothing here is a problem at cpu1.

**On a machine 6× slower it misses, and it misses on p95 and on displayed frame rate rather
than on p50.** The order to act in:

1. **Cap *visible* bullets at 32.** Measured −2.08 ms p50 / −2.04 ms p95 at the real feed
   rate, 7.2 % → 4.6 % over budget. This is spec §9.3's own lever and its trigger
   ("p95 crosses ~12 ms") has fired — p95 is 14.02 ms at 20 Hz and 16.96 ms at 714 Hz. Cap
   **drawing only**: `MAX_BULLETS = 128` and `bullets_per_volley = 3 + alive_count` are chain
   facts and a render cap must not touch either. `Arena.tsx:463`'s
   `arena.bullets.map(...)` is the whole change.
2. **Ship the `subscribe.ts` dedupe (spec §9.4).** −0.62 ms p50 at cpu1, a 20 % main-thread
   saving, and it cannot cost anything. It does **not** rescue the throttled machine — say so
   when it lands, or the next reader will assume the frame budget was the reason for it.
3. **Do not touch the art.** The temple is 0.08 ms. The S=3 boss is 2.00 ms and risk 1 is
   closed. The knight art is 1.30 ms and no memory. `--scale 2`, rasterising the temple, and
   simplifying the knights are all still the wrong levers, now on two independent harnesses.
4. **Do not hoist the bullet `ref` closures.** Measured, twice, at two feed rates and two CPU
   rates: worth nothing.

### What this does not cover

- **One Fedora/X11 box, Chrome 151, dPR 1.0, 144 Hz.** No Firefox, no WebKit, no mobile GPU,
  no dPR 2. A dPR-2 display quadruples rasterised area and the p95 headroom that would absorb
  it is 0.98×, so it is the most likely way this gets worse.
- `cpu6` slows script and main-thread raster; it does **not** slow the GPU. A GPU-bound device
  is not modelled.
- The knight numbers are the *delta* from a cost model of `gen_knights.py`'s output, not from
  its output. Re-run `scripts/spike/framebudget/` once the generator lands; the subpath count
  it must not exceed is **4,302**.
- The lobby, the gate and the muster were not measured. The fight is the dense one.
- Bullets were active in all 128 slots for the whole run. The pool drops a spawn when full and
  the live instrument saw 13–15 in flight at 20 seats (spec §12.11), so **the bullet cost is
  an upper bound** — which cuts both ways: the cap to 32 may cost nothing visible at all.

Harness, cases and raw results: `scripts/spike/framebudget/`
(`results.json`, `results2.json`, `results3.json`, `run*.log`). Throwaway; delete it or keep
it, but re-run it rather than interpolating from it.

To re-run it:

```
cd scripts/spike/framebudget
ln -s ../../../app/node_modules node_modules   # vite, react and @heartrot/client live there
python3 knightdefs.py && ./node_modules/.bin/vite build
PW_HOME=<dir containing a node_modules with playwright> DISPLAY=:0 REPS=5 node drive.mjs
```
