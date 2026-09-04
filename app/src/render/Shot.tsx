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
 * rest. No allocation per shot, no pool management — `265 ms` max striking flight plus
 * {@link STICK_FADE_MS} is under the 800 ms knight cooldown, so a seat can never have two
 * arrows at once (asserted below). Per frame the work is one `atan2` and one style write
 * per arrow actually in the air.
 *
 * A charged shot (tier 1) is the same arrow, bigger: `scale(1.6)` on the node and a second,
 * wider line trailing it inside the same `<g>` — both toggled once per launch, never per
 * frame. The local seat's charged hit is the one moment the whole picture answers: a 70 ms
 * hit stop and a 6-unit kick of the root, both `Arena.tsx`'s, both no-ops under reduced
 * motion.
 *
 * A super (tier 2) is THE BEAM. `shoot.rs` walks the whole ray and damages every part it
 * enters (`raycastBeam` is the mirror), so what is drawn is the whole line: from the bow to
 * the wall or the ray's full length — never to the creature, because the beam does not
 * stop there — as a white stroke inside a cyan one, swelling and gone in {@link BEAM_MS}.
 * Light is instant, so the strike is drawn at LAUNCH: a flash on every part the line
 * entered, and on the orb, with the class's `superDamage` over each. The arrow still
 * flies, along the beam, and lands as a miss at its end. Those per-part numbers are the
 * one place this file estimates damage, and the chain's sum for that shot is consumed
 * silently ({@link beamed}) — the sum landing on a wall 900 units past the creature is the
 * only alternative, and it is wrong in the same place every time. The one exception is a
 * super the chain REFUSED: `NotCharged`, a step still in flight, and `App.tsx` resends one
 * tier down. The beam's numbers are then the wrong ones and the chain's is the only right
 * one, so {@link beamDowngraded} hands that diff back to the counter, at the part the
 * plain ray finds.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';

import {
  CLASS_ARCHER,
  CLASS_PERIOD_MS,
  CORE,
  MAX_SEATS,
  PART_HITBOXES,
  VENT_OPEN,
  ZONE_ARENA,
  ZONE_LOBBY,
  aimSelfCheck,
  chargedDamage,
  classOf,
  decodeAim,
  landingOf,
  raycastBeam,
  raycastShot,
  superDamage,
  type BossAccount,
  type Landing,
  type PlayerSlot,
  type PlayersAccount,
  type ShotTier,
  SUPER_MS,
} from '@heartrot/client';

import { hitStop, shake } from './Arena';
import { play } from './sfx';
import { FACING_UNIT, PAL, VISIBLE_PROJECTILES } from './sprites';
import type { Room } from './viewport';

// The raycast mirror — `raycastShot`, `landingOf` and `RayEnd` — used to live here. It is
// `packages/client/src/aim.ts` now, where `autoAim` needed it from the input path too, and
// it is imported above like every other chain table. There is no fourth copy.

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
const ARROW_UNITS_PER_SEC = 2600;

/**
 * How long the impact spark lives after the arrow arrives. 120, not 400: the archer's
 * period is 400 ms now, and flight plus this must fit inside the SHORTEST period for the
 * one-node-per-seat pool below to hold.
 */
const STICK_FADE_MS = 120;

/**
 * Flight time ceiling, and the reason the pool needs no management.
 *
 * One node per seat is only safe while a seat cannot have two arrows at once, i.e. while
 * `flight + spark < cooldown`. Rather than *assert* that against a measured worst-case
 * range — the assertion someone eventually breaks by turning the speed down — the ceiling
 * is DERIVED from the shortest cooldown and the flight is clamped to it, so the invariant
 * holds by construction for any range, any speed and any map.
 *
 * It does not bind on a shot that matters: over every pit stand on the painted map (764
 * tiles at a 4-unit pitch, 12,224 stands x 64 angles, full shell at `BOSS_SPAWN`) the
 * longest terminus that STRIKES the creature is 583 units — 224 ms at
 * {@link ARROW_UNITS_PER_SEC}, against the 280 ms below (the archer's 400 ms period, the
 * shortest, less the stick). A miss can fly further (954 units,
 * the length of the pit) and is clamped to the ceiling, which is harmless: only a strike
 * has a damage number to arrive before. The dev check confirms the headroom is still there,
 * so a speed change that starts clamping real shots is reported rather than silently making
 * every long shot look slow.
 */
const ARROW_MAX_MS = Math.min(...CLASS_PERIOD_MS) - STICK_FADE_MS;

/** The loose flash at the bow, at the moment of input. */
const MUZZLE_MS = 110;

/** The damage number's rise. */
const DAMAGE_MS = 700;
const DAMAGE_RISE = 26;

/**
 * Warm, because reference B is a cold cyan room and a cyan tracer disappears into the
 * braziers and into the boss's own ordnance. Colour alone cannot carry the separation —
 * every arrow colour clearing 4.5:1 against the floor is within 1.68:1 of the ordnance's
 * amber (`#ffb020`, index 5 of `tools/gen_ordnance.py`'s palette) —
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

/**
 * The archer's lob: a quadratic Bezier whose control point sits this fraction of the range
 * straight UP from the chord's midpoint, so the arrow rises and drops onto the terminus the
 * chain already resolved. Decorative only, and derivable on every client from the same
 * bytes as the chord — the terminus is the raycast terminus, exactly as before. Under 0.5,
 * so the tangent can never vanish mid-flight, even on a vertical shot (`atan2` of (0, 0)
 * would spin the head).
 */
const LOB_FRACTION = 0.35;

/** A charged arrow: the node scaled up, and the wider trail behind the shaft (`.hr-arrow-trail`). */
const CHARGED_SCALE = 1.6;
const CHARGED_XFORM = ` scale(${CHARGED_SCALE})`;
const TRAIL_LEN = 22;

/** What the local seat's charged hit does to the whole picture — `Arena.tsx`'s two exports. */
const HIT_STOP_MS = 70;
const SHAKE_UNITS = 6;

/**
 * The beam: two `<line>`s per seat, `.hr-beam` (white) inside `.hr-beam-halo` (cyan,
 * `styles.css`), both swelling from a thread to these widths a quarter of the way in and
 * fading to nothing. Two lines rather than a `drop-shadow`: a filter re-rasterises a
 * 1,000-unit stroke every frame of the swell, and the halo IS the second line. Under the
 * 800 ms knight cooldown, so a seat's beam is always over before its next launch.
 */
const BEAM_MS = 450;
const BEAM_W = 8;
const BEAM_HALO_W = 24;
/** The strike's colour — the white of the beam's core, so a flash reads as the beam's. */
const BEAM_HIT = '#ffffff';
/** Strike nodes, one per part the beam can enter; the last one is the orb. */
const BEAM_SPOTS = PART_HITBOXES.length + 1;
const BEAM_CORE_SPOT = PART_HITBOXES.length;

// The scene's projectile cap is `sprites.ts`'s {@link VISIBLE_PROJECTILES}, imported above.
// It used to be typed here a second time under this name and a third time in `Arena.tsx` as
// `VISIBLE_BULLETS`, joined only by the `budget` prop — so halving one of them left the
// scene drawing the full 32 nodes again with no error anywhere.

interface Flight {
  t0: number;
  /** The Bezier: bow, control point, terminus. The control point IS the midpoint for a knight. */
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  ms: number;
  /** What the arrival means, resolved at launch against the vent as it stood then. */
  hit: Landing;
  /** The terminus was the core — `coreHit` rather than `hitPart` when it lands. */
  core: boolean;
  /** Tier 1 and up are drawn big, and the local seat's hit stops the frame. */
  tier: ShotTier;
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
  /** The tier byte that went with it. */
  readonly tier: ShotTier;
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

/**
 * The local seat's last super was refused and is being resent as a charged or plain
 * shot. Call it from `App.tsx`'s downgrade, before the resend: the chain's `damageDealt`
 * diff for the shot that actually lands is then drawn, at the terminus the plain ray
 * finds — not swallowed as the beam's sum, and not floated over the beam's wall.
 */
export function beamDowngraded(): void {
  unbeam?.();
}

let sink: ((shot: LocalShot) => void) | null = null;
let unbeam: (() => void) | null = null;

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
  // Node arrays, one entry per seat, filled by the `ref` callbacks below. Indexed by seat
  // and never resized: the pool IS the seat table.
  const muzzle = useRef<Array<SVGGElement | null>>([]);
  const arrow = useRef<Array<SVGGElement | null>>([]);
  const trail = useRef<Array<SVGLineElement | null>>([]);
  const impactAt = useRef<Array<SVGGElement | null>>([]);
  const impact = useRef<Array<SVGGElement | null>>([]);
  const damage = useRef<Array<SVGGElement | null>>([]);
  const damageText = useRef<Array<SVGTextElement | null>>([]);
  // The beam, per seat; the strike pool, per PART. A part flashes the same whichever seat's
  // beam entered it, and two beams on one part inside {@link BEAM_MS} restart one flash —
  // twenty seats striking is not twenty sparks per part, the same rule the sounds follow.
  const beam = useRef<Array<SVGGElement | null>>([]);
  const beamHalo = useRef<Array<SVGLineElement | null>>([]);
  const beamCore = useRef<Array<SVGLineElement | null>>([]);
  const beamAt = useRef<Array<SVGGElement | null>>([]);
  const beamSpark = useRef<Array<SVGGElement | null>>([]);
  const beamNum = useRef<Array<SVGGElement | null>>([]);
  const beamText = useRef<Array<SVGTextElement | null>>([]);

  const flights = useRef<Array<Flight | null>>(Array.from({ length: MAX_SEATS }, () => null));
  /** Last drawn terminus per seat — where a damage number belongs. */
  const endAt = useRef<Array<{ x: number; y: number } | null>>(
    Array.from({ length: MAX_SEATS }, () => null),
  );
  /**
   * The seat's last launch was a beam, whose numbers were drawn per part at launch. The
   * chain's `damageDealt` diff for it is then the SUM of every part it took, and the only
   * point this file has for it is the arrow's terminus — a wall far past the creature. So
   * that one diff advances the baseline and draws nothing. Cleared by the next launch of
   * any tier, which is the next shot that can move the counter — or by
   * {@link beamDowngraded}, when the chain refused the super and a lesser shot is the one
   * that will move it.
   */
  const beamed = useRef<boolean[]>(Array.from({ length: MAX_SEATS }, () => false));
  /** The local seat's last `fireLocal`, so a downgrade can re-aim its terminus. */
  const localShot = useRef<LocalShot | null>(null);

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

  /**
   * The spark. One WAAPI one-shot on this file's own node; no per-frame cost. The local
   * seat's landing is also the one that is HEARD and, charged, the one that is FELT — the
   * hit stop and the kick are `Arena`'s, keyed here because this is where the arrival is
   * known. Remote arrivals are silent: twenty seats landing is not twenty cues.
   */
  const land = (seat: number, hit: Landing, core: boolean, tier: ShotTier): void => {
    if (seat === localSeat && hit === 'hit') {
      play(core ? 'coreHit' : 'hitPart');
      if (tier >= 1) {
        hitStop(HIT_STOP_MS);
        shake(SHAKE_UNITS);
      }
    }
    const el = impact.current[seat];
    if (el === null || el === undefined) return;
    el.style.color = hit === 'hit' ? SPARK_HIT : hit === 'absorb' ? SPARK_ABSORB : SPARK_WALL;
    spark(el, hit);
  };

  /** The spark's one-shot, on whichever node is at the point: an arrow's, or a beam's. */
  const spark = (el: SVGGElement, hit: Landing): void => {
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

  /**
   * The beam itself: both lines laid from the bow to the end, the group faded over
   * {@link BEAM_MS} and — motion allowed — each stroke swelling from a thread to its width
   * and back to nothing. Reduced motion keeps the fade and the rest widths `styles.css`
   * gives the classes: the line is the information (where the beam went), the swell is not.
   */
  const drawBeam = (seat: number, x0: number, y0: number, x1: number, y1: number): void => {
    const g = beam.current[seat];
    const halo = beamHalo.current[seat];
    const line = beamCore.current[seat];
    if (!g || !halo || !line) return;
    for (const l of [halo, line]) {
      l.setAttribute('x1', `${x0}`);
      l.setAttribute('y1', `${y0}`);
      l.setAttribute('x2', `${x1}`);
      l.setAttribute('y2', `${y1}`);
    }
    g.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: BEAM_MS, easing: 'ease-out' });
    if (reducedRef.current) return;
    for (const [l, w] of [[halo, BEAM_HALO_W], [line, BEAM_W]] as const) {
      l.animate(
        [{ strokeWidth: '1px' }, { strokeWidth: `${w}px`, offset: 0.25 }, { strokeWidth: '0px' }],
        { duration: BEAM_MS, easing: 'ease-out' },
      );
    }
  };

  /**
   * The beam's strike, drawn at launch because light is instant: a flash on every part the
   * line entered and on the orb, each placed where the beam passes nearest the thing it
   * struck, with the class's super damage over each part. The orb takes a number only when
   * the vent stood open as the beam left — the same state {@link landingOf} judges an arrow
   * by. Sealed, it takes the absorb ring and no number: the chain may open the vent on this
   * very beam and score the core (`shoot.rs::fire` re-reads the vent after the parts fall),
   * and that is a number this file cannot know. The local seat's strike is the one that is
   * heard and felt, exactly as its arrow's landing is.
   */
  const strike = (
    seat: number,
    x: number,
    y: number,
    ex: number,
    ey: number,
    hits: readonly number[],
    core: boolean,
    cls: number,
  ): void => {
    const b = bossRef.current;
    const open = b.ventOpen === VENT_OPEN;
    const flash = (spot: number, cx: number, cy: number, hit: Landing): void => {
      const [px, py] = onBeam(x, y, ex, ey, cx, cy);
      const at = beamAt.current[spot];
      if (at) at.style.transform = `translate(${px}px, ${py}px)`;
      const sp = beamSpark.current[spot];
      if (sp) {
        sp.style.color = hit === 'hit' ? BEAM_HIT : SPARK_ABSORB;
        spark(sp, hit);
      }
      if (hit === 'hit') rise(beamNum.current[spot], beamText.current[spot], px, py, superDamage(cls), cls);
    };
    for (const i of hits) {
      const r = PART_HITBOXES[i]!;
      flash(i, b.x + r.x + r.w / 2, b.y + r.y + r.h / 2, 'hit');
    }
    if (core) flash(BEAM_CORE_SPOT, b.x + CORE.x, b.y + CORE.y, open ? 'hit' : 'absorb');
    if (seat === localSeat && (hits.length > 0 || (core && open))) {
      play(core && open ? 'coreHit' : 'hitPart');
      hitStop(HIT_STOP_MS);
      shake(SHAKE_UNITS);
    }
  };

  /** What is left of {@link VISIBLE_PROJECTILES} once `Arena` has drawn its bullets. */
  const cap = Math.max(0, VISIBLE_PROJECTILES - budget);

  /** Start a seat's arrow. The one place a `Flight` is created, local or remote. */
  const launch = (
    seat: number,
    x: number,
    y: number,
    dx: number,
    dy: number,
    cls: number,
    tier: ShotTier,
  ): void => {
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
    beamed.current[seat] = tier === 2;
    let end: { readonly x: number; readonly y: number };
    let hit: Landing;
    let core: boolean;
    if (tier === 2) {
      // The beam does not stop on the creature, so its END is a wall or the ray's full
      // length and the arrow's arrival there is a miss by construction; what it struck is
      // drawn now, where it stands, because the light is already there.
      const ray = raycastBeam(x, y, dx, dy, b.parts, b.x, b.y);
      end = ray.end;
      hit = 'miss';
      core = false;
      drawBeam(seat, x, y, end.x, end.y);
      strike(seat, x, y, end.x, end.y, ray.hits, ray.core, cls);
    } else {
      const ray = raycastShot(x, y, dx, dy, b.parts, b.x, b.y);
      end = ray;
      // The chain's answer, not the ray's: a sealed vent absorbs the shot and scores nothing
      // (`shoot.rs:492`), so it must not draw the hit spark. `ventOpen` is read at launch for
      // the same reason the position is — this is the state the shot was fired into.
      hit = landingOf(ray, b.ventOpen);
      core = ray.core;
    }
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
    // when the range is long. Positioned once per shot, animated once per shot. The local
    // twang goes with it: at input, not at the echo.
    const flash = muzzle.current[seat];
    if (flash !== null && flash !== undefined) {
      flash.style.transform = `translate(${x}px, ${y}px)`;
      flash.animate([{ opacity: 0.95 }, { opacity: 0 }], { duration: MUZZLE_MS });
    }
    if (seat === localSeat) {
      play(tier === 2 ? 'looseSuper' : tier === 1 ? 'looseCharged' : 'loose');
      // A charged loose is FELT at the bow, not only where it lands: the landing kick in
      // `land` needs a creature to hit, and in the lobby there is none — a practice super
      // used to fire in silence. The recoil here; the impact, in the pit, adds its own.
      if (tier === 2) shake(SHAKE_UNITS / 2);
      else if (tier === 1) shake(SHAKE_UNITS / 3);
    }

    // The charged dress, once per launch and for every tier past a tap: the class colours
    // the shaft and head (`styles.css`) and the trail is shown; the scale rides the
    // per-frame transform. A super's arrow rides its beam in the same dress.
    const big = tier >= 1;
    if (node !== null && node !== undefined) node.classList.toggle('hr-arrow-charged', big);
    const tail = trail.current[seat];
    if (tail !== null && tail !== undefined) tail.style.visibility = big ? 'visible' : 'hidden';

    if (reducedRef.current || range === 0 || ms === 0) {
      // No travel. The impact is the whole of the information and it appears at once.
      if (node !== null && node !== undefined) node.style.opacity = '0';
      flights.current[seat] = null;
      land(seat, hit, core, tier);
      return;
    }

    // The lob's control point: the chord's midpoint, lifted for an archer. For a knight it
    // IS the midpoint, which makes the Bezier the straight line at uniform speed.
    const lift = cls === CLASS_ARCHER ? range * LOB_FRACTION : 0;
    flights.current[seat] = {
      t0: performance.now(),
      x0: x,
      y0: y,
      cx: x + cdx / 2,
      cy: y + cdy / 2 - lift,
      x1: end.x,
      y1: end.y,
      ms,
      hit,
      core,
      tier,
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
      localShot.current = shot;
      const slot = players.slots[shot.seat];
      launch(shot.seat, shot.x, shot.y, shot.dx, shot.dy, slot === undefined ? 0 : classOf(slot), shot.tier);
    };
    unbeam = () => {
      const shot = localShot.current;
      if (localSeat === undefined || shot === null || !beamed.current[localSeat]) return;
      beamed.current[localSeat] = false;
      // The beam's arrow keeps flying to its wall; only the NUMBER moves, to where the
      // shot the chain took stops — the same ray tiers 0 and 1 launch with.
      const b = bossRef.current;
      const ray = raycastShot(shot.x, shot.y, shot.dx, shot.dy, b.parts, b.x, b.y);
      endAt.current[localSeat] = { x: ray.x, y: ray.y };
    };
    return () => {
      sink = null;
      unbeam = null;
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
        // `superShot` / `chargedShot` are the bits the chain set on THIS loose; the next
        // step clears them. Launched BEFORE the damage check below, so a remote beam's
        // sum — which arrives in this same payload — is the diff `beamed` swallows.
        launch(seat, slot.x, slot.y, aim[0], aim[1], classOf(slot), slot.superShot ? 2 : slot.chargedShot ? 1 : 0);
      }

      // Chain-only, for EVERY seat including the local one: prediction owns no number,
      // except the beam's, drawn per part at launch — see `beamed`. `dealt` is capped at
      // the part's remaining HP on chain, so a finishing blow legitimately reads less than
      // the class damage — shown as-is, never rounded up.
      if (slot.damageDealt > lastDealt && !beamed.current[seat]) {
        showDamage(seat, slot.damageDealt - lastDealt, classOf(slot));
      }
    }
  });

  /**
   * The number, at the terminus this seat's last arrow found. A charged landing — the
   * class's 2.5x, or a finishing blow that still cleared it — is the one number worth
   * reading, and `.hr-dmg-charged` (`styles.css`) draws it at 26 px in the vent's yellow.
   */
  const showDamage = (seat: number, amount: number, cls: number): void => {
    // R3 again: a number floating over the pit while you are still in the waiting area is
    // the same lie an arrow drawn there would be.
    if (!inRoom(seat)) return;
    const at = endAt.current[seat] ?? {
      x: bossRef.current.x + CORE.x,
      y: bossRef.current.y + CORE.y,
    };
    rise(damage.current[seat], damageText.current[seat], at.x, at.y, amount, cls);
  };

  /** The number's one-shot, on whichever node is at the point: a seat's, or a beam spot's. */
  const rise = (
    el: SVGGElement | null | undefined,
    text: SVGTextElement | null | undefined,
    x: number,
    y: number,
    amount: number,
    cls: number,
  ): void => {
    if (!el || !text) return;
    text.textContent = `${amount}`;
    text.classList.toggle('hr-dmg-charged', amount >= chargedDamage(cls));
    el.animate(
      [
        { opacity: 1, transform: `translate(${x}px, ${y}px)` },
        { opacity: 0, transform: `translate(${x}px, ${y - DAMAGE_RISE}px)` },
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
            land(seat, f.hit, f.core, f.tier);
          }
          flights.current[seat] = null;
          if (el !== null && el !== undefined && el.style.opacity !== '0') el.style.opacity = '0';
          continue;
        }

        if (el === null || el === undefined) continue;

        // The quadratic Bezier through bow, control point and terminus — zero lift at both
        // ends by construction, so it never moves the terminus the chain already resolved.
        const u = 1 - t;
        const x = u * u * f.x0 + 2 * u * t * f.cx + t * t * f.x1;
        const y = u * u * f.y0 + 2 * u * t * f.cy + t * t * f.y1;
        // Its derivative (halved; only the direction is read), so the shaft points where it
        // is going rather than where it started.
        const tx = u * (f.cx - f.x0) + t * (f.x1 - f.cx);
        const ty = u * (f.cy - f.y0) + t * (f.y1 - f.cy);
        const deg = (Math.atan2(ty, tx) * 180) / Math.PI;

        el.style.transform = `translate(${x}px, ${y}px) rotate(${deg}deg)${f.tier >= 1 ? CHARGED_XFORM : ''}`;
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
  // go stale: every identifier in the tree below is a module constant, and the ref arrays
  // are stable objects the callbacks fill once at mount.
  return useMemo(
    () => (
      <g aria-hidden="true" style={{ pointerEvents: 'none' }}>
        {Array.from({ length: MAX_SEATS }, (_, seat) => (
          <g key={seat}>
            {/* The beam, under everything else of the seat's: halo first, white core over
                it. Endpoints are set per launch; widths are the classes' (`styles.css`)
                until the swell overrides them. */}
            <g ref={(el) => void (beam.current[seat] = el)} style={{ opacity: 0 }}>
              <line ref={(el) => void (beamHalo.current[seat] = el)} className="hr-beam-halo" />
              <line ref={(el) => void (beamCore.current[seat] = el)} className="hr-beam" />
            </g>

            <g ref={(el) => void (muzzle.current[seat] = el)} style={{ opacity: 0 }}>
              <circle r={7} fill={HEAD} />
              <circle r={12} fill={HEAD} opacity={0.25} />
            </g>

            <g
              ref={(el) => void (arrow.current[seat] = el)}
              style={{ opacity: 0, willChange: 'transform' }}
            >
              {/* The charged trail, behind the shaft; hidden until a charged launch shows
                  it. Its stroke is `.hr-arrow-trail`'s, so no colour is typed here twice. */}
              <line
                ref={(el) => void (trail.current[seat] = el)}
                className="hr-arrow-trail"
                x1={-SHAFT_LEN}
                y1={0}
                x2={-SHAFT_LEN - TRAIL_LEN}
                y2={0}
                style={{ visibility: 'hidden' }}
              />
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
              <text ref={(el) => void (damageText.current[seat] = el)} {...DMG_TEXT} />
            </g>
          </g>
        ))}

        {/* The beam's strike pool: one spot per part and one for the orb, shared by every
            seat, each a spark and a number. Bigger than an arrow's spark — the beam is the
            widest thing that ever crosses the room, and its mark should be. */}
        {Array.from({ length: BEAM_SPOTS }, (_, spot) => (
          <g key={spot}>
            <g ref={(el) => void (beamAt.current[spot] = el)}>
              <g
                ref={(el) => void (beamSpark.current[spot] = el)}
                className="hr-beam-hit"
                style={{ opacity: 0, color: BEAM_HIT }}
              >
                <circle r={16} fill="currentColor" opacity={0.45} />
                <circle r={6} fill="currentColor" />
              </g>
            </g>
            <g ref={(el) => void (beamNum.current[spot] = el)} style={{ opacity: 0 }}>
              <text ref={(el) => void (beamText.current[spot] = el)} {...DMG_TEXT} />
            </g>
          </g>
        ))}
      </g>
    ),
    [],
  );
}

/** The damage number's face — one set of attributes for a seat's number and a beam spot's. */
const DMG_TEXT = {
  textAnchor: 'middle',
  fontSize: 18,
  fontWeight: 700,
  fill: HEAD,
  stroke: PAL.outline,
  strokeWidth: 3,
  paintOrder: 'stroke',
} as const;

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

/**
 * Where on the beam `(x0, y0) → (x1, y1)` a strike on the thing centred at `(px, py)` is
 * drawn: the nearest point of the segment. `raycastBeam` reports WHICH parts the line
 * entered and not where, and a flash at a box's centre can sit 60 units off a line that
 * only clipped the crown's corner — the mark has to be on the light. Clamped to the ends,
 * so a strike never floats in the air past the wall the beam died on.
 */
function onBeam(x0: number, y0: number, x1: number, y1: number, px: number, py: number): readonly [number, number] {
  const bx = x1 - x0;
  const by = y1 - y0;
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((px - x0) * bx + (py - y0) * by) / len2));
  return [x0 + t * bx, y0 + t * by];
}

// ---------------------------------------------------------------------------
// Self-check
//
// The ray and the auto-aim are checked where they live now (`aimSelfCheck`, in the SDK
// beside the tables they read) and called from here so they still run on every dev boot.
// What is left is this file's own: the pool proof and the cap's policy, both of which fail
// silently — a clamped flight just looks slow, a wrong cut just hides the wrong arrow.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`Shot self-check: ${what}`);
  };

  aimSelfCheck();

  // The pool is one node per seat and has no management at all, which is safe only while a
  // seat cannot have two arrows at once. `ARROW_MAX_MS` makes that true by construction —
  // so what is checked here is that the clamp is still SLACK for a shot that lands: the
  // measured worst-case STRIKING terminus (583 units over 12,224 pit stands x 64 angles on
  // the painted map, see `ARROW_MAX_MS`) must still fly at its true speed. Once it clamps,
  // every long hit silently starts arriving late.
  const WORST_RANGE = 583;
  ok(ARROW_MAX_MS > 0, 'the spark outlives the cooldown — the pool cannot be one node deep');
  ok(
    (WORST_RANGE / ARROW_UNITS_PER_SEC) * 1000 < ARROW_MAX_MS,
    'the longest real shot is being clamped — it will look slow, and 2200 u/s is derived',
  );
  ok(ARROW_MAX_MS === Math.min(...CLASS_PERIOD_MS) - STICK_FADE_MS, 'the ceiling is the shortest period, whichever class holds it');
  ok(LOB_FRACTION < 0.5, 'a lob past half the range stalls the tangent on a vertical shot');

  // The cut under the projectile cap keeps the local seat and drops the OLDEST. A shot the
  // player cannot see is the entire bug report this file answers, and applying the cap in
  // the frame step hid the local seat FIRST (frame-budget-17 §5.1).
  const fake = (t0: number): Flight => ({
    t0,
    x0: 0,
    y0: 0,
    cx: 0,
    cy: 0,
    x1: 0,
    y1: 0,
    ms: 1,
    hit: 'miss',
    core: false,
    tier: 0,
    landed: false,
  });
  const cut = flightCut([fake(30), null, fake(10), fake(20)], 0);
  ok(cut.live === 3, 'every arrow in the air counts against the cap, the local one included');
  ok(cut.oldest === 2, 'the arrow that has flown longest is the one dropped');
  ok(flightCut([fake(10), fake(30)], 0).oldest === 1, "the local seat's own arrow is never cut");
  const none = flightCut([null, null], 0);
  ok(none.live === 0 && none.oldest === -1, 'no arrows in the air is nothing to drop');

  // A beam's strike is drawn ON the beam: a part beside the line projects onto it, a part
  // past either end lands on that end, and a zero-length beam is its own point.
  const on = onBeam(0, 0, 10, 0, 4, 3);
  ok(on[0] === 4 && on[1] === 0, 'a strike beside the beam is drawn on the beam');
  ok(onBeam(0, 0, 10, 0, -5, 2)[0] === 0 && onBeam(0, 0, 10, 0, 25, 2)[0] === 10, 'a strike clamps to the ends');
  ok(onBeam(3, 3, 3, 3, 9, 9)[0] === 3, 'a zero-length beam strikes at the bow');
  // Two beams from one seat are a full super hold apart, never a mere cooldown: the hold
  // is the floor, and the beam must be gone before the next one can be earned.
  ok(BEAM_MS < SUPER_MS, "a beam outlives the super hold — the seat's two lines cannot be one pair");
}
