# 18 — The open arena

**Status:** authoritative specification. Nothing here has been applied. `assets/map/arena.json`
is unchanged on disk, no product code is modified, no deploy was run, no git command was run.

> **Amended 2026-09-03.** Applied and then moved on: the pit is now the whole painted dais
> (`PIT_TOP = 192`, row 12) and rows 1–23 are no longer "never walkable" — a raider stands on
> `map::DAIS` (`P`/`E`/`B` tiles) and never inside the creature's body (`body.rs`); the `.`
> tiles beside the dais's shoulders stay air for the ray. The tables below are the layout as
> this pass designed it.

> **Amended 2026-09-03, the Worker's scan head.** `openArena` walks arena ids from
> `Leaderboard.last_arena_id`, and that head now follows a raid whose last player pressed
> Exit too. `matchLeave` settles the arena, brings it home and records it; the settle only
> ever sees a fight nobody finished (`leave_seat` is refused outside LOBBY/MUSTERING/FIGHTING,
> and an empty arena is not a wipe), so the outcome is `OUTCOME_UNDECIDED` — and for that
> `write_leaderboard` writes **no row** but moves the head past the arena
> (`settle.rs::mark_abandoned`). Before that change the head sat at 1788266869 while fourteen
> abandoned raids piled up after it; every join re-walked the gap and each abandon added a
> step, and the scan's 76-id window would eventually have filled with nothing joinable.

> **Amended 2026-09-04, warming.** `no_open_arena` and `try_again` are no longer errors the
> player retries by hand. Both mean "not yet": `prewarmNext` is creating and delegating the
> next arena in `ctx.waitUntil` (30–60 s of devnet round trips) and the scan will find it on a
> later call. The client's `join` (`app/src/state/store.ts`) now enters `status: 'warming'` on
> either refusal and re-asks every 3 s, up to 20 times, before showing the refusal's own copy;
> the select screen shows `ARENA WARMING…` / `Preparing your arena…` for the duration. 3 s is
> not a taste: the Worker rate-limits 30 requests a minute per IP per path, so 20 a minute is
> the fastest loop that cannot turn `no_open_arena` into `rate_limited`. The routes take a guest
> proof in place of `privyToken` since the same pass (`routes.ts::resolveIdentity`); the scan is
> identity-agnostic and nothing here changes for it.

This document collapses four independent design passes — the grid pass, `docs/art/hall.md`,
`docs/art/arena.md`, and the reach-and-fit pass — into one buildable thing. They disagreed on
the pit depth, the gate width, the ray-reach limit and the layer order. §10 records every
choice made against them and §11 records what was cut.

**Every number below was produced by running something against this repository.** The
verification script is `/tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad/v.py`; it imports `tools/gen_map.py` rather than
restating it, and it writes nothing into the repo. Where an input document disagrees with the
repository, the repository wins and §9 records the correction.

---

## 1. The decision

| | today | this spec |
|---|---|---|
| lobby interior obstacles | **26 two-by-two pillars, 104 wall tiles** | **zero** |
| lobby largest unobstructed rectangle | 16 × 23 = 368 tiles | **60 × 20 = 1,200 tiles (3.26×)** |
| pit last row | 37 | **40** |
| pit walkable tiles | 726 | **842 (+16.0%)** |
| playable band height | 224 units | **272 units (+21.4%)** |
| playable share of the arena frame | 34.1% | **41.5%** |
| gate opening | 4 tiles / 64 units | **8 tiles / 128 units** |
| divider depth | 4 rows / 64 units | **5 rows / 80 units** |
| side perimeter | 1 tile | **2 tiles** |
| `ROOM_H` | 656 | **656 (held)** |
| `VIEW_LOBBY` | (0, 432, 1024, 656) | **byte-identical** |
| `VIEW_ARENA` | (0, −48, 1024, 656) | **(0, 0, 1024, 656)** |

One renderer constant moves: `app/src/render/viewport.ts` `LOBBY_HEAD`, 13 tiles → 16.

The single sentence that answers the user's complaint: **the "grid of obstacles" is 104 wall
tiles in the lobby and they are all deleted.** Everything else in this document is the enlargement
that comes with the space they freed.

---

## 2. The grid

Exact content for `assets/map/arena.json`'s `grid` array. 64 rows × 64 columns, `tile_size` 16,
legend unchanged (`#` `.` `B` `E` `G` `P`).

```
 0 ################################################################
 1 ##............................................................##
 2 ##............................................................##
 3 ##............................................................##
 4 ##............................................................##
 5 ##............................................................##
 6 ##............................................................##
 7 ##............................................................##
 8 ##............................................................##
 9 ##............................................................##
10 ##............................................................##
11 ##............................................................##
12 ##............................................................##
13 ##............................................................##
14 ##............................................................##
15 ##............................................................##
16 ##............................................................##
17 ##............................................................##
18 ##............................................................##
19 ##............................................................##
20 ##............................................................##
21 ##............................................................##
22 ##............................................................##
23 ##............................................................##
24 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
25 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPBPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
26 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
27 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
28 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
29 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
30 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
31 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
32 ##PPPPPPPPEPPPPPPPPPPPEPPPPPPPPPPPPPPPPPPEPPPPPPPPPPPEPPPPPPPP##
33 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
34 ##PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP##
35 ###PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP###
36 #####PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP#####
37 #########PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPP#########
38 ############################PPPPPPPP############################
39 ############################PPPPPPPP############################
40 ############################PPPPPPPP############################
41 ############################GGGGGGGG############################
42 ############################GGGGGGGG############################
43 ##............................................................##
44 ##............................................................##
45 ##............................................................##
46 ##............................................................##
47 ##............................................................##
48 ##............................................................##
49 ##............................................................##
50 ##............................................................##
51 ##............................................................##
52 ##............................................................##
53 ##............................................................##
54 ##............................................................##
55 ##............................................................##
56 ##............................................................##
57 ##............................................................##
58 ##............................................................##
59 ##............................................................##
60 ##............................................................##
61 ##............................................................##
62 ##............................................................##
63 ################################################################
```

Read top to bottom:

| rows | what | change from today |
|---|---|---|
| 0 | top border, **1 tile** | unchanged — §2.3 says why it cannot be 2 |
| 1–23 | boss air. Floor in the bitboard, never walkable (`PIT_TOP` holds raiders below it). It must be floor: `shoot`'s ray tests `is_wall` **before** the part rectangles, so one wall tile here kills every shot in that column, silently | unchanged |
| 24–34 | pit, full interior width, cols 2–61 | was 24–32 at cols 1–62 |
| 32 | four `E` respawn doors at cols **10, 22, 41, 53** | was cols 10, 22, 42, 54 — §2.2 |
| 35–37 | pit, chamfered: cols 3–60, 5–58, 9–54 | was rows 33–35 at 3–60 / 5–58 / 8–55 |
| 38–40 | pit doorway, cols 28–35 — **8 wide, 3 deep** | was 36–37, 4 wide, 2 deep |
| 41–42 | `G` gate block, cols 28–35 | was 38–39 at cols 30–33 |
| 43–62 | lobby, cols 2–61, **zero interior walls** | was 40–62 with 26 pillars |
| 63 | bottom border, **1 tile** | unchanged — §2.3 |
| cols 0–1, 62–63 | side perimeter, **2 tiles** | was 1 tile |

658 wall tiles total: **376 perimeter, 282 divider and chamfer, 0 obstacles.**

### 2.1 Symmetry

All 64 rows mirror exactly about x = 31.5 when `B` and `E` are read as the pit terrain they
sit in (measured; §8.3). The four entrances form two mirror pairs, 10↔53 and 22↔41.

The boss anchor is at tile column 32, whose *tile* mirror is column 31 — but world positions
in this program are tile top-left corners, so `BOSS_SPAWN.x = 32 × 16 = 512 = ARENA_UNITS / 2`
is the exact centre line. The boss is centred; the tile index is not the thing being centred.

### 2.2 The entrances were asymmetric and this fixes it

Today's `E` marks sit at cols 10, 22, **42, 54**. 63 − 10 = 53, not 54. That is 16 units of
respawn offset nobody drew on purpose. Corrected to 10, 22, **41, 53**. It is the only change
to `map::ENTRANCES` and it is a one-tile move of two doors.

`tick::entrance_for` fans five ranks off each door at `ENTRANCE_SPACING = 24`. The doors sit
at world y 512 and `fans_along_x` is false there (to_y_edge 512 > to_x_edge 160), so the ranks
fan on **y**: 464, 488, 512, 536, 560 — tile rows 29, 30, 32, 33, 35, all inside the pit band
24–40. Verified by `gen_map.validate()` (§8.1), which fails loudly on a rank outside the band.

### 2.3 Why the top and bottom borders stay 1 tile while the sides go to 2

The top border **cannot** be 2 tiles. `PART_HITBOXES` puts the crown's top at world y = 16,
which is tile row 1. A wall tile at row 1 sits inside the creature's own hittable extent and
kills every ray that passes through it — the exact silent-shot failure the boss air exists to
prevent. Row 1 is floor, permanently, and that is a hard constraint, not a preference.

The bottom border stays 1 tile because a second row buys nothing visible and costs 60 walkable
tiles. `VIEW_LOBBY` runs to y = 1088, past `MAP_MAX_XY` = 1023; the bottom 65 units of that
frame are already painted by `WaitingRoom`'s off-map masonry, so thickening the bitboard there
changes no pixel. Reference A's bottom stairs stay cut for the same reason they are cut today.

The sides go to 2 because side depth is free on the vertical budget (§4) and it is what buys
the `no_shot_at_the_boss_can_die_of_range` headroom in §8.6 — from 2.0 units to 12.4.

Reference A's own wall depths are top 0.104 of interior width, sides 0.056, bottom 0.050. This
map inverts that in the *bitboard* and restores it in the *paint*: the lobby's painted top wall
is the 5-row divider (0.083 of interior width) with the gate tower rising 176 units above it,
and the map's 1-tile top border is never in the lobby frame at all.

---

## 3. Generated constants

Emitted by `python3 tools/gen_map.py` into `programs/heartrot/src/map.rs` **and**
`packages/client/src/map.ts`. Both are generated. Neither may be hand-edited — that is the
defect this project pays for most often, and it is why the gate corners stopped being Rust
literals in the first place.

| constant | today | this grid | moved |
|---|---|---|---|
| `MAP_TILES` | 64 | 64 | |
| `TILE` | 16 | 16 | |
| `PIT_TOP` | 384 | **384** | no — tile row 24 |
| `PIT_BOT` | 607 | **655** | yes — tile row 40, last unit |
| `GATE_MIN_X` | 480 | **448** | yes |
| `GATE_MAX_X` | 543 | **575** | yes |
| `GATE_MIN_Y` | 608 | **656** | yes — still exactly `PIT_BOT + 1` |
| `GATE_MAX_Y` | 639 | **687** | yes |
| `LOBBY_TOP` | 640 | **688** | yes — tile row 43 |
| `LOBBY_BOT` | 1007 | **1007** | no |
| `LOBBY_SPAWN_MIN_X` | 208 | **208** | no |
| `LOBBY_SPAWN_MAX_X` | 664 | **664** | no |
| `LOBBY_SPAWN_Y` | 832 | **832** | no — tile row 52, mid-lobby |
| `BOSS_SPAWN` | (512, 400) | **(512, 400)** | no — tile (32, 25), top centre |
| `ENTRANCES` | (160,512) (352,512) (672,512) (864,512) | **(160,512) (352,512) (656,512) (848,512)** | yes — §2.2 |

**No hand-written Rust constant moves.** `player::LOBBY_ENTRANCE = (28*TILE, 52*TILE)` is still
floor and still mid-lobby; `LOBBY_SPACING = 24` still fans all 20 seats across x 208–664 (tiles
13–41), inside cols 2–61; `ENTRANCE_SPACING = 24` still lands all 20 respawn ranks in the pit;
`MAX_RAY_STEPS` is `MAP_TILES` and does not move.

**`packages/client/src/layout.ts` needs no paired hand-edit.** It already imports `PIT_TOP` and
`PIT_BOT` from the generated `./map` (line 21) and builds `mayMoveTo`'s zone box from them
(lines 157–158). The brief's constraint 4 is satisfied by generation. Nothing to remember.

---

## 4. The pit depth, and the limit that chose it

### 4.1 The pit can only grow downward, and downward is zero-sum

Upward is the creature. `PART_HITBOXES` spans world x 170…851, y **16…712** — rows 1–23 are the
boss's body. Raising `PIT_TOP` would let a raider stand inside the crown, which no light or draw
order fixes; `docs/art/arena.md`'s "grow the pit UPWARD into the air" is rejected on that ground
in §10.3.

So the map has 62 usable rows, 23 of which belong to the boss, and **pit + divider + lobby share
39 rows forever.** Every row the pit gains is a row the lobby loses. That is the one real cost in
this document and it is stated before the choice, not after it.

### 4.2 The two ceilings, and which one binds

Two independent things cap the pit, and the *quiet* one is not the one the brief warned about.

**Ceiling A — the crown must stay inside its own frame.** `VIEW_ARENA.y = PIT_BOT + 1 − ROOM_H`.
Every pit row raises that edge 16 units toward the crown at y = 16. Holding `ROOM_H` at 656:

| R (pit's last row) | pit rows | lobby rows | `PIT_BOT` | `LOBBY_HEAD` | `VIEW_ARENA.y` | crown clearance | pit tiles | lobby tiles |
|---|---|---|---|---|---|---|---|---|
| 37 | 14 | 23 | 607 | 13 t | −48 | 64 u | 818 | 1,380 |
| 38 | 15 | 22 | 623 | 14 t | −32 | 48 u | 826 | 1,320 |
| 39 | 16 | 21 | 639 | 15 t | −16 | 32 u | 834 | 1,260 |
| **40** | **17** | **20** | **655** | **16 t** | **0** | **16 u** | **842** | **1,200** |
| 41 | 18 | 19 | 671 | 17 t | +16 | **0 — flush** | 850 | 1,140 |
| 42 | 19 | 18 | 687 | 18 t | +32 | **−16, clips the crown** | 858 | 1,080 |

**R = 41 is the hard ceiling. R = 40 is the last row with a full tile of margin. Chosen: 40.**

`gen_map.validate()` passes at every R in that table including 42 and 43. **The generator cannot
see the crown.** §6.4 adds the assertion that closes it.

**Ceiling B — ray reach — does not bind, and the reach that *does* bind is in the lobby.**
The brief flagged `MAX_RAY_STEPS = 64` as the thing that goes silently dead as the pit deepens.
Measured over all 842 pit tiles at unit-corner resolution, the worst stand-to-core distance is
**594 units against 915 units of guaranteed reach — a 1.54× margin, and it does not move with R
at all** (it is set by the pit's left edge at the chamfer, which R does not touch).

The test that is genuinely close to firing is the other one.
`no_shot_at_the_boss_can_die_of_range` sweeps **every floor tile on the map** at tile centres
against the hand-written `WORST_RANGE = 865` in `shoot.rs`. Today's worst is **863.0 units at
tile (1, 62)** — the lobby's bottom-left corner — passing by **2.0 units**. This grid's worst is
**852.6 at tile (2, 62)**, passing by **12.4**, and the 2-tile side perimeter is the entire
reason for the improvement. That constraint binds on the **lobby corner**, not the pit. Any
later redraw that extends the lobby left or down, thins the perimeter back to 1 tile, or moves
the boss right, fires it.

### 4.3 What R = 40 buys and costs

| | today | R = 40 |
|---|---|---|
| pit walkable tiles | 726 | **842** (+16.0%) |
| pit largest unobstructed rectangle | 54 × 11 = 594 | **54 × 13 = 702** (+18.2%) |
| playable share of the arena frame | 34.1% | **41.5%** (reference B ≈ 44%) |
| lobby walkable tiles | 1,322 | 1,200 (−9.2%) |
| lobby largest unobstructed rectangle | **368** | **1,200 (3.26×)** |
| lobby floor share of its frame | 56.1% (= reference A exactly) | 48.8% |

The last row is the honest cost and it should be read before this is applied. The user's
screenshot and reference are both the **lobby**, and today's lobby matches reference A's floor
proportion exactly. R = 40 trades 7.3 points of that for 7.4 points of arena floor and 176 units
of masonry above the lobby floor — which is where the enlarged gate architecture is built, so it
is not obviously a loss.

**If the art review disagrees, R = 39 is the balanced fallback** (arena 39.0% vs reference B's
44%, lobby 51.2% vs reference A's 56.1% — both about five points off) and **R = 37 keeps the
lobby exact**. Moving between them is three rows in one file plus the matching `LOBBY_HEAD` from
the table above, then re-running the generator. Every check in §8 was evaluated across the whole
sweep and none of them changes verdict anywhere in 37…41.

---

## 5. The gate

The user's sharpest note: the gate must be **architecture joined into the top wall**, not a sign
floating over it. This section is the construction.

### 5.1 What is walkable, what is painted

| | rows | world y | who can stand there |
|---|---|---|---|
| doorway (`P`) | 38–40 | 608–655 | raiders only (`ZONE_ARENA`, y ≤ `PIT_BOT` = 655) |
| gate block (`G`) | 41–42 | 656–687 | lobby only (`ZONE_LOBBY`, y ≥ `PIT_BOT + 1` = 656) |

The zone seam is at y = 656, **inside the slot**. That is what makes the flip safe in both
directions: a player who flips zone standing on a gate tile is one step below `PIT_BOT`, so
their next step north is legal and they are not boxed out of every move. `gen_map.validate()`
enforces `GATE_MIN_Y == PIT_BOT + 1` and that every gate column is floor at the pit's last row.

**Clear walkable slot: 8 tiles, world x 448…575, 128 units, centred on 512.** That is 13.3% of
the 960-unit interior width. Reference A's arch mouth is 16.1% of its interior. §5.3 closes the
gap in paint without painting a hole wider than the slot.

### 5.2 The divider is the top wall

Rows 38–42 are solid across the full width except the slot: 5 tiles, world y 608–687, **80 units
of wall depth**, 8.3% of interior width against reference A's 10.4%. Rows 35–37 add chamfered
thickness at the sides (cols 0–2, 0–4, 0–8 and mirrors), which is what gives the lobby frame's
upper corners their mass.

Above that, world y **432…607** (rows 27–37, 176 units) is pit floor in the bitboard and is
painted, in the lobby scene only, as the gate tower and skyline. **This is legal only under R3**
(a seat and everything it looses are drawn only in the room on screen) and only because a
`ZONE_LOBBY` seat is clamped to y ≥ 656. It is not licence to paint fiction below 656.

### 5.3 Construction, bottom to top

All positions parametric. `S` = the slot, x `GATE_MIN_X` … `GATE_MAX_X` (128 u). `CX` =
`GATE_MIN_X + S/2` = 512. `D` = drawn divider depth = `LOBBY_TOP − (GATE_MIN_Y − 3 × MAP_TILE)`
= 80 u. `W_f` = interior floor width = 960 u. Nothing below may be typed as a world coordinate.

1. **Threshold.** The lit floor you stand on, exactly the `G` block: x `GATE_MIN_X`…`GATE_MAX_X`,
   y `GATE_MIN_Y`…`GATE_MAX_Y`. This is the rect `Arena.tsx` already flashes on `enter_gate`
   feedback; it keeps its four generated numbers.
2. **Mouth.** The dark hole: the 8-tile slot plus **8 units of jamb reveal per side** — the
   arch's inner soffit, drawn as receding stone, reading as depth rather than as opening.
   Painted opening 144 u = **15.0% of `W_f`**, against reference A's 16.1%. The walkable slot is
   128 u and **the painted opening may never exceed slot + 16 u**: a mouth wider than the slot is
   this project's signature defect — a player walking into a painted doorway and bouncing.
   The mouth is a **hole darker than the wall's own dark course** (reference A: L 14.3 inside the
   arch against L 17.4 for the darkest wall band); it is not a fill, it is an absence.
3. **Jambs / piers.** Two piers, each `0.5 × (0.284 W_f − S)` = 44 u wide, standing on the lobby
   floor line at y = `LOBBY_TOP` and rising through the wall. They **interrupt the wall's
   coursing** — the horizontal joints of the divider stop at the pier face and do not run
   through it. That single rule is what makes the gate read as built into the wall instead of
   drawn on it, and it is the one construction the current render does not do.
4. **Arch.** Voussoirs springing from the pier tops, framing the mouth on **three sides only**.
   The outline never crosses the threshold: a stroke along the bottom edge puts half a line of
   wall colour across walkable floor, which is how the previous version shipped.
5. **Portcullis.** Vertical iron bars, at world y 608…655 — the **doorway rows, not the gate
   block**. A `ZONE_LOBBY` seat can never reach y < 656, so bars there are beyond the room; bars
   over the `G` block would paint a barrier across floor a player is standing on.
6. **Setback and skyline.** Two setbacks — wall 1.00 → piers 0.284 `W_f` → shaft 0.217 `W_f` —
   with four raised banner bays stepping down either side. The shaft rises from the wall line at
   y = 608 to y ≈ 432 (the lobby frame's top edge), i.e. **1.58 × D above the wall**, and leaves
   the frame. One brick module and one course phase run through wall, pier and tower.
7. **Plaque and sign.** A recessed plaque on the shaft carrying the glowing **BOSS FIGHT** sign.
   Recessed, so it is a cut in the masonry rather than a panel hung on it. Glyph colour mean
   (177, 76, 50), peak (255, 193, 112) — sampled from reference A, and the brightest thing in
   the lobby.
8. **Crest.** The horned ram skull **overlapping the plaque's top edge**, so the two read as one
   carved assembly rather than two stacked objects.
9. **Braziers.** One standing on each **pier top**, at ±0.121 `W_f` from `CX`. They light the
   piers from above, which is what says the piers have depth.
10. **Banners.** Purple hangings with the horned-skull sigil, 0.054 `W_f` wide, hung from the
    raised bays 0.12 D above the wall line, one pair either side of the tower.

### 5.4 The gate is one drawing, mounted twice

`VIEW_ARENA` is (0, 0, 1024, 656) and `VIEW_LOBBY` is (0, 432, 1024, 656): they **overlap in
world y 432…655**, which is the whole tower and the doorway. The passage is a pure composited
translate. So the gate assembly is **one authored group in world coordinates**, and the arena
scene draws the part of it that falls inside the pit band (doorway mouth, jamb reveal, the far
lip) while the lobby scene draws the whole. It is never two drawings that have to agree — that
is the same one-fact-twice failure as a hand-edited generated file, and during a gate cover the
two would be on screen simultaneously.

---

## 6. The floor rule

**Stated once, binding on both rooms, no exceptions.**

> **F1. The painted floor is the wall bitboard.** Every wall, in both rooms, is compiled from
> `MAP_GRID` at module load. No wall is ever drawn by hand. `BossArena.tsx`'s `PIT_PATH` and
> `WaitingRoom.tsx`'s wall-edge compiler already do this; nothing may be added beside them.
>
> **F2. Inside a room's own movement box, art and bitboard are identical.** A painted wall on
> walkable floor is a player who bounces off nothing; a painted floor on a wall tile is a player
> who walks into stone. Both have shipped here and both were misdiagnosed as ER lag.
>
> **F3. A decoration may never become a wall tile.** Torches, banners, chains, braziers, barrels,
> chests, bones, medallions, floor markings, cracks, worn patches — all of it is paint on tiles
> this grid already declares. Adding one wall tile inside the pit invalidates the reach result in
> §8.5; adding one inside the lobby re-creates the exact defect being removed.
>
> **F4. Props hug the perimeter; the floor is open.** Every prop with mass sits on a `#` tile or
> against a wall's inner face. Nothing with mass goes in the interior of either room. Reference B
> was re-measured for this: inside its floor ellipse, 33.6% of pixels depart from a smooth radial
> luminance model, and 63.8% of those sit above the centre line with 50.3% inside the centre 30%
> of the width — that is the creature. **There is no prop, no block and no cover anywhere inside
> the ring.** Every object with mass is outside it or on its kerb.
>
> **F5. Floor markings are flat.** Medallions, inlays, ring courses, tread lines, cracks and worn
> patches are permitted anywhere and are massless by construction: no stroke that reads as an
> edge, no shadow that reads as height, nothing a player can appear to stand behind.
>
> **F6. The lobby frame's top 256 units are painted fiction over pit floor, and that is the only
> fiction allowed.** It is legal because a `ZONE_LOBBY` seat is clamped to y ≥ `PIT_BOT + 1`.
> §6.4's assertion is what keeps it legal when someone moves `PIT_BOT` again.

### 6.4 The three assertions this change owes

**(a) The crown is inside its own frame.** Nothing in the repo proves it — `viewport.ts`'s
self-check sweeps *player* stands only, and §4.2 showed `gen_map.validate()` passes maps that
clip the creature. Add to `viewport.ts`'s DEV block, deriving from `PART_HITBOXES` the same way
`Arena.tsx` already derives `BOSS_HIT_BOT`:

```ts
ok(BOSS_SPAWN[1] + BOSS_HIT_TOP >= VIEW_ARENA.y,
   'the arena frame contains the boss crown — deepening the pit crops it with no other error');
```

**(b) The lobby's painted tower never reaches the pit.** Add beside it:

```ts
ok(PIT_BOT + 1 <= LOBBY_TOP, 'room A paints over pit floor only above the lobby movement box');
```

**(c) `check_pit_reach` must test the property it claims to.** `tools/gen_hitboxes.py` is broken
in two ways that make constraint 3 of the brief theatre, both confirmed by reading and running it:

- It accepts a hit on **any part with the shell intact**. Once the shell is stripped the core is
  the only target, and that endgame is untested. Run the walk a second time with `parts=[]`.
- `_walk` steps a float `TILE` (16.0) where the program's alpha-max-plus-beta-min normaliser
  steps 14.31…16.0. It credits 1024 units of reach against 915 guaranteed — **108 units of
  phantom reach, 11.8%.** Change the step to `TILE * 894 // 1000`.

Run against a synthesised pit rows 8–59 with `B` on row 9, the shipped function prints
`pit reach: 3227 pit tiles, all reach a part within 64 steps` and does not raise, while that map
has walkable units 1029 units from the vent against 915.7 of reach.

---

## 7. The layer order

Back to front, under `#camera`. This is `Arena.tsx`'s existing rows 1–16 with the new art folded
in; the row numbers are kept so the code comment and this document stay one fact.

| row | layer | owner | notes |
|---|---|---|---|
| 0 | `.vp-void` | the room module | the only thing that ever paints outside the room. Sized from the **live** fitted box by `useViewport`, not from `VIEW_BLEED` |
| 1 | base fill + graded temple | `WAITING` / `BOSS_ARENA` | one 1024² raster |
| 2 | **floor** — pit fill (`PIT_PATH`, compiled from `MAP_GRID`) or lobby paving | room module | F1 |
| 3 | **floor markings** — ring courses, medallions, treads, cracks, worn patches | room module | F5, massless |
| 4 | **floor light** — pool, core bounce, ceiling gradient, rim band, vignette | room module | painted over the graded stone, **not through** the grade filter |
| 5 | **wall mass** — compiled from `MAP_GRID`, cap / course / face / foot | room module | F1. Above the floor light so a wall is never washed by it |
| 6 | **perimeter props and the gate assembly** — torches, braziers, banners, chains, barrels, chest, candles, bones, skull niche, barred window, **and the whole of §5** | room module | F3, F4. Room A draws the full tower; room B draws only the part inside the pit band (§5.4) |
| 7–9 | **boss** — backdrop statue / chains / banners, the rig, its occluder | `Boss.tsx` | room B only, clipped at `boss.y + BOSS_HIT_BOT` |
| 10 | **telegraphs** — slam lanes, volley lines | `Arena.tsx` | over the boss, under the knights |
| 11 | **bullets** — boss ordnance, capped at 32 drawn | `Arena.tsx` | |
| 12 | **knights** | `Knight.tsx` | **THE PLAYER IS ON TOP.** Nothing decorative may be added between here and the top |
| 13 | **arrows and damage numbers** | `Shot.tsx` | above the knights — an arrow under twenty bodies is the "I cannot see anything" report |
| 14 | **rim** — the pit's near wall drawn a second time, two tile rows | `Arena.tsx` | room B only. The one earned occluder in the composition |
| 15 | **spawn flare** | `Spawn.tsx` | pointer-transparent |
| 16 | **veil** — the passage | `Passage.tsx` | mounted last so it covers the flare |
| — | **HUD** | outside the SVG | never inside `#camera`; it does not scale with the room |

Three rules that hold this order:

- **Rows 1–6 belong to the room modules and to nothing else.** A wall drawn in `Arena.tsx` as
  well would be a second copy of the bitboard.
- **Row 12 is the ceiling for scenery.** A knight occluded by decoration is the report this
  composition exists to close. Row 14's rim is the single exception and it is earned: the boss's
  hands grip it.
- **R3: a seat and everything it looses are drawn only in the room on screen.** `seatShown` is
  the whole of the enforcement and `Shot` gates on the same predicate. Break R3 and the lobby's
  gate tower paints over the pit and over the allies standing in it.

---

## 8. Verification

Everything in this section was run against the grid in §2 before it was written down. Nothing is
quoted from a comment. `python3 /tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad/v.py` reproduces all of it.

**8.1 `gen_map.validate()` — PASS.** Border closed, exactly one `B`, exactly four `E`, no
undeclared tile, gate a solid rectangle, `GATE_MIN_Y == PIT_BOT + 1`, every gate column floor at
the pit's last row, boss inside the pit band and outside the gate, all 20 `lobby_spawn` and all
20 `entrance_for` results on floor and reachable, no sealed floor, pit not pinched.

**8.2 Connectivity, 4-connected** (movement is 8-way and tests only the destination, so a
diagonal can squeeze a corner; accepting that would sign off on passages that exist by accident).
Whole map from the heart: **3,438 / 3,438**. Pit band rows 24–40, which is a raider's clamp:
**842 / 842 — not pinched**. Lobby band rows 41–63: **1,216 / 1,216**.

**8.3 Symmetry.** All 64 rows mirror about x = 31.5 with `B`/`E` read as pit. Zero asymmetric rows.

**8.4 Freeze sweep** — `the_box_never_removes_a_seats_last_legal_move` replayed over both zones
at every tile origin: **6,876 cases, 0 positions where the box removed the last legal move.**

**8.5 Ray reach.** Guaranteed reach = 64 steps × 16 × 894/1000 = **915 units**. Worst pit stand
to core over all 842 pit tiles at unit-corner resolution: **594 units at unit (32, 559)** —
tile (2, 34), the pit's left edge at the chamfer. **Margin 321 units, 1.54×.** Zero dead tiles.
The figure does not move across R = 37…43.

**8.6 `no_shot_at_the_boss_can_die_of_range`** replayed — every floor tile on the map at tile
centres: worst **852.6 units at tile (2, 62)** against reach 915 and `WORST_RANGE` 865.
**Passes by 12.4 units** (today: 863.0 at tile (1, 62), passing by 2.0).

**8.7 Viewport containment**, replayed with `LOBBY_HEAD = 16` tiles:

- arena — **842 walkable tiles framed, 0 outside**; `VIEW_ARENA.y + h = 656 = PIT_BOT + 1`
- lobby — **1,216 walkable tiles framed, 0 outside**; `VIEW_LOBBY.y + h = 1088 = LOBBY_BOT + 1 + LOBBY_FOOT`
- boss drawn extent y 16…712, so the crown clears `VIEW_ARENA.y = 0` by **16 units**
- containment holds at every stage aspect swept 0.05…6.00, unconditionally: the fit only grows

**8.8 `VIEW_BLEED` = 256 covers aspect 0.877…2.341** at `ROOM_H` = 656 — byte-identical to today,
because `ROOM_H` is held. 1024×768 (1.33), 1440×900 (1.60), 1920×1080 (1.78) and 1366×768 (1.78)
all inside. Past 2.34 the far edge paints void, which is the documented intended degradation.

**8.9 Tile counts.** Pit 726 → **842** (+16.0%); pit largest free rect 594 → **702**; lobby 1,322
→ 1,200 (−9.2%); lobby largest free rect 368 → **1,200 (3.26×)**. Wall tiles 614 → 658.

---

## 9. Corrections to the inputs

Every one measured off this repository.

1. **The pillars are 26 two-by-two blocks = 104 wall tiles, not thirty / 120.** The brief's row
   and column lists are right; the arithmetic is not.
2. **Rows 36–37 today are `P`, not wall.** They are the doorway and sit inside the pit band,
   which is why `PIT_BOT` is 607 and not 575.
3. **The brief's flagged risk does not bind.** `MAX_RAY_STEPS` is nowhere near dead at any pit
   this map can hold: 594 units used of 915. The test genuinely close to firing is
   `no_shot_at_the_boss_can_die_of_range`, and it binds on the **lobby's bottom-left corner**,
   passing today by 2.0 units.
4. **"The boss footprint must overlap no walkable tile" is not a real invariant.**
   `PART_HITBOXES` spans world x 170…851, y 16…712 and already overlaps 842 pit tiles;
   `player.rs` has no boss collision. The real invariant, asserted in `map.rs` at compile time,
   is that `BOSS_SPAWN` is not in a wall and not on the gate. Both hold.
5. **`layout.ts` needs no paired hand-edit** (§3).
6. **The four entrances are asymmetric today** (§2.2).
7. **`python3 tools/gen_hitboxes.py --check` reports STALE on a perfectly synced tree.** Ran it:
   regenerating and diffing gives **17 insertions, 94 deletions, all rustfmt reflow** (multi-line
   `Rect {…}` collapsed to one line, multi-line `assert!` collapsed), **zero numeric
   differences.** The anti-drift guard cries wolf unconditionally, so anyone who runs it learns
   to ignore it — and a genuine drift would be ignored too. Fix: normalise through `rustfmt`
   before comparing, or compare the parsed numbers rather than the text.
8. **`WORST_RANGE = 865` is a hand literal and its doc comment is stale by 264 units.** It is not
   a defect: the live unit test in §8.6 is the real guard and it fires on drift. §11 records why
   generating it was cut.
9. **`docs/art/legibility.py` no longer runs** — it looks up `<g id="kCobalt-rest">` and the
   shipped sheet emits `k0`/`k1`/`k2`, so it raises on import. Any legibility number quoted from
   `boss-arena.md` §5 describes art that no longer exists.

---

## 10. Where the four passes disagreed, and the call

**10.1 Pit depth. Grid pass said R = 40; reach-and-fit said the ceiling is R = 41; `arena.md`
proposed pits of 28 and 32 rows.** → **R = 40.** The two limits are the same number once
translated (§4.2): reach-and-fit's `LOBBY_HEAD + LOBBY_FOOT ≥ 2R − 57` tiles bakes in a 48-unit
crown margin, which is a preference; the hard bound is `ROOM_H ≥ 16R`, giving R = 41 flush and
R = 40 with one tile of margin. `arena.md`'s 28- and 32-row pits are art geometry, not feasible
grids: as drawn they fail containment by 32 and 160 units. **The limit wins.** A bigger arena
whose back rows cannot damage the boss is worse than a smaller one that works, and it fails
silently.

**10.2 Gate opening. Grid pass said 8 tiles; `hall.md` measured the reference at 16.1% of
interior width and asked for 6–10.** → **8 tiles walkable, 9 tiles painted.** 8 tiles is 13.3%
of the interior; the 8-unit jamb reveal per side brings the painted opening to 15.0% against the
reference's 16.1%, without ever painting a hole wider than the slot. The remaining width goes
into the piers, which is where `hall.md`'s own fallback put it.

**10.3 Grow the pit upward, not downward (`arena.md` bound 1).** → **Rejected.** It is free on
containment — the binding constraint is the crown, not player stands — but `PART_HITBOXES` puts
the creature's body across rows 1–23, so a raider standing at row 20 stands inside the crown. The
user has twice said the boss stays top centre. Downward growth is the only kind available.

**10.4 Torch count and floor light. `hall.md` found the reference carries six flames, not ten,
and lights its floor with one broad centred ambient rather than ten `rx`-92 pools.** → **Adopted.**
Ten pools is also the "legibility changes as you walk" failure mode. The removed pools are the
headroom that pays for the brighter floor `hall.md` §7.5 needs.

**10.5 Ring count. `arena.md` replaces five typed `RING_K` fractions with
`RING_N = max(4, round(sqrt(RING_RX × RING_RY) / 56))`.** → **Adopted.** Five rings stretched
over a pit that grew 21% is the drift this whole document exists to avoid, and the derived form
reproduces the shipped values exactly on the shipped pit. `REF_COURSE = 56` is one measured
number carrying the whole count; it is logged as a risk.

**10.6 Layer order. Nobody supplied a complete one.** → §7, which is `Arena.tsx`'s existing rows
1–16 with the new art assigned to row 6 and the HUD placed explicitly outside the SVG.

---

## 11. What was cut, and why

**Generating `WORST_STAND_TO_CORE` and deleting `WORST_RANGE` from `shoot.rs`** (reach-and-fit's
main proposal). The compile-time assert it feeds (`915 ≥ 865`) does read like a check and behave
like a comment — but the **live unit test in §8.6 is the real guard**, it sweeps the generated map
every `cargo test`, and it fires the moment the map exceeds 865. Replacing a passing hand literal
with a generated one is churn on the critical path of a map change. **Add it when the test fails**
— at which point the number has to be recomputed anyway and generating it is the right fix.
Its doc comment being stale by 264 units is recorded in §12 instead.

**A `MAP_TILES <= 64` guard in `gen_map.validate()`.** A 65-wide grid emits a 17-hex-digit
literal into `[u64; N]` and fails at `cargo check` — loud, immediate, unmissable. A second guard
for a failure that already stops the build is a guard for nobody. The constraint is stated in
§12 instead, which is what was actually missing.

**A third tile of side perimeter.** Matching reference A's 4.6% exactly needs 3 tiles and costs
40 lobby and 34 pit tiles. Two doubles today's thickness, buys the §8.6 headroom, and leaves the
rest to paint — above stage aspect 1.561 the fitted box extends 98 units per side past the map at
1920×1032, and that band is authored masonry. Flip to 3 by changing one number if the art review
disagrees; it is safe on every check in §8 and it *improves* §8.6.

**A second bottom border row** (§2.3) and **a second top border row** (§2.3, which is forbidden).

**Re-measuring knight contrast, frame budget and ER latency in this document.** They are owed
before ship (§12) and none of them can be produced by a map redraw. Quoting the existing figures
would be quoting numbers taken against different floor art.

---

## 12. Risks

1. **The zero-sum vertical budget is real and this spec spends it on the arena.** 62 usable rows,
   23 owned by the boss, so pit + divider + lobby share 39 forever. R = 40 moves the lobby's floor
   share of its frame from 56.1% — exactly reference A — to 48.8%. **The user's screenshot and
   reference are both the lobby.** If the art review reads that as a regression, R = 39 or R = 37
   are three-row edits away and §4.2 gives every check at each value.

2. **`no_shot_at_the_boss_can_die_of_range` passes today by 2.0 units.** The 2-tile side
   perimeter raises it to 12.4. Any later redraw that extends the lobby left or down, thins the
   perimeter, or moves the boss right, fires it. It is a **lobby** constraint, not the pit
   constraint the brief warned about.

3. **Nothing in the repo proves the boss is inside its own frame.** `viewport.ts` sweeps player
   stands; `gen_map.validate()` passes maps that clip the crown (verified at R = 42 and 43).
   Without §6.4(a), the next person to give the pit a row clips the creature with no error
   anywhere. This is the single most important line in the document.

4. **`LOBBY_HEAD` 13 → 16 is load-bearing and easy to miss.** It is the only renderer constant
   that must move. It holds `ROOM_H` at 656, keeps `VIEW_LOBBY` byte-identical, keeps the two
   rooms equal in size so the gate passage stays a pure translate, and keeps `VIEW_BLEED`'s
   coverage at 0.877…2.341. Leave it at 13 and `ROOM_H` silently becomes 608, which breaks the
   equal-size assertion in `viewport.ts`'s own self-check — loudly, in DEV, but silently in a
   production build.

5. **Typed world coordinates in the two art modules will drift.** Both are otherwise parametric
   off the generated constants, and these will be wrong under the new map:
   - `WaitingRoom.tsx` `LEFT_WALL_MID = MAP_TILE / 2` (8) → the left wall is now x 0…31, mid 16.
   - `WaitingRoom.tsx` `RIGHT_WALL_MID = ARENA_UNITS − MAP_TILE / 2` (1016) → 1008.
   - `WaitingRoom.tsx` `TOP_WALL_MID = GATE_MIN_Y + MAP_TILE` (→ 672) → the divider is now
     y 608…687, mid **648**; 672 lands inside the gate rows.
   - `WaitingRoom.tsx` `ROOM_TOP = GATE_MIN_Y − 2 × MAP_TILE` assumes a 2-row wall course; the
     divider is 5 rows.
   - `WaitingRoom.tsx` `GATE`'s stepped skyline uses typed ±88 / ±72 / ±56 offsets and a typed
     `464`, all fitted to a 64-unit slot.
   - `BossArena.tsx` `RING_K` (five typed fractions) and `MEDALLION_K`.
   Every one must become a fraction of a bitboard-derived quantity. `hall.md`'s parametric walk
   over wall tiles whose neighbour is walkable is the right shape — and it is a real rewrite of
   the placement code, not a tweak. **A half-done version that keeps some typed coordinates will
   silently place fixtures on floor tiles.**

6. **`Arena.tsx:1155` carries a typed 576** in `ok(PIT_BOT + 1 - 2 * MAP_TILE === 576, …)`. It
   throws at module load in DEV the moment `PIT_BOT` moves — the good failure — but is silent in
   production. Fix by asserting the relationship, not the number.

7. **`Scene.tsx:284`'s lobby pool still scales 470×215 about `(PIT_TOP + PIT_BOT) / 2`.** A moved
   `PIT_BOT` drags the lobby's light 24 units toward a pit the lobby is not in. Quiet, not loud.

8. **Stale comments this change creates.** None is a defect; all are the drift this codebase keeps
   paying for. `shoot.rs`'s `WORST_RANGE` doc comment overstates the real worst by 264 units;
   `player.rs`'s "170,240 positions today" becomes 155,648; `arena.json`'s own readme block
   describes the old row layout, the 12-row pit and the 4-tile doorway verbatim and **must be
   rewritten in the same edit as the grid** — it is the file a redrawer reads first.

9. **Not measured, and must not be quoted.** Knight-vs-floor contrast (the 1.91–2.54:1 figure was
   taken against different floor art, and a comment in this codebase once claimed 4.35:1 because
   it was measured against primitive circles); frame budget at the new room size (the wall-edge
   compiler emits per-tile paths, so a larger perimeter means more nodes — re-measure under 6×
   CPU throttle against `frame-budget.md`'s p50 9.38 / p95 14.92 ms); ER latency. **A chain-side
   ER measurement cannot see a renderer-side send delay**, which is the only way this change can
   cost latency. `scripts/spike/er_guard.sh` was **not** run.

10. **ER speed cannot regress chain-side, by construction.** `WALLS` is a fixed `[u64; 64]` in the
    program image, `MAX_RAY_STEPS` is unchanged, the worst ray got shorter, and the lobby loses 26
    pillar draws and gains none. This is an argument, not a measurement, and it is only about the
    chain half.

---

## 13. Apply order

1. Redraw `assets/map/arena.json`'s `grid` to §2 **and rewrite its `readme` block** — it describes
   the old layout verbatim (risk 8).
2. `python3 tools/gen_map.py` → regenerates `programs/heartrot/src/map.rs` and
   `packages/client/src/map.ts`. **Never hand-edit either.**
3. Fix `check_pit_reach` per §6.4(c), then `python3 tools/gen_hitboxes.py --check`.
4. `app/src/render/viewport.ts`: `LOBBY_HEAD` 13 → 16 tiles. Add assertions §6.4(a) and (b).
5. Depin the typed coordinates in risk 5; build the gate per §5.3; apply §10.4 and §10.5.
6. `cargo check --workspace` → 0. `cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"` → the **unit** line must read **104 passed**.
7. All three `./node_modules/.bin/tsc --noEmit` (app, packages/client, worker) → 0. Never `npx tsc`.
8. `vite build` → 0.
9. Re-measure knight contrast, frame budget and ER (risk 9) before ship.

This is a **map geometry** change: it recompiles `map.rs` into the ELF, so it needs a **paired
program + client deploy**. `map.ts` drives client-side movement prediction, and a client that
disagrees with the chain about one tile is a permanent snap-back this project has twice
misdiagnosed as ER lag. No account layout, PDA seed, instruction encoding or CU cost changes —
`WALLS` is a program-image constant, so there is no migration. **The operator deploys.**
