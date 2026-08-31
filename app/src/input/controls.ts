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
 * | `move`, fighting | `last_move_tick != arena.tick` | one send per observed `tick` |
 * | `move`, lobby | `last_move_tick != clock.slot` (50 ms slots) | one send per 100 ms |
 * | `shoot` | `arena.tick > last_shot_tick + 1` | one send per two observed ticks |
 *
 * The lobby uses the ER slot rather than `arena.tick` because `boss_tick` returns before
 * incrementing unless the phase is Fighting: a tick-only limiter would grant each player
 * exactly one lobby move ever and freeze them short of the gate, so no match could start.
 * 100 ms rather than the full 50 ms the chain allows, because the ER coalesces
 * notifications to one per account per 50 ms slot anyway and 10 Hz is what the bandwidth
 * budget was measured at.
 */

import { PHASE_FIGHTING } from '@heartrot/client';

/** Pump period. One ER slot — the finest granularity any gate above is expressed in. */
const PUMP_MS = 50;

/** Lobby move gate. See the module header for why it is not the chain's 50 ms. */
const LOBBY_MOVE_MS = 100;

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

export interface ControlsConfig {
  /** Element the pointer aims over — the arena viewport. Keyboard binds to `window`. */
  readonly surface: HTMLElement;
  /** The live arena clock, read on every pump. `tick` is authoritative; wall clock is not. */
  clock(): { readonly phase: number; readonly tick: number };
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

  let lastMoveTick = -1;
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
    const { phase, tick } = cfg.clock();
    const now = performance.now();

    const dir = heldDirection();
    if (dir !== null) {
      // Fighting gates on the tick itself, which is what the chain compares against;
      // lobby gates on wall clock, because the chain's lobby clock is the ER slot and the
      // browser cannot see it.
      const allowed =
        phase === PHASE_FIGHTING ? tick !== lastMoveTick : now - lastMoveAt >= LOBBY_MOVE_MS;
      if (allowed) {
        lastMoveTick = tick;
        lastMoveAt = now;
        facing = dir;
        cfg.onMove(dir);
      }
    }

    // Shooting is Fighting-only on chain (`phase != PHASE_FIGHTING` is a hard reject), so
    // a lobby trigger-pull is dropped here rather than sent and silently failed.
    if ((pointerDown || fireKeyDown) && phase === PHASE_FIGHTING) {
      if (tick > lastShotTick + SHOT_COOLDOWN_TICKS) {
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
      return;
    }
    if (KEY_VECTORS[event.code] === undefined) return;
    held.add(event.code);
    // Arrow keys scroll the page and would drag the arena out from under the player.
    event.preventDefault();
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
// The direction mapping is the one thing here that is wrong *quietly*: an off-by-one in
// the octant index sends the player north-east when they pressed north, which reads as a
// physics bug rather than an input bug. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
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
