/**
 * The lobby — the pre-fight zone, and the entire matchmaker.
 *
 * There is no queue service and there is no room for one. "Walk onto the gate" is the whole
 * feature, and every byte of state it needs is already on chain: standing on the gate tile
 * sends `enter_gate`, which flips that seat's `zone` to `ZONE_ARENA`, and the roster below
 * is just `Players` rendered. No lobby-local list, no ready-check, nothing to fall out of
 * sync with the seat map.
 *
 * Which is also why there is no "enter the gate" button here. The gate is a tile you walk
 * onto, and a button would be a second way to do the same thing that skips the part where
 * twenty knights visibly crowd onto one arch. That crowd *is* the matchmaking UI.
 *
 * **The gate check is not this screen's, and must never become an input callback's.**
 * `App.tsx`'s `useGateEntry` polls the authoritative seat — whatever the last `Players`
 * notification wrote — every 500 ms and re-sends until `zone` actually flips. The version
 * that fired inside `onMove` stranded players permanently: under `skipPreflight` the chain
 * still had them off the tile, the rejection was invisible, and a player who stopped
 * pressing keys produced no further `onMove` and so no retry. Hence the copy below telling
 * people they can stand still — with the poll, that is now true.
 *
 * This screen ends by itself: `screenOf` derives the arena screen from your own seat's
 * `zone`, so the moment your gate transaction lands, the next notification moves you.
 */

import { MAX_SEATS, ZONE_ARENA } from '@heartrot/client';

import { useSelect } from '../state/store';
import { SKIN_COLORS } from './CharacterSelect';

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
          WASD or the arrow keys to walk. Head for the gate in the middle of the map — enough
          of you standing on it starts the raid, and that is the whole of matchmaking. Nobody
          is waiting on a server.
        </p>
        <p className="fine">
          Once you are on the gate you can let go of the keys. The gate is checked against
          the chain&rsquo;s copy of where you are, a couple of times a second, until it takes.
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
                <span>
                  {slot.occupied && <Dot skinId={slot.skinId} />}
                  {slot.occupied ? (slot.seat === seat ? 'you' : 'knight') : '—'}
                </span>
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

/**
 * The seat's colour, the same one the renderer fills its circle with, so a name in this
 * list and a dot on the floor are matchable at a glance. An out-of-range `skinId` is drawn
 * grey rather than dropped: the program never range-checks the byte it stores, so a client
 * that is one release behind the skin table must still render the roster.
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
