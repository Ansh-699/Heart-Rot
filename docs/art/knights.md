# Knight avatars — specification

Source of truth for the player sprite: what is in `assets/sprites/knights.svg`, how a
seat's `skin_id` becomes art, how that art animates, and what it costs at twenty seats.

Nothing here is implemented. Every number below says how it was obtained. Scripts used
are throwaway and live in the scratchpad; the ones worth keeping become
`tools/gen_knights.py` (§5).

**Chain impact: none.** Every field this specification reads already exists in
`PlayerSlot`. See §10.

---

## 1. What is actually in `knights.svg`

Measured by rasterising the file's path data back to a pixel grid and running connected
components (8-connectivity) plus per-column/per-row silhouette profiles.

```
viewBox   0 0 216 140      width="864" height="560"   (4x display, shape-rendering=crispEdges)
paths     23               one <path> per colour, px2svg's only output shape
painted   11,289 px of 30,240   (62.7% of the canvas is transparent)
```

### 1.1 Three knights and one piece of junk

Connected components, sorted by pixel count:

| # | pixels | bbox `(x, y, w, h)` | what it is |
|---|--------|---------------------|------------|
| 1 | 3,150 | `(5, 24, 62, 82)` | **K0** — blue-and-steel knight, horned/winged helm with a blue crest, kite shield on its left |
| 2 | 3,006 | `(77, 25, 62, 80)` | **K1** — dark knight, black mantle, sword raised to its right, tan shield |
| 3 | 2,969 | `(153, 29, 59, 77)` | **K2** — silver plate knight, round shield with a boss, dark navy greaves |
| 4 | 2,160 | `(0, 130, 216, 10)` | **caption strip** — a full-width white band with source-image lettering baked in |
| 5 | 4 | `(43, 56, 2, 2)` | a 2×2 tan blob inside K0's bbox, isolated by 8-connectivity (a face detail sitting in a gap) |

Verified by rendering the grid to PNG at 3× and looking at it. The three components are
the three knights of IMAGE A; the reading of each one's armour above comes from that
render, not from the filename.

**The caption strip is junk and must be cropped.** Rows 107–129 are empty; rows 130–139
are 216 px wide and 100% painted (1,543 px `#ffffff` + 541 px `#fdffff` + 76 px of grey
letterforms). Crop by **row range**, never by colour: `#ffffff` and `#fdffff` are also the
knights' specular highlights (185 px of `#fdffff` inside the knights). A colour-keyed
crop deletes the highlights.

### 1.2 The art is at native 1× — it cannot be losslessly reduced

Two independent checks:

- **Run lengths.** Of 4,674 horizontal runs, **2,618 are exactly one pixel long** (56%),
  983 are two, 561 are three. A 2×-upscaled source has no odd runs.
- **Block uniformity.** Scanning all four 2×2 phase offsets, the best (offset 0,0) still
  leaves **24.7%** of blocks holding more than one colour. At 3× the best offset leaves
  36.7%.

So `assets/sprites/knights.svg` is at the art's true pixel resolution. Any size reduction
is lossy and has to be justified — §3 justifies one.

### 1.3 Parts are **not** separable as delivered

`px2svg.py` emits **one `<path>` per colour, spanning the whole sheet**. Every one of the
23 paths has a bbox covering two or three knights (e.g. `#1b1029`'s bbox is
`(14, 27, 196, 111)` — all three). There is no `<g>`, no `id`, no per-knight and no
per-limb grouping in the file.

This is the same situation the boss was in, and the same tool solves it:
`tools/svg_slice.py` partitions a px2svg sheet by **region** (an ordered rects+colours
table, first match wins, ending in a catch-all) and re-emits one `<g id="part-…">` per
region using `merge_rects`. It is boss-shaped only in its `PARTS` constant.

For the knights, the only separation the animation actually needs is **the legs**, and
the sheet hands that over cleanly. Scanning up from the bottom for rows whose silhouette
splits into exactly two horizontal runs within `x ∈ [15, 53]`:

| skin | two-leg band (rows, local to bbox) | left leg x | right leg x |
|------|-----------------------------------|-----------|-------------|
| K0 | `y+71 … y+80` (10 rows) | 15–34 narrowing to 18–30 | 36–52 narrowing to 40–49 |
| K1 | `y+73 … y+78` (6 rows) | 18–31 → 21–28 | 36–49 → 39–46 |
| K2 | `y+75` only at that threshold; `y+69 … y+76` with `x ∈ [18, 53]` | 17–31 | 36–49 |

The three knights' legs occupy **the same x bands** (~17–31 and ~36–50) because they came
off one sheet at one scale. K2's band is short at the `x ≥ 15` threshold only because a
stray pixel at `x+17` bridges the gap on one row; raising the window to `x ≥ 18` fixes it.

The generator (§5) must therefore take the band per skin as a **hand-authored constant it
verifies**, exactly as `svg_slice.py` does — it asserts every row in the declared band
splits into exactly two runs and fails loudly if the art moves. Do not infer the band at
run time.

### 1.4 Palette

23 colours over the knights (rows 0–106), ordered by relative luminance:

| hex | lum | px | share | role |
|-----|-----|----|-------|------|
| `#090415` | 6 | 163 | 1.8% | deepest shadow |
| **`#1b1029`** | 20 | **1,739** | **19.0%** | **the outline.** Heaviest colour on the sheet — this is IMAGE A's dark keyline |
| `#0f142d` | 21 | 536 | 5.9% | navy under-armour (K2's greaves) |
| `#37243b` | 42 | 348 | 3.8% | shadowed plate |
| `#4b242b` | 45 | 258 | 2.8% | leather shadow |
| `#173869` | 53 | 221 | 2.4% | blue shadow |
| `#35324f` | 53 | 261 | 2.9% | cool mid-shadow |
| `#324469` | 67 | 317 | 3.5% | blue mid |
| `#4b4355` | 70 | 494 | 5.4% | steel shadow |
| `#72443f` | 77 | 223 | 2.4% | leather mid |
| `#2f5585` | 80 | 264 | 2.9% | cape blue |
| `#59596c` | 90 | 527 | 5.8% | steel mid-dark |
| `#467baf` | 116 | 218 | 2.4% | cape blue light |
| `#7d727b` | 117 | 387 | 4.2% | warm steel |
| `#b97055` | 126 | 302 | 3.3% | leather / tan |
| `#8a8692` | 136 | 419 | 4.6% | steel mid |
| `#99919b` | 147 | 549 | 6.0% | steel |
| `#8ba7c1` | 163 | 206 | 2.3% | cool steel light |
| `#b4b4c1` | 181 | 527 | 5.8% | steel light |
| `#dcdae0` | 219 | 330 | 3.6% | steel highlight |
| `#f1e8d8` | 233 | 643 | 7.0% | cream highlight |
| `#fdffff` | 255 | 185 | 2.0% | specular |
| `#ffffff` | 255 | 12 | 0.1% | specular peak |

"Tiny palette" in IMAGE A's description means *per element*, not per sheet: 19% of the art
is one outline colour and the rest is four short ramps (steel, blue, leather, navy). Each
knight individually uses 20–23 of the 23.

Every colour is shared between knights — a per-skin recolour is not available without
re-tracing. Skins are distinguished by **armour, not tint**.

---

## 2. The avatar set and how `skin_id` maps to art

### 2.1 `skin_id` already exists, end to end. Cost to add: zero.

| layer | fact | file:line |
|-------|------|-----------|
| chain layout | `pub skin_id: u8` at offset 2, inside the existing 96-byte `PlayerSlot` | `programs/heartrot/src/state.rs:705`, offset asserted at `:758` |
| chain write | `join` reads `data[1]` and stores it; `claim_seat(slot, seat, skin_id, …)` | `programs/heartrot/src/handlers/player.rs:373, 429, 447` |
| chain validation | **none.** The program stores whatever byte arrives | see §2.4 |
| wire | `join` args, `skin_id u8 @1` of 66 bytes | `packages/client/src/instructions.ts:419, 446` |
| decode | `skinId: v.getUint8(s + p.skin_id)` | `packages/client/src/layout.ts:159, 432` |
| server validation | `skinId` integer, `0 ≤ skinId < SKIN_COUNT`, `SKIN_COUNT = 3` | `worker/src/routes.ts:70, 462–465` |
| UI | 3-entry `SKINS` table, chosen **before** the seat claim | `app/src/screens/CharacterSelect.tsx:28–33` |

**Three knights in the sheet, three skins in the table.** The mapping is 1:1 and requires
no schema change, no migration and no new instruction.

### 2.2 The mapping

`skin_id` is the knight's **left-to-right index on the sheet**:

| `skin_id` | component bbox | name | reads as |
|-----------|----------------|------|----------|
| 0 | `(5, 24, 62, 82)` | **Cobalt** | blue crest, horned helm, kite shield |
| 1 | `(77, 25, 62, 80)` | **Nocturne** | black mantle, raised sword, tan shield |
| 2 | `(153, 29, 59, 77)` | **Argent** | silver plate, round shield |

The names replace `Cobalt / Ember / Moss` in `CharacterSelect.tsx`; `Cobalt` survives
because it is still the blue one, `Ember` and `Moss` describe colours the art does not
have and must go.

**The generator emits this table**, in sheet x-order, into the same file as the sprite
defs. `SKINS` in `CharacterSelect.tsx` then imports it rather than restating it. Ordering
by bbox x is what makes "which knight is skin 1" a fact of the art instead of a fact
somebody typed.

`SKIN_COLORS` (`#5aa9e6 / #e6a25a / #7fd48b`) stays, unchanged and unrelated: it is the
roster dot in `Lobby.tsx:120` and the select chip, both of which are UI chrome outside
the arena `<svg>`. Do not try to derive it from the sprite — a per-knight dominant colour
is grey for two of the three (§1.4) and would make the roster unreadable.

### 2.3 Male/female was never in this art

The reference sheet is three **armoured knights** with closed helms. There is no gendered
pair and no face to gender. The axis the art offers is armour house. Say that in the
select copy and drop the original intent.

If a gender axis is wanted later, the chain cost is still zero: `skin_id` is a `u8` with
256 values, and nothing on chain interprets it. The cost is (a) new art, and (b) two
one-line edits — `SKIN_COUNT` in `worker/src/routes.ts:70` and the generated table's
length. Six skins is as cheap as three.

### 2.4 The renderer must clamp `skin_id`. This is a trust boundary.

The Worker range-checks, the program does not. A session key can sign `join` directly
against the ER — `worker/src/routes.ts` is a convenience, not a chokepoint — so a seat can
carry `skin_id = 200`.

```
symbolFor(skinId)  ->  SKINS[skinId] ?? SKINS[0]
```

`Lobby.tsx:120` already does exactly this for the dot (`SKIN_COLORS[skinId] ?? 'var(--dim)'`).
The arena renderer must do the same, or an out-of-range byte from one seat throws inside
the render of **all twenty**.

---

## 3. Geometry: resolution, canvas, anchor, scale

### 3.1 Draw the knights at **half** the source resolution

The project's established convention, stated in `tools/gen_hitboxes.py`, is
**one sprite pixel = one arena unit, no scale, no flip** — that is what makes the boss's
drawn art and its raycast hitboxes provably the same pixels.

Applying that rule to the knights at full resolution gives a knight whose body is
**twice its hitbox**:

| | source (1×) | half (2× mode-downsample) | chain |
|---|---|---|---|
| K0 core body width (columns ≥25% painted) | 51 px | 25.5 | |
| K1 | 53 px | 26.5 | |
| K2 | 48 px | 24.0 | |
| **mean** | **50.7 px** | **25.3** | |
| `PLAYER_HIT_RADIUS × 2` (`handlers/tick.rs:143`) | — | — | **24 units** |
| ratio drawn : hittable | **2.11 : 1** | **1.06 : 1** | 1.00 |

At full resolution the sprite is 111% wider than the circle bullets test against, so
shots that visibly clip the pauldron miss. At half resolution the art and the hitbox
agree to **6%**, with no change to `tick.rs`.

The scale ratio against the boss confirms it. `boss.svg` is `viewBox="0 0 230 270"`, drawn
1:1:

| | knight 1× (62×82) | knight ½× (31×41) |
|---|---|---|
| boss width ÷ knight width | 3.7× | **7.4×** |
| boss height ÷ knight height | 3.3× | **6.6×** |
| boss area ÷ knight area | 12 : 1 | **49 : 1** |
| knights that fit across a 1024-unit arena | 16 | **31** |

IMAGE B is a demon many times a player's height over a pit of tiny figures. 3.3× is not
that; 6.6× is, before the boss is scaled up at all.

**The 2× reduction was visually verified**, not assumed: the sheet was mode-downsampled
(majority colour of each 2×2 block, transparent only when ≥3 of 4 source pixels are
transparent — never an averaged colour) and rendered at 8×. K0 keeps its crest, helm horns
and shield rim; K2 keeps the round shield's boss and the cross on its chest; K1 loses the
least because 30% of it is flat black mantle. Faces soften. 31×41 is an ordinary pixel-art
character size and the art survives it.

Use `px2svg.mode_downsample`'s rule, not point sampling. Point sampling drops the 1-px
outline on alternate edges and the knight loses its keyline, which is 19% of the art.

### 3.2 One shared canvas: **33 × 42**

The three half-res knights are 31×41, 31×40 and 29×38. Pad all three into a single
canvas so there is one anchor, one hitbox relationship, one flip pivot, and skins are
interchangeable at run time.

```
SPRITE_W = 33      odd on purpose
SPRITE_H = 42
```

**The width must be odd.** A horizontal flip (§6.3) is `scale(-1, 1)` about local x = 0.
With an odd width the columns run `x ∈ [-16, +16]` and the mirror is an exact permutation
of columns — lossless, every pixel lands on a pixel. With an even width the mirror lands
half a unit off and every flipped knight is blurred or shifted by one.

Placement inside the canvas:

- **horizontally centred**: `ox = (33 - w) // 2` → K0 `1`, K1 `1`, K2 `2`
- **bottom-aligned on the feet row**, not the bbox bottom. The feet row is the last row
  with ≥3 painted pixels: K0 `y+81` of 82, K1 `y+78` of 80, K2 `y+76` of 77 — the slack is
  a stray pixel or two below the boots. Aligning on the feet row is what puts all three
  knights on one ground line; aligning on the bbox bottom puts K1 one unit high.

The generator computes and emits `ox`/`oy` per skin. It must assert the padded content
fits in 33×42 and fail if new art does not.

### 3.3 Anchor

```
KNIGHT_ANCHOR_X = -16       local x = sprite_x - 16
KNIGHT_ANCHOR_Y = -21       local y = sprite_y - 21
```

`PlayerSlot.x` / `.y` land at sprite cell `(16, 21)`. The renderer places the sprite's
top-left at `(slot.x - 16, slot.y - 21)`, which for a `<use>` inside the seat `<g>` that
the frame loop already translates means a static `x="-16" y="-21"` on the `<use>` and
nothing per-frame.

Same rule as the boss — the anchor is the canvas centre — with one correction. `gen_hitboxes.py`
writes `-round(W/2)`, and Python's `round()` is banker's rounding: `round(33/2) = 16` here
by luck, but `round(31/2) = 16` while `31 // 2 = 15`. **Write `-(SPRITE_W // 2)` explicitly.**
Do not copy the boss's expression and hope the parity matches.

Consequence, stated so nobody discovers it in a bug report: the 24-unit hit circle covers
sprite rows **9 … 33** of 42. The helm (rows 0–9) and the boots (rows 33–41) are outside
it. A knight's head is not hittable. That is already true of the current 10-radius circle
and is the forgiving direction in a bullet-hell; changing it means changing
`PLAYER_HIT_RADIUS` in `tick.rs`, which is a chain change and is out of scope here.

### 3.4 Scale against the tile and the boss

`MAP_TILE = 16`, `MAP_TILES = 64`, arena `1024 × 1024` units.

| | units | tiles |
|---|---|---|
| knight canvas | 33 × 42 | 2.06 × 2.63 |
| knight core body | ~25 wide | 1.6 |
| hit circle | 24 across | 1.5 |
| one move step | 16 (11 diagonal per axis) | 1.0 |
| boss sprite at 1:1 | 230 × 270 | 14.4 × 16.9 |

A knight is **two tiles tall and moves one tile per 50 ms** — it crosses its own height in
100 ms. That is fast, and it is the movement speed the user has already signed off on;
this specification does not change it.

If the arena task scales the boss up to fill the top centre, the knight stays at 33×42 and
the ratio moves with the boss:

| boss draw scale | boss units | knight : boss height |
|---|---|---|
| 1× | 230 × 270 | 1 : 6.4 |
| 2× | 460 × 540 | 1 : 12.9 |
| 3× | 690 × 810 | 1 : 19.3 |

IMAGE B reads at roughly 1 : 12 – 1 : 18. **2×–3× on the boss, knights unchanged.** That is
the recommendation this spec hands to the boss/arena tasks; it is their call to take it.

---

## 4. Sharpness: the constraint the arena composition has to satisfy

`usePixelFit` (`app/src/render/Arena.tsx:427`) sizes the SVG so one arena unit covers a
whole number of device pixels:

```
raw   = min(box.width, box.height) * devicePixelRatio / VIEW_UNITS
scale = raw >= 1 ? floor(raw) : raw
```

`VIEW_UNITS` is currently `ARENA_UNITS = 1024`. Arithmetic (not a browser measurement) for
realistic containers:

| container | dpr | view | device px per arena unit | knight on screen |
|---|---|---|---|---|
| 720 css | 1 | 1024 | **0.70** | 23 × 30 css px |
| 900 css | 1 | 1024 | **0.88** | 29 × 37 css px |
| 1024 css | 1 | 1024 | 1.00 | 33 × 42 css px |
| 640 css | 2 | 1024 | 1.00 | 17 × 21 css px |
| 900 css | 2 | 1024 | 1.00 | 17 × 21 css px |
| 1200 css | 2 | 1024 | 2.00 | 33 × 42 css px |
| 900 css | 1 | **512** | 1.00 | 33 × 42 css px |
| 900 css | 2 | **512** | **3.00** | 50 × 63 css px |
| 1200 css | 2 | **512** | 4.00 | 66 × 84 css px |

Two problems, both belonging to the arena composition rather than to the sprite:

1. **Below 1.0 the art shimmers.** At 0.88, twelve percent of the sprite's rows and columns
   are dropped by the rasteriser, and *which* ones are dropped changes as the knight
   translates — under the inherited `shape-rendering: crispEdges` that is a flicker along
   the outline, not a soft blur. It is worse than the same sprite drawn blurry.
2. **`floor()` throws away half a retina screen.** At dpr 2 and a 900 css container, `raw`
   is 1.76 and the floor takes 1: the whole arena renders into 512 css px and a knight is
   17 × 21 css px. Legible as a dot, not as armour.

**The requirement this spec places on the arena task:**

> The scene's viewBox must span at most `min(box) × dpr / 2` arena units, so that a knight
> gets ≥ 2 device pixels per sprite pixel.

At a 900 css container and dpr 2 that is ≤ 900 units — already satisfied by 512. At dpr 1
it is ≤ 450 units, which no full-arena view can meet; on a dpr-1 laptop 1.0 (a 512-unit
view) is the realistic target and is exactly the "sharp SVG" the user asked for.

Since the 33-Immortals recomposition puts the boss at the top and the players in a pit
below, the visible region is a **sub-rectangle of the 1024 map, not the whole map**.
Making the viewBox that sub-rectangle is the fix, it is free, and it is required anyway
for the composition. This spec does not choose the rectangle; it states that a 512-unit
view is where the knight art starts to read and a 1024-unit view is where it does not.

Do not "solve" this by dropping `crispEdges` for the sprite layer. Antialiasing a
19%-outline pixel sprite at 0.88 turns the keyline grey and the knight loses the exact
property IMAGE A is chosen for.

---

## 5. The pose set and the generator

### 5.1 Four symbols per skin

Baked poses, not run-time transforms. Rotating or shearing pixel art in the browser
produces non-integer edges under `crispEdges`; doing the displacement at author time on
the pixel grid keeps every edge on a pixel.

| symbol | how it is generated from the source | used by |
|---|---|---|
| `rest` | the half-res sprite, unchanged | idle, walk pass-frame, respawn, standing |
| `contactL` | leg-band pixels of the **right** leg shifted up 1 row (right foot lifted); everything above the band unchanged | walk frame 0 |
| `contactR` | leg-band pixels of the **left** leg shifted up 1 row | walk frame 2 |
| `fallen` | `rest` rotated **exactly 90°** (a transpose — lossless for pixel art), so the knight lies on its side | death, dead |
| `sil` | the union silhouette of `rest`, one flat fill | hit flash |

The walk's **pass frame is not a symbol**: it is `rest` with `translate(0, -1)` on the
`<use>`. One integer unit of vertical bob at the apex of the step, free.

Five symbols × three skins = **15 defs**.

### 5.2 `tools/gen_knights.py`

New generator, same shape as `gen_map.py` / `gen_hitboxes.py` / `svg_slice.py`. Never
hand-edit its output — a hand-edited generated file is this project's most repeated defect.

Input:

```python
SHEET = "assets/sprites/knights.svg"

# Hand-authored, verified by the tool. bbox is the connected component on the sheet;
# leg_band is the row range (local to bbox, source resolution) the tool asserts splits
# into exactly two runs within leg_window on EVERY row.
SKINS = [
  dict(id=0, name="Cobalt",  bbox=(  5, 24, 62, 82), leg_band=(71, 80), leg_window=(15, 53)),
  dict(id=1, name="Nocturne",bbox=( 77, 25, 62, 80), leg_band=(73, 78), leg_window=(15, 53)),
  dict(id=2, name="Argent",  bbox=(153, 29, 59, 77), leg_band=(69, 76), leg_window=(18, 53)),
]
CROP_ROWS   = (0, 107)   # rows 107..139 are empty + the caption strip. Row range, NOT colour.
SPRITE_W, SPRITE_H = 33, 42
```

Steps, each with a loud failure:

1. Parse the sheet with `svg_slice.parse` — the same regex, so anything px2svg did not
   write is rejected rather than reinterpreted.
2. Rasterise; assert the rects are disjoint (`svg_slice.rasterize` already does).
3. Assert rows `107 … 139` contribute nothing to any declared bbox — i.e. the caption
   strip is outside every skin. Fail if a bbox reaches into it.
4. Assert the declared bboxes are exactly the connected components found at run time.
   If someone re-traces the sheet and a knight moves, this fires instead of silently
   cropping half a shield.
5. Assert `leg_band` splits into exactly two runs on every row within `leg_window`.
6. Mode-downsample each skin 2× (`px2svg.mode_downsample` semantics: majority real colour,
   transparent only when ≥3 of 4 source pixels are transparent).
7. Compute the feet row (last row with ≥3 painted px), centre horizontally, bottom-align
   on the feet row into 33×42. Assert it fits.
8. Build the five poses; run `px2svg.merge_rects` over each; emit one `<path>` per colour
   per pose, exactly as `svg_slice.emit_group` does.

Output — **one file, both consumers, one fact stored once**:

```
app/src/render/knights.gen.ts
```

holding

```ts
export const SPRITE_W = 33;
export const SPRITE_H = 42;
export const KNIGHT_ANCHOR_X = -16;
export const KNIGHT_ANCHOR_Y = -21;
/** Index IS skin_id. Sheet order, left to right. */
export const KNIGHT_SKINS: readonly { name: string; poses: Record<Pose, string> }[];
```

where each pose value is the inner markup of its `<g>` (the `<path>` list). `CharacterSelect.tsx`
imports `KNIGHT_SKINS` for its names; `Arena.tsx` imports it for the defs. Neither restates
the other.

Regenerate line, in the file header, as every other generated file here carries one:
`python3 tools/gen_knights.py`.

### 5.3 Measured cost of the defs

`merge_rects` over each half-res pose, path-data bytes counted exactly:

| skin | canvas | `rest` rects / bytes | `sil` rects / bytes | `fallen` rects / bytes |
|---|---|---|---|---|
| K0 Cobalt | 31 × 41 | 447 / 6,079 B | 47 / 675 B | 437 / 5,894 B |
| K1 Nocturne | 31 × 40 | 360 / 4,899 B | 47 / 672 B | 348 / 4,713 B |
| K2 Argent | 29 × 38 | 397 / 5,386 B | 40 / 571 B | 394 / 5,305 B |

`contactL` / `contactR` are within a few rects of `rest` (they displace ~10 pixels).

**Total inline defs ≈ 65 KB** of path data for all 15 symbols. Against `temple.svg` at
332 KB, which the constraints call fine when rasterised once, this is not a concern.

For comparison, drawing at full resolution instead: 850–1,072 rects and 11.8–14.9 KB per
pose, ~156 KB of defs and 2.4× the rasterisation work — a second reason §3.1 goes to half.

---

## 6. Animation

Every trigger below is either a **field already in `PlayerSlot`** or the **frame-to-frame
displacement the render loops already compute**. Nothing polls, nothing is added to the
chain, and every trigger is idempotent under the Magic Router's duplicate delivery
(each notification arrives twice) because it compares values rather than counting events.

### 6.1 Where the animation state may live

Hard rule from the constraints, restated because it is easy to break here:

- the seat `<g>`'s `transform` is owned by the frame loop (local seat,
  `Arena.tsx` `selfNode`) or by `useSeatInterpolation` (`predict.ts:461`). **Nothing else
  may write it.**
- the animation therefore owns a **child** node: one `<use>` per seat.

```
<g key={seat} ref={…}>              ← transform: OWNED BY THE EXISTING LOOPS
  <ellipse class="shadow"/>          ← static
  <circle class="self-ring"/>        ← static, local seat only
  <use class="knight" href="#k0-rest" x="-16" y="-21"/>   ← OWNED BY THE ANIMATION DRIVER
  <use class="flash"  href="#k0-sil" x="-16" y="-21"/>    ← OWNED BY THE ANIMATION DRIVER
  <path class="chevron"/>            ← static, local seat only
  <rect class="hpbar"/>              ← React, only when hp < hpMax
</g>
```

Two writers, two nodes, no overlap. The driver writes at most `href`, `transform` and
`opacity` on its two `<use>` nodes.

Use `<g id="…">` inside `<defs>`, **not `<symbol>`**. A `<symbol>` establishes a viewport
and clips; a `<g>` does not, needs no width/height, and `<use href="#g">` positions it with
plain `x`/`y`.

### 6.2 Walk — driven by distance travelled, never by a timer

**Driver.** Both existing loops already compute a per-frame position for every seat: the
local seat via `chase(at, predictor.self, …)` (`Arena.tsx:87`), remote seats via
`trackAt(track, tickAlpha(…), out)` (`predict.ts:451`). Both write it as a transform
string and throw the number away.

Keep it. Per seat, remember the last written `(x, y)` and accumulate:

```
d += |x - lastX| + |y - lastY|          // Manhattan. No sqrt; the stride only needs to count.
frame = (d / MAP_TILE) & 3              // integer divide
```

**One walk frame per tile stepped.** This is the whole design:

- `MOVE_STEP` is exactly one `MAP_TILE` per accepted move (`handlers/player.rs:109`), and
  `controls.ts` gates moves at `MOVE_MS = 50`. So a knight at full speed advances one
  animation frame every 50 ms — a 20 fps four-frame cycle, which is the classic pixel-art
  walk rate.
- It **derives from `MOVE_STEP`**, not from a chosen animation fps. If movement speed is
  ever retuned, the walk retimes itself and stays in step with the feet.
- A standing knight accumulates zero and the frame **freezes**. No moonwalk, by
  construction and not by a check.
- A knight interpolating between two identical positions — which is 68.4% of the Players
  notifications during a fight — accumulates zero. The stutter that the position feed
  cannot avoid does not reach the legs.
- The diagonal step is `(11, 11)`, Manhattan 22 vs 16 for a cardinal. A diagonal walker
  cycles 1.375× faster. That is correct: a diagonal move covers 15.6 units of ground
  against 16, so the cadence should be near-identical, and 1.375× is the error. If it
  reads wrong, divide the diagonal contribution by 1.414 — one multiply, and it is the
  only place in this spec where a fudge factor is acceptable, so mark it.

**Cycle table:**

| frame | symbol | `<use>` transform |
|---|---|---|
| 0 | `contactL` | none |
| 1 | `rest` | `translate(0,-1)` — the pass, body at apex |
| 2 | `contactR` | none |
| 3 | `rest` | `translate(0,-1)` |

**Cost per seat per frame:** 2 subtractions, 2 `Math.abs`, 1 add, 1 integer divide, 1
compare. A DOM write happens **only when `frame` changes** — at most 20 Hz for a moving
seat, never for a standing one. Twenty seats is ~140 float ops per frame and ≤ 400 attribute
writes per second in the worst case where all twenty sprint continuously.

**Snap guard.** `chase` snaps when the gap exceeds `SELF_SNAP = 4 * MAP_TILE`
(`Arena.tsx:76`), and `useSeatInterpolation` snaps on `teleported`. A respawn is a
teleport of hundreds of units; accumulating it would spin the legs for a dozen frames.
The driver must apply the same rule: **if `|Δx| + |Δy| > SELF_SNAP`, reset `d` instead of
adding to it.** Reuse the existing constant; do not restate 64.

### 6.3 Facing — a flip, not eight sprites

The reference art gives one pose per knight, front-facing three-quarter. Eight rotations
do not exist and cannot be derived.

`PlayerSlot.facing` is 0–7 clockwise from north (`FACING_UNIT`, `sprites.ts:60`). Map it to
a horizontal flip only:

| facing | 1, 2, 3 (NE, E, SE) | 5, 6, 7 (SW, W, NW) | 0, 4 (N, S) |
|---|---|---|---|
| flip | none | `scale(-1,1)` | **keep the previous flip** |

Composed with the walk's pass-frame bob: `transform="scale(-1,1) translate(0,-1)"`.

Driving the flip off `facing` rather than off the movement delta makes it authoritative —
every client draws the same knight facing the same way — and duplicate-safe, since the same
`facing` value twice is no change. Holding the flip through N and S is what stops a knight
walking straight up from flickering.

The mirror swaps which arm holds the shield. Universal in pixel games, and §3.2's odd
canvas width makes it exact.

**Aiming is not facing.** The existing facing stub (`FACING_UNIT`, drawn from the seat `<g>`)
stays and keeps showing the true eight-way aim the raycast uses. The sprite communicates
left/right; the stub communicates where the shot goes. Do not delete the stub — the flip
cannot express NE versus SE, and hitscan does.

### 6.4 Idle

Alternate `rest` and `rest + translate(0,-1)` on a slow timer — **~600 ms per swap**, one
shared timer for all seats, not one per seat.

A timer is correct here and only here: idle breathing is not locomotion, so there is no
position to derive it from, and the "no moonwalk" rule is about a *standing* knight showing
*walking* frames. A 1-unit breathe is not that.

Two DOM writes per idle seat per 600 ms — ~33 writes/second across twenty idle knights.

Gate: idle runs only when `d` has not advanced for two idle periods, so it does not fight
the walk cycle at the moment a knight stops.

### 6.5 Shoot recoil

**Trigger: `PlayerSlot.last_shot_tick` increases.** (`state.rs:735`, stamped in
`shoot.rs:229`.) This is already on chain, for every seat including remote ones, and a
duplicated notification carries the same value so it fires once.

Do not derive it from "I sent a shoot transaction" — that only knows about the local seat,
and nineteen other knights firing is most of what a raid looks like.

Recoil: a one-shot CSS transition on the `<use>`, translating **2 units against
`FACING_UNIT[facing]`** and back. Round the offset to whole units so the sprite lands on
the pixel grid at rest.

```
.knight.recoil { transition: transform 60ms ease-out; }
```

Then a `transitionend` (or a single `setTimeout`) returns it. `SHOT_COOLDOWN_TICKS =
ticks_for(800) - 1` (`shoot.rs:94`) means one shot per 800 ms per seat, so this is at most
25 recoils per second across twenty seats and each is two attribute writes.

The recoil transform composes with the flip and the walk bob, so all three must be written
as one `transform` string by the same driver. One writer, one node — that is why the driver
owns the `<use>`'s transform outright.

### 6.6 Hit flash

**Trigger: `PlayerSlot.hp` decreases** against the value last seen for that seat.

There is no "was hit" flag on chain and there does not need to be one. The `hp` delta is
the event, and it is duplicate-safe for free: a repeated notification carries an identical
`hp`, which is not a decrease.

Render: set the second `<use>` (`href="#k{n}-sil"`, the flat silhouette from §5.1) to
`opacity: 1`, then to `0` over **120 ms** via a CSS transition. The silhouette is 40–47
rects and 571–675 bytes, filled with one bright colour — add `hitFlash: '#fff1c9'` to
`PAL` (it is `bulletEdge`'s value; reuse the constant rather than a second literal if the
implementer prefers).

**Do not use a CSS `filter`.** `brightness()` on twenty `<use>` nodes creates twenty filter
layers, and the whole point of the silhouette symbol is that it is a flat fill the
compositor handles for nothing.

### 6.7 Death

**Trigger: `PlayerSlot.deaths` increases.** (`state.rs:729` — incremented on the same line
that stamps `respawn_at_tick`, so it is exactly one event per death.) Prefer it over
`hp == 0`: `deaths` is the *event*, `hp == 0` is the *state*, and a client that misses a
snapshot still sees the counter move.

- On the increment: swap `href` to `#k{n}-fallen`, and run one CSS transition —
  `translate(0, +4)` and `opacity 1 → 0.55` over **200 ms**. The `fallen` symbol is a
  lossless 90° transpose, so the corpse is as crisp as the standing knight.
- While `hp == 0`: hold `fallen` at 0.55 opacity. Suppress the walk driver (`d` frozen), the
  idle timer, the recoil and the flash for that seat.
- The `hp` bar is hidden at `hp == 0` (§7.3), so the corpse carries no chrome except the
  local-player chevron, which stays — you must be able to find your own corpse.

Orientation: lay the fallen knight with its **feet toward the boss** (rotate one way for
seats whose flip is unflipped, the other for flipped). Two `fallen` symbols per skin, or
one plus a `scale(-1,1)`; the flip is already exact, so one symbol suffices.

### 6.8 Respawn

`respawn_at_tick` (`state.rs:731`) and `arena.tick` give the exact return time.
**`RESPAWN_TICKS = ticks_for(3_200)` is a chain fact and must not be restated in the
client** — read `respawn_at_tick - arena.tick` and there is nothing to hardcode and nothing
to drift.

- While waiting: draw a countdown arc on the shadow ellipse, swept by
  `1 - (respawn_at_tick - tick) / (respawn_at_tick - death_tick)`. Costs one attribute per
  seat per tick, not per frame.
- On `hp` going `0 → non-zero`: `boss_tick` teleports the seat to the arena entrance.
  `useSeatInterpolation`'s `teleported` snap and `chase`'s `SELF_SNAP` already handle the
  position; §6.2's snap guard already stops the legs spinning. The sprite swaps back to
  `rest` and fades `opacity 0.55 → 1` over **250 ms**.

### 6.9 A note on durations

`ticks_for()` governs **simulation** durations. The 120 ms flash, the 200 ms fall, the
250 ms fade-in, the 60 ms recoil and the 600 ms breathe are **presentation** durations:
they are CSS transitions on a decorative node and **nothing in this section gates,
delays or alters a chain-visible outcome**. A knight that is still visibly falling has
already had `hp = 0` for as long as the chain says it has.

The two places where a real duration appears — the walk cadence and the respawn countdown —
derive from `MOVE_STEP` and from `respawn_at_tick` respectively, and neither is written
down twice.

---

## 7. Twenty knights in a pit

### 7.1 Draw order

SVG has no `z-index`; paint order is document order. Sort seats **ascending by `slot.y`**,
so a knight lower on screen is drawn later and occludes the one behind it. Standard
painter's algorithm for a three-quarter view, and it is what makes the pit read as having
depth rather than as a pile of decals.

Sort on the **authoritative `slot.y`**, not the drawn/interpolated y. Two reasons: the sort
happens in the React render, which runs on the Players notification (~2.5 Hz), not per
frame; and sorting on an interpolated value would make two knights swap order mid-lerp
whenever they cross, which flickers.

Cost: one `Array.prototype.sort` over ≤20 elements per notification. With `key={slot.seat}`,
React reorders by moving the existing DOM nodes (`insertBefore`), so the ref callbacks do
not re-fire and neither loop loses its node. Inline transforms survive a reorder.

Because 68.4% of notifications carry no position change, most sorts produce the identical
order and React does nothing at all.

**Ties.** Equal `y` must break deterministically — on `seat` — or two knights standing level
swap every notification and shimmer.

### 7.2 Finding yourself in the crowd

IMAGE B's players are tiny and numerous, and at 33×42 units on a 512-unit view twenty
knights genuinely overlap. Three cues, in order of how far away they work:

1. **A chevron above the helm.** A small filled triangle at local `y = -30`, `PAL.selfRing`
   (`#eafff4`). Nine units above the sprite's top, so it clears any knight standing in
   front of you. This is the cue that works when your knight is fully occluded, and it is
   the one that has to exist.
2. **A ground ring under the feet.** A `PAL.selfRing` ellipse at local `y = +20`, drawn
   *before* the `<use>` so the sprite stands inside it. Reads at a glance, is not occluded
   by knights behind you, and is the direct descendant of the current `r = PLAYER_R + 5`
   ring (`Arena.tsx:328`).
3. **The skin you chose.** Three visibly different suits of armour, picked by you before
   you sat down. This is the cue the art was hired for and it works only at close range —
   which is why 1 and 2 are not optional.

Do **not** draw the local knight last, out of `y` order. It reads as your knight ghosting
through other players, which is worse than being briefly hidden. The chevron already
solves occlusion.

Allies do not need a tint. The existing `PAL.ally` blue circle exists because the primitive
renderer had nothing else to say; three distinct armours plus depth ordering say more.
Dead knights are already separated by the `fallen` silhouette and 0.55 opacity.

### 7.3 The HP bar

Keep `HP_BAR_W = 26`, move it to local `y = -26` (above the helm, below the chevron).

**Render it only when `hp < hp_max`.** Twenty always-on bars is twenty rects of chrome over
the exact area the boss art occupies; showing damage only when there is damage removes
most of them for most of the fight and costs one comparison.

---

## 8. Cost, measured, and the fallback

### 8.1 DOM

| | nodes |
|---|---|
| defs | 15 `<g>`, ~60 `<path>` (one per colour per pose), built once in a `useMemo` |
| per seat | 1 `<use>` (knight) + 1 `<use>` (flash) + 1 ellipse + hp bar when damaged |
| 20 seats | **~60 nodes**, of which **20 animate** |

Against the constraint's measured ceiling — 7,589 rects animating transform at 143 fps —
twenty animated nodes is three orders of magnitude inside budget. The rects live inside
`<path d="…">` strings in `<defs>` and are DOM-free.

### 8.2 Rasterisation, and the honest caveat

Worst case is twenty seats all on the same skin: `20 × 447 = 8,940` rects rasterised per
repaint. Mixed skins average `20 × 401 = 8,020`.

That is **above** the 7,589-rect figure from the existing measurement, and the two numbers
are not comparable: the measured 7,589 were rects **animating transform** individually,
while these are static geometry inside 20 referenced subtrees whose only moving parts are
20 transforms.

**I did not measure this.** Whether a browser rasterises a `<use>`'d `<g>` once and blits it,
or re-rasterises per instance, decides whether 8,940 rects is 3 draw calls or 8,940 — and
that varies by engine. Before shipping, run the existing `scripts/spike/perf_clientside.ts`
harness with 20 knights on screen and read the real frame time. A negative result here is
a real finding and there is a prepared answer for it:

> **`ponytail:` SVG `<use>` of a 400-rect `<g>`, 20 instances. Ceiling: per-instance
> rasterisation. Upgrade path: bake each pose to a 33×42 PNG at generation time (Pillow is
> already a dependency of `px2svg.py`), embed as a `data:` URI, and draw `<image
> image-rendering="pixelated">`. 12 poses × ~1.5 KB ≈ 20 KB, and every knight becomes one
> texture blit. Same generator, same table, one output format changed.**

The PNG route is strictly cheaper at render time and strictly worse at author time (a new
output format, a rasteriser in the build). Take it when, and only when, the measurement
says to.

### 8.3 Per-frame CPU

Twenty seats × (2 subs, 2 abs, 1 add, 1 int-divide, 1 compare) ≈ 140 operations per frame,
on top of the two loops that already run. DOM writes are event-driven, not per-frame:
≤ 20 Hz per moving seat for the walk, ~1.7 Hz per idle seat, ≤ 1.25 Hz per shooting seat.

---

## 9. What must be on chain, and what must not

**On chain, and already there:**

| field | drives |
|---|---|
| `skin_id` | which knight is drawn. Cosmetic, but it must be on chain: every player has to see the same knight you chose, and the seat is claimed once with no route that edits it afterwards |
| `x`, `y` | position, and therefore — via the render loops' frame-to-frame delta — the entire walk cycle |
| `facing` | the horizontal flip and the aim stub |
| `hp`, `hp_max` | hit flash (decrease), dead state, hp bar |
| `deaths` | the death *event*, exactly once |
| `respawn_at_tick` | the respawn countdown and its exact end |
| `last_shot_tick` | the shoot recoil, for remote seats as well as your own |

**Purely cosmetic, client-only, never on chain:** the walk frame index, the flip state, the
bob offset, the idle phase, the flash and recoil timers, the chevron, the ground ring, the
draw order.

**Nothing in this specification requires a program change.** No new field, no new
instruction, no layout version bump, no migration. That is the reason `skin_id`'s presence
at `state.rs:705` is the most important single fact in this document: the avatar system was
already built, and what was missing was the art on the other end of the byte.

The one chain-adjacent question this spec raises and deliberately leaves alone:
`PLAYER_HIT_RADIUS = 12` puts the hitbox on the torso and leaves the helm and boots
unhittable (§3.3). Half-resolution art makes that discrepancy 6% instead of 111%. Closing
the last 6% means editing `tick.rs`, and it is not worth a program change.

---

## 10. Dependencies and open questions for the other tasks

1. **Arena / composition owns the viewBox.** §4's inequality — visible span ≤
   `min(box) × dpr / 2` units — is the difference between knights that read as armour and
   knights that shimmer. A 512-unit view satisfies it on every listed configuration; the
   current 1024-unit full-map view satisfies it on none.
2. **Boss owns its draw scale.** §3.4 recommends 2×–3× on `boss.svg`'s 230×270 to land the
   IMAGE B silhouette ratio with the knight held at 33×42. If the boss stays at 1:1, the
   knight is 1:6.4 of it and the composition will read as two similarly-sized fighters.
3. **`svg_slice.py`'s `PARTS` is boss-specific.** `gen_knights.py` reuses `parse`,
   `rasterize` and `merge_rects` but needs its own table (§5.2). Do not generalise
   `svg_slice.py` to take both — a second caller does not justify a parameterised parts
   engine, and the shared functions are already the reusable part.
4. **`SKIN_COUNT` is stated twice** — `worker/src/routes.ts:70` and the length of
   `SKINS` in `CharacterSelect.tsx`, with a comment at `:20` noting they must agree.
   Making `CharacterSelect` import the generated table removes one of the two; the Worker
   cannot import across that boundary and keeps its own constant, which is correct because
   it is a server-side bound, not a render hint.
