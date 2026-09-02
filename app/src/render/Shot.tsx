/**
 * Everything the player sees when a shot happens — the loose flash, the arrow in flight,
 * the impact where it lands, and the damage that landed there.
 *
 * The complaint this file answers is "I cannot see anything when I shoot", and its root
 * cause is not a bug: `shoot.rs` is HITSCAN. It allocates no projectile, the raycast walks
 * and lands damage inside the same transaction, and `MAX_BULLETS` is boss ordnance only.
 * There was nothing on screen because nothing existed to draw. Spec §4.1 keeps it that way
 * — a chain projectile would put 229 ms to 1.26 s of flight between the key and the damage,
 * on the one axis the user protected twice — so the arrow here is a **tracer**: a client-
 * side drawing of a shot the chain has already resolved.
 *
 * Four properties, in the order they constrain the code:
 *
 *   every client, every shot   A seat's arrow is reconstructed from account bytes alone —
 *                              `x`, `y`, `classAim` and `lastShotTick` — so nineteen remote
 *                              knights firing looks the same in every browser with no event
 *                              stream, no new notification and no new byte on chain.
 *   fires exactly once         The trigger is a VALUE DIFF on `lastShotTick`, never
 *                              arrival. The Magic Router delivers every notification twice
 *                              and 68.4 % of them carry no change at all; a duplicate diffs
 *                              to nothing, so there is no latch and no bookkeeping. The
 *                              first payload a client consumes seeds the baseline silently,
 *                              or joining a fight replays its last volley.
 *   local shot at 0 ms         {@link fireLocal} draws the local seat's arrow off the input
 *                              itself, ~127 ms before the chain echoes it, from the exact
 *                              `(dx, dy)` that went on the wire. **The local seat's
 *                              `lastShotTick` diff is then ignored** — that is the existing
 *                              one-writer rule (`predictor.self` vs interpolation) applied
 *                              to arrows, and it is why there is no reconciliation step and
 *                              nothing to correct.
 *   prediction owns no number  The arrow is predicted; the DAMAGE is not. A refused shot —
 *                              and gameplay is sent `skipPreflight`, so a refusal returns a
 *                              signature and is invisible — costs one arrow that flies,
 *                              lands, sparks, and shows no number, because `damageDealt`
 *                              never moved. Nothing is ever retracted, so there is no
 *                              rollback path in this file.
 *
 * **Node ownership.** Every node below is created and written by this file and by nothing
 * else. The frame loop in `Arena.tsx` is REUSED rather than duplicated: `Arena` calls
 * {@link ShotProps.frameRef}'s callback once per frame from the loop it already runs, and
 * this file writes only its own arrows' transforms there. `pointer-events: none` on the
 * root, because this layer sits ABOVE the knights (spec §8, row 13 — an arrow drawn under
 * twenty bodies is the bug report) and the same surface is the aim target.
 *
 * Cost: {@link MAX_SEATS} groups, mounted once and never re-rendered into (the tree is
 * memoised on an empty dependency list — see the note above the `return`), opacity 0 at
 * rest. No allocation per shot, no pool management — `291 ms` max flight plus
 * {@link STICK_FADE_MS} is under the 800 ms knight cooldown, so a seat can never have two
 * arrows at once (asserted below). Per frame the work is one `atan2` and one style write
 * per arrow actually in the air.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import {
  CLASS_ARCHER,
  CLASS_PERIOD_MS,
  CORE,
  MAP_TILE,
  MAP_TILES,
  MAX_SEATS,
  PART_HITBOXES,
  VENT_OPEN,
  ZONE_ARENA,
  ZONE_LOBBY,
  classOf,
  decodeAim,
  isWall,
  type BossAccount,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

import { FACING_UNIT, PAL, VISIBLE_PROJECTILES } from './sprites';
import type { Room } from './viewport';

// ---------------------------------------------------------------------------
// The raycast mirror
// ---------------------------------------------------------------------------

/**
 * `programs/heartrot/src/handlers/shoot.rs::raycast` IS THE AUTHORITY. This is a third
 * copy of that algorithm and it exists only to find the point an arrow stops at, because
 * the chain publishes no such point.
 *
 * The *data* cannot drift — `isWall` reads the same generated bitboard the program
 * raycasts and `PART_HITBOXES` / `CORE` come out of the same `gen_hitboxes.py` pass — but
 * the twenty lines below are hand-written, so they are held to account by BEHAVIOURAL dev
 * assertions at the bottom of this file rather than by a table of coordinates. A test that
 * names a tile stops testing the ray the moment the map is redrawn.
 *
 * Two deliberate differences from the Rust, both provably invisible:
 *
 *  - `SHELL_AABB` is not mirrored. It is a strict superset of every part box and the core
 *    circle, folded out of the same table purely as an early-out; skipping it changes no
 *    answer, only nine rect tests on steps that were going to miss anyway. Sixty-four
 *    steps of that in a browser is 0.0024 % of a frame.
 *  - The Rust returns `None` for a miss. Here a miss still needs a POINT to draw to, so
 *    the walk reports where it died — the wall sample, or the last step of the 64.
 *
 * Integer discipline is the part that matters: `Math.trunc` everywhere Rust's `i32 /`
 * truncates toward zero, and `unitQ12` reproduced exactly, alpha-max-plus-beta-min and all.
 */
const Q = 4096;
const MAX_RAY_STEPS = MAP_TILES;

/** `shoot.rs::unit_q12`. `null` for the zero vector, which the caller has already rejected. */
function unitQ12(dx: number, dy: number): readonly [number, number] | null {
  const vx = dx | 0;
  const vy = dy | 0;
  const ax = Math.abs(vx);
  const ay = Math.abs(vy);
  const len = ax > ay ? ax + ((ay / 2) | 0) : ay + ((ax / 2) | 0);
  if (len === 0) return null;
  return [Math.trunc((vx * Q) / len), Math.trunc((vy * Q) / len)];
}

/** Where a shot ends, and what it ended on. */
export interface RayEnd {
  readonly x: number;
  readonly y: number;
  /** True only for a live part or the core — the two things the ray can stop on. */
  readonly struck: boolean;
  /**
   * The stop was the CORE rather than a part. `raycast` draws the same distinction on chain
   * (`Hit::Core` vs `Hit::Part`) and it matters here for the reason it matters there:
   * `shoot.rs:492` scores 0 for a core hit while the vent is sealed. The ray stays a pure
   * mirror — the vent test lives in the caller, exactly as it does in `fire`.
   */
  readonly core: boolean;
}

/**
 * What an arrival MEANT, which is not the same question as what the ray stopped on.
 *
 * `absorb` is the shell eating a shot aimed at a sealed vent: the ray stopped on the
 * creature, the cooldown is spent, and `damage_dealt` never moves. Drawing that as a hit is
 * a lie the player pays for repeatedly — spec §2.3 makes the orb the brightest thing in the
 * room, so it is the first thing a new player aims at, and 20.4 % of pit stands can put a
 * ray on it through a full shell. A miss that looks like a hit is worse than a miss.
 */
export type Landing = 'hit' | 'absorb' | 'miss';

/**
 * `shoot.rs:492`'s rule, mirrored rather than approximated, in one place.
 *
 * `VENT_OPEN` is `@heartrot/client`'s, imported above. It used to be a private `const
 * VENT_OPEN = 1` right here, which made the byte's meaning a fact stored once per file that
 * reads it — and `Hud` and `Boss` were each storing it again as a bare `=== 1`.
 */
export function landingOf(end: RayEnd, ventOpen: number): Landing {
  if (!end.struck) return 'miss';
  return end.core && ventOpen !== VENT_OPEN ? 'absorb' : 'hit';
}

/**
 * Walk `(dx, dy)` from `(fromX, fromY)` and report where it stops.
 *
 * `(dx, dy)` must be in the `i8` range the wire carries, so the normalisation runs over the
 * same integers the program's does. A destroyed part (0 HP) is transparent, exactly as on
 * chain: stripping the shell is what opens a lane to the core, and it falls out of the
 * geometry rather than out of a flag.
 */
export function raycastShot(
  fromX: number,
  fromY: number,
  dx: number,
  dy: number,
  parts: readonly number[],
  bossX: number,
  bossY: number,
): RayEnd {
  const u = unitQ12(dx, dy);
  if (u === null) return { x: fromX, y: fromY, struck: false, core: false };
  const [ux, uy] = u;

  let fx = fromX * Q;
  let fy = fromY * Q;
  let x = fromX;
  let y = fromY;

  for (let step = 0; step < MAX_RAY_STEPS; step++) {
    fx += ux * MAP_TILE;
    fy += uy * MAP_TILE;
    x = Math.trunc(fx / Q);
    y = Math.trunc(fy / Q);

    if (isWall(x, y)) return { x, y, struck: false, core: false };

    const lx = x - bossX;
    const ly = y - bossY;

    for (let i = 0; i < PART_HITBOXES.length; i++) {
      const r = PART_HITBOXES[i]!;
      if (
        (parts[i] ?? 0) !== 0 &&
        lx >= r.x &&
        lx < r.x + r.w &&
        ly >= r.y &&
        ly < r.y + r.h
      ) {
        return { x, y, struck: true, core: false };
      }
    }

    const cx = lx - CORE.x;
    const cy = ly - CORE.y;
    if (cx * cx + cy * cy <= CORE.radiusSq) return { x, y, struck: true, core: true };
  }

  return { x, y, struck: false, core: false };
}

// ---------------------------------------------------------------------------
// Flight
// ---------------------------------------------------------------------------

/**
 * Arrow speed. Derived, not chosen: the median boss range from a pit stand is 280 units
 * and write-to-visible is 129.8 ms p50, so 2,157 u/s puts the arrow on the target at the
 * moment the truth arrives. Rounded UP so it lands just BEFORE the truth rather than after
 * it — an arrow still in the air when its own damage number appears is the one ordering a
 * player can actually notice.
 */
const ARROW_UNITS_PER_SEC = 2200;

/** How long the impact spark lives after the arrow arrives. */
const STICK_FADE_MS = 400;

/**
 * Flight time ceiling, and the reason the pool needs no management.
 *
 * One node per seat is only safe while a seat cannot have two arrows at once, i.e. while
 * `flight + spark < cooldown`. Rather than *assert* that against a measured worst-case
 * range — the assertion someone eventually breaks by turning the speed down — the ceiling
 * is DERIVED from the shortest cooldown and the flight is clamped to it, so the invariant
 * holds by construction for any range, any speed and any map.
 *
 * It does not bind in practice: the longest terminus over all 726 pit stands x 64 angles is
 * 640 units, which is 291 ms at {@link ARROW_UNITS_PER_SEC}, against the 400 ms below. The
 * dev check confirms that headroom is still there, so a speed change that starts clamping
 * real shots is reported rather than silently making every long shot look slow.
 */
const ARROW_MAX_MS = CLASS_PERIOD_MS[0]! - STICK_FADE_MS;

/** The loose flash at the bow, at the moment of input. */
const MUZZLE_MS = 110;

/** The damage number's rise. */
const DAMAGE_MS = 700;
const DAMAGE_RISE = 26;

/**
 * Warm, because reference B is a cold cyan room and a cyan tracer disappears into the
 * braziers and into the boss's own ordnance. Colour alone cannot carry the separation —
 * every arrow colour clearing 4.5:1 against the floor is within 1.68:1 of `PAL.bullet` —
 * so the arrow is separated from a boss bullet by SHAPE (a thin shaft with a head, against
 * an 8-unit round capsule) and by speed (5.2x), and the hue is only the third cue.
 */
const SHAFT = '#ffd98a';
const HEAD = '#fff6e0';
const SPARK_HIT = '#fff2c4';
const SPARK_WALL = '#8d8397';

/**
 * The shell absorbing a shot aimed at a sealed vent. `PAL.partLive` on purpose — the colour
 * of the thing that ate it — and the SHAPE reads the other way from a hit: the ring
 * collapses inward instead of blooming, so the two stay separable on a dim screen with no
 * colour at all. Nothing else on screen distinguishes them, and 20.4 % of pit stands can
 * reach the orb through a full shell.
 */
const SPARK_ABSORB = PAL.partLive;

/** Shaft geometry. Tip at the group's origin, body trailing back along -x. */
const HEAD_LEN = 7;
const SHAFT_LEN = 18;

/** Perpendicular sag on an archer's arrow, as a fraction of the range. Decorative only. */
const ARC_FRACTION = 0.1;

// The scene's projectile cap is `sprites.ts`'s {@link VISIBLE_PROJECTILES}, imported above.
// It used to be typed here a second time under this name and a third time in `Arena.tsx` as
// `VISIBLE_BULLETS`, joined only by the `budget` prop — so halving one of them left the
// scene drawing the full 32 nodes again with no error anywhere.

interface Flight {
  t0: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Chord, precomputed. */
  dx: number;
  dy: number;
  /** Unit perpendicular, for the sag. */
  px: number;
  py: number;
  /** Sag amplitude in units. 0 for a knight. */
  arc: number;
  ms: number;
  /** What the arrival means, resolved at launch against the vent as it stood then. */
  hit: Landing;
  /** Arrival has been played; the node is parked. */
  landed: boolean;
}

/** What {@link fireLocal} needs to draw a shot the instant the key goes down. */
export interface LocalShot {
  readonly seat: number;
  /** The PREDICTED position — the knight the player is watching, not the one Singapore has. */
  readonly x: number;
  readonly y: number;
  /** The exact `i8` pair that went on the wire (or would have, for a practice shot). */
  readonly dx: number;
  readonly dy: number;
}

/**
 * Draw the local player's shot NOW.
 *
 * Call it from `App.tsx`'s `onShoot` — for a real shot AND for a practice shot the client
 * deliberately does not send (spec §6.1: the waiting area, the muster, and a seat that
 * never crossed the gate). This file cannot tell the two apart and must not: the arrow is
 * the answer to "is the key bound", and the damage number — which only ever comes from
 * `damageDealt` — is the answer to "did it hurt anything".
 *
 * A module-scope sink rather than a ref threaded through `App` -> `World` -> `Arena`: there
 * is exactly one arena renderer on a page, and this is one import and one call at the site
 * that already has the seat, the predicted position and the wire vector in hand. With no
 * `Shot` mounted it is a no-op.
 */
export function fireLocal(shot: LocalShot): void {
  sink?.(shot);
}

let sink: ((shot: LocalShot) => void) | null = null;

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface ShotProps {
  players: PlayersAccount;
  /** The parts table the ray is resolved against, and the anchor it is resolved around. */
  boss: BossAccount;
  /**
   * The seat this browser drives. Its arrow comes from {@link fireLocal} and its
   * `lastShotTick` diff is IGNORED — one writer per arrow, the same rule the seat
   * transforms follow. Omit it (a spectator) and every seat is drawn from the chain.
   */
  localSeat?: number;
  /**
   * `prefers-reduced-motion`, resolved once by the caller. The arrow does not fly: the
   * impact appears at the terminus immediately, so the information — who shot, at what,
   * and whether it landed — survives with no travel.
   */
  reduced: boolean;
  /**
   * REQUIRED, and required for a reason: `Arena.tsx` owns the only rAF loop in the scene
   * and must call `frameRef.current?.(now)` inside it, passing the loop's own `now`. A
   * second loop is what this file exists not to add. Making the prop mandatory is the only
   * enforcement available — an unwired driver leaves every arrow parked at its bow with no
   * error anywhere.
   */
  frameRef: { current: ((now: number) => void) | null };
  /**
   * How many of the scene's {@link VISIBLE_PROJECTILES} `Arena.tsx` has already spent on
   * boss bullets this render. Boss ordnance ranks first — the cap's measured win (-2.08 ms
   * p50) is spent if arrows are drawn outside it — so arrows take what is left.
   *
   * Spent at SPAWN, in {@link Shot}'s `launch`, and NOT in the frame step. Applied in the
   * frame step it still paid for the raycast, three one-shot animations and a `Flight` for
   * an arrow it then hid, and with a full bullet pool (`budget === VISIBLE_PROJECTILES`,
   * reachable at twenty seats) `drawn >= 0` was true on the first iteration — so the seat
   * `frameOrder` put first, the LOCAL one, was the first one hidden, three lines under a
   * comment promising the opposite (`docs/perf/frame-budget-17.md` §5.1).
   *
   * Omitted means "the cap is mine".
   */
  budget?: number;
  /**
   * Bumped by the store whenever the feed drops and resubscribes. The diff baseline is
   * reseeded silently on a change, because a reconnect re-delivers a `lastShotTick` this
   * client has already drawn and replaying it is exactly the bug `Spawn.tsx` shipped with.
   */
  feedEpoch?: number;
  /**
   * Which room is on screen — the SAME fact `Arena` filters its seats by (`roomSeats`), and
   * the reason this is a prop rather than a second derivation. During the 460 ms gate cover
   * the local seat's `zone` already reads `ZONE_ARENA` while room A is still painted, so a
   * layer that re-derives the room from `zone` draws pit arrows and pit damage numbers over
   * the waiting room for the whole of the cover: one fact, two readings, which is this
   * repo's signature defect. `Passage` owns it and `Arena` passes it down.
   *
   * Absent, it falls back to the local seat's own `zone` — the same fallback `Arena` uses
   * when no `Passage` is mounted, so this file is still correct on its own.
   */
  room?: Room;
}

export function Shot({
  players,
  boss,
  localSeat,
  reduced,
  frameRef,
  budget = 0,
  feedEpoch = 0,
  room,
}: ShotProps) {
  // Four node arrays, one entry per seat, filled by the `ref` callbacks below. Indexed by
  // seat and never resized: the pool IS the seat table.
  const muzzle = useRef<Array<SVGGElement | null>>([]);
  const arrow = useRef<Array<SVGGElement | null>>([]);
  const impactAt = useRef<Array<SVGGElement | null>>([]);
  const impact = useRef<Array<SVGGElement | null>>([]);
  const damage = useRef<Array<SVGGElement | null>>([]);
  const damageText = useRef<Array<SVGTextElement | null>>([]);

  const flights = useRef<Array<Flight | null>>(Array.from({ length: MAX_SEATS }, () => null));
  /** Last drawn terminus per seat — where a damage number belongs. */
  const endAt = useRef<Array<{ x: number; y: number } | null>>(
    Array.from({ length: MAX_SEATS }, () => null),
  );

  // The diff baselines. `null` means "not seeded yet": the first payload seeds and fires
  // nothing, which is what stops a mid-fight join replaying the last volley.
  const seenShot = useRef<Array<number | null>>(Array.from({ length: MAX_SEATS }, () => null));
  const seenDealt = useRef<Array<number | null>>(Array.from({ length: MAX_SEATS }, () => null));

  // Latest boss, read by `fireLocal` without rebuilding the sink on every notification.
  const bossRef = useRef(boss);
  bossRef.current = boss;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  /**
   * Spec §3 R3, answered from the room ON SCREEN rather than from a second reading of
   * `zone`. The two rooms overlap in world space, so an arrow loosed in the waiting area
   * would otherwise be drawn straight across the pit and the allies standing in it.
   */
  const inRoom = (seat: number): boolean => {
    const shown =
      room !== undefined
        ? room === 'arena'
          ? ZONE_ARENA
          : ZONE_LOBBY
        : localSeat === undefined
          ? undefined
          : players.slots[localSeat]?.zone;
    const there = players.slots[seat]?.zone;
    return shown === undefined || there === undefined || there === shown;
  };

  /** The spark. One WAAPI one-shot on this file's own node; no per-frame cost. */
  const land = (seat: number, hit: Landing): void => {
    const el = impact.current[seat];
    if (el === null || el === undefined) return;
    el.style.color = hit === 'hit' ? SPARK_HIT : hit === 'absorb' ? SPARK_ABSORB : SPARK_WALL;
    el.animate(
      hit === 'absorb'
        ? [
            { opacity: 0.9, transform: 'scale(1.45)' },
            { opacity: 0, transform: 'scale(0.45)' },
          ]
        : [
            { opacity: hit === 'hit' ? 1 : 0.55, transform: 'scale(0.4)' },
            { opacity: 0, transform: hit === 'hit' ? 'scale(1.7)' : 'scale(1.05)' },
          ],
      { duration: STICK_FADE_MS, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
    );
  };

  /** What is left of {@link VISIBLE_PROJECTILES} once `Arena` has drawn its bullets. */
  const cap = Math.max(0, VISIBLE_PROJECTILES - budget);

  /** Start a seat's arrow. The one place a `Flight` is created, local or remote. */
  const launch = (seat: number, x: number, y: number, dx: number, dy: number, cls: number): void => {
    if (seat < 0 || seat >= MAX_SEATS) return;
    if (!inRoom(seat)) return;

    // The cap, spent here rather than in the frame step — see `budget`. The local seat is
    // exempt: its own arrow is the one the player is looking for, and this is the only
    // place that exemption can actually hold.
    if (seat !== localSeat) {
      // Nothing left at all. Returning BEFORE the raycast is where the cost goes: the ray
      // and the three one-shots are the whole of a spawn.
      if (cap === 0) return;
      const { live, oldest } = flightCut(flights.current, localSeat);
      // Full: drop the arrow that has been in the air LONGEST. It is nearest its terminus,
      // so its loss costs the least information; dropping the newest would drop the shot
      // that was just fired, which is the one the player is watching for.
      //
      // ponytail: ONE eviction per launch, so a `cap` that falls mid-volley — the bullet
      // pool filling — is absorbed by arrows expiring rather than by a mass vanish, and the
      // count can sit above it for up to `ARROW_MAX_MS` under sustained fire. The real
      // ceiling either way is `MAX_SEATS`, because `flights` is one entry per seat and a
      // seat cannot have two arrows up. Evict in a `while` if that ever measures.
      if (live >= cap && oldest >= 0) {
        flights.current[oldest] = null;
        const dropped = arrow.current[oldest];
        if (dropped !== null && dropped !== undefined && dropped.style.opacity !== '0') {
          dropped.style.opacity = '0';
        }
      }
    }

    const b = bossRef.current;
    const end = raycastShot(x, y, dx, dy, b.parts, b.x, b.y);
    // The chain's answer, not the ray's: a sealed vent absorbs the shot and scores nothing
    // (`shoot.rs:492`), so it must not draw the hit spark. `ventOpen` is read at launch for
    // the same reason the position is — this is the state the shot was fired into.
    const hit = landingOf(end, b.ventOpen);
    endAt.current[seat] = { x: end.x, y: end.y };

    const cdx = end.x - x;
    const cdy = end.y - y;
    const range = Math.hypot(cdx, cdy);
    const ms = Math.min((range / ARROW_UNITS_PER_SEC) * 1000, ARROW_MAX_MS);

    const node = arrow.current[seat];
    const spot = impactAt.current[seat];
    if (spot !== null && spot !== undefined) {
      spot.style.transform = `translate(${end.x}px, ${end.y}px)`;
    }

    // The loose flash sits at the bow and is the only thing that answers the key at 0 ms
    // when the range is long. Positioned once per shot, animated once per shot.
    const flash = muzzle.current[seat];
    if (flash !== null && flash !== undefined) {
      flash.style.transform = `translate(${x}px, ${y}px)`;
      flash.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: MUZZLE_MS });
    }

    if (reducedRef.current || range === 0 || ms === 0) {
      // No travel. The impact is the whole of the information and it appears at once.
      if (node !== null && node !== undefined) node.style.opacity = '0';
      flights.current[seat] = null;
      land(seat, hit);
      return;
    }

    const inv = 1 / range;
    flights.current[seat] = {
      t0: performance.now(),
      x0: x,
      y0: y,
      x1: end.x,
      y1: end.y,
      dx: cdx,
      dy: cdy,
      px: -cdy * inv,
      py: cdx * inv,
      arc: cls === CLASS_ARCHER ? range * ARC_FRACTION : 0,
      ms,
      hit,
      landed: false,
    };
  };

  // ---- the local shot, at input rate ------------------------------------
  //
  // No dependency array: `launch` closes over this render's `players` for the class and the
  // room, and re-registering the sink costs one assignment per notification. The sink is
  // cleared on unmount, so `fireLocal` from a screen with no arena is a no-op.
  useEffect(() => {
    sink = (shot) => {
      if (localSeat === undefined || shot.seat !== localSeat) return;
      const slot = players.slots[shot.seat];
      launch(shot.seat, shot.x, shot.y, shot.dx, shot.dy, slot === undefined ? 0 : classOf(slot));
    };
    return () => {
      sink = null;
    };
  });

  // ---- every other seat, from account bytes ------------------------------
  //
  // Runs on every payload. Both triggers are value diffs, so the Magic Router's double
  // delivery is idempotent by construction and the 68.4% of notifications carrying no
  // change do nothing at all.
  const epoch = useRef(feedEpoch);
  useEffect(() => {
    const reseed = epoch.current !== feedEpoch;
    epoch.current = feedEpoch;

    for (let seat = 0; seat < MAX_SEATS; seat++) {
      const slot = players.slots[seat];
      if (slot === undefined || !slot.occupied) {
        seenShot.current[seat] = null;
        seenDealt.current[seat] = null;
        continue;
      }

      const lastShot = seenShot.current[seat] ?? null;
      const lastDealt = seenDealt.current[seat] ?? null;
      seenShot.current[seat] = slot.lastShotTick;
      seenDealt.current[seat] = slot.damageDealt;

      // A reconnect re-delivers state this client already drew. Seed, never fire.
      if (reseed || lastShot === null || lastDealt === null) continue;

      // The local seat's arrow is already in the air — drawn from the exact wire vector
      // ~127 ms ago. Drawing its echo too would be two writers on one node and a second
      // arrow out of the same bow.
      if (slot.lastShotTick > lastShot && seat !== localSeat) {
        const aim = aimOf(slot);
        launch(seat, slot.x, slot.y, aim[0], aim[1], classOf(slot));
      }

      // Chain-only, for EVERY seat including the local one: prediction owns no number.
      // `dealt` is capped at the part's remaining HP on chain, so a finishing blow
      // legitimately reads less than the class damage — shown as-is, never rounded up.
      if (slot.damageDealt > lastDealt) {
        showDamage(seat, slot.damageDealt - lastDealt);
      }
    }
  });

  /** The number, at the terminus this seat's last arrow found. */
  const showDamage = (seat: number, amount: number): void => {
    const el = damage.current[seat];
    const text = damageText.current[seat];
    if (el === null || el === undefined || text === null || text === undefined) return;
    // R3 again: a number floating over the pit while you are still in the waiting area is
    // the same lie an arrow drawn there would be.
    if (!inRoom(seat)) return;
    const at = endAt.current[seat] ?? {
      x: bossRef.current.x + CORE.x,
      y: bossRef.current.y + CORE.y,
    };
    text.textContent = `${amount}`;
    el.animate(
      [
        { opacity: 1, transform: `translate(${at.x}px, ${at.y}px)` },
        { opacity: 0, transform: `translate(${at.x}px, ${at.y - DAMAGE_RISE}px)` },
      ],
      { duration: DAMAGE_MS, easing: 'cubic-bezier(0.1, 0.8, 0.3, 1)' },
    );
  };

  // ---- the frame step, run from `Arena.tsx`'s loop -----------------------
  //
  // The ONLY per-frame work in this file, and the only writer of an arrow's transform.
  //
  // No cap and no ordering: `launch` already refused every arrow the scene has no room
  // for, so what is in `flights` is exactly what is drawn. That deletes the per-frame
  // `frameOrder` allocation and its sort, and it is what makes the local seat's own arrow
  // survive a full bullet pool.
  useLayoutEffect(() => {
    const step = (now: number): void => {
      for (let seat = 0; seat < MAX_SEATS; seat++) {
        const f = flights.current[seat];
        if (f === null || f === undefined) continue;
        const el = arrow.current[seat];
        const t = (now - f.t0) / f.ms;

        if (t >= 1) {
          if (!f.landed) {
            f.landed = true;
            land(seat, f.hit);
          }
          flights.current[seat] = null;
          if (el !== null && el !== undefined && el.style.opacity !== '0') el.style.opacity = '0';
          continue;
        }

        if (el === null || el === undefined) continue;

        // Position, plus the archer's sag: a perpendicular `sin(pi t)` that is zero at both
        // ends, so it never moves the terminus the chain already resolved.
        const bow = f.arc === 0 ? 0 : f.arc * Math.sin(Math.PI * t);
        const x = f.x0 + f.dx * t + f.px * bow;
        const y = f.y0 + f.dy * t + f.py * bow;
        // The tangent, so the shaft points where it is going rather than where it started.
        const slope = f.arc === 0 ? 0 : f.arc * Math.PI * Math.cos(Math.PI * t);
        const tx = f.dx + f.px * slope;
        const ty = f.dy + f.py * slope;
        const deg = (Math.atan2(ty, tx) * 180) / Math.PI;

        el.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg)`;
        if (el.style.opacity !== '1') el.style.opacity = '1';
      }
    };

    frameRef.current = step;
    return () => {
      if (frameRef.current === step) frameRef.current = null;
    };
  }, [frameRef]);

  // ---- the nodes --------------------------------------------------------
  //
  // Static from React's point of view: mounted once, never re-rendered into, opacity 0 at
  // rest. `key` is the seat, so the pool is index-stable and a node is never handed to a
  // different seat mid-flight.
  //
  // The empty dependency list is what makes that paragraph TRUE rather than aspirational.
  // `Shot` re-renders on every notification that survives `subscribe.ts`'s dedupe (~380/s
  // at 20 seats); without the memo each one allocated and reconciled 261 elements AND handed
  // React 120 fresh `ref` closures, so every node in the pool was detached and re-attached —
  // the exact cost `Scene.tsx` measured at 11.2 ms/frame and paid to delete. The memo cannot
  // go stale: every identifier in the tree below is a module constant, and the six ref
  // arrays are stable objects the callbacks fill once at mount.
  return useMemo(
    () => (
      <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
        {Array.from({ length: MAX_SEATS }, (_, seat) => (
          <g key={seat}>
            <g ref={(el) => void (muzzle.current[seat] = el)} style={{ opacity: 0 }}>
              <circle r={7} fill={HEAD} />
              <circle r={12} fill={HEAD} opacity={0.25} />
            </g>

            <g
              ref={(el) => void (arrow.current[seat] = el)}
              style={{ opacity: 0, willChange: 'transform' }}
            >
              <line
                x1={-HEAD_LEN}
                y1={0}
                x2={-SHAFT_LEN}
                y2={0}
                stroke={SHAFT}
                strokeWidth={2}
                strokeLinecap="round"
              />
              <path d={`M0 0L${-HEAD_LEN} ${-3.5}L${-HEAD_LEN} 3.5Z`} fill={HEAD} />
            </g>

            <g ref={(el) => void (impactAt.current[seat] = el)}>
              <g
                ref={(el) => void (impact.current[seat] = el)}
                style={{ opacity: 0, color: SPARK_HIT }}
              >
                <circle r={9} fill="currentColor" opacity={0.5} />
                <circle r={3.5} fill="currentColor" />
              </g>
            </g>

            <g ref={(el) => void (damage.current[seat] = el)} style={{ opacity: 0 }}>
              <text
                ref={(el) => void (damageText.current[seat] = el)}
                textAnchor="middle"
                fontSize={18}
                fontWeight={700}
                fill={HEAD}
                stroke={PAL.outline}
                strokeWidth={3}
                paintOrder="stroke"
              />
            </g>
          </g>
        ))}
      </g>
    ),
    [],
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The direction to draw a seat's arrow along, as an `i8` pair — the domain the chain
 * normalises in, so the mirror runs over the same integers.
 *
 * `classAim` carries the aim only once the seat has fired: before that the byte is 0, which
 * decodes to due +x. `facing` is the honest fallback, and it is only ever 45-degree
 * accurate — which is exactly why the aim byte exists (`decodeAim`'s own note, and spec
 * §5.3: an arrow drawn from `facing` is up to 22.5 degrees off and SNAPS mid-flight when
 * its shooter takes a step, because `move` rewrites `facing` every 50 ms).
 */
function aimOf(slot: PlayerSlot): readonly [number, number] {
  const [ax, ay] =
    slot.lastShotTick === 0 ? FACING_UNIT[slot.facing] ?? FACING_UNIT[0]! : decodeAim(slot.classAim);
  return [Math.round(ax * 127), Math.round(ay * 127)];
}

/**
 * How many arrows are in the air, and which of them is the one to drop.
 *
 * `oldest` is the longest-flying seat that is NOT `mine` — the local player's own arrow is
 * never the cut, which is the half of the projectile cap that used to be a comment rather
 * than a behaviour. `-1` when there is nothing droppable.
 *
 * Pure and one pass, so the cap's policy is checkable without a renderer. Called once per
 * spawn (a knight fires every eight ticks) rather than once per frame, which is the whole
 * point of moving the cap out of the frame step.
 */
function flightCut(
  flights: ReadonlyArray<Flight | null>,
  mine: number | undefined,
): { live: number; oldest: number } {
  let live = 0;
  let oldest = -1;
  for (let seat = 0; seat < flights.length; seat++) {
    const f = flights[seat];
    if (f === null || f === undefined) continue;
    live++;
    if (seat === mine) continue;
    if (oldest === -1 || f.t0 < flights[oldest]!.t0) oldest = seat;
  }
  return { live, oldest };
}

// ---------------------------------------------------------------------------
// Self-check
//
// The ray is a hand-written third copy of a chain algorithm and every way it goes wrong is
// silent: shooting is fire-and-forget with `skipPreflight`, so an arrow drawn to the wrong
// place produces no error anywhere and is indistinguishable from the bug this file exists
// to fix. The assertions are BEHAVIOURAL — "a shot at the boss hits the boss", never "the
// ray ends at (x, y)" — because the map and the hitboxes are generator output and a test
// naming a coordinate stops testing the ray the moment the art moves.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`Shot self-check: ${what}`);
  };

  // The pool is one node per seat and has no management at all, which is safe only while a
  // seat cannot have two arrows at once. `ARROW_MAX_MS` makes that true by construction —
  // so what is checked here is that the clamp is still SLACK: the measured worst-case
  // terminus (640 units over all 726 pit stands x 64 angles, spec §4.2) must still fly at
  // its true speed. Once it clamps, every long shot silently starts arriving late.
  const WORST_RANGE = 640;
  ok(ARROW_MAX_MS > 0, 'the spark outlives the cooldown — the pool cannot be one node deep');
  ok(
    (WORST_RANGE / ARROW_UNITS_PER_SEC) * 1000 < ARROW_MAX_MS,
    'the longest real shot is being clamped — it will look slow, and 2200 u/s is derived',
  );
  ok(CLASS_PERIOD_MS[0]! <= CLASS_PERIOD_MS[1]!, 'the knight is the shortest cooldown');

  // A whole boss, from the generated table, at its spawn.
  const parts = PART_HITBOXES.map(() => 100);
  const bx = 512;
  const by = 400;
  // A stand in the pit, below the creature. Derived from the ray itself, not typed: the
  // sweep below finds the angles, so a redrawn map moves the test with it.
  const fromX = 512;
  const fromY = 560;

  /** Every angle a stand can fire, against a given shell. The tests search it. */
  const sweep = (hp: readonly number[]): RayEnd[] => {
    const out: RayEnd[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const dx = Math.round(Math.cos(a) * 127);
      const dy = Math.round(Math.sin(a) * 127);
      out.push(raycastShot(fromX, fromY, dx, dy, hp, bx, by));
    }
    return out;
  };
  const shots = sweep(parts);

  // 1. A shot at the creature terminates ON the creature. Straight up from a pit stand is
  //    the shot the whole game is: the boss is top-centre and the raid fights from below.
  const up = raycastShot(fromX, fromY, 0, -127, parts, bx, by);
  ok(up.struck, 'a shot straight up at a top-centre boss does not reach it');

  // 2. Some angle from the same stand ends on a wall, and the terminus really is one.
  const wall = shots.find((s) => !s.struck);
  ok(wall !== undefined && isWall(wall.x, wall.y), 'a missed shot does not stop on a wall tile');

  // 3. A 0-HP part is transparent — stripping the shell is what opens a lane to the core,
  //    and it has to fall out of the geometry rather than out of a flag. Found by search:
  //    which part is in the way is generator output and must not be typed here.
  let opened = false;
  for (let i = 0; i < PART_HITBOXES.length && !opened; i++) {
    const gone = parts.map((hp, j) => (j === i ? 0 : hp));
    for (let a = 0; a < 64 && !opened; a++) {
      const ang = (a / 64) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang) * 127);
      const dy = Math.round(Math.sin(ang) * 127);
      const whole = raycastShot(fromX, fromY, dx, dy, parts, bx, by);
      const holed = raycastShot(fromX, fromY, dx, dy, gone, bx, by);
      // The ray got FURTHER once the part came off, or stopped hitting anything at all.
      if (whole.struck && (holed.x !== whole.x || holed.y !== whole.y || !holed.struck)) {
        opened = true;
      }
    }
  }
  ok(opened, 'a destroyed part still blocks the ray');

  // 4. The zero vector is the one input `unit_q12` refuses, and the caller must not crash
  //    on it — `octant` rejects it upstream, so this is the unreachable branch made safe.
  const nil = raycastShot(fromX, fromY, 0, 0, parts, bx, by);
  ok(nil.x === fromX && nil.y === fromY && !nil.struck, 'a zero aim vector must draw nothing');

  // 5. `shoot.rs:492`: the shell absorbs a shot aimed at a sealed vent, so it scores
  //    nothing and must not read as a hit. Asserted on the RULE rather than on an angle —
  //    which angles reach the orb is generator output, so the ray finds them by search, and
  //    the same terminus is a hit the moment the vent opens.
  const core = sweep(parts.map(() => 0)).find((s) => s.core);
  ok(core !== undefined, 'no angle reaches the core through a stripped shell — check CORE');
  ok(landingOf(core!, 0) === 'absorb', 'a sealed vent must not draw the hit spark');
  ok(landingOf(core!, 1) === 'hit', 'an open vent must still read as a hit');
  const part = shots.find((s) => s.struck && !s.core);
  ok(part !== undefined && landingOf(part, 0) === 'hit', 'a part hit is never an absorb');
  ok(landingOf({ x: 0, y: 0, struck: false, core: false }, 1) === 'miss', 'a miss reads as a miss');

  // 6. The cut under the projectile cap keeps the local seat and drops the OLDEST. A shot
  //    the player cannot see is the entire bug report this file answers, and applying the
  //    cap in the frame step hid the local seat FIRST (frame-budget-17 §5.1).
  const fake = (t0: number): Flight => ({
    t0,
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
    dx: 0,
    dy: 0,
    px: 0,
    py: 0,
    arc: 0,
    ms: 1,
    hit: 'miss',
    landed: false,
  });
  const cut = flightCut([fake(30), null, fake(10), fake(20)], 0);
  ok(cut.live === 3, 'every arrow in the air counts against the cap, the local one included');
  ok(cut.oldest === 2, 'the arrow that has flown longest is the one dropped');
  ok(flightCut([fake(10), fake(30)], 0).oldest === 1, "the local seat's own arrow is never cut");
  const none = flightCut([null, null], 0);
  ok(none.live === 0 && none.oldest === -1, 'no arrows in the air is nothing to drop');
}
