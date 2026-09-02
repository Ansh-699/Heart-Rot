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
 *      exactly one axis ever grows, so the room is always entirely inside it. Never bars,
 *      never crop.
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
  LOBBY_BOT,
  LOBBY_TOP,
  MAP_MAX_XY,
  MAP_TILE,
  MAP_TILES,
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
 * Reference A (1122x785) puts the floor interior at y 250..690 -- 250 px above and 95 px
 * below a 440 px band, so 0.568 and 0.216 of it. Over the map's own 368-unit floor band
 * that is 209 -> 208 (13 tiles) and 79.5 -> 80 (5 tiles). Tile multiples so the compiled
 * wall geometry lands on the frame edge instead of half a tile inside it.
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
 * bottom is anchored there so the rim occluder has something to sit on. It is deliberately
 * NOT the boss clip any more: `#heartrot-boss-clip` used to cut at this same edge, but
 * `PART_HITBOXES` reaches lower, so 104 units of mace arm and claw were hittable and drawn
 * nowhere. `Arena.tsx` now derives that clip from the hitbox table (`boss.y +
 * BOSS_HIT_BOT`), which is below this line — so below aspect ~1.561, where the fitted box
 * grows on y, some of the creature legitimately renders under the rim against the void.
 * The top runs 48 units off the map, which is void, and which is what puts the crown near
 * the top of frame the way reference B does.
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
 * How far outside the room to author scenery, per side.
 *
 * The fitted box grows on one axis to match the stage aspect, and the surplus is world
 * space the room does not fill. For a room of 1024 x 656 the surplus per side is
 * `(656a - 1024) / 2` in x above aspect 1.561 and `(1024/a - 656) / 2` in y below it, so
 * 256 covers **aspect 0.88..2.34** -- 1024x768 (1.42), 1440x900 (1.69), 1920x1080 (1.86)
 * and 1366x768 (1.90) with room to spare.
 *
 * Wider than that it does not: a 3440x1392 ultrawide consumes 299 units in x. That is not
 * a hole, because {@link useViewport} sizes every `.vp-void` rect from the LIVE box rather
 * than from this constant -- past 2.34 the far edge is painted void instead of authored
 * masonry, which is the intended degradation and the reason the void rect exists.
 */
export const VIEW_BLEED = 256;

// ---------------------------------------------------------------------------
// The fit
// ---------------------------------------------------------------------------

/** A fitted viewBox: the room, centred, grown on one axis to the stage's aspect. */
export interface Fit extends ViewRect {
  /** CSS pixels per arena unit. Uniform -- the fitted box never stretches. */
  readonly scale: number;
}

/**
 * Fit `v` to a stage of `stageW` x `stageH` CSS pixels.
 *
 * Pure, so the self-check can sweep it and callers can size a stroke without a DOM read.
 * Exactly one of `w`/`h` grows: a stage wider than the room's 1.561 grows x, a narrower
 * one grows y. The result is centred on `v` and never clamped to the map.
 */
export function fitViewBox(v: ViewRect, stageW: number, stageH: number): Fit {
  const a = stageW / stageH;
  const w = Math.max(v.w, v.h * a);
  const h = Math.max(v.h, v.w / a);
  return { x: v.x + v.w / 2 - w / 2, y: v.y + v.h / 2 - h / 2, w, h, scale: stageW / w };
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
    const v = VIEWS[room];

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
      const b = fitViewBox(v, width, height);
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
// put a player in, the room that player is in contains that position -- so the fitted box
// contains it too, at every stage shape, because the fit only ever grows.
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
    const v = VIEWS[room];
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
          `${room} frames tile column ${tx} -- a player there would be off screen`,
        );
        ok(
          y0 - HEAD >= v.y && y1 < v.y + v.h,
          `${room} frames tile row ${ty} with headroom -- a player there would be cut off`,
        );
      }
    }
    ok(stands > 0, `${room} has walkable tiles to frame`);
  }

  // The fit itself, over every stage shape including the absurd ones. Containment is the
  // property the rooms rely on; equal aspect is what stops `meet` letterboxing.
  for (let a = 0.05; a <= 6.0001; a += 0.05) {
    for (const v of [VIEW_LOBBY, VIEW_ARENA]) {
      // 1000 x (1000 / a) is a stage of aspect `a`; the fit reads only the ratio.
      const b = fitViewBox(v, 1000, 1000 / a);
      const e = 1e-9;
      ok(
        b.x <= v.x + e &&
          b.y <= v.y + e &&
          b.x + b.w >= v.x + v.w - e &&
          b.y + b.h >= v.y + v.h - e,
        `the fitted box contains the room at aspect ${a.toFixed(2)}`,
      );
      ok(Math.abs(b.w / b.h - a) < 1e-9, `the fitted box matches the stage aspect ${a.toFixed(2)}`);
      ok(b.scale > 0 && Math.abs(b.scale - 1000 / a / b.h) < 1e-9, `the fit is uniform at aspect ${a.toFixed(2)}`);
    }
  }

  // Authored scenery is finite, so say which stage shapes it actually reaches. These are
  // the spec's own table, minus the ultrawide the void rect covers instead.
  for (const [w, h] of [
    [1024, 720],
    [1366, 720],
    [1440, 852],
    [1920, 1032],
  ] as const) {
    const b = fitViewBox(VIEW_LOBBY, w, h);
    ok(
      (b.w - VIEW_LOBBY.w) / 2 <= VIEW_BLEED && (b.h - VIEW_LOBBY.h) / 2 <= VIEW_BLEED,
      `authored bleed reaches the frame edge at ${w}x${h}`,
    );
  }
}
