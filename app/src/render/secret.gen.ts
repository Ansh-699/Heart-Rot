// @generated from assets/rooms/lobby.png and assets/sprites/*-mark.png by `python3 tools/gen_secret.py` -- DO NOT EDIT.
//
// The chamber behind the lobby's west door. Every number here is in WORLD UNITS at the
// lobby's own fit (`LOBBY_IMG`), so the room, its lights and the door threshold move with the
// painting. Edit the tool, then re-run the command above.
import secretPng from './rooms/secret.png?no-inline';
import type { ImgRect, RoomLight, WorldRect } from './rooms.gen';

/** The chamber (720x460 px), centred in the lobby's view. Mount with `imageRendering: 'auto'`. */
export const SECRET_IMG: ImgRect = { src: secretPng, x: 294.541, y: 509.068, w: 434.917, h: 277.864 };

/** The two torches, for `roomGlow`. */
export const SECRET_LIGHTS: readonly RoomLight[] = [
  { x: 383.941, y: 576.722, r: 57.3849, color: '#ffef7e' },
  { x: 637.643, y: 576.722, r: 57.3849, color: '#ffef7e' },
];

/** Each banner's caption: centre x, baseline y. */
export const SECRET_LABELS: readonly { x: number; y: number; text: string }[] = [
  { x: 445.554, y: 633.503, text: 'SOLANA' },
  { x: 578.446, y: 633.503, text: 'MAGICBLOCK' },
];

/** The one-line caption above the front wall: centre x, baseline y. */
export const SECRET_CAPTION = { x: 512, y: 742.232 } as const;

/** Where the local knight stands, just inside the door: the sprite's centre. */
export const SECRET_STAND = { x: 654.556, y: 690.284 } as const;

/** The lobby's west door, the painted arch, for the glow that answers a raider standing at it. */
export const SECRET_DOOR: WorldRect = { x: 15.7716, y: 682.431, w: 55.5727, h: 72.4862 };

/** The tiles a raider pushes WEST from to open the door: floor column 5, rows 43..46. */
export const SECRET_THRESHOLD: WorldRect = { x: 80, y: 688, w: 16, h: 64 };
