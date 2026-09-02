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
 * The creature's grade, and the rim light painted back over it.
 *
 * Ungraded, the boss is the brightest, warmest and most saturated object in a cavern that
 * is graded to ~210° blue and tops out at sRGB L 68.7: its dominant fills are `#c9aab0`
 * (L 177.0), `#af8c92` (147.9), `#936975` (114.8) and `#753757` (70.5) — warm pale mauve,
 * a pastel sticker on a cold cave. In the reference the demon is DARK and rim-lit.
 *
 * Evaluated in sRGB the way the browser applies a CSS shorthand chain, these five terms map
 * those four fills to L 64.2 / 53.7 / 41.8 / 26.0 at hue 219/218/215/205° — every dominant
 * value under the environment's own ceiling, and the internal contrast preserved almost
 * exactly (brightest:darkest goes 2.51 → 2.47, so it darkens rather than flattens; the risk
 * `art.md` names for a single filter, a muddy boss, is what that ratio measures). The
 * brightest pixel the creature can now produce is L 80.8 — the two 2x2 near-white blocks in
 * the source art, which the drawn eyes sit on top of anyway. That is also the ceiling the
 * `brightness(2.2)` hit flash below now clips to, since it is applied inside this group: on
 * a graded limb resting near L 40 that is still a doubling, so the flash survives the
 * grade, but nothing above `brightness(2.2)` would buy any more of one.
 *
 * The rim is the last term: the same silhouette, offset 2 units up-left, flooded cyan at
 * 0.25, drawn behind. That is a `drop-shadow`, not `art.md`'s `<use>` of the silhouette —
 * see the note on `.hr-boss-grade` below for why the `<use>` is the wrong mechanism here.
 * It is last in the chain on purpose, so the grade cannot touch the light it adds.
 *
 * The grade is on the WRAPPER, not on the art group: filters are applied in the element's
 * own coordinate system, and the art group carries `scale(BOSS_SCALE)`, which would make
 * this 2 into 6 arena units. The wrapper has no transform, so a unit here is an arena unit.
 *
 * Core and eyes are siblings of the graded group, never inside it — after this they are the
 * only warm, bright things in the frame, which is the whole point.
 */
const BOSS_GRADE =
  'grayscale(0.7) sepia(0.6) hue-rotate(185deg) saturate(1.6) brightness(0.32) ' +
  'drop-shadow(-2px -2px 0 rgb(159 232 255 / 0.25))';

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
   are WAAPI, so the rim would sit still at 0.25 alpha while the limb it outlines flies out
   of frame. A drop-shadow is the same image (offset silhouette, flat colour, behind) and
   is part of the element being animated, so it cannot desynchronise. */
.hr-boss-grade { filter: ${BOSS_GRADE}; }

/* The vent is a state, not a duration: opacity carries it even with motion off. Sealed it
   is a dull coal, NOT absent — it was opacity: 0 until the vent opens, which is after
   11,700 of 18,000 shell damage, so the reference's bright chest orb, the focal point of
   the whole composition, did not exist during the lobby, the muster, the spawn reveal or
   the first ~65% of the fight, while Scene.tsx painted a 330-unit core spill around it:
   a glow with no lamp. These are styles.css's own two .core-glow rules, which were
   written for this and never wired to anything. Colour comes from the shared tokens, so
   the lamp and the spill cannot drift apart. */
.hr-boss-vent {
  transform-box: fill-box;
  transform-origin: center;
  fill: var(--cyan-dim, #2a7f96);
  stroke: var(--cyan-dim, #2a7f96);
  opacity: 0.35;
  transition: opacity 0.4s ease-out, fill 0.4s ease-out, stroke 0.4s ease-out;
}
.hr-vent-open .hr-boss-vent {
  fill: var(--cyan, #6fe3ff);
  fill-opacity: 0.55;
  stroke: #eafeff;
  opacity: 1;
  filter: drop-shadow(0 0 18px var(--cyan, #6fe3ff));
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
      className={`hr-boss${boss.ventOpen === 1 ? ' hr-vent-open' : ''}${enraged ? ' hr-enraged' : ''}`}
      style={{ '--shell': shell } as React.CSSProperties}
      transform={`translate(${boss.x} ${boss.y})`}
    >
      <style>{CSS}</style>
      <g className="hr-boss-breathe">
        <g ref={shellRef} className="hr-boss-shell">
          <g className="hr-boss-grade">{art}</g>
          {/* The reference's bright chest orb. There is no glowing orb in the source art —
              the cavity there is the sprite's one dark socket — so it is drawn, at exactly
              the circle the chain raycasts. A literal here would make the drawn vent and
              the hit vent two different circles. Colour, opacity and glow are the two CSS
              states above, never attributes here: a presentation attribute loses to the
              class anyway, so writing one would only be a second place to look. */}
          <circle className="hr-boss-vent" cx={CORE.x} cy={CORE.y} r={CORE_R} strokeWidth={3} />
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
  if (OUTWARD.length !== N_PARTS) throw new Error('Boss: OUTWARD must cover every part');
  for (const [x, y] of OUTWARD) {
    if (Math.abs(Math.hypot(x, y) - 1) > 0.001) throw new Error(`Boss: [${x},${y}] is not a unit heading`);
  }
}
