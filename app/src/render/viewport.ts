/**
 * The viewport: the active room, whole, filling the stage. There is no camera.
 *
 * Spec 17 section 1. The old model was a window that followed the local knight over a
 * 1024-unit map at zoom 2 with a 96-unit dead zone, and both of the last two bug reports
 * were the same sentence -- "I cannot see my character". They were not sprite bugs: a
 * follow camera can put a player outside the window, and a player outside the window is
 * invisible with no error anywhere. That entire class of defect is deleted here by making
 * the frame a constant per room and proving, at module load, that the frame contains every
 * position the chain can put a player in (see the self-check at the bottom -- that
 * property is the whole reason this file exists).
 *
 * Three rules:
 *
 *   1. There are exactly two rooms and exactly one is on screen. {@link VIEW_LOBBY} and
 *      {@link VIEW_ARENA} are both 1024 x 656 -- that equality is load-bearing, because it
 *      makes the gate passage a pure composited translate (spec section 7.3).
 *   2. The viewBox aspect always equals the stage aspect, so `meet` never letterboxes, and
 *      the box COVERS the stage with the room wherever {@link KEEP} allows: the fit crops
 *      only fiction -- the tower shaft above the gate's crest, the void under the bottom
 *      wall -- and grows past the room only when the keep forces it. Never bars, never a
 *      cropped stand.
 *   3. This module is the ONLY writer of the `viewBox` attribute. React writes it nowhere;
 *      neither does `#camera`'s transform, which now rests at identity except during the
 *      passage.
 *
 * Not here, deliberately:
 *
 * - **No device-pixel snapping.** `usePixelFit` picked an integer device scale so
 *   `shape-rendering: crispEdges` would not shimmer. Spec section 1.4 deletes both: an
 *   integer scale is available in 16 of 96 window/dpr combinations, so snapping is a coin
 *   flip that reframes mid-drag for one user in six. `geometricPrecision` unconditionally,
 *   and "sharper" is delivered as bigger -- 1.008 -> 1.573 px/unit at 1080p.
 * - **No devicePixelRatio handling at all**, for the same reason: nothing snaps to the
 *   device grid any more, and the SVG is sized in percent, so the browser rasterises at
 *   whatever density it has. A monitor-to-monitor drag needs no listener because there is
 *   no number to recompute.
 * - **No clamping of the fitted box to the map.** The surplus on the grown axis is void,
 *   and void is painted (spec section 8 row 1, and {@link VIEW_BLEED} below).
 */
import { useEffect, type RefObject } from 'react';

import {
  BOSS_SPAWN,
  CORE,
  LOBBY_BOT,
  LOBBY_TOP,
  MAP_MAX_XY,
  MAP_TILE,
  MAP_TILES,
  PART_HITBOXES,
  PIT_BOT,
  PIT_TOP,
  isWallTile,
} from '@heartrot/client';

import { ARENA_UNITS } from './sprites';

// ---------------------------------------------------------------------------
// The two rooms
// ---------------------------------------------------------------------------

/** A world-space rectangle in arena units. */
export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Which room is on screen. Owned by `Passage.tsx`, not read from `slot.zone` directly. */
export type Room = 'lobby' | 'arena';

/**
 * Masonry above the drawn lobby floor and floor below it, in units.
 *
 * The waiting hall is a painting (`assets/rooms/lobby.png`, 1122x785) and
 * `tools/gen_rooms.py` fits it to this room's HEIGHT: 656 / 785 units per px. Its floor
 * sits at px y 248..690 -- 248 px of wall and gate tower above, 95 px of wall below a
 * 442 px band -- which at that fit is 207 units above and 79 below: 13 and 5 tiles. Tile
 * multiples so the painting's own floor edge lands on the map's `LOBBY_TOP` row and the
 * compiled walls on the frame edge instead of half a tile inside it.
 *
 * Both constants are LOAD-BEARING and READ BACK: `gen_rooms.py` parses them out of this
 * file to place `LOBBY_IMG` and to size the room, so this is the one place they are
 * typed. Change 13 and the painted floor no longer lands on the lobby rows -- the
 * generator refuses, and `WaitingRoom.tsx` asserts `LOBBY_IMG.y === VIEW_LOBBY.y` at
 * boot. 13 + the 23-row lobby band + 5 also holds {@link ROOM_H} at 656, which keeps
 * `VIEW_LOBBY` byte-identical to the rect every earlier spec was measured against.
 */
const LOBBY_HEAD = 13 * MAP_TILE;
const LOBBY_FOOT = 5 * MAP_TILE;

/**
 * Room height, 656 units, derived once from the lobby and reused by the arena.
 *
 * The arena's frame is anchored to the pit rim and takes its height from here rather than
 * restating it: the gate move is a pure translate only while the two rooms are the same
 * size, and two independently typed 656s are exactly how that stops being true.
 */
const ROOM_H = LOBBY_HEAD + (LOBBY_BOT + 1 - LOBBY_TOP) + LOBBY_FOOT;

/** The waiting area: the lobby floor band, plus masonry above and floor below. */
export const VIEW_LOBBY: ViewRect = {
  x: 0,
  y: LOBBY_TOP - LOBBY_HEAD,
  w: ARENA_UNITS,
  h: ROOM_H,
};

/**
 * The boss arena, sitting on the pit rim.
 *
 * `PIT_BOT + 1` is the RIM — the last walkable row of the pit, plus one — and the frame
 * bottom is anchored there: it is also the bottom edge of the arena painting
 * (`ARENA_IMG` in `rooms.gen.ts`, one unit per px), so the stairs run off the frame exactly
 * where the paint ends. It is deliberately NOT the boss clip: `#heartrot-boss-clip` used to
 * cut at this same edge, but `PART_HITBOXES` reaches lower, so 104 units of mace arm and
 * claw were hittable and drawn nowhere. `Arena.tsx` derives that clip from the hitbox
 * table (`boss.y + BOSS_HIT_BOT`), which is below this line — so below aspect ~1.561,
 * where the fitted box grows on y, some of the creature legitimately renders under the rim
 * against the void. With the painted pit ending on row 37 the rim is 608 and this frame
 * spans -48..608: the painting's top edge is at -4, so the top 44 units are void — the
 * same near-black its own ceiling fades into — and the crown has that much more headroom
 * than the map's top row gave it. Every row the pit gains raises this frame's top edge 16
 * units toward a crown that does not move, and nothing but the check at the bottom of this
 * file says whether it still fits. See {@link LOBBY_HEAD}.
 */
export const VIEW_ARENA: ViewRect = {
  x: 0,
  y: PIT_BOT + 1 - ROOM_H,
  w: ARENA_UNITS,
  h: ROOM_H,
};

export const VIEWS: Readonly<Record<Room, ViewRect>> = {
  lobby: VIEW_LOBBY,
  arena: VIEW_ARENA,
};

/**
 * Tower above the floor line the fit must keep, in units.
 *
 * The lobby painting's gate tower is the hero of room A: the ram skull over the BOSS
 * FIGHT sign crests at px y ~60, which at the lobby fit ({@link LOBBY_HEAD}) is 158 units
 * above `LOBBY_TOP` -- 9.9 tiles. 11 tiles keeps it with a course of tower above it, the
 * way the painting shows it, and gives the fit the other 2 tiles of shaft to crop. Not
 * imported from the room, because the room imports {@link VIEW_LOBBY} from here -- a
 * cycle at module load.
 */
const LOBBY_HERO = 11 * MAP_TILE;

/** One course of masonry under the bottom wall the fit must keep, so the wall has depth. */
const LOBBY_SILL = MAP_TILE;

/**
 * What the fit may NEVER crop, per room: the frame every stand and the hero art must land
 * inside at every stage aspect. Everything in the room outside it is fiction the fit is
 * free to trade for a bigger picture.
 *
 * Room A keeps its whole width -- the side walls are two tiles and a wall cropped in half
 * reads as a hole -- and, in y, the crest down through one course under the bottom wall:
 * 576 units, so a 16:9 stage is exactly covered with nothing cropped but shaft and void.
 * Room B keeps all of itself: the crown clears its frame by one tile ({@link VIEW_ARENA})
 * and the frame already sits on the rim, so there is no fiction there to give.
 */
export const KEEP: Readonly<Record<Room, ViewRect>> = {
  lobby: {
    x: 0,
    y: LOBBY_TOP - LOBBY_HERO,
    w: ARENA_UNITS,
    h: ARENA_UNITS + LOBBY_SILL - (LOBBY_TOP - LOBBY_HERO),
  },
  arena: VIEW_ARENA,
};

/**
 * How far outside the room the frame can reach, per side.
 *
 * The fitted box grows past the room only where {@link KEEP} forces it, and the surplus
 * is world space the room does not fill. Narrower than the keep's own aspect the box grows
 * on y, all of it ABOVE the room (the fit is bottom-anchored, so the surplus lands over
 * the tower and the boss's ceiling rather than under the bottom wall): `1024/a - 656`,
 * inside 256 for **aspect >= 1.12**. Wider than 16:9 it grows on x, `(576a - 1024) / 2`
 * per side for room A and `(656a - 1024) / 2` for room B, inside 256 up to **aspect
 * 2.34**. 1024x768 (1.33), 1440x900 (1.60), 1920x1080 (1.78) and 1366x768 (1.78) are all
 * covered, and the three 16:9 and 16:10 shapes show no surplus at all.
 *
 * Wider than that it does not: a 3440x1392 ultrawide consumes 299 units in x. That is not
 * a hole, because {@link useViewport} sizes every `.vp-void` rect from the LIVE box rather
 * than from this constant -- the surplus is painted `VOID` (`rooms.gen.ts`, the painting's
 * own edge colour) wherever the painting stops, which is the intended degradation and the
 * reason the void rect exists.
 */
export const VIEW_BLEED = 256;

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/** A fitted viewBox: the room covering the stage, cropped to its keep, grown past it only when forced. */
export interface Fit extends ViewRect {
  /** CSS pixels per arena unit. Uniform -- the fitted box never stretches. */
  readonly scale: number;
}

/** `v` clamped into `[lo, hi]`, which is what a box edge does against its keep. */
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Fit `room` to a stage of `stageW` x `stageH` CSS pixels.
 *
 * Pure, so the self-check can sweep it and callers can size a stroke without a DOM read.
 * Two boxes at the stage's aspect are candidates and the taller wins: the tallest that
 * fits INSIDE the room (cover -- no void), and the shortest that holds the room's
 * {@link KEEP} (containment). So a 16:9 stage shows room A edge to edge with 80 units of
 * shaft and void cropped, and a 4:3 one grows past the room only by what the keep forces.
 *
 * Bottom-anchored: the box rests on the room's bottom edge and any surplus lands above,
 * where the gate tower and the boss's masonry are authored to leave the frame -- then
 * clamped so the keep is inside it, which on a wide stage is what places the crop.
 * Centred in x, so a wide stage's surplus is symmetric.
 */
export function fitViewBox(room: Room, stageW: number, stageH: number): Fit {
  const v = VIEWS[room];
  const k = KEEP[room];
  const a = stageW / stageH;
  const h = Math.max(Math.min(v.h, v.w / a), k.h, k.w / a);
  const w = h * a;
  return {
    x: clamp(v.x + v.w / 2 - w / 2, k.x + k.w - w, k.x),
    y: clamp(v.y + v.h - h, k.y + k.h - h, k.y),
    w,
    h,
    scale: stageW / w,
  };
}

/**
 * Keep `svg`'s viewBox fitted to `stage` for `room`, for as long as both are mounted.
 *
 * The one writer of the viewBox. Also publishes `--vp-scale` (CSS px per arena unit) on
 * the SVG so an overlay can size a marker without a React render, and sizes every
 * `.vp-void` descendant to the live box inflated by {@link VIEW_BLEED} -- that rect is the
 * only thing that ever paints outside the room, and it paints void.
 *
 * No state: a `setState` per resize frame is the churn this renderer is built to avoid.
 *
 * The SVG must carry `width="100%" height="100%"` and must not carry
 * `preserveAspectRatio="none"` or `shape-rendering="crispEdges"`; both are silent framing
 * bugs, so both are checked in dev on the first fit.
 */
export function useViewport(
  room: Room,
  stage: RefObject<HTMLElement | null>,
  svg: RefObject<SVGSVGElement | null>,
): void {
  useEffect(() => {
    const box = stage.current;
    const el = svg.current;
    if (!box || !el) return;

    if (import.meta.env.DEV) {
      if (el.getAttribute('preserveAspectRatio') === 'none') {
        throw new Error('viewport: preserveAspectRatio="none" stretches the room; use the default');
      }
      if (el.getAttribute('shape-rendering') === 'crispEdges') {
        throw new Error('viewport: crispEdges shimmers at a fractional scale (spec 1.4)');
      }
      // The void is the only thing that may paint outside the room, and the loop below is
      // a no-op if the mounted room forgot the class. That failure is SILENT and shows as
      // the host's own page background at the frame edge on whichever aspects happen to
      // out-run the room's static rect -- which is exactly how it shipped once: room B's
      // hardcoded box stopped 42.6 units short per side at 3440x1392.
      if (el.querySelectorAll('.vp-void').length === 0) {
        throw new Error(`viewport: room ${room} mounts no .vp-void rect (spec section 8 row 1)`);
      }
    }

    const fit = (width: number, height: number): void => {
      // Zero happens: a hidden stage, and the frame before first layout. A viewBox of NaN
      // blanks the scene and reports nothing.
      if (!(width >= 1) || !(height >= 1)) return;
      const b = fitViewBox(room, width, height);
      el.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
      el.style.setProperty('--vp-scale', String(b.scale));
      for (const node of el.querySelectorAll('.vp-void')) {
        node.setAttribute('x', String(b.x - VIEW_BLEED));
        node.setAttribute('y', String(b.y - VIEW_BLEED));
        node.setAttribute('width', String(b.w + 2 * VIEW_BLEED));
        node.setAttribute('height', String(b.h + 2 * VIEW_BLEED));
      }
    };

    const r = box.getBoundingClientRect();
    fit(r.width, r.height);
    // contentRect rather than a second getBoundingClientRect: the callback runs after this
    // effect has written attributes, and re-reading geometry there forces a layout.
    const ro = new ResizeObserver(([entry]) => {
      const c = entry?.contentRect;
      if (c) fit(c.width, c.height);
    });
    ro.observe(box);
    return () => ro.disconnect();
  }, [room, stage, svg]);
}

// ---------------------------------------------------------------------------
// Self-check
//
// One property, and it is the reason the camera is gone: for every position the chain can
// put a player in, the KEEP of the room that player is in contains that position -- and
// the fitted box contains the keep at every stage shape, so it contains the player too.
// The fit is allowed to crop, which is exactly why the keep, and not the room, is what
// the stands are swept against.
//
// It replaces the deleted camera checks, which asserted that the window framed the gate
// and that *some* window existed for any point, and could not catch the shipped defect
// where seat 0 and the gate were never on screen at the same time.
// ---------------------------------------------------------------------------

if (import.meta.env.DEV) {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`viewport self-check: ${what}`);
  };

  ok(
    VIEW_LOBBY.w === VIEW_ARENA.w && VIEW_LOBBY.h === VIEW_ARENA.h,
    'both rooms are the same size, so the gate move is a pure translate',
  );
  ok(VIEW_ARENA.y + VIEW_ARENA.h === PIT_BOT + 1, 'the arena frame sits on the pit rim');
  ok(VIEW_LOBBY.y + VIEW_LOBBY.h === LOBBY_BOT + 1 + LOBBY_FOOT, 'the lobby frame sits below the floor band');

  // THE BOSS IS INSIDE ITS OWN FRAME. The sweep below walks PLAYER stands, and the boss is
  // not one, so nothing anywhere proved the creature fits — `gen_map.validate()` cannot see
  // it either, and passes maps that cut the crown off. The pit can only grow downward, and
  // every row it gains raises this frame's top edge 16 units toward a crown that does not
  // move, so this is the entire ceiling on pit depth and it is checked here or nowhere.
  //
  // Derived from the chain's own hitbox table the way `Arena.tsx` derives `BOSS_HIT_BOT`
  // from the other end of it: the top of the drawn rig is not the thing that matters, the
  // top of the HITTABLE rig is, because a crown above the frame is a target the player
  // cannot see and can still be killed by.
  const BOSS_HIT_TOP = Math.min(
    CORE.y - Math.sqrt(CORE.radiusSq),
    ...PART_HITBOXES.map((r) => r.y),
  );
  ok(BOSS_SPAWN[1] + BOSS_HIT_TOP >= VIEW_ARENA.y, 'the arena frame contains the boss crown');

  // The lobby frame's head is painted fiction over pit floor — the gate tower, the skyline.
  // That is legal only while a `ZONE_LOBBY` seat is clamped below all of it; the moment the
  // lobby's movement box starts above the pit's last row, the fiction is being painted over
  // floor somebody is standing on, in a room that does not draw them (R3).
  ok(PIT_BOT + 1 <= LOBBY_TOP, 'the lobby movement box starts below the pit, so its head is fiction');

  // The keep is inside the room it is cut from, or the fit could be forced past the art.
  for (const room of ['lobby', 'arena'] as const) {
    const v = VIEWS[room];
    const k = KEEP[room];
    ok(
      k.x >= v.x && k.y >= v.y && k.x + k.w <= v.x + v.w && k.y + k.h <= v.y + v.h,
      `${room}'s keep lies inside its room`,
    );
  }

  // The movement box the chain clamps into, from `player.rs::zone_bounds`: a raider is
  // held in PIT_TOP..=PIT_BOT, everyone else in PIT_BOT + 1..=MAP_MAX_XY. Anything else is
  // unreachable, so framing it would be framing empty stone.
  const ROOM_Y: Readonly<Record<Room, readonly [number, number]>> = {
    arena: [PIT_TOP, PIT_BOT],
    lobby: [PIT_BOT + 1, MAP_MAX_XY],
  };
  // A body is drawn upward from its position: 42 units of sprite plus the HP bar above it.
  // Below the feet the arena is clipped ON PURPOSE (spec section 8 row 14, the rim
  // occluder), so only headroom is asserted.
  const HEAD = 48;

  for (const room of ['lobby', 'arena'] as const) {
    const v = KEEP[room];
    const [top, bot] = ROOM_Y[room];
    let stands = 0;
    for (let ty = 0; ty < MAP_TILES; ty++) {
      for (let tx = 0; tx < MAP_TILES; tx++) {
        if (isWallTile(tx, ty)) continue;
        // Every unit of the tile, not its origin: the chain moves in 16s but clamps and
        // respawns land anywhere, and a frame edge inside a walkable tile is a knight cut
        // in half.
        const y0 = Math.max(ty * MAP_TILE, top);
        const y1 = Math.min(ty * MAP_TILE + MAP_TILE - 1, bot);
        if (y0 > y1) continue;
        const x0 = tx * MAP_TILE;
        const x1 = x0 + MAP_TILE - 1;
        stands++;
        ok(
          x0 >= v.x && x1 < v.x + v.w,
          `${room}'s keep frames tile column ${tx} -- a player there would be off screen`,
        );
        ok(
          y0 - HEAD >= v.y && y1 < v.y + v.h,
          `${room}'s keep frames tile row ${ty} with headroom -- a player there would be cut off`,
        );
      }
    }
    ok(stands > 0, `${room} has walkable tiles to frame`);
  }

  // The fit itself, over every stage shape including the absurd ones. Containment of the
  // keep is the property the rooms rely on; equal aspect is what stops `meet`
  // letterboxing; and the box may not grow past the room on an axis the keep did not
  // force, or "cover" is a comment and the flat margins are back.
  for (let a = 0.05; a <= 6.0001; a += 0.05) {
    for (const room of ['lobby', 'arena'] as const) {
      const v = VIEWS[room];
      const k = KEEP[room];
      // 1000 x (1000 / a) is a stage of aspect `a`; the fit reads only the ratio.
      const b = fitViewBox(room, 1000, 1000 / a);
      const e = 1e-9;
      ok(
        b.x <= k.x + e &&
          b.y <= k.y + e &&
          b.x + b.w >= k.x + k.w - e &&
          b.y + b.h >= k.y + k.h - e,
        `the fitted box contains ${room}'s keep at aspect ${a.toFixed(2)}`,
      );
      ok(
        b.h <= Math.max(v.h, k.w / a) + e && b.w <= Math.max(v.w, k.h * a) + e,
        `the fitted box shows no void ${room}'s keep did not force at aspect ${a.toFixed(2)}`,
      );
      ok(Math.abs(b.w / b.h - a) < 1e-9, `the fitted box matches the stage aspect ${a.toFixed(2)}`);
      ok(b.scale > 0 && Math.abs(b.scale - 1000 / a / b.h) < 1e-9, `the fit is uniform at aspect ${a.toFixed(2)}`);
    }
  }

  // Authored scenery is finite, so say which stage shapes it actually reaches. These are
  // the spec's own table, minus the ultrawide the void rect covers instead. Per side,
  // because the fit is bottom-anchored and the whole y surplus lands on one edge.
  for (const [w, h] of [
    [1024, 720],
    [1366, 720],
    [1440, 852],
    [1920, 1032],
    [1920, 1080],
  ] as const) {
    for (const room of ['lobby', 'arena'] as const) {
      const v = VIEWS[room];
      const b = fitViewBox(room, w, h);
      ok(
        v.x - b.x <= VIEW_BLEED &&
          b.x + b.w - (v.x + v.w) <= VIEW_BLEED &&
          v.y - b.y <= VIEW_BLEED &&
          b.y + b.h - (v.y + v.h) <= VIEW_BLEED,
        `authored bleed reaches the frame edge for ${room} at ${w}x${h}`,
      );
    }
  }
}
