/**
 * The lobby — bright, outdoor, and the entire matchmaker.
 *
 * There is no queue service and there is no room for one. "Enough players standing on the
 * gate starts the raid" is the whole feature, and every byte of state it needs is already
 * on chain: walking onto the gate tile sends `enter_gate`, which flips that seat's `zone`
 * to `ZONE_ARENA`, and the roster below is just `Players` rendered. No lobby-local list,
 * no ready-check, nothing to fall out of sync with the seat map.
 *
 * Which is also why there is no "enter the gate" button here. The gate is a tile you walk
 * onto — the renderer submits `enter_gate` when your predicted position reaches it — and
 * a button would be a second way to do the same thing that skips the part where twenty
 * knights visibly crowd onto one stone arch. That crowd *is* the matchmaking UI.
 *
 * This screen ends by itself: `screenOf` derives the arena screen from your own seat's
 * `zone`, so the moment your gate transaction confirms, the next notification moves you.
 * Arming the raid belongs to the muster panel on the far side of the gate, not here.
 */

import { MAX_SEATS, ZONE_ARENA } from '@heartrot/client';

import { useSelect } from '../state/store';

export function Lobby() {
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const incarnation = useSelect((s) => s.match?.incarnation ?? 0);

  // Both counts are derived here rather than selected, because a selector that builds a
  // fresh array or object makes every snapshot compare unequal and React answers that by
  // re-rendering forever instead of by warning.
  const slots = players?.slots ?? [];
  const seated = slots.filter((slot) => slot.occupied);
  const onGate = seated.filter((slot) => slot.zone === ZONE_ARENA);

  return (
    <>
      {/* The renderer's territory. It mounts the lobby room into this node and React must
          never touch what is inside it. */}
      <div id="stage" className="stage" role="presentation" />

      <aside className="panel">
        <h3>The lobby</h3>
        <p className="fine">
          Walk onto the gate at the far end. Enough of you standing on it starts the raid —
          that is the whole of matchmaking. Nobody is waiting on a server.
        </p>

        <dl className="stats">
          <div>
            <dt>Seated</dt>
            <dd className="tabular">
              {seated.length} / {MAX_SEATS}
            </dd>
          </div>
          <div>
            <dt>On the gate</dt>
            <dd className="tabular">{onGate.length}</dd>
          </div>
        </dl>

        <h3>Roster</h3>
        {players ? (
          <ol className="roster">
            {slots.map((slot) => (
              <li
                key={slot.seat}
                className={slot.occupied ? (slot.zone === ZONE_ARENA ? 'in-gate' : '') : 'empty'}
              >
                <span className="tabular">{String(slot.seat).padStart(2, '0')}</span>
                <span>{slot.occupied ? (slot.seat === seat ? 'you' : 'knight') : '—'}</span>
                <span className="fine">{slot.zone === ZONE_ARENA ? 'gate' : ''}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="fine">Waiting for the first roster update…</p>
        )}

        <p className="fine">
          Incarnation {incarnation}. Every raid the boss survives — or loses — it comes back
          with fifteen percent more shell on every part.
        </p>
      </aside>
    </>
  );
}
