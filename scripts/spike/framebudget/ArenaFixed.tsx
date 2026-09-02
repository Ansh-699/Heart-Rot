// THROWAWAY. app/src/render/Arena.tsx with ONE edit: the 128 bullet `ref` closures are
// hoisted to stable per-slot identities. Everything else is byte-identical to the
// shipped file. Diff it against the product file before believing any number from it.
/**
 * The arena viewport — the composition, and nothing else.
 *
 * This file owns *where things sit relative to each other* and *who writes which node*.
 * The art itself lives in three sibling modules, each of which owns one layer and its own
 * animation, so that a change to the boss rig cannot reach into the seat loop:
 *
 *   `./Scene`   `{SCENE}`                            the temple, graded and lit. One element
 *                                                    built at module load: no props, no memo,
 *                                                    nothing React can walk again.
 *   `./Boss`    `<Boss boss arena />`                the 13-group rig at `BOSS_SPAWN`.
 *   `./Knight`  `<Knight slot tick mine reduced />`  the CHILDREN of one seat `<g>`, never
 *                                                    the `<g>` itself, whose transform the
 *                                                    loops below own. `knightDrawOrder` is
 *                                                    its paint order.
 *   `./Spawn`   `<Spawn phase bossX bossY reduced />` the light the cavern plays when the
 *                                                    muster ends. Last child, over everything.
 *
 * The shot this assembles is the reference: the creature fixed at the TOP CENTRE with its
 * hands over the rim, the pit below it, twenty small knights in the pit, bullets falling
 * into them and hitscan going back up. Layer order under `#camera`, back to front:
 *
 *   scene      static, module-scope. React never walks it again after mount.
 *   walls      the generated wall bitboard, ON TOP of the temple. The floor is art; the
 *              walls are the geometry the chain raycasts, and art that hides one reads as
 *              lag. With them, the entrance marks and the 4x2 gate block `enter_gate`
 *              accepts — rules, drawn, not decoration.
 *   bullets    BENEATH the boss, so a bullet's first frames are hidden by the silhouette
 *              it left. One `<rect>`-shaped `<line>` per active slot, positioned
 *              imperatively from the rAF loop.
 *   boss       behind the players, per the reference.
 *   telegraphs the slam lane and the volley's aim lines. Both are pure functions of
 *              published state (`slamTelegraph`, `boss.attack_timer` + `MUZZLES`), so all
 *              twenty clients draw the same wind-up over the same column with no new byte
 *              on chain and no new notification.
 *   knights    one `<g>` per occupied seat, sorted by authoritative `y` so a knight in
 *              front of another is drawn in front of them.
 *   rim        the pit's near wall, drawn AGAIN on top of everything, so the hands grip a
 *              rim that is in front of them and the knights stand *inside* a pit.
 *   spawn      the opening light, over all of it and pointer-transparent.
 *
 * Three things in here were measured and must not be undone:
 *
 *   1. The LOCAL seat renders from `predictor.self`, chased in the rAF loop; every REMOTE
 *      seat renders from `useSeatInterpolation`. That split took static frames during a
 *      fight from 200 to 52. `predictor.ready` gates it.
 *   2. The frame loop is the ONLY writer of a bullet's and the local seat's transform.
 *      A node carrying an inline transform *and* a running animation silently discards the
 *      inline write; one writer per node is mechanical here, not a discipline.
 *   3. The camera is a `<g>` transform. Animating the `viewBox` attribute measured
 *      9.6 ms/frame against ~1.7 for the identical scene on a transform.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  GATE_MAX_X,
  GATE_MAX_Y,
  GATE_MIN_X,
  GATE_MIN_Y,
  MAP_TILE,
  MUZZLES,
  NO_TARGET,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_MUSTERING,
  PIT_BOT,
  PIT_TOP,
  SLAM_LANE_W,
  SLAM_TELEGRAPH_TICKS,
  TICK_MS,
  slamTelegraph,
  type ArenaAccount,
  type BossAccount,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

import { useSeatInterpolation, type Predictor } from '../../../app/src/net/predict';
import { Boss } from '../../../app/src/render/Boss';
import { Knight, knightDrawOrder } from '../../../app/src/render/Knight';
import { SCENE } from '../../../app/src/render/Scene';
import { Spawn } from '../../../app/src/render/Spawn';
import {
  ARENA_UNITS,
  BULLET_R,
  MAP_ENTRANCE_PATH,
  MAP_RIM_PATH,
  MAP_WALL_PATH,
  PAL,
} from '../../../app/src/render/sprites';

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

// ---------------------------------------------------------------------------
// The camera
// ---------------------------------------------------------------------------

/**
 * The lobby framing, derived rather than typed: centred on the gate the whole lobby is
 * built around, sitting on the bottom edge of the world, at an INTEGER zoom so both ends
 * of the pan land on whole device pixels.
 *
 * This is also the boss reveal the brief asks for. The creature stands at `BOSS_SPAWN`
 * from `init` onward and is simply off-camera; walking the doorway pans it into frame.
 * Zero chain machinery buys the entire reveal.
 */
const LOBBY_ZOOM = 2;
const LOBBY_SPAN = ARENA_UNITS / LOBBY_ZOOM;
const LOBBY_X = (GATE_MIN_X + GATE_MAX_X + 1) / 2 - LOBBY_SPAN / 2;
const LOBBY_Y = ARENA_UNITS - LOBBY_SPAN;

const CAM_LOBBY = `scale(${LOBBY_ZOOM}) translate(${-LOBBY_X}px, ${-LOBBY_Y}px)`;
const CAM_ARENA = 'scale(1) translate(0px, 0px)';

/**
 * How long the pit reveal takes. A camera has no twin on chain — it is the one duration in
 * this file that is allowed to be a local number, because nothing on chain is waiting for
 * it and no two clients need to agree on it.
 */
const CAMERA_MS = 900;
const CAMERA_EASE = 'cubic-bezier(0.65, 0, 0.20, 1)';

// ---------------------------------------------------------------------------
// Telegraph geometry
// ---------------------------------------------------------------------------

/** The lane a slam claims, floor to ceiling of the raider box. */
const LANE_H = PIT_BOT - PIT_TOP + 1;

/** The wind-up, in ms, from the chain's own tick count. Never a keyframe literal. */
const WINDUP_MS = SLAM_TELEGRAPH_TICKS * TICK_MS;

/**
 * The volley currently being wound up: which live muzzle fires at whom, and how long is
 * left. `spawn_volley` aims every barrel at the nearest live player and gates each one on
 * its own thorn's HP, so this is the *exact* set of lines about to be drawn in bullets —
 * derived from `attack_timer`, `target_seat`, `parts` and `MUZZLES`, all published.
 *
 * It reuses `SLAM_TELEGRAPH_TICKS` as its window rather than inventing a second one: the
 * game has one wind-up length, the chain publishes it, and two wind-ups of different
 * lengths would teach the player two different things about the same 1.5 seconds.
 */
function volleyTelegraph(
  arena: ArenaAccount,
  boss: BossAccount,
  players: PlayersAccount,
): { lines: Array<readonly [number, number, number, number]>; ticksToImpact: number } | null {
  if (arena.phase !== PHASE_FIGHTING) return null;
  if (boss.targetSeat === NO_TARGET) return null;
  // `attack_timer` is decremented every tick and the volley leaves on the tick it reads
  // zero, so the published value IS the number of ticks until impact.
  if (boss.attackTimer > SLAM_TELEGRAPH_TICKS) return null;
  const target = players.slots[boss.targetSeat];
  if (target === undefined || !target.occupied || target.hp === 0) return null;

  const lines: Array<readonly [number, number, number, number]> = [];
  for (const m of MUZZLES) {
    if ((boss.parts[m.part] ?? 0) === 0) continue;
    lines.push([boss.x + m.x, boss.y + m.y, target.x, target.y] as const);
  }
  return lines.length === 0 ? null : { lines, ticksToImpact: boss.attackTimer };
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
   * extrapolation and to seek a telegraph — never to derive game state. `arena.tick` is
   * the clock; the crank promises no wall-clock period.
   */
  tickMs?: number;
  className?: string;
}

export function ArenaFixed({
  arena,
  boss,
  players,
  localSeat,
  predictor,
  tickMs = TICK_MS,
  className,
}: ArenaProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const reduced = usePrefersReducedMotion();

  const crisp = usePixelFit(boxRef, svgRef);

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

  const nodes = useRef(new Map<number, SVGLineElement>());
  const bulletRefs = useRef<((el: SVGLineElement | null) => void)[]>([]);
  const bulletRef = (slot: number): ((el: SVGLineElement | null) => void) => {
    let f = bulletRefs.current[slot];
    if (f === undefined) {
      f = (el): void => {
        if (el) nodes.current.set(slot, el);
        else nodes.current.delete(slot);
      };
      bulletRefs.current[slot] = f;
    }
    return f;
  };
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

  // ---- the camera -------------------------------------------------------
  //
  // Sole writer of `#camera`'s transform, WAAPI only: no React attribute, no inline style.
  // The first pass runs at duration 0, which is how the resting framing is set without a
  // second writer arguing with the pan over the same property.
  const cameraRef = useRef<SVGGElement | null>(null);
  const cameraAnim = useRef<Animation | null>(null);
  const cameraFrom = useRef<string | null>(null);
  const wide = arena.phase === PHASE_LOBBY || arena.phase === PHASE_MUSTERING;
  useLayoutEffect(() => {
    const el = cameraRef.current;
    if (el === null) return;
    const to = wide ? CAM_LOBBY : CAM_ARENA;
    const from = cameraFrom.current;
    if (from === to) return;
    cameraAnim.current?.cancel();
    // Reduced motion asks for a cut, not a faster pan — a full-frame translate is the one
    // genuinely vestibular thing in this scene.
    const duration = from === null || reduced ? 0 : CAMERA_MS;
    cameraAnim.current = el.animate(
      from === null ? [{ transform: to }] : [{ transform: from }, { transform: to }],
      { duration, easing: CAMERA_EASE, fill: 'both' },
    );
    cameraFrom.current = to;
  }, [wide, reduced]);

  // ---- the two telegraphs -----------------------------------------------
  //
  // SEEKED, per the animation contract: one animation built at its true duration, its
  // `currentTime` set from the chain's own countdown on each notification. It runs
  // composited between notifications and self-corrects on every one, and it never touches
  // the rAF loop. Both dedupe on the countdown VALUE, so the Magic Router's duplicate
  // delivery re-seeks nothing.
  const slam = slamTelegraph(arena, boss);
  const slamRef = useRef<SVGRectElement | null>(null);
  const slamElapsed = slam === null || reduced ? null : (SLAM_TELEGRAPH_TICKS - slam.ticksToImpact) * tickMs;
  useSeeked(slamRef, SLAM_KEYFRAMES, WINDUP_MS, slamElapsed);

  const volley = volleyTelegraph(arena, boss, players);
  const volleyRef = useRef<SVGGElement | null>(null);
  const volleyElapsed = volley === null || reduced ? null : (SLAM_TELEGRAPH_TICKS - volley.ticksToImpact) * tickMs;
  useSeeked(volleyRef, VOLLEY_KEYFRAMES, WINDUP_MS, volleyElapsed);

  // How far through the wind-up we are, 0..1 — only read on the reduced-motion path, where
  // a telegraph becomes a shape that FILLS by attribute rather than one that animates.
  // "No information may exist only in motion" is the rule that forces this to exist.
  const slamFill = slam === null ? 0 : 1 - slam.ticksToImpact / SLAM_TELEGRAPH_TICKS;

  // ---- the static layers ------------------------------------------------
  //
  // Each is one memo with an empty dependency list, so React holds one identical element
  // reference and skips the whole subtree on every update from here on. Rebuilding a layer
  // of this size per notification is the measured way to crash a renderer process — 11.2
  // ms a frame, and 3/3 crashes at 300 frames. `SCENE` needs no memo at all: it is one
  // element built at module load, so its reference is already constant.
  const overlay = useMemo(
    () => (
      <g>
        {/* Every solid tile, over the temple. `SCENE` replaces the floor fill and nothing
            else: a wall the art hides is a legal-looking move the chain rejects, which is
            this project's signature misdiagnosis. */}
        <path d={MAP_WALL_PATH} fill={PAL.wall} />
        <path d={MAP_RIM_PATH} fill={PAL.rim} />
        {/* The four `E` respawn marks. Walkable floor, so a tint and not a wall — but a
            player who has just died needs to know where they are about to reappear. */}
        <path d={MAP_ENTRANCE_PATH} fill={PAL.entrance} opacity={0.18} />
        {/* The gate. Without it drawn, "walk to the doorway" is a guess — this 4x2 tile
            block is the whole of matchmaking and it is plain floor in the map grid. */}
        <rect
          x={GATE_MIN_X}
          y={GATE_MIN_Y}
          width={GATE_MAX_X - GATE_MIN_X + 1}
          height={GATE_MAX_Y - GATE_MIN_Y + 1}
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
  const rim = useMemo(
    () => (
      // The pit's near wall, drawn a second time OVER everything: the boss's hands grip a
      // rim that is in front of them, and a knight at the bottom of the pit stands behind
      // it. It is the same generated wall geometry the chain collides against, clipped to
      // the two rim rows, so it cannot disagree with the map about where the wall is.
      <g clipPath="url(#heartrot-rim-clip)">
        <path d={MAP_WALL_PATH} fill={PAL.wall} />
        <path d={MAP_RIM_PATH} fill={PAL.rim} />
      </g>
    ),
    [],
  );

  // Sorted at notification rate, never per frame: a knight lower on the screen is nearer,
  // so it is drawn later. Authoritative `y` on every seat including the local one — the
  // local knight drawn out of order would jump in front of an ally it is standing behind.
  const drawOrder = useMemo(() => knightDrawOrder(players.slots), [players]);

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
        // Crisp only where a whole number of device pixels is available. Below 1:1 there is
        // no integer to snap to, and snapping anyway drops a different row of a 19%-keyline
        // sprite on every frame it translates through — flicker, where softness is the
        // better failure.
        shapeRendering={crisp ? 'crispEdges' : 'geometricPrecision'}
        style={{ display: 'block' }}
        role="img"
        aria-label={`Boss arena, tick ${arena.tick}, ${arena.aliveCount} raiders alive`}
      >
        <defs>
          <clipPath id="heartrot-rim-clip">
            <rect x={0} y={PIT_BOT + 1 - 2 * MAP_TILE} width={ARENA_UNITS} height={2 * MAP_TILE} />
          </clipPath>
        </defs>

        <g ref={cameraRef} id="camera">
          {SCENE}
          {overlay}

          {/* Beneath the boss: a bullet's first frames belong inside the silhouette that
              fired it. Each is a capsule stretched back along its own velocity — at 42
              units per tick a 4-unit dot jumps ~7 units per frame and strobes, and the
              trail is what makes 420 u/s legible rather than merely correct. */}
          <g>
            {arena.bullets.map((b, slot) =>
              b.active === 0 ? null : (
                <line
                  key={slot}
                  ref={bulletRef(slot)}
                  x1={0}
                  y1={0}
                  x2={-b.dx * BULLET_TRAIL}
                  y2={-b.dy * BULLET_TRAIL}
                  stroke={PAL.bullet}
                  strokeWidth={BULLET_R * 2}
                  strokeLinecap="round"
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

          <Boss boss={boss} arena={arena} />

          {/* The slam lane. Drawn over the boss because the hand that lands in it is drawn
              over it too, and a wind-up you cannot see through the mace is not a wind-up.
              Under reduced motion the same shape FILLS by height instead of scaling. */}
          {slam !== null && (
            <g aria-hidden="true">
              <rect
                ref={slamRef}
                x={slam.lane * SLAM_LANE_W}
                y={PIT_TOP}
                width={SLAM_LANE_W}
                height={reduced ? LANE_H * slamFill : LANE_H}
                fill={PAL.partLive}
                opacity={reduced ? 0.35 : 0}
                style={reduced ? undefined : { transformBox: 'fill-box', transformOrigin: 'top' }}
              />
              <rect
                x={slam.lane * SLAM_LANE_W}
                y={PIT_TOP}
                width={SLAM_LANE_W}
                height={LANE_H}
                fill="none"
                stroke={PAL.bossEdge}
                strokeWidth={3}
                strokeDasharray="12 10"
                opacity={0.85}
              />
            </g>
          )}

          {/* Where the next volley goes. `spawn_volley` fans around exactly these lines,
              so this is the shot itself drawn 1.5 s early, not an impression of one. */}
          {volley !== null && (
            <g ref={volleyRef} aria-hidden="true" opacity={reduced ? 0.5 : 0}>
              {volley.lines.map(([x1, y1, x2, y2], i) => (
                <line
                  key={i}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={PAL.bossEdge}
                  strokeWidth={2}
                  strokeDasharray="6 10"
                />
              ))}
            </g>
          )}

          <g>
            {drawOrder.map((slot) => {
              // Any seated player, in either zone. `zone` is a one-way flag on the SAME
              // map — everyone spawns in ZONE_LOBBY and walks to the gate — so filtering
              // to ZONE_ARENA drew an empty room for the whole of the lobby, which is the
              // one phase where you have to be able to see yourself to play.
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
              return (
                // The frame loop (local seat) or `useSeatInterpolation` (everyone else) owns
                // this node's transform outright — nothing else may put a transform
                // attribute on it, which is why `Knight` renders the CHILDREN of this node
                // and never the node. `will-change` measured as a no-op on a real GPU and
                // 36–85× on software raster: one free line for the devices nobody tested.
                <g
                  key={slot.seat}
                  ref={predicted ? selfRef : seats.ref(slot.seat)}
                  style={{ willChange: 'transform' }}
                >
                  <Knight slot={slot} tick={arena.tick} mine={mine} reduced={reduced} />
                </g>
              );
            })}
          </g>

          {rim}

          {/* Last, so the opening light sits over the boss, the raiders and the bullets and
              pans with them. Pointer-transparent, and nothing waits for it. */}
          <Spawn phase={arena.phase} bossX={boss.x} bossY={boss.y} reduced={reduced} />
        </g>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * How far back a bullet's trail reaches, as a fraction of one tick's travel.
 *
 * Not a look: at `BULLET_UNITS_PER_SEC = 420` a bullet crosses ~7 units between frames and
 * is 8 wide, so a dot strobes. Half a tick of stretch closes that gap without drawing a
 * bullet anywhere the chain does not have one — the head of the capsule is the position.
 */
const BULLET_TRAIL = 0.5;

/** The lane goes from a hint to a claim as the hand comes down. */
const SLAM_KEYFRAMES: Keyframe[] = [
  { opacity: 0.08, transform: 'scaleY(0)' },
  { opacity: 0.5, transform: 'scaleY(1)' },
];

/** The aim lines brighten into the shot. */
const VOLLEY_KEYFRAMES: Keyframe[] = [{ opacity: 0.1 }, { opacity: 0.8 }];

/**
 * A SEEKED animation: built once at its true duration, played, and re-seeked from a chain
 * countdown whenever that countdown CHANGES.
 *
 * Seeking on arrival instead of on change is the trap: 68.4% of `Players` notifications in
 * a fight carry no change and the Magic Router delivers every one twice, so a duplicate
 * landing 20 ms late would rewind the wind-up 20 ms, twice a second. Comparing the value
 * makes a duplicate a no-op by construction, with no bookkeeping.
 *
 * `elapsed === null` means "nothing is winding up" and cancels, which is also what the
 * reduced-motion path passes — it draws the same information as a filling attribute.
 */
function useSeeked<T extends Element>(
  node: React.RefObject<T | null>,
  keyframes: Keyframe[],
  durationMs: number,
  elapsedMs: number | null,
): void {
  const anim = useRef<Animation | null>(null);
  const seen = useRef<number | null>(null);
  const frames = useRef(keyframes);
  frames.current = keyframes;
  // No dependency array: the guard is the value, and a ref that only just attached has to
  // be picked up on the very next commit rather than on the next state change.
  useEffect(() => {
    const el = node.current;
    if (el === null || elapsedMs === null || durationMs <= 0) {
      anim.current?.cancel();
      anim.current = null;
      seen.current = null;
      return;
    }
    if (anim.current === null) {
      anim.current = el.animate(frames.current, { duration: durationMs, fill: 'both' });
    }
    if (seen.current !== elapsedMs) {
      anim.current.currentTime = elapsedMs;
      seen.current = elapsedMs;
    }
  });
}

/**
 * Size the SVG so one arena unit covers a whole number of device pixels, and report
 * whether that was possible.
 *
 * `shape-rendering: crispEdges` snaps every edge to the device grid, so at a fractional
 * effective scale — which is what a 125% OS display scale gives you, dpr 1.1875 — wall
 * edges come out uneven and the unevenness *moves* as the scene translates. Picking the
 * largest integer device scale that fits and working back to a (fractional, correct) CSS
 * size removes the cause. Below 1:1 there is no integer to pick, so the caller drops to
 * `geometricPrecision` instead: softness rather than a keyline that flickers row by row as
 * a sprite walks.
 *
 * ponytail: driven by ResizeObserver alone. Browser zoom resizes the container so it is
 * caught, but a pure device-pixel-ratio change with no layout change (dragging the window
 * to a different-density monitor) is missed until the next resize. Add a `matchMedia
 * (resolution: Ndppx)` listener, re-armed after each change, if that shows up in testing.
 */
function usePixelFit(
  box: React.RefObject<HTMLDivElement | null>,
  svg: React.RefObject<SVGSVGElement | null>,
): boolean {
  const [crisp, setCrisp] = useState(true);
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
      // Only on a change: this runs on every resize frame, and a setState per frame during
      // a window drag is the churn the whole file is built to avoid.
      const integral = raw >= 1;
      setCrisp((was) => (was === integral ? was : integral));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(b);
    return () => ro.disconnect();
  }, [box, svg]);
  return crisp;
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
// and a missing snap slides a respawning corpse across the dungeon.
//
// The composition has two failure modes with the same shape — silent, and wrong in a way
// that reads as lag or as a bug in the chain: a camera framing that does not contain the
// gate, and a slam wind-up drawn over the wrong column. Both are cheap here. Dev-only.
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

  // The lobby framing has to contain the one thing the lobby is for. A camera that cuts
  // the gate off is not a rendering glitch to a player, it is a game with no way in.
  ok(LOBBY_X <= GATE_MIN_X && GATE_MAX_X < LOBBY_X + LOBBY_SPAN, 'the lobby camera frames the gate in x');
  ok(LOBBY_Y <= GATE_MIN_Y && GATE_MAX_Y < LOBBY_Y + LOBBY_SPAN, 'the lobby camera frames the gate in y');
  ok(Number.isInteger(LOBBY_ZOOM), 'both camera scales are integers, so both ends are pixel-exact');

  // The rim occluder must cover the rim rows and nothing the raider box needs to see: a
  // clip one tile out paints a wall over the bottom rows of the pit the knights stand in.
  ok(PIT_BOT + 1 - 2 * MAP_TILE === 576, 'the rim clip starts at the first rim row');

  // Every lane a slam can name is inside the arena, so the drawn column and the column
  // `damage_seat` tests are the same column.
  ok(SLAM_LANE_W * 8 === ARENA_UNITS, 'the slam lanes tile the arena exactly');
  ok(LANE_H > 0 && PIT_TOP + LANE_H - 1 === PIT_BOT, 'the lane spans the raider box');

  // The wind-up derives from the chain's own tick count. A hand-typed 1500 here stops
  // matching the attack the first time anyone tunes SLAM_TELEGRAPH_TICKS.
  ok(WINDUP_MS === SLAM_TELEGRAPH_TICKS * TICK_MS, 'the wind-up is the chain constant');

  // The documented trap, in executable form: the ticks that TELEGRAPH a slam divide to the
  // previous cycle, so a client that asks `slamLane` about the tick it is rendering always
  // gets null and draws nothing — or worse, mixes its own cycle index and lights the wrong
  // column. `slamTelegraph` is the only correct question, and this proves it stays pointed
  // at the beat that actually lands.
  const seed = new Uint8Array(32);
  seed[0] = 0x5a;
  seed[3] = 0xc3;
  const shell: BossAccount = {
    bump: 0,
    ventOpen: 0,
    attackTimer: 0,
    targetSeat: NO_TARGET,
    x: 512,
    y: 400,
    coreHp: 2000,
    coreHpMax: 2000,
    parts: [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500],
    partsMax: [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500],
  };
  const fakeArena = (tick: number): ArenaAccount =>
    ({ phase: PHASE_FIGHTING, tick, affixSeed: seed }) as unknown as ArenaAccount;
  const landing = slamTelegraph(fakeArena(59), shell);
  if (landing === null) throw new Error('Arena self-check: a slam is telegraphed on the tick before it lands');
  for (let t = 60 - SLAM_TELEGRAPH_TICKS; t < 60; t++) {
    const seen = slamTelegraph(fakeArena(t), shell);
    if (seen === null) throw new Error('Arena self-check: the wind-up is drawn for its whole window');
    ok(seen.lane === landing.lane, 'the wind-up names one lane for its whole window');
    ok(seen.atTick === 60 && seen.ticksToImpact === 60 - t, 'the wind-up counts down to the landing tick');
  }
  ok(slamTelegraph(fakeArena(60 - SLAM_TELEGRAPH_TICKS - 1), shell) === null, 'nothing is drawn before the window');

  // A volley telegraph is the shot itself, drawn early: one line per LIVE muzzle. Shooting
  // a thorn off must silence its line, or the player is dodging a gun that no longer fires.
  const one = (over: Partial<PlayerSlot>): PlayersAccount =>
    ({ slots: [{ seat: 0, occupied: true, hp: 100, x: 512, y: 500, ...over } as PlayerSlot] }) as PlayersAccount;
  const aiming: BossAccount = { ...shell, targetSeat: 0, attackTimer: 3 };
  const shot = volleyTelegraph(fakeArena(100), aiming, one({}));
  if (shot === null) throw new Error('Arena self-check: an aimed volley telegraphs');
  ok(shot.lines.length === MUZZLES.length, 'every live muzzle draws its own line');
  ok(shot.ticksToImpact === 3, 'the volley counts down on attack_timer');
  const disarmed = volleyTelegraph(
    fakeArena(100),
    { ...aiming, parts: [0, 0, 0, 0, 4000, 2500, 2500, 2500, 2500] },
    one({}),
  );
  ok(disarmed === null, 'a boss with every thorn shot off telegraphs nothing');
  ok(
    volleyTelegraph(fakeArena(100), { ...aiming, attackTimer: SLAM_TELEGRAPH_TICKS + 1 }, one({})) === null,
    'the volley is only drawn inside the wind-up window',
  );
  ok(volleyTelegraph(fakeArena(100), aiming, one({ hp: 0 })) === null, 'no line is drawn to a corpse');
  ok(
    volleyTelegraph({ ...fakeArena(100), phase: PHASE_LOBBY }, aiming, one({})) === null,
    'nothing is telegraphed outside a fight',
  );
}
