/**
 * Palette, shape constants and the compiled dungeon — everything the primitive renderer
 * shares.
 *
 * There is no sprite rig any more: no `boss.svg`, no `knights.svg`, no slicing, no
 * `<defs>`. Players are circles, the boss is a mass with its nine generated hitboxes drawn
 * as rects, bullets are dots. So all that is left to share is colour, size, and the wall
 * geometry — and even that is *compiled* from `MAP_GRID`, the same generated table the
 * chain raycasts and `predict.ts` collides against, rather than drawn as a picture of a
 * room. Hand-copied geometry is the signature bug of this project: one disagreeing tile
 * reads as permanent lag rather than as a map bug.
 *
 * Boss coordinates are not here at all — `PART_HITBOXES` and `CORE` come straight from
 * `@heartrot/client`, so the drawn boss and the raycast boss cannot drift.
 *
 * Nothing in here touches React or the DOM.
 */
import { MAP_GRID, MAP_TILE, MAP_TILES } from '@heartrot/client';

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/**
 * The scene's viewBox is arena space, 1:1 — the same `MAP_TILES * MAP_TILE` the chain
 * clamps every position into. `PlayerSlot.x`, `Boss.x` and `Bullet.x` land in the SVG
 * unmodified: no scale factor, no rounding, no second unit to convert between. It is also
 * what lets bullet extrapolation be exact — the client steps the same integers the crank
 * does. `App.tsx` computes this same number the same way for its aim scale.
 */
export const ARENA_UNITS = MAP_TILES * MAP_TILE;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Bullet dot radius. */
export const BULLET_R = 4;

/**
 * Past this a position change was a teleport, not a walk — a reconcile onto a respawn at
 * an entrance. Chasing it draws a corpse gliding across the dungeon for two seconds, so
 * the render snaps instead, and the gait accumulator resets rather than spinning the legs.
 *
 * Three readers: `Arena.tsx`'s `chase`, `Knight.tsx`'s `advance`, and — restated there,
 * because `net/` may not import `render/` — `predict.ts::teleported`. It lives in this
 * leaf module rather than in `Arena.tsx` because `Arena` imports `Knight`: an export read
 * back the other way at module scope is a temporal-dead-zone crash, not a cycle warning.
 */
export const SELF_SNAP = 4 * MAP_TILE;
/** The little hp bar floating over a player. */
export const HP_BAR_W = 26;

// `PLAYER_R` and `BOSS_R` are gone with the primitives they sized: `Knight.tsx` and
// `Boss.tsx` own their own geometry now, off the generated sprite boxes and
// `PART_HITBOXES`.
//
// So are `GATE_MIN` / `GATE_MAX`, and they were the dangerous pair. They read
// `30 * MAP_TILE` .. `34 * MAP_TILE - 1` on BOTH axes — a square block — and the gate is
// no longer square: x 480..543 by y 608..639. A caller reusing them drew the marker 128
// units north of the real gate, inside the pit, and "walk to the middle" stranded every
// player. `GATE_MIN_X` / `GATE_MAX_X` / `GATE_MIN_Y` / `GATE_MAX_Y` come out of
// `tools/gen_map.py` into `@heartrot/client`, alongside `onGate` itself, which is the
// same predicate `handlers::player::on_gate` runs. Import those; never restate them.

/**
 * `PlayerSlot.facing` is eight-way clockwise from north (`FACING_STEP` in `shoot.rs`),
 * with y growing downward. Normalised, so the facing stub sticks out the same distance on
 * a diagonal as on a cardinal.
 */
export const FACING_UNIT: readonly (readonly [number, number])[] = [
  [0, -1],
  [0.7071, -0.7071],
  [1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
  [-1, 0],
  [-0.7071, -0.7071],
];

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Legibility over beauty. Three separations have to survive a dim laptop screen: you from
 * the other raiders, a live boss part from a destroyed one, and a bullet from the floor.
 */
export const PAL = {
  wall: '#2b2733',
  /** Lit top face of a wall, so a pillar and a corridor are not one flat block. */
  rim: '#413a4f',
  entrance: '#b5b56a',

  selfRing: '#eafff4',
  outline: '#0f0d12',

  hpBack: '#000000',
  hpFill: '#8bd450',

  bossEdge: '#ff5c7a',
  partLive: '#c94f6d',

  ventOpen: '#ffe873',

  bullet: '#ffb020',
} as const;

// ---------------------------------------------------------------------------
// The dungeon
// ---------------------------------------------------------------------------

/** Contiguous runs of `true`, as inclusive `[start, end]` pairs. */
function spans(flags: readonly boolean[]): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i] === true;
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push([start, i - 1]);
      start = -1;
    }
  }
  return out;
}

/**
 * 4,096 tiles would be 4,096 nodes that never change. Merging each row's runs into
 * subpaths of one `d` makes each layer a single node, built once per page load.
 */
function tilePath(hit: (tx: number, ty: number) => boolean, h: number = MAP_TILE): string {
  let d = '';
  for (let ty = 0; ty < MAP_TILES; ty++) {
    const flags = Array.from({ length: MAP_TILES }, (_, tx) => hit(tx, ty));
    for (const [lo, hi] of spans(flags)) {
      const w = (hi - lo + 1) * MAP_TILE;
      d += `M${lo * MAP_TILE} ${ty * MAP_TILE}h${w}v${h}h-${w}z`;
    }
  }
  return d;
}

/** Off-map reads as wall, exactly as `isWallTile` decides it. */
function tileAt(tx: number, ty: number): string {
  return MAP_GRID[ty]?.[tx] ?? '#';
}

/** Every solid tile: the border, the corner rocks, the chamber walls, the pillars. */
export const MAP_WALL_PATH = tilePath((tx, ty) => tileAt(tx, ty) === '#');

/** The lit top face of every wall with floor above it. Purely a legibility cue. */
export const MAP_RIM_PATH = tilePath((tx, ty) => tileAt(tx, ty) === '#' && tileAt(tx, ty - 1) !== '#', 3);

/** The four edge entrances — walkable, so a floor tint and not a wall. */
export const MAP_ENTRANCE_PATH = tilePath((tx, ty) => tileAt(tx, ty) === 'E');

/**
 * How many projectile nodes the whole scene may draw — boss ordnance plus arrows, one
 * budget shared across both layers.
 *
 * It lives here because it is ONE number and it used to be two: `Arena.tsx` typed it as
 * `VISIBLE_BULLETS` and `Shot.tsx` as `VISIBLE_PROJECTILES`, joined only by
 * `budget={shownBullets.length}` and `cap = VISIBLE_PROJECTILES - budget`. Nothing
 * cross-checked them, so halving `Arena`'s copy to buy frame budget back left `Shot`
 * drawing `32 - 16 = 16` arrows on top of 16 bullets and the scene at 32 nodes again — the
 * measured win silently spent, with no error anywhere. Neither file could own it: `Arena`
 * already imports `Shot`, so exporting it from either would be a cycle.
 *
 * Measured (`docs/perf/frame-budget.md`), 20 knights + full art + the real 714 notif/s feed
 * at 6x CPU throttle: 128 drawn is 11.46 ms p50 / 16.96 p95 with 7.2 % of frames over
 * budget; 32 drawn is 9.38 / 14.92 with 4.6 % over, and the client services 72
 * notifications a second instead of 61. `MAX_BULLETS` is 128 and stays 128 — that is a
 * chain fact and so is `bullets_per_volley`; this caps the PICTURE and never the
 * simulation.
 */
export const VISIBLE_PROJECTILES = 32;

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------

// `spans` is the only non-trivial thing in this file and all of its failure modes are
// silent — a dropped run is a wall you can walk through on screen. The facing table is the
// other: a non-unit heading puts a player's aim stub off their own dot, which reads as a
// rendering glitch rather than as a bad constant. Both are cheap enough to check at import,
// and either should stop the app here rather than three layers down.
{
  const got = JSON.stringify(spans([false, true, true, false, true, false, false, true]));
  if (got !== '[[1,2],[4,4],[7,7]]') throw new Error(`sprites: spans() is broken: ${got}`);
  if (spans([]).length !== 0 || spans([true]).length !== 1) throw new Error('sprites: spans() edges');
  if (MAP_WALL_PATH.length === 0) throw new Error('assets/map: the generated dungeon has no walls');
  if (FACING_UNIT.length !== 8) throw new Error('sprites: FACING_UNIT must have 8 headings');
  for (const [x, y] of FACING_UNIT) {
    if (Math.abs(Math.hypot(x, y) - 1) > 0.001) throw new Error(`sprites: [${x},${y}] is not a unit heading`);
  }
}
