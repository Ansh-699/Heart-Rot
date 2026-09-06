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
 * nothing is in reach. The pointer aims nothing any more; a pointer down is fire held —
 * except a touch on the LEFT half of the surface, which is a virtual thumbstick: its
 * travel from where it went down is the eight-way `dir` ({@link stickDirection}).
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
 * was paid for and the cooldown ring is the only reason the shot has not left. So is the
 * TAP inside the cooldown, and for the same reason ({@link queueAfterRefusal}) — it used to
 * be dropped in silence, which measured 4 sends from 8 taps at 930 ms. The hold is
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
 * trigger inside the cooldown calls neither YET — the ring is already on screen saying why
 * — and is queued, so the pump the gate opens for calls both. Prediction owns no number —
 * the arrow is the answer to "is the key bound", and `damageDealt` off the roster is the
 * answer to "did it hurt anything".
 *
 * The dead gate is prevention, not reaction, and it has to be: gameplay is sent with
 * `skipPreflight` and never confirmed, so `Custom(7)`/`Custom(8)` are not observable on
 * the hot path at all — the transaction returns a signature and quietly does nothing.
 * The authoritative signal is the roster the world feed already delivers (`hp == 0`,
 * final for the raid), which costs no round trip. Without it a corpse holding fire sends
 * one doomed `shoot` every 800 ms for the rest of the match.
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
 * 3. *Pump schedule.* The pump used to run on a fixed `setInterval(pump, PUMP_MS)` grid,
 *    which is a different clock from the move deadline. `nextMoveDeadline` claws back at
 *    most `MOVE_MS - MIN_GAP_MS` = 5 ms of lateness, so a tick later than that re-anchors
 *    and the next move slips a whole slot. Nothing on an idle machine (cadence p50 50.0,
 *    p95 51.5 ms) and one lost move per late tick on a busy one — the second player's
 *    laptop measured timer gaps p90 74 ms and 34 of 72 send gaps over 60 ms — and every
 *    lost slot is 50 ms of extra lag on the peer's screen that compounds while walking.
 *    The pump reschedules itself on the deadline instead ({@link pumpDelay}), so a late
 *    tick is followed by an EARLY one that takes the stolen slot back. `MIN_GAP_MS`'s own
 *    harness, pooled over two runs of 15 s cells with the 6 ms-per-frame block:
 *
 *    | keys/s | fixed grid | on the deadline | refusals/s, grid -> deadline |
 *    |---|---|---|---|
 *    | 0 | 19.59 | 19.70 accepted moves/s | 0.04 -> 0.17 |
 *    | 8 | 19.53 | 19.73 | 0.10 -> 0.17 |
 *    | 16 | 19.56 | 19.80 | 0.07 -> 0.10 |
 *
 *    The refusals ARE the recovery, not a regression: the send the floor allows 45 ms after
 *    a late one shares that slot with probability `(MOVE_MS - MIN_GAP_MS) / MOVE_MS`, so a
 *    tenth of the reclaimed slots come back refused and nine tenths come back as moves. The
 *    fixed grid bought its cleaner refusal count by never attempting the recovery at all.
 *    Net accepted is up in every cell, the whole band stays under 0.4 refusals/s — inside
 *    what the shipped floor already measures above — and the minimum gap never fell below
 *    45.0 ms in any cell. A hitch far past the floor (60 ms every 500 ms, measured 17.9/s)
 *    is not recoverable by either arm: 5 ms per send is all the floor will give back, and
 *    the floor is the chain's one-move-per-slot rule, not a tunable.
 */

import {
  AIM_MAX,
  CHARGE_MS,
  CLASS_ARCHER,
  CLASS_COOLDOWN_TICKS,
  CLASS_KNIGHT,
  CLASS_PERIOD_MS,
  PHASE_FIGHTING,
  PHASE_MUSTERING,
  PHASE_LOBBY,
  ZONE_LOBBY,
  ZONE_RANGE,
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
 * 400 ms for an archer. Both come from `@heartrot/client`, which derives them from
 * `CLASS_PERIOD_MS` through `ticksFor` exactly as `state.rs` does — no tick count is typed
 * anywhere on either side.
 *
 * This used to be a local `800 / TICK_MS - 1`, and `Hud.tsx` used to hold a third copy that
 * had gone stale at the 400 ms-era `1`: the pill went green 600 ms early, in a live fight,
 * while this module's own gate refused to send. That is the second half of "the space bar
 * doesn't work". `Hud.tsx` now imports this function, so the pill and the pump cannot
 * disagree again, and the archer's 400 ms lands in both the day a seat carries one.
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
 * What a pump has to fire, if anything: whatever is queued first — a release that was
 * earned or a tap the gate refused, and in both cases only the cooldown held it — else the
 * tap at a press or the walking auto-repeat, plain. A standing hold with no tap fires
 * nothing; its shot is the release. Pure, for the self-check, because both wrong answers
 * are silent: a dropped queue is a super the player stood 2.5 s for and never saw, and a
 * tap that also fires on release is two arrows.
 */
function nextShot(queued: ShotTier | null, held: boolean, still: boolean, tap: boolean): ShotTier | null {
  if (queued !== null) return queued;
  return held && (tap || !still) ? 0 : null;
}

/**
 * The queue after a trigger the cooldown refused. A tap is queued rather than dropped, and
 * that is the loudest of this module's silent losses: dropped, a press a little early left
 * no arrow, no ring and no error at all — measured live, 8 taps at 930 ms against the
 * knight's 900 ms effective gate sent 4 and the other 4 simply vanished, which reads as the
 * game ignoring the player. A tier already queued outranks it: the queue is one deep, and a
 * release was stood 1.25-2.75 s for while a tap costs one keypress. An auto-repeat queues
 * nothing — the next pump repeats it anyway, and queuing it would fire an arrow after the
 * key came up. Pure, for the self-check.
 */
function queueAfterRefusal(queued: ShotTier | null, tap: boolean): ShotTier | null {
  return queued === null && tap ? 0 : queued;
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

/** A thumb resting on the stick wobbles; travel inside this radius is standing still. */
const STICK_DEAD_PX = 12;

/**
 * The virtual thumbstick's offset from where the thumb went down → eight-way `facing`, or
 * `null` inside the dead zone. Screen vector, y down, the same sectors as {@link
 * dirFromVector}, so a thumb and a key held together agree on north.
 */
export function stickDirection(dx: number, dy: number): number | null {
  // ponytail: no hysteresis in stickDirection; add ±4° if the zigzag shows in playtests
  return dx * dx + dy * dy < STICK_DEAD_PX * STICK_DEAD_PX ? null : dirFromVector(dx, dy);
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
/** `player.rs::assert_playable`: the three phases a move or a shot can land in. */
function playable(phase: number): boolean {
  return phase === PHASE_LOBBY || phase === PHASE_MUSTERING || phase === PHASE_FIGHTING;
}

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

/**
 * How long until the next pump, one having just run at `now`. The pump rides the move
 * deadline rather than a fixed 50 ms grid, so a tick the browser delivered late is followed
 * by an EARLY one that takes the stolen slot back instead of losing it — header,
 * "Keypress-to-wire" 3, where the two arms are measured.
 *
 * A full `PUMP_MS` when nothing is due: an idle seat, or a phase that takes no step, leaves
 * the deadline in the past, and rescheduling at 0 there would spin the pump at the timer's
 * own floor for the whole lobby rather than recovering anything. Early is safe in either
 * case — the gate is re-read on every pump and `MIN_GAP_MS` is still the floor under it, so
 * an early pump either sends inside the rule or does nothing.
 */
function pumpDelay(now: number, lastMoveAt: number): number {
  const due = lastMoveAt + MOVE_MS - now;
  return due > 0 ? Math.min(PUMP_MS, due) : PUMP_MS;
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
  let fireKeyDown = false;
  // The pointer that is fire held, and the touch that is the thumbstick — by id, because a
  // second finger's up must not release the first finger's hold. A touch on the LEFT half
  // of the surface while no stick is down becomes the stick; every other pointer is fire,
  // and a second fire pointer is ignored. Mouse and pen never reach the stick branch.
  let fireId: number | null = null;
  let stickId: number | null = null;
  // Where the thumb went down: the stick's origin, and the sector is measured from it.
  let stickX = 0;
  let stickY = 0;
  let stickDir: number | null = null;

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
  // A released tier the cooldown is still holding, or a tap it refused. One deep: a second
  // release needs a second press, and a tap never displaces a release ({@link
  // queueAfterRefusal}). `queuedAt` is the wall clock it went in at, and it bounds a TAP
  // only: one class period late, `periodMsFor`, an arrow is a shot the player has stopped
  // expecting, so it is dropped instead of fired. A release is never dropped — the stand
  // was paid for, and the gate it waits on is one class period wide anyway.
  let queued: ShotTier | null = null;
  let queuedAt = 0;

  const fireHeld = (): boolean => fireId !== null || fireKeyDown;

  function heldDirection(): number | null {
    if (stickDir !== null) return stickDir;
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

    // Dead, and a death is final for the raid. Every move and shot would come back
    // `PlayerDead`, invisibly. Held keys are left alone — the next seat starts from a
    // fresh attach anyway. The draw comes down — a corpse does not hold a bow — and a
    // queued release goes with it.
    if (alive === false) {
      setHold(null);
      queued = null;
      return;
    }

    const dir = heldDirection();
    // A step needs a phase the chain will take it in — LOBBY, MUSTERING, FIGHTING
    // (`player.rs::assert_playable`). Holding a key on the results screen used to send one
    // move per slot into a SETTLED arena and paint the WrongPhase refusal on the screen.
    if (dir !== null && playable(phase)) {
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
    const klass = cls ?? CLASS_ARCHER;
    // A queued tap the gate never opened for is stale — see the declaration. Only a tap:
    // a queued release outlives everything but a death.
    //
    // The window is the GATE's width plus one pump, not the period's. A tap refused at the
    // very top of a cooldown waits the whole of it plus `SHOT_MARGIN_TICKS`, so a window of
    // one bare period expires the tap BEFORE the gate it is queued for ever opens, and the
    // press is lost exactly as it was before the queue existed — measured, knight: four
    // presses inside one cooldown produced no arrow at all. The extra `PUMP_MS` is not
    // slack: this drop runs EARLIER IN THE SAME PUMP than the gate check below, so a window
    // equal to the gate loses the tap to a tie on the one pump that could have fired it.
    if (queued === 0 && now - queuedAt >= periodMsFor(klass) + SHOT_MARGIN_TICKS * TICK_MS + PUMP_MS) {
      queued = null;
    }
    const tier = nextShot(queued, held, still, tap);
    if (tier === null) return;

    // Two shapes of shot the chain accepts, and they are paced by different clocks.
    //
    // `live` is the raid's: Fighting, in the pit, rate limited on the crank tick.
    //
    // `practice` is the waiting area's, and it is why a friend can see your arrows there
    // at all. It used to be refused on chain, so the client never sent it and the arrow
    // existed only in the shooter's own browser — two players shooting at each other in
    // the lobby each saw an empty room, which is the bug this pair of gates closes. The
    // chain limits it on the ER slot, because the crank has not started and `arena.tick`
    // is frozen at 0; the wall clock below is this side's mirror of that same period.
    // Anyone already through the gate is refused: weapons stay down in the pit.
    const live = phase === PHASE_FIGHTING && (zone ?? ZONE_ARENA) === ZONE_ARENA;
    // The range down the stairs shoots too: its straw is what it is for, and `shoot.rs`'s
    // practice path takes both zones in every phase a seat can act in — a raid in the pit
    // is no reason for the hall to lower its bows.
    const practice = playable(phase) && ((zone ?? ZONE_LOBBY) === ZONE_LOBBY || zone === ZONE_RANGE);

    // The two clocks, each pacing the trigger it can see. Inside a live cooldown nothing is
    // drawn at all: the ring is already on screen counting it down, and an arrow there
    // would claim a shot the chain never took. The chain's stamp of the last shot, off the
    // roster, can be later than the tick this client saw at the send — pace against the
    // later of the two, or the next send is `RateLimited` and the shot is lost.
    // Only while `live`. A practice shot stamps the same field with an ER SLOT — ~569
    // million against a tick that never reaches 4,000 — so folding that in would close
    // this gate for the rest of the page. The chain clears the stamp at the gate and
    // guards the value besides; this is the client's half of the same rule.
    if (live && stamped !== undefined) lastShotTick = Math.max(lastShotTick, stamped);
    if (live ? !shotAllowed(tick, lastShotTick, klass) : now - lastFireAt < periodMsFor(klass)) {
      // Refused, not dropped: the first pump the gate opens for fires it, and the send
      // below clears the queue, so it fires exactly once.
      //
      // Stamped from the LAST press, not the first. A player still pressing has plainly
      // not stopped expecting an arrow, and stamping once let one early tap start a clock
      // that expired every later tap in the same cooldown with it.
      if (queued === null || tap) queuedAt = now;
      queued = queueAfterRefusal(queued, tap);
      return;
    }

    queued = null;
    if (live) lastShotTick = tick;
    lastFireAt = now;
    const [dx, dy] = cfg.aim();
    // Draw first, send second: the arrow is client-side either way, and a practice arrow
    // and a real one are the same arrow.
    cfg.onTrigger?.(dx, dy, tier);
    if (live || practice) cfg.onShoot(dx, dy, tier);
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
    fireId = null;
    stickId = null;
    stickDir = null;
    release(performance.now());
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && stickId === null) {
      const rect = cfg.surface.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        stickId = event.pointerId;
        stickX = event.clientX;
        stickY = event.clientY;
        stickDir = null;
        cfg.surface.setPointerCapture(event.pointerId);
        return;
      }
    }
    // A second finger is not a second tap — but the SAME pointer pressing again (a mouse
    // whose up was eaten by a context menu) is, or desktop click-to-fire sticks.
    if (fireId !== null && fireId !== event.pointerId) return;
    fireDown(performance.now());
    fireId = event.pointerId;
    // Keeps the hold alive after the pointer leaves the viewport mid-press.
    cfg.surface.setPointerCapture(event.pointerId);
    pump(true);
  };

  // The stick's sector changes are a key going down: straight to the wire, one period
  // sooner than the next pump. Inside the dead zone the thumb is standing still, so a
  // hold under the other finger charges exactly as it does under the spacebar.
  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== stickId) return;
    const dir = stickDirection(event.clientX - stickX, event.clientY - stickY);
    if (dir === stickDir) return;
    stickDir = dir;
    pump();
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (cfg.surface.hasPointerCapture(event.pointerId)) {
      cfg.surface.releasePointerCapture(event.pointerId);
    }
    if (event.pointerId === stickId) {
      stickId = null;
      stickDir = null;
      return;
    }
    if (event.pointerId !== fireId) return;
    fireId = null;
    release(performance.now());
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  cfg.surface.addEventListener('pointerdown', onPointerDown);
  cfg.surface.addEventListener('pointermove', onPointerMove);
  cfg.surface.addEventListener('pointerup', onPointerUp);
  cfg.surface.addEventListener('pointercancel', onPointerUp);
  // Not a fixed grid: each pump schedules the next on the move deadline, so a tick the
  // browser delivered late is followed by an early one that recovers the slot instead of
  // losing it. {@link pumpDelay}, and "Keypress-to-wire" 3 for the two arms measured.
  // `finally`, because the reschedule IS the loop. `setInterval` was self-healing: one
  // throw skipped one tick and the next still came. A chained timeout whose reschedule
  // sits after the call would end input for the rest of the match on a single exception,
  // with the world still animating around a player whose keys do nothing.
  let pumpTimer = setTimeout(function tick() {
    try {
      pump();
    } finally {
      pumpTimer = setTimeout(tick, pumpDelay(performance.now(), lastMoveAt));
    }
  }, PUMP_MS);

  return () => {
    clearTimeout(pumpTimer);
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

  // The pump rides that deadline instead of a fixed grid, so a late tick is followed by an
  // early one. Both failures are silent: a grid loses the whole slot a late tick stole
  // (19.56 -> 19.80 moves/s at 16 keys/s, measured), and rescheduling at 0 with nothing due
  // spins the timer at its own floor for as long as the player stands still.
  assert(pumpDelay(0, 0) === MOVE_MS, 'a move just sent puts the next pump one slot out');
  assert(pumpDelay(10, 0) === MOVE_MS - 10, 'a pump 10 ms late is followed by one 10 ms early');
  assert(pumpDelay(0, Number.NEGATIVE_INFINITY) === PUMP_MS, 'nothing due waits a period rather than spinning');
  assert(pumpDelay(999, 0) === PUMP_MS, 'and so does a long idle');
  assert(pumpDelay(0, 999) === PUMP_MS, 'no pump is ever more than a period away');

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
  assert(periodMsFor(CLASS_ARCHER) === 400, "the archer's period is 400 ms");
  // Faster and lighter: a shot
  // an archer may take at tick t is one a knight may not.
  assert(
    shotAllowed(9 + cooldownTicksFor(CLASS_ARCHER), 7, CLASS_ARCHER) &&
      !shotAllowed(9 + cooldownTicksFor(CLASS_ARCHER), 7, CLASS_KNIGHT),
    'the archer is the faster class',
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

  // And what a trigger the cooldown refused leaves behind. Dropping it was this module's
  // loudest silent loss — 8 taps at 930 ms against the knight's 900 ms gate sent 4, and the
  // other 4 left nothing on screen at all. It fires EXACTLY ONCE: `nextShot` takes the queue
  // ahead of everything, the send clears it, and the pump after that finds the line above.
  assert(queueAfterRefusal(null, true) === 0, 'a tap inside the cooldown is queued, not dropped');
  assert(queueAfterRefusal(2, true) === 2, 'and never displaces a queued release');
  assert(queueAfterRefusal(null, false) === null, 'an auto-repeat queues nothing: the next pump repeats it anyway');
  assert(
    nextShot(queueAfterRefusal(null, true), false, true, false) === 0,
    'the queued tap fires on the next allowed pump, key up or not',
  );

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

  // The thumbstick: a resting thumb is standing still, past the dead zone it is the same
  // eight sectors as the keys, y down.
  assert(stickDirection(STICK_DEAD_PX - 1, 0) === null, 'a thumb inside the dead zone is standing still');
  assert(stickDirection(0, -20) === 0, 'a thumb pushed up is north');
  assert(stickDirection(20, 20) === 3, 'a thumb pushed down-right is south-east');
}
