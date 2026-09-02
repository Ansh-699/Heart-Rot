# HEARTROT — Full-screen presentation, and the death of the camera

**Date:** 2026-09-02
**Status:** Specification. Nothing here is implemented.
**Implements against:** `app/src/render/Arena.tsx`, `app/src/render/sprites.ts`, `app/src/App.tsx`,
`app/src/styles.css`, `app/src/state/store.ts`.
**Touches the chain:** nothing. No instruction, no account byte, no notification. See §10.

---

## 0. How the numbers in this document were got

Three sources, and nothing else. Where a figure has no citation here, it is arithmetic on
the constants in §1.2 and can be re-derived.

1. **Stage rectangles** — measured. `app/src/styles.css` was copied verbatim into a static
   replica of `App.tsx`'s shell markup (`.shell > .header + .main > #stage.stage + .panel`),
   served over HTTP and measured in Chromium via Playwright at twelve window sizes. The
   header measured **47.8 px** at every one; `.main:has(> .stage)` gives the panel a fixed
   320 px, so `stage = (winW − 320) × (winH − 47.8)`. The replica uses fallback fonts, so a
   loaded `--pixel` face could move the header by a pixel or two; nothing below is sensitive
   to that.
2. **Fit arithmetic** — `fit.py`, a 60-line script over the rule in §4. Reproduced
   independently in Chromium (§4.4) against real `getScreenCTM()` matrices; the two agree to
   four decimal places on all fourteen (shape × room) combinations tested.
3. **Reference images** — measured by eye off the PNGs at their native sizes:
   `waiting_area_full_vertical.png` 1122×785, `actual_boss_arena.png` 1122×612.

Anything I did **not** measure is called out as such. There is one, in §11.

---

## 1. What ships today

### 1.1 The shipped code, read line by line

`app/src/render/Arena.tsx`:

| line | what |
|---|---|
| 241–242 | `LOBBY_ZOOM = 2`, `LOBBY_SPAN = ARENA_UNITS / LOBBY_ZOOM` = **512** |
| 250–259 | `LOBBY_X` = 181, `LOBBY_Y` = 512 — the initial lobby window, framed on the union of the gate and the spawn fan |
| 265 | `LOBBY_MARGIN = 96` — the follow camera's dead zone |
| 268 | `lobbyOriginFor(x, y)` — the window that centres a point, clamped to the map |
| 275 | `nearLobbyEdge(o, x, y)` — re-centre test |
| 283 | `CAM_ARENA = 'scale(1) translate(0px, 0px)'` |
| 290–291 | `CAMERA_MS = 900`, `CAMERA_EASE` |
| 404 | `const crisp = usePixelFit(boxRef, svgRef)` |
| 516–538 | the camera `useLayoutEffect`: sole writer of `#camera`'s transform, WAAPI only |
| 636–655 | the wrapper `<div>` (`display:flex; align-items:center; justify-content:center`) and the `<svg viewBox="0 0 1024 1024">` |
| 927–955 | `usePixelFit` — sizes the `<svg>` to a **square** of side `min(boxW, boxH)`, snapped down to an integer device-pixel multiple of 1024, and returns whether that snap was possible |

So, concretely, today:

- The `<svg>` is **always a square**, side `min(stageW, stageH)`, centred in the stage by the
  wrapper's flexbox. On a 1920×1080 window the stage is 1600×1032 and the square is 1032 —
  **568 px of the stage, 35.5 % of it, is empty background**.
- `viewBox` is fixed at `0 0 1024 1024`.
- `#camera` carries `scale(2) translate(-x, -y)` while `phase ∈ {LOBBY, MUSTERING}` and
  `scale(1) translate(0,0)` otherwise. In the fight the whole 1024² world is on screen,
  including the 384 units of empty backdrop above the pit and the 416 units of empty lobby
  below it. **The pit — the 992 × 224 box the fight happens in — is 22 % of the picture.**
- In the lobby the visible window is 512 × 512 world units and it **follows the local
  knight** with a 96-unit dead zone.

### 1.2 Constants this document builds on

From `packages/client/src/map.ts`, generated from `assets/map/arena.json` by
`tools/gen_map.py`:

```
MAP_TILES 64   MAP_TILE 16   ARENA_UNITS 1024   MAP_MAX_XY 1023
PIT_TOP 384    PIT_BOT 607              raider box: y 384..607
GATE_MIN_X 480 GATE_MAX_X 543  GATE_MIN_Y 608  GATE_MAX_Y 639
LOBBY_SPAWN_MIN_X 208  LOBBY_SPAWN_MAX_X 664  LOBBY_SPAWN_Y 832
BOSS_SPAWN (512, 400)
```

Read off the grid in `assets/map/arena.json` directly:

```
rows  0..23   open backdrop above the pit — no player may ever stand here (mayMoveTo clamps)
rows 24..35   the pit, full width (cols 1..62), funnelling at rows 33..35
rows 36..37   the neck, cols 30..33
rows 38..39   the GATE block, cols 30..33            -> y 608..639, x 480..543
rows 40..62   the lobby room, cols 1..62, with pillar pairs   -> y 640..1007, x 16..1007
row  63       wall                                            -> y 1008..1023
```

From `packages/client/src/hitboxes.ts` (generated): `BOSS_SCALE 3`, sprite 230 × 270,
`BOSS_ANCHOR (-345, -405)`. At `BOSS_SPAWN` the sprite canvas is x 167..857, y −5..805,
clipped by `#heartrot-boss-clip` at y ≤ 608. The **ink** — the union of `PART_HITBOXES` —
spans x 170..833, y 16..712, so on screen it is **663 × 592 after the clip**, topped by the
crown at world y **16**.

Knight sprite: `SPRITE_W 33`, `SPRITE_H 42` (`knights.gen.ts`), drawn 1 sprite pixel = 1
arena unit. A knight is **33 units wide**.

### 1.3 The defect the follow camera is currently shipping

Not a new bug report — arithmetic on the shipped constants, run in `fit.py`:

```
shipped initial window:  x 181..692  y 512..1023
spawn x=208 (seat 0): re-centres=True   window x 0..511    gate columns visible 32/64
spawn x=436          : re-centres=False  window x 181..692  gate columns visible 64/64
spawn x=664          : re-centres=True   window x 408..919  gate columns visible 64/64
```

Seat 0 spawns at x 208. That is 27 units **inside** the 96-unit dead zone of the initial
window, so `nearLobbyEdge` is true on the first `Players` notification and the camera
re-centres to `x 0..511` before the player has pressed a key. The gate spans x 480..543;
in that window **half of it is off screen**. The first player to join a match is shown a
panning room and half a doorway.

The existing self-check (`Arena.tsx:1017–1050`) does not catch it: it asserts that the
*initial* window frames the gate and that *some* window exists for any point, never that a
player and the gate are visible *at the same time*. That is the whole failure mode of a
follow camera and it is why this document deletes it rather than tuning it.

Also visible in the same numbers: **51.6 % of the lobby room's floor width** (512 of 992
units) is on screen at once, ever.

### 1.4 One coupling that will break silently

`App.tsx:400–421`, `aimOrigin`:

```ts
const scale = box.width / ARENA_UNITS;
return { x: box.left + predictor.self.x * scale, y: box.top + predictor.self.y * scale };
```

Its own comment says it: this is correct only while `#camera` is at scale 1 and the whole
1024-unit world is on screen. Every change in this document invalidates it. It is
fire-and-forget input with no error path, so a wrong aim is silent. §7.4 replaces it.

---

## 2. The decision: what "the full map" means

**Committed: the ACTIVE ROOM, fitted to the viewport. Not the 64×64 grid.**

### 2.1 The references settle it

The two PNGs are two *rooms*, not two crops of one picture. Image A is an enclosed stone
chamber with a portcullis in its top wall; image B is a circular arena with a boss on a
dais. Nothing in image A is visible in image B and nothing in B is visible in A. The user's
own framing — "the boss fight happens BEYOND THE GATE — you pass through it" — is a
statement that the two are different places. A single framing containing both is a picture
of neither.

### 2.2 The whole grid does not fit anything

The 1024² world is square. Every stage rectangle measured in §0 is wider than it is tall
except two portrait outliers; the aspect range is **0.978 to 2.241**. A square region in a
1.55 stage letterboxes to 1032 px in a 1600 px hole — which is exactly what ships today and
exactly what the user is calling small. Fitting the square by *width* instead would crop
32 % of its height, which is the pan the user is calling bad.

And most of the grid is nothing. Rows 0..23 are 384 units of backdrop no player can ever
enter; rows 40..62 are the lobby, empty for the entire fight. Showing both rooms at once
spends 62 % of the picture on the room nobody is in.

### 2.3 Playability at twenty players

Knight is 33 × 42 units.

| framing | px/unit at 1920×1080 | knight | pit drawn as | room floor visible |
|---|---|---|---|---|
| today, FIGHTING | 1.008 | 33 px | 1000 × 226 px | — |
| today, LOBBY | 2.016 | 66 px | — | 51.6 % of width |
| **this spec, arena** | **1.5625** | **51.6 px** | **1550 × 350 px** | 100 % |
| **this spec, lobby** | **1.5625** | **51.6 px** | — | **100 %** |

The fight — the thing that matters — draws the pit into **2.40× the pixels** it gets today
((1.5625/1.008)²) and the knight 56 % larger. The lobby knight gets 22 % *smaller* than
today's 2× zoom, and that is the price of the whole room being visible; it is the trade the
user asked for in as many words.

Occupancy at twenty seats: 20 × 33 × 42 = 27,720 unit², against a pit of 992 × 224 =
222,208 (**12.5 % coverage**) and a lobby floor of 992 × 368 = 365,056 (**7.6 %**). Neither
room is crowded at full seats; there is no legibility argument for zooming in further.

### 2.4 Which room is active — and it is not the phase

`Arena.tsx:504` currently keys the framing on `arena.phase`. That is wrong, and provably:
`enter_gate` (`handlers/player.rs:555`) flips **one seat** to `ZONE_ARENA` and teleports it
to `tick::entrance_for(seat)` while the arena is still `LOBBY`/`MUSTERING`. During a muster,
players are in **both** rooms at once, and today a player who has already walked through the
gate is still shown the lobby framing.

The right signal already exists and is already the thing that swaps the HUD panel —
`store.ts:447 screenOf`:

```ts
return mySeatSlot(state)?.zone === ZONE_ARENA ? 'arena' : 'lobby';
```

**The room is the screen.** `Arena` derives it from props it already has:

```ts
const room = players.slots[localSeat]?.zone === ZONE_ARENA ? 'arena' : 'lobby';
```

No new prop, no new subscription, no second definition of where the player is. When
`localSeat` is `-1` or the slot is unoccupied (spectating, or before `useMatchLink`
resolves), fall back to `arena.phase === PHASE_LOBBY || arena.phase === PHASE_MUSTERING ?
'lobby' : 'arena'`.

**Accepted consequence:** during a muster, a player in the pit cannot see allies still in
the lobby, and vice versa. That is not the off-screen-player defect §1.3 describes — they
are in a different room, behind a shut gate, and the roster in the HUD already says how many.
The moment they cross, they appear at an entrance inside the active framing.

---

## 3. The two visual rectangles

A **visual rect** `V` is the composed picture: everything that must be on screen, always,
on every window shape. It is bigger than the playable box, the way reference A is bigger
than its floor.

Both rects are **1024 × 656**. That is not a coincidence to be preserved by luck — §6
depends on it and §9 asserts it.

### 3.1 `V_LOBBY` — derived from reference A's own proportions

Measured off `waiting_area_full_vertical.png` (1122 × 785): the floor interior runs
y ≈ 250..690, so `floorH ≈ 440 px`. Above it, up to the top of the gate tower, is 250 px
(**0.568 × floorH**). Below it, to the bottom of the stairs, is 95 px (**0.216 × floorH**).

Our lobby floor is y 640..1008, `floorH = 368`:

```
above = round(0.565 × 368) = 208   ->  V_LOBBY.y      = 640 − 208 = 432
below = round(0.217 × 368) =  80   ->  V_LOBBY bottom = 1008 + 80 = 1088
V_LOBBY = { x: 0, y: 432, w: 1024, h: 656 }
```

Ratios back-check: 208/368 = 0.565 against the reference's 0.568; 80/368 = 0.217 against
0.216. The bottom 64 units lie outside the world and are bleed — reference A's stairs
descend off its bottom edge too.

The 208 units above the floor are where the portcullis (y 608..639), the "BOSS FIGHT" sign,
the ram crest, the braziers and the banner wall live. This is art, in the lobby layer, and
it occupies world y 432..640, which is arena space. §5 is what makes that legal.

### 3.2 `V_ARENA` — the boss, and the rim

Bottom edge is `PIT_BOT + 1 = 608`: the rim line, where `#heartrot-boss-clip` already cuts
the boss and where the rim occluder is redrawn over everything. Height is fixed at 656 to
match `V_LOBBY`:

```
V_ARENA = { x: 0, y: −48, w: 1024, h: 656 }
```

That puts 64 units of headroom above the crown's top at world y 16 — **9.8 % of frame
height**, against reference B's ~55 px of 612 (**9.0 %**). The full sprite canvas (top at
y −5) is inside the frame.

### 3.3 Where these constants live

`app/src/render/sprites.ts`, beside `ARENA_UNITS`, exported as `VIEW_ARENA` / `VIEW_LOBBY`
and **derived, not typed** — `GATE_MAX_Y + 1` for the floor top, `MAP_MAX_XY + 1 − MAP_TILE`
for the floor bottom, `PIT_BOT + 1` for the arena's bottom. The two reference ratios (0.565,
0.217) are the only literals, and they carry the measurement in a comment. Both `Scene`
layers and `Arena` read them; nothing computes a framing twice.

---

## 4. The fit: viewBox from stage rectangle

### 4.1 The rule

```
fit(V, stageW, stageH):
    a  = stageW / stageH
    vw = max(V.w, V.h * a)
    vh = max(V.h, V.w / a)
    return { x: V.x + V.w/2 − vw/2,  y: V.y + V.h/2 − vh/2,  w: vw,  h: vh }
```

Written to the root `<svg>` as `viewBox="x y w h"` with `preserveAspectRatio="xMidYMid meet"`
and `width: 100%; height: 100%` — the SVG fills the stage cell exactly. Exactly one of `vw`,
`vh` grows; the other is `V`'s. Centred on `V`'s centre on both axes, unclamped and never
clamped to the world.

### 4.2 Aspect mismatch: overscan, never bars, never crop

The surplus is spent on **world**, not on background. There is no letterboxing and there is
no cropping, and both follow from the rule rather than from a check:

- `a ≥ V.w/V.h ⟹ vw = V.h·a ≥ V.w and vh = V.h` → grows in x only.
- `a < V.w/V.h ⟹ vh = V.w/a > V.h and vw = V.w` → grows in y only.
- `vw/vh = a` by construction, so `meet` is exact and letterboxes nothing.
- `V ⊆ viewBox` always, since the box only ever grows about `V`'s centre.

Swept in `fit.py` over aspect 0.001 → 3.500 in steps of 0.001, both rooms: **0 violations**
of *(V inside viewBox)* and *(viewBox aspect == stage aspect)* in 7,000 checks.

### 4.3 The measured table

Stage rectangles measured per §0; viewBox and scale computed by the rule. Both rooms give
the same numbers except where noted, because both rects are 1024 × 656.

| window | stage px | a | viewBox `x y w h` | bleed x | bleed y | px/unit | knight px |
|---|---|---|---|---|---|---|---|
| 1920×1080 | 1600×1032 | 1.550 | `0 −50 1024 660` (arena) / `0 430 1024 660` (lobby) | 0 | ±2 | 1.5625 | 51.6 |
| 2560×1440 | 2240×1392 | 1.609 | `−16 −48 1056 656` / `−16 432 1056 656` | ±16 | 0 | 2.122 | 70.0 |
| 1600×900 | 1280×852 | 1.502 | `0 −61 1024 682` / `0 419 1024 682` | 0 | ±13 | 1.250 | 41.2 |
| 1440×900 | 1120×852 | 1.315 | `0 −109 1024 779` / `0 371 1024 779` | 0 | ±61 | 1.094 | 36.1 |
| 1920×1200 | 1600×1152 | 1.389 | `0 −89 1024 737` / `0 391 1024 737` | 0 | ±41 | 1.5625 | 51.6 |
| 1280×800 | 960×752 | 1.277 | `0 −121 1024 802` / `0 359 1024 802` | 0 | ±73 | 0.9375 | 30.9 |
| 1512×982 (MBP 14) | 1192×934 | 1.276 | `0 −121 1024 802` / `0 359 1024 802` | 0 | ±73 | 1.164 | 38.4 |
| 1366×768 | 1046×720 | 1.453 | `0 −72 1024 705` / `0 408 1024 705` | 0 | ±24 | 1.0215 | 33.7 |
| 1024×768 | 704×720 | 0.978 | `0 −244 1024 1047` / `0 236 1024 1047` | 0 | ±196 | 0.6875 | 22.7 |
| 1280×1024 | 960×976 | 0.984 | `0 −241 1024 1041` / `0 239 1024 1041` | 0 | ±193 | 0.9375 | 30.9 |
| 2560×1080 uw | 2240×1032 | 2.171 | `−200 −48 1424 656` / `−200 432 1424 656` | ±200 | 0 | 1.5732 | 51.9 |
| 3440×1440 uw | 3120×1392 | 2.241 | `−223 −48 1470 656` / `−223 432 1470 656` | ±223 | 0 | 2.122 | 70.0 |

**Worst-case bleed over the twelve shapes: x ±223, y ±196.**

Note the shape of the failure at the bottom of the table: on a 1024×768 window the stage is
704 px wide and the room is 1024 units wide, so `px/unit = 704/1024 = 0.6875` and a knight
is 22.7 px. That is not a regression — today's square is `min(704, 720) = 704` and gives
exactly the same 0.6875 in the fight. Once "the whole 1024-wide room is visible" is the
requirement, the scale on a narrow stage is `stageW/1024` and there is nothing left to
choose. There is no bleed cap, deliberately: capping the bleed and letterboxing the surplus
would produce the identical scale (see the derivation above — `vw = V.w` whenever
`a < V.w/V.h`) and trade authored dark for empty dark.

### 4.4 Verified in a browser, not just in Python

A standalone page applying §4.1 to a real `<svg>` in Chromium, at **all twelve** measured
stage sizes × both rooms — 24 cases. For each it read `getBoundingClientRect()` on the SVG
and `getScreenCTM()` on `#camera`:

- SVG fills the stage to within 0.5 px: **24/24**
- CTM is uniform (`a === d`, no skew): **24/24**
- `V`'s corners inside the stage rect — nothing cropped: **24/24**
- `px/unit` read off the live CTM equals `fit.py`'s column, to 4 dp, on all 24: 1.5625,
  2.122, 1.25, 1.0937, 1.5625, 0.9375, 1.1641, 1.0215, 0.6875, 0.9375, 1.5732, 2.122 —
  identical for both rooms at every shape, which is the §3 equal-size property showing up
  in a browser.

### 4.5 Bleed is the art's problem, and it has a budget

Nothing outside `V` is world. Two tiers:

1. **Void rect.** The first child of every room layer is one `<rect>` whose `x/y/width/height`
   are set to the **live viewBox**, filled with that room's darkest stone. One attribute
   write per resize. This is what guarantees no window shape can ever show through to the
   page background, at any aspect.
2. **Authored bleed, 256 units on every side of `V`.** 223 and 196 are the measured worst
   cases (§4.3); 256 is 16 tiles and the next round number above both. Within that band the
   art is real — continued wall courses, torch falloff, floor. Beyond it, tier 1.

`.stage::after` (`styles.css:253`) already paints the depth ramp and vignette **on the lens**,
in stage coordinates, outside the SVG. It keeps working unchanged and is what stops the bleed
band reading as an empty plain. Do not move it into the scene.

---

## 5. Two room layers, one at a time

`V_LOBBY` covers world y 432..1088 and `V_ARENA` covers −48..608. They **overlap** at
y 432..608, and the lobby's gate tower is authored there. So:

- The scene splits into two sibling groups under `#camera`: `#room-lobby` and `#room-arena`.
  Each paints **everything inside its own `V` plus 256 units of bleed**, opaquely, including
  whatever world another room also claims.
- At rest exactly one is `opacity: 1` and the other `opacity: 0` with `pointer-events: none`.
  Never both, outside the §6 transition.
- Everything that is not room art — walls path, gate rect, bullets, boss, telegraphs,
  knights, rim, spawn light — stays where it is in the existing layer order (`Arena.tsx:21–41`),
  above both room groups. Their world coordinates do not change and neither does their paint
  order.
- The boss stays at `BOSS_SPAWN`, drawn in world coordinates, clipped at the rim exactly as
  today. **Nothing in this document moves the boss.** Top-middle at x 512 is dead centre of
  a rect whose x is `0 … 1024`, and the fit centres x on `V`'s centre on every aspect, so
  the boss is horizontally centred on every window shape in §4.3 — check the table: x bleed
  is always symmetric.

`SCENE` (`render/Scene.tsx`) is a module-scope constant React never walks again. Splitting
it into two module-scope constants keeps that property; do not turn it into a component with
props.

---

## 6. The gate transition

### 6.1 Transform, not viewBox

`Arena.tsx:50` records the measurement that governs this: animating the `viewBox` attribute
cost **9.6 ms/frame** against **~1.7 ms** for the identical scene on a `<g>` transform. That
stands. So:

- `viewBox` is written **only** on mount, on resize, and on the room change — never animated,
  never touched per frame.
- `#camera`'s transform is the animated thing, and its **resting value is `identity`, always,
  in both rooms**. Nothing pans. `CAM_ARENA` and the resting `scale(2) translate(…)` both
  go away.

### 6.2 The move

On a room change from `prev` (the viewBox in effect) to `next` (the new room's fitted
viewBox), both applied in the same commit:

```
s  = next.w / prev.w
T  = translate(next.x − s·prev.x, next.y − s·prev.y) scale(s)
```

`T` makes the new viewBox show exactly the old framing. Animate `#camera` from `T` to
`identity` over `CAMERA_MS` with `CAMERA_EASE` — the constants already in the file, unchanged.

Because both rects are 1024 × 656, `s = 1` and `T` collapses to a pure translate. Computed
across all twelve measured shapes:

```
s = 1.0000 on 12 of 12;  max |s − 1| = 0.00%
lobby -> arena:  translate(0, −480)  ->  identity     on all twelve
arena -> lobby:  translate(0, +480)  ->  identity     on all twelve
```

480 units is 30 tiles, straight up through the gate. A pure composited translate: no scale,
no filter re-rasterization (`.hr-boss-grade` carries a CSS `filter`, which is the one thing
in the tree an animated scale could rasterize badly), no per-frame JS. Keep the general `s`
term in the code anyway — it costs one division and it is what makes the transition correct
if someone later changes a rect's height.

### 6.3 The rest of the transition

- Cross-fade the two room layers over the same 900 ms. The outgoing room must be gone before
  the camera reaches the destination's world space, or its gate tower paints over the pit:
  fade `#room-lobby` out over the first 40 % and `#room-arena` in over the whole move.
  Whether that reads well is `07-animation.md`'s call; the constraint here is only that
  exactly one room is opaque at rest.
- Reduced motion: `duration 0`, a cut, exactly as `Arena.tsx:531` does today. A 480-unit
  full-frame translate is the one genuinely vestibular thing in this scene.
- First paint (`cameraFrom === null`): `duration 0`. Same guard as today.
- A resize **during** the transition: cancel the animation, recompute the viewBox for the
  current room, settle `#camera` to identity. Do not try to re-target a running animation.
  Resizing mid-flight is rare and a cut is the honest answer.

---

## 7. What changes, file by file

### 7.1 `app/src/render/Arena.tsx` — the fit hook

`usePixelFit` is replaced by `useViewFit(box, svg, room)`. It owns the `viewBox` attribute
and the resting `#camera` transform, and it is the **only** writer of either.

```
useViewFit(box, svg, camera, room, reduced):
  ref  applied: Rect | null = null
  effect:
    apply():
      r = box.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return
      next = fit(room === 'arena' ? VIEW_ARENA : VIEW_LOBBY, r.width, r.height)
      s = format(next)                              // fixed 3 dp, so it is comparable
      if (s === lastString) return                  // ResizeObserver fires per drag frame
      prev = applied
      svg.setAttribute('viewBox', s); applied = next; lastString = s
      if (prev !== null && prev.room !== room) animateCamera(prev, next)   // §6.2
      else camera.getAnimations().forEach(a => a.cancel())                 // resize: settle
    apply()
    ro = new ResizeObserver(apply); ro.observe(box); return () => ro.disconnect()
```

Returns nothing. **No `useState`** — today's `setCrisp` fires from inside a ResizeObserver,
and dropping it removes a React render from the window-drag path.

The hook must run on both the resize and the room change; a single effect with `[room]` in
the deps plus the observer covers both, and the string guard makes the double call free.

The `ponytail:` note at `Arena.tsx:922` — that a bare `devicePixelRatio` change with no
layout change is missed — **is resolved by deletion**, not by a `matchMedia` listener. §8
drops the integer snap, so nothing in the fit reads `devicePixelRatio` at all.

### 7.2 `app/src/render/Arena.tsx` — the markup

```jsx
<div ref={boxRef} className={className} style={{ position: 'relative', overflow: 'hidden', minHeight: 0 }}>
  <svg ref={svgRef}
       preserveAspectRatio="xMidYMid meet"
       shapeRendering="geometricPrecision"
       style={{ display: 'block', width: '100%', height: '100%' }}
       role="img" aria-label={…}>
```

The flex centring goes (there is nothing left to centre) and the `viewBox` attribute goes
(the hook owns it — React must not also write it, or the two writers fight the way the file's
own header warns about). Do not set `width`/`height` presentation attributes; the CSS wins
and two sources for one size is the defect class this repo keeps paying for.

### 7.3 `app/src/render/Arena.tsx` — the room

```ts
const room: 'arena' | 'lobby' =
  players.slots[localSeat]?.occupied === true
    ? (players.slots[localSeat]!.zone === ZONE_ARENA ? 'arena' : 'lobby')
    : (arena.phase === PHASE_LOBBY || arena.phase === PHASE_MUSTERING ? 'lobby' : 'arena');
```

`ZONE_ARENA` is already exported from `@heartrot/client` (`layout.ts:131`).

### 7.4 `app/src/App.tsx` — `aimOrigin`, which breaks otherwise

Replace the hand-rolled `box.width / ARENA_UNITS` (§1.4) with the browser's own world→client
matrix, taken from the **camera group**, so it is right during the transition too:

```ts
aimOrigin: () => {
  const cam = host.querySelector<SVGGElement>('#camera');
  const m = cam?.getScreenCTM();
  if (!m) return null;
  const p = new DOMPoint(predictor.self.x, predictor.self.y).matrixTransform(m);
  return { x: p.x, y: p.y };
},
```

This is a strict simplification: no `ARENA_UNITS`, no assumption about the camera scale, no
`getBoundingClientRect`. Verified uniform (`a === d`) on 14/14 cases in §4.4, which is what
`aimFromVector` needs — it takes a **direction** from client-pixel deltas, and a non-uniform
scale would skew every angle. Keep the `null` return: `attachControls` reads it as "keep the
last facing".

**The fit must never introduce a non-uniform scale.** That is a hard invariant, not a
preference, and §9 asserts it.

### 7.5 `app/src/styles.css`

- `.stage > svg, .stage > canvas { width: 100%; height: 100% }` at line 273 is currently
  **dead** — the SVG is not a direct child of `.stage`; it is inside the portal's
  `position:absolute; inset:0` div and then Arena's own div. Either change it to `.stage svg`
  or delete it and keep the inline style from §7.2. Do not keep both.
- `img, svg, canvas { image-rendering: pixelated }` (line ~101) stays. It is a no-op for
  vector paths — there is no raster in the scene — but it is the right default the day
  someone adds an `<image>`.
- `.stage::after` stays exactly as it is (§4.5).

---

## 8. Sharpness — and why `crispEdges` goes

The user asked for "sharper and enhanced". The honest decomposition:

**There is no raster to blur.** Every scene element is an SVG `<path>` — `Scene.tsx`'s 16
paths, the generated knight poses, the boss art. Vectors re-rasterize at whatever scale the
viewBox gives them. "Sharper" here therefore means **bigger**, and §2.3's table is the whole
of it: 1.008 → 1.5625 px/unit in the fight, the pit into 2.40× the pixels.

**Integer pixel snapping cannot survive filling the stage.** `usePixelFit` today buys an
integer device scale by choosing the SVG's *size* — which is only possible because it leaves
bars. Fill the stage and the scale becomes `stageW/vbW`, and the only remaining lever is to
round the *viewBox* up to the next integer scale, which costs extra world:

```
k = floor(stageW · dpr / vbW);  waste = (stageW · dpr / k) / vbW − 1
```

Run over all 12 shapes × both rooms × dpr ∈ {1, 1.5, 2, 3} — 96 combinations — with a 5 %
world budget: an integer scale is available in **16 of 96**. Examples: 1920×1080 at dpr 2
snaps to k=3 for 4.2 % extra world; the same window at dpr 1 would need 56.2 %; 1600×900 at
every dpr needs 25 % or more.

So `crispEdges` would be available on roughly one in six configurations — and *which* one
depends on the window size, so dragging a window would flip the render mode **and** shift the
framing by up to 5 % mid-drag. Meanwhile the other five in six get `crispEdges` at a
fractional scale, which is precisely the failure `Arena.tsx:648–652` already documents: edges
snap unevenly and the unevenness *moves* as a sprite translates, and the local knight
translates 5.3 units per frame.

**Decision: `shape-rendering="geometricPrecision"`, unconditionally. Delete `usePixelFit`,
delete the `crisp` state, delete the toggle.** Stable-soft over flickering-hard, which is the
same trade the shipped comment already makes below 1:1 — this change just makes below-integer
the common case.

**Consequence for the art, and it is a real constraint:** the worst measured scale is 0.6875
px/unit (1024×768). A 1-unit keyline is sub-pixel there and will grey out. **No art feature
carrying identity may be thinner than 2 units.** The knight sprites are already at risk —
`Knight.tsx:120–160` measured the dark keyline at 49 % of Argent's surviving pixels and the
identifying accent at 6.1 %, at a much friendlier scale than 0.69. That is `art`'s problem,
not the camera's, but this framing is what sets the floor it has to clear.

---

## 9. The self-check that replaces `Arena.tsx:1017–1051`

Dev-only, same `ok()` idiom, same file. Delete every assertion mentioning `LOBBY_X`,
`LOBBY_Y`, `LOBBY_SPAN`, `LOBBY_ZOOM` or `lobbyOriginFor` — they are about a camera that no
longer exists — and put these in their place. Each one is a silent failure otherwise.

```ts
// The pure-translate transition (§6.2) is only pure while the rects are the same size.
ok(VIEW_ARENA.w === VIEW_LOBBY.w && VIEW_ARENA.h === VIEW_LOBBY.h,
   'both room framings are the same size, so the gate move is a translate');

// The lobby frame must contain the room and the doorway out of it. This is the check
// whose absence shipped a seat-0 spawn that could see half a gate.
ok(VIEW_LOBBY.y <= GATE_MIN_Y && GATE_MAX_Y < VIEW_LOBBY.y + VIEW_LOBBY.h,
   'the lobby framing contains the gate in y');
ok(VIEW_LOBBY.x <= GATE_MIN_X && GATE_MAX_X < VIEW_LOBBY.x + VIEW_LOBBY.w,
   'the lobby framing contains the gate in x');
ok(VIEW_LOBBY.x <= LOBBY_SPAWN_MIN_X && LOBBY_SPAWN_MAX_X < VIEW_LOBBY.x + VIEW_LOBBY.w &&
   VIEW_LOBBY.y <= LOBBY_SPAWN_Y && LOBBY_SPAWN_Y < VIEW_LOBBY.y + VIEW_LOBBY.h,
   'the lobby framing contains every seat spawn');

// The arena frame must contain the raider box and the boss's ink, or a player or a limb
// is drawn outside the picture with nothing to say so.
ok(VIEW_ARENA.y <= PIT_TOP && PIT_BOT < VIEW_ARENA.y + VIEW_ARENA.h,
   'the arena framing contains the raider box');
ok(VIEW_ARENA.y + VIEW_ARENA.h === PIT_BOT + 1,
   'the arena framing ends on the rim, where the boss clip ends');
ok(VIEW_ARENA.y <= BOSS_SPAWN[1] + BOSS_ANCHOR_Y,
   'the arena framing contains the top of the boss canvas');

// The boss is top-MIDDLE and stays there: the fit centres x on the rect's centre, so this
// is the assertion that the rect's centre is the boss's column.
ok(VIEW_ARENA.x + VIEW_ARENA.w / 2 === BOSS_SPAWN[0], 'the arena framing is centred on the boss');

// §4.2, as code: the fit only ever grows, never crops, and never letterboxes. Swept over
// the aspect range the twelve measured stage shapes span, and past both ends of it.
for (const a of [0.5, 0.978, 1.0, 1.276, 1.5625, 1.778, 2.241, 3.5]) {
  for (const V of [VIEW_ARENA, VIEW_LOBBY]) {
    const b = fit(V, a * 1000, 1000);
    ok(Math.abs(b.w / b.h - a) < 1e-9, `the viewBox matches the stage aspect at ${a}`);
    ok(b.x <= V.x && b.y <= V.y && b.x + b.w >= V.x + V.w && b.y + b.h >= V.y + V.h,
       `the visual rect survives the fit at ${a}`);
  }
}

// Non-uniform scale would skew every aim angle (§7.4). The fit produces one scale by
// construction; this is the assertion that keeps it that way.
const b = fit(VIEW_ARENA, 1600, 1032);
ok(Math.abs(1600 / b.w - 1032 / b.h) < 1e-9, 'the fit scales both axes equally');
```

---

## 10. What this does not touch

**Nothing on chain.** No instruction, no account layout, no new byte, no new notification, no
change to the crank period, the tick length, the delegation set or the transaction shape.
The CU cost of this document is **zero**, because it adds no on-chain work: it is a viewBox
attribute, a `<g>` transform and a layer split, all inside the browser.

The measured ER numbers the user asked to protect — write-to-visible p50 122 ms / p95 132 ms
at twenty seats, 14,703 samples per row — are properties of `move`/`shoot` and the Magic
Router, and no code path in §7 is on them.

Client invariants preserved, explicitly:

- The local seat still renders from `predictor.self`, chased in the rAF loop; remote seats
  still render from `useSeatInterpolation`. Untouched — 200 static frames → 52 stands.
- One writer per node transform. The fit hook writes `viewBox` on the `<svg>` and the
  transform on `#camera`, and it is the only writer of either. React writes neither.
- The blockhash cache, `MOVE_MS = 50`, `ticks_for()`, `layout.ts`'s mirror of the movement
  rule: all untouched.
- Generated files untouched. `V_LOBBY` and `V_ARENA` **derive from** `map.ts`'s generated
  constants; they do not restate them.
- `CAMERA_MS`/`CAMERA_EASE` keep their values. `Arena.tsx:286`'s claim — that this is the one
  duration allowed to be a local number because nothing on chain waits for it — still holds.

## 11. What I could not deliver, and the one number to re-measure

**Reference B's boss-to-frame ratio is not reachable from this framing.** In
`actual_boss_arena.png` the creature is ~285 px of 612, **47 %** of frame height. Ours is
592 units of 656, **90 %**. Closing that needs a frame ~1,300 units tall — taller than the
world and leaving the pit as a 17 % sliver — or a smaller boss. `BOSS_SCALE = 3` is a
**chain** fact: `programs/heartrot/src/hitboxes.rs` raycasts the scaled boxes and
`gen_hitboxes.py` emits both sides from one JSON. Changing it is a regenerate-and-redeploy,
and it moves every hitbox. Out of scope here; flagged so nobody re-litigates it against
the camera. Everything else in reference B — boss top-centre, concentric floor below, steps
at the bottom edge, cyan braziers along the walls, cold teal on dark blue-grey — is
composition and palette, and this framing supports all of it.

**The one thing I did not measure: fill rate.** The scene is rasterized into 1600 × 1032 =
1.65 Mpx instead of today's 1032² = 1.07 Mpx — **+55 %** — and `.stage::after`'s two
gradients cover the same 55 % more. The current budget is p50 9.38 ms / p95 14.92 ms at 20
knights under a 6× CPU throttle with the 32-bullet visible cap. I have no measurement of what
+55 % fill does to it, and I will not guess. **Re-run that exact benchmark after
implementation.** If p95 crosses 16.7 ms the lever is scene complexity — `Scene.tsx`'s 16
paths and 332 KB of path data, and the `.hr-boss-grade` filter — not the framing, because
shrinking the framing back is the defect this document exists to remove.

---

## 12. Deletion list

The point of the change. Everything here comes out of `app/src/render/Arena.tsx`:

```
241  LOBBY_ZOOM              250  LOBBY_FOCUS_MIN / _MAX
242  LOBBY_SPAN              252  LOBBY_X            259  LOBBY_Y
265  LOBBY_MARGIN            268  lobbyOriginFor()   275  nearLobbyEdge()
283  CAM_ARENA
404  crisp                   927  usePixelFit()      (and its ponytail dpr note)
     camOrigin ref, followX / followY, the `wide` phase test,
     the LOBBY_SPAWN_* / GATE_* imports that go unused with them,
     and 35 lines of self-check about a camera that no longer exists.
```

Net: one hook in, one hook out; a follow camera, a dead zone, a zoom level, a square-fit
sizer and their five derived constants gone; two module-scope scene groups where there was
one. The framing becomes two rectangles and one translate.
