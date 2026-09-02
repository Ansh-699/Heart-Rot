/**
 * The lobby — the pre-fight zone, and the entire matchmaker.
 *
 * There is no queue service and there is no room for one. "Walk onto the gate" is the whole
 * feature, and every byte of state it needs is already on chain: standing on the gate tile
 * sends `enter_gate`, which flips that seat's `zone` to `ZONE_ARENA`, and the roster is just
 * `Players` rendered. No lobby-local list, no ready-check, nothing to fall out of sync with
 * the seat map.
 *
 * Which is also why there is no "enter the gate" button here, and — since
 * `docs/architecture/08-gate.md` §6 — no "wake it up" button on the far side either. The
 * gate is a tile you walk onto, and a button would be a second way to do the same thing
 * that skips the part where twenty knights visibly crowd onto one arch. That crowd *is* the
 * matchmaking UI. The first knight through opens a fixed-length window and the chain's own
 * crank ends it, so the copy below is now true: enough of you standing on it does start the
 * raid, and nobody is waiting on a server.
 *
 * **The gate check is not this screen's, and must never become an input callback's.**
 * `App.tsx`'s `useGateEntry` polls the authoritative seat — whatever the last `Players`
 * notification wrote — every 500 ms and re-sends until `zone` actually flips. The version
 * that fired inside `onMove` stranded players permanently: under `skipPreflight` the chain
 * still had them off the tile, the rejection was invisible, and a player who stopped
 * pressing keys produced no further `onMove` and so no retry. Hence the copy telling people
 * they can stand still — with the poll, that is true.
 *
 * This screen ends by itself: `screenOf` derives the arena screen from your own seat's
 * `zone`, so the moment your gate transaction lands, the next notification moves you —
 * mid-countdown, which is why the countdown lives in `screens/Gate.tsx` and is rendered by
 * both sides of that split rather than by this file.
 */

import { useSelect } from '../state/store';
import { GatePrompt, Muster, MusterCounts, Roster } from './Gate';

export function Lobby() {
  const incarnation = useSelect((s) => s.match?.incarnation ?? 0);

  return (
    <>
      {/* No `#stage` here. `App` declares the one stage node and both screens share it,
          because a portal whose container changes identity is deleted and rebuilt, not
          moved — and this screen ends by handing the arena straight to the next one. */}
      <aside className="panel">
        <h3>The lobby</h3>

        {/* Ordered as the player experiences it: where to walk, then how long, then who
            with. The prompt is first because it is the only thing on this screen that
            answers "what do I do", and it changes as you approach. */}
        <GatePrompt />

        <Muster />

        <MusterCounts />

        <h3>Roster</h3>
        <Roster />

        <p className="fine">
          Incarnation {incarnation}. Every raid the boss survives — or loses — it comes back
          with fifteen percent more shell on every part.
        </p>
      </aside>
    </>
  );
}
