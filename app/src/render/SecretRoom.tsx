/**
 * The secret room — the chamber behind the lobby's west door, hung with the banners of the
 * two things the game runs on: Solana, and MagicBlock's ephemeral rollup.
 *
 * ON CHAIN: a zone. `ZONE_SECRET` is a third value of `PlayerSlot.zone`, and the room's
 * floor is `SECRET_ROOM` — a block of lobby floor tiles the chain holds a secret seat inside
 * (`player::zone_box` / `standable`) exactly as it holds a raider on the dais. A seat gets in
 * and out through `use_door` (tag 17): the client sends it from the edge of a REFUSED step
 * — west into the wall from the door's threshold tiles, east into the wall from the room's
 * exit tiles ({@link knockDir}) — so the knock is the same refusal a wall gives, and the
 * chain moves the seat, not the client. Every step inside is a `move` like any other.
 *
 * ON SCREEN: room A with the chamber painted over it. `secret.gen.ts` places the painting so
 * its floor IS `SECRET_ROOM` in world units (held below at boot), so every seat in the zone
 * is drawn by the ordinary knight layer at its chain position, with no offset anywhere; the
 * veil under the painting hides the waiting area and `Arena.tsx`'s `seatShown` hides the
 * seats on the other side of the wall. Mounted right after the room element, before every
 * mover. Pointer-transparent, and nothing here writes a transform any other node owns.
 */
import { SECRET_DOOR, SECRET_EXIT, SECRET_ROOM, ZONE_LOBBY, ZONE_SECRET, inBlock } from '@heartrot/client';

import { dirFromVector } from '../input/controls';
import { roomGlow } from './RoomLight';
import { VOID } from './rooms.gen';
import { SECRET_ARCH_LOBBY, SECRET_ARCH_ROOM, SECRET_CAPTION, SECRET_FLOOR, SECRET_IMG, SECRET_LABELS, SECRET_LIGHTS } from './secret.gen';
import { ARENA_UNITS } from './sprites';

/** How dark the hall goes behind the chamber. */
const VEIL_OPACITY = 0.9;

/** The sectors a step west and east quantise to — the two the door answers. */
const WEST = dirFromVector(-1, 0);
const EAST = dirFromVector(1, 0);

/**
 * The direction that knocks from here, or `null`: west from the lobby's door tiles, east
 * from the room's exit tiles. `App.tsx` asks this when the predictor refuses a step — refused
 * there, in this direction, from here, it is the door being pushed — and sends `use_door`.
 */
export function knockDir(zone: number, x: number, y: number): number | null {
  if (zone === ZONE_LOBBY && inBlock(SECRET_DOOR, x, y)) return WEST;
  if (zone === ZONE_SECRET && inBlock(SECRET_EXIT, x, y)) return EAST;
  return null;
}

/** The painted arch a seat standing at (`x`, `y`) in `zone` is about to push, for the glow. */
export function archAt(zone: number, x: number, y: number) {
  const dir = knockDir(zone, x, y);
  return dir === null ? null : dir === WEST ? SECRET_ARCH_LOBBY : SECRET_ARCH_ROOM;
}

export function SecretRoom() {
  return (
    <g
      className="secret-room"
      role="img"
      aria-label="A hidden room: the banners of Solana and MagicBlock"
      style={{ pointerEvents: 'none' }}
    >
      <rect x={-ARENA_UNITS} y={-ARENA_UNITS} width={3 * ARENA_UNITS} height={3 * ARENA_UNITS} fill={VOID.lobby} opacity={VEIL_OPACITY} />
      <image
        href={SECRET_IMG.src}
        x={SECRET_IMG.x}
        y={SECRET_IMG.y}
        width={SECRET_IMG.w}
        height={SECRET_IMG.h}
        preserveAspectRatio="none"
        style={{ imageRendering: 'auto' }}
      />
      {roomGlow('secret-glow', SECRET_LIGHTS)}
      {SECRET_LABELS.map((l) => (
        <text key={l.text} className="secret-label" x={l.x} y={l.y} textAnchor="middle">
          {l.text}
        </text>
      ))}
      <text className="secret-caption" x={SECRET_CAPTION.x} y={SECRET_CAPTION.y} textAnchor="middle">
        every step and every arrow is a transaction
      </text>
    </g>
  );
}

if (import.meta.env.DEV) {
  // The painting's floor and the chain's block are one fact: a seat in the zone is drawn
  // on the cobbles only while these four numbers agree. And the two thresholds answer in
  // the two directions the chain crosses them in, and nowhere else.
  const fail = (msg: string): never => {
    throw new Error(`SecretRoom: ${msg}`);
  };
  const f = SECRET_FLOOR;
  if (f.x !== SECRET_ROOM.minX || f.y !== SECRET_ROOM.minY || f.x + f.w - 1 !== SECRET_ROOM.maxX || f.y + f.h - 1 !== SECRET_ROOM.maxY) {
    fail('the painted floor is not SECRET_ROOM; re-run tools/gen_secret.py');
  }
  if (knockDir(ZONE_LOBBY, SECRET_DOOR.minX, SECRET_DOOR.minY) !== WEST) fail('the door threshold does not knock west');
  if (knockDir(ZONE_SECRET, SECRET_EXIT.minX, SECRET_EXIT.maxY) !== EAST) fail('the exit does not knock east');
  if (knockDir(ZONE_LOBBY, SECRET_EXIT.minX, SECRET_EXIT.minY) !== null) fail('a lobby seat knocks from inside the room');
  if (knockDir(ZONE_SECRET, SECRET_ROOM.minX, SECRET_ROOM.minY) !== null) fail('the far corner knocks');
}
