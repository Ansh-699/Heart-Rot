/**
 * The passage — the beat that covers walking through the gate.
 *
 * Built against `docs/architecture/17-fullscreen-spec.md` §7 (authoritative) and
 * `docs/architecture/15-gate-transition.md` §§3–6 (its evidence). Where the two disagree
 * §17 ships: it adds the `#camera` lift and drops 15 §3.5's departure acknowledgement.
 *
 * WHAT IT IS COVERING, and it is not decoration. `enter_gate` does not walk you through
 * the gate; it calls `tick::entrance_for(seat)` and assigns x/y. Every seat is thrown
 * between 171.0 and 387.2 units sideways — 10.7 to 24.2 tiles, 1,209 ms of walking at one
 * tile per `MOVE_MS` — in ZERO frames, and both renderers already snap rather than chase
 * (`SELF_SNAP` is 64; `predict.ts::teleported` returns true on a zone change outright). So
 * the shipped passage is a hard cut with nothing over it. This file is the only thing that
 * can make that teleport legible.
 *
 * WHY IT WRAPS `<Arena>` RATHER THAN MOUNTING INSIDE IT. The beat owns two values the
 * renderer reads — which room is on screen, and whether the local seat is frozen — and
 * during the cover both of them disagree with the chain ON PURPOSE. Owning them above the
 * renderer is what keeps `Arena` correct with no `Passage` at all: it falls back to §1.7's
 * one rule and simply cuts. The veils travel back down as a slot, because they have to
 * land inside `#camera` to be in the camera's space.
 *
 * FOUR RULES, in the order they constrain the code:
 *
 *   fires once   The trigger is a value diff on `PlayerSlot.zone` — `passageFires` — behind
 *                the `feedEpoch` resync gate. The Magic Router delivers every payload
 *                twice and 68.4 % of `Players` frames carry no position change; a
 *                duplicate diffs to nothing, so there is no latch and no bookkeeping.
 *   never blocks Keys bind to `window`, every node here is `pointer-events: none`, nothing
 *                calls `preventDefault`, no send awaits the beat, and `screenOf` still
 *                swaps on the payload. Only the PICTURE lags — 460 ms in the long form,
 *                140 ms during a live fight. A cinematic that eats the first second of a
 *                fight is a bug; that is exactly what `PASSAGE_LIVE_MS` exists for, and
 *                the HUD reading `arena` while room A is still on screen is deliberate.
 *   cuts once    While the cover is up, `cover.finished` is the ONLY writer of `room`
 *                (`cutsRoom`). `phase` and `feedEpoch` are dependencies of the zone effect
 *                and both change inside a cover in ordinary play — the first player through
 *                the gate causes LOBBY -> MUSTERING on the very payload that opened the
 *                beat — so an unguarded room write there cuts to room B under a veil that
 *                is still fading in, then snaps 480 units when `RISE` is created.
 *                Corollary the renderer depends on: the payload that OPENS the beat does
 *                not advance `room` either, which is what lets `Arena.crossing` see "the
 *                room on screen disagrees with my zone" in the same commit and keep the
 *                local seat mounted with the veil still at opacity 0.
 *   skippable    A pointer or key event finishes every live animation. The end state is
 *                "gone" and the cut hangs off `cover.finished` rather than wall-clock time,
 *                so finishing early IS skipping and a skipper still lands in the right room.
 *   reduced      §10: a 150 ms opacity cross-fade of the flat veil and nothing else. No
 *                lift, no bloom, no wash, no camera move — a full-frame translate is the
 *                one genuinely vestibular thing in this scene. The HOLD survives, because
 *                a hold is not motion; without it the reduced-motion player is the only one
 *                who sees the 24-tile teleport bare.
 *
 * NODE OWNERSHIP (`07-animation.md` §3.2). Every node in the veil layer is created and
 * animated by this file and by nothing else, and only `opacity` and `transform` — both
 * composited — are ever animated. That is why the design is gradient rects fading rather
 * than the more obvious growing `clip-path`, which measured a 21.5 ms worst frame against
 * a 10.9 ms baseline. `#camera` and `#gate-portcullis` are BORROWED: this file plays one
 * WAAPI one-shot on each and never sets an attribute or an inline style on either. If the
 * waiting room ever gives the portcullis an idle sway of its own, that is §3.1's
 * two-writer failure, and it is silent.
 *
 * ON CHAIN: nothing. 0 CU, 0 bytes, 0 accounts. Every fact the beat reads — `zone`, `x`,
 * `y`, `phase` — is already on the wire, and the payload that flips `zone` is the same
 * payload that says where you landed. A client rendering none of this still passes the
 * gate, on the same tick, into the same fight. That is the test, and it is why the hard
 * constraint on ER speed is satisfied trivially rather than carefully.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  BOSS_SPAWN,
  CORE,
  GATE_MAX_X,
  GATE_MAX_Y,
  GATE_MIN_X,
  GATE_MIN_Y,
  MAP_ENTRANCES,
  PHASE_FIGHTING,
  PIT_BOT,
  ZONE_ARENA,
  ZONE_LOBBY,
} from '@heartrot/client';

import { Arena, CAMERA_EASE, usePrefersReducedMotion, type ArenaProps } from './Arena';
import { play } from './sfx';
import { ARENA_UNITS, SELF_SNAP } from './sprites';
import { VIEW_ARENA, VIEW_LOBBY, type Room } from './viewport';

// ---------------------------------------------------------------------------
// Durations. Cosmetic and client-local — `07-animation.md` §6.2 forbids an animation
// length on chain and §6.3 permits it here. None of them is arbitrary.
// ---------------------------------------------------------------------------

/** Within 10 % of the 1,209 ms the chase would take to walk the worst teleport. */
const PASSAGE_MS = 1100;
/** 9.2 tiles of walking, against a throat four tiles deep. Generous, not stingy. */
const COVER_MS = 460;
/** 10 % of one volley period (32 ticks x 100 ms) — the ceiling it respects is 3,200 ms. */
const PASSAGE_LIVE_MS = 320;
/** One write-to-visible round trip: a mid-fight entrant is blind for no longer than the
 *  network already blinds them. */
const COVER_LIVE_MS = 140;
/** `07-animation.md` §5.2's ceiling for the effects reduced motion keeps. */
const REDUCED_MS = 150;
const REDUCED_COVER_MS = 75;

/** The flat veil starts blooming out of the arch before it goes flat. */
const FLAT_LEAD_MS = 115;
/** How much of the reveal the flat veil takes to clear, and the gradient after it. */
const FLAT_OUT = 0.6;
const MOUTH_OUT = 0.5;
/** The creature is not seen the instant the room arrives; the light finds it. */
const BLOOM_DELAY_MS = 100;

/** Room A's arch, lifted by exactly its own height. Derived; never a literal. */
const GATE_LIFT = GATE_MAX_Y - GATE_MIN_Y + 1;
/** The gate block's centre — where the dark blooms out of. */
const GATE_CX = (GATE_MIN_X + GATE_MAX_X + 1) / 2;
const GATE_CY = (GATE_MIN_Y + GATE_MAX_Y + 1) / 2;
/** The throat mouth at room B's south edge — where the light opens from. */
const THROAT_Y = PIT_BOT;

/**
 * How far the eye rises through the gate: `VIEW_LOBBY.y − VIEW_ARENA.y`, 480 units.
 *
 * Read off the two view rects rather than typed, because the move is a pure composited
 * TRANSLATE only while both rooms are the same size — which is the entire payoff of
 * `viewport.ts` deriving both from one `ROOM_H`. At the cut the viewBox is already room
 * B's while `#camera` still shows room A's world band; the animation slides the one into
 * the other. The boss never moves.
 */
const CAMERA_LIFT = VIEW_LOBBY.y - VIEW_ARENA.y;

/**
 * The core, in world units. Both terms are generated — `BOSS_SPAWN` by `gen_map.py`,
 * `CORE` by `gen_hitboxes.py` — so when the boss moves, this light moves with it.
 */
const CORE_X = BOSS_SPAWN[0] + CORE.x;
const CORE_Y = BOSS_SPAWN[1] + CORE.y;
const CORE_R = Math.round(Math.sqrt(CORE.radiusSq));

/**
 * How far the veils reach past the world, per side.
 *
 * `viewport.ts` sizes its `.vp-void` rects from the LIVE fitted box; these are sized once,
 * because a veil is uniform and only has to be big enough. The worst measured surplus is
 * 299 units on a 3440x1392 ultrawide, and the camera lift moves the whole layer 480 units
 * relative to the frame, so half a world clears both with room to spare — one constant
 * instead of a second copy of the two view rects.
 */
const BLEED = 512;
const COVER_X = -BLEED;
const COVER_Y = -BLEED;
const COVER_W = ARENA_UNITS + 2 * BLEED;
const COVER_H = ARENA_UNITS + 2 * BLEED;

/** The dark, matched to `Spawn.tsx`'s veil so the two beats overlap without a seam. */
const VEIL = '#05080f';
/** Room B's temperature, sampled from the served `app/src/render/rooms/arena.png` at px (543, 290). */
const TEAL = '#113541';
/** The vent's own colour, as `Spawn.tsx` reads it. */
const GLOW = '#8fe9ff';

// ---------------------------------------------------------------------------
// Keyframes, at module scope so the self-check can hold every one of them to the
// composited-properties rule. This is what stops the rejected `clip-path` design coming
// back in a later edit that looks harmless.
// ---------------------------------------------------------------------------

const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];
const LIFT: Keyframe[] = [
  { transform: 'translate(0px, 0px)' },
  { transform: `translate(0px, ${-GATE_LIFT}px)` },
];
const WASH: Keyframe[] = [{ opacity: 0.5 }, { opacity: 0 }];
const BLOOM: Keyframe[] = [
  { opacity: 0, transform: 'scale(0.4)' },
  { opacity: 0.35, offset: 0.45 },
  { opacity: 0, transform: 'scale(1.15)' },
];
const RISE: Keyframe[] = [
  { transform: `translate(0px, ${-CAMERA_LIFT}px)` },
  { transform: 'translate(0px, 0px)' },
];
const ALL_KEYFRAMES = [FADE_IN, FADE_OUT, LIFT, WASH, BLOOM, RISE];

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

/**
 * Does this payload open the passage?
 *
 * Exported so the self-check can hold the whole trigger to account: every way it fails is
 * silent. `prev !== next` makes it idempotent under the Router's double delivery;
 * `prev !== null` kills the mid-fight join, which would otherwise replay the beat — and
 * FREEZE the knight — over a fight already in progress; `next === ZONE_ARENA` keeps the
 * incarnation reset silent, because `begin_next_incarnation` putting every slot back in
 * `ZONE_LOBBY` is a return to the waiting room and not a passage.
 */
export function passageFires(prev: number | null, next: number): boolean {
  return prev !== null && prev !== next && next === ZONE_ARENA;
}

const roomOf = (zone: number): Room => (zone === ZONE_ARENA ? 'arena' : 'lobby');

/**
 * Every self-check in this file, module-scope so the two that need a live DOM node can run
 * from inside the layout effect. Every call site is behind `import.meta.env.DEV`, which the
 * bundler folds to `false`, so this whole function leaves the production build.
 */
const ok = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(`Passage self-check: ${what}`);
};

/**
 * Does this payload write `room`?
 *
 * `render2.md` finding 2: `cover.finished` is supposed to be the single owner of the cut,
 * but `phase` and `feedEpoch` are dependencies of the zone effect and its else branch wrote
 * `room` unconditionally — so a LOBBY -> MUSTERING notification landing inside the cover
 * (the FIRST player through the gate causes exactly that, every match) cut to room B at its
 * final framing while the veil was still half transparent and `#camera` was still at
 * identity, then snapped 480 units when `RISE` was created at t = COVER_MS.
 *
 * It is also the Passage half of finding 1. `Arena` closes that one itself — `crossing`
 * (`Arena.tsx:505`) reads "the room on screen disagrees with my seat's zone" in the same
 * commit the payload lands in, and `seatShown` keeps the local seat in room A on the
 * strength of it. That only works while THIS file leaves `room` naming room A on that
 * commit, which is precisely what `fires` denies here. Two files, one fact, and the fact
 * lives where it is owned.
 */
export function cutsRoom(fires: boolean, covering: boolean): boolean {
  return !fires && !covering;
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface PassageProps extends Omit<ArenaProps, 'room' | 'hold' | 'veil'> {
  /**
   * `state.feedEpoch`, bumped whenever the world feed leaves `'live'` (15 §4.2).
   *
   * Without it `prev` survives a reconnect — the renderer does not unmount, `App.tsx`
   * mounts `<World>` as a sibling of the screen switch — and the measured outage is
   * 1,681 ms. Drop in room A, return in room B, and the beat fires and holds your knight
   * over a fight you are already losing.
   *
   * Do NOT substitute `state.status`: `store.ts:415` forces it to `'live'` on every
   * account update, so the payload that needs suppressing is the same payload that repairs
   * the status — the gate would race the thing it gates.
   */
  feedEpoch?: number;
}

/** One beat, its shape fixed at the moment it opened. */
interface Beat {
  /** Distinguishes consecutive beats, so the effect re-runs on a second passage. */
  n: number;
  /**
   * Long form or short, read ONCE at open. Not `phase` from a later render: a muster that
   * ends during a passage must not shorten a beat already running — a beat that changes
   * length mid-flight is a hitch, and `.finished` would resolve against a duration nothing
   * agrees on.
   */
  live: boolean;
  /**
   * The room this beat was opened for. The cut prefers the LATEST zone (`prev`) over it,
   * because the zone effect deliberately writes no room while the cover is up: the two
   * agree on every ordinary passage, and where they do not, the chain has moved the seat
   * back out of room B inside the cover — an incarnation reset landing inside
   * `COVER_LIVE_MS` — and cutting to the room the seat is not in would strand it there
   * until some later payload happened to change `zone`, `phase` or `feedEpoch` again.
   * Still stored, because it is the only answer the no-veil bail below has.
   */
  to: Room;
}

export function Passage(props: PassageProps) {
  const reduced = usePrefersReducedMotion();
  const { arena, players, localSeat, feedEpoch = 0 } = props;
  const zone = localSeat === undefined ? undefined : players.slots[localSeat]?.zone;
  const phase = arena.phase;

  // `undefined` until the roster arrives, so `Arena` uses its own §1.7 fallback rather
  // than being told a room by a component that does not know one yet.
  const [room, setRoom] = useState<Room | undefined>(zone === undefined ? undefined : roomOf(zone));
  const [beat, setBeat] = useState<Beat | null>(null);
  const [hold, setHold] = useState(false);
  const prev = useRef<number | null>(null);
  const epoch = useRef(feedEpoch);
  // `hold`, readable from an effect that must not list it as a dependency. The two move
  // together and only through `setCover`, so there is still ONE hold — this is the same
  // value, not a second one.
  const covering = useRef(false);
  const setCover = (on: boolean): void => {
    covering.current = on;
    setHold(on);
  };

  const mouthA = useRef<SVGRectElement | null>(null);
  const flat = useRef<SVGRectElement | null>(null);
  const mouthB = useRef<SVGRectElement | null>(null);
  const wash = useRef<SVGRectElement | null>(null);
  const bloom = useRef<SVGCircleElement | null>(null);
  const root = useRef<SVGGElement | null>(null);

  // Passive is enough, and deliberately so. The commit that carries the flip must already
  // be safe BEFORE this runs — it is, because `room` still names room A on it and
  // `Arena.crossing` reads that in the same commit. Nothing here races the paint, so
  // nothing here needs the layout phase. The deps are three values that change a handful of
  // times a match, not per notification.
  useEffect(() => {
    if (zone === undefined) return;
    // The feed dropped: this payload is a resync, not a diff. Seeding `prev` with the
    // current zone rather than `null` re-arms on the NEXT payload rather than suppressing
    // two — §4.4 asks for exactly one.
    const resync = epoch.current !== feedEpoch;
    epoch.current = feedEpoch;
    const was = prev.current;
    prev.current = zone;
    // `phase` is a dependency so the beat opens with the phase of the payload that opened
    // it, but a phase-only re-run diffs `was === zone` and fires nothing.
    const opens = !resync && passageFires(was, zone);
    if (opens) {
      setBeat((b) => ({ n: (b?.n ?? 0) + 1, live: phase === PHASE_FIGHTING, to: roomOf(zone) }));
      // Latched here rather than only in the beat's own effect, so `covering` is true for
      // every re-run of THIS effect from the moment the beat opens — which is what finding
      // 2's guard below reads. The beat effect sets it again, because `reduced` changing
      // mid-beat tears that effect down and its cleanup releases the hold; idempotent.
      setCover(true);
    }
    // The ONLY writer of `room` outside the cut. Finding 2: a phase change or a feed
    // resync inside the cover no longer cuts room B in under a half-transparent veil.
    if (cutsRoom(opens, covering.current)) setRoom(roomOf(zone));
  }, [zone, phase, feedEpoch]);

  // Layout, not passive: the veils mount at opacity 0 and must be animating before the
  // browser paints, or the cover starts a frame late over a knight that has already
  // snapped — which is the whole thing it exists to hide.
  useLayoutEffect(() => {
    if (beat === null) return;
    const veil = flat.current;
    if (veil === null) {
      // No veil slot mounted. Cut rather than hold: a hold with nothing covering it is a
      // frozen knight in plain sight, which is strictly worse than the snap. `setCover`
      // rather than a bare `setRoom`, because the zone effect has already latched the hold
      // one commit ago and this path registers no cleanup to release it.
      setCover(false);
      setRoom(beat.to);
      return;
    }
    setCover(true);

    const coverMs = reduced ? REDUCED_COVER_MS : beat.live ? COVER_LIVE_MS : COVER_MS;
    const totalMs = reduced ? REDUCED_MS : beat.live ? PASSAGE_LIVE_MS : PASSAGE_MS;
    const revealMs = totalMs - coverMs;
    const long = !reduced && !beat.live;

    const anims: Animation[] = [];
    const push = (a: Animation | null | undefined): void => {
      if (a != null) anims.push(a);
    };
    // Room A's own nodes, borrowed for one one-shot each. `null` while the waiting room
    // has not drawn them, which is why this is a query and not a hard dependency.
    const inRoomA = (id: string): SVGGraphicsElement | null | undefined =>
      root.current?.ownerSVGElement?.querySelector<SVGGraphicsElement>(id);

    // ---- the cover ------------------------------------------------------
    //
    // Long form: the dark blooms out of the arch first and the flat veil finishes the
    // occlusion behind it, so the room is swallowed by the doorway rather than dipped to
    // black. Short and reduced forms are the flat veil alone.
    const lead = long ? FLAT_LEAD_MS : 0;
    const cover = veil.animate(FADE_IN, {
      duration: coverMs - lead,
      delay: lead,
      easing: 'ease-in',
      fill: 'forwards',
    });
    push(cover);

    if (long) {
      push(mouthA.current?.animate(FADE_IN, { duration: 230, easing: 'ease-in', fill: 'forwards' }));
      const portcullis = inRoomA('#gate-portcullis');
      if (import.meta.env.DEV) {
        // Spec §12.2 check 6, the two-writer check for the one node this file BORROWS.
        // It cannot run at module load — the node belongs to room A's tree — so it runs
        // here, on the node already in hand. A second `#gate-portcullis` would take the
        // LIFT while the drawn one sat still; a CSS animation on it would fight the LIFT
        // for `transform` and lose or win at random. Both are silent (§3.1).
        const all = root.current?.ownerSVGElement?.querySelectorAll('#gate-portcullis');
        ok(all?.length === 1, `exactly one #gate-portcullis in room A (${all?.length ?? 0})`);
        ok(getComputedStyle(portcullis as Element).animationName === 'none', 'the portcullis has no CSS animation of its own');
      }
      // The last moment room A is the room.
      push(portcullis?.animate(LIFT, { duration: 180, easing: 'ease-out', fill: 'forwards' }));
      play('gate');
      // Nothing else in room A moves: the sign, the tower and the braziers are paint in
      // `LOBBY_IMG`, and the portcullis is the one thing `gen_rooms.py` cuts out of that
      // painting (`GATE_IMG`) precisely so it can.
    }

    // Skip. `finish()` jumps to the last keyframe; because the cut hangs off
    // `cover.finished` rather than a timer, a skipper still lands in the right room, and
    // the reveal's own animations are pushed into the same array so a second skip finishes
    // those too. `finish()` on an already-finished animation is a no-op, so the double
    // fire needs no guard and there is exactly one way out.
    const skip = (): void => {
      for (const a of anims) a.finish();
    };
    addEventListener('pointerdown', skip, { passive: true });
    addEventListener('keydown', skip, { passive: true });

    let alive = true;
    cover.finished
      .then(() => {
        if (!alive) return;
        // ---- the cut ----------------------------------------------------
        //
        // Chained to the veil's own completion and not to a `setTimeout`: timers and WAAPI
        // are throttled by different mechanisms under a backgrounded tab, and
        // `cover.finished` cannot drift from the veil because it IS the veil.
        //
        // `beat.to` is the room this beat was opened for; `prev.current` is the last thing
        // the chain said, and the zone effect deliberately wrote no room while the cover
        // was up. They differ only when a payload flipped `zone` back inside the cover —
        // an incarnation reset landing inside `COVER_LIVE_MS` — and cutting to the room the
        // seat is actually in is the whole point of the cut. Normally identical.
        setRoom(prev.current === null ? beat.to : roomOf(prev.current));
        setCover(false);

        push(veil.animate(FADE_OUT, { duration: revealMs * FLAT_OUT, easing: 'ease-out', fill: 'forwards' }));
        if (!reduced) {
          // The eye rises through the gate into the pit. A pure composited translate over
          // the boss's filter.
          push(
            root.current
              ?.ownerSVGElement?.querySelector<SVGGraphicsElement>('#camera')
              ?.animate(RISE, { duration: revealMs, easing: CAMERA_EASE, fill: 'both' }),
          );
        }
        if (long) {
          // The arena resolves outward from the place you walked in.
          push(
            mouthB.current?.animate(FADE_OUT, { duration: revealMs * MOUTH_OUT, easing: 'ease-out', fill: 'forwards' }),
          );
          // Warm to cold. The first sight of room B is bluer than its resting state and
          // settles into it, so the temperature change reads as a settle, not a switch.
          push(wash.current?.animate(WASH, { duration: revealMs, easing: 'linear', fill: 'forwards' }));
          // And the boss is seen.
          push(
            bloom.current?.animate(BLOOM, {
              duration: revealMs - BLOOM_DELAY_MS,
              delay: BLOOM_DELAY_MS,
              easing: 'ease-out',
              fill: 'forwards',
            }),
          );
        }
        return Promise.all(anims.map((a) => a.finished));
      })
      // `.finished` rejects on `cancel()`, which is not an error — it is the beat being
      // called off, and the cleanup below has already released the hold.
      .catch(() => {})
      .then(() => {
        if (alive) setBeat(null);
      });

    return () => {
      alive = false;
      // Release 2 of 3, unconditional: unmount, a re-render that tears the beat down, an
      // incarnation reset and a `settle` mid-passage all free the knight here. Release 1
      // is `cover.finished` above; release 3 is `Arena`'s own `HOLD_CEILING_MS`, which is
      // the only one that survives this component misbehaving.
      setCover(false);
      removeEventListener('pointerdown', skip);
      removeEventListener('keydown', skip);
      // Every borrowed node returns to its resting state on cancel — the camera and the
      // portcullis untransformed, the sign at its own opacity — which is also how room A's
      // arch is put back down before an incarnation reset ever shows it again.
      for (const a of anims) a.cancel();
    };
  }, [beat, reduced]);

  // Static: no props, no dependency array, one identical element for the life of the page.
  // A `useMemo` with dependencies here is the 11.2 ms/frame reconciliation `Scene.tsx`
  // already measured and paid to remove.
  const veils = useMemo(
    () => (
      <g ref={root} pointerEvents="none" aria-hidden="true" shapeRendering="geometricPrecision">
        <defs>
          {/* `userSpaceOnUse`, so both blooms are centred in WORLD units on the arch and on
              the throat, and do not follow the rect that carries them. */}
          <radialGradient id="heartrot-passage-mouth-a" gradientUnits="userSpaceOnUse" cx={GATE_CX} cy={GATE_CY} r={900}>
            <stop offset="0" stopColor={VEIL} stopOpacity={1} />
            <stop offset="0.35" stopColor={VEIL} stopOpacity={0.85} />
            <stop offset="1" stopColor={VEIL} stopOpacity={0} />
          </radialGradient>
          <radialGradient
            id="heartrot-passage-mouth-b"
            gradientUnits="userSpaceOnUse"
            cx={GATE_CX}
            cy={THROAT_Y}
            r={900}
          >
            <stop offset="0" stopColor={VEIL} stopOpacity={0} />
            <stop offset="0.35" stopColor={VEIL} stopOpacity={0.8} />
            <stop offset="1" stopColor={VEIL} stopOpacity={1} />
          </radialGradient>
        </defs>
        {/* 0–230 ms: the mouth darkens, blooming out of the arch. */}
        <rect
          ref={mouthA}
          x={COVER_X}
          y={COVER_Y}
          width={COVER_W}
          height={COVER_H}
          fill="url(#heartrot-passage-mouth-a)"
          opacity={0}
        />
        {/* 115–460 ms: the swallow completes. The one node the reduced form uses. */}
        <rect ref={flat} x={COVER_X} y={COVER_Y} width={COVER_W} height={COVER_H} fill={VEIL} opacity={0} />
        {/* 460–780 ms: the light opens from the steps you walked in through. */}
        <rect
          ref={mouthB}
          x={COVER_X}
          y={COVER_Y}
          width={COVER_W}
          height={COVER_H}
          fill="url(#heartrot-passage-mouth-b)"
          opacity={0}
        />
        {/* 460–1100 ms: warm to cold. */}
        <rect ref={wash} x={COVER_X} y={COVER_Y} width={COVER_W} height={COVER_H} fill={TEAL} opacity={0} />
        {/* 560–1100 ms: the boss is SEEN — a transient light drawn over the rig, exactly as
            `Spawn.tsx`'s flare is. `Boss.x`/`.y` are written by `init` and by nothing else.
            `transform-box` is not optional: without it the scale origin is the viewBox
            corner and the bloom lands somewhere the boss is not (`07-animation.md` §3.3). */}
        <circle
          ref={bloom}
          cx={CORE_X}
          cy={CORE_Y}
          r={CORE_R * 3}
          fill={GLOW}
          opacity={0}
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        />
      </g>
    ),
    [],
  );

  // Spread whole, so `feedEpoch` rides through to `<Spawn>` the moment `ArenaProps`
  // declares and forwards it — `Spawn.tsx` takes the identical resync gate against `phase`
  // and today defaults to no gate, which is the reconnect replay 15 §1.5 names. Nothing
  // else in `props` is unknown to `Arena`.
  return <Arena {...props} room={room} hold={hold} veil={veils} />;
}

// ---------------------------------------------------------------------------
// Self-check
//
// Dev-only, same shape as `Spawn.tsx`'s and `Arena.tsx`'s. Every bug below is silent: a
// trigger that double-fires looks like a renderer bug, a leaked hold looks like a frozen
// knight, and a non-composited keyframe looks like nothing at all until someone reads a
// frame trace and finds a dropped frame.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  // 1. The trigger (15 §11 check 1).
  ok(passageFires(ZONE_LOBBY, ZONE_ARENA), 'walking the gate opens the passage');
  ok(!passageFires(ZONE_ARENA, ZONE_ARENA), 'a duplicate payload is silent');
  ok(!passageFires(null, ZONE_ARENA), 'arriving mid-fight does not replay the passage');
  ok(!passageFires(ZONE_ARENA, ZONE_LOBBY), 'the incarnation reset is not a passage');

  // 2. The teleport is still bigger than the snap threshold (15 §11 check 4). If a map
  //    redraw ever brings an entrance within `SELF_SNAP` of the gate, that seat CHASES
  //    instead of snapping and the hold freezes a knight mid-walk — a different bug
  //    wearing this one's clothes.
  const nearest = Math.min(...MAP_ENTRANCES.map(([x, y]) => Math.hypot(x - GATE_CX, y - GATE_CY)));
  ok(nearest > SELF_SNAP, `every entrance is farther than SELF_SNAP from the gate (${nearest.toFixed(1)})`);

  // 3. Only composited properties are animated (15 §11 check 5). This is what stops the
  //    `clip-path` design — worst frame 21.5 ms against a 10.9 ms baseline — coming back.
  for (const frames of ALL_KEYFRAMES) {
    for (const f of frames) {
      for (const k of Object.keys(f)) {
        ok(k === 'opacity' || k === 'transform' || k === 'offset', `${k} is not a composited property`);
      }
    }
  }

  // 4. The geometry is derived, not typed (15 §11 check 7).
  ok(GATE_LIFT === GATE_MAX_Y - GATE_MIN_Y + 1 && GATE_LIFT > 0, 'the lift is the arch height');
  ok(GATE_CX === (GATE_MIN_X + GATE_MAX_X + 1) / 2, 'the arch bloom is centred on the arch');
  ok(VIEW_LOBBY.h === VIEW_ARENA.h && VIEW_LOBBY.w === VIEW_ARENA.w, 'the rise is a pure translate');
  ok(CAMERA_LIFT > 0, 'the eye rises through the gate, not down through it');

  // 5. The forms are ordered, and the live one cannot eat the fight.
  ok(COVER_LIVE_MS < COVER_MS && PASSAGE_LIVE_MS < PASSAGE_MS, 'the live form is the short one');
  ok(PASSAGE_LIVE_MS <= 320, 'the live beat is a tenth of a volley period');
  ok(REDUCED_MS <= 150 && REDUCED_COVER_MS < REDUCED_MS, 'reduced motion stays inside the 150 ms ceiling');
  ok(FLAT_LEAD_MS < COVER_MS, 'the flat veil finishes the cover it starts inside');
  ok(BLOOM_DELAY_MS < PASSAGE_MS - COVER_MS, 'the bloom fits inside the reveal');

  // 6. Who writes `room` — the check that would have caught BOTH open findings, and the
  //    reason neither was caught before is that every check in this file was a pure
  //    function while both defects were ordering. This makes the ordering a pure function.
  //
  //    Finding 2: `cover.finished` is the only writer of the cut. The LOBBY -> MUSTERING
  //    notification that the FIRST player through the gate causes every match re-runs the
  //    zone effect inside the cover; the else branch used to set the room from `zone` on
  //    the spot, so room B appeared at its final framing through a half-transparent veil
  //    and then snapped 480 units when `RISE` was created at t = COVER_MS.
  ok(!cutsRoom(false, true), 'a phase change inside the cover does not cut the room');
  ok(cutsRoom(false, false), 'with no cover up the room follows the chain immediately');
  //    Finding 1: the payload that OPENS the beat must not also advance the room, or
  //    `Arena.crossing` reads `roomOf(zone) === shown` on that very commit, `seatShown`
  //    stops keeping the local seat, and the knight is unmounted from room A with the veil
  //    still at opacity 0 — "I cannot see my character", at the exact moment the beat
  //    exists to prevent it.
  ok(!cutsRoom(true, false), 'the payload that opens a beat does not also cut');
}
