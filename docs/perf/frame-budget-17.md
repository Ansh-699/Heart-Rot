# frame-budget-17 — the full-screen rooms, measured in a real browser

**Question.** Spec 17 §10.4 sets one gate on the whole redesign: *20 knights, 6× CPU
throttle, p95 ≤ 16.7 ms.* It also names one number as the redesign's single unmeasured
risk — the +55 % rasterised area — and one suspect nobody had priced, the `.hr-boss-grade`
rasterisation boundary. This measures the shipped tree against both.

**Answer, in one line.** **The gate fails, and neither suspect is the reason.** At twenty
knights, the live 20-seat feed and a 6× throttle the shipped scene reads **18.70 ms p50 /
30.00 ms p95, 67.5 % of frames over 16.7 ms, 39.1 fps, and 39 of 714 notifications per
second serviced** — against the previous shipped **9.38 / 14.92 / 4.6 % / 71.4 fps /
72 Hz**. That is **2.0× p50 and 2.0× p95**, and the notification throughput that spec §10.3
calls "the ER budget in disguise" has fallen **46 %**.

**Fill rate is measured and null.** Over a **4.8× sweep of rasterised area** — 1.00, 0.98,
1.98 and 4.79 Mpx — frame time does not track area in either direction: 23.40, 25.00,
18.40 and 20.80 ms p50, with the *largest* window among the fastest. §10.4's flagged risk
and §13's "most likely way this gets worse" are both closed. So is the boss filter: killing
`.hr-boss-grade` costs **+1.10 ms** (i.e. nothing, the wrong way), and killing the room
grade filters too costs **+1.30 ms**.

**What it is instead: the twenty-seat actor layer, and inside it the arrow *spawn*.** With
zero seats the same scene reads **8.10 / 11.10 and 0.5 % over budget**. Twenty seats add
**9.80 ms p50 / 13.20 ms p95**, of which **4.80 ms p50 / 5.60 ms p95 is arrows** — and it is
not the flight: under emulated `prefers-reduced-motion`, which skips every flight entirely,
the cost is **unchanged**. It is `Shot.launch()` firing for all nineteen remote seats.

**The single thing to cut, and it fixes a bug at the same time.** `Shot.tsx:528` applies
`VISIBLE_PROJECTILES` in the *draw* step and not in `launch()`, so every arrow is raycast,
given three WAAPI one-shots and a `Flight` — and then hidden. Under a full bullet pool it is
hidden **always**: `budget = shownBullets.length` saturates at `VISIBLE_BULLETS = 32`, so
`cap = max(0, 32 − 32) = 0`, and the first line of the draw loop, `drawn >= budgetLeft`,
hides the **local player's own arrow too** — the code contradicts its own comment three
lines above it. Move the cap into `launch`. Measured ceiling: **−4.60 ms p50 / −4.20 ms
p95.**

---

## 1. Method, and what is comparable to what

The harness (`scripts/spike/framebudget/main2.tsx` + `drive2.mjs`, throwaway; **no product
file was modified**) mounts the shipped composition: `App.tsx`'s 48 px header, its `.stage`
with the `::after` vignette, `World`'s absolutely-positioned grid box, and `<Passage>` —
which *is* `<Arena>` wrapped in the gate beat. Underneath it the real `useViewport`,
`WAITING`, `BOSS_ARENA`, `Boss`, `Knight` (against the now-generated `knights.gen.ts`),
`Shot`, `Spawn`, both telegraphs, `useSeatInterpolation` and the real `createPredictor`. It
is product code under measurement, not a model of it.

Both scenes were screenshot-verified before any number was trusted (`shot-smoke-lobby.png`,
`shot-dbg.png`): the portcullis, sign, torches and props paint in room A; the boss, rings,
braziers and cyan core paint in room B; twenty knights carry bows, arrows fly, damage
numbers rise.

### What changed since `docs/perf/frame-budget.md`

| | old harness | this one |
|---|---|---|
| stage | 1024 × 1024, camera at zoom 2 | **the window minus the 48 px header** — 1920 × 1032 by default |
| knight art | injected cost model (`knightdefs.py`, 4,302 subpaths) | the real `knights.gen.ts` — `gen_knights.py` has landed |
| rooms | one `SCENE` | `WAITING` / `BOSS_ARENA`, one mounted at a time |
| arrows | did not exist | `fireLocal` at the class cadence for the local seat; every remote seat's `lastShotTick` advances on its own class period, which is what the wire does |
| gate beat | did not exist | `room: 'passage'` flips the local seat's `zone` every 18 ticks |

**Metric is unchanged and therefore comparable:** `performance.now()` at rAF entry to
`performance.now()` in a `MessageChannel` task that runs after the frame commits, so it
includes style, layout and paint commit.

**The knight comparison is fair, and that is checked rather than assumed.** The old report's
numbers came from a *cost model* of `gen_knights.py`'s output and set a ceiling the real
generator must not exceed: **4,302 subpaths**. The shipped `knights.gen.ts` carries **4,307
subpaths in 258 `d` attributes, 67,451 bytes** — 0.1 % over the model. The knight geometry in
both reports is the same geometry, so the 9.38 → 18.70 gap is not the art landing.

**Everything else is the previous file's method, unchanged:** headed system Chrome on X11
`:0`, dPR 1.0, 144 Hz; **a fresh browser per case**; case order reversed on odd reps; 40
warm-up frames discarded, 400 kept; `cpu6` = `Emulation.setCPUThrottlingRate: 6`; the feed
is an unclamped `MessageChannel` pump, one macrotask per notification, rotating one account
kind per message on the measured 20-seat mix (Arena 50 % / Players 45 % / Boss 5 %).

**Bullets.** The headline rows pin **14** live bullets, which is the live instrument's
observed 13–15 at twenty seats (spec §12.11). The old report pinned all 128 and said so; the
128-pinned row is reported here too so the two can be laid side by side. It makes little
difference — 17.00 vs 18.70 p50 — and the 128 row is the *cheaper* one, for the reason in §5.

**Spread, stated up front.** Pass 1 was taken across a long sitting and its σ reaches
4.4 ms p50 / 10.4 ms p95 on some rows. Passes 2–4 were each taken in one sitting and read
σ ≤ 1.3 ms p50 on almost every row. **Every attribution below is quoted from a
single-sitting pass and against that pass's own baseline**, never across passes. Where a
difference is inside its own σ it is called null rather than reported as a delta.

---

## 2. The headline, and the curve

Twenty knights, the live bullet load, 1920 × 1032 (1.98 Mpx). `feed` is what the client
actually serviced.

| case | cpu | feed req. | p50 | p95 | p99 | max | > 16.7 ms | fps | feed |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **prior shipped** (1024², 128 bullets, no arrows) | 6× | 714 | **9.38** | **14.92** | — | — | **4.6 %** | **71.4** | **72** |
| **now** | 6× | 714 | **18.70** | **30.00** | 39.60 | 52.0 | **67.5 %** | **39.1** | **39** |
| now | 1× | 714 | 4.60 | 6.20 | 8.30 | 9.6 | 0.0 % | 72.6 | 541 |
| now, feed at the crank's 20 Hz | 6× | 20 | 11.00 | 16.30 | 19.80 | 26.2 | 2.8 % | 64.0 | 20 |
| now, room A (waiting area) | 6× | 714 | 15.40 | 22.30 | 35.70 | 41.4 | 39.8 % | 44.5 | 46 |
| now, 128 bullets pinned | 6× | 714 | 17.00 | 22.80 | 29.50 | 42.9 | 56.3 % | 40.4 | 41 |

**Gate §12.1 item 3 — p95 ≤ 16.7 ms at 20 knights / 6× — FAILS at 30.00 ms.** It fails at
1.8× the limit, on p95, on p50 (18.70 against a 16.7 ms vsync), and on displayed frame rate
(39.1 fps). At the crank's own 20 Hz delivery it scrapes through at 16.30; at the rate the
feed actually arrives it does not.

**On the dev box it is still comfortable** — 4.60 / 6.20, zero frames over budget, 541 of
714 notifications serviced. Nothing here is a problem at cpu1, exactly as before.

### The knight curve at the live load, 6× throttle, 714 Hz

| knights | p50 | σ | p95 | σ | > 16.7 ms | fps | feed |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 8.10 | 0.58 | 11.10 | 1.47 | 0.5 % | 96.8 | 97 |
| 1 | 8.20 | 0.14 | 10.10 | 0.17 | 0.3 % | 86.7 | 90 |
| 5 | 10.60 | 0.38 | 13.60 | 0.42 | 1.5 % | 65.8 | 68 |
| 10 | 12.50 | 0.21 | 16.30 | 0.26 | 4.0 % | 54.7 | 56 |
| **20** | **18.70** | 0.71 | **30.00** | 4.70 | **67.5 %** | 39.1 | 39 |

Least-squares slope over 1..20: **0.53 ms per knight**, against the old report's
**0.109 ms**. A seat is now **4.9× more expensive**, and the curve is no longer flat — it is
the shape of the whole problem. **The scene holds 60 fps up to ten seats and breaks between
ten and twenty.**

---

## 3. Attribution — what costs, and what is measured null

All rows 20 knights / 714 Hz / 6× / 1.98 Mpx, three reps, each pass against its own baseline.

### 3.1 The actor layer is the cost (pass 3, baseline 17.90 / 24.30)

| scene | p50 | p95 | Δp50 | Δp95 | > 16.7 ms |
|---|---:|---:|---:|---:|---:|
| **base: 20 knights, arrows, boss, bullets, both rooms' art** | **17.90** | **24.30** | — | — | 66.8 % |
| arrows off | 13.10 | 18.70 | **−4.80** | **−5.60** | 11.3 % |
| arrows off, seats frozen | 11.40 | 16.40 | −6.50 | −7.90 | 4.3 % |
| arrows off, every seat at full HP | 13.30 | 18.50 | −4.60 | −5.80 | 11.5 % |
| arrows off, frozen, full HP | 11.50 | 15.60 | −6.40 | −8.70 | 3.3 % |
| **zero seats — the scene with no actors at all** | **8.10** | **11.10** | **−9.80** | **−13.20** | **0.5 %** |

Read bottom-up. **The room, the boss, the bullets, the telegraphs, the vignette and the
framing together cost 8.10 ms p50 and clear the gate by 5.6 ms.** Everything that fails is
in the twenty seats:

- **arrows 4.80 ms p50 / 5.60 ms p95** — the largest single removable item in the tree.
- **movement, pose swaps and interpolation 1.70 / 2.30** (13.10 → 11.40).
- **HP bars, corpses and respawn arcs: null.** 13.10 vs 13.30 and 11.40 vs 11.50, both
  inside σ. The `hp`/`deaths`/`respawnAtTick` render path is free; do not spend a commit on it.
- **the twenty bodies themselves, standing still: 3.40 ms** (11.50 − 8.10).

### 3.2 It is the arrow *spawn*, not the arrow (pass 2, baseline 20.40 / 30.90)

| variant | p50 | p95 | Δp50 | verdict |
|---|---:|---:|---:|---|
| base | 20.40 | 30.90 | — | 87.8 % over budget |
| arrows off | 16.20 | 26.20 | −4.20 | the whole shot path |
| **only the local seat fires** | **15.80** | **26.70** | **−4.60** | **the cost is the nineteen remote arrows** |
| only remote seats fire | 21.80 | 33.20 | +1.40 | the local arrow is free |
| **`prefers-reduced-motion: reduce`** | **20.60** | 36.20 | +0.20 | **the per-frame flight loop is free** |
| damage numbers frozen | 20.00 | 31.20 | −0.40 | null |

The reduced-motion row is the decisive one. `Shot.launch` under reduced motion does the
raycast, positions the muzzle, fires the muzzle and impact one-shots — and then returns
**without creating a `Flight` at all**, so the per-frame step has nothing to walk. The cost
does not move. **Every millisecond of the 4.80 is in `launch()` and the WAAPI one-shots it
starts, and none of it is in the transform writes.**

At twenty seats on their class cadences that is ≈25 spawns/s, each starting the knight's
recoil one-shot, the muzzle flash, the impact spark and the damage number — **≈95 WAAPI
animations per second**, on a main thread that is already servicing 39 renders/s. Cumulative
style-recalc duration over the run tracks it: **2.21 s of 9.6 s with the actors, 0.71 s of
4.7 s without**, at essentially the same recalc *count* (442 vs 536) — the recalcs did not
get more frequent, they got more expensive.

### 3.3 Everything the redesign was suspected of — measured, and null

| suspect | p50 | Δ vs its baseline | verdict |
|---|---:|---:|---|
| **rasterised area, 1.00 → 4.79 Mpx** | 23.40 / 25.00 / 18.40 / 20.80 | no trend | **null over 4.8×** |
| the room grade filter (`#stage svg g[style*=filter]` → `none`) | 20.80 | +0.40 | null |
| **`.hr-boss-grade` → `none`** | 21.50 | +1.10 | **null** |
| both grade filters off | 21.70 | +1.30 | null |
| the knight halo `<use>` hidden | 21.90 | +1.50 | null |
| `.stage::after` (the full-screen vignette) removed | 18.70 | +0.30 | null |
| feed 714 Hz → 100 Hz | 20.80 | +0.40 | null |
| `<Arena>` mounted directly instead of `<Passage>` | 21.50 | +1.10 | null |
| **`BOSS_ARENA` alone in a bare svg** | **0.00** | — | **free** |
| **`WAITING` alone in a bare svg** | **0.10** | — | **free** |
| `Boss` alone, animating, with the new grade | 3.20 | — | 2.00 before → **+1.20 for the whole rig** |

Six of these were the redesign's named risks and all six are closed:

1. **§10.4's "+55 % fill rate, NOT MEASURED" is null.** Frame time over 1.00 / 0.98 / 1.98 /
   4.79 Mpx is 23.40 / 25.00 / 18.40 / 20.80 ms p50 — the two *smallest* windows are the two
   *slowest*, so there is not even a weak positive trend to salvage. Confirmed a second time
   in pass 4 at the live bullet load: 1366×768 (0.98 Mpx) reads 16.30 against 1920×1080's
   18.70. The scene is not fill-rate bound; `cpu6` throttles script and main-thread raster
   and this scene is bound by the former.
2. **The boss filter's rasterisation boundary is null,** as §2.3 item 2 already argued from a
   different measurement. The whole rig — new grade, `contrast(1.6)`, spill, white-hot core —
   costs 3.20 ms alone against 2.00 ms for the old one. **+1.20 ms for the lighting fix.**
3. **Both rooms are free**, 0.00 and 0.10 ms alone, the same result the 22,195-subpath temple
   got. `Scene.tsx`'s four barriers — a module-scope `ReactElement`, no state-derived props,
   `will-change`, `pointer-events: none` — carried over intact to `WaitingRoom.tsx` and
   `BossArena.tsx`. **The authored props, the 26 pillars, the ring family and the twelve
   braziers cost nothing. Do not simplify the art.**
4. **The knight halo is free.** One `<use>` for one `<use>`, node count unchanged, as §8.1
   predicted.
5. **The vignette is free**, even covering 1.98 Mpx.
6. **The gate beat is free** — see §4.

---

## 4. The gate transition

`room: 'passage'` flips the local seat `ZONE_LOBBY → ZONE_ARENA` every 18 ticks (1.8 s at
the crank's 10 Hz), so several complete beats run inside every measured window. The long
form is what runs, because the beat opens during `PHASE_MUSTERING`.

| case | cpu | p50 | p95 | p99 | max | > 16.7 ms |
|---|---:|---:|---:|---:|---:|---:|
| passage, live bullets | 6× | 12.70 | 24.20 | 35.30 | 40.9 | 27.7 % |
| steady fight, live bullets | 6× | 18.70 | 30.00 | 39.60 | 52.0 | 67.5 % |
| passage, 128 bullets | 6× | 17.80 | 35.20 | 60.30 | 67.0 | 55.2 % |
| passage | 1× | 2.40 | 3.30 | 5.20 | 9.2 | 0.0 % |

**The passage costs nothing the steady fight does not already cost**, on p50, p95, p99 and
the worst frame. §10.4's naive composition — "+1.2 ms onto the shipped baseline gives
≈16.1 ms p95, over budget" — is the wrong worry: the beat's own reasoning was right, the long
form only runs during MUSTERING when the bullet pool is empty, and the numbers say so.

**This is not a like-for-like comparison and must not be quoted as one.** The passage case
spends about half its window with the local seat in room A, which is the cheaper room
(15.40 vs 18.70), so some of the gap is the room and not the beat. The claim that survives is
the negative one: **no frame attributable to the transition is worse than the fight's own
worst frame.**

---

## 5. Two defects the measurement found

### 5.1 Every arrow is spawned and then hidden — including your own

`Arena.tsx:869` passes `budget={shownBullets.length}`. `visibleBullets` caps that at
`VISIBLE_BULLETS = 32`. `Shot.tsx:528` computes `cap = Math.max(0, VISIBLE_PROJECTILES − budget)`
with `VISIBLE_PROJECTILES = 32`. **With 32 or more live bullets, `cap === 0`.**

The draw loop's first test is `if (drawn >= budgetLeft)` with `drawn = 0` and
`budgetLeft = 0`, so it hides the very first seat it reaches. `frameOrder` puts the local
seat first, which means the local seat is the first one hidden — and three lines above it the
comment reads *"The local seat is never cut: its own shot is the one the player is looking
for."* **The code contradicts its own comment.**

At the live 13–15 bullets `cap` is 17–19 and most arrows survive, so this is a
volley-time defect rather than a permanent one — but volley time is exactly when the player
is shooting back, and "I cannot see anything" is the report this whole feature exists to
close.

The cost is paid either way, because the cap is applied in the *draw* step and `launch()`
runs unconditionally: raycast, muzzle one-shot, impact one-shot, damage one-shot, `Flight`
allocated. **Move the cap into `launch`** — return before the raycast when the remaining
budget is zero, drop the oldest flight rather than the newest, and exempt the local seat
there, where the exemption can actually hold. Measured ceiling of taking the spawn count from
twenty to one: **−4.60 ms p50 / −4.20 ms p95** (§3.2).

### 5.2 Boss ordnance paints into the waiting area

`Arena.tsx` gates row 7 (the boss), row 10 (the slam telegraph) and the volley telegraph on
`shown === 'arena'`. **Row 11, the bullets, is not gated** (`Arena.tsx:792`). Spec §7.1's own
table has a reachable `FIGHTING / ZONE_LOBBY / room A` state — a seat that never crossed the
gate — and in it the boss's ordnance is drawn across the waiting room. It is visible in
`scripts/spike/framebudget/shot-smoke-lobby.png`: the orange capsule fan over the portcullis.

This is a §3 R3 violation of the same kind R3 exists to prevent, and it is also why room A
carries a bullet layer it has no business paying for: the lobby renders **1056 DOM nodes to
the arena's 987**. One `shown === 'arena' &&` on the `<g>` at `Arena.tsx:791` closes it.

---

## 6. First paint, memory

**Cold first paint** — navigation to `first-contentful-paint` over localhost, whole harness
bundle (812 KB) parsed for the first time, 3 samples, 1920 × 1080:

| cpu | domInteractive | loadEventEnd | first-contentful-paint |
|---:|---:|---:|---:|
| 1× | 8.9 / 12.4 / 13.9 ms | 203 / 274 / 328 ms | **244 / 248 / 268 ms** |
| 6× | 52.3 / 57.7 / 62.9 ms | 494 / 503 / 510 ms | **372 / 372 / 408 ms** |

Against the old report's 180/196/324 (cpu1) and 312/320/324 (cpu6). Slower — but the bundle
is different (this one carries both rooms and the generated knights; the old one carried
`ArenaFixed` and an injected defs blob), and the window is 1.9× the area. **Upper bound only,
and not a regression anyone should act on.**

**Memory** — renderer-process RSS from `/proc`, scoped to the launched process tree
(`performance.memory` reads 5–13 MB for every variant, including the empty one; it measures
the JS heap and is useless for this question):

| variant | DOM nodes | renderer RSS after |
|---|---:|---:|
| room B, no actors | 744 | 486.5 MB |
| room A, no actors | 821 | 492.0 MB |
| `Boss` alone | 106 | 488.7 MB |
| room B, 20 knights | 997 | 442.8 MB |
| room A, 20 knights | 1074 | 442.0 MB |
| room B, 20 knights, feed 714 Hz | 1005 | 476.7 MB |
| the passage, 20 knights | 853 | 456.3 MB |

**Memory does not discriminate between any of these choices** — 442–493 MB, the bands
overlapping completely, and the *empty* rooms reading higher than the full ones, which is the
same unexplained inversion the old report recorded and is most likely a GC that the busier
variants have already taken. Read the band, not the ordering.

---

## 7. Verdict, and exactly what to cut

**On the dev box, ship it.** 4.60 / 6.20, zero frames over budget, 541 of 714 notifications
serviced. **On a machine 6× slower it misses 60 fps by a factor of two,** and because
`controls.ts:381` pumps sends from `setInterval(pump, 50)` on this same thread, every
over-budget frame is a late send. Spec §10.3 is right that the frame budget is the ER budget
in disguise; the client now services **39 notifications/s where it used to service 72**.

In order:

1. **Move `VISIBLE_PROJECTILES` from the draw step into `Shot.launch()`.** Measured ceiling
   **−4.60 ms p50 / −4.20 ms p95**, and it is the same edit that stops the local player's own
   arrow being hidden during a volley (§5.1). Highest value per line in the whole file. Cap
   concurrent *spawns*, drop the oldest, exempt the local seat.
2. **Stop `<Arena>` re-rendering on every notification.** The largest lever in the table by
   some distance: **714 Hz → 20 Hz is −7.70 ms p50 and −13.70 ms p95** (18.70 / 30.00 →
   11.00 / 16.30), and it is the difference between failing the gate and passing it.
   **The `subscribe.ts` dedupe spec §9.4 asks for will NOT deliver this, and that is measured:
   714 Hz and 100 Hz read the same (20.40 vs 20.80), and 68.4 % dedupe only reaches ~230 Hz.**
   The rate has to come down at the *React* boundary, not the socket: the bullets, the seat
   transforms and the arrows already reach the DOM through refs and the one rAF loop, so most
   of the per-payload render is redundant work that produces the same tree. **Not measured as
   implemented — this is the shape of the fix, not a priced patch.**
3. **Arithmetic, labelled as arithmetic:** 1 and 2 together project ≈9 ms p50 / ≈13 ms p95,
   inside the gate with room to spare. Re-run before believing it.
4. **Do not touch the art, the framing, the filters or the beat.** Both rooms are 0.00 and
   0.10 ms. The boss rig with its new lighting is +1.20 ms for the whole fix. The halo, the
   vignette, the grade filters and the passage are each null. The framing is null across a
   4.8× area sweep. **Every one of these was a named risk and every one is closed** — the
   levers §10.4 nominated ("if it fails the lever is scene complexity") are the wrong levers,
   and reaching for them would cost the redesign its picture for nothing.
5. **One `shown === 'arena' &&` on `Arena.tsx:791`** (§5.2). Costs nothing; it is correctness.

### What this does not cover

- **One Fedora/X11 box, Chrome 151, dPR 1.0, 144 Hz.** No Firefox, no WebKit, no mobile GPU,
  no dPR 2. Unchanged from the old report, and still the largest hole.
- **The HUD is not mounted.** Eight `position: fixed` clusters that consume the same store
  updates are absent from every number here, so the shipped total is **worse than this**, not
  better. That is the first thing to add to the harness.
- `cpu6` slows script and main-thread raster; it does not slow the GPU. Given §3.3's null
  area result, a GPU-bound device is the one machine class this measurement says nothing
  useful about.
- The seat feed is synthetic. Positions walk a real tile stride and `lastShotTick` advances on
  the real class period, but no two seats ever contend for the same tile and nobody stands still.
- **The telemetry drag was not measured** (§9.3 prices it at 1 forced layout per 300
  pointermoves on a fixed overlay outside `#stage`; that claim is untested here).
- Pass 1's spread is large enough that its *attribution* rows should not be quoted. Use
  passes 2–4. Pass 1's curve and its area sweep are consistent across reps and stand.
- **§12.1 item 3 also asks for `scripts/spike/perf_appath.ts`. It was not run**, and not
  because it was skipped: it is a live-chain write-to-visible measurement that needs a funded
  treasury, a delegated arena and a live seat on devnet. It measures the network, not the
  renderer, and nothing in this file substitutes for it.

### One blocker found while running the gates

**`(cd worker && npx tsc --noEmit)` exits 1**, so §12.1 item 1 does not pass on this tree.
`worker/src/routes.ts:578` calls `claimSeat` without the `class` field that
`packages/client/src/instructions.ts:481` now makes required, and `routes.ts:75` still has
only `SKIN_COUNT = 3` with no `CLASS_COUNT` sibling and no `class` in the body parse at
`:532`. This is spec §5.4's own warning — *"Miss it and the Worker rejects the seat claim"* —
caught at compile time instead of at runtime, which is the better failure. It is the Worker
half of step 10, and step 10 is an indivisible program + app + worker deploy. Not touched
here; no product file was modified for this measurement. `(cd app && npx tsc --noEmit)`,
`(cd packages/client && npx tsc --noEmit)` and `cargo check --workspace` are all **0**.

Harness, cases and raw results: `scripts/spike/framebudget/` — `main2.tsx`, `drive2.mjs`,
`cases17*.json`, `results17*.json`, `run17*.log`, `agg17.py`, `cold2.mjs`, `mem2.mjs`.
Throwaway. Re-run it rather than interpolating from it:

```
cd scripts/spike/framebudget
ln -s ../../../app/node_modules node_modules
./node_modules/.bin/vite build --config vite2.config.ts
PW_HOME=<dir with a node_modules containing playwright> DISPLAY=:0 REPS=3 \
  CASES=cases17d.json OUT=results17d.json node drive2.mjs
python3 agg17.py results17d.json
```
