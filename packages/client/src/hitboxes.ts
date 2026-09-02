// @generated from assets/sprites/hitboxes.json by `python3 tools/gen_hitboxes.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the drawn
// boss and the raycast boss stop being the same boss. Move the art, re-run
// `python3 tools/gen_boss.py`, then re-run the command above.
/**
 * Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y` -- the exact
 * numbers `programs/heartrot/src/hitboxes.rs` raycasts against, emitted from the same
 * JSON in the same pass. Client-side hit prediction that disagrees with the chain is
 * the bug this file exists to make impossible.
 *
 * `assets/sprites/hitboxes.json` is in sprite pixels on a 318x604 canvas, origin top-left; one sprite pixel
 * is 1 arena units. The two spaces differ by `local = sprite * BOSS_SCALE +
 * BOSS_ANCHOR_*` and nothing else -- the renderer must use exactly that, or the drawn
 * boss and the raycast boss stop being the same boss.
 */

/** A boss-local axis-aligned box, in arena units relative to `Boss.x` / `Boss.y`. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The source canvas, in SPRITE pixels. Multiply by {@link BOSS_SCALE} for arena units. */
export const BOSS_SPRITE_W = 318;
export const BOSS_SPRITE_H = 604;

/**
 * Arena units per sprite pixel. The renderer draws the sprite at
 * `scale(BOSS_SCALE)` inside the boss group; every number below is already scaled,
 * so nothing else in the client may multiply by it a second time.
 */
export const BOSS_SCALE = 1;

/**
 * Where the SCALED sprite's top-left corner goes, relative to `Boss.x` / `Boss.y`.
 * The sprite's own viewBox is in unscaled pixels, so the group is exactly:
 *
 *     translate(boss.x + BOSS_ANCHOR_X, boss.y + BOSS_ANCHOR_Y) scale(BOSS_SCALE)
 *
 * in that order, and nothing else. It is the scaled canvas centre, derived from the
 * sprite's own dimensions -- import it rather than recomputing it, or the art and the
 * raycast drift apart again.
 */
export const BOSS_ANCHOR_X = -159;
export const BOSS_ANCHOR_Y = -302;

/** Index-aligned with `BossAccount.parts`: thorn0, thorn1, thorn2, thorn3, crown, wolf_l, beast_r, mace, claws. */
export const PART_HITBOXES: readonly [Rect, Rect, Rect, Rect, Rect, Rect, Rect, Rect, Rect] = [
  { x: -79, y: -254, w: 27, h: 59 }, // 0 thorn0
  { x: 59, y: -245, w: 36, h: 52 }, // 1 thorn1
  { x: -158, y: -76, w: 50, h: 27 }, // 2 thorn2
  { x: 85, y: -132, w: 33, h: 83 }, // 3 thorn3
  { x: -49, y: -301, w: 125, h: 118 }, // 4 crown
  { x: -147, y: -223, w: 100, h: 116 }, // 5 wolf_l
  { x: 25, y: -222, w: 131, h: 107 }, // 6 beast_r
  { x: -129, y: -114, w: 67, h: 106 }, // 7 mace
  { x: 33, y: -120, w: 87, h: 113 }, // 8 claws
];

/**
 * The vent, as the circle inscribed in the `core` box. `radiusSq` is squared to match
 * the program, which compares squared distances and never takes a square root.
 */
export const CORE: { readonly x: number; readonly y: number; readonly radiusSq: number } = {
  x: -15,
  y: -108,
  radiusSq: 1024,
};

/** Where a volley leaves the boss: the `BossAccount.parts` index that fires, and the
 * boss-local point it fires from. */
export interface Muzzle {
  readonly part: number;
  readonly x: number;
  readonly y: number;
}

/**
 * The volley emitters — the exact points `programs/heartrot/src/hitboxes.rs` spawns
 * bullets at, emitted from the same JSON in the same pass, so a locally predicted volley
 * and the chain's volley leave the same thorn.
 *
 * Each point is a DRAWN pixel of its thorn -- the one nearest the mask centroid, written
 * by `tools/gen_boss.py` -- so a volley leaves paint and not the air beside it.
 */
export const MUZZLES: readonly [Muzzle, Muzzle, Muzzle, Muzzle] = [
  { part: 0, x: -67, y: -222 }, // thorn0
  { part: 1, x: 77, y: -217 }, // thorn1
  { part: 2, x: -130, y: -62 }, // thorn2
  { part: 3, x: 102, y: -93 }, // thorn3
];
