# Enlarged fight arena — specification

What the FIGHTING room looks like once the pit stops being fourteen tiles tall: the
circular arena of `/home/anshtyagi/Downloads/actual_boss_arena.png` (image B) rebuilt so
that every dimension is a function of the generated `PIT_TOP`/`PIT_BOT`/`MAP_GRID` and none
of them is typed, with the creature fixed TOP CENTRE where the user asked it to stay and
the floor between the perimeter and the creature completely clear.

**This is a delta, not a rewrite.** `docs/art/boss-arena.md` is specified and shipped as
`app/src/render/BossArena.tsx`. That file already gets the hard part right — the rings are
clipped to the compiled `PIT_PATH`, nothing has mass on a walkable tile, the layer is a
module-scope element with no props. What it does *not* survive is the pit changing size:
eleven of its constants are world coordinates fitted to a 224-unit band. §6 lists them.

Nothing here is implemented. Every number says how it was obtained, and every number in
this file is printed by `docs/art/arena.py`:

```
python3 docs/art/arena.py
```

That script composites the shipped scene in sRGB out of `temple.svg`, `parts/boss.svg`,
`knights.gen.ts` and `arena.json` — no redraws, no retyped hexes — and it is validated
against three numbers this codebase measured independently before it is trusted for a
fourth (§5.1).

**Chain impact: none.** See §8.

---

## 1. What the enlargement has to preserve

### 1.1 The reference, re-read for the thing the user is complaining about

Image B's composition survives a scale change because its floor is **empty**. Inside the
floor ellipse — centre (561, 385), semi-axes (418, 120), the fit `boss-arena.md` §1.5
measured — there is the creature, the paving, the mortar courses and the medallions, and
nothing else. Every object with mass in that picture is outside the ring or standing on its
kerb: the pillars, the banners, the chains, the demon statues, the horned skull pedestals
and eleven of the twelve braziers.

Measured (`arena.py`, residual of each pixel against a smooth radial luminance model of the
floor, binned at 40 bins per radius): 157,521 px inside the ellipse; 33.6 % of them depart
from that smooth model by more than 14 L8, and **63.8 % of those departures sit above the
ellipse's centre line and 50.3 % within 30 % of the centre column** — which is where the
creature is. Outside the centre third of the width, 73.8 % of the floor is within 14 L8 of a
smooth radial ramp; the remaining quarter is the mortar courses and the medallions.

That is the composition rule the user is asking for, and it is the reference's own:
**the middle is the creature, the edge is architecture, and between them is paving.**

### 1.2 The palette, the light and the ring family carry over unchanged

`boss-arena.md` §1 measured image B once and thoroughly, and none of it depends on how big
our pit is: the dark frame with 0.66 % cyan-hot pixels, the braziers that light nothing past
15 px, the single radial pool centred on the creature at a 2.7:1 centre-to-rim ratio, the
mortar courses at 0.21 of the radius, the colour table. **Do not re-derive any of it.** This
document changes only what the pit's own size decides.

### 1.3 The one thing that actually improves

The shipped pit is **4.43:1** — 992 x 224 — against image B's floor at 3.48:1. Every
candidate enlargement is closer to the reference than that:

| pit | rows | height | aspect | walkable units | % of the 1024 square |
|---|---|---|---|---|---|
| shipped | 24–37 | 224 | 4.43:1 | 185,856 | 17.7 % |
| C1 | 24–47 | 416 | 2.38:1 | 376,320 | 35.9 % |
| C2 | 20–47 | 480 | 2.07:1 | 439,808 | 41.9 % |
| C3 | 18–49 | 544 | 1.82:1 | 503,296 | 48.0 % |

At 2:1 the ring family reads as concentric circles seen from above. At 4.43:1 it reads as
stacked lens shapes, which is the shipped defect and not a style.

The creature also stops eating the room. `Arena.tsx` clips the drawn rig at
`boss.y + BOSS_HIT_BOT`, where `BOSS_HIT_BOT = max(r.y + r.h) = 312` over `PART_HITBOXES` —
a **fixed** world y of 712 at `BOSS_SPAWN`, independent of `PIT_BOT`. So a taller pit gains
floor the creature cannot reach. Measured (`arena.py`, `parts/boss.svg` minus the `ground`
and `legs` groups `Boss.tsx` hides, placed at `translate(512−345, 400−405) scale(3)`):

```
boss-covered share of the pit    shipped 20.2 %   C1 12.5 %   C2 15.6 %   C3 16.0 %
```

*(`boss-arena.md` §2's "34.0 %" is stale in two ways: it rasterised whole-`boss.svg`
including the legs the renderer hides, and it clipped at `PIT_BOT + 1 = 608`, which is not
where the clip has been since `BOSS_HIT_BOT` was introduced.)*

---

## 2. What the art asks of the grid, and why

Three hard bounds. All three fail **silently** — no error, no test, just a wrong-looking or
unplayable room — so they are stated here in the form the grid agent can check.

### 2.1 The two rooms share one frame height, and that is the binding constraint

`app/src/render/viewport.ts`:

```
LOBBY_HEAD = 13 * MAP_TILE = 208      LOBBY_FOOT = 5 * MAP_TILE = 80
ROOM_H     = LOBBY_HEAD + (LOBBY_BOT + 1 - LOBBY_TOP) + LOBBY_FOOT
VIEW_ARENA = { y: PIT_BOT + 1 - ROOM_H, h: ROOM_H }
```

The arena's frame takes its **height from the lobby** — deliberately, so the gate move stays
a pure translate — and it is anchored to the pit rim. The module-load containment check
(`viewport.ts`, `HEAD = 48`) then requires every walkable unit plus 48 units of headroom to
be inside that frame. Written out, with `p` pit tile rows and `l` lobby tile rows:

```
16p + 48  <=  288 + 16l        =>        p <= l + 15
```

**Every row moved from the lobby into the pit spends the budget twice** — it adds 16 units
of pit and removes 16 units of frame. Rows taken from the boss's air above the pit (map rows
1–23, which no `ZONE_ARENA` player can ever stand on) cost 16.

Solved over the 64-row map (`p + l <= 60` after the border, doorway and gate rows):

```
shipped        p 14, l 23, air 23     slack 384 units
lobby 23 rows  ->  pit at most 37 rows,  0 rows of air left
lobby 22 rows  ->  pit at most 37 rows,  1 row
lobby 20 rows  ->  pit at most 35 rows,  5 rows
lobby 18 rows  ->  pit at most 33 rows,  9 rows
absolute max   ->  p 37 (592 units), l 22, air 1
```

So: **the pit can grow from 14 rows to at most 37, and it gets there by eating the boss's
air, not the lobby.** Two of the four candidates above are art geometry only, not feasible
grids as drawn — C2 (28 rows) needs a lobby of at least 13 rows and C3 (32 rows) at least 17;
laid out with the lobby squeezed to 11 and 7 rows they fail containment by 32 and 160 units.
That check throws at module load in DEV and is silent in a production build, which is exactly
how "I cannot see my character" shipped twice.

### 2.2 The boss may not rise more than four tile rows, and only with `WORST_RANGE` re-derived

`shoot.rs` is hitscan with `MAX_RAY_STEPS = MAP_TILES = 64` and the alpha-max-plus-beta-min
normaliser, so the *shortest* reach is `64 * 16 * 894 / 1000 = 915` units. The compile-time
assertion is written against `WORST_RANGE = 865`, and
`no_shot_at_the_boss_can_die_of_range` re-measures it over every floor tile in the generated
map — **including the lobby**, because the test does not know about zones.

Deepening or widening the pit is free: every pit tile is nearer the core than the lobby's far
corner already is. Moving the boss is not. Measured (`arena.py`, `reach_table`):

```
core = BOSS_SPAWN + (CORE_X, CORE_Y) = (587, boss_y - 54)
farthest floor tile is always the lobby's bottom-left, tile (1, 62), world (24, 1000)

  boss row 25 (y 400, today)   862 units   OK, and WORST_RANGE = 865 leaves 3 units of slack
  boss row 24 (y 384)          875         OK
  boss row 23 (y 368)          887         OK
  boss row 22 (y 352)          899         OK
  boss row 21 (y 336)          912         OK  -- the last one
  boss row 20 (y 320)          925         DIES OF RANGE
  boss row 19 (y 304)          937         DIES
  boss row 18 (y 288)          950         DIES
```

**`BOSS_SPAWN.y >= 336`.** Any lift at all also makes `WORST_RANGE = 865` stale, and a stale
`WORST_RANGE` disarms the compile-time reach check without failing it.

The recommendation is simpler: **leave the boss at row 25.** It is where the user put it, it
costs nothing, and `PIT_TOP` can pass above it freely — `map.rs` only asserts
`BOSS_SPAWN.y >= PIT_TOP`, knights are painted after the boss (`Arena.tsx` line 816 before
line 933), and raiders standing level with or above the creature are drawn in front of it.

### 2.3 The backdrop needs 312 units above `PIT_TOP`

`BossArena.tsx` paints image B's rear wall into the band
`BACKDROP_TOP = 16` .. `BACKDROP_BOT = PIT_TOP - 22`. Three of its shapes have **typed
heights** and will run out of that band:

| shape | drawn extent | needs |
|---|---|---|
| `STATUE_D` at `translate(x, BACKDROP_BOT − 260)` | 272 units tall (local y −12..260) | `PIT_TOP >= 310` |
| `CHAIN_PATH`, `V BACKDROP_TOP + 274` | ends at y 290 | `PIT_TOP >= 312` |
| `BANNER_PATH`, 186 + 20 from y 24 | ends at y 230 | `PIT_TOP >= 252` |

So with the shipped backdrop, **`PIT_TOP >= 312`** — tile row 20. Above that the statue's
horns cross the map's border row and the chains hang into the band a knight's sprite covers.
`BossArena.tsx`'s boot check tests only `BACKDROP_BOT > BACKDROP_TOP`, which is 296 units too
generous; §3.6 makes the backdrop scale and §7 extends the check.

---

## 3. Geometry, derived

Everything below is a constant expression over `MAP_GRID`, `PIT_TOP`, `PIT_BOT`, `GATE_MIN_X`,
`GATE_MAX_X`, `BOSS_SPAWN`, `CORE` and `SPRITE_H`. No world coordinate is typed.

### 3.1 The ring frame — keep, it is already right

```ts
const RING_CX = ARENA_UNITS / 2;
const RING_CY = (PIT_TOP + PIT_BOT + 1) / 2;
const RING_RX = (PIT_X1 - PIT_X0) / 2;
const RING_RY = (PIT_BOT + 1 - PIT_TOP) / 2;
```

`PIT_X0`/`PIT_X1` are compiled from `MAP_GRID`. The family is orthographic and clipped to
`PIT_PATH`, so the map's chamfer cuts the ellipse's corners for free and no ring line can
stop short of a walkable tile. **Do not perspective-correct it**: `PlayerSlot.x/.y` land in
the SVG unmodified, and a floor drawn where the chain's positions are not is the
disagreement this project has twice misdiagnosed as lag.

### 3.2 The course count must be derived, or a big floor reads as four huge rings

`RING_K = [0.22, 0.44, 0.65, 0.87, 1.0]` is five typed fractions. The fractions themselves
are scale-free — `boss-arena.md` §1.5 measured image B's mortar spacing at 0.21 of the
radius — but *five of them* is a count fitted to a 112-unit semi-minor axis. On a 240-unit
one the courses fall 50 units apart on the short axis, against the reference's 30.

Derive the count from the reference's own course spacing instead. Image B's floor has
geometric-mean radius `sqrt(418 * 120) = 223.9 px`; our arena is `496 / 418 = 1.187x` its
scale, so one course is `0.21 * 223.9 * 1.187 = 55.8` arena units. Round it to 56 and:

```ts
/** Image B's own mortar spacing at this arena's scale: 0.21 * sqrt(418*120) * (496/418). */
const REF_COURSE = 56;
const RING_N = Math.max(4, Math.round(Math.sqrt(RING_RX * RING_RY) / REF_COURSE));
const RING_K = Array.from({ length: RING_N }, (_, i) => (i + 1) / RING_N);
```

Which gives, and the minor-axis gap it lands on:

```
shipped  n 4  gap 28.0 u        C1  n 6  gap 34.7 u
C2       n 6  gap 40.0 u        C3  n 7  gap 38.9 u
```

Four rings on the shipped pit against today's five is within the measurement's own
resolution and is the correct degenerate case; the interesting rows are the big pits, where
the count grows with the floor instead of stretching over it.

Every course still reads at the recommended light. Mortar L8 against the floor 9–14 units
outside it, on the +x axis at the band's vertical centre (`arena.py`):

```
C2, n 6:  k 0.17  39/54    k 0.33  30/36    k 0.50  25/30
          k 0.67  38/46    k 0.83  14/21
C3, n 7:  k 0.14  39/54    k 0.29  32/38    k 0.43  28/35    k 0.57  21/31
          k 0.71  39/46    k 0.86  13/20
```

5 to 15 L8 of separation on every course of every candidate — `boss-arena.md` §5.5 calls
anything inside 1 L8 invisible, and nothing here is close to that.

### 3.3 Dais, medallions, steps

* **Dais** = ring `RING_K[0]`, filled one step lighter. Still no raised platform: the clip at
  `boss.y + BOSS_HIT_BOT` leaves the creature no visible bottom edge for one to sit under,
  and image B's dais reads as paving plus light, not as height.
* **Medallions** — 26 x 12 diamonds at the four cardinal points of
  `RING_K[Math.round(0.66 * RING_N) - 1]`. The 0.66 is image B's own: of the five medallions
  `boss-arena.md` §1.6 located, the east–west pair at (275, 382) and (832, 382) sits at
  `286 / 418 = 0.684` of the semi-major axis, and the shipped constant is 0.65. That lands on
  `k = 0.75` at `n = 4`, `0.67` at `n = 6` and `0.71` at `n = 7` — two courses in from the
  kerb at every count. Draw all four: the north one falls behind the creature and appears as
  limbs break, and drawing it keeps the composition symmetric for one extra subpath.
* **Steps** — `STEP_TOP = PIT_BOT + 1 - STEP_COUNT * STEP_H` across `GATE_MIN_X..GATE_MAX_X`
  is already derived. Keep it.

### 3.4 The floor is open, and this is the rule that keeps it open

Repeated from `boss-arena.md` §3.5 because it is the user's central complaint and it is
enforced by nothing but this paragraph:

> Anything drawn inside the pit band, or in the air above `PIT_TOP`, must read as **light**
> or as a **floor marking**, never as an object with mass. There is no collision for it —
> `is_wall` reads the bitboard and nothing else — so a barrel or a pillar painted on floor is
> a solid-looking thing players and arrows pass straight through, which reads as a chain bug.

The enlarged arena has *more* room to be tempted with and the same amount of permission:
none. Rings, medallions, treads, flames, and the wash. Nothing else touches the pit.

### 3.5 Braziers scale with the perimeter

`BRAZIERS` is derived today except for its count, which is asserted at exactly 12. Eight of
those sit on the far rim line at `PIT_TOP - 4`; on a 544-unit pit that leaves both long sides
dark for 500 units. Add side pairs at the reference's own flame spacing:

```ts
const FLAME_GAP = 160;                       // ~ image B's wall-brazier pitch at our scale
const sideRows = Math.max(0, Math.floor((PIT_BOT + 1 - PIT_TOP) / FLAME_GAP) - 1);
// one pair per side row, placed 12 units inside pitSpan(row) so they land on floor
```

`pitSpan(ty)` already exists in `BossArena.tsx` and returns the walkable span of a row, so
the flames follow the chamfer without a second geometry. That gives 12 flames on the shipped
pit (unchanged), 14 on C1, 16 on C2, 18 on C3.

**Flames must stay on walkable tiles.** `Arena.tsx` paints `MAP_WALL_PATH` opaque over every
`#` tile *after* this layer, so a flame on the kerb is drawn and then painted over —
invisible, with no error. The existing boot check catches that; §7 keeps it and drops the
`=== 12`.

A knight can therefore stand on a flame, and does. Measured, Nocturne over its own 33x42 box
(`arena.py`):

```
                        background box Y     Nocturne     (shipped pit / C2)
standing on a flame       0.0260 / 0.0262   3.68 / 3.67:1
one tile beside it        0.0197 / 0.0210   4.01 / 3.94:1
same spot, no flame       0.0072 / 0.0074   4.89 / 4.88:1
```

Still above 3:1, and better than the arena's own worst case (§5.3). The flames are a legible
cost, not a hazard — which is the direct consequence of `boss-arena.md` §1.3's finding that a
brazier in image B lights nothing past 15 px, so it is drawn as a flame and not as a lamp.

### 3.6 The backdrop scales off `BACKDROP_BOT`

Statue, chains and banners currently carry typed heights (§2.3). Express each as a fraction
of the band it lives in:

```ts
const BACKDROP_H = BACKDROP_BOT - BACKDROP_TOP;              // 346 on the shipped pit
// statue: scale(Math.min(1, BACKDROP_H / 288)) about its own origin -- never larger than it
//         ships, and 288 = the 272-unit silhouette plus 16 units of clearance at the top
// chains: V BACKDROP_TOP + 0.79 * BACKDROP_H     (274/346 on the shipped band)
// banner: height 0.54 * BACKDROP_H, point 0.06   (186/346 and 20/346)
```

Identical on the shipped pit — 274.3, 186.8, 20.1, and the statue clamped to scale 1 — and it
survives `PIT_TOP` moving up 300 units instead of failing off the top of the map. Pillars are
already derived and stay.

---

## 4. Light, re-solved over the whole pit envelope

The stack is `BossArena.tsx`'s and no layer is added or removed. Two of its members are
world coordinates fitted to the shipped band and must become derived; the rest are alphas
and re-solve to one setting that holds across the envelope.

### 4.1 The pool

```
shipped:    POOL_CY = 452     POOL_RX = 520     POOL_RY = 150
derived:    POOL_CX = BOSS_SPAWN[0]
            POOL_CY = PIT_TOP + 0.30 * (PIT_BOT + 1 - PIT_TOP)
            POOL_RX = 1.05 * RING_RX
            POOL_RY = 0.67 * (PIT_BOT + 1 - PIT_TOP)
```

On the shipped pit that is (512, 451, 521, 150) against the typed (512, 452, 520, 150) —
the same light, now expressed as what it *is*: a pool centred under the creature, overshooting
the floor so the rim reads as unlit rather than as the end of a gradient.

Why it cannot stay typed: a 150-unit semi-minor axis covers 100 % of a 224-unit band but
**only 79 % of a 544-unit one** (`arena.py`). The far rows would fall to the bare wash, and
§3.2's outermost courses — already the dimmest at L8 13–15 — would go invisible out there.

### 4.2 The wash region, the ceiling and the rim band

* **Wash region** — the pit path plus `SPRITE_H − FEET_Y = 22` units above `PIT_TOP`, already
  derived as `WASH_ABOVE_PIT`. Keep. It is what stops a knight standing on the pit's top row
  from being drawn against un-washed masonry.
* **`CEILING_END = 330`** is typed and means "just past the pit's top edge". Derive it:
  `CEILING_END = PIT_TOP - 54`, which reproduces 330 today and keeps the creature emerging
  from darkness when `PIT_TOP` moves. At `PIT_TOP` below ~120 the ceiling has nowhere to
  fall and the term should clamp to `BACKDROP_TOP`.
* **`RIM_SHADOW = [520, 600, 700]`** is typed and is the band peaking on the rim wall.
  Derive: `[PIT_BOT - 87, PIT_BOT - 7, PIT_BOT + 93]`, which reproduces the shipped triple
  exactly and keeps the near-rim shadow on the rim.

### 4.3 The alphas, solved

Same method as `boss-arena.md` §5.4 — binary search one gain `g` over every added-light layer,
at each wash opacity, taking the largest `g` that still holds the darkest skin at 3.00:1 worst
case — but run over **four pit sizes at once** and taking the minimum, so the answer is not
fitted to one candidate:

```
                shipped   C1      C2      C3      min
wash 0.45   g    0.707   0.751   0.709   0.707    0.70
wash 0.70   g    0.938   0.999   0.948   0.940    0.93
wash 0.82   g    1.016   1.091   1.054   1.043    1.01
```

**The solved gain barely moves with pit size** — 0.94 to 1.00 at wash 0.70 across a pit that
grows by half again in height, with the course count moving underneath it. That is the answer
to "how does this scale": it does not need to. One setting spans the envelope.

> **Re-run**, because two things under this table moved after it was first taken. The
> `18-open-arena` bitboard changed the *shipped* column (its pit went 726 → 842 walkable
> tiles), and `arena.py`'s ring loop was modelling geometry `BossArena.tsx` no longer draws —
> a lit band on the `r > k` side of the mortar ellipse at α 0.60, where the file draws a
> 2-unit crest on the concentric ellipse `KERB` units *inside* a 3-unit joint at α 0.92. The
> `shipped` column moved most (0.984 → 0.938 at wash 0.70) because it is the only column the
> map rebuild touches; C1–C3 are synthetic candidates and barely move. **The binding minimum
> is 0.93 and the shipped `GAIN` is 0.92, so the recommendation below is unchanged** — it is
> still one notch under the tightest solve, which is the property it was chosen for.

**Take wash 0.70, g 0.92** — one notch under the tightest solve, so the target is met with
margin on every candidate rather than exactly on one. That is a **2.0x lift on every added-
light alpha** against `BossArena.tsx`'s shipped `g = 0.46`:

| layer | α before this spec | this spec | base × 0.92 |
|---|---|---|---|
| pit wash `#03070f` | 0.70 | 0.70 | (not gained) |
| dais `#8fb6cf` | 0.046 | 0.092 | 0.10 |
| mortar `#04070d` | 0.60 | 0.60 | (not gained) |
| lit course `#a8d6f0` | 0.074 | 0.147 | 0.16 |
| medallion `#9fc4dc` | 0.060 | 0.120 | 0.13 |
| medallion line `#04070d` | 0.50 | 0.50 | (not gained) |
| pool `#96cdeb` | 0.064 | 0.129 | 0.14 |
| core spill `#6ee1ff` | 0.046 | 0.092 | 0.10 |

The dark layers are not gained: they are the floor the light is spent against, and gaining
both ends is a contrast knob that cancels.

**Shipped.** `BossArena.tsx` carries `GAIN = 0.92` and this whole column, so the first column
is history and is labelled as such — it is not what the file reads today. One row moved on
its own afterwards: **`MORTAR_ALPHA` is 0.92, not the 0.60 above.** That is not a gain, it is
the joint being re-solved once the light around it doubled — at 0.60 over a floor twice as
bright the courses stopped reading, which is the defect `boss-arena.md` §5.5 measures.

---

## 5. Legibility, measured

### 5.1 The model, and what validates it

`docs/art/arena.py` composites the scene in sRGB out of the shipped sources and is checked
against three numbers this codebase arrived at independently before any new number is read
off it:

| check | this model | what the codebase says |
|---|---|---|
| graded temple over the pit band | sRGB (41, 50, 65), mean channel 51.9 | `Scene.tsx` `TEMPLE_GRADE`: "(41, 50, 65) … 51.9" |
| skin body relative luminance | 0.1678 / 0.1136 / 0.1303 | `Scene.tsx` `PIT_POOL_ALPHA` doc, same three |
| the drawn rig | `parts/boss.svg` minus {ground, legs}, cut at `boss.y + 312` | `Boss.tsx` `HIDDEN`; `Arena.tsx` `BOSS_HIT_BOT` |

Contrast is taken against the **mean linear luminance of the 33 x 42 box the knight covers**
(`SPRITE_W`/`SPRITE_H`/`FEET_Y` from `Knight.tsx`), not the single unit under its feet. That
is what the eye integrates, and it is the difference between a metric that says a 1-unit
mortar line ruins the floor (it does not) and one that says a broad pool does (it does).

### 5.2 The figure luminances have moved, and `boss-arena.md` §5.1's are stale

The rim that forms a knight's silhouette edge is now the generated `halo` group — the union
dilated two units, minus itself — and `SKIN_KEY` was brightened from `#95b4da`/`#d5aa9a` to
`#a8c1e0`/`#dcb7aa`/`#bebec9`. Re-measured off the shipped `knights.gen.ts`:

```
skin       body px   Y_body    halo rim px   Y_key    Y_figure
Cobalt        745    0.1678         248     0.5185    0.2554
Nocturne      678    0.1136         272     0.5198    0.2299
Argent        653    0.1303         273     0.5199    0.2452
```

`boss-arena.md` §5.1 has 86 / 96 / 103 rim pixels and `Y_figure` 0.1960 / 0.1556 / 0.1755 —
those describe the deleted one-sided key light, not what ships. **Nocturne is still the
binding case**, but at Y 0.2299 rather than 0.1556, which is why its measured failing area
today is 0.3 % of the pit and not §5.2's 41.9 %. Quote these, not those.

*(Related: `docs/art/legibility.py` no longer runs against the current sheet — it looks up
`<g id="kCobalt-rest">` and the groups are `k0`/`k1`/`k2`. It raises `ValueError` on import.
Not fixed here; flagged so the next person does not read its numbers as current.)*

### 5.3 The result, at wash 0.70 / g 0.92

Over every walkable unit the drawn rig does not cover, on each candidate:

```
pit         units      bg box Y                  Cobalt          Nocturne        Argent        under 3:1
                    p50     p95     max      worst  p5  p50    worst  p5  p50   worst  p5  p50
shipped   148,242  .0121  .0332  .0400     3.39 3.67 4.91   3.11 3.36 4.50   3.28 3.55 4.75   0.00 %
C1        329,232  .0114  .0306  .0395     3.41 3.79 4.97   3.13 3.48 4.56   3.30 3.66 4.80   0.00 %
C2        371,396  .0111  .0312  .0420     3.32 3.76 5.00   3.04 3.45 4.58   3.21 3.64 4.83   0.00 %
C3        422,971  .0110  .0312  .0424     3.30 3.76 5.01   3.03 3.45 4.59   3.19 3.64 4.84   0.00 %
```

**Worst case 3.03:1 on the darkest skin, 0.00 % of any candidate pit under 3:1, on a pit that
ranges from 224 to 544 units tall.** Against the shipped build measured the same way —
Nocturne worst 2.61:1, 0.3 % of the pit failing — that is the last of the failing area closed
and half a contrast unit of margin bought (2.61 → 3.11 on the same pit).

The worst unit is not at an edge. It sits dead centre under the pool, at world (538, 531) on
C2 and (539, 525) on C3, in the brightest floor in the room. That is the correct place for it
to be: the budget is being spent where the fight is.

### 5.4 What it costs, stated

```
share of pit floor below L8 15 (too dark to carry drawn stone detail)
   shipped light on each pit      shipped 2.2 %   C1 5.5 %   C2 5.7 %   C3 6.1 %
   this spec's light              shipped 9.2 %   C1 10.1 %  C2 10.2 %  C3 12.3 %
```

10–12 % of the enlarged floor is too dark to show paving. It is not scattered: **78–87 % of
those units sit at ring radius > 0.87**, and 19–36 % of the apron outside `k = 1.0` is in it.
That is the kerb and the space between the outermost course and the wall — which is exactly
where image B is dark too, and it is the price of a wash deep enough to hold 3:1 on twenty
figures. If it is ever judged too dark, the lever is the wash, and §4.3's table says what the
gain becomes at each setting.

### 5.5 What this layer still cannot fix

Unchanged from `boss-arena.md` §5.6 and re-stated because the enlargement does not touch it:
a knight standing in front of the creature reads against the graded boss body, not against
the floor, at **1.77:1 in the worst case**. The arena layer is behind the boss. The lever is a
scrim between the boss and the knight layer or a stronger key light, and it belongs to
`Boss.tsx`/`Knight.tsx`. §1.3's finding that the creature covers a *smaller share* of a bigger
pit (20.2 % → 12.5–16.0 %) shrinks the affected area; it does not change the ratio.

Likewise `PAL.rim` `#413a4f` (Y 0.0471) and `MAP_ENTRANCE_PATH`'s `#b5b56a` at 0.18
(Y 0.0365) are painted by `Arena.tsx`'s wall layer over walls and the four respawn tiles.
Both are over the 3:1 cap on their own and neither is this layer's to fix.

---

## 6. The eleven constants that must stop being typed

The whole delta, as a checklist against `app/src/render/BossArena.tsx`:

| line | constant | today | becomes |
|---|---|---|---|
| 157 | `RING_K` | 5 typed fractions | `RING_N` from `sqrt(RING_RX*RING_RY)/56`, §3.2 |
| 163 | `MEDALLION_K` | `RING_K[2]` | `RING_K[round(0.66 * RING_N) - 1]`, §3.3 |
| 230 | `BRAZIERS` far-rim `dx` | `[136, 282, 391, 478]` | fractions of `RING_RX`: `[0.27, 0.57, 0.79, 0.96]` |
| 230 | `BRAZIERS` side pairs | absent | `FLAME_GAP`, §3.5 |
| 285 | `CHAIN_PATH` height | `274` | `0.79 * BACKDROP_H`, §3.6 |
| 288 | `BANNER_PATH` height | `186` + `20` | `0.54` / `0.06` of `BACKDROP_H`, §3.6 |
| 542 | `STATUE_D` transform | `translate(x, BACKDROP_BOT − 260)` | + `scale(min(1, BACKDROP_H / 288))`, §3.6 |
| 347–349 | `POOL_CY/RX/RY` | `452 / 520 / 150` | §4.1 |
| 352 | `CEILING_END` | `330` | `PIT_TOP − 54`, §4.2 |
| 353 | `RIM_SHADOW` | `[520, 600, 700]` | `[PIT_BOT−87, PIT_BOT−7, PIT_BOT+93]`, §4.2 |
| 321–327 | the six gained alphas | `g = 0.46` | `g = 0.92`, §4.3 |

Two more outside this file, both of which a moved `PIT_BOT` breaks today:

* `Arena.tsx:1155` — `ok(PIT_BOT + 1 - 2 * MAP_TILE === 576, …)`. A **typed 576** in a
  self-check whose whole job is to notice the rim clip drifting. It throws at module load in
  DEV the moment the pit moves, which is the good failure, but the fix is to assert the
  relationship (`the clip covers exactly the last two pit rows`) rather than the number.
* `Scene.tsx:284` — the lobby scene's pool still carries `scale(470 215)` against
  `(PIT_TOP + PIT_BOT) / 2`. `SCENE` is the lobby layer now, so a moved pit silently drags its
  pool somewhere the lobby is not.

---

## 7. The boot check, extended

`BossArena.tsx`'s import-time block is the right shape and catches most of the silent
failures. Four additions, all one-liners, all for failure modes the enlargement introduces:

1. `BRAZIERS.length === 12` → `BRAZIERS.length === 12 + 2 * sideRows`, or drop the count test
   and keep the on-floor and mirrored tests, which are the ones that matter.
2. **Backdrop fits its band**: the tallest drawn backdrop shape must end above
   `BACKDROP_BOT`, and start below `BACKDROP_TOP`. §2.3's three overruns are all invisible.
3. **The pool reaches the floor**: `POOL_RY >= (PIT_BOT + 1 - PIT_TOP) / 2`, so the far rows
   are never outside the gradient entirely.
4. **Every course is inside the pit**: `RING_N >= 4` and `RING_RY / RING_N >= 12`, so a very
   flat pit cannot produce courses closer together than the mortar is wide.

The viewport containment check in `viewport.ts` and the range check in `shoot.rs` already
cover §2.1 and §2.2 — they need no help, only a grid that respects them.

---

## 8. Chain impact: none

Nothing in this document reaches the program.

* **No new account bytes.** No field on `Arena`, `Boss` or `PlayerSlot` is read or added. The
  layer is a pure function of `MAP_GRID`, `PIT_TOP`, `PIT_BOT`, `GATE_MIN_X`, `GATE_MAX_X`,
  `BOSS_SPAWN`, `CORE` and `SPRITE_H`.
* **No new instruction and no new CU.** The pit's *size* changing is the grid agent's change
  and recompiles `map.rs`; nothing in this file adds work to `boss_tick` or `shoot`.
* **No new notification traffic.** `BOSS_ARENA` is a module-scope element with no props and
  cannot be re-rendered by a `Players` notification.
* **The ER path is untouched.** Nothing here sends, signs, or reads an account, so the
  measured p50 131 → 131.5 ms at twenty seats is not this layer's to move.

**On the one thing a chain-side measurement cannot see:** node count. Ring courses, medallions
and treads are one `<path>` per role with `n` subpaths, so the count is constant in `RING_N`.
Braziers add three subpaths each, so the enlargement's extra flames add 6 to 18 subpaths
across three existing paths and **no new elements**. `BOSS_ARENA`'s subtree is 31 elements
today — 11 `rect`, 11 `path`, 6 `g`, 3 `ellipse`, counted off the source — and stays 31.
Nothing in this spec adds a node that moves, and the layer is promoted
(`will-change: transform`) and rasterised once, which is why `temple-scene.md` §3.3 measured
the same scene with and without the whole gradient stack at 3.5 ms against 3.5 ms. The frame
budget in `docs/perf/frame-budget.md` — p50 9.38 ms, p95 14.92 ms at 20 knights under 6x CPU
throttle — is a per-frame figure over movers and is untouched by a layer that never moves.
**That is an argument, not a measurement. Re-measure it on the enlarged pit before shipping**
— the pit path grows from 185,856 to up to 503,296 units of clipped fill, which is more
raster area on the promoted layer even though it is no more geometry.

---

## 9. What was cut

* **Per-brazier light pools.** `boss-arena.md` §1.3 measured that image B's braziers light
  nothing past 15 px, and §4.3 has no budget for eighteen pools. Flames only, and §3.5
  measured that a knight standing on one still reads at 3.65:1.
* **A raised dais.** The rig's clip leaves it no visible bottom edge to sit under.
* **Perspective floor rings.** The floor plane is the coordinate space; see §3.1.
* **Props, cover, blocks, or anything with mass on the pit floor.** §3.4. This is the user's
  central request and the reference's own rule.
* **Moving the boss up to make room.** §2.2: four rows of headroom, bought at the price of a
  stale `WORST_RANGE` and a compile-time check that stops checking. `PIT_TOP` can pass above
  the creature instead, for free.
* **Taking pit rows from the lobby.** §2.1: it spends the frame budget twice per row, and the
  user asked for both rooms to be large.
* **Re-deriving image B.** `boss-arena.md` §1 did it once and none of it is scale-dependent.

## 10. Open risks

1. **The 3:1 target is a choice.** WCAG 3:1 is a UI-component threshold, not a games standard.
   §4.3 is re-solvable at a different bar; `arena.py` takes it as one constant.
2. **The model has not been checked against a screenshot.** It composites in sRGB the way the
   CSS filter shorthands are specified and reproduces three numbers the codebase measured
   independently (§5.1), but not a pixel of the shipped page. That check is one screenshot and
   one luminance read, and it should run before the constants land.
3. **The raster-area claim in §8 is reasoned, not measured.** The pit fill more than doubles.
4. **`REF_COURSE = 56` is one measured number carrying the whole course count.** It comes from
   image B's 0.21-of-radius spacing at our arena's scale. If the pit ends up far from
   `RING_RX = 496` the ratio, not the constant, is what should carry.
5. **The four candidate pits are the art's envelope, not the grid's answer.** C2 and C3 as
   drawn here fail §2.1's containment when the lobby is squeezed to make room for them. The
   light settings hold for any pit in 224–592 units; the grid still has to be a legal one.
