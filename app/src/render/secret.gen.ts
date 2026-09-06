// @generated from assets/map/arena.json `secret`, assets/rooms/lobby.png and assets/sprites/*-mark.png
// by `python3 tools/gen_secret.py` -- DO NOT EDIT.
//
// The chamber behind the lobby's west door, painted onto the chain's own tiles. Every number
// here is in WORLD UNITS: the painting's floor is exactly `SECRET_ROOM` (map.ts), so a seat
// the chain puts in `ZONE_SECRET` is drawn on the floor with no offset anywhere. Edit the
// tool or arena.json's `secret` block, then re-run the command above.
import secretPng from './rooms/secret.png?no-inline';
import type { ImgRect, RoomLight, WorldRect } from './rooms.gen';

/** The chamber (730x445 px), its floor on `SECRET_ROOM`. Mount with `imageRendering: 'auto'`. */
export const SECRET_IMG: ImgRect = { src: secretPng, x: 291.623, y: 567.547, w: 440.755, h: 268.679 };

/** The painted floor, which `SecretRoom.tsx` holds equal to `SECRET_ROOM` at boot. */
export const SECRET_FLOOR: WorldRect = { x: 352, y: 640, w: 320, h: 160 };

/** The two torches, for `roomGlow`. */
export const SECRET_LIGHTS: readonly RoomLight[] = [
  { x: 385.811, y: 635.17, r: 57.3849, color: '#ffef7e' },
  { x: 635.774, y: 635.17, r: 57.3849, color: '#ffef7e' },
];

/** Each banner's caption: centre x, baseline y. */
export const SECRET_LABELS: readonly { x: number; y: number; text: string }[] = [
  { x: 445.585, y: 691.924, text: 'SOLANA' },
  { x: 578.415, y: 691.924, text: 'MAGICBLOCK' },
];

/** The one-line caption above the front wall: centre x, baseline y. */
export const SECRET_CAPTION = { x: 512, y: 791.547 } as const;

/** The lobby's west door, the painted arch: the glow when a seat stands in `SECRET_DOOR`. */
export const SECRET_ARCH_LOBBY: WorldRect = { x: 15.7716, y: 682.431, w: 55.5727, h: 72.4862 };

/** The room's east door, the painted arch: the glow when a seat stands in `SECRET_EXIT`. */
export const SECRET_ARCH_ROOM: WorldRect = { x: 679.245, y: 677.434, w: 45.8868, h: 72.4528 };
