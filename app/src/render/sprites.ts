/**
 * Palette and shape constants — everything the renderer's layers share.
 *
 * There is no geometry in here any more. The rooms are painted, the boss and the archer
 * are atlases, and the ordnance is `./ordnance.gen`. The wall and rim paths this file
 * used to compile from `MAP_GRID` were painted flat over every wall tile, which over a
 * painted room is a colour mask over the painted walls, so they went with the vector
 * rooms — the map is still the one generated table the chain raycasts and `predict.ts`
 * collides against; it is simply no longer drawn a second time.
 *
 * Boss coordinates are not here at all — `PART_HITBOXES` and `CORE` come straight from
 * `@heartrot/client`, so the drawn boss and the raycast boss cannot drift.
 *
 * Nothing in here touches React or the DOM.
 */
import { MAP_TILE, MAP_TILES } from '@heartrot/client';

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

/**
 * Past this a position change was a teleport, not a walk — a reconcile across a feed
 * stall. Chasing it draws a body gliding across the dungeon for two seconds, so
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
// `30 * MAP_TILE` .. `34 * MAP_TILE - 1` on BOTH axes — a square block — and the gate was
// never square, and is now three blocks: `GATES`, by tier, out of `tools/gen_map.py` into
// `@heartrot/client`, alongside `gateAt` itself, which is the same predicate
// `map::gate_at` runs for `enter_gate`. A caller restating a gate drew the marker 128
// units north of the real one, inside the pit, and "walk to the middle" stranded every
// player. Import those; never restate them.

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
 * the other raiders, a live boss part from a destroyed one, and a bullet from the floor —
 * the last is the ordnance atlas's own amber now (`tools/gen_ordnance.py`), not a paint
 * in here.
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
} as const;

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

// The facing table fails silently: a non-unit heading puts a player's aim stub off their
// own dot, which reads as a rendering glitch rather than as a bad constant. Cheap enough
// to check at import, and it should stop the app here rather than three layers down.
{
  if (FACING_UNIT.length !== 8) throw new Error('sprites: FACING_UNIT must have 8 headings');
  for (const [x, y] of FACING_UNIT) {
    if (Math.abs(Math.hypot(x, y) - 1) > 0.001) throw new Error(`sprites: [${x},${y}] is not a unit heading`);
  }
}
