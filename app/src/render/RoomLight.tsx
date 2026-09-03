/**
 * The rooms' light: a glow on the floor under every painted torch and brazier, and a
 * handful of drifting motes. Both rooms mount these two layers from their generated light
 * tables (`LOBBY_LIGHTS`, `ARENA_LIGHTS` in `rooms.gen.ts`: position, reach and colour read
 * off the paint by `tools/gen_rooms.py`), so a repaint moves the light with it and no
 * position or colour is typed here.
 *
 * Why it exists: the paintings are lit rooms drawn as posters. A radial glow under each
 * flame that breathes a little, and a few embers crossing the floor, are what make the eye
 * read "lit" rather than "printed" — and nothing more. Restraint is the design: the glow
 * is a low-alpha gradient on normal blending (a `mix-blend-mode` reads the backdrop back
 * every frame the scene changes, and the scene changes every frame), the flicker is ±15 %
 * of opacity, the motes are twenty dots of one or two units at a fifth to two fifths alpha.
 *
 * The cost contract is the room elements' own: built once at module load inside the room's
 * `<g>`, never re-rendered, nothing per frame in JS and nothing on the notification path.
 * Every motion is one CSS keyframe (`styles.css`, "rooms: light"): `room-flicker` on each
 * glow's opacity, phase-offset by its index through `--i`; `room-drift` on the mote group's
 * translate, a closed 32 s loop so it never jumps. Under reduced motion both are cancelled
 * and the rooms stay lit at rest. Both layers sit UNDER the seats, the ordnance and the
 * boss, in the room's own compositor layer: light on the floor, never over the creature.
 *
 * Measured (scripts/spike/framebudget main3, 1920x1080, 20 seats, 24 bullets, 400 frames,
 * the same bundle with these two layers shown vs hidden, three interleaved reps, medians):
 * arena commit p50 2.20 → 2.20 ms, lobby 1.60 → 1.70 ms; at a 4x CPU throttle the arena
 * 7.80 → 8.50 ms. Under the 1 ms/frame the ambience was budgeted.
 */
import type { CSSProperties, ReactElement } from 'react';

import type { RoomLight, WorldRect } from './rooms.gen';

/** The glow's alpha at the flame, and the fraction of it left at half its reach. */
const GLOW_ALPHA = 0.34;
const GLOW_MID = 0.32;
/** Motes per room. Twenty reads as air; more reads as weather. */
const MOTES = 20;

/** One gradient and one circle per light. `id` keeps the gradient ids distinct per room. */
export function roomGlow(id: string, lights: readonly RoomLight[]): ReactElement {
  return (
    <g className="room-light" aria-hidden="true">
      <defs>
        {lights.map((l, i) => (
          <radialGradient key={i} id={`${id}-${i}`}>
            <stop offset="0" stopColor={l.color} stopOpacity={GLOW_ALPHA} />
            <stop offset="0.5" stopColor={l.color} stopOpacity={GLOW_ALPHA * GLOW_MID} />
            <stop offset="1" stopColor={l.color} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {lights.map((l, i) => (
        <circle
          key={i}
          cx={l.x}
          cy={l.y}
          r={l.r}
          fill={`url(#${id}-${i})`}
          style={{ '--i': i } as CSSProperties}
        />
      ))}
    </g>
  );
}

/**
 * The motes, in the colour of the room's first light (they are its embers), scattered
 * over `view` by the golden ratio: even, never a grid, never a clump. A room with no
 * painted fire has nothing to shed and gets none.
 */
export function roomMotes(view: WorldRect, lights: readonly RoomLight[]): ReactElement | null {
  const ember = lights[0];
  if (ember === undefined) return null;
  return (
    <g className="room-motes" aria-hidden="true">
      {Array.from({ length: MOTES }, (_, i) => (
        <circle
          key={i}
          cx={view.x + ((i * 0.618034 + 0.31) % 1) * view.w}
          cy={view.y + ((i * 0.381966 + 0.13) % 1) * view.h}
          r={1 + (i % 3) * 0.5}
          fill={ember.color}
          fillOpacity={0.2 + (i % 4) * 0.06}
        />
      ))}
    </g>
  );
}
