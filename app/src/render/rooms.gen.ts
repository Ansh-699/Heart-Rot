// @generated from assets/map/arena.json `rooms` and assets/rooms/*.png by `python3 tools/gen_rooms.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the painting on screen
// and the grid the chain walks stop being the same room. Edit `rooms` in arena.json, re-run
// the command above, then `python3 tools/gen_map.py`.
//
// `?no-inline` keeps every painting a hashed file under /assets/ (served immutable by
// app/public/_headers) rather than a base64 string in the bundle, whatever its size.
import arenaPng from './rooms/arena.png?no-inline';
import gate0Png from './rooms/gate0.png?no-inline';
import gate1Png from './rooms/gate1.png?no-inline';
import gate2Png from './rooms/gate2.png?no-inline';
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

/** One `G` block, in world units, with the difficulty tier `enter_gate` reads off it. */
export interface LobbyGate extends WorldRect {
  readonly tier: number;
}

/** A painted torch or brazier: where its flame is, how far its glow reaches, its colour off the paint. */
export interface RoomLight {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly color: string;
}

/**
 * The waiting hall (1695x1086 px), fitted to the room's height at 0.6041 units per
 * px, so `y` is `VIEW_LOBBY.y` and `h` is `ROOM_H`, centred in x with 0.0663 units of void
 * each side. Its floor is the 16-row lobby band. Mount it with `imageRendering: 'auto'`: the
 * painting is not pixel art.
 */
export const LOBBY_IMG: ImgRect = { src: lobbyPng, x: 0.0663, y: 320, w: 1023.8674, h: 656 };

/**
 * The fight arena (1122x612 px) at one unit per px -- the scale the boss crop and its
 * hitboxes are cut at -- with its bottom edge on the pit rim (`PIT_BOT + 1`) and centred
 * in x, so it overhangs the frame by 49 units a side and leaves 44 units of void
 * above its top edge in `VIEW_ARENA`. The demon is painted out of this copy: the rig is
 * the only demon on screen, so a destroyed part leaves a hole the room shows through.
 */
export const ARENA_IMG: ImgRect = { src: arenaPng, x: -49, y: -4, w: 1122, h: 612 };

/**
 * The three portcullises, by tier, cut out of the lobby painting (which has each throat
 * painted dark underneath), for `WaitingRoom` to mount as the `.gate-portcullis` nodes the
 * passage lifts. Each spans its `G` block's rows.
 */
export const GATE_IMGS: readonly ImgRect[] = [
  { src: gate0Png, x: 196.3831, y: 554.372, w: 103.8969, h: 86.9834 },
  { src: gate1Png, x: 460.9576, y: 554.372, w: 103.8969, h: 86.9834 },
  { src: gate2Png, x: 726.7403, y: 554.372, w: 103.8969, h: 86.9834 },
];

/** The `G` blocks by tier, tile-aligned: what `map.ts`'s `GATES` must equal, both from one grid. */
export const LOBBY_GATES: readonly LobbyGate[] = [
  { x: 192, y: 608, w: 112, h: 32, tier: 0 },
  { x: 464, y: 608, w: 96, h: 32, tier: 1 },
  { x: 720, y: 608, w: 112, h: 32, tier: 2 },
];

/** Each doorway's own light, read off its bars: the colour its mark's halo wears. */
export const LOBBY_GATE_COLORS: readonly string[] = ['#bcd85f', '#d87946', '#d84f46'];

/** What the `.vp-void` rect paints per room: the median of that painting's outermost ring. */
export const VOID: Readonly<Record<'lobby' | 'arena', string>> = {
  lobby: '#070811',
  arena: '#070915',
};

/** The painted lobby floor, a union. Every walkable lobby tile lies wholly inside it (generator-proven). */
export const LOBBY_FLOOR: readonly WorldRect[] = [
  { x: 207.86, y: 639.5433, w: 608.2799, h: 257.326 },
  { x: 76.1768, y: 639.5433, w: 131.6832, h: 130.4751 },
  { x: 816.14, y: 639.5433, w: 131.6832, h: 130.4751 },
];

/** The painted platform the pit is cut from: the walkable pit is this whole ellipse, less the boss. */
export const ARENA_PLATFORM: WorldEllipse = { cx: 512, cy: 396, rx: 461, ry: 212 };

/**
 * The boss crop, in world units: `gen_boss.py` cuts exactly this out of the arena painting,
 * so `BOSS_SPAWN + BOSS_ANCHOR === { x, y }` here -- the rig sits on its own paint pixel-exact.
 */
export const BOSS_CROP: WorldRect = { x: 353, y: 50, w: 318, h: 604 };

/** The lobby's painted torches, for the glow the room hangs under each. */
export const LOBBY_LIGHTS: readonly RoomLight[] = [
  { x: 79.1971, y: 707.1971, r: 57.3849, color: '#fcd37b' },
  { x: 942.9908, y: 707.1971, r: 57.3849, color: '#fde386' },
  { x: 174.6372, y: 550.7477, r: 48.3241, color: '#facf81' },
  { x: 316.5893, y: 551.3517, r: 48.3241, color: '#fcdb77' },
  { x: 437.3996, y: 551.3517, r: 48.3241, color: '#fcd77b' },
  { x: 585.3923, y: 551.3517, r: 48.3241, color: '#fddb83' },
  { x: 706.2026, y: 551.3517, r: 48.3241, color: '#fdb57b' },
  { x: 848.1547, y: 551.9558, r: 48.3241, color: '#fea573' },
  { x: 442.8361, y: 884.1842, r: 51.3444, color: '#fcdf8d' },
  { x: 581.1639, y: 884.1842, r: 51.3444, color: '#fdd985' },
  { x: 160.14, y: 857.6059, r: 42.2836, color: '#f6b15c' },
];

/** The arena's painted braziers, likewise. */
export const ARENA_LIGHTS: readonly RoomLight[] = [
  { x: -17, y: 499, r: 60, color: '#95d5c7' },
  { x: 117, y: 227, r: 55, color: '#39c5c3' },
  { x: 226, y: 201, r: 55, color: '#42c5c3' },
  { x: 380, y: 166, r: 50, color: '#55c0b9' },
  { x: 384, y: 557, r: 60, color: '#5ee0d1' },
  { x: 627, y: 556, r: 60, color: '#72e4e3' },
  { x: 641, y: 165, r: 50, color: '#5dc9cb' },
  { x: 794, y: 202, r: 55, color: '#33c6c4' },
  { x: 902, y: 225, r: 55, color: '#60cfd0' },
  { x: 989, y: 220, r: 55, color: '#3fc6c5' },
  { x: 1038, y: 501, r: 60, color: '#74ddd8' },
];

// Warm the paintings at import, so the first mount of either room does not flash void.
if (typeof Image !== 'undefined') {
  for (const src of [lobbyPng, arenaPng, gate0Png, gate1Png, gate2Png]) new Image().src = src;
}
