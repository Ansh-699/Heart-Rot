/**
 * The arena composition — where things sit relative to each other, and who writes which
 * node. There is no camera in this file any more, and that is the point of it.
 *
 * ONE ROOM IS ON SCREEN AND IT FILLS THE STAGE (spec 17 §1). `./viewport`'s `useViewport`
 * owns the `viewBox` attribute and is its only writer; `#camera` rests at IDENTITY in both
 * rooms and is written in exactly one place — `./Passage`, during the gate move. Nothing
 * pans, nothing follows anybody, and nothing a player can stand on is ever cropped: the
 * fit covers the stage with the room and gives up only the fiction outside `viewport.ts`'s
 * `KEEP` (the tower shaft, the void under the bottom wall). The follow camera, its dead
 * zone and its fourteen constants are deleted rather than disabled: they were the reported bug (a
 * lobby that panned to half a doorway on the first notification, spec §1.6), and their
 * self-checks moved to `./viewport` where the framing now lives.
 *
 * The art lives in sibling modules, each of which owns one layer and its own animation, so
 * a change to the boss rig cannot reach into the seat loop:
 *
 *   `./WaitingRoom` `{WAITING}`                      room A, framed on `VIEW_LOBBY`.
 *   `./BossArena`   `{BOSS_ARENA}`                    room B, framed on `VIEW_ARENA`.
 *                                                     Both are ONE element built at module
 *                                                     load: no props, no memo, nothing
 *                                                     React can walk again.
 *   `./Boss`    `<Boss boss arena />`                 the rig at `BOSS_SPAWN`, top centre,
 *                                                     unmoved by anything in here.
 *   `./Knight`  `<Knight slot mine reduced />`        the CHILDREN of one seat `<g>`, never
 *                                                     the `<g>` itself, whose transform the
 *                                                     loops below own.
 *   `./Shot`    `<Shot … />`                          the arrows, ABOVE the knights.
 *   `./Spawn`   `<Spawn phase bossX bossY reduced />` the light the cavern plays when the
 *                                                     muster ends.
 *
 * Layer order under `#camera`, back to front — spec §8, rows 1..16:
 *
 *   room        the active room whole: void rect, floor, markings, floor light, wall mass
 *               and props (rows 1-6). Room A or room B, never both.
 *   boss        rows 7-9, room B only, clipped at its hittable extent.
 *   telegraphs  row 10, over the boss and UNDER the knights.
 *   bullets     row 11, boss ordnance and its four muzzle bursts, capped at 32 drawn
 *               bullets, ROOM B ONLY.
 *   knights     row 12. THE PLAYER IS ON TOP: nothing in the scene is drawn over a body.
 *   arrows      row 13, above the knights — an arrow under twenty bodies is the "I cannot
 *               see anything" report.
 *   rim         row 14 is GONE: the painted room carries its own rim, and the flat
 *               `PAL.wall` this used to draw over every wall tile was a colour mask.
 *   spawn       row 15, the opening light, pointer-transparent.
 *   veil        row 16, the passage, mounted last so it covers the flare.
 *
 * Rows 1-6 belong to the room modules. A wall drawn here as well would be a second copy of
 * the bitboard, which is this project's signature defect.
 *
 * R3, the room contract that makes room A's painted gate tower legal (spec §3): A SEAT AND
 * EVERYTHING IT LOOSES ARE DRAWN ONLY IN THE ROOM ON SCREEN. `VIEW_LOBBY` and `VIEW_ARENA`
 * overlap in world space; break R3 and the lobby's fake masonry paints over the pit and
 * over the allies standing in it. `seatShown` is the whole of the enforcement and it is
 * exported so `Shot` gates arrows and damage numbers on the same predicate — R3 answered
 * twice, once against `room` and once against a raw `zone`, is one fact stored twice, and
 * the two answers differ by construction for the whole of a gate cover.
 *
 * Four things in here were measured and must not be undone:
 *
 *   1. The LOCAL seat renders from `predictor.self`, chased in the rAF loop; every REMOTE
 *      seat renders from `useSeatInterpolation`. That split took static frames during a
 *      fight from 200 to 52. `predictor.ready` gates it.
 *   2. The frame loop is the ONLY writer of a bullet's and the local seat's transform.
 *      A node carrying an inline transform *and* a running animation silently discards the
 *      inline write; one writer per node is mechanical here, not a discipline.
 *   3. The `viewBox` is set, never animated: animating it measured 9.6 ms/frame against
 *      ~1.7 for the identical scene on a `<g>` transform. That is why the gate move is a
 *      transform on `#camera` and why the fit hook writes the attribute only on a resize or
 *      a room change.
 *   4. The 32-bullet visible cap: 11.46/16.96 ms → 9.38/14.92 at 20 knights and 6x throttle.
 *   5. `Knight` is memoised on the seat's own VALUES (`Knight.tsx`'s `sameSeat`), so one
 *      accepted `move` — one `Players` write, ~322 of them a second at twenty seats —
 *      re-renders the one seat it moved and not all twenty. This file still renders per
 *      notification and must: it owns the draw order, the bullet ranking and the
 *      telegraphs. What it must NOT do is hand a seat a value that churns without being
 *      drawn — `predictedSlot` below is the one place that could, and does not.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import {
  BOSS_SPAWN,
  CORE,
  GATES,
  MAP_ENTRANCES,
  MAP_TILE,
  MAX_BULLETS,
  MUZZLES,
  SLAM_LANES,
  NO_TARGET,
  OUTCOME_WIN,
  PART_HITBOXES,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  PHASE_SETTLING,
  PIT_BOT,
  PIT_TOP,
  SLAM_LANE_W,
  SLAM_TELEGRAPH_TICKS,
  TICK_MS,
  ZONE_ARENA,
  ZONE_LOBBY,
  gateAt,
  isFurious,
  onDais,
  isWall,
  slamTelegraph,
  type ArenaAccount,
  type BossAccount,
  type Bullet,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

import { useSeatInterpolation, type PredictedSelf, type Predictor } from '../net/predict';
import { BOSS_ARENA } from './BossArena';
import { Boss } from './Boss';
import { Knight, knightDrawOrder } from './Knight';
import { FIRE_DEFS, FIRE_PILLAR, FIRE_RING } from './fire.gen';
import { ORDNANCE_DEFS, ORD_BULLET, ORD_BURST, ORD_THORN } from './ordnance.gen';
import { play } from './sfx';
import { Shot } from './Shot';
import { Spawn } from './Spawn';
import { WAITING } from './WaitingRoom';
import { useViewport, type Room } from './viewport';
import { ARENA_UNITS, PAL, SELF_SNAP, VISIBLE_PROJECTILES } from './sprites';

/**
 * The input period the local seat is chased at: one move per 50 ms ER slot, so the chase
 * covers exactly one `MOVE_STEP` in the time it takes the next one to arrive. It lands
 * within a frame of the prediction and never overshoots it.
 *
 * Chasing rather than assigning `predictor.self` outright is deliberate. Prediction alone
 * is not smoothness: `self` teleports one whole tile at 20 Hz, so two thirds of frames
 * would draw no movement at all — measurably *more* discrete than the interpolated seat it
 * replaces. The chase is what turns 16 units every 50 ms into 5.3 units every frame, at the
 * cost of ~32 ms of lag behind the keypress (against 165 ms for the interpolated seat).
 */
export const MOVE_MS = 50;

/**
 * How many bullets are DRAWN — the scene's whole projectile budget, of which whatever this
 * file does not spend is handed to `Shot` as `budget`. One number, and it is
 * {@link VISIBLE_PROJECTILES} in `sprites.ts` rather than a second name here: the two used
 * to be typed separately and nothing cross-checked them, so lowering one of them silently
 * restored the cap through the other. The live instrument saw only 13-15 bullets in flight
 * at 20 seats, so the cap is almost never reached — which is also why the ranking below is
 * allowed to cost anything at all.
 */
const VISIBLE_BULLETS = VISIBLE_PROJECTILES;

/**
 * How far ahead a bullet is looked at when ranking it. The game already has exactly one
 * answer to "about to happen" — the wind-up it telegraphs both attacks over — and a second
 * number here would teach the player two different lengths of "soon". Derived, never typed:
 * `SLAM_TELEGRAPH_TICKS` is the chain's, and a bullet's `dx`/`dy` are per tick, so the
 * horizon is a tick count and no `tickMs` enters it.
 */
const BULLET_HORIZON_TICKS = SLAM_TELEGRAPH_TICKS;

/**
 * Squared distance of a bullet's CLOSEST APPROACH to the nearest live raider inside the
 * next {@link BULLET_HORIZON_TICKS}. `Infinity` when nobody is alive to be hit.
 *
 * The bullet travels `(dx, dy)` per tick from `(x, y)`, so against a raider at `r` the
 * approach is minimised at `t = (r·d)/(d·d)` — clamped into `[0, horizon]`, which is what
 * makes the two ends behave. A bullet that has already gone past everyone clamps to `t = 0`
 * and is scored on how far away it is NOW, so it ranks worst; one that will not arrive
 * inside the wind-up clamps to the horizon and is scored on how near it gets by then.
 * Squared throughout: nothing here needs the metre, only the order.
 */
function bulletRisk(b: Bullet, slots: readonly PlayerSlot[]): number {
  const dd = b.dx * b.dx + b.dy * b.dy;
  let best = Infinity;
  for (const p of slots) {
    if (!p.occupied || p.hp === 0) continue;
    const rx = p.x - b.x;
    const ry = p.y - b.y;
    let t = dd === 0 ? 0 : (rx * b.dx + ry * b.dy) / dd;
    if (t < 0) t = 0;
    else if (t > BULLET_HORIZON_TICKS) t = BULLET_HORIZON_TICKS;
    const mx = rx - t * b.dx;
    const my = ry - t * b.dy;
    const m = mx * mx + my * my;
    if (m < best) best = m;
  }
  return best;
}

/**
 * Which pool slots get a `<line>`: every live bullet while the pool holds no more than
 * {@link VISIBLE_BULLETS}, and past that the {@link VISIBLE_BULLETS} most DANGEROUS ones.
 *
 * Slot index is arrival order in a ring, not danger, so a first-32 slice drops whichever
 * bullets happen to sit high in the pool — including the one arriving at the player's feet
 * while thirty-one that already missed are drawn. Ranking by {@link bulletRisk} keeps the
 * ones converging on somebody and spends the cut on the ones that have already gone past,
 * which is the only class a player can safely be shown fewer of.
 *
 * The scan is `O(live x seats)` and runs ONLY over the cap — at the 13-15 bullets the live
 * instrument sees at 20 seats (spec §12.11) this is the plain filter it was before, and the
 * ranking costs nothing until there is something to rank. Returned in ascending slot order
 * so the drawn list stays monotone and React reorders nothing it does not have to.
 *
 * Pure, so the cap and the ranking are both checkable without a renderer.
 */
/** Room A's bullet list. A module constant, so it is not a fresh array every render. */
const NO_BULLETS: readonly number[] = [];

/**
 * The ordnance atlas as React wants it, built ONCE. React 19 does not compare `__html`:
 * `setProp` assigns `innerHTML` whenever the prop OBJECT is a new one, so an inline
 * `{ __html: ORDNANCE_DEFS }` re-parsed the eighteen symbols and rebuilt every `<use>`
 * shadow tree in the scene on every one of the ~380 renders a second this file makes in a
 * fight. Measured (`scripts/spike/framebudget/run-ab35-defs.log`, 20 seats, 24 bullets,
 * 1920x1080, 6x throttle): that one object was 9.8 % of all sampled time in `setProp`.
 */
const ORDNANCE_HTML = { __html: ORDNANCE_DEFS } as const;
const FIRE_HTML = { __html: FIRE_DEFS } as const;

function visibleBullets(bullets: readonly Bullet[], slots: readonly PlayerSlot[]): number[] {
  const live: number[] = [];
  for (let slot = 0; slot < bullets.length; slot++) {
    if (bullets[slot]!.active !== 0) live.push(slot);
  }
  if (live.length <= VISIBLE_BULLETS) return live;
  const risk = live.map((slot) => bulletRisk(bullets[slot]!, slots));
  // Sorted by rank, then cut, then put back in slot order. `sort` is stable, so with no
  // live raider (every risk `Infinity`) this degrades to exactly the index-order slice —
  // which is why the comparator is a three-way and not a subtraction: `Infinity - Infinity`
  // is `NaN`, and a comparator that returns `NaN` has no defined order at all.
  return live
    .map((_, i) => i)
    .sort((a, b) => (risk[a]! === risk[b]! ? 0 : risk[a]! < risk[b]! ? -1 : 1))
    .slice(0, VISIBLE_BULLETS)
    .map((i) => live[i]!)
    .sort((a, b) => a - b);
}

/**
 * Which of the sixteen tail sprites a velocity gets: `ord-b0` points along +x and the
 * sectors run clockwise with y down, 22.5° a step — the atlas is drawn in the SVG's own
 * frame, so this is `atan2` and nothing else. Chosen once per node by React, never in
 * the frame loop; a bullet's velocity is fixed for its whole flight.
 */
function sector(dx: number, dy: number): number {
  return Math.round(Math.atan2(dy, dx) / (Math.PI / 8)) & 15;
}

/**
 * Move `at` toward `to` by at most `step` units. Snaps when the target is within reach, or
 * when the gap is a teleport rather than a walk. Mutated in place: this runs every frame.
 *
 * Exported with `MOVE_MS` so `scripts/spike/perf_choppy.ts` measures the frame-by-frame
 * displacement of the *real* chase against the real predictor, rather than a copy of it
 * that could be smooth while the shipped one is not.
 */
export function chase(at: { x: number; y: number }, to: { x: number; y: number }, step: number): void {
  const dx = to.x - at.x;
  const dy = to.y - at.y;
  const d = Math.hypot(dx, dy);
  if (d <= step || d > SELF_SNAP) {
    at.x = to.x;
    at.y = to.y;
    return;
  }
  at.x += (dx * step) / d;
  at.y += (dy * step) / d;
}

// ---------------------------------------------------------------------------
// Feel: hit stop and shake
// ---------------------------------------------------------------------------
//
// Two module-scope sinks in the shape of `Shot`'s `fireLocal`, called when the local
// player's charged shot lands: there is exactly one arena renderer on a page, so a call
// is one import rather than a prop threaded through three layers. Both are no-ops under
// reduced motion, which the mounted `Arena` mirrors into `reducedNow` from the one
// resolver (`usePrefersReducedMotion`) rather than asking `matchMedia` a second time.

/** The frame loop skips its bullet and local-seat writes until this instant. */
let hitStopUntil = 0;
/** The root `<svg>`, held while an `Arena` is mounted. */
let shakeRoot: SVGSVGElement | null = null;
let reducedNow = false;

/**
 * How long a shake and a muzzle burst last. Cosmetic and local, like `CAMERA_MS`: nothing
 * on chain waits for either and no two clients need to agree on them.
 */
const SHAKE_MS = 160;
const BURST_MS = 150;

/**
 * Freeze the picture for `ms`: bullets and the local seat keep their last drawn
 * transform and snap forward when it ends — the seat is PLACED, not chased, exactly as
 * after a passage hold. The rAF loop keeps running and `Shot` keeps stepping, so the
 * arrow that earned the stop still lands.
 */
export function hitStop(ms: number): void {
  if (reducedNow) return;
  hitStopUntil = performance.now() + ms;
}

/**
 * Kick the ROOT `<svg>` by `units` world units, settling over {@link SHAKE_MS}. The root
 * and never `#camera`: `Passage` borrows `#camera` for the gate move, and a node with
 * two writers silently drops one of them. Units become CSS pixels through the live fit,
 * so the kick is the same fraction of the room on every stage.
 */
export function shake(units: number): void {
  const root = shakeRoot;
  if (reducedNow || root === null) return;
  const px = units * (root.getScreenCTM()?.a ?? 1);
  root.animate(
    [
      { transform: `translate(${px}px, ${-px / 2}px)` },
      { transform: `translate(${-px}px, ${px / 2}px)` },
      { transform: `translate(${px / 2}px, 0)` },
      { transform: 'translate(0, 0)' },
    ],
    { duration: SHAKE_MS },
  );
}

// ---------------------------------------------------------------------------
// The gate move, and the room contract
// ---------------------------------------------------------------------------

/**
 * How long the pit reveal takes, and the curve it takes it on. A camera has no twin on
 * chain — a local number, like `SHAKE_MS` and `BURST_MS` above, because nothing on chain
 * is waiting for it and no two clients need to agree on it.
 *
 * Exported rather than used here: `#camera` rests at identity in both rooms and `Passage`
 * is its only writer (spec §7.3). Restating 900 there would be one fact stored twice, which
 * is the defect this project keeps paying for.
 */
export const CAMERA_MS = 900;
export const CAMERA_EASE = 'cubic-bezier(0.65, 0, 0.20, 1)';

/**
 * Longest a passage hold may freeze the local seat, whatever `Passage` does or fails to do.
 *
 * The third of the hold's three independent releases (spec §7.3), and the only one that
 * survives a `Passage` that never unmounts, never resolves and never cleans up — including
 * a player who tabs out mid-passage, since WAAPI pauses on a hidden document and
 * `cover.finished` then never settles. 2.2x the longest legitimate cover (1,100 ms of beat,
 * 460 ms of it opaque), so it never fires on a healthy path and always fires on a broken
 * one. A leaked hold is a knight frozen for the rest of the match.
 */
const HOLD_CEILING_MS = 1000;

/** Which room a `zone` byte names. The only place the two vocabularies are joined. */
export const roomOf = (zone: number): Room => (zone === ZONE_ARENA ? 'arena' : 'lobby');

/**
 * Is this seat's content drawn right now? R3, and the ONE answer to it — the seat loop
 * below filters on it, and `Shot` gates arrows and damage numbers on it, because a seat
 * and the arrow it looses are the same fact and one fact stored twice is what this repo
 * keeps paying for.
 *
 * `VIEW_LOBBY` (y 432..1088) and `VIEW_ARENA` (y -48..608) overlap in world space, and room
 * A authors a gate tower over what is really pit floor. That is only safe while nobody in
 * the other zone is drawn: a seat still in the lobby, painted onto the arena frame, lands
 * 400 units below the pit; an ally in the pit, painted onto the lobby frame, stands behind
 * room A's fake masonry. Both read as a rendering bug rather than as the framing.
 *
 * THE ROOM ON SCREEN DECIDES, never a zone compared against the local player's zone. The
 * two answers differ by construction for the whole of a gate cover, because `Passage` lags
 * `room` behind the chain on purpose (spec §7.3): gate an ally's arrow on raw zone and it
 * is drawn at pit coordinates over the waiting room, under a veil still fading in.
 *
 * `holdSeat` is the single exception and it is the local player's own seat. The payload
 * that flips `zone` to `ZONE_ARENA` lands one commit BEFORE `Passage` can open the beat,
 * so without it the local knight is unmounted from room A with nothing covering it — "I
 * cannot see my character", at the exact moment the beat exists to prevent it. Held, the
 * seat stays mounted in whatever room is on screen and the frozen frame loop leaves it at
 * its last drawn position, which is what `hold` has always claimed to do.
 *
 * Deliberate consequence, so it is not reported as a defect: during a muster a player in
 * the pit no longer sees allies still in the lobby, and vice versa. They are in a different
 * room behind a shut gate, and the HUD roster already reports the count.
 */
export function seatShown(slot: PlayerSlot, room: Room, holdSeat?: number): boolean {
  if (holdSeat !== undefined && slot.seat === holdSeat) return true;
  return roomOf(slot.zone) === room;
}

/**
 * The seats drawn in the room on screen, in paint order.
 *
 * Pure, and the paint order is still `knightDrawOrder`'s — this only removes seats from it,
 * so two knights in the same room keep the depth order they had, and an empty seat is
 * dropped there rather than here.
 */
export function roomSeats(slots: readonly PlayerSlot[], room: Room, holdSeat?: number): PlayerSlot[] {
  return knightDrawOrder(slots).filter((s) => seatShown(s, room, holdSeat));
}

/**
 * How far BELOW its own origin the boss can still be hit, in boss-local units.
 *
 * The clip on the drawn rig is derived from this and never typed, because the art and the
 * hitboxes disagreeing is one fact stored twice and it fails silently in the ugliest way
 * this file has: `#heartrot-boss-clip` used to cut the rig at `PIT_BOT + 1 = 608` while
 * `PART_HITBOXES` reaches boss-local y 312 — world 712 at `BOSS_SPAWN` — so 104 units of
 * mace arm and claw were hittable and drawn nowhere. An arrow fired down the pit stopped
 * dead in mid-air and sparked gold on empty stone, and the chain scored the damage.
 *
 * The chain owns the table, so the art moves to it: `Rect::contains` is half-open, so
 * `y + h` is the first unit NOT hittable and is exactly the right cut. The vent is a
 * circle, so it contributes its centre plus its radius.
 */
const BOSS_HIT_BOT = Math.max(
  CORE.y + Math.sqrt(CORE.radiusSq),
  ...PART_HITBOXES.map((r) => r.y + r.h),
);

// ---------------------------------------------------------------------------
// Telegraph geometry
// ---------------------------------------------------------------------------

/**
 * The seat `<g>`'s only style, hoisted so the twenty of them share one object.
 *
 * `will-change` measured as a no-op on a real GPU and 36-85x on software raster: one free
 * line for the devices nobody tested. Module scope rather than an inline literal because
 * this file renders at notification rate and twenty fresh objects a render is twenty style
 * diffs React can otherwise skip on reference alone.
 */
const SEAT_STYLE = { willChange: 'transform' } as const;

/** The lane a slam claims, floor to ceiling of the raider box. */
const LANE_H = PIT_BOT - PIT_TOP + 1;

/**
 * The volley currently being wound up: which live muzzle fires at whom, and how long is
 * left. `spawn_volley` aims every barrel at the nearest live player and gates each one on
 * its own thorn's HP, so this is the *exact* set of lines about to be drawn in bullets —
 * derived from `attack_timer`, `target_seat`, `parts` and `MUZZLES`, all published.
 *
 * It reuses `SLAM_TELEGRAPH_TICKS` as its window rather than inventing a second one: the
 * game has one wind-up length, the chain publishes it, and two wind-ups of different
 * lengths would teach the player two different things about the same 1.5 seconds.
 */
function volleyTelegraph(
  arena: ArenaAccount,
  boss: BossAccount,
  players: PlayersAccount,
): { lines: Array<readonly [number, number, number, number]>; ticksToImpact: number } | null {
  if (arena.phase !== PHASE_FIGHTING) return null;
  if (boss.targetSeat === NO_TARGET) return null;
  // `attack_timer` is decremented every tick and the volley leaves on the tick it reads
  // zero, so the published value IS the number of ticks until impact.
  if (boss.attackTimer > SLAM_TELEGRAPH_TICKS) return null;
  const target = players.slots[boss.targetSeat];
  if (target === undefined || !target.occupied || target.hp === 0) return null;

  const lines: Array<readonly [number, number, number, number]> = [];
  for (const m of MUZZLES) {
    if ((boss.parts[m.part] ?? 0) === 0) continue;
    lines.push([boss.x + m.x, boss.y + m.y, target.x, target.y] as const);
  }
  return lines.length === 0 ? null : { lines, ticksToImpact: boss.attackTimer };
}

/**
 * Hellfire: the slam's lane as rings of fire on the stone with a flame standing in each,
 * from the owner's reference. Two rings a lane (one where the floor is short), placed on
 * the STANDABLE floor of that lane — the dais tiles a raider can be hit on, read off the
 * generated map — and below the creature's feet, because a ring drawn up on the boss's own
 * body warned nobody and hid the boss. The chain's danger is still the whole lane; a faint
 * haze over the exact rect keeps that readable, the rings say where you would be standing.
 */
const RING_RX = FIRE_RING.rx;
const RING_RY = FIRE_RING.ry;
/** How far in from the floor's ends the first and last ring sit. */
const RING_INSET = 34;
/** A ring per this much floor, two at least where there is room for two. */
const RING_EVERY = 100;
/** Where the rings of every lane sit, computed once from the map. Lanes with no floor are
 *  empty — the chain never slams them, since no raider can stand there. */
const LANE_RINGS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = Array.from({ length: SLAM_LANES }, (_, lane) => {
  const cx = lane * SLAM_LANE_W + SLAM_LANE_W / 2;
  const floor = (y: number): boolean => [cx - RING_RX * 0.8, cx, cx + RING_RX * 0.8].every((x) => !isWall(x, y) && onDais(x, y));
  // The lowest run of standable rows in the lane, and only below the creature's feet.
  let top = -1;
  let bot = -1;
  for (let y = PIT_TOP; y <= PIT_BOT; y += MAP_TILE) {
    if (!floor(y)) continue;
    if (top < 0) top = y;
    bot = y;
  }
  if (top < 0) return [];
  top = Math.max(top, BOSS_SPAWN[1] + 40);
  const span = bot - top;
  if (span < RING_EVERY / 2) return [];
  const n = span >= RING_EVERY ? Math.max(2, Math.round(span / RING_EVERY)) : 1;
  const a = top + RING_INSET;
  const b = bot - RING_INSET;
  return Array.from({ length: n }, (_, k) => [cx, Math.round(n === 1 ? (a + b) / 2 : a + ((b - a) * k) / (n - 1))] as const);
});

/**
 * One lane of hellfire, in two stages. THE WARNING is the circle alone: the red glow on
 * the stone, the ring with its runes, and a fill growing out of each ring's centre over
 * the wind-up — `fills` seeked by `Arena` off the chain's countdown, one animation per node
 * (`useSeekedAll`), so the countdown IS the size of the circle and it runs on the chain's
 * clock and no other. THE ERUPTION is the fire, mounted by `Arena` for `ERUPT_MS` on the
 * landing tick and never before: the pixel flame stands up out of every ring at once,
 * burns through its frames, and dies down (`.hr-hell-erupt`). Nothing per frame in JS.
 * Under reduced motion the rings are drawn full and still and the fire holds one frame.
 *
 * Nodes: 1 haze + 4 × (glow, fill group + ellipse, ring window + use, and in the eruption
 * a group + window + use) = 33 at most. The fire is `tools/gen_fire.py`'s frames, so the
 * flames MOVE frame to frame instead of shapes being scaled; no filter, no mask.
 */
function HellLane({
  lane,
  stage,
  fills,
  reduced,
}: {
  lane: number;
  /** `warn`: the rings alone, glowing, each fill growing out of its centre over the
   *  wind-up. `erupt`: the fire, standing up out of every ring at once and dying down. */
  stage: 'warn' | 'erupt';
  fills?: React.MutableRefObject<(SVGGElement | null)[]>;
  reduced: boolean;
}): ReactNode {
  const erupt = stage === 'erupt';
  const x = lane * SLAM_LANE_W;
  return (
    <>
      <rect className="hr-hell-haze" x={x} y={PIT_TOP} width={SLAM_LANE_W} height={LANE_H} fill="url(#hr-hell-haze-g)" />
      {(LANE_RINGS[lane] ?? []).map(([cx, cy], k) => {
        const origin = `${cx}px ${cy}px`;
        return (
          <g key={k} style={{ '--i': k } as CSSProperties}>
            <ellipse className="hr-hell-glow" cx={cx} cy={cy} rx={RING_RX * 1.7} ry={RING_RY * 2.2} fill="url(#hr-hell-glow-g)" />
            <g
              ref={(el) => {
                if (fills) fills.current[k] = el;
              }}
              style={{ transformOrigin: origin, transform: reduced || erupt ? undefined : 'scale(0.05)' }}
            >
              <ellipse className="hr-hell-fill" cx={cx} cy={cy} rx={RING_RX} ry={RING_RY} fill="url(#hr-hell-fill-g)" />
            </g>
            {/* The rune ring, `tools/gen_fire.py`'s two frames through a frame-sized window,
                stepped by CSS. Pixel art on the stone, like everything else on it. */}
            <svg x={cx - FIRE_RING.w / 2} y={cy - FIRE_RING.h / 2} width={FIRE_RING.w} height={FIRE_RING.h} aria-hidden="true">
              <use className="hr-ring-frames" href="#fire-ring" width={FIRE_RING.w * FIRE_RING.frames} height={FIRE_RING.h} style={{ '--strip': `${-FIRE_RING.w * FIRE_RING.frames}px` } as CSSProperties} />
            </svg>
            {erupt && (
              /* The fire: the eight-frame flame loop through its window, its base on the
                 ring's centre, stood up by `.hr-hell-erupt` and stepped by `.hr-fire-frames`.
                 Two nodes; the frames are the animation. */
              <g className="hr-hell-erupt" style={{ transformOrigin: `${cx}px ${cy + 3}px` }}>
                <svg x={cx - FIRE_PILLAR.w / 2} y={cy + 3 - FIRE_PILLAR.h} width={FIRE_PILLAR.w} height={FIRE_PILLAR.h} aria-hidden="true">
                  <use className="hr-fire-frames" href="#fire-pillar" width={FIRE_PILLAR.w * FIRE_PILLAR.frames} height={FIRE_PILLAR.h} style={{ '--strip': `${-FIRE_PILLAR.w * FIRE_PILLAR.frames}px` } as CSSProperties} />
                </svg>
              </g>
            )}
          </g>
        );
      })}
    </>
  );
}

/**
 * The predicted seat's slot: authoritative in every field except the three the prediction
 * already owns.
 *
 * `Arena` draws the local seat's `<g>` from `predictor.self` but was handing `Knight` the
 * authoritative slot, so the body moved ~32 ms after the keypress while the gait and the
 * facing flip — which `advance` folds out of `x`/`y`/`facing` — started a round trip later
 * and kept running that long after the player stopped (`docs/review/render.md` finding 5).
 *
 * The identity discipline is the whole of the risk. `Knight` folds a snapshot exactly when
 * the object it is handed is a NEW one (`Knight.tsx:259`), so a fresh object per render
 * would re-fold at the render rate and double-count every shot and every hurt, while one
 * mutated in place would never fold again at all. So: a cached object, replaced only when
 * something it carries actually changed — one fold per authoritative payload, as before,
 * plus one per predicted step. The extra folds are pure value diffs on `hp`, `deaths` and
 * `lastShotTick` (`Knight.tsx:186`), so a fold that carries no event fires nothing.
 */
function predictedSlot(
  cache: { src: PlayerSlot | null; out: PlayerSlot | null },
  slot: PlayerSlot,
  self: PredictedSelf,
): PlayerSlot {
  const out = cache.out;
  if (
    out !== null &&
    cache.src === slot &&
    out.x === self.x &&
    out.y === self.y &&
    out.facing === self.facing
  ) {
    return out;
  }
  cache.src = slot;
  cache.out = { ...slot, x: self.x, y: self.y, facing: self.facing };
  return cache.out;
}

export interface ArenaProps {
  arena: ArenaAccount;
  boss: BossAccount;
  players: PlayersAccount;
  /** Seat the local player drives, ringed so they can find themselves among twenty. */
  localSeat?: number;
  /**
   * The local player's prediction. Given one, `localSeat` is drawn from `predictor.self`
   * at input rate instead of from the authoritative snapshot stream — the crank rewrites
   * `Players` every 100 ms with no position change in it, and interpolating P→P is the
   * "still, still, still, JUMP" the fight is reported to move with. Omit it and every
   * seat interpolates, which is what a spectator wants anyway.
   */
  predictor?: Predictor;
  /**
   * Target ms between ticks, from `/api/session/init`. Only ever used to pace bullet
   * extrapolation and to seek a telegraph — never to derive game state. `arena.tick` is
   * the clock; the crank promises no wall-clock period.
   */
  tickMs?: number;
  /**
   * Which room is on screen. `Passage` owns it, because during the 460 ms cover it and the
   * seat's own `zone` disagree ON PURPOSE — the swap hangs off `cover.finished` so the
   * outgoing room is unmounted only once the veil is opaque (spec §7.3).
   *
   * Absent, it falls back to the one rule in §1.7: the local seat's `zone`, and the phase
   * when there is no seat. That fallback is the whole behaviour with no `Passage` mounted,
   * so this file is correct on its own and `Passage` only adds the beat.
   */
  room?: Room;
  /**
   * Freeze the local seat while the veil is opaque. While set the frame loop writes no
   * transform, so the knight holds its last drawn position and is PLACED at the entrance on
   * release rather than chased 387 units across the room in front of the player.
   *
   * A HINT, not the trigger. The hold that matters is derived here from `room` disagreeing
   * with the local seat's own zone, because that is true one commit earlier than `Passage`
   * can set this — and that commit is where the knight used to disappear. This prop only
   * extends the freeze past the cut on the paths where `Passage` keeps it set.
   *
   * Release 3 of 3 lives here as {@link HOLD_CEILING_MS}: whatever `Passage` does, the hold
   * expires. The other two are `cover.finished` and `Passage`'s own effect cleanup.
   */
  hold?: boolean;
  /**
   * Row 16: the passage veils and the teal wash, mounted after `Spawn` so the veil covers
   * the flare when both fire. A slot rather than an import, because `Passage` owns `room`
   * and `hold` above it — it renders `<Arena>`, and its veils have to land INSIDE this
   * `<svg>` to be in the camera's space.
   */
  veil?: ReactNode;
  /**
   * Bumped by the store whenever the feed drops and resubscribes. Forwarded to BOTH
   * readers, `Shot` and `Spawn`: a diff baseline that is not reseeded replays every shot
   * and every cinematic a reconnect re-delivers — the bug `Spawn.tsx` shipped with, and
   * the reason a resync gate exists at
   * all rather than reading `state.status` (which `store.ts:415` forces to `'live'` on
   * every payload, so it races the thing it gates).
   */
  feedEpoch?: number;
  className?: string;
}

/** `ticks` of the chain's clock as m:ss, floored at zero — the gate's muster countdown. */
function clockOf(ticks: number): string {
  const total = Math.max(0, Math.round((ticks * TICK_MS) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** How many ticks a bullet may fly on its own velocity past the last tick the feed delivered. */
const BULLET_LOOKAHEAD = 6;

export function Arena({
  arena,
  boss,
  players,
  localSeat,
  predictor,
  tickMs = TICK_MS,
  room,
  hold = false,
  veil,
  feedEpoch = 0,
  className,
}: ArenaProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reduced = usePrefersReducedMotion();
  // The gate this raid went through, for the muster clock. `difficulty` is a clamped
  // chain byte and `GATES` has one entry per tier, so the lookup only misses on a table
  // the generator refused to write; the clock then draws nowhere rather than throwing.
  const raidGate = GATES[arena.difficulty];

  const localSlot = localSeat === undefined ? undefined : players.slots[localSeat];
  // §1.7's ONE rule, and the shipped `wide = phase === LOBBY || MUSTERING` is deleted with
  // the camera: `enter_gate` flips one seat to `ZONE_ARENA` while the arena is still
  // MUSTERING, so a phase-derived framing showed the lobby to a player already through the
  // gate. The seat's own zone is the only thing that knows which side of the door it is on.
  const shown: Room =
    room ??
    (localSlot?.occupied === true
      ? roomOf(localSlot.zone)
      : arena.phase === PHASE_LOBBY || arena.phase === PHASE_MUSTERING
        ? 'lobby'
        : 'arena');

  // A passage is in flight exactly while the room on screen and the local seat's own zone
  // disagree — `Passage` holds `room` back for the length of the cover on purpose. Derived
  // here rather than taken from the `hold` prop because it is true in the SAME commit the
  // payload lands in, and `hold` cannot be until `Passage`'s passive effect has run and a
  // second render has reached its layout effect. That one commit is the whole of the
  // defect: it unmounted the local knight with the veil still at opacity 0.
  //
  // With no `Passage` mounted `shown` is derived from this very zone, so it is never set.
  const crossing = localSlot?.occupied === true && roomOf(localSlot.zone) !== shown;
  const holding = hold || crossing;

  // Sole writer of the `viewBox`. No React attribute, no second source for the framing:
  // two writers of one size is the defect class this repo keeps paying for.
  useViewport(shown, boxRef, svgRef);

  // `tickMs`, not the `TICK_MS` default: the ceiling on the interpolation window has to be
  // the crank period the worker actually reports, or every remote seat paces itself against
  // a 100 ms the crank never promised (`docs/review/render.md`, minor 1).
  //
  // And a crank period, not `MOVE_MS`. That swap has been tried and measured against two
  // guests in one live arena: it leaves the p50 settle exactly where it is (46.6 → 47.5 ms)
  // and adds stalled frames (37.2 → 38.5%), because the ceiling is not on the p50 path at
  // all. `retarget`'s doc in `net/predict.ts` carries the table.
  const seats = useSeatInterpolation(players, reduced, tickMs);

  // Latest snapshot and the moment its tick landed, read by the rAF loop without the loop
  // being torn down and rebuilt every tick.
  const bullets = useRef(arena.bullets);
  const pace = useRef(tickMs);
  const tickAt = useRef(0);
  // The four muzzle bursts, one strip per thorn, indexed like `MUZZLES`.
  const burstNodes = useRef<(SVGUseElement | null)[]>([]);
  useEffect(() => {
    const prev = bullets.current;
    const next = arena.bullets;
    // A volley leaves the pool as slots turning free→active AT a muzzle: `spawn_volley`
    // writes the muzzle's own point into `x`/`y`, and the bullet does not move until the
    // next tick. That edge plays the thorn's burst and the `volley` cue — once per muzzle
    // per tick however many bullets it fired — and it is taken on VALUES rather than on
    // the array: every delivery decodes into a fresh object, the Magic Router delivers
    // each one twice, and identical bytes have no edge in them. A slot reused inside one
    // missed notification (active before, at another point) counts as an edge too.
    if (prev !== next) {
      let fired = 0;
      for (let slot = 0; slot < next.length; slot++) {
        const b = next[slot]!;
        const was = prev[slot];
        if (b.active === 0 || (was !== undefined && was.active !== 0 && was.x === b.x && was.y === b.y)) continue;
        for (const [i, m] of MUZZLES.entries()) {
          if (b.x === boss.x + m.x && b.y === boss.y + m.y) fired |= 1 << i;
        }
      }
      if (fired !== 0) {
        play('volley');
        if (!reduced) {
          for (const [i, el] of burstNodes.current.entries()) {
            if (el !== null && (fired & (1 << i)) !== 0) el.animate(BURST_KEYFRAMES, BURST_TIMING);
          }
        }
      }
    }
    bullets.current = next;
    pace.current = tickMs;
  });
  // `hitStop` and `shake` see the root and the motion preference only while an `Arena`
  // is mounted. One effect for both: they are two facts about the one mounted scene.
  useEffect(() => {
    shakeRoot = svgRef.current;
    reducedNow = reduced;
    return () => {
      shakeRoot = null;
    };
  }, [reduced]);
  useEffect(() => {
    tickAt.current = performance.now();
  }, [arena.tick]);

  const nodes = useRef(new Map<number, SVGUseElement>());
  // `Shot`'s per-frame step, driven from the ONE rAF loop in the scene. A second loop is
  // what that module exists not to add, so the driver is a mandatory prop over there and
  // this ref is the whole of the wiring.
  const shotFrame = useRef<((now: number) => void) | null>(null);
  // The local seat's `<g>`, owned by the frame loop the way `nodes` owns the bullets.
  const selfNode = useRef<SVGGElement | null>(null);
  // The gates' under-foot lights, one per tier. Same ownership rule: the frame loop writes
  // their opacity and React never does, so standing on a tile lights it at input rate
  // rather than 127 ms later (`docs/review/render.md` finding 4). They hint;
  // `useGateEntry` still sends.
  const gateNodes = useRef<(SVGRectElement | null)[]>([]);
  const drawn = useRef<{ x: number; y: number } | null>(null);
  const frameAt = useRef(0);
  // The hold, read by the frame loop rather than closed over: the loop must not be torn
  // down and rebuilt when the veil opens. `heldAt` is what makes the ceiling a WALL clock
  // and not a frame count — a backgrounded tab runs no frames at all, and that is exactly
  // the case release 3 exists for.
  const held = useRef(false);
  const heldAt = useRef(0);
  if (held.current !== holding) {
    held.current = holding;
    heldAt.current = performance.now();
  }
  // Placed on attach, not on the next frame: a seat that waits for one sits at the SVG
  // origin, which reads as the knight teleporting to the corner. Stable while `predictor`
  // is, so React does not detach and reattach the node on every update.
  const selfRef = useCallback(
    (el: SVGGElement | null) => {
      selfNode.current = el;
      // A new node starts where the prediction is; chasing from wherever the last one
      // stopped would drag the knight in from the old seat's position.
      drawn.current = null;
      if (el === null || predictor === undefined) return;
      el.style.transform = `translate(${predictor.self.x}px, ${predictor.self.y}px)`;
    },
    [predictor],
  );
  useEffect(() => {
    // Unconditional. Under reduced motion bullets snap to each published position — React
    // already writes that transform — but the local seat has no transform of its own to
    // snap to, and `Shot` still needs its step called to land arrows and retire flights.
    // The loop used to bail for a reduced-motion spectator; that would leave every arrow
    // parked at its bow with no error anywhere.
    let raf = 0;
    const frame = () => {
      const now = performance.now();
      // A hit stop holds the two writers below for its length; both snap forward after.
      const stopped = now < hitStopUntil;
      if (!reduced && !stopped) {
        // Up to BULLET_LOOKAHEAD ticks past the last one, not one. A bullet's velocity is
        // fixed for its whole flight, so extrapolating along it through a feed stall is
        // exact until the next tick lands; clamping at 1 froze every bullet in the air for
        // the length of the stall and then jumped it. Measured live on Sep 4 2026: feed
        // stalls of 0.6–1.4 s in a fight. A bullet that hits something during the stall is
        // freed by the tick that reports it, which is when it disappears — one tick late.
        const f = Math.min(BULLET_LOOKAHEAD, (now - tickAt.current) / pace.current);
        for (const [slot, el] of nodes.current) {
          const b = bullets.current[slot];
          if (b === undefined) continue;
          el.style.transform = `translate(${b.x + b.dx * f}px, ${b.y + b.dy * f}px)`;
        }
      }

      // One more node per frame, off the predicted position rather than the feed, so the
      // knight the player is watching moves when they press a key and not when Singapore
      // says so. Under reduced motion the step is unbounded, which is a snap.
      //
      // Under the passage hold it writes nothing at all: the knight keeps its last drawn
      // transform under an opaque veil, and clearing `drawn` means the next unheld frame
      // PLACES it at the entrance `enter_gate` chose instead of chasing it there. The
      // ceiling is the release that does not depend on `Passage` being well behaved.
      const el = selfNode.current;
      const frozen = stopped || (held.current && now - heldAt.current < HOLD_CEILING_MS);
      if (frozen) drawn.current = null;
      else if (el !== null && predictor !== undefined) {
        let at = drawn.current;
        if (at === null) at = drawn.current = { x: predictor.self.x, y: predictor.self.y };
        // Real elapsed time, not an assumed 1/60: a 144 Hz screen would otherwise chase
        // 2.4× too slowly. Capped at one input period so a backgrounded tab resumes with
        // a single step rather than a sprint across the room.
        const dt = Math.min(MOVE_MS, now - frameAt.current);
        chase(at, predictor.self, reduced ? Infinity : (MAP_TILE * dt) / MOVE_MS);
        el.style.transform = `translate(${at.x}px, ${at.y}px)`;

        // Off the DRAWN position, not the authoritative one: the light has to appear under
        // the foot the player can see, and `gateAt` is the same predicate `enter_gate`
        // checks. Written only on a change — this runs every frame and the value flips
        // twice per visit; three compares a frame, no allocation.
        const here = gateAt(at.x, at.y);
        for (let tier = 0; tier < gateNodes.current.length; tier++) {
          const gate = gateNodes.current[tier];
          if (gate == null) continue;
          const lit = here === tier ? '1' : '0';
          if (gate.style.opacity !== lit) gate.style.opacity = lit;
        }
      }

      // The arrows, last: they are drawn over the bodies this loop has just placed, and
      // `Shot` reads no state of its own from the loop beyond `now`.
      shotFrame.current?.(now);

      frameAt.current = now;
      raf = requestAnimationFrame(frame);
    };
    frameAt.current = performance.now();
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced, predictor]);

  // ---- the two telegraphs -----------------------------------------------
  //
  // SEEKED, per the animation contract: one animation built at its true duration, its
  // `currentTime` set from the chain's own countdown on each notification. It runs
  // composited between notifications and self-corrects on every one, and it never touches
  // the rAF loop. Both dedupe on the countdown VALUE, so the Magic Router's duplicate
  // delivery re-seeks nothing.
  // The wind-up, in ms, from the chain's own tick count and the crank period the worker
  // reports — the SAME `tickMs` the elapsed times below are seeked with. Deriving the
  // duration from the `TICK_MS` constant while seeking with the prop put the animation and
  // its playhead on two different clocks the moment the crank ran at anything but 100 ms
  // (`docs/review/render.md`, minor 1).
  const windupMs = SLAM_TELEGRAPH_TICKS * tickMs;

  const slam = slamTelegraph(arena, boss);
  const slamRef = useRef<SVGGElement | null>(null);
  const slamFills = useRef<(SVGGElement | null)[]>([]);
  const slamElapsed = slam === null || reduced ? null : (SLAM_TELEGRAPH_TICKS - slam.ticksToImpact) * tickMs;
  // Two seeked animations on one clock: the lane brightening, and each ring's fill growing
  // out of its centre — both full on the landing tick.
  useSeeked(slamRef, SLAM_KEYFRAMES, windupMs, slamElapsed);
  useSeekedAll(slamFills, RING_KEYFRAMES, windupMs, slamElapsed);
  // The slam's two cues, off the same derivation the lane is drawn from: the warn when a
  // wind-up appears, the impact when it resolves. Nothing is DRAWN on the landing: the
  // fire is the telegraph and it goes out on the tick the hand comes down — a burst or a
  // shake there was "a flick after the fire" the owner had removed. Room B only, like the
  // lane, and the first render starts with nothing winding up, so a mount plays nothing.
  const slamming = shown === 'arena' && slam !== null;
  const slamHeard = useRef(false);
  const slamLaneLast = useRef(0);
  if (slam !== null) slamLaneLast.current = slam.lane;
  // The eruption: the fire itself, on the lane the wind-up was last drawn over, for
  // `ERUPT_MS` from the landing tick. State rather than a pooled node because the geyser
  // is two hundred nodes of CSS loops, and mounting them only for the second they burn is
  // what keeps a quiet floor quiet. Keyed on the landing so two slams a lane apart are two
  // fires. `play('slam')` lands on the same edge. The key is PREFIXED: the kill's group
  // beside it is keyed on the same clock, and two siblings with the same number for a key
  // (a slam landing on the tick the boss dies) made React add a group a render and remove
  // none.
  const [erupt, setErupt] = useState<{ lane: number; key: number } | null>(null);
  useEffect(() => {
    if (slamming) play('slamWarn');
    else if (slamHeard.current) {
      play('slam');
      setErupt({ lane: slamLaneLast.current, key: Date.now() });
    }
    slamHeard.current = slamming;
  }, [slamming]);
  useEffect(() => {
    if (erupt === null) return;
    const id = window.setTimeout(() => setErupt(null), ERUPT_MS);
    return () => window.clearTimeout(id);
  }, [erupt]);

  // The kill landing: the pit flashes white for `FLASH_MS`, the core shatters (`Boss.tsx`,
  // on the same edge) and embers rain over the pit for `KILL_RAIN_MS`. Mounted by state
  // on the FIGHTING → SETTLING edge with the win byte, as the eruption is on the landing:
  // a duplicate notification carries no edge, and a reconnect into a settled arena plays
  // nothing. The card reveals at 4.2 s (`Hud.tsx`, REVEAL_WIN_MS); this is over by 3.
  const [kill, setKill] = useState<number | null>(null);
  const fought = useRef(false);
  useEffect(() => {
    if (fought.current && arena.phase === PHASE_SETTLING && arena.outcome === OUTCOME_WIN) setKill(Date.now());
    fought.current = arena.phase === PHASE_FIGHTING;
  }, [arena.phase, arena.outcome]);
  useEffect(() => {
    if (kill === null) return;
    const id = window.setTimeout(() => setKill(null), KILL_RAIN_MS);
    return () => window.clearTimeout(id);
  }, [kill]);
  const flashRef = useRef<SVGRectElement | null>(null);
  useEffect(() => {
    if (kill !== null) flashRef.current?.animate(FLASH_KEYFRAMES, { duration: FLASH_MS, easing: 'ease-out', fill: 'forwards' });
  }, [kill]);

  const volley = volleyTelegraph(arena, boss, players);
  const volleyRef = useRef<SVGGElement | null>(null);
  const volleyElapsed = volley === null || reduced ? null : (SLAM_TELEGRAPH_TICKS - volley.ticksToImpact) * tickMs;
  useSeeked(volleyRef, VOLLEY_KEYFRAMES, windupMs, volleyElapsed);

  // ---- the static layers ------------------------------------------------
  //
  // Rows 1-6 — floor, markings, floor light, wall mass, props — belong to `WAITING`
  // and `BOSS_ARENA`, which are module-scope elements React never walks again. Nothing
  // static is built in here: the rim occluder that used to be was the generated wall
  // bitboard drawn a second time in flat `PAL.wall`, which over a painted room is a colour
  // mask over the painted walls — and a wall the art disagrees with is a legal-looking
  // move the chain rejects, which is this project's signature misdiagnosis.

  // Sorted at notification rate, never per frame: a knight lower on the screen is nearer,
  // so it is drawn later. Authoritative `y` on every seat including the local one — the
  // local knight drawn out of order would jump in front of an ally it is standing behind.
  // Filtered to the room on screen: R3, and the reason room A may paint a gate tower over
  // what is really pit floor.
  // The local seat is kept in the room on screen while the passage is crossing — see
  // `seatShown`. That, and not the `hold` prop, is what makes the documented hold real.
  const holdSeat = holding ? localSeat : undefined;
  const drawOrder = useMemo(
    () => roomSeats(players.slots, shown, holdSeat),
    [players, shown, holdSeat],
  );

  // Which pool slots get a node, decided once per render rather than in the JSX: `Shot`
  // needs the COUNT to know what is left of the 32, and boss ordnance ranks first.
  //
  // Room B only, and gated HERE rather than on row 11's `<g>` so that the count `Shot`
  // budgets against is the count actually drawn — one fact, one place. Rows 7, 10 and the
  // volley telegraph were already gated; row 11 was not, and spec §7.1's own table has a
  // reachable `FIGHTING / ZONE_LOBBY` state (a seat that never crossed the gate) in which
  // the boss's ordnance was painted across the waiting room. Same R3 violation a pit arrow
  // drawn in room A would be, and it is why room A carried a bullet layer it had no
  // business paying for (`docs/perf/frame-budget-17.md` §5.2).
  const shownBullets = shown === 'arena' ? visibleBullets(arena.bullets, players.slots) : NO_BULLETS;

  // One cached slot for the predicted seat, see `predictedSlot`. A ref and not a memo: it
  // is keyed on a mutable position no dependency array can watch.
  const poseCache = useRef<{ src: PlayerSlot | null; out: PlayerSlot | null }>({ src: null, out: null });

  return (
    <div
      ref={boxRef}
      className={className}
      // The flex centring is gone with the camera: there is nothing left to centre, the
      // room fills the stage. `overflow: hidden` stays because the void bleed is allowed to
      // paint past the room and must not scroll the page.
      style={{ position: 'relative', overflow: 'hidden', minHeight: 0 }}
    >
      <svg
        ref={svgRef}
        // No `viewBox` attribute: `useViewport` owns it, and React writing one too would be
        // two writers for one framing. No `width`/`height` presentation attributes either —
        // the CSS below wins and two sources for one size is the defect class this repo
        // keeps paying for.
        preserveAspectRatio="xMidYMid meet"
        // Unconditional. The integer device-pixel snap is deleted, not fixed: an integer
        // scale is available on 16 of 96 window/dpr shapes, so `crispEdges` was a coin flip
        // that reframed mid-drag for one user in six and shimmered for the other five.
        // "Sharper" is delivered as BIGGER — 1.008 to 1.573 px/unit on a 1080p screen.
        shapeRendering="geometricPrecision"
        style={{ display: 'block', width: '100%', height: '100%' }}
        role="img"
        aria-label={`Boss arena, tick ${arena.tick}, ${arena.aliveCount} raiders alive`}
      >
        <defs>
          {/* The boss ends where the boss ENDS. At SCALE=3 the sprite is 810 units tall and
              reaches world y 805 — 200 units below the pit — so the legs and the lower claw
              were drawn straight down the temple approach, over the stairs and the gate.
              That art is still cut; what is no longer cut is anything the chain can hit.
              The cut used to be `PIT_BOT + 1 = 608`, the bottom of the rim band, chosen so
              the hands read as gripping the rim. But `PART_HITBOXES` reaches world y 712 at
              `BOSS_SPAWN`, so 104 units of mace arm and claw were hittable and drawn
              nowhere: an arrow fired down the pit stopped in mid-air and sparked gold on
              bare stone while the chain scored the damage. Art that disagrees with the
              hitboxes is one fact stored twice, and the chain owns the table — so the cut
              is derived from it ({@link BOSS_HIT_BOT}) and follows `boss.y`. The painted
              room carries its own rim under the hands; nothing here redraws one.
              Clipped here rather than inside `Boss`: `clip-path` resolves against the
              element's own transform, and `.hr-boss` carries `translate(boss.x, boss.y)`,
              so a clip there moves with the boss instead of standing still in world space. */}
          <clipPath id="heartrot-boss-clip">
            <rect
              x={-ARENA_UNITS}
              y={-ARENA_UNITS}
              width={3 * ARENA_UNITS}
              height={ARENA_UNITS + boss.y + BOSS_HIT_BOT}
            />
          </clipPath>
          {/* The ordnance atlas, mounted once: sixteen tail sprites, the muzzle burst and
              the hit splat, each a `<symbol>` cropping the one PNG. Every bullet below is
              a `<use>` against these, and a dangling href renders nothing and throws
              nothing — without this line a volley is invisible and no error anywhere.
              Generated markup, so `dangerouslySetInnerHTML` is the only way to put it
              inside an SVG parent; it is a build artefact of `tools/gen_ordnance.py`, not
              anything a user can reach. */}
          <g dangerouslySetInnerHTML={ORDNANCE_HTML} />
          <g dangerouslySetInnerHTML={FIRE_HTML} />
          {/* HELLFIRE's light: the glow on the stone and the growing fill, both soft by
              GRADIENT. The fire and the ring themselves are pixel art from the atlas above. */}
          <radialGradient id="hr-hell-glow-g">
            <stop offset="0" stopColor="#ff4a1c" stopOpacity="0.34" />
            <stop offset="0.5" stopColor="#e8200c" stopOpacity="0.16" />
            <stop offset="1" stopColor="#7a0e08" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="hr-hell-fill-g">
            <stop offset="0" stopColor="#ff5a20" stopOpacity="0.42" />
            <stop offset="0.6" stopColor="#ff2a12" stopOpacity="0.3" />
            <stop offset="1" stopColor="#b0140a" stopOpacity="0.12" />
          </radialGradient>
          <radialGradient id="hr-hell-haze-g">
            <stop offset="0" stopColor="#ff2a12" stopOpacity="0.18" />
            <stop offset="0.6" stopColor="#d01c0c" stopOpacity="0.09" />
            <stop offset="1" stopColor="#7a0e08" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* `#camera` rests at IDENTITY. It carries no transform from this file, ever — it
            exists so `Passage` has one node to translate for the gate move and so
            `App.tsx`'s `aimOrigin` has one `getScreenCTM()` to aim through. No ref here:
            one writer, and it is not this one. */}
        <g id="camera" className={arena.phase === PHASE_MUSTERING ? 'is-mustering' : undefined}>
          {/* Rows 1-6: the active room, whole. Exactly one is mounted — R3 depends on it,
              and so does the frame budget: two rooms is two full scene rasters. */}
          {shown === 'lobby' ? WAITING : BOSS_ARENA}

          {/* The muster, on the raid's gate itself, for whoever is still in the lobby: the
              raider who walked through started a twenty-second clock the arena account
              carries, and the one still here needs to see it where the decision is made —
              over the gate that raid went through (`arena.difficulty`, locked by then), in
              digits, not in a corner. The static room's exclamation marks stand down while
              this stands (`.is-mustering .gate-mark`). One `<text>` per tick, ten times a
              second, on a node the static layer does not own. */}
          {shown === 'lobby' && arena.phase === PHASE_MUSTERING && raidGate !== undefined && (
            <g
              className="gate-clock"
              aria-hidden="true"
              transform={`translate(${(raidGate.minX + raidGate.maxX + 1) / 2} ${raidGate.minY - 30})`}
            >
              <text className="gate-clock-label" y={-24} textAnchor="middle">
                BOSS WAKES IN
              </text>
              <text className="gate-clock-digits" y={6} textAnchor="middle">
                {clockOf(arena.fightAtTick - arena.tick)}
              </text>
            </g>
          )}

          {/* The gates lighting up under your feet, room A only, one per tier. Not part of
              the room element because they are the one part of that layer that is not
              static — the frame loop owns their opacity and nothing else may set it, which
              is why React gives them none. Feedback, never a send: `enter_gate` stays on
              `useGateEntry`'s authoritative poll, and the version that fired from the input
              path stranded players. */}
          {shown === 'lobby' &&
            GATES.map((g, tier) => (
              <rect
                key={tier}
                ref={(el) => {
                  gateNodes.current[tier] = el;
                }}
                aria-hidden="true"
                x={g.minX}
                y={g.minY}
                width={g.maxX - g.minX + 1}
                height={g.maxY - g.minY + 1}
                fill={PAL.ventOpen}
                fillOpacity={0.3}
                stroke={PAL.ventOpen}
                strokeWidth={3}
                // Snaps rather than fades: the whole point is that it answers the keypress,
                // and a 90 ms cross-fade is 90 ms of the lag this exists to remove.
                style={{ opacity: 0, pointerEvents: 'none' }}
              />
            ))}

          {/* Rows 7-11, room B only. The boss, its telegraphs and its ordnance have no
              business in a room the pit is not in: `VIEW_LOBBY` overlaps the creature's
              lower body, so drawing it there would put a claw through room A's masonry. */}
          {shown === 'arena' && (
            <g clipPath="url(#heartrot-boss-clip)">
              <Boss boss={boss} arena={arena} />
            </g>
          )}

          {/* Row 10. Over the boss because the hand that lands in the lane is drawn over it
              too, and a wind-up you cannot see through the mace is not a wind-up. Under the
              knights, because the player is on top of everything the scene does.

              The lane is HELLFIRE in two stages. The wind-up is the WARNING: red rune rings
              down the lane the chain names, each one's fill growing out of its centre over
              the 1.5 s (`slamFills`, seeked off the chain above), the whole lane
              brightening on top — the circle that says "something is about to happen here",
              and nothing burns yet. The landing is the ERUPTION: the fire stands up out of
              every ring for `ERUPT_MS` and dies down. Keyed on the landing tick so each
              wind-up is a fresh mount. Under reduced motion the rings are drawn lit and
              still. */}
          {shown === 'arena' && slam !== null && (
            <g key={`warn-${slam.atTick}`} ref={slamRef} className="hr-hell" aria-hidden="true">
              <HellLane lane={slam.lane} stage="warn" fills={slamFills} reduced={reduced} />
            </g>
          )}
          {shown === 'arena' && erupt !== null && (
            <g key={`erupt-${erupt.key}`} className="hr-hell" aria-hidden="true">
              <HellLane lane={erupt.lane} stage="erupt" reduced={reduced} />
            </g>
          )}

          {/* Where the next volley goes. `spawn_volley` fans around exactly these lines,
              so the dashed lines are the shot itself drawn 1.5 s early; the thorns glow
              through the wind-up (`tools/gen_ordnance.py`'s two-frame strip, stepped by
              `.hr-thorn-frames`) and the raider it is aimed at wears the lock (`Knight`'s
              `targeted`). The group's seeked opacity is the countdown, on the chain's clock. */}
          {shown === 'arena' && volley !== null && (
            <g ref={volleyRef} aria-hidden="true" opacity={reduced ? 0.6 : 0}>
              {/* The dashed aim lines, thorn to raider: the owner asked for them back. They
                  are `spawn_volley`'s own lines, drawn 1.5 s early; the glow and the lock
                  below sit at their two ends. */}
              {volley.lines.map(([x1, y1, x2, y2], i) => (
                <line
                  key={`l${i}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={PAL.bossEdge}
                  strokeWidth={2}
                  strokeDasharray="6 10"
                  opacity={0.85}
                />
              ))}
              {volley.lines.map(([x1, y1], i) => (
                <svg key={i} x={x1 - ORD_THORN.w / 2} y={y1 - ORD_THORN.h / 2} width={ORD_THORN.w} height={ORD_THORN.h}>
                  <use
                    className="hr-thorn-frames"
                    href="#ord-thorn"
                    width={ORD_THORN.w * ORD_THORN.frames}
                    height={ORD_THORN.h}
                    style={{ '--strip': `${-ORD_THORN.w * ORD_THORN.frames}px`, '--i': i } as CSSProperties}
                  />
                </svg>
              ))}
            </g>
          )}

          {/* Row 11. Each bullet is one `<use>` of the sector sprite its velocity falls in
              (`tools/gen_ordnance.py`: a thorn seed dragging an ember tail, drawn at
              sixteen angles — at 42 units a tick a dot jumps ~7 units a frame and strobes,
              and the tail is what makes 420 u/s legible rather than merely correct). The
              sector is chosen once here by React; the frame loop owns the transform and
              nothing else about the node ever changes. */}
          <g>
            {shownBullets.map((slot) => {
              const b = arena.bullets[slot];
              if (b === undefined) return null;
              return (
                <use
                  key={slot}
                  ref={(el) => {
                    if (el) nodes.current.set(slot, el);
                    else nodes.current.delete(slot);
                  }}
                  href={`#ord-b${sector(b.dx, b.dy)}`}
                  x={-ORD_BULLET.w / 2}
                  y={-ORD_BULLET.h / 2}
                  width={ORD_BULLET.w}
                  height={ORD_BULLET.h}
                  style={{
                    willChange: 'transform',
                    // The published position. The frame loop overwrites this between ticks;
                    // under reduced motion it is the only thing that ever writes it.
                    transform: `translate(${b.x}px, ${b.y}px)`,
                  }}
                />
              );
            })}
            {/* The muzzle bursts: one frame-sized window per thorn, parked over its muzzle,
                with the three-frame strip behind it at opacity 0. The bullets effect plays
                one by stepping the strip across the window — WAAPI is that node's only
                writer, and React sets nothing on it after mount. Room B only, like the
                thorns they sit on. */}
            {shown === 'arena' &&
              MUZZLES.map((m, i) => (
                <svg
                  key={i}
                  aria-hidden="true"
                  x={boss.x + m.x - ORD_BURST.w / 2}
                  y={boss.y + m.y - ORD_BURST.h / 2}
                  width={ORD_BURST.w}
                  height={ORD_BURST.h}
                >
                  <use
                    ref={(el) => {
                      burstNodes.current[i] = el;
                    }}
                    href="#ord-burst"
                    width={ORD_BURST.w * ORD_BURST.frames}
                    height={ORD_BURST.h}
                    style={{ opacity: 0 }}
                  />
                </svg>
              ))}
          </g>

          {/* Row 12 — THE PLAYER IS ON TOP. Every scene layer is behind this one, and the
              only thing above it is the arrow the player fires.
              Nothing decorative may be added between here and the top: a knight occluded by
              scenery is the report this composition exists to close.

              `drawOrder` is already filtered to the room on screen (R3). */}
          <g>
            {drawOrder.map((slot) => {
              const mine = slot.seat === localSeat;
              // Prediction for the seat the player drives, interpolation for everyone else.
              // Both machines already existed; this is the line that stops the local knight
              // being drawn from ~127 ms-old chain state that the crank re-anchors.
              // `ready` and not merely `predictor !== undefined`: `self` is the arena's
              // top-left corner until the first reconcile, so an ungated seat would be drawn
              // in the corner. Unreachable through the live path — a seat only becomes
              // `occupied` in the same notification that reconciles it — but the fallback
              // here is interpolation, which is correct, rather than a teleport.
              const predicted = mine && predictor !== undefined && predictor.ready;
              // The pose reads from the same copy of the seat the transform does, or the
              // legs describe a position the body left two tiles ago.
              const posed = predicted ? predictedSlot(poseCache.current, slot, predictor.self) : slot;
              return (
                // The frame loop (local seat) or `useSeatInterpolation` (everyone else) owns
                // this node's transform outright — nothing else may put a transform
                // attribute on it, which is why `Knight` renders the CHILDREN of this node
                // and never the node. The style is {@link SEAT_STYLE}, shared by all twenty.
                <g key={slot.seat} ref={predicted ? selfRef : seats.ref(slot.seat)} style={SEAT_STYLE}>
                  <Knight slot={posed} mine={mine} reduced={reduced} targeted={volley !== null && boss.targetSeat === slot.seat} />
                </g>
              );
            })}
          </g>

          {/* Row 13. ABOVE the knights, in both rooms: the waiting area fires practice
              arrows and they have to be as visible there as in the pit, which is the whole
              of "the space bar doesn't work". An arrow drawn under twenty bodies is the "I
              cannot see anything" report with extra steps.
              `room={shown}` and not a second derivation inside `Shot`: R3 is the same fact
              `drawOrder` filters on above, and during the cover the local seat's `zone`
              already reads `ZONE_ARENA` while room A is still painted — so a layer that
              re-derives the room from `zone` draws pit arrows and pit damage numbers over
              the waiting room for the whole of the cover. `holdSeat` is deliberately NOT
              passed: the held knight is a body parked at its last drawn position, but an
              arrow it looses is loosed in the pit at pit coordinates, and drawing that in
              room A is the bug this prop exists to close, not an exception to it. */}
          <Shot
            players={players}
            boss={boss}
            localSeat={localSeat}
            reduced={reduced}
            frameRef={shotFrame}
            budget={shownBullets.length}
            feedEpoch={feedEpoch}
            room={shown}
          />

          {/* Row 15. Over the boss, the raiders and the bullets. Pointer-transparent, and
              nothing waits for it. Room B: it is the light the cavern plays when the muster
              ends, and the muster ends in the pit. */}
          {shown === 'arena' && (
            <Spawn
              phase={arena.phase}
              bossX={boss.x}
              bossY={boss.y}
              reduced={reduced}
              feedEpoch={feedEpoch}
            />
          )}

          {/* The kill, over everything in the pit: the flash (opacity-only WAAPI on one
              rect, not mounted under reduced motion — it is motion and nothing else) and
              the ember rain, `RoomLight.tsx`'s own ember loop falling instead of rising.
              The `room-light` class is what its keyframes are scoped to, and the arena's
              glow (`BossArena.tsx`) keeps that sheet mounted; reduced motion hides every
              ember through the same sheet. Keyed on the kill so a second one is fresh. */}
          {shown === 'arena' && kill !== null && (
            <g key={`kill-${kill}`} aria-hidden="true">
              {!reduced && <rect ref={flashRef} x={0} y={0} width={ARENA_UNITS} height={PIT_BOT + 1} fill="#fff" opacity={0} />}
              <g className="room-light">{RAIN}</g>
            </g>
          )}

          {/* Row 16. After `Spawn`, so the veil covers the flare when both fire. */}
          {veil}
        </g>
      </svg>
      {/* The fury wash: a red vignette at the screen's edges while the boss is in its last
          fifth (`isFurious`, the same integers the crank halves the volley on). A lens
          effect like `.stage::after`'s vignette, so it lives on the lens — an HTML sibling
          of the `<svg>`, not a world node — and it is MOUNTED ONCE and toggled by class:
          mounting it on the edge would restart its keyframes on every duplicate
          notification. Room B only, R3: a raider still in the waiting room cannot see the
          creature, and a red screen with nothing red on it reads as a fault. Pointer-
          transparent so aiming reaches the stage under it. */}
      <div
        className={`fury-wash${shown === 'arena' && arena.phase === PHASE_FIGHTING && isFurious(boss, arena.raidSize, arena.difficulty) ? ' is-on' : ''}`}
        aria-hidden="true"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The muzzle burst: the strip stepped across its window, one frame per step. `steps`
 * jumps at the END of each interval, so frame 0 shows first; at the final instant the
 * strip has left the window, and with the default `fill: 'none'` the base opacity 0 is
 * what remains.
 */
const BURST_KEYFRAMES: Keyframe[] = [
  { opacity: 1, transform: 'translateX(0)' },
  { opacity: 1, transform: `translateX(${-ORD_BURST.w * ORD_BURST.frames}px)` },
];
const BURST_TIMING: KeyframeAnimationOptions = {
  duration: BURST_MS,
  easing: `steps(${ORD_BURST.frames})`,
};

/**
 * The lane goes from a glow to a blaze as the hand comes down — the whole group, on top of
 * the growth below. The floor is 0.7 and not 0: the wind-up is 1.5 s against a measured
 * 1,126 ms of worst latency, so the FIRST frame is the one the dodge is decided on and a
 * lane that fades up out of nothing spends its budget being invisible.
 */
const SLAM_KEYFRAMES: Keyframe[] = [{ opacity: 0.7 }, { opacity: 0.82, offset: 0.5 }, { opacity: 1 }];

/** A ring's fill, from a spark at its centre to the whole ring on the landing tick. */
const RING_KEYFRAMES: Keyframe[] = [{ transform: 'scale(0.05)' }, { transform: 'scale(1)' }];

/** How long the fire burns after the hand lands. `styles.css`'s `hr-hell-erupt` runs this long. */
const ERUPT_MS = 950;

/** The thorns brighten into the shot. */
const VOLLEY_KEYFRAMES: Keyframe[] = [{ opacity: 0.25 }, { opacity: 1 }];

/** The kill's white flash over the pit, and how long the embers rain after it. */
const FLASH_MS = 120;
const FLASH_KEYFRAMES: Keyframe[] = [{ opacity: 0.85 }, { opacity: 0 }];
const KILL_RAIN_MS = 3_000;
/**
 * The ember rain: thirty of `RoomLight.tsx`'s embers, born above the creature and
 * falling through the pit (a positive `--ry`), each on its own clock and started part way
 * through it so the first frame is already a shower. In the ordnance atlas's amber: they
 * are the core's. Built once; the numbers are a hash of the index, so the shower is the
 * same one every kill.
 */
const RAIN = Array.from({ length: 48 }, (_, i) => {
  const a = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
  const b = ((Math.sin(i * 78.233) * 43758.5453) % 1 + 1) % 1;
  const dur = 1.7 + a * 1.1;
  return (
    <circle
      key={i}
      className="hrl-ember"
      cx={BOSS_SPAWN[0] - 330 + b * 660}
      cy={PIT_TOP - 80 + a * 120}
      r={2 + b * 2}
      fill="#ffb020"
      style={
        {
          '--dur': `${dur.toFixed(2)}s`,
          '--del': `${(-a * dur).toFixed(2)}s`,
          '--dx': `${((a - 0.5) * 24).toFixed(1)}px`,
          '--ry': `${(260 + b * 160).toFixed(1)}px`,
          '--a': (0.8 + a * 0.2).toFixed(2),
        } as CSSProperties
      }
    />
  );
});

/**
 * A SEEKED animation: built once at its true duration, played, and re-seeked from a chain
 * countdown whenever that countdown CHANGES.
 *
 * Seeking on arrival instead of on change is the trap: 68.4% of `Players` notifications in
 * a fight carry no change and the Magic Router delivers every one twice, so a duplicate
 * landing 20 ms late would rewind the wind-up 20 ms, twice a second. Comparing the value
 * makes a duplicate a no-op by construction, with no bookkeeping.
 *
 * `elapsed === null` means "nothing is winding up" and cancels, which is also what the
 * reduced-motion path passes — it draws the same information as a filling attribute.
 */
function useSeeked<T extends Element>(
  node: React.RefObject<T | null>,
  keyframes: Keyframe[],
  durationMs: number,
  elapsedMs: number | null,
): void {
  const anim = useRef<Animation | null>(null);
  const seen = useRef<number | null>(null);
  const frames = useRef(keyframes);
  frames.current = keyframes;
  // No dependency array: the guard is the value, and a ref that only just attached has to
  // be picked up on the very next commit rather than on the next state change.
  useEffect(() => {
    const el = node.current;
    if (el === null || elapsedMs === null || durationMs <= 0) {
      anim.current?.cancel();
      anim.current = null;
      seen.current = null;
      return;
    }
    if (anim.current === null) {
      anim.current = el.animate(frames.current, { duration: durationMs, fill: 'both' });
    }
    if (seen.current !== elapsedMs) {
      anim.current.currentTime = elapsedMs;
      seen.current = elapsedMs;
    }
  });
}

/**
 * {@link useSeeked} over a list of nodes on one countdown — the rings of a lane, each with
 * its own origin and so its own animation. Animations are keyed on the node, so a fresh
 * mount (a new wind-up is a new `key`) gets fresh ones and an unmounted node's is dropped
 * with it; the seek is applied to every node at once, on change, as `useSeeked` does.
 */
function useSeekedAll(
  nodes: React.MutableRefObject<(Element | null)[]>,
  keyframes: Keyframe[],
  durationMs: number,
  elapsedMs: number | null,
): void {
  const anims = useRef(new WeakMap<Element, Animation>());
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (elapsedMs === null || durationMs <= 0) {
      for (const el of nodes.current) {
        if (el === null) continue;
        anims.current.get(el)?.cancel();
        anims.current.delete(el);
      }
      seen.current = null;
      return;
    }
    for (const el of nodes.current) {
      if (el === null) continue;
      let anim = anims.current.get(el);
      if (anim === undefined) {
        anim = el.animate(keyframes, { duration: durationMs, fill: 'both' });
        anims.current.set(el, anim);
        anim.currentTime = elapsedMs;
      } else if (seen.current !== elapsedMs) {
        anim.currentTime = elapsedMs;
      }
    }
    seen.current = elapsedMs;
  });
}

/**
 * A rAF loop is not a keyframe — it has to be told about reduced motion.
 *
 * The one JS resolver (spec §7.6). CSS gates itself beside the rules it cancels; anything
 * that has to *decide* in JavaScript — the chase easing, the gate move becoming a cut,
 * `Spawn`'s veil — takes it from here as a prop rather than reading `matchMedia` again.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Self-check
//
// The chase is the whole of the smoothness fix and it fails silently: too small a step
// floats behind the input, too large a one is the 16-unit teleport it exists to remove,
// and a missing snap slides a re-anchored body across the dungeon.
//
// The composition's failure modes have the same shape — silent, and wrong in a way that
// reads as lag or as a bug in the chain: a seat painted into the wrong room, a slam
// wind-up drawn over the wrong column, an entrance close enough to the gate that the hold
// chases a knight across the room instead of placing it. All cheap here. Dev-only.
//
// The camera's own checks are gone with the camera. Their INTENT — that the framing
// contains what the player has to see — moved to `./viewport`, where the framing is: the
// two rooms are equal in size, they derive from the generated map, and the fitted viewBox
// contains the room on every stage aspect. Assertions about a window that no longer exists
// would have passed forever while the bug they were written for shipped.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`Arena self-check: ${what}`);
  };

  // One 50 ms input period covers exactly one tile — the step the chain itself applies —
  // so the render never lags the prediction by more than the move it has not seen yet.
  const at = { x: 0, y: 0 };
  chase(at, { x: 2 * MAP_TILE, y: 0 }, MAP_TILE);
  ok(at.x === MAP_TILE && at.y === 0, 'chase covers one tile per input period');

  // Within reach it lands exactly on the prediction rather than orbiting it.
  chase(at, { x: MAP_TILE + 4, y: 0 }, MAP_TILE);
  ok(at.x === MAP_TILE + 4, 'chase snaps once the target is within a step');

  // Reduced motion asks for no animation at all: an unbounded step is a snap.
  chase(at, { x: 300, y: 300 }, Infinity);
  ok(at.x === 300 && at.y === 300, 'an unbounded step snaps');

  // A reconcile across a stall is not a walk, and lerping it draws a body gliding
  // through walls for two seconds.
  chase(at, { x: 900, y: 900 }, MAP_TILE);
  ok(at.x === 900 && at.y === 900, 'a teleport-sized gap snaps instead of chasing');

  // The passage hold PLACES the local seat at its entrance rather than chasing it there,
  // and `chase` decides which by comparing the gap against `SELF_SNAP`. `enter_gate` calls
  // `entrance_for(seat)`, so every entrance has to be a teleport-sized distance from every
  // gate a player can leave through — the shortest today is 171.0 units against a 64-unit
  // snap. A map redraw that brings one inside the snap would freeze that seat mid-walk
  // under an opaque veil, which is the worst-looking failure this file has.
  for (const g of GATES) {
    const gateCx = (g.minX + g.maxX + 1) / 2;
    const gateCy = (g.minY + g.maxY + 1) / 2;
    for (const [ex, ey] of MAP_ENTRANCES) {
      ok(
        Math.hypot(ex - gateCx, ey - gateCy) > SELF_SNAP,
        `entrance (${ex}, ${ey}) is a snap away from a gate, not a walk`,
      );
    }
  }

  // R3, the room contract. Both directions fail silently and both are ugly: a lobby seat
  // painted onto the arena frame stands 400 units under the pit floor, and a pit seat
  // painted onto the lobby frame stands behind room A's fake masonry.
  const inLobby = { seat: 0, occupied: true, hp: 100, x: 512, y: 832, zone: ZONE_LOBBY } as PlayerSlot;
  const inPit = { seat: 1, occupied: true, hp: 100, x: 512, y: 500, zone: ZONE_ARENA } as PlayerSlot;
  const both = [inLobby, inPit];
  ok(roomSeats(both, 'lobby').length === 1 && roomSeats(both, 'lobby')[0] === inLobby, 'room A draws only lobby seats');
  ok(roomSeats(both, 'arena').length === 1 && roomSeats(both, 'arena')[0] === inPit, 'room B draws only arena seats');
  ok(
    roomSeats([{ ...inLobby, occupied: false }], 'lobby').length === 0,
    'an empty seat is drawn in neither room',
  );

  // The hold. The seat crossing the gate reads `ZONE_ARENA` while room A is still on
  // screen, and it must stay drawn there — unmounting it is the "I cannot see my
  // character" report, delivered at the one moment the beat exists to cover it.
  ok(roomSeats([inPit], 'lobby').length === 0, 'without the hold, a crossed seat leaves room A');
  ok(roomSeats([inPit], 'lobby', inPit.seat)[0] === inPit, 'the held seat stays drawn in the room on screen');
  ok(roomSeats([inPit], 'arena', inPit.seat)[0] === inPit, 'and is still drawn once the room cuts');
  ok(roomSeats(both, 'lobby', inPit.seat).length === 2, 'the hold adds one seat and removes none');
  ok(seatShown(inLobby, 'lobby') && !seatShown(inLobby, 'arena'), 'R3 answers from the room on screen');

  // Every sector a velocity can fall in has a sprite, and the cardinals land where the
  // atlas drew them (`ord-b0` along +x, clockwise with y down). A dangling href draws
  // nothing and throws nothing, which for a bullet is a hit from nowhere.
  ok(
    sector(42, 0) === 0 && sector(0, 42) === 4 && sector(-42, 0) === 8 && sector(0, -42) === 12,
    'cardinal velocities map to the cardinal sectors',
  );
  ok(sector(30, 30) === 2 && sector(-30, -30) === 10 && sector(30, -30) === 14, 'diagonals land between them');
  for (let k = 0; k < 16; k++) ok(ORDNANCE_DEFS.includes(`id="ord-b${k}"`), `the ordnance atlas has sector ${k}`);
  ok(
    ORDNANCE_DEFS.includes('id="ord-burst"') && ORDNANCE_DEFS.includes('id="ord-hit"'),
    'the ordnance atlas has the burst and the splat',
  );

  // THE DRAWN RIG AND THE HITTABLE RIG ARE THE SAME RIG. `#heartrot-boss-clip` cuts the
  // art; `PART_HITBOXES` and `CORE` are what `shoot.rs` and `raycastShot` resolve against.
  // A cut above a hitbox is an arrow stopping dead on bare stone while the chain scores
  // the damage, and it is silent in both directions. Measured against `BOSS_SPAWN`, which
  // is where `init` puts the creature and where it stays.
  const clipBot = BOSS_SPAWN[1] + BOSS_HIT_BOT;
  PART_HITBOXES.forEach((r, i) => {
    ok(BOSS_SPAWN[1] + r.y + r.h <= clipBot, `part ${i} is drawn everywhere the chain can hit it`);
  });
  ok(
    BOSS_SPAWN[1] + CORE.y + Math.sqrt(CORE.radiusSq) <= clipBot,
    'the vent is drawn everywhere the chain can hit it',
  );

  // The hold's ceiling is the release that does not depend on `Passage`. It must clear the
  // longest legitimate cover by a margin no timing jitter can close, or it fires mid-beat
  // and the knight is chased across the room in front of the player after all.
  ok(HOLD_CEILING_MS > 460 * 2, 'the hold ceiling clears the longest opaque cover twice over');

  // Every lane a slam can name is inside the arena, so the drawn column and the column
  // `damage_seat` tests are the same column.
  ok(SLAM_LANE_W * 8 === ARENA_UNITS, 'the slam lanes tile the arena exactly');
  ok(LANE_H > 0 && PIT_TOP + LANE_H - 1 === PIT_BOT, 'the lane spans the raider box');

  // The render cap caps DRAWING only, and it must never look like a shorter pool: a pool
  // holding fewer than the cap draws every live bullet, and `MAX_BULLETS` stays 128 on both
  // sides of the wire. Over the cap it is a RANKING, and the thing that must not regress is
  // which bullets survive it — a slice that keeps thirty-one spent tracers and drops the one
  // arriving at a player is worse than not capping at all.
  const pool = (live: number, b: Partial<Bullet> = {}): Bullet[] =>
    Array.from({ length: MAX_BULLETS }, (_, i) => ({
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      ...b,
      active: i < live ? 1 : 0,
    }));
  const noSlots: PlayerSlot[] = [];
  ok(visibleBullets(pool(0), noSlots).length === 0, 'an empty pool draws nothing');
  ok(visibleBullets(pool(15), noSlots).length === 15, 'a pool under the cap draws every live bullet');
  ok(visibleBullets(pool(MAX_BULLETS), noSlots).length === VISIBLE_BULLETS, 'a full pool draws exactly the cap');
  ok(
    visibleBullets(pool(MAX_BULLETS), noSlots)[0] === 0,
    'with nobody alive to rank against, the cap falls back to index order',
  );

  // The ranking itself. One raider stands at (512, 500); the pool is full of bullets that
  // have already flown past them, and slot 127 — the LAST one a first-32 slice would ever
  // reach — is the one about to land on their head.
  const seat = (over: Partial<PlayerSlot>): PlayerSlot =>
    ({ seat: 0, occupied: true, hp: 100, x: 512, y: 500, ...over }) as PlayerSlot;
  const spent = pool(MAX_BULLETS, { x: 512, y: 900, dx: 0, dy: 42 });
  spent[127] = { x: 512, y: 380, dx: 0, dy: 42, active: 1 };
  const drawn = visibleBullets(spent, [seat({})]);
  ok(drawn.length === VISIBLE_BULLETS, 'the ranking still draws exactly the cap');
  ok(drawn.includes(127), 'the bullet about to hit a raider is drawn, whatever slot it landed in');

  // A bullet heading AWAY ranks behind one heading in from the same distance, so the cut is
  // spent tracers first. Both are live, both are equidistant, only the sign differs.
  const away = pool(MAX_BULLETS, { x: 512, y: 380, dx: 0, dy: -42 });
  away[127] = { x: 512, y: 380, dx: 0, dy: 42, active: 1 };
  ok(
    visibleBullets(away, [seat({})]).includes(127),
    'an approaching bullet outranks an identical one that has turned away',
  );

  // A corpse is not a target: ranking against one would spend the whole cap on bullets
  // converging where nobody is standing.
  ok(
    visibleBullets(spent, [seat({ hp: 0 })])[0] === 0,
    'a dead raider ranks nothing, so the cap falls back to index order',
  );

  // Finding 5's identity discipline, which fails in two opposite directions and silently in
  // both: a fresh object per render re-folds `Knight`'s walk at the render rate and
  // double-counts every shot, and one mutated in place never folds again at all.
  const cache: { src: PlayerSlot | null; out: PlayerSlot | null } = { src: null, out: null };
  const auth = seat({ facing: 2 });
  const self: PredictedSelf = { x: 528, y: 500, facing: 2 };
  const first = predictedSlot(cache, auth, self);
  ok(first !== auth && first.x === 528 && first.hp === auth.hp, 'the predicted slot overrides position only');
  ok(predictedSlot(cache, auth, self) === first, 'an unchanged prediction folds nothing');
  self.x = 544;
  const stepped = predictedSlot(cache, auth, self);
  ok(stepped !== first && stepped.x === 544, 'a predicted step folds exactly once');
  const next = seat({ facing: 2, hp: 80 });
  ok(predictedSlot(cache, next, self).hp === 80, 'a new authoritative payload folds even at a standstill');

  // The documented trap, in executable form: the ticks that TELEGRAPH a slam divide to the
  // previous cycle, so a client that asks `slamLane` about the tick it is rendering always
  // gets null and draws nothing — or worse, mixes its own cycle index and lights the wrong
  // column. `slamTelegraph` is the only correct question, and this proves it stays pointed
  // at the beat that actually lands.
  const seed = new Uint8Array(32);
  seed[0] = 0x5a;
  seed[3] = 0xc3;
  const shell: BossAccount = {
    bump: 0,
    ventOpen: 0,
    attackTimer: 0,
    targetSeat: NO_TARGET,
    x: 512,
    y: 400,
    coreHp: 2000,
    coreHpMax: 2000,
    parts: [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500],
    partsMax: [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500],
  };
  const fakeArena = (tick: number): ArenaAccount =>
    ({ phase: PHASE_FIGHTING, tick, affixSeed: seed, raidSize: 1, difficulty: 0 }) as unknown as ArenaAccount;
  const landing = slamTelegraph(fakeArena(59), shell);
  if (landing === null) throw new Error('Arena self-check: a slam is telegraphed on the tick before it lands');
  for (let t = 60 - SLAM_TELEGRAPH_TICKS; t < 60; t++) {
    const seen = slamTelegraph(fakeArena(t), shell);
    if (seen === null) throw new Error('Arena self-check: the wind-up is drawn for its whole window');
    ok(seen.lane === landing.lane, 'the wind-up names one lane for its whole window');
    ok(seen.atTick === 60 && seen.ticksToImpact === 60 - t, 'the wind-up counts down to the landing tick');
  }
  ok(slamTelegraph(fakeArena(60 - SLAM_TELEGRAPH_TICKS - 1), shell) === null, 'nothing is drawn before the window');

  // A volley telegraph is the shot itself, drawn early: one line per LIVE muzzle. Shooting
  // a thorn off must silence its line, or the player is dodging a gun that no longer fires.
  const one = (over: Partial<PlayerSlot>): PlayersAccount =>
    ({ slots: [{ seat: 0, occupied: true, hp: 100, x: 512, y: 500, ...over } as PlayerSlot] }) as PlayersAccount;
  const aiming: BossAccount = { ...shell, targetSeat: 0, attackTimer: 3 };
  const shot = volleyTelegraph(fakeArena(100), aiming, one({}));
  if (shot === null) throw new Error('Arena self-check: an aimed volley telegraphs');
  ok(shot.lines.length === MUZZLES.length, 'every live muzzle draws its own line');
  ok(shot.ticksToImpact === 3, 'the volley counts down on attack_timer');
  const disarmed = volleyTelegraph(
    fakeArena(100),
    { ...aiming, parts: [0, 0, 0, 0, 4000, 2500, 2500, 2500, 2500] },
    one({}),
  );
  ok(disarmed === null, 'a boss with every thorn shot off telegraphs nothing');
  ok(
    volleyTelegraph(fakeArena(100), { ...aiming, attackTimer: SLAM_TELEGRAPH_TICKS + 1 }, one({})) === null,
    'the volley is only drawn inside the wind-up window',
  );
  ok(volleyTelegraph(fakeArena(100), aiming, one({ hp: 0 })) === null, 'no line is drawn to a corpse');
  ok(
    volleyTelegraph({ ...fakeArena(100), phase: PHASE_LOBBY }, aiming, one({})) === null,
    'nothing is telegraphed outside a fight',
  );

}
