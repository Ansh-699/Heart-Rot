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
 *     <ellipse ring x2>       static            — React (local seat only)
 *     <circle  respawn arc>   dash offset       — React, once per notification
 *     <g       body>          transform+opacity — WAAPI one-shots (recoil, fall, revive,
 *                                                 idle breathe). Resting values are React
 *                                                 attributes, so a reload with no
 *                                                 animation running still looks right.
 *       <use   rim halo>      href + flip/bob   — React
 *       <use   knight>        href + flip/bob   — React
 *       <g     archer kit>    flip/bob          — React (archers only)
 *         <path arrow>        transform+opacity — WAAPI one-shot (loose)
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
import { memo, useEffect, useRef } from 'react';

import { CLASS_ARCHER, MAP_TILE, classOf, type PlayerSlot } from '@heartrot/client';

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
 * canvas. `sil` is the flat union silhouette used for the hit flash. `halo` / `halo-fallen`
 * are that union dilated two units and minus itself — the boundary rim `docs/art/
 * legibility.md` §3.1 derives, generated so nothing here has to dilate a `<use>`.
 */
export type KnightPose = 'rest' | 'contactL' | 'contactR' | 'fallen' | 'sil' | 'halo' | 'halo-fallen';

/** Canvas each pose is emitted on. Only the two fallen poses are transposed. */
function poseBox(pose: KnightPose): readonly [number, number] {
  return pose === 'fallen' || pose === 'halo-fallen'
    ? [KNIGHT_SPRITE_H, KNIGHT_SPRITE_W]
    : [KNIGHT_SPRITE_W, KNIGHT_SPRITE_H];
}

/**
 * Does the checked-in sheet carry the dilated halo groups yet.
 *
 * A dangling `<use href>` renders nothing and throws nothing, so shipping the halo href
 * against a sheet that predates it is twenty knights with **no** boundary rim at all —
 * strictly worse than the one-sided key light it replaces, and invisible in review. One
 * substring test over a module-scope string, evaluated once at load.
 *
 * ponytail: a compatibility branch. Ceiling: until `tools/gen_knights.py` emits the halo
 * and `knights.gen.ts` is regenerated, the rim stays the shipped up-left offset and the
 * down-right edge keeps measuring 1.06:1. Upgrade path: re-run the generator, then delete
 * this const and the two ternaries that read it.
 */
const HAS_HALO = KNIGHT_DEFS.includes('id="k0-halo"');

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
 * Per-skin rim light — the boundary contrast, drawn behind each body as the generated
 * two-unit halo (`docs/art/legibility.md` §3.1, §3.2).
 *
 * **The metric is the boundary, not the average.** Over 60% of every skin is its own dark
 * keyline (p5 and p25 of all three sit at Y = 0.0076), so an area-weighted body-vs-floor
 * number measures the wrong thing and cannot be fixed anyway: 4.5:1 against image B's p95
 * lit ring stone needs a body 3.10x Cobalt / 4.58x Nocturne, which is re-tracing the sheet.
 * WCAG 1.4.11 is defined on the boundary of a graphical object, and that is reachable.
 *
 * The rim value is solved, not chosen: `4.5 x (0.0767 + 0.05) - 0.05 = 0.5202`, where
 * 0.0767 is the brightest floor either reference scene samples. Each accent's HSL lightness
 * is lifted until its relative luminance reaches that, hue and saturation untouched, so the
 * rim still *says* Cobalt / Nocturne / Argent. Measured with `docs/art/legibility.py`, worst
 * over all ten sampled floor percentiles of both scenes:
 *
 *   skin      accent    rim        Y       worst   on its own contact shadow
 *   Cobalt    #2f5585   #a8c1e0    0.5185  4.49:1  7.02:1
 *   Nocturne  #b97055   #dcb7aa    0.5198  4.50:1  7.03:1
 *   Argent    #b4b4c1   #bebec9    0.5199  4.50:1  7.04:1
 *
 * Cobalt's 4.49 is 4.5:1 only to two significant figures and is the binding case; it occurs
 * on image B's p95 alone. The "contact shadow" column is why the `<ellipse>` at `FEET_Y` is
 * load-bearing and not decoration: the knight lands its rim on ground it has itself darkened.
 * Rim against the sprite's own keyline is 9.9:1, so the halo reads as a halo, not as body.
 *
 * Two values this supersedes, so nobody restores them from an older document: the common
 * HSL L of 0.72 the previous rims were solved to (`#95b4da` / `#d5aa9a` / `#b4b4c1`, worst
 * 3.88-4.04:1 on these scenes), and `sprites.ts`'s "ally 4.35:1", which was measured against
 * the primitive circles that predate this art and was never true of it.
 *
 * The rim is **opaque**, not the 0.5 the original review asked for. At 0.5 it is a blend of
 * the accent and whatever floor it happens to stand on, which makes this file's value depend
 * on a pool gradient another commit is about to change and measures *worse than doing
 * nothing*: Cobalt's accent is a dark blue, and `#2f5585` over the floor at 0.5 is 1.25:1.
 *
 * `accent` is the fill each skin actually paints and is checked against the art below; the
 * halo groups are emitted `fill="currentColor"` exactly as `sil` is, which is what lets one
 * `<use>` colour them (every other pose carries per-path hex fills an inherited `fill`
 * cannot override).
 *
 * Index is `skin_id`, as in `KNIGHT_SKINS`.
 */
const SKIN_KEY: readonly { readonly accent: string; readonly key: string }[] = [
  { accent: '#2f5585', key: '#a8c1e0' }, // Cobalt   — blue
  { accent: '#b97055', key: '#dcb7aa' }, // Nocturne — copper
  { accent: '#b4b4c1', key: '#bebec9' }, // Argent   — silver
];

/** Clamped exactly as `knightPoseId` clamps, and for the same reachable bad `skin_id`. */
function keyLight(skinId: number): string {
  return (SKIN_KEY[skinId] ?? SKIN_KEY[0]!).key;
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
// The archer kit
//
// There is no archer sheet: `gen_knights.py` traces one body per skin and re-tracing it is
// out of scope here. So the class reads as **authored vector geometry hung on the shared
// body**, drawn in the sprite's own local frame so the flip, the bob, the recoil, the
// breathe, the fall and the revive all carry it for free.
//
// It has to survive 21 device pixels, which rules out detail and rules in silhouette. The
// bow is the whole read: a 36-unit recurve arc at local x 12..19, entirely outside the body's
// own x -8..11, so an archer breaks the knight outline at a glance and from any distance. The
// quiver's fletchings break it again above the shoulder, and the nocked arrow crosses the
// body horizontally — three orthogonal directions of silhouette change, none of them colour,
// which is also what keeps the class legible to a dichromat.
//
// Local +x is forward: `flip` is false for facings 1..3 (NE/E/SE), and the whole kit sits
// inside the same `scale(-1,1)` group as the body, so a west-facing archer mirrors with it.
//
// Two tones everywhere, the same construction the sprites and the local marker use: a wide
// `#05060a` keyline under a narrow `#e0d3ae` fill. Measured with `docs/art/legibility.py`'s
// own method: `#e0d3ae` is Y 0.6549, worst 5.57:1 over all ten sampled floor percentiles of
// both scenes, and 13.60:1 against the keyline — so whichever ground the bow crosses, floor
// or lit ally rim, one of the two tones is winning. Nothing is thinner than 2 units
// (`docs/art/legibility.md` §4.2's device-pixel floor).
// ---------------------------------------------------------------------------

const KIT_LIGHT = '#e0d3ae';
const KEYLINE = '#05060a';

/**
 * The bow limbs and the drawn string, as one two-subpath outline drawn twice.
 *
 * The sprite content sits at local x -8..11 (canvas 8..27 under `anchorX`'s -16), so a bow at
 * x 12..19 is entirely *outside* the knight outline, and its tips at y -23 / 13 clear the helm
 * top at -20. That is the whole silhouette argument: at any size where the knight is a shape
 * rather than a texture, an archer is the shape with a bow beside it.
 */
const BOW_D = 'M12,-23 Q22,-5 12,13 M12,-23 L5,-5 L12,13';
/**
 * Quiver, and the fletchings clearing the shoulder. Two subpaths, one filled path.
 * The fletch tops out at y -24, which is exactly where the local-seat chevron's point ends.
 */
const KIT_D = 'M-12,-16 L-6,-19 L-2,-4 L-8,-1 Z M-13,-21 L-7,-24 L-5,-19 L-11,-16 Z';
/** The nocked arrow: shaft from the string's nock, through the bow, with a head. */
const ARROW_D = 'M5,-6.2 L18,-6.2 L18,-8 L23,-5 L18,-2 L18,-3.8 L5,-3.8 Z';

/**
 * Everything about the kit that never changes, as one element built once at module load and
 * shared by all twenty seats. Only the arrow needs a ref, so only the arrow is per-seat.
 */
const ARCHER_STATIC = (
  <>
    <path d={BOW_D} fill="none" stroke={KEYLINE} strokeWidth={5} strokeLinecap="round" />
    <path d={BOW_D} fill="none" stroke={KIT_LIGHT} strokeWidth={2.6} strokeLinecap="round" />
    <path d={KIT_D} fill={KIT_LIGHT} stroke={KEYLINE} strokeWidth={2} paintOrder="stroke" />
  </>
);

/**
 * Draw and loose, as one WAAPI one-shot on one node.
 *
 * The resting state is **drawn**: the string is bent back to a nock at local x 5 and the
 * arrow sits on it. That is the honest resting pose for a class whose whole silhouette is
 * "about to shoot", and it means the shot event — which only ever arrives *after* the fact,
 * as a `last_shot_tick` rising edge — animates the half that can be shown: the arrow leaps
 * forward off the string, vanishes, and a fresh one is nocked.
 *
 * Transform and opacity only, so it composites; `fill: 'none'` hands both properties back at
 * the end, which is what makes the React attributes below the resting truth after a reload.
 *
 * ponytail: the string does not flex. Ceiling: at 21 px the bend is under a pixel of travel
 * and animating it means animating `d`, which is not a composited property. Upgrade path: a
 * second path with a `path()` CSS transition, once someone reports the bow reads as static.
 */
const LOOSE_MS = 420;

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

/**
 * How long a seat must go without an accepted step before it is standing again.
 *
 * `w.stepped` alone can no longer answer that. {@link Knight} is memoised on the values it
 * draws, so the notification that WOULD clear the latch — same position, same hp, same
 * everything — produces no render at all, and the latch would hold the breathe cancelled
 * for the rest of the seat's life. That is `docs/review/render.md` finding 3 (nineteen
 * standing raiders as statues) reached by a second route, so the answer moves off the
 * render and onto a clock: five ER slots, against one accepted move per slot while the
 * player is actually walking.
 */
const IDLE_MS = 250;

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
  const { pose, bob } = dead ? { pose: 'fallen' as KnightPose, bob: 0 } : walkPose(w.d);
  // Both offsets come off the pose's own canvas: `fallen` is transposed, so hard-coding
  // the standing canvas would lay the corpse five units below its own shadow.
  const [pw, ph] = poseBox(pose);
  const ox = anchorX(pw, w.flip);
  const oy = -(ph >> 1);
  const archer = classOf(slot) === CLASS_ARCHER;
  const [sw, sh] = poseBox('sil');
  // The rim. With the halo generated it is the full dilated boundary at the pose's own
  // anchor, and the corpse gets one too; without it, the shipped one-unit up-left offset of
  // `sil`, whose down-right edge measures 1.06:1 (see HAS_HALO).
  const rimPose: KnightPose = HAS_HALO ? (dead ? 'halo-fallen' : 'halo') : 'sil';
  const [rw, rh] = poseBox(rimPose);
  // One unit up and one unit *left on screen*: a flipped knight is drawn through
  // `scale(-1,1)`, so local +x is screen -x and the sign has to follow the flip or half the
  // raid is lit from the other side. Zero once the halo is symmetric.
  const rimDx = HAS_HALO ? 0 : w.flip ? 1 : -1;
  // A knight standing still shows `contactL` at bob 0; the pass frame is the only one that
  // lifts. Under reduced motion the lift goes and the cycle reads as pose changes alone.
  const lift = reduced ? 0 : bob;
  const flipT = w.flip ? 'scale(-1,1) ' : '';
  const knightT = `${flipT}translate(0,${lift})`;

  const bodyRef = useRef<SVGGElement | null>(null);
  const flashRef = useRef<SVGUseElement | null>(null);
  const arrowRef = useRef<SVGPathElement | null>(null);
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

    // Loose, then re-nock. Fires on the same value diff the recoil does, so it is duplicate-
    // proof for the same reason, and it is skipped for the dead and under reduced motion for
    // the same reasons the recoil is.
    if (w.shots !== p.shots && !dead && !reduced && arrowRef.current !== null) {
      arrowRef.current.animate(
        [
          { transform: 'translate(0px,0px)', opacity: 1 },
          { transform: 'translate(20px,0px)', opacity: 0, offset: 0.4 },
          { transform: 'translate(0px,0px)', opacity: 0, offset: 0.42 },
          { transform: 'translate(0px,0px)', opacity: 1 },
        ],
        { duration: LOOSE_MS, easing: 'ease-out' },
      );
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
  // again once they have stopped, which is what `moving` off `w.stepped` buys.
  //
  // No `if (breathe.current !== null) return` guard: the cleanup below is the only exit
  // from the branch that creates one, so `breathe.current` is provably null on entry here.
  // That guard is how the old latched `moving` turned into a permanent statue — once it
  // held a cancelled animation there was no path back.
  //
  // A WALKING seat arms {@link IDLE_MS} instead of simply staying cancelled, and `w.d` — the
  // stride odometer, which rises on every accepted step and on nothing else — is a
  // dependency so each step re-arms it. Under memoisation the seat that stops walking gets
  // no further render, so the timer left by its LAST step is what starts the breathe again.
  useEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    if (reduced || dead) {
      breathe.current?.cancel();
      breathe.current = null;
      return;
    }
    const start = (): void => {
      breathe.current = body.animate(
        [
          { transform: 'translate(0px,0px)', offset: 0 },
          { transform: 'translate(0px,0px)', offset: 0.499 },
          { transform: 'translate(0px,-1px)', offset: 0.5 },
          { transform: 'translate(0px,-1px)', offset: 1 },
        ],
        { duration: 1200, iterations: Infinity },
      );
    };
    let idle = 0;
    if (moving) idle = window.setTimeout(start, IDLE_MS);
    else start();
    return () => {
      clearTimeout(idle);
      breathe.current?.cancel();
      breathe.current = null;
    };
  }, [reduced, dead, moving, w.d]);

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

      {/* Cue 2 of 3 for finding yourself, and the direct descendant of the old `PLAYER_R + 5`
          ring. Two tones, wide dark under narrow bright, because one of the two has to be
          winning on every ground the ring can land on: `#eafff4` is 7.94:1 against the
          darkest sampled floor and `#05060a` is 10.96:1 against a lit ally rim or a brazier
          patch. Geometry is larger than what shipped because `LOBBY_ZOOM = 2` is deleted with
          the follow camera — `rx 15 / width 2` was 1.4 device px at a 720 px square and was
          only ever legible because the lobby camera doubled it (legibility.md §4.1, §5.2). */}
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

      <g ref={bodyRef} opacity={dead ? 0.55 : 1}>
        {/* The rim. First child, so the body covers everything but the boundary; inside the
            body `<g>`, so the recoil and the breathe carry it rather than leaving it behind.
            One `<use>` for one `<use>` — node count is unchanged from the key light this
            replaces — and with the halo generated the corpse gains an outline it does not
            have today. Without it there is no fallen union to draw, so the corpse is skipped:
            `fallen` is a transposed canvas and a standing halo behind a lying body reads as
            a ghost. */}
        {(HAS_HALO || !dead) && (
          <use
            href={`#${knightPoseId(slot.skinId, rimPose)}`}
            x={anchorX(rw, w.flip) + rimDx}
            y={-(rh >> 1) + (HAS_HALO ? 0 : -1)}
            transform={knightT}
            // Both, for the same reason the flash sets both: the generated silhouette may
            // carry `currentColor` or its own fill, and this has to win either way.
            fill={keyLight(slot.skinId)}
            color={keyLight(slot.skinId)}
          />
        )}
        <use href={`#${knightPoseId(slot.skinId, pose)}`} x={ox} y={oy} transform={knightT} />

        {/* The class, as silhouette. Inside the body `<g>` and inside the body's own
            `scale(-1,1) translate(0,bob)`, so it flips, bobs, recoils, falls and revives with
            the figure and never needs a writer of its own. Dropped for the corpse: the kit is
            authored against the standing pose and `fallen` is a transposed canvas. */}
        {archer && !dead && (
          <g transform={knightT}>
            {ARCHER_STATIC}
            <path
              ref={arrowRef}
              d={ARROW_D}
              fill={KIT_LIGHT}
              stroke={KEYLINE}
              strokeWidth={1.6}
              paintOrder="stroke"
            />
          </g>
        )}
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

      {/* Cue 1 of 3, and the only one that works when you are completely hidden behind another
          knight — so it is never clipped, never faded, and never suppressed while dead: a
          player watching their own respawn countdown still needs to know which corpse is
          theirs. 16 x 12 units against the shipped 10 x 7, for legibility.md §4.1's reason.
          The keyline exists because the chevron's one bad background is an ally's lifted rim:
          `#eafff4` on that is 1.76:1, and on the keyline 10.96:1. `paint-order: stroke` puts
          the keyline outside the fill so the shape does not shrink to pay for it.

          It cannot be occluded, and that is arithmetic rather than luck: draw order is
          ascending `y`, so only an ally with a larger `y` paints later, and such an ally's
          head top sits at `y_self + d - 21` with d >= 16 — at worst 29 units below this
          chevron. No separate marker layer is needed (legibility.md §5.4). */}
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
 * a field added to the render and forgotten here is a knight that stops updating, which
 * is silent. In render order: position and facing (the walk, via `advance`), `hp`/`hpMax`
 * (the flash, the corpse, the bar), `deaths` and `respawnAtTick` (the fall, the revive,
 * the arc), `lastShotTick` (the recoil and the loose), `skinId` (the sprite and its rim)
 * and the CLASS bits of `classAim` — the aim bits are not read here and change every tick,
 * so comparing the raw byte would memoise nothing at all.
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
    p.skinId === n.skinId &&
    classOf(p) === classOf(n) &&
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
  ok(keyLight(200) === SKIN_KEY[0]!.key, 'an out-of-range skin clamps here too');

  // The halo is transposed exactly where `fallen` is, and on the same canvas as `sil`
  // otherwise. Getting this wrong lays the corpse's outline across its own body.
  ok(poseBox('halo').join() === poseBox('sil').join(), 'the halo shares the standing canvas');
  ok(poseBox('halo-fallen').join() === poseBox('fallen').join(), 'the fallen halo is transposed');

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

  // The memo comparison. Every failure mode here is silent in exactly one of two
  // directions: a field left out is a knight that stops updating, a field wrongly included
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
  ok(!sameSeat(base, props({ skinId: 2 })), 'a re-skin renders');
  ok(!sameSeat(base, props({ classAim: CLASS_ARCHER << 7 })), 'a class change renders');
  ok(!sameSeat(base, { ...base, mine: true }), 'the local cues render');
  // The two rows the whole fix rests on. An `Arena` write is half the feed and moves
  // `tick` alone; the aim bits move with every one of them and nothing here draws them.
  ok(sameSeat(base, props({ classAim: 0x3f }, 9)), 'aim and tick alone are skipped');
  ok(
    !sameSeat(props({ hp: 0, deaths: 1, respawnAtTick: 30 }), props({ hp: 0, deaths: 1, respawnAtTick: 30 }, 9)),
    'a dead seat still follows the tick, or its respawn arc freezes',
  );
}
