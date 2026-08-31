/**
 * The raid HUD — the side panel on the arena screen.
 *
 * **The boss is the primary readout.** A destroyed part stops animating and visibly
 * detaches, and that is what a player actually watches; the art is the UI. This panel
 * exists for the three things the sprite cannot say precisely — how close the shell is to
 * the vent threshold, how much time is left, and your own health, which you cannot see
 * because you are looking at the boss. So it supports the sprite rather than replacing it.
 *
 * Everything here is read off `Arena`, `Boss` and `Players` and nothing else. `vent_open`
 * and `alive_count` are taken from the chain rather than recomputed, because the program
 * recomputes both every tick and a second opinion in the browser would be a slower,
 * occasionally-wrong copy of an authoritative number. `tick` is the only clock: it is what
 * the crank agrees with, and a free-running local counter drifts away from the thing that
 * decides whether a bullet hit you.
 *
 * React owns this panel and never the world. Everything below re-renders on every
 * notification; the renderer inside `#stage` must not, because a re-render at 2.5 Hz that
 * touches `d`, `fill` or `x` is a full repaint landing at exactly the moment a volley
 * spawns.
 */

import {
  BULLET_ACTIVE,
  NO_TARGET,
  N_PARTS,
  PHASE_LOBBY,
  type BossAccount,
} from '@heartrot/client';

import { mySeatSlot, useSelect, useStore } from '../state/store';

/**
 * Index-aligned with `Boss.parts`, which is index-aligned with the `part_index` array in
 * the hitbox JSON `tools/svg_slice.py` emits. One build step produces both the `<g>` the
 * browser animates and the rectangle the program raycasts against, so this list may be
 * renamed but never reordered.
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

// A labels array that has quietly drifted from `N_PARTS` mislabels every row after the
// gap and looks perfectly reasonable doing it. Fail at import instead.
if (PART_NAMES.length !== N_PARTS) {
  throw new Error(`Hud: ${PART_NAMES.length} part names for ${N_PARTS} parts`);
}

/** Thorn clusters are the only parts whose destruction changes incoming fire. */
const FIRST_THORN = 3;
const LAST_THORN = 6;

/** `Boss.vent_open` flips when `sum(parts) * 100 < sum(parts_max) * 35`. Integer, no float. */
const VENT_PERCENT = 35;

/** Ticks to `m:ss`. `tick` is authoritative; wall-clock time never is. */
function clock(ticks: number, tickMs: number): string {
  const total = Math.max(0, Math.round((ticks * tickMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The whole arena-side panel: muster before the boss is armed, telemetry after, and your
 * own health always. Render it inside `<aside className="panel">`.
 */
export function Hud() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  return (
    <>
      {phase === PHASE_LOBBY ? <Muster /> : <BossPanel />}
      <SelfPanel />
    </>
  );
}

function Meter({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="meter">
      <span className="meter-fill" style={{ width: `${pct}%`, background: tone }} />
    </span>
  );
}

/**
 * Through the gate, boss not yet armed. Someone has to ask the Worker to schedule it.
 *
 * `startMatch` is self-debouncing in the store, so twenty knights hammering this is fine
 * — nineteen of them get `already_started`, which is the intended outcome, not a failure.
 */
function Muster() {
  const store = useStore();
  const throughGate = useSelect((s) => s.arena?.aliveCount ?? 0);
  const busy = useSelect((s) => s.status === 'joining');

  return (
    <>
      <h3>Muster</h3>
      <p className="fine">
        {throughGate} through the gate. More knights mean more incoming fire, not a longer
        fight: every volley carries three bullets plus one per living raider. Break the
        thorn clusters and the volleys stop coming.
      </p>
      <button
        className="btn btn-primary"
        onClick={() => void store.startMatch()}
        disabled={busy || throughGate === 0}
      >
        {busy ? 'Waking it…' : 'Wake it up'}
      </button>
      <p className="fine">
        Arming the raid schedules every boss tick up front — a crank cannot re-arm itself,
        so there is no topping it up later. Five to fifteen seconds, and it cannot be
        undone.
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
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const incoming = useSelect(
    (s) => s.arena?.bullets.reduce((n, b) => n + (b.active === BULLET_ACTIVE ? 1 : 0), 0) ?? 0,
  );

  if (!boss) return <p className="fine">Waiting for the boss to load…</p>;

  const enraged = tick >= enrageAtTick;

  return (
    <>
      <h3>The amalgam</h3>
      <ul className="parts">
        {boss.parts.map((hp, index) => {
          const max = boss.partsMax[index] ?? 0;
          const silenced = hp === 0 && index >= FIRST_THORN && index <= LAST_THORN;
          return (
            <li key={PART_NAMES[index]} className={hp === 0 ? 'dead' : ''}>
              <span>{PART_NAMES[index]}</span>
              <Meter value={hp} max={max} />
              <span className="fine tabular">{hp === 0 ? (silenced ? 'silent' : 'gone') : hp}</span>
            </li>
          );
        })}
      </ul>

      <Vent boss={boss} />

      <dl className="stats">
        <div>
          <dt>{enraged ? 'Enraged' : 'Enrage in'}</dt>
          <dd className="tabular">
            {enraged ? 'now' : clock(Math.max(0, enrageAtTick - tick), tickMs)}
          </dd>
        </div>
        <div>
          <dt>Alive</dt>
          <dd className="tabular">{alive}</dd>
        </div>
        <div>
          <dt>Incoming</dt>
          <dd className="tabular">{incoming}</dd>
        </div>
        <div>
          <dt>Hunting</dt>
          <dd className="tabular">
            {boss.targetSeat === NO_TARGET
              ? '—'
              : boss.targetSeat === seat
                ? 'you'
                : `seat ${boss.targetSeat}`}
          </dd>
        </div>
      </dl>
    </>
  );
}

/**
 * The vent is derived on chain from the parts every tick and cached for us. Showing the
 * shell total next to it — and the threshold it has to cross — is what makes "strip the
 * shell, then shoot the face" legible without a tutorial.
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
      <p className="fine">
        {open
          ? 'The chest is open. Everything you put into the shell now is wasted.'
          : `The vent opens when the shell drops below ${VENT_PERCENT}%.`}
      </p>
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
          {/* `respawn_at_tick` is absolute, so a stale account reads 0 rather than
              counting backwards from a tick that has already passed. */}
          {dead ? `respawn ${clock(Math.max(0, slot.respawnAtTick - tick), tickMs)}` : slot.hp}
        </span>
      </div>
      <p className="fine tabular">damage dealt {slot.damageDealt}</p>
    </div>
  );
}
