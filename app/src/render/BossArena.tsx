/**
 * Room B — the fight arena: the painting `assets/rooms/arena.png`, whole, at one unit per px.
 *
 * ONE module-scope `ReactElement` with no props, mounted as the first child of `#camera`
 * in room A's place whenever the room on screen is the arena, framed on `VIEW_ARENA`.
 * Two nodes: the void and the painting. The pit floor, the dais, the stairs, the braziers,
 * the backdrop and the demon are all in the paint; the only things drawn over it are the
 * boss rig (`Boss.tsx`), the seats, the ordnance and the light beats.
 *
 * The painting's placement is `ARENA_IMG` in `rooms.gen.ts`: `tools/gen_rooms.py` centres
 * it in x and rests its bottom edge on the pit rim (`PIT_BOT + 1`), at the ONE scale the
 * boss crop and its hitboxes are cut at. That is the invariant this file exists to hold,
 * and the boot check at the bottom is its proof: `Boss.tsx` places the rig's atlas cells at
 * `BOSS_SPAWN + BOSS_ANCHOR`, and `gen_boss.py` cut those cells out of this same painting
 * at `BOSS_CROP` — so on a full shell the rig is pixel-identical to the demon under it and
 * invisible as a rig, which is what lets a limb flinch, break off and char while the room
 * stays a flat image. Both terms of that equation are generated; nothing here restates
 * either.
 *
 * The performance contract `Scene.tsx` earned, unchanged: compared by identity, never
 * diffed again; nothing derived from chain state; `will-change: transform`;
 * `pointer-events: none`. **Do not add a prop to this file** — 11.2 ms/frame and 3/3
 * renderer crashes at 300 frames, measured.
 *
 * `imageRendering: 'auto'`, inline: the painting is not pixel art. See `WaitingRoom.tsx`.
 */
import type { ReactElement } from 'react';

import {
  BOSS_ANCHOR_X,
  BOSS_ANCHOR_Y,
  BOSS_SPAWN,
  MAP_TILE,
  MAP_TILES,
  PIT_BOT,
  PIT_TOP,
  isWallTile,
} from '@heartrot/client';

import { ARENA_IMG, ARENA_PLATFORM, BOSS_CROP, VOID } from './rooms.gen';
import { ARENA_UNITS } from './sprites';
import { VIEW_ARENA } from './viewport';

/**
 * Render as `{BOSS_ARENA}` as the FIRST child of `#camera` while the room on screen is
 * the arena. Do not wrap it, do not give it a key that changes, do not pass it anything.
 */
export const BOSS_ARENA: ReactElement = (
  <g
    id="boss-arena"
    aria-hidden
    // The promotion hint. No transform is ever written to this node — `#camera` above it
    // owns the passage's translate, and two writers on one node's transform is this
    // project's signature bug.
    style={{ willChange: 'transform', pointerEvents: 'none' }}
  >
    {/* Void under everything, so the fitted viewBox's bleed never shows the host's own
        background. `vp-void` is load-bearing and `useViewport` refuses to mount a room
        without it: it RESIZES every node with that class to the live box inflated by
        `VIEW_BLEED` on each resize. The attributes below are only the pre-layout frame. */}
    <rect
      className="vp-void"
      x={-ARENA_UNITS}
      y={-ARENA_UNITS}
      width={3 * ARENA_UNITS}
      height={3 * ARENA_UNITS}
      fill={VOID.arena}
    />
    <image
      href={ARENA_IMG.src}
      x={ARENA_IMG.x}
      y={ARENA_IMG.y}
      width={ARENA_IMG.w}
      height={ARENA_IMG.h}
      // One unit per px by construction; `none` makes the browser honour the rect to the
      // unit rather than re-fit inside it, which is what "pixel-exact under the rig" needs.
      preserveAspectRatio="none"
      style={{ imageRendering: 'auto' }}
    />
  </g>
);

// ---------------------------------------------------------------------------
// Boot check
//
// Every failure here is silent and shows as something else: a painting a row off the rim
// is a raider standing on the void, a pit tile off the dais is permanent lag, and a rig a
// unit off its own paint is a ghost outline around every limb. Dev-only, run by
// `scripts/spike/scenemount/devcheck.mjs`; the generators' `--check` guard the other side.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`BossArena boot check: ${what}`);
  };

  // The painting rests on the rim and spans the frame: the stairs run off the bottom edge
  // exactly where the paint ends, and no stage aspect can show void beside it.
  ok(ARENA_IMG.y + ARENA_IMG.h === PIT_BOT + 1, `ARENA_IMG ends at ${ARENA_IMG.y + ARENA_IMG.h}, the rim is ${PIT_BOT + 1}`);
  ok(
    ARENA_IMG.x <= VIEW_ARENA.x && ARENA_IMG.x + ARENA_IMG.w >= VIEW_ARENA.x + VIEW_ARENA.w,
    `ARENA_IMG spans x ${ARENA_IMG.x}..${ARENA_IMG.x + ARENA_IMG.w}, narrower than the frame`,
  );

  // Walkable == painted over the pit rows, both directions, against the platform ellipse
  // the grid was cut from. The generator's rule is a coverage threshold plus a kerb fill,
  // so the consumer's check is the pair of bounds that hold for ANY threshold: a walkable
  // tile touches the platform, and a tile wholly inside the platform is walkable.
  const { cx, cy, rx, ry } = ARENA_PLATFORM;
  const norm = (x: number, y: number): number => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  for (let ty = PIT_TOP / MAP_TILE; ty <= PIT_BOT / MAP_TILE; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      const x0 = tx * MAP_TILE;
      const y0 = ty * MAP_TILE;
      const x1 = x0 + MAP_TILE;
      const y1 = y0 + MAP_TILE;
      // The tile's nearest point to the centre in the ellipse's own metric is the per-axis
      // clamp, so the tile meets the ellipse exactly when that point is inside it.
      const touches = norm(clamp(cx, x0, x1), clamp(cy, y0, y1)) <= 1;
      const within = norm(x0, y0) <= 1 && norm(x1, y0) <= 1 && norm(x0, y1) <= 1 && norm(x1, y1) <= 1;
      const walkable = !isWallTile(tx, ty);
      ok(!walkable || touches, `pit tile (${tx}, ${ty}) is walkable but off the painted platform`);
      ok(!within || walkable, `pit tile (${tx}, ${ty}) is painted platform but a wall`);
    }
  }

  // THE ONE THAT MATTERS. `Boss.tsx` draws the atlas at `BOSS_SPAWN + BOSS_ANCHOR`;
  // `gen_boss.py` cut the atlas out of the painting at `BOSS_CROP`. Equal, or the rig sits
  // beside its own paint and every limb wears a ghost of itself.
  const rigX = BOSS_SPAWN[0] + BOSS_ANCHOR_X;
  const rigY = BOSS_SPAWN[1] + BOSS_ANCHOR_Y;
  ok(
    rigX === BOSS_CROP.x && rigY === BOSS_CROP.y,
    `the rig lands at (${rigX}, ${rigY}) but the crop was cut at (${BOSS_CROP.x}, ${BOSS_CROP.y}) — ` +
      'arena.json boss_crop_px and hitboxes.json crop_px disagree; re-run tools/gen_rooms.py, gen_boss.py, gen_hitboxes.py',
  );
  // And the crop was cut from inside the painting (its bottom may hang below the rim as
  // transparent padding, so only the top and sides are bounded).
  ok(
    BOSS_CROP.x >= ARENA_IMG.x && BOSS_CROP.x + BOSS_CROP.w <= ARENA_IMG.x + ARENA_IMG.w && BOSS_CROP.y >= ARENA_IMG.y,
    'BOSS_CROP reaches outside the painting it was cut from',
  );
}
