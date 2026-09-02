/**
 * One knight, drawn *inside* a seat `<g>`.
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
 *     <circle  ring>          static            — React (local seat only)
 *     <circle  respawn arc>   dash offset       — React, once per notification
 *     <g       body>          transform+opacity — WAAPI one-shots (recoil, fall, revive,
 *                                                 idle breathe). Resting values are React
 *                                                 attributes, so a reload with no
 *                                                 animation running still looks right.
 *       <use   key light>     href + flip/bob   — React
 *       <use   knight>        href + flip/bob   — React
 *       <use   flash>         opacity           — WAAPI one-shot
 *     <path    chevron>       static            — React (local seat only)
 *     <rect    hp bar>        React, only when damaged
 *
 * **The walk is driven by displacement, never by a clock.** A standing knight accumulates
 * zero and its legs freeze by construction rather than by a check, and a duplicate
 * notification — 68.4% of the `Players` stream during a fight carries no position change,
 * and the Magic Router delivers every one of them twice — diffs to nothing. See `advance`.
 *
 * The sprite art itself is not here: this draws `<use href="#k0-rest">` and friends, which
 * resolve against the `<defs>` block `tools/gen_knights.py` emits (`docs/art/knights.md`
 * §5). Until those defs exist the `<use>` nodes resolve to nothing and draw nothing —
 * which is the correct failure: no exception, no blank screen, and the art appears the
 * moment the generator lands.
 */
import { useEffect, useRef } from 'react';

import { MAP_TILE, type PlayerSlot } from '@heartrot/client';

import { KNIGHT_DEFS, KNIGHT_SKINS, SPRITE_H, SPRITE_W } from './knights.gen';
import { FACING_UNIT, HP_BAR_W, PAL, SELF_SNAP } from './sprites';

// ---------------------------------------------------------------------------
// The sprite contract with `tools/gen_knights.py`
// ---------------------------------------------------------------------------

/**
 * The canvas, the skin count and the art itself all come out of one `gen_knights.py` pass,
 * so a re-traced sheet cannot leave this file describing a canvas that no longer exists.
 * These were three hand-typed numbers until the generator existed.
 */
const KNIGHT_SPRITE_W = SPRITE_W;
const KNIGHT_SPRITE_H = SPRITE_H;
const KNIGHT_SKIN_COUNT = KNIGHT_SKINS.length;

/**
 * `rest` doubles as the walk's pass frame (with a one-unit bob) and as the respawn and
 * standing pose. `fallen` is a lossless 90° transpose, so it arrives on a transposed
 * canvas. `sil` is the flat union silhouette used for the hit flash.
 */
export type KnightPose = 'rest' | 'contactL' | 'contactR' | 'fallen' | 'sil';

/** Canvas each pose is emitted on. Only `fallen` is transposed. */
function poseBox(pose: KnightPose): readonly [number, number] {
  return pose === 'fallen' ? [KNIGHT_SPRITE_H, KNIGHT_SPRITE_W] : [KNIGHT_SPRITE_W, KNIGHT_SPRITE_H];
}

/**
 * The `<defs>` id for a pose. `skin_id` is clamped here and this is the **only** place it
 * is read: the program stores `data[1]` verbatim and only the Worker range-checks it, so a
 * session key signing `join` straight against the ER can seat a `skin_id` of 200. An
 * unclamped lookup would throw inside the render of all twenty seats, not just the bad one.
 */
export function knightPoseId(skinId: number, pose: KnightPose): string {
  const skin = Number.isInteger(skinId) && skinId >= 0 && skinId < KNIGHT_SKIN_COUNT ? skinId : 0;
  return `k${skin}-${pose}`;
}

/**
 * Paint order for the pit: ascending authoritative `y`, so a knight lower on screen
 * occludes the one behind it. SVG has no `z-index`; document order is the only depth cue a
 * three-quarter view gets.
 *
 * Sorted on the **authoritative** `y`, never the interpolated one — this runs in the React
 * render at notification rate, and sorting a lerping value makes two knights swap order
 * mid-crossing, which flickers. Ties break on `seat` or two knights standing level trade
 * places on every notification.
 */
export function knightDrawOrder(slots: readonly PlayerSlot[]): PlayerSlot[] {
  return slots.filter((s) => s.occupied).sort((a, b) => a.y - b.y || a.seat - b.seat);
}

/**
 * The fifteen pose groups, as one element for the arena `<svg>`'s `<defs>` to mount.
 *
 * Built at module load and frozen: it holds ~4,300 static subpaths and React must never
 * walk it again. `dangerouslySetInnerHTML` is the only way to put generated SVG markup
 * inside an SVG parent — the string is a build artefact of `tools/gen_knights.py` over a
 * checked-in asset, not anything a user can reach.
 */
export const KNIGHT_POSE_DEFS = (
  <g id="knight-poses" dangerouslySetInnerHTML={{ __html: KNIGHT_DEFS }} />
);

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * `PlayerSlot.x/.y` land at the canvas centre, so the `<use>` sits at a static negative
 * offset and nothing is computed per frame. Written as `-(w >> 1)` rather than copied from
 * `gen_hitboxes.py`'s `-round(w/2)`: Python rounds bankers' at .5 and the parity of an odd
 * canvas is exactly what this depends on.
 *
 * Flipped, the offset is the *other* half — `-(w - (w >> 1))` — which is what keeps a
 * mirrored knight standing in the same place as an unmirrored one instead of one unit left.
 */
function anchorX(w: number, flip: boolean): number {
  return flip ? -(w - (w >> 1)) : -(w >> 1);
}

/**
 * Per-skin key light — the rim of accent colour behind each body, one unit up-left.
 *
 * `docs/review/art.md` finding 3 measured the shipped sprites against the pit floor at its
 * stated p50 (sRGB 53) and found every skin under the legibility floor: **Nocturne 1.91:1,
 * Argent 2.11:1, Cobalt 2.54:1**. (`sprites.ts`'s old "ally 4.35:1" was measured against
 * the deleted primitive circles and is not true of this art.) `mode_downsample` compounds
 * it — the dark keyline takes 49.0% of Argent's surviving pixels and 48.7% of Nocturne's,
 * while the *identifying* accent survives at 56 / 48 / 40 px, 6-7.5% of the body. Three
 * skins at ~2:1 whose identity lives in 6% of their pixels are three dark blobs at 21 px.
 *
 * `sil` is the only pose the generator emits with `fill="currentColor"`, so it is the only
 * one that can be recoloured by a `<use>`; every other pose carries per-path hex fills that
 * an inherited `fill` cannot override. Drawn first inside the body `<g>`, offset one unit,
 * it survives only as the ~13% of pixels the body does not cover — a hard rim, which is how
 * pixel art at this size lights a figure.
 *
 * `accent` is the fill the review identified, and is checked against the art below.
 * `key` is that accent lifted to a common HSL L of 0.72 — hue and saturation untouched, so
 * the rim still *says* Cobalt / Nocturne / Argent. Argent's silver is already brighter than
 * that, so it is its own key light.
 *
 * Measured with the review's own method (WCAG relative luminance, weighted by surviving
 * pixel count, against the same sRGB-53 floor), reproducing its three numbers first:
 *
 *   skin      rim px  rim vs floor   knight vs floor    skin-coloured px
 *   Cobalt      86      5.74:1        2.54 -> 2.87:1     7.5% -> 17.1%
 *   Nocturne    96      5.87:1        1.91 -> 2.40:1     7.1% -> 18.6%
 *   Argent     103      5.98:1        2.11 -> 2.63:1     6.1% -> 18.9%
 *
 * The aggregate barely moves because the rim is 13% of the figure; the *separation* is the
 * point, and that roughly triples. Getting the aggregate over 4.5:1 needs the pit floor
 * lifted too — `Scene.tsx`'s half of the same finding.
 *
 * Opaque, not the review's 0.5. At 0.5 the rim is a blend of the accent and whatever floor
 * it happens to stand on, which (a) makes this file's value depend on a pool gradient
 * another commit is about to change, and (b) measures *worse than doing nothing*: Cobalt's
 * accent is a dark blue, `#2f5585` over the floor at 0.5 is 1.25:1 — invisible — and drags
 * the aggregate from 2.54:1 down to 2.41:1. Opaque and lifted is the same one node.
 *
 * Index is `skin_id`, as in `KNIGHT_SKINS`.
 */
const SKIN_KEY: readonly { readonly accent: string; readonly key: string }[] = [
  { accent: '#2f5585', key: '#95b4da' }, // Cobalt   — blue
  { accent: '#b97055', key: '#d5aa9a' }, // Nocturne — copper
  { accent: '#b4b4c1', key: '#b4b4c1' }, // Argent   — silver, already at key value
];

/** Clamped exactly as `knightPoseId` clamps, and for the same reachable bad `skin_id`. */
function keyLight(skinId: number): string {
  return (SKIN_KEY[skinId] ?? SKIN_KEY[0]!).key;
}

/**
 * The rim offset, in the `<use>`'s own coordinates. One unit up and one unit *left on
 * screen*: a flipped knight is drawn through `scale(-1,1)`, so local +x is screen -x and
 * the sign has to follow the flip or half the raid is lit from the other side.
 */
function keyDx(flip: boolean): number {
  return flip ? 1 : -1;
}

/** Feet-level chrome: the shadow, the local ring and the respawn arc all sit here. */
const FEET_Y = 20;
/** Respawn arc radius, and the circumference its dash pattern is cut from. */
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
  /** Manhattan units travelled. `(d / MAP_TILE) & 3` is the walk frame. */
  d: number;
  /**
   * Did the *last* snapshot move this seat. `d` cannot answer that — it is a cumulative
   * odometer whose only reset is a teleport, so `d !== 0` latches on the first accepted
   * step and never clears, which is what left the idle breathe firing once per seat ever
   * (`docs/review/render.md` finding 3: nineteen standing raiders as statues).
   */
  stepped: boolean;
  /** Held through N and S so a knight walking straight up does not flicker. */
  flip: boolean;
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
    // Facing 0 (north) on a fresh seat: an arbitrary but stable starting side.
    flip: slot.facing >= 5,
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
 *
 * Exported for the self-check at the bottom of this file; nothing else calls it.
 */
export function advance(st: Walk, slot: PlayerSlot, tick: number): void {
  // Manhattan, not Euclidean: the stride only has to count tiles, and a sqrt per seat per
  // notification buys nothing. The diagonal step is (11,11) — Manhattan 22 against 16 for
  // a cardinal, so a diagonal walker cycles 1.375x fast for 15.6 units of real ground.
  //
  // ponytail: unscaled. Ceiling: diagonal legs run 37% quick. Upgrade path: divide the
  // diagonal contribution by 1.414. This is the only fudge factor the art spec permits and
  // it is deliberately not applied until someone says it reads wrong.
  const step = Math.abs(slot.x - st.x) + Math.abs(slot.y - st.y);
  st.d = step > SNAP ? 0 : st.d + step;
  // A teleport is not a stride, so it is not locomotion either: a knight reconciled onto a
  // respawn point should stand and breathe, not finish a step it never took.
  st.stepped = step > 0 && step <= SNAP;
  st.x = slot.x;
  st.y = slot.y;

  // Facing is 0..7 clockwise from north. The art has one pose per knight, so facing can
  // only be a horizontal flip — and N/S hold the previous side, because a flip cannot
  // express "north" and flipping on the way past it strobes.
  if (slot.facing >= 1 && slot.facing <= 3) st.flip = false;
  else if (slot.facing >= 5 && slot.facing <= 7) st.flip = true;

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
  // knights firing is most of what a raid looks like.
  if (slot.lastShotTick > st.lastShotTick) {
    st.lastShotTick = slot.lastShotTick;
    st.shots++;
  }
}

/** The four-frame cycle: contact, pass, contact, pass. One frame per tile stepped. */
function walkPose(d: number): { pose: KnightPose; bob: number } {
  switch ((d / MAP_TILE) & 3) {
    case 0:
      return { pose: 'contactL', bob: 0 };
    case 2:
      return { pose: 'contactR', bob: 0 };
    // The pass frame is `rest` lifted one unit, not a symbol of its own.
    default:
      return { pose: 'rest', bob: -1 };
  }
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface KnightProps {
  slot: PlayerSlot;
  /** `arena.tick`. Only the respawn countdown reads it, once per notification. */
  tick: number;
  /** The seat this browser drives. Gets the chevron and the ground ring. */
  mine?: boolean;
  /** No breathe, no bob, no translation — flash and fade survive as opacity only. */
  reduced?: boolean;
}

export function Knight({ slot, tick, mine = false, reduced = false }: KnightProps) {
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
  const { pose, bob } = dead ? { pose: 'fallen' as KnightPose, bob: 0 } : walkPose(w.d);
  // Both offsets come off the pose's own canvas: `fallen` is transposed, so hard-coding
  // the standing canvas would lay the corpse five units below its own shadow.
  const [pw, ph] = poseBox(pose);
  const ox = anchorX(pw, w.flip);
  const oy = -(ph >> 1);
  const [sw, sh] = poseBox('sil');
  // A knight standing still shows `contactL` at bob 0; the pass frame is the only one that
  // lifts. Under reduced motion the lift goes and the cycle reads as pose changes alone.
  const lift = reduced ? 0 : bob;
  const flipT = w.flip ? 'scale(-1,1) ' : '';
  const knightT = `${flipT}translate(0,${lift})`;

  const bodyRef = useRef<SVGGElement | null>(null);
  const flashRef = useRef<SVGUseElement | null>(null);
  const breathe = useRef<Animation | null>(null);
  // What has already been played, so the effect is a no-op on mount and on every
  // re-render that carried no event.
  const played = useRef({ shots: w.shots, hurts: w.hurts, falls: w.falls, revives: w.revives });

  // The *last* fold, never the odometer. This is a render-rate read of a per-notification
  // fact, so it flips back to false on the first snapshot that carries no movement and the
  // breathe resumes — which is the whole of finding 3.
  const moving = w.stepped && !dead;
  const facingUnit = FACING_UNIT[slot.facing] ?? FACING_UNIT[0]!;

  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const p = played.current;

    if (w.falls !== p.falls) {
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
      body.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 250 });
    } else if (w.shots !== p.shots && !dead && !reduced) {
      // Two units against the aim, rounded so the sprite lands back on the pixel grid.
      const rx = Math.round(-facingUnit[0] * 2);
      const ry = Math.round(-facingUnit[1] * 2);
      body.animate([{ transform: `translate(${rx}px,${ry}px)` }, { transform: 'translate(0px,0px)' }], {
        duration: 120,
        easing: 'ease-out',
      });
    }

    // A flat silhouette at full opacity, faded out. Never a CSS `filter`: twenty
    // `brightness()` nodes is twenty filter layers, and a flat fill is free to composite.
    if (w.hurts !== p.hurts && flashRef.current !== null) {
      flashRef.current.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 120 });
    }

    played.current = { shots: w.shots, hurts: w.hurts, falls: w.falls, revives: w.revives };
  }, [w, w.shots, w.hurts, w.falls, w.revives, dead, reduced, facingUnit]);

  // Idle breathe. A timer is correct *here and only here*: breathing is not locomotion, so
  // there is no displacement to derive it from. One infinite composited animation per idle
  // seat, cancelled the moment the legs take over so the two never fight — and started
  // again the moment they stop, which is what `moving` off `w.stepped` buys.
  //
  // No `if (breathe.current !== null) return` guard: the cleanup below is the only exit
  // from the branch that creates one, so `breathe.current` is provably null on entry here.
  // That guard is how the old latched `moving` turned into a permanent statue — once it
  // held a cancelled animation there was no path back.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    if (reduced || dead || moving) {
      breathe.current?.cancel();
      breathe.current = null;
      return;
    }
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
  }, [reduced, dead, moving]);

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

      {/* Cue 2 of 3 for finding yourself: not occluded by the knights standing behind you,
          and the direct descendant of the old `PLAYER_R + 5` ring. */}
      {mine && (
        <ellipse cy={FEET_Y} rx={15} ry={6} fill="none" stroke={PAL.selfRing} strokeWidth={2} opacity={0.8} />
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

      <g ref={bodyRef} opacity={dead ? 0.55 : 1}>
        {/* Key light. First child, so the body covers all of it but the up-left rim; inside
            the body `<g>`, so the recoil and the breathe carry it rather than leaving it
            behind. `sil` is the standing union, so it is dropped for the corpse — `fallen`
            is a transposed canvas and a standing halo behind a lying body reads as a ghost. */}
        {!dead && (
          <use
            href={`#${knightPoseId(slot.skinId, 'sil')}`}
            x={anchorX(sw, w.flip) + keyDx(w.flip)}
            y={-(sh >> 1) - 1}
            transform={knightT}
            // Both, for the same reason the flash sets both: the generated silhouette may
            // carry `currentColor` or its own fill, and this has to win either way.
            fill={keyLight(slot.skinId)}
            color={keyLight(slot.skinId)}
          />
        )}
        <use href={`#${knightPoseId(slot.skinId, pose)}`} x={ox} y={oy} transform={knightT} />
        <use
          ref={flashRef}
          href={`#${knightPoseId(slot.skinId, 'sil')}`}
          x={anchorX(sw, w.flip)}
          y={-(sh >> 1)}
          transform={w.flip ? 'scale(-1,1)' : undefined}
          // Both, because the generated silhouette may carry its own fill or defer with
          // `currentColor`; whichever it does, it flashes this colour and no other.
          fill={PAL.selfRing}
          color={PAL.selfRing}
          opacity={0}
        />
      </g>

      {/* Cue 1 of 3, and the only one that works when you are completely hidden behind
          another knight. Nine units clear of the helm. */}
      {mine && <path d="M-5,-30 L5,-30 L0,-23 Z" fill={PAL.selfRing} />}

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

// ---------------------------------------------------------------------------
// Self-check
//
// `advance` is the whole animation contract and every one of its failure modes is silent:
// a walk driven by anything but displacement moonwalks, a missing snap guard spins the
// legs across a respawn, a flip that does not hold through N strobes, and an event that
// fires on a duplicate notification fires twice a second forever. Dev-only.
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
  ok(walkPose(0).pose === 'contactL' && walkPose(2 * MAP_TILE).pose === 'contactR', 'the contacts');
  ok(walkPose(MAP_TILE).bob === -1 && walkPose(3 * MAP_TILE).bob === -1, 'the pass frame lifts');

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

  // The flip is authoritative (every client draws the same knight facing the same way) and
  // holds through north and south, which a horizontal mirror cannot express.
  advance(st, slot({ x: 900, y: 900, facing: 6 }), 0);
  ok(st.flip, 'west flips');
  advance(st, slot({ x: 900, y: 900, facing: 0 }), 0);
  ok(st.flip, 'north holds the previous flip');
  advance(st, slot({ x: 900, y: 900, facing: 2 }), 0);
  ok(!st.flip, 'east unflips');

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
  ok(knightPoseId(200, 'rest') === 'k0-rest', 'an out-of-range skin clamps');
  ok(knightPoseId(2, 'rest') === 'k2-rest', 'a valid skin is itself');

  // The key light is the only place in this file that names a colour out of the generated
  // sheet, so it is the only place that can silently drift when the art is re-traced: a
  // rim in a colour the skin no longer wears is exactly the "three dark blobs" this fixes,
  // and nothing throws. Assert each accent is still painted by its own skin.
  ok(SKIN_KEY.length === KNIGHT_SKIN_COUNT, 'one key light per skin');
  SKIN_KEY.forEach(({ accent }, s) => {
    const open = KNIGHT_DEFS.indexOf(`<g id="k${s}-rest">`);
    const group = KNIGHT_DEFS.slice(open, KNIGHT_DEFS.indexOf('</g>', open));
    ok(open >= 0 && group.includes(`fill="${accent}"`), `skin ${s} still paints ${accent}`);
  });
  // Identity is the point: two skins lit the same colour are the blobs, one rim brighter.
  ok(new Set(SKIN_KEY.map((k) => k.key)).size === KNIGHT_SKIN_COUNT, 'every skin lights differently');
  // Screen-left under the mirror is local-right; the same sign both ways lights half the
  // raid from the wrong side and nothing about that reads as a bug.
  ok(keyDx(false) === -1 && keyDx(true) === 1, 'the key light stays up-left through a flip');
  ok(keyLight(200) === SKIN_KEY[0]!.key, 'an out-of-range skin clamps here too');

  // The odd canvas is what makes the mirror lossless; the two halves must differ by one or
  // a flipped knight stands one unit off from an unflipped one.
  ok(anchorX(KNIGHT_SPRITE_W, false) === -16 && anchorX(KNIGHT_SPRITE_W, true) === -17, 'the flip pivot');

  // Ascending y, ties on seat — anything else swaps two level knights every notification.
  const order = knightDrawOrder([
    slot({ seat: 3, y: 50 }),
    slot({ seat: 1, y: 10 }),
    slot({ seat: 2, y: 10 }),
    slot({ seat: 4, y: 0, occupied: false }),
  ]);
  ok(order.map((s) => s.seat).join(',') === '1,2,3', 'draw order is y then seat, occupied only');
}
