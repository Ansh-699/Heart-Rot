/**
 * Room A — the waiting hall: the painting `assets/rooms/lobby.png`, whole.
 *
 * One `<g>` mounted inside `#camera`, mutually exclusive with room B
 * (`{shown === 'lobby' ? WAITING : BOSS_ARENA}`), framed on `VIEW_LOBBY`. The void, the
 * painting, its light (`RoomLight.tsx`), the three portcullises cut out of the painting so
 * the passage can lift the one walked through, and two kinds of marker placed from the
 * generated tables: a mark over each gate and the controls plaque. Nothing here is derived
 * from chain state and no world coordinate is typed: every number is `rooms.gen.ts`, which
 * `tools/gen_rooms.py` derives from the painting's own size and writes in the same run as
 * the grid the chain walks. That is what makes the painted floor and the walkable bitboard
 * ONE fact — the generator proves its half (walkable ⇒ painted) when it writes the grid,
 * and the boot check at the bottom is the consumer's half, re-derived here against the
 * tables the chain actually ships.
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
 * `.gate-portcullis[data-tier]` is BORROWED by `Passage.tsx`, which plays one WAAPI
 * `transform` one-shot on the one under the seat's last lobby position (its WHICH GATE
 * note; `arena.difficulty` is only the fallback) and asserts there are exactly three.
 * Nothing here may animate them. The gate marks and the plaque are the only other nodes
 * over the paint; the signs, the towers, the stalls and the braziers stay paint.
 */
import type { CSSProperties, ReactElement } from 'react';

import { LOBBY_TOP, MAP_TILE, MAP_TILES, isWallTile } from '@heartrot/client';

import { roomGlow, roomMotes } from './RoomLight';
import {
  GATE_IMGS,
  LOBBY_FLOOR,
  LOBBY_GATE_COLORS,
  LOBBY_GATES,
  LOBBY_IMG,
  LOBBY_LIGHTS,
  VOID,
  type ImgRect,
  type LobbyGate,
} from './rooms.gen';
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
    {roomGlow('lobby-glow', LOBBY_LIGHTS)}
    {roomMotes(VIEW_LOBBY, LOBBY_LIGHTS)}
    {/* The portcullises, cut out of the painting (which has each throat painted dark under
        them), so the passage's LIFT shows the doorway walked through open. Three nodes, by
        contract, told apart by tier. */}
    {GATE_IMGS.map((img, tier) => (
      <g key={tier} className="gate-portcullis" data-tier={tier}>
        {painting(img)}
      </g>
    ))}
    {LOBBY_GATES.map((gate) => (
      <GateMark key={gate.tier} gate={gate} color={LOBBY_GATE_COLORS[gate.tier]} />
    ))}
  </g>
);


/**
 * The "go here" marker over a gate — one per tier, in that gate's own light.
 *
 * It replaces three paragraphs. The lobby used to explain itself in text — a muster card,
 * a "N tiles to the gate" prompt and a control legend — which between them covered a third
 * of the room the art exists to show. A quest marker says the same thing in one glyph and
 * says it *in the world*, where the player is already looking; three of them in three
 * colours, under three painted signs, say which doorway is which without a word.
 *
 * Centred on the gate block from the generated map, so it cannot drift from the doorway it
 * points at; `gate.y` is the top of the walkable gate tiles, and the mark floats a little
 * above that, clear of the portcullis art. The halo's colour is `--tier`, read off that
 * doorway's bars by the generator (`LOBBY_GATE_COLORS`), never typed.
 *
 * Motion is a slow bob and pulse, CSS only, on a node nothing else writes — the scene layer
 * mounts once and never re-renders, so this must not need React to animate. Under reduced
 * motion it holds still and stays perfectly legible.
 */
function GateMark({ gate, color }: { gate: LobbyGate; color: string | undefined }) {
  const cx = gate.x + gate.w / 2;
  const y = gate.y - 26;
  return (
    <g
      className="gate-mark"
      data-tier={gate.tier}
      aria-hidden="true"
      style={{ '--tier': color } as CSSProperties}
      transform={`translate(${cx} ${y})`}
    >
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
// permanent lag (this project's signature misdiagnosis), a portcullis that does not
// cover its doorway lifts to reveal a strip of painted bars, and a mark over the wrong
// block sends the raid to the wrong tier. Dev-only, run by
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
  // when it lies wholly inside the painted floor. The floor is a union of rects and a tile
  // may straddle two of them, so "wholly inside" is sampled, not tested against one rect.
  // A wall inside the paint is a floor the chain refuses to walk; a walkable tile outside
  // it is a knight standing on masonry.
  const onFloor = (x: number, y: number): boolean =>
    LOBBY_FLOOR.some((f) => x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h);
  const SAMPLES = 4;
  for (let ty = LOBBY_TOP / MAP_TILE; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      let painted = true;
      for (let j = 0; j < SAMPLES && painted; j++) {
        for (let i = 0; i < SAMPLES; i++) {
          const x = tx * MAP_TILE + (i * MAP_TILE) / (SAMPLES - 1);
          const y = ty * MAP_TILE + (j * MAP_TILE) / (SAMPLES - 1);
          if (!onFloor(x, y)) {
            painted = false;
            break;
          }
        }
      }
      ok(
        painted === !isWallTile(tx, ty),
        `tile (${tx}, ${ty}) is ${painted ? 'painted floor but a wall' : 'walkable but off the painted floor'} ` +
          '— re-run tools/gen_rooms.py then tools/gen_map.py',
      );
    }
  }

  // The gates: tiers 0.. left to right, one portcullis and one colour each, and each block
  // IS a block of walkable tiles with wall either side of it — the same `G` runs
  // `gen_map.py` numbers, re-read here from the wall table the chain ships.
  ok(LOBBY_GATES.length === GATE_IMGS.length, `${LOBBY_GATES.length} gates but ${GATE_IMGS.length} portcullises`);
  ok(LOBBY_GATES.length === LOBBY_GATE_COLORS.length, `${LOBBY_GATES.length} gates but ${LOBBY_GATE_COLORS.length} colours`);
  LOBBY_GATES.forEach((g, i) => {
    ok(g.tier === i, `gate ${i} carries tier ${g.tier}`);
    const before = LOBBY_GATES[i - 1];
    ok(before === undefined || before.x + before.w < g.x, `gate ${i} is not right of gate ${i - 1}`);
    const tx0 = g.x / MAP_TILE;
    const tx1 = (g.x + g.w) / MAP_TILE - 1;
    for (let ty = g.y / MAP_TILE; ty < (g.y + g.h) / MAP_TILE; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) ok(!isWallTile(tx, ty), `gate ${i} tile (${tx}, ${ty}) is wall`);
      ok(isWallTile(tx0 - 1, ty) && isWallTile(tx1 + 1, ty), `gate ${i} is not walled off on row ${ty}`);
    }
    // The portcullis spans the block's rows and reaches its outer tiles' centres, so its
    // lift clears the whole seam the seat stands in.
    const img = GATE_IMGS[i];
    ok(
      img !== undefined &&
        img.y <= g.y &&
        img.y + img.h >= g.y + g.h &&
        img.x <= g.x + MAP_TILE / 2 &&
        img.x + img.w >= g.x + g.w - MAP_TILE / 2,
      `portcullis ${i} does not cover gate block ${g.x}..${g.x + g.w} x ${g.y}..${g.y + g.h}`,
    );
  });

  // Every light is on the painting: a glow in the void is a torch nobody drew.
  for (const l of LOBBY_LIGHTS) {
    ok(
      l.x >= LOBBY_IMG.x && l.x <= LOBBY_IMG.x + LOBBY_IMG.w && l.y >= LOBBY_IMG.y && l.y <= LOBBY_IMG.y + LOBBY_IMG.h,
      `light at (${l.x}, ${l.y}) is off the painting`,
    );
  }
}
