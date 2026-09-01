/**
 * Client-side prediction and reconciliation — decision D14.
 *
 * Measured RTT India → devnet-as is **196 ms median / 136 ms min**, and move-to-confirm is
 * that plus one 50 ms ER block. Rendering the authoritative position is therefore a fifth
 * of a second behind every keypress, which fails build-step 2's "it feels instant" gate on
 * its own. Prediction is not polish here; it is the only thing that makes the ER feel like
 * an ER. `01-architecture.md` §6.3 is explicit that **"10 ms" must never be used as a
 * latency budget anywhere**.
 *
 * Three object classes, three treatments, and they are not interchangeable:
 *
 * | Class | Treatment |
 * |---|---|
 * | **Own player** | Predict on input, reconcile on `PlayerSlot.last_move_seq`. This file. |
 * | **Other players** | Interpolate ~1 update behind. **Never extrapolate** — `interpolateSeat`. |
 * | **Bullets** | Extrapolate exactly — integer state, float only in the transform. `bulletAt`. |
 *
 * The whole scheme rests on `PlayerSlot.last_move_seq`, which exists for exactly this
 * reason: without it an arriving position is ambiguous as to which input produced it, so
 * a reconciler cannot tell "the server has caught up" from "the server is one move
 * behind", and the symptom is rubber-banding for every player (D14 / R4).
 *
 * **The step table below is a mirror of `programs/heartrot/src/handlers/player.rs`.** If
 * the prediction and the chain disagree by one unit, every input snaps back. They are
 * integers on both sides on purpose — a float anywhere reintroduces the drift the layout
 * contract went out of its way to remove.
 */

import { useCallback, useEffect, useRef } from 'react';

import {
  MAP_MAX_XY,
  MAP_TILE,
  isWall,
  type Bullet,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

// ---------------------------------------------------------------------------
// Map geometry — the generated table, not a copy of it
// ---------------------------------------------------------------------------

/**
 * `MAP_TILE`, `MAP_MAX_XY` and `isWall` all come from `@heartrot/client`'s `map` module,
 * which `tools/gen_map.py` emits from `assets/map/arena.json` in the same pass that emits
 * the chain's `programs/heartrot/src/map.rs`. A hand-mirrored wall test here would put the
 * dungeon in two places again, and one disagreeing tile is a permanent snap-back that
 * reads as lag rather than as a map bug.
 *
 * Not re-exported. `TILE`, `MAP_MAX_XY`, `MOVE_STEP` and `stepFrom` were all public here
 * and had zero importers — a re-export of a generated constant is just a second name for
 * it, and the second name is how a map ends up in two places. Everyone else imports
 * `MAP_TILE` / `MAP_TILES` / `isWall` from `@heartrot/client` directly.
 */
const TILE = MAP_TILE;

/** Crank period. A *target*, not a contract — never derive game state from wall clock. */
const TICK_MS = 400;

const STEP = TILE;

// `round(TILE / √2)`, so a diagonal covers the same ground as a straight. Written as a
// literal because the chain cannot compute it (no floats there) and the two must agree.
const STEP_DIAG = 11;

/**
 * Eight-way step indexed by `facing`: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW, y down.
 * Byte-for-byte the `MOVE_STEP` of `handlers/player.rs`. Also what a caller feeds to the
 * `move` instruction builder, so the direction it predicts and the direction it sends
 * cannot come from two different tables.
 */
const MOVE_STEP: readonly (readonly [number, number])[] = [
  [0, -STEP],
  [STEP_DIAG, -STEP_DIAG],
  [STEP, 0],
  [STEP_DIAG, STEP_DIAG],
  [0, STEP],
  [-STEP_DIAG, STEP_DIAG],
  [-STEP, 0],
  [-STEP_DIAG, -STEP_DIAG],
];

export interface Point {
  readonly x: number;
  readonly y: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Apply one move exactly as `move_player` would: clamp into the map, then reject a wall.
 * `null` means the chain would have returned `Err` — the caller must not move *or* turn,
 * because a rejected move leaves `facing` untouched on chain too.
 */
function stepFrom(x: number, y: number, dir: number): Point | null {
  const step = MOVE_STEP[dir];
  if (step === undefined) throw new RangeError(`predict: dir ${dir} is not 0..7`);
  const nx = clamp(x + step[0], 0, MAP_MAX_XY);
  const ny = clamp(y + step[1], 0, MAP_MAX_XY);
  return isWall(nx, ny) ? null : { x: nx, y: ny };
}

// ---------------------------------------------------------------------------
// Own-player prediction
// ---------------------------------------------------------------------------

const SEQ_MASK = 0xffff;

/**
 * How long an unacknowledged input may sit in the buffer before it is dropped.
 *
 * This is the load-bearing number in the whole file. The chain silently *rejects* a move
 * that loses the one-per-tick race (`last_move_tick == now`), and a rejected move is
 * indistinguishable from an in-flight one: neither ever acknowledges. Replaying those
 * forever would leave the prediction permanently ahead of the server — a player who
 * appears to walk through the boss and then teleports back. Expiring at ~5× the measured
 * 196 ms RTT keeps a genuinely in-flight input, drops a dead one.
 */
const PENDING_TTL_MS = 1_000;

/** Hard cap under the TTL, so a stalled socket cannot grow the buffer without bound. */
const MAX_PENDING = 32;

export interface PredictedSelf {
  x: number;
  y: number;
  facing: number;
}

interface PendingInput {
  readonly seq: number;
  readonly dir: number;
  readonly at: number;
}

export interface Predictor {
  /**
   * Where the renderer should draw the local player, this instant. Mutated in place on
   * every `push` and `reconcile`; read it, do not hold it across frames.
   */
  readonly self: PredictedSelf;
  /** Unacknowledged inputs. A number that only grows means the ER stopped accepting. */
  readonly pending: number;
  /**
   * Apply an input locally and record it for replay. Returns the `seq` to put in the
   * `move` instruction, or `null` when the chain would reject the move anyway (dead
   * player, wall) and nothing should be sent.
   */
  push(dir: number, now?: number): number | null;
  /** An authoritative `PlayerSlot` arrived: discard acknowledged inputs, replay the rest. */
  reconcile(slot: PlayerSlot, now?: number): void;
}

/**
 * `seq` is a u16 and wraps. Comparing with `>=` breaks once per 65,536 moves — about
 * 4.5 hours of continuous play — and the failure is a full desync, so the comparison is
 * done in wrap space: `a` is at or after `b` when the forward distance is under half the
 * range. Everything in flight is at most `MAX_PENDING` apart, so the window is never
 * ambiguous in practice.
 */
function isAcked(lastSeq: number, seq: number): boolean {
  return ((lastSeq - seq) & SEQ_MASK) < 0x8000;
}

export function createPredictor(): Predictor {
  const self: PredictedSelf = { x: 0, y: 0, facing: 0 };
  const pending: PendingInput[] = [];
  let seq = 0;
  // `null` until the first authoritative update: predicting from a position nobody has
  // confirmed would put the player somewhere the server has never heard of.
  let authoritative: PlayerSlot | null = null;

  return {
    self,
    get pending(): number {
      return pending.length;
    },

    push(dir, now = performance.now()): number | null {
      // A dead player's position belongs to `boss_tick` — it owns `respawn_at_tick` and
      // the return to the entrance — and `move_player` rejects them outright.
      if (authoritative === null || authoritative.hp === 0) return null;

      const next = stepFrom(self.x, self.y, dir);
      if (next === null) return null;

      seq = (seq + 1) & SEQ_MASK;
      pending.push({ seq, dir, at: now });
      if (pending.length > MAX_PENDING) pending.shift();

      self.x = next.x;
      self.y = next.y;
      self.facing = dir;
      return seq;
    },

    reconcile(slot, now = performance.now()) {
      authoritative = slot;

      // Everything the server has already applied, plus everything too old to still be
      // in flight. Both are dropped from the front; the buffer is ordered by `seq`.
      while (pending.length > 0) {
        const head = pending[0];
        if (head === undefined) break;
        if (!isAcked(slot.lastMoveSeq, head.seq) && now - head.at < PENDING_TTL_MS) break;
        pending.shift();
      }

      // Snap to truth, then replay what the server has not seen yet. A wall-rejected
      // replay is skipped rather than dropped: the chain would have rejected it too, and
      // the TTL above is what eventually retires it.
      self.x = slot.x;
      self.y = slot.y;
      self.facing = slot.facing;
      for (const input of pending) {
        const next = stepFrom(self.x, self.y, input.dir);
        if (next === null) continue;
        self.x = next.x;
        self.y = next.y;
        self.facing = input.dir;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Everything that is not the local player
// ---------------------------------------------------------------------------

/**
 * Fraction of the way from the last crank tick to the next, clamped to `[0, 1]`.
 *
 * `tickAt` is the timestamp `subscribe.ts` records when `Arena.tick` actually *changed* —
 * not when any `Arena` write arrived, since `shoot` rewrites the account without
 * advancing the clock. `arena.tick` is the authoritative clock; a free-running local
 * counter drifts from the crank, and the crank is what decides whether a bullet hit you.
 */
export function tickAlpha(tickAt: number, now = performance.now(), tickMs = TICK_MS): number {
  return clamp((now - tickAt) / tickMs, 0, 1);
}

/**
 * Where to draw a bullet between ticks.
 *
 * This is the one place a float is correct. The bullet's *state* stays the chain's
 * integers and is re-read every tick, so nothing accumulates: at every whole tick the
 * rendered position is exactly the chain's, and in between it is a straight line along
 * the same integer velocity. That is what renders a 2.5 Hz stream as 60 fps bullet hell
 * with zero prediction error — as long as the float never flows back into state.
 */
export function bulletAt(bullet: Bullet, alpha: number): Point {
  return { x: bullet.x + bullet.dx * alpha, y: bullet.y + bullet.dy * alpha };
}

/**
 * Where to draw somebody else, one update behind.
 *
 * `alpha` is clamped, which is the whole point: extrapolating another player overshoots
 * the moment they stop, and every stop then ends in a snap-back. Interpolating one update
 * behind costs ~400 ms of staleness on people you are not aiming at, which nobody can
 * see, and never overshoots (§6.3).
 */
function interpolateSeat(previous: PlayerSlot, next: PlayerSlot, alpha: number): Point {
  const t = clamp(alpha, 0, 1);
  return {
    x: previous.x + (next.x - previous.x) * t,
    y: previous.y + (next.y - previous.y) * t,
  };
}

/**
 * Distance past which a position change is a teleport, not a walk.
 *
 * `move_player` advances one `MOVE_STEP` — at most one tile — per accepted input, so any
 * larger jump is `boss_tick` returning a dead player to an entrance. Lerping a respawn
 * draws a corpse sliding diagonally through the dungeon for a full tick; four tiles is
 * comfortably above any real step and far below the shortest respawn.
 */
const SNAP_DISTANCE = 4 * TILE;

function teleported(from: PlayerSlot, to: PlayerSlot): boolean {
  return (
    from.occupied !== to.occupied ||
    from.zone !== to.zone ||
    Math.abs(to.x - from.x) > SNAP_DISTANCE ||
    Math.abs(to.y - from.y) > SNAP_DISTANCE
  );
}

/** Anything with a `style.transform`. `<g>`, `<circle>`, a `<div>` — the hook does not care. */
type Placeable = SVGElement | HTMLElement;

export interface SeatInterpolation {
  /**
   * Ref callback for seat `seat`'s outermost node. Stable for the life of the hook, so
   * React does not detach and reattach twenty nodes on every 2.5 Hz update.
   *
   * The hook owns that element's `transform` outright — give it no transform attribute of
   * its own, and hang any facing flip on a child, exactly as the bullet loop owns a
   * `<rect>`'s style transform.
   */
  ref(seat: number): (el: Placeable | null) => void;
  /**
   * The same interpolated position as a value, for a renderer that has no per-seat node
   * to hand a ref to — a `<canvas>` draw loop calls this once per seat per frame instead.
   * `null` when the seat is empty. Use `ref` **or** `at`, never both for one seat.
   */
  at(seat: number, now?: number): Point | null;
}

/**
 * Draw the other twenty knights between updates instead of at 2.5 Hz.
 *
 * Positions are written straight to the DOM from a rAF loop, never through React: a
 * re-render per frame per seat is exactly the cost the bullet layer already refuses to
 * pay, and none of this changes a single React-visible value. `previous` is captured here
 * rather than threaded down from `subscribeMatch` because the renderer only ever holds the
 * latest `PlayersAccount`, and one hook remembering the last one it saw is a smaller
 * contract than three components passing a pair around.
 *
 * `reduced` comes from the caller because the renderer already resolves
 * `prefers-reduced-motion` for the bullet loop; resolving it a second time here would put
 * the same media query in two places. Under it, seats simply snap to each published
 * position — which is what they do today.
 */
export function useSeatInterpolation(
  players: PlayersAccount,
  reduced = false,
  tickMs = TICK_MS,
): SeatInterpolation {
  const nodes = useRef(new Map<number, Placeable>());
  const callbacks = useRef(new Map<number, (el: Placeable | null) => void>());
  const reducedRef = useRef(reduced);
  const paceRef = useRef(tickMs);
  paceRef.current = tickMs;
  const snapshot = useRef<{
    previous: PlayersAccount | null;
    next: PlayersAccount;
    at: number;
  }>({ previous: null, next: players, at: 0 });

  const seatAt = useCallback((seat: number, alpha: number): Point | null => {
    const { previous, next } = snapshot.current;
    const to = next.slots[seat];
    if (to === undefined) return null;
    const from = previous?.slots[seat];
    // No previous snapshot means nothing to lerp from, and drawing the halfway point of a
    // guess is worse than being one update stale.
    return from === undefined || teleported(from, to) ? to : interpolateSeat(from, to, alpha);
  }, []);

  const alphaNow = useCallback(
    (now = performance.now()): number =>
      reducedRef.current ? 1 : tickAlpha(snapshot.current.at, now, paceRef.current),
    [],
  );

  const place = useCallback(
    (seat: number, el: Placeable, alpha: number): void => {
      const at = seatAt(seat, alpha);
      if (at === null) return;
      el.style.transform = `translate(${at.x}px, ${at.y}px)`;
    },
    [seatAt],
  );

  const paint = useCallback((): void => {
    const alpha = alphaNow();
    for (const [seat, el] of nodes.current) place(seat, el, alpha);
  }, [place, alphaNow]);

  useEffect(() => {
    snapshot.current = { previous: snapshot.current.next, next: players, at: performance.now() };
    // Paint immediately: waiting for the next frame leaves a seat that was just mounted
    // sitting at the SVG origin, which reads as a knight teleporting to the corner.
    paint();
  }, [players, paint]);

  useEffect(() => {
    reducedRef.current = reduced;
    paint();
    if (reduced) return;
    let raf = 0;
    const frame = () => {
      paint();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced, paint]);

  const ref = useCallback(
    (seat: number) => {
      let cb = callbacks.current.get(seat);
      if (cb === undefined) {
        cb = (el: Placeable | null) => {
          if (el === null) {
            nodes.current.delete(seat);
            return;
          }
          nodes.current.set(seat, el);
          place(seat, el, alphaNow());
        };
        callbacks.current.set(seat, cb);
      }
      return cb;
    },
    [place, alphaNow],
  );

  const at = useCallback(
    (seat: number, now = performance.now()): Point | null => seatAt(seat, alphaNow(now)),
    [seatAt, alphaNow],
  );

  return { ref, at };
}

// ---------------------------------------------------------------------------
// Self-check
//
// Reconciliation is the part of this file that is wrong silently: a broken ack rule
// still renders, it just rubber-bands. Dev-only so it costs a production build nothing.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`predict self-check: ${what}`);
  };

  // Tile row 4 is open floor for its whole width in the generated dungeon, so these steps
  // exercise reconciliation rather than the map. Tile column 0 is the outer wall.
  const FREE_Y = 4 * TILE;
  const slot = (over: Partial<PlayerSlot>): PlayerSlot =>
    ({ x: 320, y: FREE_Y, facing: 0, hp: 100, lastMoveSeq: 0, ...over }) as unknown as PlayerSlot;

  // The generated wall table is really the one being consulted — a stale or missing build
  // of `packages/client/src/map.ts` would otherwise show up only as in-game rubber-banding.
  ok(isWall(0, 0) && !isWall(320, FREE_Y), 'generated wall map is loaded');

  // Wrap-space acks: the u16 rollover must not read as "nothing acknowledged".
  ok(isAcked(5, 5) && isAcked(5, 4) && !isAcked(4, 5), 'ack ordering');
  ok(isAcked(1, 0xffff) && !isAcked(0xffff, 1), 'ack across the u16 wrap');

  // Predict three east steps, acknowledge two, keep the third.
  const p = createPredictor();
  p.reconcile(slot({}), 0);
  ok(p.push(2, 0) === 1 && p.push(2, 0) === 2 && p.push(2, 0) === 3, 'seq increments from 1');
  ok(p.self.x === 320 + 3 * TILE && p.pending === 3, 'three steps predicted');
  p.reconcile(slot({ x: 320 + 2 * TILE, lastMoveSeq: 2 }), 10);
  ok(p.pending === 1 && p.self.x === 320 + 3 * TILE, 'unacked input replayed, acked dropped');

  // A silently rejected input (lost the one-move-per-tick race) must expire, not replay
  // forever — otherwise the prediction stays permanently one step ahead of the server.
  p.reconcile(slot({ x: 320 + 2 * TILE, lastMoveSeq: 2 }), 10 + PENDING_TTL_MS);
  ok(p.pending === 0 && p.self.x === 320 + 2 * TILE, 'stale input expires and snaps back');

  // The chain rejects a wall move and leaves facing alone; so must the prediction.
  const edge = createPredictor();
  edge.reconcile(slot({ x: TILE, facing: 4 }), 0);
  ok(edge.push(6, 0) === null && edge.self.facing === 4, 'wall move is not predicted');

  // Dead players do not move, and bullets land on integers at whole ticks.
  const dead = createPredictor();
  dead.reconcile(slot({ hp: 0 }), 0);
  ok(dead.push(2, 0) === null, 'dead player cannot move');
  ok(bulletAt({ x: 10, y: 10, dx: 48, dy: 0, active: 1 }, 1).x === 58, 'bullet lands exact');

  // Remote seats: lerp, and — the whole reason `alpha` is clamped — never overshoot.
  const here = slot({ x: 100, y: 100, occupied: true, zone: 1 });
  const step = slot({ x: 100 + TILE, y: 100, occupied: true, zone: 1 });
  ok(interpolateSeat(here, step, 0.5).x === 100 + TILE / 2, 'seat lerps to the midpoint');
  ok(interpolateSeat(here, step, 2).x === 100 + TILE, 'seat alpha is clamped, not extrapolated');
  ok(tickAlpha(0, TICK_MS * 2) === 1 && tickAlpha(100, 0) === 0, 'tick alpha clamps both ends');
  // The crank period is a target, not a contract; `MatchInfo.tickMs` overrides it.
  ok(tickAlpha(0, 100, 200) === 0.5, 'tick alpha honours a caller-supplied tickMs');

  // A respawn crosses the map in one update. Lerping it walks a corpse through walls.
  ok(!teleported(here, step), 'one step is a walk');
  ok(teleported(here, slot({ x: 900, y: 900, occupied: true, zone: 1 })), 'a respawn snaps');
  ok(teleported(here, slot({ x: 100, y: 100, occupied: true, zone: 0 })), 'a zone change snaps');
}
