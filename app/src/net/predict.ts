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
 * | **Other players** | Interpolate ~1 update behind. **Never extrapolate** — `SeatTrack`. |
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

import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import {
  BOSS_SPAWN,
  MAP_MAX_XY,
  MAP_TILE,
  MAP_TILES,
  PIT_BOT,
  PIT_TOP,
  TICK_MS,
  ZONE_ARENA,
  ZONE_LOBBY,
  isDaisTile,
  isWall,
  mayMoveTo,
  mayStandStep,
  onDais,
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
 * Apply one move exactly as `move_player` would: clamp into the map, reject a wall, then
 * reject a destination outside the seat's zone box, then one off the dais or inside the
 * boss. `null` means the chain would have returned `Err` — the caller must not move *or*
 * turn, because a rejected move leaves `facing` untouched on chain too.
 *
 * The zone test is `mayMoveTo` and the dais-and-body test is `mayStandStep`, both
 * imported rather than restated: `player.rs` refuses on
 * `is_wall(nx, ny) || !may_move_to(zone, y, ny) || !may_stand_step(zone, (x, y), (nx, ny))`,
 * one condition with one error, and a prediction that mirrors only the wall part
 * mispredicts every step at a box edge. That was live: a raider walking north at the pit
 * rim moved locally, got `BlockedByWall` back and rubber-banded — this file's own
 * signature failure mode, misread as lag.
 */
function stepFrom(x: number, y: number, dir: number, zone: number): Point | null {
  const step = MOVE_STEP[dir];
  if (step === undefined) throw new RangeError(`predict: dir ${dir} is not 0..7`);
  const nx = clamp(x + step[0], 0, MAP_MAX_XY);
  const ny = clamp(y + step[1], 0, MAP_MAX_XY);
  if (isWall(nx, ny) || !mayMoveTo(zone, y, ny) || !mayStandStep(zone, x, y, nx, ny)) return null;
  return { x: nx, y: ny };
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
 *
 * 3,000, not 1,000. Measured live on Sep 4 2026 walking a lobby from India against
 * devnet-as: ack p50 85 ms, p95 668 ms, single spikes to 1,366 ms, thirteen moves in
 * flight at once, refused 0 %. At a one-second TTL every spike expired live inputs, the
 * replay dropped them, and the archer snapped back a few steps — the "choppy" the player
 * reports, which is the network's tail and not a refusal. The TTL has to clear the tail:
 * three seconds is over twice the worst spike seen, and a genuinely refused move (a lost
 * slot race) costs one step of lateness at most, three seconds later, on a path the
 * pacing now makes rare.
 */
const PENDING_TTL_MS = 3_000;

/** Hard cap under the TTL, so a stalled socket cannot grow the buffer without bound. */
const MAX_PENDING = 64;

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
   * Where the renderer should draw the local player, this instant.
   *
   * **This is the local seat's render source.** `useSeatInterpolation` is for everybody
   * else: it lerps between *authoritative* snapshots, and once the boss activates
   * `boss_tick` rewrites `Players` every 100 ms for collisions — most of
   * those carrying no position change — so a seat driven from it holds, holds, holds and
   * jumps. Prediction is driven by input and no chain write can re-anchor it.
   *
   * The object identity is stable for the life of the predictor and the fields are
   * mutated in place on every `push` and `reconcile`, so a rAF loop reads `.x` / `.y`
   * per frame and allocates nothing. Read it, never hold it across frames, never write
   * to it — `reconcile` overwrites all three fields from the chain.
   *
   * Position is a 20 Hz staircase: one whole `MAP_TILE` per accepted input, nothing in
   * between. Measured, drawing it raw is *more* discrete than today's interpolated seat
   * (68% of frames identical, 16-unit teleports). A renderer chases it rather than
   * assigning it; see `render/Arena.tsx`.
   *
   * Meaningless until `ready`.
   */
  readonly self: PredictedSelf;
  /**
   * Whether `self` has ever been anchored to the chain. `false` means no `PlayerSlot` has
   * arrived yet and `self` is still `{0, 0}` — the top-left corner of the arena, not the
   * player. A frame loop must fall back to the authoritative seat until this is true.
   */
  readonly ready: boolean;
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
    get ready(): boolean {
      return authoritative !== null;
    },

    push(dir, now = performance.now()): number | null {
      // A dead player stays where it fell for the rest of the raid, and `move_player`
      // rejects them outright.
      if (authoritative === null || authoritative.hp === 0) return null;

      const next = stepFrom(self.x, self.y, dir, authoritative.zone);
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
        const next = stepFrom(self.x, self.y, input.dir, slot.zone);
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
 * Shortest window a seat may be given to cross a step. One frame at 60 Hz.
 *
 * A `span` of zero divides by zero in `tickAlpha`; anything under a frame is a snap with
 * extra arithmetic. Two position changes closer together than this is a duplicated
 * notification arriving out of order, not a player walking twice in 16 ms.
 */
const MIN_SPAN_MS = 16;

/**
 * One seat's interpolation, walking `from` → `slot` over `span` ms starting at `at`.
 *
 * Per seat and per *position change*, which is the whole correction. The hook used to
 * hold one global `{previous, next, at}` and re-anchor every seat whenever any `Players`
 * write arrived. Two measured consequences, both only in a fight:
 *
 *   - `boss_tick` rewrites `Players` every 100 ms for bullet collisions and
 *     the ER notifies a written account whether or not its bytes changed. Measured on
 *     devnet: 0% of lobby notifications carry no position change, 39.8% of fight ones do
 *     on the ER socket and 68.4% on the router the client actually opens. Each of those
 *     re-anchored the lerp from P to P — a seat that holds still for a whole window and
 *     then jumps the distance it owed. That is the reported chop, and it is why it starts
 *     exactly when the boss does.
 *   - The window was the 100 ms crank period while motion arrives on the 50 ms ER slot,
 *     so `alpha` only ever reached ~0.5 before being reset and 63% of all travel was
 *     delivered as 11-13 unit jumps *even in the lobby*.
 *
 * So: a snapshot that does not move a seat does not touch that seat's track, and `span`
 * is the observed gap between that seat's own last two position changes rather than an
 * assumed crank period. A stream of crank writes now interpolates through, and a seat
 * walking on the ER slot gets a 50 ms window because that is the cadence it is walking at.
 */
interface SeatTrack {
  /** The authoritative snapshot this track ends at, and the value the next one is diffed against. */
  slot: PlayerSlot;
  fromX: number;
  fromY: number;
  /** `performance.now()` when `slot`'s *position* landed. Not when a notification arrived. */
  at: number;
  /** Milliseconds to cross. The observed inter-arrival gap of this seat's motion. */
  span: number;
}

/**
 * Where a track is at `alpha`. Writes into `out` because this runs per seat per frame and
 * twenty allocations a frame is exactly the cost the bullet layer already refuses to pay.
 *
 * `alpha` is clamped by the caller, which is the whole point: extrapolating another player
 * overshoots the moment they stop, and every stop then ends in a snap-back (§6.3).
 */
function trackAt(track: SeatTrack, alpha: number, out: { x: number; y: number }): void {
  out.x = track.fromX + (track.slot.x - track.fromX) * alpha;
  out.y = track.fromY + (track.slot.y - track.fromY) * alpha;
}

/**
 * Fold one authoritative snapshot into a seat's track.
 *
 * Three cases, and the middle one is the fix: a teleport snaps, a real step re-anchors,
 * and a snapshot that leaves the seat where it already was updates the stored slot and
 * lets the running lerp finish undisturbed.
 *
 * A re-anchor starts from where the seat is *drawn* right now, not from the previous
 * authoritative position. They are the same point when the feed is on cadence; when a
 * notification is late the lerp has already finished and they still agree; when it is
 * early the drawn point is short of it and starting from the stored slot would step the
 * sprite backwards. `ceiling` caps the window so a seat that stood still for five seconds
 * and then took one step does not crawl that step over five seconds.
 */
function retarget(track: SeatTrack, to: PlayerSlot, now: number, ceiling: number): void {
  if (teleported(track.slot, to)) {
    track.fromX = to.x;
    track.fromY = to.y;
    track.at = now;
    track.span = ceiling;
  } else if (to.x !== track.slot.x || to.y !== track.slot.y) {
    const alpha = tickAlpha(track.at, now, track.span);
    track.fromX = track.fromX + (track.slot.x - track.fromX) * alpha;
    track.fromY = track.fromY + (track.slot.y - track.fromY) * alpha;
    track.span = clamp(now - track.at, MIN_SPAN_MS, ceiling);
    track.at = now;
  }
  track.slot = to;
}

/**
 * Distance past which a position change is a teleport, not a walk.
 *
 * `move_player` advances one `MOVE_STEP` — at most one tile — per accepted input, so any
 * larger jump is a re-anchor across a feed stall or a room change. Lerping one draws a
 * body sliding diagonally through the dungeon for a full tick; four tiles is comfortably
 * above any real step and far below any such jump.
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

/**
 * Fold a whole `Players` snapshot into the per-seat tracks.
 *
 * Module level, not a closure, so the self-check can drive it: this is the half of the
 * mount ordering that decides whether a freshly attached seat has a transform, and that
 * ordering is not otherwise observable outside a browser.
 */
function foldTracks(
  tracks: Map<number, SeatTrack>,
  slots: readonly PlayerSlot[],
  now: number,
  ceiling: number,
): void {
  for (const to of slots) {
    const track = tracks.get(to.seat);
    // First sight of a seat: there is nothing to lerp from, and drawing the halfway
    // point of a guess is worse than being one update stale.
    if (track === undefined) {
      tracks.set(to.seat, { slot: to, fromX: to.x, fromY: to.y, at: now, span: ceiling });
    } else {
      retarget(track, to, now, ceiling);
    }
  }
}

/** Anything with a `style.transform`. `<g>`, `<circle>`, a `<div>` — the hook does not care. */
type Placeable = SVGElement | HTMLElement;

function seatXY(
  tracks: Map<number, SeatTrack>,
  seat: number,
  now: number,
  reduced: boolean,
  out: { x: number; y: number },
): boolean {
  const track = tracks.get(seat);
  if (track === undefined) return false;
  trackAt(track, reduced ? 1 : tickAlpha(track.at, now, track.span), out);
  return true;
}

/**
 * Write one seat's transform, or nothing at all when that seat has no track yet.
 *
 * The silent return is the whole of finding 2 in `docs/review/render.md`: a node attached
 * before its track exists keeps whatever transform it had, which on a fresh `<g>` is none —
 * the SVG origin, the top-left corner. It stays silent, because the caller that can fix it
 * is the fold, and the fold now runs in the same commit (see `useLayoutEffect` below).
 */
function placeSeat(
  tracks: Map<number, SeatTrack>,
  seat: number,
  el: Placeable,
  now: number,
  reduced: boolean,
  out: { x: number; y: number },
): void {
  if (!seatXY(tracks, seat, now, reduced, out)) return;
  el.style.transform = `translate(${out.x}px, ${out.y}px)`;
}

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
 * Draw the other twenty knights between updates instead of at the notification rate.
 *
 * **Remote seats only.** The local seat is drawn from `Predictor.self`; see its doc for
 * why interpolation is the wrong source for the one seat that has inputs to predict from.
 *
 * Positions are written straight to the DOM from a rAF loop, never through React: a
 * re-render per frame per seat is exactly the cost the bullet layer already refuses to
 * pay, and none of this changes a single React-visible value. Each seat's `SeatTrack` is
 * captured here rather than threaded down from `subscribeMatch` because the renderer only
 * ever holds the latest `PlayersAccount`, and one hook remembering what it last saw per
 * seat is a smaller contract than three components passing a history around.
 *
 * `tickMs` is a *ceiling* on the interpolation window, not the window — `SeatTrack`
 * explains why assuming the crank period jumps every seat twice a second. Pass the crank
 * period; each seat paces itself from the cadence its own motion actually arrives at.
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
  const tracks = useRef(new Map<number, SeatTrack>());
  const reducedRef = useRef(reduced);
  const paceRef = useRef(tickMs);
  paceRef.current = tickMs;
  // One scratch point for the whole hook. `place` runs per seat per frame and the only
  // thing it does with the result is format a transform string.
  const scratch = useRef({ x: 0, y: 0 });

  const place = useCallback((seat: number, el: Placeable, now: number): void => {
    placeSeat(tracks.current, seat, el, now, reducedRef.current, scratch.current);
  }, []);

  const paint = useCallback((): void => {
    const now = performance.now();
    for (const [seat, el] of nodes.current) place(seat, el, now);
  }, [place]);

  /**
   * **`useLayoutEffect`, not `useEffect`** — `docs/review/render.md` finding 2.
   *
   * React attaches host refs bottom-up in the layout phase, so a seat `<g>`'s ref lands
   * *before* this hook's owner (`Arena`, its ancestor) gets to run anything. `ref` calls
   * `place`, `place` has no track for a seat it has never seen, and it returns without
   * writing — so the node is committed to the DOM with no transform at all. As a passive
   * effect this fold ran after the browser had already painted that node at the SVG
   * origin: every knight flashed in the top-left corner for one frame on the way in, and
   * at the gate all twenty did it at once.
   *
   * As a layout effect it runs in the same commit as the ref that attached the node, and
   * the `paint()` below is what actually writes the transform — the `ref` callback's own
   * `place` is still a no-op on a first mount and is not the thing being fixed. Both are
   * synchronous before paint, so the frame the browser draws is the first one.
   *
   * Every seat mount rides a `players` change (`Arena`'s `drawOrder` is memoised on it),
   * and a whole-`Arena` remount re-runs this on mount regardless of deps, so there is no
   * mount path that this misses.
   *
   * Cost, at the 20 seats the game caps at: 20 folds and at most 20 `style.transform`
   * writes, moved earlier in the same commit rather than added. It reads no layout
   * property — no `getBoundingClientRect`, no `offset*`, nothing that flushes — so it
   * cannot thrash; a transform write only invalidates. Blocking paint is the point.
   */
  useLayoutEffect(() => {
    foldTracks(tracks.current, players.slots, performance.now(), paceRef.current);
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
          place(seat, el, performance.now());
        };
        callbacks.current.set(seat, cb);
      }
      return cb;
    },
    [place],
  );

  const at = useCallback((seat: number, now = performance.now()): Point | null => {
    const out = { x: 0, y: 0 };
    return seatXY(tracks.current, seat, now, reducedRef.current, out) ? out : null;
  }, []);

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

  // The boss's feet row: dais for its whole width, outside the creature (the hitboxes end
  // above the feet line) and — the part that matters — inside the `ZONE_ARENA` box. It
  // used to be the pit's top row, which is the dais's crest now: two tiles wide and inside
  // the boss. Before that it was tile row 4, open floor but *boss air* — legal for a ray to
  // cross, illegal for anybody to stand on — and that went unnoticed while `stepFrom`
  // mirrored only the wall test, so every case below silently exercised half the rule. A
  // fixture must stand somewhere the chain would actually accept.
  //
  // `zone` is spelled out for the same reason: it is an input to the move rule now, and a
  // slot without one is not a seat the chain would ever hold.
  const FREE_Y = BOSS_SPAWN[1];
  const slot = (over: Partial<PlayerSlot>): PlayerSlot =>
    ({
      x: 320,
      y: FREE_Y,
      zone: ZONE_ARENA,
      facing: 0,
      hp: 100,
      lastMoveSeq: 0,
      ...over,
    }) as unknown as PlayerSlot;

  // The generated tables are really the ones being consulted — a stale or missing build
  // of `packages/client/src/map.ts` would otherwise show up only as in-game rubber-banding.
  ok(isWall(0, 0) && !isWall(320, FREE_Y) && onDais(320, FREE_Y), 'generated wall map is loaded');

  // Wrap-space acks: the u16 rollover must not read as "nothing acknowledged".
  ok(isAcked(5, 5) && isAcked(5, 4) && !isAcked(4, 5), 'ack ordering');
  ok(isAcked(1, 0xffff) && !isAcked(0xffff, 1), 'ack across the u16 wrap');

  // Predict three east steps, acknowledge two, keep the third.
  const p = createPredictor();
  // `self` is the arena's top-left corner until the chain says otherwise, which is why the
  // renderer has to gate its frame loop on `ready` rather than on the predictor existing.
  ok(!p.ready && p.self.x === 0 && p.self.y === 0, 'prediction is not ready before a slot');
  p.reconcile(slot({}), 0);
  ok(p.ready, 'a reconcile makes prediction ready');
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

  // The zone box — `handlers::player::may_move_to` — and the dais and the boss's body —
  // `may_stand_step` — the OTHER parts of the chain's one refusal. None of these is a wall:
  // the boss's air is open floor so `raycast` survives, and the gate rows are floor the
  // lobby walks over. A prediction that mirrors only `is_wall` moves the knight, the chain
  // answers `BlockedByWall`, and the seat rubber-bands — which this project reads as lag
  // every single time. The stand is the dais's westernmost tile on its crest row, found in
  // the generated grid rather than typed: west of it is the air beside the shoulder.
  const crest = PIT_TOP / TILE;
  let shoulderX = 0;
  while (shoulderX < MAP_TILES * TILE && !isDaisTile(shoulderX / TILE, crest)) shoulderX += TILE;
  ok(onDais(shoulderX, PIT_TOP) && !isWall(shoulderX - TILE, PIT_TOP), 'the crest row has a dais tile with air beside it');
  const rim = createPredictor();
  rim.reconcile(slot({ x: shoulderX, y: PIT_TOP, facing: 2 }), 0);
  ok(rim.push(0, 0) === null && rim.self.y === PIT_TOP, 'a raider cannot walk north out of the pit');
  ok(rim.push(6, 0) === null && rim.self.x === shoulderX, 'a raider cannot step off the dais into the air');
  ok(rim.push(4, 0) !== null, 'and can still walk south');

  // The boss: its feet line is a stand and the body above it is not.
  const feet = createPredictor();
  feet.reconcile(slot({ x: BOSS_SPAWN[0], y: BOSS_SPAWN[1], facing: 2 }), 0);
  ok(feet.push(0, 0) === null && feet.self.facing === 2, 'a raider cannot step into the boss');
  ok(feet.push(2, 0) !== null, 'and can walk along its feet');

  const lobby = createPredictor();
  lobby.reconcile(slot({ x: 512, y: PIT_BOT + 1, zone: ZONE_LOBBY, facing: 2 }), 0);
  ok(lobby.push(0, 0) === null, 'a lobby seat cannot walk north over the rim');
  ok(lobby.push(4, 0) !== null, 'and can still walk away from it');

  // Dead players do not move, and bullets land on integers at whole ticks.
  const dead = createPredictor();
  dead.reconcile(slot({ hp: 0 }), 0);
  ok(dead.push(2, 0) === null, 'dead player cannot move');
  ok(bulletAt({ x: 10, y: 10, dx: 48, dy: 0, active: 1 }, 1).x === 58, 'bullet lands exact');

  // Remote seats: lerp, and — the whole reason `alpha` is clamped — never overshoot.
  const here = slot({ x: 100, y: 100, occupied: true, zone: 1 });
  const step = slot({ x: 100 + TILE, y: 100, occupied: true, zone: 1 });
  const out = { x: 0, y: 0 };
  const track: SeatTrack = { slot: step, fromX: here.x, fromY: here.y, at: 0, span: 50 };
  trackAt(track, 0.5, out);
  ok(out.x === 100 + TILE / 2, 'seat lerps to the midpoint');
  trackAt(track, tickAlpha(track.at, 500, track.span), out);
  ok(out.x === 100 + TILE, 'seat alpha is clamped, not extrapolated');
  ok(tickAlpha(0, TICK_MS * 2) === 1 && tickAlpha(100, 0) === 0, 'tick alpha clamps both ends');

  // The chop, and the only assertion in this file that is about the *fight*. A crank write
  // rewrites `Players` without moving anybody; folding one in must not touch the running
  // lerp, or the seat holds for a window and then jumps the distance it owed.
  const cranked: SeatTrack = { slot: step, fromX: here.x, fromY: here.y, at: 0, span: 50 };
  retarget(cranked, slot({ ...step, hp: 40, occupied: true, zone: 1 }), 25, TICK_MS);
  ok(cranked.at === 0 && cranked.span === 50 && cranked.fromX === here.x, 'a crank write does not re-anchor');
  trackAt(cranked, tickAlpha(cranked.at, 25, cranked.span), out);
  ok(out.x === 100 + TILE / 2, 'the lerp keeps running through a crank write');
  ok(cranked.slot.hp === 40, 'a crank write still updates the stored slot');

  // Motion arrives on the 50 ms ER slot; the window must follow that, not the 100 ms crank.
  const paced: SeatTrack = { slot: here, fromX: here.x, fromY: here.y, at: 0, span: TICK_MS };
  retarget(paced, step, 50, TICK_MS);
  ok(paced.span === 50 && paced.at === 50, 'window is the observed motion cadence');
  retarget(paced, slot({ x: 100 + 2 * TILE, y: 100, occupied: true, zone: 1 }), 5_000, TICK_MS);
  ok(paced.span === TICK_MS, 'a long pause is capped at the ceiling, not crawled across');

  // A re-anchor starts from the drawn point, so an early snapshot never steps backwards.
  const early: SeatTrack = { slot: step, fromX: here.x, fromY: here.y, at: 0, span: 100 };
  retarget(early, slot({ x: 100 + 2 * TILE, y: 100, occupied: true, zone: 1 }), 50, TICK_MS);
  ok(early.fromX === 100 + TILE / 2, 're-anchor starts where the seat is drawn');
  // The crank period is a target, not a contract; `MatchInfo.tickMs` overrides it.
  ok(tickAlpha(0, 100, 200) === 0.5, 'tick alpha honours a caller-supplied tickMs');

  // Mount ordering — `docs/review/render.md` finding 2. React attaches the seat `<g>`'s
  // ref before the owning component's effects run, so `place` fires with no track and
  // writes nothing; the layout-phase fold is what must leave a transform on the node
  // before the browser paints it. Assert both halves, so a revert to `useEffect` is at
  // least a documented behaviour change rather than a silent one-frame corner flash.
  const fresh = new Map<number, SeatTrack>();
  const node = { style: { transform: '' } } as unknown as Placeable;
  const seated = slot({ seat: 3, x: 100, y: 100, occupied: true, zone: 1 });
  placeSeat(fresh, 3, node, 0, false, out);
  ok(node.style.transform === '', 'a ref attaching before the fold writes nothing');
  foldTracks(fresh, [seated], 0, TICK_MS);
  placeSeat(fresh, 3, node, 0, false, out);
  ok(node.style.transform === 'translate(100px, 100px)', 'a freshly attached seat has a transform before paint');
  // And the fold is the same one the running lerp relies on: a second snapshot retargets
  // rather than re-seeding, or every update would restart every seat from where it is.
  foldTracks(fresh, [slot({ seat: 3, x: 100 + TILE, y: 100, occupied: true, zone: 1 })], 50, TICK_MS);
  ok(fresh.get(3)?.span === 50, 'a second fold retargets the existing track');

  // A re-anchor crosses the map in one update. Lerping it walks a body through walls.
  ok(!teleported(here, step), 'one step is a walk');
  ok(teleported(here, slot({ x: 900, y: 900, occupied: true, zone: 1 })), 'a re-anchor snaps');
  ok(teleported(here, slot({ x: 100, y: 100, occupied: true, zone: 0 })), 'a zone change snaps');
}
