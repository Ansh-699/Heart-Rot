// @generated from assets/rooms/arena.png by `python3 tools/gen_boss.py` -- DO NOT EDIT.
//
// The boss, cut out of the arena painting. Every rect below is a cell of
// `assets/sprites/boss_parts.png` and its place on the crop canvas `hitboxes.json`
// describes -- the same partition `gen_hitboxes.py` turns into the chain's boxes, so
// the drawn limb and the hittable limb are one limb. Edit `tools/gen_boss.py`, re-run.
import atlas from '../../../assets/sprites/boss_parts.png';

/** The atlas URL. Vite hashes the file under `/assets/`; it is never inlined. */
export const BOSS_ATLAS: string = atlas;
/** The atlas bitmap, in atlas pixels -- the `<image>`'s own width and height. */
export const ATLAS_W = 488;
export const ATLAS_H = 395;
/** Atlas pixels per crop pixel: the source was 1x the 1122 px authoring width. */
export const ATLAS_SCALE = 1;

export interface BossPart {
  readonly name: string;
  /** The `Boss.parts` slot, or `null` for a rig-only group (`torso`, `core`). */
  readonly index: number | null;
  /** The cell's top-left in the atlas, in atlas pixels; the cell is `w * ATLAS_SCALE` by `h * ATLAS_SCALE`. */
  readonly ax: number;
  readonly ay: number;
  /** The part's tight box on the crop canvas, in crop pixels (= arena units at `--scale 1`). */
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
}

/** Paint order, back to front. */
export const BOSS_PARTS: readonly BossPart[] = [
  { name: 'torso', index: null, ax: 0, ay: 0, w: 263, h: 286, cx: 38, cy: 4 },
  { name: 'claws', index: 8, ax: 0, ay: 286, w: 76, h: 109, cx: 192, cy: 186 },
  { name: 'mace', index: 7, ax: 207, ay: 286, w: 59, h: 102, cx: 31, cy: 190 },
  { name: 'core', index: null, ax: 299, ay: 286, w: 65, h: 65, cx: 112, cy: 162 },
  { name: 'beast_r', index: 6, ax: 76, ay: 286, w: 131, h: 107, cx: 184, cy: 80 },
  { name: 'wolf_l', index: 5, ax: 388, ay: 0, w: 100, h: 116, cx: 12, cy: 79 },
  { name: 'crown', index: 4, ax: 263, ay: 0, w: 125, h: 118, cx: 110, cy: 1 },
  { name: 'thorn3', index: 3, ax: 266, ay: 286, w: 33, h: 83, cx: 244, cy: 170 },
  { name: 'thorn2', index: 2, ax: 427, ay: 286, w: 50, h: 24, cx: 1, cy: 229 },
  { name: 'thorn1', index: 1, ax: 391, ay: 286, w: 36, h: 52, cx: 218, cy: 57 },
  { name: 'thorn0', index: 0, ax: 364, ay: 286, w: 27, h: 59, cx: 80, cy: 48 },
];

/** The skull's two eyes, in crop pixels -- the bright blocks the painting lights from within. */
export const EYES_PX: readonly (readonly [number, number])[] = [[138, 142], [152, 142]];
