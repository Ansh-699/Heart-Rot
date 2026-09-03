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
 * error anywhere). `shoot` therefore carries a free `(dx, dy)` pair scaled to `i8` and the
 * chain normalises it; `move` still quantises to the eight-way `MOVE_STEP` table, because a
 * step is a tile and a tile has eight neighbours. This module does not choose the pair: it
 * asks {@link ControlsConfig.aim} at the trigger, and `App.tsx` answers with
 * `@heartrot/client`'s `autoAim` off the predicted position — or the body's facing when
 * nothing is in reach. The pointer aims nothing any more; a pointer down is fire held.
 *
 * **The hold is release-to-fire.** A press is one plain tap at 0 ms, exactly as before.
 * Fire kept down while standing still then accrues a tier — `CHARGE_MS` plus a send-latency
 * margin reaches tier 1 (2.5x), `SUPER_MS` plus the same margin reaches tier 2 (5x, the
 * beam) — and the RELEASE fires the tier reached: `NotCharged` on chain if a step was still
 * in flight, which `App.tsx` answers by resending one tier down. Nothing fires at tier 1 by
 * itself any more; the old auto-fire at `CHARGE_MS` made a super unreachable, because the
 * charged shot always left first. A release short of tier 1 fires nothing — the tap already
 * answered that press — so a quick press-release is one arrow, never two. A release inside
 * the cooldown is QUEUED, one deep, and the first pump past the gate fires it: the stand
 * was paid for and the cooldown ring is the only reason the shot has not left. The hold is
 * measured from the later of the press and the last step (`max(fireDownAt, lastMoveAt)`):
 * charge accrues ONLY while standing still, and a step restarts it. That is the rule of the
 * mechanic, not a lock on the keys — suppressing `onMove` instead would break
 * shoot-while-walking and trap a player mid-slam. Walking, the tap path auto-repeats plain
 * exactly as it always has. {@link ControlsConfig.onCharge} is the hold's edge, reporting
 * the tier reached on every change, for the archer's draw pose and the two arcs.
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
 * | `shoot` | `tick > last_shot_tick + CLASS_COOLDOWN_TICKS[class]` | {@link shotAllowed}, one tick of slack |
 * | `shoot`, tier 1 | `Clock.slot - last_move_tick >= CHARGE_SLOTS` -> else `NotCharged` (20) | {@link tierReached} |
 * | `shoot`, tier 2 | `Clock.slot - last_move_tick >= SUPER_SLOTS` -> else `NotCharged` (20) | {@link tierReached} |
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
  AIM_MAX,
  CHARGE_MS,
  CLASS_ARCHER,
  CLASS_COOLDOWN_TICKS,
  CLASS_KNIGHT,
  CLASS_PERIOD_MS,
  PHASE_FIGHTING,
  SUPER_MS,
  TICK_MS,
  ZONE_ARENA,
  type ShotTier,
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
 * and it resolves to the knight because that is what a zeroed byte decodes to (`classOf`),
 * which is every seat that predates the class. Every caller passes the seat's own decoded
 * byte; the class this CLIENT sends when its clock names none is the pump's own default,
 * the archer, and a different question.
 *
 * **Plus one tick of slack.** `lastShotTick` is this client's view of the tick at the send,
 * and the chain stamps its OWN tick, which is at or past that view. When the view lags less
 * at the next send than it did at this one, the mirror passes a shot the chain refuses with
 * `RateLimited` — invisibly, under `skipPreflight` — and that is the shot that "did not
 * fire" mid-fight. The lag is the notification latency, under two ticks at the ~130 ms
 * round trip, and it is only the CHANGE in it between two sends that bites, so one tick
 * covers it at 100 ms a shot. The pump also raises its record to the seat's decoded
 * `last_shot_tick` when the roster says the chain's stamp was later. `Hud.tsx`'s pill reads
 * this same predicate, so it goes green when a send would actually pass.
 */
export function shotAllowed(tick: number, lastShotTick: number, cls: number = CLASS_KNIGHT): boolean {
  return tick > lastShotTick + cooldownTicksFor(cls) + SHOT_MARGIN_TICKS;
}

/** See {@link shotAllowed}. */
const SHOT_MARGIN_TICKS = 1;

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
 * Send latency, on top of `CHARGE_MS` / `SUPER_MS`, before a hold counts as its tier. The
 * chain measures the hold in ER slots between the last accepted step and the shot's
 * arrival; the client measures it in wall clock between the two SENDS. The margin covers
 * the step landing later than the shot's clock assumes — a whole `NotCharged` round trip
 * is what it saves.
 */
const CHARGE_MARGIN_MS = 250;

/**
 * The stand a tier costs as this client judges it: the chain's hold plus the margin.
 * Exported for `Knight.tsx`'s arcs. A readout that closes at `CHARGE_MS` while the release
 * earns the tier only at `CHARGE_MS + 250` tells the player to let go 250 ms early, and
 * under release-to-fire that is a plain arrow after a full stand — so the arc closes at
 * the instant a release would be granted, or it is lying.
 */
export function holdMsFor(tier: 1 | 2): number {
  return (tier === 2 ? SUPER_MS : CHARGE_MS) + CHARGE_MARGIN_MS;
}

/**
 * The tier a hold that began at `fireDownAt`, with the last step sent at `lastMoveAt`, has
 * reached by `now`. The later of the two starts the clock: charge accrues only while
 * standing still, and a step restarts it. Pure, so the rule is checkable without a DOM.
 */
function tierReached(now: number, fireDownAt: number, lastMoveAt: number): ShotTier {
  const stood = now - Math.max(fireDownAt, lastMoveAt);
  return stood >= holdMsFor(2) ? 2 : stood >= holdMsFor(1) ? 1 : 0;
}

/**
 * What a pump has to fire, if anything: a queued release first — it was earned, and only
 * the cooldown held it — else the tap at a press or the walking auto-repeat, plain. A
 * standing hold with no tap fires nothing; its shot is the release. Pure, for the
 * self-check, because both wrong answers are silent: a dropped queue is a super the player
 * stood 2.5 s for and never saw, and a tap that also fires on release is two arrows.
 */
function nextShot(queued: ShotTier | null, held: boolean, still: boolean, tap: boolean): ShotTier | null {
  if (queued !== null) return queued;
  return held && (tap || !still) ? 0 : null;
}

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
 * Inverse of `dirFromVector`: the aim vector of an eight-way facing, `AIM_MAX` long. The
 * fallback when auto-aim has nothing in reach: the shot goes along the body's own facing —
 * exactly as accurate as the shipped eight-way client, and no worse. Trig rather than a
 * table because `dirFromVector` is `atan2` and this has to be its exact inverse; the
 * self-check round-trips all eight.
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
  /** Element the pointer fires over — the arena viewport. Keyboard binds to `window`. */
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
   * arena is. `cls` is `class_aim >> 7` and picks the cooldown. Both optional: `zone`
   * defaults to the pit, so a caller that has not wired it keeps sending real shots in a
   * fight rather than silently downgrading every one of them to a practice arrow, and
   * `cls` defaults to the archer, the only class this client sends.
   *
   * `lastShotTick` is the seat's decoded `last_shot_tick`: the chain's own stamp of the
   * last accepted shot, which can be LATER than the tick this client saw at the send. The
   * pump paces against the later of the two. Optional; omitted means the local record only.
   */
  clock(): {
    readonly phase: number;
    readonly tick: number;
    readonly alive?: boolean;
    readonly zone?: number;
    readonly cls?: number;
    readonly lastShotTick?: number;
  };
  /**
   * The pair the next shot is aimed along — `i8`, never `(0, 0)`; only its ratio reaches
   * the chain. Read at the trigger and nowhere else, so the caller resolves it against the
   * world as it stands at that instant: `App.tsx` auto-aims from the predicted position and
   * falls back to {@link octantAim} of the body's facing.
   */
  aim(): readonly [number, number];
  onMove(dir: number): void;
  /**
   * Every accepted trigger, live or practice, with the exact `i8` pair the shot was aimed
   * along and the tier it went as — draw it here and nowhere else. Called BEFORE
   * {@link onShoot} so the arrow leaves the bow at 0 ms rather than after a transaction is
   * built.
   *
   * Optional so a caller can be wired in either order, but a build that never sets it has
   * a spacebar that does nothing outside a fight, which is the bug this module was opened
   * for. `Shot.tsx::fireLocal` is what this is for.
   */
  onTrigger?(dx: number, dy: number, tier: ShotTier): void;
  /**
   * The subset of {@link onTrigger} that goes on the wire: free aim as an `i8` pair, never
   * `(0, 0)`, and the tier byte. The caller passes both straight to `shoot({ dx, dy,
   * tier })`; the chain normalises the pair and stamps `facing` from it, so nothing out
   * here decides an octant on the shot path.
   *
   * Called only when all four chain gates pass. Anything sent from here that the chain
   * refuses is invisible under `skipPreflight`, which is exactly why the gates are mirrored
   * rather than the refusals reported — with one exception, `NotCharged`, which the caller
   * confirms and answers by resending one tier down, once per rung, because the client
   * cannot see the step still in flight that the chain can.
   */
  onShoot(dx: number, dy: number, tier: ShotTier): void;
  /**
   * The hold's edge: `null` when fire is not held standing still (released, walking, dead),
   * otherwise the tier the stand has reached — 0 drawing, 1 charged ready, 2 super ready.
   * Once per change, never per pump — the archer's draw pose, the two arcs and the ready
   * cues hang off it (`Knight.tsx::chargeLocal`).
   */
  onCharge(tier: ShotTier | null): void;
}

/** Attaches every listener and the pump. The returned function removes all of them. */
export function attachControls(cfg: ControlsConfig): () => void {
  const held = new Set<string>();
  let pointerDown = false;
  let fireKeyDown = false;

  let lastMoveAt = Number.NEGATIVE_INFINITY;
  // Below any real tick by more than any class cooldown, so THIS record never gates the
  // first shot of a match. The roster's stamp is folded in on every pump, and that one
  // gates a fresh seat exactly as the chain does: its `last_shot_tick` is 0.
  let lastShotTick = Number.NEGATIVE_INFINITY;
  // Wall clock of the last trigger of either kind. Paces the practice arrow, which has no
  // tick to pace it, and stops one following a real shot through the gate inside a period.
  let lastFireAt = Number.NEGATIVE_INFINITY;
  // When the current hold began — the first of the pointer and the fire key to go down —
  // and `-Infinity` between holds, which is how `release` tells a real release apart.
  let fireDownAt = Number.NEGATIVE_INFINITY;
  // The last value handed to `onCharge`, so the edge fires once per change.
  let hold: ShotTier | null = null;
  // A released tier the cooldown is still holding. One deep: a second release needs a
  // second press, and a press inside the cooldown is the tap the gate already drops.
  let queued: ShotTier | null = null;

  const fireHeld = (): boolean => pointerDown || fireKeyDown;

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

  function setHold(next: ShotTier | null): void {
    if (next === hold) return;
    hold = next;
    cfg.onCharge(next);
  }

  /**
   * `tap` marks the pump a fire press dispatched itself: the one plain shot a standing
   * player gets, at 0 ms. Every other pump standing still fires only a queued release.
   */
  function pump(tap = false): void {
    const { phase, tick, alive, zone, cls, lastShotTick: stamped } = cfg.clock();
    const now = performance.now();

    // Dead. Every move and shot would come back `PlayerDead`, invisibly. Held keys are
    // deliberately NOT cleared: the respawn eight ticks later resumes whatever the player
    // is still pressing, and clearing would strand them standing still at the entrance.
    // The draw, though, comes down — a corpse does not hold a bow — and a queued release
    // goes with it: a super fired from the entrance eight ticks later is not the shot the
    // player stood for.
    if (alive === false) {
      setHold(null);
      queued = null;
      return;
    }

    const dir = heldDirection();
    if (dir !== null) {
      // One rule in every phase, on the wall clock, because the gate it mirrors is the ER
      // slot and the browser cannot see slots. This comment used to say a fight gates on
      // `arena.tick`; it has not since the chain moved both phases onto the slot.
      if (moveAllowed(now, lastMoveAt)) {
        lastMoveAt = nextMoveDeadline(now, lastMoveAt);
        cfg.onMove(dir);
      }
    }

    // Standing still is "no direction held". A direction held into a wall counts as walking
    // here although no step leaves — the chain would grant that hold and this mirror does
    // not, which errs toward a plain shot rather than a `NotCharged` round trip.
    const still = dir === null;
    const held = fireHeld();
    setHold(held && still ? tierReached(now, fireDownAt, lastMoveAt) : null);
    const tier = nextShot(queued, held, still, tap);
    if (tier === null) return;
    const klass = cls ?? CLASS_ARCHER;

    // `shoot` is Fighting-only AND arena-only on chain: outside either, the transaction is
    // built, signed, sent and refused with nothing to show for it. So it is not sent — the
    // trigger still fires, and only the send is dropped.
    const live = phase === PHASE_FIGHTING && (zone ?? ZONE_ARENA) === ZONE_ARENA;

    // The two clocks, each pacing the trigger it can see. Inside a live cooldown nothing is
    // drawn at all: the ring is already on screen counting it down, and an arrow there
    // would claim a shot the chain never took. The chain's stamp of the last shot, off the
    // roster, can be later than the tick this client saw at the send — pace against the
    // later of the two, or the next send is `RateLimited` and the shot is lost.
    if (stamped !== undefined) lastShotTick = Math.max(lastShotTick, stamped);
    if (live ? !shotAllowed(tick, lastShotTick, klass) : now - lastFireAt < periodMsFor(klass)) return;

    queued = null;
    if (live) lastShotTick = tick;
    lastFireAt = now;
    const [dx, dy] = cfg.aim();
    // Draw first, send second: the arrow is client-side either way, and a practice arrow
    // and a real one are the same arrow.
    cfg.onTrigger?.(dx, dy, tier);
    if (live) cfg.onShoot(dx, dy, tier);
  }

  /** The hold begins with whichever of the two fire inputs goes down first. */
  function fireDown(now: number): void {
    if (!fireHeld()) fireDownAt = now;
  }

  /**
   * The hold ends with the last of the two to go up, and the tier it reached is the shot.
   * Judged here rather than off `hold`: the edge is only re-read on a pump, and a release
   * 40 ms after one has 40 ms more stand than the edge knows about. A direction under the
   * release is walking — tier 0, and the auto-repeat already covered it — so a release
   * short of tier 1 queues nothing.
   */
  function release(now: number): void {
    // No hold open — a keyup for a press that landed before these listeners did, a pointer
    // coming up over the surface it never went down on, a blur with nothing held — is not
    // a release: `-Infinity` reads as an infinite stand and would queue a super the player
    // never drew, and the chain would grant it to anyone who had not stepped for 2.5 s.
    if (fireHeld() || fireDownAt === Number.NEGATIVE_INFINITY) return;
    const tier = heldDirection() === null ? tierReached(now, fireDownAt, lastMoveAt) : 0;
    fireDownAt = Number.NEGATIVE_INFINITY;
    if (tier !== 0) queued = tier;
    // Straight to the wire, as the press is: the queue drains on this pump when the
    // cooldown allows and on the first scheduled one that does when it does not.
    pump();
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
    const fire = event.code === FIRE_KEY;
    if (fire) {
      fireDown(performance.now());
      fireKeyDown = true;
    } else {
      held.add(event.code);
    }
    // Straight to the wire rather than waiting out the pump. `pump` re-reads the clock
    // and every gate, so this can only send what the next pump would have sent anyway,
    // one period sooner.
    pump(fire);
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    held.delete(event.code);
    if (event.code !== FIRE_KEY) return;
    fireKeyDown = false;
    release(performance.now());
  };

  // Alt-tabbing away never delivers the keyup, so without this the player keeps walking
  // in whatever direction they left in — for the rest of the match. The hold ends the way
  // a release ends it: a tier the player stood for is theirs whether the key or the tab
  // let go, and dropping it here would be the one silent drop this module has none of.
  const onBlur = (): void => {
    held.clear();
    fireKeyDown = false;
    pointerDown = false;
    release(performance.now());
  };

  const onPointerDown = (event: PointerEvent): void => {
    fireDown(performance.now());
    pointerDown = true;
    // Keeps the hold alive after the pointer leaves the viewport mid-press.
    cfg.surface.setPointerCapture(event.pointerId);
    pump(true);
  };

  const onPointerUp = (event: PointerEvent): void => {
    pointerDown = false;
    if (cfg.surface.hasPointerCapture(event.pointerId)) {
      cfg.surface.releasePointerCapture(event.pointerId);
    }
    release(performance.now());
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  cfg.surface.addEventListener('pointerdown', onPointerDown);
  cfg.surface.addEventListener('pointerup', onPointerUp);
  cfg.surface.addEventListener('pointercancel', onPointerUp);
  const pumpTimer = setInterval(pump, PUMP_MS);

  return () => {
    clearInterval(pumpTimer);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    cfg.surface.removeEventListener('pointerdown', onPointerDown);
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

  // Shots: strictly greater, so the chain's next accepted shot is `cooldown + 1` ticks
  // later — one class period, whatever TICK_MS is — and this mirror waits one tick more.
  // Expressed against the constant, never a literal: this block read `shotAllowed(9, 7)`
  // from the 400 ms era and was passing only because the mirror had gone stale in the same
  // direction.
  for (const cls of [CLASS_KNIGHT, CLASS_ARCHER]) {
    const cd = cooldownTicksFor(cls);
    assert(!shotAllowed(7 + cd, 7, cls), 'a shot inside the cooldown must be gated');
    assert(!shotAllowed(8 + cd, 7, cls), 'and so must the first tick past it: the slack');
    assert(shotAllowed(9 + cd, 7, cls), 'a shot past the slack must pass');
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
    shotAllowed(9 + cooldownTicksFor(CLASS_KNIGHT), 7, CLASS_KNIGHT) &&
      !shotAllowed(9 + cooldownTicksFor(CLASS_KNIGHT), 7, CLASS_ARCHER),
    'the archer must be the slower class',
  );
  assert(SHOT_MARGIN_TICKS * TICK_MS * 4 < periodMsFor(CLASS_KNIGHT), 'the slack is slack, not a second cooldown');
  // A zeroed `class_aim` decodes to the knight, so an omitted class and any byte this build
  // does not understand resolve to it rather than to `undefined` — `Hud.tsx` pins the same
  // default. The class this client SENDS is the pump's `cls ?? CLASS_ARCHER`, not this.
  assert(shotAllowed(9, 0) === shotAllowed(9, 0, CLASS_KNIGHT), 'an omitted class is the zeroed byte, the knight');
  assert(cooldownTicksFor(99) === cooldownTicksFor(CLASS_KNIGHT), 'an unknown class falls back to the knight');
  assert(periodMsFor(99) === periodMsFor(CLASS_KNIGHT), 'and so does its practice period');

  // The hold. Measured from the LATER of the press and the last step, with the margin on
  // top of the chain's `CHARGE_MS` / `SUPER_MS`: a step inside the hold restarts it, a
  // press after a long stand still waits the full hold, and the first hold of a match is
  // finite.
  const hold1 = holdMsFor(1);
  const hold2 = holdMsFor(2);
  assert(tierReached(hold1 - 1, 0, Number.NEGATIVE_INFINITY) === 0, 'a hold short of the margin is plain');
  assert(tierReached(hold1, 0, Number.NEGATIVE_INFINITY) === 1, 'a hold at the margin is charged');
  assert(tierReached(hold2 - 1, 0, Number.NEGATIVE_INFINITY) === 1, 'and stays charged short of the super hold');
  assert(tierReached(hold2, 0, Number.NEGATIVE_INFINITY) === 2, 'a hold at the super margin is a super');
  assert(tierReached(hold1, 0, 400) === 0, 'a step inside the hold restarts it');
  assert(tierReached(400 + hold1, 0, 400) === 1, 'and it accrues again from that step');
  assert(tierReached(hold1 - 1, hold1 - 1 - 100, Number.NEGATIVE_INFINITY) === 0, 'a long stand still does not pre-charge a fresh press');
  assert(CHARGE_MARGIN_MS > 0 && CHARGE_MARGIN_MS < CHARGE_MS, 'the margin is a margin, not a second hold');
  assert(hold2 - hold1 === SUPER_MS - CHARGE_MS, "the second arc is the chain's own gap: the margin is paid once");

  // What leaves on a pump. A queued release beats everything; a standing hold with no tap
  // fires nothing, because its shot is the release; walking auto-repeats plain.
  assert(nextShot(2, false, true, false) === 2, 'a queued release fires, held or not');
  assert(nextShot(1, true, true, true) === 1, 'and beats the tap of a new press');
  assert(nextShot(null, true, true, true) === 0, 'a press standing still is one plain tap');
  assert(nextShot(null, true, true, false) === null, 'a standing hold fires nothing by itself');
  assert(nextShot(null, true, false, false) === 0, 'walking auto-repeats plain');
  assert(nextShot(null, false, true, false) === null, 'nothing held, nothing queued, nothing fired');

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
