/**
 * Where a raider may stand, beyond the y band — the client's copy of
 * `programs/heartrot/src/body.rs` and of `handlers::player::standable` /
 * `may_stand_step`, for prediction.
 *
 * The pit is the whole painted dais and the creature stands in the middle of it. Two
 * things then refuse a step that no wall can, because a wall kills every ray in its
 * column: the boss's own body — the union of the nine generated part boxes, folded here
 * out of the same `PART_HITBOXES` the chain folds, at `BOSS_SPAWN` because the boss
 * never moves — and the air beside the dais's shoulders, which `onDais` reads out of the
 * same generated grid the chain's `DAIS` table is compiled from.
 *
 * Both halves live in this one module and `predict.ts` calls {@link mayStandStep} beside
 * `mayMoveTo`, exactly as `move_player` does: a prediction that mirrored the wall and the
 * band but not this would walk the knight into the creature, get `BlockedByWall` back and
 * rubber-band — this project's signature misdiagnosis, read as lag every time.
 */

import { PART_HITBOXES, type Rect } from './hitboxes';
import { ZONE_ARENA } from './layout';
import { BOSS_SPAWN, inBlock, onDais, sideRoomOf } from './map';

/** The union of every part box, boss-local, in arena units. Half-open like every `Rect`. */
export const BOSS_BODY: Rect = (() => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of PART_HITBOXES) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
})();

/** Is this arena-space point inside the boss's body, with the boss at `BOSS_SPAWN`? `body::in_body`. */
export function inBossBody(x: number, y: number): boolean {
  const lx = x - BOSS_SPAWN[0];
  const ly = y - BOSS_SPAWN[1];
  return lx >= BOSS_BODY.x && lx < BOSS_BODY.x + BOSS_BODY.w && ly >= BOSS_BODY.y && ly < BOSS_BODY.y + BOSS_BODY.h;
}

/**
 * `handlers::player::standable`: a raider stands on the dais and outside the boss; a lobby
 * seat stands wherever walls and the band allow, which is not this module's question.
 */
export function standable(zone: number, x: number, y: number): boolean {
  // A side room, whole and nothing else: its walls are not in the grid, because the room is
  // laid over lobby floor that lobby seats still walk.
  const room = sideRoomOf(zone);
  if (room) return inBlock(room.floor, x, y);
  return zone !== ZONE_ARENA || (onDais(x, y) && !inBossBody(x, y));
}

/**
 * `handlers::player::may_stand_step`: the destination must be standable — or the seat
 * already is not, in which case walls alone govern it until it is. The same un-stranding
 * shape as `mayMoveTo`, for the same reason: the rule was laid under live accounts.
 */
export function mayStandStep(zone: number, x: number, y: number, nx: number, ny: number): boolean {
  return !standable(zone, x, y) || standable(zone, nx, ny);
}
