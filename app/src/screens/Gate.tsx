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
 * the same countdown from the lobby. So the countdown, the roster and the auto-arm live
 * here, in one module both screens import — `screens/Lobby.tsx` renders all three, and
 * `ui/Hud.tsx` should render `<Muster />` where its deleted "Wake it up" button was.
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
  MAX_SEATS,
  MUSTER_TICKS,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  TICK_MS,
  ZONE_ARENA,
  onGate,
} from '@heartrot/client';

import { mySeatSlot, useSelect, type State } from '../state/store';
import { SKIN_COLORS } from './CharacterSelect';

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
 */
export function GatePrompt() {
  const slot = useSelect(mySeatSlot);
  if (!slot || !slot.occupied || slot.zone === ZONE_ARENA) return null;

  const gap = gateGap(slot.x, slot.y);
  if (gap === 0) {
    return (
      <div className="vent" role="status">
        <strong>Hold here. The gate is reading you.</strong>
        <p className="fine">
          You can let go of the keys. Your position on the gate is checked against the
          chain&rsquo;s copy a couple of times a second until it takes, so standing still is
          the correct thing to do.
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
// ---------------------------------------------------------------------------

/**
 * Twenty rows, always — an empty seat is information during a muster, because it is a seat
 * somebody can still walk into. `slots` is the decoded array straight off the last
 * notification, so this re-renders at notification rate and not per frame.
 */
export function Roster() {
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);

  if (!players) return <p className="fine">Waiting for the first roster update…</p>;

  return (
    <ol className="roster">
      {players.slots.map((slot) => {
        const inPit = slot.occupied && slot.zone === ZONE_ARENA;
        return (
          <li
            key={slot.seat}
            className={slot.occupied ? (inPit ? 'in-gate' : '') : 'empty'}
            aria-current={slot.seat === seat ? 'true' : undefined}
          >
            <span className="tabular">{String(slot.seat).padStart(2, '0')}</span>
            <span>
              {slot.occupied && <Dot skinId={slot.skinId} />}
              {slot.occupied ? (slot.seat === seat ? 'you' : 'knight') : '—'}
            </span>
            <span className="fine">{inPit ? 'pit' : ''}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** How many are seated and how many are through, as one block both screens can show. */
export function MusterCounts() {
  const seated = useSelect((s) => (s.players?.slots ?? []).filter((slot) => slot.occupied).length);
  const raiders = useSelect(raiderCount);

  return (
    <dl className="stats">
      <div>
        <dt>Seated</dt>
        <dd className="tabular">
          {seated} / {MAX_SEATS}
        </dd>
      </div>
      <div>
        <dt>In the pit</dt>
        <dd className="tabular">{raiders}</dd>
      </div>
    </dl>
  );
}

/**
 * The seat's colour, the same one the renderer fills its knight with, so a name in the list
 * and a figure on the floor are matchable at a glance. An out-of-range `skinId` is drawn
 * grey rather than dropped: the program never range-checks the byte it stores, so a client
 * one release behind the skin table must still render the roster.
 */
function Dot({ skinId }: { skinId: number }) {
  return (
    <span
      role="presentation"
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        marginRight: 6,
        borderRadius: '50%',
        background: SKIN_COLORS[skinId] ?? 'var(--dim)',
      }}
    />
  );
}

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
}
