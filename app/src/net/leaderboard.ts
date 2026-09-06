/**
 * `GET /api/leaderboard`, once per mount: the rows as the Worker shapes them
 * (`worker/src/routes.ts`) and the ring's write counter. Shared by the leaderboard card, the
 * landing's "N raider runs recorded", the keep's records and the crypt -- one fetch, one
 * shape, one place to change either.
 */
import { useEffect, useState } from 'react';

/** One row of `GET /api/leaderboard`. */
export interface LeaderboardRow {
  rank: number;
  raider: string;
  damage: number;
  outcome: number;
  incarnation: number;
  survived: boolean;
  arenaId: string;
}

export interface LeaderboardState {
  /** `null` until the response lands. */
  rows: LeaderboardRow[] | null;
  /** The ring's write counter, one per seated raider per settle; `null` until it lands. */
  total: number | null;
  failed: boolean;
}

/**
 * `all`: the whole ring (at most 128 rows) rather than the top fifty -- the crypt reads
 * incarnations and needs every row of each. `live` drops a response that lands after the
 * caller unmounted, which is the only way a state update can reach an unmounted card.
 */
export function useLeaderboard(all = false): LeaderboardState {
  const [state, setState] = useState<LeaderboardState>({ rows: null, total: null, failed: false });
  useEffect(() => {
    let live = true;
    fetch(all ? '/api/leaderboard?all' : '/api/leaderboard')
      .then((response) => {
        if (!response.ok) throw new Error(`leaderboard ${response.status}`);
        return response.json() as Promise<{ rows: LeaderboardRow[]; total?: number }>;
      })
      .then((body) => {
        if (live) setState({ rows: body.rows, total: typeof body.total === 'number' ? body.total : null, failed: false });
      })
      .catch(() => {
        if (live) setState({ rows: null, total: null, failed: true });
      });
    return () => {
      live = false;
    };
  }, [all]);
  return state;
}
