/**
 * The raid HUD — edge-anchored clusters over a full-screen scene.
 *
 * The 320 px side panel is gone (`17-fullscreen-spec.md` §9.1: it cost the worst-case
 * scale 0.6875 px/unit and a 22.7 px knight), so every number it carried is now a
 * `position: fixed` cluster pinned to a viewport edge. The square world is centred, so an
 * edge-anchored cluster lands in the letterbox gutter for free wherever the gutter is wide
 * enough and only overlaps the outermost stone where it is not — which is why there is no
 * gutter detection, no `ResizeObserver` and no breakpoint here. Translucency covers the
 * overlap case and `pointer-events: none` keeps aiming reaching the stage underneath.
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
 * codes are pure functions of state this HUD already has: `RateLimited` is exactly
 * `last_move_tick == tick` / `tick <= last_shot_tick + SHOT_COOLDOWN_TICKS`, and
 * `PlayerDead` is exactly `hp == 0`. So the cadence pills predict the rejection instead of
 * reporting it, which is both earlier and never wrong. `metrics.refusedRate` cannot do this
 * job: `recordSend(seq?)` only tracks `move`, so a refused *shot* has never incremented it
 * and never will. The pills are the instrument — which is why they now mount in the waiting
 * area too (§0.3 of `16-hud.md`), the one screen the dead spacebar lived on.
 *
 * React owns these clusters and never the world. Everything below re-renders on every
 * notification; the renderer inside `#stage` must not.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';

import {
  CLASS_ARCHER,
  MAX_SEATS,
  MUZZLES,
  NO_TARGET,
  N_CLASSES,
  N_PARTS,
  OUTCOME_ENRAGE,
  OUTCOME_UNDECIDED,
  OUTCOME_WIN,
  OUTCOME_WIPE,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  PHASE_SETTLED,
  PHASE_SETTLING,
  TICK_MS,
  VENT_OPEN,
  ZONE_ARENA,
  classOf,
  ventPct,
} from '@heartrot/client';

import { shotAllowed } from '../input/controls';
import { isMuted, play, setMuted, type SfxName } from '../render/sfx';
import { SKIN_COLORS } from '../screens/CharacterSelect';
import { Muster } from '../screens/Gate';
import { mySeatSlot, useSelect, useStore } from '../state/store';

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

/*
 * `Boss.vent_open` flips when `sum(parts) * 100 < sum(parts_max) * vent_pct(raid_size)` —
 * 65 solo, 35 at a full raid, linear between. The percentage is `layout.ts`'s `ventPct`,
 * the same mirror `shoot.rs` recomputes against; this file used to hold a literal 35 and
 * would have taught a solo player a threshold thirty points below the real one.
 */

/**
 * The cooldown gate is `controls.ts`'s, not a copy of it.
 *
 * This file used to hold a third copy of `SHOT_COOLDOWN_TICKS` and it held the 400 ms-era
 * value `1` against the chain's `ticks_for(800) - 1 = 7`, so SHOT READY went green 600 ms
 * early — in a live fight — while the client's own (correct) gate refused to send. That is
 * the second half of "the space bar doesn't work". The predicate now comes from the same
 * module the send pump gates on, so the pill and the pump can never disagree again.
 *
 * `shotAllowed` takes the class itself — `CLASS_COOLDOWN_TICKS[class]`, 7 knight and 13
 * archer — so the HUD passes `cls` straight through and there is no second class table
 * here, and no alias in between. (There used to be a cast standing in for that argument;
 * it retired the day the argument became real.)
 */

/** 0 knight, 1 archer — `PlayerSlot.class_aim` bit 7. Flavour text only; the chain decides. */
const CLASS_NAMES = ['KNIGHT', 'ARCHER'] as const;

// `classOf` is `layout.ts`'s, imported above. This file used to keep a private second copy
// reading an OPTIONAL `classAim` behind a comment saying the decoder "does not carry the
// field yet" — it does, and `App.tsx` already imports the real one. Same answer today, two
// answers the day the packing changes, which is this repo's named defect in its smallest
// form. Deleted; the cooldown copy above it went the same way and for the same reason.

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
 * Cue a sound on the tick a chain fact becomes true — and not on mount, where a reconnect
 * re-delivers a fight whose vent opened minutes ago. `sfx.play` de-duplicates a name
 * inside 30 ms, so a renderer cueing the same beat costs nothing.
 */
function usePlayOnRise(when: boolean, name: SfxName): void {
  const was = useRef(when);
  useEffect(() => {
    if (when && !was.current) play(name);
    was.current = when;
  }, [when, name]);
}

const PHASE_NAMES: Readonly<Record<number, string>> = {
  [PHASE_LOBBY]: 'LOBBY',
  [PHASE_MUSTERING]: 'MUSTERING',
  [PHASE_FIGHTING]: 'FIGHTING',
  [PHASE_SETTLING]: 'SETTLING',
  [PHASE_SETTLED]: 'SETTLED',
};

/**
 * The cluster chrome. `.hud*` only — the `.dev*` rules that used to ride along are in
 * `styles.css`, where they always also were.
 *
 * It lives here rather than in `styles.css` because these class names arrived with this
 * component and nothing else styles them; a stylesheet rule with the same selector, added
 * later, wins on order and this block can then be deleted whole. One place either way.
 *
 * `pointer-events: none` on the cluster with `auto` on its interactive children is what
 * lets a cluster overlap the arena at 1280×800 without stealing aim: `controls.ts` binds
 * `pointerdown` to `#stage`, and an overlay that does not hit-test is not in the way.
 */
const HUD_CSS = `
.hud {
  position: fixed;
  z-index: 30;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--line);
  border-radius: 3px;
  box-shadow: 0 8px 26px -10px rgb(0 0 0 / 0.75);
}
.hud button { pointer-events: auto; }
.hud h3 {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}
.hud p { margin: 0; }
.hud-tl { top: 8px; left: 8px; }
.hud-tc { top: 8px; left: 50%; transform: translateX(-50%); width: min(520px, 46vw); }
.hud-ml { top: 50%; left: 12px; transform: translateY(-50%); max-width: min(340px, 30vw); }
.hud-bl { left: 8px; bottom: 8px; min-width: 232px; }
/* Spec §1.3 puts the parts cluster bottom-right; telemetry's anchor is right 12px /
   bottom 12px, and open it is ~700px tall, so bottom-right is under it whenever anyone
   presses backtick. Telemetry is no longer open by DEFAULT, but its cue button rests in
   that same corner, so bottom-right is still occupied at rest. Top-right is the free one.
   ponytail: if telemetry ever moves to a true middle-right anchor, move this back to BR. */
.hud-tr { top: 8px; right: 8px; min-width: 168px; }
/* One line of instruction, and it is the whole answer to "the space bar doesn't work":
   until now nothing in the running game named a single key except one line in Gate.tsx
   that disappears the moment you reach the gate. Not a cluster of its own — it rides in
   .hud-bl, which is already mounted on both sides of the gate and already carries the
   trigger's state, so the keys sit beside the pill that reports them and the play area
   loses nothing. --dim resolves to --muted on this surface (styles.css), so it reads.
   (No backticks in this block: it is a template literal, and one would end it.) */
.hud-keys { color: var(--dim); }
.hud-keys b { font-family: var(--pixel); font-weight: 400; color: var(--ink); }
.hud-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.hud-seats { display: flex; gap: 3px; margin: 2px 0 0; padding: 0; list-style: none; }
.hud-seat {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px solid var(--line);
}
.hud-toggle {
  font: 10px var(--pixel);
  letter-spacing: 0.08em;
  color: var(--muted);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
.hud-toggle:hover { color: var(--ink); }
`;
/* The nine `.dev` rules that used to close this block are gone. Every one of them was a
   third copy: `styles.css` already ships the 88 % backdrop, the grip, and — for the four
   small-text roles §0.5 measured at 3.45:1 over the boss's orb — the `--dim: var(--muted)`
   token override on `.hud, .dev, .dev-cue`, which retires the token on the surface instead
   of rewriting the rules that name it. `DevPanel.tsx` styles `.dev`; this file styles
   `.hud`. */

/**
 * Every cluster, mounted once. All five are `position: fixed`, so this renders the same on
 * either side of the gate and the caller does not have to place anything.
 */
export function Hud() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  // `PHASE_MUSTERING` has to be tested explicitly. Without it the muster falls into
  // `BossBar`, which renders an enrage clock off `enrageAtTick` — and that field is
  // stamped at the MUSTERING → FIGHTING flip, so it reads 0 for the whole window: a 0:00
  // countdown for a fight that has not begun. `Muster` is `screens/Gate`'s, rendered by
  // both sides of the gate so the countdown does not vanish when your seat crosses it.
  const mustering = phase === PHASE_LOBBY || phase === PHASE_MUSTERING;
  return (
    <>
      <style>{HUD_CSS}</style>
      <PhaseCluster />
      <div className="hud hud-tc">{mustering ? <Muster /> : <BossBar />}</div>
      <Verdict />
      <SelfPanel />
      {!mustering && <Parts />}
    </>
  );
}

// ---------------------------------------------------------------------------
// TL — phase, tick, socket, roster
// ---------------------------------------------------------------------------

/**
 * The four facts the deleted `.header` carried, minus the wordmark. The roster is twenty
 * dots rather than twenty rows: an empty seat is information during a muster, and the
 * colour is the same `SKIN_COLORS` entry the knight is drawn in, so a dot and a figure on
 * the floor are matchable at a glance. Counts a screen reader needs are on each dot's
 * label and on the telemetry panel's Match group.
 */
function PhaseCluster() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const status = useSelect((s) => s.status);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);

  return (
    <div className="hud hud-tl">
      <div className="hud-row">
        <span className="pill">{PHASE_NAMES[phase] ?? `PHASE ${phase}`}</span>
        <span className="fine tabular">tick {tick}</span>
        <span className={`dot dot-${status}`} aria-hidden="true" />
        <span className="fine">{status}</span>
        <MutePill />
        <ExitPill />
      </div>
      <ol className="hud-seats">
        {Array.from({ length: MAX_SEATS }, (_, i) => {
          const slot = players?.slots[i];
          const inPit = slot?.zone === ZONE_ARENA;
          return (
            <li
              key={i}
              className="hud-seat"
              aria-current={i === seat ? 'true' : undefined}
              aria-label={`seat ${i}${slot?.occupied ? (inPit ? ', in the pit' : ', in the lobby') : ', empty'}`}
              style={{
                background: slot?.occupied ? (SKIN_COLORS[slot.skinId] ?? 'var(--dim)') : 'none',
                borderColor: i === seat ? 'var(--ink)' : inPit ? 'var(--lobby-green)' : 'var(--line)',
              }}
            />
          );
        })}
      </ol>
    </div>
  );
}

/**
 * A real `<button>`, for the reason `Parts`' toggle is: Space is the fire key and
 * `controls.ts` takes it before activation; Enter toggles this. `sfx.ts` owns the
 * remembered value — this only mirrors it into React so the label re-renders.
 */
function MutePill() {
  const [muted, set] = useState(isMuted);
  return (
    <button
      className="pill hud-mute"
      aria-pressed={muted}
      onClick={() => {
        setMuted(!muted);
        set(!muted);
      }}
    >
      {muted ? 'MUTED' : 'SOUND'}
    </button>
  );
}

/**
 * The way out — and the reason abandoned arenas no longer strand.
 *
 * A player leaving used to be invisible to the chain: the seat kept `ZONE_ARENA`, the raid
 * ran its full six minutes to enrage, and then sat in `SETTLING` with nobody left who was
 * permitted to settle it. This button is the departure signal, and `store.leaveMatch`
 * releases the seat server-side before clearing the local match.
 *
 * A real `<button>` inside a `.hud` cluster works despite the layer's `pointer-events:
 * none` — `MutePill` above is the standing proof.
 */
function ExitPill() {
  const store = useStore();
  const inMatch = useSelect((s) => s.match !== null);
  if (!inMatch) return null;
  return (
    <button className="pill hud-exit" onClick={() => void store.leaveMatch()}>
      EXIT
    </button>
  );
}

// ---------------------------------------------------------------------------
// ML — the verdict
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
  // The verdict is the HUD's own event — the byte lands here and nowhere else draws it.
  usePlayOnRise(outcome === OUTCOME_WIN, 'win');
  usePlayOnRise(outcome === OUTCOME_WIPE || outcome === OUTCOME_ENRAGE, 'lose');
  if (!row) return null;
  return (
    <div className={`hud hud-ml verdict verdict-${row.label.toLowerCase()}`} role="status">
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
 *
 * `segment` makes it one cell of the boss bar: `flex-grow` is the pool's maximum, so the
 * bar's width is HP and a thorn reads as the fraction of the shell it is. An empty pool
 * is `dead` — charred, not merely drained — because a part at zero is a different thing
 * from a part at one.
 */
function Meter({
  label,
  value,
  max,
  tone,
  segment = false,
}: {
  label: string;
  value: number;
  max: number;
  tone?: string;
  segment?: boolean;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const dead = max > 0 && value === 0;
  return (
    <span
      className={`meter${segment ? ' shell-seg' : ''}${dead ? ' dead' : ''}`}
      role="meter"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      title={segment ? label : undefined}
      style={segment ? { flexGrow: max } : undefined}
    >
      <span
        className="meter-fill"
        style={{ ['--fill']: pct / 100, background: tone } as CSSProperties}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// TC — the boss bar
// ---------------------------------------------------------------------------

/**
 * The genre convention: one bar, nine segments — one per part, each as wide as the HP it
 * holds and each draining on its own — so the bar is the boss's silhouette in numbers
 * and a dead thorn is a charred gap, not a lower percentage. The core joins the bar the
 * tick the vent opens (it is unreachable before, and drawing it sealed would be a target
 * that is not one), and one line of fight state follows. `Incoming` (the live bullet
 * count) is not here — it is a debugging number and the bullets are on screen; it moved
 * to the telemetry Feed group, where the rest of the observed numbers live.
 */
function BossBar() {
  const boss = useSelect((s) => s.boss);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const enrageAtTick = useSelect((s) => s.arena?.enrageAtTick ?? 0);
  // 1, never 0, when the arena is not loaded: `ventPct` is a function of an occupant
  // count and there is no such thing as a raid of nobody.
  const raidSize = useSelect((s) => s.arena?.raidSize ?? 1);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  const alive = useSelect((s) => s.arena?.aliveCount ?? 0);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  // `VENT_OPEN` and not a bare 1: the byte's meaning belongs to `shoot.rs`, which is
  // the handler that acts on it, and a literal here is a second copy of that rule.
  const open = boss?.ventOpen === VENT_OPEN;
  usePlayOnRise(open, 'ventOpen');

  if (!boss) return <p className="fine">Waiting for the boss to load…</p>;

  const shell = boss.parts.reduce((a, b) => a + b, 0);
  const shellMax = boss.partsMax.reduce((a, b) => a + b, 0);
  // `enrage_at_tick` is stamped by `Arena::begin_fight` at the MUSTERING → FIGHTING flip
  // and zeroed by `begin_next_incarnation`, so zero means "no fight is running" and not
  // "the deadline has passed". Without the `!== 0` test a fresh arena reads `tick >= 0`
  // and the bar says "enraged" before the boss has taken a single shot.
  const enraged = enrageAtTick !== 0 && tick >= enrageAtTick;

  return (
    <>
      <div className="vent-head">
        <h3>The amalgam</h3>
        <span className={`pill ${open ? 'pill-open' : ''}`}>
          {open ? 'VENT OPEN' : 'VENT SEALED'}
        </span>
      </div>
      <div className="vent-row">
        <span>Shell</span>
        <div className="shell-bar" role="group" aria-label="Shell, by part">
          {boss.parts.map((hp, index) => (
            <Meter
              key={PART_NAMES[index] ?? index}
              label={PART_NAMES[index] ?? `part ${index}`}
              value={hp}
              max={boss.partsMax[index] ?? 0}
              tone="var(--flesh)"
              segment
            />
          ))}
          {open && (
            <Meter label="Core" value={boss.coreHp} max={boss.coreHpMax} tone="var(--olive)" segment />
          )}
        </div>
        <span className="fine tabular">{shellPercent(shell, shellMax)}%</span>
      </div>
      <p className="fine tabular">
        {open ? `core ${boss.coreHp} / ${boss.coreHpMax}` : `core sealed below ${ventPct(raidSize)}%`}{' '}
        ·{' '}
        {enrageAtTick === 0
          ? '—'
          : enraged
            ? 'enraged'
            : `${clock(Math.max(0, enrageAtTick - tick), tickMs)} to enrage`}{' '}
        · {alive} alive ·{' '}
        {boss.targetSeat === NO_TARGET
          ? 'hunting nobody'
          : boss.targetSeat === seat
            ? 'hunting you'
            : `hunting seat ${boss.targetSeat}`}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// TR — the nine parts, collapsed
// ---------------------------------------------------------------------------

/**
 * Nine rows is the densest thing on screen and it is a fight-long reference, not a
 * moment-to-moment read, so it opens on a click. Not persisted: it is one click and the
 * default is right for the common case.
 */
function Parts() {
  const boss = useSelect((s) => s.boss);
  const [open, setOpen] = useState(false);
  if (!boss) return null;
  const standing = boss.parts.reduce((n, hp) => n + (hp > 0 ? 1 : 0), 0);

  return (
    <div className="hud hud-tr">
      {/* A real <button>: `controls.ts` preventDefaults Space on `window` before the
          browser's activation behaviour runs, so Space fires the shot and never this, and
          Enter activates it. Nothing in the HUD may depend on Space. */}
      <button
        className="hud-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} parts {standing}/{N_PARTS} standing
      </button>
      {open && (
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
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BL — you
// ---------------------------------------------------------------------------

/**
 * Health, class and the two cadence pills, **on both sides of the gate**.
 *
 * This cluster used to mount only from `ArenaScreen`, so the waiting area had no shot
 * indicator at all — and the waiting area is exactly where the spacebar does nothing. A
 * permanently grey pill in an empty room is a legible bug report; a key that does nothing
 * is not. The SHOT pill therefore says *why* it is grey rather than only that it is:
 * `shoot.rs` refuses outside `PHASE_FIGHTING` and outside `ZONE_ARENA`, and both refusals
 * are normal play, not faults.
 */
function SelfPanel() {
  const slot = useSelect(mySeatSlot);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const fightAtTick = useSelect((s) => s.arena?.fightAtTick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  if (!slot) return null;

  const dead = slot.hp === 0;
  const cls = classOf(slot);
  // The move gate is NOT predictable here. `lastMoveTick` is an ER slot and `tick` is a
  // crank tick — two clocks (`player.rs:345`) — and the comparison that used to sit here
  // never held, so the pill read green for the whole fight. A browser cannot see slots;
  // the one refusal it can foresee is death.
  const moveReady = !dead;
  const live = phase === PHASE_FIGHTING && slot.zone === ZONE_ARENA;
  const shotReady = shotAllowed(tick, slot.lastShotTick, cls);
  const musterLeft = fightAtTick > tick ? clock(fightAtTick - tick, tickMs) : '0:00';

  return (
    <div className="hud hud-bl">
      <div className="hud-row">
        <span className="pill">{CLASS_NAMES[cls] ?? `CLASS ${cls}`}</span>
        <span className="fine tabular">
          {/* `respawn_at_tick` is absolute, so a stale account reads 0 rather than
              counting backwards from a tick that has already passed. */}
          {dead ? `respawn ${clock(Math.max(0, slot.respawnAtTick - tick), tickMs)}` : `${slot.hp} hp`}
        </span>
      </div>
      <Meter
        label="Your health"
        value={slot.hp}
        max={slot.hpMax}
        tone={dead ? 'var(--gone)' : 'var(--ok)'}
      />

      <div className="cadence">
        <span className={`pill ${dead ? 'pill-down' : moveReady ? 'pill-open' : ''}`}>
          {dead ? 'DOWN' : moveReady ? 'MOVE READY' : 'MOVE COOLING'}
        </span>
        <span className={`pill ${dead ? 'pill-down' : live && shotReady ? 'pill-open' : ''}`}>
          {dead ? 'DOWN' : !live ? 'PRACTICE' : shotReady ? 'SHOT READY' : 'SHOT COOLING'}
        </span>
      </div>
      {/* The dishonesty is ambiguity, not silence: the arrow answers "is the key bound",
          this line answers "why no damage". */}
      {!live && !dead && (
        <p className="fine">
          {slot.zone === ZONE_ARENA
            ? `Weapons go live when the muster ends — ${musterLeft}.`
            : 'Practice shots only. There is no target on this side of the gate.'}
        </p>
      )}
      {/* The keys, in every phase, because every one of them is bound in every phase:
          `controls.ts::pump` moves on the wall clock everywhere and fires the trigger
          everywhere, drawing a practice arrow where the chain would refuse the send. Held
          drag both aims and fires; Space fires along the body's facing. Written out rather
          than drawn as three key caps — a picture of a keyboard is a second thing to
          maintain and reads no faster at 11px. */}
      <p className="fine hud-keys">
        <b>WASD</b> or arrows move · <b>SPACE</b> fires, held still it charges · drag to aim
      </p>
      <p className="fine tabular">
        damage {slot.damageDealt} · deaths {slot.deaths}
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
  // The threshold the table below is written against: a full raid's 35 %. The solo end
  // and monotonicity are asserted too, because the bar prints `ventPct` for every size.
  const VENT_PERCENT = ventPct(MAX_SEATS);
  if (ventPct(1) !== 65 || VENT_PERCENT !== 35) {
    throw new Error(`Hud self-check: ventPct reads ${ventPct(1)} solo, ${VENT_PERCENT} full`);
  }
  for (let raid = 2; raid <= MAX_SEATS; raid += 1) {
    if (ventPct(raid) > ventPct(raid - 1)) {
      throw new Error(`Hud self-check: ventPct rises from ${raid - 1} to ${raid} raiders`);
    }
  }

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

  // The pill and the send pump must never disagree: the shipped copy of the cooldown read
  // 1 against the chain's 7, so SHOT READY went green 600 ms before a shot could be sent.
  // Asserting the predicate here is what stops a fourth copy appearing.
  if (shotAllowed(7, 0) || !shotAllowed(8, 0)) {
    throw new Error('Hud self-check: the shot gate is not controls.ts’s 800 ms cooldown');
  }
  // The archer row of the same table. Without this the class argument could be dropped on
  // the floor here and the pill would go green 600 ms early for an archer exactly the way
  // the hardcoded `1` did for a knight — the same defect, one class over.
  if (shotAllowed(13, 0, CLASS_ARCHER) || !shotAllowed(14, 0, CLASS_ARCHER)) {
    throw new Error('Hud self-check: the shot gate is not controls.ts’s 1400 ms archer cooldown');
  }
  // Not asserted here any more: `classOf` is `layout.ts`'s and is checked where it lives.
  // What this file still owns is the LABEL — a names array shorter than the class table
  // prints "CLASS 1" at a seat the chain calls an archer, and nothing else would notice.
  if (CLASS_NAMES.length !== N_CLASSES) {
    throw new Error(`Hud self-check: ${CLASS_NAMES.length} class names for ${N_CLASSES} classes`);
  }
}
