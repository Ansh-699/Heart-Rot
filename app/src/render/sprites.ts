/**
 * Build-time sprite data for the renderer.
 *
 * Everything here is derived from the files in `assets/sprites/` at module load and is
 * then immutable. Nothing in this file touches React or the DOM, so the parsing below is
 * the one place a wrong number can enter the render tree, and the assertions at the
 * bottom fail the app loudly at import rather than drawing a boss with a missing arm.
 *
 * Two source shapes, two different jobs:
 *
 *   `parts/boss.svg`  already carries one `<g id="part-*">` per body part, emitted by
 *                     `tools/svg_slice.py` from the same pass that produced
 *                     `hitboxes.json`. The groups are lifted out verbatim — the animation
 *                     target and the hitbox are literally the same node, which is the
 *                     whole point of that build step.
 *
 *   `knights.svg`     is a flat sheet: 23 `<path>` elements, no groups, three figures
 *                     side by side. It has to be cut up here. The cut is *derived* from
 *                     the sheet's own empty columns rather than hardcoded, so re-exporting
 *                     the art with the figures at different offsets keeps working instead
 *                     of silently drawing a knight's shoulder as a whole knight.
 */
import bossSlicedSvg from '../../../assets/sprites/parts/boss.svg?raw';
import knightsSheetSvg from '../../../assets/sprites/knights.svg?raw';
import roomUrl from '../../../assets/sprites/room.svg';
import hitboxJson from '../../../assets/sprites/hitboxes.json';

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/**
 * The scene's viewBox is arena space, 1:1. `TILE * 64` in `shoot.rs` and `tick.rs`.
 *
 * Drawing in arena units directly means `PlayerSlot.x`, `Boss.x` and `Bullet.x` land in
 * the SVG unmodified: no scale factor, no rounding, no second unit anyone has to convert
 * between. It is also what lets the bullet extrapolation in `Arena.tsx` be exact — the
 * client steps the same integers by the same amount the crank does.
 */
export const ARENA_UNITS = 1024;

/** The static map layer. One `<image>`, rasterised once, never re-rendered. */
export const MAP_URL: string = roomUrl;

/**
 * Bullet square, in arena units. Comfortably inside `PLAYER_HIT_RADIUS` (12) so a bullet
 * that visually clips a knight is a bullet that actually hit it.
 */
export const BULLET_SIZE = 8;

// ---------------------------------------------------------------------------
// px2svg grammar
// ---------------------------------------------------------------------------

/**
 * `px2svg.to_svg()` emits one `<path>` per colour whose `d` is nothing but axis-aligned
 * integer rectangles written `M{x} {y}h{w}v{h}h-{w}z`. `tools/svg_slice.py` relies on that
 * being exact (it verified 7589/7589 subpaths), and so does this file. Anything else in a
 * sprite is a bug we want to hear about at boot, which is why `parseRects` throws instead
 * of skipping what it cannot read.
 */
const PATH_RE = /<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"\s*\/>/g;
const RECT_RE = /M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\3z/g;
const VIEWBOX_RE = /viewBox="0 0 (\d+) (\d+)"/;

type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly fill: string };

function viewBox(svg: string, name: string): { w: number; h: number } {
  const m = VIEWBOX_RE.exec(svg);
  if (!m?.[1] || !m[2]) throw new Error(`${name}: no "viewBox=\\"0 0 W H\\"" on the root <svg>`);
  return { w: Number(m[1]), h: Number(m[2]) };
}

function parseRects(svg: string, name: string): Rect[] {
  const out: Rect[] = [];
  for (const path of svg.matchAll(PATH_RE)) {
    const fill = path[1];
    const d = path[2];
    if (fill === undefined || d === undefined) continue;
    let consumed = 0;
    for (const r of d.matchAll(RECT_RE)) {
      out.push({ x: Number(r[1]), y: Number(r[2]), w: Number(r[3]), h: Number(r[4]), fill });
      consumed += r[0].length;
    }
    if (consumed !== d.length) {
      throw new Error(`${name}: a path d= holds commands outside the px2svg rect grammar`);
    }
  }
  return out;
}

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

// ---------------------------------------------------------------------------
// Boss rig
// ---------------------------------------------------------------------------

type Hitbox = { readonly index: number | null; readonly x: number; readonly y: number; readonly w: number; readonly h: number };

const HITBOXES = hitboxJson.hitboxes as Record<string, Hitbox | undefined>;

/**
 * Where a part swings from, as a fraction of its own hitbox. A crown that rotates about
 * its centre lifts off the skull; a mace arm that rotates about its centre detaches at the
 * shoulder. Anything not named here pivots about its centre, which is right for the thorn
 * sprays and the torso bob.
 */
const PIVOTS: Record<string, readonly [number, number] | undefined> = {
  crown: [0.5, 1], // fused to the skull below it
  wolf_l: [1, 0.5], // grows out of the left shoulder, swings outward
  beast_r: [0, 0.5], // mirror of wolf_l
  mace: [0.75, 0], // the shoulder, not the middle of the arm
  claws: [0.25, 0],
  torso: [0.5, 1],
  legs: [0.5, 1],
};

const BOSS_GROUP_RE = /<g id="part-([a-z0-9_]+)">([\s\S]*?)<\/g>/g;

export type BossPart = {
  /** Slicer part name, e.g. `crown`. Also the CSS hook: `.hr-p-crown`. */
  readonly name: string;
  /** Index into `BossAccount.parts`, or `null` for a rig-only group (ground, torso, legs, core). */
  readonly index: number | null;
  /** The group's `<path>` children, verbatim from the slicer. */
  readonly inner: string;
  /** Pivot in sprite units. Absolute on purpose — see the `transform-box` note below. */
  readonly originX: number;
  readonly originY: number;
};

const bossBox = viewBox(bossSlicedSvg, 'parts/boss.svg');

/** Sprite canvas, in arena units (1 sprite pixel = 1 arena unit). */
export const BOSS_SPRITE_W = bossBox.w;
export const BOSS_SPRITE_H = bossBox.h;

/**
 * Where the sprite's top-left corner goes, relative to `Boss.x` / `Boss.y`.
 *
 * `PART_HITBOXES` in `programs/heartrot/src/handlers/shoot.rs` spans x [-96, 96] and
 * y [-112, 128] around the boss position, so the volume the program raycasts is centred on
 * (0, 8). Centring the 230x270 canvas there is what puts the drawn boss where the shots
 * land.
 *
 * ponytail: the program's table is a hand-written idealisation — symmetric, with the mace
 * on the right — while the art has the mace on the left and an off-centre crown. Vertically
 * they agree to within two units; horizontally individual parts are up to ~40 units apart,
 * so a shot at the drawn crown can miss and a shot at empty air can hit. The upgrade path is
 * already built: `hitboxes.json` (imported above) carries exact integer boxes from the same
 * slice that produced these groups, so `PART_HITBOXES` becomes generated from it and the
 * drift closes. Not fixable from the renderer — that table is the contract until it moves.
 */
export const BOSS_ANCHOR_X = 0 - Math.round(BOSS_SPRITE_W / 2);
export const BOSS_ANCHOR_Y = 8 - Math.round(BOSS_SPRITE_H / 2);

/** The vent, for the glow that reads "the core is damageable now". */
export const BOSS_CORE_BOX: Hitbox = HITBOXES['core'] ?? { index: null, x: 0, y: 0, w: 0, h: 0 };

/**
 * Every `<g>` in the sliced file, in document order — which is the slicer's paint order,
 * back to front. Preserving it is what keeps the torso behind the arms that swing across it.
 */
export const BOSS_PARTS: readonly BossPart[] = Array.from(
  bossSlicedSvg.matchAll(BOSS_GROUP_RE),
  ([, name, inner]): BossPart => {
    if (name === undefined || inner === undefined) throw new Error('parts/boss.svg: malformed <g>');
    const box = HITBOXES[name];
    if (!box) throw new Error(`parts/boss.svg: group "${name}" has no entry in hitboxes.json`);
    const [fx, fy] = PIVOTS[name] ?? [0.5, 0.5];
    return {
      name,
      index: box.index,
      inner,
      // Absolute sprite units, and `transform-box` is deliberately left at its `view-box`
      // default (decision R17). `fill-box` resolves against a bounding box that SVG 2
      // defines as the union over descendants *with their transforms applied*, so the
      // moment an animated wrapper goes round these parts the pivot starts drifting every
      // frame — and it presents as "the crown rotates wrong when the mace swings", which
      // is a miserable thing to chase.
      originX: box.x + box.w * fx,
      originY: box.y + box.h * fy,
    };
  },
);

// ---------------------------------------------------------------------------
// Player skins
// ---------------------------------------------------------------------------

export type SkinPath = { readonly fill: string; readonly d: string };

export type Skin = {
  readonly w: number;
  /** Half-width, rounded, so the figure straddles its arena position on whole pixels. */
  readonly anchorX: number;
  readonly paths: readonly SkinPath[];
};

/**
 * Cut `knights.svg` into one group per figure.
 *
 * The sheet holds the three figures in a single row plus an unrelated strip along the
 * bottom, with fully empty columns between the figures and fully empty rows above the
 * strip. So: take the tallest contiguous band of painted rows as the character row, split
 * it at its empty columns, and file each rect by which column run it falls in. No rect can
 * straddle a boundary because a boundary is by definition a column nothing paints, which is
 * what makes this exact rather than approximate — the pixels are re-emitted unchanged, not
 * re-merged.
 */
function sliceSheet(svg: string, name: string): { skins: Skin[]; height: number } {
  const { w, h } = viewBox(svg, name);
  const rects = parseRects(svg, name);

  const rowUsed = new Array<boolean>(h).fill(false);
  for (const r of rects) {
    for (let y = Math.max(0, r.y); y < Math.min(h, r.y + r.h); y++) rowUsed[y] = true;
  }
  const band = spans(rowUsed).reduce<readonly [number, number] | undefined>(
    (best, s) => (best === undefined || s[1] - s[0] > best[1] - best[0] ? s : best),
    undefined,
  );
  if (!band) throw new Error(`${name}: sheet is blank`);
  const [top, bottom] = band;

  const colUsed = new Array<boolean>(w).fill(false);
  for (const r of rects) {
    if (r.y + r.h <= top || r.y > bottom) continue;
    for (let x = Math.max(0, r.x); x < Math.min(w, r.x + r.w); x++) colUsed[x] = true;
  }
  // A run narrower than a few pixels is a stray, not a character.
  const figures = spans(colUsed).filter(([lo, hi]) => hi - lo >= 8);
  if (figures.length === 0) throw new Error(`${name}: found no figures in the character band`);

  const height = bottom - top + 1;
  const skins = figures.map(([lo, hi]): Skin => {
    const byFill = new Map<string, string[]>();
    for (const r of rects) {
      if (r.y + r.h <= top || r.y > bottom) continue;
      if (r.x < lo || r.x + r.w - 1 > hi) continue;
      const d = `M${r.x - lo} ${r.y - top}h${r.w}v${r.h}h-${r.w}z`;
      const run = byFill.get(r.fill);
      if (run) run.push(d);
      else byFill.set(r.fill, [d]);
    }
    const figureW = hi - lo + 1;
    return {
      w: figureW,
      anchorX: Math.round(figureW / 2),
      paths: [...byFill].map(([fill, ds]) => ({ fill, d: ds.join('') })),
    };
  });

  return { skins, height };
}

const sheet = sliceSheet(knightsSheetSvg, 'knights.svg');

/** One entry per `PlayerSlot.skinId`, drawn once into `<defs>` and instanced with `<use>`. */
export const SKINS: readonly Skin[] = sheet.skins;

/** Shared across skins so twenty knights stand on one baseline. */
export const SKIN_HEIGHT = sheet.height;

/** `<defs>` id for skin *i*, referenced by every player node. */
export function skinHref(skinId: number): string {
  return `#hr-skin-${((skinId % SKINS.length) + SKINS.length) % SKINS.length}`;
}

export function skinOf(skinId: number): Skin {
  const s = SKINS[((skinId % SKINS.length) + SKINS.length) % SKINS.length];
  if (!s) throw new Error('unreachable: SKINS is non-empty');
  return s;
}

/**
 * `PlayerSlot.facing` is eight-way clockwise from north (`FACING_STEP` in `shoot.rs`).
 * The art is drawn facing the camera, so only the three westward headings mirror; N and S
 * keep whatever the sprite already is rather than flickering on every turn through vertical.
 */
export function facesWest(facing: number): boolean {
  return facing === 5 || facing === 6 || facing === 7;
}

// ---------------------------------------------------------------------------
// Boot assertions
// ---------------------------------------------------------------------------

// These are the check for everything above. All of it derives from build-time assets, so a
// failure is a broken asset or a changed grammar, and either one should stop the app here
// rather than three layers down as a boss with no crown or twenty invisible knights.
{
  const chainIndices = BOSS_PARTS.map((p) => p.index).filter((i): i is number => i !== null).sort((a, b) => a - b);
  const expected = hitboxJson.part_index.length;
  if (chainIndices.length !== expected || chainIndices.some((v, i) => v !== i)) {
    throw new Error(
      `parts/boss.svg: chain part indices are ${JSON.stringify(chainIndices)}, expected 0..${expected - 1}`,
    );
  }
  if (BOSS_SPRITE_W !== hitboxJson.sprite.w || BOSS_SPRITE_H !== hitboxJson.sprite.h) {
    throw new Error('parts/boss.svg: viewBox disagrees with hitboxes.json sprite size');
  }
  if (SKINS.length === 0 || SKIN_HEIGHT <= 0) throw new Error('knights.svg: no usable skins');
}
