/**
 * The arena scene: static map, boss rig, players, bullets — four layers, drawn once into
 * one SVG whose viewBox *is* arena space.
 *
 * Layer discipline, and why each one is the way it is:
 *
 *   map      four `<path>`/`<rect>` nodes compiled from the generated wall bitboard. A
 *            64x64 tile map as one rect per tile is 4,096 nodes that never change (design
 *            spec §6); merging each row's runs into subpaths makes each layer one node.
 *   boss     `<Rig>`, one composited `<g>` per part.
 *   players  one composited `<g>` per seat, `<use>`-ing a skin defined once in `<defs>`.
 *   bullets  up to 128 `<rect>`s, the only place in the codebase that uses `will-change`,
 *            positioned imperatively from a rAF loop.
 *
 * The bullet loop is the reason the game looks like bullet hell at a 2.5 Hz update rate.
 * The chain advances a bullet by exactly `(dx, dy)` per tick, so the client renders
 * `(x + dx*f, y + dy*f)` for `f` = fraction of a tick elapsed. At `f = 1` that lands on the
 * integer the crank will publish — same integers, same fixed step, zero prediction error.
 * Anything cleverer here would be wrong, not smoother.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { PHASE_FIGHTING, ZONE_ARENA, type ArenaAccount, type BossAccount, type PlayersAccount } from '@heartrot/client';

import { Rig } from './Rig';
import {
  ARENA_UNITS,
  BULLET_SIZE,
  MAP_ENTRANCE_PATH,
  MAP_RIM_PATH,
  MAP_WALL_PATH,
  SKINS,
  SKIN_HEIGHT,
  facesWest,
  skinHref,
  skinOf,
} from './sprites';
import './animations.css';

export interface ArenaProps {
  arena: ArenaAccount;
  boss: BossAccount;
  players: PlayersAccount;
  /** Seat the local player drives, marked so they can find themselves among twenty knights. */
  localSeat?: number;
  /**
   * Target ms between ticks, from `/api/session/init`. Only ever used to pace bullet
   * extrapolation — never to derive game state. `arena.tick` is the clock; 400 ms is a
   * target the crank does not promise.
   */
  tickMs?: number;
  className?: string;
}

export function Arena({ arena, boss, players, localSeat, tickMs = 400, className }: ArenaProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reduced = usePrefersReducedMotion();

  usePixelFit(boxRef, svgRef);

  // Latest chain snapshot and the moment it landed, for the rAF loop to read without being
  // torn down and rebuilt on every tick.
  const bullets = useRef(arena.bullets);
  const tickAt = useRef(0);
  const pace = useRef(tickMs);
  useEffect(() => {
    bullets.current = arena.bullets;
    pace.current = tickMs;
  });
  useEffect(() => {
    tickAt.current = performance.now();
  }, [arena.tick]);

  const nodes = useRef(new Map<number, SVGRectElement>());
  useEffect(() => {
    // Under reduced motion the bullets simply snap to each published position: React already
    // writes that transform, so there is nothing left for a frame loop to do.
    if (reduced) return;
    let raf = 0;
    const frame = () => {
      const f = Math.min(1, (performance.now() - tickAt.current) / pace.current);
      for (const [slot, el] of nodes.current) {
        const b = bullets.current[slot];
        if (!b) continue;
        el.style.transform = `translate(${b.x + b.dx * f}px, ${b.y + b.dy * f}px)`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced]);

  // The map and the skin definitions never change for the life of the scene. Memoised so a
  // 2.5 Hz state stream cannot walk a few thousand `<path>` elements looking for a diff.
  const stage = useMemo(
    () => (
      <>
        <defs>
          {SKINS.map((skin, i) => (
            <g key={i} id={`hr-skin-${i}`}>
              {skin.paths.map((p) => (
                <path key={p.fill} fill={p.fill} d={p.d} />
              ))}
            </g>
          ))}
        </defs>
        {/* The dungeon, compiled from the same wall bitboard the chain collides against:
            floor, then walls, then the lit top faces, then the four entrances. Four static
            nodes, no image, nothing to keep in sync by hand. */}
        <g className="hr-map">
          <rect x={0} y={0} width={ARENA_UNITS} height={ARENA_UNITS} fill="#17151b" />
          <path d={MAP_WALL_PATH} fill="#2b2733" />
          <path d={MAP_RIM_PATH} fill="#413a4f" />
          <path d={MAP_ENTRANCE_PATH} fill="#b5b56a" opacity={0.18} />
        </g>
      </>
    ),
    [],
  );

  const fighting = arena.phase === PHASE_FIGHTING;

  return (
    <div ref={boxRef} className={className ? `hr-stage ${className}` : 'hr-stage'}>
      <svg
        ref={svgRef}
        className="hr-scene"
        viewBox={`0 0 ${ARENA_UNITS} ${ARENA_UNITS}`}
        // One inherited declaration covers every path in the tree. This — not
        // `image-rendering`, which does nothing to SVG shapes — is what keeps the art crisp.
        shapeRendering="crispEdges"
        role="img"
        aria-label={`Boss arena, tick ${arena.tick}, ${arena.aliveCount} raiders alive`}
      >
        {stage}

        <Rig boss={boss} />

        <g className="hr-players">
          {players.slots.map((slot) => {
            if (!slot.occupied || slot.zone !== ZONE_ARENA) return null;
            const skin = skinOf(slot.skinId);
            const dead = slot.hp === 0;
            const moving = !dead && arena.tick <= slot.lastMoveTick + 1;
            const shooting = !dead && fighting && slot.lastShotTick === arena.tick;
            return (
              <g
                key={slot.seat}
                // Position and facing both live on the wrapper, so the animated group below
                // carries nothing but its keyframes — an animated `<g>` that also has a
                // transform of its own has that transform replaced, not composed.
                transform={`translate(${slot.x} ${slot.y})${facesWest(slot.facing) ? ' scale(-1 1)' : ''}`}
              >
                {slot.seat === localSeat && (
                  <ellipse className="hr-you" cx={0} cy={0} rx={skin.anchorX} ry={6} />
                )}
                <g
                  className={
                    'hr-rig' +
                    (dead ? ' hr-dead' : moving ? ' hr-run' : ' hr-idle') +
                    (shooting ? ' hr-shoot' : '')
                  }
                >
                  <g transform={`translate(${-skin.anchorX} ${-SKIN_HEIGHT})`}>
                    {/* No x/y on the <use>: an extra transform there would take the group
                        above off the compositor for good. */}
                    <use href={skinHref(slot.skinId)} />
                  </g>
                </g>
              </g>
            );
          })}
        </g>

        <g className="hr-bullets">
          {arena.bullets.map((b, slot) =>
            b.active === 0 ? null : (
              <rect
                key={slot}
                ref={(el) => {
                  if (el) nodes.current.set(slot, el);
                  else nodes.current.delete(slot);
                }}
                className="hr-bullet"
                x={-BULLET_SIZE / 2}
                y={-BULLET_SIZE / 2}
                width={BULLET_SIZE}
                height={BULLET_SIZE}
                // The published position. The frame loop overwrites this between ticks; with
                // reduced motion it is the only thing that ever writes it.
                style={{ transform: `translate(${b.x}px, ${b.y}px)` }}
              />
            ),
          )}
        </g>
      </svg>
    </div>
  );
}

/**
 * Size the SVG so one sprite pixel covers a whole number of device pixels.
 *
 * `shape-rendering: crispEdges` snaps every edge to the device grid, so at a fractional
 * effective scale — which is what a 125% OS display scale gives you, dpr 1.1875 — sprite
 * pixels come out 5,5,5,4,5,5,5,4 wide and the unevenness *moves* as a sprite translates.
 * Anti-aliasing would have hidden that as blur; crispEdges makes it structural. Picking the
 * largest integer device scale that fits and working back to a (fractional, correct) CSS
 * size removes the cause.
 *
 * Below 1:1 there is no integer to pick and no crispness to protect, so it falls through to
 * a plain fit.
 *
 * ponytail: driven by ResizeObserver alone. Browser zoom changes the layout viewport and so
 * resizes the container, but a pure device-pixel-ratio change with no layout change (drag to
 * a different-density monitor) is missed until the next resize. Add a `matchMedia
 * (resolution: Ndppx)` listener, re-armed after each change, if that shows up in testing.
 */
function usePixelFit(
  box: React.RefObject<HTMLDivElement | null>,
  svg: React.RefObject<SVGSVGElement | null>,
): void {
  useEffect(() => {
    const b = box.current;
    const s = svg.current;
    if (!b || !s) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const raw = (Math.min(r.width, r.height) * dpr) / ARENA_UNITS;
      const scale = raw >= 1 ? Math.floor(raw) : raw;
      const css = `${(ARENA_UNITS * scale) / dpr}px`;
      s.style.width = css;
      s.style.height = css;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
  }, [box, svg]);
}

/**
 * `animations.css` already stops every keyframe under `prefers-reduced-motion`, but a rAF
 * loop is not a keyframe — it has to be told.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
