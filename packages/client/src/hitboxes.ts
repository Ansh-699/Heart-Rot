// @generated from assets/sprites/hitboxes.json by `python3 tools/gen_hitboxes.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the drawn
// boss and the raycast boss stop being the same boss. Move the art, re-run
// `python3 tools/svg_slice.py`, then re-run the command above.
/**
 * Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y` -- the exact
 * numbers `programs/heartrot/src/hitboxes.rs` raycasts against, emitted from the same
 * JSON in the same pass. Client-side hit prediction that disagrees with the chain is
 * the bug this file exists to make impossible.
 *
 * `assets/sprites/hitboxes.json` is in sprite pixels on a 230x270 canvas, origin top-left; one sprite pixel
 * is one arena unit. The two spaces differ by `BOSS_ANCHOR_*` and nothing else.
 */

/** A boss-local axis-aligned box, in arena units relative to `Boss.x` / `Boss.y`. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The sprite canvas, in arena units (1 sprite pixel = 1 arena unit). */
export const BOSS_SPRITE_W = 230;
export const BOSS_SPRITE_H = 270;

/**
 * Where the sprite's top-left corner goes, relative to `Boss.x` / `Boss.y`:
 * `translate(boss.x + BOSS_ANCHOR_X, boss.y + BOSS_ANCHOR_Y)`. It is the canvas
 * centre, derived from the sprite's own dimensions -- import it rather than
 * recomputing it, or the art and the raycast drift apart again.
 */
export const BOSS_ANCHOR_X = -115;
export const BOSS_ANCHOR_Y = -135;

/** Index-aligned with `BossAccount.parts`: crown, wolf_l, beast_r, thorn0, thorn1, thorn2, thorn3, mace, claws. */
export const PART_HITBOXES: readonly [Rect, Rect, Rect, Rect, Rect, Rect, Rect, Rect, Rect] = [
  { x: 7, y: -128, w: 67, h: 59 }, // 0 crown
  { x: -47, y: -86, w: 50, h: 53 }, // 1 wolf_l
  { x: 57, y: -83, w: 46, h: 52 }, // 2 beast_r
  { x: -16, y: -107, w: 21, h: 36 }, // 3 thorn0
  { x: 65, y: -98, w: 48, h: 65 }, // 4 thorn1
  { x: -30, y: -37, w: 20, h: 23 }, // 5 thorn2
  { x: 88, y: -8, w: 24, h: 17 }, // 6 thorn3
  { x: -114, y: -33, w: 111, h: 137 }, // 7 mace
  { x: 55, y: -38, w: 52, h: 110 }, // 8 claws
];

/**
 * The vent, as the circle inscribed in the `core` box. `radiusSq` is squared to match
 * the program, which compares squared distances and never takes a square root.
 */
export const CORE: { readonly x: number; readonly y: number; readonly radiusSq: number } = {
  x: 25,
  y: -18,
  radiusSq: 400,
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
 * Each point is its thorn box's centre: inside the box by construction, and needing no
 * notion of "outward", which is a direction the art does not carry.
 */
export const MUZZLES: readonly [Muzzle, Muzzle, Muzzle, Muzzle] = [
  { part: 3, x: -6, y: -89 }, // thorn0
  { part: 4, x: 89, y: -66 }, // thorn1
  { part: 5, x: -20, y: -26 }, // thorn2
  { part: 6, x: 100, y: 0 }, // thorn3
];
