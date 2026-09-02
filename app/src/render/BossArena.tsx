/**
 * Room B — the fight arena, built to `/home/anshtyagi/Downloads/actual_boss_arena.png`.
 *
 * ## What this is
 *
 * The whole static environment for `ZONE_ARENA`, as ONE module-scope `ReactElement` with no
 * props. It is the room-B half of `17-fullscreen-spec.md` §2.2 and the implementation of
 * `docs/art/boss-arena.md`: a circular tiered floor of concentric stone courses with
 * cardinal medallions, the boss's dais at top centre, steps at the doorway the gate lets
 * players in through, cyan brazier flames around the perimeter, and a dark backdrop of
 * pillars, chains, purple banners and demon statues above the pit rim. Cold teal light on
 * blue-grey stone; the creature (drawn by `Boss.tsx`, not here) is the only bright thing.
 *
 * `docs/art/arena.md` is the delta that made every one of its dimensions a function of the
 * generated `PIT_TOP`/`PIT_BOT`/`MAP_GRID`: the course count, the medallion ring, the flame
 * ring, the backdrop's heights, the pool, the ceiling and the rim band were all world
 * coordinates fitted to a 224-unit pit band, and the pit is 272 units tall now. Nothing in
 * this file may be a typed world coordinate again — a size or a fraction, never a position.
 *
 * Mount it as the FIRST child of `#camera` in place of `Scene.tsx`'s `SCENE` whenever the
 * room on screen is the arena. `Arena.tsx` keeps painting `MAP_WALL_PATH` / `MAP_RIM_PATH`
 * on top: nothing in this file is drawn over a wall, and nothing in it is solid.
 *
 * ## The performance contract, which is the point of the shape of this file
 *
 * Same contract `Scene.tsx` earned and states at length: a module-scope element, compared by
 * identity, never diffed again; nothing derived from chain state, so a `Players`
 * notification at 10-20/s has nothing to write here; `will-change: transform` so it holds
 * its own compositor raster instead of dirtying the movers' paint chunk (measured 30-85x);
 * `pointer-events: none` so it cannot become a hit-test target. Every number below is a
 * constant expression over the generated `MAP_GRID`, `PIT_TOP`/`PIT_BOT`, `GATE_MIN_X`,
 * `BOSS_SPAWN` and `CORE`. **Do not add a prop to this file.** The measured cost of losing
 * that is 11.2 ms/frame and 3/3 renderer crashes at 300 frames.
 *
 * ## The two rules the geometry obeys
 *
 * 1. **The painted floor is the wall bitboard.** `PIT_PATH` is compiled from `MAP_GRID` —
 *    every non-`#` tile in the `PIT_TOP..PIT_BOT` band, which is exactly the box
 *    `move_player` clamps a `ZONE_ARENA` player into — and the ring family is clipped to it,
 *    so the map's chamfer cuts the ellipse's corners for free. A hand-drawn arena that
 *    disagrees with `map.rs` by one tile reads as permanent lag, which is this project's
 *    signature misdiagnosis.
 * 2. **Nothing here has mass on a walkable tile.** Rings, medallions, treads and flames are
 *    floor markings and light. The backdrop (pillars, banners, chains, statues) is painted
 *    into the dark ABOVE `PIT_TOP`, where no `ZONE_ARENA` player can stand and where the map
 *    must stay open floor — `shoot`'s raycast tests `is_wall` first, so one wall tile above
 *    the pit would kill every shot in that column.
 */
import type { ReactElement } from 'react';

import {
  BOSS_SPAWN,
  CORE,
  GATE_MAX_X,
  GATE_MIN_X,
  MAP_GRID,
  MAP_TILE,
  PIT_BOT,
  PIT_TOP,
} from '@heartrot/client';

import templeSvg from '../../../assets/sprites/temple.svg?raw';

import { SPRITE_H } from './knights.gen';
import { ARENA_UNITS } from './sprites';

// ---------------------------------------------------------------------------
// The temple asset — the masonry this room is cut into
// ---------------------------------------------------------------------------
//
// `Scene.tsx` is gone — it was the single-room predecessor of this file and `WaitingRoom`,
// and it sat unimported for a whole redraw while still carrying a second copy of
// `TEMPLE_GRADE` and a third parse of this asset. The remaining duplicate is `WaitingRoom`,
// which reads the same asset for the lobby under its own `LOBBY_GRADE`. Both reads go to
// the same file and derive the same four constants, so this is duplicated CODE and not a
// duplicated FACT.
// ponytail: one extra regex. Ceiling: a re-conversion of temple.svg has to be checked in
// two files. Upgrade path if a third room ever appears: hoist these four constants into a
// shared module — not worth a new file for two callers.

/**
 * Two decimals. Almost nothing in this file is an integer any more — every dimension is a
 * fraction of a generated span — and `289.34000000000003` in a `d` attribute is seventeen
 * characters of float noise repeated on every subpath. Rounding is presentational only:
 * nothing here is compared against a chain coordinate.
 */
const u = (n: number): number => Math.round(n * 100) / 100;

const TEMPLE_W = 210;
const TEMPLE_H = 238;

const TEMPLE_PATHS: readonly (readonly [fill: string, d: string])[] = [
  ...templeSvg.matchAll(/<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"/g),
].map((m) => [m[1]!, m[2]!] as const);

if (TEMPLE_PATHS.length !== 16) {
  throw new Error(
    `BossArena: temple.svg matched ${TEMPLE_PATHS.length} paths, expected 16. ` +
      'A silent regex miss renders the room with holes in it and throws nothing.',
  );
}

/** `Scene.tsx`'s least-squares fit, unchanged: neutral grey masonry -> cold blue stone. */
const TEMPLE_GRADE = 'sepia(1) hue-rotate(177deg) saturate(1.39) brightness(0.5)';

// ---------------------------------------------------------------------------
// Pit geometry, compiled from the generated grid
// ---------------------------------------------------------------------------

/**
 * The pit floor as one path of tile rects, plus its horizontal extent and its row span.
 *
 * Every walkable tile inside `PIT_TOP..PIT_BOT`, keyed on `!== '#'` rather than on `=== 'P'`.
 * That distinction is load-bearing: row 25 carries a `B` at the boss spawn and row 32 carries
 * four `E` respawn marks, all of them walkable pit floor. Keying on `'P'` leaves five
 * tile-sized holes in the wash — five squares of un-darkened masonry a raider can stand on,
 * which is precisely the "painted floor disagrees with the bitboard" defect this layer exists
 * to avoid. `!== '#'` is also the predicate `isWallTile` inverts, so there is one rule.
 */
const [PIT_PATH, PIT_X0, PIT_X1] = ((): [string, number, number] => {
  let d = '';
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = 0;
  for (let ty = 0; ty < MAP_GRID.length; ty++) {
    const top = ty * MAP_TILE;
    if (top < PIT_TOP || top > PIT_BOT) continue;
    const row = MAP_GRID[ty]!;
    for (let tx = 0; tx < row.length; tx++) {
      if (row[tx] === '#') continue;
      d += `M${tx * MAP_TILE} ${top}h${MAP_TILE}v${MAP_TILE}h-${MAP_TILE}z`;
      if (tx * MAP_TILE < x0) x0 = tx * MAP_TILE;
      if ((tx + 1) * MAP_TILE > x1) x1 = (tx + 1) * MAP_TILE;
    }
  }
  return [d, x0, x1];
})();

/**
 * The walkable span on one tile row, as `[start, end)` in world x — the same half-open
 * convention `PIT_X0`/`PIT_X1` use above, so a value from one can be mirrored against the
 * other without an off-by-one.
 */
function pitSpan(ty: number): readonly [number, number] {
  const row = MAP_GRID[ty] ?? '';
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  for (let tx = 0; tx < row.length; tx++) {
    if (row[tx] === '#') continue;
    x0 = Math.min(x0, tx * MAP_TILE);
    x1 = Math.max(x1, (tx + 1) * MAP_TILE);
  }
  return [x0, x1];
}

// ---------------------------------------------------------------------------
// The ring family — `boss-arena.md` §3.1
// ---------------------------------------------------------------------------

/** Centre and semi-axes of the arena circle, both derived from the pit's own bounds. */
const RING_CX = ARENA_UNITS / 2;
const RING_CY = (PIT_TOP + PIT_BOT + 1) / 2;
const RING_RX = (PIT_X1 - PIT_X0) / 2;
const RING_RY = (PIT_BOT + 1 - PIT_TOP) / 2;

/**
 * Image B's own mortar spacing, expressed at this arena's scale: `0.21 * sqrt(418 * 120)`
 * pixels of reference floor times `496 / 418`, the width ratio the shipped pit was fitted at
 * (`arena.md` §3.2). One course is 56 arena units, and that is the only number here read off
 * the reference.
 */
const REF_COURSE = 56;

/**
 * How many courses the floor carries. **A count, not a coordinate.**
 *
 * The five typed fractions this replaces were scale-free individually but their *count* was
 * fitted to a 112-unit semi-minor axis. Keep them and a pit half again as tall reads as four
 * huge lens shapes instead of concentric stone courses. Deriving the count from the pit's own
 * geometric-mean radius keeps the course spacing at the reference's while the floor grows.
 *
 * Orthographic and NOT perspective-corrected. The floor plane IS the coordinate space, so
 * `PlayerSlot.x`/`.y` land in the SVG unmodified. A perspective floor would draw the rings
 * somewhere the chain's positions are not, and this project has twice misdiagnosed exactly
 * that class of disagreement as lag.
 */
const RING_N = Math.max(4, Math.round(Math.sqrt(RING_RX * RING_RY) / REF_COURSE));

/** Course boundaries as a fraction of the radius, evenly spaced out to the kerb. */
const RING_K: readonly number[] = Array.from({ length: RING_N }, (_, i) => (i + 1) / RING_N);

/** The dais is the innermost ring, filled one step lighter — paving plus light, no platform. */
const DAIS_K = RING_K[0]!;

/**
 * The ring the four cardinal medallions sit on: two courses in from the kerb at every count.
 *
 * 0.66 is image B's own — of the five medallions `boss-arena.md` §1.6 located, the east–west
 * pair sits at `286 / 418 = 0.684` of the semi-major axis. Rounding it into the derived course
 * count is what keeps the medallions ON a course line rather than floating between two.
 */
const MEDALLION_K = RING_K[Math.max(0, Math.round(0.66 * RING_N) - 1)]!;

/** A mark size, not a coordinate: 26 x 12 units, foreshortened 2.2:1 like the floor. */
const MEDALLION_W = 26;
const MEDALLION_H = 12;

/**
 * How far INSIDE its own mortar joint the lit top face of a course sits. A width, not a
 * position: the kerb ellipse is `RING_R{X,Y} * k - KERB` on both axes, so the highlight is
 * offset along the ring's normal everywhere on the ring.
 *
 * The 2-unit `cy` translate this replaces was the whole reason the rings did not read.
 * Translating the highlight down by 2 units is a RADIAL offset only where the ring line runs
 * horizontally; on the left and right flanks — where the line is vertical — it moves the
 * highlight ALONG the line, so a 2-unit `#a8d6f0` band landed inside the 3-unit mortar band
 * and the two cancelled. Measured on the +x axis of the shipped build: the mortar's 3 drawn
 * units left ONE unit of visible dark line (L8 31 at x 705) with its neighbours at 41 and 39,
 * one of them the highlight showing THROUGH the mortar painted over it. The sign also flipped
 * between the top of the ellipse (highlight outside) and the bottom (inside).
 *
 * Inside rather than outside is image B's own arrangement at its two strongest rings — the
 * aligned radial profile puts the crest at -2 units on both k = 0.29 and k = 0.34 — and it is
 * the only sign that keeps the OUTERMOST kerb inside `ba-pit-clip`: at k = 1 the ring is the
 * ellipse inscribed in the pit, so a highlight one unit outside it is clipped away entirely.
 */
const KERB = 2.5;

/**
 * Four diamonds at the cardinal points of {@link MEDALLION_K}, as one path of four subpaths.
 *
 * N sits inside the creature's silhouette and only appears as limbs break; W, E and S are the
 * three that are always visible. All four are drawn so the composition stays symmetric.
 */
const MEDALLION_PATH = (
  [
    [RING_CX, RING_CY - RING_RY * MEDALLION_K],
    [RING_CX, RING_CY + RING_RY * MEDALLION_K],
    [RING_CX - RING_RX * MEDALLION_K, RING_CY],
    [RING_CX + RING_RX * MEDALLION_K, RING_CY],
  ] as const
)
  .map(
    ([cx, cy]) =>
      `M${cx - MEDALLION_W / 2} ${cy}L${cx} ${cy - MEDALLION_H / 2}` +
      `L${cx + MEDALLION_W / 2} ${cy}L${cx} ${cy + MEDALLION_H / 2}Z`,
  )
  .join('');

// ---------------------------------------------------------------------------
// The steps — `boss-arena.md` §3.5
// ---------------------------------------------------------------------------

/**
 * Four treads across the doorway, the single entrance from the gate. Span and depth are both
 * generated: x is the gate block, and four 8-unit treads fill the last two pit rows above it.
 * Darkest at the bottom, in the same value pair as the ring mortar and highlight. They are
 * clipped to `PIT_PATH` like everything else, so on a deeper throat they simply start lower
 * down it — the treads can never spill sideways out of the slot the grid cut.
 */
const STEP_COUNT = 4;
const STEP_H = 8;
const STEP_TOP = PIT_BOT + 1 - STEP_COUNT * STEP_H;
const STEP_W = GATE_MAX_X - GATE_MIN_X + 1;

// ---------------------------------------------------------------------------
// Braziers — `boss-arena.md` §3.6, relocated onto floor. See BRAZIERS.
// ---------------------------------------------------------------------------

const ellipsePath = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;

/** How far inside a row's own walkable span a flame stands. A size, not a position. */
const FLAME_INSET = 12;

/** ~ image B's wall-brazier pitch at our scale. A pit taller than this gains a side pair. */
const FLAME_GAP = 160;

/**
 * The perimeter flames, mirrored about the arena's centre line. Twelve on a pit under two
 * flame-pitches tall, which is this one; two more per pitch above that.
 *
 * A brazier here is a flame and a few units of bloom, and **nothing else**. `boss-arena.md`
 * §1.3 measured image B's braziers on rings of increasing radius: the stone around a flame is
 * back at the scene's ambient within 15 px, at every one of the twelve. There is no falloff
 * to model. Twelve radial gradients with real radii would put twelve pools of light on the
 * floor the raid stands on — light the reference does not have, spent against the one budget
 * (§5.4) that decides whether the knights are legible at all.
 *
 * Eight sit on the far rim line at `PIT_TOP - 4`, which is open floor above the pit and the
 * one place in this room where the reference's wall braziers can be read against the dark.
 *
 * The other four are §3.6's chamfer and doorway pairs, moved from the wall tiles it names
 * onto the pit floor beside them. That is not a taste change: `Arena.tsx` paints
 * `MAP_WALL_PATH` opaque over every `#` tile AFTER this layer, so a flame drawn on the
 * chamfer or on the kerb is drawn and then painted over — invisible, with no error anywhere.
 * On floor they are still light and still legal under the no-mass rule.
 */
const BRAZIERS: readonly (readonly [number, number])[] = (() => {
  const out: Array<readonly [number, number]> = [];
  const pair = (x: number, y: number): void => {
    out.push([x, y], [2 * RING_CX - x, y]);
  };

  // Far rim: image B's four symmetric wall pairs, as fractions of our own semi-major axis
  // rather than as the four world offsets they were fitted to on a 992-unit pit.
  for (const k of [0.27, 0.57, 0.79, 0.96]) pair(u(RING_CX - RING_RX * k), PIT_TOP - 4);

  // The chamfer pair, on the first chamfered row's own floor edge — found by asking the grid
  // which row is the first one narrower than the pit, not by counting rows up from the bottom.
  const [cy, [cx0]] = ((): [number, readonly [number, number]] => {
    for (let ty = PIT_TOP / MAP_TILE; ty <= PIT_BOT / MAP_TILE; ty++) {
      const span = pitSpan(ty);
      if (span[1] - span[0] < PIT_X1 - PIT_X0) return [ty * MAP_TILE + MAP_TILE / 2, span];
    }
    return [PIT_TOP + MAP_TILE / 2, [PIT_X0, PIT_X1]];
  })();
  pair(cx0 + FLAME_INSET, cy);

  // The doorway pair, flanking the steps on the lowest pit row still wider than the throat.
  // Inside the throat the row IS the gate slot, and a flame there would sit on the treads.
  let doorRow = Math.floor(PIT_BOT / MAP_TILE);
  while (doorRow > PIT_TOP / MAP_TILE) {
    const [x0, x1] = pitSpan(doorRow);
    if (x1 - x0 > STEP_W) break;
    doorRow--;
  }
  pair(GATE_MIN_X - 24, doorRow * MAP_TILE + MAP_TILE / 2);

  // Side pairs, so a tall pit does not leave its long sides dark for hundreds of units. Zero
  // of them on a pit under two flame-pitches tall, which is the shipped case and this one.
  const sideRows = Math.max(0, Math.floor((PIT_BOT + 1 - PIT_TOP) / FLAME_GAP) - 1);
  for (let i = 0; i < sideRows; i++) {
    const ty = Math.round((PIT_TOP + ((i + 1) * (PIT_BOT + 1 - PIT_TOP)) / (sideRows + 1)) / MAP_TILE);
    const [x0] = pitSpan(ty);
    pair(x0 + FLAME_INSET, ty * MAP_TILE + MAP_TILE / 2);
  }
  return out;
})();

const BRAZIER_HALO = BRAZIERS.map(([x, y]) => ellipsePath(x, y, 11, 15)).join('');
const BRAZIER_FLAME = BRAZIERS.map(([x, y]) => ellipsePath(x, y, 3, 5)).join('');
const BRAZIER_CORE = BRAZIERS.map(([x, y]) => ellipsePath(x, y - 1, 1.5, 2.5)).join('');

// ---------------------------------------------------------------------------
// The backdrop — flat, dark, and strictly above the pit
// ---------------------------------------------------------------------------

/**
 * Image B's rear wall: pillars, hanging chains, purple banners with pale horned-skull crests,
 * and two carved demon statues flanking the chamber.
 *
 * All of it is **backdrop**: painted into the dark above the rim, with no mass, no wall tile
 * and no cast shadow, exactly as `boss-arena.md` §3.5 requires. Rows 1..23 of the map are open
 * floor on purpose and must stay that way, so none of this can ever become geometry.
 *
 * `BACKDROP_BOT` keeps every one of these shapes clear of the region a knight's sprite covers.
 * A raider standing on the pit's top row is drawn from `PIT_TOP - (SPRITE_H - FEET_Y)`, and
 * anything painted into that band becomes background for a figure rather than scenery behind
 * one — which is the legibility hole §4.1 exists to close.
 */
const WASH_ABOVE_PIT = 22; // = Knight.tsx SPRITE_H (42) - FEET_Y (20). FEET_Y is not exported.
const BACKDROP_TOP = MAP_TILE; // row 0 is the map border and is painted as wall.
const BACKDROP_BOT = PIT_TOP - WASH_ABOVE_PIT;

/** A horned skull, ~26 x 24, centred on its own origin. Used on every banner crest. */
const SKULL_D =
  'M-8,-6q0,-8 8,-8q8,0 8,8q0,6 -3,8l0,4q-5,3 -10,0l0,-4q-3,-2 -3,-8z' +
  'M-8,-8q-8,-2 -10,-10q7,1 10,6z' +
  'M8,-8q8,-2 10,-10q-7,1 -10,6z';

const PILLAR_PATH = [96, 272, 448]
  .flatMap((dx) => [RING_CX - dx, RING_CX + dx])
  .map((x) => `M${x - 20} ${BACKDROP_TOP}h40v${BACKDROP_BOT - 12 - BACKDROP_TOP}h-40z`)
  .join('');

/**
 * The band every backdrop height is a fraction of. The three shapes below carried typed
 * heights fitted to this band at 346 units; `arena.md` §2.3 measured what happens when
 * `PIT_TOP` moves — the statue's horns cross the map border and the chains hang into the strip
 * a knight's sprite covers, both silently. The fractions reproduce the shipped drawing exactly
 * at 346 and scale with the band instead of running off the top of it.
 */
const BACKDROP_H = BACKDROP_BOT - BACKDROP_TOP;


const CHAIN_XS = [228, 472].flatMap((dx) => [RING_CX - dx, RING_CX + dx]);
const CHAIN_BOT = u(BACKDROP_TOP + 0.79 * BACKDROP_H); // 274.3 on the shipped band
const CHAIN_PATH = CHAIN_XS.map((x) => `M${x} ${BACKDROP_TOP}V${CHAIN_BOT}`).join('');

const BANNER_XS = [184, 360].flatMap((dx) => [RING_CX - dx, RING_CX + dx]);
const BANNER_TOP = BACKDROP_TOP + 8;
const BANNER_H = u(0.54 * BACKDROP_H); // 186.8
const BANNER_POINT = u(0.06 * BACKDROP_H); // 20.8
const BANNER_PATH = BANNER_XS.map(
  (x) =>
    `M${x - 30} ${BANNER_TOP}h60v${BANNER_H}l-30 ${BANNER_POINT}l-30 -${BANNER_POINT}z`,
).join('');

/**
 * A hunched, horned demon statue as one symmetric silhouette, drawn about its own x origin.
 * Deliberately a silhouette and nothing else: at image B's own palette these read at L8 19,
 * four points above the void, and any interior detail at that level is noise the ceiling
 * gradient eats anyway.
 */
const STATUE_D =
  'M-46,260L-38,140L-52,100L-44,92L-30,118L-26,54L-44,14L-56,-12L-40,0L-24,28' +
  'L-8,8L0,0L8,8L24,28L40,0L56,-12L44,14L26,54L30,118L44,92L52,100L38,140L46,260Z';

/** Local y −12..260 = 272 units of silhouette plus 16 of clearance. Never enlarged, only shrunk. */
const STATUE_SPAN = 288;
const STATUE_K = Math.min(1, BACKDROP_H / STATUE_SPAN);
const STATUE_TOP = u(BACKDROP_BOT - 260 * STATUE_K);
const STATUE_XS = [RING_CX - 316, RING_CX + 316];

// ---------------------------------------------------------------------------
// Light — `boss-arena.md` §4, solved in §5.4 rather than chosen
// ---------------------------------------------------------------------------

/**
 * The pit wash, and it is the single most important number in this file.
 *
 * `arena.md` §4.3 re-runs `boss-arena.md` §5.4's search — binary-search one gain over every
 * added-light layer, take the largest that still holds the darkest skin at a 3.00:1 SOLVE
 * TARGET worst case — over FOUR pit sizes at once and takes the minimum, so the answer is not
 * fitted to one pit.
 * The solved gain barely moves with pit size: 0.94 to 1.00 at wash 0.70 across a pit that more
 * than doubles in height with the course count moving 4 -> 7 underneath it. {@link GAIN} 0.92
 * is one notch under the tightest solve, so every candidate clears the target with margin
 * rather than one candidate clearing it exactly.
 *
 * The dark layers are NOT gained. They are the floor the light is spent against, and gaining
 * both ends is a contrast knob that cancels. Raising the wash washes the rings out; lowering
 * it walks the floor into the knights standing on it. Both have shipped in this project.
 *
 * ## What 3.00:1 is, and what it is not — re-measured on THIS pit and THIS floor
 *
 * 3.00:1 is a target the solve above was run against, in ONE metric: the figure's mean
 * relative luminance (body plus halo rim) against the MEAN of the 33x42 sprite box behind it,
 * over every walkable unit of the pit the creature does not cover (173,876 of them). In that
 * metric the shipped floor holds, and the mortar change below does not move it:
 *
 * ```
 *                 worst        p50        under 3:1        median SPRITE PIXEL
 *   Cobalt      3.31:1      4.87:1          0.0 %                 1.90:1
 *   Nocturne    3.04:1      4.46:1          0.0 %                 1.45:1
 *   Argent      3.20:1      4.71:1          0.0 %                 1.49:1
 * ```
 *
 * The right-hand column is the OTHER metric and it is the one the art review reported at
 * 1.75:1: every drawn pixel of the rest pose against the exact background pixel behind it,
 * median over 24,840 sampled feet positions. It is far lower than 3.00:1 because a knight is
 * not one flat value — 37-52 % of its pixels are its own dark outline and shadowed plate,
 * which are SUPPOSED to sit near the floor, and the p95 is 8.1-12.4:1 where the lit faces are.
 * Neither number is wrong; quoting one for the other is. Both are unchanged to two decimals by
 * `MORTAR_ALPHA` 0.60 -> 0.92 (floor L8 p50 27.1 -> 27.0).
 */
const GAIN = 0.92;
const WASH_ALPHA = 0.7;
const DAIS_ALPHA = 0.1 * GAIN;

/**
 * The mortar joint, and it is a DARK layer: not gained, and free to move without touching the
 * solve above.
 *
 * 0.60 was the value `boss-arena.md` §5.5 measured a ring at, on a floor whose pool was still
 * at `g = 0.46`. At `GAIN` 0.92 the floor is roughly twice as bright and the same 0.60 no
 * longer reaches image B's joint. Measured on the composite (radial profile aligned per ray
 * over 70 rays, detrended against the pool, floor : trough):
 *
 * ```
 *   ring        k=0.20  k=0.40  k=0.60  k=0.80        image B, same method
 *   0.60         1.35    1.27    1.25    1.33         k=0.29 2.41   k=0.34 2.23
 *   0.92         1.56    1.52    1.44    1.96         k=0.52 1.94   k=0.71 1.50
 *                                                     k=0.93 1.61
 * ```
 *
 * Every measurable ring now lands inside image B's own 1.50 .. 2.41 band. It cannot go much
 * further: `C_MORTAR` at alpha 1.0 is the washed floor's own floor, which caps the darkest
 * ring this room can draw at about 1.8:1 once the pool, the core spill and the vignette are
 * painted back over it. The joints cover 7.1 % of the pit and the knights are unmoved by the
 * change — see the contrast table under {@link GAIN}.
 */
const MORTAR_ALPHA = 0.92;
const COURSE_LIT_ALPHA = 0.16 * GAIN;
const MEDALLION_ALPHA = 0.13 * GAIN;
const MEDALLION_LINE_ALPHA = 0.5;
const POOL_ALPHA = 0.14 * GAIN;
const CORE_SPILL_ALPHA = 0.1 * GAIN;

/** Colours, sampled from image B (§1.7) or already in `Scene.tsx`'s stack. */
const C_WASH = '#03070f';
const C_MORTAR = '#04070d';
const C_LIT = '#a8d6f0';
const C_DAIS = '#8fb6cf';
const C_MEDALLION = '#9fc4dc';
const C_POOL = '#96cdeb';
const C_CORE = '#6ee1ff';
const C_FLAME = '#31b2b9';
const C_FLAME_HALO = '#0f323b';
const C_VOID = '#060a13';

/**
 * The pool moves off the pit's geometric centre up to the creature's feet, because §1.4
 * measured image B's one real light centred on the creature and ours stands at the top of the
 * band. The semi-axes overshoot the pit deliberately: the falloff should still be dropping
 * where the floor ends, so the rim reads as unlit rather than as the end of a gradient.
 *
 * Typed, it was (512, 452, 520, 150) — a 150-unit semi-minor axis covering 100 % of a 224-unit
 * band but only 79 % of a 544-unit one (`arena.md` §4.1). The far rows would fall to the bare
 * wash and the outermost courses, already the dimmest, would go invisible out there. Derived,
 * it is (512, 466, 504, 182) on this pit and still the same light on the shipped one.
 */
const POOL_CX = BOSS_SPAWN[0];
const POOL_CY = u(PIT_TOP + 0.3 * (PIT_BOT + 1 - PIT_TOP));
const POOL_RX = u(1.05 * RING_RX);
const POOL_RY = u(0.67 * (PIT_BOT + 1 - PIT_TOP));

/**
 * The ceiling the creature emerges from and the near-rim shadow band, both derived off the
 * edge they describe. `CEILING_END` means "just past the pit's top edge" and `RIM_SHADOW`
 * peaks on the rim wall; typed as 330 and [520, 600, 700] they meant that only on the pit they
 * were fitted to. Both reproduce their shipped values exactly at the shipped `PIT_TOP`/`PIT_BOT`.
 */
const CEILING_END = Math.max(BACKDROP_TOP, PIT_TOP - 54);
const RIM_SHADOW = [PIT_BOT - 87, PIT_BOT - 7, PIT_BOT + 93] as const;

/**
 * Where the creature's chest orb throws its ambient bounce, in world units. Both terms are
 * generated — `BOSS_SPAWN` by `gen_map.py`, `CORE` by `gen_hitboxes.py` — so when the boss
 * moves this light moves with it and nobody has to remember. Writing the sum here instead
 * would re-create this project's signature defect in the one place two generators exist to
 * prevent it.
 *
 * It is the room's bounce and NOT the lamp: `.hr-boss-vent` is `opacity: 0` for the lobby,
 * the muster and the first two thirds of the fight, and this layer is static by contract and
 * cannot key off `vent_open`. `Boss.tsx` owns the hotspot.
 */
const CORE_WORLD = { x: BOSS_SPAWN[0] + CORE.x, y: BOSS_SPAWN[1] + CORE.y };

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------
//
// Everything above is derived from the generated map, and every one of its failure modes is
// silent: a ring that misses the floor, a medallion outside the pit, a flame on a wall tile
// the overlay then paints over, a step that does not reach the doorway. All of them render
// something and throw nothing. Check them once, at import, where a map redraw will trip them.
{
  if (!Number.isFinite(PIT_X0) || PIT_PATH.length === 0) {
    throw new Error('BossArena: the generated map has no pit floor');
  }
  if (RING_CX - RING_RX !== PIT_X0 || RING_CX + RING_RX !== PIT_X1) {
    // The circle is drawn about the arena's centre line, not about the pit's own midpoint.
    // A map redraw that made the pit asymmetric would put the whole ring family off centre
    // with the boss still at top centre, and nothing would report it.
    throw new Error('BossArena: the pit is not centred on the arena, so the rings cannot be');
  }
  if (SPRITE_H - WASH_ABOVE_PIT !== 20) {
    throw new Error(
      `BossArena: WASH_ABOVE_PIT is SPRITE_H - Knight.tsx FEET_Y; SPRITE_H is now ${SPRITE_H}`,
    );
  }
  // The backdrop must FIT its band, not merely have one. `arena.md` §2.3: all three of these
  // overrun invisibly — the chains hang into the strip a knight's sprite covers and the
  // statue's horns cross the map's border row — and nothing downstream reports either.
  const backdropBot = Math.max(CHAIN_BOT, BANNER_TOP + BANNER_H + BANNER_POINT, STATUE_TOP + 260 * STATUE_K);
  // +1 of slack so `u`'s two-decimal rounding cannot make a shape that lands exactly on the
  // band's floor line read as an overrun. A real overrun is tens of units, not hundredths.
  if (BACKDROP_BOT <= BACKDROP_TOP || backdropBot > BACKDROP_BOT + 1) {
    throw new Error(`BossArena: the backdrop does not fit its band (ends at ${backdropBot})`);
  }
  if (STATUE_TOP - 12 * STATUE_K < BACKDROP_TOP) {
    throw new Error('BossArena: the statue crosses the map border row');
  }
  // Every course inside the pit, and no two closer together than the mortar is wide. The
  // second clause is the innermost kerb: `RING_RY * RING_K[0] - KERB` is an `<ellipse>` `ry`,
  // and a negative one is an SVG error — the element is dropped and NOTHING is reported.
  if (RING_N < 4 || RING_RY / RING_N < 12 || RING_RY * RING_K[0]! <= KERB) {
    throw new Error(`BossArena: ${RING_N} courses over a ${RING_RY}-unit semi-minor axis`);
  }
  // The pool has to reach the floor's far rows, or they fall to the bare wash and the
  // outermost course — the dimmest one — goes invisible out there with no error.
  if (POOL_RY < (PIT_BOT + 1 - PIT_TOP) / 2 || POOL_RX < RING_RX) {
    throw new Error('BossArena: the pool does not cover the pit');
  }
  if (STEP_TOP < PIT_TOP || STEP_TOP % MAP_TILE !== 0) {
    throw new Error(`BossArena: the steps do not land on a pit tile row (top ${STEP_TOP})`);
  }
  // Every flame must be on a walkable tile. On a `#` tile the overlay's opaque wall layer
  // paints straight over it and the arena silently loses a lamp.
  for (const [x, y] of BRAZIERS) {
    const tile = MAP_GRID[Math.floor(y / MAP_TILE)]?.[Math.floor(x / MAP_TILE)] ?? '#';
    if (tile === '#') throw new Error(`BossArena: brazier at ${x},${y} is on a wall tile`);
  }
  // No count test: `arena.md` §7.1 — the count is now derived from the pit's height, and the
  // tests that matter are on-floor (above) and mirrored (below).
  if (BRAZIERS.length < 12) throw new Error(`BossArena: only ${BRAZIERS.length} braziers`);
  // Mirrored about the centre line, which is what makes the composition read as a circle.
  const mirrored = BRAZIERS.every(([x, y]) =>
    BRAZIERS.some(([mx, my]) => my === y && Math.abs(2 * RING_CX - mx - x) < 1),
  );
  if (!mirrored) throw new Error('BossArena: the braziers are not symmetric about the centre line');
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

const LIGHTING = (
  <defs>
    {/* The creature's ambient bounce. See CORE_WORLD — this is the room, not the lamp. */}
    <radialGradient
      id="ba-core"
      gradientUnits="userSpaceOnUse"
      cx={CORE_WORLD.x}
      cy={CORE_WORLD.y}
      r={330}
    >
      <stop offset="0" stopColor={C_CORE} stopOpacity={CORE_SPILL_ALPHA} />
      <stop offset="1" stopColor={C_CORE} stopOpacity={0} />
    </radialGradient>

    {/* The one real light: the pool, centred on the creature's feet. Image B's entire floor
        lighting model is this single radial falloff, measured at 2.7:1 centre to rim. */}
    <radialGradient
      id="ba-pool"
      gradientUnits="userSpaceOnUse"
      r={1}
      cx={0}
      cy={0}
      gradientTransform={`translate(${POOL_CX} ${POOL_CY}) scale(${POOL_RX} ${POOL_RY})`}
    >
      <stop offset="0" stopColor={C_POOL} stopOpacity={POOL_ALPHA} />
      <stop offset="1" stopColor={C_POOL} stopOpacity={0} />
    </radialGradient>

    {/* The ceiling. The asset's own dark top band is 26 world units tall and the reference
        needs the creature emerging from darkness across the whole upper third; this is what
        sinks the backdrop's pillars and statues into the dark so they read as receding. */}
    <linearGradient id="ba-ceiling" gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={CEILING_END}>
      <stop offset="0" stopColor="#050811" stopOpacity={0.92} />
      <stop offset="1" stopColor="#050811" stopOpacity={0} />
    </linearGradient>

    <linearGradient
      id="ba-rim"
      gradientUnits="userSpaceOnUse"
      x1={0}
      y1={RIM_SHADOW[0]}
      x2={0}
      y2={RIM_SHADOW[2]}
    >
      <stop offset="0" stopColor="#03060c" stopOpacity={0} />
      <stop
        offset={(RIM_SHADOW[1] - RIM_SHADOW[0]) / (RIM_SHADOW[2] - RIM_SHADOW[0])}
        stopColor="#03060c"
        stopOpacity={0.72}
      />
      <stop offset="1" stopColor="#03060c" stopOpacity={0} />
    </linearGradient>

    <radialGradient id="ba-vignette" cx="50%" cy="50%" r="72%">
      <stop offset="0.52" stopColor="#000000" stopOpacity={0} />
      <stop offset="1" stopColor="#000000" stopOpacity={0.72} />
    </radialGradient>

    {/* The ring family and the medallions are clipped to the pit floor itself, so the map's
        chamfer on rows 33-35 cuts the ellipse's corners for free. 13,991 units inside the
        outermost ring are wall and 25,366 walkable units sit outside it; this is what keeps
        those two facts from needing a second, hand-drawn geometry to disagree with. */}
    <clipPath id="ba-pit-clip">
      <path d={PIT_PATH} />
    </clipPath>
  </defs>
);

/**
 * The whole room, as one element built once at module load.
 *
 * Render it as `{BOSS_ARENA}` as the FIRST child of `#camera` while the local seat's zone is
 * `ZONE_ARENA`. Do not wrap it, do not give it a key that changes, do not pass it anything.
 */
export const BOSS_ARENA: ReactElement = (
  <g
    id="boss-arena"
    aria-hidden
    // The promotion hint. No transform is ever written to this node — `#camera` above it owns
    // the passage's translate, and two writers on one node's transform is this project's
    // signature bug.
    style={{ willChange: 'transform', pointerEvents: 'none' }}
  >
    {LIGHTING}

    {/* Void under everything, so the fitted viewBox's bleed never shows the host's own
        background. `vp-void` is not decoration: `useViewport` RESIZES every node with that
        class to the live box inflated by `VIEW_BLEED` on each resize (spec section 8 row 1),
        which is what makes this correct at any stage aspect. The static numbers below are
        only the pre-layout frame; without the class they were the whole story and stopped at
        x -256..1280, which is 42.6 units short on each side at 3440x1392 (measured). */}
    <rect
      className="vp-void"
      x={-ARENA_UNITS / 4}
      y={-ARENA_UNITS / 4}
      width={ARENA_UNITS * 1.5}
      height={ARENA_UNITS * 1.5}
      fill={C_VOID}
    />

    {/* The masonry. `preserveAspectRatio` is off by construction: the 210x238 source is
        stretched to the 1024x1024 arena, an 11.8 % vertical squash that is invisible on
        stone read from above and mildly helpful, since a top-down ground plane is
        foreshortened anyway. */}
    <g
      transform={`scale(${ARENA_UNITS / TEMPLE_W} ${ARENA_UNITS / TEMPLE_H})`}
      style={{ filter: TEMPLE_GRADE }}
    >
      {TEMPLE_PATHS.map(([fill, d], i) => (
        <path key={i} fill={fill} d={d} />
      ))}
    </g>

    {/* The backdrop, above the rim. Flat, dark, no mass — see BACKDROP_BOT. The ceiling
        gradient at the end of this file is what makes it recede rather than loom. */}
    <g shapeRendering="geometricPrecision">
      <path d={CHAIN_PATH} fill="none" stroke="#141a26" strokeWidth={5} strokeDasharray="9 5" opacity={0.9} />
      <path d={PILLAR_PATH} fill="#0e1723" />
      <path d={BANNER_PATH} fill="#2b2030" opacity={0.85} />
      {BANNER_XS.map((x) => (
        <path
          key={x}
          d={SKULL_D}
          transform={`translate(${x} ${u(BANNER_TOP + 0.2 * BACKDROP_H)})`}
          fill="#8b7f86"
          opacity={0.45}
        />
      ))}
      {STATUE_XS.map((x) => (
        <path
          key={x}
          d={STATUE_D}
          transform={`translate(${x} ${STATUE_TOP}) scale(${STATUE_K})`}
          fill="#10131d"
        />
      ))}
    </g>

    {/* The wash. The pit floor as the map defines it, plus one knight's worth of headroom
        above it: a raider on the pit's top row is drawn from PIT_TOP - 22, and without the
        band that sprite reads against un-washed masonry at more than twice the median
        background luminance. That hot spot was the worst legibility in the shipped build. */}
    <path d={PIT_PATH} fill={C_WASH} fillOpacity={WASH_ALPHA} />
    <rect
      x={PIT_X0}
      y={BACKDROP_BOT}
      width={PIT_X1 - PIT_X0}
      height={WASH_ABOVE_PIT}
      fill={C_WASH}
      fillOpacity={WASH_ALPHA}
    />

    {/* The circular floor. `geometricPrecision` is set here as well as at the root: a stroked
        ellipse under `crispEdges` is a staircase, and this group must not inherit one if the
        root's attribute ever changes again. `Spawn.tsx` carries the same override. */}
    <g clipPath="url(#ba-pit-clip)" shapeRendering="geometricPrecision">
      {/* The dais: no raised platform. The creature covers 34 % of the pit and is clipped
          flat at the rim, so a platform would have no visible bottom edge to sit under —
          and image B's dais reads as paving plus light, not as height. The fill is worth
          +3.0 L8 on its own; the pool centred on it is the rest. */}
      <ellipse
        cx={RING_CX}
        cy={RING_CY}
        rx={RING_RX * DAIS_K}
        ry={RING_RY * DAIS_K}
        fill={C_DAIS}
        fillOpacity={DAIS_ALPHA}
      />

      {/* The courses. Each is a dark mortar joint with the lit top face of its kerb showing
          just inside it — the same cue `MAP_RIM_PATH` draws on every wall in this game, and
          the light/dark pair image B carries at every one of its rings.

          The two ellipses are concentric and separated by {@link KERB}, NOT by a translate:
          a 2-unit kerb band at radius `k*R - 2.5` and a 3-unit joint at `k*R` touch at 1.5
          units and never overlap, at every angle. The drawn widths are image B's own — its
          aligned radial profile puts the joint at 3 units and the crest 2 units off it. */}
      {RING_K.map((k) => (
        <g key={k}>
          <ellipse
            cx={RING_CX}
            cy={RING_CY}
            rx={RING_RX * k - KERB}
            ry={RING_RY * k - KERB}
            fill="none"
            stroke={C_LIT}
            strokeOpacity={COURSE_LIT_ALPHA}
            strokeWidth={2}
          />
          <ellipse
            cx={RING_CX}
            cy={RING_CY}
            rx={RING_RX * k}
            ry={RING_RY * k}
            fill="none"
            stroke={C_MORTAR}
            strokeOpacity={MORTAR_ALPHA}
            strokeWidth={3}
          />
        </g>
      ))}

      <path
        d={MEDALLION_PATH}
        fill={C_MEDALLION}
        fillOpacity={MEDALLION_ALPHA}
        stroke={C_MORTAR}
        strokeOpacity={MEDALLION_LINE_ALPHA}
        strokeWidth={2}
      />

      {/* The steps, where the gate lets players in. */}
      {Array.from({ length: STEP_COUNT }, (_, i) => (
        <g key={i}>
          <rect
            x={GATE_MIN_X}
            y={STEP_TOP + i * STEP_H}
            width={STEP_W}
            height={STEP_H}
            fill={C_MORTAR}
            fillOpacity={0.18 + i * 0.14}
          />
          <rect
            x={GATE_MIN_X}
            y={STEP_TOP + i * STEP_H}
            width={STEP_W}
            height={2}
            fill={C_LIT}
            fillOpacity={COURSE_LIT_ALPHA * 2}
          />
        </g>
      ))}
    </g>

    {/* The far rim: the pit's top edge, lit. The one hard line in the room that says "the
        ground stops here". The NEAR rim is the boss rig's occluder, redrawn over everything
        by `Arena.tsx`, and is not this layer's. */}
    <rect x={PIT_X0} y={PIT_TOP - 2} width={PIT_X1 - PIT_X0} height={3} fill={C_LIT} opacity={0.42} />
    <rect x={PIT_X0} y={PIT_TOP + 1} width={PIT_X1 - PIT_X0} height={14} fill="#03060c" opacity={0.5} />

    {/* Twelve flames and their bloom. No floor gradients — see BRAZIERS. */}
    <path d={BRAZIER_HALO} fill={C_FLAME_HALO} opacity={0.7} />
    <path d={BRAZIER_FLAME} fill={C_FLAME} />
    <path d={BRAZIER_CORE} fill="#bdf6f8" opacity={0.9} />

    {/* The lighting, painted over the graded masonry and NOT through the grade filter: the
        added cyan is already the colour it should be, and running it through sepia +
        hue-rotate would grade the light along with the stone. */}
    <rect
      x={-ARENA_UNITS / 4}
      y={-ARENA_UNITS / 4}
      width={ARENA_UNITS * 1.5}
      height={CEILING_END + ARENA_UNITS / 4}
      fill="url(#ba-ceiling)"
    />
    <rect x={0} y={0} width={ARENA_UNITS} height={ARENA_UNITS} fill="url(#ba-pool)" />
    <rect x={0} y={0} width={ARENA_UNITS} height={ARENA_UNITS} fill="url(#ba-core)" />
    <rect
      x={0}
      y={RIM_SHADOW[0]}
      width={ARENA_UNITS}
      height={RIM_SHADOW[2] - RIM_SHADOW[0]}
      fill="url(#ba-rim)"
    />
    <rect x={0} y={0} width={ARENA_UNITS} height={ARENA_UNITS} fill="url(#ba-vignette)" />
  </g>
);
