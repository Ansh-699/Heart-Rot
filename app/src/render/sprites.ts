/**
 * Build-time sprite data for the renderer.
 *
 * Everything here is derived at module load from the art in `assets/sprites/` and from the
 * generated tables in `@heartrot/client`, and is then immutable. Nothing in this file
 * touches React or the DOM, so the parsing below is the one place a wrong number can enter
 * the render tree, and the assertions at the bottom fail the app loudly at import rather
 * than drawing a boss with a missing arm.
 *
 * Three source shapes, three different jobs:
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
 *
 *   `@heartrot/client` carries the generated tables: the wall bitboard the chain collides
 *                     against, and the boss hitboxes and anchor it raycasts against. The
 *                     dungeon is *compiled* from that grid here rather than drawn as a
 *                     picture of it, and the boss anchor is imported rather than
 *                     recomputed, so there is no second copy of either fact to drift.
 */
import {
  BOSS_ANCHOR_X,
  BOSS_ANCHOR_Y,
  BOSS_SPRITE_H,
  BOSS_SPRITE_W,
  MAP_GRID,
  MAP_TILE,
  MAP_TILES,
  PART_HITBOXES,
} from '@heartrot/client';

import bossSlicedSvg from '../../../assets/sprites/parts/boss.svg?raw';
import knightsSheetSvg from '../../../assets/sprites/knights.svg?raw';
import hitboxJson from '../../../assets/sprites/hitboxes.json';

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/**
 * The scene's viewBox is arena space, 1:1 — the same `MAP_TILES * MAP_TILE` the chain
 * clamps every position into, taken from the generated map rather than restated here.
 *
 * Drawing in arena units directly means `PlayerSlot.x`, `Boss.x` and `Bullet.x` land in
 * the SVG unmodified: no scale factor, no rounding, no second unit anyone has to convert
 * between. It is also what lets the bullet extrapolation in `Arena.tsx` be exact — the
 * client steps the same integers by the same amount the crank does.
 */
export const ARENA_UNITS = MAP_TILES * MAP_TILE;

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
// The dungeon
// ---------------------------------------------------------------------------

/**
 * The map layer, compiled from `MAP_GRID` — the same generated table the chain raycasts
 * and `predict.ts` collides against. Drawn from the bitboard rather than from a picture of
 * a room, because a picture can disagree with the walls and this cannot.
 *
 * 4,096 tiles would be 4,096 nodes that never change (design spec §6). Merging each row's
 * runs into subpaths of one `d` makes each layer a single node instead, and since the
 * strings are module constants the whole dungeon is built once per page load.
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

/** Every solid tile: the border, the four corner rocks, the chamber walls, the pillars. */
export const MAP_WALL_PATH = tilePath((tx, ty) => tileAt(tx, ty) === '#');

/**
 * The lit top face of every wall that has floor above it. Purely a legibility cue: without
 * it a 2x2 pillar and a corridor wall are the same flat block and the halls read as noise.
 */
export const MAP_RIM_PATH = tilePath((tx, ty) => tileAt(tx, ty) === '#' && tileAt(tx, ty - 1) !== '#', 3);

/** The four edge entrances — walkable, so they are a floor tint and not a wall. */
export const MAP_ENTRANCE_PATH = tilePath((tx, ty) => tileAt(tx, ty) === 'E');

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
  if (bossBox.w !== BOSS_SPRITE_W || bossBox.h !== BOSS_SPRITE_H) {
    throw new Error('parts/boss.svg: viewBox disagrees with the generated sprite size');
  }

  // F1, restated as a runnable check: the group this file draws and the box the program
  // raycasts are the same rectangle, translated by the generated anchor and nothing else.
  // Both sides come from `hitboxes.json`, so this can only fire if the art file and the
  // generated modules were produced by different runs of the slicer.
  hitboxJson.part_index.forEach((name, i) => {
    const art = HITBOXES[name];
    const hit = PART_HITBOXES[i];
    if (!art || !hit) throw new Error(`hitboxes.json: part ${i} "${name}" is missing a box`);
    if (
      art.x + BOSS_ANCHOR_X !== hit.x ||
      art.y + BOSS_ANCHOR_Y !== hit.y ||
      art.w !== hit.w ||
      art.h !== hit.h
    ) {
      throw new Error(
        `part "${name}": drawn at [${art.x + BOSS_ANCHOR_X},${art.y + BOSS_ANCHOR_Y},${art.w},${art.h}] ` +
          `but shot at [${hit.x},${hit.y},${hit.w},${hit.h}] — re-run tools/gen_hitboxes.py`,
      );
    }
  });

  if (MAP_WALL_PATH.length === 0) throw new Error('assets/map: the generated dungeon has no walls');
  if (SKINS.length === 0 || SKIN_HEIGHT <= 0) throw new Error('knights.svg: no usable skins');
}
