/**
 * The spawn beat — the one-shot the cavern plays when the muster ends and the fight begins.
 *
 * The boss does not descend and does not move: it stands at `map::BOSS_SPAWN` from `init`
 * onward, and the *reveal* is the camera pan (`docs/architecture/11-immortals-spec.md`
 * §1.4), which `#camera` owns. §7.5 forbids a `DESCENT_MS` outright. So this file draws the
 * only part of the moment nobody else owns: the light. The cavern darkens, the eyes ignite,
 * the vent flares, the pit rim catches the glow, and it clears.
 *
 * Four rules it is built to satisfy, in the order they constrain the code:
 *
 *   fires once   The trigger is a value diff — `phase` *changing* to `PHASE_FIGHTING` —
 *                per §7.4. The Magic Router delivers every notification twice and the
 *                crank rewrites `Arena` at 10 Hz; a duplicate diffs to nothing, so there
 *                is no latch, no counter and no bookkeeping. `prev === null` (the first
 *                payload this client ever consumed) never fires, so joining a fight
 *                already in progress does not replay its opening.
 *   never blocks  Nothing here gates input, and nothing waits for it: `pointer-events:
 *                none`, no state outside this component, and the fight is already running
 *                underneath. Cancel it at any point in its life and the game is unchanged.
 *   skippable    A pointer or key event finishes the animations on the spot. Because the
 *                end state is "gone", finishing early *is* skipping.
 *   reduced      §7.6: cancel by not starting. The beat carries no information — the phase
 *                is in the HUD and the boss is already on screen — so under
 *                `prefers-reduced-motion` it renders nothing at all rather than a 150 ms
 *                fade of the same veil.
 *
 * Node ownership (§7.3): every node below is created and animated by this file and by
 * nothing else, and only `opacity` is ever animated — no transform on any node another
 * writer owns, and no `transform-box` trap to fall into. The boss's own resting eye and
 * vent art belong to the boss rig; these are a transient flare drawn over it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  BOSS_ANCHOR_X,
  BOSS_ANCHOR_Y,
  BOSS_SCALE,
  CORE,
  MAP_TILE,
  MAP_TILES,
  PHASE_FIGHTING,
  PIT_BOT,
  PIT_TOP,
} from '@heartrot/client';

/**
 * How long the beat lasts, client-local and cosmetic.
 *
 * It is deliberately NOT derived from a chain constant: it matches no game duration, and
 * §7.5 bans an on-chain animation length. The only real ceiling is that it must be over
 * well before the boss's first volley lands (`VOLLEY_INTERVAL_TICKS` = 32 ticks = 3,200 ms
 * at `TICK_MS` 100), so the light show can never be the reason a player misses the first
 * thing that shoots at them. 1,200 ms leaves 2 s of margin, and the veil is transparent
 * again by ~950 ms.
 */
const SPAWN_MS = 1200;

/** World span, from the generated map rather than a second copy of 1024. */
const ARENA_UNITS = MAP_TILES * MAP_TILE;

/**
 * The eyes, in sprite pixels: two near-white 2x2 blocks at (137,81) and (144,81) in
 * `assets/sprites/parts/boss.svg` (spec §8.3, an inference from 8 pixels — "cheap to verify
 * on first render, cheap to move"). Converted to boss-local units through the generated
 * anchor and scale, so `gen_hitboxes.py --scale 2` moves the flare with everything else.
 *
 * ponytail: two literals the generator does not emit. If the boss rig ends up exporting
 * eye coordinates, import those and delete these three lines.
 */
const EYE_SPRITE_X = [137, 144] as const;
const EYE_SPRITE_Y = 81;
const EYE_X = EYE_SPRITE_X.map((x) => BOSS_ANCHOR_X + x * BOSS_SCALE);
const EYE_Y = BOSS_ANCHOR_Y + EYE_SPRITE_Y * BOSS_SCALE;
/** The 2x2 block scaled up, rounded out a little so it reads as a light and not a pixel. */
const EYE_R = 3 * BOSS_SCALE;

/** The vent, from the same numbers the chain compares a ray against. Never a literal. */
const CORE_R = Math.round(Math.sqrt(CORE.radiusSq));

/** The pit lip the hands grip — the rim that catches the glow. */
const RIM_CY = (PIT_TOP + PIT_BOT) / 2;
const RIM_RX = ARENA_UNITS / 2 - MAP_TILE;
const RIM_RY = (PIT_BOT - PIT_TOP) / 2;

const VEIL = '#05080f';
const GLOW = '#8fe9ff';
const RIM = '#4fb8e6';

/**
 * Does this payload open the beat?
 *
 * Exported so the self-check at the bottom can hold the whole trigger to account: the
 * duplicate notification, the mid-fight join and the phases either side of the flip are all
 * silent failures otherwise — a cinematic that replays twice a second looks like a bug in
 * the renderer, and one that plays on reconnect looks like the fight restarted.
 */
export function spawnFires(prev: number | null, next: number): boolean {
  return prev !== null && prev !== next && next === PHASE_FIGHTING;
}

export interface SpawnProps {
  /** `arena.phase`. The beat opens on the payload that *changes* it to `PHASE_FIGHTING`. */
  phase: number;
  /** `boss.x` / `boss.y` — the anchor every boss-local number above is measured from. */
  bossX: number;
  bossY: number;
  /**
   * `prefers-reduced-motion`, resolved once by the caller. Passed rather than read here:
   * §7.6 asks for one resolver, and `Arena.tsx` already has it for the frame loop.
   */
  reduced: boolean;
  /**
   * `state.feedEpoch`, bumped whenever the world feed leaves `'live'`
   * (`docs/architecture/15-gate-transition.md` §4.2).
   *
   * Without it this beat replays on every reconnect. The renderer does not unmount when
   * the socket drops — `App.tsx:159` mounts `<World>` as a sibling of the screen switch —
   * so `prev` survives the outage, and the measured outage is 1,681 ms, four crank ticks.
   * A player who drops during `PHASE_MUSTERING` and returns during `PHASE_FIGHTING` gets
   * the opening cinematic replayed over a fight already in progress.
   *
   * Do NOT substitute `state.status`: `store.ts:415` forces it to `'live'` on every
   * account update, so the payload that needs suppressing is the same payload that repairs
   * the status — the gate would race the thing it gates.
   *
   * Optional only so this file does not break a caller that has not been rewired yet; the
   * default is a constant, which means no gate. `Passage.tsx` implements the identical
   * rule against `zone` and the two must stay in step.
   */
  feedEpoch?: number;
}

/**
 * Mount as the LAST child of `#camera`, so the light sits over the boss, the raiders and
 * the bullets, and pans with them. It draws nothing at all except during the beat.
 */
export function Spawn({ phase, bossX, bossY, reduced, feedEpoch = 0 }: SpawnProps) {
  const prev = useRef<number | null>(null);
  const epoch = useRef(feedEpoch);
  const [playing, setPlaying] = useState(false);
  const veil = useRef<SVGRectElement | null>(null);
  const eyes = useRef<SVGGElement | null>(null);
  const rim = useRef<SVGEllipseElement | null>(null);

  useEffect(() => {
    if (epoch.current !== feedEpoch) {
      // The feed dropped: this payload is a resync, not a diff. Seeding `prev` with the
      // current phase rather than `null` re-arms on the NEXT payload rather than
      // suppressing two — §4.4 asks for exactly one.
      epoch.current = feedEpoch;
      prev.current = phase;
      return;
    }
    const was = prev.current;
    prev.current = phase;
    // Under reduced motion `prev` is still tracked, so turning the setting off mid-session
    // does not make the next duplicate payload look like a fresh transition.
    if (!reduced && spawnFires(was, phase)) setPlaying(true);
  }, [phase, reduced, feedEpoch]);

  // Layout, not passive: the nodes mount opaque-at-zero and must be animating before the
  // browser paints them, or the first frame is a black rectangle over the arena.
  useLayoutEffect(() => {
    if (!playing) return;
    const opts: KeyframeAnimationOptions = { duration: SPAWN_MS, easing: 'ease-out' };
    const anims = [
      // Darkness in fast, gone by ~950 ms — the cavern dims, it does not black out.
      veil.current?.animate(
        [{ opacity: 0 }, { opacity: 0.55, offset: 0.14 }, { opacity: 0.5, offset: 0.45 }, { opacity: 0 }],
        opts,
      ),
      // It wakes: eyes and vent come up through the veil, which is why they are drawn over it.
      eyes.current?.animate(
        [
          { opacity: 0 },
          { opacity: 0, offset: 0.12 },
          { opacity: 1, offset: 0.38 },
          { opacity: 1, offset: 0.7 },
          { opacity: 0 },
        ],
        opts,
      ),
      // The rim catches it a beat later, so the light reads as coming FROM the creature.
      rim.current?.animate(
        [{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 0.9, offset: 0.55 }, { opacity: 0 }],
        opts,
      ),
    ].filter((a): a is Animation => a !== undefined);

    if (anims.length === 0) {
      setPlaying(false);
      return;
    }

    // Skip. `finish()` jumps to the last keyframe, which is "invisible", so skipping and
    // finishing are the same code path and there is no second way out to get wrong.
    const skip = () => {
      for (const a of anims) a.finish();
    };
    addEventListener('pointerdown', skip, { passive: true });
    addEventListener('keydown', skip, { passive: true });

    let live = true;
    // `.finished` rejects on cancel (unmount, or a re-render that tears this down); that is
    // not an error, it is the beat being called off, and nothing waits on it (§7.5).
    Promise.all(anims.map((a) => a.finished))
      .then(() => {
        if (live) setPlaying(false);
      })
      .catch(() => {});

    return () => {
      live = false;
      removeEventListener('pointerdown', skip);
      removeEventListener('keydown', skip);
      for (const a of anims) a.cancel();
    };
  }, [playing]);

  if (!playing) return null;

  return (
    <g
      // Never in the way: the fight is already running underneath this.
      pointerEvents="none"
      aria-hidden="true"
      // The scene inherits `crispEdges` for the pixel art; a soft light rendered on the
      // device grid is a staircase.
      shapeRendering="geometricPrecision"
    >
      <rect ref={veil} x={0} y={0} width={ARENA_UNITS} height={ARENA_UNITS} fill={VEIL} opacity={0} />
      <g ref={eyes} opacity={0} transform={`translate(${bossX} ${bossY})`}>
        {EYE_X.map((x, i) => (
          <g key={i}>
            <circle cx={x} cy={EYE_Y} r={EYE_R * 2.4} fill={GLOW} opacity={0.18} />
            <circle cx={x} cy={EYE_Y} r={EYE_R} fill={GLOW} />
          </g>
        ))}
        <circle cx={CORE.x} cy={CORE.y} r={CORE_R * 1.6} fill={GLOW} opacity={0.14} />
        <circle cx={CORE.x} cy={CORE.y} r={CORE_R} fill={GLOW} opacity={0.55} />
      </g>
      <ellipse
        ref={rim}
        cx={ARENA_UNITS / 2}
        cy={RIM_CY}
        rx={RIM_RX}
        ry={RIM_RY}
        fill="none"
        stroke={RIM}
        strokeWidth={6}
        opacity={0}
      />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Self-check
//
// The trigger is the whole of this file's correctness and every way it fails is silent:
// firing on a duplicate replays the beat twice a second, firing on the first payload
// replays it on every reconnect, and not firing at all is a missing feature nobody sees.
// Dev-only, same shape as `Arena.tsx`'s.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`Spawn self-check: ${what}`);
  };

  const PHASE_MUSTERING = 6; // state.rs; not yet mirrored into `@heartrot/client`.

  ok(spawnFires(PHASE_MUSTERING, PHASE_FIGHTING), 'the muster ending opens the beat');
  // The Magic Router delivers every notification twice, and the crank rewrites Arena at
  // 10 Hz for the whole fight.
  ok(!spawnFires(PHASE_FIGHTING, PHASE_FIGHTING), 'a duplicate payload is silent');
  // First payload this client consumed: a mid-fight join, or a reconnect.
  ok(!spawnFires(null, PHASE_FIGHTING), 'arriving mid-fight does not replay the opening');
  ok(!spawnFires(PHASE_FIGHTING, 2 /* SETTLING */), 'leaving the fight does not open it');
  ok(!spawnFires(0 /* LOBBY */, PHASE_MUSTERING), 'the muster itself does not open it');

  // Geometry comes from the generated tables, not from this file. If a `--scale` change
  // ever leaves these behind, the flare lands somewhere the boss is not.
  ok(EYE_X.length === 2 && EYE_X[0] !== EYE_X[1], 'two eyes, apart');
  ok(CORE_R > 0 && RIM_RY > 0, 'the vent and the rim have a size');
}
