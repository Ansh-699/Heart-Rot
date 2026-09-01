/**
 * Telemetry and treasury spend, toggled with the backtick key.
 *
 * The panel exists because this project's whole claim is a measurable one — the chain is
 * the game loop and the player pays nothing — and a claim like that should be legible
 * from inside the running app, not only from a spike write-up.
 *
 * Everything shown is observed. Latency comes from matching a `move`'s `seq` against the
 * roster's `lastMoveSeq`; treasury spend is the delta of a balance this page polls. The
 * one constant, the player's own cost, is constant because ER fees are zero and the ER
 * runs no fee-payer validation — a session keypair with no account on either chain played
 * a whole match on devnet. It is labelled as a fact, not computed from nothing.
 *
 * Rendering is decoupled from the event rate: metrics arrive far faster than anyone can
 * read them, so the panel samples at 4 Hz rather than re-rendering per transaction.
 */

import { useEffect, useState } from 'react';

import { onMetrics, snapshot, type Snapshot } from '../net/metrics';
import { useSelect } from '../state/store';

/** Treasury poll interval. It moves once per match, so this is already generous. */
const TREASURY_MS = 15_000;

/** Panel sample rate. Fast enough to feel live, slow enough to read. */
const SAMPLE_MS = 250;

const LAMPORTS_PER_SOL = 1_000_000_000;

/** The chain's own cadence: `boss_tick` is scheduled at 400 ms. */
const TARGET_HZ = 2.5;

interface Treasury {
  readonly lamports: number;
  readonly matches: number;
}

function sol(lamports: number, dp = 4): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(dp);
}

/** Semantic grade for a value that should stay low. */
function grade(v: number | null, ok: number, warn: number): string {
  if (v === null) return '';
  if (v <= ok) return 'is-ok';
  return v <= warn ? 'is-warn' : 'is-bad';
}

function Row({
  label,
  value,
  unit,
  tone = '',
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  note?: string;
}) {
  return (
    <div className="dev-row">
      <span className="dev-label">{label}</span>
      <span className={`dev-value tabular ${tone}`}>
        {value}
        {unit ? <span className="dev-unit">{unit}</span> : null}
      </span>
      {note ? <span className="dev-note">{note}</span> : null}
    </div>
  );
}

export default function DevPanel() {
  const [open, setOpen] = useState(false);
  const [m, setM] = useState<Snapshot>(() => snapshot());
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const status = useSelect((s) => s.status);
  // Match identity, because "the chain says one thing and the screen says another" is the
  // failure this project keeps hitting, and it is unanswerable without knowing WHICH
  // arena and WHICH validator the tab is actually reading.
  const arenaId = useSelect((s) => s.match?.arenaId ?? null);
  const mySeat = useSelect((s) => s.match?.seat ?? null);
  const erEndpoint = useSelect((s) => s.match?.erEndpoint ?? null);
  const seated = useSelect((s) => s.players?.slots.filter((x) => x.occupied).length ?? null);

  // Backtick toggles. Ignored while typing so it never eats a keystroke meant for a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Backquote' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Sample rather than subscribe-and-render: `onMetrics` fires per transaction, and at 20
  // seats that is far more often than a human reads. Subscribing only wakes the timer.
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const tick = () => setM(snapshot());
    const id = window.setInterval(tick, SAMPLE_MS);
    const off = onMetrics(() => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
      });
    });
    tick();
    return () => {
      window.clearInterval(id);
      off();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [open]);

  // Treasury polls whether or not the panel is open, so the session burn is measured from
  // when the page loaded rather than from when someone first pressed backtick.
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
        setOpening((v) => (v === null ? lamports : v));
      } catch {
        // A failed poll leaves the last reading on screen. The treasury is a gauge, not a
        // control, so a gap is not worth an error state.
      }
    };
    void read();
    const id = window.setInterval(read, TREASURY_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  if (!open) {
    return (
      <button className="dev-cue" onClick={() => setOpen(true)} title="Telemetry (`)">
        <span className="dev-cue-key">`</span> telemetry
      </button>
    );
  }

  const burn = treasury && opening !== null ? opening - treasury.lamports : null;

  return (
    <aside className="dev" aria-label="Telemetry">
      <div className="dev-head">
        <h2>Telemetry</h2>
        <button className="dev-close" onClick={() => setOpen(false)} aria-label="Close telemetry">
          ✕
        </button>
      </div>

      <div className="dev-group">
        <h3>Round trip</h3>
        <Row
          label="p50"
          value={m.p50 === null ? '—' : String(Math.round(m.p50))}
          unit="ms"
          tone={grade(m.p50, 300, 600)}
          note="write to visible"
        />
        <Row
          label="p95"
          value={m.p95 === null ? '—' : String(Math.round(m.p95))}
          unit="ms"
          tone={grade(m.p95, 500, 900)}
        />
        <Row
          label="last"
          value={m.last === null ? '—' : String(Math.round(m.last))}
          unit="ms"
          tone={grade(m.last, 300, 600)}
        />
      </div>

      <div className="dev-group">
        <h3>Throughput</h3>
        <Row label="sent" value={m.txPerSec.toFixed(1)} unit="tx/s" />
        <Row label="acked" value={m.ackPerSec.toFixed(1)} unit="tx/s" />
        <Row label="in flight" value={String(m.pending)} />
        <Row
          label="unacked"
          value={(m.dropRate * 100).toFixed(0)}
          unit="%"
          tone={grade(m.dropRate, 0.05, 0.25)}
          note="rate limited or lost"
        />
        <Row label="session" value={String(m.txTotal)} unit="tx" />
      </div>

      <div className="dev-group">
        <h3>Feed</h3>
        <Row
          label="tick"
          value={m.tickHz === null ? '—' : m.tickHz.toFixed(2)}
          unit="/s"
          tone={m.tickHz === null ? '' : grade(Math.abs(m.tickHz - TARGET_HZ), 0.4, 1)}
          note="chain targets 2.5"
        />
        <Row
          label="feed age"
          value={m.feedAge === null ? '—' : String(Math.round(m.feedAge))}
          unit="ms"
          tone={grade(m.feedAge, 1500, 3000)}
        />
        <Row label="socket" value={status} />
      </div>

      <div className="dev-group">
        <h3>Match</h3>
        <Row label="arena" value={arenaId === null ? '—' : String(arenaId)} />
        <Row label="your seat" value={mySeat === null ? '—' : String(mySeat)} />
        <Row
          label="roster"
          value={seated === null ? '—' : String(seated)}
          unit="seated"
          note={seated === 0 && mySeat !== null ? 'you hold a seat the roster does not show' : undefined}
          tone={seated === 0 && mySeat !== null ? 'is-bad' : ''}
        />
        <Row
          label="validator"
          value={erEndpoint ? erEndpoint.replace(/^https?:\/\//, '').replace(/\/$/, '') : '—'}
        />
      </div>

      <div className="dev-group">
        <h3>Cost</h3>
        <Row label="you pay" value="0" unit="SOL" tone="is-ok" note="ER fees are zero" />
        <Row
          label="treasury"
          value={treasury ? sol(treasury.lamports) : '—'}
          unit="SOL"
          note={treasury ? `~${treasury.matches} matches left` : undefined}
        />
        <Row
          label="burned"
          value={burn === null ? '—' : sol(Math.max(0, burn), 5)}
          unit="SOL"
          note="since you loaded the page"
        />
      </div>

      <p className="dev-foot">
        Latency is a <code>move</code>&apos;s <code>seq</code> matched against the roster.
        Sends are fire-and-forget, so a refusal is only ever visible as an unacked write.
      </p>
    </aside>
  );
}
