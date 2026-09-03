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

import { useEffect, useRef, useState } from 'react';

import {
  CLASS_ARCHER,
  FURY_PCT,
  MAX_SEATS,
  MUZZLES,
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
  VENT_PCT_FULL,
  VENT_PCT_SOLO,
  ZONE_ARENA,
  fightHp,
  isFurious,
  ventPct,
} from '@heartrot/client';

import { shotAllowed } from '../input/controls';
import { isMuted, play, setMuted, type SfxName } from '../render/sfx';
import { SKIN_COLORS } from '../screens/CharacterSelect';
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
 * `VENT_PCT_SOLO` solo, `VENT_PCT_FULL` at a full raid, linear between. The percentage is
 * `layout.ts`'s `ventPct`, the same mirror `shoot.rs` recomputes against; this file used
 * to hold a literal 35 and would have taught a solo player a threshold sixty points below
 * the real one. The self-check names the constants for the same reason: it held a literal
 * 65 through two solo retunes and would have thrown on the first dev boot to run it.
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

/**
 * `part` of `whole` in percent, floored — the same integer arithmetic the program compares
 * against, so the number on screen never rounds up across a threshold the chain has
 * already crossed. Shell against the vent line, and fight HP against `FURY_PCT`.
 */
function floorPercent(part: number, whole: number): number {
  return whole > 0 ? Math.floor((part * 100) / whole) : 0;
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
/* The two bars. The cluster grows to fit them; it is the one panel that survived, so it
   can carry the fight's two most-read numbers at a width that reads from the far side of
   the room. Fill colour is the state: --ok / --cyan while it is fine, --ember when it is
   not, which is the same rule the boss's own eyes follow. The mark on the boss bar is the
   enrage line at FURY_PCT. */
.hud-tl { width: min(380px, 42vw); }
.hud-vitals { display: grid; gap: 5px; margin: 6px 0 4px; }
.hud-bar-row { display: grid; grid-template-columns: 62px 1fr 58px; align-items: center; gap: 8px; }
.hud-bar-label { font-family: var(--pixel); font-size: 10px; letter-spacing: 0.1em; color: var(--muted); }
.hud-bar-num { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; color: var(--ink); }
.hud-bar { position: relative; height: 9px; background: color-mix(in srgb, var(--line) 55%, transparent); border: 1px solid var(--line); border-radius: 2px; overflow: hidden; }
.hud-bar-boss { height: 12px; }
/* The fill is a full-width box SCALED, not a box whose width changes: width is a layout
   property and the bar re-renders on every notification that moves hp, so a width
   transition re-laid-out the whole cluster ten times a second. scaleX is compositor-only. */
.hud-bar-fill { height: 100%; width: 100%; transform-origin: left center; background: var(--ok); transition: transform 0.25s ease-out, background-color 0.3s; }
.hud-bar-boss .hud-bar-fill { background: var(--cyan); }
.hud-bar-fill.is-low, .is-down .hud-bar-fill, .hud-enraged .hud-bar-fill { background: var(--ember); }
.hud-bar-mark { position: absolute; top: -1px; bottom: -1px; width: 1px; background: var(--ember); opacity: 0.8; }
.is-down .hud-bar-label, .hud-enraged .hud-bar-label { color: var(--ember); }
@media (prefers-reduced-motion: reduce) { .hud-bar-fill { transition: none; } }
.hud-urgent { color: var(--ember); }
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
  return (
    <>
      <style>{HUD_CSS}</style>
      {/* ONE cluster, top left. The screen used to carry four: a muster card top centre, a
          class/health panel bottom left, a "tiles to the gate" prompt bottom centre and a
          parts list top right. Together they covered a third of the play area and buried
          the room the whole redesign exists to show. Everything still worth reading moved
          into the cluster below; the gate now carries its own marker instead of a
          paragraph telling you where it is. `Verdict` stays because it is the end of a
          match, not chrome. */}
      <PhaseCluster />
      <Verdict />
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
/**
 * The one line that survived the cull: your health, your shot, and how much shell is left.
 *
 * These three were spread across a bottom-left panel and a top-centre bar. They are worth
 * a glance mid-fight and nothing more, so they live in the cluster the player already
 * reads rather than in furniture of their own. Everything else those panels carried —
 * class name, respawn clock, muster copy, per-part list, control hints — was either
 * instructional (and now belongs to the gate marker) or legible from the scene itself.
 */
function VitalsRow() {
  const slot = useSelect(mySeatSlot);
  const boss = useSelect((s) => s.boss);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const raidSize = useSelect((s) => s.arena?.raidSize ?? 0);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  if (!slot) return null;

  const dead = slot.hp === 0;
  // Fight HP, not shell: shell above the vent line never has to come off, so a solo bar
  // read `shell 97%` three hits from a win. `fightHp` is the chain's own `Boss::fight_hp`
  // and the floor is what keeps `boss 20%` and ENRAGED landing on the same tick — the
  // label is `isFurious`'s, never the number's.
  const hp = boss ? fightHp(boss, raidSize) : null;
  const furious = phase === PHASE_FIGHTING && boss !== null && isFurious(boss, raidSize);
  const bossShown = hp !== null && hp.max > 0 && phase !== PHASE_LOBBY && phase !== PHASE_MUSTERING;
  const bossPct = bossShown ? floorPercent(hp.left, hp.max) : 0;
  const ownPct = slot.hpMax > 0 ? floorPercent(slot.hp, slot.hpMax) : 0;

  // BARS, not numbers. "the health bar is confusing i dont see it quite good how much
  // health is left" — the numbers were 11 px text in a corner while the player's eyes
  // were on the creature. A filled bar is read at a glance from anywhere on the screen,
  // the number rides on it for whoever wants it, and the boss bar carries the enrage line
  // at FURY_PCT so the moment the fight changes is visible before it happens.
  return (
    <div className="hud-vitals">
      <div className={`hud-bar-row${dead ? ' is-down' : ''}`}>
        <span className="hud-bar-label">
          {dead ? `DOWN ${clock(Math.max(0, slot.respawnAtTick - tick), tickMs)}` : 'HP'}
        </span>
        <div className="hud-bar" role="meter" aria-label="your health" aria-valuenow={slot.hp} aria-valuemax={slot.hpMax}>
          <div
            className={`hud-bar-fill${ownPct <= 30 ? ' is-low' : ''}`}
            style={{ transform: `scaleX(${ownPct / 100})` }}
          />
        </div>
        <span className="hud-bar-num">
          {slot.hp}/{slot.hpMax}
        </span>
      </div>
      {bossShown && (
        <div className={`hud-bar-row hud-boss${furious ? ' hud-enraged' : ''}`}>
          <span className="hud-bar-label">{furious ? 'ENRAGED' : 'BOSS'}</span>
          <div className="hud-bar hud-bar-boss" role="meter" aria-label="boss health" aria-valuenow={bossPct} aria-valuemax={100}>
            <div className="hud-bar-fill" style={{ transform: `scaleX(${bossPct / 100})` }} />
            <div className="hud-bar-mark" style={{ left: `${FURY_PCT}%` }} aria-hidden="true" />
          </div>
          <span className="hud-bar-num">{bossPct}%</span>
        </div>
      )}
    </div>
  );
}

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
        <FightClock />
        <span className="fine tabular">tick {tick}</span>
        <span className={`dot dot-${status}`} aria-hidden="true" />
        <span className="fine">{status}</span>
        <MutePill />
        <ExitPill />
      </div>
      <VitalsRow />
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
 * The two clocks a raid runs on, in the one cluster that survived the popup cull: how long
 * until the boss wakes (`fight_at_tick`, stamped by `begin_muster`) and, once it has, how
 * long before the six-minute enrage ends the fight (`enrage_at_tick`, stamped at the
 * MUSTERING → FIGHTING flip and 0 before it). Both are chain ticks against the chain's own
 * `tick`, never a wall clock — the muster card that used to show the first of these went
 * with the panels, and nothing else in the fight said how long was left.
 *
 * Ember under thirty seconds of the fight, because that is the number that changes what a
 * raid does: it is the difference between stripping one more limb and going for the core.
 */
function FightClock() {
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const fightAt = useSelect((s) => s.arena?.fightAtTick ?? 0);
  const enrageAt = useSelect((s) => s.arena?.enrageAtTick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  if (phase === PHASE_MUSTERING) {
    return <span className="fine tabular">wakes in {clock(fightAt - tick, tickMs)}</span>;
  }
  if (phase === PHASE_FIGHTING && enrageAt !== 0) {
    const left = enrageAt - tick;
    const urgent = left * tickMs <= 30_000;
    return (
      <span className={`fine tabular${urgent ? ' hud-urgent' : ''}`}>{clock(left, tickMs)} left</span>
    );
  }
  return null;
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
  if (ventPct(1) !== VENT_PCT_SOLO || VENT_PERCENT !== VENT_PCT_FULL) {
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
    const shown = floorPercent(shell, max);
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

  // The same rule for the fight-HP number beside ENRAGED: furious may never show more
  // than `FURY_PCT`. Built on `fightHp`'s own `max` rather than the sheet's numbers so a
  // vent or core retune moves the rows with it; the core ceiling is well above any
  // `left` a 20 % line can produce, so the rows stay representable through a retune.
  const solo = { partsMax: [1_000], coreHpMax: 1_000, parts: [1_000], coreHp: 1_000 };
  const { max: fightMax } = fightHp(solo, 1);
  const line = Math.floor((fightMax * FURY_PCT) / 100);
  const at = (left: number) => ({ ...solo, parts: [Math.floor((1_000 * ventPct(1)) / 100)], coreHp: left });
  if (isFurious(solo, 1) || !isFurious(at(line), 1) || isFurious(at(line + 1), 1)) {
    throw new Error(`Hud self-check: fury does not flip at exactly ${FURY_PCT}% of ${fightMax}`);
  }
  if (floorPercent(line, fightMax) > FURY_PCT || floorPercent(fightMax, fightMax) !== 100) {
    throw new Error(`Hud self-check: boss % reads ${floorPercent(line, fightMax)}% beside ENRAGED`);
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
  // The `+ 1` past the cooldown is `controls.ts`'s `SHOT_MARGIN_TICKS`: the chain stamps its
  // own tick, at or past the client's view, so the gate opens one tick after the cooldown.
  if (shotAllowed(8, 0) || !shotAllowed(9, 0)) {
    throw new Error('Hud self-check: the shot gate is not controls.ts’s 800 ms cooldown');
  }
  // The archer row of the same table. Without this the class argument could be dropped on
  // the floor here and the pill would go green 600 ms early for an archer exactly the way
  // the hardcoded `1` did for a knight — the same defect, one class over.
  if (shotAllowed(14, 0, CLASS_ARCHER) || !shotAllowed(15, 0, CLASS_ARCHER)) {
    throw new Error('Hud self-check: the shot gate is not controls.ts’s 1400 ms archer cooldown');
  }
  // Not asserted here any more: `classOf` is `layout.ts`'s and is checked where it lives.
  // What this file still owns is the LABEL — a names array shorter than the class table
  // prints "CLASS 1" at a seat the chain calls an archer, and nothing else would notice.
  if (CLASS_NAMES.length !== N_CLASSES) {
    throw new Error(`Hud self-check: ${CLASS_NAMES.length} class names for ${N_CLASSES} classes`);
  }
}
