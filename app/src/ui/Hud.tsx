/**
 * The raid HUD — the side panel on the arena screen.
 *
 * The stage draws primitive shapes: a circle per knight, a bigger shape for the boss, dots
 * for bullets. That is deliberately illegible about *numbers*, so this panel carries all of
 * them — your hp, how close the shell is to the vent threshold, which parts are still
 * standing, the core once it is reachable, the tick, and how the fight ended.
 *
 * Everything here is read off `Arena`, `Boss` and `Players` and nothing else. `vent_open`,
 * `alive_count` and `outcome` are taken from the chain rather than recomputed, because the
 * program writes all three and a second opinion in the browser would be a slower,
 * occasionally-wrong copy of an authoritative number. `tick` is the only clock: it is what
 * the crank agrees with, and a free-running local counter drifts away from the thing that
 * decides whether a bullet hit you.
 *
 * **Transaction feedback comes from the same accounts, not from a catch block.** `move` and
 * `shoot` are sent `skipPreflight` and fire-and-forget, so a `Custom(7) RateLimited` or
 * `Custom(8) PlayerDead` rejection arrives — if at all — long after it mattered. But both
 * codes are pure functions of state this panel already has: `RateLimited` is exactly
 * `last_move_tick == tick` / `tick <= last_shot_tick + 1`, and `PlayerDead` is exactly
 * `hp == 0`. So the cadence row below predicts the rejection instead of reporting it, which
 * is both earlier and never wrong. Neither is an error; both are the normal shape of play.
 *
 * React owns this panel and never the world. Everything below re-renders on every
 * notification; the renderer inside `#stage` must not.
 */

import type { CSSProperties } from 'react';

import {
  BULLET_ACTIVE,
  MUZZLES,
  NO_TARGET,
  N_PARTS,
  OUTCOME_ENRAGE,
  OUTCOME_UNDECIDED,
  OUTCOME_WIN,
  OUTCOME_WIPE,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  TICK_MS,
  type BossAccount,
} from '@heartrot/client';

import { Muster } from '../screens/Gate';
import { mySeatSlot, useSelect } from '../state/store';

/**
 * Index-aligned with `Boss.parts`, which is index-aligned with `PART_HITBOXES` — the table
 * the program raycasts against and the boss rig draws from. The comment on
 * `hitboxes.ts::PART_HITBOXES` is the authority for this order and this list mirrors it:
 * thorn0, thorn1, thorn2, thorn3, crown, wolf_l, beast_r, mace, claws.
 *
 * **May be renamed, never reordered.** These were the old pre-renumber order (crown first,
 * thorns 3..6) and every row on the panel was therefore labelled with a different limb than
 * the bar beside it was measuring — a defect nothing fails on, because the names are the
 * only thing that carries the meaning.
 */
const PART_NAMES = [
  'Thorns I',
  'Thorns II',
  'Thorns III',
  'Thorns IV',
  'Ram crown',
  'Wolf head',
  'Beast head',
  'Mace arm',
  'Claw arms',
] as const;

// A labels array that has quietly drifted from `N_PARTS` mislabels every row after the
// gap and looks perfectly reasonable doing it. Fail at import instead.
if (PART_NAMES.length !== N_PARTS) {
  throw new Error(`Hud: ${PART_NAMES.length} part names for ${N_PARTS} parts`);
}

/**
 * Thorn clusters are the only parts whose destruction changes incoming fire, and after the
 * renumbering they are the first four — the same four `MUZZLES` names, which is the check:
 * `MUZZLES[i].part === i` for `i` in `FIRST_THORN..=LAST_THORN` (asserted below).
 */
const FIRST_THORN = 0;
const LAST_THORN = 3;

/** `Boss.vent_open` flips when `sum(parts) * 100 < sum(parts_max) * 35`. Integer, no float. */
const VENT_PERCENT = 35;

/**
 * `SHOT_COOLDOWN_TICKS` from `handlers/shoot.rs`, where the test is strictly greater.
 *
 * ponytail: third copy of this constant (chain, `input/controls.ts`, here). All three retire
 * together if the client package ever exports the gate values; until then a wrong copy only
 * mislabels a pill, which is why this is the cheap place to keep it.
 */
const SHOT_COOLDOWN_TICKS = 1;

/** Ticks to `m:ss`. `tick` is authoritative; wall-clock time never is. */
function clock(ticks: number, tickMs: number): string {
  const total = Math.max(0, Math.round((ticks * tickMs) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Shell integrity, in the same integer arithmetic the program compares against. */
function shellPercent(shell: number, shellMax: number): number {
  return shellMax > 0 ? Math.floor((shell * 100) / shellMax) : 0;
}

/**
 * The whole arena-side panel: muster before the boss is armed, telemetry after, your own
 * health always, and the verdict once there is one. Render it inside `<aside className="panel">`.
 */
export function Hud() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  // `PHASE_MUSTERING` has to be tested explicitly. Without it the muster falls into
  // `BossPanel`, which renders an enrage clock off `enrageAtTick` — and that field is now
  // stamped at the MUSTERING → FIGHTING flip, so it reads 0 for the whole window: a 0:00
  // countdown for a fight that has not begun. `Muster` is `screens/Gate`'s, rendered by
  // both sides of the gate so the countdown does not vanish when your seat crosses it.
  const mustering = phase === PHASE_LOBBY || phase === PHASE_MUSTERING;
  return (
    <>
      <Verdict />
      {mustering ? <Muster /> : <BossPanel />}
      <SelfPanel />
    </>
  );
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * `Arena.outcome` is a byte the program writes once and never revises, and the three losing
 * and winning shapes are genuinely different events: the core died, everyone died, or the
 * clock ran out with the core alive. Collapsing them into "you lost" throws away the only
 * information that tells a raid what to do differently, so each gets its own row.
 */
const VERDICTS: Readonly<Record<number, { readonly label: string; readonly line: string }>> = {
  [OUTCOME_WIN]: {
    label: 'WIN',
    line: 'The core stopped. It comes back with fifteen percent more shell on every part.',
  },
  [OUTCOME_WIPE]: {
    label: 'WIPE',
    line: 'Every raider standing in the arena was down on the same tick.',
  },
  [OUTCOME_ENRAGE]: {
    label: 'ENRAGE',
    line: 'The enrage tick passed with the core still alive. Not a wipe — you ran out of clock.',
  },
};

function Verdict() {
  const outcome = useSelect((s) => s.arena?.outcome ?? OUTCOME_UNDECIDED);
  const row = VERDICTS[outcome];
  if (!row) return null;
  return (
    <div className={`verdict verdict-${row.label.toLowerCase()}`} role="status">
      <span className="verdict-label">{row.label}</span>
      <span className="fine">{row.line}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meters
// ---------------------------------------------------------------------------

/**
 * A bar is a picture of a number, and a screen reader sees neither. `role="meter"` plus
 * the three values is what makes it a number again; `label` is required rather than
 * optional because an unnamed meter reads as "45 percent" of nothing.
 *
 * The fill drives a `--fill` custom property and a composited `scaleX`, never `width`:
 * ~30 of these redraw on the same 2.5 Hz notification and animating `width` relayouts
 * every one of them on every frame. Do not revert it.
 */
function Meter({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span
      className="meter"
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <span
        className="meter-fill"
        style={{ ['--fill']: pct / 100, background: tone } as CSSProperties}
      />
    </span>
  );
}

function BossPanel() {
  const boss = useSelect((s) => s.boss);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const enrageAtTick = useSelect((s) => s.arena?.enrageAtTick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  const alive = useSelect((s) => s.arena?.aliveCount ?? 0);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const incoming = useSelect(
    (s) => s.arena?.bullets.reduce((n, b) => n + (b.active === BULLET_ACTIVE ? 1 : 0), 0) ?? 0,
  );

  if (!boss) return <p className="fine">Waiting for the boss to load…</p>;

  // `enrage_at_tick` is stamped by `Arena::begin_fight` at the MUSTERING → FIGHTING flip
  // and zeroed by `begin_next_incarnation`, so zero means "no fight is running" and not
  // "the deadline has passed". Without the `!== 0` test a fresh arena reads `tick >= 0`
  // and the panel says "Enraged / now" before the boss has taken a single shot.
  const enraged = enrageAtTick !== 0 && tick >= enrageAtTick;

  return (
    <>
      <h3>The amalgam</h3>
      <ul className="parts">
        {boss.parts.map((hp, index) => {
          const max = boss.partsMax[index] ?? 0;
          const gone = hp === 0;
          const silenced = gone && index >= FIRST_THORN && index <= LAST_THORN;
          const name = PART_NAMES[index] ?? `part ${index}`;
          return (
            <li key={name} className={gone ? 'dead' : ''}>
              <span>
                <span className="fine tabular">{index + 1}</span> {name}
              </span>
              <Meter label={name} value={hp} max={max} />
              <span className="fine tabular">{gone ? (silenced ? 'silent' : 'gone') : hp}</span>
            </li>
          );
        })}
      </ul>

      <Vent boss={boss} />

      <dl className="stats">
        <div>
          <dt>Tick</dt>
          <dd className="tabular">{tick}</dd>
        </div>
        <div>
          <dt>{enraged ? 'Enraged' : 'Enrage in'}</dt>
          <dd className="tabular">
            {enrageAtTick === 0
              ? '—'
              : enraged
                ? 'now'
                : clock(Math.max(0, enrageAtTick - tick), tickMs)}
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
 * shell percentage next to the threshold it has to cross — and the core only once it is
 * reachable — is what makes "strip the shell, then shoot the face" legible without a
 * tutorial. The percentage uses the program's own integer arithmetic so it can never read
 * 35% beside an open vent.
 */
function Vent({ boss }: { boss: BossAccount }) {
  const shell = boss.parts.reduce((a, b) => a + b, 0);
  const shellMax = boss.partsMax.reduce((a, b) => a + b, 0);
  const open = boss.ventOpen === 1;

  return (
    <div className="vent">
      <div className="vent-head">
        <span className={`pill ${open ? 'pill-open' : ''}`}>
          {open ? 'VENT OPEN' : 'VENT SEALED'}
        </span>
        <span className="fine">
          {open ? 'core is killable' : `opens below ${VENT_PERCENT}% shell`}
        </span>
      </div>
      <div className="vent-row">
        <span>Shell</span>
        <Meter label="Shell integrity" value={shell} max={shellMax} tone="var(--flesh)" />
        <span className="fine tabular">{shellPercent(shell, shellMax)}%</span>
      </div>
      <div className="vent-row">
        <span>Core</span>
        <Meter label="Core" value={boss.coreHp} max={boss.coreHpMax} tone="var(--olive)" />
        <span className="fine tabular">
          {open ? `${boss.coreHp} / ${boss.coreHpMax}` : 'sealed'}
        </span>
      </div>
      <p className="fine">
        {open
          ? 'The chest is open. Everything you put into the shell now is wasted.'
          : 'The core takes no damage until the shell breaks.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// You
// ---------------------------------------------------------------------------

function SelfPanel() {
  const slot = useSelect(mySeatSlot);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  if (!slot) return null;

  const dead = slot.hp === 0;
  // The two gates verbatim, so the pills go grey on exactly the ticks the chain would
  // answer `Custom(7)`. In the lobby `boss_tick` never advances `tick`, so the move gate
  // there is the ER slot clock, not this — hence the phase test.
  const moveReady = phase !== PHASE_FIGHTING || slot.lastMoveTick !== tick;
  const shotReady = tick > slot.lastShotTick + SHOT_COOLDOWN_TICKS;

  return (
    <div className="self">
      <h3>You</h3>
      <div className="vent-row">
        <span>Health</span>
        <Meter
          label="Your health"
          value={slot.hp}
          max={slot.hpMax}
          tone={dead ? 'var(--gone)' : 'var(--ok)'}
        />
        <span className="fine tabular">
          {/* `respawn_at_tick` is absolute, so a stale account reads 0 rather than
              counting backwards from a tick that has already passed. */}
          {dead ? `respawn ${clock(Math.max(0, slot.respawnAtTick - tick), tickMs)}` : slot.hp}
        </span>
      </div>

      <div className="cadence">
        <span className={`pill ${dead ? 'pill-down' : moveReady ? 'pill-open' : ''}`}>
          {dead ? 'DOWN' : moveReady ? 'MOVE READY' : 'MOVE COOLING'}
        </span>
        <span className={`pill ${dead ? 'pill-down' : shotReady ? 'pill-open' : ''}`}>
          {dead ? 'DOWN' : shotReady ? 'SHOT READY' : 'SHOT COOLING'}
        </span>
      </div>
      <p className="fine">
        {dead
          ? 'Down. Moves and shots are refused as PlayerDead (Custom 8) until you respawn — that is the rule working, not a fault.'
          : 'One move per tick, one shot per two. Anything faster comes back RateLimited (Custom 7), so the client paces itself off the tick.'}
      </p>
      <p className="fine tabular">
        damage dealt {slot.damageDealt} · deaths {slot.deaths}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-check
//
// Two things here restate chain arithmetic, and both fail silently when wrong: a shell
// percentage that disagrees with `vent_open` teaches the player the wrong threshold, and a
// verdict table missing a row shows a finished raid no result at all. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  // [shell, shellMax, displayed %, vent open by the program's own comparison]
  const shells: readonly (readonly [number, number, number, boolean])[] = [
    [10_000, 10_000, 100, false],
    [3_500, 10_000, 35, false],
    // 34.5% — the case that catches a rounded percentage. `Math.round` would print "35%"
    // beside an open vent and teach the player a threshold the program does not use.
    [3_450, 10_000, 34, true],
    // 34.44%, the measured opening point of the four-player kill.
    [3_444, 10_000, 34, true],
    [1, 10_000, 0, true],
    [0, 10_000, 0, true],
    [0, 0, 0, false],
  ];
  for (const [shell, max, percent, open] of shells) {
    const shown = shellPercent(shell, max);
    if (shown !== percent) {
      throw new Error(`Hud self-check: ${shell}/${max} shows ${shown}%, expected ${percent}%`);
    }
    if (shell * 100 < max * VENT_PERCENT !== open) {
      throw new Error(`Hud self-check: ${shell}/${max} vent should be ${String(open)}`);
    }
    // The number on screen must never claim the shell is above the threshold while the
    // vent is open, or below it while sealed. That is the whole point of the integer math.
    if (open && shown >= VENT_PERCENT) {
      throw new Error(`Hud self-check: vent open but shell reads ${shown}%`);
    }
  }

  // The part order is a wire fact, not a label choice: `MUZZLES[i].part` is emitted by
  // `tools/gen_hitboxes.py` from the same table the program raycasts, so this is what
  // catches the panel drifting back to the pre-renumber order and mislabelling every row.
  for (let i = FIRST_THORN; i <= LAST_THORN; i += 1) {
    if (MUZZLES[i - FIRST_THORN]?.part !== i) {
      throw new Error(`Hud self-check: part ${i} is not a thorn — PART_NAMES is out of order`);
    }
  }
  if (MUZZLES.length !== LAST_THORN - FIRST_THORN + 1) {
    throw new Error('Hud self-check: the thorn range does not cover every muzzle');
  }

  for (const outcome of [OUTCOME_WIN, OUTCOME_WIPE, OUTCOME_ENRAGE]) {
    if (!VERDICTS[outcome]) throw new Error(`Hud self-check: outcome ${outcome} has no verdict`);
  }
  if (VERDICTS[OUTCOME_UNDECIDED]) {
    throw new Error('Hud self-check: an undecided arena must show no verdict');
  }
  const labels = new Set(Object.values(VERDICTS).map((v) => v.label));
  if (labels.size !== 3) {
    throw new Error('Hud self-check: WIN, WIPE and ENRAGE must stay three distinct labels');
  }
}
