/**
 * The secret room — the chamber behind the lobby's west door, hung with the banners of the
 * two things the game runs on: Solana, and MagicBlock's ephemeral rollup.
 *
 * ON CHAIN: nothing, and that is the design. There is no room in the grid the program
 * walks: the door is a wall tile, so a westward step from the threshold is refused by
 * `predictor.push` before it is ever sent, and THAT refusal is the knock (`App.tsx`'s
 * `onMove`, through {@link atSecretDoor}). The seat stays exactly where the chain has it —
 * on the threshold, a step from the arch — and every other raider sees a knight standing
 * at a door. This is a picture shown to whoever pushed; the first accepted step (any real
 * move) closes it, so nothing on screen ever claims a position the chain does not hold.
 *
 * Mounted inside `#camera` over room A, in world units, from `secret.gen.ts` — every number
 * there is `tools/gen_secret.py`'s, derived from the painting and the lobby's own fit. The
 * knight in the doorway is the local skin's idle frame from the archer atlas, flipped to
 * face the room the way `Knight.tsx` flips a west-facing seat. Pointer-transparent, and
 * nothing here writes a transform any other node owns.
 */
import { MAP_TILE, isWall } from '@heartrot/client';

import { ARCHER_ATLAS, ATLAS_H, ATLAS_W, FRAMES, KNIGHT_SKINS, type SkinId } from './knights.gen';
import { roomGlow } from './RoomLight';
import { VOID } from './rooms.gen';
import { SECRET_CAPTION, SECRET_IMG, SECRET_LABELS, SECRET_LIGHTS, SECRET_STAND, SECRET_THRESHOLD } from './secret.gen';
import { ARENA_UNITS } from './sprites';

/** How dark the hall goes behind the chamber. */
const VEIL_OPACITY = 0.9;

type Frame = readonly [number, number, number, number];

/** Is a seat at (`x`, `y`) — a tile origin, as the chain stores it — on the door's threshold? */
export function atSecretDoor(x: number, y: number): boolean {
  const t = SECRET_THRESHOLD;
  return x >= t.x && x < t.x + t.w && y >= t.y && y < t.y + t.h;
}

export function SecretRoom({ skinId }: { skinId: number }) {
  // The same clamp as `Knight.tsx`: the program stores the byte verbatim.
  const skin = (Number.isInteger(skinId) && skinId >= 0 && skinId < KNIGHT_SKINS.length ? skinId : 0) as SkinId;
  const body = FRAMES[`${skin}-e-idle`];
  const halo = FRAMES[`halo${skin}-e-idle`];
  const [, , w, h] = body;
  // `Knight.tsx`'s flipped anchor: the frame is drawn mirrored about the stand's x.
  const ox = -(w - (w >> 1));
  const oy = -(h >> 1);
  const frame = ([fx, fy, fw, fh]: Frame) => (
    <svg x={ox} y={oy} width={fw} height={fh} viewBox={`${fx} ${fy} ${fw} ${fh}`}>
      <image href={ARCHER_ATLAS} width={ATLAS_W} height={ATLAS_H} />
    </svg>
  );
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
      <g transform={`translate(${SECRET_STAND.x} ${SECRET_STAND.y}) scale(-1 1)`}>
        {frame(halo)}
        {frame(body)}
      </g>
    </g>
  );
}

if (import.meta.env.DEV) {
  // The generator's threshold against the grid the chain ships: floor tiles with the door's
  // wall to their west, so a west step from any of them is exactly the refusal the knock
  // keys on. A door that drifts off the grid fails here, at boot, not in a silent no-op.
  const t = SECRET_THRESHOLD;
  const fail = (msg: string): never => {
    throw new Error(`SecretRoom: ${msg}`);
  };
  for (let y = t.y; y < t.y + t.h; y += MAP_TILE) {
    if (isWall(t.x, y)) fail(`threshold tile at ${t.x},${y} is wall`);
    if (!isWall(t.x - MAP_TILE, y)) fail(`no door wall west of ${t.x},${y}`);
  }
  if (!atSecretDoor(t.x, t.y) || !atSecretDoor(t.x, t.y + t.h - MAP_TILE)) fail('the threshold does not answer');
  if (atSecretDoor(t.x + t.w, t.y) || atSecretDoor(t.x, t.y - MAP_TILE) || atSecretDoor(t.x, t.y + t.h)) fail('a tile off the threshold answers');
}
