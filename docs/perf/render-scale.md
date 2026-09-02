# render-scale — costing the HEARTROT visual redesign before anyone builds it

> **Historical (2026-09-03).** The SVG art this document costs — `temple.svg`, `boss.svg`,
> `knights.svg`, `room.svg`, `parts/boss.svg` — is gone: the rooms are the two reference
> paintings as `<image>`s, the boss atlas is cut from the arena painting, the archer is a
> generated pixel atlas. The method (frame-commit timing under a 6× CPU throttle, fresh
> browser per case) is what `scripts/spike/framebudget` still does; the painted-room
> numbers are in `frame-budget-rooms.md`.

**Question.** Does the real art (`temple.svg`, `boss.svg`, `knights.svg`) hold 60 fps at 20
players, and if not, what is the cheapest thing to give up: rasterising the temple,
simplifying knight paths, capping visible bullets, or CSS containment?

**Answer.** Yes, with a wide margin, and none of the four give-ups is needed. At 20 knights
under a 6× CPU throttle the scene costs **6.10 ms p50 / 7.60 ms p95** of main-thread frame
time against a 16.7 ms budget. At 33 knights it is 6.70 / 8.10 ms. On the unthrottled box it
is 1.00 / 1.50 ms.

The surprise is where the cost is. **The 128 bullets that already ship cost more per frame
than the entire new art put together** — 3.20 ms versus 2.40 ms at 20 knights, cpu6. The
temple, the thing everyone expects to be fatal, costs 0.30 ms. If the frame budget ever
needs relief the lever is the bullet loop, which is existing code, not the art.

Every number below was produced by the harness described in *Method*. Nothing is estimated.

---

## 1. What the assets actually are

The brief (and `tools/README.md` lineage) describes `temple.svg` as "16 paths". That is true
and misleading: `px2svg.py` emits **one `<path>` element per colour**, and packs every pixel
run for that colour into one `d` attribute as `M{x} {y}h{w}v{h}h-{w}z` subpaths. The element
count is 16; the geometry count is 22,195.

Counted with `grep -o 'M[0-9]' | wc -l`, cross-checked against the `z` count (they match
exactly in every file, so no subpath was miscounted):

| file | bytes | `<path>` elements | rect subpaths |
|---|---:|---:|---:|
| `assets/sprites/temple.svg` | 332,218 | 16 | **22,195** |
| `assets/sprites/boss.svg` | 118,187 | 13 | **7,589** |
| `assets/sprites/knights.svg` | 45,334 | 23 | **3,038** |
| `assets/sprites/room.svg` | 103,214 | 52 | 6,763 |
| `assets/sprites/parts/boss.svg` | 121,820 | 74 | 7,697 |
| `assets/sprites/ref-user-temple.svg` | 836,725 | 25,378 | 25,378 |
| `assets/sprites/ref-user-creature.svg` | 122,340 | 13 | 7,851 |

Two things follow, and both are load-bearing.

**The 7,589 in the project's remembered ceiling ("7,589 rects animating transform ran at
143 fps") is exactly `boss.svg`'s subpath count.** That measurement was of 7,589 *separate
DOM nodes*. Inline SVG from `px2svg` is not that shape: 22,195 temple subpaths arrive as
**16 DOM nodes**. Path-data complexity and node count are different costs, and the cheap one
is what we have. Do not budget the redesign against the 7,589-node figure — it is the wrong
model and it is pessimistic by roughly three orders of magnitude in node terms.

**`knights.svg` is a reference sheet, not three sprites.** Fills `#fdffff` (112 subpaths,
max run width 208 px) and `#ffffff` (82 subpaths, max run width 129 px) are the paper the
three knights are drawn on; every other fill has a max run width ≤ 29 px. Dropping those two
fills and splitting on the x-histogram valleys at x≈68 and x≈148 yields three sprites whose
subpath counts sum losslessly to the remaining 2,844:

| sprite | source x-band | bbox | subpaths |
|---|---|---|---:|
| knight 0 (blue cape, horned helm) | 0–70 | 65 × 112 | 1,062 |
| knight 1 (dark armour, gold trim) | 70–149 | 77 × 113 | 877 |
| knight 2 (silver plate, cross shield) | 149–216 | 59 × 77 | 905 |

**An implementer who inlines `knights.svg` whole will paint a cream rectangle over the
arena.** The background fills must be dropped at slice time.

### Scene totals actually mounted

`temple + boss = 29,784` static subpaths, plus knights, plus 128 bullet `<rect>`s:

| knights | knight subpaths | total subpaths | DOM nodes |
|---:|---:|---:|---:|
| 0 | 0 | 29,784 | 246 |
| 1 | 1,062 | 30,846 | 269 |
| 5 | 4,783 | 34,567 | 359 |
| 10 | 9,594 | 39,378 | 470 |
| 20 | 19,003 | **48,787** | 694 |
| 33 | 31,284 | 61,068 | 983 |

48,787 pieces of geometry in 694 DOM nodes at 20 players. That ratio is the whole story.

---

## 2. Method

Harness in `/tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad/harness/`
(throwaway; no product code was modified):

- `prep.py` — parses the real SVGs, slices the knights, partitions `boss.svg` into a 13-group
  rig using the real `assets/sprites/hitboxes.json` boxes. Both the knight slice and the boss
  partition `assert` that no subpath is lost, so the harness cannot quietly measure less art
  than the game will draw.
- `index.html` — mounts the scene the way `app/src/render/Arena.tsx` does: **one** `<svg>`,
  `viewBox="0 0 1024 1024"` (`MAP_TILES * MAP_TILE`), layers as `<g>`, and every animated node
  moved from a single rAF loop by writing `el.style.transform = translate(Xpx, Ypx)` — the
  same imperative write path as `Arena.tsx:185`/`:201`.
- `drive.js` — Playwright 1.62.1 driving **system Google Chrome 151.0.7922.137 headed on X11
  `:0`**, so vsync and the GPU compositor are real rather than a headless virtual clock.
- `mem.js` — renderer RSS from `/proc`, scoped to the launched process tree.

Per frame the loop performs exactly the work the redesign implies: 13 boss-part transforms
(idle sway), one transform per knight (walk + bob), and one transform per bullet.
Measurements discard 40 warm-up frames and keep 400. Viewport 1024×1024, `devicePixelRatio`
1.0, 144 Hz display.

### Two measurement artefacts I hit and corrected — read this before trusting any re-run

**1. Reusing one page across cases contaminates everything after the first heavy scene.**
My first matrix navigated once and rebuilt the scene per case. From the fourth case onward
every result pinned to ~55 fps and never recovered — including `temple:none`, which has
nothing to be slow about. A fresh-page smoke test of the identical 20-knight scene had
measured 144.9 fps. The driver now opens a **fresh browser per case**. Any re-run that reuses
a page will reproduce the fake 55 fps cliff and conclude, wrongly, that the art is too heavy.

**2. `rAF` delta is bimodal here and must not be used as the headline metric.** Chrome flips
between 144 Hz and 60 Hz vsync non-deterministically: the *same case* read `rafP50` 16.60 ms
in one rep and 7.00 ms in the next (`curve-k20`), and `baseline-empty` — 3 DOM nodes — never
flipped while `curve-k33` did. This is a display-mode switch, not load.

The reported metric is therefore **`commitP50`/`commitP95`: main-thread frame cost including
style, layout and paint commit**, measured as `performance.now()` at rAF entry to
`performance.now()` in a `MessageChannel` task that runs after the frame commits. It is
monotonic in load, reproducible to σ ≤ 0.23 ms across 5 fresh-browser reps, and is the number
that has to fit in 16.7 ms. `rAF` deltas are reported only where they add information.

**CPU throttling is the honest stand-in for weaker hardware.** The dev box is fast; shipping
its unthrottled numbers would be dishonest about a mid-range laptop or a phone. `cpu6` =
`Emulation.setCPUThrottlingRate: 6`. Treat cpu1 as "this box" and cpu6 as "a machine six
times slower".

---

## 3. The curve: knight count 1 / 5 / 10 / 20

5 reps per point, fresh browser each, alternating forward/reverse case order. Full art
throughout: inline SVG temple, 13-group inline SVG boss rig, inline SVG knights, 128 bullets.

| knights | cpu | commitP50 | σ | commitP95 | commitMax | JS work p50 | build ms | first paint ms | frames > 16.7 ms |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 1× | 0.80 | 0.00 | 1.20 | 1.50 | 0.10 | 6.0 | 4.5 | 0.0 % |
| 1 | 1× | 0.90 | 0.00 | 1.30 | 1.50 | 0.10 | 6.1 | 8.1 | 0.0 % |
| 5 | 1× | 0.90 | 0.00 | 1.10 | 1.60 | 0.10 | 6.5 | 5.7 | 0.3 % |
| 10 | 1× | 0.90 | 0.04 | 1.40 | 1.70 | 0.10 | 6.9 | 5.4 | 0.0 % |
| **20** | 1× | **1.00** | 0.00 | **1.50** | 2.00 | 0.10 | 9.0 | 6.2 | 0.0 % |
| 33 | 1× | 1.10 | 0.06 | 1.60 | 2.00 | 0.10 | 8.9 | 7.1 | 0.3 % |
| 0 | 6× | 4.30 | 0.12 | 5.60 | 8.50 | 0.20 | 37.7 | 24.4 | 0.0 % |
| 1 | 6× | 4.80 | 0.23 | 6.10 | 10.10 | 0.40 | 41.6 | 24.3 | 0.0 % |
| 5 | 6× | 5.30 | 0.12 | 6.60 | 10.20 | 0.40 | 36.5 | 25.1 | 0.0 % |
| 10 | 6× | 5.50 | 0.19 | 6.70 | 11.80 | 0.40 | 40.4 | 27.1 | 0.3 % |
| **20** | 6× | **6.10** | 0.19 | **7.60** | 14.80 | 0.60 | 46.3 | 32.8 | 2.3 % |
| 33 | 6× | 6.70 | 0.13 | 8.10 | 18.60 | 0.60 | 53.2 | 36.7 | 0.5 % |

**The curve is close to flat.** Least-squares slope over the six points is **0.0077 ms per
knight at cpu1** (intercept 0.85 ms) and **0.0649 ms per knight at cpu6** (intercept 4.70 ms).
Going from 1 player to 20 costs 0.10 ms unthrottled and 1.30 ms at 6× throttle. Adding 19,003
subpaths of knight geometry is not what decides this frame.

The fixed cost — 0.80 ms at cpu1, 4.30 ms at cpu6, with *zero* knights — is the temple, the
boss and the 128 bullets. That is where the budget goes.

---

## 4. Attribution: what each element actually costs

20 knights, cpu6, 5 reps each, fresh browser per case. `commitP50`, σ ≤ 0.11 ms throughout.

This is a **separate measurement session** from §3, and between-session variance is visible:
the same 20-knight full-art scene reads 6.40 ms here and 6.10 ms in §3. Compare rows *within*
a table, never across the two. ~0.3 ms is the between-session noise floor; every Δ claimed
below is larger than it except the temple rasterisation (0.30 ms), which is a real
within-session effect but is smaller than the between-session drift and so must not be used
to justify work.

| scene | commitP50 | commitP95 | Δ vs full | DOM nodes |
|---|---:|---:|---:|---:|
| today's renderer: 128 bullets, no art | 4.00 | 5.60 | — | 131 |
| full art, 0 bullets | 3.20 | 4.50 | −3.20 | 566 |
| **full art, 128 bullets (the redesign)** | **6.40** | **7.90** | — | 694 |
| bullets 128 → 64 | 4.80 | 6.20 | −1.60 | 630 |
| bullets 128 → 32 | 4.00 | 6.00 | −2.40 | 598 |
| temple inline SVG → rasterised bitmap | 6.10 | 7.90 | −0.30 | 679 |
| knights inline SVG → rasterised bitmaps | 5.60 | 7.60 | −0.80 | 306 |
| temple + boss + knights all rasterised | 5.10 | 7.00 | −1.30 | 194 |
| 20 → 33 knights | 6.90 | 9.10 | +0.50 | 983 |

Read the top three rows together. Today's renderer, drawing no art at all, already spends
4.00 ms. Adding the complete redesign — 22,195-subpath temple, 13-group animated boss,
20 knights — takes it to 6.40 ms. **All of the new art costs +2.40 ms. The 128 bullets that
already ship cost +3.20 ms.**

That inverts the intuition the redesign was budgeted against. The 332 KB temple is the
cheapest major element on the list.

### Answering the four candidate give-ups directly

| candidate | saves at 20 knights, cpu6 | verdict |
|---|---:|---|
| **Cap visible bullets** (128 → 32) | **2.40 ms** | The only lever worth pulling, and only if one is ever needed. |
| Rasterise everything | 1.30 ms | Costs 127 ms of build time and all sharpness. Not worth it. |
| Simplify knight paths (→ bitmaps) | 0.80 ms | Not worth it. |
| **Rasterise the temple** | **0.30 ms** | Real (σ ≈ 0.09) but 1.8 % of budget, and it costs +40 ms build time and all sharpness. **Do not do this.** |
| **CSS containment** on the temple layer | **0.00 ms** | No effect. Measured `contain:strict` + `content-visibility:auto` + layer promotion at 7.2 ms vs 7.2 ms baseline. |

Two of the four things the brief proposed giving up are measurably worthless here, and the
one that works best (bullets) is the one that has nothing to do with the art.

`will-change: transform` also made no measurable difference (7.10 ms with, 7.20 ms without, at
cpu6/k20). The scene does not depend on layer promotion. `Arena.tsx` already sets it on
bullets; keep it, but do not add more of it expecting a win — 161 promoted layers at 20
players buys nothing here.

---

## 5. First paint, build cost, memory

**Build and first paint.** Building the whole scene from parsed JSON — including
`innerHTML`-parsing 713,737 bytes of path data — is 9.0 ms at cpu1 and 46.3 ms at cpu6 for
20 knights; first paint after insertion is 6.2 ms / 32.8 ms. Rasterising is *slower* to start,
not faster: `all-raster` build is 127.2 ms at cpu6 versus 46.3 ms inline, because each sprite
must round-trip through a Blob URL and an `Image` decode. There is no first-paint argument
for rasterising either.

**Memory** (renderer-process RSS, `/proc`, scoped to the launched tree; single sample per
variant, so treat ±5 MB as noise):

| variant | renderer RSS after | Δ vs empty page |
|---|---:|---:|
| empty page | 335.6 MB | — |
| today: 128 bullets, no art | 364.9 MB | +29.3 MB |
| **full inline SVG, 20 knights** | **378.2 MB** | **+42.6 MB** |
| full inline SVG, 33 knights | 384.1 MB | +48.5 MB |
| temple rasterised, 20 knights | 382.9 MB | +47.3 MB |
| everything rasterised, 20 knights | 379.3 MB | +43.7 MB |

The art adds ~43 MB over an empty page and ~13 MB over today's renderer. **Rasterising does
not save memory — it costs slightly more**, because decoded bitmaps are larger than the path
data they replace. The differences between the last three rows are inside the noise band; the
solid conclusion is that all variants land at 375–385 MB and memory does not discriminate
between them.

Note `performance.memory.usedJSHeapSize` reads 4.7–5.1 MB for every variant including the
empty one. It measures the JS heap, not geometry or bitmaps, and is useless for this question.

---

## 6. Recommendation

**Build the redesign with inline SVG, unmodified, at full sharpness.** Specifically:

1. **Inline `temple.svg` as-is.** All 16 `<path>` elements, all 22,195 subpaths, static,
   built once and never touched by the frame loop or by React. Cost: 0.30 ms/frame at cpu6.
   Do not rasterise it, do not simplify it, do not add `contain` or `content-visibility` to
   it — all three were measured and none pays.
2. **Inline the 13-group boss rig.** Animate the 13 `<g>` elements by `style.transform` from
   the existing rAF loop. Generate the rig from `assets/sprites/hitboxes.json` at build time —
   see §7.
3. **Inline the three knight sprites**, sliced with the `#fdffff`/`#ffffff` background fills
   removed. At ~950 subpaths each they cost 0.065 ms per knight at cpu6. 33 knights fit.
4. **Leave the bullet loop alone for now** — 128 bullets at 3.20 ms/frame fits the budget —
   but understand that it, not the art, is the frame budget's largest single consumer.

**Headroom.** 20 knights at cpu6 is 7.60 ms p95 against 16.7 ms: **2.2× headroom**. 33 knights
is 8.10 ms p95: 2.1× headroom. The scene only misses 60 fps at a 20× CPU throttle
(commitP50 22.2 ms, 48 fps), which is a device far below anything that can run the rest of
this client.

**The single trigger for reopening this.** If p95 ever crosses ~12 ms on the target device,
cap *visible* bullets to 32 — worth 2.40 ms, more than rasterising every asset in the game.
Cap rendering only. `MAX_BULLETS = 128` is chain state and `bullets_per_volley = 3 +
alive_count` is chain logic; a render cap must not touch either, or the client stops agreeing
with the crank about what is on the board.

---

## 7. Implementation spec

**Slicing is a generator, not a hand edit.** `assets/sprites/knights.svg` and the boss rig
must be produced by a script under `tools/`, in the same spirit as `gen_map.py` and
`gen_hitboxes.py`. Hand-editing a sliced sprite reintroduces this project's most repeated
defect — one fact stored twice — the moment the art is retouched. The harness's `prep.py` is a
working reference implementation of both operations, including the `assert`s that make them
lossless; it is throwaway code and should be rewritten as a proper tool, not copied.

Non-negotiable properties, each of which the harness enforces and each of which failed at
least once while I built it:

- **Knight slice.** Drop fills `#fdffff` and `#ffffff`. Split on x-bands `[0,70)`, `[70,149)`,
  `[149,216)`. Assert the three slices' subpath counts sum to 2,844. Translate each slice to
  its own bbox origin so the sprite's local origin is its top-left.
- **Boss rig.** Partition by *region*, assigning each subpath to the first `hitboxes.json` box
  containing its origin, catch-all group last. Assert the partition is lossless against
  `boss.svg`'s 7,589. This keeps the animated `<g>` and the raycast rectangle literally the
  same pixels, which is why `svg_slice.py` already exists and why the rig must not be drawn by
  hand.
- **Part indices.** The nine shot-at parts must stay aligned with `Boss.parts[N_PARTS]` in
  `programs/heartrot/src/state.rs` — `crown, wolf_l, beast_r, thorn0..3, mace, claws`.
  `core`, `legs`, `torso` are rig-only groups; `core` is shot at but lives in `Boss.core_hp`.

**Rendering rules**, all measured above:

- One `<svg>`, `viewBox="0 0 1024 1024"`. Do not introduce a second unit or a scale factor;
  `ARENA_UNITS` is already `MAP_TILES * MAP_TILE` and bullet extrapolation depends on the 1:1
  mapping.
- The temple `<g>` is built once and never re-rendered. React must not own it and must not
  re-key it on a `Players` notification — 68.4 % of those carry no position change and the
  Magic Router delivers each twice, so anything that re-renders on notification will do so
  ~6× more often than the state actually changes.
- Every animated node is moved by `el.style.transform` from the one rAF loop, exactly as
  `Arena.tsx` does today. Preserve the prediction/interpolation split: local seat from
  `predictor.self`, remote seats from interpolation. Nothing here changes that, and it is what
  fixed the fight-time stutter.
- One writer per node's transform. The knight sprite needs two nested `<g>`: the outer one is
  the frame loop's (position + walk bob), the inner one carries the static
  `scale(...) translate(...)` that maps sprite pixels to arena units. Do not combine them.

**Sizes used in the measurement**, which the numbers above are only valid for: knight scaled
to 44 arena units tall (2.2× today's `PLAYER_R = 10` dot); boss scaled to 300 arena units wide
(3.3× today's `BOSS_R = 46` circle); bullets 8×8 arena units. A materially larger boss or
knight changes the rasterised area and invalidates these figures — re-run the harness rather
than interpolating.

---

## 8. A blocker outside the render budget — the boss cannot simply move to top centre

This is not a rendering finding, but it will stop the 33 Immortals composition dead and the
brief states the opposite, so it belongs here.

**The brief says `map::BOSS_SPAWN = (512, 320)`, tile (32,20). It is not.** The constant at
`programs/heartrot/src/map.rs:142` is:

```rust
pub const BOSS_SPAWN: (i16, i16) = (512, 512); // tile (32, 32)
```

`(512, 320)` is the value of a **bug that was already fixed**. The comment immediately above
that constant records it: the boss was inside solid rock, `shoot`'s ray died on the corridor
wall before reaching it, and three copies of the coordinate disagreed. The only surviving
`(512, 320)` in the tree is a test fixture at `state.rs:1134`.

I parsed `map::WALLS` and cross-checked all 64 × 64 tiles against the ASCII art in its own
row comments — they agree exactly — then measured wall density in a 7 × 7 tile box:

| placement | tile | centre is wall | solid tiles in 7×7 |
|---|---|---|---:|
| current `BOSS_SPAWN` (512, 512) | (32, 32) | no | **0 / 49** |
| brief's claimed (512, 320) | (32, 20) | no | **35 / 49** |
| top centre (512, 160) | (32, 10) | no | 4 / 49 |
| (512, 96) | (32, 6) | no | 6 / 49 |

The current spawn sits in a perfectly clear chamber. The brief's coordinate is 71 % solid
rock — moving the boss there re-creates precisely the documented bug.

Worse for the composition: the map has no pit. Row-by-row, the widest unbroken floor run is
62 tiles at rows 1, 4, 11–13, 31, 49, 52, 59–62, but **rows 15–48 — the entire middle — never
exceed a 16-tile run.** It is a symmetric four-quadrant dungeon, not an arena. The 33 Immortals
layout needs a clear band across the top for the boss and one wide open pit below it, and the
current `WALLS` table provides neither.

**Therefore:** moving the boss to top centre is a **map regeneration** via `tools/gen_map.py`
(editing `assets/map/arena.json`), not a coordinate change. The viable boss band is rows
11–13, the only fully-clear rows in the top half. `BOSS_SPAWN` must be re-derived by the
generator, which already `assert!`s that the spawn is not in a wall — that assert is the thing
that will catch a hand-edit, and it fires on every `cargo check`. Do not hand-edit
`map.rs`; it is generated.

---

## 9. Confidence and what I did not measure

- All frame-time figures: 5 reps, fresh browser per rep, σ reported. Solid.
- Memory: **single sample per variant**. The 375–385 MB band is trustworthy; the ordering
  within it is not.
- One machine, one GPU, one browser: Chrome 151 on Fedora, X11, dPR 1.0, 144 Hz. **Not
  measured: Firefox, Safari/WebKit, any mobile GPU, or dPR 2.** A dPR-2 display quadruples
  rasterised area and is the most likely way these numbers get worse; the 2.2× headroom at
  cpu6 is the margin available to absorb it, and it is probably but not certainly enough.
- CPU throttling slows script and main-thread raster; it does **not** slow the GPU. A device
  that is GPU-bound rather than CPU-bound is not modelled by `cpu6`.
- Bullets were animated every frame for all 128 slots. The real game pools them and a full
  pool drops the spawn, so 128 simultaneously-active bullets is the worst case, not the
  common one. The 3.20 ms bullet cost is therefore an upper bound.
- I did not measure the gate/lobby/walking phases, only the fight. The fight is the dense one.
