/**
 * Room A — the waiting hall: the painting `assets/rooms/lobby.png`, whole.
 *
 * One `<g>` mounted inside `#camera`, mutually exclusive with room B
 * (`{shown === 'lobby' ? WAITING : BOSS_ARENA}`), framed on `VIEW_LOBBY`. Three nodes: the
 * void, the painting, and the portcullis cut out of the painting so the passage can lift
 * it. Nothing here is derived from chain state and no world coordinate is typed: every
 * number is `rooms.gen.ts`, which `tools/gen_rooms.py` derives from the painting's own
 * size and writes in the same run as the grid the chain walks. That is what makes the
 * painted floor and the walkable bitboard ONE fact — the generator proves its half
 * (walkable ⇒ painted) when it writes the grid, and the boot check at the bottom is the
 * consumer's half, re-derived here against the tables the chain actually ships.
 *
 * The performance contract `Scene.tsx` earned, unchanged: a module-scope `ReactElement`
 * compared by identity and never diffed again; `will-change: transform` so it holds its own
 * compositor raster instead of dirtying the movers' paint chunk (measured 30–85x);
 * `pointer-events: none` so it can never become a hit-test target. **Do not add a prop to
 * this file** — 11.2 ms/frame and 3/3 renderer crashes at 300 frames, measured.
 *
 * `imageRendering: 'auto'`, inline, on every painting: the references are not pixel art
 * (43k unique colours), and nearest-neighbour at the lobby's fractional fit gives ragged
 * diagonals. The knight and ordnance atlases keep `pixelated` through their own rule; the
 * root `svg` carries no `image-rendering` at all (it would re-break the boss's filters).
 *
 * `#gate-portcullis` is BORROWED by `Passage.tsx`, which plays one WAAPI `transform`
 * one-shot on it and asserts there is exactly one. Nothing here may animate it, and nothing
 * else in this room is a node at all — the sign, the tower and the braziers are paint.
 */
import type { ReactElement } from 'react';

import {
  GATE_MAX_X,
  GATE_MAX_Y,
  GATE_MIN_X,
  GATE_MIN_Y,
  LOBBY_TOP,
  MAP_TILE,
  MAP_TILES,
  isWallTile,
} from '@heartrot/client';

import { GATE_IMG, LOBBY_FLOOR, LOBBY_IMG, VOID, type ImgRect } from './rooms.gen';
import { ARENA_UNITS } from './sprites';
import { VIEW_LOBBY } from './viewport';

/** A painting placed at its generated world rect. */
const painting = (img: ImgRect): ReactElement => (
  <image
    href={img.src}
    x={img.x}
    y={img.y}
    width={img.w}
    height={img.h}
    // The rect IS the fit `gen_rooms.py` computed from the source's own aspect; `none`
    // makes the browser honour it to the unit rather than re-fit inside it.
    preserveAspectRatio="none"
    style={{ imageRendering: 'auto' }}
  />
);

/**
 * Mount as `{WAITING}`, in room B's place, as the first child of `#camera`.
 * Do not wrap it, do not give it a changing key, do not pass it anything.
 */
export const WAITING: ReactElement = (
  <g
    id="waiting-room"
    aria-hidden
    // Promotion hint. No transform is ever written here — `#camera` above owns the one
    // the passage animates, and two writers on one node's transform is this project's
    // signature bug.
    style={{ willChange: 'transform', pointerEvents: 'none' }}
  >
    {/* The void, so the frame can never show raw page behind the room. `vp-void` is
        load-bearing and `useViewport` refuses to mount a room without it (viewport.ts):
        it resizes every node carrying the class to the LIVE viewBox inflated by
        `VIEW_BLEED` on each resize. The attributes below are only the pre-layout frame. */}
    <rect
      className="vp-void"
      x={-ARENA_UNITS}
      y={-ARENA_UNITS}
      width={3 * ARENA_UNITS}
      height={3 * ARENA_UNITS}
      fill={VOID.lobby}
    />
    {painting(LOBBY_IMG)}
    {/* The portcullis, cut out of the painting (which has the throat painted dark under
        it), so the passage's LIFT shows the doorway open. One node, by contract. */}
    <g id="gate-portcullis">{painting(GATE_IMG)}</g>
    <GateMark />
  </g>
);

/**
 * The "go here" marker over the gate.
 *
 * It replaces three paragraphs. The lobby used to explain itself in text — a muster card,
 * a "N tiles to the gate" prompt and a control legend — which between them covered a third
 * of the room the art exists to show. A quest marker says the same thing in one glyph and
 * says it *in the world*, where the player is already looking.
 *
 * Centred on the gate block from the generated map, so it cannot drift from the doorway it
 * points at; `GATE_MIN_Y` is the top of the walkable gate tiles, and the mark floats a
 * little above that, clear of the portcullis art.
 *
 * Motion is a slow bob and pulse, CSS only, on a node nothing else writes — the scene layer
 * mounts once and never re-renders, so this must not need React to animate. Under reduced
 * motion it holds still and stays perfectly legible.
 */
function GateMark() {
  const cx = (GATE_MIN_X + GATE_MAX_X + 1) / 2;
  const y = GATE_MIN_Y - 26;
  return (
    <g className="gate-mark" aria-hidden="true" transform={`translate(${cx} ${y})`}>
      {/* Halo first, so the glyph reads against both the lit arch and the dark throat. */}
      <circle r={13} className="gate-mark-halo" />
      {/* The bar and the dot of an exclamation, drawn rather than typed: a <text> glyph
          would depend on a webfont that may not have loaded when the scene mounts once. */}
      <rect x={-2.5} y={-9} width={5} height={11} rx={1.6} className="gate-mark-ink" />
      <circle cx={0} cy={6} r={2.6} className="gate-mark-ink" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Boot check
//
// Every failure below is silent on screen: a painting a tile off its grid reads as
// permanent lag (this project's signature misdiagnosis), and a portcullis that does not
// cover the doorway lifts to reveal a strip of painted bars. Dev-only, run by
// `scripts/spike/scenemount/devcheck.mjs`; the generator's `--check` guards the other side.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`WaitingRoom boot check: ${what}`);
  };

  // The painting is fitted to the room's height, so its top and bottom edges are the
  // frame's — `gen_rooms.py` reads `LOBBY_HEAD`/`LOBBY_FOOT` out of viewport.ts to make
  // that true, and this is where a drift between the two files is caught.
  ok(
    Math.abs(LOBBY_IMG.y - VIEW_LOBBY.y) <= 1 && Math.abs(LOBBY_IMG.h - VIEW_LOBBY.h) <= 1,
    `LOBBY_IMG spans y ${LOBBY_IMG.y}..${LOBBY_IMG.y + LOBBY_IMG.h} but VIEW_LOBBY spans ` +
      `${VIEW_LOBBY.y}..${VIEW_LOBBY.y + VIEW_LOBBY.h}`,
  );

  // Walkable == painted, both directions, over every lobby tile: a tile is walkable exactly
  // when it lies wholly inside the painted floor rect. A wall inside the paint is a floor
  // the chain refuses to walk; a walkable tile outside it is a knight standing on masonry.
  const { x: fx, y: fy, w: fw, h: fh } = LOBBY_FLOOR;
  for (let ty = LOBBY_TOP / MAP_TILE; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      const x0 = tx * MAP_TILE;
      const y0 = ty * MAP_TILE;
      const painted = x0 >= fx && x0 + MAP_TILE <= fx + fw && y0 >= fy && y0 + MAP_TILE <= fy + fh;
      ok(
        painted === !isWallTile(tx, ty),
        `tile (${tx}, ${ty}) is ${painted ? 'painted floor but a wall' : 'walkable but off the painted floor'} ` +
          '— re-run tools/gen_rooms.py then tools/gen_map.py',
      );
    }
  }

  // The portcullis covers the whole gate block, so its lift clears the whole doorway.
  ok(
    GATE_IMG.x <= GATE_MIN_X &&
      GATE_IMG.x + GATE_IMG.w >= GATE_MAX_X + 1 &&
      GATE_IMG.y <= GATE_MIN_Y &&
      GATE_IMG.y + GATE_IMG.h >= GATE_MAX_Y + 1,
    `GATE_IMG does not cover the gate block ${GATE_MIN_X}..${GATE_MAX_X} x ${GATE_MIN_Y}..${GATE_MAX_Y}`,
  );
}
