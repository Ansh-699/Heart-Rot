/**
 * Room A — the waiting hall, rebuilt against `waiting_area_full_vertical.png`.
 *
 * One `<g>` mounted inside `#camera`, mutually exclusive with room B
 * (`{shown === 'lobby' ? WAITING : BOSS_ARENA}`). Frame is `VIEW_LOBBY`;
 * nothing here reads the camera, because under spec 17 §1 there is no camera.
 *
 * ## What changed, and why
 *
 * The brief: remove every square obstacle, make the room large and open, and build the
 * BOSS FIGHT gate into the top wall as architecture rather than hanging a sign over it.
 * `docs/art/hall.md` measured the reference for it; `docs/architecture/18-open-arena.md`
 * enlarges the bitboard. This file is the paint, and it holds three rules that between them
 * make the room impossible to get wrong the next time the map moves:
 *
 *  1. **Every bound is scanned off `MAP_GRID`.** `FLOOR`, `W_F`, `H_F`, `WALL_TOP` and
 *     `D_TOP` are derived at module load. The previous version typed `ROOM_TOP =
 *     GATE_MIN_Y - 2*MAP_TILE`, `LEFT_WALL_MID = MAP_TILE/2`, ten torch coordinates, eight
 *     barrel coordinates and an `AISLE_X0/X1` pair — every one of which is wrong the moment
 *     `gen_map.py` re-runs, silently, by placing a fixture on open floor.
 *  2. **Every fixture with mass is placed by a walk of the room's own inner face**
 *     ({@link anchor}), so its anchor tile is `'#'` by construction and its provenance *is*
 *     the assertion. There is no coordinate table left in this file.
 *  3. **The painted floor is the wall bitboard**, in both directions: the floor is painted
 *     over the whole room and then the walls are painted back over it from
 *     `MAP_WALL_PATH` — the same generated table the chain raycasts and `predict.ts`
 *     collides against. Nothing after the wall layer paints mass onto a walkable tile, and
 *     the boot check proves each anchor is solid.
 *
 * The one deliberate exception is R3's: the gate tower is authored upward over tiles that
 * are *pit* floor. That is legal only because a seat is drawn only in the room its own
 * `zone` names and a `ZONE_LOBBY` seat is clamped to `y >= PIT_BOT + 1`, which the boot
 * check re-derives rather than trusting (`PIT_BOT + 1 <= FLOOR.top`). If R3 is ever broken,
 * this tower paints over the pit and over the allies standing in it.
 *
 * ## The performance contract, which is why this is its own file
 *
 * `WAITING` is a module-scope `ReactElement`, not a component call. React compares it by
 * identity on every update, finds it `===` the previous one, and skips the subtree without
 * diffing a node. Four barriers, the same four `Scene.tsx` states and for the same reasons:
 *
 *   1. Stable element identity. No props object to change, no hook to get a dependency
 *      array wrong in. A `useMemo(..., [])` is one rung weaker — it still runs the
 *      reconciler's identity check and React may drop it under memory pressure.
 *   2. Nothing in it derives from chain state. Every number below comes from a build
 *      constant, the generated `MAP_GRID`/`GATE_*`/`LOBBY_*`/`PIT_BOT`, or a measurement
 *      recorded in this header. The 10–20 `Players` notifications a second — 68.4 % of
 *      which carry no position change, each delivered twice by the Magic Router — have
 *      nothing to write here. The room is a pure function of the bitboard, and the bitboard
 *      is a compile-time constant in the program image.
 *   3. `will-change: transform`, so it holds its own compositor raster. Promoted vs
 *      unpromoted measured 30–85x, and an unpromoted static background dirties the paint
 *      chunk it shares with the movers.
 *   4. `pointer-events: none`, so it can never become a hit-test target and drag a style
 *      recalculation in through the input path.
 *
 * **Do not add a prop to this file.** `Scene.tsx` measured the alternative at 11.2 ms a
 * frame and 3/3 renderer crashes at 300 frames.
 *
 * Paint cost — the static half, measured on THIS layer this session by server-rendering
 * `WAITING` (`react-dom/server` over an esbuild bundle) and counting element opens:
 * **254 SVG nodes / 165,135 B of markup**, against the 265 / 361,866 B the previous header
 * records for the temple-floored layer measured the same way. The floor went from 16 traced
 * raster paths (283 KB of source) to five vector paths — base, lit slabs, dark slabs, joints,
 * pins — and the markup halved. Barrier 1 means that cost is paid once, at mount, and never
 * again.
 *
 * **The rAF half is owed and is not quoted here.** `docs/art/waiting-room.md` §7.4's
 * 6.9 ms p50 was measured on the old room in the `looksright` harness under 6x CPU
 * throttle; this room is a different node graph and the harness needs a browser that is not
 * available in this environment (`PW_HOME` unset, no playwright on the box). Re-measure
 * against `docs/perf/frame-budget.md`'s p50 9.38 / p95 14.92 ms at 20 knights before ship.
 * The argument that it cannot regress is barrier 1 — the layer is never invalidated, so its
 * cost is a mount cost and not a frame cost — but that is an argument, not a measurement.
 *
 * ## Chain impact: none
 *
 * No instruction, no account, no compute unit, no subscription, no send. `MAP_GRID`,
 * `GATE_*`, `LOBBY_*` and `PIT_BOT` are consumed read-only; this layer emits no generated
 * file and has no channel to the bitboard, which is why art here cannot become a wall.
 */
import type { ReactElement } from 'react';

import {
  GATE_MAX_X,
  GATE_MIN_X,
  GATE_MIN_Y,
  LOBBY_TOP,
  MAP_GRID,
  MAP_TILE,
  MAP_TILES,
  PIT_BOT,
} from '@heartrot/client';

import { ARENA_UNITS, MAP_RIM_PATH, MAP_WALL_PATH } from './sprites';
import { KEEP, VIEW_BLEED, VIEW_LOBBY } from './viewport';

// ---------------------------------------------------------------------------
// The room, scanned off the bitboard. No world coordinate is typed in this file.
// ---------------------------------------------------------------------------

const solid = (tx: number, ty: number): boolean => (MAP_GRID[ty]?.[tx] ?? '#') === '#';
const tileOf = (u: number): number => Math.floor(u / MAP_TILE);

/** The gate's walkable slot, in tiles and in units — the same rectangle `on_gate` compares. */
const GATE_TX0 = tileOf(GATE_MIN_X);
const GATE_TX1 = tileOf(GATE_MAX_X);
const SLOT_W = GATE_MAX_X - GATE_MIN_X + 1;

/**
 * The lobby floor's bounding box: every walkable tile at or below `LOBBY_TOP`.
 *
 * `right`/`bottom` are inclusive of the last unit, exactly as `PIT_BOT` and `LOBBY_BOT`
 * are, so `W_F` and `H_F` are the walkable extents and not one unit short of them.
 */
const FLOOR = ((): { left: number; right: number; top: number; bottom: number } => {
  let l = MAP_TILES;
  let r = -1;
  let t = MAP_TILES;
  let b = -1;
  for (let ty = tileOf(LOBBY_TOP); ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (solid(tx, ty)) continue;
      if (tx < l) l = tx;
      if (tx > r) r = tx;
      if (ty < t) t = ty;
      if (ty > b) b = ty;
    }
  }
  if (r < 0) throw new Error('WaitingRoom: the lobby band has no walkable tile — check MAP_GRID');
  return { left: l * MAP_TILE, right: (r + 1) * MAP_TILE - 1, top: t * MAP_TILE, bottom: (b + 1) * MAP_TILE - 1 };
})();

const W_F = FLOOR.right - FLOOR.left + 1;
const H_F = FLOOR.bottom - FLOOR.top + 1;
/** The room's centre line. The gate is on it, and the boot check proves that. */
const CX = FLOOR.left + W_F / 2;
/** The floor's own centre, which is where the room's one light and its centre inlay sit. */
const CY = FLOOR.top + H_F / 2;

/**
 * The top wall's outer line, **scanned** rather than assumed.
 *
 * A row belongs to the wall band when every non-`'#'` tile in it lies inside the gate slot's
 * columns — that is, when it is solid masonry but for the doorway punched through it. Walk
 * up from the floor line while that holds.
 *
 * The previous version wrote `ROOM_TOP = GATE_MIN_Y - 2*MAP_TILE`, which silently assumes
 * the divider is exactly two rows deep. Spec 18 makes it five. A scan is three lines and
 * cannot go stale; `D_TOP` is the wall's painted depth and every vertical proportion in the
 * gate assembly is a fraction of it.
 */
const WALL_TOP = ((): number => {
  const bandRow = (ty: number): boolean => {
    const row = MAP_GRID[ty];
    if (row === undefined) return false;
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (row[tx] !== '#' && (tx < GATE_TX0 || tx > GATE_TX1)) return false;
    }
    return true;
  };
  let ty = tileOf(FLOOR.top);
  while (ty > 0 && bandRow(ty - 1)) ty--;
  return ty * MAP_TILE;
})();

/** The top wall's depth. Reference A: 0.104 of the interior width; spec 18's divider: 0.083. */
const D_TOP = FLOOR.top - WALL_TOP;

/**
 * How far past the map edge masonry is painted: to the bleed, so the fitted box's surplus at
 * every aspect `VIEW_BLEED` covers is stone falling off into the void rather than a flat band
 * beside the room. Off-map is solid by `isWallTile`'s own contract, so no player can ever be here.
 */
const OFF_MAP = VIEW_BLEED;
/** The three off-map strips: left, right, below. */
const OFF_MAP_D =
  `M${-OFF_MAP} ${WALL_TOP}h${OFF_MAP}v${ARENA_UNITS + OFF_MAP - WALL_TOP}h-${OFF_MAP}z` +
  `M${ARENA_UNITS} ${WALL_TOP}h${OFF_MAP}v${ARENA_UNITS + OFF_MAP - WALL_TOP}h-${OFF_MAP}z` +
  `M0 ${ARENA_UNITS}h${ARENA_UNITS}v${OFF_MAP}h-${ARENA_UNITS}z`;

/**
 * One brick module for the whole layer: **one course per map tile**, running bond, the
 * vertical joint offset half a block on odd rows.
 *
 * `hall.md` §3.2 asks for one module and one *phase* through wall, pier and tower, because
 * a tower whose courses do not line up with the wall's reads as a panel laid on it. Taking
 * the module to be the tile guarantees the phase by construction — every masonry element
 * here snaps to the same grid the bitboard is drawn on — where `D_TOP / 5` (the reference's
 * five courses) would drift out of phase the moment the divider is not a multiple of five
 * tiles deep.
 */
const bond = (ty: number): number => (ty % 2 ? MAP_TILE / 2 : 0);

// ---------------------------------------------------------------------------
// Palette — sampled off reference A, not chosen
// ---------------------------------------------------------------------------

/**
 * `docs/art/waiting-room.md` §1's sampled values, and the fact that decides all of them:
 * over the reference's interior the floor's mean **R−B = −8.3 and G−B = −16.8**. The stone
 * is a desaturated violet-mauve. *Every* warm value in that image belongs to a light
 * source. Grading the stone warm is the mistake this palette exists to prevent.
 *
 * The value structure `hall.md` §5.1 measured, and which is what gives a room with no
 * interior geometry its depth: void L 8.3 < wall's dark course L 17.4 < floor at the
 * perimeter L 24–33 < the wall's lit inner face L 37–47 < floor at the centre L 57. The
 * wall carries both the darkest and the brightest stone in the room; that contrast inside a
 * single object is its thickness.
 */
const PAL = {
  /** Outside the room. Reference sampled (10, 9, 22): violet-black, not neutral. */
  void: '#0a0710',
  /** The masonry the extended frame exposes beyond the map border. */
  offMap: '#1b1522',
  /** Wall body — the dark carved course. Must sit clearly BELOW the floor's own luminance,
   *  or the rim and face read as outlines around holes rather than as light on mass. */
  wall: '#120d1c',
  /** The lit stone face of a wall tile, inset inside its own mortar. */
  cap: '#2a2338',
  /** Lit top face of a wall. Reference outer brick course, L 34.6. */
  rim: '#3d3350',
  /** Lit left/right edge — `MAP_RIM_PATH` only lights walls with floor *above*. */
  face: '#2c2440',
  /** The shadow a wall casts onto the floor beside it. Flat paint, never mass. */
  foot: '#0b0710',
  /** The arch's interior. Reference L 14.3 — BELOW the wall's own dark course (17.4), which
   *  is what makes the mouth read as depth rather than as a dark panel. */
  mouth: '#070410',
  /** The slab face and its two variants — the fit in the floor section below. */
  slab: '#3a3450',
  slabLit: '#3c3653',
  slabDark: '#38324d',
  /** The light side of an engraved groove; the wear on a slab face. */
  bevel: '#6f6588',


  /** The floor's one light — fitted (107, 58, 8), see the floor section. NOT the torch orange. */
  ambient: '#6b3a08',
  flameOuter: '#ff6a1a',
  flameMid: '#ffb03a',
  flameCore: '#fff0c0',

  iron: '#171420',
  ironLit: '#3a3548',
  sign: '#ff3346',
  signPanel: '#150609',
  banner: '#2e1b40',
  bannerEdge: '#1a0f26',
  bone: '#9c9384',
  wood: '#4a3524',
  woodLit: '#5d4430',
  hoop: '#6b5136',
  gold: '#c9a049',
  clay: '#5a3d33',
} as const;

// ---------------------------------------------------------------------------
// The floor: vector stone on the tile grid, fitted to reference A
// ---------------------------------------------------------------------------

/**
 * The previous floor was `temple.svg`'s lower band — a 210x238 raster traced to 16 paths,
 * stretched 4.9x over the map and graded purple. At that stretch it was mud: the temple's
 * stair approach became a vertical band down the middle of the room, its terrace edges became
 * horizontal smears, and nothing in it was a slab you could count. Reference A is slabs you
 * can count (`hall.md` §1.2: **one slab per map tile**, running bond, dark joints, a darker pin
 * at every joint crossing), so the floor is now drawn on the same tile grid the bitboard is
 * drawn on, and the 283 KB asset is out of this layer.
 *
 * ## Fitted, not chosen
 *
 * A least-squares fit of the three-term model this layer paints — one base colour, one radial
 * light on the floor's centre, one void vignette on a wider ellipse — against reference A's
 * floor, the per-bin sRGB MEDIAN at fourteen elliptical radii 0.05..1.35
 * (`scipy.optimize.least_squares`, this session) lands at **RMSE 1.26 sRGB counts**:
 *
 *     face(r) = B + 0.257·(1 − r)⁺·(A − B), then ⊕ void at 0.75·clamp((r − 0.28) / (1.36 − 0.28))
 *     B = (58.4, 52.0, 80.1)   A = (107, 58, 8)
 *
 * Rendered and re-measured, the fitted vignette came back 3 L too bright at every radius past
 * 0.45 and 7 L at the corners, so it is applied from r 0.2 at 0.8 rather than from 0.28 at
 * 0.75 — the centre is untouched and the corner lands on the reference's L 17.
 *
 * The light is a dark amber, not the torch orange: at the centre it raises R and G and PULLS
 * B DOWN, which is the reference's R−B flip from −14.6 at the edge to +2.8 at the centre
 * (`hall.md` §1.6). With the flame colour held fixed the fit is 20 % worse. `PAL.ambient` is
 * that colour and is used nowhere else.
 *
 * A median excludes the joints, so `B` IS the slab face and `PAL.slab` is exactly it. (A first
 * pass fitted the mean and lifted it 8 % for the joints; the render came back 34 % over the
 * reference at the median — the joints take back about half of that.) `slabLit`/`slabDark`
 * sit ±3 % (sRGB) either side, the per-slab spread the reference's 5x crop shows. Which slabs
 * are lit, dark or doubled comes from a hash of the tile index, so the bond is irregular and
 * identical on every load.
 */
const JOINT_W = 1.5;
/** Reference joint/face ≈ 0.67 in L, ≈ 0.45 in Y. `PAL.void` over the face at this alpha. */
const JOINT_ALPHA = 0.38;
/** The pin at a joint crossing — the darkest mark on the floor, `hall.md` §1.5. */
const PIN_W = 2.5;
const PIN_ALPHA = 0.7;

/**
 * The light budget, from the fit above. The reference's centre is Y 0.042 (mean) / 0.048
 * (slab faces, p75) and its median floor is Y 0.023; the boot check holds the centre face at or
 * under the reference's. Measured on the render (`plate-lobby-nohud-empty-stage.png`, this
 * session, `legibility.py`'s skin luminances): whole-floor median Y 0.0209, brightest faces at
 * dead centre (p99) Y 0.052, the spawn row (y 832) median 0.030. Against those the darkest skin,
 * Nocturne (Y 0.1136), stands at **2.31:1 / 1.60:1 / 2.09:1**; Argent 2.54 / 1.77 / 2.30;
 * Cobalt 3.07 / 2.14 / 2.78. The reference's own median gives Nocturne 2.24:1; its centre
 * faces 1.7:1. Those are the room's numbers, not a cap solved for elsewhere.
 */
const AMBIENT_ALPHA = 0.257;
const VIGNETTE_ALPHA = 0.8;
/** The vignette's ellipse is 1.36x the floor's, so the ramp keeps falling into the corners
 *  (r = 1.41) instead of clamping at the mid-edge — the reference is still falling at r 1.35. */
const VIGNETTE_SCALE = 1.36;
const VIGNETTE_R0 = 0.2;
const HALO_ALPHA = 0.1;
const GATE_GLOW_ALPHA = 0.09;

/**
 * Floor markings. `hall.md` §4.2 asked for 15 % — the reference does not do that. Around the
 * centre medallion its 5x crop measures Y p5 0.022 / p50 0.042 / p95 0.065: the groove is
 * about half the face and the bevel about 1.5x it, and that is what makes the inlay read as
 * cut stone rather than a decal. The boot check bounds every marking — joint, groove, bevel,
 * wear, slab variant — at ±55 % of the face in Y: inside what the reference does, and a long
 * way short of a barrel (3x+), which is the object read the rule exists to prevent.
 */
const MARK_DARK_ALPHA = 0.35;
const MARK_LIT_ALPHA = 0.25;
const WEAR_ALPHA = 0.12;
const MARK_BOUND = 0.55;

/** A hash on the tile index — the same slab is lit, dark or doubled on every load. */
const noise = (tx: number, ty: number): number =>
  ((Math.imul(tx + 1, 0x9e3779b1) ^ Math.imul(ty + 1, 0x85ebca6b)) >>> 0) % 100;

/**
 * The slab grid: one horizontal joint per course, one vertical joint per slab on the bond,
 * a pin on every crossing, and the lit/dark slabs. Emitted for walkable tiles only — the
 * walls in layer 5 repaint their own tiles, so marks under them would be paid for and never
 * seen. The base fill underneath still covers the whole extent.
 */
const SLABS = ((): { lit: string; dark: string; joints: string; pins: string } => {
  let lit = '';
  let dark = '';
  let joints = '';
  let pins = '';
  const pinOff = (PIN_W - JOINT_W) / 2;
  for (let ty = tileOf(WALL_TOP); ty < MAP_TILES; ty++) {
    const y = ty * MAP_TILE;
    joints += `M0 ${y}h${ARENA_UNITS}v${JOINT_W}h-${ARENA_UNITS}z`;
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (solid(tx, ty)) continue;
      const x = tx * MAP_TILE + bond(ty);
      const n = noise(tx, ty);
      if (n < 14) lit += `M${x} ${y}h${MAP_TILE}v${MAP_TILE}h-${MAP_TILE}z`;
      else if (n < 28) dark += `M${x} ${y}h${MAP_TILE}v${MAP_TILE}h-${MAP_TILE}z`;
      // One joint in twelve is left out, so the bond carries the doubled slabs the reference has.
      if (n % 12 === 5) continue;
      joints += `M${x} ${y}v${MAP_TILE}h${JOINT_W}v-${MAP_TILE}z`;
      pins += `M${x - pinOff} ${y - pinOff}h${PIN_W}v${PIN_W}h-${PIN_W}z`;
    }
  }
  return { lit, dark, joints, pins };
})();

// ---------------------------------------------------------------------------
// Wall edge geometry, compiled from the same grid as the walls themselves
// ---------------------------------------------------------------------------

const FACE_W = 3;
/** The wall's cast shadow, widened with the wall (`hall.md` §5.2) — it is now the room's
 *  ONLY cast shadow, so it carries more weight than it did beside 26 pillars. */
const FOOT_H = MAP_TILE / 2;

/**
 * The edge treatments, derived from `MAP_GRID` — the same generated table, so there is still
 * exactly one source of truth for where a wall is. `MAP_CAP/COURSE/FACE_PATH` sit on wall
 * tiles; `MAP_FOOT_PATH` is flat paint on the floor tile *below* a wall.
 *
 * ponytail: derived locally rather than exported from `sprites.ts`, because this agent does
 * not own that file. Upgrade path is one `tilePath` call each in `sprites.ts` and an import.
 */
const [MAP_CAP_PATH, MAP_COURSE_PATH, MAP_FACE_PATH, MAP_FOOT_PATH] = ((): [string, string, string, string] => {
  let cap = '';
  let course = '';
  let face = '';
  let foot = '';
  for (let ty = 0; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (!solid(tx, ty)) continue;
      const x = tx * MAP_TILE;
      const y = ty * MAP_TILE;
      // The cap is ERODED, not inset per tile: a run of wall has to read as one mass, and
      // insetting every tile dices it into blocks with a mortar cross through the middle.
      const cx0 = solid(tx - 1, ty) ? x : x + FACE_W;
      const cx1 = solid(tx + 1, ty) ? x + MAP_TILE : x + MAP_TILE - FACE_W;
      const cy0 = solid(tx, ty - 1) ? y : y + FACE_W;
      const cy1 = solid(tx, ty + 1) ? y + MAP_TILE : y + MAP_TILE - FACE_W;
      cap += `M${cx0} ${cy0}H${cx1}V${cy1}H${cx0}z`;
      // Running bond on the module every masonry element in this file shares: one course
      // per tile, the vertical joint offset half a block on odd rows. Irregular enough to
      // read as brick; regular enough to phase with the tower.
      course += `M${x} ${y}h${MAP_TILE}v1.5h-${MAP_TILE}z`;
      course += `M${x + bond(ty)} ${y}v${MAP_TILE}h1.5v-${MAP_TILE}z`;
      if (!solid(tx - 1, ty)) face += `M${x} ${y}h${FACE_W}v${MAP_TILE}h-${FACE_W}z`;
      if (!solid(tx + 1, ty)) face += `M${x + MAP_TILE - FACE_W} ${y}h${FACE_W}v${MAP_TILE}h-${FACE_W}z`;
      if (!solid(tx, ty + 1)) foot += `M${x} ${y + MAP_TILE}h${MAP_TILE}v${FOOT_H}h-${MAP_TILE}z`;
    }
  }
  return [cap, course, face, foot];
})();

/** A running-bond brick grid over a rectangle, on the module and phase above. `w` widens the
 *  block for the off-map foundation courses; the course height is always one tile. */
function brick(x0: number, y0: number, x1: number, y1: number, w: number = MAP_TILE): string {
  const span = x1 - x0;
  let d = '';
  for (let ty = Math.ceil(y0 / MAP_TILE); ty * MAP_TILE < y1; ty++) {
    const y = ty * MAP_TILE;
    d += `M${x0} ${y}h${span}v1.5h-${span}z`;
    for (let x = Math.floor(x0 / w) * w + (ty % 2 ? w / 2 : 0); x < x1; x += w) {
      if (x <= x0) continue;
      d += `M${x} ${y}v${MAP_TILE}h1.5v-${MAP_TILE}z`;
    }
  }
  return d;
}

// ---------------------------------------------------------------------------
// The inner-face walk — where every fixture with mass is placed
// ---------------------------------------------------------------------------

interface Anchor {
  /** A point on the wall's inner face, at the fixture's parametric position. */
  readonly fx: number;
  readonly fy: number;
  /** The mid-depth of the wall at the same position — where a wall-mounted fixture goes. */
  readonly mx: number;
  readonly my: number;
  /** The wall's painted depth here, in units. */
  readonly d: number;
  /** The solid tile the fixture is anchored on. Asserted `'#'` in the boot check. */
  readonly tx: number;
  readonly ty: number;
}

/** Every anchor this layer used, so the boot check can prove each one is a wall tile. */
const ANCHORS: Anchor[] = [];

/**
 * Place a fixture at parametric position `t` along one side of the room's inner face.
 *
 * This replaces the shipped `TORCHES`, `BARRELS`, `CHEST`, `CANDLES` and `BONES` coordinate
 * lists — thirty-odd typed numbers, every one of them wrong the moment the lobby grows.
 * Three properties fall out and none can drift when the map changes: the anchor is on a
 * `'#'` tile by construction, it moves with the map, and the placement contains no
 * coordinate at all.
 *
 * The scan walks inward from the map edge (or, on the top side, down from `WALL_TOP`) until
 * it leaves solid tiles, so it reads the perimeter's real depth — 1 tile or 2 or 5 — instead
 * of assuming one.
 */
function anchor(side: 'top' | 'bottom' | 'left' | 'right', t: number): Anchor {
  const horiz = side === 'left' || side === 'right';
  const along = horiz ? tileOf(FLOOR.top + t * (H_F - 1)) : tileOf(FLOOR.left + t * (W_F - 1));
  const step = side === 'left' || side === 'top' ? 1 : -1;
  const start = side === 'left' ? 0 : side === 'top' ? tileOf(WALL_TOP) : MAP_TILES - 1;

  let k = start;
  let n = 0;
  while (k >= 0 && k < MAP_TILES && solid(horiz ? k : along, horiz ? along : k)) {
    k += step;
    n++;
  }
  if (n === 0) {
    throw new Error(`WaitingRoom: no wall on the ${side} face at t=${t} — fixture placed over the doorway?`);
  }
  const faceU = (step > 0 ? k : k + 1) * MAP_TILE;
  const midU = faceU - (step * n * MAP_TILE) / 2;
  const alongU = along * MAP_TILE + MAP_TILE / 2;
  const a: Anchor = horiz
    ? { fx: faceU, fy: alongU, mx: midU, my: alongU, d: n * MAP_TILE, tx: k - step, ty: along }
    : { fx: alongU, fy: faceU, mx: alongU, my: midU, d: n * MAP_TILE, tx: along, ty: k - step };
  ANCHORS.push(a);
  return a;
}

// ---------------------------------------------------------------------------
// Fixtures — primitives only, no generator, no new asset
// ---------------------------------------------------------------------------

/** A wall flame: bracket, shaft, three lobes, and a small halo on the masonry (F2). */
function torch(key: string, x: number, y: number, s = 1): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <rect x={-2.5} y={-1} width={5} height={12} fill={PAL.wood} />
      <rect x={-5} y={9} width={10} height={3} fill={PAL.hoop} />
      <path d="M0 -20 C7 -12 6 -3 0 -1 C-6 -3 -7 -12 0 -20z" fill={PAL.flameOuter} />
      <path d="M0 -16 C4.5 -10 4 -3 0 -2 C-4 -3 -4.5 -10 0 -16z" fill={PAL.flameMid} />
      <path d="M0 -11 C2.2 -7 2 -3 0 -2.5 C-2 -3 -2.2 -7 0 -11z" fill={PAL.flameCore} />
    </g>
  );
}

/**
 * The halo a flame throws. Radius **0.02 W_f** (`hall.md` §5.3 step 5) — it lands on the
 * masonry and barely on the floor, which is what the reference measures and the opposite of
 * the `rx 92` pools it replaces.
 */
const HALO_R = 0.02 * W_F;
function halo(key: string, x: number, y: number): ReactElement {
  return <circle key={key} cx={x} cy={y} r={HALO_R} fill="url(#waiting-halo)" />;
}

/** A barrel: contact shadow, staves, two hoops, lid. Base straddles the wall's inner face. */
function barrel(key: string, x: number, y: number, s = 1): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cx={0} cy={2} rx={13} ry={5} fill={PAL.foot} opacity={0.55} />
      <rect x={-11} y={-26} width={22} height={28} rx={4} fill={PAL.wood} />
      <rect x={-11} y={-21} width={22} height={3} fill={PAL.hoop} />
      <rect x={-11} y={-8} width={22} height={3} fill={PAL.hoop} />
      <ellipse cx={0} cy={-26} rx={11} ry={4} fill={PAL.woodLit} />
    </g>
  );
}

/** A clay urn — reference A's top-right and lower-right clusters. */
function urn(key: string, x: number, y: number, s = 1): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <ellipse cx={0} cy={1} rx={11} ry={4} fill={PAL.foot} opacity={0.55} />
      <path d="M-9 1 C-13 -8 -10 -18 0 -20 C10 -18 13 -8 9 1z" fill={PAL.clay} />
      <path d="M-5 -19 h10 v3 h-10z" fill={PAL.woodLit} />
    </g>
  );
}

/** The treasure chest, lid open, the only gold in the room. */
function chest(key: string, x: number, y: number): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y})`}>
      <ellipse cx={0} cy={2} rx={19} ry={6} fill={PAL.foot} opacity={0.55} />
      <rect x={-17} y={-16} width={34} height={18} rx={2} fill={PAL.wood} />
      <rect x={-17} y={-10} width={34} height={3} fill={PAL.gold} opacity={0.75} />
      <path d="M-17 -16 Q0 -32 17 -16z" fill={PAL.woodLit} />
      <rect x={-4} y={-13} width={8} height={7} rx={1} fill={PAL.gold} />
    </g>
  );
}

/** A candle cluster — flat-footed, so it may stand on open floor. */
function candles(key: string, x: number, y: number): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y})`}>
      {[
        [-14, 0, 20],
        [-5, -4, 27],
        [4, 1, 17],
        [12, -3, 23],
        [20, 2, 14],
      ].map(([cx, dy, h], i) => (
        <g key={i} transform={`translate(${cx} ${dy})`}>
          <rect x={-2} y={-h!} width={4} height={h!} fill="#d9cdb4" opacity={0.8} />
          <path
            d={`M0 ${-h! - 7} C2 ${-h! - 3} 1.8 ${-h! - 0.5} 0 ${-h!} C-1.8 ${-h! - 0.5} -2 ${-h! - 3} 0 ${-h! - 7}z`}
            fill={PAL.flameMid}
          />
        </g>
      ))}
    </g>
  );
}

/** Scattered bones. Flat markings; walking over one reads correctly. */
function bones(key: string, x: number, y: number): ReactElement {
  return (
    <g key={key} fill={PAL.bone} opacity={0.5} transform={`translate(${x} ${y}) scale(0.7)`}>
      <path d="M0 0h18v4H0zM-3 -2a3 3 0 106 0a3 3 0 10-6 0M18 -2a3 3 0 106 0a3 3 0 10-6 0" />
      <path d="M26 14h14v3H26zM23 12a2.5 2.5 0 105 0a2.5 2.5 0 10-5 0" />
      <path d="M-16 16h12v3h-12zM-20 15a2.5 2.5 0 105 0a2.5 2.5 0 10-5 0" />
      <ellipse cx={44} cy={-2} rx={7} ry={6} />
    </g>
  );
}

/** A horned-skull motif — the crest above the sign and the device on both banners. */
function skull(key: string, x: number, y: number, s: number, fill: string, opacity = 1): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`} fill={fill} opacity={opacity}>
      {/* horns, sweeping out and up */}
      <path d="M-7 -6 C-16 -10 -23 -8 -26 -1 C-22 -4 -16 -4 -10 -1z" />
      <path d="M7 -6 C16 -10 23 -8 26 -1 C22 -4 16 -4 10 -1z" />
      {/* cranium and muzzle */}
      <path d="M0 -12 C9 -12 13 -5 13 2 C13 8 9 11 6 12 L4 20 L0 23 L-4 20 L-6 12 C-9 11 -13 8 -13 2 C-13 -5 -9 -12 0 -12z" />
      {/* sockets, cut back out of the skull */}
      <path d="M-8 -1 L-3 -1 L-4.5 5 L-8 4z" fill={PAL.void} />
      <path d="M8 -1 L3 -1 L4.5 5 L8 4z" fill={PAL.void} />
    </g>
  );
}

/** Hanging links in the wall's shadow. Reference A: symmetric pairs on the top wall. */
function chain(key: string, x: number, top: number, len: number): ReactElement {
  let d = '';
  for (let y = top; y < top + len; y += 7) d += `M${x - 2.5} ${y}h5v5h-5z`;
  return <path key={key} d={d} fill={PAL.iron} stroke={PAL.ironLit} strokeWidth={0.6} />;
}

// ---------------------------------------------------------------------------
// The gate assembly — architecture built into the top wall
// ---------------------------------------------------------------------------

/**
 * The complaint the user made is that the shipped gate reads as a sign floating over a wall.
 * It did, and `hall.md` §3 says why: the shipped tower was a stepped slab of `PAL.cap`
 * standing above the wall band with its own outline, sharing neither the wall's coursing,
 * nor its jambs, nor its shadow. Five things make it architecture, and all five are here:
 *
 *  1. **Piers that start at the floor line, not at the wall's top.** They run from
 *     `FLOOR.top` — the wall's inner face, where a knight's foot meets the stone — up past
 *     the wall's outer silhouette, and they are drawn OVER the wall's own coursing, so the
 *     wall's horizontal joints terminate against the pier face instead of running through
 *     it. A tower that begins at the wall's top edge is a sign; a pier that begins at the
 *     floor is a building. This is the single most load-bearing item on the list.
 *  2. **One brick module and one phase** through wall, pier, arch and shaft — {@link bond},
 *     which is the tile grid the bitboard itself is drawn on.
 *  3. **A stepped plan and a stepped skyline**: wall → piers `0.284 W_f` → shaft
 *     `0.217 W_f`, two setbacks, with four raised banner bays at `±0.20..0.31 W_f` rising
 *     `0.12 D_top` between the wall's flat run and the piers' `0.30 D_top`. Without the bays
 *     the eye reads one flat wall with one tall thing on it.
 *  4. **The mouth is a hole, not an outline** — filled below the wall's own dark course, and
 *     framed on THREE sides only. A closed `rect` lays half a stroke of lit stone across the
 *     walkable threshold: measured on the previous render at Y 0.0429 against a 0.0384 cap,
 *     dropping the darkest skin to 1.76:1 on the one tile every player holds still on.
 *  5. **A recessed plaque with the crest overlapping its top edge**, and **braziers standing
 *     on the pier tops** — which is what lights the piers from above and says they have
 *     depth.
 *
 * ### The painted opening never exceeds the walkable one
 *
 * The mouth is the walkable slot plus **half a tile of jamb reveal per side** — the arch's
 * inner soffit, receding stone reading as depth. Spec 18 §5.2 caps it at slot + 16 units and
 * the boot check enforces exactly that. A painted opening wider than the slot is a lie about
 * the map, and it is the class of bug this whole redraw is organised around.
 *
 * ### Where §3.1's pier width comes from, and why it is not the reference's
 *
 * `hall.md` measured the reference's piers at `0.047 W_f`, inner faces at `±0.096 W_f`. That
 * inner face is **184 units** apart on this map against a 128-unit walkable slot — a painted
 * opening 1.44x the doorway, which rule 4 above forbids. Spec 18 §5.3's own formula
 * (`0.5 * (0.284 W_f - S)` = 72 u) disagrees with the 44 u it quotes beside it for the same
 * reason. Resolved by keeping the two ends the reference actually fixes — the outer face at
 * `0.142 W_f` and the mouth at the slot — and letting the pier width fall out between them.
 */
const JAMB_REVEAL = MAP_TILE / 2;
const MOUTH_W = SLOT_W + 2 * JAMB_REVEAL;
const MOUTH_X0 = CX - MOUTH_W / 2;
const MOUTH_X1 = CX + MOUTH_W / 2;

const PIER_IN = MOUTH_W / 2;
/** Outer face at reference A's `0.142 W_f`, but never further out than one mouth-width — on a
 *  narrow slot the reference fraction would make the piers wider than the doorway. */
const PIER_OUT = Math.min(0.142 * W_F, PIER_IN + MOUTH_W / 2);
/** The second setback, at the reference's own ratio between its two stages. */
const SHAFT_W = (0.217 / 0.284) * (2 * PIER_OUT);
const BAY_IN = 0.2 * W_F;
const BAY_OUT = 0.31 * W_F;

const PIER_TOP = WALL_TOP - 0.3 * D_TOP;
const BAY_TOP = WALL_TOP - 0.12 * D_TOP;
/** The tower leaves the frame, as reference A's does, at every aspect `VIEW_BLEED` covers. */
const SHAFT_TOP = VIEW_LOBBY.y - VIEW_BLEED;

/**
 * The arch: springs at the wall's outer line, crown at the pier tops, jambs down to the
 * threshold. 0.5 in height/width against reference A's 0.49 — its arch sits inside a wall
 * band 1.25x deeper than this one relative to the room, so matching its *internal* course
 * heights would give a letterbox slot 30 units tall. The proportion is matched instead.
 */
const ARCH_SPRING = WALL_TOP;
const ARCH_APEX = PIER_TOP;
const MOUTH_BOT = GATE_MIN_Y;
/** Quadratic control point that puts the curve's apex exactly on `ARCH_APEX`. */
const ARCH_CY = 2 * ARCH_APEX - ARCH_SPRING;
/** Three-sided: jamb, head, jamb. It NEVER closes across the threshold. */
const ARCH_D = `M${MOUTH_X0} ${MOUTH_BOT}V${ARCH_SPRING}Q${CX} ${ARCH_CY} ${MOUTH_X1} ${ARCH_SPRING}V${MOUTH_BOT}`;

/** Voussoirs: wedge blocks radiating from the springing line, on the arch head. */
const VOUSSOIR_D = ((): string => {
  let d = '';
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    const u = 1 - t;
    const px = u * u * MOUTH_X0 + 2 * u * t * CX + t * t * MOUTH_X1;
    const py = u * u * ARCH_SPRING + 2 * u * t * ARCH_CY + t * t * ARCH_SPRING;
    const vx = px - CX;
    const vy = py - ARCH_SPRING;
    const len = Math.hypot(vx, vy) || 1;
    d += `M${px.toFixed(1)} ${py.toFixed(1)}L${(px + (vx / len) * MAP_TILE).toFixed(1)} ${(py + (vy / len) * MAP_TILE).toFixed(1)}`;
  }
  return d;
})();

const PLAQUE_W = 0.169 * W_F;
const PLAQUE_H = 0.3 * D_TOP;
const PLAQUE_BOT = PIER_TOP - 0.14 * D_TOP;
const PLAQUE_TOP = PLAQUE_BOT - PLAQUE_H;
/**
 * The crest: `0.098 W_f` wide, its muzzle overlapping the plaque's top edge, so the two read
 * as one carved assembly rather than as two decals with a gap between them.
 *
 * The skull primitive's bounding box is 52 x 35 local units — aspect 1.49 against the
 * reference ram skull's 2.9 — so scaling it to the reference's width gives 0.79 D_top of
 * height where `hall.md` §1.3 measured 0.40. The overlap is taken at a tenth of the drawn
 * height rather than the reference's fifth for exactly that reason: a fifth of this
 * primitive's height puts the muzzle through the sign's own glyphs.
 */
const CREST_S = (0.098 * W_F) / 52;
const CREST_BOT = PLAQUE_TOP + 0.1 * 35 * CREST_S;
const CREST_CY = CREST_BOT - 23 * CREST_S;

const PIER_CX = PIER_IN + (PIER_OUT - PIER_IN) / 2;
const BANNER_CX = (BAY_IN + BAY_OUT) / 2;
const BANNER_W = 0.054 * W_F;
const BANNER_LEN = 0.98 * D_TOP;

/** The tower's silhouette: piers, shaft, and the four raised bays. One path, drawn once. */
const TOWER_D =
  `M${CX - PIER_OUT} ${FLOOR.top}V${PIER_TOP}h${PIER_OUT - PIER_IN}V${FLOOR.top}z` +
  `M${CX + PIER_IN} ${FLOOR.top}V${PIER_TOP}h${PIER_OUT - PIER_IN}V${FLOOR.top}z` +
  `M${CX - SHAFT_W / 2} ${PIER_TOP}V${SHAFT_TOP}h${SHAFT_W}V${PIER_TOP}z` +
  `M${CX - BAY_OUT} ${WALL_TOP}V${BAY_TOP}h${BAY_OUT - BAY_IN}V${WALL_TOP}z` +
  `M${CX + BAY_IN} ${WALL_TOP}V${BAY_TOP}h${BAY_OUT - BAY_IN}V${WALL_TOP}z`;

const GATE: ReactElement = (
  <g>
    {/* The mouth, first and behind everything: a hole darker than the wall's dark course. */}
    <path d={`${ARCH_D}z`} fill={PAL.mouth} />

    {/* Portcullis — inside the mouth, on the DOORWAY rows only. The gate block below
        (`GATE_MIN_Y..`) is walkable and inside this room's own zone, so painting a barrier
        over it is forbidden: the doorway you walk into has to read as floor. The tunnel
        above it is pit rows a `ZONE_LOBBY` seat can never reach. */}
    <g id="gate-portcullis" fill={PAL.ironLit}>
      {Array.from({ length: 7 }, (_, i) => (
        <rect
          key={i}
          x={MOUTH_X0 + ((i + 1) * MOUTH_W) / 8 - 1.5}
          y={ARCH_SPRING}
          width={3}
          height={MOUTH_BOT - ARCH_SPRING}
        />
      ))}
      <rect x={MOUTH_X0} y={ARCH_SPRING + (MOUTH_BOT - ARCH_SPRING) * 0.2} width={MOUTH_W} height={3} />
      <rect x={MOUTH_X0} y={ARCH_SPRING + (MOUTH_BOT - ARCH_SPRING) * 0.7} width={MOUTH_W} height={3} />
      <rect x={MOUTH_X0} y={ARCH_SPRING} width={MOUTH_W} height={4} fill={PAL.iron} />
    </g>

    {/* Tower masonry: piers from the floor line, shaft on the arch, four raised bays. Drawn
        OVER the wall's compiled coursing, so the wall's joints stop at the pier face — that
        interruption is what makes the gate read as built into the wall rather than on it. */}
    <path d={TOWER_D} fill={PAL.cap} stroke={PAL.wall} strokeWidth={FACE_W * 2} paintOrder="stroke" />
    <g clipPath="url(#waiting-tower-clip)">
      <path d={brick(CX - PIER_OUT, SHAFT_TOP, CX + PIER_OUT, FLOOR.top)} fill={PAL.wall} opacity={0.45} />
    </g>
    {/* Lit top faces — the same 3-unit rim the compiled walls carry. */}
    <path
      d={
        `M${CX - PIER_OUT} ${PIER_TOP}h${PIER_OUT - PIER_IN}v${FACE_W}h-${PIER_OUT - PIER_IN}z` +
        `M${CX + PIER_IN} ${PIER_TOP}h${PIER_OUT - PIER_IN}v${FACE_W}h-${PIER_OUT - PIER_IN}z` +
        `M${CX - BAY_OUT} ${BAY_TOP}h${BAY_OUT - BAY_IN}v${FACE_W}h-${BAY_OUT - BAY_IN}z` +
        `M${CX + BAY_IN} ${BAY_TOP}h${BAY_OUT - BAY_IN}v${FACE_W}h-${BAY_OUT - BAY_IN}z`
      }
      fill={PAL.rim}
    />

    {/* The arch ring: three-sided outline plus its voussoirs. No segment ever crosses the
        threshold, which the boot check re-derives from the path string itself. */}
    <path d={VOUSSOIR_D} fill="none" stroke={PAL.rim} strokeWidth={2} opacity={0.85} />
    <path d={ARCH_D} fill="none" stroke={PAL.rim} strokeWidth={3} />

    {/* The plaque: RECESSED — a dark inset panel with a stone bead above and below on the
        brick module, its frame flush with the pier faces. A course of the tower, not a
        rectangle laid on it. */}
    <g id="gate-sign">
      <rect
        x={CX - PLAQUE_W / 2 - FACE_W}
        y={PLAQUE_TOP - FACE_W}
        width={PLAQUE_W + 2 * FACE_W}
        height={PLAQUE_H + 2 * FACE_W}
        fill={PAL.rim}
      />
      <rect x={CX - PLAQUE_W / 2} y={PLAQUE_TOP} width={PLAQUE_W} height={PLAQUE_H} fill={PAL.signPanel} />
      <text
        x={CX}
        y={PLAQUE_BOT - PLAQUE_H * 0.2}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize={PLAQUE_H * 0.55}
        fontWeight={700}
        letterSpacing={PLAQUE_H * 0.06}
        fill={PAL.sign}
      >
        BOSS FIGHT
      </text>
    </g>

    {/* The crest, overlapping the plaque's top edge. */}
    {skull('gate-crest', CX, CREST_CY, CREST_S, '#b9a58f', 0.92)}

    {/* Braziers standing ON the pier tops, above the wall line — not hung on the wall face
        beside the sign. Their halo on the pier stone is what ties the shaft back into the
        wall, and it is the reason the tower's upper stage is lit at all. */}
    {halo(`gh-l`, CX - PIER_CX, PIER_TOP)}
    {halo(`gh-r`, CX + PIER_CX, PIER_TOP)}
    {torch('gate-l', CX - PIER_CX, PIER_TOP, 1.25)}
    {torch('gate-r', CX + PIER_CX, PIER_TOP, 1.25)}
  </g>
);

// ---------------------------------------------------------------------------
// The floor — open, and provably so
// ---------------------------------------------------------------------------

/** Snap a marking to a tile centre, so it sits on the slab grid rather than across it. */
const snap = (u: number): number => tileOf(u) * MAP_TILE + MAP_TILE / 2;

/**
 * A floor medallion: a diamond ring (or two) around a four-point compass rose, engraved —
 * a dark groove with a light bevel one unit off it, at the reference's own groove/bevel
 * ratio (see `MARK_DARK_ALPHA`). Geometry first, value second; the boot check bounds both.
 */
function medallion(key: string, cx: number, cy: number, r: number, rings: number): ReactElement {
  const dia = (k: number): string => `M${cx} ${cy - k}L${cx + k} ${cy}L${cx} ${cy + k}L${cx - k} ${cy}z`;
  const rose =
    `M${cx} ${cy - r * 0.45}L${cx + r * 0.12} ${cy}L${cx} ${cy + r * 0.45}L${cx - r * 0.12} ${cy}z` +
    `M${cx - r * 0.45} ${cy}L${cx} ${cy - r * 0.12}L${cx + r * 0.45} ${cy}L${cx} ${cy + r * 0.12}z`;
  let grooves = '';
  for (let i = 0; i < rings; i++) grooves += dia(r - i * r * 0.22);
  return (
    <g key={key}>
      <path d={grooves} fill="none" stroke={PAL.void} strokeWidth={2} opacity={MARK_DARK_ALPHA} />
      <path
        d={grooves}
        fill="none"
        stroke={PAL.bevel}
        strokeWidth={1.5}
        opacity={MARK_LIT_ALPHA}
        transform="translate(1 1)"
      />
      <path d={rose} fill={PAL.void} opacity={MARK_DARK_ALPHA} />
      <path d={rose} fill={PAL.bevel} opacity={MARK_LIT_ALPHA} transform="translate(1 1)" />
    </g>
  );
}

/**
 * Everything on the floor, and there is no fourth thing: slabs (`SLABS`, in layer 2), wear,
 * and five medallions. No cover, no rubble field, no crates, no pillars, no scatter in
 * the middle third — the user's "no randomly scattered cover tiles, nothing that reads as
 * cover", and `hall.md` §4.3's deletion of the old central-aisle rule, which only existed
 * because the aisle was the one unobstructed column between 26 pillar blocks. With the
 * obstacles gone the whole floor is the aisle.
 *
 * Positions are fractions of the floor's own half-extents, so they scale with the map.
 * Reference A's corner medallions sit at ±0.39 W_f and −0.27 / +0.41 H_f from the floor's
 * centre — not a symmetric cross, because the gate crowds the top of the room.
 */
const MARKINGS: ReactElement = (
  <g>
    {/* Worn patches: lighter mottling over the slab faces. */}
    <g fill={PAL.bevel} opacity={WEAR_ALPHA}>
      {(
        [
          [-0.22, -0.35, 0.13, 0.09],
          [0.18, -0.28, 0.1, 0.07],
          [0.05, 0.12, 0.16, 0.1],
          [-0.4, 0.3, 0.11, 0.08],
          [0.42, 0.34, 0.12, 0.08],
          [-0.06, 0.42, 0.14, 0.07],
        ] as const
      ).map(([fx, fy, rx, ry], i) => (
        <ellipse key={i} cx={CX + fx * W_F} cy={CY + fy * H_F} rx={rx * W_F * 0.5} ry={ry * H_F * 0.5} />
      ))}
    </g>
    {/* Hairline cracks, three segments each. Flat and massless: no shadow, nothing to stand behind. */}
    <path
      d={(
        [
          [-0.34, -0.18, 0.05, 0.04, 0.02, 0.05, 0.04, 0.02],
          [0.12, -0.4, 0.03, 0.05, 0.04, 0.02, 0.01, 0.06],
          [-0.1, 0.32, 0.06, -0.02, 0.03, -0.05, 0.05, -0.01],
          [0.36, 0.05, -0.03, 0.05, -0.04, 0.02, -0.02, 0.05],
          [-0.44, 0.46, 0.03, -0.04, 0.02, -0.01, 0.03, -0.05],
        ] as const
      )
        .map(
          ([fx, fy, ...seg]) =>
            `M${(CX + fx * W_F).toFixed(1)} ${(CY + fy * H_F).toFixed(1)}` +
            seg
              .map((v, i) => (i % 2 ? ` ${(v * H_F * 0.5).toFixed(1)}` : `l${(v * W_F * 0.5).toFixed(1)}`))
              .join(''),
        )
        .join('')}
      fill="none"
      stroke={PAL.void}
      strokeWidth={1.2}
      opacity={MARK_DARK_ALPHA}
    />
    {medallion('m-tl', snap(CX - 0.39 * W_F), snap(CY - 0.27 * H_F), 0.057 * W_F * 0.5, 1)}
    {medallion('m-tr', snap(CX + 0.39 * W_F), snap(CY - 0.27 * H_F), 0.057 * W_F * 0.5, 1)}
    {medallion('m-bl', snap(CX - 0.39 * W_F), snap(CY + 0.41 * H_F), 0.057 * W_F * 0.5, 1)}
    {medallion('m-br', snap(CX + 0.39 * W_F), snap(CY + 0.41 * H_F), 0.057 * W_F * 0.5, 1)}
    {medallion('m-c', snap(CX), snap(CY), 0.088 * W_F * 0.5, 2)}
  </g>
);

// ---------------------------------------------------------------------------
// Perimeter fixtures — every one placed on the inner-face walk
// ---------------------------------------------------------------------------

/**
 * All decoration hugs the perimeter, which is the user's rule and the reference's: every
 * prop with mass is within about 1.5 tiles of a wall's inner face, and nothing stands in the
 * middle. The eye reads depth from a detailed near edge against a plain far ground, so the
 * detail budget goes here rather than onto the floor.
 *
 * `t` is the parametric position along that side's inner face. The fractions are the
 * reference's own, converted once: side torches at 0.06 and 0.72 of `H_f` (measured 0.00 and
 * 0.71), lit side doorways at 0.29, the skull niche at 0.10 of `W_f` and the barred cell
 * window at 0.83, chains at ±0.156 and ±0.439 from the centre line.
 *
 * ponytail: props are not solid — a knight can clip the outer units of a barrel. Upgrade
 * path is marking those tiles `#` in `assets/map/arena.json` and re-running `gen_map.py`,
 * which changes the table the chain raycasts, so it is a map change with `cargo test` behind
 * it and not an art edit.
 */
const PROPS: ReactElement = ((): ReactElement => {
  const L1 = anchor('left', 0.06);
  const L2 = anchor('left', 0.72);
  const R1 = anchor('right', 0.06);
  const R2 = anchor('right', 0.72);
  const DL = anchor('left', 0.29);
  const DR = anchor('right', 0.29);
  // Props: top-left barrel and chest, top-right urns, bottom corners, and reference A's
  // lower-left candle cluster with its scatter of bones.
  const P = {
    tlBarrel: anchor('top', 0.08),
    tlChest: anchor('top', 0.16),
    trUrn: anchor('top', 0.9),
    trUrn2: anchor('top', 0.94),
    blBarrel: anchor('bottom', 0.07),
    brBarrel: anchor('bottom', 0.92),
    brUrn: anchor('right', 0.86),
    candle: anchor('left', 0.78),
  };
  const niche = anchor('top', 0.1);
  const window_ = anchor('top', 0.83);
  const chains = [0.5 - 0.439, 0.5 - 0.156, 0.5 + 0.156, 0.5 + 0.439].map((t) => anchor('top', t));

  const inward = MAP_TILE * 1.1;
  return (
    <g>
      {/* Chains, hanging in the top wall's shadow. */}
      {chains.map((a, i) => chain(`ch${i}`, a.fx, WALL_TOP + D_TOP * 0.1, D_TOP * 0.55))}

      {/* A recessed arched niche with a skull, cut into the dark course. */}
      <g>
        <path
          d={`M${niche.fx - 0.0165 * W_F} ${WALL_TOP + 0.75 * D_TOP}V${WALL_TOP + 0.45 * D_TOP}a${0.0165 * W_F} ${0.0165 * W_F} 0 0 1 ${0.033 * W_F} 0V${WALL_TOP + 0.75 * D_TOP}z`}
          fill={PAL.mouth}
          stroke={PAL.rim}
          strokeWidth={2}
        />
        {skull(`niche-s`, niche.fx, WALL_TOP + 0.6 * D_TOP, (0.02 * W_F) / 52, PAL.bone, 0.55)}
      </g>

      {/* A barred cell bay with a skull inside, framed by pilaster blocks. */}
      <g>
        <rect
          x={window_.fx - 0.04 * W_F}
          y={WALL_TOP + 0.35 * D_TOP}
          width={0.08 * W_F}
          height={0.5 * D_TOP}
          fill={PAL.mouth}
          stroke={PAL.rim}
          strokeWidth={2}
        />
        {Array.from({ length: 5 }, (_, i) => (
          <rect
            key={i}
            x={window_.fx - 0.04 * W_F + ((i + 1) * 0.08 * W_F) / 6 - 1}
            y={WALL_TOP + 0.35 * D_TOP}
            width={2}
            height={0.5 * D_TOP}
            fill={PAL.ironLit}
          />
        ))}
        {skull(`cell-s`, window_.fx, WALL_TOP + 0.68 * D_TOP, (0.022 * W_F) / 52, PAL.bone, 0.4)}
      </g>

      {/* Banners, hung from the raised bays, carrying the horned-skull sigil. Sampled L 23.1
          in the reference — darker than the wall's lit course, so they read as cloth in
          shadow rather than as a second focal point. */}
      {[CX - BANNER_CX, CX + BANNER_CX].map((bx, i) => (
        <g key={i}>
          <path
            d={`M${bx - BANNER_W / 2} ${BAY_TOP}h${BANNER_W}v${BANNER_LEN - BANNER_W * 0.28}l-${BANNER_W / 2} ${BANNER_W * 0.28}l-${BANNER_W / 2} -${BANNER_W * 0.28}z`}
            fill={PAL.banner}
            stroke={PAL.bannerEdge}
            strokeWidth={2}
          />
          <rect x={bx - BANNER_W * 0.6} y={BAY_TOP - 4} width={BANNER_W * 1.2} height={5} rx={2} fill={PAL.ironLit} />
          {skull(`b${i}-s`, bx, BAY_TOP + BANNER_LEN * 0.42, (BANNER_W * 0.62) / 52, '#7d5fa8', 0.9)}
        </g>
      ))}

      {/* The two lit side doorways — the only warm thing on the side walls besides the
          torches, and the reference's own depth trick: a hole with light behind it. */}
      {[DL, DR].map((a, i) => (
        <g key={i}>
          <rect
            x={i === 0 ? a.fx - a.d : a.fx}
            y={a.fy - 0.035 * H_F}
            width={a.d}
            height={0.07 * H_F}
            fill={PAL.mouth}
          />
          {/* The leaf and its lit edge stay INSIDE the wall's own depth. A door panel that
              spills past the inner face is mass painted on walkable floor. */}
          <rect
            x={i === 0 ? a.fx - a.d * 0.8 : a.fx + a.d * 0.2}
            y={a.fy - 0.028 * H_F}
            width={a.d * 0.6}
            height={0.056 * H_F}
            fill={PAL.wood}
          />
          <rect
            x={i === 0 ? a.fx - 3 : a.fx + 1}
            y={a.fy - 0.028 * H_F}
            width={2}
            height={0.056 * H_F}
            fill={PAL.gold}
            opacity={0.45}
          />
        </g>
      ))}

      {/* Props with mass, each straddling a wall's inner face. */}
      {barrel('p-tl', P.tlBarrel.fx, P.tlChest.fy + inward)}
      {chest('p-tc', P.tlChest.fx, P.tlChest.fy + inward * 0.9)}
      {urn('p-tr', P.trUrn.fx, P.trUrn.fy + inward)}
      {urn('p-tr2', P.trUrn2.fx, P.trUrn2.fy + inward * 1.3, 0.82)}
      {barrel('p-bl', P.blBarrel.fx, P.blBarrel.fy - inward * 0.4, 0.9)}
      {barrel('p-br', P.brBarrel.fx, P.brBarrel.fy - inward * 0.4)}
      {urn('p-r', P.brUrn.fx - inward, P.brUrn.fy, 0.9)}
      {/* Flat things — bones and candle bases — may sit on floor: walking over a bone reads
          correctly. Bone and candle wax are props, not floor: the marking bound does not apply. */}
      {candles('p-cd', P.candle.fx + inward * 1.4, P.candle.fy)}
      {bones('p-bn', P.candle.fx + inward * 3.2, P.candle.fy + inward * 0.6)}

      {/* Four wall flames, and nothing else lights the perimeter (F1). */}
      {[L1, L2, R1, R2].map((a, i) => halo(`h${i}`, a.mx, a.my))}
      {[L1, L2, R1, R2].map((a, i) => torch(`t${i}`, a.mx, a.my))}
    </g>
  );
})();

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/**
 * Mount as `{WAITING}`, in room B's place, as the first child of `#camera`.
 * Do not wrap it, do not give it a changing key, do not pass it anything.
 *
 * Layer order is spec 18 §7, rows 0–6, and the order is load-bearing: floor light goes
 * UNDER the wall mass, so a wall is never washed by it, and the whole gate assembly goes
 * last, over the props.
 */
export const WAITING: ReactElement = (
  <g
    id="waiting-room"
    aria-hidden
    // Promotion hint, barrier 3. No transform is ever written here — `#camera` above owns
    // the one the passage animates, and two writers on one node's transform is this
    // project's signature bug.
    style={{ willChange: 'transform', pointerEvents: 'none' }}
  >
    <defs>
      {/* The room's one light: a radial on the floor's own centre, on the floor's own ellipse,
          reaching the mid-edges. Colour and alpha are the least-squares fit above. */}
      <radialGradient
        id="waiting-ambient"
        gradientUnits="userSpaceOnUse"
        r={1}
        cx={0}
        cy={0}
        gradientTransform={`translate(${CX} ${CY}) scale(${W_F / 2} ${H_F / 2})`}
      >
        <stop offset="0" stopColor={PAL.ambient} stopOpacity={AMBIENT_ALPHA} />
        <stop offset="1" stopColor={PAL.ambient} stopOpacity={0} />
      </radialGradient>

      {/* The vignette, on 1.36x the same ellipse — the other half of the ramp, and it keeps
          falling into the corners the way the reference's does. */}
      <radialGradient
        id="waiting-vignette"
        gradientUnits="userSpaceOnUse"
        r={1}
        cx={0}
        cy={0}
        gradientTransform={`translate(${CX} ${CY}) scale(${(W_F / 2) * VIGNETTE_SCALE} ${(H_F / 2) * VIGNETTE_SCALE})`}
      >
        <stop offset={VIGNETTE_R0 / VIGNETTE_SCALE} stopColor={PAL.void} stopOpacity={0} />
        <stop offset="1" stopColor={PAL.void} stopOpacity={VIGNETTE_ALPHA} />
      </radialGradient>

      {/* The frame's fall-off: the off-map masonry goes to void at the bleed. On 2x the floor
          ellipse the map's side and bottom edges both land near r 0.55, so the fade starts at
          the border wall on every side and is near-black by the frame edge. */}
      <radialGradient
        id="waiting-frame-fade"
        gradientUnits="userSpaceOnUse"
        r={1}
        cx={0}
        cy={0}
        gradientTransform={`translate(${CX} ${CY}) scale(${W_F} ${H_F})`}
      >
        <stop offset="0.5" stopColor={PAL.void} stopOpacity={0} />
        <stop offset="0.85" stopColor={PAL.void} stopOpacity={0.9} />
      </radialGradient>

      {/* One halo def for every flame: `objectBoundingBox` units, so six lights cost one def. */}
      <radialGradient id="waiting-halo">
        <stop offset="0" stopColor={PAL.flameOuter} stopOpacity={HALO_ALPHA} />
        <stop offset="1" stopColor={PAL.flameOuter} stopOpacity={0} />
      </radialGradient>

      {/* The gate's red spill. The only red in the room, and the reason the eye goes there. */}
      <radialGradient id="waiting-gate-glow" gradientUnits="userSpaceOnUse" cx={CX} cy={ARCH_SPRING} r={MOUTH_W * 1.6}>
        <stop offset="0" stopColor="#ff2b3c" stopOpacity={GATE_GLOW_ALPHA} />
        <stop offset="1" stopColor="#ff2b3c" stopOpacity={0} />
      </radialGradient>

      {/* Everything the room is made of is clipped to the room band, so the map's pit walls
          never leak into the waiting area's frame. The gate tower is drawn OUTSIDE this clip,
          which is the R3 exception and the only one. */}
      <clipPath id="waiting-room-clip">
        <rect
          x={-OFF_MAP}
          y={WALL_TOP}
          width={ARENA_UNITS + 2 * OFF_MAP}
          height={ARENA_UNITS + OFF_MAP - WALL_TOP}
        />
      </clipPath>
      <clipPath id="waiting-tower-clip">
        <path d={TOWER_D} />
      </clipPath>
    </defs>

    {/* 0. The void, so the frame can never show raw page behind the room.
           `vp-void` is load-bearing: `useViewport` resizes every node carrying it to the
           LIVE viewBox inflated by `VIEW_BLEED`. The attributes below are just the
           pre-layout frame. */}
    <rect
      className="vp-void"
      x={-ARENA_UNITS}
      y={-ARENA_UNITS}
      width={3 * ARENA_UNITS}
      height={3 * ARENA_UNITS}
      fill={PAL.void}
    />

    <g clipPath="url(#waiting-room-clip)">
      {/* 1. Masonry beyond the map border, all the way to the bleed: coarse foundation blocks
             falling off into the void, so the border reads as a thick wall and the fitted
             box's surplus is stone into darkness rather than a flat band. */}
      <path d={OFF_MAP_D} fill={PAL.offMap} />
      <path
        d={
          brick(-OFF_MAP, WALL_TOP, 0, ARENA_UNITS + OFF_MAP, 2 * MAP_TILE) +
          brick(ARENA_UNITS, WALL_TOP, ARENA_UNITS + OFF_MAP, ARENA_UNITS + OFF_MAP, 2 * MAP_TILE) +
          brick(0, ARENA_UNITS, ARENA_UNITS, ARENA_UNITS + OFF_MAP, 2 * MAP_TILE)
        }
        fill={PAL.wall}
        opacity={0.6}
      />
      <path d={OFF_MAP_D} fill="url(#waiting-frame-fade)" />

      {/* 2. The floor: slabs on the tile grid, over the map's whole extent below the wall
             line. Layer 5 paints the walls back over it from the same table, which is what
             makes the painted floor set-equal to the walkable bitboard. */}
      <rect x={0} y={WALL_TOP} width={ARENA_UNITS} height={ARENA_UNITS - WALL_TOP} fill={PAL.slab} />
      <path d={SLABS.lit} fill={PAL.slabLit} />
      <path d={SLABS.dark} fill={PAL.slabDark} />
      <path d={SLABS.joints} fill={PAL.void} opacity={JOINT_ALPHA} />
      <path d={SLABS.pins} fill={PAL.void} opacity={PIN_ALPHA} />

      {/* 3. Floor markings, on the floor and under the light. */}
      {MARKINGS}

      {/* 4. Floor light — the whole model, and it is two nodes: one warm radial on the
             floor's centre and one vignette on the same ellipse. Both are clipped to the
             floor's own bounding box and both sit UNDER the wall mass, so a wall is never
             washed by them (round 1 of the previous layer painted pools over the walls and
             they were eaten). */}
      <rect x={FLOOR.left} y={FLOOR.top} width={W_F} height={H_F} fill="url(#waiting-ambient)" />
      <rect x={FLOOR.left} y={FLOOR.top} width={W_F} height={H_F} fill="url(#waiting-vignette)" />

      {/* 5. Wall mass, compiled from `MAP_GRID`. This is the ONLY thing that draws a wall,
             which is what makes the painted floor set-equal to the walkable bitboard: the
             floor is painted over the whole room above and the walls are painted back over
             it from the same table the chain raycasts.
             The foot shadow is flat paint on the floor tile below a wall — the room's only
             cast shadow now that the pillars are gone, and the one marking exempt from the
             marking bound, because it only ever touches a wall's inner face and so cannot read
             as a free-standing object. */}
      <path d={MAP_FOOT_PATH} fill={PAL.foot} opacity={0.55} />
      <path d={MAP_WALL_PATH} fill={PAL.wall} />
      <path d={MAP_CAP_PATH} fill={PAL.cap} />
      <path d={MAP_COURSE_PATH} fill={PAL.wall} opacity={0.45} />
      <path d={MAP_RIM_PATH} fill={PAL.rim} />
      <path d={MAP_FACE_PATH} fill={PAL.face} />

      {/* 6. Perimeter fixtures, one layer: wall-mounted and floor-standing together, so
             decoration can never occlude an actor. */}
      {PROPS}
    </g>

    {/* 6b. The gate, unclipped: its tower is authored above the room band, over what is
            really pit floor. R3 is the whole of its licence and the boot check re-derives
            it. */}
    <rect
      x={CX - MOUTH_W * 1.6}
      y={ARCH_SPRING - MOUTH_W * 1.6}
      width={MOUTH_W * 3.2}
      height={MOUTH_W * 3.2}
      fill="url(#waiting-gate-glow)"
    />
    {GATE}
  </g>
);

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------

/**
 * Assertions, not review notes. This block throws at import, so a violation cannot reach a
 * player, and every failure mode below is otherwise silent:
 *
 *  - a decoration that became a wall, or a fixture that drifted onto open floor when the map
 *    grew — the defect class this redraw exists to delete;
 *  - a painted opening wider than the walkable one, this project's signature lie about the
 *    map;
 *  - a brighter floor than the darkest knight can stand on, which reads as "I can't see my
 *    guy" and has shipped once already;
 *  - the tower painting over the pit if R3's zone clamp ever moves.
 */
{
  const NOCTURNE_Y = 0.1136; // darkest skin, area-weighted, `docs/art/legibility.py`
  /** Reference A, centre crop (500..620, 410..540): floor Y mean 0.0423, p75 0.0481 — the slab
   *  faces under the light — p95 0.0649. The face may match the p75; it may not exceed it. The
   *  lit variant lands about 0.051, inside the crop's p95, and the marking bound below holds it. */
  const REF_FACE_Y = 0.0481;

  const hex = (h: string): readonly number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const over = (src: readonly number[], a: number, dst: readonly number[]): number[] =>
    dst.map((d, i) => a * src[i]! + (1 - a) * d);
  const chan = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (c: readonly number[]): number => 0.2126 * chan(c[0]!) + 0.7152 * chan(c[1]!) + 0.0722 * chan(c[2]!);
  const L = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

  // --- light budget: the brightest slab face in the room, under each light that reaches it.
  // The floor is fitted to the reference and the reference's centre is Y 0.042, so the darkest
  // skin stands at about 1.7:1 there and 2.2:1 at the floor's median. That is the reference's
  // own number, measured, not the 1.85 the previous floor was solved against.
  const face = hex(PAL.slab);
  const centre = over(hex(PAL.ambient), AMBIENT_ALPHA, face);
  if (lum(centre) > REF_FACE_Y) {
    throw new Error(
      `WaitingRoom: the floor's centre is Y ${lum(centre).toFixed(4)} > reference ${REF_FACE_Y} — the darkest ` +
        `skin drops to ${((NOCTURNE_Y + 0.05) / (lum(centre) + 0.05)).toFixed(2)}:1. Lower AMBIENT_ALPHA.`,
    );
  }
  // The halo lives at the wall's face, where the vignette is at mid-edge strength and the
  // centre radial has fallen to zero. That is the composite that actually occurs there.
  const edgeT = (1 / VIGNETTE_SCALE - VIGNETTE_R0 / VIGNETTE_SCALE) / (1 - VIGNETTE_R0 / VIGNETTE_SCALE);
  const rim = over(hex(PAL.void), VIGNETTE_ALPHA * edgeT, face);
  const corner = over(hex(PAL.void), VIGNETTE_ALPHA, face);
  const lit = over(hex(PAL.flameOuter), HALO_ALPHA, rim);
  if (lum(lit) > REF_FACE_Y) {
    throw new Error(`WaitingRoom: a flame halo lands the floor at Y ${lum(lit).toFixed(4)} > ${REF_FACE_Y}. Lower HALO_ALPHA.`);
  }
  // The gate threshold is walkable floor inside this room's zone, so the red spill is on the
  // same budget as the flames. It sits ABOVE the floor's bounding box — the gate block is
  // walkable but is not lobby floor — so neither the centre radial nor the vignette reaches it.
  const thresh = over(hex('#ff2b3c'), GATE_GLOW_ALPHA, face);
  if (lum(thresh) > REF_FACE_Y) {
    throw new Error(`WaitingRoom: the gate threshold is Y ${lum(thresh).toFixed(4)} > ${REF_FACE_Y}. Lower GATE_GLOW_ALPHA.`);
  }
  // The ramp is the depth cue; if it collapses the room is flat and no test elsewhere sees it.
  // Reference A: centre-to-corner 2.3:1 in L.
  if (L(centre) / L(corner) < 1.9) {
    throw new Error(`WaitingRoom: centre-to-corner is ${(L(centre) / L(corner)).toFixed(2)}:1 in L, under 1.9`);
  }

  // --- floor markings stay flat: within MARK_BOUND of the local face, both directions
  const base = hex(PAL.slab);
  for (const [what, mark] of [
    ['joint', over(hex(PAL.void), JOINT_ALPHA, base)],
    ['groove', over(hex(PAL.void), MARK_DARK_ALPHA, base)],
    ['bevel', over(hex(PAL.bevel), MARK_LIT_ALPHA, base)],
    ['wear', over(hex(PAL.bevel), WEAR_ALPHA, base)],
    ['lit slab', hex(PAL.slabLit)],
    ['dark slab', hex(PAL.slabDark)],
  ] as const) {
    const drift = Math.abs(lum(mark) - lum(base)) / lum(base);
    if (drift > MARK_BOUND) {
      throw new Error(
        `WaitingRoom: a floor ${what} is ${(drift * 100).toFixed(1)} % off the floor's own ` +
          `luminance, over the ${MARK_BOUND * 100} % bound — it will read as an object you can hit.`,
      );
    }
  }

  // --- every fixture with mass is anchored on a solid tile, by the walk's own construction
  if (ANCHORS.length < 20) throw new Error(`WaitingRoom: only ${ANCHORS.length} fixture anchors — the walk did not run`);
  for (const a of ANCHORS) {
    if (!solid(a.tx, a.ty)) {
      throw new Error(`WaitingRoom: a fixture is anchored on walkable tile (${a.tx}, ${a.ty}) — it must be '#'`);
    }
  }

  // --- the painted opening is never wider than the walkable one
  if (MOUTH_W > SLOT_W + MAP_TILE) {
    throw new Error(`WaitingRoom: the painted mouth is ${MOUTH_W} u against a ${SLOT_W} u slot — max is slot + 16`);
  }
  const throughRow = tileOf(MOUTH_BOT);
  if (!solid(tileOf(MOUTH_X0), throughRow) || !solid(tileOf(MOUTH_X1 - 1), throughRow)) {
    throw new Error('WaitingRoom: the arch jambs do not stand on wall tiles at the threshold');
  }
  // The arch is three-sided by construction: it ends on a vertical, so no segment of it can
  // lay stone across the walkable threshold.
  if (!/V\d+(\.\d+)?$/.test(ARCH_D) || ARCH_D.includes('z')) {
    throw new Error('WaitingRoom: the arch outline is closed — it will stroke the walkable threshold');
  }
  // The piers stand clear of the slot, and the portcullis hangs above it.
  if (PIER_IN < SLOT_W / 2) throw new Error('WaitingRoom: the gate piers overhang the walkable slot');
  if (MOUTH_BOT > GATE_MIN_Y) throw new Error('WaitingRoom: the portcullis overlaps the walkable gate block');

  // --- R3: the lobby zone clamp still excludes every tile the tower paints over
  if (PIT_BOT + 1 > FLOOR.top) {
    throw new Error(
      `WaitingRoom: PIT_BOT + 1 (${PIT_BOT + 1}) is past the lobby floor line (${FLOOR.top}) — ` +
        'the gate tower now paints over tiles a lobby seat can stand on (R3).',
    );
  }

  // --- the crest is the hero of the room, and the fit is allowed to crop everything above the
  // keep: a crest above `KEEP.lobby.y` is cropped on a 16:9 stage and nothing else says so.
  if (CREST_CY - 12 * CREST_S < KEEP.lobby.y) {
    throw new Error(`WaitingRoom: the crest tops out at ${(CREST_CY - 12 * CREST_S).toFixed(0)} u, above the keep (${KEEP.lobby.y})`);
  }

  // --- the room itself
  if (D_TOP < 2 * MAP_TILE) throw new Error(`WaitingRoom: the top wall scanned ${D_TOP} u deep — too thin to carry a gate`);
  if (Math.abs(CX - (GATE_MIN_X + SLOT_W / 2)) > MAP_TILE / 2) {
    throw new Error('WaitingRoom: the gate is no longer on the room centre line — recheck the map');
  }
  if (!MAP_CAP_PATH || !MAP_COURSE_PATH || !MAP_FACE_PATH || !MAP_FOOT_PATH || !VOUSSOIR_D) {
    throw new Error('WaitingRoom: wall edge geometry compiled empty — check MAP_GRID');
  }
}

/**
 * `docs/art/waiting-room.md` §8 names this layer `WAITING`; `Arena.tsx` has imported it
 * under both that name and `WAITING_ROOM`. One alias, one element — the same reference
 * either way, so there is no second fact here to drift.
 */
export { WAITING as WAITING_ROOM };
