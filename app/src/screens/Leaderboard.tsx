/**
 * The leaderboard — the landing's one detour, and the one screen that reads a route
 * instead of the chain.
 *
 * The ring lives in the `Leaderboard` PDA on base, and the browser has no base-layer RPC:
 * the paid provider's token is a Worker secret, and the public devnet endpoint is what
 * `Env.BASE_RPC_URL` exists to avoid. So the Worker reads, ranks and shortens
 * (`GET /api/leaderboard`, thirty seconds at the edge) and this screen only renders what
 * it is handed. Nothing here is derived a second time — the rank, the eight-character
 * raider and the top-fifty cut are the route's, so a row on this table and a row in a
 * curl of the route cannot disagree.
 *
 * It is a flag in the store (`State.leaderboard`) and not a step: `Back` clears it and
 * `screenOf` returns to whatever the sign-in and the seat already say.
 */

import { useEffect, useState } from 'react';

import { OUTCOME_ENRAGE, OUTCOME_WIN, OUTCOME_WIPE } from '@heartrot/client';

import { useStore } from '../state/store';

/** One row of `GET /api/leaderboard`, as the Worker shapes it (`worker/src/routes.ts`). */
type Row = {
  rank: number;
  raider: string;
  damage: number;
  outcome: number;
  incarnation: number;
  arenaId: string;
};

/**
 * The match's outcome, as a column word. `OUTCOME_UNDECIDED` is every row written before
 * the field existed (`LeaderboardEntry.outcome`) and reads as an em dash rather than as
 * a fourth verdict the chain never gave.
 */
const OUTCOME_WORD: Readonly<Record<number, string>> = {
  [OUTCOME_WIN]: 'win',
  [OUTCOME_WIPE]: 'wipe',
  [OUTCOME_ENRAGE]: 'enrage',
};

/**
 * The HUD's vocabulary on a card: pixel labels at 9 px with letter-spacing, `--mono`
 * numbers, one `--line` rule between rows. The body scrolls inside the card because
 * `.main:has(> .card)` centres the card, and a card taller than the window centred in a
 * grid cell loses its top edge above the viewport — fifty rows are taller than 1080.
 */
const LEADERBOARD_CSS = `
.card.board { width: 100%; }
.board .rows { max-height: 60vh; overflow-y: auto; }
.board table { width: 100%; border-collapse: collapse; }
.board th { padding: 0 8px 8px; text-align: left; font: 9px var(--pixel); letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); }
.board td { padding: 7px 8px; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
.board .num { text-align: right; }
.board .rank { color: var(--muted); }
.board .win { color: var(--ok); }
.board .wipe { color: var(--ember); }
.board .enrage { color: var(--torch); }
`;

export function Leaderboard() {
  const store = useStore();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  // One fetch per mount. `live` drops a response that lands after `Back`, which is the
  // only way a state update can reach an unmounted card.
  useEffect(() => {
    let live = true;
    fetch('/api/leaderboard')
      .then((response) => {
        if (!response.ok) throw new Error(`leaderboard ${response.status}`);
        return response.json() as Promise<{ rows: Row[] }>;
      })
      .then((body) => {
        if (live) setRows(body.rows);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  const note = failed
    ? 'The leaderboard did not answer. Try again in a moment.'
    : rows === null
      ? 'Reading the leaderboard…'
      : rows.length === 0
        ? 'No raid has been recorded yet.'
        : null;

  return (
    <section className="card board">
      <style>{LEADERBOARD_CSS}</style>
      <p className="eyebrow">Top fifty by damage</p>
      <h2>Leaderboard</h2>
      {rows === null || note !== null ? (
        <p className="fine" role="status">
          {note}
        </p>
      ) : (
        <div className="rows">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Raider</th>
                <th className="num">Damage</th>
                <th>Outcome</th>
                <th className="num">Incarnation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                // Ties share a rank, so the rank alone is not a key; the row's place in
                // the response is, and the list never reorders.
                <tr key={index}>
                  <td className="num rank">{row.rank}</td>
                  <td>{row.raider}</td>
                  <td className="num">{row.damage.toLocaleString()}</td>
                  <td className={OUTCOME_WORD[row.outcome] ?? ''}>
                    {OUTCOME_WORD[row.outcome] ?? '—'}
                  </td>
                  <td className="num">{row.incarnation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <button className="btn btn-quiet" onClick={() => store.hideLeaderboard()}>
        Back
      </button>
    </section>
  );
}
