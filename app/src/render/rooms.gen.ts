// @generated from assets/map/arena.json `rooms` and assets/rooms/*.png by `python3 tools/gen_rooms.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the painting on screen
// and the grid the chain walks stop being the same room. Edit `rooms` in arena.json, re-run
// the command above, then `python3 tools/gen_map.py`.
//
// `?no-inline` keeps every painting a hashed file under /assets/ (served immutable by
// app/public/_headers) rather than a base64 string in the bundle, whatever its size.
import arenaPng from './rooms/arena.png?no-inline';
import gatePng from './rooms/gate.png?no-inline';
import lobbyPng from './rooms/lobby.png?no-inline';

/** A painting placed in the world: `<image href={src} x={x} y={y} width={w} height={h}>`. */
export interface ImgRect {
  readonly src: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A world-space rectangle in arena units. */
export interface WorldRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A world-space axis-aligned ellipse in arena units. */
export interface WorldEllipse {
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}

/**
 * The waiting hall (1122x785 px), fitted to the room's height at 0.8357 units per
 * px, so `y` is `VIEW_LOBBY.y` and `h` is `ROOM_H`, centred in x with 43.1898 units of void
 * each side. Mount it with `imageRendering: 'auto'`: the painting is not pixel art.
 */
export const LOBBY_IMG: ImgRect = { src: lobbyPng, x: 43.1898, y: 432, w: 937.6204, h: 656 };

/**
 * The fight arena (1122x612 px) at one unit per px -- the scale the boss crop and its
 * hitboxes are cut at -- with its bottom edge on the pit rim (`PIT_BOT + 1`) and centred
 * in x, so it overhangs the frame by 49 units a side and leaves 44 units of void
 * above its top edge in `VIEW_ARENA`.
 */
export const ARENA_IMG: ImgRect = { src: arenaPng, x: -49, y: -4, w: 1122, h: 612 };

/**
 * The portcullis, cut out of the lobby painting (which has the hole painted throat-dark
 * underneath), for `WaitingRoom` to mount as the one `#gate-portcullis` node the passage
 * lifts. Covers the whole `G` block.
 */
export const GATE_IMG: ImgRect = { src: gatePng, x: 446.8178, y: 555.679, w: 146.242, h: 85.2382 };

/** What the `.vp-void` rect paints per room: the median of that painting's outermost ring. */
export const VOID: Readonly<Record<'lobby' | 'arena', string>> = {
  lobby: '#080814',
  arena: '#070915',
};

/** The painted lobby floor. Every walkable lobby tile lies wholly inside it (generator-proven). */
export const LOBBY_FLOOR: WorldRect = { x: 105.865, y: 639.2459, w: 811.4344, h: 369.3656 };

/** The painted platform the pit is cut from: the walkable pit is this ellipse's lower half. */
export const ARENA_PLATFORM: WorldEllipse = { cx: 512, cy: 396, rx: 461, ry: 212 };

/**
 * The boss crop, in world units: `gen_boss.py` cuts exactly this out of the arena painting,
 * so `BOSS_SPAWN + BOSS_ANCHOR === { x, y }` here -- the rig sits on its own paint pixel-exact.
 */
export const BOSS_CROP: WorldRect = { x: 353, y: 50, w: 318, h: 604 };

// Warm the paintings at import, so the first mount of either room does not flash void.
if (typeof Image !== 'undefined') {
  for (const src of [lobbyPng, arenaPng, gatePng]) new Image().src = src;
}
