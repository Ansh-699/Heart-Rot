# Temple scene — specification

Source of truth for the arena backdrop: what is actually in `assets/sprites/temple.svg`,
how it is mounted so a Players notification cannot touch it, and how it plus five
gradients produces image B's read without a 3D engine.

Nothing here is implemented. Every number says how it was obtained. Measurement scripts
are throwaway and live in the scratchpad; the one worth keeping becomes
`tools/gen_temple.py` (§5.1).

**Chain impact: one generator input, and it is not this document's to change.** See §10.

Companion specs: `docs/art/boss-rig.md` (the creature, `BOSS_SPAWN`, the pit rim),
`docs/art/knights.md` (the avatars). Where they already fixed a number, this document
uses theirs and says so.

---

## 1. What is actually in `temple.svg`

Measured by parsing every `<path>`'s `d` back to a pixel grid, then rendering that grid to
PNG and looking at it at 4×.

```
viewBox   0 0 210 238     width="840" height="952"   (4x display, shape-rendering=crispEdges)
paths     16              one <path> per colour, px2svg's only output shape
subpaths  22,195          every one of the form  M x y h w v h h-w z
bytes     332,218
```

### 1.1 It is not vector art. It is a 16-colour bitmap wearing an SVG costume

The 22,195 rects were expanded onto a 210×238 grid and counted:

| check | result |
|---|---|
| pixels painted | **49,980** |
| canvas area (210 × 238) | **49,980** |
| pixels painted twice | **0** |
| pixels left unpainted | **0** |

Exactly 100 % coverage, zero overlap, zero transparency. Each `<path>` is one palette
index's pixel mask — not a wall, not a pillar, not an object. **There are no semantic
shapes in this file to layer, mask, or animate individually.** Any question of the form
"which path is the foreground rim" has no answer; the answer has to come from geometry.

Written back out as a plain PNG at native resolution: **21,341 bytes**. The SVG is a
**15.6×** inflation of the image it encodes, and it carries no extra information —
re-rasterising it is lossless by construction.

### 1.2 The palette

Sorted by Rec.709 luminance of the 8-bit values.

| # | hex | L | rgb | px | % of canvas | reads as |
|---|-----|---|-----|----|-------------|----------|
| 1 | `#111218` | 18.2 | 17,18,24 | 305 | 0.6 % | deepest void |
| 2 | `#161620` | 22.7 | 22,22,32 | 8,230 | **16.5 %** | the void — top band and bottom corners |
| 3 | `#1f1e24` | 30.6 | 31,30,36 | 357 | 0.7 % | void edge |
| 4 | `#25262b` | 38.1 | 37,38,43 | 4,334 | 8.7 % | deep recess |
| 5 | `#392d28` | 47.2 | 57,45,40 | 678 | 1.4 % | dead wood, darkest |
| 6 | `#2f3035` | 48.1 | 47,48,53 | 1,674 | 3.3 % | recess |
| 7 | `#34363d` | 54.1 | 52,54,61 | 6,021 | 12.0 % | alcove / recessed block |
| 8 | `#463930` | 59.1 | 70,57,48 | 772 | 1.5 % | dead wood |
| 9 | `#3f4040` | 63.8 | 63,64,64 | 2,327 | 4.7 % | shadowed stone |
| 10 | `#494a49` | 73.7 | 73,74,73 | 4,086 | 8.2 % | stone in shade |
| 11 | `#594839` | 74.5 | 89,72,57 | 1,157 | 2.3 % | dead wood, lit |
| 12 | `#5a5349` | 83.8 | 90,83,73 | 590 | 1.2 % | wood highlight |
| 13 | `#565854` | 87.3 | 86,88,84 | 9,587 | **19.2 %** | the wall's base tone |
| 14 | `#5c605c` | 94.9 | 92,96,92 | 6,851 | 13.7 % | lit stone |
| 15 | `#686962` | 104.3 | 104,105,98 | 1,586 | 3.2 % | edge highlight |
| 16 | `#70736b` | 113.8 | 112,115,107 | 1,425 | 2.9 % | brightest — stair newels |

Two facts follow.

* **The whole asset lives in L 18 – 114**, the bottom 45 % of the value range. It is
  already a dark asset. There is no highlight in it above L 114, so image B's rim light and
  cyan orb **must be added** (§6), never extracted.
* **Only four entries carry chroma above sat 15** (`#392d28`, `#463930`, `#594839`,
  `#5a5349`, sat 17–32). Those four are the dead tree, 3,197 px, 6.4 % of the canvas. The
  other twelve are neutral grey (sat 1–10) and regrade cleanly to any hue (§5).

### 1.3 What the picture is

Rendered to PNG at 4× and read directly. It is **a front elevation of a stone temple
wall**, not a cavern and not a pit:

| source rows | mean L | what is there |
|---|---|---|
| 0 – 6 | 23 | solid void, ragged lower edge — a black ceiling band |
| 7 – 70 | 47 – 66 | dark upper wall: recessed alcoves in a regular grid, a **gnarled dead tree** spreading across the centre, and a **horned skull** motif at x 125–155, y 42–58 |
| 71 – 178 | 74 – 91 | the lit masonry face: block courses and repeated carved lozenges, rust/vine staining |
| 179 – 229 | 61 → 33 | a **descending staircase**, centre, flanked by voids that go to solid black |
| 230 – 237 | 23 | solid void |

**The stair, measured.** Mean column luminance over rows 190–230:

```
x  60..74    L 22.7 – 38     pure void  (#161620)
x  75..84    L 78 – 84       LEFT newel   <- the brightest thing in the file
x  85..124   L 54 – 63       the treads
x 125..134   L 79 – 84       RIGHT newel
x 135..150   L 27 – 45       void again
```

Stair axis = (85 + 124) / 2 = **104.5**, against a canvas centre of 104.5. It is dead
centre to the pixel. Riser bands (dark rows inside x 85–124) sit at y **185–188, 193–196,
201–204, 210–212, 218–220, 226–228** — six treads at an ~8 px pitch. The newels stay lit to
y ≈ 220 and then fall off.

**Composition is symmetric, pixels are not.** Comparing `px[y][x]` to `px[y][209-x]`:
**35.2 %** identical. The architecture repeats left/right, the noise does not. There is no
half-file to mirror and no saving to take there.

### 1.4 The tree lands on the gate. Do not move either

The gate is tiles 30..=33 on both axes (`player.rs GATE_MIN_X`), arena 480..559 square.
Under the mapping in §4 that is source `x 98..115, y 111..130`. That box is **22 % dead
wood** against a 6.4 % canvas average — it is the tree's root ball. The gate marker will be
drawn on the root mass at the centre of the temple. That is a free, correct read; leave it.

---

## 2. Depth layers: there are none in the file, and parallax is not wanted

The task asked whether the paths split into background / midground / foreground rim for
parallax. Two independent reasons the answer is no, and the second is the one that decides
it.

1. **§1.1** — the paths are colour masks with 100 % coverage. Cutting depth layers means
   cutting the *raster* by row band. That is possible (`background-position` on three copies
   of one image), but it produces three rasters where one was enough.
2. **There is no camera.** `usePixelFit` (`Arena.tsx:427-449`) sizes the `<svg>` to the whole
   1024-unit arena at an integer device scale and never pans or zooms. Parallax is
   differential motion under a moving camera. With a fixed camera, three layers offset by
   different constants is one layer.

**Skipped: parallax and any layer split. Add when a camera that pans actually exists** —
at which point §3 already proves the cost of moving the layer is nil (`transform` on the
promoted background measured 1.7 ms/frame against 1.8 ms static, table in §3.2).

Depth comes from §6 instead: value ramp, vignette, actor scale, contact shadow, and paint
order. All of them are free, all of them are tunable without regenerating an asset.

---

## 3. The performance contract

All numbers from Google Chrome 151.0.7922.137 headless via Playwright, on this machine,
`--disable-frame-rate-limit --disable-gpu-vsync` (so rAF spacing measures work, not vsync),
viewport 1100×1100, arena 1024×1024, foreground = 20 players + 128 bullets moved by
`style.transform` in one rAF loop, 400 frames × 3 runs per cell, median of the pooled
deltas. Renderer reported by `WEBGL_debug_renderer_info`:
`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)` —
**software raster**. Every raster cost below is therefore pessimistic; every
compositor-only cost is representative. The *ratios* are what this section relies on.

Scripts: `scratchpad/bench/scene{2,4,5,6}.html` + `scene{2,4,5,6}-run.mjs`.

### 3.1 The thing that actually costs frames is not the background. It is `will-change`

Foreground animating, background static, everything at 1024².

| background | `will-change: transform` on foreground | frame median | p95 | fps |
|---|---|---|---|---|
| none | none | 1.8 ms | 3.6 | 556 |
| none | players only | 3.4 ms | 5.4 | 294 |
| none | players + bullets | 1.6 ms | 3.0 | 625 |
| inline SVG, inside the arena `<svg>` | none | **8.6 ms** | 12.3 | 116 |
| inline SVG, inside the arena `<svg>` | players only | **7.9 ms** | 13.4 | 127 |
| inline SVG, inside the arena `<svg>` | players + bullets | **1.9 ms** | 3.6 | 526 |
| inline SVG, separate `<svg>` behind | none | **9.9 ms** | 16.0 | 101 |
| inline SVG, separate `<svg>` behind | players + bullets | **2.0 ms** | 3.2 | 500 |
| 210×238 PNG behind | none | 2.8 ms | 4.6 | 357 |
| 210×238 PNG behind | players + bullets | 2.1 ms | 4.0 | 476 |

Three readings, in order of importance.

* **Promoting every moving node is worth 4–5×.** With all movers promoted, a
  22,195-rect background costs 1.9 ms — 0.1 ms over having no background at all. Without,
  it costs 8.6 ms. An unpromoted mover dirties the paint chunk it shares with the
  background and the whole thing re-rasters.
* **Putting the background in its own `<svg>` element does nothing on its own.**
  9.9 ms vs 8.6 ms — separate-but-unpromoted is if anything worse. "Separate SVG layer" is
  not the fix; **compositor promotion** is. This is the trap the phrase invites.
* **`Arena.tsx` is missing one `will-change` today.** Bullets set it
  (`Arena.tsx:398`); the player `<g key={slot.seat}>` at `Arena.tsx:326` does **not**.
  That is the "players only" row's mirror image and it is a live defect independent of this
  document — partial promotion (row 2: 3.4 ms) measured *worse* than none (1.8 ms).

### 3.2 What a static layer survives, and what kills it

Background present, foreground fully promoted and animating, background subjected to one
mutation per frame.

| background | per-frame mutation | frame median | p95 | vs static |
|---|---|---|---|---|
| inline SVG | none | 1.8 ms | 3.8 | — |
| inline SVG | `transform` translate + scale | 1.7 ms | 3.4 | free |
| inline SVG | `filter: brightness()` | 1.6 ms | 3.6 | free |
| inline SVG | **`viewBox` attribute** | **9.6 ms** | 14.2 | **5.3×** |
| inline SVG | **`innerHTML` rebuild (React remount)** | **11.2 ms** | 16.5 | **6.2×** |
| PNG | none | 1.7 ms | 3.8 | — |
| PNG | `transform` translate + scale | 1.9 ms | 3.9 | free |
| PNG | `filter: brightness()` | 1.7 ms | 3.6 | free |
| PNG | **`innerHTML` rebuild (React remount)** | **3.5 ms** | 6.3 | **2.1×** |

* A composited `transform` or `filter` on a promoted background is **free** at either
  representation. Camera drift, a hit-flash, a fade — all affordable.
* Animating `viewBox` is not a transform; it re-rasters. **Never animate `viewBox`.**
* Re-mounting the layer costs **6.2× with inline SVG and 2.1× with a PNG.** The PNG is not
  merely faster in the good case — it is 3× more forgiving in the bad one. Something
  eventually gets this wrong; choose the representation that survives it.

Attempting the inline-SVG remount at 300 frames **crashed the renderer process**
(`Target page, context or browser has been closed`) on 3/3 attempts. It ran at 120.

### 3.3 One-time cost, and the shipping candidates

Full scene, gradient stack from §6 present, foreground promoted and animating with the
depth scale of §6.4.

| representation | bytes on the wire | build + first layout | frame median | p95 |
|---|---|---|---|---|
| inline `<svg>`, 16 paths | 332,218 | 36.8 ms / 20.4 ms | 3.5 ms | 6.5 |
| **210×238 PNG, CSS-scaled** | **21,341** | **16.7 ms / 19.0 ms** | **3.1 ms / 3.7 ms** | 4.9 / 6.5 |
| 1024×1024 pre-baked PNG | 49,423 | 17.0 ms / 16.0 ms | 3.3 ms / 2.5 ms | 5.9 / 4.4 |

(two figures per cell = without / with the gradient overlay; the five-stop gradient stack
is inside the noise either way — **the lighting in §6 is free**.)

### 3.4 Decision

**Ship the 210 × 238 PNG.**

* It is *the same image*. §1.1 proved the SVG is a lossless-recoverable bitmap; nothing is
  approximated by rasterising it.
* 21 KB against 332 KB, and the browser never parses 22,195 path commands.
* Against the 1024² bake: identical pixels wherever the arena renders at 1024 device px
  (both are nearest-neighbour at the same scale), 2.3× smaller, **4.19 MB vs 0.20 MB of
  decoded-bitmap memory**, and no baked resolution to go stale when `usePixelFit` picks a
  2× or 3× integer scale on a dense display. The bake wins nothing measurable (3.3 vs 3.1 ms)
  and costs a second file to keep in sync.
* Against inline SVG: 6.2× cheaper in the failure mode, and it cannot crash the renderer.

**Skipped: an SVG-native background, a 2× bake, an `<image>` inside the arena `<svg>`.
Add a 2× bake when a display is measured showing visible resample artefacts** — the
source is 210 px wide and no bake can invent detail past that.

---

## 4. Mount specification

### 4.1 Geometry — no crop, no aspect change

`preserveAspectRatio` off; stretch the whole 210 × 238 file across the whole 1024 × 1024
arena. Scales are **x 1024/210 = 4.8762**, **y 1024/238 = 4.3025** — a 11.8 % vertical
squash, invisible on a stone texture read from above and mildly helpful, since a top-down
ground plane is foreshortened anyway.

No crop is needed because the uncropped mapping already lands the zones. `arena_y =
src_y × 4.3025`:

| source rows | arena y | what the game puts there |
|---|---|---|
| 0 – 6 | 0 – 26 | void → dark ceiling edge |
| 7 – 70 | 30 – 301 | dark upper wall + tree + skull → **boss alcove**; the boss sprite occupies y 9 – 224 (`boss-rig.md` §5) |
| 71 – 178 | 305 – 766 | lit masonry → **the pit**, upper two thirds |
| 179 – 229 | 770 – 985 | stair + flanking voids → the pit's south terrace |
| 230 – 237 | 989 – 1020 | void → dark south edge |

Horizontally: the stair newels at source x 75–84 and 125–134 land at arena **x 366–410** and
**x 610–654**, framing the centre channel. `BOSS_SPAWN.x = 512` sits on the tree's trunk
axis (source x 104.5 → arena 509.6, §1.3). Nothing needs nudging.

**The arena stays square and the camera stays fixed.** Image B is a landscape frame, but
1024 × 1024 is `MAP_TILES × MAP_TILE` and is chain geometry. Its read is reproduced by
*zoning a square* — top 30 % boss, bottom 70 % pit — not by cropping playfield away. Two
things were checked and rejected: a letterboxed wide viewport (hides tiles players can
legally stand on) and animating `viewBox` for a camera (§3.2: 5.3× and it re-rasters).

### 4.2 DOM shape

The background is **a sibling of the arena `<svg>`, not a child of it**, and React must
render it exactly once for the life of the scene.

```
<div ref={boxRef}>              existing flex centring box, Arena.tsx:239
  <div class="scene">           NEW  position:relative; the pixel-fitted square
    <div class="scene-bg" />    NEW  the temple raster        z 0
    <div class="scene-light" /> NEW  the gradient stack (§6)  z 1
    <svg id="arena">…</svg>     EXISTING, background:transparent   z 2
  </div>
</div>
```

`usePixelFit` today writes `svg.style.width/height`. It must instead size `.scene`, and
`.scene-bg`, `.scene-light` and the `<svg>` all take `position:absolute; inset:0`. That is
the only change to that hook: one element reference, same arithmetic, and the three layers
stay locked together by construction rather than by three copies of the same number.

```css
.scene      { position: relative; }
.scene-bg   { position: absolute; inset: 0;
              background: url(<templeUrl>) 0 0 / 100% 100% no-repeat;
              image-rendering: pixelated;
              will-change: transform;          /* promote: §3.1 */
              transform: translateZ(0); }
.scene-light{ position: absolute; inset: 0; pointer-events: none;
              will-change: opacity; }
svg#arena   { position: absolute; inset: 0; background: transparent; }
```

`background-image` rather than `<img>`: same cost measured (§3.3), no alt-text or
drag-target semantics to suppress, and no node for a stray `ref` to grab.

### 4.3 Why a Players notification cannot reach it

Four independent barriers, cheapest first. The first alone is sufficient; the rest are
there because "sufficient" has been wrong in this codebase before.

1. **It is not in the component that re-renders.** Mount `.scene-bg` and `.scene-light` in
   the same `useMemo(..., [])` pattern `Arena.tsx:213` already uses for `map` — a stable
   element reference React skips during reconciliation. Notifications land in `arena`,
   `players`, `boss`; none is a dependency.
2. **It has no props derived from state.** The only dynamic value is the URL, a build-time
   import constant. There is nothing for a re-render to write even if one reached it.
3. **It is outside the arena `<svg>`,** so an SVG attribute write cannot dirty its paint
   chunk, and a `usePixelFit` resize writes `.scene` — not the layer.
4. **It is compositor-promoted** (`will-change: transform`), so it holds its own raster.
   §3.1 shows what that is worth: 8.6 ms → 1.9 ms.

The measured worst case if all four are somehow defeated and React remounts it every
frame: **3.5 ms** (§3.2) — degraded, still shippable. The same failure with inline SVG is
11.2 ms, and crashed the renderer at 300 frames.

### 4.4 The rule this must not break

`Arena.tsx:322-325`: *"The frame loop or `useSeatInterpolation` owns this node's transform
outright — nothing else may put a transform attribute on it."* `.scene-bg`'s
`transform: translateZ(0)` is a static promotion hint written once in CSS. **If idle camera
drift is ever added (§6.6), the drift loop becomes that node's sole owner and the CSS
`transform` must be deleted in the same commit.** Two writers, one node, is this project's
signature bug.

---

## 5. The grade — from grey temple to cold shaft

Image B is a cold blue cavern; the asset is neutral grey-brown (§1.2). Three ways to get
there were considered:

* a CSS `filter: hue-rotate()/sepia()` on the layer — free per §3.2, but it grades the
  *rendered* pixels including the gradient stack, and hue-rotate on near-neutral greys
  (sat 1–10) produces almost nothing;
* a `<feColorMatrix>` — same problem, plus a filter primitive on a full-screen layer;
* **remap the 16 palette entries at PNG-generation time.** Zero runtime cost, exact
  per-entry control, and the four wood entries can be handled differently from the twelve
  neutrals — which is the whole point, since a cold cave with a warm dead tree in it *is*
  image B's colour story.

Take the third.

### 5.1 `tools/gen_temple.py`

Input `assets/sprites/temple.svg`, output `app/src/render/temple.png` (imported for its
URL; Vite emits it hashed — `app/tsconfig.json` already carries `vite/client` types) and
`app/src/render/temple.gen.ts` holding the derived constants §6 needs. One fact, one place:
**the grade is derived data and is never hand-edited into a stylesheet.**

Algorithm, exactly as measured:

```
for each of the 16 palette entries c:
    L    = 0.2126*r + 0.7152*g + 0.0722*b            # of the source colour
    u    = clamp((L - 18.2) / (113.8 - 18.2), 0, 1) ** 1.15
    out  = lerp(FLOOR, CEIL, u)
    if c in WOOD:                                     # the four sat>15 entries, §1.2
        out = lerp(out, (r*1.45, g*1.05, b*0.90), 0.42)
    emit clamp(out, 0, 255)

FLOOR = #080c16    CEIL = #3d4a5a    gamma = 1.15
WOOD  = { #392d28, #463930, #594839, #5a5349 }
```

`18.2` and `113.8` are the measured min and max of the palette (§1.2), not guesses — they
belong in the generator as a computed range, not as literals.

**`CEIL = #3d4a5a` is not a taste call, it is solved for.** Sweeping the ceiling and
measuring WCAG contrast of the actor palette against the pit's 75th-percentile background
luminance:

| CEIL | pit p75 (L) | self `#5ef2b5` | ally `#5aa2ff` | dead `#6b6478` |
|---|---|---|---|---|
| `#69809e` | 90 | 4.82:1 | 2.61:1 | 1.21:1 |
| `#566880` | 80 | 5.64:1 | 3.06:1 | 1.41:1 |
| `#47566a` | 68 | 6.86:1 | 3.72:1 | 1.72:1 |
| **`#3d4a5a`** | **59** | **7.90:1** | **4.28:1** | **1.98:1** |
| `#343e4c` | 50 | 9.02:1 | 4.89:1 | 2.26:1 |

`#3d4a5a` is the lightest ceiling that keeps `ally` above 4:1. Anything lighter and the
second-commonest thing on screen stops separating from the floor. Going darker buys little
and flattens the masonry the asset exists to show.

The resulting 16 → 16 map, for review (regenerate, never transcribe):

```
#111218 -> #080c16  L  18 ->  12      #594839 -> #4c3a38  L  75 ->  62   (wood)
#161620 -> #0a0e18  L  23 ->  14      #5a5349 -> #4f4342  L  84 ->  69   (wood)
#1f1e24 -> #0d121d  L  31 ->  18      #565854 -> #2c3745  L  87 ->  54
#25262b -> #111621  L  38 ->  22      #5c605c -> #313c4b  L  95 ->  59
#392d28 -> #2f2426  L  47 ->  38 (w)  #686962 -> #374352  L 104 ->  66
#2f3035 -> #161c28  L  48 ->  28      #70736b -> #3d4a5a  L 114 ->  72
#34363d -> #19202c  L  54 ->  31
#463930 -> #3b2e2e  L  59 ->  49 (w)
#3f4040 -> #1f2633  L  64 ->  37
#494a49 -> #242d3a  L  74 ->  44
```

Computed by running the algorithm above; **the generator is the source of truth and this
table is for review only.** Note what the wood rule buys: `#594839` lands at L 62 against
`#494a49`'s L 44, so the dead tree ends up the *lightest and warmest* thing in the upper
third — which is why the boss's silhouette against it reads at all.

---

## 6. Depth without a 3D engine

Layer order, back to front. Everything below `svg#arena` is CSS on the two new divs;
everything at or above it is inside the existing SVG.

```
z 0  .scene-bg      the graded temple raster                  static, promoted
z 1  .scene-light   five gradients                            static, promoted
z 2  svg#arena  ├── gate marker, existing map decals          static
                ├── pit rim arc                               static  (boss-rig.md §5)
                ├── contact shadows + knights                 frame loop
                ├── bullets                                   frame loop
                └── boss group                                per-tick
```

Bullets **below** the boss group, per `boss-rig.md` §5, so a bullet leaving a muzzle is
hidden by the silhouette for its first frames instead of skating across the creature's
chest.

### 6.1 The gradient stack

One element, five stops, `pointer-events: none`. Measured free (§3.3). These values were
rendered to a full 1024² composite and looked at (§9); they are a tuned starting point, not
a derivation, and they belong in the stylesheet where they can be adjusted without a
rebuild.

```css
.scene-light {
  background:
    /* 1. core-orb spill — the cyan glow image B has at the creature's chest */
    radial-gradient(34% 20% at 50% 16%,  rgba(110,225,255,.30), rgba(110,225,255,0) 100%),
    /* 2. pit light pool — the only broad light source, centred on the players */
    radial-gradient(72% 30% at 50% 52%,  rgba(150,205,235,.20), rgba(150,205,235,0) 100%),
    /* 3. ceiling — sinks the boss alcove so the silhouette reads against near-black */
    linear-gradient(180deg, rgba(5,8,17,.92) 0%, rgba(5,8,17,0) 30%),
    /* 4. south edge */
    linear-gradient(0deg,   rgba(3,6,12,.80) 0%, rgba(3,6,12,0) 28%),
    /* 5. vignette */
    radial-gradient(70% 76% at 50% 56%, rgba(0,0,0,0) 50%, rgba(0,0,0,.70) 100%);
}
```

Stop 3 does the heaviest lifting. The asset's own top band is only 26 arena units tall
(§4.1) and image B needs the creature emerging from darkness across the whole upper third;
stop 3 manufactures that ceiling from a gradient rather than from a crop, so it stays
tunable and costs nothing.

### 6.2 The pit rim

`boss-rig.md` §5 already specifies it: a foreground ellipse arc in the arena layer,
baseline **arena y = 216**, drawn between the boss's `legs` (z=8) and `mace` (z=9) so the
lower body is hidden and both hands read as gripping it. This document adds only that the
temple provides **no ledge at that row** — source y 50, mid upper wall, mean L 56 — so the
rim is entirely drawn geometry. Give it a 3 px `#a8d6f0` upper stroke and a 26 px
`rgba(6,9,16,.85)` → transparent falloff below; that pair is what separates alcove from pit
in the composite.

### 6.3 The value ramp is the depth

After §5 and §6.1, measured over the pit region (arena y 272–992, every 2nd pixel):

```
lit pit background luminance:  p5=9  p25=28  p50=53  p75=63  p95=75  p99=82
```

A 9 → 82 range across the playfield, dark at both ends and lit in the middle. That
gradient *is* the third dimension: near-black at the top reads as "far and unlit", the
bright middle as "where the light falls", the darkening south edge as "the floor drops
away". No perspective transform, no second raster.

### 6.4 Actor scale by depth

The frame loop already writes `el.style.transform = translate(x, y)`
(`Arena.tsx:168, 185, 201`). Append a scale term to the same string:

```
s = 0.80 + 0.40 * (y / 1024)          clamp not required: y is chain-clamped to 0..1023
transform = `translate(${x}px, ${y}px) scale(${s.toFixed(3)})`
```

A knight at the pit's north edge draws at 0.80×, at the south edge at 1.19× — a 1.5×
near/far ratio, which is what sells an orthographic plane as a receding one.

**Measured cost: 2.0 → 2.5 ms/frame** at 20 players + 128 bullets, software raster, same
harness (`scene6.html?noscale=0|1`). +0.5 ms for the single strongest depth cue in the
scene.

**This is cosmetic only.** `PLAYER_HIT_RADIUS = 12` (`tick.rs`) and every collision live on
chain in unscaled arena units. The scale must be applied to the rendered `<g>` and to
nothing that feeds a hit test. `PLAYER_R = 10` stays 10; `sprites.ts:38`'s promise that
"a touch is a hit" is a statement about the *hit* radius and survives, but a knight drawn
at 1.19× now overhangs its hitbox by 2 px at the south edge. That is the correct trade —
the alternative is scaling hitboxes, which is chain state.

### 6.5 Contact shadow

The one thing that stops a sprite looking pasted onto a texture. One `<ellipse>` inside
each actor's already-transformed `<g>`, so it inherits the translate and the depth scale
for free and adds **zero moved nodes**:

```
<ellipse cx="0" cy={PLAYER_R} rx={PLAYER_R * 0.9} ry={PLAYER_R * 0.4}
         fill="#000" opacity=".42" />
```

Painted first inside the group, so the knight sits on it. Under the boss, the same shape at
`rx=115, ry=26` on the rim baseline.

### 6.6 Idle camera drift — offered, not recommended

`transform` on the promoted background measured free (1.7 ms vs 1.8 ms static, §3.2), so a
±8 px sinusoidal drift on `.scene-bg` and `.scene-light` is affordable. It is also a second
rAF consumer and a transform-ownership hazard (§4.4).

**Skipped. Add when the scene has been seen in motion and reads as static** — and if
added, delete the CSS `transform` from `.scene-bg` in the same commit and drive both divs
from the one existing frame loop, never a second one.

---

## 7. What this breaks in the current renderer

Ranked by how quietly it fails.

1. **`PAL.dead` stops working.** `sprites.ts:76-78` requires three separations to survive.
   Against the lit pit background:

   | actor | vs p50 | vs p95 | vs p99 |
   |---|---|---|---|
   | `self #5ef2b5` | 8.65:1 | 6.11:1 | 5.48:1 |
   | `ally #5aa2ff` | 4.69:1 | 3.31:1 | 2.97:1 |
   | `bullet #ffb347` | 6.87:1 | 4.85:1 | 4.35:1 |
   | `hpFill #8bd450` | 6.78:1 | 4.78:1 | 4.29:1 |
   | **`dead #6b6478`** | **2.17:1** | **1.53:1** | **1.37:1** |

   A dead knight is a mid-grey hollow ring on a mid-grey stone floor. It vanishes. It did
   not before, because `PAL.floor` is `#17151b` (L 21) and everything had 6–9:1 headroom.
   **The fix is not a new fill colour** — no mid-value fill contrasts with a mid-value
   ground. The fix is that every actor carries its own dark edge, which is exactly what
   image A's knights do and what `knights.md` specifies. Constraint on this scene, stated
   as a number the generator can assert: **keep the lit pit inside L 28–75 (p25–p95)**, well
   within the actors' own internal range (outline L 14 → highlight L 206), so every knight
   has both a darker and a lighter edge available against any pixel of floor it stands on.
2. **`Arena.tsx:326` — the player `<g>` has no `will-change: transform`.** Live defect
   today (§3.1: partial promotion measured *worse* than none, 3.4 ms vs 1.8 ms); with this
   background it becomes a 4× regression. Add it in the same commit as the layer, or before.
3. **`usePixelFit` sizes the wrong element.** It writes `svg.style.width/height`
   (`Arena.tsx:441-443`); it must write `.scene` (§4.2) or the three layers desynchronise on
   every resize.
4. **`svg#arena` needs an explicit transparent background.** It currently paints nothing,
   which is why the memoised `map`'s full-arena `<rect fill={PAL.floor}>` (`Arena.tsx:217`)
   exists. That rect now covers the temple and must go, along with `MAP_WALL_PATH` /
   `MAP_RIM_PATH` if the temple replaces them — decide that against `map.rs`, because the
   walls the chain raycasts are still real and hiding them makes collision look like lag.
   **The gate rect (`Arena.tsx:220-229`) stays**: it is the whole of matchmaking, and §1.4
   shows it lands on the tree's root ball, which flatters it.
5. **`boss.svg` carries an opaque plate that will cover the temple.** Rows **216–269**, all
   230 px wide, 9,844 px of `#2c3436` — already identified in `boss-rig.md` §1 as "the baked
   in floor strip". Rendering the boss over this scene without cropping it draws a solid
   dark rectangle across the arena; it is visible in the first composite in §9. Cropping to
   rows 0–215 is `boss-rig.md`'s change, not this one's, but this scene is where it shows.

---

## 8. Open question for the boss task, with the number

At 1:1 the boss sprite is 230 units wide in a 1024 arena — **22.5 % of the frame**. In
image B the demon spans roughly 55 %. Reaching that means drawing the boss at ~2.2× and
scaling `PART_HITBOXES` to match, which is `tools/gen_hitboxes.py` input and therefore
`hitboxes.rs` and therefore chain state (§10).

Drawing the boss scaled while leaving hitboxes at 1× is not an option: `boss-rig.md` §4.1
already records three of four muzzles firing from transparent pixels, and a 2.2× visual
offset would make every part unshootable where it looks.

**Not this document's call.** Recorded here because the scene is where the proportion is
judged, and because §4.1's zone mapping has headroom for it: the boss alcove runs to arena
y 301 and a 2.2× sprite from y 9 spans to y 483 — it would overrun into the pit and the
`BOSS_SPAWN` y would have to come back up. Raise it with the boss task before either side
commits.

---

## 9. Evidence

Composites rendered at 1024² by applying §5 and §6 to the real rasters and downsampled for
review. All in the scratchpad, none in the repo:

* `temple.png`, `temple-4x.png` — the file rasterised from its own path data, ungraded.
  This is what proved §1.1 and §1.3.
* `prev-cool.png`, `composite2-512.png`, `composite3-640.png` — the grade and lighting at
  an earlier, lighter ceiling (`#69809e` / `#8ea8c6`), kept because they are what drove the
  §5 contrast sweep. **They are not the specification**; the mid-band brightness visible in
  them is the failure the sweep then solved.
* **`composite4-640.png` — the specification rendered.** Uncropped stretch (§4.1), §5 grade
  at the solved `CEIL = #3d4a5a`, §6.1 gradients, the §6.2 rim arc at y 216, `boss.svg`
  cropped to rows 0–215 at `BOSS_SPAWN = (512,144)`, twenty depth-scaled actors with §6.5
  contact shadows. It reads as image B: the boss top-centre against a near-black alcove, a
  lit rim arc, players small and scattered in a lit pit, dark corners, the stair as a south
  terrace, and the tree — which the §5 wood rule leaves the lightest warm thing on screen —
  hanging behind the creature like its own roots.
* `composite-512.png` — the same scene with `boss.svg` **un**cropped. The opaque plate of
  §7.5 is the dark rectangle across the boss's legs.

Benchmarks: `bench/scene2.html`+`scene2-run.mjs` (same-svg vs split),
`scene4` (invalidation modes), `scene5` (`will-change` matrix — the §3.1 table),
`scene6`+`s6b.mjs` (shipping candidates, gradient stack, depth-scale isolation).

---

## 10. Chain impact

**None from this document.**

Every number the scene consumes — `MAP_TILES = 64`, `MAP_TILE = 16`, the 1024-unit arena,
`GATE_MIN/MAX` at tiles 30..=33, `BOSS_SPAWN` — is read, never written. The one chain
change the scene depends on is `BOSS_SPAWN = (512, 144)`, already specified and derived in
`boss-rig.md` §5, authored as the `B` marker in `assets/map/arena.json` and emitted by
`tools/gen_map.py`. **Do not edit `map.rs`.**

Two things this document deliberately keeps cosmetic:

* **Depth scale (§6.4)** — rendered transform only. `PLAYER_HIT_RADIUS = 12` and every
  collision stay in unscaled arena units. A knight drawn at 1.19× overhangs its hitbox by
  2 px at the south edge; that is accepted, and the alternative (scaling hit radii by
  screen position) would make the same input behave differently at different y, on chain.
* **Grade, gradients, vignette, contact shadow, rim arc** — pixels only. Nothing reads
  them back.

The one thing that would be chain state is **§8's boss scale**, because it moves
`PART_HITBOXES` and therefore `hitboxes.rs`. That belongs to the boss task and is flagged,
not taken.

---

## 11. Change list, in dependency order

1. `Arena.tsx:326` — `will-change: transform` on the player `<g>`. Independently correct
   today; **blocking** for anything else here (§3.1, §7.2).
2. `tools/gen_temple.py` — §5.1. Emits `app/src/render/temple.png` and
   `app/src/render/temple.gen.ts`. Generated output is never hand-edited.
3. `Arena.tsx` — the `.scene` wrapper and the two layer divs, in one `useMemo(…, [])`
   (§4.2). `usePixelFit` retargeted to `.scene` (§7.3).
4. Stylesheet — `.scene-bg`, `.scene-light` (§4.2, §6.1).
5. `Arena.tsx` — retire the memoised `map`'s floor rect; decide wall/rim path fate against
   `map.rs`; keep the gate rect (§7.4).
6. `Arena.tsx` — pit rim arc at y 216, between the boss's `legs` and `mace` (§6.2, and
   `boss-rig.md` §5 for paint order).
7. Frame loop — append the depth scale to the three `transform` writes (§6.4); contact
   shadow inside each actor group (§6.5).
8. Raise §8 with the boss task before either side commits to a sprite scale.
