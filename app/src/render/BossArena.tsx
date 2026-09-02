/**
 * Room B — the fight arena, built to `/home/anshtyagi/Downloads/actual_boss_arena.png`.
 *
 * ## What this is
 *
 * The whole static environment for `ZONE_ARENA`, as ONE module-scope `ReactElement` with no
 * props. It is the room-B half of `17-fullscreen-spec.md` §2.2 and the implementation of
 * `docs/art/boss-arena.md`: a circular tiered floor of concentric stone courses with
 * cardinal medallions, the boss's dais at top centre, steps at the doorway the gate lets
 * players in through, twelve cyan brazier flames, and a dark backdrop of pillars, chains,
 * purple banners and demon statues above the pit rim. Cold teal light on blue-grey stone;
 * the creature (drawn by `Boss.tsx`, not here) is the only bright thing in the frame.
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
// Duplicated from `Scene.tsx` because that file exports only its finished `SCENE` element.
// Both reads go to the same asset, so this is duplicated CODE and not a duplicated FACT —
// but it is still two copies of one regex. When `Scene.tsx` is retired in favour of the two
// room files, hoist these four constants into a shared module and delete both copies.
// ponytail: one extra regex. Ceiling: a re-conversion of temple.svg has to be checked twice.

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
 * Course boundaries as a fraction of the radius. Read off image B by elliptical binning with
 * the pool's falloff subtracted (`boss-arena.md` §1.5): heavy mortar lines at r 0.44, 0.65,
 * 0.87 with 0.21 spacing, finer courses inside the dais, and the lit kerb outside the last.
 *
 * Orthographic and NOT perspective-corrected. The floor plane IS the coordinate space, so
 * `PlayerSlot.x`/`.y` land in the SVG unmodified. A perspective floor would draw the rings
 * somewhere the chain's positions are not, and this project has twice misdiagnosed exactly
 * that class of disagreement as lag.
 */
const RING_K = [0.22, 0.44, 0.65, 0.87, 1.0] as const;

/** The dais is the innermost ring, filled one step lighter — paving plus light, no platform. */
const DAIS_K = RING_K[0];

/** The ring the four cardinal medallions sit on. */
const MEDALLION_K = RING_K[2];

/** Foreshortened like everything else in the pit: 26 x 12 units, 2.2:1. */
const MEDALLION_W = 26;
const MEDALLION_H = 12;

/**
 * Four diamonds at the cardinal points of ring k = 0.65, as one path of four subpaths.
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
 * generated: x is the gate block, and four 8-unit treads fill the two pit rows above it
 * exactly. Darkest at the bottom, in the same value pair as the ring mortar and highlight.
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

/**
 * Twelve flames, mirrored about the arena's centre line.
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
  // Far rim: image B's four symmetric wall pairs, scaled to our width (§1.2).
  for (const dx of [136, 282, 391, 478]) {
    out.push([RING_CX - dx, PIT_TOP - 4], [RING_CX + dx, PIT_TOP - 4]);
  }
  // The chamfer pair, on the first chamfered row's own floor edge.
  const chamferRow = Math.floor(PIT_BOT / MAP_TILE) - 4;
  const [cx0, cx1] = pitSpan(chamferRow);
  const cy = chamferRow * MAP_TILE + MAP_TILE / 2;
  out.push([cx0 + 12, cy], [cx1 - 12, cy]);
  // The doorway pair, flanking the steps on the lowest full-width pit row.
  const doorRow = Math.floor(STEP_TOP / MAP_TILE) - 1;
  const dy = doorRow * MAP_TILE + MAP_TILE / 2;
  out.push([GATE_MIN_X - 24, dy], [GATE_MAX_X + 1 + 24, dy]);
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

const CHAIN_XS = [228, 472].flatMap((dx) => [RING_CX - dx, RING_CX + dx]);
const CHAIN_PATH = CHAIN_XS.map((x) => `M${x} ${BACKDROP_TOP}V${BACKDROP_TOP + 274}`).join('');

const BANNER_XS = [184, 360].flatMap((dx) => [RING_CX - dx, RING_CX + dx]);
const BANNER_PATH = BANNER_XS.map(
  (x) => `M${x - 30} ${BACKDROP_TOP + 8}h60v186l-30 20l-30 -20z`,
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

// ---------------------------------------------------------------------------
// Light — `boss-arena.md` §4, solved in §5.4 rather than chosen
// ---------------------------------------------------------------------------

/**
 * The pit wash, and it is the single most important number in this file.
 *
 * `boss-arena.md` §5.4 binary-searches one gain over every added-light layer at each wash
 * opacity, taking the largest gain that still holds the darkest skin at 3.00:1 worst case.
 * Wash 0.70 / gain 0.46 is the last row whose median floor is still bright enough to show
 * drawn stone detail (§5.5: at wash 0.88 three of the four ring courses are inside 1 L8 of
 * the floor beside them — invisible), and it is the row that fixes the shipped legibility
 * hole: Nocturne worst case 2.05:1 -> 3.00:1, and its failing area 41.9 % of the pit -> zero.
 *
 * Every alpha below is that gain applied to a measured base. Raising the wash washes the
 * rings out; lowering it walks the floor into the knights standing on it. Both directions
 * have been shipped in this project already.
 */
const WASH_ALPHA = 0.7;
const DAIS_ALPHA = 0.046;
const MORTAR_ALPHA = 0.6;
const COURSE_LIT_ALPHA = 0.074;
const MEDALLION_ALPHA = 0.06;
const MEDALLION_LINE_ALPHA = 0.5;
const POOL_ALPHA = 0.064;
const CORE_SPILL_ALPHA = 0.046;

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
 */
const POOL_CY = 452;
const POOL_RX = 520;
const POOL_RY = 150;

/** Unchanged from `Scene.tsx`: the ceiling the creature emerges from, the near-rim band, the vignette. */
const CEILING_END = 330;
const RIM_SHADOW = [520, 600, 700] as const;

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
  if (BACKDROP_BOT <= BACKDROP_TOP) throw new Error('BossArena: no room above the pit for a backdrop');
  if (STEP_TOP < PIT_TOP || STEP_TOP % MAP_TILE !== 0) {
    throw new Error(`BossArena: the steps do not land on a pit tile row (top ${STEP_TOP})`);
  }
  // Every flame must be on a walkable tile. On a `#` tile the overlay's opaque wall layer
  // paints straight over it and the arena silently loses a lamp.
  for (const [x, y] of BRAZIERS) {
    const tile = MAP_GRID[Math.floor(y / MAP_TILE)]?.[Math.floor(x / MAP_TILE)] ?? '#';
    if (tile === '#') throw new Error(`BossArena: brazier at ${x},${y} is on a wall tile`);
  }
  if (BRAZIERS.length !== 12) throw new Error(`BossArena: expected 12 braziers, built ${BRAZIERS.length}`);
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
      gradientTransform={`translate(${RING_CX} ${POOL_CY}) scale(${POOL_RX} ${POOL_RY})`}
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
          transform={`translate(${x} ${BACKDROP_TOP + 78})`}
          fill="#8b7f86"
          opacity={0.45}
        />
      ))}
      {[RING_CX - 316, RING_CX + 316].map((x) => (
        <path key={x} d={STATUE_D} transform={`translate(${x} ${BACKDROP_BOT - 260})`} fill="#10131d" />
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

      {/* The courses. Each is a dark mortar line with the lit top face of its kerb showing
          above it — the same cue `MAP_RIM_PATH` draws on every wall in this game, and the
          bright band image B carries immediately outside its darkest ring. */}
      {RING_K.map((k) => (
        <g key={k}>
          <ellipse
            cx={RING_CX}
            cy={RING_CY - 2}
            rx={RING_RX * k}
            ry={RING_RY * k}
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
