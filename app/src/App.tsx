/**
 * The shell: four screens, one linear flow, no router.
 *
 * Onboarding → character select → lobby → arena, and the only way back is a settled
 * match. A route table would buy history, deep links and code splitting for a flow with
 * no branches, no shareable URLs and one bundle — so the "route" is `screenOf(state)`,
 * which reads the seat's `zone` straight off the chain.
 *
 * What this file draws is the chrome: identity, roster, boss telemetry, the match clock,
 * the result. It does not draw the world. That is `#stage`, which the SVG renderer mounts
 * into — the two are kept apart deliberately, because everything below re-renders on state
 * changes and the renderer must not: a React re-render at 2.5 Hz that touches `d`, `fill`
 * or `x` is a full repaint landing at exactly the moment a bullet volley spawns.
 */

import { useEffect } from 'react';

import {
  BULLET_ACTIVE,
  MAX_SEATS,
  NO_TARGET,
  PHASE_LOBBY,
  PHASE_SETTLED,
  PHASE_SETTLING,
  ZONE_ARENA,
  type BossAccount,
} from '@heartrot/client';

import {
  mySeatSlot,
  screenOf,
  useSelect,
  useStore,
  type ConnectionStatus,
} from './state/store';

/**
 * Index-aligned with `Boss.parts`, which is index-aligned with the hitbox JSON
 * `tools/svg_slice.py` emits. One build step produces the `<g>` the browser animates and
 * the rectangle the program raycasts against, so this list may be renamed but never
 * reordered.
 */
const PART_NAMES = [
  'Ram crown',
  'Wolf head',
  'Beast head',
  'Thorns I',
  'Thorns II',
  'Thorns III',
  'Thorns IV',
  'Mace arm',
  'Claw arms',
] as const;

/**
 * `skin_id` is a render hint, not an index into chain state — the program does not
 * range-check it — so the count here and the Worker's `SKIN_COUNT` are the only bound,
 * and they have to agree.
 */
const SKINS = [
  { name: 'Vanguard', colour: '#4a7fd4', blurb: 'Plate and a tower shield. Slow, and hard to move.' },
  { name: 'Warden', colour: '#b5b56a', blurb: 'Chain and a poleaxe. Reads the room before it swings.' },
  { name: 'Reaver', colour: '#a06a80', blurb: 'Light mail, two blades. Alive only while it is moving.' },
] as const;

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  idle: 'offline',
  joining: 'joining',
  connecting: 'syncing',
  live: 'live',
  stale: 'stalled',
  settling: 'settling',
  error: 'error',
};

/** Ticks to `m:ss`. `tick` is the only clock — wall time is never authoritative here. */
function clock(ticks: number, tickMs: number): string {
  const total = Math.max(0, Math.round((ticks * tickMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function App() {
  const screen = useSelect(screenOf);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const status = useSelect((s) => s.status);
  const store = useStore();

  // The chain decides a match is over; somebody has to tell the base layer. `settle()`
  // is self-debouncing, so all twenty clients seeing this notification is fine.
  useEffect(() => {
    if (phase === PHASE_SETTLING && status !== 'settling') void store.settle();
  }, [phase, status, store]);

  return (
    <div className="shell">
      <Header />
      <main className="main">
        {screen === 'onboarding' && <Onboarding />}
        {screen === 'select' && <CharacterSelect />}
        {screen === 'lobby' && <Lobby />}
        {screen === 'arena' && <Arena />}
      </main>
      <ErrorBar />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Header() {
  const status = useSelect((s) => s.status);
  const seat = useSelect((s) => s.match?.seat ?? null);
  const incarnation = useSelect((s) => s.match?.incarnation ?? 0);
  const tick = useSelect((s) => s.arena?.tick ?? 0);

  return (
    <header className="header">
      <h1 className="wordmark">HEARTROT</h1>
      <span className="tag">incarnation {incarnation}</span>
      {seat !== null && <span className="tag">seat {seat}</span>}
      <span className="spacer" />
      <span className="tag tabular">tick {tick}</span>
      <span className={`dot dot-${status}`} aria-hidden="true" />
      <span className="tag">{STATUS_LABEL[status]}</span>
    </header>
  );
}

/**
 * Errors are shown, never swallowed. A stalled crank and a dry treasury both present as
 * "nothing is happening", and a player with no message assumes the former is their wifi.
 */
function ErrorBar() {
  const error = useSelect((s) => s.error);
  const status = useSelect((s) => s.status);
  if (!error && status !== 'stale') return null;
  return (
    <div className="errorbar" role="status">
      {error ?? 'The boss clock has stopped advancing. Waiting for the rollup to answer.'}
    </div>
  );
}

/**
 * Where the SVG world is drawn. Owned by the renderer, not by this file: React manages
 * the chrome around it and never the nodes inside it, so a HUD re-render cannot schedule
 * a repaint of 128 bullets.
 */
function Stage() {
  return <div id="stage" className="stage" role="presentation" />;
}

function Meter({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="meter">
      <span className="meter-fill" style={{ width: `${pct}%`, background: tone }} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Screen 1 — onboarding
// ---------------------------------------------------------------------------

function Onboarding() {
  const store = useStore();
  const busy = useSelect((s) => s.status === 'joining');

  // Both buttons are the same call on purpose. Privy exposes email, social *and*
  // Phantom/Backpack/WalletConnect through one Wallet Standard connector list, so the
  // spec's "two paths" is one code path — and the wallet, if there is one, is used for
  // identity only. It never signs a gameplay transaction and never sees a popup in play.
  const signIn = () => void store.signIn();

  return (
    <section className="card">
      <p className="eyebrow">A co-op raid that lives entirely on chain</p>
      <h2>Twenty of you. One boss. No health bar.</h2>
      <p className="lede">
        The boss is a shell, not a number. Break its crown, its heads, its thorn clusters —
        the thorns are what fire at you — and when enough of it is gone the chest vent opens
        and the face underneath becomes killable.
      </p>
      <p className="fine">
        Sign in once. There is no wallet popup during play, no seed phrase, and nothing to
        fund: your play key is generated in this browser, holds zero SOL, and never leaves.
      </p>
      <div className="row">
        <button className="btn btn-primary" onClick={signIn} disabled={busy}>
          {busy ? 'Signing in…' : 'Enter with email or social'}
        </button>
        <button className="btn" onClick={signIn} disabled={busy}>
          I already have a wallet
        </button>
      </div>
      <p className="fine">Devnet only. No token, no NFT, nothing to buy.</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen 2 — character select
// ---------------------------------------------------------------------------

function CharacterSelect() {
  const store = useStore();
  const skinId = useSelect((s) => s.skinId);
  const busy = useSelect((s) => s.status === 'joining');

  return (
    <section className="card">
      <p className="eyebrow">Choose a body</p>
      <h2>Character select</h2>
      <div className="skins">
        {SKINS.map((skin, index) => (
          <button
            key={skin.name}
            className="skin"
            aria-pressed={index === skinId}
            onClick={() => store.setSkin(index)}
          >
            <span className="skin-chip" style={{ background: skin.colour }} />
            <b>{skin.name}</b>
            <span className="fine">{skin.blurb}</span>
          </button>
        ))}
      </div>
      <p className="fine">
        Armour is cosmetic. Every knight has the same reach, the same speed and the same
        health — what changes the fight is which part of the boss the raid agrees to break
        first.
      </p>
      <button className="btn btn-primary" onClick={() => void store.join()} disabled={busy}>
        {busy ? 'Claiming a seat…' : 'Take a seat'}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Screen 3 — lobby
// ---------------------------------------------------------------------------

function Lobby() {
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const seated = useSelect((s) => s.players?.slots.filter((slot) => slot.occupied).length ?? 0);
  const throughGate = useSelect((s) => s.arena?.aliveCount ?? 0);

  return (
    <>
      <Stage />
      <aside className="panel">
        <h3>The lobby</h3>
        <p className="fine">
          Walk onto the gate. Enough of you standing on it starts the raid — that is the
          whole of matchmaking.
        </p>
        <dl className="stats">
          <div>
            <dt>Seated</dt>
            <dd className="tabular">
              {seated} / {MAX_SEATS}
            </dd>
          </div>
          <div>
            <dt>Through the gate</dt>
            <dd className="tabular">{throughGate}</dd>
          </div>
        </dl>
        <h3>Roster</h3>
        <ol className="roster">
          {(players?.slots ?? []).map((slot) => (
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
        {!players && <p className="fine">Waiting for the first roster update…</p>}
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// Screen 4 — arena
// ---------------------------------------------------------------------------

function Arena() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);

  return (
    <>
      <Stage />
      <aside className="panel">
        {phase === PHASE_LOBBY ? <Muster /> : <BossPanel />}
        <SelfPanel />
      </aside>
      {phase === PHASE_SETTLED && <Result />}
    </>
  );
}

/** Through the gate, boss not yet armed. Someone has to ask the Worker to start it. */
function Muster() {
  const store = useStore();
  const throughGate = useSelect((s) => s.arena?.aliveCount ?? 0);
  const busy = useSelect((s) => s.status === 'joining');

  return (
    <>
      <h3>Muster</h3>
      <p className="fine">
        {throughGate} through the gate. More knights mean more incoming fire, not a longer
        fight: each volley carries three bullets plus one per living raider.
      </p>
      <button
        className="btn btn-primary"
        onClick={() => void store.startMatch()}
        disabled={busy || throughGate === 0}
      >
        Wake it up
      </button>
      <p className="fine">
        Arming the raid delegates the arena to the rollup and schedules every boss tick up
        front. It takes five to fifteen seconds and cannot be undone.
      </p>
    </>
  );
}

function BossPanel() {
  const boss = useSelect((s) => s.boss);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const enrageAtTick = useSelect((s) => s.arena?.enrageAtTick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? 400);
  const alive = useSelect((s) => s.arena?.aliveCount ?? 0);
  const bullets = useSelect(
    (s) => s.arena?.bullets.reduce((n, b) => n + (b.active === BULLET_ACTIVE ? 1 : 0), 0) ?? 0,
  );

  if (!boss) return <p className="fine">Waiting for the boss to load…</p>;

  return (
    <>
      <h3>The amalgam</h3>
      <ul className="parts">
        {boss.parts.map((hp, index) => {
          const max = boss.partsMax[index] ?? 0;
          return (
            <li key={index} className={hp === 0 ? 'dead' : ''}>
              <span>{PART_NAMES[index]}</span>
              <Meter value={hp} max={max} />
              <span className="fine tabular">{hp === 0 ? 'gone' : hp}</span>
            </li>
          );
        })}
      </ul>
      <Vent boss={boss} />
      <dl className="stats">
        <div>
          <dt>Enrage in</dt>
          <dd className="tabular">{clock(Math.max(0, enrageAtTick - tick), tickMs)}</dd>
        </div>
        <div>
          <dt>Alive</dt>
          <dd className="tabular">{alive}</dd>
        </div>
        <div>
          <dt>Incoming</dt>
          <dd className="tabular">{bullets}</dd>
        </div>
        <div>
          <dt>Hunting</dt>
          <dd className="tabular">
            {boss.targetSeat === NO_TARGET ? '—' : `seat ${boss.targetSeat}`}
          </dd>
        </div>
      </dl>
    </>
  );
}

/**
 * The vent is derived on chain from the parts every tick and cached for us. Showing the
 * shell total next to it is what makes "shoot the shell off, then the face" legible
 * without a tutorial.
 */
function Vent({ boss }: { boss: BossAccount }) {
  const shell = boss.parts.reduce((a, b) => a + b, 0);
  const shellMax = boss.partsMax.reduce((a, b) => a + b, 0);
  const open = boss.ventOpen === 1;
  return (
    <div className="vent">
      <div className="vent-row">
        <span>Shell</span>
        <Meter value={shell} max={shellMax} tone="var(--flesh)" />
        <span className={`pill ${open ? 'pill-open' : ''}`}>
          {open ? 'VENT OPEN' : 'VENT SEALED'}
        </span>
      </div>
      <div className="vent-row">
        <span>Core</span>
        <Meter value={boss.coreHp} max={boss.coreHpMax} tone="var(--olive)" />
        <span className="fine">{open ? 'killable' : 'invulnerable'}</span>
      </div>
    </div>
  );
}

function SelfPanel() {
  const slot = useSelect(mySeatSlot);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? 400);
  if (!slot) return null;

  const dead = slot.hp === 0;
  return (
    <div className="self">
      <h3>You</h3>
      <div className="vent-row">
        <span>Health</span>
        <Meter value={slot.hp} max={slot.hpMax} tone={dead ? 'var(--gone)' : 'var(--ok)'} />
        <span className="fine tabular">
          {dead ? `respawn ${clock(Math.max(0, slot.respawnAtTick - tick), tickMs)}` : slot.hp}
        </span>
      </div>
      <p className="fine tabular">damage dealt {slot.damageDealt}</p>
    </div>
  );
}

/** The match is over and the leaderboard row is written. Nothing here is on chain twice. */
function Result() {
  const store = useStore();
  const slot = useSelect(mySeatSlot);
  const coreHp = useSelect((s) => s.boss?.coreHp ?? 0);
  const won = coreHp === 0;

  return (
    <div className="overlay">
      <div className="card">
        <p className="eyebrow">{won ? 'The core stopped' : 'The raid broke'}</p>
        <h2>{won ? 'It is dead. It will be back, larger.' : 'Wiped.'}</h2>
        <p className="lede tabular">
          {slot ? `${slot.damageDealt} damage dealt · ${slot.hp === 0 ? 'died' : 'survived'}` : ''}
        </p>
        <p className="fine">
          The arena has been committed back to the base layer and your row is on the
          leaderboard. The next incarnation has fifteen percent more shell per part.
        </p>
        <button className="btn btn-primary" onClick={() => store.leaveMatch()}>
          Back to the lobby
        </button>
      </div>
    </div>
  );
}
