# 17 — Full-screen rooms, arrows, and the archer: the one specification

**Status:** authoritative. Supersedes, for every point of disagreement, `12-fullscreen.md`,
`13-archer.md`, `14-shoot-feel.md`, `15-gate-transition.md`, `16-hud.md`,
`art/waiting-room.md`, `art/boss-arena.md`, `art/boss-light.md`, `art/legibility.md` and
`perf/er-baseline.md`. Those documents keep their evidence; this one keeps the decisions.
Where a number here contradicts one of them, this document is the one that ships.

**Written against** commit `6fc72d5`, program `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`
(115,440 B, `sha256 417bcec7…` = `target/deploy/heartrot.so`), `cargo test -p heartrot`
unit line **94 passed**.

---

## 0. What the user asked for, and the one rule that outranks everything

1. Kill the camera crop and the pan. Full screen, full room, sharper.
2. Fix the boss lighting.
3. Draw the player above the scene.
4. Make the space bar work.
5. Make shooting visible.
6. Add arrows and an archer.
7. Waiting area = reference A. Boss arena = reference B, reached through the gate with a
   transition.
8. Boss stays top-middle.
9. Telemetry translucent and draggable (low priority, their words).
10. **Do not degrade the MagicBlock ER speed.** Said twice.

Rule 10 overrules 1–9. Every decision below that could have gone on chain went off chain
unless the chain was the only correct owner. The total on-chain cost of this entire
specification is **one reinterpreted padding byte and roughly a dozen BPF instructions**
(§5). Everything else is 0 CU, 0 account bytes, 0 new notifications, 0 new accounts.

### 0.1 Three corrections to the brief, verified in source this session

**Correction A — root cause A is wrong, and an implementer sent to fix it would fix a
line that never runs.** The brief says `shoot.rs:374`'s cooldown refuses every waiting-area
shot. It does not:

- `app/src/input/controls.ts:310` gates fire on `phase === PHASE_FIGHTING` *before*
  building anything. In the waiting area **no transaction is built, signed or sent.**
  There is no refused shot because there is no shot.
- If one were sent, `shoot.rs:521` returns `WrongPhase` **before** `fire()` is called at
  `:534`. The cooldown at `:374` is unreachable outside `PHASE_FIGHTING`.
- There is no first-shot hole either: `MUSTER_TICKS = 200` elapse before `FIGHTING`, so the
  first shot of every fight passes `200 > 0 + 7`.

The spacebar is dead in the waiting area because **the client deliberately drops it**. The
fix is in the browser (§6), not in Rust.

**Correction B — a live bug the brief did not name.** `app/src/ui/Hud.tsx:96` hardcodes
`SHOT_COOLDOWN_TICKS = 1`. The chain value is `ticks_for(800) - 1 = 7`;
`controls.ts:129` derives 7 correctly. The SHOT READY pill therefore goes green **600 ms
early, in a live fight**, for 6 of every 8 ticks of a held trigger, while the client's own
(correct) gate refuses to send. That is the second half of "the space bar doesn't work",
and it is not a lobby-only problem. Third copy, second drift, of this project's named
recurring defect. Fixed in §6.2.

**Correction C — the ER number to defend is not 122/132 ms.** `docs/perf/twenty-lobby.jsonl`
was measured in `PS_MODE=lobby`, which the program now **refuses**: `start_match` calls
`begin_muster` → `guards::assert_any_raider` → `NoRaiders` over an empty pit. That p95 of
131 ms cannot be reproduced on any build. The number to defend is the **fight** number from
today's pooled baseline (§10.1). Anyone gating against 132 ms fails every build forever.

---

## 1. The viewport model — the active room, fitted; the camera is deleted

### 1.1 The single answer to "what is on screen"

**The active room, whole, always, filling the stage edge to edge.** Not the 64×64 grid, and
not a window that follows anybody. There are exactly two rooms and exactly one is on screen.

```ts
// app/src/render/sprites.ts — derived from the generated map, never restated.
// Both rects are 1024 × 656. That equality is load-bearing (§7.3).
export const VIEW_LOBBY  = { x: 0, y: 432, w: ARENA_UNITS, h: 656 } as const;
export const VIEW_ARENA  = { x: 0, y: -48, w: ARENA_UNITS, h: 656 } as const;
```

**Derivation, so nobody re-types a number the map already owns.**

- Lobby floor is tile rows 40..62 → world y 640..1007, **368 units** tall.
  Reference A (1122×785) puts the floor interior at y 250..690 with 250 px above and 95 px
  below → ratios 0.568 and 0.216. `0.568 × 368 = 209 → 208` (13 tiles) above,
  `0.216 × 368 = 79.5 → 80` (5 tiles) below. Top `640 − 208 = 432`; bottom
  `1008 + 80 = 1088`; height **656**.
- Arena bottom edge is `PIT_BOT + 1 = 608` — the rim where `#heartrot-boss-clip` already
  cuts the boss. Height 656 → top `608 − 656 = −48`. Boss crown is at world y 16
  (`BOSS_SCALE` 3, anchor −345/−405), so headroom is `16 − (−48) = 64` units = **9.76 %**
  of frame height, against reference B's 9.0 %.

### 1.2 The fit rule — aspect-matched viewBox, never bars, never crop

Computed from the live stage rect on every resize. One writer, the fit hook; React writes
neither the viewBox nor `#camera`'s transform.

```ts
const a = stage.width / stage.height;          // stage aspect
const vw = Math.max(V.w, V.h * a);             // exactly one of these grows
const vh = Math.max(V.h, V.w / a);
const vx = V.x + V.w / 2 - vw / 2;             // centred on V, UNCLAMPED
const vy = V.y + V.h / 2 - vh / 2;
svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
```

`<svg width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`.

Because the viewBox aspect always equals the stage aspect, `meet` never letterboxes; because
exactly one axis grows, `V` is always entirely inside the viewBox. **Never bars. Never
crop.** Room aspect is `1024 / 656 = 1.5610`: a stage wider than that grows the viewBox in
x, a stage narrower grows it in y.

Verified in a real browser at 12 stage sizes × 2 rooms = 24 cases: the SVG fills the stage
to within 0.5 px 24/24; `getScreenCTM()` uniform (`a === d`) 24/24; `V`'s corners inside the
stage 24/24. A containment sweep over aspect 0.001..3.500 step 0.001 for both rooms (7,000
checks) found **0 violations**. Worst surplus consumed: x ±223, y ±196 → **author 256 units
of bleed per side**, and make the first child of each room layer a `<rect>` sized to the
live viewBox inflated by 256 (§8, row 1). That rect is the only thing that ever paints
outside the room, and it paints void.

### 1.3 Scale, with the side panel deleted (§9.1)

Stage = `winW × (winH − 48)` (the header stays; the 320 px column goes). Arithmetic, not
measurement:

| window | stage | stage aspect | px/unit | knight (33 u) |
|---|---|---|---|---|
| 3440×1440 | 3440×1392 | 2.471 | 2.122 | 70.0 px |
| 1920×1080 | 1920×1032 | 1.861 | 1.573 | 51.9 px |
| 1440×900 | 1440×852 | 1.690 | 1.299 | 42.9 px |
| 1366×768 | 1366×720 | 1.897 | 1.098 | 36.2 px |
| 1024×768 | 1024×720 | 1.422 | 1.000 | 33.0 px |

Today's fight scale is 1.008 px/unit and a 33 px knight everywhere. **Deleting the panel is
what buys the floor of 1.000 px/unit** — with the 320 px column the worst case measured
0.6875 and a 22.7 px knight, which is a visible regression. Panel deletion is therefore not
cosmetic; it is load-bearing for legibility.

**Art constraint that falls out: no identity-carrying feature thinner than 2 units.** At the
1.000 px/unit floor a 1-unit rim is one device pixel and antialiases to nothing. This is the
same 2 units `art/legibility.md` derived independently for the knight halo.

### 1.4 Sharpness

`shape-rendering="geometricPrecision"` **unconditionally**. `usePixelFit` and the `crisp`
state are deleted, not fixed.

Integer device-pixel snapping was rejected with a number: over 12 window shapes × 2 rooms ×
dpr {1, 1.5, 2, 3} = 96 combinations with a 5 % extra-world budget, an integer scale is
available in **16 of 96**. 1920×1080 at dpr 2 snaps at 4.2 % waste; the same window at dpr 1
needs 56.2 %; 1600×900 needs ≥25 % at every dpr. `crispEdges` would be a window-size coin
flip that reframes mid-drag for one user in six and shimmers for the other five.

"Sharper and enhanced" is delivered as **bigger**: 1.008 → 1.573 px/unit on a 1080p screen,
the pit into 2.4× the pixels, the knight from 33 px to 51.9 px.

### 1.5 Everything that dies with the camera

Delete from `app/src/render/Arena.tsx`:

`LOBBY_ZOOM`, `LOBBY_SPAN`, `LOBBY_FOCUS_MIN`, `LOBBY_FOCUS_MAX`, `LOBBY_X`, `LOBBY_Y`,
`LOBBY_MARGIN`, `lobbyOriginFor()`, `nearLobbyEdge()`, `CAM_ARENA`, `camOrigin`,
`followX`/`followY`, `wide`, `usePixelFit()`, the `crisp` state, and the ~35 lines of
self-check at `:1017–1051` that assert properties of a camera that no longer exists
(replaced by §12.1).

Keep `CAMERA_MS = 900` and `CAMERA_EASE` — §7.3 reuses them for the gate move.

`#camera` **rests at identity in both rooms.** Nothing pans, ever. Its transform is written
in exactly one place, and only during the gate transition.

### 1.6 The shipped defect this deletes (arithmetic on `Arena.tsx:241–283`)

The initial lobby window is x 181..692 / y 512..1023. Seat 0 spawns at x = 208, which is 27
units inside the 96-unit dead zone — so `nearLobbyEdge` fires on the **first** `Players`
notification and `lobbyOriginFor(208, 832)` re-centres to x 0..511. The gate spans 480..543,
so 32 of its 64 columns go off screen. **The first player to join is shown a panning room
and half a doorway.** The existing self-check cannot catch it: it asserts the initial window
frames the gate, and that *some* window exists for any point, never that a player and the
gate are visible *at the same time*. Also: only 51.6 % of the lobby floor's width (512 of
992 units) is ever on screen today.

### 1.7 The room selector — one rule, and the shipped one is wrong

```ts
// store.ts:450 already has this. Reuse it; do not write a second rule.
mySeatSlot(state)?.zone === ZONE_ARENA ? 'arena' : 'lobby'
```

falling back to `phase` when there is no seat. `Arena.tsx:505`'s
`wide = phase === LOBBY || MUSTERING` is a **second, disagreeing rule**: `enter_gate` flips
one seat to `ZONE_ARENA` while the arena is still `MUSTERING`, so a player already through
the gate is currently shown the lobby framing. Delete `wide`.

The room actually on screen is owned by `Passage.tsx` (§7.3) as a `room` state, **not** read
directly from `slot.zone` — during the 460 ms cover the two disagree on purpose.

### 1.8 `aimOrigin` must be fixed in the same commit

`App.tsx:400` computes `box.width / ARENA_UNITS`, and its own comment says that is valid
only at camera scale 1 with the whole world on screen. Under §1.2 it is wrong on every
aspect. Replace with the CTM:

```ts
const g = host.querySelector<SVGGElement>('#camera');
const m = g?.getScreenCTM();
if (!m) return null;
const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
```

**This is not optional and cannot be deferred.** Shooting is fire-and-forget with
`skipPreflight`; a wrong aim produces no error anywhere, and the user is already reporting
that shooting does not work. Ship the arrows without this and every arrow aims at a point
hundreds of units from the pointer, indistinguishable from the bug being fixed.

Also delete `styles.css:273 .stage > svg` — a selector that matches nothing today (the SVG
is not a direct child of `.stage`). Two sources for one size is this repo's named defect.

---

## 2. The two rooms

Both are static, module-scope `ReactElement`s with **no props**, mounted exactly the way
`SCENE` is today. A `useMemo` with a dependency array or a props object silently
reintroduces the 11.2 ms/frame reconciliation `Scene.tsx` already measured and paid to
remove. Only one is mounted at a time (`{room === 'lobby' ? WAITING : SCENE}`).

### 2.1 Room A — the waiting area (reference A)

**Frame** `VIEW_LOBBY`. **Floor** reuses `Scene.tsx`'s already-imported `TEMPLE_PATHS` under
its existing `scale(1024/210, 1024/238)` transform, verbatim — its lower band is already
stone slabs with diamond medallions plus a bottom-centre stair whose rails measure at world
x 366..663, centred on 514, within 3 units of the gate centre 511.5. Zero new path bytes.

**Grade** (fitted by least squares over the 16 temple entries, weighted by their pixel share
of the lobby band only, against reference A's own 16-bin luminance ramp at gamma 1.15):

```
sepia(0.81) hue-rotate(232deg) saturate(1.58) brightness(0.45)
```

weighted RMSE 3.94/255 against `Scene.tsx`'s own 3.44 for the cold fit. **The deciding
measurement:** reference A's interior floor has R−B = −8.3 and G−B = −16.8. The stone is
violet-mauve; every warm value in that image belongs to a light source. The shipped cold
grade gives (31, 38, 48) with G above R; this one gives (37, 30, 42) with R above G.

**Walls** compile from `MAP_GRID` through `sprites.ts`'s existing `tilePath`. Reuse
`MAP_WALL_PATH` and `MAP_RIM_PATH`; add `MAP_FACE_PATH` (3-unit lit left/right edge — `RIM`
only lights walls with floor above, so the side borders get no highlight today) and
`MAP_FOOT_PATH` (4-unit cast shadow).

**The 26 pillar blocks get mass.** They are `#` tiles (rows 42/43, 46/47, 50/51, 54/55,
58/59 — every one exactly 2×2 tiles). `art/waiting-room.md` says to leave them unfilled
because cool `PAL.wall` on a warm floor reads as floating tiles. The correct fix is the
warm brick of the perimeter, not omission: a wall tile drawn as floor is exactly the lie
§3 forbids.

**Props are authored vector primitives.** `assets/sprites/room.svg` is **cut** (§11): its
props cannot be extracted — colour keying fails (`#a7939c` is both wall brick and the
chest's metal trim) and edge flood-fill leaves alcove 0/360 px, bone 2/192, crest 4/340,
torch 18/170, chest 69/483, door 307/676 usable. Its only usable form is opaque tile panels
at 4,849 B brotli, against 623 B brotli for 33 lines of authored generators. 7.8× cheaper,
no generator, no `.gen.ts`, no `--check` mode.

Author: portcullis + BOSS FIGHT sign + ram-skull crest above the gate block (x 480..543,
y 608..639, its tower painted upward into y 432..607); braziers flanking it; wall torches
around the perimeter; purple horned-skull banners; barrels, chest, candles, bones on the
floor.

**Torch-pool alpha — MEASURED AND CLOSED.** This section used to say "not specified, and
that is stated rather than guessed", because the first sweep failed (a `sed` mangled the
parameterised generator and returned three identical readings). It has since been swept
properly, over 323,063 legal stands. The constraint it had to satisfy, from the darkest
skin's contrast against a lit floor tile, is unchanged:

```
(0.1136 + 0.05) / (Y_floor + 0.05) ≥ 1.85   ⇒   Y_floor ≤ 0.0384 everywhere
```

| POOL_ALPHA | 0.045 | 0.060 | **0.070** | 0.090 | 0.130 | 0.180 | 0.220 |
|---|---|---|---|---|---|---|---|
| max floor Y | 0.0340 | 0.0366 | **0.0382** | 0.0425 | 0.0510 | 0.0630 | 0.0746 |
| Nocturne | 1.95:1 | 1.89:1 | **1.86:1** | 1.77:1 | 1.62:1 | 1.45:1 | 1.31:1 |

**The ceiling is 0.07. The shipped value is 0.045, and staying below the ceiling is a
result rather than an omission:** the ceiling buys +7 % of in-pool luminance (p95 0.0253 →
0.0272, invisible) for the whole of the margin, and reference A says the pools are not the
bright thing anyway — `waiting-room.md` §1 samples the pool at L 38.7 against an interior
median of L 41.1, marginally *darker* than the lit floor. The shipped render reproduces
that relation (in-pool p50 0.0131 against the room's 0.0126). Flooding the room to spend
the headroom would trade a measured pass for a measured fail.

Round 3's prototype pools measured Y 0.0617 — 1.6× over the cap, Nocturne 1.46:1, **worse
than the fight scene** after `Scene.tsx` already moved `PIT_POOL_ALPHA` down for this exact
reason. The "do not ship round 3's alpha" warning that stood here is discharged: the
shipped alpha is an order of magnitude below it, and `WaitingRoom.tsx`'s boot check is the
standing guard (conservative in the right direction — its design bound throws at 0.055
against a measured ceiling of 0.07, so it refuses values the room could survive and never
passes one it cannot). The full derivation, including the one thing that actually broke the
cap — a closed `rect` arch outline laying half a 3-unit stroke across the walkable gate
block, Nocturne 1.76:1 on the one tile every player holds still on — is in
`WaitingRoom.tsx`'s own header.

Reference A's bottom stairs are **cut**: tile row 63 is solid wall across its full width.
Drawing an opening there would need a map edit and a `gen_map.py` re-run, which rewrites the
bitboard the chain raycasts. Not an art change.

### 2.2 Room B — the boss arena (reference B)

**Frame** `VIEW_ARENA`. Boss stays at `BOSS_SPAWN` (512, 400), top centre, unmoved. Floor
stays `PIT_PATH`.

**Ring family**, orthographic — the floor plane *is* the coordinate space, so
`PlayerSlot.x/y` land in the SVG unmodified. A perspective floor would draw rings where the
chain's positions are not.

- centre `(ARENA_UNITS/2, (PIT_TOP + PIT_BOT + 1)/2)` = (512, 496)
- semi-axes `((PIT_X1 − PIT_X0)/2, (PIT_BOT + 1 − PIT_TOP)/2)` = (496, 112)
- rings at k = 0.22, 0.44, 0.65, 0.87, 1.00 (rx 109/218/322/432/496, ry 25/49/73/97/112),
  from the 0.21 ring spacing measured in reference B
- drawn inside one `<clipPath>` holding `PIT_PATH` itself, so the map's chamfer cuts the
  ellipse's corners for free. This matters: 13,991 units inside the k=1.0 ellipse are wall,
  and 25,366 walkable units (13.6 %) sit outside it — those are the apron, still floor,
  drawn flat and dark.
- the ring group carries its own `shape-rendering="geometricPrecision"` — belt and braces;
  §1.4 makes it the root default but `Spawn.tsx:202` already sets the same override and this
  fails silently if the root ever changes.

**Dais:** no raised platform. Ring k=0.22 filled one step lighter, pool centred on it.
**Medallions:** diamonds 26×12 at the cardinals of k=0.65 — N(512,423) S(512,569) W(190,496)
E(834,496); N sits inside the boss silhouette.
**Steps:** four 8-unit treads across the doorway, world x 480..543, y 576..607.
**Braziers:** twelve, mirrored about x = 512 — eight flames-only on the far rim at
`PIT_TOP − 4` (x = 512 ± 136, 282, 391, 478), two on the chamfer corners, two flanking the
doorway. **Flames only, no floor gradients** (§11: measured null).

**Light, solved rather than chosen.** Pit wash 0.45 → **0.70**, its region extended 22 units
above `PIT_TOP`; pool re-centred to (512, 452), semi-axes (520, 150), α 0.064; core spill
0.10 → 0.046; dais 0.046; ring highlight 0.074; medallion 0.060; mortar `#04070d` @0.60;
rim band and vignette unchanged.

That row of the budget is picked by two independent measurements agreeing. Contrast: at wash
0.70 with light gain 0.46 the worst standing spot gives Cobalt 3.59:1, Argent 3.29:1,
Nocturne 3.00:1, with **0.0 % of the pit under 3:1 for all three** (shipped: Nocturne 2.05:1
worst, under 3:1 on 41.9 % of the pit). Ring legibility picks the same row: at wash 0.70
mortar reads by 4.9–13.1 L8 against the floor beside it; at wash 0.88 three of the four
rings are inside 1 L8 — invisible.

**Two findings recorded, not fixed here.** (a) The creature's own graded body is the worst
background in the arena — Nocturne p5 1.77:1 over the 34.0 % of walkable units the boss
covers. No arena change reaches it. (b) `Arena.tsx`'s wall layer breaks the contrast cap on
its own: `PAL.rim #413a4f` is Y 0.0471 (2.5× the cap) and `MAP_ENTRANCE_PATH`'s `#b5b56a`
@0.18 lands a floor tile at Y 0.0365 — **on the four tiles where dead raiders respawn.**

**Reference B's boss-to-frame ratio is not reachable, and this is closed, not deferred.**
The creature is 47 % of frame height in the reference and 90 % here (592 of 656 units).
Closing it needs a ~1300-unit-tall frame — taller than the world, leaving the pit a 17 %
sliver — or a smaller boss, and `BOSS_SCALE = 3` is a chain fact `hitboxes.rs` raycasts and
`gen_hitboxes.py` emits both sides of. Do not re-litigate this against the camera.

### 2.3 Boss lighting (reference B's one bright thing)

Five edits in `app/src/render/Boss.tsx` plus one deletion in `styles.css`. No Rust.

**1. The grade** (`Boss.tsx:177`) — replace the multiply with a tone curve:

```
grayscale(0.7) sepia(0.6) hue-rotate(195deg) saturate(0.5) brightness(0.55)
contrast(1.6) drop-shadow(-3px -3px 0 rgb(159 232 255 / 0.30))
```

hue 185→195; saturate 1.6→0.5 (contrast amplifies chroma — 1.6 measures 52 % saturation
against the reference's 19 %; 0.5 lands on 19 %); brightness 0.32→0.55; `contrast(1.6)` new
and **after** brightness; drop-shadow stays last; rim 2 u/α0.25 → 3 u/α0.30. Lengths are
arena units because `.hr-boss-grade` carries no transform.

Fraction of the creature's own pixels clearing each WCAG step against its own background:

| | 1.5:1 | 2:1 | 3:1 | 3.5:1 | 4:1 | body L255 p50 / p90 / p99 |
|---|---|---|---|---|---|---|
| reference | 0.532 | 0.232 | 0.123 | 0.070 | 0.025 | 13.0 / 32.2 / 72.7 |
| **shipped** | 0.085 | 0.004 | 0.003 | 0.003 | 0.003 | 9.3 / 14.3 / 22.8 |
| proposed | 0.486 | 0.279 | 0.111 | 0.073 | 0.027 | 13.1 / 35.0 / 89.7 |

The median was already right. The tail was gone — `brightness(b)` is a straight multiply, so
the shipped grade compresses the ungraded art by the same ~0.13 factor at every percentile,
and the reference's 5.6× p50→p99 spread became 2.5×. That is what "the boss lighting
everything is wrong" is.

**2. The grade stays on the ancestor — and not for the performance reason.** The
rasterisation boundary costs +0.10 ms p50 / +0.10 ms p95 at 6× throttle against ±1.5 ms
run-to-run spread: inside noise, and per-part is not cheaper. It must stay on the ancestor
because **a WAAPI `filter` keyframe replaces a CSS `filter` on the same node** (proved:
mid-animation computed style reads `brightness(1.09999)`, the CSS filter gone). A per-part
grade would blink off on every flinch (180 ms), every break-off (520 ms), and permanently on
every dead limb.

**3. The core.** Keep the circle's geometry exactly — `cx={CORE.x} cy={CORE.y} r={CORE_R}`,
because an SVG stroke is centred on its path, so a thick ring's midline is still the circle
`hitboxes.rs` raycasts. Delete `strokeWidth={3}`; publish `style={{'--core-r': CORE_R}}` and
write the ring as `calc(var(--core-r) * 0.15)`. **Never type 60 anywhere.**

- sealed: fill `#04121a` α1, stroke `var(--cyan)` α0.75, `drop-shadow(0 0 16px rgb(111 227 255 / 0.35))`, opacity 1
- open: stroke `#eafeff` α1, `drop-shadow(0 0 26px var(--cyan)) drop-shadow(0 0 9px #eafeff)`, plus the existing pulse

The orb burns from frame one; the vent *state* is carried by white-hot plus pulse, not by an
opacity step. Measured: reference orb is a near-black well at r0–22 (darker than the wall
behind the creature) with the ring at r24–34 — outer radius 34 on a 289 px creature = 0.118×
width, against the shipped r60 on a 576 px creature = 0.104×. **The circle is already the
right size; only its paint is wrong.**

**4. Spill.** One `<radialGradient id="heartrot-boss-spill">` + one `<circle>`,
r = `CORE_R * 2.6`, stops `#9fe8ff` @0.20 → `#6fe3ff` @0.07 at 0.4 → 0 at 1. Inserted
**between** `.hr-boss-grade` and the vent, inside `.hr-boss-shell`: over the graded art so
it is light, under the vent so the ring sits on its own glow, never inside the grade (which
would tint light that is already the right colour). One static node.

Why it is needed at all: `Scene.tsx:247–275` defines `scene-core` and `:391` paints it
inside `SCENE`, which is drawn **under** the boss. The one light anchored to the creature
never touches it.

**5. Delete `styles.css:328–372`** (`#boss-breathe`, `.boss-part`, `.boss-eye`) and their two
entries at `:930–931`. Nothing renders them — every live class is `hr`-prefixed. In
particular `.boss-part { will-change: transform }` promotes a class that does not exist.
Note this in the commit message or a reviewer will read the deletion as a de-promotion.
Also re-derive or delete the stale arithmetic at `Boss.tsx:146–176`: its `brightness(2.2)`
flash ceiling of L 80.8 was computed for the old chain; under the new one a clipped fill
grades to ≈L255 74 against a resting body at 13 — a 5.7× lift where the old chain gave ≈2×.

**A structural limit, so nobody re-runs the search.** `parts/boss.svg` has 13 unique fills
across 74 paths, and 75.3 % of the creature's pixels sit on 8 discrete L255 values. A
23,760-point grid search over grayscale × sepia × hue-rotate × saturate × brightness ×
contrast tops out at 0.001 of pixels clearing 4:1 against the reference's 0.025, and cannot
reach it. **The missing light has to be added as a light, not squeezed out of thirteen flat
fills.** That is what item 4 is.

---

## 3. The guarantee: painted floor equals the wall bitboard

Two rules, in both rooms, no exceptions. `is_wall` reads the bitboard and nothing else, so a
painted pillar on a floor tile is a solid-looking thing bullets and bodies pass through, and
a painted floor on a wall tile is an invitation to walk into a wall — the two defects this
project misdiagnoses as lag.

**R1 — Mass only on `#`.** Anything drawn with volume, occlusion or a cast shadow must have
at least half its footprint on `#` tiles. Flat markings (ring lines, medallions, treads,
scorch, candles, bones, floor light) may sit anywhere; they read as paint, not as objects.
In room B this is why the rear wall, pillars, chains and demon statues of reference B stay
**backdrop above `PIT_TOP`**: tile rows 1..23 must stay floor or every shot fired up that
column dies on the raycast.

**R2 — Every walkable tile reads as floor.** No painted wall, prop or scenery may cover a
non-`#` tile inside the room's own zone. In room A the 26 pillar blocks are `#` and get
mass (§2.1); the central aisle (tile x 24..39, world x 384..639) is clear in every row and
is the composition.

**R3 — The room contract, which is what makes room A's gate tower legal.** `VIEW_LOBBY`
spans y 432..1088 and `VIEW_ARENA` spans −48..608; they overlap in world space, and room A's
gate tower is authored at y 432..607, which is really pit floor. That is only safe under one
rule, and it is a hard one:

> **A seat is drawn only in the room its own `zone` names, and the local seat's `zone` names
> the room on screen.**

Under R3 the painted stone above the lobby floor covers nothing that can be drawn, because
nobody in `ZONE_ARENA` is rendered on the lobby screen. **Break R3 and the lobby's fake wall
paints over the pit and over the allies standing in it.** During the 900 ms passage the
outgoing room must be unmounted before `#camera` reaches the incoming room's world space
(§7.3 orders this off `cover.finished`).

R3 has a deliberate behavioural consequence, stated so it is not reported as a bug: **during
a muster, a player in the pit no longer sees allies still in the lobby, and vice versa.**
They are in a different room behind a shut gate, and the HUD roster already reports the
count.

**R4 — Props are not solid.** Making a barrel block movement means marking its tiles `#` in
`assets/map/arena.json` and re-running `gen_map.py`, which rewrites the bitboard the chain
raycasts. That is a map change with `cargo test` behind it, not an art change. Not specified,
not built. `ponytail: a knight can clip the outer 16 units of a floor-standing barrel; the
upgrade is a map edit plus gen_map.py, not an art edit.`

**R5 — The 48-unit off-map bleed.** Room A paints masonry out to x −48..1072 so the map's
16-unit border reads as a wall with thickness. Off-map is solid by `isWallTile`'s own
contract, so no player can be there. Nothing enforces that decoration stays out of x 0..1023
— a future edit that lets it drift inside the border reintroduces exactly the defect R2
exists to prevent.

---

## 4. The archer decision: hitscan stays, arrows are drawn

### 4.1 The decision, plainly

**Player fire stays hitscan. Arrows are a client-side tracer. No projectile is ever
allocated on chain.** This is not a compromise made to save work — it is the faster build,
and the tracer is visually identical to the thing it replaces.

The alternative was measured, and it is affordable on every axis except the one the user
named twice:

| | on-chain arrows | hitscan + tracer |
|---|---|---|
| boss_tick CU at 20 players | 24,884 → **48,534** (12.1 % of 399,700) | **24,884** (unchanged) |
| live bullets, steady state | 23 + 5.7…31.4 = up to 54.4 of 128 | 23 of 128 |
| damage lands | **351 ms – 1.38 s** after the key | **129.8 ms** (today's p50) |
| arrow appears | after the round trip | **at key-press, 0 ms** |
| `shoot` becomes a real `Arena` writer | yes, permanently | no |

The CU is not the reason to say no; the pool is not the reason to say no. **Flight latency
is.** Hitscan resolves damage inside the send. A projectile adds 229 ms (aimed p50) to
1.26 s (worst miss) *on top of* write-to-visible, which is a self-inflicted regression on
exactly the axis rule 10 protects, and it reverses `09-shooting.md` §3's deliberate
asymmetry: player fire instant, boss fire dodgeable.

Marginal cost measured with mollusk-svm 0.15.1 against the real tree ELF, pinning live
bullets at N before every `boss_tick`, 120 chained ticks per row, 20 seats: N=0 → 4,560 CU
p50; 8 → 10,277; 23 → 20,982; 32 → 27,478; 64 → 50,470; 128 → 96,491. Dead linear at
**718 CU per live projectile per tick**. Within-case spread on identical runs 77–288 CU,
which is the instrument's resolution.

One more reason, recorded because it will bite someone later: `tick.rs:284` asserts
`volleys_in_flight * (BASE_VOLLEY_BULLETS + MAX_SEATS) <= MAX_BULLETS`, and `spawn_volley`
**silently drops** a spawn when the pool is full. Twenty archers sharing that pool would
starve boss volleys, and that reads as a chain bug.

### 4.2 What the tracer is

- **Terminus** from a bit-exact TypeScript mirror of `shoot.rs::raycast`, over the generated
  `WALLS` and `PART_HITBOXES` tables `packages/client` already imports for exactly this and
  has never used. Measured 408 ns/call, mean 3.70 steps, over 929,280 calls — 0.0024 % of a
  p50 9.38 ms frame.
- **Speed** `ARROW_UNITS_PER_SEC = 2200`, derived as median boss range 280 u ÷ p50
  write-to-visible 0.1298 s = 2157, rounded up to 2200 so the arrow lands **just before**
  the truth rather than after it. Max terminus over all 726 pit stands × 64 angles is 640 u
  → max flight **291 ms**.
- **Pool** = `MAX_SEATS` nodes indexed by seat. No pool management at all, because
  `291 ms flight + 400 ms stick-fade = 691 ms < 800 ms` knight cooldown (and far under the
  archer's 1400 ms). **Assert that inequality in dev** — lowering the speed or the cooldown
  breaks it silently and the symptom is a seat's arrow teleporting mid-flight.
- **Colour** warm amber/white shaft. Reference B is a cold cyan room; a cyan tracer vanishes
  into the braziers and into the boss's own ordnance. Separated from boss bullets by **speed
  (5.24×) and hue**, and — because measurement says colour cannot carry it — by **shape**:
  every arrow colour that clears 4.5:1 against the floor is within 1.51–1.68:1 of
  `PAL.bullet #ffb020`. Arrow = thin shaft ≥12 u long, ≤2 u thick, distinct head. Boss
  bullet = ≈8 u round capsule.
- **Archer arc**: perpendicular sag, amplitude range/10, `sin(πt)`, zero at both ends.
  Client-only, decorative, never affects the terminus.
- Arrows share `Arena.tsx`'s existing 32-visible-projectile cap, **boss bullets ranked
  first** — the cap's measured win (−2.08 ms p50, −2.04 ms p95, over-budget 7.2 % → 4.6 %)
  is spent if arrows are drawn outside it.

**The tracer is a third copy of the raycast algorithm.** The *data* is safe (both sides read
the same generated tables) but the 20-line loop is not. Mitigate the way `layout.ts` already
mitigates `player.rs`'s movement rule: a header comment naming `shoot.rs::raycast` as the
authority, plus three **behavioural** dev assertions — a pit-centre shot terminates inside
`SHELL_AABB`; a shot into a searched-for wall terminates on that tile; a 0-HP part is
transparent. Never a table of coordinates: the map is generator output, and a test naming a
tile stops testing the ray.

---

## 5. The class byte — `PlayerSlot._pad0`, and the migration that does not exist

### 5.1 The field

`state.rs:859` has `pub _pad0: u8` at **offset 3**, between `skin_id` (offset 2, asserted at
`:911`) and `x` (offset 4). It becomes:

```rust
/// bit 7      class      0 = knight, 1 = archer
/// bits 6..4  aim sector 45° each
/// bits 3..0  aim ratio  min/max, tangent-linear, 0..15
pub class_aim: u8,
```

**The migration story is that there is none, and that is the point.** `size_of::<PlayerSlot>()`
stays 96, `size_of::<Players>()` stays 1924, `size_of::<Arena>()` stays 1200,
`LAYOUT_VERSION` stays 1, rent delta 0 lamports, no realloc of a delegated account, no
decoder in `packages/client` / `app` / `worker` changes shape. Every seat live on devnet
carries **0** in that byte today, so **class 0 must be the knight** — the existing default —
and the aim field is only read when `last_shot_tick != 0`, because before the first shot
there is no arrow to draw.

### 5.2 The class table

Two entries. Both **50 DPS by construction**, so the boss needs no rescaling.

| class | id | damage | period | cooldown ticks | shots/s |
|---|---|---|---|---|---|
| knight | 0 | 40 | 800 ms | `ticks_for(800) - 1` = 7 | 1.25 |
| archer | 1 | 70 | 1400 ms | `ticks_for(1400) - 1` = 13 | 0.71 |

`40 × 14 == 70 × 8`. The archer is **slower and heavier, not faster** — the notification
budget is the constraint, and a faster class multiplies `Boss`-writing transactions. Both
durations go through `state::ticks_for()`; no tick count is ever typed. `SHOT_DAMAGE` stops
being a bare const and becomes `CLASS_DAMAGE[class]`; `SHOT_COOLDOWN_TICKS` becomes
`CLASS_COOLDOWN[class]`.

**No per-class range.** Proved useless: `SHELL_AABB` is 681×696 units, all 214 pit floor
stands reach the shell, and aimed steps-to-end is p50 6 / p95 11 / **max 13** against
`MAX_RAY_STEPS = 64`. A range knob would have to cut below 13 to do anything, which makes
the class unplayable rather than different.

### 5.3 The aim encoding — no trig on chain

```rust
// encode, in fire(), on the line that already writes slot.facing
let sector = ((dx < 0) as u8) << 2 | ((dy < 0) as u8) << 1 | ((dy.abs() > dx.abs()) as u8);
let (min, max) = (dx.abs().min(dy.abs()), dx.abs().max(dy.abs()));
let t = if max == 0 { 0 } else { (min as u32 * 15 + max as u32 / 2) / max as u32 } as u8;
slot.class_aim = (slot.class_aim & CLASS_MASK) | (sector << 4) | t;   // CLASS_MASK = 0b1000_0000
```

Decoded client-side by inverting it exactly.

**`& CLASS_MASK` is the single point of silent failure in this whole feature.** Drop it and
a player changes class on their first shot, with no error anywhere. It gets its own test:
fire an archer 20 times, assert `class_aim >> 7 == 1`.

Error, swept over all 65,535 legal wire aims × a core-aimed and a 90°-off ray from each of
214 stands: **1 class bit + 7 aim bits → worst 1.90°, aimed endpoint offset p50/p95/max
2/13/28 units.** That p95 of 13 units is under one tile (16) and under
`PLAYER_HIT_RADIUS = 12`. A second class bit costs 4.05° and a 62-unit p95 miss, so **two
classes is the budget, not a preference.** 1,120 of 65,535 aims (1.71 %) reconstruct into
the neighbouring octant — harmless, because `facing` is its own field and is never derived
from this byte. All 8 codes that do not re-encode to themselves were checked to decode to
the same ray as the code they re-encode to.

Compare the alternative that needs no chain change: `facing` is 8-way, so an arrow drawn
from it is up to **22.5° off** — 116 units lateral at the median 280 u range — and it
**snaps direction mid-flight** the moment its shooter takes a step, because `move` rewrites
`facing` every 50 ms. Nineteen of every twenty arrows on screen are remote. That is the
whole reason the byte is worth spending.

### 5.4 Choosing a class at join

`class` travels the road `skin_id` already travels: `JOIN_DATA_LEN` **66 → 67**, with
`class` **appended at `data[66]`**, so no existing offset moves and both 32-byte slices are
untouched (`player.rs:134`, `instruction.rs:183`, `instructions.ts:447`). Validate
`class >= N_CLASSES → InvalidInstructionData` at **both** the Worker and the program.
**Never clamp** — a clamp turns a version skew into a silently wrong class.

`worker/src/routes.ts:75 SKIN_COUNT = 3` gets a sibling `CLASS_COUNT = 2` and a range check
next to the existing one at `:534`. Miss it and the Worker rejects the seat claim with a
server-side error on a client-side-looking feature.

`JOIN_DATA_LEN` 66 → 67 means **the program and the app ship together**. That is deliberate
— an old client gets a clean `InvalidInstructionData` rather than a misread byte — but it
makes the chain change one indivisible deploy. §12 orders it last for that reason.

### 5.5 The seam, so the client work is not blocked on the deploy

```ts
/** Aim unit vector for drawing this seat's arrow. shoot.rs::fire is the authority. */
function aimOf(slot: PlayerSlot): readonly [number, number] {
  return slot.lastShotTick === 0 ? FACING_UNIT[slot.facing] : decodeAim(slot.classAim);
}
```

Before the program ships, `decodeAim` is `FACING_UNIT[slot.facing]` and everything else in
§4 and §6 works. After it ships, one three-line function changes. Nothing is written twice
and nothing is thrown away.

### 5.6 What must NOT be built

- **A new arrow array on `Arena`.** 128 × 8 B takes `Arena` 1,200 → 2,224 B: the account is
  delegated, the ER tops up at 6,960 lamports/byte, `LAYOUT_VERSION` moves, every decoder
  in three packages moves, and it is a realloc on a live delegated account. The +13.7 KB/s
  per subscriber is the cheapest part of that bill.
- **A `gate_entered_at_tick` field**, or any animation clock, phase, frame index or
  "is playing" flag. `07-animation.md` §6.2 prohibits them by name, there is no free byte
  left after §5.1, and the zone flip already says the passage happened while the same
  payload says where you landed. **One fact stored twice** is this project's named defect.
- **`Bullet._pad0` as an arrow owner tag.** It stays unused, because §4.1 allocates no
  bullet.

---

## 6. The shoot contract

### 6.1 One predicate, and what happens on each side of it

```ts
const canSend =
  phase === PHASE_FIGHTING &&
  zone  === ZONE_ARENA &&          // NEW — see 6.3
  alive &&
  shotAllowed(tick, lastShotTick, cls);
```

- `canSend` **true** → send `shoot(dx, dy)` **and** draw the arrow immediately from the exact
  `(dx, dy)`. The local seat ignores its own confirmation — the existing one-writer rule
  (`predictor.self` vs interpolation) applied to arrows.
- `canSend` **false** → draw a **practice arrow** locally, send nothing, show no damage. The
  practice arrow is gated by a wall-clock timer of the class period (800/1400 ms), because
  `arena.tick` is 0 and frozen in the waiting area, and that timer is what keeps the
  one-node-per-seat proof in §4.2 true.

That single rule closes **all three** dead-trigger windows, not the one the brief named:

1. **The waiting area** (`ZONE_LOBBY`, `PHASE_LOBBY`) — the key now does something.
2. **The 20-second muster** (`ZONE_ARENA`, `PHASE_MUSTERING`) — the worst of the three, and
   unnamed until this session: the player is in the pit with the boss filling the top of the
   frame, trigger dead, and the pill reads SHOT COOLING.
3. **Seated but never through the gate during `FIGHTING`** — `controls.ts` mirrors phase,
   alive and cooldown but **not** `shoot.rs:369`'s zone gate, so such a seat sends a doomed
   `Custom(9)` every 800 ms for the whole match. Adding `zone === ZONE_ARENA` to the
   predicate stops it.

Relaxing `shoot.rs`'s `PHASE_FIGHTING` guard was **rejected**: it would spend three write
locks and a full transaction to change no state, at up to 25/s.

**Say why there is no damage.** The dishonesty is ambiguity, not silence: a practice arrow
answers "is the key bound", and one line of HUD copy — `WEAPONS DOWN · muster 0:14` in the
muster, `PRACTICE — no target beyond the gate` in the waiting area — answers "why no
damage". Both are one string in the existing pill.

### 6.2 Fix the three copies of the cooldown before anything else

`export` `controls.ts:217 shotAllowed` and **delete `Hud.tsx:96`**. Seven characters plus a
deletion. `controls.ts`'s existing dev self-check
(`(SHOT_COOLDOWN_TICKS + 1) * TICK_MS === 800`) then covers the HUD too, and gains a sibling
for the archer's 1400 ms.

**This is a prerequisite, not a side-quest.** A muzzle flash fires on client-accepted
triggers; while the pill and the gate disagree by 600 ms the flash would fire on shots the
chain never sees, and a muzzle flash that lies is worse than no muzzle flash. Also fix the
stale `Hud.tsx:379` copy, "one shot per two" — it is one per eight.

### 6.3 Feedback, and who owns each piece

**Governing rule: prediction owns no number.** Under it, a wrong prediction costs one
misplaced spark for one frame and no number is ever retracted — so there is no rollback path
to write, which is the entire reason this rule exists.

| effect | owner | when |
|---|---|---|
| muzzle flash + recoil | predicted | 0 ms, WAAPI on the existing knight `<g>` — no new art; the five shipped poses have no firing pose and do not need one |
| arrow flight | predicted (local) / chain (remote) | 0 ms / on `lastShotTick` rising edge |
| thunk spark, stick, part flash | predicted | on arrival |
| **damage number** | **chain only** | `slot.damageDealt` delta |
| cooldown ring | hybrid | smooth fill on the local clock, ready-flip on the same `shotAllowed` predicate the pump uses, **held at 99 %** rather than ever flipping early |
| remote arrows | chain only | `lastShotTick` value diff |

**The hit feed needs no new chain state.** Everything is already decoded and delivered:
`layout.ts` `PLAYER_SLOT` offsets `last_shot_tick = 20`, `damage_dealt = 28`, `facing = 1`;
and `subscribe.ts:123` **already** passes `onPlayers(players, previous)`. `damageDealt`
advancing with `lastShotTick` = a landed shot for that amount; `lastShotTick` alone = a miss
or an absorbed shot.

Both known delivery properties are already handled by the existing mechanism: the spawn
trigger is `Knight.tsx:292`'s `slot.lastShotTick > st.lastShotTick` fold, which is a **value
diff**, so the Magic Router's double delivery is idempotent and the 68.4 % of notifications
carrying no position change are irrelevant to it. No new bookkeeping.

`dealt` is capped at the part's remaining HP (`shoot.rs:389`), so a finishing blow
legitimately shows less than 40. **Display it as-is; never round it up to the class damage.**

### 6.4 Aiming

Run the same 408 ns raycast every frame and draw **the answer, not the ray**: a reticle whose
shape names what is there — open ring (nothing / wall), hot filled (a live part or an open
core), crossed (sealed vent). Keyboard fire keeps 8-way facing. **Do not snap to the core**;
that is an aimbot.

The part **name and HP bracket is cut** (§11) — the HUD parts cluster already carries both,
and a text label that tracks the pointer at 60 Hz is a per-frame DOM write in the layer the
frame budget is tightest in.

### 6.5 The cooldown does not move in this change

The complaint is "I cannot see anything", not "not often enough", and **`shoot`
write-to-visible has never been measured at any seat count** — the 129.8 ms baseline is a
`move` measurement over a read-only `Arena`. `shoot` names `Arena` + `Boss` + `Players` all
writable and can never be as parallel as `move`, because `Boss` must stay writable.
Arithmetic, labelled as arithmetic: 20 seats at 800 ms = 25 shots/s = 1.25 `Boss`-writing
transactions per 50 ms ER slot; at 400 ms it is 2.5; at 250 ms it is 4.0. Fix the feedback,
take the measurement §10.3 makes nearly free, then decide.

---

## 7. The phase machine and the gate transition

### 7.1 The phase machine, as it is (read from `player.rs:488`, not assumed)

`assert_playable` admits exactly `LOBBY`, `MUSTERING`, `FIGHTING`. That makes the two-form
selection in §7.3 exhaustive, not a default plus a special case.

| `Arena.phase` | local `zone` | room on screen | trigger |
|---|---|---|---|
| LOBBY | LOBBY | A | practice arrow |
| MUSTERING | LOBBY | A | practice arrow |
| MUSTERING | ARENA | B | practice arrow, pill reads `WEAPONS DOWN` |
| FIGHTING | LOBBY | A | practice arrow (a seat that never crossed) |
| FIGHTING | ARENA | B | **live**, `shoot` sent |
| SETTLING | either | last room | practice arrow, verdict cluster up |

### 7.2 Edge triggers, duplicate-proof

Every cinematic in this codebase fires on a **value diff**, never on a flag:

```ts
const passageFires = (prev, next) => prev !== null && prev !== next && next === ZONE_ARENA;
```

Same shape as the existing `spawnFires`. Idempotent under the Magic Router's double
delivery; `prev !== null` kills the mid-fight join; `next === ZONE_ARENA` keeps the
incarnation reset (ARENA → LOBBY) silent.

**The resync gate.** Add **one** store field, `feedEpoch`, bumped in `App.tsx`'s existing
`onHealth` when health leaves `'live'`. Consumers reset their diff baseline on an epoch
change. **Do not read `state.status`** — `store.ts:415` forces it to `'live'` on every
payload, so the gate would race the thing it gates. `Spawn.tsx` has this bug **today**
(it replays its cinematic after every 1,681 ms reconnect); the same three lines fix both,
and the acceptance test must run against **both** readers.

### 7.3 The passage — `app/src/render/Passage.tsx`

**What it is covering, measured.** `enter_gate` does not walk you through the gate; it calls
`tick::entrance_for(seat)` and assigns x/y. All four `E` marks sit at y = 512, whose distance
to the nearer y edge is 512 (the maximum), so every seat fans along y. Worst case is seat 3
at (864, 464): **387.2 units = 24.2 tiles sideways, in zero frames** — 1,209 ms of walking
delivered instantly. Best is seat 17 at 171.0 units. Both renderers already snap rather than
chase (`SELF_SNAP = 64`, and `predict.ts:391 teleported()` returns true on a zone change
outright), so **remote seats need no code at all**. Only the local view spans both rooms.

**The ordering problem, and why the beat holds instead of starting early.** The payload that
flips `zone` is the same payload that carries the new x/y, so a beat started on that payload
is already too late — the knight snapped before frame 1 of the veil drew. Starting early on
local prediction was rejected: the lead time is round trip p50 129.8 ms **plus up to
`GATE_RETRY_MS = 500` of poll**, wildly variable, and `enter_gate` is sent `skipPreflight`,
so a refused send returns a signature — the portcullis would rise and nothing would happen.

**The beat.** Long form 1100 ms (`COVER_MS` 460) during LOBBY/MUSTERING; short form 320 ms
(`COVER_LIVE_MS` 140) during FIGHTING, because the short form is the only one that can
coexist with a live volley.

| t (long) | what |
|---|---|
| 0–180 | portcullis lifts 32 units — `GATE_MAX_Y − GATE_MIN_Y + 1`, derived |
| 0–230 | gradient veil fades in, centred on the gate block centre (512, 624) |
| 115–460 | flat veil completes occlusion |
| **460** | `cover.finished` → **room A unmounts, room B mounts, viewBox := VIEW_ARENA, `#camera` := `translate(0, -480)`, hold clears** |
| 460–780 | gradient veil opens from the throat mouth (512, `PIT_BOT` = 607) |
| 460–1100 | `#camera` animates `translate(0px, -480px)` → identity, `CAMERA_MS`/`CAMERA_EASE` |
| 460–1100 | teal wash `#183a44` (sampled from reference B) fades 0.5 → 0 |

**The viewBox is never animated** (9.6 ms vs 1.7 ms, the file's own measurement stands). The
camera move is a pure composited translate over the `.hr-boss-grade` filter, with
**s = `next.w / prev.w` = 1.0000 on all twelve measured stage shapes** — which is the entire
payoff of making both rooms 1024×656. 480 units = 30 tiles, straight up through the gate.
The boss never moves.

**The hold** is one boolean read by the existing rAF loop. While set, the local-seat block
sets `drawn.current = null` and writes no transform, so the knight holds its last drawn
position under the opaque veil and is **placed** at the door on release, never chased.

**Three independent releases**, because a leaked hold freezes a knight for the whole match:
(1) `cover.finished`; (2) an unconditional clear in the effect cleanup, covering unmount,
incarnation reset, settle mid-passage, and the cancel path where `.finished` rejects; (3) a
**1000 ms wall-clock ceiling** in the frame loop, which already has `performance.now()`.
2.2× the longest legitimate cover, so it never fires on a healthy path and always fires on a
broken one — including a player who tabs out mid-passage, since WAAPI pauses on a hidden
document.

**Skip** = `finish()` on every live animation, exactly `Spawn.tsx`'s model: the end state is
"gone", so finishing early *is* skipping, and because the swap hangs off `cover.finished` a
skipper still lands correctly. **Reduced motion** = a 150 ms opacity cross-fade of the flat
veil and nothing else; the hold survives (a hold is not motion).

**Input is never blocked.** Keys bind to `window`, every beat node is
`pointer-events: none`, nothing calls `preventDefault`, no send awaits the beat, and
`screenOf` still swaps on the payload. Only the picture lags 460 ms (140 ms live). The HUD
therefore reads `arena` while room A is still on screen — deliberate, because delaying
`screenOf` would put a cinematic inside the router, which `Gate.tsx`'s module header forbids
in terms. Someone will report it; it is not a bug.

**Two writers on the portcullis is the silent failure here.** `Passage.tsx` plays a WAAPI
one-shot on `#gate-portcullis` / `#gate-sign`, which are room A's nodes. If room A ever gains
an idle sway on the same node, that is `07-animation.md` §3.1's failure. The dev assertion
in §12.1 catches it.

**The renderer survives the swap and must keep surviving it.** `App.tsx:153` puts
`<div id="stage">` in its own child slot and `<World>` at `:159` is a **sibling** of the
screen switch, portalling in. So `render/Arena`, its rAF loop, its predictor and its
subscription do **not** unmount at the passage. Remounting that node costs 46.3 ms of SCENE
rebuild. Any restructure of `<main>`'s children must preserve the stage node's position
among its siblings.

---

## 8. The layer order — one list, background to HUD

Inside `<svg>`, in this order. Rows 1–16 are children of `#camera`.

| # | layer | notes |
|---|---|---|
| 0 | `<defs>` | knight poses, boss parts, clips, gradients. Never painted. |
| 1 | **void rect** | sized to the live viewBox inflated by 256 per side, written by the fit hook. First child of the room layer. Also the geometry the passage's flat veil reuses. |
| 2 | room floor | `TEMPLE_PATHS` (A) / `PIT_PATH` (B), graded |
| 3 | floor markings | ring family + medallions + treads (B); medallions + stair (A). Clipped to the floor path. **No mass** (R1). |
| 4 | floor light | pit wash, pool, torch pools. Never above an actor. |
| 5 | wall mass | `MAP_WALL_PATH` + `MAP_RIM_PATH` + `MAP_FACE_PATH` + `MAP_FOOT_PATH`, compiled from `MAP_GRID`. Room A's 26 pillars live here. |
| 6 | **props, one layer** | wall-mounted *and* floor-standing together — portcullis, sign, crest, braziers, torches, banners, barrels, chest, candles, bones. Contact shadow is their only depth cue. **Actors are never occluded by decoration.** |
| 7 | boss | inside `.hr-boss-grade`, clipped at `PIT_BOT + 1` |
| 8 | boss spill | radial gradient, over the graded body, under the vent (§2.3 item 4) |
| 9 | boss vent | the circle the chain raycasts. Never moved, never offset. |
| 10 | boss telegraphs | over the boss, **under** the knights |
| 11 | boss bullets | existing 32-visible cap |
| 12 | **knights** | sorted by authoritative `y`, local seat included in the sort. Halo is the first child of each body `<g>`. The **local marker** (ground ring + chevron) rides inside the local seat's own `<g>` — it needs no layer of its own. |
| 13 | **player arrows** | **above** the knights. An arrow drawn under twenty bodies is the "I cannot see anything" report. |
| 14 | pit-rim occluder | the one earned exception, and bounded: clipped to world y 576..607, two tile rows, so it covers at most the lower ~10 units of a knight on the last walkable row and nothing at all in room A. |
| 15 | spawn flare | `Spawn.tsx`, unchanged |
| 16 | passage veils + teal wash | mounted **after** `Spawn` so the veil covers the flare when both fire |

Above the SVG, in DOM order:

| # | layer |
|---|---|
| 17 | `.stage::after` — **radial vignette only**; the linear gradient is deleted (§11) |
| 18 | HUD clusters (§9.2) |
| 19 | telemetry panel — translucent, draggable, top of everything |

### 8.1 Player legibility — why row 12 is not enough on its own

**Aggregate 4.5:1 body-vs-floor is unreachable and is the wrong target.** Solving for it
needs body Y = 0.2791 against room A's median floor (2.46× Nocturne) and 0.5200 against room
B's p95 lit ring stone (4.58× Nocturne) — that is re-tracing the sheet. And it measures the
wrong quantity: p5 and p25 of all three skins sit at Y = 0.0076, the keyline colour. **Over
60 % of every knight is deliberately dark.**

**The real defect is the boundary.** The shipped key light is `sil` offset one unit up-left
only, covering 11.5–15.8 % of the body. On the **down-right** side the outermost pixels are
the sprite's own keyline at Y = 0.0076, which is **1.28:1** against room A's median floor and
**1.06:1** against room B's p95. Half of every knight has no boundary contrast at all today.

The fix, all of it derived rather than chosen:

1. `tools/gen_knights.py` emits two new derived groups per skin — `k{s}-halo` (the `sil`
   union dilated **2 px**, minus the union) and `k{s}-halo-fallen` (same on the transposed
   `fallen` mask), both `fill="currentColor"`, same run-length subpath form. **Derived from
   art already checked in.** Re-run the tool; never hand-edit `knights.gen.ts`.
2. `Knight.tsx` replaces the offset key-light `<use>` with one un-offset
   `<use href="#k{s}-halo">` as first child of the body `<g>` — one `<use>` for one `<use>`,
   node count unchanged, and the corpse gains an outline it does not have today. Delete
   `keyDx` and its "stays up-left through a flip" self-check: a symmetric halo has no side.
3. Rim luminance from `4.5 × (0.0767 + 0.05) − 0.05 = 0.5202`, hue and saturation held:
   Cobalt `#a8c1e0` (Y 0.5185), Nocturne `#dcb7aa` (0.5198), Argent `#bebec9` (0.5199).
   Worst case over all ten floor percentiles of both rooms: **4.49 / 4.50 / 4.50**. Against
   floor already carrying the seat's own contact shadow (`#0f0d12` @0.45, already drawn) it
   is 7.02–7.04:1 — **the contact shadow is load-bearing, not decoration.**
4. **2 units, not 1**, and that is a device-pixel argument: at §1.3's 1.000 px/unit floor a
   1-unit rim is one device pixel.
5. Local marker: two ellipses at `FEET_Y = 20`, rx 18 ry 7 — under-ring `#05060a` width 5
   opacity 0.75, then ring `#eafff4` width 3 opacity 0.9. Chevron `M-8,-36 L8,-36 L0,-24 Z`,
   fill `#eafff4`, stroke `#05060a` width 2, `paint-order: stroke`. Plus a redundant ring
   breathe (0.55↔0.95, 1400 ms, cancelled under reduced motion).
   **Shape + luminance + position, never hue:** under protan/deutan/tritan the three skin
   rims collapse to 1.02–1.03:1. **Skin is flavour and carries no information.** The chevron
   needs its `#05060a` keyline precisely because `#eafff4` is only 1.76:1 against a lifted
   ally rim.

---

## 9. HUD, and the telemetry panel

### 9.1 Delete the 320 px panel; keep the 48 px header

The panel dies because §1.3 shows it costs the worst-case scale 0.6875 → 1.000 px/unit and
the knight 22.7 → 33.0 px, and because the user asked for full screen twice. **The header
stays** — the wordmark is a branding decision the user has not made, its 48 px costs 4.4 %
of a 1080p stage, and keeping it is the smaller diff.

Everything the panel held moves to edge-anchored `position: fixed` clusters. **No gutter
detection, no ResizeObserver, no breakpoint** — the scene now fills the stage, so there are
no letterbox gutters to aim at and translucency is what makes overlay legible.

### 9.2 Eight clusters

TL phase/tick/socket · TC boss bar or muster clock · ML verdict · MR telemetry ·
BL you (`SelfPanel`) · BC one line of instruction · BR parts.

**`SelfPanel` — the health meter and both cadence pills — is currently mounted only from
`ArenaScreen`. `Lobby.tsx` renders a different panel entirely, so there is no shot indicator
anywhere in the waiting area, which is the only screen the dead spacebar lived on.** Mounting
it in the lobby is the whole visibility fix, and it is one line.

Facts the HUD mirrors, and the one place each lives: `shotAllowed` imported from
`controls.ts` (§6.2, never re-derived); the vent threshold
`sum(parts) * 100 < sum(parts_max) * 35` in the program's integer arithmetic, with
`Hud.tsx::shellPercent` and its self-check moving unchanged; `PART_NAMES`'s import-time
length throw and the `MUZZLES[i].part === i` check moving unchanged; and **`tick` as the only
clock** — no local `setInterval` countdown anywhere, the muster clock stays a projection of
`fight_at_tick − tick`.

### 9.3 The telemetry panel

All 21 rows and 5 groups survive verbatim, **one column at 268 px**. Two content changes:
`refused` moves to the top of Throughput and its note gains "moves only — a refused shot is
not counted here"; `--dim` becomes `--muted` on `.dev-group h3`, `.dev-unit`, `.dev-note`,
`.dev-foot`.

**Background alpha 0.88 is a measured floor, not taste.** Worst realistic backdrop is the
boss's cyan orb `rgb(161, 252, 243)`, the max-luminance feature of reference B. At α 0.88:
`--muted` 4.54 (pass), `--ink` 10.04, `--ok` 5.85, `--torch` 5.95, `--ember` 4.07
(AA-large only — it must not migrate onto small text). At α 0.86 `--muted` drops to 4.27 and
fails. `--dim` measures 3.45 and **cannot survive translucency at any alpha a user would
call transparent**, which is why it is retired inside `.dev`. No `backdrop-filter`.

**Drag:** `.dev-head` is the grip — `touch-action: none`, `setPointerCapture` on
`pointerdown`, `translate3d` written per `pointermove`, release plus one `localStorage` write
on `pointerup`. **Zero document/window listeners.** Measured: with capture 10/10 moves reach
the handle, without capture 0/10 (the panel freezes after one pixel); during a captured drag
`#stage` receives **zero** pointer events. `transform` costs 1 forced layout per 300 writes;
`left`/`top` costs 299.

Store the **offset**, not `left`/`top`; clamp on load and on resize; wrap **both** the read
and the write in try/catch (`localStorage.setItem` **throws** `SecurityError` in an opaque
origin, it does not return null) with `Number.isFinite` guards. `Reset position` button
instead of a keyboard drag.

**The grip stays a `<div>`, every HUD control stays a real `<button>`, and none may add a
Space handler or rely on Space to activate.** Measured: Space with a button focused fires the
shot and not the click (`controls.ts` preventDefaults first), but Enter with a button focused
fires the click and no shot. A `<button>` grip would put the fire key on a focus trap.

**A defect this found, recorded so nobody trusts the counter:** `metrics.refusedRate` is
move-only — `recordSend(seq?)`, and `shoot` carries no seq — so a refused shot increments
`sent` and nothing else, ever. The brief's premise that `refused` would have shown the dead
spacebar is wrong. The instrument is the state-derived cadence pill, not a counter, and a
real shot-refusal counter cannot be built from the wire.

---

## 10. The ER speed budget — this section overrules every section above it

### 10.1 The baseline, and it is not the number in the brief

Pooled `base-2026-09-02` + `-b`, 4 blocks per row, shipped build, **fight** mode:

| seats | samples | p50 | p95 | accepted | feed | notif |
|---|---|---|---|---|---|---|
| 1 | 1,308 | 135 ±14 | 204.3 ±133 | 82.0 % | 125.8 KB/s | 62.8/s |
| 5 | 6,284 | 130 ±10 | 197 ±179 | 78.8 % | 416.5 KB/s | 188.1/s |
| 10 | 12,755 | 129.8 ±6 | 296 ±180 | 80.1 % | 799.8 KB/s | 353.4/s |
| **20** | **25,277** | **129.8 ±9** | **270.5 ±181** | **80.5 %** | **1,530.2 KB/s** | **668.4/s** |

The shape the user likes reproduces: **20 seats are not slower than 1**, because `move` takes
`Arena` read-only and concurrent movers never serialise. The *level* does not reproduce
across days — versus 2026-09-01 on the same program, +7.8 ms p50, +123 ms p95, −13.7 pt
accepted. See Correction C: the 122/132 ms figures are from a lobby-mode run the program now
refuses.

Crank-only floor (quiet block): 30 frames/s, 51,050 B/s. `Arena` 10/s at 1,200 B, `Players`
10/s at 1,924 B (100 % duplicate), `Boss` 10/s at 50 B.

Compute: `boss_tick` worst 24,884 CU of a 399,700 ceiling at 20 players (≈32,384 on an arena
whose child PDAs miss bump 255). `shoot` guards 781 CU; `shoot` worst ray 16,699 CU — and
note that worst case is 8.4 % of the **default 200,000** per-transaction limit, not of
399,700.

### 10.2 The regression gate — a threshold, not a constant

**A regression is: candidate arm worse than baseline arm, same metric, same seat count, by
more than `max(floor, 2 × the baseline arm's observed spread)`, where each arm is TWO pooled
runs taken in the same sitting.** Floors: p50 **5 ms**, p95 **15 ms**, accepted **5 pt**,
bytes/s **15 %**, decode **30 %**.

```
scripts/spike/er_guard.sh base-X ; er_guard.sh base-X-b
scripts/spike/er_guard.sh cand-Y ; er_guard.sh cand-Y-b
scripts/spike/er_guard_cmp.mjs base-X,base-X-b cand-Y,cand-Y-b     # exit 1 on regression
```

**Why not a constant:** two runs of *identical unmodified code* five minutes apart drift
7.5 ms p50 / 78 ms p95 / 0.9 pt at twenty seats. A fixed 5/15/5 rule reports **seven
regressions over 20 checks in code nobody touched**. The palindrome sweep sees 1–2 ms of
within-run p50 spread and is blind to run-to-run drift, which is 4× larger at p50 and 40× at
p95. Pooling puts the drift inside the spread the limit derives from — the effective p50
limit at 20 seats is 18 ms today and collapses to the 5 ms floor on a quiet evening.

**Never gate across days.** Today versus yesterday on the same program prints 8 regressions.
All four runs in one sitting. `er_guard_cmp.mjs` refuses to compare runs whose `PS_*` knobs
differ, and `er_guard.sh` records the `.so` sha256 in `env.txt` so a candidate can be
confirmed to be a build of this tree.

### 10.3 What is actually on the critical path

**On chain: one thing.** §5's class byte adds to `shoot` one read-modify-write
(`(class_aim & 0x80) | aim_bits(dx, dy)`) and one 2-entry const table index (`>> 7` on a `u8`
is total, so no bounds check), and to `join` one byte read and one compare. Roughly a dozen
BPF instructions, an order of magnitude **below the 77–288 CU resolution of the instrument
that would measure it**, so it is stated as a bound and not as a measurement. `boss_tick`
gains **nothing** — no projectile enters the tick's loop, so 24,884 CU is unchanged. Zero new
account bytes, zero new notifications per shot (still 3), zero new write locks.

**Off chain: everything else.** The camera, both rooms, the boss grade, the tracer, the
passage, the HUD, the telemetry drag — 0 CU, and `er_guard` (a Node process) **cannot see any
of it.**

**And that is exactly where the real risk lives.** `controls.ts:381` pumps sends from
`setInterval(pump, 50)` **on the same main thread the scene renders on**. `frame-budget.md`
§4 measured the client servicing ≈62 of ≈700 notifications/s at 6× throttle with 11–17 ms
frames, so **every over-budget frame is a late pump and real felt lag.** The frame budget is
the ER budget in disguise.

### 10.4 Frame budget — the one number that must be re-measured

Today: 20 knights, full art, 6× CPU throttle — **p50 9.38 ms / p95 14.92 ms** against a
16.7 ms vsync. Headroom is real but not lavish.

What this spec adds to it, honestly labelled:

- **Fill rate, NOT MEASURED.** The scene rasterises into ≈1.65 Mpx instead of 1.07 Mpx
  (+55 %) and `.stage::after` covers the same +55 %.
- Boss grade + spill: **+0.15 ms p50 isolated**, inside noise on the full arena (n=8, 6×
  throttle: full arena 20 knights shipped 8.50/14.55 → proposal 8.45/13.65).
- Passage: an isolated harness measured the opacity design at p50 6.0 / p95 10.2 / worst
  16.0 ms against a 4.8/9.0/10.9 baseline — but **p50/p95 do not separate the designs** in
  that harness (session drift of 3 ms swamps the gap); what survives is the worst frame,
  which is why the animated `clip-path` variant is rejected (21.5 ms and 20.9 ms worst in two
  sessions, ≈2× baseline). Naively composing +1.2 ms onto the shipped baseline gives ≈16.1 ms
  p95, over budget — probably pessimistic, since the long form only runs during MUSTERING
  when the bullet pool is empty, but **that composition must not be asserted until measured.**
- Static room layers: a forced-repaint worst case of a 269-node / 330 KB prototype at 6×
  throttle measured p50 16.6 / p95 17.4 ms with **zero frames missed** — and that is a worst
  case that never happens, because the shipped layer never repaints.
- Halo: one `<use>` for one `<use>`, node count unchanged, ≈250–275 extra sprite-px per seat.
- Telemetry drag: 1 forced layout per 300 pointermoves, on a fixed overlay outside `#stage`.

**Gate: re-run `scripts/spike/framebudget` at 20 knights / 6× / 714 Hz. p95 must stay
≤ 16.7 ms.** If it does not, the lever is **scene complexity** — `Scene.tsx`'s 16 paths /
332 KB and the `.hr-boss-grade` filter — **not the framing.** Also re-run
`scripts/spike/perf_appath.ts`.

### 10.5 Bundle

Art is 77.4 KiB brotli of a 695.3 KiB critical path; the other 617.9 KiB is the Privy wallet
SDK. **The art is not the bundle problem**, and no decision in this spec should be made to
protect it. The authored vector props add 623 B brotli; the rejected `room.svg` panels would
have added 4,849 B. Neither matters; the 7.8× ratio is used as a tiebreak, not as a budget.

---

## 11. What is CUT, and why

**Cut from the chain**

| cut | why |
|---|---|
| On-chain arrows in `arena.bullets` | +229 ms to 1.26 s of flight latency before damage lands. Rule 10. The CU (+23,700) and the pool (54.4 of 128) were affordable; the latency is not. |
| A new arrow array on `Arena` | 1,200 → 2,224 B on a **delegated** account: realloc, `LAYOUT_VERSION` bump, three decoders, ER top-up at 6,960 lamports/byte. |
| `PlayerSlot.gate_entered_at_tick` | No free byte after §5.1, prohibited by name in `07-animation.md` §6.2, and it is one fact stored twice. |
| A third class (2 aim-ratio bits) | Measured: worst 4.05° and a 62-unit p95 miss. Two classes is the byte's budget. |
| Per-class range | Max steps-to-end over 214 stands is 13 of `MAX_RAY_STEPS` 64. The knob does nothing. |
| Relaxing `shoot`'s `PHASE_FIGHTING` guard | Three write locks and a transaction to change no state, at up to 25/s. |
| Dropping `shoot`'s `Arena` meta to READONLY | Real and free (`fire()` only reads `arena.tick`; `end_fight` is already idempotent and `tick.rs:861` does it every tick anyway) — but its two benefits are **expected from account roles and not measured**, and it is orthogonal to everything the user asked for. Take it in its own commit with its own `er_guard` run. |

**Cut from the client**

| cut | why |
|---|---|
| The follow camera and all 14 of its constants (§1.5) | It is the reported bug. |
| `usePixelFit` and integer pixel snapping | Available on 16 of 96 window/dpr combinations; a coin flip that reframes mid-drag. Deleting it also deletes the "renders at 57 % of the stage" defect and the stale dpr `ponytail:` note. |
| `.stage::after`'s **linear** gradient | Tuned for the deleted 2× lobby camera. Under the full-map framing it costs the rim 7.65:1 → 3.79:1 at the spawn row and 1.59:1 at the bottom edge. The radial vignette stays (0.046 alpha at the spawn row). Room-scale depth is now `Scene.tsx`'s world-space stack's job. |
| `assets/sprites/room.svg` entirely | Its props cannot be cut out (colour keying and flood-fill both fail); its only usable form is opaque panels at 7.8× the bytes of authored vectors, carrying px2svg dithering that would read as a different material next to them. |
| Reference A's bottom stairs | Row 63 is solid wall. Drawing them is a `gen_map.py` change to the bitboard the chain raycasts. |
| Twelve brazier floor gradients (room B) | Measured null: mean L8 around a reference flame goes 154 → 38 at d=10 → back to ambient by d=45. Flames only. |
| A brazier under-light on the boss | Measured null: 12 % floor lift under the creature, and building it moved the contrast ladder by ≤0.015 at every step for a fourth perimeter shadow term. |
| A `<use>` silhouette rim on the boss | The existing mechanism is right; §2.3 item 2 proves why. |
| Brightening `scene-core` | Already measured to walk the pit floor into the knights. |
| Reticle part **name + HP bracket** | The HUD parts cluster carries both; a text label tracking the pointer at 60 Hz is a per-frame DOM write in the tightest layer. Shape-only reticle stays. |
| Any cooldown change | The complaint is visibility, and `shoot` write-to-visible has never been measured (§6.5). |
| Deleting the 48 px header | Not requested; it is a branding decision. |
| A two-column telemetry panel | 352×445 measured, too wide below 1920. |
| Keyboard drag for the panel | A `Reset position` button is smaller and does not put a handler near the fire key. |
| A real shot-refusal counter | Cannot be built: `shoot` carries no seq and sends are fire-and-forget. The cadence pill is the only honest instrument. |
| Chasing 4.5:1 aggregate body-vs-floor | Needs 2.46–4.58× the darkest skin's luminance — that is re-tracing the sheet, and it measures the wrong quantity (§8.1). |

**Explicitly NOT cut** (each is small and each prevents a silent failure): the `feedEpoch`
resync gate, the passage's three hold releases, the `& CLASS_MASK` test, the raycast mirror's
three behavioural assertions, and the arrow-pool inequality assertion.

---

## 12. Implementation order

Each step compiles and ships on its own except where noted.

1. **`Hud.tsx:96` deletion + `export shotAllowed`.** Prerequisite for all feedback (§6.2).
2. **Viewport.** Fit hook, `VIEW_LOBBY`/`VIEW_ARENA`, delete §1.5's list, **`aimOrigin` via
   `getScreenCTM` in the same commit** (§1.8), delete `styles.css:273`.
3. **Panel deletion + HUD clusters + `SelfPanel` in the lobby** (§9). Do not move the
   `#stage` node among `<main>`'s children.
4. **Room B** — rings, light budget, boss grade/core/spill, `styles.css:328–372` deletion
   (§2.2, §2.3).
5. **Room A** — grade, walls, pillars, authored props (§2.1). The torch-pool alpha is
   measured and closed: ceiling 0.07, shipped 0.045 at Nocturne 1.95:1 over 323,063 stands.
6. **Legibility** — `gen_knights.py` re-run, halo, rim lift, local marker, `.stage::after`
   trim (§8.1).
7. **Passage** + `feedEpoch` (§7). Fixes `Spawn.tsx`'s replay bug in the same three lines.
8. **Arrows + shoot contract**, with `aimOf` returning `FACING_UNIT[facing]` (§4, §5.5, §6).
9. **Telemetry drag** (§9.3). Lowest priority, by the user's own words.
10. **The chain change** — `class_aim`, class table, `JOIN_DATA_LEN` 66→67, Worker
    `CLASS_COUNT`, `CharacterSelect`, `decodeAim`. **Program + app + worker deploy together.**

### 12.1 Acceptance gates

1. `(cd app && npx tsc --noEmit)`, `(cd packages/client && npx tsc --noEmit)`,
   `(cd worker && npx tsc --noEmit)` all **0**; `cargo check --workspace` **0**.
2. `cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"` — the **unit**
   line reads 94 passed before step 10, and ≥97 after (three new tests: `& CLASS_MASK`
   preservation, aim round-trip, class-table DPS equality). The doc-test line reads 0 and is
   not the line.
3. Frame budget at 20 knights / 6× throttle: **p95 ≤ 16.7 ms** (§10.4). Re-run
   `perf_appath.ts` too.
4. `er_guard.sh` × 4 in one sitting, `er_guard_cmp.mjs` exits **0** (§10.2). Required only
   for step 10; recommended once after step 8.
5. Screenshot both rooms and run `python3 docs/art/legibility.py shot.png A|B`. If room B's
   floor p95 exceeds Y 0.0767, lift the rims again — Cobalt clears at 4.49:1, which is
   4.5:1 only to two significant figures.
6. A dead limb's contrast against the cavern, re-measured after the new boss grade.
   `.hr-boss-part.hr-dead { grayscale(1) brightness(0.45) }` was tuned against the old grade
   and may now be indistinguishable from the background, which loses the read the whole rig
   exists for.

### 12.2 The self-checks that replace the deleted camera checks

Dev-only, in `Arena.tsx` / `Passage.tsx`, all `throw` on failure. Checks 1–5 and 7 are pure
and run at **module load**. Check 6 is the exception and cannot be: it interrogates a node
that belongs to room A's rendered tree, so it runs **inside `Passage`'s layout effect**, on
the `#gate-portcullis` element the beat already has in hand, at the moment the long form
borrows it. That places it on the long gate beat only — which is the only form that writes
to the node, so it guards exactly the writes it exists to guard.

1. `VIEW_LOBBY.w === VIEW_ARENA.w && VIEW_LOBBY.h === VIEW_ARENA.h` — the gate move is a
   pure translate only while this holds.
2. `VIEW_ARENA.y + VIEW_ARENA.h === PIT_BOT + 1` and
   `VIEW_LOBBY.y + VIEW_LOBBY.h === (lobby floor bottom) + 80` — both frames still derive
   from the generated map.
3. For a sweep of stage aspects: the fitted viewBox **contains** `V` and its aspect equals
   the stage aspect.
4. Every `E` entrance is farther than `SELF_SNAP` (64) from the gate block centre — shortest
   today is 171.0. A map redraw that brings one closer would make that seat *chase* under
   the hold instead of snapping, freezing a knight mid-walk.
5. `ARROW_UNITS_PER_SEC`: `640 / ARROW_UNITS_PER_SEC * 1000 + STICK_FADE_MS < CLASS_PERIOD_MS[0]`.
6. Exactly one element matches `#gate-portcullis` and it carries no CSS animation — the
   two-writer check (§7.3). **Effect-time, not module-load** — see above. Implemented at
   `Passage.tsx`'s `inRoomA('#gate-portcullis')` call site.
7. `(CLASS_COOLDOWN[c] + 1) * TICK_MS === CLASS_PERIOD_MS[c]` for every class, and
   `CLASS_DAMAGE[0] * (CLASS_COOLDOWN[1] + 1) === CLASS_DAMAGE[1] * (CLASS_COOLDOWN[0] + 1)`
   — the DPS-neutrality the boss's HP curve assumes.

---

## 13. Known ceilings

`ponytail:` each of these is a deliberate corner with a named upgrade path.

- **Props are not solid** (R4). A knight can clip the outer 16 units of a floor-standing
  barrel. Upgrade: mark the tiles `#` in `assets/map/arena.json` and re-run `gen_map.py` —
  a map change with `cargo test` behind it.
- **Two classes only.** The third aim-ratio bit is the cost. Upgrade: widen the aim to a
  second byte, which means growing `PlayerSlot` and a real migration.
- **Remote arrows are 45°-resolved until step 10 ships.** Upgrade is `decodeAim` (§5.5).
- **A remote arrow is still in flight when its own damage flash fires**, by up to 160 ms,
  because the arrow spawn and the parts change arrive on the same notification triple. Judged
  unreadable — the local player never sees it, and nineteen other arrows land constantly —
  but that judgement is not measured.
- **The archer's 1400 ms is a balance guess** constrained by the notification budget, not by
  playtesting. It is DPS-neutral by construction, so the boss needs no rescaling, and the
  knob is one `ticks_for()` call.
- **`PAL.rim` and `MAP_ENTRANCE_PATH`'s tint break the contrast cap** in `Arena.tsx`'s wall
  layer — including on the four tiles where dead raiders respawn. Not fixed here.
- **A knight in front of the boss reads at 1.77:1** against the creature's own graded body.
  No arena change reaches it; the lever is a scrim or a stronger key light in
  `Boss.tsx`/`Knight.tsx`.
- **Only Chromium was measured.** Pointer-capture retargeting is where engines historically
  diverge, and it is load-bearing for the telemetry drag.
- **Two arenas are stranded delegated in `PHASE_LOBBY`** from aborted perf runs
  (1788327977, 1788328056). `settle` refuses with `WrongPhase`; only rent and ER top-up are
  locked. Treasury 1.12 → 0.93 SOL over five runs, ≈0.04 SOL per run.
