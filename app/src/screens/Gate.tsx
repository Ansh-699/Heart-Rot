/**
 * The gate, the muster and the hand-off into the spawn — the three pieces of the pre-fight
 * that belong to **neither** screen.
 *
 * This is not a screen and must not become one. `screenOf` has four values and the gate is
 * not one of them: the gate is a tile you walk onto in the lobby, and the instant your
 * `enter_gate` lands your own seat's `zone` flips and `screenOf` moves you to the arena. A
 * fifth screen wedged in between would have to be entered and left on a chain fact that
 * already moves you, i.e. it would be a second router disagreeing with the first.
 *
 * But the muster window straddles the split. `docs/architecture/08-gate.md` §5.3: the knight
 * who opened the window is already on the arena screen while everyone still walking watches
 * the same countdown from the lobby. So the countdown and the approach prompt live here,
 * in one module and two callers: `ui/Hud.tsx` renders `<Muster />` in its top-centre
 * cluster, which is on screen on **both** sides of the gate, and `screens/Lobby.tsx`
 * renders `<GatePrompt />` as the one line of instruction anchored bottom-centre over the
 * waiting room.
 *
 * The twenty-row roster and the seat counts that used to live here went with the 320 px
 * panel (`17-fullscreen-spec.md` §9.1); `Hud`'s top-left cluster is the one roster now.
 *
 * Three rules from the spec that are load-bearing and easy to undo by accident:
 *
 * 1. **No local `setInterval` countdown.** The chain's `tick` is the clock. A crank
 *    interval is a floor, not a guarantee (`settle.rs` — "ticks drift under load rather
 *    than catching up"), so a wall-clock timer and the chain disagree by more the longer
 *    the window runs. Everything below is a projection of `fight_at_tick - tick`.
 * 2. **Select integers, render seconds.** The Magic Router delivers every notification
 *    twice and 68.4% of `Players` frames carry no change. A component that selected the
 *    whole arena object would re-render ~20x/s for a number that changes once a second.
 *    Every `useSelect` here returns a number, a boolean or a stable slot reference.
 * 3. **Sub-second smoothness is CSS, not JavaScript.** The bar is a `scaleX` on `--fill`
 *    with a 160 ms linear transition already in `styles.css`, so ten notifications a
 *    second read as a continuous drain with no rAF callback and nothing added to the frame
 *    loop.
 */

import type { CSSProperties } from 'react';

import {
  GATE_MAX_X,
  GATE_MAX_Y,
  GATE_MIN_X,
  GATE_MIN_Y,
  MAP_TILE,
  MUSTER_TICKS,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  PHASE_ROLLED,
  PHASE_ROLLING,
  PHASE_SETTLED,
  PHASE_SETTLING,
  TICK_MS,
  ZONE_ARENA,
  onGate,
} from '@heartrot/client';

import { mySeatSlot, useSelect, type State } from '../state/store';

// ---------------------------------------------------------------------------
// Selectors — all primitives, per rule 2 above
// ---------------------------------------------------------------------------

/** Seats standing in the pit. The chain's `alive_count` says the same thing, but it is
 *  written only by `enter_gate` before the crank exists; counting the roster the client
 *  already holds costs nothing and cannot disagree with the list drawn underneath it. */
function raiderCount(state: State): number {
  return (state.players?.slots ?? []).filter((slot) => slot.occupied && slot.zone === ZONE_ARENA)
    .length;
}

// ---------------------------------------------------------------------------
// Beat 3 — the interaction
// ---------------------------------------------------------------------------

/**
 * Will the chain take an `enter_gate` at all in this phase?
 *
 * `assert_playable` (`handlers/player.rs:502`), mirrored. Exported because `App.tsx`'s
 * retry loop tests the same three phases inline to decide whether to send, and the prompt
 * below tells the player which of the two is happening — one table, or the copy eventually
 * says "the gate is reading you" over a loop that has stopped sending.
 */
export function gateOpen(phase: number): boolean {
  return phase === PHASE_LOBBY || phase === PHASE_MUSTERING || phase === PHASE_FIGHTING;
}

/** World units from `(x, y)` to the nearest edge of the gate block; 0 while standing on it. */
function gateGap(x: number, y: number): number {
  const dx = Math.max(GATE_MIN_X - x, 0, x - GATE_MAX_X);
  const dy = Math.max(GATE_MIN_Y - y, 0, y - GATE_MAX_Y);
  return Math.max(dx, dy);
}

/**
 * "Walk there, then hold" — the whole interaction, in the two states it has.
 *
 * Rendered from the **authoritative** slot, and it disappears on the authoritative flip.
 * That is deliberate and it is the honest half of the split `08-gate.md` §5.1 draws: the
 * ~127 ms round trip is feedback that the chain took the input, and hiding the prompt
 * optimistically would show nothing at all if the send were dropped and the 500 ms poll had
 * to retry. The *instant* half — the gate lighting under your feet off `predictor.self` —
 * is the renderer's node and the frame loop's alone; React must never own it.
 *
 * A third state, and a second voice for the hold, because "stand still, it is being sent"
 * is a claim and this prompt used to make it unconditionally. Two ways it is false:
 *
 * - **Nothing is being sent at all.** `assert_playable` (`handlers/player.rs:502`) refuses
 *   `enter_gate` outside the three phases below, and `App.tsx`'s retry loop mirrors that
 *   and returns without sending. `layout.ts`'s own phase table asks for exactly this — "so
 *   a UI can say *why* an action is unavailable rather than sending it and losing".
 * - **Something came back refused.** `enter_gate`'s refusals include the ones retrying
 *   cannot heal — `WrongSessionKey` (a second tab rotated the seat's key), `WrongPhase`
 *   racing the crank — and telling that player their position is being checked "until it
 *   takes" is the one sentence that guarantees they wait forever. The message itself is
 *   NOT repeated here: `App.tsx`'s error bar is its one renderer and this reads a boolean,
 *   so the prompt corrects its own advice without becoming a second copy of the notice.
 */
export function GatePrompt() {
  const slot = useSelect(mySeatSlot);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const refused = useSelect((s) => s.error !== null);
  if (!slot || !slot.occupied || slot.zone === ZONE_ARENA) return null;

  if (!gateOpen(phase)) {
    return (
      <div className="vent" role="status">
        <strong>The gate is shut.</strong>
        <p className="fine">
          This raid is past the point where the gate takes anyone, so nothing is being sent
          for you any more. The verdict lands when the chain finishes settling it, and the
          next raid starts from this room.
        </p>
      </div>
    );
  }

  const gap = gateGap(slot.x, slot.y);
  if (gap === 0) {
    return (
      <div className="vent" role="status">
        <strong>
          {refused ? 'The gate is still trying.' : 'Hold here. The gate is reading you.'}
        </strong>
        <p className="fine">
          {refused
            ? 'Something came back refused — the notice on the right says what. Keep standing here: the gate is re-sent a couple of times a second, and every refusal that answering again can clear is cleared that way.'
            : 'You can let go of the keys. Your position on the gate is checked against the chain’s copy a couple of times a second until it takes, so standing still is the correct thing to do.'}
        </p>
      </div>
    );
  }

  return (
    <div className="vent" role="status">
      <strong className="tabular">{Math.round(gap / MAP_TILE)} tiles to the gate</strong>
      <p className="fine">
        WASD or the arrow keys. The gate is the wide arch below the pit — walk onto it and
        stop.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beats 4–6 — the wait, the spawn, the landing
// ---------------------------------------------------------------------------

/**
 * The window: who is in, how long is left, and what happens at zero.
 *
 * Renders on both screens and returns null outside the two pre-fight phases, so `Hud` can
 * mount it unconditionally where the "Wake it up" button was.
 */
export function Muster() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const fightAtTick = useSelect((s) => s.arena?.fightAtTick ?? 0);
  // `?? TICK_MS`, never `?? 400`: the fallback is only reached before `/api/session/init`
  // answers, which is exactly when the lobby is on screen, and a 400 ms-era default would
  // render a 20-second window as 80 seconds.
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  const raiders = useSelect(raiderCount);

  if (phase !== PHASE_LOBBY && phase !== PHASE_MUSTERING) return null;

  // Waiting for the first knight. There is no deadline yet because nobody has opened one.
  if (phase === PHASE_LOBBY || fightAtTick === 0) {
    return (
      <>
        <h3>Muster</h3>
        <p className="fine">
          {raiders === 0
            ? 'Nobody is in the pit yet. The first knight through the gate opens a twenty-second window; everyone who reaches the gate before it closes fights in the same raid.'
            : 'Someone is in the pit. Arming the crank takes a few seconds of devnet round trips, and then the window opens for everyone.'}
        </p>
      </>
    );
  }

  const remaining = Math.max(0, fightAtTick - tick);
  const seconds = Math.ceil((remaining * tickMs) / 1000);

  return (
    <>
      <h3>Muster</h3>
      <div className="vent" role="status" aria-live="polite">
        <span className="tabular" style={{ fontSize: 22 }}>
          {seconds}s
        </span>
        {/* One number, three renderings: the digits above, the bar here, and `aria-valuenow`
            for anyone who sees neither. `--fill` drives a composited scaleX with a 160 ms
            linear transition, so ten notifications a second read as one continuous drain. */}
        <span
          className="meter"
          role="meter"
          aria-label="Time until the boss lands"
          aria-valuenow={remaining}
          aria-valuemin={0}
          aria-valuemax={MUSTER_TICKS}
        >
          <span
            className="meter-fill"
            style={{ ['--fill']: MUSTER_TICKS > 0 ? remaining / MUSTER_TICKS : 0 } as CSSProperties}
          />
        </span>
        <p className="fine">
          {raiders} in the pit. The gate stays open — anyone still walking gets in.
        </p>
      </div>
      <p className="fine">
        At zero the thing lowers itself over the rim and weapons go live. Nobody presses
        anything: the chain&rsquo;s own crank ends the window, so the raid starts whether or
        not the rest of the lobby arrives.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Who else is here
//
// Nowhere, any more. The twenty-row `<Roster>`, the `Seated / In the pit` counts and the
// skin dot that went with them were the 320 px panel's, and the panel is deleted
// (`17-fullscreen-spec.md` §9.1). `ui/Hud.tsx`'s top-left cluster carries the same fact as
// twenty dots — same `SKIN_COLORS` entry, same `zone` test, a screen-reader label per seat
// — in a cluster that is on screen on BOTH sides of the gate, which the roster never was.
// One list, one place; a second copy here would be the drift this file's header warns about.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Self-check
//
// One piece of non-trivial logic left: the distance that drives the approach prompt. It
// fails silently in production — a wrong gap says "3 tiles" while you stand on the arch.
// Dev-only, in the style of `App.tsx`'s gate check.
//
// The single-elector check that used to live here went with the election itself. Every
// client fires now (`App.tsx`'s `useMuster`), because `LOBBY → MUSTERING` is single-shot on
// chain and `store.startMatch` swallows the `already_started` nineteen of them get.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const fail = (message: string): never => {
    throw new Error(`Gate self-check: ${message}`);
  };

  if (!onGate(GATE_MIN_X, GATE_MIN_Y) || gateGap(GATE_MIN_X, GATE_MIN_Y) !== 0) {
    fail('the gate block corner is not on the gate');
  }
  if (gateGap(GATE_MAX_X, GATE_MAX_Y) !== 0) fail('the far gate corner reads as off-gate');
  if (gateGap(GATE_MIN_X - 4 * MAP_TILE, GATE_MIN_Y) !== 4 * MAP_TILE) {
    fail('four tiles west of the gate is not four tiles from the gate');
  }
  // The gate block is not square — x spans four tiles and y spans two — so a gap that
  // measured from a single MIN/MAX pair would be wrong on one axis and right on the other.
  if (gateGap(GATE_MIN_X, GATE_MAX_Y + 2 * MAP_TILE) !== 2 * MAP_TILE) {
    fail('the gate block is being measured as a square');
  }

  const slot = (seat: number, occupied: boolean, zone: number) =>
    ({ seat, occupied, zone }) as never;
  const roster = {
    players: { slots: [slot(0, true, 0), slot(1, true, ZONE_ARENA), slot(2, true, ZONE_ARENA)] },
  } as unknown as State;

  if (raiderCount(roster) !== 2) fail('the pit count is wrong');

  // The other silent-failure predicate: a phase missing from `gateOpen` tells a player
  // mid-raid that the gate is shut while the loop is still sending for them, and a phase
  // wrongly included leaves the old lie in place. Both are invisible without this.
  for (const open of [PHASE_LOBBY, PHASE_MUSTERING, PHASE_FIGHTING]) {
    if (!gateOpen(open)) fail(`phase ${open} takes enter_gate and gateOpen says it does not`);
  }
  for (const shut of [PHASE_SETTLING, PHASE_SETTLED, PHASE_ROLLING, PHASE_ROLLED]) {
    if (gateOpen(shut)) fail(`phase ${shut} refuses enter_gate and gateOpen says it does not`);
  }
}
