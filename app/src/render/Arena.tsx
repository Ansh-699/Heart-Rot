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
  LOBBY_SPAWN_MAX_X,
  LOBBY_SPAWN_Y,
  LOBBY_SPAWN_MIN_X,
  GATE_MIN_Y,
  MAP_TILE,
  MAX_BULLETS,
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
  onGate,
  slamTelegraph,
  type ArenaAccount,
  type BossAccount,
  type Bullet,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

import { useSeatInterpolation, type PredictedSelf, type Predictor } from '../net/predict';
import { Boss } from './Boss';
import { KNIGHT_POSE_DEFS, Knight, knightDrawOrder } from './Knight';
import { SCENE } from './Scene';
import { Spawn } from './Spawn';
import {
  ARENA_UNITS,
  BULLET_R,
  MAP_ENTRANCE_PATH,
  MAP_RIM_PATH,
  MAP_WALL_PATH,
  PAL,
  SELF_SNAP,
} from './sprites';

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
 * How many bullets are DRAWN. `MAX_BULLETS` is 128 and stays 128: it is a chain fact, and
 * so is `bullets_per_volley = 3 + alive_count`. This caps the picture, never the
 * simulation — the client must not disagree with the crank about what is on the board.
 *
 * Measured (`docs/perf/frame-budget.md`), 20 knights + full art + the real 714 notif/s
 * feed at 6x CPU throttle: 128 drawn is 11.46 ms p50 / 16.96 p95 with 7.2% of frames over
 * budget; 32 drawn is 9.38 / 14.92 with 4.6% over, and the client services 72 notifications
 * a second instead of 61. Nothing else measured was worth half of it. The live instrument
 * saw only 13-15 bullets in flight at 20 seats, so the cap is almost never reached — which
 * is also why the ranking below is allowed to cost anything at all.
 */
const VISIBLE_BULLETS = 32;

/**
 * How far ahead a bullet is looked at when ranking it. The game already has exactly one
 * answer to "about to happen" — the wind-up it telegraphs both attacks over — and a second
 * number here would teach the player two different lengths of "soon". Derived, never typed:
 * `SLAM_TELEGRAPH_TICKS` is the chain's, and a bullet's `dx`/`dy` are per tick, so the
 * horizon is a tick count and no `tickMs` enters it.
 */
const BULLET_HORIZON_TICKS = SLAM_TELEGRAPH_TICKS;

/**
 * Squared distance of a bullet's CLOSEST APPROACH to the nearest live raider inside the
 * next {@link BULLET_HORIZON_TICKS}. `Infinity` when nobody is alive to be hit.
 *
 * The bullet travels `(dx, dy)` per tick from `(x, y)`, so against a raider at `r` the
 * approach is minimised at `t = (r·d)/(d·d)` — clamped into `[0, horizon]`, which is what
 * makes the two ends behave. A bullet that has already gone past everyone clamps to `t = 0`
 * and is scored on how far away it is NOW, so it ranks worst; one that will not arrive
 * inside the wind-up clamps to the horizon and is scored on how near it gets by then.
 * Squared throughout: nothing here needs the metre, only the order.
 */
function bulletRisk(b: Bullet, slots: readonly PlayerSlot[]): number {
  const dd = b.dx * b.dx + b.dy * b.dy;
  let best = Infinity;
  for (const p of slots) {
    if (!p.occupied || p.hp === 0) continue;
    const rx = p.x - b.x;
    const ry = p.y - b.y;
    let t = dd === 0 ? 0 : (rx * b.dx + ry * b.dy) / dd;
    if (t < 0) t = 0;
    else if (t > BULLET_HORIZON_TICKS) t = BULLET_HORIZON_TICKS;
    const mx = rx - t * b.dx;
    const my = ry - t * b.dy;
    const m = mx * mx + my * my;
    if (m < best) best = m;
  }
  return best;
}

/**
 * Which pool slots get a `<line>`: every live bullet while the pool holds no more than
 * {@link VISIBLE_BULLETS}, and past that the {@link VISIBLE_BULLETS} most DANGEROUS ones.
 *
 * Slot index is arrival order in a ring, not danger, so a first-32 slice drops whichever
 * bullets happen to sit high in the pool — including the one arriving at the player's feet
 * while thirty-one that already missed are drawn. Ranking by {@link bulletRisk} keeps the
 * ones converging on somebody and spends the cut on the ones that have already gone past,
 * which is the only class a player can safely be shown fewer of.
 *
 * The scan is `O(live x seats)` and runs ONLY over the cap — at the 13-15 bullets the live
 * instrument sees at 20 seats (spec §12.11) this is the plain filter it was before, and the
 * ranking costs nothing until there is something to rank. Returned in ascending slot order
 * so the drawn list stays monotone and React reorders nothing it does not have to.
 *
 * Pure, so the cap and the ranking are both checkable without a renderer.
 */
function visibleBullets(bullets: readonly Bullet[], slots: readonly PlayerSlot[]): number[] {
  const live: number[] = [];
  for (let slot = 0; slot < bullets.length; slot++) {
    if (bullets[slot]!.active !== 0) live.push(slot);
  }
  if (live.length <= VISIBLE_BULLETS) return live;
  const risk = live.map((slot) => bulletRisk(bullets[slot]!, slots));
  // Sorted by rank, then cut, then put back in slot order. `sort` is stable, so with no
  // live raider (every risk `Infinity`) this degrades to exactly the index-order slice —
  // which is why the comparator is a three-way and not a subtraction: `Infinity - Infinity`
  // is `NaN`, and a comparator that returns `NaN` has no defined order at all.
  return live
    .map((_, i) => i)
    .sort((a, b) => (risk[a]! === risk[b]! ? 0 : risk[a]! < risk[b]! ? -1 : 1))
    .slice(0, VISIBLE_BULLETS)
    .map((i) => live[i]!)
    .sort((a, b) => a - b);
}

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
// Framed on the gate AND every lobby spawn, not the gate alone.
//
// `lobby_spawn` fans the seats symmetrically about `LOBBY_ENTRANCE`, so they span
// x 208..664 while a gate-centred window showed 256..768 — seats 0 and 1 stood outside it
// and drew nothing a player could find. Seat 0 is what the FIRST player to join gets, so
// the default experience of the game was an empty room with a knight you never see.
// Nothing was broken in the sprite path; the camera was pointed at the wrong place.
const LOBBY_FOCUS_MIN = Math.min(GATE_MIN_X, LOBBY_SPAWN_MIN_X);
const LOBBY_FOCUS_MAX = Math.max(GATE_MAX_X, LOBBY_SPAWN_MAX_X);
const LOBBY_X = Math.max(
  0,
  Math.min(
    ARENA_UNITS - LOBBY_SPAN,
    Math.round((LOBBY_FOCUS_MIN + LOBBY_FOCUS_MAX + 1) / 2 - LOBBY_SPAN / 2),
  ),
);
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

/**
 * The predicted seat's slot: authoritative in every field except the three the prediction
 * already owns.
 *
 * `Arena` draws the local seat's `<g>` from `predictor.self` but was handing `Knight` the
 * authoritative slot, so the body moved ~32 ms after the keypress while the gait and the
 * facing flip — which `advance` folds out of `x`/`y`/`facing` — started a round trip later
 * and kept running that long after the player stopped (`docs/review/render.md` finding 5).
 *
 * The identity discipline is the whole of the risk. `Knight` folds a snapshot exactly when
 * the object it is handed is a NEW one (`Knight.tsx:259`), so a fresh object per render
 * would re-fold at the render rate and double-count every shot and every hurt, while one
 * mutated in place would never fold again at all. So: a cached object, replaced only when
 * something it carries actually changed — one fold per authoritative payload, as before,
 * plus one per predicted step. The extra folds are pure value diffs on `hp`, `deaths` and
 * `lastShotTick` (`Knight.tsx:186`), so a fold that carries no event fires nothing.
 */
function predictedSlot(
  cache: { src: PlayerSlot | null; out: PlayerSlot | null },
  slot: PlayerSlot,
  self: PredictedSelf,
): PlayerSlot {
  const out = cache.out;
  if (
    out !== null &&
    cache.src === slot &&
    out.x === self.x &&
    out.y === self.y &&
    out.facing === self.facing
  ) {
    return out;
  }
  cache.src = slot;
  cache.out = { ...slot, x: self.x, y: self.y, facing: self.facing };
  return cache.out;
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

export function Arena({
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

  // `tickMs`, not the `TICK_MS` default: the ceiling on the interpolation window has to be
  // the crank period the worker actually reports, or every remote seat paces itself against
  // a 100 ms the crank never promised (`docs/review/render.md`, minor 1).
  const seats = useSeatInterpolation(players, reduced, tickMs);

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
  // The local seat's `<g>`, owned by the frame loop the way `nodes` owns the bullets.
  const selfNode = useRef<SVGGElement | null>(null);
  // The gate's under-foot light. Same ownership rule: the frame loop writes its opacity and
  // React never does, so standing on the tile lights it at input rate rather than 127 ms
  // later (`docs/review/render.md` finding 4). It hints; `useGateEntry` still sends.
  const gateNode = useRef<SVGRectElement | null>(null);
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

        // Off the DRAWN position, not the authoritative one: the light has to appear under
        // the foot the player can see, and `onGate` is the same predicate `enter_gate`
        // checks. Written only on a change — this runs every frame and the value flips
        // twice per visit.
        const gate = gateNode.current;
        if (gate !== null) {
          const lit = onGate(at.x, at.y) ? '1' : '0';
          if (gate.style.opacity !== lit) gate.style.opacity = lit;
        }
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
  // The wind-up, in ms, from the chain's own tick count and the crank period the worker
  // reports — the SAME `tickMs` the elapsed times below are seeked with. Deriving the
  // duration from the `TICK_MS` constant while seeking with the prop put the animation and
  // its playhead on two different clocks the moment the crank ran at anything but 100 ms
  // (`docs/review/render.md`, minor 1).
  const windupMs = SLAM_TELEGRAPH_TICKS * tickMs;

  const slam = slamTelegraph(arena, boss);
  const slamRef = useRef<SVGRectElement | null>(null);
  const slamElapsed = slam === null || reduced ? null : (SLAM_TELEGRAPH_TICKS - slam.ticksToImpact) * tickMs;
  useSeeked(slamRef, SLAM_KEYFRAMES, windupMs, slamElapsed);

  const volley = volleyTelegraph(arena, boss, players);
  const volleyRef = useRef<SVGGElement | null>(null);
  const volleyElapsed = volley === null || reduced ? null : (SLAM_TELEGRAPH_TICKS - volley.ticksToImpact) * tickMs;
  useSeeked(volleyRef, VOLLEY_KEYFRAMES, windupMs, volleyElapsed);

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
      //
      // `pit-rim` is `art.md` fix 5a: the rule (`drop-shadow(0 -2px 0 …)`, cold light down
      // the near face) was written in `styles.css` and matched no node, so the strongest
      // depth cue in the composition was drawn nowhere. The class goes on this `<g>` and
      // not on either `<path>` — the shadow is of the rim silhouette, and two shadows on
      // two overlapping paths would draw the wall's edge through the rim's.
      <g className="pit-rim" clipPath="url(#heartrot-rim-clip)">
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

  // One cached slot for the predicted seat, see `predictedSlot`. A ref and not a memo: it
  // is keyed on a mutable position no dependency array can watch.
  const poseCache = useRef<{ src: PlayerSlot | null; out: PlayerSlot | null }>({ src: null, out: null });

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
          {/* The boss ends at the rim. At SCALE=3 the sprite is 810 units tall and reaches
              world y 805 — 200 units BELOW the pit — so the legs and the lower claw were
              drawn straight down the temple approach, over the stairs and the gate, in
              full view of the lobby camera. That is not a rig bug: spec §1.2's own
              footprint has the mace at y 301..711 while §1.4 assumes the boss is
              off-camera during the lobby, and both cannot hold.
              Clipped here rather than inside `Boss`: `clip-path` resolves against the
              element's own transform, and `.hr-boss` carries `translate(boss.x, boss.y)`,
              so a clip there moves with the boss instead of staying on the rim. Cut at
              `PIT_BOT + 1`, which is the BOTTOM of the rim band the occluder redraws over
              everything — so the cut edge lands under the rim and the hands read as
              gripping it, which is the composition the reference is built on. */}
          <clipPath id="heartrot-boss-clip">
            <rect
              x={-ARENA_UNITS}
              y={-ARENA_UNITS}
              width={3 * ARENA_UNITS}
              height={ARENA_UNITS + PIT_BOT + 1}
            />
          </clipPath>
          {/* The fifteen knight poses, mounted once. Every seat draws `<use href="#kN-…">`
              against these, and a dangling href renders nothing and throws nothing — so
              without this line the pit is twenty invisible knights and no error anywhere.
              A module-scope constant, so React never walks its ~4,300 subpaths again. */}
          {KNIGHT_POSE_DEFS}
        </defs>

        <g ref={cameraRef} id="camera">
          {SCENE}
          {overlay}

          {/* The gate lighting up under your feet. Outside `overlay`'s memo because it is
              the one part of that layer that is not static — the frame loop owns its
              opacity and nothing else may set it, which is why React gives it none. It is
              feedback, never a send: `enter_gate` stays on `useGateEntry`'s authoritative
              poll, and the version that fired from the input path stranded players. */}
          <rect
            ref={gateNode}
            aria-hidden="true"
            x={GATE_MIN_X}
            y={GATE_MIN_Y}
            width={GATE_MAX_X - GATE_MIN_X + 1}
            height={GATE_MAX_Y - GATE_MIN_Y + 1}
            fill={PAL.ventOpen}
            fillOpacity={0.3}
            stroke={PAL.ventOpen}
            strokeWidth={3}
            // Snaps rather than fades: the whole point is that it answers the keypress, and
            // a 90 ms cross-fade is 90 ms of the lag this exists to remove.
            style={{ opacity: 0, pointerEvents: 'none' }}
          />

          {/* Beneath the boss: a bullet's first frames belong inside the silhouette that
              fired it. Each is a capsule stretched back along its own velocity — at 42
              units per tick a 4-unit dot jumps ~7 units per frame and strobes, and the
              trail is what makes 420 u/s legible rather than merely correct. */}
          <g>
            {visibleBullets(arena.bullets, players.slots).map((slot) => {
              const b = arena.bullets[slot];
              if (b === undefined) return null;
              return (
                <line
                  key={slot}
                  ref={(el) => {
                    if (el) nodes.current.set(slot, el);
                    else nodes.current.delete(slot);
                  }}
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
              );
            })}
          </g>

          <g clipPath="url(#heartrot-boss-clip)">
            <Boss boss={boss} arena={arena} />
          </g>

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
              // The pose reads from the same copy of the seat the transform does, or the
              // legs describe a position the body left two tiles ago.
              const posed = predicted ? predictedSlot(poseCache.current, slot, predictor.self) : slot;
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
                  <Knight slot={posed} tick={arena.tick} mine={mine} reduced={reduced} />
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

/**
 * A rAF loop is not a keyframe — it has to be told about reduced motion.
 *
 * The one JS resolver (spec §7.6). CSS gates itself beside the rules it cancels; anything
 * that has to *decide* in JavaScript — the camera pan becoming a cut, the chase easing,
 * `Spawn`'s veil — takes it from here as a prop rather than reading `matchMedia` again.
 */
export function usePrefersReducedMotion(): boolean {
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
  // And the thing the gate is for: the players walking to it. This is the check whose
  // absence shipped a lobby where seat 0 could not see their own knight — the gate was
  // framed perfectly and the spawns were never tested at all.
  ok(
    LOBBY_X <= LOBBY_SPAWN_MIN_X && LOBBY_SPAWN_MAX_X < LOBBY_X + LOBBY_SPAN,
    'the lobby camera frames every seat spawn in x',
  );
  ok(
    LOBBY_Y <= LOBBY_SPAWN_Y && LOBBY_SPAWN_Y < LOBBY_Y + LOBBY_SPAN,
    'the lobby camera frames the spawn row in y',
  );
  ok(LOBBY_Y <= GATE_MIN_Y && GATE_MAX_Y < LOBBY_Y + LOBBY_SPAN, 'the lobby camera frames the gate in y');
  ok(Number.isInteger(LOBBY_ZOOM), 'both camera scales are integers, so both ends are pixel-exact');

  // The rim occluder must cover the rim rows and nothing the raider box needs to see: a
  // clip one tile out paints a wall over the bottom rows of the pit the knights stand in.
  ok(PIT_BOT + 1 - 2 * MAP_TILE === 576, 'the rim clip starts at the first rim row');

  // Every lane a slam can name is inside the arena, so the drawn column and the column
  // `damage_seat` tests are the same column.
  ok(SLAM_LANE_W * 8 === ARENA_UNITS, 'the slam lanes tile the arena exactly');
  ok(LANE_H > 0 && PIT_TOP + LANE_H - 1 === PIT_BOT, 'the lane spans the raider box');

  // The render cap caps DRAWING only, and it must never look like a shorter pool: a pool
  // holding fewer than the cap draws every live bullet, and `MAX_BULLETS` stays 128 on both
  // sides of the wire. Over the cap it is a RANKING, and the thing that must not regress is
  // which bullets survive it — a slice that keeps thirty-one spent tracers and drops the one
  // arriving at a player is worse than not capping at all.
  const pool = (live: number, b: Partial<Bullet> = {}): Bullet[] =>
    Array.from({ length: MAX_BULLETS }, (_, i) => ({
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      ...b,
      active: i < live ? 1 : 0,
    }));
  const noSlots: PlayerSlot[] = [];
  ok(visibleBullets(pool(0), noSlots).length === 0, 'an empty pool draws nothing');
  ok(visibleBullets(pool(15), noSlots).length === 15, 'a pool under the cap draws every live bullet');
  ok(visibleBullets(pool(MAX_BULLETS), noSlots).length === VISIBLE_BULLETS, 'a full pool draws exactly the cap');
  ok(
    visibleBullets(pool(MAX_BULLETS), noSlots)[0] === 0,
    'with nobody alive to rank against, the cap falls back to index order',
  );

  // The ranking itself. One raider stands at (512, 500); the pool is full of bullets that
  // have already flown past them, and slot 127 — the LAST one a first-32 slice would ever
  // reach — is the one about to land on their head.
  const seat = (over: Partial<PlayerSlot>): PlayerSlot =>
    ({ seat: 0, occupied: true, hp: 100, x: 512, y: 500, ...over }) as PlayerSlot;
  const spent = pool(MAX_BULLETS, { x: 512, y: 900, dx: 0, dy: 42 });
  spent[127] = { x: 512, y: 380, dx: 0, dy: 42, active: 1 };
  const drawn = visibleBullets(spent, [seat({})]);
  ok(drawn.length === VISIBLE_BULLETS, 'the ranking still draws exactly the cap');
  ok(drawn.includes(127), 'the bullet about to hit a raider is drawn, whatever slot it landed in');

  // A bullet heading AWAY ranks behind one heading in from the same distance, so the cut is
  // spent tracers first. Both are live, both are equidistant, only the sign differs.
  const away = pool(MAX_BULLETS, { x: 512, y: 380, dx: 0, dy: -42 });
  away[127] = { x: 512, y: 380, dx: 0, dy: 42, active: 1 };
  ok(
    visibleBullets(away, [seat({})]).includes(127),
    'an approaching bullet outranks an identical one that has turned away',
  );

  // A corpse is not a target: ranking against one would spend the whole cap on bullets
  // converging where nobody is standing.
  ok(
    visibleBullets(spent, [seat({ hp: 0 })])[0] === 0,
    'a dead raider ranks nothing, so the cap falls back to index order',
  );

  // Finding 5's identity discipline, which fails in two opposite directions and silently in
  // both: a fresh object per render re-folds `Knight`'s walk at the render rate and
  // double-counts every shot, and one mutated in place never folds again at all.
  const cache: { src: PlayerSlot | null; out: PlayerSlot | null } = { src: null, out: null };
  const auth = seat({ facing: 2 });
  const self: PredictedSelf = { x: 528, y: 500, facing: 2 };
  const first = predictedSlot(cache, auth, self);
  ok(first !== auth && first.x === 528 && first.hp === auth.hp, 'the predicted slot overrides position only');
  ok(predictedSlot(cache, auth, self) === first, 'an unchanged prediction folds nothing');
  self.x = 544;
  const stepped = predictedSlot(cache, auth, self);
  ok(stepped !== first && stepped.x === 544, 'a predicted step folds exactly once');
  const next = seat({ facing: 2, hp: 80 });
  ok(predictedSlot(cache, next, self).hp === 80, 'a new authoritative payload folds even at a standstill');

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
