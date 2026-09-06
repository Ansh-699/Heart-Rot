// @generated from assets/map/arena.json `doors`, assets/rooms/lobby.png and assets/sprites/*-mark.png
// by `python3 tools/gen_side_rooms.py` -- DO NOT EDIT.
//
// The side rooms off the lobby, each painted onto the chain's own tiles. Every number here is
// in WORLD UNITS: a painting's floor is exactly its `SIDE_ROOMS[i].floor` (map.ts), so a seat
// the chain puts in a room's zone is drawn on its floor with no offset anywhere. Edit the
// tool or arena.json's `doors` block, then re-run the command above.
import secretPng from './rooms/secret.png?no-inline';
import keepPng from './rooms/keep.png?no-inline';
import cryptPng from './rooms/crypt.png?no-inline';
import glyphsPng from './siderooms-glyphs.png';
import doorsPng from './siderooms-doors.png';
import type { ImgRect, RoomLight, WorldRect } from './rooms.gen';

export type SideRoomName = 'secret' | 'keep' | 'crypt';

/** The three doorways a seat can stand at, drawn open: the two painted arches and the stair. */
export type DoorKind = 'west' | 'east' | 'stairs';

export interface SideRoomArt {
  /** The chamber, its floor on the chain's block. Mount with `imageRendering: 'auto'`. */
  readonly img: ImgRect;
  /** The painted floor, which `SideRooms.tsx` holds equal to the chain's block at boot. */
  readonly floor: WorldRect;
  /** The torches (and the vault's glow), for `roomGlow`. */
  readonly lights: readonly RoomLight[];
  /** Captions: centre x, baseline y. */
  readonly labels: readonly { x: number; y: number; text: string }[];
  /** The painted doorway in the LOBBY the room is knocked on: the glow when a seat stands at it. */
  readonly archLobby: WorldRect;
  /** The painted doorway in the ROOM it is left by: the glow when a seat stands at the exit. */
  readonly archRoom: WorldRect;
  /** Which open frame each doorway shows: `archLobby`'s and `archRoom`'s. */
  readonly doorLobby: DoorKind;
  readonly doorRoom: DoorKind;
  /** Where the room's furniture takes text or a picture: tablets, the chest, the mirror, the slabs. */
  readonly anchors: Readonly<Record<string, WorldRect>>;
}

export const SIDE_ROOM_ART: Readonly<Record<SideRoomName, SideRoomArt>> = {
  secret: {
    img: { src: secretPng, x: 291.623, y: 567.547, w: 440.755, h: 268.679 },
    floor: { x: 352, y: 640, w: 320, h: 160 },
    lights: [
      { x: 385.811, y: 635.17, r: 57.3849, color: '#ffef7e' },
      { x: 635.774, y: 635.17, r: 57.3849, color: '#ffef7e' },
    ],
    labels: [
      { x: 445.585, y: 691.924, text: 'SOLANA' },
      { x: 578.415, y: 691.924, text: 'MAGICBLOCK' },
      { x: 512, y: 791.547, text: 'every step and every arrow is a transaction' },
    ],
    archLobby: { x: 19.396, y: 682.431, w: 45.9079, h: 72.4862 },
    archRoom: { x: 679.245, y: 677.434, w: 45.8868, h: 72.4528 },
    doorLobby: 'west',
    doorRoom: 'east',
    anchors: {},
  },
  keep: {
    img: { src: keepPng, x: 243.623, y: 599.547, w: 536.755, h: 300.679 },
    floor: { x: 304, y: 672, w: 416, h: 192 },
    lights: [
      { x: 318.491, y: 667.17, r: 57.3849, color: '#ffef7e' },
      { x: 703.094, y: 667.17, r: 57.3849, color: '#ffef7e' },
      { x: 689.811, y: 704.604, r: 20.5378, color: '#f2cf6b' },
    ],
    labels: [
      { x: 512, y: 674.415, text: 'RECORDS' },
      { x: 689.811, y: 680.453, text: 'VAULT' },
      { x: 396.377, y: 798.793, text: 'ARMOURY' },
      { x: 512, y: 855.547, text: 'what the chain remembers, what pays for it, who you are' },
    ],
    archLobby: { x: 958.696, y: 682.431, w: 45.9079, h: 72.4862 },
    archRoom: { x: 250.868, y: 725.132, w: 45.8868, h: 72.4528 },
    doorLobby: 'east',
    doorRoom: 'west',
    anchors: {
      tablet0: { x: 429.585, y: 611.623, w: 43.4717, h: 48.3019 },
      tablet1: { x: 489.962, y: 611.623, w: 43.4717, h: 48.3019 },
      tablet2: { x: 550.34, y: 611.623, w: 43.4717, h: 48.3019 },
      chest: { x: 651.17, y: 725.132, w: 77.283, h: 21.7358 },
      mirror: { x: 383.698, y: 680.453, w: 53.1321, h: 94.1887 },
    },
  },
  crypt: {
    img: { src: cryptPng, x: 291.623, y: 599.547, w: 440.755, h: 268.679 },
    floor: { x: 352, y: 672, w: 320, h: 160 },
    lights: [
      { x: 385.811, y: 667.17, r: 57.3849, color: '#ffef7e' },
      { x: 635.774, y: 667.17, r: 57.3849, color: '#ffef7e' },
    ],
    labels: [
      { x: 512, y: 823.547, text: 'every incarnation the chain has buried' },
    ],
    archLobby: { x: 477.267, y: 921.635, w: 72.4862, h: 54.3646 },
    archRoom: { x: 475.774, y: 617.66, w: 72.4528, h: 54.3396 },
    doorLobby: 'stairs',
    doorRoom: 'stairs',
    anchors: {
      slab0: { x: 373.736, y: 682.868, w: 45.8868, h: 54.3396 },
      slab1: { x: 450.415, y: 682.868, w: 45.8868, h: 54.3396 },
      slab2: { x: 527.698, y: 682.868, w: 45.8868, h: 54.3396 },
      slab3: { x: 604.377, y: 682.868, w: 45.8868, h: 54.3396 },
      slab4: { x: 373.736, y: 760.151, w: 45.8868, h: 54.3396 },
      slab5: { x: 450.415, y: 760.151, w: 45.8868, h: 54.3396 },
      slab6: { x: 527.698, y: 760.151, w: 45.8868, h: 54.3396 },
      slab7: { x: 604.377, y: 760.151, w: 45.8868, h: 54.3396 },
    },
  },
};

/** The open frames' rects in `siderooms-doors.png`: each arch with its leaf gone, the stair lit. */
export const DOOR_FRAMES: Readonly<Record<DoorKind, { x: number; y: number; w: number; h: number }>> = { west: { x: 0, y: 0, w: 76, h: 120 }, east: { x: 76, y: 0, w: 76, h: 120 }, stairs: { x: 152, y: 0, w: 120, h: 90 } };

const DOOR_IMG = `<image href="${doorsPng}" width="272" height="120"/>`;

/** The `<defs>` markup for the open doorways, mounted once by whichever component owns the arena `<svg>`. */
export const DOOR_DEFS =
  `<symbol id="door-west-open" viewBox="0 0 76 120">${DOOR_IMG}</symbol>` +
  `<symbol id="door-east-open" viewBox="76 0 76 120">${DOOR_IMG}</symbol>` +
  `<symbol id="door-stairs-open" viewBox="152 0 120 90">${DOOR_IMG}</symbol>`;

/** The crypt's outcome glyphs, `w` x `w` each, three across: skull (wipe), crown (kill), hourglass (enrage). */
export const CRYPT_GLYPH = { w: 12, names: ['skull', 'crown', 'hourglass'] } as const;

const GLYPH_IMG = `<image href="${glyphsPng}" width="36" height="12"/>`;

/** The `<defs>` markup, mounted once by whichever component owns the arena `<svg>`. */
export const CRYPT_GLYPH_DEFS =
  `<symbol id="crypt-skull" viewBox="0 0 12 12">${GLYPH_IMG}</symbol>` +
  `<symbol id="crypt-crown" viewBox="12 0 12 12">${GLYPH_IMG}</symbol>` +
  `<symbol id="crypt-hourglass" viewBox="24 0 12 12">${GLYPH_IMG}</symbol>`;
