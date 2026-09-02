/**
 * The boss — the real art, rigged per part, index-aligned with the chain.
 *
 * `assets/sprites/parts/boss.svg` is the only boss asset with thirteen named
 * `<g id="part-*">` groups; `boss.svg` is one path per colour and cannot be rigged. It is
 * inlined here as raw text and split into its groups ONCE at module load, so React never
 * parses, walks or re-renders 32,105 painted pixels of static geometry again.
 *
 * Name → `Boss.parts[i]` comes from `assets/sprites/hitboxes.json`'s own `part_index`
 * array — the same file `tools/gen_hitboxes.py` compiles `PART_HITBOXES` out of. Typing
 * that order out again here would be this project's signature defect (one fact stored
 * twice) in the exact place the generator exists to prevent it: a renumbering would then
 * break the wrong limb off, on screen, with no error anywhere.
 *
 * THE TWO SYSTEMS, deliberately separate:
 *
 *   cosmetic   breathing, eye glow, the open vent's pulse. Pure CSS keyframes on nodes
 *              React does not write. They run composited at 60 fps and NEVER stall waiting
 *              for a notification — the boss keeps breathing through a dead socket.
 *   derived    dead parts, vent state, enrage, death. Read from the snapshot. The resting
 *              appearance is an attribute (so a reload with no animation is still correct)
 *              and the one-shots are `Element.animate()` calls fired on a VALUE DIFF
 *              against the previous snapshot.
 *
 * The diff is what survives the feed: 68.4% of notifications during a fight carry no
 * change and the Magic Router delivers every one of them twice. A duplicate diffs to
 * nothing, so nothing fires — idempotence by construction, with no latch registry, no
 * debounce timer and nothing counting notifications.
 *
 * NODE STACK, one writer each (two writers on one transform means one of them is silently
 * discarded — measured):
 *
 *     <g .hr-boss>          translate(boss.x, boss.y), `--shell`, state classes  <- React
 *       <g .hr-boss-breathe>                                        <- CSS keyframes only
 *         <g .hr-boss-shell>                          <- WAAPI, the death sequence only
 *           <g .hr-boss-grade>       BOSS_GRADE + the rim light. No transform, on purpose
 *             <g> translate(anchor) scale(BOSS_SCALE) <- static, memoised, built once
 *               11 part groups                        <- WAAPI one-shots only
 *           spill circle             the orb's light, OVER the grade so it is not tinted
 *           .hr-boss-vent            the orb itself, over its own spill. CSS states only
 *           .hr-boss-eye x2                                          <- CSS keyframes only
 *
 * The three light nodes are siblings of the graded group and never inside it: the grade
 * exists to darken the creature, and light added under it would be darkened with it.
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
  PHASE_LOBBY,
  PHASE_SETTLING,
  VENT_OPEN,
  VOLLEY_INTERVAL_MS,
  type ArenaAccount,
  type BossAccount,
} from '@heartrot/client';

import HITBOXES from '../../../assets/sprites/hitboxes.json';
import BOSS_SVG from '../../../assets/sprites/parts/boss.svg?raw';

// ---------------------------------------------------------------------------
// The art, parsed once
// ---------------------------------------------------------------------------

/** `<g id="part-NAME">inner</g>`, in file order — which is paint order, back to front. */
const PART_SRC: readonly { readonly name: string; readonly inner: string }[] = Array.from(
  BOSS_SVG.matchAll(/<g id="part-([a-z0-9_]+)">([\s\S]*?)<\/g>/g),
  (m) => ({ name: m[1] ?? '', inner: m[2] ?? '' }),
);

/** Name → `Boss.parts` index, straight from the generator's own input. */
const PART_INDEX = new Map<string, number>(
  HITBOXES.part_index.map((n, i): [string, number] => [n, i]),
);

/**
 * Drawn scenery the composition cannot carry. Both are `index: null` in
 * `hitboxes.json` — nothing raycasts either, so hiding them moves no hitbox and changes no
 * damage. Nothing indexed may ever be added here: hiding art the chain still resolves hits
 * against re-creates the "drawn boss ≠ raycast boss" defect `gen_hitboxes.py` exists to
 * prevent, and players would shoot at a limb that is not on screen.
 *
 *   ground  9,844 px of `#2c3436` spanning the full canvas width — a solid dark rectangle
 *           across the pit. Scenery from the original illustration, not anatomy.
 *   legs    world x 437..788, y 436..608. With `mace` (x 170..503) and `claws` (677..833)
 *           it made the creature cover 33.8% of walkable pit floor at mean sRGB L 133
 *           against a floor at L 53, contiguously 67% of pit width. The reference pit is a
 *           dark hole with only the hands entering at the rim; the legs are the part that
 *           painted the floor the raiders stand on. `mace` and `claws` ARE indexed and stay
 *           drawn — they are clipped at the rim instead (`#heartrot-boss-clip`).
 */
const HIDDEN = new Set(['ground', 'legs']);

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
 * The eye pair: the sprite's only near-white pixels, two 2x2 blocks at (137,81) and
 * (144,81) — 8 px in a 62,100 px canvas, far too small to read as eyes once the creature
 * fills the top of the arena. They are drawn as glow circles at the same coordinates,
 * converted through the generated anchor and scale rather than through a copied number.
 */
const EYE_R = 2.5 * BOSS_SCALE;
const EYES: readonly (readonly [number, number])[] = (
  [
    [138, 82],
    [145, 82],
  ] as const
).map(([sx, sy]): readonly [number, number] => [
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
 * Cosmetic ratios of the generated `CORE_R`. Like `FLINCH_PX` above they match no chain
 * fact, so they are typed here — but they are ratios and never lengths, because `CORE_R`
 * is derived from `CORE.radiusSq` and a literal would go stale the moment the chain retunes
 * the vent. `RING_RATIO` is the stroke width; `SPILL_R` is how far the orb's own light
 * carries. At `CORE_R` 60 that is a 9-unit ring and a 312-unit pool across a 576-unit
 * creature — roughly the chest and the inner arms, which is where reference B's teal lands.
 */
const RING_RATIO = 0.15;
const SPILL_R = 2.6;

/**
 * The creature's grade, and the rim light painted back over it.
 *
 * Ungraded, the boss is the brightest, warmest and most saturated object in a cavern that
 * is graded to ~210° blue and tops out at sRGB L 68.7: its dominant fills are `#c9aab0`,
 * `#af8c92`, `#936975` and `#753757` — warm pale mauve, a pastel sticker on a cold cave. In
 * the reference the demon is DARK and rim-lit. Dark it already was; lit it was not.
 *
 * WHAT THE REFERENCE ACTUALLY SETS IS A RATIO, NOT A LEVEL. Reference B's creature sits at
 * **0.58× the luminance of its own floor** — one of the darkest masses in the picture,
 * rim-lit, with the orb and the eyes the only bright things on it. Two rounds missed that
 * from opposite sides, and both were caught by the same raster (`scripts/spike/looksright`,
 * which mounts the real `App.tsx`, so the numbers are the shipped frame and not a model;
 * `docs/art/shipped/README.md` §4 is the run that named the inversion).
 *
 * `brightness(b)` is `c ↦ b·c` — a straight multiply, so it maps the creature's tonal
 * distribution onto a scaled copy of itself. The first chain ended in `brightness(0.32)` and
 * every percentile of the body landed on the same ~0.13 factor: a 2.5× p50→p99 spread
 * against the reference's 15×, and 8.5 % of the body clearing 1.5:1 against the cavern.
 * Dark, and dead. `brightness(0.55) contrast(1.6)` then opened the range by LIFTING it —
 * measured on the shipped frame, body p50 0.0564 relative luminance against a floor at
 * 0.0159, i.e. **3.5× brighter than the floor it stands on** where the reference is 0.58×.
 * Same defect, mirrored: a bright body with a short tail instead of a dark one.
 *
 * `contrast` is the only term here that darkens the bulk WITHOUT flattening the tail:
 * `c ↦ k·c + (1−k)/2` clips the darks toward black while the top of the range survives. It
 * goes AFTER `brightness` — the pair is `c ↦ k·b·c + (1−k)/2` and swapping them moves the
 * black point. At `brightness(0.45) contrast(2.0)` the same raster reads (n = 2 browser
 * launches, agreeing to two figures; body mask = the arena plate minus a boss-hidden plate,
 * the orb and its spill disc excluded so the creature is not measured against its own lamp):
 *
 *                        p5      p50      p90      p99    spread   body/floor
 *     this chain      0.0000   0.0082   0.0731   0.1233    15.0×      0.57×
 *     reference B     0.0031   0.0127   0.0634   0.1909    15.1×      0.58×
 *     old chain       0.0001   0.0564   0.1231   0.1984     3.5×      3.54×
 *
 * `saturate(0.5)` and `hue-rotate(195deg)` are unchanged, and re-checked rather than
 * re-argued: the graded body measures HSV saturation p50 0.33 against the reference
 * creature's 0.44 — already under it, so pulling chroma further buys nothing.
 *
 * The `brightness(2.2)` hit flash below is applied INSIDE this group, so it composes with
 * this chain. Re-derived: a dominant fill clips to white under the flash and then grades to
 * relative luminance 0.129 — **15.8× the resting body's 0.0082**, where the old chain gave
 * 5.1×. A darker body makes the flash read harder, not softer; nothing about it needs
 * retuning.
 *
 * THE RIM IS NOT THE LIGHT, and this is why it stays a one-line term. It draws the same
 * silhouette offset 3 units up-left, flooded cyan at 0.30, behind. Measured, thickening it
 * from 2 units @ α 0.25 to 3 @ 0.30 takes the exposed band 0.88 → 1.40 px and 1.50:1 →
 * 1.75:1 against the cavern — but isolating it moves the 1.5:1 ladder step by 0.005. The
 * reference's own lit edge is 2 px at 1.54:1: nobody's rim is doing this work. It is free
 * and it is kept, and the light itself comes from the orb (`.hr-boss-vent`) and its spill.
 * It is last in the chain on purpose, so the grade cannot touch the light it adds — which is
 * also why it SURVIVES the darker body above instead of being crushed with it. Measured by
 * shooting the same frame with the term deleted: 150,918 px move, and that band reads Y
 * 0.0215 with the rim against 0.0130 without, over a cavern at 0.0184.
 *
 * The grade is on the WRAPPER, not on the art group: filters are applied in the element's
 * own coordinate system, and the art group carries `scale(BOSS_SCALE)`, which would make
 * this 3 into 9 arena units. The wrapper has no transform, so a unit here is an arena unit.
 *
 * Core, spill and eyes are siblings of the graded group, never inside it — after this they
 * are the only warm, bright things in the frame, which is the whole point. Confirmed on the
 * same raster: the brightest pixels anywhere in the creature's mask are the orb's own glow
 * (cyan, ≈ rgb(131 217 227)) sitting just outside the excluded spill disc, not body art.
 *
 * WHAT THIS CHAIN CANNOT FIX, so nobody tries it here: the creature is 47.9 % of stage width
 * against the reference's 22.3 %, which is what hides the tiered floor rings. Drawn extent
 * IS hittable extent — `BOSS_SCALE`, `BOSS_ANCHOR_*`, `PART_HITBOXES`, `CORE` and `MUZZLES`
 * are all emitted by `tools/gen_hitboxes.py --scale` into `hitboxes.rs` AND `hitboxes.ts`,
 * and the program raycasts against them. Shrinking the drawing from this file would make
 * players shoot at a limb that is not where it is drawn. Narrowing the silhouette is a
 * generator re-run plus a same-commit program+client deploy, not a render change.
 */
const BOSS_GRADE =
  'grayscale(0.7) sepia(0.6) hue-rotate(195deg) saturate(0.5) brightness(0.45) ' +
  'contrast(2.0) drop-shadow(-3px -3px 0 rgb(159 232 255 / 0.30))';

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
.hr-enraged .hr-boss-breathe {
  animation-duration: calc(1.7s * (0.5 + var(--shell, 1) * 0.5));
}
@keyframes hr-boss-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.014); } }

.hr-boss-eye {
  fill: color-mix(in srgb, #ff5c4a calc((1 - var(--shell, 1)) * 100%), #9fe8ff);
  transform-box: fill-box;
  transform-origin: center;
  animation: hr-boss-eye 1.9s ease-in-out infinite;
}
.hr-boss-eye:nth-of-type(2) { animation-delay: -0.35s; }
.hr-enraged .hr-boss-eye { fill: #ff3a2a; }
@keyframes hr-boss-eye {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.25); }
}

/* A destroyed limb stays on the creature, dark and drained. Removing it outright loses
   the read the whole rig is for: which gun you killed. */
.hr-boss-part.hr-dead { opacity: 0.34; filter: grayscale(1) brightness(0.45); }

/* The grade and the rim light. One node, one filter, and it wraps the memoised art rather
   than duplicating it: art.md's <use href="#art"> silhouette would rasterise 32,105 px
   of geometry a second time AND go stale, because a <use> shadow tree mirrors attributes
   but NOT Element.animate() — every flinch, every break-off and the whole death sequence
   are WAAPI, so the rim would sit still at 0.30 alpha while the limb it outlines flies out
   of frame. A drop-shadow is the same image (offset silhouette, flat colour, behind) and
   is part of the element being animated, so it cannot desynchronise.

   AND IT STAYS ON THE ANCESTOR, but not for the reason people assume. A filter here IS a
   rasterisation boundary around the eleven part groups that take every WAAPI one-shot, so
   it was measured rather than argued: 6x CPU throttle, fresh Chrome per case, 400 frames,
   n=8 (scripts/spike/framebudget/gradeperf_boss.json) gives none 1.90/3.20 ms p50/p95,
   ancestor 2.00/3.30, per-part 2.05/3.30. The grade costs +0.10 ms at both percentiles
   against a run-to-run spread of +/-1.5 ms — inside noise, and per-part is not cheaper.
   That is a negative result and it is the answer: do not move the grade for performance.

   The reason it MUST stay is the cascade. A WAAPI filter keyframe REPLACES a CSS
   filter on the same node for the animation's whole duration (waapi.mjs: mid-animation
   the computed style reads brightness(1.09999) and the CSS filter is simply gone). A
   per-part grade would therefore blink off for 180 ms on every flinch, 520 ms on every
   break-off, and permanently on every .hr-dead limb. Restating the grade inside all three
   is one fact stored four times, in the one place a renumbering has already broken a limb. */
.hr-boss-grade { filter: ${BOSS_GRADE}; }

/* The orb — a WELL RINGED BY A LIGHT, and it burns from the first frame.

   It used to be a flat filled disc at opacity 0.35: measured, mean rgb(34,66,79) = L255
   12.7 against the body immediately around it at 10.3, i.e. 1.17:1. The brief called it
   "a hole, not a coal" and the raster agrees. Profiling reference B's own orb radially
   says the opposite shape: r 0-22 is a NEAR-BLACK well at L255 0.8-4.4 — darker than the
   wall behind the creature — ringed at r 24-34 by a band peaking at L255 113, decayed back
   to body level by r ~40. Outer ring radius 34 on a 289 px creature is 0.118x its width;
   this circle is r 60 on a 576 px creature, 0.104x. The geometry was already right. Only
   the paint was wrong: it wants a dark fill and a bright ring, and it had a mid fill and a
   3-unit hairline.

   Sealed is a LIT coal, not a dim one. The reference's orb burns identically whether or not
   anything has hit it, and the vent's state is carried by the ring going white-hot and
   starting to pulse — a stronger read than an opacity step, and one that survives
   reduced-motion, where the pulse is gated below but the white-hot ring is not.

   Lengths: the vent is a direct child of .hr-boss-shell, which carries no scale, so the
   blur radii here are arena units. Width is a ratio of the generated --core-r published
   by the element, never a literal — a stroke is centred on its path, so a thick ring's
   midline is still the exact circle the chain raycasts. */
.hr-boss-vent {
  transform-box: fill-box;
  transform-origin: center;
  fill: #04121a;
  fill-opacity: 1;
  stroke: var(--cyan, #6fe3ff);
  stroke-opacity: 0.75;
  stroke-width: calc(var(--core-r) * ${RING_RATIO});
  opacity: 1;
  filter: drop-shadow(0 0 16px rgb(111 227 255 / 0.35));
  transition: stroke 0.4s ease-out, stroke-opacity 0.4s ease-out, filter 0.4s ease-out;
}
.hr-vent-open .hr-boss-vent {
  stroke: #eafeff;
  stroke-opacity: 1;
  filter: drop-shadow(0 0 26px var(--cyan, #6fe3ff)) drop-shadow(0 0 9px #eafeff);
  animation: hr-boss-vent 1.1s ease-in-out infinite;
}
@keyframes hr-boss-vent { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.15); } }

@media (prefers-reduced-motion: reduce) {
  .hr-boss-breathe, .hr-boss-eye, .hr-vent-open .hr-boss-vent { animation: none; }
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

export function Boss({ arena, boss, deathMs = DEATH_MS }: BossProps) {
  const shellRef = useRef<SVGGElement | null>(null);
  const partRefs = useRef<(SVGGElement | null)[]>([]);
  /** The last snapshot actually consumed. Every one-shot below is a diff against it. */
  const prev = useRef<{ parts: number[]; phase: number } | null>(null);

  // Thirteen static geometry groups. Built once, never re-rendered: the dead state, the
  // flinches and the death sequence are all applied imperatively to these nodes, so a
  // 10 Hz account stream never walks this subtree.
  const art = useMemo(
    () => (
      <g transform={`translate(${BOSS_ANCHOR_X} ${BOSS_ANCHOR_Y}) scale(${BOSS_SCALE})`}>
        {PART_SRC.map(({ name, inner }) => {
          if (HIDDEN.has(name)) return null;
          const i = PART_INDEX.get(name);
          return (
            <g
              key={name}
              className="hr-boss-part"
              // fill-box + an explicit origin, or a part-local scale or rotate resolves
              // against the root viewBox and flings the limb off-canvas. Measured.
              style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
              ref={
                i === undefined
                  ? undefined
                  : (el) => {
                      partRefs.current[i] = el;
                    }
              }
              dangerouslySetInnerHTML={{ __html: inner }}
            />
          );
        })}
      </g>
    ),
    [],
  );

  useEffect(() => {
    const now = { parts: boss.parts.slice(0, N_PARTS), phase: arena.phase };
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
        el.classList.add('hr-dead');
        el.animate(
          [
            { transform: 'none', opacity: 1, filter: 'brightness(3)' },
            soft
              ? { transform: 'none', opacity: 0.34, filter: 'none' }
              : {
                  transform: `translate(${ox * BREAK_PX}px, ${oy * BREAK_PX}px) rotate(${ox * 9}deg)`,
                  opacity: 0.34,
                  filter: 'none',
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

    const shell = shellRef.current;
    if (shell === null) return;

    // Death. One edge, one call. `SETTLING` is reached from `FIGHTING` and from nowhere
    // else, so the phase pair is the whole guard — a duplicate carries the same pair and
    // fires nothing.
    if (was.phase === PHASE_FIGHTING && now.phase === PHASE_SETTLING) {
      for (let i = 0; i < N_PARTS; i++) {
        const el = at(i);
        const [ox, oy] = OUTWARD[i] ?? [0, -1];
        if (el === null || soft) continue;
        el.animate(
          [
            { transform: 'none' },
            { transform: `translate(${ox * BREAK_PX * 2}px, ${oy * BREAK_PX * 2}px)` },
          ],
          { duration: deathMs * 0.35, delay: i * deathMs * 0.04, easing: 'ease-in', fill: 'forwards' },
        );
      }
      shell.animate([{ opacity: 1, offset: 0.7 }, { opacity: 0, offset: 1 }], {
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
      className={`hr-boss${boss.ventOpen === VENT_OPEN ? ' hr-vent-open' : ''}${enraged ? ' hr-enraged' : ''}`}
      style={{ '--shell': shell } as React.CSSProperties}
      transform={`translate(${boss.x} ${boss.y})`}
    >
      <style>{CSS}</style>
      <g className="hr-boss-breathe">
        <g ref={shellRef} className="hr-boss-shell">
          <g className="hr-boss-grade">{art}</g>
          {/* The orb's own light, landing on the creature that carries it. Scene.tsx paints
              a 330-unit core spill at the same world point, but SCENE is drawn UNDER the
              boss: the one light in this frame anchored to the creature never touched it —
              a glow with no lamp lighting nothing. Brightening that layer is not the fix
              (Scene.tsx:195-232 measured that lifting the pit walks the floor into the
              knights); a second, small spill here is.

              Placement is the whole trick. OVER `.hr-boss-grade`, so it is light rather
              than a fill the grade would tint — the grade would push cyan that is already
              the right colour toward the body's own hue. UNDER the vent, so the ring sits
              on its own glow. Static: no keyframe, no ref, no snapshot read, so it is one
              node in the tree and nothing at all in the frame loop. */}
          <defs>
            <radialGradient
              id="heartrot-boss-spill"
              gradientUnits="userSpaceOnUse"
              cx={CORE.x}
              cy={CORE.y}
              r={CORE_R * SPILL_R}
            >
              <stop offset="0" stopColor="#9fe8ff" stopOpacity={0.2} />
              <stop offset="0.4" stopColor="#6fe3ff" stopOpacity={0.07} />
              <stop offset="1" stopColor="#6fe3ff" stopOpacity={0} />
            </radialGradient>
          </defs>
          <circle
            cx={CORE.x}
            cy={CORE.y}
            r={CORE_R * SPILL_R}
            fill="url(#heartrot-boss-spill)"
            pointerEvents="none"
          />
          {/* The reference's bright chest orb. There is no glowing orb in the source art —
              the cavity there is the sprite's one dark socket — so it is drawn, at exactly
              the circle the chain raycasts. A literal here would make the drawn vent and
              the hit vent two different circles. Colour, opacity, stroke width and glow are
              the two CSS states above, never attributes here: a presentation attribute
              loses to the class anyway, so writing one would only be a second place to
              look. `--core-r` is published rather than typed for the same reason — it lets
              the ring be a ratio of the radius the chain owns. */}
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
// Both failure modes here are silent and both are catastrophic on screen: a part group
// the art no longer carries renders a limb that never breaks, and a group whose index
// moved breaks the WRONG limb off — the chain and the picture disagreeing about the same
// creature, which is the one thing the generator exists to prevent. Cheap enough to check
// at import, and it should stop the app here rather than three layers down.
// ---------------------------------------------------------------------------

{
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(BOSS_SVG) ?? [];
  if (Number(w) !== BOSS_SPRITE_W || Number(h) !== BOSS_SPRITE_H) {
    throw new Error(`Boss: the art is ${w}x${h}, the generated tables say ${BOSS_SPRITE_W}x${BOSS_SPRITE_H}`);
  }
  if (PART_SRC.length !== Object.keys(HITBOXES.hitboxes).length) {
    throw new Error(`Boss: the art has ${PART_SRC.length} part groups, hitboxes.json has ${Object.keys(HITBOXES.hitboxes).length}`);
  }
  if (PART_INDEX.size !== N_PARTS) throw new Error(`Boss: part_index holds ${PART_INDEX.size} names, N_PARTS is ${N_PARTS}`);
  const drawn = new Set(PART_SRC.map((p) => p.name));
  for (const name of PART_INDEX.keys()) {
    if (!drawn.has(name)) throw new Error(`Boss: hitboxes.json indexes "${name}", the art has no such group`);
  }
  // Hiding art the chain still raycasts is the one composition change that can make the
  // game lie: players would shoot at a limb that is not on screen and hit it.
  for (const name of HIDDEN) {
    if (PART_INDEX.has(name)) throw new Error(`Boss: "${name}" is hit-indexed and may not be hidden`);
  }
  // The orb is the frame's key light and every part of it is a ratio of the chain's own
  // radius. A retune that took `CORE.radiusSq` to 0 would silently delete the light rather
  // than move it, and a spill that does not outrun its ring puts the ring on bare body.
  if (!(CORE_R > 0)) throw new Error(`Boss: CORE.radiusSq is ${CORE.radiusSq}; the orb has no radius to light from`);
  if (SPILL_R <= 1) throw new Error(`Boss: SPILL_R ${SPILL_R} does not reach past the ring it lights`);
  if (OUTWARD.length !== N_PARTS) throw new Error('Boss: OUTWARD must cover every part');
  for (const [x, y] of OUTWARD) {
    if (Math.abs(Math.hypot(x, y) - 1) > 0.001) throw new Error(`Boss: [${x},${y}] is not a unit heading`);
  }
}
