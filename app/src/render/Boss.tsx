/**
 * The boss — the painting's own demon, rigged per part, index-aligned with the chain.
 *
 * The creature is cut out of the arena painting by `tools/gen_boss.py` into one RGBA
 * atlas (`assets/sprites/boss_parts.png`), one tight cell per part, and placed back at
 * exactly the crop it came from: `BOSS_SPAWN + BOSS_ANCHOR` is the crop's top-left. The
 * room under it (`BossArena.tsx`) is the SAME painting with the demon painted out inside
 * that same silhouette (`gen_rooms.py`), so on a full shell the rig covers its own hole
 * edge to edge and reads as the painting — and a destroyed part is simply gone: the wall
 * and the dais show through where it stood, and a burst of dark smoke marks the wound.
 * That is the whole reason the rig exists.
 *
 * Every cell is drawn through a nested `<svg viewBox={atlas cell}>` sized to the part's
 * world box: a crop without a `clipPath`, eleven `<image>`s of one URL, one decoded bitmap.
 * `BOSS_PARTS[i].index` is the `Boss.parts` slot, emitted by the same tool that emits
 * `hitboxes.json` — the file `gen_hitboxes.py` compiles `PART_HITBOXES` from — and the boot
 * check at the bottom proves each drawn box IS its chain box, unit for unit.
 *
 * THE TWO SYSTEMS, deliberately separate:
 *
 *   cosmetic   breathing, eye glow, the open vent's breathe, the fury aura, the lingering
 *              smoke. Pure CSS keyframes on nodes React does not write. They run composited
 *              at 60 fps and NEVER stall waiting for a notification — the boss keeps
 *              breathing through a dead socket.
 *   derived    dead parts, vent state, fury, enrage, death. Read from the snapshot. The
 *              resting appearance is a class (so a reload with no animation is still
 *              correct) and the one-shots are `Element.animate()` calls fired on a VALUE
 *              DIFF against the previous snapshot.
 *
 * The diff is what survives the feed: 68.4% of notifications during a fight carry no
 * change and the Magic Router delivers every one of them twice. A duplicate diffs to
 * nothing, so nothing fires — idempotence by construction, with no latch registry, no
 * debounce timer and nothing counting notifications.
 *
 * NOTHING GLOWS THROUGH A FILTER. Fury used to be a `drop-shadow` on the whole shell,
 * re-rasterising the rig every frame of its pulse — and once a part could be a HOLE, the
 * shadow of the living parts bled a red rim into every hole. It is an ember aura UNDER the
 * creature now: one gradient ellipse pulsing in opacity, composited, no filter anywhere on
 * the rig while it fights. The smoke is soft by GRADIENT, not by `filter: blur`: a blurred
 * SVG child is re-rastered on every frame of its drift, `will-change` or not (measured on
 * the framebudget harness, 20 seats, nine parts dead — 27 blurred wisps cost 0.9 ms/frame
 * at 1080p, 3.2 ms at a 4x CPU throttle, and a static blur was still 0.4 ms because the
 * eye and vent keyframes re-raster the breathe layer every frame anyway). So the smoke
 * sits in its own group BESIDE the breathe group — outside the shell's death filter — and
 * carries the `will-change` the seats and the rooms carry: a no-op on a real GPU, 36–85x
 * on software raster (`Arena.tsx`, `SEAT_STYLE`).
 *
 * NODE STACK, one writer each (two writers on one transform means one of them is silently
 * discarded — measured):
 *
 *     <g .hr-boss>          translate(boss.x, boss.y), `--shell`, state classes  <- React
 *       <defs>              the aura and smoke gradients
 *       <g .hr-boss-breathe>                                        <- CSS keyframes only
 *         <g .hr-boss-shell>    <- WAAPI `filter` for the death sequence, and nothing else
 *           .hr-boss-aura       the fury light, under the creature. CSS opacity only
 *           <g> translate(anchor) scale(BOSS_SCALE)   <- static, memoised, built once
 *             11 part groups                          <- WAAPI one-shots + .hr-dead
 *           .hr-boss-vent            the open vent's ring, over the core cell. CSS only
 *           .hr-boss-eye x2                                          <- CSS keyframes only
 *       <g .hr-smoke-layer> translate(anchor) scale(BOSS_SCALE), will-change  <- static
 *         one .hr-smoke per part: .hr-smoke-chunk x12  WAAPI burst on the kill;
 *                                 .hr-smoke-wisp x3    CSS drift while dead
 */
import { useEffect, useMemo, useRef } from 'react';

import {
  BOSS_ANCHOR_X,
  BOSS_ANCHOR_Y,
  BOSS_SCALE,
  BOSS_SPRITE_H,
  BOSS_SPRITE_W,
  CORE,
  N_PARTS,
  PART_HITBOXES,
  PHASE_FIGHTING,
  PHASE_MUSTERING,
  PHASE_LOBBY,
  PHASE_SETTLING,
  VENT_OPEN,
  VOLLEY_INTERVAL_MS,
  isFurious,
  type ArenaAccount,
  type BossAccount,
  OUTCOME_WIN,
} from '@heartrot/client';

import { ATLAS_H, ATLAS_SCALE, ATLAS_W, BOSS_ATLAS, BOSS_PARTS, EYES_PX } from './boss.gen';
import { play, speak, VOICE_NAMES, type VoiceName } from './sfx';

/**
 * Which way a limb flinches and breaks off: away from the boss origin, along its own
 * hitbox centre. Derived from the generated table, so it cannot disagree with where the
 * chain says the part is. Expressed as a unit vector; callers scale it in SPRITE pixels,
 * because the part groups live inside the `scale(BOSS_SCALE)` group.
 */
const OUTWARD: readonly (readonly [number, number])[] = PART_HITBOXES.map((r) => {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const d = Math.hypot(cx, cy) || 1;
  return [cx / d, cy / d] as const;
});

/** The vent, from the squared radius the chain compares against. Never a literal. */
const CORE_R = Math.sqrt(CORE.radiusSq);

/**
 * The eye pair, from the generator's own crop coordinates, converted through the
 * generated anchor and scale rather than through a copied number. The painting already
 * lights them; these are the pulse on top.
 */
const EYE_R = 4 * BOSS_SCALE;
const EYES: readonly (readonly [number, number])[] = EYES_PX.map(([sx, sy]): readonly [number, number] => [
  sx * BOSS_SCALE + BOSS_ANCHOR_X,
  sy * BOSS_SCALE + BOSS_ANCHOR_Y,
]);

/**
 * The fury aura's seat: the torso cell, the one part that is never destroyed, so the
 * light always has a body over it. Read off the generated rig, never typed.
 */
const TORSO = BOSS_PARTS.find((p) => p.name === 'torso');
if (TORSO === undefined) throw new Error('Boss: boss.gen.ts rigs no torso to seat the fury aura on');
const TORSO_INDEX = BOSS_PARTS.indexOf(TORSO);
const AURA = {
  cx: (TORSO.cx + TORSO.w / 2) * BOSS_SCALE + BOSS_ANCHOR_X,
  cy: (TORSO.cy + TORSO.h / 2) * BOSS_SCALE + BOSS_ANCHOR_Y,
  rx: TORSO.w * 0.75 * BOSS_SCALE,
  ry: TORSO.h * 0.6 * BOSS_SCALE,
};

/**
 * Cosmetic durations, in ms. The first three match no game duration — there is no chain
 * beat for a flinch — so they are typed, and none may ever reach the chain.
 *
 * The death sequence is the exception and is now derived: `PHASE_SETTLING` has no bounded
 * on-chain length (it ends when `settle` is called, not on a timer), so the honest bound
 * is the fight's own slowest beat, one volley period. Mirrored from
 * `tick.rs::VOLLEY_INTERVAL_TICKS` through `@heartrot/client` rather than typed, so it
 * still matches the volley the first time anyone tunes balance. `deathMs` stays a prop.
 */
const FLINCH_MS = 180;
const BREAK_MS = 520;
/** Between one limb tearing off and the next, in the death — ten limbs in 1.4 s. */
const DEATH_STAGGER_MS = 140;
const BURST_MS = 900;
const DEATH_MS = VOLLEY_INTERVAL_MS;

/** Sprite pixels a limb moves. One is `BOSS_SCALE` arena units inside the scaled group. */
const FLINCH_PX = 2;
const BREAK_PX = 7;

/**
 * The smoke, in sprite pixels: the reference's flying chunks scatter 20–60 out from the
 * wound with a little lift, doubling in size as they thin out; three wisps stay behind.
 * Two purples, the reference's — the dark of the cloud and the lit edge of it — each a
 * radial gradient (`hr-smoke-0/1`), which is what makes every chunk and wisp soft-edged
 * with no filter in the tree.
 */
const CHUNKS = 12;
const CHUNK_R = [6, 16] as const;
const CHUNK_THROW = [20, 60] as const;
const CHUNK_LIFT = 18;
const WISPS = 3;
const SMOKE_INK = ['#2a1230', '#4a1f52'] as const;

/**
 * The corpse: opaque, drained and dark. One string, used by the death sequence's end
 * frame, so the creature burns out in place rather than fading — a corpse that stays is
 * the read that the raid won. Petrified, not black: the limbs average 40 of 255 (measured
 * over the atlas — mace 39, claws 42, crown 44), so `brightness(0.25)` was a hole.
 */
const CHARRED = 'grayscale(1) brightness(1.15) contrast(0.85) sepia(0.35)';

/**
 * The open vent's ring width, as a ratio of the generated `CORE_R`. A ratio and never a
 * length: `CORE_R` is derived from `CORE.radiusSq` and a literal would go stale the moment
 * the chain retunes the vent. A stroke is centred on its path, so the ring's midline is
 * still the exact circle the chain raycasts.
 *
 * A sixth of the 0.15 it shipped at. At 0.15 with a 26 px glow and a scale pulse the ring
 * was the brightest thing on screen, and the player's report called it "this flash light"
 * and asked what it was for. Its only job is to mark the circle the chain raycasts once
 * the vent is open; a hairline does that.
 */
const RING_RATIO = 0.025;

/** Checked at fire time, not held in state: it is always current and costs one line. */
function reduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ---------------------------------------------------------------------------
// Style
//
// Every rule here is compositor work on a node React does not touch. `--shell` is the
// shell fraction, published by the one React-written node and inherited downward, so the
// breathing quickens and the eyes redden as the creature is stripped — at no extra cost
// and with no JS in the loop. The smoke's rules live in styles.css ("smoke"), beside the
// rooms' light, because they are the same vocabulary.
// ---------------------------------------------------------------------------

const CSS = `
.hr-boss-breathe {
  transform-box: fill-box;
  transform-origin: 50% 75%;
  animation: hr-boss-breathe calc(3.4s * (0.5 + var(--shell, 1) * 0.5)) ease-in-out infinite;
}
/* Twice as fast under either red state: the six-minute timeout (.hr-enraged, ends the
   fight) and fury (.hr-fury, the last fifth of the fight HP). Same breath, because a
   player reads "faster" and not which rule made it so. */
.hr-enraged .hr-boss-breathe, .hr-fury .hr-boss-breathe {
  animation-duration: calc(1.7s * (0.5 + var(--shell, 1) * 0.5));
}
/* Never below 1: the rig grows over its own painted-out hole and shrinks back onto it;
   under 1 the two-pixel ring of cloned floor around the cut would show. */
@keyframes hr-boss-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.014); } }

.hr-boss-eye {
  fill: color-mix(in srgb, #ff5c4a calc((1 - var(--shell, 1)) * 100%), #9fe8ff);
  transform-box: fill-box;
  transform-origin: center;
  animation: hr-boss-eye 1.9s ease-in-out infinite;
}
.hr-boss-eye:nth-of-type(2) { animation-delay: -0.35s; }
.hr-enraged .hr-boss-eye, .hr-fury .hr-boss-eye { fill: var(--ember, #ff5a4a); }
@keyframes hr-boss-eye {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.25); }
}

/* Fury: an ember light under the creature, pulsing at the furious volley's own beat
   (1.6 s). Opacity on one gradient ellipse, so it composites; no filter on the rig. The
   resting rule is what reduced motion keeps. */
.hr-boss-aura { opacity: 0; }
.hr-fury .hr-boss-aura { animation: hr-fury-aura 1.6s ease-in-out infinite; }
@keyframes hr-fury-aura { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.85; } }

/* A destroyed limb is GONE: the room's own wall and dais show through the hole, and its
   smoke (styles.css) says which gun you killed. The break-off ends here, so there is no pop. */
.hr-boss-part.hr-dead { opacity: 0; }

/* The vent. Sealed, it draws NOTHING: the core cell's own orb is the sealed look, and any
   ring here would sit on it a shade off. Open, a thin half-opacity ring on the exact
   circle the chain raycasts, with a small glow that reads as the orb lighting from
   inside, breathing in opacity and never in size. It used to be a white-hot ring under a
   26 px cyan glow scale-pulsing at 1.1 s, and the player asked "what is the motive of
   this flash light": a marker had become a beacon. The fade-in is a transition on
   stroke-opacity and the breathe is a keyframe on opacity, so the two never fight over
   one property and the open edge still fades rather than snapping.

   Lengths: the vent is a direct child of .hr-boss-shell, which carries no scale, so the
   blur radius here is arena units. Width is a ratio of the generated --core-r published
   by the element, never a literal. */
.hr-boss-vent {
  fill: none;
  stroke: var(--cyan, #6fe3ff);
  stroke-opacity: 0;
  stroke-width: calc(var(--core-r) * ${RING_RATIO});
  transition: stroke-opacity 0.4s ease-out;
}
.hr-vent-open .hr-boss-vent {
  stroke-opacity: 0.5;
  filter: drop-shadow(0 0 6px var(--cyan, #6fe3ff));
  animation: hr-boss-vent 2.8s ease-in-out infinite;
}
@keyframes hr-boss-vent { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }

@media (prefers-reduced-motion: reduce) {
  .hr-boss-breathe, .hr-boss-eye, .hr-vent-open .hr-boss-vent, .hr-fury .hr-boss-aura { animation: none; }
  .hr-fury .hr-boss-aura { opacity: 0.6; }
}
`;

// ---------------------------------------------------------------------------

export interface BossProps {
  arena: ArenaAccount;
  boss: BossAccount;
  /**
   * Length of the death sequence. Cosmetic and unbounded on chain, so it has a default
   * Defaults to `VOLLEY_INTERVAL_MS` — the fight's own slowest beat — because `SETTLING`
   * has no bounded on-chain duration to derive one from.
   */
  deathMs?: number;
}

/**
 * Which of the boss's five recorded lines speaks at which moment. A table, so re-dealing a
 * line to a different moment is one edit here and no asset moves. The clips are named for
 * where they came from (`sfx.ts::VoiceName`), deliberately not for these moments.
 *
 * The three beats interrupt whatever taunt is speaking; everything else is the taunt
 * clock below.
 */
const VOICE = {
  wakes: 'boss-new1',
  fury: 'boss-07',
  dies: 'boss-08',
} as const;

/**
 * Between the beats the boss taunts on a clock: one line every 5–10 s of the fight, drawn
 * from the whole pool with no immediate repeat ("make boss say line after every 5-10sec").
 * Wall-clock, deliberately: this is presentation, not a rule, and a taunt cadence tied to
 * the crank would stutter with the feed. `speak` still refuses a taunt that would land on
 * top of a beat, so the cadence yields to the fight rather than the other way round.
 */
const TAUNT_MIN_MS = 5_000;
const TAUNT_MAX_MS = 10_000;

function nextTaunt(last: VoiceName | null): VoiceName {
  const pool = VOICE_NAMES.filter((v) => v !== last);
  return pool[Math.floor(Math.random() * pool.length)] ?? VOICE_NAMES[0]!;
}

/**
 * The burst's chunks, per part: a fixed scatter, so the same kill always looks the same
 * and nothing is drawn at random per frame. Golden-angle headings, so twelve never clump.
 */
function chunkFlight(i: number): { dx: number; dy: number; r: number } {
  const a = i * 2.399963;
  const d = CHUNK_THROW[0] + ((i * 17) % (CHUNK_THROW[1] - CHUNK_THROW[0]));
  return { dx: Math.cos(a) * d, dy: Math.sin(a) * d - CHUNK_LIFT, r: CHUNK_R[0] + ((i * 5) % (CHUNK_R[1] - CHUNK_R[0])) };
}

export function Boss({ arena, boss, deathMs = DEATH_MS }: BossProps) {
  const shellRef = useRef<SVGGElement | null>(null);
  const partRefs = useRef<(SVGGElement | null)[]>([]);
  const smokeRefs = useRef<(SVGGElement | null)[]>([]);
  const deathTimers = useRef<number[]>([]);
  useEffect(() => () => {
    for (const t of deathTimers.current) window.clearTimeout(t);
  }, []);
  /** The last snapshot actually consumed. Every one-shot below is a diff against it. */
  const prev = useRef<{ parts: number[]; phase: number; vent: number; fury: boolean } | null>(null);

  // A chain fact, derived and never stored: `Boss::is_furious` on the same integers the
  // crank halves the volley on. FIGHTING-gated so a settling corpse at 0 % fight HP and a
  // mustering boss are never furious, whatever the shell reads.
  const furious = arena.phase === PHASE_FIGHTING && isFurious(boss, arena.raidSize, arena.difficulty);

  // Eleven static cells, and the smoke for the nine the chain can destroy. Built once,
  // never re-rendered: the dead state, the flinches, the bursts and the death sequence
  // are all applied imperatively to these nodes, so a 10 Hz account stream never walks
  // this subtree.
  const art = useMemo(
    () => (
      <g transform={`translate(${BOSS_ANCHOR_X} ${BOSS_ANCHOR_Y}) scale(${BOSS_SCALE})`}>
        {BOSS_PARTS.map((p) => {
          const i = p.index;
          return (
            <g
              key={p.name}
              className="hr-boss-part"
              // fill-box + an explicit origin, or a part-local scale or rotate resolves
              // against the root viewBox and flings the limb off-canvas. Measured.
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
              ref={
                i === null
                  ? undefined
                  : (el) => {
                      partRefs.current[i] = el;
                    }
              }
            >
              {/* A nested svg clips to its viewport, so the viewBox IS the crop: this
                  cell and nothing else of the atlas, at the part's own world box. */}
              <svg
                x={p.cx}
                y={p.cy}
                width={p.w}
                height={p.h}
                viewBox={`${p.ax} ${p.ay} ${p.w * ATLAS_SCALE} ${p.h * ATLAS_SCALE}`}
              >
                <image href={BOSS_ATLAS} width={ATLAS_W} height={ATLAS_H} style={{ imageRendering: 'auto' }} />
              </svg>
            </g>
          );
        })}
      </g>
    ),
    [],
  );
  const smoke = useMemo(
    () => (
      <g
        className="hr-smoke-layer"
        transform={`translate(${BOSS_ANCHOR_X} ${BOSS_ANCHOR_Y}) scale(${BOSS_SCALE})`}
        style={{ willChange: 'transform' }}
      >
        {BOSS_PARTS.map((p) => {
          const i = p.index;
          if (i === null) return null;
          const cx = p.cx + p.w / 2;
          const cy = p.cy + p.h / 2;
          return (
            <g
              key={p.name}
              className="hr-smoke"
              ref={(el) => {
                smokeRefs.current[i] = el;
              }}
            >
              {Array.from({ length: CHUNKS }, (_, k) => (
                <circle
                  key={k}
                  className="hr-smoke-chunk"
                  cx={cx}
                  cy={cy}
                  r={chunkFlight(k).r}
                  fill={`url(#hr-smoke-${k % 2})`}
                />
              ))}
              {Array.from({ length: WISPS }, (_, k) => (
                <ellipse
                  key={k}
                  className="hr-smoke-wisp"
                  cx={cx + (k - 1) * p.w * 0.18}
                  cy={cy + (k % 2 ? -1 : 1) * p.h * 0.1}
                  rx={Math.max(10, p.w * 0.3)}
                  ry={Math.max(7, p.h * 0.22)}
                  fill={`url(#hr-smoke-${k % 2})`}
                />
              ))}
            </g>
          );
        })}
      </g>
    ),
    [],
  );

  // The taunt clock runs only while the fight does. Keyed on the phase alone so a
  // notification that changes nothing else never re-arms it, and cleared on the way out so
  // a settled arena — or an unmounted room — never speaks.
  const fighting = arena.phase === PHASE_FIGHTING;
  useEffect(() => {
    if (!fighting) return;
    let last: VoiceName | null = null;
    let timer = 0;
    const arm = (): void => {
      timer = window.setTimeout(() => {
        last = nextTaunt(last);
        speak(last);
        arm();
      }, TAUNT_MIN_MS + Math.random() * (TAUNT_MAX_MS - TAUNT_MIN_MS));
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [fighting]);

  useEffect(() => {
    const now = { parts: boss.parts.slice(0, N_PARTS), phase: arena.phase, vent: boss.ventOpen, fury: furious };
    const was = prev.current;
    prev.current = now;

    const soft = reduced();
    const at = (i: number): SVGGElement | null => partRefs.current[i] ?? null;
    /** The resting state of one part: the cell shown or gone, its smoke off or lingering. */
    const rest = (i: number, dead: boolean): void => {
      at(i)?.classList.toggle('hr-dead', dead);
      smokeRefs.current[i]?.classList.toggle('is-on', dead);
    };
    /**
     * Torn off: a flash, a lurch outward, and gone. Ends where `.hr-dead` rests, so the
     * limb vanishes with no pop, and the room is already there behind it. The burst is
     * the reference's flying chunks, scattering out of the wound, doubling and fading.
     * No `fill: 'forwards'` on the chunks: they end where their own rule rests
     * (`opacity: 0`, styles.css), and a held fill is twelve Animation objects a kill,
     * kept for the life of the tab because nothing here ever cancels a chunk. Under
     * reduced motion the wisps alone say it, at rest.
     */
    const tear = (i: number): void => {
      const el = at(i);
      if (el === null) return;
      const [ox, oy] = OUTWARD[i] ?? [0, -1];
      play('partBreak');
      rest(i, true);
      el.animate(
        [
          { transform: 'none', opacity: 1, filter: 'brightness(3)' },
          soft
            ? { transform: 'none', opacity: 0, filter: 'brightness(3)' }
            : {
                transform: `translate(${ox * BREAK_PX}px, ${oy * BREAK_PX}px) rotate(${ox * 9}deg)`,
                opacity: 0,
                filter: 'brightness(1)',
              },
        ],
        { duration: BREAK_MS, easing: 'ease-in' },
      );
      if (soft) return;
      const chunks = smokeRefs.current[i]?.querySelectorAll<SVGCircleElement>('.hr-smoke-chunk') ?? [];
      chunks.forEach((c, k) => {
        const { dx, dy } = chunkFlight(k);
        c.animate(
          [
            { transform: 'translate(0px, 0px) scale(1)', opacity: 0.95 },
            { transform: `translate(${dx}px, ${dy}px) scale(2)`, opacity: 0 },
          ],
          { duration: BURST_MS, easing: 'cubic-bezier(0.1, 0.8, 0.3, 1)' },
        );
      });
    };

    // First snapshot: adopt the resting appearance, play nothing. A page loaded onto a
    // half-stripped boss must show a half-stripped boss, not nine bursts of smoke.
    if (was === null) {
      for (let i = 0; i < N_PARTS; i++) rest(i, now.parts[i] === 0);
      return;
    }

    for (let i = 0; i < N_PARTS; i++) {
      const before = was.parts[i] ?? 0;
      const after = now.parts[i] ?? 0;
      // The duplicate-proof line: an unchanged value is not an event. A byte-identical
      // payload — which is what a doubled delivery is — reaches here and does nothing.
      if (after === before) continue;
      const el = at(i);
      if (el === null) continue;
      const [ox, oy] = OUTWARD[i] ?? [0, -1];

      if (after > before) {
        // A new incarnation refilled the shell. The cell comes back, the smoke clears,
        // and a death still tearing limbs off stops where it is.
        for (const t of deathTimers.current) window.clearTimeout(t);
        deathTimers.current = [];
        rest(i, false);
        for (const a of el.getAnimations()) a.cancel();
        continue;
      }

      if (after === 0) {
        tear(i);
        continue;
      }

      // Damage. Fire-and-forget: no rAF, no state, no re-render, and it stacks rather than
      // fighting another writer for one `style.transform`.
      el.animate(
        [
          { offset: 0, transform: 'none', filter: 'none' },
          soft
            ? { offset: 0.15, transform: 'none', filter: 'brightness(2.2)' }
            : {
                offset: 0.15,
                transform: `translate(${ox * FLINCH_PX}px, ${oy * FLINCH_PX}px)`,
                filter: 'brightness(2.2)',
              },
          { offset: 1, transform: 'none', filter: 'none' },
        ],
        { duration: FLINCH_MS, easing: 'ease-out' },
      );
    }

    // The vent opening is one edge of one byte; the ring's own transition is the visual.
    if (was.vent !== VENT_OPEN && now.vent === VENT_OPEN) {
      play('ventOpen');
    }
    // Fury is the same shape: one edge of one derived bit, the class is the visual and
    // the roar is the one-shot. A reload onto a furious boss lands on the first-snapshot
    // return above and shows the aura without the roar.
    if (!was.fury && now.fury) {
      play('fury');
      speak(VOICE.fury, true);
    }
    // The boss speaks on the tick it wakes — MUSTERING → FIGHTING is the crank's flip and
    // the one edge every raider sees at the same time — and on the tick the fight ends
    // with its core gone. A wipe or an enrage ends the fight through the same phase
    // change; the death line is only for the raid that actually killed it.
    if (was.phase === PHASE_MUSTERING && now.phase === PHASE_FIGHTING) speak(VOICE.wakes, true);
    // `arena.outcome`, not `boss.coreHp`: the kill lands as two notifications, and when
    // the arena's arrives first the boss in hand still has the core it had a tick ago.
    // The outcome byte is written with the phase, in the same payload as the edge.
    const killed = arena.outcome === OUTCOME_WIN;
    if (was.phase === PHASE_FIGHTING && now.phase === PHASE_SETTLING && killed) {
      speak(VOICE.dies, true);
    }

    const shell = shellRef.current;
    if (shell === null) return;

    // Death. One edge, one call. `SETTLING` is reached from `FIGHTING` and from nowhere
    // else, so the phase pair is the whole guard — a duplicate carries the same pair and
    // fires nothing. The creature burns out IN PLACE: a corpse that stays is the read
    // that the raid won, and the dead parts' smoke keeps drifting over it.
    if (was.phase === PHASE_FIGHTING && now.phase === PHASE_SETTLING) {
      shell.animate([{ filter: 'brightness(3)' }, { filter: CHARRED }], {
        duration: deathMs,
        easing: 'ease-in',
        fill: 'forwards',
      });
      // A kill, not a wipe or a clock-out (the core is what says so): the limbs still on
      // the shell tear off one after another while it chars, each with its own burst
      // and its own smoke, and the torso is what remains — a charred core in a column
      // of wisps. The result card waits for this (`Hud.tsx`, REVEAL_WIN_MS).
      if (killed) {
        let k = 0;
        for (let i = 0; i < N_PARTS; i++) {
          if (i === TORSO_INDEX || (now.parts[i] ?? 0) === 0) continue;
          deathTimers.current.push(window.setTimeout(() => tear(i), DEATH_STAGGER_MS * k++));
        }
      }
    }

    // Back to the lobby: the next incarnation reforms. Release everything the death
    // sequence is holding, on the shell, the limbs and their smoke.
    if (was.phase !== PHASE_LOBBY && now.phase === PHASE_LOBBY) {
      for (const a of shell.getAnimations()) a.cancel();
      for (let i = 0; i < N_PARTS; i++) {
        const el = at(i);
        if (el === null) continue;
        rest(i, false);
        for (const a of el.getAnimations()) a.cancel();
      }
    }
  });

  // The shell fraction the cosmetic layer reads. `partsMax` is the incarnation's own
  // ceiling, so this stays 1..0 however the boss is scaled up.
  let live = 0;
  let full = 0;
  for (let i = 0; i < N_PARTS; i++) {
    live += boss.parts[i] ?? 0;
    full += boss.partsMax[i] ?? 0;
  }
  const shell = full > 0 ? live / full : 0;
  // A chain fact, read and never timed client-side. `enrageAtTick` is 0 until the fight
  // actually begins, so the zero test is what stops an enrage read during the muster.
  const enraged = arena.enrageAtTick !== 0 && arena.tick >= arena.enrageAtTick;

  return (
    <g
      className={`hr-boss${boss.ventOpen === VENT_OPEN ? ' hr-vent-open' : ''}${enraged ? ' hr-enraged' : ''}${furious ? ' hr-fury' : ''}`}
      style={{ '--shell': shell } as React.CSSProperties}
      transform={`translate(${boss.x} ${boss.y})`}
    >
      <style>{CSS}</style>
      <defs>
        {/* The aura: ember at the core, gone by the edge. The smoke: two purples, soft-edged
            by the gradient itself so no chunk or wisp ever needs a blur filter. */}
        <radialGradient id="hr-aura-grad">
          <stop offset="0" stopColor="var(--ember, #ff5a4a)" stopOpacity={0.55} />
          <stop offset="0.6" stopColor="var(--ember, #ff5a4a)" stopOpacity={0.18} />
          <stop offset="1" stopColor="var(--ember, #ff5a4a)" stopOpacity={0} />
        </radialGradient>
        {SMOKE_INK.map((ink, k) => (
          <radialGradient key={ink} id={`hr-smoke-${k}`}>
            <stop offset="0" stopColor={ink} stopOpacity={0.95} />
            <stop offset="0.6" stopColor={ink} stopOpacity={0.75} />
            <stop offset="1" stopColor={ink} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      <g className="hr-boss-breathe">
        <g ref={shellRef} className="hr-boss-shell">
          <ellipse className="hr-boss-aura" cx={AURA.cx} cy={AURA.cy} rx={AURA.rx} ry={AURA.ry} fill="url(#hr-aura-grad)" />
          {art}
          {/* The vent ring, at exactly the circle the chain raycasts. A literal here would
              make the drawn vent and the hit vent two different circles. Its two states
              live in the CSS above, never in attributes here; `--core-r` is published
              rather than typed so the ring width can be a ratio of the radius the chain
              owns. */}
          <circle
            className="hr-boss-vent"
            style={{ '--core-r': CORE_R } as React.CSSProperties}
            cx={CORE.x}
            cy={CORE.y}
            r={CORE_R}
          />
          {EYES.map(([x, y]) => (
            <circle key={x} className="hr-boss-eye" cx={x} cy={y} r={EYE_R} />
          ))}
        </g>
      </g>
      {/* Beside the breathe group, not inside it: the corpse's charring filter never
          touches it, and it does not breathe with the body it left. */}
      {smoke}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Boot check
//
// Every failure here is silent and catastrophic on screen: a cell outside the atlas draws
// nothing and throws nothing; a part whose index moved breaks the WRONG limb off; a drawn
// box that is not its chain box is an arrow stopping on bare stone while the chain scores
// the damage. `boss.gen.ts` and `hitboxes.ts` are two emissions of one JSON, and this is
// where a stale one of them is caught — at import, not three layers down.
// ---------------------------------------------------------------------------

{
  const seen = new Set<number>();
  for (const p of BOSS_PARTS) {
    if (p.cx < 0 || p.cy < 0 || p.cx + p.w > BOSS_SPRITE_W || p.cy + p.h > BOSS_SPRITE_H) {
      throw new Error(`Boss: "${p.name}" lies outside the ${BOSS_SPRITE_W}x${BOSS_SPRITE_H} sprite canvas`);
    }
    if (p.ax + p.w * ATLAS_SCALE > ATLAS_W || p.ay + p.h * ATLAS_SCALE > ATLAS_H) {
      throw new Error(`Boss: "${p.name}" reaches outside the ${ATLAS_W}x${ATLAS_H} atlas`);
    }
    if (p.index === null) continue;
    if (seen.has(p.index)) throw new Error(`Boss: two parts claim Boss.parts[${p.index}]`);
    seen.add(p.index);
    const r = PART_HITBOXES[p.index];
    if (
      r === undefined ||
      r.x !== p.cx * BOSS_SCALE + BOSS_ANCHOR_X ||
      r.y !== p.cy * BOSS_SCALE + BOSS_ANCHOR_Y ||
      r.w !== p.w * BOSS_SCALE ||
      r.h !== p.h * BOSS_SCALE
    ) {
      throw new Error(`Boss: "${p.name}" is drawn where the chain does not hit it — re-run tools/gen_boss.py and tools/gen_hitboxes.py`);
    }
  }
  if (seen.size !== N_PARTS) throw new Error(`Boss: the atlas rigs ${seen.size} parts, N_PARTS is ${N_PARTS}`);
  // The vent ring is a ratio of the chain's own radius. A retune that took `CORE.radiusSq`
  // to 0 would silently delete the open-vent read rather than move it.
  if (!(CORE_R > 0)) throw new Error(`Boss: CORE.radiusSq is ${CORE.radiusSq}; the vent has no radius to ring`);
  if (OUTWARD.length !== N_PARTS) throw new Error('Boss: OUTWARD must cover every part');
  for (const [x, y] of OUTWARD) {
    if (Math.abs(Math.hypot(x, y) - 1) > 0.001) throw new Error(`Boss: [${x},${y}] is not a unit heading`);
  }
}
