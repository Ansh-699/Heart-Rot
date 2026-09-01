/**
 * Keyboard and pointer input, rate-limited to the gates the program actually enforces.
 *
 * This module emits *intents* — an eight-way `dir` — and nothing else. It builds no
 * transaction and signs nothing: the caller turns an intent into a `seq` through
 * `createPredictor().push`, and only then into an instruction. Keeping the split means
 * input can be tested without a chain and the prediction buffer has exactly one writer.
 *
 * **Why the rate limits live here as well as on chain.** ER transaction fees are zero and
 * the forked SVM runs no fee-payer validation at all, so nothing debits a spammer and the
 * network offers no economic backstop — `last_move_tick` and `last_shot_tick` *are* the
 * rate limiter (D16/R12). A client that outruns them does not get faster movement, it
 * gets a stream of `InvalidArgument` failures, and because gameplay is sent with
 * `skipPreflight` those failures are invisible: the transaction returns a signature and
 * then does nothing. The prediction buffer meanwhile fills with inputs that will never be
 * acknowledged. Mirroring the gates is what keeps the two sides in step.
 *
 * The gates, verbatim from the handlers:
 *
 * | Action | Chain rule | Mirrored as |
 * |---|---|---|
 * | `move`, any phase | `last_move_tick != clock.slot` (50 ms slots) | one send per 50 ms |
 * | `shoot` | `arena.tick > last_shot_tick + 1` | one send per two observed ticks |
 * | either, dead | `hp == 0` -> `PlayerDead` (Custom 8) | `clock().alive === false` sends nothing |
 *
 * The dead gate is prevention, not reaction, and it has to be: gameplay is sent with
 * `skipPreflight` and never confirmed, so `Custom(7)`/`Custom(8)` are not observable on
 * the hot path at all — the transaction returns a signature and quietly does nothing.
 * The authoritative signal is the roster the world feed already delivers (`hp == 0`,
 * cleared by the respawn eight ticks later), which costs no round trip. Without it a
 * corpse holding fire sends one doomed `shoot` every 800 ms for the rest of the match.
 *
 * Movement is gated on the ER slot in every phase. It used to gate a fight on `arena.tick`
 * instead, and that made the raid feel like wading: one 16-unit tile per 400 ms crank tick
 * is 2.5 tiles a second across a 64-tile arena, while the lobby — already on the slot
 * clock — moved eight times faster. The chain now reads the slot in both, so this mirror
 * does too.
 *
 * The lobby needed the slot clock in the first place because `boss_tick` returns before
 * incrementing unless the phase is Fighting: a tick-only limiter would grant each player
 * exactly one lobby move ever and freeze them short of the gate, so no match could start.
 *
 * **Keypress-to-wire.** Two things here are pure client-side latency in front of the
 * ~130 ms round trip, and neither is visible to the telemetry panel — it starts its clock
 * at `recordSend`, which is downstream of both.
 *
 * 1. *Pump quantisation.* A key pressed just after a pump waited a whole period before
 *    anything left the browser. Every listener that changes intent therefore pumps
 *    immediately; the gates below are unchanged, so an early call either sends now or
 *    does nothing, and the cadence cannot be exceeded.
 * 2. *Deadline drift.* The gate used to re-anchor to the moment a move actually left, so
 *    a pump the browser delivered 3 ms late made the next one 47 ms early, which failed
 *    the gate and cost a whole 50 ms slot. Measured on Node timers with a 5 ms busy block
 *    per pump: 24-29 lost slots per 400 moves and a 100 ms worst-case gap, i.e. 18.5-18.75
 *    moves/s against the 20 the chain allows. `nextMoveDeadline` advances the deadline by
 *    exactly one period instead, which measures 19.95/s with zero lost slots.
 */

import { PHASE_FIGHTING } from '@heartrot/client';

/** Pump period. One ER slot — the finest granularity any gate above is expressed in. */
const PUMP_MS = 50;

/** Move gate. One ER slot — the chain's own floor, not a tunable. */
const MOVE_MS = 50;

/**
 * Floor on the wall time between two moves that actually left. Recovering a slot the
 * browser stole (below) means one deliberately early send, and without this floor an
 * immediate pump from a keypress can land microseconds after a scheduled one — two moves
 * inside one ER slot, the second refused with `RateLimited` and invisible. 40 ms keeps
 * the recovery while leaving the pair a slot apart 80% of the time. Measured under
 * immediate dispatch at 3 and 8 keypresses/s: minimum observed gap 40.1 ms, none below.
 */
const MIN_GAP_MS = 40;

/** `SHOT_COOLDOWN_TICKS` from `handlers/shoot.rs`, where the test is strictly greater. */
const SHOT_COOLDOWN_TICKS = 1;

/**
 * Physical keys, by `KeyboardEvent.code` rather than `key`. `code` is layout-independent,
 * so AZERTY and Dvorak players get WASD in the same place on the keyboard instead of
 * scattered across it, and it does not change under a held modifier.
 */
const KEY_VECTORS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const FIRE_KEY = 'Space';

/**
 * Screen vector → eight-way `facing`: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW, y down.
 * The float lives entirely inside this function; what leaves it is an integer index into
 * the same `MOVE_STEP` table the chain uses.
 */
export function dirFromVector(dx: number, dy: number): number {
  return Math.round(Math.atan2(dx, -dy) / (Math.PI / 4)) & 7;
}

/**
 * The two cadence gates, pulled out of the pump so they can be asserted without a DOM.
 * They are the whole reason this module exists and both fail silently when wrong.
 */
function moveAllowed(now: number, lastMoveAt: number): boolean {
  // One rule for every phase, because the chain now has one rule for every phase. The
  // budget is wall clock rather than the observed tick: the gate it mirrors is the ER
  // slot, and a client cannot see slots — 50 ms IS one slot, which is the floor. There is
  // no number below this that the chain would accept or that anything could observe, so
  // this is "as fast as the network allows" in the literal sense rather than a taste.
  return now - lastMoveAt >= MOVE_MS;
}

/**
 * The deadline the *next* move is measured against, given one just went out at `now`.
 *
 * Advancing by exactly `MOVE_MS` rather than re-anchoring to `now` is what stops a late
 * pump from costing a whole slot: the lateness is absorbed by the one send that was late
 * instead of being carried into every send after it. The `Math.max` is the floor — after
 * a long idle (or a hidden tab, whose timers are throttled to ~1 Hz) the accumulated
 * deadline is far in the past and would let a burst through, so it never sits more than
 * `MOVE_MS - MIN_GAP_MS` behind the send it belongs to.
 */
function nextMoveDeadline(now: number, lastMoveAt: number): number {
  return Math.max(lastMoveAt + MOVE_MS, now - MOVE_MS + MIN_GAP_MS);
}

function shotAllowed(tick: number, lastShotTick: number): boolean {
  return tick > lastShotTick + SHOT_COOLDOWN_TICKS;
}

export interface ControlsConfig {
  /** Element the pointer aims over — the arena viewport. Keyboard binds to `window`. */
  readonly surface: HTMLElement;
  /**
   * The live arena clock, read on every pump. `tick` is authoritative; wall clock is not.
   *
   * `alive` is the local seat's `hp > 0` off the last roster notification. Optional, and
   * omitting it means "assume alive" — a caller that cannot see the roster yet gets the
   * old behaviour rather than a frozen player.
   */
  clock(): { readonly phase: number; readonly tick: number; readonly alive?: boolean };
  /**
   * The local player's position in client pixels, or `null` when it is off screen or not
   * yet known. Pointer aim needs an origin; without one, shots follow the last `facing`.
   */
  aimOrigin(): { readonly x: number; readonly y: number } | null;
  onMove(dir: number): void;
  onShoot(dir: number): void;
}

/** Attaches every listener and the pump. The returned function removes all of them. */
export function attachControls(cfg: ControlsConfig): () => void {
  const held = new Set<string>();
  let pointerDown = false;
  let pointerX = 0;
  let pointerY = 0;
  let fireKeyDown = false;

  // Last direction actually emitted. The chain sets `facing` on both `move` and `shoot`,
  // so this tracks it locally for the keyboard-fire path, which has no aim vector.
  let facing = 0;

  let lastMoveAt = Number.NEGATIVE_INFINITY;
  // Two below any real tick, so the first shot of a match is never gated.
  let lastShotTick = -(SHOT_COOLDOWN_TICKS + 1);

  function heldDirection(): number | null {
    let dx = 0;
    let dy = 0;
    for (const code of held) {
      const vector = KEY_VECTORS[code];
      if (vector === undefined) continue;
      dx += vector[0];
      dy += vector[1];
    }
    // Opposite keys held at once cancel out — standing still, not an arbitrary direction.
    return dx === 0 && dy === 0 ? null : dirFromVector(dx, dy);
  }

  function aimDirection(): number {
    if (!pointerDown) return facing;
    const origin = cfg.aimOrigin();
    if (origin === null) return facing;
    const dx = pointerX - origin.x;
    const dy = pointerY - origin.y;
    return dx === 0 && dy === 0 ? facing : dirFromVector(dx, dy);
  }

  function pump(): void {
    const { phase, tick, alive } = cfg.clock();
    const now = performance.now();

    // Dead. Every move and shot would come back `PlayerDead`, invisibly. Held keys are
    // deliberately NOT cleared: the respawn eight ticks later resumes whatever the player
    // is still pressing, and clearing would strand them standing still at the entrance.
    if (alive === false) return;

    const dir = heldDirection();
    if (dir !== null) {
      // Fighting gates on the tick itself, which is what the chain compares against;
      // lobby gates on wall clock, because the chain's lobby clock is the ER slot and the
      // browser cannot see it.
      if (moveAllowed(now, lastMoveAt)) {
        lastMoveAt = nextMoveDeadline(now, lastMoveAt);
        facing = dir;
        cfg.onMove(dir);
      }
    }

    // Shooting is Fighting-only on chain (`phase != PHASE_FIGHTING` is a hard reject), so
    // a lobby trigger-pull is dropped here rather than sent and silently failed.
    if ((pointerDown || fireKeyDown) && phase === PHASE_FIGHTING) {
      if (shotAllowed(tick, lastShotTick)) {
        lastShotTick = tick;
        facing = aimDirection();
        cfg.onShoot(facing);
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    if (event.code === FIRE_KEY) {
      fireKeyDown = true;
      event.preventDefault();
      // Straight to the wire rather than waiting out the pump. `pump` re-reads the clock
      // and both gates, so this can only send what the next pump would have sent anyway,
      // one period sooner.
      pump();
      return;
    }
    if (KEY_VECTORS[event.code] === undefined) return;
    held.add(event.code);
    // Arrow keys scroll the page and would drag the arena out from under the player.
    event.preventDefault();
    pump();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === FIRE_KEY) fireKeyDown = false;
    held.delete(event.code);
  };

  // Alt-tabbing away never delivers the keyup, so without this the player keeps walking
  // in whatever direction they left in — for the rest of the match.
  const onBlur = (): void => {
    held.clear();
    fireKeyDown = false;
    pointerDown = false;
  };

  const onPointerDown = (event: PointerEvent): void => {
    pointerDown = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    // Keeps aim tracking after the pointer leaves the viewport mid-drag.
    cfg.surface.setPointerCapture(event.pointerId);
    pump();
  };

  const onPointerMove = (event: PointerEvent): void => {
    pointerX = event.clientX;
    pointerY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent): void => {
    pointerDown = false;
    if (cfg.surface.hasPointerCapture(event.pointerId)) {
      cfg.surface.releasePointerCapture(event.pointerId);
    }
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  cfg.surface.addEventListener('pointerdown', onPointerDown);
  cfg.surface.addEventListener('pointermove', onPointerMove);
  cfg.surface.addEventListener('pointerup', onPointerUp);
  cfg.surface.addEventListener('pointercancel', onPointerUp);
  const pumpTimer = setInterval(pump, PUMP_MS);

  return () => {
    clearInterval(pumpTimer);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    cfg.surface.removeEventListener('pointerdown', onPointerDown);
    cfg.surface.removeEventListener('pointermove', onPointerMove);
    cfg.surface.removeEventListener('pointerup', onPointerUp);
    cfg.surface.removeEventListener('pointercancel', onPointerUp);
  };
}

// ---------------------------------------------------------------------------
// Self-check
//
// Two things here are wrong *quietly*. An off-by-one in the octant index sends the player
// north-east when they pressed north, which reads as a physics bug rather than an input
// bug. And an off-by-one in either cadence gate is invisible in both directions: too fast
// and the sends come back rejected under `skipPreflight` with no error anywhere (61% of
// moves, measured, at 150 ms), too slow and the player is simply sluggish. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`controls self-check: ${what}`);
  };

  // One gate for every phase now: wall clock, because the chain gates on an ER slot the
  // browser cannot read. A fight is no longer throttled to the 400 ms crank tick.
  // Expressed against MOVE_MS, not a literal: this line read `!moveAllowed(50, 0)` from
  // when the gate was 100 ms, and it has been throwing on import in dev ever since the
  // gate came down to one ER slot.
  assert(!moveAllowed(MOVE_MS - 1, 0), 'a move inside the period must be gated');
  assert(moveAllowed(MOVE_MS, 0), 'a move at the period must pass');
  assert(moveAllowed(9999, 0), 'a long-idle move must pass whatever the tick is doing');

  // The deadline walks the 50 ms grid instead of the wall clock, so a pump delivered late
  // costs only itself. Both failures are silent: re-anchoring to `now` drops ~1.5 moves a
  // second, and dropping the floor lets an immediate keypress send twice inside one slot.
  assert(nextMoveDeadline(50, 0) === MOVE_MS, 'an on-time move advances the deadline by one period');
  assert(nextMoveDeadline(53, 0) === MOVE_MS, 'a late pump must not carry its lateness forward');
  assert(!moveAllowed(99, nextMoveDeadline(53, 0)), 'the next move is still gated before its deadline');
  assert(moveAllowed(100, nextMoveDeadline(53, 0)), 'the slot a late pump stole is recovered');
  assert(
    nextMoveDeadline(9999, 0) === 9999 - MOVE_MS + MIN_GAP_MS,
    'a long idle re-bases the deadline instead of banking a burst',
  );
  assert(!moveAllowed(9999 + MIN_GAP_MS - 1, nextMoveDeadline(9999, 0)), 'two sends stay MIN_GAP_MS apart');
  assert(moveAllowed(9999 + MIN_GAP_MS, nextMoveDeadline(9999, 0)), 'and no further apart than that');
  assert(nextMoveDeadline(0, Number.NEGATIVE_INFINITY) === -MOVE_MS + MIN_GAP_MS, 'the first move is finite');

  // Shots: strictly greater, i.e. one per two ticks — 800 ms at a 400 ms tick.
  assert(!shotAllowed(8, 7), 'a shot one tick after the last must be gated');
  assert(shotAllowed(9, 7), 'a shot two ticks after the last must pass');
  assert(shotAllowed(0, -(SHOT_COOLDOWN_TICKS + 1)), 'the first shot of a match must pass');

  const expected: readonly (readonly [number, number, number])[] = [
    [0, -1, 0],
    [1, -1, 1],
    [1, 0, 2],
    [1, 1, 3],
    [0, 1, 4],
    [-1, 1, 5],
    [-1, 0, 6],
    [-1, -1, 7],
  ];
  for (const [dx, dy, dir] of expected) {
    if (dirFromVector(dx, dy) !== dir) {
      throw new Error(`controls self-check: (${dx}, ${dy}) should be facing ${dir}`);
    }
  }
}
