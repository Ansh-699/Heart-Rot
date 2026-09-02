# The hall — specification

The waiting hall, redesigned against `/home/anshtyagi/Downloads/waiting_area_full_vertical.png`
after the brief "remove every square obstacle, make the arena much larger and less cramped,
build the Boss Fight gate into the top wall as architecture".

Nothing here is implemented. This document specifies. Every number says how it was obtained,
and where a number is a proportion it is written as a **fraction of a bitboard-derived
quantity**, never as a world coordinate — because the map geometry is being enlarged in the
same change and a typed coordinate would be wrong the moment `gen_map.py` re-runs.

Companion specs: `docs/art/waiting-room.md` (the layer this replaces — its §4 grade, §7.3
legibility cap and §8 mounting contract are **carried forward unchanged** and are not
restated here), `docs/art/temple-scene.md`, `docs/art/knights.md`.

**Chain impact: none.** §9.

---

## 0. Findings that change the brief

Three things the reference says that the current build and the brief do not, stated up front
because they change what should be built.

**F1 — the reference's walls carry six flames, not a ring of torches.** A warm-pixel mask
(`R>180 & G>110 & B<140 & R−B>60`, clustered at 25 px) finds exactly eight warm sources in the
whole image: two gate braziers at x 444 / 678, two torches on each side wall (x≈78 at y 263
and 562; x≈1042 at y 268 and 563), and two lit doorways in the side walls (x 28 y 382,
x 1089 y 386). **The top and bottom walls carry no torch at all** — they are lit only by the
gate. The shipped layer has ten torches with rx-92 floor pools. That is not the reference.

**F2 — the reference's torches do not light the floor.** Sampling a 12×32 px box outward from
the left torch: at 15 px the floor is L 18.0 / R−B −3.0, at 45 px it is L 17.8 / R−B −12.5,
which is the room's ambient violet. The warm signature survives about **15–20 px, under 2 % of
the room width**. What actually lights the floor is one broad centre-weighted ambient: down the
room's centre line L runs 31.0 at the top wall → 57.8 at y 442 → 30.4 at the bottom wall, and
by radius (normalised elliptical, centre 561.5/472) L runs 57.2 at r<0.15 down to 24.8 at
r 1.2–1.35. **One soft light, centred, is the whole lighting model.** Ten local pools are both
wrong and the thing that makes legibility change as you walk (`waiting-room.md` §7.3).

**F3 — the walkable gate is a quarter of the size the composition needs.** The reference's arch
mouth measures x 483..639, **156 px = 16.1 % of the 966 px interior width** (longest sub-L20 run
per row across y 150..270). The map's gate block is 4 tiles of a 62-tile interior — **6.5 %**.
Paint can widen the *mouth* over wall tiles, but then the doorway you see is 2.5× the doorway
you can walk through, which is this project's signature defect wearing a different hat. The
honest fix is a **6–10 tile gate block in `assets/map/arena.json`**; that is a `gen_map.py`
re-run with `cargo test` behind it, owned by the map task, not by this layer. If the gate stays
4 tiles, §3.4 says what the paint must do instead.

---

## 1. What is actually in the reference

1122×785, opened and inspected at 1× and in 3–5× nearest-neighbour crops. All boxes below are
image pixels, so any of it can be re-read.

### 1.1 The frame the room sits in

| thing | measurement | method |
|---|---|---|
| interior floor | **x 79..1044 × y 262..682** — 966 × 421 px, **aspect 2.30:1** | column/row luminance profiles; the floor starts where the wall's lit inner face ends in a dark mortar line (L drops 60→17 at x 76, 17.0→27.8 across x 76..80) |
| room including walls | x 20..1100 × y 150..730 — 1080 × 580, aspect 1.86:1 | same profiles, outer silhouette |
| room vs image | **96 % of the image width, 74 % of its height** | 1080/1122, 580/785 |
| void margin | 20 px sides (1.9 % of room width), 55 px below (7 % of room height); above, 150 px — and the gate tower occupies it | |

The composition answer to "large screen-filling room, broad playable area, clear centre,
substantial side space": **the floor is 89 % of the room's width and the room is 96 % of the
frame.** There is no camera margin. There is nothing between the walls.

### 1.2 Wall construction and block rhythm

Four bands, outside in, on the top wall — the deep one:

| band | y | sampled sRGB | L | R−B |
|---|---|---|---|---|
| void | outside | (8.1, 7.4, 18.7) | 8.3 | −10.6 |
| outer lit course | 158..184 | (43.4, 34.1, 50.8) | 37.3 | −7.3 |
| dark carved course | 195..240 | (20.0, 15.3, 30.9) | **17.4** | −10.8 |
| inner lip / lit bottom edge | 242..260 | (23.5, 18.7, 32.7) | 20.7 | −9.2 |
| floor immediately inside | 270..320 | (41.4, 34.8, 53.8) | 37.6 | −12.4 |

Depths, measured off those profiles: **top wall 100 px (10.4 % of the interior width), side
walls 54 px (5.6 %, of which 26 px is the lit inner face), bottom wall 48 px (5.0 %)**. The top
wall is 1.9–2.1× the others. It is the thick one because it carries the gate; that asymmetry is
the composition, not sloppiness.

Block module, from local-minimum joint counts along single rows and columns:

- **floor slab ≈ 14–15 px horizontally, 13 px vertically** (medians of 69 / 48 joint gaps at
  y 470, y 500, x 300). The interior is 966 px over a 62-tile-wide room ⇒ 15.6 px per map tile.
  **One painted floor slab ≈ one map tile.** Do not draw a finer slab grid; at fit scale it
  becomes noise.
- **wall brick ≈ 13 px wide × 21 px tall** (31 gaps along y 172; 11 along x 250) — one tile wide,
  a course and a third tall, laid in running bond with the joints offset half a block per course.
  (An FFT on the same signals returns 59.3 / 42.9 px; those are 3- and 2-block groupings, not the
  module. The joint count is the number to use.)
- The bond is **deliberately irregular**: doubled blocks, half blocks, occasional dropped or
  darkened block, hairline diagonal cracks. Perfectly regular masonry reads as a texture swatch.

The outer silhouette is **stepped, not straight**. Scanning the topmost L>22 row per column:
the base line is y 162, with blocks raised to y 150 at x 262..286, 364..389, 736..759, 839..864
— **four raised bays, 12 px (0.12 of the wall's depth) above the base line**, in symmetric pairs
either side of the gate. Each pair frames a banner. That, plus the gate tower, is the only
relief in the top edge, and it is what stops the wall reading as a bar.

### 1.3 The gate assembly

Measured from the L>18 extent per row above the wall line, plus 3× crops:

| element | extent | as a fraction |
|---|---|---|
| arch mouth (dark, portcullis behind) | x 483..639, crown y≈185, springs y≈215 | **width 0.161 W_f**, centred on the room's centre line |
| flanking piers | x 424..469 and 654..698, tops at y 132 | each **0.047 W_f**; inner faces at ±0.096 W_f, outer at ±0.142 W_f |
| pier tops above the wall silhouette | 162 − 132 = 30 px | **0.30 × the top wall's own depth** |
| sign plaque | x 480..643, y 118..148 | 0.169 W_f wide, 0.30 D_top tall |
| ram-skull crest | x≈518..613, y 77..117 | 0.098 W_f wide, 0.40 D_top tall; **overlaps the sign's top edge** |
| upper shaft | x 456..666, from y 88 up past y 4 | **0.217 W_f**; rises ≥ 1.58 D_top above the wall line and **leaves the frame** |
| braziers | x 444 and 678 (±0.121 W_f), y 150 | standing on the pier tops, above the wall line |
| arch interior | sampled (16.2, 12.5, 26.2) | **L 14.3 — darker than the wall's own dark course (17.4)** |

Sign colour: the glyph mask (`R>90, R−G>60, R−B>50`) means (177, 76, 50) and peaks at
(255, 193, 112). It is the most saturated thing in the frame and the only text.

The tower is a **three-stage plan pyramid**: wall (widest) → piers 0.284 W_f → shaft 0.217 W_f.
That, and only that, is why it reads as architecture rather than as a sign.

### 1.4 Decoration, all of it on the perimeter

- **Banners** — two, hung from the raised bays, x 778..830 on the right (0.054 W_f wide),
  y 150..248 (0.98 D_top long, ending just above the floor line), swallow-tailed, carrying a pale
  horned-skull sigil. Sampled (29.0, 19.8, 38.4), L 23.1: darker than the wall's lit course, so
  they read as cloth in shadow, not as a second focal point.
- **Chains** — hanging links in the wall's shadow, at x ≈ 137, 410, 713, 985: symmetric pairs at
  **±0.156 and ±0.439 W_f** from the centre line.
- **Skull relief** — a recessed arched niche with a skull, x 178..210, y 198..237 (0.033 W_f ×
  0.39 D_top), cut into the dark course at the top left.
- **Barred cell window** — top right, x ≈ 876..953, y 197..247 (0.080 W_f × 0.50 D_top): a
  recessed bay of vertical iron bars with a skull inside, framed by pilaster blocks.
- **Side doorways** — a warm-lit wooden door set in the *outer* half of each side wall,
  x 22..38 and 1081..1098, y ≈ 372..399, i.e. **0.29 of the way down the floor**. They are the
  only warm thing on the side walls besides the torches.
- **The bottom stair** — an opening in the bottom wall, x ≈ 513..610 (0.10 W_f), centred on the
  room's centre line, flanked by projecting jamb blocks, three steps descending into black.
- **Props** — barrel and open chest at top left, clay urns at top right and lower right, barrels
  bottom left and bottom right, a candle cluster and scattered bones lower left. **Every one of
  them is within about 1.5 tiles of a wall's inner face.** Nothing stands in the middle.

### 1.5 The floor

Grey-violet slabs in running bond, dark mortar joints with small darker pins at the joint
intersections, subtle lighter worn patches and hairline diagonal cracks over the slab faces.
On it, and nothing else:

- **four corner medallions** at (185, 360), (950, 360), (182, 643), (948, 643) — a single diamond
  ring around a four-point compass rose, ≈ 55 px (**0.057 W_f**);
- **one centre medallion** at ≈ (556, 475) — **two** nested diamond rings around the same rose,
  ≈ 85 px (**0.088 W_f**).

Positions as fractions: the corner four sit at **±0.39 W_f** from the centre line and at
**−0.27 / +0.41 H_f** from the floor's vertical centre. They are not on a symmetric cross; the
upper pair sits closer in because the gate crowds the top of the room.

They are **engraved, not painted**: a dark groove with a light bevel on one side, and the
5× crop shows them at a luminance within a few counts of the slabs around them. That is the
whole trick — a floor marking that is a value away from the floor becomes an object.

### 1.6 Value structure, and the vignette

Whole-image L percentiles: p1 1.7, p5 5.9, p25 12.9, **p50 28.5**, p75 42.3, p95 59.6.

Floor-only, by elliptical radius from the floor's centre (normalised to its half-extents):

| r | 0–.15 | .15–.30 | .30–.45 | .45–.60 | .60–.75 | .75–.90 | .90–1.05 | 1.05–1.20 | 1.20–1.35 |
|---|---|---|---|---|---|---|---|---|---|
| L | 57.2 | 56.9 | 54.3 | 48.1 | 43.5 | 38.7 | 33.2 | 29.9 | **24.8** |

Close to linear in L: `L ≈ 57.6 − 24.6 r`. Centre-to-corner is **2.3:1 in L, 4.5:1 in relative
luminance**.

**The hue moves with the value.** Floor centre sampled (67.6, 52.8, 64.8) → **R−B +2.8**; floor
left edge (32.4, 28.9, 47.0) → **R−B −14.6**; corner (27.4, 21.4, 34.5) → −7.1. The stone is a
cold violet-mauve and the room's one light warms only its middle. Grading the whole floor warm
is the mistake `waiting-room.md` §1 exists to prevent, and grading it uniformly cold loses the
centre. It is a **radial gradient in hue as well as in value**.

---

## 2. The room, derived

### 2.1 Every quantity comes from the bitboard

The layer imports `MAP_GRID`, `MAP_TILE`, `MAP_TILES`, `GATE_*` and `LOBBY_TOP`/`LOBBY_BOT` from
`@heartrot/client` and derives the rest. No coordinate in §1 is transcribed into code. The four
derived quantities everything else is written against:

```
FLOOR   = bounding box of the lobby's '.' tiles, straight off MAP_GRID
W_f     = FLOOR.width          H_f = FLOOR.height
D_top   = FLOOR.top - (the first non-'#' row found scanning UP from FLOOR.top
                       in a column that is '#' in every row of the band)
CX      = FLOOR.left + W_f / 2
```

`D_top` is a **scan, not a constant**. The shipped layer writes `ROOM_TOP = GATE_MIN_Y −
2·MAP_TILE`, which silently assumes the rim band is exactly two rows; the map task is changing
that band. A scan is the same three lines and cannot go stale.

### 2.2 Proportion targets for the enlarged map

These belong to the map task, and are recorded here because the art cannot produce the
reference's composition without them:

| property | reference | current map | target |
|---|---|---|---|
| lobby floor aspect | **2.30:1** | 62×23 tiles = 2.70:1 | 2.2–2.4:1 — at 62 tiles wide that is **26–28 tiles tall** |
| interior floor / room width | 89 % | 97 % (1-tile border) | keep; the painted band (§2.3) supplies the rest |
| top wall depth | 0.104 W_f | 4 tiles = 0.065 W_f | **6 tiles of wall above the floor** (0.097 W_f) |
| gate opening | 0.161 W_f | 4 tiles = 0.065 W_f | **6–10 tiles** (F3) |
| interior obstacles | **zero** | 30 pillars, 120 tiles | **zero** |

### 2.3 The frame

```
viewBox = [ FLOOR.left − PAD_X, WALL_TOP − TOWER_H,
            W_f + 2·PAD_X,      (FLOOR.bottom + PAD_B) − (WALL_TOP − TOWER_H) ]
PAD_X   = 0.019 · (room width)      // reference's void margin, §1.1
PAD_B   = 0.07  · (room height)
TOWER_H = 1.6 · D_top               // §1.3; the reference's tower leaves the frame, ours may not
```

`preserveAspectRatio="xMidYMid meet"`, never `slice` — the complaint that closed twice was a
crop. `usePixelFit` must size the element to **this frame's aspect**, not to a square off the
short edge (`waiting-room.md` §2.4); the frame constants come from one exported pair, because
the lobby and the fight have different ones and two copies of that fact is the defect this
project keeps paying for.

**Viewport containment is a property of this frame, not of a review.** Every walkable unit of
every walkable lobby tile is inside `[FLOOR.left − PAD_X, FLOOR.right + PAD_X] ×
[FLOOR.top, FLOOR.bottom + PAD_B]` by construction, because the frame is the floor's own
bounding box plus non-negative padding, and `meet` never crops. §7's check asserts it anyway at
every stage aspect the review uses.

---

## 3. The gate assembly — the sharp point

The complaint is that the shipped gate reads as a sign over a wall. It does, and the reference
says why: the shipped tower is a **stepped slab of `PAL.cap` standing above the wall band with
its own outline**, sharing neither the wall's coursing, nor its jambs, nor its shadow. Five
things make the reference's version architecture. All five are required; any four leave a sign.

### 3.1 Piers that start at the floor, not at the wall top

Two masonry piers, each **0.047 W_f wide**, inner faces at **±0.096 W_f** from `CX`. They run
**from the floor line** (`FLOOR.top`, the wall's inner face) **continuously up to `0.30 D_top`
above the wall's outer silhouette**. They are not drawn on top of the wall band — the wall
band's own courses **terminate against them**, so the pier is a break in the wall's brick
pattern rather than a panel over it. Draw order is: wall courses clipped to `x ∉ pier span`,
then the piers, then everything above.

This is the single most load-bearing item. A tower that begins at the wall's top edge is a sign.
A pier that begins at the floor is a building.

### 3.2 One brick module through wall, pier and tower

The same course height, the same block width, the same running-bond half-offset, the same mortar
value. The tower's courses **line up with the wall's courses** where they meet — same phase, not
merely the same size. Concretely: the brick grid is generated once from `D_top / 5` (the
reference's 100 px wall carries five courses of ≈21 px) and every masonry element in this layer
snaps to it, including the piers and the shaft.

### 3.3 A stepped plan, and a stepped skyline either side

Plan, bottom to top: wall → piers spanning **0.284 W_f** → shaft **0.217 W_f**. Two setbacks, so
the mass tapers.

The skyline steps too. The reference's four raised banner bays sit **0.12 D_top** above the wall
line at ±0.20 to ±0.31 W_f from centre (§1.2), between the wall's flat run and the piers' 0.30.
Without them the eye reads one flat wall with one tall thing on it. With them it reads a graded
rise into the gate. Reproduce them at the same offsets and hang the banners from them.

### 3.4 The arch is a hole, and it is the darkest thing in the room

Not an outline. A void:

- the mouth is filled at **L 14.3 sampled**, *below* the wall's dark course (17.4), so it reads
  as depth rather than as a dark panel;
- it is framed by a ring of **voussoirs** — wedge blocks one value above the wall's lit course,
  on the same brick module, springing from imposts at the pier tops;
- the **portcullis** — vertical bars plus two or three horizontal rails — hangs *inside* the
  mouth, above the walkable band, exactly where `waiting-room.md`'s R3 already puts it: on wall
  rows the lobby zone can never reach. It must not overlap the gate block. The existing boot
  check asserts this and is kept.
- **The threshold is never crossed by a line.** The arch outline is three-sided — jambs and
  lintel, no bottom edge. A closed `rect` lays half a stroke of lit stone across the walkable
  gate block; that was measured at Y 0.0429 against a 0.0384 cap, dropping the darkest skin to
  1.76:1 on the one tile every player stands still on. Keep the three-sided path.

**If the gate block stays 4 tiles (F3):** paint the mouth at the walkable width plus exactly one
tile of jamb reveal each side, and put the extra width into the *piers*, not the opening. A
painted opening wider than the walkable slot is a lie about the map, which is the class of bug
this whole document is organised around.

### 3.5 The sign and the crest belong to the stone

- The plaque is **recessed**: a dark inset panel (`signPanel`) with a stone bead above and below
  on the brick module, its outer frame flush with the pier faces. It is a course of the tower,
  not a rectangle laid on it. Width 0.169 W_f, height 0.30 D_top, sitting directly on the arch's
  lintel.
- The glyphs are the only saturated red in the frame — mean (177, 76, 50), peak (255, 193, 112)
  — and they **spill**: a soft red halo on the stone around the plaque, on the same alpha budget
  as the torches (§6, and the boot check already prices `GATE_GLOW_ALPHA`).
- The **ram-skull crest overlaps the plaque's top edge** by roughly a fifth of its height. That
  overlap is what welds the two into one object; a crest floating above a gap reads as two
  decals. Width 0.098 W_f, height 0.40 D_top, centred.
- **Braziers stand on the pier tops**, at ±0.121 W_f, above the wall line — not hung on the wall
  face beside the sign. They are the reason the tower's upper stage is lit at all, and their
  warm halo on the pier stone is what ties the shaft back into the wall.

### 3.6 The tower's licence, restated

Above `FLOOR.top − D_top` the assembly is painted over tiles that are pit floor, not lobby wall.
That is legal only under `waiting-room.md` R3: a seat is drawn only in the room its own `zone`
names, and a `ZONE_LOBBY` seat is clamped to `y ≥ PIT_BOT + 1`, so nothing drawable on this
screen can stand there. **If the map task changes `PIT_BOT` or the zone clamp, this tower paints
over the pit and over the allies standing in it.** The check in §7 asserts the clamp still holds
rather than trusting the comment.

---

## 4. The floor — open, and provably so

### 4.1 What is on it

Three things, and no fourth:

1. **Slabs** — running bond at one slab per map tile (§1.2), dark mortar joints, darker pins at
   joint intersections, an irregular bond with occasional doubled and half slabs.
2. **Wear** — lighter mottled patches and hairline diagonal cracks over the slab faces, at low
   amplitude; §4.2 fixes how low.
3. **Medallions** — four at ±0.39 W_f / −0.27 and +0.41 H_f, single ring, 0.057 W_f; one at the
   centre, double ring, 0.088 W_f. Snapped to tile centres so they sit on the slab grid.

Nothing else. No cover, no rubble field, no crates, no pillars, no floor grate, no rug, no
scatter in the middle third. Props hug the perimeter (§5.3).

### 4.2 The rule that keeps floor decoration from becoming an object

Any marking drawn on a walkable tile must satisfy

```
| Y(marking) − Y(floor under it) |  ≤  0.15 · Y(floor under it)
```

— within 15 % of the local floor's relative luminance, both directions. That is measured off the
reference: on a 5× crop the medallion's bevel and groove sit a few counts either side of the
slabs around them, and the whole inlay disappears at 1×. A marking outside that band reads as a
thing you can hit, which is precisely the complaint being answered.

The same bound covers cracks, worn patches and the wall's cast shadow at its outer edge.

**Consequence for the medallions:** they are geometry, not brightness. The read comes from the
diamond's shape and its 1-unit bevel offset, not from contrast. Do not "make them visible".

### 4.3 Why the aisle rule goes away

`waiting-room.md` §6 keeps a clear central aisle because the shipped map has 26 pillar blocks
and the aisle is the only unobstructed column. With the obstacles removed the **whole floor is
the aisle**, and a preserved aisle marking would draw a corridor across an open room — the
"tiny room layout" read the brief rejects. Delete `AISLE_X0`/`AISLE_X1` and the placement rules
written against them; replace with §5.3's perimeter rule, which is stronger and derived.

---

## 5. Depth without obstacles

The reference has no interior geometry at all and still reads deep. Four mechanisms, in order of
how much they contribute:

### 5.1 Value separation — four bands, measured

| band | reference L | role |
|---|---|---|
| void, outside the room | **8.3** | the frame |
| wall's dark carved course | **17.4** | the wall's mass |
| floor at the perimeter | **24–33** | the far ground |
| wall's lit inner face / bottom wall | **37–47** | the wall's near edge |
| floor at the centre | **57** | the near ground |

Two facts fall out. **The wall carries both the darkest and the brightest stone in the room** —
its lit face is 1.4–1.5× the luminance of the floor beside it while its carved course is ~0.5×.
That contrast *inside a single object* is what gives it thickness. And the void is a full stop
below everything, so the room has an edge.

The shipped `PAL` already encodes this (`wall #120d1c` deliberately below the floor, `rim
#3d3350` above it); it survives. What must change is that with a much larger floor the perimeter
bands are now a small fraction of the frame, so the **wall's depth must scale with the room**
(§2.2: 6 tiles of painted top band, not 4) or the frame becomes a floor with a hairline around it.

### 5.2 The wall's cast shadow

A soft dark band on the floor along every wall's inner face, falling from the wall's foot into
the room. `MAP_FOOT_PATH` in the shipped layer already emits it, derived from `MAP_GRID` — it is
paint on a floor tile, permitted anywhere by §6's rule, and it is what turns a butt join into
contact. With the interior obstacles gone it is the **only** cast shadow in the room, so it
carries more weight than it used to: widen it in proportion to the wall's painted depth rather
than leaving it at a fixed 4 units.

### 5.3 The vignette, which is the actual depth cue

Reproduce §1.6's ramp: `L ≈ 57.6 − 24.6 r` on the floor's own normalised elliptical radius,
i.e. **centre-to-corner 2.3:1 in L / 4.5:1 in Y**, with the hue moving from R−B ≈ +3 at the
centre to R−B ≈ −14 at the edges. Built as, back to front:

1. the graded stone (`LOBBY_GRADE`, unchanged from `waiting-room.md` §4 — R above G, blue
   highest, which is the reference's channel order);
2. the wash, flat, over the whole floor;
3. **one** warm radial centred on the floor's centre, ellipse ratio `W_f : H_f`, reaching the
   corners — this is the room's own bounce and it replaces the ten torch pools;
4. the walls, so the wall's own value bands are not washed out;
5. the six flames of F1 and their **small** halos — radius ≈ 0.02 W_f, on the masonry, barely on
   the floor;
6. the gate's red spill;
7. the edge vignette, darkening the last ~10 % of the frame into the void.

Order matters: pools painted before the walls get eaten by them (`waiting-room.md` §7.1).

### 5.4 Perimeter interest, which is where every prop goes

The eye reads depth from a detailed near edge against a plain far ground. So all detail is on the
perimeter: banners at the raised bays, chains at ±0.156 and ±0.439 W_f, the skull niche and the
barred window in the dark course, the lit side doorways at 0.29 H_f, props within **1.5 tiles of
a wall's inner face**, the stair opening at the bottom centre if the map has one.

**Placement is a walk, not a table.** Build the room's inner face once:

```
FACE = [ (tx,ty,dir) for every '#' tile in MAP_GRID whose neighbour in `dir` is walkable ]
```

ordered clockwise from the top-left corner, then place every fixture at a parametric position
along `FACE`. Three properties fall out for free and none of them can drift when the map changes:
every fixture is on a `#` tile by construction; every fixture moves with the map; and the
placement code contains **no coordinate at all**. This replaces the shipped `TORCHES`,
`BARRELS`, `CHEST`, `CANDLES` and `BONES` coordinate lists, all 30-odd typed numbers of which are
wrong the moment the lobby grows.

Flat things — bones, candle bases, the wall's foot shadow — are exempt and may sit on floor,
because walking over a bone reads correctly. They still obey §4.2's luminance bound.

---

## 6. Light budget

Carried forward from `waiting-room.md` §7.3 unchanged, because the cap is arithmetic and the map
does not enter it:

```
Nocturne body Y = 0.1136   (measured this session: `python3 docs/art/legibility.py`, §1)
(0.1136 + 0.05) / (Y_floor + 0.05) ≥ 1.85   ⇒   Y_floor ≤ 0.0384 everywhere
```

Two results from this session's measurement of the reference itself:

- **The reference's own floor breaks the cap at its centre.** `legibility.py` reports reference A's
  floor at p50 **0.0231**, p95 **0.0468**; my own centre box reads Y ≈ 0.0409. Against that p50,
  Nocturne is **2.24:1**, Cobalt 2.98:1, Argent 2.47:1 — and the worst case over both reference
  scenes is 1.29:1. So the reference is not a legibility target; it is a *shape* target.
- **The shape survives the trim almost intact.** Scaling the reference's ramp so its brightest
  floor lands on the cap costs `0.0384 / 0.0409` = **a 6 % reduction**. The centre-to-corner
  ratio, the hue swing and the linear falloff are all preserved. That is the whole light
  specification: reproduce §1.6's ramp, scaled by 0.94, and the room is both the reference's and
  legal.

Against the shipped room this is a **brightening**: `waiting-room.md` records the shipped layer at
Y p50 0.0126 over every legal stand, against the reference floor's 0.0231. The shipped room is
about 45 % darker than its own reference at the median, which is what "cramped and flat" partly
is. The headroom exists because F2 removes the ten local pools that were spending it.

**I did not measure knight contrast on a render.** There is nothing built to render. Every
contrast figure above is either `legibility.py`'s output on the *reference PNG* this session, or
the cap arithmetic. The re-measure against the built hall is §7's first check and is owed before
this ships.

---

## 7. How the guarantees are enforced

Assertions, not review notes. The first four extend the boot check already at the foot of
`app/src/render/WaitingRoom.tsx`; it throws at import, so a violation cannot reach a player.

1. **Painted floor ≡ walkable bitboard.** Every floor-coloured element is emitted from
   `MAP_GRID`-derived paths (`MAP_WALL_PATH` and the cap/course/face/foot paths compiled beside
   it). Assert `paintedFloorTiles ≡ { t : MAP_GRID[t] ≠ '#' }` as a set equality, in both
   directions, once at import. Not a spot check — the failure this catches is a single tile.
2. **No decoration is a wall.** Assert every fixture's anchor tile is `'#'`, by construction from
   §5.3's `FACE` walk (the anchor's provenance *is* the assertion), and separately assert that
   the layer emits no path into the collision source: the layer imports `MAP_GRID` read-only and
   exports nothing that `predict.ts`, `player.rs` or `shoot.rs` reads. Art cannot become a wall
   because art has no channel to the bitboard.
3. **Nothing opaque over the gate block.** Kept verbatim from the shipped check, plus: assert the
   arch path has no segment with `y ≥ GATE_MIN_Y` (the three-sided outline of §3.4).
4. **The tower's licence.** Assert `PIT_BOT + 1 ≤ FLOOR.top`, i.e. the lobby zone clamp still
   excludes every tile the tower paints over (§3.6).
5. **Legibility, re-measured on the render** — not asserted, measured:
   `python3 docs/art/legibility.py <screenshot>.png A`, over every legal lobby stand as
   `waiting-room.md` §7.3 did (323,063 units at the old size; more at the new one). Pass is
   `max Y ≤ 0.0384` and Nocturne ≥ 1.85:1 at every stand. **Owed; not yet run.**
6. **Viewport containment**, at every stage aspect the review uses: map each walkable unit
   through the `meet` transform and assert it lands inside the stage rect. §2.3 makes this true
   by construction; the check is because "I cannot see my character" was reported twice.
7. **Floor markings stay flat**: for each medallion, crack and worn patch, assert §4.2's 15 %
   luminance bound against the local floor value. Cheap, and it is the difference between an
   inlay and an obstacle.

---

## 8. What changes in the shipped layer

Kept: the mounting contract (module-scope `ReactElement`, `will-change: transform`,
`pointer-events: none`, no props — `waiting-room.md` §8), `LOBBY_GRADE`, the `PAL` value
relationships, `TEMPLE_PATHS`, the wall-edge path compiler, the three-sided arch, the boot check.

Changed:

| | now | spec |
|---|---|---|
| `ROOM_TOP` | `GATE_MIN_Y − 2·MAP_TILE` | scanned off `MAP_GRID` (§2.1) |
| `AISLE_X0/X1` | typed, 24..40 tiles | **deleted** (§4.3) |
| `TORCHES` | 10 entries + 2 braziers, typed | 4 wall flames + 2 braziers, placed on the `FACE` walk (F1, §5.3) |
| torch pools | `rx 92 × ry 62` each | halo `r ≈ 0.02 W_f` on masonry; the floor light is one centred radial (F2, §5.3) |
| `BARRELS`/`CHEST`/`CANDLES`/`BONES` | typed coordinates | parametric on `FACE` |
| gate tower | a stepped slab above the wall band | piers from the floor line, shared brick module, stepped plan and skyline, recessed plaque, overlapping crest, braziers on the piers (§3) |
| floor decoration | none authored | 5 engraved medallions under §4.2's bound |
| frame | `-48 560 1120 496`, typed | derived (§2.3) |

Deleted outright: the 26 pillar fills and the `PAL.wall` note about them — the map no longer has
pillars.

---

## 9. Chain impact: none

- No instruction added, changed or called. No account read or written. Compute-unit cost **zero**,
  so `boss_tick`'s 24,884 CU of a 399,700 ceiling and `shoot`'s 781 CU of guards are untouched.
- No subscription, poll or send. The measured ER p50 (131 → 131.5 ms at twenty seats, 20/20
  checks) is a property of the send path and the blockhash cache; nothing here touches either.
- `MAX_RAY_STEPS`, `PIT_TOP`/`PIT_BOT` and `LOBBY_*` are consumed read-only. **This layer cannot
  fix or break ray reach**; that is the map task's constraint 3 and `gen_hitboxes.py`'s assertion.
- The layer emits no generated file and writes none. `MAP_GRID` is the single source of truth for
  every wall in it.

The renderer-side risk the brief names is real and is answered by construction: the layer never
re-renders (barrier 1), so a heavier scene cannot delay a send. But **node count is now a
function of room size** — the wall-edge compiler emits per-tile paths and a 62×28 lobby has more
perimeter than a 62×23 one. The shipped layer is 260 nodes at rAF p50 6.9 ms, identical to an
empty loop; the enlarged one must be re-measured in the `looksright` harness under the 6× CPU
throttle before it ships, against `docs/review/frame-budget.md`'s p50 9.38 / p95 14.92 ms at 20
knights. **Owed; not yet run.**

---

## 10. Acceptance

1. The lobby contains **zero interior wall tiles** and the painted floor is set-equal to the
   walkable set, asserted both directions (§7.1).
2. The frame is derived (§2.3), `meet`, and every walkable unit is inside it at every stage
   aspect (§7.6).
3. The gate reads as architecture: piers from the floor line, one brick module through wall and
   tower, a two-setback plan, a stepped skyline either side, a hole darker than the wall's dark
   course, a recessed plaque, a crest overlapping it, braziers on the pier tops (§3). A reviewer
   who can cover the sign and still see a gate has passed it.
4. No painted opening is wider than the walkable opening (§3.4).
5. Floor decoration is limited to slabs, wear and five medallions, every one inside §4.2's 15 %
   luminance bound.
6. Every fixture with mass is anchored on a `'#'` tile by the `FACE` walk, and no fixture's
   position is a typed coordinate (§5.3).
7. Floor luminance follows §1.6's ramp scaled by 0.94: centre-to-corner ≥ 2:1 in L, hue moving
   from R−B ≈ +3 to ≈ −14, and **max Y ≤ 0.0384 at every legal stand**, measured on the render
   with `legibility.py` (§7.5).
8. The layer re-renders zero times under a live notification feed, and its rAF cost at the new
   room size is re-measured under 6× throttle (§9).

---

## Appendix — reproducing the measurements

Every number in §1 comes from `PIL` → `numpy` over
`/home/anshtyagi/Downloads/waiting_area_full_vertical.png`, with `L = 0.2126R + 0.7152G +
0.0722B` and relative luminance from linearised sRGB. The named boxes are in the tables. The
non-obvious estimators:

- **Room extents** — column means of `L[300:600, :]` and row means over `L[:, 300:820]` (gate
  columns excluded); an edge is where the mean crosses between the void band and the wall's lit
  course.
- **Outer silhouette** — per column, the topmost row with `L > 22` in `y ∈ [130, 270]`, run-length
  encoded at 6 px granularity.
- **Gate stages** — per row, the first and last column with `L > 18` in `x ∈ [400, 740]`.
- **Arch mouth** — per row, the longest run of `L < 20` in the same window.
- **Flames** — `R>180 & G>110 & B<140 & R−B>60`, greedily clustered at 25 px.
- **Block module** — local minima of a single row/column below `mean − 0.6·std`, gaps under 5 px
  merged, median gap reported. An FFT on the same signal returns 59.3 px (floor) and 42.9 px
  (wall); those are block *groupings*, and are recorded here so nobody re-derives them and
  believes them.
- **Vignette** — floor pixels binned by `r = √(((x−cx)/(W_f/2))² + ((y−cy)/(H_f/2))²)`.
- **Knight contrast and the reference floor's Y percentiles** — `python3 docs/art/legibility.py`,
  run this session, unmodified. Its `BOX_A` is `(150, 300, 980, 690)`, a tighter floor crop than
  mine, which is why its floor p50 (0.0231) sits above mine (0.0211). Prefer its numbers: it is
  the project's method and it is what the acceptance check re-runs.
