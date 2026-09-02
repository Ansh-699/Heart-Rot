# Player legibility

What "the player is on top like the game" resolves to, what the shipped art actually measures
at, and the one ordered draw list every renderer file follows.

Every number below is reproduced by `docs/art/legibility.py`:

```
python3 docs/art/legibility.py                 # against the two reference PNGs
python3 docs/art/legibility.py shot.png B      # against a screenshot of the shipped scene
```

It parses the shipped `app/src/render/knights.gen.ts` — not a redraw of it — and uses WCAG 2.x
relative luminance with contrast `(Lhi + 0.05) / (Llo + 0.05)`, which is `docs/review/art.md`'s
own method. It reproduces that review's three body luminances (Cobalt 0.1678, Argent 0.1303,
Nocturne 0.1136) exactly, which is how you know the parser is measuring the same thing.

---

## 1. What the request means

"The player is on top like the game" has two readings. Both are true, both are cheap, neither
contradicts the other, and this document specifies both.

**(i) Draw order.** An actor is never occluded by decoration. A barrel, a brazier, a banner, a
chain, a statue, a light pool, a floor medallion — none of them are ever painted over a knight.
Depth for a floor prop comes from its own contact shadow, never from covering the player.
§6 is the ordered list. There is exactly one earned exception and it is bounded in §6.

**(ii) Findability.** Among twenty knights standing in the same brazier light, *your* knight is
identified in under a second, without hue. §5 is that marker.

A third thing turned up while measuring and it dominates both: the local knight is currently
drawn at **21 CSS pixels tall on any 2× display**, because `usePixelFit` throws away up to 49%
of the available scale (§4.3). No colour work reaches a 21 px figure. Fix §4.3 first.

---

## 2. The metric has to change, and here is the proof

### 2.1 What the shipped art measures at, on both new scenes

Floors sampled from the reference PNGs, stone only, walls and props and the boss and the dais
excluded (`BOX_A = (150,300,980,690)` in the 1122×785 waiting-area plate, `BOX_B =
(200,300,920,520)` in the 1122×612 arena plate):

| scene | mean sRGB | Y p5 | p25 | p50 | p75 | p95 |
|---|---|---|---|---|---|---|
| A — waiting area | (48, 40, 57) | 0.0106 | 0.0176 | 0.0231 | 0.0335 | 0.0468 |
| B — boss arena | (40, 43, 53) | 0.0048 | 0.0127 | 0.0218 | 0.0386 | 0.0767 |

Shipped knight bodies against them, area-weighted over each `k{skin}-rest` group:

| skin | body Y | A p50 | B p50 | **worst over both scenes** |
|---|---|---|---|---|
| Cobalt | 0.1678 | 2.98:1 | 3.03:1 | **1.72:1** |
| Argent | 0.1303 | 2.47:1 | 2.51:1 | **1.42:1** |
| Nocturne | 0.1136 | 2.24:1 | 2.28:1 | **1.29:1** |

Two things to read off this. The reference floors are *darker* than the shipped graded pit
floor, so the p50 numbers are better than `Scene.tsx`'s 1.85–2.47 range — the new scenes help.
And the worst case is worse, because image B has bright cyan-lit ring stone at p95 = 0.0767 and
a Nocturne knight standing on it reads at **1.29:1**, which is a knight-shaped absence.

### 2.2 Aggregate body contrast cannot reach 4.5:1. Stop chasing it.

Solving `(Ybody + 0.05) / (Yfloor + 0.05) = 4.5` for the body:

| against | floor Y | body Y required | = what |
|---|---|---|---|
| A p50 | 0.0231 | 0.2791 | 2.46× Nocturne, 1.66× Cobalt |
| B p50 | 0.0218 | 0.2732 | 2.40× Nocturne, 1.63× Cobalt |
| B p95 | 0.0767 | 0.5200 | 4.58× Nocturne, 3.10× Cobalt |

Making a body 2.4–4.6× brighter *is* re-tracing the sheet, which the brief excludes. And the
body cannot get there by addition either: §4.2 measures a full two-unit halo, the largest
addition that still looks like pixel art, and it tops out at 3.83–4.25:1 at p50 and 2.21–2.41:1
worst case. Both directions are closed.

Nor should it be chased. **Over 60% of every skin is its own dark keyline** — p5 and p25 of all
three skins sit at Y = 0.0076, the outline colour. That is not a defect, it is how the sprites
are drawn, and averaging a deliberately-dark interior against the floor is measuring the wrong
thing.

### 2.3 The metric that is right, and reachable

WCAG 1.4.11 non-text contrast is defined on **the boundary of a graphical object**, not on its
average fill. For a figure on a ground the readable quantity is the contrast between the
figure's outermost pixels and the ground immediately behind them.

Measured on that basis, today's defect is precise and one-sided. The shipped key light
(`Knight.tsx::SKIN_KEY`) is drawn as `sil` offset one unit **up-left only**, so it covers
11.5% (Cobalt) / 14.2% (Nocturne) / 15.8% (Argent) of the body. On the down-right side the
outermost pixels are the sprite's own keyline at Y = 0.0076, and against the floor that is:

* A p50: **1.28:1**
* B p95: **1.06:1**

The down-right half of every knight has, today, no boundary contrast at all. That is the bug.

**Acceptance metric, from here on: boundary contrast ≥ 4.5:1 against every sampled floor
percentile of both scenes, on every edge of the figure.** Aggregate body-vs-floor is reported
for continuity with `docs/review/art.md` and is not a gate.

---

## 3. The three files that produce the fix

### 3.1 `tools/gen_knights.py` — one new derived pose per skin

The rim must be a full outline, not a directional offset. SVG cannot dilate a `<use>`, and the
three ways to fake it are all rejected on measured grounds:

* eight offset `<use>` copies = 160 extra nodes at twenty seats;
* stroking `sil` strokes every internal rect seam of the run-length union, drawing the sprite's
  own tiling through the figure;
* `feMorphology` is a filter, and `Knight.tsx` already rejects per-seat filters — twenty
  `brightness()` nodes was twenty filter layers, and this is the same shape of cost.

So the halo is generated, from art already checked in. `gen_knights.py` emits two new groups per
skin, both derived from geometry it already computes — **this re-traces nothing**:

| id | source | what |
|---|---|---|
| `k{s}-halo` | the same union `sil` is emitted from | that union dilated by 2 px (4-neighbour, twice), minus the union itself |
| `k{s}-halo-fallen` | the `fallen` pose mask | the same dilation, on the transposed canvas |

Emit both with `fill="currentColor"` exactly as `sil` is emitted, so a `<use>` can colour them,
and as merged run-length subpaths in the same `M x yh wv hh-wz` form as every other pose. Two
groups per skin, six total; `KNIGHT_DEFS` gains ~6% of its subpath count.

Measured areas of the dilation (`legibility.py` §5):

| skin | body px | 1-unit halo | 2-unit halo |
|---|---|---|---|
| Cobalt | 745 | 149 (20%) | 248 (33%) |
| Nocturne | 678 | 176 (26%) | 272 (40%) |
| Argent | 653 | 174 (27%) | 273 (42%) |

**Two units, not one, and the reason is device pixels, not taste.** One arena unit is
`viewportSquare / 1024` device pixels: 0.70 px at a 720 px square, 0.88 px at 900, 1.05 px at
1080. A one-unit rim is *sub-pixel on every laptop*, and under `shape-rendering: crispEdges` it
snaps to zero on some rows and one on others as the sprite walks — which is the row-by-row
flicker `usePixelFit`'s own comment describes. Two units is 1.41–2.11 px and survives.

Do not hand-edit `knights.gen.ts`. Change the tool, re-run it, commit the output.

### 3.2 `Knight.tsx` — the key light becomes the halo

`SKIN_KEY` keeps its structure and its self-check. Two changes:

**The `key` values are lifted.** They were solved to a common HSL L of 0.72; the two reference
scenes demand more. `4.5 × (0.0767 + 0.05) − 0.05 = 0.5202`, where 0.0767 is image B's p95 lit
ring stone. Lifting each accent's HSL lightness until its relative luminance reaches that, hue
and saturation untouched:

| skin | accent | shipped key | Y | worst | **new key** | Y | **worst** | on a shadowed floor |
|---|---|---|---|---|---|---|---|---|
| Cobalt | `#2f5585` | `#95b4da` | 0.4409 | 3.88:1 | **`#a8c1e0`** | 0.5185 | **4.49:1** | 7.02:1 |
| Nocturne | `#b97055` | `#d5aa9a` | 0.4523 | 3.97:1 | **`#dcb7aa`** | 0.5198 | **4.50:1** | 7.03:1 |
| Argent | `#b4b4c1` | `#b4b4c1` | 0.4620 | 4.04:1 | **`#bebec9`** | 0.5199 | **4.50:1** | 7.04:1 |

"worst" is the minimum over all ten sampled floor percentiles of both scenes. Cobalt's 4.49
is 4.5 to two significant figures and is the binding case; it is the *only* number in the table
that is not comfortably clear, and it occurs on B p95 alone. The "shadowed floor" column is the
same rim measured against floor that already carries the seat's own contact shadow
(`#0f0d12` at 0.45, which `Knight.tsx` already draws) — the knight lands its rim on ground it
has itself darkened, so the realised number is ~7:1 under the body and 4.5:1 only at the
outermost fringe of the halo. That is why the contact shadow in §6 is not optional decoration.

The rim against the sprite's own keyline is 9.9:1, so the halo reads as a halo and not as more
body.

**The `<use>` changes.** Delete the offset-`sil` key-light node. Replace it with, as the first
child of the body `<g>`, at the pose's own anchor with **no offset**:

```
<use href={`#${knightPoseId(slot.skinId, dead ? 'halo-fallen' : 'halo')}`}
     x={anchorX(hw, w.flip)} y={-(hh >> 1)} transform={knightT}
     fill={keyLight(slot.skinId)} color={keyLight(slot.skinId)} />
```

Both `fill` and `color`, for the reason the existing flash node sets both. Node count is
unchanged — one `<use>` replaces one `<use>` — and the corpse gains an outline it does not have
today. `keyDx()` and its self-check go with the offset; the self-check line asserting the rim
stays up-left through a flip is deleted, because a symmetric halo has no side.

Keep everything else in the file: `advance` is untouched, the walk is still displacement-driven,
`knightDrawOrder` is unchanged, and the WAAPI one-shot discipline is unchanged. The halo is
inside the body `<g>`, so recoil, fall, revive and breathe carry it.

### 3.3 `styles.css` — `.stage::after` is the largest single loss and it is not art

`.stage::after` (styles.css:255) composites a full-viewport gradient **over the SVG**: a linear
ramp reaching `rgb(8 13 20 / 0.42)` at 88% of the stage and `0.70` at 100%, plus a radial
vignette to `0.62`. It was tuned for the old two-camera framing, where the lobby camera showed
world y 512..1024 blown up 2×, so world y 832 landed at 62% of the screen. Under the
full-map camera the same world row lands at **81%** of the screen, and the ramp there is nearly
twice as strong.

What it costs the new rim, per screen row (`legibility.py` §7):

| world row | linear α | vignette α | rim vs floor |
|---|---|---|---|
| pit centre, y = 496 | 0.105 | 0.000 | 7.64:1 → **6.41:1** |
| gate, y = 624 | 0.183 | 0.000 | 7.64:1 → **5.67:1** |
| **lobby spawn, y = 832** | 0.361 | 0.046 | 7.65:1 → **3.79:1** |
| bottom edge, y = 1000 | 0.645 | 0.296 | 7.65:1 → **1.59:1** |

`LOBBY_SPAWN_Y = 832` is where every player spawns. The rim is engineered to 4.5:1 and this
overlay takes it to 3.79:1 before the player has moved. At the bottom edge of the waiting area
— which under the new camera is playable floor, not letterbox — it takes it to 1.59:1.

**Delete the `linear-gradient` layer of `.stage::after`; keep only the radial vignette.** With
the full-map camera the SVG owns depth in world space — `Scene.tsx`'s ceiling, pool, rim-shadow
and vignette stack all still applies — and the DOM ramp is now a second, screen-space copy of
the same idea sitting on the wrong side of the actors. Keeping only the radial costs the rim
0.046 α at the spawn row: **7.65:1 → 7.3:1**, inside the noise.

If the ramp is wanted back it belongs *inside* `#camera`, under the actors, in world units —
never above the SVG.

`.stage`'s own background gradient (the cavern behind the letterbox) stays. It is under the
SVG and costs nothing.

---

## 4. Size, which is upstream of all of it

### 4.1 Removing the camera halves the knight

`LOBBY_ZOOM = 2` is being deleted with the follow camera. Every marker and every rim in the
waiting area was drawn at 2× and is about to be drawn at 1×. Nothing in `Knight.tsx` compensates
automatically. This is why §5's marker geometry is larger than what ships today: it is restoring
the apparent size the lobby had, not inflating it.

### 4.2 The device-pixel budget

One arena unit, with the 1024-unit square fit to the viewport:

| viewport square | 1 unit | knight | 2-unit rim | MAP_TILE |
|---|---|---|---|---|
| 1440 px | 1.41 px | 46 × 59 px | 2.81 px | 22.5 px |
| 1080 px | 1.05 px | 35 × 44 px | 2.11 px | 16.9 px |
| 900 px | 0.88 px | 29 × 37 px | 1.76 px | 14.1 px |
| 720 px | 0.70 px | 23 × 30 px | 1.41 px | 11.2 px |

Nothing carrying information may be thinner than **2 arena units**. At 720 px that is 1.4 device
px, which is the floor; one unit is 0.70 px and is not a thing.

### 4.3 `usePixelFit` is discarding up to 49% of the stage, and it is why "21 px" exists

`Arena.tsx::usePixelFit` computes `raw = min(w, h) × dpr / 1024` and then takes
`Math.floor(raw)` whenever `raw >= 1`, so `crispEdges` lands on an integer device grid. The
floor is correct in intent and catastrophic in magnitude: at `raw = 1.758` it picks 1, and the
arena renders at 512 CSS px inside a 900 CSS px stage.

| stage min side | dpr | SVG rendered | knight | **stage used** | crisp |
|---|---|---|---|---|---|
| 700 | 2 | 512 px | **21.0 px** | 73% | yes |
| 800 | 2 | 512 px | **21.0 px** | 64% | yes |
| 900 | 2 | 512 px | **21.0 px** | 57% | yes |
| 1000 | 2 | 512 px | **21.0 px** | 51% | yes |
| 900 | 1.5 | 683 px | 28.0 px | 76% | yes |
| 900 | 1 | 900 px | 36.9 px | 100% | no |
| 1200 | 2 | 1024 px | 42.0 px | 85% | yes |

The "three dark blobs at 21 px" in `Knight.tsx`'s header is not a figure of speech — it is this
row, and it is what any 2× display gets. It also contradicts the brief directly: the user asked
for the map **full screen**, and in twenty of the twenty-four `(css, dpr)` configurations
measured the SVG does not fill the stage — in thirteen of them it leaves more than 15% of it
empty, and in one it leaves 49%.

**Fix: snap to the integer only when the snap is nearly free.**

```ts
const raw = (Math.min(r.width, r.height) * dpr) / ARENA_UNITS;
const int = Math.floor(raw);
// Snap to the crisp integer grid only when it costs under 15% of the available size.
// At raw 1.758 the floor threw away 43% of the stage and drew a 21px knight.
const integral = raw >= 1 && int / raw >= 0.85;
const scale = integral ? int : raw;
```

and `setCrisp(integral)` instead of `setCrisp(raw >= 1)`. Results after: 900 @ 2× renders at
900 CSS px with a 36.9 px knight (100% of the stage, `geometricPrecision`); 1200 @ 2× keeps the
integer snap at 85%; 1400 @ 1.5× keeps it at 98%. Worst-case unused stage becomes 15%.

This is one expression and it is worth more legibility than everything else in this document
combined. Do it first, then re-measure.

---

## 5. The local-seat marker

### 5.1 What it must not rely on

Not hue. Simulating the three lifted rims under protanopia, deuteranopia and tritanopia
(Viénot LMS), the closest pair sits at **1.02–1.03:1** in luminance in all three cases — the
skins are indistinguishable to a dichromat, and that is acceptable *because skin is flavour and
carries no information*. Nothing that matters may ride that channel.

Not motion alone, per this project's existing rule: no information may exist only in motion.

So the marker is **shape + luminance + position**, in that order, with motion as redundancy.

### 5.2 The marker

All geometry in arena units, all of it inside the seat `<g>` — the same node `Knight` already
renders into, whose transform stays owned by the frame loop or `useSeatInterpolation`. No new
top-level layer is needed, and §5.4 shows why.

**A. Ground ring — two ellipses, drawn before the body, centred on `FEET_Y = 20`.**

| | rx | ry | stroke | width | opacity |
|---|---|---|---|---|---|
| under-ring | 18 | 7 | `#05060a` | 5 | 0.75 |
| ring | 18 | 7 | `#eafff4` | 3 | 0.9 |

Two tones so the ring survives both ends of the floor: `#eafff4` reads at **7.94:1** against the
darkest sampled floor, `#05060a` reads at 10.96:1 against a lit rim or a bright brazier patch,
and one of the two is always winning. The under-ring drawn first and wider makes it a bright
line with a dark keyline, which is the same construction the sprites themselves use.

At 3 units the bright stroke is 2.1 px at a 720 px square. The shipped `rx 15 / width 2` is
1.4 px and was only ever legible because the lobby camera doubled it (§4.1).

**B. Chevron — above the helm, dark-keylined.**

```
<path d="M-8,-36 L8,-36 L0,-24 Z"
      fill="#eafff4" stroke="#05060a" strokeWidth={2} paintOrder="stroke" />
```

16 × 12 units, against the shipped 10 × 7 — 11.2 × 8.4 px at a 720 px square. `paint-order:
stroke` puts the keyline outside the fill so the shape does not shrink. The keyline exists
because the chevron's only bad background is another knight's rim: `#eafff4` against a lifted
rim is **1.76:1**, and against the keyline it is 10.96:1.

This is the cue that works when you are completely hidden behind an ally, and it is the only
one. It must never be clipped, never faded, and never suppressed while dead — a player watching
their own respawn countdown still needs to know which corpse is theirs.

**C. Redundant breathe.** Ring group opacity 0.55 ↔ 0.95, 1400 ms, `iterations: Infinity`, one
WAAPI animation on the ring `<g>` and nothing else, cancelled under `reduced`. It carries no
information — A and B already carry all of it — so removing it removes nothing.

### 5.3 What was skipped

No name label, no seat number, no minimap arrow. At 23–46 px per knight a legible text label is
14+ units tall and would occupy more screen than the knight. Add a label when twenty *named*
players in one raid is a real complaint, not before. No hue-coded self colour: §5.1.

### 5.4 Why the marker does not need its own layer

The chevron sits 24–36 units above the seat centre; a knight is 42 units tall and anchored at
its centre, so an ally's head top is 21 units above *its own* centre. Draw order is ascending
`y`, so only an ally with a larger `y` is painted later — and such an ally's head top is at
`y_self + Δ − 21` with Δ ≥ 16 (one tile), i.e. at worst 5 units *below* the local seat's centre
and 29 units below the chevron. An ally can never cover it. An ally standing exactly level ties
on seat, which is deterministic. A separate marker layer would be one more layer and one more
ordering argument for zero measured gain.

---

## 6. The draw order

One list, back to front. Every implementer follows this; nothing gets inserted without editing
this table. SVG has no `z-index` — **document order is the only depth cue**, so the row number
*is* the child index inside `#camera`.

| # | layer | node | owner | notes |
|---|---|---|---|---|
| 1 | base fill | `<rect>` | `Scene.tsx` | under everything; kills stretch seams |
| 2 | floor art | graded room / temple paths | `Scene.tsx` | the stone, the inlaid medallions, the stairs |
| 3 | floor lighting | ceiling, pool, core spill, rim-shadow, vignette gradients | `Scene.tsx` | painted over the grade, not through it |
| 4 | map geometry | `MAP_WALL_PATH`, `MAP_RIM_PATH`, `MAP_ENTRANCE_PATH`, gate block | `Arena.tsx` `overlay` | **always over the art.** Art that hides a wall is a legal-looking move the chain rejects |
| 5 | props | barrels, chests, candles, bones, banners, torches, portcullis, statues, chains, pillars | new prop layer | **all of them, wall-mounted and floor-standing, in one layer.** Sorted by their own `y` among themselves only |
| 6 | prop light | brazier and torch glow discs | new prop layer | the pools those props cast — over the prop, under every actor |
| 7 | gate feedback | the frame-loop `<rect>` | `Arena.tsx` | opacity owned by the frame loop, nothing else |
| 8 | boss ordnance | `<line>` per visible bullet | `Arena.tsx` | under the boss so a bullet's first frames hide inside the silhouette that fired it |
| 9 | boss | the rig, clipped at `PIT_BOT + 1` | `Boss.tsx` | fixed at top-middle; does not move |
| 10 | telegraphs | slam lane, volley aim lines | `Arena.tsx` | over the boss (the hand that lands is over it too), **under the knights** — a wind-up must never paint over the figure you are reading |
| 11 | knights | one `<g>` per occupied seat | `Arena.tsx` + `Knight.tsx` | `knightDrawOrder`: ascending authoritative `y`, ties on `seat`. Local seat sorts by its own `y` like everyone |
| 12 | player arrows | one node per live arrow | new arrow layer | **above the knights.** An arrow leaving your own bow that is drawn under the crowd is the "I cannot see anything" report |
| 13 | pit rim occluder | `rim`, clipped to two tile rows | `Arena.tsx` | **the one exception** — see below |
| 14 | spawn light | `<Spawn>` | `Spawn.tsx` | over everything, `pointer-events: none` |

Above the SVG, in DOM paint order:

| # | layer | where | notes |
|---|---|---|---|
| 15 | stage lens vignette | `.stage::after` | radial only. The linear ramp is deleted — §3.3 |
| 16 | HUD | `aside.panel` | a grid sibling of `#stage`, never over it. Keep it that way |
| 17 | error bar | `ErrorBar` | |
| 18 | telemetry | `.dev` / `.dev-cue`, `z-index: 40` | the only thing that overlaps the arena by design |

**Row 13, the only occluder above an actor.** The pit's near wall is redrawn over everything so
the boss's hands grip a rim in front of them and a knight at the pit floor stands *inside* a
pit. It is clipped to `y ∈ [PIT_BOT + 1 − 2·MAP_TILE, PIT_BOT + 1]` = world y 576..607, i.e. two
tile rows, and `move_player` clamps an arena-zone knight to `PIT_TOP..=PIT_BOT`. So it can cover
at most the lower ~10 units of a knight standing on the last walkable row, and it covers nothing
at all in the waiting area, which is entirely below it. That bound is the reason it is allowed.
It must not grow, and no other layer may join it.

**Consequences that are not negotiable:**

* Nothing new goes between rows 11 and 14 except row 12 and row 13.
* A prop is never promoted above an actor for depth. Its contact shadow is its depth.
* Row 5 is one layer, not "far props" and "near props". Splitting it is how a barrel ends up
  in front of a player.
* Rows 1–7 are static and must stay static: `Scene.tsx`'s `SCENE` is a module-scope element and
  `overlay` / `rim` are `useMemo([], …)`, and the measured cost of losing that is 11.2 ms/frame
  and 3/3 renderer crashes at 300 frames. A new prop layer is built the same way — a module
  constant or an empty-dependency memo, no props, no chain state.

---

## 7. Arrows, since they land in this order

Not this document's design, but two constraints fall out of the measurements and belong here.

**Colour.** An arrow must clear 4.5:1 against both floors and must not be confusable with boss
ordnance. `PAL.bullet = #ffb020` measures Y 0.5241, worst-vs-floor 4.53:1. Any arrow colour that
also clears 4.5:1 sits at a similar luminance and therefore reads as the same object to a
dichromat: `#cfeeff` is 6.84:1 against the floor but only **1.51:1 against the bullet amber**.

So **shape, not colour, separates an arrow from a bullet.** A bullet is a round-capped capsule
~8 units across; an arrow must be a thin shaft with a distinct head, at least 12 units long and
no more than 2 units thick. Suggested fill `#cfeeff` with a `#05060a` keyline, which is 6.84:1
against the floor and 10.96:1 against anything bright it crosses.

**Budget.** Arrows are the risk the brief already flags: `boss_tick`'s swept-collision loop over
live bullets dominates its 24,884 CU at twenty players, and the visible-bullet cap of 32 is what
brought the frame budget to p50 9.38 ms / p95 14.92 ms at 6× throttle. Arrows get their own cap
and their own ranking, and neither pool borrows from the other.

---

## 8. Acceptance

Ordered, because each depends on the one before.

1. `usePixelFit` (§4.3): the SVG uses ≥ 85% of the stage's smaller dimension in every
   `(css, dpr)` row of `legibility.py` §8. Today it is as low as 51%.
2. `.stage::after` (§3.3): the linear ramp is gone. Screenshot the spawn row; the rim reads
   ≥ 7:1, not 3.79:1.
3. Boundary contrast (§2.3, §3.1, §3.2): screenshot both scenes with a knight of each skin
   standing on the brightest floor patch available, run
   `python3 docs/art/legibility.py shot.png B`, and confirm the rim clears 4.5:1 on **every**
   edge including down-right. The down-right edge is the one that measures 1.06:1 today.
4. Marker (§5): from a cold start with twenty seats occupied, the local knight is found in
   under one second, and is still found with the page rendered through a deuteranopia filter.
5. Draw order (§6): no prop, light pool, telegraph or gradient covers any part of a knight
   anywhere on either scene, other than row 13 within its two-tile-row bound.
6. Frame budget: re-run the 20-knight 6× CPU throttle capture. p50 ≤ 9.38 ms and p95 ≤ 14.92 ms
   must hold. The halo replaces the key-light `<use>` one-for-one so node count is unchanged and
   the added paint area is ~270 sprite-px per seat, but "should be free" is not a measurement.
7. `cargo test -p heartrot` still reads 94 passed on the unit line — nothing here touches the
   program, and if that number moves, something did.

None of this changes a byte on chain, an instruction, an account layout or a send. The
MagicBlock ER path is untouched: no new writes, no new notifications, no new CU.

---

## 9. Numbers this document supersedes

* `sprites.ts`'s "ally 4.35:1" — measured against the deleted primitive circles. Already known
  wrong; now also wrong about the scene it was measured on.
* `docs/review/art.md`'s recommendation to raise `PIT_POOL_ALPHA` to 0.35 — `Scene.tsx` already
  rejects it with arithmetic and this document agrees: on the reference floors the knights are
  *lighter* than the ground, so brightening the ground walks it into them.
* `Knight.tsx::SKIN_KEY`'s common HSL L of 0.72 and its measured table (rim 5.74–5.98:1 against
  a sRGB-53 floor). That floor is not what either new scene composites. §3.2 replaces both the
  values and the table.
* `Knight.tsx::keyDx` and the "the key light stays up-left through a flip" self-check — deleted
  with the directional offset.
