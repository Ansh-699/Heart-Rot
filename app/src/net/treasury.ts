/**
 * `GET /api/faucet/status`, polled: the treasury that pays for every match, as a gauge.
 * Shared by the telemetry panel and the keep's vault. A failed poll leaves the last reading
 * in place -- the treasury is a gauge, not a control, so a gap is not worth an error state.
 */
import { useEffect, useState } from 'react';

const TREASURY_MS = 15_000;

export interface Treasury {
  lamports: number;
  matches: number;
}

export function useTreasury(): Treasury | null {
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const r = await fetch('/api/faucet/status');
        if (!r.ok || !live) return;
        const j = (await r.json()) as { treasuryLamports: string; estimatedMatches: number };
        const lamports = Number(j.treasuryLamports);
        if (!Number.isFinite(lamports) || !live) return;
        setTreasury({ lamports, matches: j.estimatedMatches });
      } catch {
        // See the module note: the last reading stands.
      }
    };
    void read();
    const id = window.setInterval(read, TREASURY_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);
  return treasury;
}
