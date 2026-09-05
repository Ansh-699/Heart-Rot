/**
 * The rooms' light: a glow on the floor under every painted torch and brazier, the embers
 * those flames shed, and a handful of drifting motes. Both rooms mount these layers from
 * their generated light tables (`LOBBY_LIGHTS`, `ARENA_LIGHTS` in `rooms.gen.ts`: position,
 * reach and colour read off the paint by `tools/gen_rooms.py`), so a repaint moves the light
 * with it and no position or colour is typed here.
 *
 * Why it exists: the paintings are lit rooms drawn as posters, and a poster of a torch is
 * still a poster. The flames are painted INTO the bitmap and cannot be animated; what can be
 * animated is everything the flame throws — the pool of light it casts, the sparks that leave
 * it, the dust its heat moves. Each light guts on its own clock (a phase and a duration hashed
 * from its own x,y, never an index ramp, so eleven torches never breathe in step), sheds two
 * embers that rise, wander sideways and die out of phase with every other ember, and the air
 * carries motes that bob individually inside a slow room-wide drift.
 *
 * Restraint is the design: this is ambience under the gameplay. The glow is a low-alpha
 * gradient on normal blending (a `mix-blend-mode` reads the backdrop back every frame the
 * scene changes, and the scene changes every frame), the flicker holds its old ~0.92 mean
 * opacity so no room got darker or brighter, its size breathes ±3.5 %, and an ember is a one-
 * unit dot at under half alpha. If a frame makes you look at the torches instead of the boss
 * it is too much.
 *
 * The cost contract is the room elements' own: built once at module load inside the room's
 * `<g>`, never re-rendered, nothing per frame in JS and nothing on the notification path.
 * Every motion is a CSS keyframe on TRANSFORM and OPACITY only — no `filter`, no blend mode,
 * nothing that forces layout — phase-offset per node by custom properties written once at
 * build time. Per room that is 11 glows, 22 embers and 20 motes in 2 grouping `<g>`s — 53
 * animated nodes carrying 55 animations of this file's, beside the one room-wide mote drift
 * `styles.css` already ran. The keyframes live in `LIGHT_CSS` below rather than `styles.css`
 * (the pattern `Boss.tsx` and `Hud.tsx` use) and override the older `.room-light circle` /
 * `.room-motes` rules there by specificity; the reduced-motion block at the end of
 * `LIGHT_CSS` cancels every one of them, and the rooms stay lit at rest. All three layers sit
 * UNDER the seats, the ordnance and the boss — verified as DOM order, ambience at index 63 to
 * 143 against the first actor at 183: light on the floor, never over the creature.
 *
 * Measured (the looksright bundle, 1920x1080, 20 seats, 24 bullets, 6x CPU throttle; the SAME
 * bundle with these layers `visibility: hidden` vs shown, twelve interleaved 140-frame blocks
 * inside ONE page so machine noise lands on both arms): the ambience costs 0.8 to 2.5 ms/frame
 * at 6x — 0.13 to 0.42 ms at 1x — over three paired runs, inside the 1 ms/frame it is
 * budgeted. Read those three as a range and not a trend: on a loaded box the run-to-run spread
 * of this measurement is wider than the effect it measures (one control run came back at
 * -5.3 ms/frame, which is the noise floor talking, and this project has been burned by
 * single-run gates before — see CLAUDE.md on ER latency). Only the WITHIN-run pairing is
 * trustworthy, and it is what earned `will-change` on the glow: dropping it, adjacent, in the
 * same session, moved the arena from 0.80 to 1.70 ms/frame at 6x, because eleven 110 px radial
 * gradients re-rasterise on every step of a scale unless the layer is promoted.
 *
 * Brightness is unchanged, which is the point of holding the flicker's mean at the old 0.92:
 * mean luminance over the room rect, 48 stills per arm against the previous version, lobby
 * 38.674 vs 38.666 (+0.02 %) and arena 37.655 vs 37.293 (+0.97 %, inside one standard
 * deviation of either arm).
 */
import type { CSSProperties, ReactElement } from 'react';

import type { RoomLight, WorldRect } from './rooms.gen';

/** The glow's alpha at the flame, and the fraction of it left at half its reach. */
const GLOW_ALPHA = 0.34;
const GLOW_MID = 0.32;
/** Motes per room. Twenty reads as air; more reads as weather. */
const MOTES = 20;
/** Embers per light. Two is a fire; six is a bonfire and you stop looking at the boss. */
const EMBERS = 2;

/**
 * A light's clock, off its own coordinates. Deliberately NOT the index: an index ramp gives
 * eleven durations in a straight line, and a straight line resynchronises — every few seconds
 * the whole wall guts together, which is the one thing eleven independent flames must not do.
 */
const hash = (a: number, b: number): number => {
  const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return n - Math.floor(n);
};

// ---------------------------------------------------------------------------
// Style
//
// Transform and opacity only, on nodes React writes once and never touches again. Lengths
// inside an SVG `transform` are user units, so `-30px` of ember rise is 30 arena units —
// about two thirds of a torch's reach.
// ---------------------------------------------------------------------------

const LIGHT_CSS = `
/* The pool of light. Opacity AND size: a flame's light does not just dim, its reach
   shortens. The mean opacity is the 0.92 the room shipped at, so no room changed
   brightness; the scale stays under ±3.5 % so the edge never reads as a moving hoop. */
.room-light circle.hrl-glow {
  /* Promoted: measured 1.70 -> 0.80 ms/frame of arena ambience at a 6x throttle. Eleven
     re-rasters of a 110 px gradient per frame become eleven composited layer transforms. */
  will-change: transform, opacity;
  transform-box: fill-box;
  transform-origin: center;
  animation: hrl-flicker var(--dur) ease-in-out var(--del) infinite;
}
@keyframes hrl-flicker {
  0%, 100% { opacity: 1;    transform: scale(1); }
  17%      { opacity: 0.86; transform: scale(0.972); }
  31%      { opacity: 0.97; transform: scale(1.028); }
  46%      { opacity: 0.82; transform: scale(0.966); }
  58%      { opacity: 0.95; transform: scale(1.012); }
  73%      { opacity: 0.88; transform: scale(0.988); }
  88%      { opacity: 1;    transform: scale(1.034); }
}

/* An ember: born in the flame, rises, drifts sideways, burns out. --dx / --ry are its
   own drift and rise, --a its peak alpha, all written once per node below. It shrinks as
   it climbs, which is what reads as "going out" without a second property to animate. */
.room-light circle.hrl-ember {
  transform-box: fill-box;
  transform-origin: center;
  opacity: 0;
  animation: hrl-ember var(--dur) linear var(--del) infinite;
}
@keyframes hrl-ember {
  0%   { transform: translate(0, 0) scale(0.5);                                   opacity: 0; }
  18%  { opacity: var(--a); }
  55%  { transform: translate(var(--dx), calc(var(--ry) * 0.55)) scale(1);        opacity: calc(var(--a) * 0.8); }
  100% { transform: translate(calc(var(--dx) * -0.5), var(--ry)) scale(0.3);      opacity: 0; }
}

/* The air. The mote group already carries a slow closed drift from styles.css; these two
   subgroups counter-drift inside it so the field shears instead of sliding as one slab,
   and every mote bobs and twinkles on its own clock inside that. Three nested closed
   loops, no two of the same length, so nothing ever snaps back. */
.hrl-air { animation: hrl-air var(--dur) ease-in-out var(--del) infinite; }
@keyframes hrl-air {
  0%, 100% { transform: translate(0, 0); }
  50%      { transform: translate(var(--dx), var(--ry)); }
}
.room-motes circle.hrl-mote {
  transform-box: fill-box;
  transform-origin: center;
  animation: hrl-mote var(--dur) ease-in-out var(--del) infinite;
}
/* Element opacity clamps at 1, so a mote cannot twinkle UP from its resting alpha. The
   fill carries 1.25x of the old value and the keyframe averages 0.8 of it back off — the
   air's mean alpha is unchanged, and now it has somewhere to brighten to. */
@keyframes hrl-mote {
  0%, 100% { transform: translate(0, 0);       opacity: 0.8; }
  25%      { transform: translate(4px, -3px);  opacity: 1; }
  50%      { transform: translate(1px, -7px);  opacity: 0.45; }
  75%      { transform: translate(-4px, -3px); opacity: 0.9; }
}

/* Reduced motion: lit, and still. Same selectors as above and later in this sheet, so these
   win without leaning on specificity. The embers go entirely — an ember is motion, and a
   frozen one is just a dot in the air (Spawn.tsx renders nothing under it for the same
   reason). The glow and the motes stay exactly where the room drew them. */
@media (prefers-reduced-motion: reduce) {
  .room-light circle.hrl-glow,
  .hrl-air,
  .room-motes circle.hrl-mote { animation: none; }
  .room-motes circle.hrl-mote { opacity: 0.8; }
  .room-light circle.hrl-ember { display: none; }
}
`;

/**
 * One gradient and one circle per light, plus the embers each one sheds. `id` keeps the
 * gradient ids distinct per room. Embers are drawn after the glows, so a spark sits over its
 * own pool of light — and the whole group still sits under the seats and the boss.
 */
export function roomGlow(id: string, lights: readonly RoomLight[]): ReactElement {
  return (
    <g className="room-light" aria-hidden="true">
      <style>{LIGHT_CSS}</style>
      <defs>
        {lights.map((l, i) => (
          <radialGradient key={i} id={`${id}-${i}`}>
            <stop offset="0" stopColor={l.color} stopOpacity={GLOW_ALPHA} />
            <stop offset="0.5" stopColor={l.color} stopOpacity={GLOW_ALPHA * GLOW_MID} />
            <stop offset="1" stopColor={l.color} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {lights.map((l, i) => {
        const h = hash(l.x, l.y);
        return (
          <circle
            key={i}
            className="hrl-glow"
            cx={l.x}
            cy={l.y}
            r={l.r}
            fill={`url(#${id}-${i})`}
            // 2.9 s to 5.5 s, and a negative delay of up to a full cycle: at t=0 every
            // flame is already somewhere different in its own gutter.
            style={
              {
                '--dur': `${(2.9 + h * 2.6).toFixed(2)}s`,
                '--del': `${(-h * 5.9).toFixed(2)}s`,
              } as CSSProperties
            }
          />
        );
      })}
      {lights.flatMap((l, i) =>
        Array.from({ length: EMBERS }, (_, e) => {
          const a = hash(l.x + e * 19.3, l.y - e * 11.7);
          const b = hash(l.y + e * 5.1, l.x + e * 3.7);
          const dur = 2.6 + a * 2.4;
          return (
            <circle
              key={`${i}-${e}`}
              className="hrl-ember"
              // Off the flame's exact centre by a quarter of its reach, so a light's two
              // embers leave from two places in the fire rather than one.
              cx={l.x + (a - 0.5) * l.r * 0.25}
              cy={l.y + (b - 0.5) * 3}
              r={0.85 + a * 0.8}
              fill={l.color}
              style={
                {
                  '--dur': `${dur.toFixed(2)}s`,
                  '--del': `${(-b * dur).toFixed(2)}s`,
                  '--dx': `${((b - 0.5) * 14).toFixed(1)}px`,
                  '--ry': `${(-22 - a * 20).toFixed(1)}px`,
                  '--a': (0.38 + b * 0.3).toFixed(2),
                } as CSSProperties
              }
            />
          );
        }),
      )}
    </g>
  );
}

/**
 * The motes, in the colour of the room's first light (they are its embers, gone cold),
 * scattered over `view` by the golden ratio: even, never a grid, never a clump. Split into
 * two counter-drifting halves so the field shears; each mote then bobs on its own clock. A
 * room with no painted fire has nothing to shed and gets none.
 */
export function roomMotes(view: WorldRect, lights: readonly RoomLight[]): ReactElement | null {
  const ember = lights[0];
  if (ember === undefined) return null;
  const motes = Array.from({ length: MOTES }, (_, i) => {
    const h = hash(i * 3.1 + 0.7, i * 1.9 + 2.3);
    return (
      <circle
        key={i}
        className="hrl-mote"
        cx={view.x + ((i * 0.618034 + 0.31) % 1) * view.w}
        cy={view.y + ((i * 0.381966 + 0.13) % 1) * view.h}
        r={1 + (i % 3) * 0.5}
        fill={ember.color}
        // 1.25x the alpha the room shipped at, because the keyframe above averages 0.8 of
        // it back off. Reduced motion pins that same 0.8, so the still air is today's air.
        fillOpacity={(0.2 + (i % 4) * 0.06) * 1.25}
        style={
          {
            '--dur': `${(7 + h * 9).toFixed(2)}s`,
            '--del': `${(-h * 16).toFixed(2)}s`,
          } as CSSProperties
        }
      />
    );
  });
  return (
    <g className="room-motes" aria-hidden="true">
      <g
        className="hrl-air"
        style={{ '--dur': '21s', '--del': '0s', '--dx': '13px', '--ry': '-9px' } as CSSProperties}
      >
        {motes.filter((_, i) => i % 2 === 0)}
      </g>
      <g
        className="hrl-air"
        style={
          { '--dur': '27s', '--del': '-6s', '--dx': '-11px', '--ry': '7px' } as CSSProperties
        }
      >
        {motes.filter((_, i) => i % 2 === 1)}
      </g>
    </g>
  );
}
