/**
 * The boss — the painting's own demon, rigged per part, index-aligned with the chain.
 *
 * The creature is cut out of the arena painting by `tools/gen_boss.py` into one RGBA
 * atlas (`assets/sprites/boss_parts.png`), one tight cell per part, and placed back at
 * exactly the crop it came from: `BOSS_SPAWN + BOSS_ANCHOR` is the crop's top-left, so on
 * a full shell the rig is pixel-identical to the room beneath it and invisible as a rig.
 * That is the whole reason it exists — a limb can flinch, break off and char while the
 * room stays a flat image.
 *
 * Every cell is drawn through a nested `<svg viewBox={atlas cell}>` sized to the part's
 * world box: a crop without a `clipPath`, eleven `<image>`s of one URL, one decoded bitmap.
 * `BOSS_PARTS[i].index` is the `Boss.parts` slot, emitted by the same tool that emits
 * `hitboxes.json` — the file `gen_hitboxes.py` compiles `PART_HITBOXES` from — and the boot
 * check at the bottom proves each drawn box IS its chain box, unit for unit.
 *
 * THE TWO SYSTEMS, deliberately separate:
 *
 *   cosmetic   breathing, eye glow, the open vent's breathe, the fury glow. Pure CSS
 *              keyframes on nodes React does not write. They run composited at 60 fps and
 *              NEVER stall waiting for a notification — the boss keeps breathing through a
 *              dead socket.
 *   derived    dead parts, vent state, fury, enrage, death. Read from the snapshot. The
 *              resting appearance is an attribute (so a reload with no animation is still
 *              correct) and the one-shots are `Element.animate()` calls fired on a VALUE
 *              DIFF against the previous snapshot.
 *
 * The diff is what survives the feed: 68.4% of notifications during a fight carry no
 * change and the Magic Router delivers every one of them twice. A duplicate diffs to
 * nothing, so nothing fires — idempotence by construction, with no latch registry, no
 * debounce timer and nothing counting notifications.
 *
 * THE PAINT NEVER PEEKS. The room under the rig carries the same demon, so anything that
 * exposes it reads as a ghost: a dead part is OPAQUE and charred, never faded; the breathe
 * scales from 1 upward and never below it; death chars the whole creature in place rather
 * than fading or scattering it. The flinch and the break-off do move a limb for a few
 * hundred ms, and that transient sliver of paint is accepted.
 *
 * NODE STACK, one writer each (two writers on one transform means one of them is silently
 * discarded — measured):
 *
 *     <g .hr-boss>          translate(boss.x, boss.y), `--shell`, state classes  <- React
 *       <g .hr-boss-breathe>                                        <- CSS keyframes only
 *         <g .hr-boss-shell>    <- WAAPI `filter` for the death sequence; CSS `filter`
 *                                  keyframes for the fury glow. Never both: fury is a
 *                                  FIGHTING-only class and death starts on SETTLING.
 *           <g> translate(anchor) scale(BOSS_SCALE)   <- static, memoised, built once
 *             11 part groups                          <- WAAPI one-shots + .hr-dead
 *           .hr-boss-vent            the open vent's ring, over the painted orb. CSS only
 *           .hr-boss-eye x2                                          <- CSS keyframes only
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
} from '@heartrot/client';

import { ATLAS_H, ATLAS_SCALE, ATLAS_W, BOSS_ATLAS, BOSS_PARTS, EYES_PX } from './boss.gen';
import { play, speak } from './sfx';

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
 * Cosmetic durations, in ms. The first two match no game duration — there is no chain beat
 * for a flinch — so they are typed, and neither may ever reach the chain.
 *
 * The death sequence is the exception and is now derived: `PHASE_SETTLING` has no bounded
 * on-chain length (it ends when `settle` is called, not on a timer), so the honest bound
 * is the fight's own slowest beat, one volley period. Mirrored from
 * `tick.rs::VOLLEY_INTERVAL_TICKS` through `@heartrot/client` rather than typed, so it
 * still matches the volley the first time anyone tunes balance. `deathMs` stays a prop.
 */
const FLINCH_MS = 180;
const BREAK_MS = 520;
const DEATH_MS = VOLLEY_INTERVAL_MS;

/** Sprite pixels a limb moves. One is `BOSS_SCALE` arena units inside the scaled group. */
const FLINCH_PX = 2;
const BREAK_PX = 7;

/**
 * A destroyed limb: opaque, drained and dark. Opaque is the load-bearing word — at any
 * opacity under 1 the room's own painted limb shows through the kill. One string, used by
 * the resting class, the break-off's end frame and the death sequence, so the three
 * cannot disagree about what dead looks like.
 */
const CHARRED = 'grayscale(1) brightness(0.25)';

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
// and with no JS in the loop.
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
/* Never below 1: the rig grows over the painted demon and shrinks back onto it, so the
   paint underneath never peeks out around a breath. */
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

/* Fury: a red glow on the whole creature's silhouette, pulsing at the furious volley's
   own beat (1.6 s). On .hr-boss-shell, not .hr-boss, so it sits UNDER the breathe scale
   and inside the arena clip like the rest of the rig. A drop-shadow on the full rig
   re-rasterises every frame — the vent's old 26 px glow paid the same cost and this one
   replaces it rather than adding to it. The resting rule is what reduced motion keeps. */
.hr-fury .hr-boss-shell {
  filter: drop-shadow(0 0 14px var(--ember, #ff5a4a));
  animation: hr-fury-glow 1.6s ease-in-out infinite;
}
@keyframes hr-fury-glow {
  0%, 100% { filter: drop-shadow(0 0 10px var(--ember, #ff5a4a)); }
  50%      { filter: drop-shadow(0 0 22px var(--ember, #ff5a4a)); }
}

/* A destroyed limb stays on the creature, dark and drained — and OPAQUE, because the room
   under it still carries the living limb. Removing it outright, or fading it, loses the
   read the whole rig is for: which gun you killed. */
.hr-boss-part.hr-dead { opacity: 1; filter: ${CHARRED}; }

/* The vent. Sealed, it draws NOTHING: the painting's own orb is the sealed look, and any
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
  .hr-boss-breathe, .hr-boss-eye, .hr-vent-open .hr-boss-vent, .hr-fury .hr-boss-shell { animation: none; }
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
 * `speak` refuses a line while another is still speaking, so a limb break landing on the
 * same tick as the vent opening plays one line, not two over each other. The limb line is
 * also held to one per `TAUNT_GAP_MS`: nine limbs breaking in a solo fight is nine
 * chances to speak, and a boss that talks on every one is a boss nobody listens to.
 */
const VOICE = {
  wakes: 'boss-new1',
  limb: 'boss-02',
  vent: 'boss-04',
  fury: 'boss-07',
  dies: 'boss-08',
} as const;
const TAUNT_GAP_MS = 12_000;
let lastTauntAt = -Infinity;

export function Boss({ arena, boss, deathMs = DEATH_MS }: BossProps) {
  const shellRef = useRef<SVGGElement | null>(null);
  const partRefs = useRef<(SVGGElement | null)[]>([]);
  /** The last snapshot actually consumed. Every one-shot below is a diff against it. */
  const prev = useRef<{ parts: number[]; phase: number; vent: number; fury: boolean } | null>(null);

  // A chain fact, derived and never stored: `Boss::is_furious` on the same integers the
  // crank halves the volley on. FIGHTING-gated so a settling corpse at 0 % fight HP and a
  // mustering boss are never furious, whatever the shell reads.
  const furious = arena.phase === PHASE_FIGHTING && isFurious(boss, arena.raidSize);

  // Eleven static cells. Built once, never re-rendered: the dead state, the flinches and
  // the death sequence are all applied imperatively to these nodes, so a 10 Hz account
  // stream never walks this subtree.
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

  useEffect(() => {
    const now = { parts: boss.parts.slice(0, N_PARTS), phase: arena.phase, vent: boss.ventOpen, fury: furious };
    const was = prev.current;
    prev.current = now;

    const soft = reduced();
    const at = (i: number): SVGGElement | null => partRefs.current[i] ?? null;

    // First snapshot: adopt the resting appearance, play nothing. A page loaded onto a
    // half-stripped boss must show a half-stripped boss, not nine break-off animations.
    if (was === null) {
      for (let i = 0; i < N_PARTS; i++) at(i)?.classList.toggle('hr-dead', now.parts[i] === 0);
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
        // A new incarnation refilled the shell. Drop the death sequence's held state.
        el.classList.remove('hr-dead');
        for (const a of el.getAnimations()) a.cancel();
        continue;
      }

      if (after === 0) {
        play('partBreak');
        if (performance.now() - lastTauntAt >= TAUNT_GAP_MS) {
          lastTauntAt = performance.now();
          speak(VOICE.limb);
        }
        el.classList.add('hr-dead');
        // Ends where `.hr-dead` rests, so the limb lands charred with no pop.
        el.animate(
          [
            { transform: 'none', opacity: 1, filter: 'brightness(3)' },
            soft
              ? { transform: 'none', opacity: 1, filter: CHARRED }
              : {
                  transform: `translate(${ox * BREAK_PX}px, ${oy * BREAK_PX}px) rotate(${ox * 9}deg)`,
                  opacity: 1,
                  filter: CHARRED,
                },
          ],
          { duration: BREAK_MS, easing: 'ease-in' },
        );
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
      speak(VOICE.vent);
    }
    // Fury is the same shape: one edge of one derived bit, the class is the visual and
    // the roar is the one-shot. A reload onto a furious boss lands on the first-snapshot
    // return above and shows the glow without the roar.
    if (!was.fury && now.fury) {
      play('fury');
      speak(VOICE.fury);
    }
    // The boss speaks on the tick it wakes — MUSTERING → FIGHTING is the crank's flip and
    // the one edge every raider sees at the same time — and on the tick the fight ends
    // with its core gone. A wipe or an enrage ends the fight through the same phase
    // change; the death line is only for the raid that actually killed it.
    if (was.phase === PHASE_MUSTERING && now.phase === PHASE_FIGHTING) speak(VOICE.wakes);
    if (was.phase === PHASE_FIGHTING && now.phase === PHASE_SETTLING && boss.coreHp === 0) {
      speak(VOICE.dies);
    }

    const shell = shellRef.current;
    if (shell === null) return;

    // Death. One edge, one call. `SETTLING` is reached from `FIGHTING` and from nowhere
    // else, so the phase pair is the whole guard — a duplicate carries the same pair and
    // fires nothing. The creature burns out IN PLACE: it never fades and never scatters,
    // because either would expose the living demon painted under it.
    if (was.phase === PHASE_FIGHTING && now.phase === PHASE_SETTLING) {
      shell.animate([{ filter: 'brightness(3)' }, { filter: CHARRED }], {
        duration: deathMs,
        easing: 'ease-in',
        fill: 'forwards',
      });
    }

    // Back to the lobby: the next incarnation reforms. Release everything the death
    // sequence is holding, on both the shell and the limbs.
    if (was.phase !== PHASE_LOBBY && now.phase === PHASE_LOBBY) {
      for (const a of shell.getAnimations()) a.cancel();
      for (let i = 0; i < N_PARTS; i++) {
        const el = at(i);
        if (el === null) continue;
        el.classList.remove('hr-dead');
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
      <g className="hr-boss-breathe">
        <g ref={shellRef} className="hr-boss-shell">
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
