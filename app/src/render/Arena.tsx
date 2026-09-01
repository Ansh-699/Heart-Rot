/**
 * The arena viewport — primitive shapes only.
 *
 * One `<svg>` whose viewBox *is* arena space (0..1024), holding four layers:
 *
 *   map      four static nodes compiled from the generated wall bitboard: floor, walls,
 *            lit rims, entrances. Built once in a `useMemo`, so React holds one identical
 *            element reference and never walks the dungeon again on a 2.5 Hz state stream.
 *   boss     a body circle plus one `<rect>` per part, straight out of `PART_HITBOXES`,
 *            plus the vent circle from `CORE`. Live parts are lit, destroyed ones dark.
 *   players  one `<circle>` per occupied seat. REMOTE seats are positioned imperatively by
 *            `useSeatInterpolation`, between authoritative snapshots. The LOCAL seat is
 *            positioned from `predictor.self` in the frame loop below — see `MOVE_MS`.
 *   bullets  one `<rect>` per active slot, positioned imperatively from a rAF loop.
 *
 * No sprite rig, no tileset, no image assets, no hand-copied geometry. Every coordinate
 * comes from the generated tables in `@heartrot/client` (via `sprites.ts` for the dungeon
 * paths), which `tools/gen_map.py` and `tools/gen_hitboxes.py` emit from the same JSON as
 * the chain's own `map.rs` and `hitboxes.rs`. A hand-drawn room can disagree with the walls
 * the chain collides against; this cannot.
 *
 * The bullet loop is what makes a 2.5 Hz feed look like bullet hell. The chain advances a
 * bullet by exactly `(dx, dy)` per tick, so the client draws `(x + dx*f, y + dy*f)` for
 * `f` = fraction of a tick elapsed. At `f = 1` that lands on the integer the crank will
 * publish — same integers, same fixed step, zero prediction error. Anything cleverer here
 * would be wrong, not smoother.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  CORE,
  MAP_TILE,
  PART_HITBOXES,
  ZONE_ARENA,
  type ArenaAccount,
  type BossAccount,
  type PlayersAccount,
} from '@heartrot/client';

import { useSeatInterpolation, type Predictor } from '../net/predict';
import {
  ARENA_UNITS,
  BOSS_R,
  GATE_MAX,
  GATE_MIN,
  BULLET_R,
  FACING_UNIT,
  HP_BAR_W,
  MAP_ENTRANCE_PATH,
  MAP_RIM_PATH,
  MAP_WALL_PATH,
  PAL,
  PLAYER_R,
} from './sprites';

/** The vent circle, from the squared radius the chain compares against. */
const CORE_R = Math.round(Math.sqrt(CORE.radiusSq));

/**
 * The input period the local seat is chased at: one move per 50 ms ER slot, so the chase
 * covers exactly one `MOVE_STEP` in the time it takes the next one to arrive. It lands
 * within a frame of the prediction and never overshoots it.
 *
 * Chasing rather than assigning `predictor.self` outright is deliberate. Prediction alone
 * is not smoothness: `self` teleports one whole tile at 20 Hz, so two thirds of frames
 * would draw no movement at all — measurably *more* discrete than the interpolated seat it
 * replaces. The chase is what turns 16 units every 50 ms into 5.3 units every frame, at the
 * cost of ~32 ms of lag behind the keypress (against 165 ms for the interpolated seat).
 */
export const MOVE_MS = 50;

/**
 * Past this the prediction did not walk, it was moved — a reconcile onto a respawn at an
 * entrance. Chasing that draws a corpse gliding across the dungeon for two seconds, so it
 * snaps, exactly as `teleported` makes remote seats snap.
 */
const SELF_SNAP = 4 * MAP_TILE;

/**
 * Move `at` toward `to` by at most `step` units. Snaps when the target is within reach, or
 * when the gap is a teleport rather than a walk. Mutated in place: this runs every frame.
 *
 * Exported with `MOVE_MS` so `scripts/spike/perf_choppy.ts` measures the frame-by-frame
 * displacement of the *real* chase against the real predictor, rather than a copy of it
 * that could be smooth while the shipped one is not.
 */
export function chase(at: { x: number; y: number }, to: { x: number; y: number }, step: number): void {
  const dx = to.x - at.x;
  const dy = to.y - at.y;
  const d = Math.hypot(dx, dy);
  if (d <= step || d > SELF_SNAP) {
    at.x = to.x;
    at.y = to.y;
    return;
  }
  at.x += (dx * step) / d;
  at.y += (dy * step) / d;
}

export interface ArenaProps {
  arena: ArenaAccount;
  boss: BossAccount;
  players: PlayersAccount;
  /** Seat the local player drives, ringed so they can find themselves among twenty. */
  localSeat?: number;
  /**
   * The local player's prediction. Given one, `localSeat` is drawn from `predictor.self`
   * at input rate instead of from the authoritative snapshot stream — the crank rewrites
   * `Players` every 100 ms with no position change in it, and interpolating P→P is the
   * "still, still, still, JUMP" the fight is reported to move with. Omit it and every
   * seat interpolates, which is what a spectator wants anyway.
   */
  predictor?: Predictor;
  /**
   * Target ms between ticks, from `/api/session/init`. Only ever used to pace bullet
   * extrapolation — never to derive game state. `arena.tick` is the clock; 400 ms is a
   * target the crank does not promise.
   */
  tickMs?: number;
  className?: string;
}

export function Arena({
  arena,
  boss,
  players,
  localSeat,
  predictor,
  tickMs = 400,
  className,
}: ArenaProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reduced = usePrefersReducedMotion();

  usePixelFit(boxRef, svgRef);

  const seats = useSeatInterpolation(players, reduced);

  // Latest snapshot and the moment its tick landed, read by the rAF loop without the loop
  // being torn down and rebuilt every tick.
  const bullets = useRef(arena.bullets);
  const pace = useRef(tickMs);
  const tickAt = useRef(0);
  useEffect(() => {
    bullets.current = arena.bullets;
    pace.current = tickMs;
  });
  useEffect(() => {
    tickAt.current = performance.now();
  }, [arena.tick]);

  const nodes = useRef(new Map<number, SVGRectElement>());
  // The local seat's `<g>`, owned by the frame loop the way `nodes` owns the bullets.
  const selfNode = useRef<SVGGElement | null>(null);
  const drawn = useRef<{ x: number; y: number } | null>(null);
  const frameAt = useRef(0);
  // Placed on attach, not on the next frame: a seat that waits for one sits at the SVG
  // origin, which reads as the knight teleporting to the corner. Stable while `predictor`
  // is, so React does not detach and reattach the node on every update.
  const selfRef = useCallback(
    (el: SVGGElement | null) => {
      selfNode.current = el;
      // A new node starts where the prediction is; chasing from wherever the last one
      // stopped would drag the knight in from the old seat's position.
      drawn.current = null;
      if (el === null || predictor === undefined) return;
      el.style.transform = `translate(${predictor.self.x}px, ${predictor.self.y}px)`;
    },
    [predictor],
  );
  useEffect(() => {
    // Under reduced motion bullets snap to each published position: React already writes
    // that transform, so there is nothing left for a frame loop to do — but the local
    // seat has no transform of its own to snap to, so the loop still runs for it.
    if (reduced && predictor === undefined) return;
    let raf = 0;
    const frame = () => {
      const now = performance.now();
      if (!reduced) {
        const f = Math.min(1, (now - tickAt.current) / pace.current);
        for (const [slot, el] of nodes.current) {
          const b = bullets.current[slot];
          if (b === undefined) continue;
          el.style.transform = `translate(${b.x + b.dx * f}px, ${b.y + b.dy * f}px)`;
        }
      }

      // One more node per frame, off the predicted position rather than the feed, so the
      // knight the player is watching moves when they press a key and not when Singapore
      // says so. Under reduced motion the step is unbounded, which is a snap.
      const el = selfNode.current;
      if (el !== null && predictor !== undefined) {
        let at = drawn.current;
        if (at === null) at = drawn.current = { x: predictor.self.x, y: predictor.self.y };
        // Real elapsed time, not an assumed 1/60: a 144 Hz screen would otherwise chase
        // 2.4× too slowly. Capped at one input period so a backgrounded tab resumes with
        // a single step rather than a sprint across the room.
        const dt = Math.min(MOVE_MS, now - frameAt.current);
        chase(at, predictor.self, reduced ? Infinity : (MAP_TILE * dt) / MOVE_MS);
        el.style.transform = `translate(${at.x}px, ${at.y}px)`;
      }

      frameAt.current = now;
      raf = requestAnimationFrame(frame);
    };
    frameAt.current = performance.now();
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced, predictor]);

  // The dungeon never changes for the life of the scene. One memo, one stable element
  // reference, and React skips the whole subtree on every update from here on.
  const map = useMemo(
    () => (
      <g>
        <rect x={0} y={0} width={ARENA_UNITS} height={ARENA_UNITS} fill={PAL.floor} />
        <path d={MAP_WALL_PATH} fill={PAL.wall} />
        <path d={MAP_RIM_PATH} fill={PAL.rim} />
        <path d={MAP_ENTRANCE_PATH} fill={PAL.entrance} opacity={0.18} />
        {/* The gate. Without it drawn, "walk to the middle" is a guess — this 4x4 tile
            block is the whole of matchmaking and it is plain floor in the map grid. */}
        <rect
          x={GATE_MIN}
          y={GATE_MIN}
          width={GATE_MAX - GATE_MIN + 1}
          height={GATE_MAX - GATE_MIN + 1}
          fill={PAL.ventOpen}
          fillOpacity={0.12}
          stroke={PAL.ventOpen}
          strokeWidth={2}
          strokeDasharray="8 6"
        />
      </g>
    ),
    [],
  );

  const ventOpen = boss.ventOpen === 1;

  return (
    <div
      ref={boxRef}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
        minHeight: 0,
      }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${ARENA_UNITS} ${ARENA_UNITS}`}
        // One inherited declaration keeps every edge on the device grid, which is what
        // `usePixelFit` exists to make even.
        shapeRendering="crispEdges"
        style={{ display: 'block' }}
        role="img"
        aria-label={`Boss arena, tick ${arena.tick}, ${arena.aliveCount} raiders alive`}
      >
        {map}

        <g transform={`translate(${boss.x} ${boss.y})`}>
          {/* The body, so nine loose boxes still read as one creature. */}
          <circle r={BOSS_R} fill={PAL.bossBody} stroke={PAL.bossEdge} strokeWidth={2} />
          {PART_HITBOXES.map((part, i) => {
            const hp = boss.parts[i] ?? 0;
            const max = boss.partsMax[i] ?? 1;
            const dead = hp === 0;
            return (
              <rect
                key={i}
                x={part.x}
                y={part.y}
                width={part.w}
                height={part.h}
                fill={dead ? PAL.partDead : PAL.partLive}
                // Shell remaining, floored so a nearly-dead part is still clearly a part
                // rather than a ghost of one.
                fillOpacity={dead ? 1 : 0.45 + 0.55 * (hp / Math.max(1, max))}
                stroke={dead ? PAL.partDead : PAL.bossEdge}
                strokeWidth={2}
              />
            );
          })}
          {/* Sealed until the vent opens at 34.44% shell; the only thing worth shooting
              after that, so it is the brightest object on the boss. */}
          <circle
            cx={CORE.x}
            cy={CORE.y}
            r={CORE_R}
            fill={ventOpen ? PAL.ventOpen : PAL.ventSealed}
            stroke={ventOpen ? PAL.ventOpenEdge : PAL.ventSealedEdge}
            strokeWidth={3}
          />
        </g>

        <g>
          {players.slots.map((slot) => {
            // Any seated player, in either zone. `zone` is a one-way flag on the SAME
            // map — everyone spawns in ZONE_LOBBY and walks to the gate — so filtering
            // to ZONE_ARENA drew an empty room for the whole of the lobby, which is the
            // one phase where you have to be able to see yourself to play.
            if (!slot.occupied) return null;
            const dead = slot.hp === 0;
            const lobby = slot.zone !== ZONE_ARENA;
            const mine = slot.seat === localSeat;
            // Prediction for the seat the player drives, interpolation for everyone else.
            // Both machines already existed; this is the line that stops the local knight
            // being drawn from ~127 ms-old chain state that the crank re-anchors.
            // `ready` and not merely `predictor !== undefined`: `self` is the arena's
            // top-left corner until the first reconcile, so an ungated seat would be drawn
            // in the corner. Unreachable through the live path — a seat only becomes
            // `occupied` in the same notification that reconciles it — but the fallback
            // here is interpolation, which is correct, rather than a teleport.
            const predicted = mine && predictor !== undefined && predictor.ready;
            const colour = dead ? PAL.dead : mine ? PAL.self : PAL.ally;
            const unit = FACING_UNIT[slot.facing] ?? FACING_UNIT[0]!;
            const hp = slot.hpMax > 0 ? Math.max(0, Math.min(1, slot.hp / slot.hpMax)) : 0;
            return (
              // The frame loop (local seat) or `useSeatInterpolation` (everyone else) owns
              // this node's transform outright — nothing else may put a transform
              // attribute on it.
              <g key={slot.seat} ref={predicted ? selfRef : seats.ref(slot.seat)}>
                {mine && (
                  <circle
                    r={PLAYER_R + 5}
                    fill="none"
                    stroke={PAL.selfRing}
                    strokeWidth={2}
                    opacity={0.8}
                  />
                )}
                <circle
                  r={PLAYER_R}
                  // Dead is hollow, never filled: the one separation that has to survive a
                  // glance at twenty dots.
                  fill={dead ? 'none' : colour}
                  stroke={colour}
                  strokeWidth={2}
                />
                {!dead && (
                  /* Which way they will shoot. A nub, not an arrow — this is a dot. */
                  <line
                    x1={unit[0] * PLAYER_R}
                    y1={unit[1] * PLAYER_R}
                    x2={unit[0] * (PLAYER_R + 8)}
                    y2={unit[1] * (PLAYER_R + 8)}
                    stroke={colour}
                    strokeWidth={3}
                  />
                )}
                {/* No health bar in the lobby — nothing damages you before the gate, so
                    twenty full bars would be twenty pieces of noise. */}
                {!dead && !lobby && (
                  <>
                    <rect
                      x={-HP_BAR_W / 2}
                      y={-PLAYER_R - 10}
                      width={HP_BAR_W}
                      height={4}
                      fill={PAL.hpBack}
                      opacity={0.6}
                    />
                    <rect
                      x={-HP_BAR_W / 2}
                      y={-PLAYER_R - 10}
                      width={HP_BAR_W * hp}
                      height={4}
                      fill={PAL.hpFill}
                    />
                  </>
                )}
              </g>
            );
          })}
        </g>

        <g>
          {arena.bullets.map((b, slot) =>
            b.active === 0 ? null : (
              <rect
                key={slot}
                ref={(el) => {
                  if (el) nodes.current.set(slot, el);
                  else nodes.current.delete(slot);
                }}
                x={-BULLET_R}
                y={-BULLET_R}
                width={BULLET_R * 2}
                height={BULLET_R * 2}
                fill={PAL.bullet}
                stroke={PAL.bulletEdge}
                strokeWidth={1}
                style={{
                  willChange: 'transform',
                  // The published position. The frame loop overwrites this between ticks;
                  // under reduced motion it is the only thing that ever writes it.
                  transform: `translate(${b.x}px, ${b.y}px)`,
                }}
              />
            ),
          )}
        </g>
      </svg>
    </div>
  );
}

/**
 * Size the SVG so one arena unit covers a whole number of device pixels.
 *
 * `shape-rendering: crispEdges` snaps every edge to the device grid, so at a fractional
 * effective scale — which is what a 125% OS display scale gives you, dpr 1.1875 — wall
 * edges come out uneven and the unevenness *moves* as the scene translates. Picking the
 * largest integer device scale that fits and working back to a (fractional, correct) CSS
 * size removes the cause. Below 1:1 there is no integer to pick and no crispness to
 * protect, so it falls through to a plain fit.
 *
 * ponytail: driven by ResizeObserver alone. Browser zoom resizes the container so it is
 * caught, but a pure device-pixel-ratio change with no layout change (dragging the window
 * to a different-density monitor) is missed until the next resize. Add a `matchMedia
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

/** A rAF loop is not a keyframe — it has to be told about reduced motion. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// Self-check
//
// The chase is the whole of the smoothness fix and it fails silently: too small a step
// floats behind the input, too large a one is the 16-unit teleport it exists to remove,
// and a missing snap slides a respawning corpse across the dungeon. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`Arena self-check: ${what}`);
  };

  // One 50 ms input period covers exactly one tile — the step the chain itself applies —
  // so the render never lags the prediction by more than the move it has not seen yet.
  const at = { x: 0, y: 0 };
  chase(at, { x: 2 * MAP_TILE, y: 0 }, MAP_TILE);
  ok(at.x === MAP_TILE && at.y === 0, 'chase covers one tile per input period');

  // Within reach it lands exactly on the prediction rather than orbiting it.
  chase(at, { x: MAP_TILE + 4, y: 0 }, MAP_TILE);
  ok(at.x === MAP_TILE + 4, 'chase snaps once the target is within a step');

  // Reduced motion asks for no animation at all: an unbounded step is a snap.
  chase(at, { x: 300, y: 300 }, Infinity);
  ok(at.x === 300 && at.y === 300, 'an unbounded step snaps');

  // A reconcile onto a respawn is not a walk, and lerping it draws a corpse gliding
  // through walls for two seconds.
  chase(at, { x: 900, y: 900 }, MAP_TILE);
  ok(at.x === 900 && at.y === 900, 'a respawn-sized gap snaps instead of chasing');
}
