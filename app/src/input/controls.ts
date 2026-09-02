/**
 * Keyboard and pointer input, rate-limited to the gates the program actually enforces.
 *
 * This module emits *intents* — an eight-way `dir` to walk, a free `(dx, dy)` pair to shoot
 * — and nothing else. It builds no transaction and signs nothing: the caller turns an
 * intent into a `seq` through `createPredictor().push`, and only then into an instruction.
 * Keeping the split means input can be tested without a chain and the prediction buffer has
 * exactly one writer.
 *
 * **Aim is free, movement is not.** The boss stands at the top of the map and the raid
 * fights from a pit below it, so a 45 degree aim step selects nothing: measured against the
 * real hitboxes, eight-way aim reaches 5 of 10 targets and **never the core**, from any
 * stand in the pit (`docs/architecture/09-shooting.md` §1.1 — the raid is unwinnable with no
 * error anywhere). `shoot` therefore carries the raw pointer vector scaled to `i8` and the
 * chain normalises it; `move` still quantises to the eight-way `MOVE_STEP` table, because a
 * step is a tile and a tile has eight neighbours.
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
 * | `shoot` | `arena.phase == Fighting` -> else `WrongPhase` (6) | `live` below |
 * | `shoot` | `slot.zone == ZONE_ARENA` -> else `WrongZone` (9) | `live` below |
 * | `shoot` | `tick > last_shot_tick + CLASS_COOLDOWN_TICKS[class]` | {@link shotAllowed} |
 * | either, dead | `hp == 0` -> `PlayerDead` (Custom 8) | `clock().alive === false` sends nothing |
 *
 * **All four shot gates are mirrored now, and that is what makes the trigger honest.**
 * `shoot.rs`'s zone gate was the one this module did not mirror: a seat that claimed a
 * place but never walked through the gate sent one doomed `Custom(9)` every 800 ms for the
 * whole match, invisibly. And a trigger the chain would refuse no longer does *nothing* —
 * it fires {@link ControlsConfig.onTrigger} and sends nothing, which is the practice shot
 * of `17-fullscreen-spec.md` §6.1. Three windows had a dead key before this: the waiting
 * area, the 20 s muster (the worst one — the boss fills the frame and the key is dead),
 * and any seat still short of the gate during a fight.
 *
 * The split between the two callbacks is the whole contract, and it is deliberate that
 * neither can do the other's job: `onTrigger` draws, `onShoot` sends. A trigger the chain
 * accepts calls both, in that order; a trigger it would refuse calls only `onTrigger`; a
 * trigger inside the cooldown calls neither, because the cooldown ring is already on
 * screen saying so. Prediction owns no number — the arrow is the answer to "is the key
 * bound", and `damageDealt` off the roster is the answer to "did it hurt anything".
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

import {
  CLASS_ARCHER,
  CLASS_COOLDOWN_TICKS,
  CLASS_KNIGHT,
  CLASS_PERIOD_MS,
  PHASE_FIGHTING,
  TICK_MS,
  ZONE_ARENA,
} from '@heartrot/client';

/** Pump period. One ER slot — the finest granularity any gate above is expressed in. */
const PUMP_MS = 50;

/** Move gate. One ER slot — the chain's own floor, not a tunable. */
const MOVE_MS = 50;

/**
 * Floor on the wall time between two moves that actually left, and the amount of a stolen
 * slot `nextMoveDeadline` may claw back in one send. Without a floor, an immediate pump
 * from a keypress can land microseconds after a scheduled one — two moves inside one ER
 * slot, the second refused with `RateLimited`, invisible on the wire and, now that the
 * local knight renders from prediction, a visible one-tile pull-back.
 *
 * **40 -> 45, measured.** Harness: real Node timers, a 6 ms busy block per 16.7 ms frame to
 * make the pump late the way the renderer does, a 50 ms ER slot grid at a random phase, and
 * a send counted refused when it shares a slot with the last accepted one — `move_player`'s
 * own `last_move_tick != clock.slot`. 15-20 s per cell, `keys/s` = direction changes, each
 * dispatching a pump immediately as `onKeyDown` does:
 *
 * | floor | 0 keys/s | 3 | 8 | 16 | refusals/s (8 / 16 keys) |
 * |---|---|---|---|---|---|
 * | 40 ms | 19.65 | 19.45 | 19.39 | 19.20 accepted moves/s | 0.27 / 0.40 |
 * | 45 ms | 19.65 | — | 19.60 | 19.60 | 0.07 / 0.00 |
 * | 48 ms | — | — | 19.47 | 19.67 | 0.13 / 0.00 |
 * | 50 ms | 15.80 | 14.20 | 15.67 | 16.20 | 0 / 0 |
 *
 * Three findings, in the order they decide the number:
 *
 * 1. **50 is not free — it costs a fifth of the movement rate.** At 50 the floor is `now`,
 *    which is never below `lastMoveAt + MOVE_MS`, so the deadline re-anchors and every late
 *    pump loses its lateness permanently: 15.7-16.2 accepted moves/s against 19.6. The
 *    floor is not just a burst guard, it *is* the slot recovery.
 * 2. **Raising it inside that range is free.** 40, 45 and 48 all measure 19.6 sends/s: the
 *    scheduled pump never invokes the floor (minimum gap with no keypresses is 49.2 ms),
 *    only the immediate keypress pump does. So the floor's whole behavioural footprint is
 *    one early send per direction change, refused with probability `(50 - floor) / 50`.
 * 3. So take the halving. 45 cuts that probability 20% -> 10% for no measured throughput,
 *    and keeps 5 ms of recovery headroom; 48 keeps 2 ms, and every browser number in this
 *    project came from one box, so the jitter tail is exactly what is not measured here.
 *
 * Honest limit: this harness reproduces 0.2-0.4 refusals/s at 40, not the ~1.8/s `DevPanel`
 * reports. It reproduces the *mechanism*, on Node timers; a browser's jitter tail and the
 * shot path are outside it. If 45 does not move the reported rate, the mechanism is not
 * this floor and the next place to look is `connection.ts`'s duplicate-signature drop.
 *
 * Not taken: suppressing the prediction for the early send. At 45 it is refused 10% of the
 * time, so that trades one pull-back for nine round trips of visible input lag.
 *
 * **Re-run against the shipped rule** (same harness, 15 s cells, this box) before touching
 * the shot path, because the shot work changes the pump's callers and not this gate:
 *
 * | floor | 8 keys/s | 16 keys/s | refusals/s | min gap |
 * |---|---|---|---|---|
 * | 40 | 19.33 | 19.26 accepted/s | 0.27 / 0.40 | 40.2 ms |
 * | 45 | 19.60 | 19.53 | **0.07 / 0.13** | 45.2 ms |
 * | 50 | 14.66 | 15.66 | 0 / 0 | 50.0 ms |
 *
 * Same three findings, same decision: 50 costs a fifth of the movement rate because the
 * floor *is* the slot recovery, and 45 buys the halved refusal rate for nothing measurable.
 * Keep 45. This is a `move` result and only a `move` result — the shot path shares the pump
 * but not this gate, and `shoot` has never been measured under load at any seat count.
 */
const MIN_GAP_MS = 45;

/**
 * The shot gate, per class, and the ONLY copy on the client.
 *
 * `shoot.rs` compares `arena.tick > slot.last_shot_tick + CLASS_COOLDOWN_TICKS[class]`, so
 * the next accepted shot is one full class period after the last: 800 ms for a knight,
 * 1400 ms for an archer. Both come from `@heartrot/client`, which derives them from
 * `CLASS_PERIOD_MS` through `ticksFor` exactly as `state.rs` does — no tick count is typed
 * anywhere on either side.
 *
 * This used to be a local `800 / TICK_MS - 1`, and `Hud.tsx` used to hold a third copy that
 * had gone stale at the 400 ms-era `1`: the pill went green 600 ms early, in a live fight,
 * while this module's own gate refused to send. That is the second half of "the space bar
 * doesn't work". `Hud.tsx` now imports this function, so the pill and the pump cannot
 * disagree again, and the archer's 1400 ms lands in both the day a seat carries one.
 *
 * `cls` is `PlayerSlot.class_aim >> 7`, so 0 or 1 — the fallback is totality, not defence,
 * and it must resolve to the knight because every seat live on devnet reads 0 in that byte.
 */
export function shotAllowed(tick: number, lastShotTick: number, cls: number = CLASS_KNIGHT): boolean {
  return tick > lastShotTick + cooldownTicksFor(cls);
}

const cooldownTicksFor = (cls: number): number =>
  CLASS_COOLDOWN_TICKS[cls] ?? CLASS_COOLDOWN_TICKS[CLASS_KNIGHT]!;

/**
 * The practice trigger's gate. A trigger the chain would refuse never reaches the chain, so
 * `arena.tick` cannot pace it — in the waiting area the crank is not running and the tick
 * is frozen at 0 forever. Wall clock at the same class period is what keeps a held trigger
 * from emitting a stream of arrows, and it is what keeps `Shot.tsx`'s one-node-per-seat
 * proof (max flight + stick-and-fade < the class period) true for a practice shot too.
 */
const periodMsFor = (cls: number): number => CLASS_PERIOD_MS[cls] ?? CLASS_PERIOD_MS[CLASS_KNIGHT]!;

/**
 * Aim vectors leave here scaled so the larger component is this — the `i8` ceiling, and the
 * finest direction the wire can carry. The chain normalises with alpha-max-plus-beta-min, so
 * only the ratio matters; filling the byte is what buys the 0.235 degree resolution.
 */
const AIM_MAX = 127;

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
 * Screen vector → the `(dx, dy)` `i8` pair the wire carries, larger component ±`AIM_MAX`.
 * `null` for the zero vector, which the chain rejects (`octant` returns
 * `InvalidInstructionData`) and which a pointer resting exactly on the player produces.
 *
 * This is the whole free-aim change on the client: the same `atan2` input, scaled instead of
 * quantised. Precision surviving to the chain is 0.235°, against 45° through `dirFromVector`.
 */
export function aimFromVector(dx: number, dy: number): readonly [number, number] | null {
  const longest = Math.max(Math.abs(dx), Math.abs(dy));
  if (longest === 0) return null;
  return [Math.round((dx / longest) * AIM_MAX), Math.round((dy / longest) * AIM_MAX)];
}

/**
 * Inverse of `dirFromVector`: the aim vector of an eight-way facing. Keyboard fire has no
 * pointer, so it aims along the body's own facing — exactly as accurate as the shipped
 * eight-way client, and no worse. Trig rather than a table because `dirFromVector` is
 * `atan2` and this has to be its exact inverse; the self-check round-trips all eight.
 */
export function octantAim(dir: number): readonly [number, number] {
  const angle = (dir & 7) * (Math.PI / 4);
  return [Math.round(Math.sin(angle) * AIM_MAX), Math.round(-Math.cos(angle) * AIM_MAX)];
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

export interface ControlsConfig {
  /** Element the pointer aims over — the arena viewport. Keyboard binds to `window`. */
  readonly surface: HTMLElement;
  /**
   * The live arena clock, read on every pump. `tick` is authoritative; wall clock is not.
   *
   * `alive` is the local seat's `hp > 0` off the last roster notification. Optional, and
   * omitting it means "assume alive" — a caller that cannot see the roster yet gets the
   * old behaviour rather than a frozen player.
   *
   * `zone` is the local seat's `PlayerSlot.zone`, and it is the fourth chain gate: a shot
   * from `ZONE_LOBBY` is `WrongZone` (Custom 9) however alive and however Fighting the
   * arena is. `cls` is `class_aim >> 7` and picks the cooldown. Both optional and both
   * default to what every seat live on devnet already is — in the pit, a knight — so a
   * caller that has not wired them yet keeps sending real shots in a fight rather than
   * silently downgrading every one of them to a practice arrow.
   */
  clock(): {
    readonly phase: number;
    readonly tick: number;
    readonly alive?: boolean;
    readonly zone?: number;
    readonly cls?: number;
  };
  /**
   * The local player's position in client pixels, or `null` when it is off screen or not
   * yet known. Pointer aim needs an origin; without one, shots follow the last `facing`.
   */
  aimOrigin(): { readonly x: number; readonly y: number } | null;
  onMove(dir: number): void;
  /**
   * Every accepted trigger, live or practice, with the exact `i8` pair the shot was aimed
   * along — draw it here and nowhere else. Called BEFORE {@link onShoot} so the arrow
   * leaves the bow at 0 ms rather than after a transaction is built.
   *
   * Optional so a caller can be wired in either order, but a build that never sets it has
   * a spacebar that does nothing outside a fight, which is the bug this module was opened
   * for. `Shot.tsx::fireLocal` is what this is for.
   */
  onTrigger?(dx: number, dy: number): void;
  /**
   * The subset of {@link onTrigger} that goes on the wire: free aim as an `i8` pair, never
   * `(0, 0)`. The caller passes it straight to `shoot({ dx, dy })`; the chain normalises it
   * and stamps `facing` from the same pair, so nothing out here decides an octant on the
   * shot path.
   *
   * Called only when all four chain gates pass. Anything sent from here that the chain
   * refuses is invisible under `skipPreflight`, which is exactly why the gates are mirrored
   * rather than the refusals reported.
   */
  onShoot(dx: number, dy: number): void;
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
  // Below any real tick by more than any class cooldown, so the first shot of a match is
  // never gated whatever class the seat is.
  let lastShotTick = Number.NEGATIVE_INFINITY;
  // Wall clock of the last trigger of either kind. Paces the practice arrow, which has no
  // tick to pace it, and stops one following a real shot through the gate inside a period.
  let lastFireAt = Number.NEGATIVE_INFINITY;

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

  /** Never `(0, 0)`: every fallback path ends on `octantAim`, which is a unit direction. */
  function aimVector(): readonly [number, number] {
    if (pointerDown) {
      const origin = cfg.aimOrigin();
      // No origin yet, or the pointer resting on the player: fall through to the body's
      // facing rather than inventing an angle.
      const aim = origin === null ? null : aimFromVector(pointerX - origin.x, pointerY - origin.y);
      if (aim !== null) return aim;
    }
    return octantAim(facing);
  }

  function pump(): void {
    const { phase, tick, alive, zone, cls } = cfg.clock();
    const now = performance.now();

    // Dead. Every move and shot would come back `PlayerDead`, invisibly. Held keys are
    // deliberately NOT cleared: the respawn eight ticks later resumes whatever the player
    // is still pressing, and clearing would strand them standing still at the entrance.
    if (alive === false) return;

    const dir = heldDirection();
    if (dir !== null) {
      // One rule in every phase, on the wall clock, because the gate it mirrors is the ER
      // slot and the browser cannot see slots. This comment used to say a fight gates on
      // `arena.tick`; it has not since the chain moved both phases onto the slot.
      if (moveAllowed(now, lastMoveAt)) {
        lastMoveAt = nextMoveDeadline(now, lastMoveAt);
        facing = dir;
        cfg.onMove(dir);
      }
    }

    if (!pointerDown && !fireKeyDown) return;
    const klass = cls ?? CLASS_KNIGHT;

    // `shoot` is Fighting-only AND arena-only on chain: outside either, the transaction is
    // built, signed, sent and refused with nothing to show for it. So it is not sent — the
    // trigger still fires, and only the send is dropped.
    const live = phase === PHASE_FIGHTING && (zone ?? ZONE_ARENA) === ZONE_ARENA;

    // The two clocks, each pacing the trigger it can see. Inside a live cooldown nothing is
    // drawn at all: the ring is already on screen counting it down, and an arrow there
    // would claim a shot the chain never took.
    if (live ? !shotAllowed(tick, lastShotTick, klass) : now - lastFireAt < periodMsFor(klass)) return;

    if (live) lastShotTick = tick;
    lastFireAt = now;
    const [dx, dy] = aimVector();
    // The chain stamps `facing = octant(dx, dy)` from the same pair, so tracking it
    // here keeps the keyboard's next shot aimed where the last one went.
    facing = dirFromVector(dx, dy);
    // Draw first, send second: the arrow is client-side either way, and a practice arrow
    // and a real one are the same arrow.
    cfg.onTrigger?.(dx, dy);
    if (live) cfg.onShoot(dx, dy);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== FIRE_KEY && KEY_VECTORS[event.code] === undefined) return;
    // Before the repeat guard, and that ordering is the fix: Space and the arrows scroll
    // the page, the browser repeats them while they are held, and only the FIRST of those
    // events used to be cancelled. So holding fire scrolled the arena out from under the
    // player — which is a spacebar that visibly does the wrong thing rather than nothing,
    // and there are no text inputs anywhere in this app for the cancel to interfere with.
    // It is also what keeps Space firing instead of clicking whichever HUD button has
    // focus: the default activation is cancelled here, at the end of the bubble path.
    event.preventDefault();
    if (event.repeat) return;
    if (event.code === FIRE_KEY) {
      fireKeyDown = true;
    } else {
      held.add(event.code);
    }
    // Straight to the wire rather than waiting out the pump. `pump` re-reads the clock
    // and every gate, so this can only send what the next pump would have sent anyway,
    // one period sooner.
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

  // Shots: strictly greater, so the next accepted shot is `cooldown + 1` ticks later — one
  // class period, whatever TICK_MS is. Expressed against the constant, never a literal:
  // this block read `shotAllowed(9, 7)` from the 400 ms era and was passing only because
  // the mirror had gone stale in the same direction.
  for (const cls of [CLASS_KNIGHT, CLASS_ARCHER]) {
    const cd = cooldownTicksFor(cls);
    assert(!shotAllowed(7 + cd, 7, cls), 'a shot inside the cooldown must be gated');
    assert(shotAllowed(8 + cd, 7, cls), 'a shot one tick past it must pass');
    // The DPS the boss's HP curve assumes only holds while the period the pump paces the
    // trigger at and the period the cooldown was derived from are the same one.
    assert((cd + 1) * TICK_MS === periodMsFor(cls), 'the cooldown must be one class period');
    assert(shotAllowed(0, Number.NEGATIVE_INFINITY, cls), 'the first shot of a match must pass');
  }
  assert(periodMsFor(CLASS_KNIGHT) === 800, "the knight's period must stay 800 ms");
  assert(periodMsFor(CLASS_ARCHER) === 1400, "the archer's period must stay 1400 ms");
  // Slower and heavier, never faster: the notification budget is the constraint, so a shot
  // a knight may take at tick t is one an archer may not.
  assert(
    shotAllowed(8 + cooldownTicksFor(CLASS_KNIGHT), 7, CLASS_KNIGHT) &&
      !shotAllowed(8 + cooldownTicksFor(CLASS_KNIGHT), 7, CLASS_ARCHER),
    'the archer must be the slower class',
  );
  // Every seat live on devnet reads 0 in `class_aim`, so both the default and any byte this
  // build does not understand have to resolve to the knight rather than to `undefined`.
  assert(shotAllowed(9, 0) === shotAllowed(9, 0, CLASS_KNIGHT), 'the default class is the knight');
  assert(cooldownTicksFor(99) === cooldownTicksFor(CLASS_KNIGHT), 'an unknown class falls back to the knight');
  assert(periodMsFor(99) === periodMsFor(CLASS_KNIGHT), 'and so does its practice period');

  // Free aim. The larger component fills the byte — anything smaller throws away chain-side
  // resolution for nothing — and the pair must never be (0, 0), which the chain rejects.
  const aim = aimFromVector(10, -40);
  assert(aim !== null && aim[0] === 32 && aim[1] === -127, 'aim fills i8 on its longer axis');
  assert(aimFromVector(0, 0) === null, 'the zero vector has no aim, and the chain refuses it');
  for (let dir = 0; dir < 8; dir += 1) {
    const [sx, sy] = octantAim(dir);
    if (dirFromVector(sx, sy) !== dir) {
      throw new Error(`controls self-check: octantAim(${dir}) does not round-trip`);
    }
  }

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
