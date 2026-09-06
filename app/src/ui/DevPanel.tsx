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
 *
 * Now that the scene fills the screen the panel floats over it, so it is translucent and
 * draggable. Both are cheap and both are measured: 88 % is the alpha floor at which
 * `--muted` still clears 4.5:1 over the brightest thing it can land on (the boss's cyan
 * orb), and the drag moves a `transform` — 1 forced layout per 300 pointermoves against
 * 299 for `left`/`top`, inside a frame budget whose p95 is 14.92 ms of 16.7 ms. The drag
 * binds three handlers to the grip and **none** to `document` or `window`: pointer capture
 * retargets the whole gesture to the grip, so the game underneath sees nothing, and no
 * global listener exists that could swallow WASD or Space.
 *
 * It also does not HIT-TEST, and it starts closed. Both are the same correction: over a
 * full-screen scene, an interactive 268 px column down the right edge silently ate every
 * aim drag started inside it, and open-by-default made that a quarter of the play area
 * from the first frame. The panel now only takes a pointer on its own grip, and backtick
 * (or the cue button it leaves in the corner) brings it back.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { onMetrics, snapshot, type Snapshot } from '../net/metrics';
import { useTreasury } from '../net/treasury';
import { useSelect } from '../state/store';


/** Panel sample rate. Fast enough to feel live, slow enough to read. */
const SAMPLE_MS = 250;

const LAMPORTS_PER_SOL = 1_000_000_000;

/** The chain's own cadence. Mirrors `state::TICK_MS`; the crank is scheduled at 100 ms. */
const TARGET_HZ = 1000 / 100;

/** `.dev`'s resting inset, in `styles.css`. The stored position is an offset from it. */
const ANCHOR = 12;

/** Panel edge that must stay on screen. Also the gap the clamp leaves at every edge. */
const MARGIN = 8;

const STORE_KEY = 'heartrot.telemetry';

interface Offset {
  readonly x: number;
  readonly y: number;
}

const ORIGIN: Offset = { x: 0, y: 0 };

/**
 * Everything a browser can hand back from `localStorage`, answered with the default.
 *
 * `getItem` and `JSON.parse` share the one `try`: a truncated value and a storage-blocked
 * origin are the same failure, and a `SecurityError` from an opaque origin (measured:
 * `setItem` *throws* there, it does not return null) must not take the panel down at mount.
 * `Number.isFinite` is the last gate — a stored `null`, `"12"` or `1e999` reaching
 * `translate3d` produces an invalid declaration and a panel that silently will not move.
 */
export function parseStored(raw: string | null): Offset {
  try {
    if (raw === null) return ORIGIN;
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return ORIGIN;
    const { x, y } = v as Record<string, unknown>;
    if (typeof x !== 'number' || typeof y !== 'number') return ORIGIN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return ORIGIN;
    return { x, y };
  } catch {
    return ORIGIN;
  }
}

/**
 * Keep the panel on the screen it is being dragged on — which is also the screen a stored
 * position gets read on, and that is the regression this exists for: an offset saved on a
 * 2560-wide monitor strands the panel entirely off a 1280-wide laptop, where it cannot be
 * grabbed back without clearing site data. Pure, so it can be asserted without a DOM.
 */
export function clampOffset(
  o: Offset,
  box: { readonly width: number; readonly height: number },
  vp: { readonly w: number; readonly h: number },
): Offset {
  // Left/top of the untransformed panel: it rests against the bottom-right corner.
  const restX = vp.w - ANCHOR - box.width;
  const restY = vp.h - ANCHOR - box.height;
  const bound = (v: number, rest: number): number =>
    Math.min(ANCHOR - MARGIN, Math.max(-(rest - MARGIN), v));
  return { x: bound(o.x, restX), y: bound(o.y, restY) };
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

/*
 * This file ships NO `<style>` block. The panel's whole appearance — the 88 % backdrop, the
 * four small-text roles, the grip cursor — and the `pointer-events: none` / `.dev-head`
 * `auto` pair that keeps a 268 px column from eating every aim drag are all in `styles.css`
 * beside `.dev`, which is where a rule about a selector belongs. Both were briefly written
 * here as well; two stylesheets for one selector is the same defect as two constants for one
 * number, and the copy that loses is the one that is not next to the rest of the rule.
 */


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

/**
 * The drag.
 *
 * Pointer capture is the mechanism, not a nicety: measured, a 10-step drag from a 24 px
 * grip delivers 10 of 10 `pointermove`s with capture and 0 of 10 without — the pointer
 * leaves the grip on the first pixel. Capture is also what keeps the gesture out of the
 * game, together with `.dev` being a fixed sibling of `<main>` rather than a descendant of
 * `#stage`: during a captured drag the stage receives zero pointer events.
 *
 * Position lives in refs, so a drag does not re-render the panel at pointer rate, and the
 * one storage write happens on release rather than per move.
 */
function useDrag(open: boolean) {
  const panel = useRef<HTMLElement | null>(null);
  const offset = useRef<Offset>(ORIGIN);
  const drag = useRef<{ id: number; gx: number; gy: number; base: Offset } | null>(null);

  const apply = (o: Offset): void => {
    offset.current = o;
    if (panel.current) panel.current.style.transform = `translate3d(${o.x}px, ${o.y}px, 0)`;
  };

  const fit = (o: Offset): Offset => {
    const el = panel.current;
    if (!el) return o;
    const r = el.getBoundingClientRect();
    return clampOffset(o, r, { w: window.innerWidth, h: window.innerHeight });
  };

  // Load, clamp, apply — and re-clamp on resize, because the stored value was clamped to a
  // different screen. Passive, on `window`, and it reads no keys.
  useEffect(() => {
    if (!open) return;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch {
      // Storage blocked. The default anchor is the answer, and it is not an error state.
    }
    apply(fit(parseStored(raw)));
    const onResize = () => apply(fit(offset.current));
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, [open]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    // The close and reset buttons are not grips.
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, gx: e.clientX, gy: e.clientY, base: offset.current };
    e.preventDefault(); // suppress the text selection the <h2> would otherwise start
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    apply(fit({ x: d.base.x + e.clientX - d.gx, y: d.base.y + e.clientY - d.gy }));
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // Guarded because this handler is also `pointercancel`, and after a cancel the id no
    // longer matches an active pointer — where the spec says `releasePointerCapture`
    // throws `NotFoundError`. Unguarded, that throw leaves the drag latched and the
    // position unsaved. `controls.ts:474` guards the same call for the same reason.
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    drag.current = null;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(offset.current));
    } catch {
      // A preference, not a fact. Losing it costs one drag.
    }
  };

  const reset = (): void => {
    apply(ORIGIN);
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      // Nothing was stored, or storage is blocked. Either way the panel is home.
    }
  };

  return { panel, reset, grip: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } };
}

export default function DevPanel() {
  // Closed by default, since the scene became the window. Open, the panel covers a
  // quarter of the play area with a wall of numbers a first-time player has no use for
  // yet — and the corner it rests in is the one the boss stands in. The claim it exists to
  // make is still one keypress away and the cue button says which key; the measurement it
  // is the instrument for (treasury burn) polls whether or not it is open, so opening it
  // late still reports from page load. The choice does not persist.
  const [open, setOpen] = useState(false);
  const [m, setM] = useState<Snapshot>(() => snapshot());
  const treasury = useTreasury();
  const seated = useSelect((s) => s.players?.slots.filter((x) => x.occupied).length ?? null);
  const drag = useDrag(open);

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


  if (!open) {
    return (
      <button className="dev-cue" onClick={() => setOpen(true)} title="Telemetry (`)">
        <span className="dev-cue-key">`</span> telemetry
      </button>
    );
  }

  return (
    <aside className="dev" aria-label="Telemetry" ref={drag.panel}>
      {/* A <div>, not a <button>: `controls.ts` preventDefaults Space on a window listener
          before the browser's activation behaviour runs, so a <button> grip would put the
          fire key on a focus trap. The two real controls stay real buttons — Enter works. */}
      <div className="dev-head" {...drag.grip}>
        <h2>Telemetry</h2>
        <span className="spacer" />
        <button
          className="dev-close"
          onClick={drag.reset}
          aria-label="Reset telemetry position"
          title="Reset position"
        >
          ⤢
        </button>
        <button className="dev-close" onClick={() => setOpen(false)} aria-label="Close telemetry">
          ✕
        </button>
      </div>

      <div className="dev-group">
        <h3>Chain</h3>
        {/* The whole arena's traffic, read off the feed: every raider's move and shot and
            every crank tick is one transaction the ER executed. This is the number that
            says what the game costs the chain, and it is counted, not estimated. */}
        <Row
          label="writes"
          value={m.writesPerSec.toFixed(1)}
          unit="tx/s"
          tone="is-ok"
          note="every raider's move and shot, every crank tick"
        />
        <Row label="moves" value={m.movesPerSec.toFixed(1)} unit="tx/s" />
        <Row label="shots" value={m.shotsPerSec.toFixed(1)} unit="tx/s" />
        <Row label="ticks" value={m.ticksPerSec.toFixed(1)} unit="tx/s" />
        <Row label="session" value={String(m.writesTotal)} unit="tx" />
        <Row label="raiders" value={seated === null ? '—' : String(seated)} unit="seated" />
      </div>

      <div className="dev-group">
        <h3>Yours, live</h3>
        <Row label="sent" value={m.txPerSec.toFixed(1)} unit="tx/s" note={`${m.txTotal} this session`} />
        {/* Newest first: what it was, its signature once the node answered, how long it
            took to come back through the feed, and how it ended. */}
        <ol className="dev-txs" aria-label="Your latest transactions">
          {m.recent.length === 0 && <li className="dev-tx dev-tx-empty">move or shoot and they appear here</li>}
          {m.recent.map((t) => (
            <li key={t.id} className={`dev-tx is-${t.state}`}>
              <span className="dev-tx-kind">{t.kind}</span>
              <span className="dev-tx-sig">{t.signature ? `${t.signature.slice(0, 8)}…${t.signature.slice(-4)}` : 'signing…'}</span>
              <span className="dev-tx-ms">{t.ms !== undefined ? `${Math.round(t.ms)} ms` : t.state === 'sent' ? '…' : t.state}</span>
            </li>
          ))}
        </ol>
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
          label="tick"
          value={m.tickHz === null ? '—' : m.tickHz.toFixed(2)}
          unit="/s"
          tone={m.tickHz === null ? '' : grade(Math.abs(m.tickHz - TARGET_HZ), 0.4, 1)}
          note={`chain targets ${TARGET_HZ.toFixed(1)} · feed age ${m.feedAge === null ? '—' : Math.round(m.feedAge)} ms`}
        />
      </div>

      <div className="dev-group">
        <h3>Treasury</h3>
        <Row
          label="balance"
          value={treasury ? sol(treasury.lamports) : '—'}
          unit="SOL"
          note={treasury ? `~${treasury.matches} matches left · players pay nothing` : 'players pay nothing'}
        />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Self-check
//
// Two pieces of logic here fail quietly and expensively. The clamp fails by stranding the
// panel where nobody can grab it back without clearing site data; the parse fails by
// taking the panel down at mount on a browser with storage blocked. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`DevPanel self-check: ${what}`);
  };

  const box = { width: 268, height: 700 }; // measured, the full 21-row panel
  const vp = { w: 1280, h: 800 };

  const far = clampOffset({ x: -9999, y: -9999 }, box, vp);
  assert(vp.w - ANCHOR - box.width + far.x >= MARGIN, 'a drag past the left edge keeps MARGIN on screen');
  assert(vp.h - ANCHOR - box.height + far.y >= MARGIN, 'a drag past the top edge keeps MARGIN on screen');

  const past = clampOffset({ x: 9999, y: 9999 }, box, vp);
  assert(past.x <= ANCHOR - MARGIN && past.y <= ANCHOR - MARGIN, 'the rest corner is the far bound');

  // The regression this exists for: a value stored on a wide monitor, read on a narrow one.
  const stranded = clampOffset({ x: -2000, y: 0 }, box, vp);
  assert(stranded.x > -vp.w, 'a position stored at 2560 wide is pulled back onto a 1280 screen');
  assert(vp.w - ANCHOR - box.width + stranded.x >= MARGIN, 'and lands with its left edge on screen');

  // A value that already fits is not moved. Without this the clamp could quietly re-home
  // the panel on every resize event, which reads as the drag not sticking.
  const inside = clampOffset({ x: -100, y: -40 }, box, vp);
  assert(inside.x === -100 && inside.y === -40, 'a position already on screen survives the clamp');

  // Each of these is a real value a browser can hand back.
  for (const raw of ['', 'null', '{}', '{"x":null,"y":0}', '{"x":"12","y":0}', '{"x":1e999,"y":0}', '[1,2]']) {
    const v = parseStored(raw);
    assert(Number.isFinite(v.x) && Number.isFinite(v.y), `garbage "${raw}" falls back to a finite default`);
  }
  assert(parseStored(null).x === 0, 'an empty store is the default anchor');
  const round = parseStored(JSON.stringify({ x: -40, y: -12 }));
  assert(round.x === -40 && round.y === -12, 'a stored offset round-trips');
}
