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

import { useCallback, useEffect, useRef, useState } from 'react';

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
  SHELL_PCT_PER_INCARNATION,
  TICK_MS,
  TIER_COLORS,
  TIER_EASY,
  TIER_NAMES,
  VENT_PCT_FULL_BY_TIER,
  VENT_PCT_SOLO_BY_TIER,
  ZONE_ARENA,
  fightHp,
  isFurious,
  ventPct,
  type PlayerSlot,
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
 * `Boss.vent_open` flips when `sum(parts) * 100 < sum(parts_max) * vent_pct(raid_size, tier)`
 * — `VENT_PCT_SOLO_BY_TIER[difficulty]` solo, `VENT_PCT_FULL_BY_TIER[difficulty]` at a full
 * raid, linear between. The percentage is
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
/* ONE SMALL CARD, ONE BARE BAR, TWO ICONS. The brief: keep fight state, timer, tick, live
   status, sound, exit, player HP and boss HP; improve hierarchy, spacing, alignment and
   contrast; add nothing. So: a restrained card top left with a thin border and 80 %
   panel — state and timer on the first line, tick and feed on the second in muted mono,
   HP as a 4 px bar with its count — the boss bar alone at the top centre, drawn straight
   onto the scene where the eyes already are, and sound / leave as two icons top right,
   half opacity until hovered. Seat dots appear under the HP bar only when there is more
   than one seat to show. The layer fades to 60 % after four quiet seconds and returns on
   any input or hit; H hides it. \`.hud\` — the boxed style — dresses the verdict alone.
   (No unescaped backticks in this block: it is a template literal.) */
.hud-layer {
  position: fixed;
  inset: 0;
  z-index: 30;
  pointer-events: none;
  transition: opacity 0.6s ease;
}
.hud-layer.is-calm { opacity: 0.6; }
.hud-layer.is-hidden { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .hud-layer { transition: none; } }

/* Top right: the wordmark owns the top left and telemetry's cue owns the bottom right. */
.hud-corner { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px; }

/* Under the wordmark, which owns the top-left row: the first row of the screen reads
   wordmark / boss bar / icons, and the card hangs below it. */
/* One phase line and one bar. No box: the room is the picture and the card is a caption. */
.hud-card {
  position: absolute;
  top: 44px;
  left: 14px;
  width: 168px;
  display: grid;
  gap: 5px;
}
.hud-stale { font: 9px var(--mono); letter-spacing: 0.1em; text-transform: uppercase; color: var(--torch); }
/* The controls, once, in the corner nobody plays in, gone on the first step. */
.hud-hint {
  position: absolute;
  left: 14px;
  bottom: 14px;
  font: 10px var(--mono);
  letter-spacing: 0.06em;
  color: var(--muted);
  text-shadow: 0 1px 2px rgb(0 0 0 / 0.8);
}
.hud-hint b { font-weight: normal; color: var(--ink); }
.hud-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.hud-state {
  font: 10px var(--pixel);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}
.hud-state.is-muster { color: var(--torch); }
.hud-state.is-enraged { color: var(--ember); }
.hud-timer {
  font: 18px var(--pixel);
  line-height: 1;
  letter-spacing: 0.04em;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}
.hud-urgent .hud-timer { color: var(--ember); }
.hud-hp { display: grid; grid-template-columns: 1fr 52px; align-items: center; gap: 8px; }
.hud-hp-bar { position: relative; height: 3px; background: rgb(0 0 0 / 0.55); overflow: hidden; }
.hud-hp-fill { height: 100%; width: 100%; transform-origin: left center; background: var(--ok); transition: transform 0.25s ease-out, background-color 0.3s; }
.hud-hp-fill.is-low, .is-down .hud-hp-fill { background: var(--ember); }
.hud-hp-num { font: 11px var(--mono); font-variant-numeric: tabular-nums; text-align: right; color: var(--ink); }
@media (prefers-reduced-motion: reduce) { .hud-hp-fill { transition: none; } }
.hud-icon {
  width: 24px;
  height: 24px;
  padding: 2px;
  border: 0;
  background: none;
  color: var(--ink);
  opacity: 0.5;
  cursor: pointer;
  pointer-events: auto;
  filter: drop-shadow(0 1px 0 #000) drop-shadow(0 0 3px rgb(0 0 0 / 0.9));
  transition: opacity 0.15s;
}
.hud-icon:hover, .hud-icon:focus-visible { opacity: 1; outline: 0; }
.hud-icon svg { width: 100%; height: 100%; display: block; }
.hud-icon[aria-pressed='true'] { color: var(--muted); }

.hud-top {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  width: min(440px, 36vw);
}
.hud-tag {
  font: 9px var(--pixel);
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  text-shadow: 0 1px 0 #000, 0 0 6px rgb(0 0 0 / 0.9);
}
.hud-boss {
  width: 100%;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
}
.hud-boss-bar {
  position: relative;
  height: 6px;
  background: rgb(0 0 0 / 0.55);
  box-shadow: 0 0 0 1px rgb(0 0 0 / 0.7);
  overflow: hidden;
}
/* scaleX, never width: this bar redraws on every notification that moves the shell. */
.hud-boss-fill {
  height: 100%;
  width: 100%;
  transform-origin: left center;
  background: var(--cyan);
  transition: transform 0.25s ease-out, background-color 0.3s;
}
.hud-boss-mark { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--ember); opacity: 0.8; }
.hud-boss-pct { font: 11px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); text-shadow: 0 1px 0 #000, 0 0 6px rgb(0 0 0 / 0.9); }
.hud-enraged .hud-boss-fill { background: var(--ember); }
.hud-enraged .hud-tag { color: var(--ember); }
@media (prefers-reduced-motion: reduce) { .hud-boss-fill { transition: none; } }

.hud-seats { display: flex; gap: 3px; margin: 1px 0 0; padding: 0; list-style: none; }
.hud-seat { width: 5px; height: 5px; border-radius: 50%; box-shadow: 0 0 0 1px rgb(0 0 0 / 0.6); }

/* The end-of-match verdict is the one boxed thing left: it is a result, not chrome. On a
   WIN it is three more lines — placing, damage, the next incarnation — and one button; on
   a WIPE or ENRAGE the sentence and the button. Nothing the settle does not also write
   to the leaderboard row. */
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
.hud-ml { top: 50%; left: 12px; transform: translateY(-50%); width: min(300px, 30vw); }
/* The result: centred over the pit floor, under the corpse, where the raid just ended. */
.hud-ml.verdict { top: 68%; left: 50%; transform: translate(-50%, -50%); width: min(340px, 80vw); text-align: center; align-items: center; }
.verdict { gap: 10px; padding: 14px 16px; }
.verdict-line { font: 12px var(--mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.verdict-next { font: 11px var(--mono); font-variant-numeric: tabular-nums; color: var(--muted); }
/* The button and the text links are what take a click; the box itself stays click-through.
   The links are inline text — the marker line and the guest's sign-in line read as
   sentences under the button, not as a second row of controls. */
.verdict .btn { pointer-events: auto; margin-top: 4px; }
.verdict .link { pointer-events: auto; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
.verdict .link:hover, .verdict .link:focus-visible { color: var(--olive); outline: none; }
/* Until SETTLED lands (see Verdict): plain text, the underline is what says "link". */
.verdict .link:disabled { color: var(--muted); text-decoration: none; cursor: default; }
`;

/** Quiet seconds before the layer fades. Long enough that it never fades mid-dodge. */
const CALM_AFTER_MS = 4_000;

/**
 * The whole HUD, three nodes. Everything is `position: fixed`, so it renders the same on
 * either side of the gate and the caller places nothing.
 */
export function Hud() {
  const calm = useCalm();
  const hidden = useHideKey();
  return (
    <>
      <style>{HUD_CSS}</style>
      <div className={`hud-layer${calm ? ' is-calm' : ''}${hidden ? ' is-hidden' : ''}`}>
        <Card />
        <Hint />
        <Top />
        <Corner />
      </div>
      <Fallen />
      <Verdict />
    </>
  );
}

/**
 * Fades the layer after {@link CALM_AFTER_MS} of nothing: no pointer, no key, no change
 * to your own hp, no phase change. Any of those brings it straight back. The timer is
 * re-armed on every pointer move, which is cheap: React bails out of a `setCalm(false)`
 * that changes nothing, and clearing a timeout is not work.
 */
function useCalm(): boolean {
  const [calm, setCalm] = useState(false);
  const hp = useSelect((s) => mySeatSlot(s)?.hp ?? -1);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const timer = useRef(0);
  const wake = useCallback((): void => {
    setCalm(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCalm(true), CALM_AFTER_MS);
  }, []);
  useEffect(() => {
    const on = (): void => wake();
    window.addEventListener('pointermove', on, { passive: true });
    window.addEventListener('pointerdown', on, { passive: true });
    window.addEventListener('keydown', on);
    return () => {
      window.removeEventListener('pointermove', on);
      window.removeEventListener('pointerdown', on);
      window.removeEventListener('keydown', on);
      window.clearTimeout(timer.current);
    };
  }, [wake]);
  useEffect(() => wake(), [hp, phase, wake]);
  return calm;
}

/** H hides the layer entirely; H again brings it back. Ignored while typing in a field. */
function useHideKey(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const on = (event: KeyboardEvent): void => {
      if (event.code !== 'KeyH' || event.repeat) return;
      const t = event.target as HTMLElement | null;
      if (t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      setHidden((h) => !h);
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  return hidden;
}

function Corner() {
  return (
    <div className="hud-corner">
      <MarkerIcon />
      <MuteIcon />
      <ExitIcon />
    </div>
  );
}

/**
 * A real `<button>`: Space is the fire key and `controls.ts` takes it before activation;
 * Enter toggles this. `sfx.ts` owns the remembered value — this only mirrors it into
 * React so the icon re-renders.
 */
function MuteIcon() {
  const [muted, set] = useState(isMuted);
  return (
    <button
      className="hud-icon"
      aria-pressed={muted}
      aria-label={muted ? 'Unmute' : 'Mute'}
      title={muted ? 'Unmute' : 'Mute'}
      onClick={() => {
        setMuted(!muted);
        set(!muted);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
        {muted ? (
          <path d="M16 8l5 8M21 8l-5 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        ) : (
          <path d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 5.5a8 8 0 0 1 0 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
        )}
      </svg>
    </button>
  );
}

/**
 * The marker colour, from the lobby: `changeMarker` gives the seat back and opens the
 * select, whose "Take a seat" claims again with the new colour — the colour is written
 * at the claim and nowhere else, so a change is a re-seat.
 */
function MarkerIcon() {
  const store = useStore();
  const skinId = useSelect((s) => s.skinId);
  return (
    <button
      className="hud-icon"
      aria-label="Change marker colour"
      title="Change marker colour"
      onClick={() => void store.changeMarker()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="7" fill={SKIN_COLORS[skinId] ?? 'currentColor'} stroke="currentColor" strokeWidth="2" />
      </svg>
    </button>
  );
}
function ExitIcon() {
  const store = useStore();
  const inMatch = useSelect((s) => s.match !== null);
  if (!inMatch) return null;
  return (
    <button className="hud-icon" aria-label="Leave the match" title="Leave the match" onClick={() => void store.leaveMatch()}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 3h9v18H4z" fill="currentColor" opacity="0.9" />
        <path d="M11 12h9M17 8l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </button>
  );
}

const PHASE_NAMES: Readonly<Record<number, string>> = {
  [PHASE_LOBBY]: 'LOBBY',
  [PHASE_MUSTERING]: 'MUSTERING',
  [PHASE_FIGHTING]: 'FIGHTING',
  [PHASE_SETTLING]: 'SETTLING',
  [PHASE_SETTLED]: 'SETTLED',
};

/**
 * The card: state and timer, tick and feed, HP, seats. Everything the old two clusters
 * said, on four short lines with one typographic scale each — state in small caps, the
 * timer as the only large thing, tick and feed as one muted line, the count beside its bar.
 */
function Card() {
  const slot = useSelect(mySeatSlot);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const tick = useSelect((s) => s.arena?.tick ?? 0);
  const fightAt = useSelect((s) => s.arena?.fightAtTick ?? 0);
  const enrageAt = useSelect((s) => s.arena?.enrageAtTick ?? 0);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  const raidSize = useSelect((s) => s.arena?.raidSize ?? 0);
  const tier = useSelect((s) => s.arena?.difficulty ?? TIER_EASY);
  const boss = useSelect((s) => s.boss);
  const status = useSelect((s) => s.status);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  if (!slot) return null;

  const furious = phase === PHASE_FIGHTING && boss !== null && isFurious(boss, raidSize, tier);
  const mustering = phase === PHASE_MUSTERING;
  const left = enrageAt - tick;
  const timer = mustering ? clock(fightAt - tick, tickMs) : phase === PHASE_FIGHTING && enrageAt !== 0 ? clock(left, tickMs) : null;
  const urgent = phase === PHASE_FIGHTING && enrageAt !== 0 && left * tickMs <= 30_000;
  const dead = slot.hp === 0;
  const pct = slot.hpMax > 0 ? floorPercent(slot.hp, slot.hpMax) : 0;
  const occupied = players?.slots.filter((x) => x.occupied).length ?? 0;

  return (
    <div className={`hud-card${urgent ? ' hud-urgent' : ''}${dead ? ' is-down' : ''}`}>
      <div className="hud-card-head">
        <span className={`hud-state${furious ? ' is-enraged' : mustering ? ' is-muster' : ''}`}>
          {furious ? 'ENRAGED' : (PHASE_NAMES[phase] ?? `PHASE ${phase}`)}
        </span>
        {timer !== null && <span className="hud-timer">{timer}</span>}
      </div>
      {/* The tick and the feed status live in the telemetry panel; here only a feed
          that is NOT live earns a word, in the phase line, where the eye already is. */}
      {status === 'stale' && <span className="hud-stale">stale</span>}
      <div className="hud-hp">
        <div className="hud-hp-bar" role="meter" aria-label="your health" aria-valuenow={slot.hp} aria-valuemax={slot.hpMax}>
          <div className={`hud-hp-fill${pct <= 30 ? ' is-low' : ''}`} style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
        {/* A death is final for the raid — no respawn, so no countdown. */}
        <span className="hud-hp-num">{dead ? 'DOWN' : `${slot.hp}/${slot.hpMax}`}</span>
      </div>
      {occupied > 1 && (
        <ol className="hud-seats">
          {Array.from({ length: MAX_SEATS }, (_, i) => {
            const other = players?.slots[i];
            if (!other?.occupied) return null;
            return (
              <li
                key={i}
                className="hud-seat"
                aria-current={i === seat ? 'true' : undefined}
                aria-label={`seat ${i}${other.zone === ZONE_ARENA ? ', in the pit' : ', in the lobby'}`}
                style={{
                  background: SKIN_COLORS[other.skinId] ?? 'var(--dim)',
                  opacity: other.zone === ZONE_ARENA ? 1 : 0.45,
                }}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * The controls, said twice, both times in the corner and never in the play area.
 *
 * The first is the waiting area's: how to walk, said once, and gone for the life of the
 * seat on the first step the chain acknowledges (`lastMoveSeq`).
 *
 * The second is the muster's, and it is a different lesson. A player who has crossed the
 * gate has plainly worked out how to walk and how to shoot — but the SUPER is the one
 * thing in this game nothing teaches, because it is a hold with no button and no cooldown
 * ring to hint at it, and the muster is the only window where there is nothing else to
 * read. So the countdown before a boss wakes is exactly when to say it, and it goes when
 * the fight starts rather than lingering over it.
 */
function Hint() {
  const moved = useSelect((s) => (mySeatSlot(s)?.lastMoveSeq ?? 0) > 0);
  const inPit = useSelect((s) => mySeatSlot(s)?.zone === ZONE_ARENA);
  const mustering = useSelect((s) => s.arena?.phase === PHASE_MUSTERING);
  if (inPit) {
    if (!mustering) return null;
    return (
      <div className="hud-hint" aria-hidden="true">
        <b>SPACE</b> shoot · <b>HOLD</b> to charge · <b>HOLD LONGER</b> for a super
      </div>
    );
  }
  if (moved) return null;
  return (
    <div className="hud-hint" aria-hidden="true">
      <b>WASD</b> move · <b>SPACE</b> attack · hold to charge
    </div>
  );
}

/** Top centre, in the pit only: the boss bar, bare, where the eyes already are. */
function Top() {
  const inPit = useSelect((s) => mySeatSlot(s)?.zone === ZONE_ARENA);
  const phase = useSelect((s) => s.arena?.phase ?? PHASE_LOBBY);
  const raidSize = useSelect((s) => s.arena?.raidSize ?? 0);
  const tier = useSelect((s) => s.arena?.difficulty ?? TIER_EASY);
  const boss = useSelect((s) => s.boss);
  if (!inPit || boss === null || phase === PHASE_LOBBY) return null;

  // Fight HP, not shell: shell above the vent line never has to come off, so a solo bar
  // read 97 % three hits from a win. `fightHp` is the chain's own `Boss::fight_hp`, and
  // the floor keeps 20 % and ENRAGED landing on the same tick.
  const hp = fightHp(boss, raidSize, tier);
  if (hp.max <= 0) return null;
  const fighting = phase === PHASE_FIGHTING;
  const furious = fighting && isFurious(boss, raidSize, tier);
  const pct = floorPercent(hp.left, hp.max);
  // The tag names the tier while fighting, in the doorway's own light — the one place the
  // raid's difficulty is written on screen — and ENRAGED overrides it: fury is the fact
  // that changes what you do next. Through the muster it is still just the boss.
  const tag = furious ? 'ENRAGED' : fighting ? TIER_NAMES[tier] : 'BOSS';
  const tagStyle = furious || !fighting ? undefined : { color: TIER_COLORS[tier] };

  return (
    <div className={`hud-top${furious ? ' hud-enraged' : ''}`}>
      <div className="hud-boss">
        <span className="hud-tag" style={tagStyle}>{tag}</span>
        <div className="hud-boss-bar" role="meter" aria-label="boss health" aria-valuenow={pct} aria-valuemax={100}>
          <div className="hud-boss-fill" style={{ transform: `scaleX(${pct / 100})` }} />
          <div className="hud-boss-mark" style={{ left: `${FURY_PCT}%` }} aria-hidden="true" />
        </div>
        <span className="hud-boss-pct">{pct}%</span>
      </div>
    </div>
  );
}

/**
 * `tone` is the `styles.css` colour hook (`.verdict-win .verdict-label` and friends) and
 * stays keyed by outcome, not by label — the label reads VICTORY now and the class does not.
 * A WIN's `line` is short because three result lines follow it; a WIPE's or an ENRAGE's
 * is the whole verdict.
 */
const VERDICTS: Readonly<
  Record<number, { readonly label: string; readonly tone: string; readonly line: string }>
> = {
  [OUTCOME_WIN]: { label: 'DESTROYED', tone: 'win', line: 'Heartrot fell' },
  [OUTCOME_WIPE]: {
    label: 'WIPE',
    tone: 'wipe',
    line: 'Every raider in the arena was down. A death is final, so the raid ended with the last one.',
  },
  [OUTCOME_ENRAGE]: {
    label: 'ENRAGE',
    tone: 'enrage',
    line: 'The enrage tick passed with the core still alive. Not a wipe — you ran out of clock.',
  },
};

/**
 * Your rank by damage among the occupied seats — ties share a rank, so two raiders on
 * 1,240 are both 2nd and nobody is 3rd — and your share of the raid's total, floored like
 * every other percentage here. `damageDealt` is on every live `PlayerSlot`, so this reads
 * the roster the Card already renders from; the settle writes the same number to the
 * leaderboard row a moment later.
 */
function standing(slots: readonly PlayerSlot[], seat: number) {
  const seated = slots.filter((s) => s.occupied);
  const damage = slots[seat]?.damageDealt ?? 0;
  const total = seated.reduce((sum, s) => sum + s.damageDealt, 0);
  return {
    rank: 1 + seated.filter((s) => s.damageDealt > damage).length,
    of: seated.length,
    damage,
    share: floorPercent(damage, total),
  };
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 20th. `MAX_SEATS` is 20, so the teens are the whole trick. */
function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;
}

/** Seconds the results panel stays up before the next seat is taken by itself. */
/**
 * How long after the outcome lands the result waits before it draws — the kill plays
 * first. A WIN chars the boss over `VOLLEY_INTERVAL_MS` (3.2 s) with the limbs tearing
 * off across it; a loss has nothing to watch and only needs the beat.
 */
const REVEAL_WIN_MS = 4_200;
const REVEAL_LOSS_MS = 1_500;

function Verdict() {
  const store = useStore();
  const outcome = useSelect((s) => s.arena?.outcome ?? OUTCOME_UNDECIDED);
  // The chain's word, delivered by the feed: `settle` (tag 9) writes SETTLED on the ER
  // before it commits. Not `outcome`, which lands at SETTLING while the Worker's settle is
  // still in flight. Nothing here leaves before it: `leave_seat` is refused outside
  // LOBBY/MUSTERING/FIGHTING (`assert_playable`), so a leave sent from SETTLING is a
  // refused instruction the Worker answers `release_failed`, followed by a join that has
  // to scan past the arena this seat is still sitting in. The countdown, the button and
  // both links wait on the same byte.
  const settled = useSelect((s) => s.arena?.phase === PHASE_SETTLED);
  const incarnation = useSelect((s) => s.arena?.incarnation ?? 0);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const guest = useSelect((s) => s.guest === true);
  const row = VERDICTS[outcome];
  // The verdict is the HUD's own event — the byte lands here and nowhere else draws it.
  usePlayOnRise(outcome === OUTCOME_WIN, 'win');
  usePlayOnRise(outcome === OUTCOME_WIPE || outcome === OUTCOME_ENRAGE, 'lose');

  // No countdown and no auto-rejoin: the result stays until the player leaves it. It
  // draws only after the ending has played — the outcome lands at SETTLING, the same
  // edge the boss's death starts on, so the timer runs from there.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (outcome === OUTCOME_UNDECIDED) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShown(true),
      outcome === OUTCOME_WIN ? REVEAL_WIN_MS : REVEAL_LOSS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [outcome]);

  if (!row || !shown) return null;
  const won = outcome === OUTCOME_WIN;
  // Only a WIN rolls a next incarnation (`OUTCOME_WIN`'s own doc), so only a WIN names one.
  const next = incarnation + 1;
  const stand = won && players !== null ? standing(players.slots, seat) : null;
  return (
    <div className={`hud hud-ml verdict verdict-${row.tone}`} role="status">
      <span className="verdict-label">{row.label}</span>
      <span className={won ? 'verdict-line' : 'fine'}>{row.line}</span>
      {stand !== null && (
        <>
          <span className="verdict-line">
            You placed {ordinal(stand.rank)} of {stand.of}
          </span>
          <span className="verdict-line">
            {stand.damage.toLocaleString('en-US')} damage · {stand.share}%
          </span>
          {/* Cumulative, not "+15%": the rule (`SHELL_PCT_PER_INCARNATION`) is linear on
              the incarnation-0 shell, so +15% is true of the base and false of the boss
              just fought — 2 → 3 is +11.5 % on it. */}
          <span className="verdict-next">
            Next: Incarnation {next} · shell +{next * SHELL_PCT_PER_INCARNATION}%
          </span>
        </>
      )}
      <button className="btn btn-primary" disabled={!settled} onClick={() => void store.leaveMatch()}>
        Back to lobby
      </button>
      {/* Secondary, in the box's smallest type: the select is not a step any more, so
          the way back to it is a link, and the guest's sign-in is an offer under the same
          button everyone else gets — a name on the leaderboard, not a gate on the raid. */}
      <span className="fine">
        <button className="link" disabled={!settled} onClick={() => void store.changeMarker()}>
          Change marker
        </button>
      </span>
      {guest && (
        <span className="fine">
          <button className="link" disabled={!settled} onClick={() => void store.signOut()}>
            Sign in
          </button>{' '}
          to keep your name on the leaderboard.
        </span>
      )}
    </div>
  );
}

/**
 * Down, mid-fight. A death is final for the raid — the seat stays on the floor at hp 0,
 * its damage still counts at the verdict, and there is nothing to wait for — so the card
 * says so once and offers the two things a corpse can still do: leave, or watch. It yields
 * to {@link Verdict} the moment the phase leaves FIGHTING; the Verdict is the result.
 */
function Fallen() {
  const store = useStore();
  const slot = useSelect(mySeatSlot);
  const fighting = useSelect((s) => s.arena?.phase === PHASE_FIGHTING);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const down = slot !== null && slot.hp === 0 && slot.zone === ZONE_ARENA && fighting;
  // "Watch the raid" is local and lasts one death: a new seat, or hp back above zero,
  // starts over.
  const [watching, setWatching] = useState(false);
  useEffect(() => setWatching(false), [seat, down]);
  usePlayOnRise(down, 'lose');
  if (!down || watching || players === null) return null;
  const stand = standing(players.slots, seat);
  return (
    <div className="hud hud-ml verdict verdict-ember" role="status">
      <span className="verdict-label">YOU FELL</span>
      <span className="fine">Heartrot got you. No respawn — what you dealt still counts at the verdict.</span>
      <span className="verdict-line">
        {stand.damage.toLocaleString('en-US')} damage · {stand.share}%
      </span>
      <span className="verdict-line">
        {ordinal(stand.rank)} of {stand.of} so far
      </span>
      <button className="btn btn-primary" onClick={() => void store.leaveMatch()}>
        Back to lobby
      </button>
      <span className="fine">
        <button className="link" onClick={() => setWatching(true)}>
          Watch the raid
        </button>
      </span>
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
  // The threshold the table below is written against: a full EASY raid's 35 %. The solo
  // end and monotonicity are asserted too, because the bar prints `ventPct` for every size.
  const VENT_PERCENT = ventPct(MAX_SEATS, TIER_EASY);
  if (ventPct(1, TIER_EASY) !== VENT_PCT_SOLO_BY_TIER[TIER_EASY] || VENT_PERCENT !== VENT_PCT_FULL_BY_TIER[TIER_EASY]) {
    throw new Error(`Hud self-check: ventPct reads ${ventPct(1, TIER_EASY)} solo, ${VENT_PERCENT} full`);
  }
  for (let raid = 2; raid <= MAX_SEATS; raid += 1) {
    if (ventPct(raid, TIER_EASY) > ventPct(raid - 1, TIER_EASY)) {
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
  const { max: fightMax } = fightHp(solo, 1, TIER_EASY);
  const line = Math.floor((fightMax * FURY_PCT) / 100);
  const at = (left: number) => ({ ...solo, parts: [Math.floor((1_000 * ventPct(1, TIER_EASY)) / 100)], coreHp: left });
  if (isFurious(solo, 1, TIER_EASY) || !isFurious(at(line), 1, TIER_EASY) || isFurious(at(line + 1), 1, TIER_EASY)) {
    throw new Error(`Hud self-check: fury does not flip at exactly ${FURY_PCT}% of ${fightMax}`);
  }
  // One name and one colour per tier, so the tag can never print `undefined` over the bar.
  if (TIER_NAMES.some((n) => n.length === 0) || TIER_COLORS.some((c) => !/^#[0-9a-f]{6}$/i.test(c))) {
    throw new Error('Hud self-check: a tier has no name or no colour');
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
    throw new Error('Hud self-check: VICTORY, WIPE and ENRAGE must stay three distinct labels');
  }

  // Standing is the only arithmetic the results panel adds, and its silent failures are a
  // tie printed as two ranks, a released seat's stale damage counted into the total, and
  // a share rounded up past the raid's. Seats 0 and 3 tie on 1,240 of 4,480: both 2nd,
  // nobody 3rd, 27 % each; the zeroed seat 4 carries 9,999 and counts for nothing.
  const raid = [1_240, 2_000, 0, 1_240, 9_999].map(
    (damageDealt, i) => ({ seat: i, occupied: i !== 4, damageDealt }) as PlayerSlot,
  );
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => standing(raid, i));
  if (!a || !b || !c || !d || a.of !== 4 || a.rank !== 2 || d.rank !== 2 || b.rank !== 1 || c.rank !== 4) {
    throw new Error('Hud self-check: standing ranks the tie wrong');
  }
  if (a.share !== 27 || b.share !== 44 || c.share !== 0 || a.damage !== 1_240) {
    throw new Error(`Hud self-check: standing shares ${a.share}/${b.share}/${c.share}`);
  }
  for (const [n, s] of [[1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'], [11, '11th'], [12, '12th'], [13, '13th'], [20, '20th']] as const) {
    if (ordinal(n) !== s) throw new Error(`Hud self-check: ordinal(${n}) reads ${ordinal(n)}`);
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
  // 400 ms is 4 ticks: cooldown 3, the margin's +1 opens the gate at tick 5.
  if (shotAllowed(4, 0, CLASS_ARCHER) || !shotAllowed(5, 0, CLASS_ARCHER)) {
    throw new Error('Hud self-check: the shot gate is not controls.ts’s 400 ms archer cooldown');
  }
  // Not asserted here any more: `classOf` is `layout.ts`'s and is checked where it lives.
  // What this file still owns is the LABEL — a names array shorter than the class table
  // prints "CLASS 1" at a seat the chain calls an archer, and nothing else would notice.
  if (CLASS_NAMES.length !== N_CLASSES) {
    throw new Error(`Hud self-check: ${CLASS_NAMES.length} class names for ${N_CLASSES} classes`);
  }
}
