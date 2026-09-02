/**
 * One archer, drawn *inside* a seat `<g>`.
 *
 * This component renders the contents of a seat node and never the node itself. The seat
 * `<g>`'s transform is owned outright by the frame loop in `Arena.tsx` (local seat) or by
 * `useSeatInterpolation` (`net/predict.ts`, every remote seat). Two writers on one
 * transform is the bug that produces impossible motion — measured in this project as an
 * inline write being *silently discarded* while a WAAPI animation holds the property — so
 * the node stack below gives every animated property exactly one writer:
 *
 *   seat  <g>                 position          — the existing loops. NOT TOUCHED HERE.
 *     <ellipse shadow>        static            — React
 *     <ellipse ring x2>       static            — React (local seat only)
 *     <circle  respawn arc>   dash offset       — React, once per notification
 *     <circle  charge arc>    dash offset       — WAAPI, one run per hold (local seat only)
 *     <g       body>          transform+opacity — WAAPI one-shots (recoil, fall, revive,
 *                                                 idle breathe). Resting values are React
 *                                                 attributes, so a reload with no
 *                                                 animation running still looks right.
 *       <g     flip>          static per facing — React
 *         <svg rim halo>      viewBox (frame)   — React
 *         <svg body>          viewBox (frame)   — React
 *         <svg charge glow>   opacity           — WAAPI loop (local seat, while ready)
 *         <svg flash>         opacity           — WAAPI one-shot
 *       <use   hit splat>     opacity           — WAAPI one-shot
 *     <path    chevron>       static            — React (local seat only)
 *     <rect    hp bar>        React, only when damaged
 *
 * **The walk is driven by displacement, never by a clock.** A standing archer accumulates
 * zero and its legs freeze by construction rather than by a check, and a duplicate
 * notification — 68.4% of the `Players` stream during a fight carries no position change,
 * and the Magic Router delivers every one of them twice — diffs to nothing. See `advance`.
 *
 * The art is `archer.png`, one atlas for every skin, facing and pose (`tools/archer_sheet.py`
 * through `tools/gen_knights.py`). Each sprite is a nested `<svg viewBox={frame}>` around
 * one `<image>` of the whole atlas: the viewBox is the crop, so there is no `<defs>`, no
 * `clipPath`, and one decoded bitmap for all twenty seats.
 */
import { memo, useEffect, useRef, useState, type Ref } from 'react';

import { CHARGE_MS, MAP_TILE, type PlayerSlot } from '@heartrot/client';

import {
  ARCHER_ATLAS,
  ATLAS_H,
  ATLAS_W,
  FRAMES,
  KNIGHT_SKINS,
  type Dir,
  type FrameKey,
  type Pose,
  type SkinId,
} from './knights.gen';
import { play } from './sfx';
import { FACING_UNIT, HP_BAR_W, PAL, SELF_SNAP } from './sprites';

// ---------------------------------------------------------------------------
// The sprite contract with `tools/gen_knights.py`
// ---------------------------------------------------------------------------

/**
 * `skin_id` is clamped here and this is the **only** place it is read: the program stores
 * `data[1]` verbatim and only the Worker range-checks it, so a session key signing `join`
 * straight against the ER can seat a `skin_id` of 200. An unclamped lookup would throw
 * inside the render of all twenty seats, not just the bad one.
 */
function skinOf(skinId: number): SkinId {
  return (Number.isInteger(skinId) && skinId >= 0 && skinId < KNIGHT_SKINS.length ? skinId : 0) as SkinId;
}

/**
 * Facing is 0..7 clockwise from north. Five directions are authored; the western three
 * are the eastern three mirrored, which the odd canvas makes an exact permutation of
 * columns. `advance` stores the byte verbatim, so every client draws every seat facing
 * the same way — a flip is a fact of the art, never of the walk state.
 */
const DIR_OF: readonly { readonly dir: Dir; readonly flip: boolean }[] = [
  { dir: 'n', flip: false },
  { dir: 'ne', flip: false },
  { dir: 'e', flip: false },
  { dir: 'se', flip: false },
  { dir: 's', flip: false },
  { dir: 'se', flip: true },
  { dir: 'e', flip: true },
  { dir: 'ne', flip: true },
];

function dirOf(facing: number): { readonly dir: Dir; readonly flip: boolean } {
  return DIR_OF[facing] ?? DIR_OF[0]!;
}

/**
 * Paint order for the pit: ascending authoritative `y`, so an archer lower on screen
 * occludes the one behind it. SVG has no `z-index`; document order is the only depth cue a
 * three-quarter view gets.
 *
 * Sorted on the **authoritative** `y`, never the interpolated one — this runs in the React
 * render at notification rate, and sorting a lerping value makes two seats swap order
 * mid-crossing, which flickers. Ties break on `seat` or two archers standing level trade
 * places on every notification.
 */
export function knightDrawOrder(slots: readonly PlayerSlot[]): PlayerSlot[] {
  return slots.filter((s) => s.occupied).sort((a, b) => a.y - b.y || a.seat - b.seat);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * `PlayerSlot.x/.y` land at the canvas centre, so each sprite sits at a static negative
 * offset and nothing is computed per frame. Written as `-(w >> 1)` rather than copied from
 * `gen_hitboxes.py`'s `-round(w/2)`: Python rounds bankers' at .5 and the parity of an odd
 * canvas is exactly what this depends on.
 *
 * Flipped, the offset is the *other* half — `-(w - (w >> 1))` — which is what keeps a
 * mirrored archer standing in the same place as an unmirrored one instead of one unit left.
 */
function anchorX(w: number, flip: boolean): number {
  return flip ? -(w - (w >> 1)) : -(w >> 1);
}

/** Feet-level chrome: the shadow, the local ring, the respawn and charge arcs sit here. */
const FEET_Y = 20;
/** The wide dark tone under every bright line of local-seat chrome. */
const KEYLINE = '#05060a';
/** Arc radius, and the circumference the dash patterns are cut from. */
const ARC_R = 13;
const ARC_C = 2 * Math.PI * ARC_R;

/**
 * Past this a position change was a teleport, not a walk — a reconcile onto a respawn at
 * an entrance. Accumulating it would spin the legs for a dozen frames.
 *
 * `Arena.tsx`'s, imported rather than restated: it is the same threshold
 * `predict.ts::teleported` applies to remote seats, and the gait must reset on exactly the
 * gaps the position snaps on or the legs run while the body teleports.
 */
const SNAP = SELF_SNAP;

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

/** Everything the animation remembers about one seat between notifications. */
interface Walk {
  x: number;
  y: number;
  /** Manhattan units travelled. `floor(d / MAP_TILE) & 3` is the walk frame. */
  d: number;
  /**
   * Did the *last* snapshot move this seat. `d` cannot answer that — it is a cumulative
   * odometer whose only reset is a teleport, so `d !== 0` latches on the first accepted
   * step and never clears, which is what left the idle breathe firing once per seat ever
   * (`docs/review/render.md` finding 3: nineteen standing raiders as statues).
   */
  stepped: boolean;
  /** The chain's byte, verbatim. `dirOf` turns it into a sheet direction and a mirror. */
  facing: number;
  hp: number;
  deaths: number;
  lastShotTick: number;
  /** `arena.tick` when `deaths` last moved, so the respawn arc has a start as well as an end. */
  deathTick: number;
  /** One-shot counters. Monotonic, so a `useEffect` dep fires exactly once per event. */
  shots: number;
  hurts: number;
  falls: number;
  revives: number;
}

function initialWalk(slot: PlayerSlot, tick: number): Walk {
  return {
    x: slot.x,
    y: slot.y,
    d: 0,
    stepped: false,
    facing: slot.facing,
    hp: slot.hp,
    deaths: slot.deaths,
    lastShotTick: slot.lastShotTick,
    deathTick: tick,
    shots: 0,
    hurts: 0,
    falls: 0,
    revives: 0,
  };
}

/**
 * Fold one authoritative snapshot into the walk state. **Every trigger is a value diff
 * against the last snapshot consumed**, never a count of notifications — so a byte-
 * identical duplicate advances nothing, with no bookkeeping to get wrong.
 */
function advance(st: Walk, slot: PlayerSlot, tick: number): void {
  // Manhattan, not Euclidean: the stride only has to count tiles, and a sqrt per seat per
  // notification buys nothing. The diagonal step is (11,11) — Manhattan 22 against 16 for
  // a cardinal, so a diagonal walker cycles 1.375x fast for 15.6 units of real ground.
  //
  // ponytail: unscaled. Ceiling: diagonal legs run 37% quick. Upgrade path: divide the
  // diagonal contribution by 1.414. This is the only fudge factor the art spec permits and
  // it is deliberately not applied until someone says it reads wrong.
  const step = Math.abs(slot.x - st.x) + Math.abs(slot.y - st.y);
  st.d = step > SNAP ? 0 : st.d + step;
  // A teleport is not a stride, so it is not locomotion either: an archer reconciled onto a
  // respawn point should stand and breathe, not finish a step it never took.
  st.stepped = step > 0 && step <= SNAP;
  st.x = slot.x;
  st.y = slot.y;
  st.facing = slot.facing;

  if (slot.hp < st.hp) st.hurts++;
  // `deaths` is the *event*; `hp === 0` is the state. A client that missed a snapshot still
  // sees the counter move.
  if (slot.deaths > st.deaths) {
    st.deaths = slot.deaths;
    st.deathTick = tick;
    st.falls++;
  }
  if (st.hp === 0 && slot.hp > 0) st.revives++;
  st.hp = slot.hp;

  // Works for remote seats, which "I sent a shoot transaction" cannot — and nineteen other
  // archers firing is most of what a raid looks like.
  if (slot.lastShotTick > st.lastShotTick) {
    st.lastShotTick = slot.lastShotTick;
    st.shots++;
  }
}

/** The four-frame cycle: contact, pass, contact, pass. One frame per tile stepped. */
function walkPose(d: number): Pose {
  return `walk${Math.floor(d / MAP_TILE) & 3}` as Pose;
}

// ---------------------------------------------------------------------------
// The charge sink
// ---------------------------------------------------------------------------

/**
 * Tell the local archer it is holding a draw (`true`) or has let go (`false`).
 *
 * A module-scope sink rather than a ref threaded through `App` -> `World` -> `Arena`, the
 * same shape as `Shot.tsx`'s `fireLocal`: there is exactly one local seat on a page and
 * `App.tsx`'s `onCharge` is the one caller. With no local seat mounted it is a no-op.
 * Nothing on chain says "charging" — only the loose carries the bit — so this is purely
 * the local player's own feedback: the draw pose, the arc filling over `CHARGE_MS`, and
 * the arrowhead pulsing once the hold is long enough to send.
 */
export function chargeLocal(on: boolean): void {
  chargeSink?.(on);
}

let chargeSink: ((on: boolean) => void) | null = null;

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface KnightProps {
  slot: PlayerSlot;
  /** `arena.tick`. Only the respawn countdown reads it, once per notification. */
  tick: number;
  /** The seat this browser drives. Gets the chevron, the ground ring and the charge. */
  mine?: boolean;
  /** No breathe, no recoil, no glow pulse, no translation — fades survive as opacity only. */
  reduced?: boolean;
}

/**
 * How long a seat must go without an accepted step before it is standing again.
 *
 * `w.stepped` alone cannot answer that. {@link Knight} is memoised on the values it
 * draws, so the notification that WOULD clear the latch — same position, same hp, same
 * everything — produces no render at all, and the seat would hold its last walk frame
 * (and its cancelled breathe) for the rest of its life. That is `docs/review/render.md`
 * finding 3 (nineteen standing raiders as statues) reached by a second route, so the
 * answer moves off the render and onto a clock: five ER slots, against one accepted move
 * per slot while the player is actually walking.
 */
const IDLE_MS = 250;
/** How long the `loose` frame holds after a shot before the arm comes back. */
const LOOSE_MS = 300;
/** One pulse of the ready glow. */
const GLOW_MS = 360;
/** Recoil, in units, uncharged and charged. */
const RECOIL = 2;
const RECOIL_CHARGED = 4;

/** One frame of the atlas at a local offset. The viewBox is the crop. */
function Sprite({
  frame,
  x,
  y,
  opacity,
  ref,
}: {
  frame: FrameKey;
  x: number;
  y: number;
  opacity?: number;
  ref?: Ref<SVGSVGElement>;
}) {
  const [fx, fy, w, h] = FRAMES[frame];
  return (
    <svg ref={ref} x={x} y={y} width={w} height={h} viewBox={`${fx} ${fy} ${w} ${h}`} opacity={opacity}>
      <image href={ARCHER_ATLAS} width={ATLAS_W} height={ATLAS_H} />
    </svg>
  );
}

type Charge = 'off' | 'draw' | 'ready';

function KnightBody({ slot, tick, mine = false, reduced = false }: KnightProps) {
  const state = useRef<Walk | null>(null);
  // Guards the fold against React re-rendering this component with the *same* snapshot —
  // StrictMode's double render, or a parent re-rendering for the bullet feed. The decoder
  // allocates a fresh `PlayerSlot` per notification, so object identity is exactly "is
  // this new state".
  const seen = useRef<PlayerSlot | null>(null);
  const w = (state.current ??= initialWalk(slot, tick));
  if (seen.current !== slot) {
    seen.current = slot;
    advance(w, slot, tick);
  }

  const dead = slot.hp === 0;
  // The *last* fold, never the odometer. This is a render-rate read of a per-notification
  // fact, so it flips back to false on the first snapshot that carries no movement — which
  // is the whole of finding 3.
  const moving = w.stepped && !dead;
  const [standing, setStanding] = useState(true);
  const [loose, setLoose] = useState(false);
  const [charge, setCharge] = useState<Charge>('off');

  const { dir, flip } = dirOf(w.facing);
  const skin = skinOf(slot.skinId);
  const pose: Pose = dead
    ? 'fallen'
    : loose
      ? 'loose'
      : charge === 'ready'
        ? 'charge0'
        : charge === 'draw'
          ? 'draw'
          : standing
            ? 'idle'
            : walkPose(w.d);
  // Both offsets come off the frame's own rect: `fallen` is transposed, so hard-coding
  // the standing canvas would lay the corpse five units below its own shadow.
  const [, , pw, ph] = FRAMES[`${skin}-${dir}-${pose}`];
  const ox = anchorX(pw, flip);
  const oy = -(ph >> 1);
  const flipT = flip ? 'scale(-1,1)' : undefined;

  const bodyRef = useRef<SVGGElement | null>(null);
  const flashRef = useRef<SVGSVGElement | null>(null);
  const glowRef = useRef<SVGSVGElement | null>(null);
  const hitRef = useRef<SVGUseElement | null>(null);
  const arcRef = useRef<SVGCircleElement | null>(null);
  const breathe = useRef<Animation | null>(null);
  const looseTimer = useRef(0);
  // What has already been played, so the effect is a no-op on mount and on every
  // re-render that carried no event.
  const played = useRef({ shots: w.shots, hurts: w.hurts, falls: w.falls, revives: w.revives });

  const facingUnit = FACING_UNIT[slot.facing] ?? FACING_UNIT[0]!;
  const charged = slot.chargedShot;

  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const p = played.current;

    if (w.falls !== p.falls) {
      play('fall');
      // The corpse settles at React's `opacity: 0.55`; `fill: 'none'` (the default) means
      // the animation hands the property straight back when it ends.
      body.animate(
        reduced
          ? [{ opacity: 1 }, { opacity: 0.55 }]
          : [
              { transform: 'translate(0px,0px)', opacity: 1 },
              { transform: 'translate(0px,4px)', opacity: 0.55 },
            ],
        { duration: reduced ? 150 : 200, easing: 'ease-in' },
      );
    } else if (w.revives !== p.revives) {
      play('respawn');
      body.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 250 });
    } else if (w.shots !== p.shots && !dead) {
      // The loose frame, then the arm comes back. The bit on the seat says whether this
      // was a charged shot — the next move clears it, which is the arrow's lifetime. The
      // local seat's loose is cued by `Shot.tsx` at launch, before this edge arrives.
      if (!mine) play(charged ? 'looseCharged' : 'loose');
      setLoose(true);
      clearTimeout(looseTimer.current);
      looseTimer.current = window.setTimeout(() => setLoose(false), LOOSE_MS);
      if (!reduced) {
        // Against the aim, rounded so the sprite lands back on the pixel grid.
        const kick = charged ? RECOIL_CHARGED : RECOIL;
        const rx = Math.round(-facingUnit[0] * kick);
        const ry = Math.round(-facingUnit[1] * kick);
        body.animate([{ transform: `translate(${rx}px,${ry}px)` }, { transform: 'translate(0px,0px)' }], {
          duration: 120,
          easing: 'ease-out',
        });
      }
    }

    // A flat silhouette at full opacity, faded out, and the ordnance splat popped over it.
    // Never a CSS `filter`: twenty `brightness()` nodes is twenty filter layers, and a flat
    // fill is free to composite.
    if (w.hurts !== p.hurts) {
      play('hurt');
      flashRef.current?.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 120 });
      hitRef.current?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { duration: 220 });
    }

    played.current = { shots: w.shots, hurts: w.hurts, falls: w.falls, revives: w.revives };
  }, [w, w.shots, w.hurts, w.falls, w.revives, dead, reduced, facingUnit, charged, mine]);

  useEffect(() => () => clearTimeout(looseTimer.current), []);

  // Standing is a clock, for {@link IDLE_MS}'s reason. `w.d` — the stride odometer, which
  // rises on every accepted step and on nothing else — is a dependency so each step
  // re-arms it; under memoisation the seat that stops walking gets no further render, so
  // the timer left by its LAST step is what stands it up again.
  useEffect(() => {
    if (!moving) {
      setStanding(true);
      return;
    }
    setStanding(false);
    const idle = window.setTimeout(() => setStanding(true), IDLE_MS);
    return () => clearTimeout(idle);
  }, [moving, w.d]);

  // Idle breathe. A timer is correct *here and only here*: breathing is not locomotion, so
  // there is no displacement to derive it from. One infinite composited animation per
  // standing seat, cancelled the moment the legs take over so the two never fight.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null || reduced || dead || !standing) return;
    breathe.current = body.animate(
      [
        { transform: 'translate(0px,0px)', offset: 0 },
        { transform: 'translate(0px,0px)', offset: 0.499 },
        { transform: 'translate(0px,-1px)', offset: 0.5 },
        { transform: 'translate(0px,-1px)', offset: 1 },
      ],
      { duration: 1200, iterations: Infinity },
    );
    return () => {
      breathe.current?.cancel();
      breathe.current = null;
    };
  }, [reduced, dead, standing]);

  // The charge sink. Only the local seat listens; `ready` is the moment the hold is long
  // enough for the chain to accept the bit, and the same moment the arc closes — so the
  // ready cue is played here, where that moment is known, and nowhere else.
  useEffect(() => {
    if (!mine) return;
    let timer = 0;
    const me = (on: boolean): void => {
      clearTimeout(timer);
      if (!on) {
        setCharge('off');
        return;
      }
      setCharge('draw');
      timer = window.setTimeout(() => {
        setCharge('ready');
        play('chargeReady');
      }, CHARGE_MS);
    };
    chargeSink = me;
    return () => {
      clearTimeout(timer);
      if (chargeSink === me) chargeSink = null;
    };
  }, [mine]);

  const charging = charge !== 'off' && !dead;

  // The arc fills once per hold and holds full: `fill: 'forwards'` is the resting value
  // while the node lives, and the node lives exactly as long as the hold. Not gated on
  // reduced motion — it is the progress readout, not decoration.
  useEffect(() => {
    if (!charging) return;
    arcRef.current?.animate([{ strokeDashoffset: `${ARC_C}px` }, { strokeDashoffset: '0px' }], {
      duration: CHARGE_MS,
      easing: 'linear',
      fill: 'forwards',
    });
  }, [charging]);

  // The ready glow: `charge1` over `charge0`, one opacity loop, so the arrowhead pulses
  // between the two baked glow sizes.
  const pulsing = charge === 'ready' && !dead && !reduced;
  useEffect(() => {
    if (!pulsing) return;
    const anim = glowRef.current?.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], {
      duration: GLOW_MS,
      iterations: Infinity,
    });
    return () => anim?.cancel();
  }, [pulsing]);

  // Elapsed fraction of this seat's own death-to-respawn window. `RESPAWN_TICKS` is a chain
  // fact and is deliberately not restated: both ends of the sweep are read off the feed.
  const span = slot.respawnAtTick - w.deathTick;
  const waiting = dead && slot.respawnAtTick > tick && span > 0;
  const progress = waiting ? Math.max(0, Math.min(1, 1 - (slot.respawnAtTick - tick) / span)) : 0;

  const damaged = slot.hpMax > 0 && slot.hp < slot.hpMax && !dead;
  const hp = damaged ? Math.max(0, Math.min(1, slot.hp / slot.hpMax)) : 0;

  return (
    <>
      <ellipse cy={FEET_Y} rx={11} ry={4} fill={PAL.outline} opacity={0.45} />

      {/* Cue 2 of 3 for finding yourself. Two tones, wide dark under narrow bright, because
          one of the two has to be winning on every ground the ring can land on: `#eafff4`
          is 7.94:1 against the darkest sampled floor and `#05060a` is 10.96:1 against a lit
          ally rim or a brazier patch. */}
      {mine && (
        <>
          <ellipse cy={FEET_Y} rx={18} ry={7} fill="none" stroke={KEYLINE} strokeWidth={5} opacity={0.75} />
          <ellipse
            cy={FEET_Y}
            rx={18}
            ry={7}
            fill="none"
            stroke={PAL.selfRing}
            strokeWidth={3}
            opacity={0.9}
          />
        </>
      )}

      {waiting && (
        <circle
          cy={FEET_Y}
          r={ARC_R}
          fill="none"
          stroke={PAL.selfRing}
          strokeWidth={2}
          strokeDasharray={`${ARC_C * progress} ${ARC_C}`}
          transform={`rotate(-90 0 ${FEET_Y})`}
          opacity={0.7}
        />
      )}

      {charging && (
        <circle
          ref={arcRef}
          cy={FEET_Y}
          r={ARC_R}
          fill="none"
          stroke={PAL.ventOpen}
          strokeWidth={2}
          strokeDasharray={ARC_C}
          strokeDashoffset={ARC_C}
          transform={`rotate(-90 0 ${FEET_Y})`}
          opacity={0.85}
        />
      )}

      <g ref={bodyRef} opacity={dead ? 0.55 : 1}>
        {/* One flip for the whole stack: every sprite in it shares the facing. */}
        <g transform={flipT}>
          {/* The rim: the halo baked in the skin's own rim colour, first so the body covers
              everything but the boundary. The corpse gets the transposed one. */}
          <Sprite frame={`halo${skin}-${dir}-${pose}`} x={ox} y={oy} />
          <Sprite frame={`${skin}-${dir}-${pose}`} x={ox} y={oy} />
          {pulsing && <Sprite ref={glowRef} frame={`${skin}-${dir}-charge1`} x={ox} y={oy} opacity={0} />}
          <Sprite ref={flashRef} frame={`sil-${dir}-${pose}`} x={ox} y={oy} opacity={0} />
        </g>
        {/* The ordnance splat, `tools/gen_ordnance.py`'s 18 px `#ord-hit`, centred on the
            hit circle. A symbol with a viewBox needs its size on the `<use>`. */}
        <use ref={hitRef} href="#ord-hit" x={-9} y={-9} width={18} height={18} opacity={0} />
      </g>

      {/* Cue 1 of 3, and the only one that works when you are completely hidden behind another
          archer — so it is never clipped, never faded, and never suppressed while dead: a
          player watching their own respawn countdown still needs to know which corpse is
          theirs. The keyline exists because the chevron's one bad background is an ally's
          lifted rim; `paint-order: stroke` puts it outside the fill so the shape does not
          shrink to pay for it. It cannot be occluded: draw order is ascending `y`, so only an
          ally with a larger `y` paints later, and such an ally's head top sits at worst 29
          units below this chevron (legibility.md §5.4). */}
      {mine && (
        <path
          d="M-8,-36 L8,-36 L0,-24 Z"
          fill={PAL.selfRing}
          stroke={KEYLINE}
          strokeWidth={2}
          paintOrder="stroke"
        />
      )}

      {/* Twenty always-on bars is twenty pieces of chrome over the area the boss art
          occupies. One comparison removes most of them for most of the fight. */}
      {damaged && (
        <>
          <rect x={-HP_BAR_W / 2} y={-26} width={HP_BAR_W} height={4} fill={PAL.hpBack} opacity={0.6} />
          <rect x={-HP_BAR_W / 2} y={-26} width={HP_BAR_W * hp} height={4} fill={PAL.hpFill} />
        </>
      )}
    </>
  );
}

/**
 * Does this seat draw the same picture it drew last time.
 *
 * **The comparison is over VALUES, never over object identity.** Every accepted `move` is
 * one `Players` write, the chain accepts ~322 of them a second at twenty seats, and the
 * decoder allocates a fresh {@link PlayerSlot} for ALL twenty seats on each one — so a
 * shallow prop compare memoises exactly nothing, and an unmemoised `Knight` re-rendered
 * the whole twenty-seat actor layer ~322 times a second for one seat's step. That is the
 * measured root of the frame-budget failure (`docs/perf/frame-budget-17.md` §7 item 2:
 * "the rate has to come down at the REACT boundary, not the socket"). One write now
 * re-renders the one seat it moved.
 *
 * The fields are exactly what this component reads, and it is a closed list on purpose —
 * a field added to the render and forgotten here is a seat that stops updating, which
 * is silent. In render order: position and facing (the walk, via `advance`), `hp`/`hpMax`
 * (the flash, the corpse, the bar), `deaths` and `respawnAtTick` (the fall, the revive,
 * the arc), `lastShotTick` and `chargedShot` (the recoil and the loose), `skinId` (the
 * sprite and its rim). The aim bits of `classAim` are not read here and change every
 * tick, so they are not compared.
 *
 * `advance` reads exactly this subset too, so a skipped snapshot is one that would have
 * folded nothing: the fold stays driven by `seen.current !== slot` and stays correct
 * against whichever snapshot was last *rendered*.
 *
 * `tick` is the one prop that is not a seat fact. Only the respawn arc reads it, so it is
 * a difference only while this seat is dead — otherwise every `Arena` write (half the
 * feed) would re-render all twenty seats to redraw nothing.
 */
function sameSeat(a: KnightProps, b: KnightProps): boolean {
  const p = a.slot;
  const n = b.slot;
  return (
    a.mine === b.mine &&
    a.reduced === b.reduced &&
    p.x === n.x &&
    p.y === n.y &&
    p.facing === n.facing &&
    p.hp === n.hp &&
    p.hpMax === n.hpMax &&
    p.deaths === n.deaths &&
    p.respawnAtTick === n.respawnAtTick &&
    p.lastShotTick === n.lastShotTick &&
    p.chargedShot === n.chargedShot &&
    p.skinId === n.skinId &&
    (a.tick === b.tick || (p.hp > 0 && n.hp > 0))
  );
}

/**
 * One seat, re-rendered only when its own bytes say something changed. See {@link sameSeat}.
 *
 * This also holds the LOCAL seat to the input rate rather than the render rate: `Arena`
 * hands it a `predictedSlot` whose identity discipline exists for the same reason this
 * comparison does, and the two now agree instead of one covering for the other.
 */
export const Knight = memo(KnightBody, sameSeat);

// ---------------------------------------------------------------------------
// Self-check
//
// `advance` is the whole animation contract and every one of its failure modes is silent:
// a walk driven by anything but displacement moonwalks, a missing snap guard spins the
// legs across a respawn, a facing table that mirrors the wrong side draws half the raid
// aiming away from the boss, and an event that fires on a duplicate notification fires
// twice a second forever. Dev-only.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`Knight self-check: ${what}`);
  };

  const slot = (o: Partial<PlayerSlot>): PlayerSlot =>
    ({
      seat: 0,
      occupied: true,
      zone: 0,
      facing: 0,
      chargedShot: false,
      classAim: 0,
      skinId: 0,
      x: 100,
      y: 100,
      hp: 100,
      hpMax: 100,
      lastMoveSeq: 0,
      deaths: 0,
      respawnAtTick: 0,
      lastShotTick: 0,
      lastMoveTick: 0,
      damageDealt: 0,
      sessionPubkey: new Uint8Array(32),
      identity: new Uint8Array(32),
      ...o,
    }) as PlayerSlot;

  const st = initialWalk(slot({}), 0);

  // A duplicate delivery is byte-identical, so it diffs to nothing. This is the whole
  // duplicate-proofing: no counter, no latch, no bookkeeping.
  advance(st, slot({}), 0);
  advance(st, slot({}), 0);
  ok(st.d === 0 && st.shots === 0 && st.hurts === 0, 'a duplicate snapshot advances nothing');

  // One tile stepped is one walk frame, and the cycle is contact / pass / contact / pass.
  advance(st, slot({ x: 100 + MAP_TILE }), 0);
  ok(st.d === MAP_TILE, 'one accepted move is one tile of stride');
  ok(walkPose(0) === 'walk0' && walkPose(2 * MAP_TILE) === 'walk2', 'the contacts');
  ok(walkPose(MAP_TILE) === 'walk1' && walkPose(3 * MAP_TILE) === 'walk3', 'the passes');
  ok(walkPose(4 * MAP_TILE) === 'walk0' && walkPose(22) === 'walk1', 'the cycle wraps and a diagonal counts');

  ok(st.stepped, 'an accepted move reads as moving');

  // The case `docs/review/render.md` finding 3 exists for. `d` is still 16 here; the seat
  // must nevertheless read as standing, or the idle breathe is cancelled for the life of
  // the seat. Getting this wrong the other way — a `stepped` that never becomes true —
  // leaves twenty infinite animations running under the walk, which is worse.
  advance(st, slot({ x: 100 + MAP_TILE }), 0);
  ok(st.d === MAP_TILE && !st.stepped, 'a fold that moves nothing reads as standing');

  // A respawn is a teleport of hundreds of units. Accumulating it would spin the legs.
  advance(st, slot({ x: 900, y: 900 }), 0);
  ok(st.d === 0, 'a teleport resets the stride instead of adding to it');
  ok(!st.stepped, 'a teleport is not locomotion');

  // Facing is stored verbatim and every client draws the same seat the same way; the
  // western half of the compass is the eastern half mirrored, and N and S never mirror.
  advance(st, slot({ x: 900, y: 900, facing: 6 }), 0);
  ok(st.facing === 6, 'facing is the byte');
  ok(dirOf(0).dir === 'n' && !dirOf(0).flip && dirOf(4).dir === 's' && !dirOf(4).flip, 'the poles');
  ok(dirOf(2).dir === 'e' && !dirOf(2).flip && dirOf(6).dir === 'e' && dirOf(6).flip, 'west is east mirrored');
  ok(dirOf(1).dir === 'ne' && dirOf(7).dir === 'ne' && dirOf(7).flip, 'north-west is north-east mirrored');
  ok(dirOf(3).dir === 'se' && dirOf(5).dir === 'se' && dirOf(5).flip, 'south-west is south-east mirrored');
  ok(dirOf(200).dir === 'n', 'a byte the table does not hold degrades to north');

  // hp decreasing is the hit; `deaths` incrementing is the death; hp leaving zero is the
  // respawn. All three are diffs, none is a flag on chain.
  advance(st, slot({ x: 900, y: 900, facing: 2, hp: 60 }), 5);
  ok(st.hurts === 1, 'a hp decrease is one flash');
  advance(st, slot({ x: 900, y: 900, facing: 2, hp: 0, deaths: 1 }), 7);
  ok(st.falls === 1 && st.deathTick === 7, 'the death event stamps its own tick');
  advance(st, slot({ x: 900, y: 900, facing: 2, hp: 100, deaths: 1 }), 9);
  ok(st.revives === 1, 'hp leaving zero is the respawn');

  advance(st, slot({ x: 900, y: 900, facing: 2, lastShotTick: 12 }), 12);
  advance(st, slot({ x: 900, y: 900, facing: 2, lastShotTick: 12 }), 12);
  ok(st.shots === 1, 'a repeated last_shot_tick recoils once');

  // An out-of-range `skin_id` is reachable: the program stores the byte verbatim and only
  // the Worker range-checks it. It must degrade to skin 0, not throw inside twenty seats.
  ok(skinOf(200) === 0 && skinOf(-1) === 0 && skinOf(2) === 2, 'an out-of-range skin clamps');

  // The frame table: every standing frame is the canvas, the corpse is its transpose, and
  // the rim shares its pose's box. Getting this wrong lays the corpse's outline across its
  // own body.
  ok(FRAMES['0-s-idle'][2] === 33 && FRAMES['0-s-idle'][3] === 42, 'the standing canvas');
  ok(FRAMES['1-e-fallen'][2] === 42 && FRAMES['1-e-fallen'][3] === 33, 'the corpse is transposed');
  ok(FRAMES['halo2-n-walk3'][3] === FRAMES['2-n-walk3'][3], 'the halo shares its pose box');
  ok(FRAMES['sil-se-loose'][2] === FRAMES['sil-se-fallen'][3], 'the flash follows the same rule');

  // The odd canvas is what makes the mirror lossless; the two halves must differ by one or
  // a flipped archer stands one unit off from an unflipped one.
  ok(anchorX(33, false) === -16 && anchorX(33, true) === -17, 'the flip pivot');

  // Ascending y, ties on seat — anything else swaps two level archers every notification.
  const order = knightDrawOrder([
    slot({ seat: 3, y: 50 }),
    slot({ seat: 1, y: 10 }),
    slot({ seat: 2, y: 10 }),
    slot({ seat: 4, y: 0, occupied: false }),
  ]);
  ok(order.map((s) => s.seat).join(',') === '1,2,3', 'draw order is y then seat, occupied only');

  // The memo comparison. Every failure mode here is silent in exactly one of two
  // directions: a field left out is a seat that stops updating, a field wrongly included
  // is the twenty-seat re-render this exists to remove, coming straight back.
  const props = (o: Partial<PlayerSlot>, tick = 0): KnightProps => ({ slot: slot(o), tick });
  const base = props({});
  ok(sameSeat(base, props({})), 'a byte-identical seat is skipped');
  ok(!sameSeat(base, props({ x: 100 + MAP_TILE })), 'a step renders');
  ok(!sameSeat(base, props({ facing: 6 })), 'a turn renders');
  ok(!sameSeat(base, props({ hp: 60 })), 'a hit renders');
  ok(!sameSeat(base, props({ hp: 0, deaths: 1 })), 'a death renders');
  ok(!sameSeat(base, props({ respawnAtTick: 30 })), 'a respawn window renders');
  ok(!sameSeat(base, props({ lastShotTick: 12 })), 'a shot renders');
  ok(!sameSeat(base, props({ chargedShot: true })), 'a charged loose renders');
  ok(!sameSeat(base, props({ skinId: 2 })), 'a re-skin renders');
  ok(!sameSeat(base, { ...base, mine: true }), 'the local cues render');
  // The two rows the whole fix rests on. An `Arena` write is half the feed and moves
  // `tick` alone; the aim bits move with every one of them and nothing here draws them.
  ok(sameSeat(base, props({ classAim: 0x3f }, 9)), 'aim and tick alone are skipped');
  ok(
    !sameSeat(props({ hp: 0, deaths: 1, respawnAtTick: 30 }), props({ hp: 0, deaths: 1, respawnAtTick: 30 }, 9)),
    'a dead seat still follows the tick, or its respawn arc freezes',
  );
}
