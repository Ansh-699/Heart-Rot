# Boss rig — `assets/sprites/boss.svg`

Specification only. Nothing here was implemented. Every number below was measured by
rasterising the checked-in SVGs with a throwaway script (regex over the `M x yh w v h h-w z`
grammar `px2svg.py` emits, painted into a 230×270 numpy grid) — the same grammar
`tools/svg_slice.py` parses, so the numbers are the ones the toolchain already agrees on.

Sizes as measured, not as remembered: `assets/sprites/boss.svg` is **118 187 bytes**,
13 `<path>` elements, `viewBox="0 0 230 270"`. `assets/sprites/parts/boss.svg` is
121 820 bytes, 13 `<g id="part-*">` groups.

`python3 tools/gen_hitboxes.py --check` exits **0** today: `hitboxes.json`,
`programs/heartrot/src/hitboxes.rs` and `packages/client/src/hitboxes.ts` are in sync.
Any change proposed here must be made in `svg_slice.py` / `hitboxes.json` and regenerated,
never typed into the two generated files.

---

## 1. The 13 paths are colours, not body parts

The task asked which of the 13 paths is the horn, the jaw, the claw. **None of them is.**
`px2svg.py` emits one path per quantised colour spanning the whole creature. Measured
per-path bounding boxes prove it — nine of the thirteen span nearly the entire 230×270
canvas:

| # | fill | rects | px | bbox `x,y,w,h` | centroid | what it actually is |
|---|---|---:|---:|---|---|---|
| 0 | `#af8c92` | 1765 | 4864 | 72,10,151,255 | 146.5,130.1 | mid flesh — whole body |
| 1 | `#936975` | 1531 | 4033 | 69,11,152,254 | 147.5,132.3 | shadow flesh — whole body |
| 2 | `#c9aab0` | 1490 | 5345 | 73,8,149,257 | 147.4,137.8 | light flesh — whole body |
| 3 | `#753757` | 1096 | 3208 | 68,15,147,249 | 143.4,131.6 | deep magenta shade — whole body |
| 4 | `#69623e` | 372 | 950 | 1,29,227,208 | 101.9,141.1 | olive — thorn/ornament family |
| 5 | `#5e5430` | 350 | 759 | 3,30,225,207 | 114.2,130.4 | olive — thorn/ornament family |
| 6 | `#ddc5c5` | 307 | 1225 | 77,7,144,228 | 158.2,119.0 | rim light — whole body |
| 7 | `#2c3436` | 220 | **9844** | **0,216,230,54** | 110.5,244.6 | **the baked-in floor strip, and only that** |
| 8 | `#8a7559` | 171 | 609 | 3,22,205,214 | 103.3,119.2 | olive — thorn/ornament family |
| 9 | `#401a36` | 154 | 889 | 128,72,78,173 | 150.0,156.8 | darkest — cavities and gaps |
| 10 | `#36371c` | 129 | 371 | 15,56,149,174 | 70.8,183.8 | olive — thorn/ornament family |
| 11 | `#fff8e8` | 3 | 7 | 137,81,9,2 | 140.9,81.9 | **specular — the eye pair** |
| 12 | `#fcfae6` | 1 | 1 | 145,82,1,1 | 145.5,82.5 | specular — right eye core |

Total painted 32 105 px of 62 100 (51.7 % coverage).

Two paths *are* anatomically meaningful because they are used in exactly one place:

* **Path 7 `#2c3436`** — 9844 px, bbox exactly `0,216,230,54`, appears nowhere else. This is
  the scene floor baked into the sprite. It is byte-for-byte the `ground` hitbox entry in
  `hitboxes.json` (`x:0 y:216 w:230 h:54 pixels:9844`).
* **Paths 11 + 12** — the only near-white pixels in the file, 8 px total, in **two 2×2 blocks
  at sprite (137,81) and (144,81)**: same row, 7 px apart, symmetric about x≈141.5. That is
  an eye pair and nothing else in the sprite reads that way. In part space they land inside
  `torso` (a decorative group, `index: null`).

Anatomy therefore has to come from a **spatial** partition, which is exactly what
`tools/svg_slice.py` already does. That partition is the rig. This section exists so nobody
re-opens `boss.svg` looking for a horn path.

---

## 2. What the creature actually is

Rasterised part map, one character per 4×5 px block (`G` ground, `C` crown, `W` wolf_l,
`B` beast_r, `T` torso, `O` core, `L` legs, `M` mace, `K` claws, `a b c d` thorn0..3):

```
  5 .....................................CCC.CCCCC............
 15 ...................................CCCCCCCCCCCCC..........
 25 .........................aa......CCCCCCCCCCC.CCC..........
 35 ..........................aa..CCCCCCCCCCCCCCCCC.b.bb......
 45 ........................aa.aaTCCC.CCCCCCC.C...bbbb........
 55 ......................WWWaWWWWTTTCCCCCCCCCCCBBBBbb........
 65 .....................WWWWWWWWWTTTTTTTTTTTTTBBBBBBbbb....b.
 75 ....................WWWWWWWWWWTTTTTTTTTTTTTBBBBBBBBB...bb.
 85 .................WWWWWWWWWWWWWTTTTTTTTTTTTTBBBBBBBBBBB.b..
 95 .................WWWW.WWWWWWWWOOOOOOOOOOTTTBBBBBBBBBBBBT..
105 .....................ccccMMMTTOOOOOOOOOOTTTKKKKKKKKKKKK...
115 .....................cMMcMMMTTOOOOOOOOOOTTTKKKKKKKKKKKKK..
125 .....................MMMMMMMTTOOOOOOOOOOTT.KKKKKKKKdd.....
135 .........MMM.......MMMMMMMM.TTOOOOOOOOOOTTKKKKKKKKKddddd..
145 ..................MMMMMMMM.MLLLLLLLLLLLLLLLKKKKKKKK.......
155 ...............MM....MMMMMLLLLLLLLLLLLLLLLL..KKKKKK.......
165 .................MM..MMMMMLLLLLLLLLLLLLLLLLKKKKKKKKKKK....
175 .................MMMMMMMM.LLLLLLLLLLLLLLLL..KKKKKKKKKK....
185 .............MMMMMMMMMMM.MLLLLLL.LLLLLLLLLL.KKKKKKKKKK....
195 ...........MMMMMMMMM.MMM..LLLLL..LLLLLLLLLLK...KKKK.......
205 ........MMMMMMMMM.M.....MMLLLLL....LLLLLLLLLLLLL..........
215 GGGGGMMMMMGGGGGGGGGGGGGGGGLLLLLLGGGGGGGLLLLLGLLLLLGGGGGGGG
235 GGGGGGGGGGGGGGGGGGGGGGGGGGGLLLGLGGGGGGGGLLLLLLGGGGGLGGGGGG
255 GGGGGGGGGGGGGGGGGGGGGGGLLLLLLLLLGGGGGGGLLLLGLGGGGGGGGGGGGG
```

It is an **upright bipedal figure standing on a floor**, not the pit-gripping torso of
reference image B. Head/helm at top, two beast-headed pauldrons at shoulder height, a
chest cavity, a left arm swinging down-left to a mace ball, a right clawed arm, two legs,
and 54 px of floor.

Measured: creature bbox excluding `ground` is **x 1..227, y 7..264**, 22 261 px,
mass centroid **(141.3, 133.6)**, widest row y=94 at 153 px.

Anatomical reading of each `<g>`, with the geometric evidence:

| `<g>` | px | bbox | reading | evidence |
|---|---:|---|---|---|
| `crown` | 2334 | 122,7,67,59 | horned helm / skull, top of the figure | topmost mass; contains the olive ornamental bosses at x152..172 y26..64 |
| `wolf_l` | 1635 | 68,49,50,53 | left shoulder beast-head | mirrors `beast_r` across the torso; 1635 vs 1528 px, 3 px difference in height |
| `beast_r` | 1528 | 172,52,46,52 | right shoulder beast-head | as above |
| `thorn0` | 96 | 99,28,21,36 | horn spray above the left pauldron | pure olive (`#69623e/5e5430/8a7559`), diagonal, 12.7 % box fill |
| `thorn1` | 239 | 180,37,48,65 | horn spray above the right pauldron | pure olive, longest spray, 7.7 % box fill |
| `thorn2` | 155 | 85,98,20,23 | spike at the left elbow | pure olive, sits on the `mace` arm |
| `thorn3` | 75 | 203,127,24,17 | spike on the right forearm | pure olive, sits on the `claws` arm |
| `mace` | 3001 | 1,102,111,137 | **left arm + mace ball** | contiguous diagonal from shoulder (104,106) to a ball at x1..103 y208..239 |
| `claws` | 2707 | 170,97,52,110 | **right clawed arm + hand** | widest at y170..174, x173..215 — the splayed hand |
| `core` | 1794 | 120,95,40,45 | chest socket | contains the sprite's single largest dark blob |
| `torso` | 2669 | 112,48,111,99 | chest/shoulder mass | catch-all; holds the eye pair at (137,81),(144,81) |
| `legs` | 6028 | 90,147,117,118 | both legs | starts at exactly y=147, runs to y=264 |
| `ground` | 9844 | 0,216,230,54 | floor strip | one exclusive colour |

**The chest cavity is real geometry.** Connected-component analysis of the darkest colour
`#401a36` finds four blobs ≥20 px; the largest is **345 px at bbox (128,104) 22×23** — a dark
socket in the middle of the chest. The other three are the leg gap (273 px at 131,151 20×57)
and two floor shadows under the feet. So the socket at (128..150, 104..127) is the vent, and
it is the only cavity in the sprite.

**There is no glowing orb.** Reference image B has a bright cyan orb at the demon's chest;
`boss.svg` has a *dark hole* there and 8 near-white pixels 23 rows higher, at the eyes. The
orb has to be drawn by the renderer, not extracted from the art. §6 says where.

---

## 3. Part decomposition — keep it, do not redo it

`Boss.parts` is `[u16; 9]` (`state.rs:55`, `N_PARTS = 9`). The existing `part_index` in
`hitboxes.json` is correct and should not be re-cut:

* **Destructible, index-aligned with `Boss.parts`:**
  `0 crown`, `1 wolf_l`, `2 beast_r`, `3 thorn0`, `4 thorn1`, `5 thorn2`, `6 thorn3`,
  `7 mace`, `8 claws`.
* **Core / vent:** `core` (`index: null`). Shot at, but its hp lives in `Boss.core_hp`, and
  `shoot.rs` only decrements it while `vent_open == 1`. `vent_open` is recomputed each tick
  in `tick.rs:551-552` from `sum(parts) × 100 < sum(parts_max) × 35`.
* **Decorative, animated, never shot at:** `torso`, `legs`, `ground` (all `index: null`).

The four `thorn*` parts are also the **volley emitters** — `gen_hitboxes.to_muzzles()`
derives `MUZZLES` from any part whose name starts with `thorn`, and `tick.rs:690-696` gates
each emitter on `boss.parts[muzzle.part] != 0`. Destroying a thorn silences one emitter.
That coupling is load-bearing; keep the naming convention.

---

## 4. Five measured defects in the rig as it stands

Ranked by how visible each one will be once the art is actually on screen.

### 4.1 Three of the four muzzles fire from transparent pixels

`to_muzzles()` uses the **box centre**. Measured, against the drawn mask:

| thorn | muzzle sprite | on a drawn pixel? | reachable by the raycast? |
|---|---|---|---|
| thorn0 | (109,46) | **no** | yes |
| thorn1 | (204,69) | **no** | **no — inside `beast_r`'s box** |
| thorn2 | (95,109) | yes | yes |
| thorn3 | (215,135) | **no** | yes |

Today this is invisible: the boss is a circle. The moment the sprite is drawn, three of four
volleys spawn in mid-air beside the creature.

**Fix, one fact one place:** the muzzle must be a *drawn* pixel, and only `svg_slice.py` owns
the pixels. Have the slicer write a `muzzle: [x, y]` field into each `thorn*` entry in
`hitboxes.json` — the drawn pixel nearest the mask centroid — and have `to_muzzles()` read
that field instead of computing a box centre. `gen_hitboxes.py` keeps its existing assert
that the muzzle lies inside its own `Rect`, which still holds.

Measured values for that field (nearest drawn pixel to the mask centroid), sprite then
boss-local (`ANCHOR = (-115, -135)`):

| thorn | centroid | muzzle sprite | muzzle local | today's local |
|---|---|---|---|---|
| thorn0 | (107.7, 45.0) | (109, 44) | **(-6, -91)** | (-6, -89) |
| thorn1 | (205.5, 63.3) | (205, 63) | **(90, -72)** | (89, -66) |
| thorn2 | (94.4, 110.0) | (94, 110) | **(-21, -25)** | (-20, -26) |
| thorn3 | (211.2, 135.3) | (211, 135) | **(96, 0)** | (100, 0) |

The deltas are 2–6 units. Small on chain, but the difference between a bullet leaving a horn
and a bullet appearing next to one.

### 4.2 Hitboxes overlap; the first live part in array order wins

`shoot.rs:184-188` walks `PART_HITBOXES` in order and returns the first live part containing
the sample point. Measured overlap: **3367 px covered by more than one box**, over
x 85..221, y 37..143. Pairs:

| pair | overlap px | region | winner |
|---|---:|---|---|
| beast_r × thorn1 | **1900** | 180,52 38×50 | beast_r |
| mace × thorn2 | 380 | 85,102 20×19 | thorn2 |
| claws × thorn3 | 323 | 203,127 19×17 | thorn3 |
| beast_r × claws | 322 | 172,97 46×7 | beast_r |
| wolf_l × thorn0 | 285 | 99,49 19×15 | wolf_l |
| crown × thorn1 | 261 | 180,37 9×29 | crown |
| crown × beast_r | 238 | 172,52 17×14 | crown |
| thorn1 × claws | 210 | 180,97 42×5 | thorn1 |
| wolf_l × thorn2 | 80 | 85,98 20×4 | wolf_l |

Consequence, measured by replaying the first-match walk with every part alive:

| # | part | box area | reachable | box lost | own art reachable |
|---|---|---:|---:|---:|---|
| 0 | crown | 3953 | 3953 | 0.0 % | 2334/2334 = 100 % |
| 1 | wolf_l | 2650 | 2650 | 0.0 % | 1635/1635 = 100 % |
| 2 | beast_r | 2392 | 2154 | 9.9 % | 1379/1528 = 90 % |
| 3 | thorn0 | 756 | 471 | 37.7 % | 65/96 = 68 % |
| 4 | **thorn1** | 3120 | 1085 | **65.2 %** | **136/239 = 57 %** |
| 5 | thorn2 | 460 | 380 | 17.4 % | 149/155 = 96 % |
| 6 | thorn3 | 408 | 408 | 0.0 % | 75/75 = 100 % |
| 7 | mace | 15207 | 14827 | 2.5 % | 2827/3001 = 94 % |
| 8 | claws | 5720 | 5055 | 11.6 % | 2685/2707 = 99 % |

`thorn1` is a volley emitter whose art is 57 % unhittable while `beast_r` lives, and whose
muzzle sits in the unreachable part. A player aiming at the horn that is shooting at them
hits the pauldron instead.

**Fix:** claim order in `shoot.rs` is `PART_HITBOXES` order, which is `part_index` order,
which is the `index:` field in `svg_slice.PARTS`. Renumber so the four thorns are indices
0..3 and `crown, wolf_l, beast_r, mace, claws` are 4..8. Small-and-specific before
large-and-general is the same rule the slicer already applies to *claiming* pixels; the
raycast should use the same rule. Then regenerate. Nothing else needs to change:
`reset_for_incarnation` sets every part from one uniform array (`state.rs:1134` uses
`[1_500; N_PARTS]`), so index identity is not persisted anywhere that matters.

### 4.3 Thorn boxes are mostly air

Box fill measured as drawn-px ÷ box-area: `thorn1` **7.7 %**, `thorn0` **12.7 %**,
`thorn3` 18.4 %, `mace` 19.7 %, `thorn2` 33.7 %, `claws` 47.3 %, `crown` 59.0 %,
`wolf_l` 61.7 %, `beast_r` 63.9 %.

This is intrinsic: a diagonal spray inside an axis-aligned tight bbox is mostly empty, and
`gen_hitboxes.py` already refuses any box thinner than `TILE = 16` on either axis, so the
boxes cannot be tightened much further. **Recommendation: accept it and do not chase it.**
With the boss fixed at top centre and players firing upward from a pit, a generous horn
hitbox is a fairness feature, not a bug. Fixing 4.2 (reordering) is what actually matters,
because that is where a shot lands on the *wrong* part rather than merely a generous one.

### 4.4 The vent circle is 3.6× the drawn cavity

`CORE_X = 25, CORE_Y = -18, CORE_RADIUS_SQ = 400` — sprite centre (140,117), r = 20,
area **1257 px**. Of those, 1256 are painted creature (so the circle is not off the body),
but only **345 are the dark `#401a36` cavity**. The circle also overlaps **0 px** of any part
hitbox, which is correct and worth preserving.

The hitbox cannot shrink to the cavity: `min(w,h)//2` from a 22×23 cavity gives r = 11, and
a vent that small is unhittable at range. So the **art** must grow to the box, not the box
shrink to the art. See §6.4.

### 4.5 `Boss.x` is not the creature's centre of mass

`ANCHOR_X = -round(230/2) = -115`. Measured: the creature's **bounding box** centre is
x = (1+227)/2 = **114**, one pixel from the canvas centre. Its **mass centroid** is
x = **141.3**, twenty-six units right of it, because the `mace` arm is a thin sweep reaching
to x=1 while the right side is dense.

For a symmetric top-centre composition the silhouette is what the eye centres on, and the
silhouette is already centred. **Recommendation: leave `ANCHOR_X` and `BOSS_SPAWN.x` alone.**
Recorded here only so nobody "fixes" a 26-unit offset that is a centroid artefact, and
because `BOSS_SPAWN` is tile-granular (multiples of 16) and therefore cannot express a
26-unit correction anyway.

---

## 5. Top-centre composition — geometry, not new machinery

The brief said `BOSS_SPAWN = (512, 320)`. It is **`(512, 512)`, tile (32,32)** —
`map.rs:142`. `MAP_TILES = 64`, `TILE = 16`, so the arena is 1024×1024 and the boss is at
its exact centre.

**Recommendation: `BOSS_SPAWN = (512, 144)`, tile (32, 9).** Derivation and clearance, all
measured against the generated tables:

* Highest hitbox is `crown` at local y = −128, so the topmost hittable pixel lands at arena
  y = 144 − 128 = **16** (tile row 1).
* The sprite canvas top-left is `(boss.x − 115, boss.y − 135)` = **(397, 9)**, on-map.
* `WALLS` row 9 has only bit 2 set; tile (32,9) is open, so the `map.rs:170-173` assert that
  `BOSS_SPAWN` is not in a wall holds. Tile rows 8..15 are all clear across tx 25..40.
* Lowest hitbox is `mace` at local y = −33+137 = +104 → arena y **248** (tile 15.5). The pit
  floor for players therefore starts around tile row 17 and runs to row 62.
* `BOSS_SPAWN` is authored as the `B` marker in `assets/map/arena.json` and emitted by
  `tools/gen_map.py`. Move the marker; do not edit `map.rs`.

### Occlusion is paint order, and it costs nothing

Reference image B needs the lower body gone and the hands gripping a pit rim. Both fall out
of one inserted layer, with **no hitbox change at all**, because every part it hides has
`index: null` and is therefore not shot at:

`svg_slice.PARTS` already carries a `z` field (paint order, back to front) that is separate
from claim order: `ground 0, thorn0 1, thorn1 2, crown 3, wolf_l 4, beast_r 5, torso 6,
core 7, legs 8, mace 9, claws 10, thorn2 11, thorn3 12`.

Insert the pit rim **between `legs` (z=8) and `mace` (z=9)**. Then:

* `ground` (z=0) and `legs` (z=8) are painted before the rim and disappear behind it.
* `mace` (z=9) and `claws` (z=10) are painted after it, so the hands read as gripping it.

Measured row profiles justify a rim baseline at sprite **y = 207**:

* `legs` occupy exactly y 147..264 and are fully hidden by any rim at or above y=147.
* `claws` runs y 97..207 and is widest — the splayed hand — at **y 170..174, x 173..215**.
* `mace` runs y 102..239; the ball sits at **y 208..239, x 1..103**.
* At rim y=207, **85 % of the creature's 22 261 px is above the line**, both hands are drawn
  over it, and the mace ball hangs into the pit — which is what image B shows.

The rim is a foreground ellipse arc drawn in the arena layer, not part of the boss group,
and it does not move. Draw the **bullet layer beneath the boss group** so a bullet leaving a
thorn is hidden by the silhouette for its first few frames instead of skating across the
creature's chest.

---

## 6. Animation specification

Two hard constraints from this project's measured history govern every entry.

**(a) `Arena.tsx:265` is `<g transform={translate(boss.x boss.y)}>`. The frame loop owns that
node.** No animation may touch it. Every animation below lives on a **child** `<g>`, with
`transform-box: fill-box` and an explicit `transform-origin`, so a second writer never
appears on the same transform.

**(b) 68.4 % of `Players` notifications during a fight carry no position change, and the
Magic Router delivers every notification twice.** Anything edge-triggered must therefore fire
on a *value change*, compared against the previous snapshot, and must be idempotent under a
duplicate delivery of the same value. Nothing may be triggered by "a notification arrived".

Node structure this assumes (three nested groups, one writer each):

```
<g id="boss-pos">      transform: translate(boss.x, boss.y)   <- rAF loop, existing, untouched
  <g id="boss-breathe">                                       <- CSS keyframes only
    <g id="boss-shell" style="--shell: 0.62">                 <- React, once per snapshot
      ... 13 part groups ...
```

| animation | driver | technique | spec |
|---|---|---|---|
| **6.1 idle breathing** | nothing — always on | **CSS `@keyframes`** on `#boss-breathe` | `scale(1) → scale(1.014) → scale(1)`, 3.4 s, `ease-in-out`, `infinite`. `transform-box: fill-box; transform-origin: 115px 200px` (sprite pixels — the hips, so the head rises and the feet do not). Compositor-owned, zero JS, survives every notification. `animation-duration: calc(3.4s * (0.5 + var(--shell) * 0.5))` makes breathing quicken as the shell falls, at no extra cost. |
| **6.2 eye glow** | nothing — always on; intensity from `--shell` | **CSS `@keyframes`** on two added `<circle>`s | The art has only 8 near-white px, too small to see. Draw two circles at boss-local **(22,−54)** and **(29,−54)** (sprite (137,81),(144,81)), `r=4`, over the `torso` group. Animate `opacity: 0.55 ↔ 1` and `r: 4 ↔ 5`, 1.9 s, `ease-in-out`, `infinite`, the two offset by 0.35 s so they do not pulse in lockstep. Colour interpolated from `--shell`: cold at full shell, red at the enrage end. |
| **6.3 damage flinch, per part** | `boss.parts[i]` **decreasing** between consecutive snapshots | **Web Animations API**, one `el.animate(...)` call per event | Keep the previous `parts` array in a ref. On a snapshot, for each `i` where `next[i] < prev[i]`, call `partEl[i].animate([...], {duration: 180, easing:'ease-out'})` and store the new array. A duplicate notification produces `next[i] === prev[i]` and fires nothing — this is the (b) requirement, satisfied structurally rather than by a debounce timer. Keyframes: `translate` 3 px along the outward normal from the boss centre plus `filter: brightness(2.2)` at 15 %, back to rest at 100 %. Fire-and-forget; no rAF, no React state, no re-render. Outward normal per part = its hitbox centre minus (0,0), normalised — derived, not tabulated. |
| **6.4 vent-open reveal** | `boss.ventOpen === 1` (recomputed on chain every tick, `tick.rs:551`) | **CSS class toggle** on `#boss-shell` | A boolean state, not a duration, so it must not be a JS animation. Add `<circle class="vent" cx="25" cy="-18" r="20">` — **exactly `CORE_X`, `CORE_Y`, `sqrt(CORE_RADIUS_SQ)` imported from `@heartrot/client`, never literals** — inside the `core` group. Sealed: `opacity: 0`. Open: `opacity: 1`, plus a 1.1 s infinite `r: 20 → 23` pulse and a `drop-shadow`. This is the fix for §4.4: the drawn glow becomes the hit circle, so the 912 px of the circle that are not the dark cavity stop being a lie. One 0.4 s `ease-out` transition on `opacity` covers the open/seal moment. |
| **6.5 enrage** | `arena.tick >= ENRAGE_AT_TICK` (`init.rs:190`, `ticks_for(360_000)` = 3600 ticks = 6 min) | **CSS class** `.enraged` on `#boss-shell` | A chain fact, so read it, never time it client-side. Compare `arena.tick` — already in the snapshot — against `ENRAGE_AT_TICK` exported from the client package (export it if it is not; do not restate 3600 or 360000 anywhere). `.enraged` overrides the `--shell` colour ramp to red, halves the 6.1 breathing duration, and adds a 0.9 s `filter: saturate()` throb. No new timers. |
| **6.6 death** | `arena.phase` `FIGHTING → SETTLING` | **Web Animations API**, one call, on `#boss-shell` | One-shot, so a JS animation is right. **`SETTLING` has no bounded duration on chain** — checked: the only settle-related constants are `PHASE_SETTLING`/`PHASE_SETTLED` (`state.rs:93-94`) and the unrelated `ROLL_TIMEOUT_TICKS`; the phase ends when `settle_up` is called, not on a timer. So the animation cannot be sized to the phase. Size it to `VOLLEY_INTERVAL_TICKS × TICK_MS = ticks_for(3_200) × 100 = 3200 ms` (`tick.rs:155`), one volley cycle — an existing on-chain duration, exported from the client package, **never a typed 3200**. Sequence on one timeline: 0–35 % all nine part groups get a staggered `opacity → 0` and `translate` outward (stagger index × 4 % so limbs shed in order); 35–70 % the vent circle expands `r: 20 → 90` while `opacity: 1 → 0`; 70–100 % `#boss-shell` `opacity → 0`. Run it once on the phase edge, guarded by the same previous-value comparison as 6.3 so the duplicated notification does not restart it. |

**Reduced motion.** `Arena.tsx:452-459` already reads `prefers-reduced-motion`. 6.1, 6.2 and
6.5 are pure CSS and must be disabled inside a `@media (prefers-reduced-motion: reduce)`
block. 6.3, 6.4 and 6.6 carry game information — a part took damage, the vent is open, the
boss died — so they keep their state change and drop only the movement: no `translate`, no
`r` pulse, opacity and colour only.

**Cost.** The 13 part groups total 32 105 painted pixels emitted as merged rect runs; the
existing measured ceiling in this project is 7589 rects animating `transform` at 143 fps.
The animations above put a transform on **at most 13 nodes** (one per part group) plus three
wrapper groups, and 6.1/6.2/6.5 are compositor keyframes with no main-thread work. The one
thing that must not happen is React re-rendering the 13 part groups per notification: the
groups are static geometry and must be memoised so that only `class`, `style` custom
properties, and imperative `animate()` calls ever touch them.

---

## 7. Change list, in dependency order

1. `tools/svg_slice.py` — renumber `index:` so `thorn0..3` become 0..3 and
   `crown, wolf_l, beast_r, mace, claws` become 4..8 (§4.2); emit a `muzzle: [x, y]` field
   for each `thorn*`, the drawn pixel nearest that part's mask centroid (§4.1); insert the
   pit-rim layer between `z=8` and `z=9` (§5).
2. `tools/gen_hitboxes.py` — `to_muzzles()` reads the `muzzle` field instead of computing a
   box centre; keep the existing "muzzle inside its own `Rect`" assert.
3. Re-run `python3 tools/svg_slice.py` then `python3 tools/gen_hitboxes.py`. Never edit
   `programs/heartrot/src/hitboxes.rs` or `packages/client/src/hitboxes.ts`.
4. `assets/map/arena.json` — move the `B` marker to tile (32, 9); re-run
   `python3 tools/gen_map.py` (§5).
5. `packages/client` — export `ENRAGE_AT_TICK` (`init.rs:190`) and
   `VOLLEY_INTERVAL_MS = VOLLEY_INTERVAL_TICKS × TICK_MS` (`tick.rs:155`), both derived from
   `ticks_for`, for 6.5 and 6.6. Neither number may be typed into the client.
6. `app/src/render/` — the three-group node structure, the memoised part groups, the eye
   circles at local (22,−54)/(29,−54), the vent circle at `CORE`, and the bullet layer moved
   beneath the boss group.
7. `python3 tools/gen_hitboxes.py --check` must exit 0, and `cargo test -p heartrot` must
   still report 59 passing unit tests, before any of this is called done.
