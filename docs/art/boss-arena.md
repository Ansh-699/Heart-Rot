# Boss arena — specification

Source of truth for what the FIGHTING scene looks like: the circular arena of
`/home/anshtyagi/Downloads/actual_boss_arena.png` (image B), rebuilt over the generated pit
bounds as SVG, with the creature fixed TOP CENTRE where the user asked it to stay.

Nothing here is implemented. Every number says how it was obtained. Measurement scripts are
throwaway and live in the scratchpad; the three that matter are named inline.

**Chain impact: none. Zero new bytes, zero new instructions, zero CU.** See §9.

Companion specs: `docs/art/temple-scene.md` (the backdrop asset this sits on top of),
`docs/art/boss-rig.md` (the creature), `docs/art/knights.md` (the avatars). Where they fixed
a number this document uses theirs and says so.

---

## 1. What is actually in image B

Measured, not described. `actual_boss_arena.png` is 1122x612; rows 0..13 are a white scan
artefact (row 12 mean L 226.9) and every number below is taken from the 1122x598 crop below
them. Luminance is Rec.709 on 8-bit sRGB, written `L8`.

### 1.1 It is a dark picture with four bright pixels in it

```
L8 over the whole frame:  p1 4.1   p5 7.5   p25 12.6   p50 21.4   p75 35.6   p95 66.1   p99 89.3
```

Half the frame is below L8 21. The only things above L8 150 are the twelve brazier flames
(peak L8 232) and a handful of bone highlights on the creature (peak L8 183). Cyan-hot pixels
— `(G+B)/2 - R > 35` and `L8 > 55` — are **4,452 px, 0.66 % of the frame**.

The composition rule follows from that and is the one thing that must survive the port:
**the frame is dark, and light is spent in a few small places.** Not a dim scene; a dark
scene with lamps in it.

### 1.2 The light sources, located

Cyan blobs clustered with `scipy.ndimage.label` (scratchpad `ref4.py`). Twelve, symmetric
about x = 561:

| where | positions (x, y) | peak L8 |
|---|---|---|
| rear wall, four symmetric pairs | (83, 209) (164, 211) (276, 190) (425, 149) / (692, 151) (843, 198) (952, 211) (1039, 209) | 129 – 226 |
| front corner pedestals | (32, 486) (1088, 489) | 223, 230 |
| flanking the steps | (433, 546) (674, 549) | 218, 232 |

Pairs check out: 561−83 = 478 against 1039−561 = 478; 561−164 = 397 against 952−561 = 391;
561−276 = 285 against 843−561 = 282; 561−425 = 136 against 692−561 = 131.

### 1.3 **The braziers light nothing.** This is the most useful measurement in the file

Mean L8 on rings of increasing radius around two flames (`ref8.py`):

```
wall brazier (843,195)     d=0 154   d=10 38   d=20 24   d=30 28   d=45 23   d=60 22   d=110 31
front step brazier (674,549) d=0 143  d=10 49   d=20 28   d=30 24   d=45 17   d=60 25   d=110 32
```

The stone around a flame is back at the scene's ambient (L8 20–35) **within 15 px**. There is
no falloff to model, no light pool per brazier, no pedestal wash. A brazier in image B is a
sprite that is bright, plus a few pixels of bloom, and nothing else.

That kills the obvious implementation before it is written. Twelve radial gradients with real
radii would put twelve pools of light on the floor the raid stands on — light the reference
does not have, spent against the one budget (§6) that decides whether the knights are visible.

### 1.4 The one real light is the floor pool, and it is centred on the creature

Floor sampled on a grid, 9x9 patch means (`ref8.py`):

```
           x=200   x=330   x=460   x=561   x=660   x=790   x=920
y=350       32.1    53.5    75.9    69.5    67.9    54.9    31.0
y=390       23.4    48.4    57.3    56.2    58.2    47.8    28.8
y=430       24.8    34.6    49.8    50.3    48.6    34.6    33.2
y=470       20.3    40.2    40.9    39.5    33.5    40.0    22.9
```

Brightest floor is x 460–660, y 340–410 — directly under and in front of the creature — at
L8 70–76, falling to L8 20–33 at the sides and the near edge. Binned by elliptical radius
about (561, 385) with semi-axes (418, 120), near half only (`ref9.py`):

```
r      0.10  0.30  0.50  0.70  0.86  1.00
L8     73.4  59.0  48.1  37.6  27.5  28.7
```

**Centre-to-rim ratio 2.7:1, close to linear in r.** One radial falloff, centred on the boss,
is the whole lighting model of image B's floor.

One detail worth keeping: the hottest floor sample is `#483f43` — R > B. The scene is cold
everywhere (B > R by 8–16) *except* at the very centre of the pool, which is neutral-warm.

### 1.5 Floor geometry: concentric rings, and their radii

Same elliptical binning, with the smooth falloff subtracted so the paving shows as residual
(`ref9.py`). Heavy dark mortar lines at

```
r = 0.44   0.65   0.87        spacing 0.21, and a bright course at r 0.90..0.95 (+4.4 L8)
                              immediately OUTSIDE the darkest line at 0.87
```

plus finer courses at r 0.17–0.33 inside the dais. So: **four ring boundaries at k ≈ 0.22,
0.44, 0.65, 0.87 of the radius, then the lit kerb, then the wall.** The bright band outside
the last dark line is the kerb's top face catching light — the same cue `MAP_RIM_PATH`
already draws on every wall in this game.

The floor's outer boundary is not a true ellipse: fitting the near half gives semi-minor
117 at y = 480 but 98 at y = 440, because image B is a perspective view and the near half is
compressed more than the far half. **Do not port the perspective** — §3.1.

### 1.6 Medallions

Square inset panels with a carved diamond/star, ~30x18 px, read off the brightened crop
(scratchpad `floorstrip.png`): (307, 268) (812, 267) (275, 382) (832, 382) (560, 440). Two
symmetric pairs plus one at bottom centre. In a top-down projection they are the cardinal and
diagonal points of one ring; the near one appears at a smaller radius only because of the
perspective in §1.5.

The motif already exists in this project: `temple.svg` carries carved lozenges through its
whole masonry face (rendered at 4x, scratchpad `temple.png`). Reuse the read, do not invent a
new one.

### 1.7 Everything else, and its palette

7x7 patch means (`ref8.py` and the follow-up sampler):

| element | hex | L8 |
|---|---|---|
| brazier flame core | `#31b2b9` | 151 |
| flame halo, 9 px out | `#0f323b` | 44 |
| lit floor under the boss | `#483f43` | 66 |
| mid floor | `#2c2b35` | 44 |
| outer floor | `#1b202b` | 32 |
| steps tread | `#282b36` | 43 |
| front kerb top | `#060e18` | 13 |
| rear wall stone | `#30262d` | 41 |
| pillar face | `#0e1723` | 22 |
| banner (purple) | `#392d31` | 48 |
| demon statue | `#10131d` | 19 |
| hanging chain | `#0a0f1a` | 14 |
| void | `#060a13` | 10 |

Behind the creature: a brick rear wall broken by tall pillars, four purple banners with pale
horned-skull crests, two large carved demon statues at x ≈ 215 and x ≈ 905, and four hanging
chains at x ≈ 40, 290, 830, 1085. At the bottom: a low kerb wall of blocks running left and
right of a flight of ~6 steps at x 470..655, two horned-skull posts flanking the steps, and a
large horned skull on each front corner pedestal.

---

## 2. What the map allows

Everything below is read out of `assets/map/arena.json` and the constants `gen_map.py` emits.
No number in this document is a second copy of a number that lives there.

```
pit rows            24..37        PIT_TOP 384   PIT_BOT 607      (224 units tall)
pit x, rows 24..32  tiles 1..62   world 16..1007                 (992 units wide)
        row 33      tiles 3..60   world 48..975
        row 34      tiles 5..58   world 80..943
        row 35      tiles 8..55   world 128..895
        rows 36,37  tiles 30..33  world 480..543   <- the doorway, and the only way in
gate                480..543 x 608..639
BOSS_SPAWN          (512, 400)    CORE_WORLD (587, 346)          (hitboxes.ts, generated)
walkable            721 tiles = 184,576 units = 17.6 % of the 1024 square
```

The pit is **4.43:1**, not the reference's 3.48:1. That is a difference in camera pitch, not a
disagreement: image B is a three-quarter view of a circle, ours is closer to straight down, and
a circle seen from higher up is a *wider* ellipse. `arena.json`'s own README already says the
corner shaping on rows 33–35 exists "so it reads as an ellipse". This spec finishes that job.

**The boss covers a third of the pit.** `parts/boss.svg` rasterised and placed exactly as
`Boss.tsx` places it — `translate(512 − 345, 400 − 405) scale(3)`, clipped at `PIT_BOT + 1` —
paints **62,760 of the 184,576 walkable units, 34.0 %** (scratchpad `arena.py`). By band:
33.3 % of rows 24–27, 28.6 % of 28–30, 37.2 % of 31–34, 41.9 % of 35–37. Floor decoration
under the creature is decoration nobody sees; §3.4 places the medallions accordingly.

---

## 3. Geometry

All of it lives in the static `SCENE` element (`app/src/render/Scene.tsx`), between the pit
wash and the lighting stack. No props, no state, no chain input — see §8.

### 3.1 The ring family

```
centre       (ARENA_UNITS / 2, (PIT_TOP + PIT_BOT + 1) / 2)     = (512, 496)
semi-axes    ((PIT_X1 − PIT_X0) / 2, (PIT_BOT + 1 − PIT_TOP) / 2) = (496, 112)
rings at k = 0.22, 0.44, 0.65, 0.87, 1.00
             rx = 109, 218, 322, 432, 496
             ry =  25,  49,  73,  97, 112
```

`PIT_X0`/`PIT_X1` are already compiled from `MAP_GRID` in `Scene.tsx`; `PIT_TOP`/`PIT_BOT`
come from `@heartrot/client`. Nothing here is typed twice. k comes from §1.5's measured 0.21
spacing.

**Concentric, orthographic, and NOT perspective-corrected.** The floor plane *is* the
coordinate space: `PlayerSlot.x` and `.y` land in the SVG unmodified (`sprites.ts`
`ARENA_UNITS`). A perspective floor would draw the rings somewhere the chain's positions are
not, and this project has twice misdiagnosed exactly that class of disagreement as lag.

### 3.2 The floor is the pit path, and the ellipse is clipped to it

The ellipse and the pit disagree at both ends, measured:

* **13,991 units inside the k=1.0 ellipse are wall** — the corner shaping on rows 33–35.
* **25,366 walkable units (13.6 %) are outside it** — the far left and right of rows 24–32.

So the two must not be confused for one another:

1. The **floor** is `PIT_PATH`, the existing tile path compiled from `MAP_GRID` in
   `Scene.tsx`. It already covers every walkable unit and nothing else. It stays the floor.
2. The **rings** are drawn inside `<clipPath>` holding that same `PIT_PATH`. The chamfer then
   cuts the ellipse's corners for free — no second geometry, no generated table, no chance of
   a one-tile disagreement.
3. The 13.6 % outside ring k=1.0 is the **apron**: still floor, still walkable, drawn flat and
   dark. In image B this is the space between the kerb and the wall.

A ring line that stopped short of a walkable tile, or an apron drawn as if it were wall, is
the same defect the wall layer exists to prevent. `Arena.tsx:583` keeps painting
`MAP_WALL_PATH` on top of all of this; nothing in this spec goes over a wall.

### 3.3 The dais

**No raised platform.** Two reasons, in order:

1. It would not be seen. The creature covers 34 % of the pit (§2) and is clipped flat at
   `PIT_BOT + 1`, so it has no visible bottom edge for a platform to sit under.
2. Image B's dais reads as *paving plus light*, not as height — the inner disc is a finer
   square grid under the brightest part of the pool.

So the dais is ring k=0.22 filled one step lighter than the floor, and the pool centred on it.
Measured at the recommended settings (§5.4): dais centre L8 31.2, floor at k=0.35 L8 28.2,
pit rim at k=1.0 L8 20.5. The fill itself is worth only **+3.0 L8** — most of the dais read is
the pool, and that is the correct division of labour: the platform is where the light is.

### 3.4 Medallions

Diamonds, 26 x 12 units (2.2:1, foreshortened like everything else in the pit), at the four
cardinal points of ring k = 0.65:

```
N (512, 423)   S (512, 569)   W (190, 496)   E (834, 496)
```

N sits inside the boss's silhouette and W/E sit outside its 167..857 span, so **W, E and S are
the three that are always visible**; N appears as limbs break and when the creature dies. Draw
all four: one `<path>`, four subpaths, and the composition stays symmetric.

Fill is a light step, outline is a dark step (§5). Measured at the recommended settings, the
south medallion at (512, 569): **L8 17.8 against L8 12.8** for the floor 40 units east — a
5.0 L8 step, 1.39x, on a floor whose whole local range is L8 11–33.

### 3.5 The steps, the kerb, and where objects with mass are allowed

The doorway is tiles 30..33 of rows 36..37 — world x 480..543, y 576..607 — and it is `P`,
walkable, the single entrance from the gate. Draw four treads of 8 units across that span,
darkest at the bottom, in the same value pair as the ring mortar/highlight. That is the
"steps where the gate lets players in".

The kerb is the top face of the rim wall, rows 36..37, x 0..479 and 544..1023. It is already
drawn — `MAP_RIM_PATH` paints a 3-unit lit face on every wall tile with floor above it. Image
B's bright band outside the outermost mortar line (§1.5) is the same cue. Do not add a second.

**The rule that keeps this honest:** anything drawn inside the pit band or in the boss's air
above `PIT_TOP` must read as *light* or as a *floor marking*, never as an object with mass.
There is no collision for it — `is_wall` reads the bitboard and nothing else — so a barrel or
a pillar painted on floor is a solid-looking thing players and bullets pass through, which
reads as a chain bug. Objects with mass go only on `#` tiles.

That leaves exactly these spots for them, from the map in §2:

| feature | legal tiles | world |
|---|---|---|
| corner pedestals + horned skulls (image B's front corners) | rows 33–35, tiles 0..7 and 56..63 | the chamfer |
| kerb posts flanking the steps | rows 36–37, tiles 26..29 and 34..37 | x 416..479, 544..607 |
| rear pillars, banners, statues, chains | rows 1..23 are open floor — **not** wall | see below |

The back wall of image B has no counterpart on this map: rows 1..23 are open floor, and they
are open *on purpose* — `shoot`'s raycast tests `is_wall` before the part rectangles, so one
wall tile above the pit kills every shot in that column (`map.rs` `PIT_TOP` doc, and the
`const _` assertion that enforces it). The rear wall, pillars, banners, statues and chains are
therefore **backdrop, painted into the dark above the rim, with no mass and no wall tile** —
which is what `temple.svg` already is. §4's ceiling gradient is what makes them read as
receding rather than as things you could walk into.

### 3.6 Braziers

Twelve, mirrored about x = 512, following §1.2's pairs scaled to our width:

* **Eight on the far rim line**, at `PIT_TOP − 4`, x = 512 ± 136, ± 282, ± 391, ± 478 —
  flames only, no bracket, no pedestal (they sit over open floor; §3.5).
* **Two on the chamfer corners**, rows 34–35, on wall — these may have pedestals.
* **Two flanking the doorway**, rows 36–37 at x ≈ 456 and 568 — on wall, pedestals allowed.

Each is a flame, not a lamp: a 6 x 10 unit teal shape at `#31b2b9` with a 9-unit halo at
`#0f323b`, and **no radial gradient on the floor**. §1.3 measured that image B's braziers
light nothing past 15 px; §6 is why we cannot afford to be more generous than the reference.

---

## 4. Light

The existing stack in `Scene.tsx` is already image B's stack. This spec re-zones it and
re-solves its constants; it does not add a layer.

| # | layer | what it is | change |
|---|---|---|---|
| 1 | pit wash | `#03070f` over `PIT_PATH` | **opacity 0.45 → 0.70, and the region extends 22 units above `PIT_TOP`** (§4.1) |
| 2 | dais | ring k=0.22 filled `#8fb6cf` | new, α 0.046 |
| 3 | ring courses | mortar `#04070d` α 0.60, lit upper edge `#a8d6f0` α 0.074 | new |
| 4 | medallions | `#9fc4dc` α 0.060, outline `#04070d` α 0.50 | new |
| 5 | pool | radial `#96cdeb`, **centre (512, 452), semi-axes (520, 150)**, α 0.064 → 0 | re-centred and re-solved |
| 6 | core spill | radial `#6ee1ff` at `CORE_WORLD`, r 330, α 0.046 | 0.10 → 0.046 |
| 7 | rim shadow | `#03060c`, band 520/600/700, peak 0.72 | unchanged |
| 8 | vignette | `#000000`, 0 at 52 %, 0.72 at 100 % | unchanged |

The pool moves off the pit's geometric centre (496) up to y = 452, because §1.4 measured image
B's pool centred on the creature and ours stands at the top of the band. Semi-axes 520 x 150
overshoot the pit deliberately: the falloff should still be dropping where the floor ends, so
the rim reads as unlit rather than as the end of a gradient.

### 4.1 The wash has to start one knight above the pit

A knight is 33 x 42 units drawn 1:1 into arena space (`Knight.tsx`, `SPRITE_W`/`SPRITE_H`,
`FEET_Y = 20`), so **22 of its 42 units are above its feet**. A raider standing on the pit's
top row is therefore drawn from y = 362, against the *un-washed* temple masonry and the full
strength of the core spill.

That is where the worst legibility in the shipped build actually is. Modelled, the shipped
build's worst standing position is world (724, 384) — the pit's top row — at a background box
luminance of Y 0.0501, more than twice the median. Extending the wash region up by 22 units
costs one changed mask and takes that hot spot out.

---

## 5. Legibility: measured, not asserted

This section exists because `sprites.ts` once carried "ally 4.35:1" and the real figure was
1.91:1. Everything below is reproduced from the shipped source in one script
(scratchpad `arena.py` + `knights.py`), and the model is validated against three numbers this
codebase already measured independently:

| check | this model | what the codebase says |
|---|---|---|
| graded temple over the pit band | sRGB (41, 50, 65), mean channel 51.9 | `Scene.tsx`: "(41, 50, 65) … 51.9" |
| skin body relative luminance | Cobalt 0.1678, Argent 0.1303, Nocturne 0.1136 | `Scene.tsx` `PIT_POOL_ALPHA` doc, same three |
| key-light rim pixel counts | 86 / 96 / 103 | `Knight.tsx` `SKIN_KEY` table, same three |

### 5.1 The figure, and the right way to measure it

Contrast is computed against the **mean background luminance over the 33 x 42 box the knight
covers**, averaged in linear Y, not against the single unit under its feet. That is what the
eye integrates, and it is the difference between a metric that says a 1-unit ring highlight
ruins the pit (it does not) and one that says a broad pool does (it does).

Figure luminance includes `Knight.tsx`'s key-light rim, since that rim is what forms the
silhouette edge:

```
skin       body px   Y_body    rim px   Y_key    Y_figure
Cobalt        745    0.1678       86    0.4409    0.1960
Nocturne      678    0.1136       96    0.4523    0.1556
Argent        653    0.1303      103    0.4620    0.1755
```

Nocturne is the binding case at Y 0.1556. WCAG 3:1 against it needs a background box at
**Y ≤ 0.0185**, which is a neutral sRGB of about 37.

### 5.2 Where the shipped build stands

Over the 121,816 walkable units the boss does not cover:

```
                    background box Y   p50 0.0172   p95 0.0315   max 0.0501
Cobalt     worst 2.46:1   p5 3.02:1   p50 3.66:1    under 3:1 on  3.6 % of the pit
Nocturne   worst 2.05:1   p5 2.52:1   p50 3.06:1    under 3:1 on 41.9 % of the pit
Argent     worst 2.25:1   p5 2.78:1   p50 3.36:1    under 3:1 on 16.6 % of the pit
```

Nocturne is under 3:1 on **two fifths of the arena** today. That is the defect this spec's
light budget exists to close, and it is not caused by the decoration this spec adds.

### 5.3 Where the brightness comes from — the decomposition that decides everything

Max background box Y over the same units, layer by layer:

```
graded temple alone                          p50 0.0358   max 0.0599   (Nocturne 1.87:1)
+ pit wash #03070f @0.45                     p50 0.0147   max 0.0224   (2.84:1)
+ core spill @0.10                           p50 0.0147   max 0.0351   (2.41:1)
+ rim band + vignette                        p50 0.0128   max 0.0351   (2.41:1)
```

**The pit wash is doing all the work and the added light is undoing a third of it.** With no
decoration at all, 13.6 % of visible floor units are already over the 3:1 cap.

Two more surfaces are over the cap on their own, both painted by `Arena.tsx`'s wall layer, and
neither is this spec's to fix:

* `PAL.rim` `#413a4f`, the lit top face of every wall: **Y 0.0471, 2.5x the cap.** It is the
  brightest large surface in the arena after the creature.
* `MAP_ENTRANCE_PATH`'s `#b5b56a` at 0.18 lands a floor tile at **Y 0.0365, twice the cap** —
  on the four tiles where dead raiders respawn.

### 5.4 The bound, and the budget

With the pit blacked out — wash 0.95, no pool, no core spill, no decoration — the worst case
is **Nocturne 3.04:1 and 0 % of the pit under 3:1**. So 3:1 everywhere is reachable, and every
unit of light spent on the floor is spent against it. That makes this a budget, and it can be
solved rather than argued about.

Binary search on one gain `g` applied to every added-light layer, for each pit-wash opacity,
taking the largest `g` that still holds Nocturne at 3.00:1 worst case:

```
wash 0.55  ->  g 0.00    floor L8  p5 11.6  p50 23.6  p95 29.5  max 34.6   (flat, no pool)
wash 0.70  ->  g 0.46    floor L8  p5 11.3  p50 21.0  p95 32.8  max 52.9
wash 0.82  ->  g 0.56    floor L8  p5  9.7  p50 17.4  p95 31.0  max 54.4
wash 0.90  ->  g 0.63    floor L8  p5  8.4  p50 15.0  p95 29.9  max 55.8
wash 0.95  ->  g 0.66    floor L8  p5  7.3  p50 13.5  p95 29.4  max 56.4
```

Every row holds 3:1 on 100 % of the pit for all three skins. The trade is entirely **mean
level against spatial swing**, and it is monotone: darker floor buys a hotter pool.

**Take wash 0.70, g 0.46.** Verified end to end at that setting:

```
background box Y  p50 0.0092   p95 0.0144   max 0.0185
Cobalt    worst 3.59:1   p5 3.82:1   p50 4.16:1     under 3:1 on 0.0 % of the pit
Nocturne  worst 3.00:1   p5 3.19:1   p50 3.47:1     under 3:1 on 0.0 % of the pit
Argent    worst 3.29:1   p5 3.50:1   p50 3.81:1     under 3:1 on 0.0 % of the pit
floor L8  p5 11.3   p25 16.7   p50 21.0   p75 25.9   p95 32.8   max 52.9
```

Against the shipped build (§5.2) that is Nocturne's worst case from 2.05:1 to 3.00:1 and its
failing area from 41.9 % of the pit to zero. It is also the last row in the sweep whose median
floor is still bright enough to carry drawn stone detail (§5.5), and it reaches L8 52.9 under
the creature — against image B's own L8 73 peak and ~40 median.

The α values in §4's table are `g = 0.46` applied to a base of pool 0.14, core 0.10,
ring-highlight 0.16, dais 0.10, medallion 0.13.

### 5.5 The rings live or die on the wash, and that is what picks wash 0.70

A dark mortar line only reads on a floor bright enough to show it. Measured on the +x axis at
two settings, mortar against the floor 10 units to either side of it:

```
                       wash 0.70, g 0.46 (recommended)      wash 0.88, g 0.60
  ring    mortar L8    floor in / out    delta        delta
  k=0.22     27.0       40.1 / 31.9      -4.9 .. -13.1      -0.8
  k=0.44     22.4       32.3 / 30.0      -7.6 .. -9.9       -0.3
  k=0.65     27.4       36.6 / 26.5      +0.9 .. -9.2       (medallion contaminated)
  k=0.87     12.9       21.6 / 19.1      -6.2 .. -8.7       +0.5
```

At wash 0.70 every ring reads, by 5 to 13 L8. At wash 0.88 three of the four are inside 1 L8
of the floor beside them — invisible. **The floor's median level, not the ring's own paint, is
what makes the concentric structure visible**, and that is the argument that picks the row in
§5.4 rather than the darkest one that passes contrast.

Stepping the pool gradient at the ring radii instead of painting mortar — same light, banded —
was measured as an alternative and fails on the outer rings whatever the wash:

```
step of 30 % of the local alpha at each boundary, washed base at L8 15.7:
  k=0.22   L8 27.4 -> 23.9   delta 3.5
  k=0.44   L8 24.1 -> 21.6   delta 2.5
  k=0.65   L8 20.9 -> 19.4   delta 1.6
  k=0.87   L8 17.6 -> 17.0   delta 0.6
```

The pool's own falloff has almost nothing left to modulate by ring k=0.87. Paint the mortar;
do not band the gradient.

### 5.6 The worst background in the arena is the creature, and this layer cannot fix it

The boss's own body, graded through `Boss.tsx`'s `BOSS_GRADE`, over the 34 % of the pit it
covers:

```
graded boss body inside the pit: mean sRGB (42, 49, 60)   Y p5 0.0065  p50 0.0368  p95 0.0661
   Cobalt    p5 2.12:1   p50 2.84:1   p95 4.35:1
   Nocturne  p5 1.77:1   p50 2.37:1   p95 3.64:1
   Argent    p5 1.94:1   p50 2.60:1   p95 3.99:1
```

A knight standing in front of the creature reads at **1.77:1 in the worst case** — worse than
anywhere on the floor, before or after this spec. The arena layer is behind the boss and
cannot touch it. Recorded here so the next person measures the right thing; the lever is a
scrim between the boss and the knight layer, or a stronger key light, and it belongs to
`Boss.tsx`/`Knight.tsx`, not here.

---

## 6. Colour

The pit's added light is `#96cdeb` (pool) and `#6ee1ff` (core spill), both already in
`Scene.tsx` and both cold — image B's `#31b2b9` flame and its blue-grey stone are the same
family. The two new dark values, `#04070d` (mortar) and `#03070f` (wash), are near-neutral
blue-black.

Two departures from a literal port, both measured:

* **The floor is bluer than image B's.** Ours composites onto the graded temple, which
  `Scene.tsx` grades to (41, 50, 65) — B > R by 24. Image B's mid floor is `#2c2b35`, B > R by
  9. Correcting that would mean re-fitting `TEMPLE_GRADE`, which `Scene.tsx` solved by least
  squares against a target ramp. Not worth reopening for 15 points of blue.
* **We do not reproduce the warm centre** (`#483f43`, §1.4). A warm hotspot needs a second
  gradient in a second hue over the same pixels, and §5.4 has no budget for a second bright
  layer. If it is ever wanted, take it out of the pool's budget, not on top of it.

---

## 7. Mount point and paint order

Into `Scene.tsx`'s `SCENE`, which is a **module-scope `ReactElement`** — no props, no hooks,
no chain input, so React compares it by identity and never walks it again. That property is
the entire performance contract of the environment layer and this spec must not break it:
everything in §3 and §4 is a constant expression over `MAP_GRID`, `PIT_TOP`/`PIT_BOT`,
`BOSS_SPAWN` and `CORE`.

Order inside `SCENE`, back to front:

```
base fill  ->  graded temple  ->  pit wash (§4.1 region)  ->  apron  ->  dais fill
           ->  ring courses   ->  medallions  ->  steps  ->  braziers
           ->  pool  ->  core spill  ->  rim band  ->  vignette
```

Everything from the apron to the braziers goes inside one `<g clip-path="url(#pit)">` whose
clip path is the existing `PIT_PATH`. The lighting stack stays *outside* the clip and outside
the grade filter, exactly as it is today — the added cyan is already the colour it should be,
and running it through `sepia + hue-rotate` would grade the light along with the stone.

`Arena.tsx:583` keeps painting `MAP_WALL_PATH` and `MAP_RIM_PATH` on top of `SCENE`. Nothing
in this spec is drawn over a wall.

**Two mechanical requirements:**

1. The ring group needs `shape-rendering="geometricPrecision"`. The root `<svg>` carries
   `crispEdges` whenever `usePixelFit` engages (`Arena.tsx:653`), which snaps every edge to
   the device grid and turns a stroked ellipse into a staircase. `Spawn.tsx:202` already sets
   the same override for the same reason — follow it.
2. Node count added: 5 ring strokes + 5 highlight arcs + 1 dais + 1 medallion path + 1 steps
   path + 12 brazier groups ≈ **30 static nodes**, rasterised once on a promoted layer.
   `temple-scene.md` §3.3 measured the same scene with and without the whole gradient stack at
   3.5 ms against 3.5 ms; the frame budget in `docs/perf/frame-budget.md` (p50 9.38 ms,
   p95 14.92 ms at 20 knights under 6x throttle) is a per-frame figure over movers and is
   untouched by a layer that never moves.

---

## 8. Camera

The fight camera is already `CAM_ARENA = scale(1) translate(0, 0)` (`Arena.tsx:283`): during
`PHASE_FIGHTING` the whole 1024-unit square is on screen with no pan and no crop, and
`usePixelFit` sizes the `<svg>` to it at an integer device scale. **This spec assumes that and
requires nothing else.** Every framing decision above — the pit as a 4.43:1 band, the ring
family sized to `PIT_X0..PIT_X1`, medallions at ±322 — is only correct under an identity
camera. If a fight camera that pans is ever added, §3.1 is the first thing it breaks.

---

## 9. Chain impact: none

Nothing in this document reaches the program.

* **No new account bytes.** No field on `Arena`, `Boss` or `PlayerSlot` is read or added. The
  scene is a pure function of `MAP_GRID`, `PIT_TOP`, `PIT_BOT`, `BOSS_SPAWN` and `CORE` — all
  compile-time constants already exported by `@heartrot/client`.
* **No new instruction, no new CU.** `boss_tick`'s measured worst case at 20 players stays
  24,884 CU of a 399,700 ceiling; `shoot`'s guards stay 781 CU. This spec adds no work to
  either, because it adds no work to the chain at all.
* **No new notification traffic.** `SCENE` has no props and cannot be re-rendered by a
  `Players` notification; the 68.4 % of notifications that carry no position change stay as
  cheap as they are now.
* **The ER write-to-visible path is untouched**: p50 122 ms / p95 132 ms at 20 seats stands,
  because nothing here sends, signs, or reads an account.

The one file that changes is `app/src/render/Scene.tsx`, plus the `PIT_POOL_ALPHA` and
`CORE_SPILL_ALPHA` constants it already owns.

---

## 10. What was cut

* **Per-brazier light pools.** §1.3 measured that image B's braziers light nothing past 15 px,
  and §5.4 has no budget for twelve pools. Flames only.
* **A raised dais.** §3.3: 34 % occlusion and a flat clip at `PIT_BOT + 1` leave nothing of it
  visible. Paving plus light instead.
* **Perspective floor rings.** §3.1: the floor plane is the coordinate space.
* **A rear wall, pillars and statues with mass.** §3.5: rows 1..23 must stay floor or every
  shot in that column dies on the raycast. They are backdrop.
* **A second, warm gradient at the pool centre.** §6: it would have to come out of the same
  budget, and the cold read is the one the reference is built on.
* **Re-fitting `TEMPLE_GRADE` to image B's stone hue.** §6: 15 points of blue against a
  least-squares fit that is already validated.

## 11. Open risks

1. **The 3:1 target is a choice.** WCAG 3:1 is a UI-component threshold, not a games standard.
   Everything in §5.4 is re-solvable at a different bar; the script takes it as one constant.
2. **The model is a model.** §5 composites in sRGB the way the CSS filter shorthands are
   specified, and matches three numbers the codebase measured independently (§5 table). It has
   not been checked against a screenshot of the shipped page. That check is one screenshot and
   one `relY()` call, and it should be run before the constants land.
3. **`PAL.rim` and the entrance tint are over the cap** (§5.3) and belong to `Arena.tsx`'s
   wall layer. If they are left alone, the pit's edges and the four respawn tiles stay the
   brightest floor a knight can stand on, whatever this layer does.
4. **The creature is the worst background in the arena** (§5.6) at 1.77:1, and no arena
   change reaches it.
