/**
 * Room A — the waiting area, as reference `waiting_area_full_vertical.png`.
 *
 * One `<g>` mounted inside `#camera`, mutually exclusive with room B
 * (`{shown === 'lobby' ? WAITING : BOSS_ARENA}`). Frame is `VIEW_LOBBY`;
 * nothing here reads the camera, because under spec §1 there is no camera.
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
 *      constant, the generated `MAP_GRID`/`GATE_*`/`LOBBY_*`, or a measurement recorded in
 *      this header. The 10–20 `Players` notifications a second — 68.4 % of which carry no
 *      position change, each delivered twice by the Magic Router — have nothing to write
 *      here.
 *   3. `will-change: transform`, so it holds its own compositor raster. Promoted vs
 *      unpromoted measured 30–85x, and an unpromoted static background dirties the paint
 *      chunk it shares with the movers.
 *   4. `pointer-events: none`, so it can never become a hit-test target and drag a style
 *      recalculation in through the input path.
 *
 * **Do not add a prop to this file.** `Scene.tsx` measured the alternative at 11.2 ms a
 * frame and 3/3 renderer crashes at 300 frames.
 *
 * Paint cost, re-measured on the shipped layer in the `looksright` harness (`#waiting-room`
 * counts 259 descendants; 240 rAF frames per run, this box's refresh is 6.9 ms):
 *
 * - **as it ships — never invalidated**: rAF p50 6.9 / p95 7.0 / max 9.0 ms, **0 frames
 *   missed**, identical at 1x and 6x CPU throttle and identical to an empty rAF loop. The
 *   layer costs the frame nothing, which is barrier 1 doing its job.
 * - *forced* to fully repaint every frame by writing a transform on its own node — a worst
 *   case that never happens: p50 20.9 / p95 27.8 ms at 1x, p50 20.9 / p95 27.8 at 6x. (Not
 *   comparable row to row with `waiting-room.md` §7.4's 16.6/17.4, which was measured against
 *   a 16.7 ms vsync on a 269-node prototype.)
 *
 * The arch's `rect` -> three-sided `path` swap below was measured paired, both forms in one
 * page, swapped in the DOM and interleaved A/B/A/B/B/A under the forced repaint: p50 20.90 ms
 * in all six runs, 259 layer nodes either way. One element for one element, one drawn segment
 * fewer, no cost.
 *
 * The shipped layer server-renders to **260 SVG nodes / 347,422 B** of markup, against the prototype's
 * 269 / 330,806 B — the same order, with `room.svg`'s opaque panels (spec §11) and the
 * world-space vignette (`.stage::after` owns it, spec §8 row 17) cut, and 244 of those
 * bytes' worth of nodes being the 16 temple paths `Scene.tsx` already ships either way.
 *
 * ## The bitboard guarantee (spec §3)
 *
 * Every wall is compiled from `MAP_GRID`, never drawn: the same generated table the chain
 * raycasts and `predict.ts` collides against. Painted floor equals the wall bitboard, so
 * there is no painted pillar you can walk through and no painted floor you bump into —
 * this project's two signature misdiagnoses-as-lag.
 *
 * The one deliberate exception is R3's: the gate tower is authored upward into world
 * y 464..607, which is really *pit* floor. That is legal only because a seat is drawn only
 * in the room its own `zone` names, and a `ZONE_LOBBY` seat is clamped to
 * `y >= PIT_BOT + 1`, so nothing that can be drawn on this screen can stand there. If R3 is
 * ever broken, this tower paints over the pit and over the allies standing in it.
 *
 * ## Chain impact: none
 *
 * No instruction, no account, no compute unit, no subscription, no send. The ER numbers the
 * user asked twice to protect are untouched by construction.
 */
import type { ReactElement } from 'react';

import {
  GATE_MAX_X,
  GATE_MAX_Y,
  GATE_MIN_X,
  GATE_MIN_Y,
  LOBBY_BOT,
  LOBBY_TOP,
  MAP_GRID,
  MAP_TILE,
  MAP_TILES,
} from '@heartrot/client';

import templeSvg from '../../../assets/sprites/temple.svg?raw';

import { ARENA_UNITS, MAP_RIM_PATH, MAP_WALL_PATH } from './sprites';

// ---------------------------------------------------------------------------
// The room's bounds, all derived — no coordinate is typed twice
// ---------------------------------------------------------------------------

/**
 * The room, outside in, straight off the generated grid:
 *
 * - `y 576..607` outer wall course (tile rows 36–37), solid but for the gate tunnel;
 * - `y 608..639` inner wall course (rows 38–39) — this *is* `GATE_MIN_Y..GATE_MAX_Y`, so
 *   the gate block is a doorway punched through the room's top wall;
 * - `y 640..1007` the floor, `LOBBY_TOP..LOBBY_BOT`, 1,322 walkable tiles;
 * - `y 1008..1023` the bottom border, solid across its whole width. Reference A's bottom
 *   stairs are **cut** for exactly that reason (spec §2.1): drawing an opening there is a
 *   `gen_map.py` change to the bitboard the chain raycasts, not an art change. The
 *   temple's own stair stands in at the foot of the aisle instead.
 */
const ROOM_TOP = GATE_MIN_Y - 2 * MAP_TILE;

/**
 * How far past the map edge masonry is painted, so the map's 16-unit border reads as a wall
 * with thickness rather than as a line (reference A's wall is ~1/9 of the frame height; a
 * bare border is ~1/28). Off-map is solid by `isWallTile`'s own contract, so no player can
 * ever be here — spec R5.
 */
const OFF_MAP = 3 * MAP_TILE;

/** The clear central aisle: tile x 24..39, unobstructed in every floor row. Nothing goes in it. */
const AISLE_X0 = 24 * MAP_TILE;
const AISLE_X1 = 40 * MAP_TILE;

/** Gate block, as a rect. Same four numbers `on_gate` compares against. */
const GATE_W = GATE_MAX_X - GATE_MIN_X + 1;
const GATE_CX = GATE_MIN_X + GATE_W / 2;

// ---------------------------------------------------------------------------
// Palette — sampled off reference A, not chosen
// ---------------------------------------------------------------------------

/**
 * `docs/art/waiting-room.md` §1's sampled values, and the fact that decides all of them:
 * over the reference's interior the floor's mean **R−B = −8.3 and G−B = −16.8**. The stone
 * is a desaturated violet-mauve. *Every* warm value in that image belongs to a light
 * source. Grading the stone warm is the mistake this palette exists to prevent — and it is
 * why the shipped cold grade (G above R) reads wrong rather than merely cold.
 */
const PAL = {
  /** Outside the room. Reference sampled (10, 9, 22): violet-black, not neutral. */
  void: '#0a0710',
  /** The masonry the extended frame exposes beyond the map border. */
  offMap: '#1b1522',
  /** Wall body. Reference inner carved course, L 18.1 — and it must sit clearly BELOW the
   *  floor's own luminance, or the 3-unit rim and face read as outlines around holes rather
   *  than as light on mass. The first render of this layer got that wrong: at `#241c2e` the
   *  wall matched the washed floor and all 26 pillars read as empty outlined squares. */
  wall: '#120d1c',
  /** The lit stone face of a wall tile, inset inside its own mortar. Without it a wall is a
   *  flat block with a bright outline, and the 26 pillars read as outlined holes rather than
   *  as columns — the first render of this layer did exactly that. */
  cap: '#2a2338',
  /** Lit top face of a wall. Reference outer brick course, L 34.6. */
  rim: '#3d3350',
  /** Lit left/right edge — `MAP_RIM_PATH` only lights walls with floor *above*, so without
   *  this the side borders are flat strips. */
  face: '#2c2440',
  /** The shadow a wall casts onto the floor beside it. A flat marking, so it may sit on
   *  floor (R1); it is what gives the perimeter contact rather than a butt join. */
  foot: '#0b0710',

  torchPool: '#ffc477',
  ambient: '#ffb877',
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
} as const;

// ---------------------------------------------------------------------------
// The floor: the temple's own lower band, regraded
// ---------------------------------------------------------------------------

const TEMPLE_W = 210;
const TEMPLE_H = 238;

/**
 * The same 16 (fill, path-data) pairs `Scene.tsx` extracts, under the same transform. The
 * asset's lower band (source rows 134..238 -> world y 576..1024) is already stone slabs
 * carrying diamond-lattice medallions, with a broad stair at bottom centre whose bright
 * rails measure at world x 366..663 — centred on 514, within 3 units of the gate centre
 * 511.5. The aisle from the stair to the doorway is already dead centre. **Zero new path
 * bytes**: the module is in the graph either way.
 *
 * Extracted with a regex rather than injected with `dangerouslySetInnerHTML` so the asset's
 * own `shape-rendering="crispEdges"` root attribute is dropped and spec §1.4's
 * `geometricPrecision` actually governs these paths.
 */
const TEMPLE_PATHS: readonly (readonly [fill: string, d: string])[] = [
  ...templeSvg.matchAll(/<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"/g),
].map((m) => [m[1]!, m[2]!] as const);

if (TEMPLE_PATHS.length !== 16) {
  throw new Error(
    `temple.svg: expected 16 <path> elements, matched ${TEMPLE_PATHS.length}. ` +
      'Re-check the px2svg output shape before touching this regex.',
  );
}

/**
 * The warm grade — fitted, not chosen (spec §2.1).
 *
 * Least squares over the 16 temple entries, weighted by their pixel share of the **lobby
 * band only** (`#161620` 30.7 %, `#565854` 21.0 %, `#5c605c` 12.9 %, `#494a49` 8.4 %,
 * `#34363d` 7.3 %), against reference A's own 16-bin luminance ramp at gamma 1.15.
 * Weighted RMSE 3.94/255, against `Scene.tsx`'s 3.44 for the cold fit.
 *
 * Reproduced this session by evaluating the four CSS Filter Effects matrices in sRGB in the
 * order the shorthands compose — `brightness · saturate · hue-rotate · sepia`, which is
 * *not* the order they read left to right, and getting it backwards yields a warm tan with
 * blue lowest. The check: this chain applied to `Scene.tsx`'s own cold fit reproduces its
 * documented pit band `sRGB (41, 50, 65)` exactly. Applied here it gives the lobby band
 * **sRGB (36.8, 29.8, 41.6)** — R above G, blue highest, reference A's channel order and
 * the opposite of the shipped grade's `(31, 38, 48)`.
 */
const LOBBY_GRADE = 'sepia(0.81) hue-rotate(232deg) saturate(1.58) brightness(0.45)';

// ---------------------------------------------------------------------------
// The light budget — solved against the legibility cap, not chosen
// ---------------------------------------------------------------------------

/**
 * The constraint, from the darkest skin (Nocturne, area-weighted relative luminance 0.1136)
 * needing the fight scene's 1.85:1 against the floor it stands on:
 *
 *     (0.1136 + 0.05) / (Y_floor + 0.05) >= 1.85   =>   Y_floor <= 0.0384 everywhere
 *
 * ## The sweep spec §2.1 asked for, run
 *
 * Spec §2.1 declines to name the pool alpha because the sweep that would have fixed it failed
 * — a `sed` mangled the parameterised generator and it returned three identical readings. This
 * is that sweep, and it is on the shipped pixels: `scripts/spike/looksright`'s harness mounts
 * the real `App.tsx`, so `Arena.tsx`, this file and every grade in `styles.css` are product
 * code and only the chain is faked. 1920x1080, stage 1920 x 1032.6, **1.57405 px/unit**, the
 * `meet` fit and `.stage::after`'s vignette both in the frame; world -> screen is the CTM the
 * browser reported. Each row is one render of THIS file with the alpha written onto these very
 * nodes (`#waiting-pool`'s stops, `#waiting-ambient`'s, the wash rect's `fill-opacity`), so no
 * row is a redraw of the layer. Luminance and contrast are `docs/art/legibility.py`'s method,
 * unchanged, and the three skin luminances are that script's own parse of `knights.gen.ts`.
 *
 * Sampled where a knight's FEET are, not where the room is darkest — the floor unit under the
 * sprite, over two sets:
 *
 * - **the walk**: the chain's own spawn row (`map.rs` `LOBBY_SPAWN_Y` 832, x 208..664) and the
 *   aisle up to the gate — 56,763 floor units;
 * - **every legal stand**: every position `player.rs::zone_bounds` lets a `ZONE_LOBBY` seat
 *   hold (y >= `PIT_BOT` + 1), 323,063 units, props hidden (a knight stands *beside* a candle
 *   cluster, never on one) and the harness's own seat masked out.
 *
 * | shipped 0.40 / 0.035 / 0.045 | p50 | p95 | p99 | max |
 * |---|---|---|---|---|
 * | the walk | 0.0222 | 0.0289 | 0.0299 | 0.0415 |
 * | every legal stand | 0.0126 | 0.0259 | 0.0298 | 0.0340 |
 *
 * What the three skins actually read, measured rather than asserted:
 *
 * | skin | body Y | walk p50 | walk p95 | worst stand in the room |
 * |---|---|---|---|---|
 * | Cobalt | 0.1678 | 3.02:1 | 2.76:1 | **2.59:1** |
 * | Argent | 0.1303 | 2.50:1 | 2.29:1 | **2.15:1** |
 * | Nocturne | 0.1136 | 2.26:1 | 2.07:1 | **1.95:1** |
 *
 * Nocturne clears the 1.85 floor at every one of the 323,063 stands, and the swing from the
 * room's median to its brightest stand is 0.31 of a contrast step — legibility does not change
 * as you walk, which is the whole point of the cap. The walk is also not a cave: its p50 of
 * 0.0222 is within 4 % of reference A's own interior floor p50 (0.0231), while the room as a
 * whole sits at 0.0126. The aisle and the gate are the lit part and the perimeter is not, which
 * is the composition rather than a shortfall.
 *
 * **The pool alpha, from the sweep** — max floor Y over every legal stand, and what the darkest
 * skin reads there:
 *
 * | POOL_ALPHA | 0.045 | 0.060 | 0.070 | 0.090 | 0.130 | 0.180 | 0.220 |
 * |---|---|---|---|---|---|---|---|
 * | max Y | 0.0340 | 0.0366 | **0.0382** | 0.0425 | 0.0510 | 0.0630 | 0.0746 |
 * | Nocturne | 1.95:1 | 1.89:1 | **1.86:1** | 1.77:1 | 1.62:1 | 1.45:1 | 1.31:1 |
 *
 * So the ceiling is **0.07** and round 3's 0.40 is an order of magnitude past it. The shipped
 * 0.045 stays, and that is a result and not an omission: the ceiling buys +7 % of in-pool
 * luminance (in-pool p95 0.0253 -> 0.0272, invisible) for the entire margin, and reference A
 * says the pools are not the bright thing anyway — `waiting-room.md` §1 samples the pool at
 * L 38.7 against an interior median of L 41.1, i.e. marginally DARKER than the lit floor. The
 * shipped render reproduces that relation: in-pool p50 0.0131 against the room's 0.0126.
 * Flooding the room to use up the headroom would trade a measured pass for a measured fail.
 *
 * The boot check at the foot of this file is the guard, and it is conservative in the right
 * direction: its design bound (brightest palette entry x peak pool alpha, a co-occurrence the
 * render does not actually contain) throws at POOL_ALPHA 0.055 against a measured ceiling of
 * 0.07. It refuses values the room could survive; it never passes one it cannot.
 *
 * ## What the measurement found, and it was not a lamp
 *
 * At the shipped alphas exactly one thing on this screen broke the cap, and it was paint: the
 * arch outline was a closed `rect` whose bottom edge is `y = GATE_MIN_Y`, so half its 3-unit
 * stroke lay across the walkable gate block. Measured on the render, that line reads **Y 0.0429
 * and Nocturne drops to 1.76:1 standing on it** — on the one tile every player holds still on
 * while the gate reads them, which is the "legibility changes as you walk" failure this cap
 * exists to prevent, arriving through the draw list instead of through an alpha. Three-sided
 * outline instead (see the gate assembly). Threshold floor, all 32 rows of the gate block clear
 * of its jambs, before -> after: max Y 0.0429 -> **0.0271**, over-cap 3.12 % -> **0.00 %**,
 * Nocturne 1.76:1 -> **2.12:1**. The red glow's own contribution is fine and was never the
 * problem: it lands the threshold at p50 0.0228 / p95 0.0251.
 *
 * Residual, recorded rather than chased: 14 of the walk's 56,763 samples still read over cap
 * (max 0.0415, Nocturne 1.79:1), all of them in the 2-unit seam at x 480..482 / 542..543 where
 * the gate brazier's halo and the jamb's own lit face share a sampled pixel with the first
 * walkable unit. A seat centred there is half inside the wall, and one sampled pixel is 0.64
 * world units, so this is the measurement's own floor rather than a light to turn down.
 *
 * ## Why the stack is wash-led — the round that solved it, kept
 *
 * Legibility that changes as you walk past a torch is a defect this project has already paid
 * to fix once (`Scene.tsx`'s `PIT_POOL_ALPHA`, moved *down* against an art review that asked
 * for it up), and round 3's prototype pools measured Y 0.0617 — 1.6x over the cap, Nocturne
 * 1.46:1, worse than the fight scene.
 *
 * **The grade breaks the cap on its own, before a single lamp is lit.** Graded, the temple's
 * two brightest lobby-band entries land at Y 0.0457 (`#70736b`, 2.6 % of the band — the stair
 * rails, which sit bottom-centre in the aisle and are therefore ON the walk) and Y 0.0387
 * (`#686962`, 3.2 %). No pool alpha can fix that, which is why every row of a pool-only sweep
 * reads FAIL, and it is why the stack gains a wash exactly as `Scene.tsx`'s pit does.
 *
 * Round 1 solved wash/ambient/pool jointly at 0.55/0.03/0.09 and rendered a cave: interior
 * L p50 23.6 against reference A's own 39.6, and the wrong colour with it (mean R−B +0.1 where
 * the reference is −8.9). The lever turned out to be the wash and not the lamp — brighten the
 * base, cut the light — which is round 2's 0.40/0.035/0.045 over a bluer wash (`#0e0a1c`,
 * R−B −14), the values the sweep above holds and confirms.
 *
 * The room stays darker than reference A at the top of its ramp and always will: the
 * reference's own p95 floor is Y 0.0475, 24 % over the cap. Matching it would cost the darkest
 * skin the contrast this whole block exists to buy.
 */
const WASH_ALPHA = 0.40;
const AMBIENT_ALPHA = 0.035;
const POOL_ALPHA = 0.045;
const GATE_GLOW_ALPHA = 0.09;
/** The wash colour, and the void's colour one shade off black — reference A's own violet-black. */
const WASH = '#0e0a1c';

// ---------------------------------------------------------------------------
// Wall edge geometry, compiled from the same grid as the walls themselves
// ---------------------------------------------------------------------------

const FACE_W = 3;
const FOOT_H = 4;

/**
 * The two edge treatments spec §2.1 asks for. `sprites.ts` owns `MAP_WALL_PATH` and
 * `MAP_RIM_PATH` and both are reused verbatim above; its `tilePath` helper is private and
 * only lights walls with floor *above*, so the left/right borders get no highlight at all
 * today and the floor meets the wall with no contact shadow.
 *
 * Derived here from `MAP_GRID` — the same generated table, so there is still exactly one
 * source of truth for where a wall is. `MAP_FACE_PATH` sits on wall tiles; `MAP_FOOT_PATH`
 * is a flat marking on the floor tile *below* a wall, which R1 permits anywhere because
 * paint is not mass.
 *
 * ponytail: derived locally rather than exported from `sprites.ts`, because this agent does
 * not own that file. Upgrade path is one `tilePath` call each in `sprites.ts` and an import
 * — same geometry, one fewer loop.
 */
const [MAP_CAP_PATH, MAP_COURSE_PATH, MAP_FACE_PATH, MAP_FOOT_PATH] = ((): [string, string, string, string] => {
  const solid = (tx: number, ty: number): boolean => (MAP_GRID[ty]?.[tx] ?? '#') === '#';
  let cap = '';
  let course = '';
  let face = '';
  let foot = '';
  for (let ty = 0; ty < MAP_TILES; ty++) {
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (!solid(tx, ty)) continue;
      const x = tx * MAP_TILE;
      const y = ty * MAP_TILE;
      // The cap is ERODED, not inset per tile: a 2x2 pillar has to read as one block, and
      // insetting every tile dices it into four with a mortar cross through the middle.
      const cx0 = solid(tx - 1, ty) ? x : x + FACE_W;
      const cx1 = solid(tx + 1, ty) ? x + MAP_TILE : x + MAP_TILE - FACE_W;
      const cy0 = solid(tx, ty - 1) ? y : y + FACE_W;
      const cy1 = solid(tx, ty + 1) ? y + MAP_TILE : y + MAP_TILE - FACE_W;
      cap += `M${cx0} ${cy0}H${cx1}V${cy1}H${cx0}z`;
      // A one-tile mortar grid over the cap — thin and dark rather than a gap, so the
      // perimeter reads as brick and a 2x2 pillar as four bricks of one column instead of
      // as four separate blocks.
      course += `M${x} ${y}h${MAP_TILE}v1.5h-${MAP_TILE}zM${x} ${y}v${MAP_TILE}h1.5v-${MAP_TILE}z`;
      if (!solid(tx - 1, ty)) face += `M${x} ${y}h${FACE_W}v${MAP_TILE}h-${FACE_W}z`;
      if (!solid(tx + 1, ty)) face += `M${x + MAP_TILE - FACE_W} ${y}h${FACE_W}v${MAP_TILE}h-${FACE_W}z`;
      if (!solid(tx, ty + 1)) foot += `M${x} ${y + MAP_TILE}h${MAP_TILE}v${FOOT_H}h-${MAP_TILE}z`;
    }
  }
  return [cap, course, face, foot];
})();

// ---------------------------------------------------------------------------
// Authored props — primitives only, no generator, no new asset
// ---------------------------------------------------------------------------

/**
 * `assets/sprites/room.svg` is **cut** (spec §11) and this is what replaces it. Its props
 * cannot be extracted: colour keying fails because the palette is shared (`#a7939c` is both
 * wall brick and the chest's metal trim), and an edge flood-fill leaves alcove 0/360 px,
 * bone 2/192, crest 4/340, torch 18/170, chest 69/483, door 307/676 usable, because the
 * props are drawn in the same stone and bone greys as the wall behind them. Its only usable
 * form is opaque tile panels at 4,849 B brotli, against 623 B brotli for these generators.
 *
 * The placement rule is not negotiable (spec R1): anything with mass puts at least half its
 * footprint on `#` tiles, which in practice means against the border's inner face — where
 * reference A puts them anyway. Flat things (bones, candle bases, the wall's foot shadow)
 * may sit anywhere, because walking over a bone reads correctly.
 *
 * ponytail: props are not solid — a knight can clip the outer 16 units of a barrel. Upgrade
 * path is marking those tiles `#` in `assets/map/arena.json` and re-running `gen_map.py`,
 * which changes the table the chain raycasts, so it is a map change with `cargo test` behind
 * it and not an art edit.
 */

/** A wall torch: bracket, shaft, three flame lobes, and a soft halo on the masonry. */
function torch(key: string, x: number, y: number, s = 1): ReactElement {
  return (
    <g key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <circle r={26} fill={PAL.flameOuter} opacity={0.12} />
      <rect x={-2.5} y={-1} width={5} height={12} fill={PAL.wood} />
      <rect x={-5} y={9} width={10} height={3} fill={PAL.hoop} />
      <path d="M0 -20 C7 -12 6 -3 0 -1 C-6 -3 -7 -12 0 -20z" fill={PAL.flameOuter} />
      <path d="M0 -16 C4.5 -10 4 -3 0 -2 C-4 -3 -4.5 -10 0 -16z" fill={PAL.flameMid} />
      <path d="M0 -11 C2.2 -7 2 -3 0 -2.5 C-2 -3 -2.2 -7 0 -11z" fill={PAL.flameCore} />
    </g>
  );
}

/** The warm ellipse a torch throws on the floor. One gradient def serves every one of them. */
function pool(key: string, cx: number, cy: number, rx: number, ry: number): ReactElement {
  return <ellipse key={key} cx={cx} cy={cy} rx={rx} ry={ry} fill="url(#waiting-pool)" />;
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

/** The treasure chest, lid open, the only gold in the room. */
const CHEST: ReactElement = (
  <g transform="translate(232 646)">
    <ellipse cx={0} cy={2} rx={19} ry={6} fill={PAL.foot} opacity={0.55} />
    <rect x={-17} y={-16} width={34} height={18} rx={2} fill={PAL.wood} />
    <rect x={-17} y={-10} width={34} height={3} fill={PAL.gold} opacity={0.75} />
    <path d="M-17 -16 Q0 -32 17 -16z" fill={PAL.woodLit} />
    <rect x={-4} y={-13} width={8} height={7} rx={1} fill={PAL.gold} />
  </g>
);

/** A candle cluster — flat-footed, so it may stand on open floor. Reference A's lower left. */
const CANDLES: ReactElement = (
  <g transform="translate(250 884)">
    {[
      [-14, 0, 20],
      [-5, -4, 27],
      [4, 1, 17],
      [12, -3, 23],
      [20, 2, 14],
    ].map(([cx, dy, h], i) => (
      <g key={i} transform={`translate(${cx} ${dy})`}>
        <rect x={-2} y={-h!} width={4} height={h!} fill="#d9cdb4" opacity={0.8} />
        <path d={`M0 ${-h! - 7} C2 ${-h! - 3} 1.8 ${-h! - 0.5} 0 ${-h!} C-1.8 ${-h! - 0.5} -2 ${-h! - 3} 0 ${-h! - 7}z`} fill={PAL.flameMid} />
      </g>
    ))}
    <ellipse cx={2} cy={4} rx={26} ry={7} fill={PAL.flameOuter} opacity={0.1} />
  </g>
);

/** Scattered bones. Flat markings; walking over one reads correctly. */
const BONES: ReactElement = (
  <g fill={PAL.bone} opacity={0.5} transform="translate(322 894) scale(0.7)">
    <path d="M0 0h18v4H0zM-3 -2a3 3 0 106 0a3 3 0 10-6 0M18 -2a3 3 0 106 0a3 3 0 10-6 0" />
    <path d="M26 14h14v3H26zM23 12a2.5 2.5 0 105 0a2.5 2.5 0 10-5 0" />
    <path d="M-16 16h12v3h-12zM-20 15a2.5 2.5 0 105 0a2.5 2.5 0 10-5 0" />
    <ellipse cx={44} cy={-2} rx={7} ry={6} />
    <rect x={40} y={2} width={8} height={5} rx={1} />
  </g>
);

/** A horned-skull motif — the crest above the gate and the device on both banners. */
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

/** A purple hanging on the top wall. Straddles the inner course, so mass sits on `#`. */
function banner(key: string, cx: number): ReactElement {
  const top = GATE_MIN_Y - 12;
  return (
    <g key={key}>
      <path
        d={`M${cx - 21} ${top}h42v50l-21 12l-21 -12z`}
        fill={PAL.banner}
        stroke={PAL.bannerEdge}
        strokeWidth={2}
      />
      <rect x={cx - 24} y={top - 4} width={48} height={5} rx={2} fill={PAL.ironLit} />
      {skull(`${key}-s`, cx, top + 24, 0.55, '#7d5fa8', 0.9)}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Fixture placement — every one on a `#` tile, every one clear of the aisle
// ---------------------------------------------------------------------------

/** Mid-line of the inner wall course, and of each border, in world units. */
const TOP_WALL_MID = GATE_MIN_Y + MAP_TILE;
const LEFT_WALL_MID = MAP_TILE / 2;
const RIGHT_WALL_MID = ARENA_UNITS - MAP_TILE / 2;
const BOT_WALL_MID = ARENA_UNITS - MAP_TILE / 2;

/**
 * Twelve wall torches plus the two gate braziers. `[x, y, poolCx, poolCy, rx, ry]`.
 *
 * The four on the top wall are clear of x 416..607 so they never crowd the gate assembly,
 * and every pool is clear of the aisle's own centre line — the aisle is the composition
 * (spec §2.1: the stair sits in it, the gate closes it).
 */
const TORCHES: readonly (readonly [number, number, number, number, number, number])[] = [
  [196, TOP_WALL_MID, 196, LOBBY_TOP + 54, 92, 62],
  [324, TOP_WALL_MID, 324, LOBBY_TOP + 54, 92, 62],
  [700, TOP_WALL_MID, 700, LOBBY_TOP + 54, 92, 62],
  [828, TOP_WALL_MID, 828, LOBBY_TOP + 54, 92, 62],
  [LEFT_WALL_MID, 712, MAP_TILE + 46, 712, 62, 92],
  [LEFT_WALL_MID, 888, MAP_TILE + 46, 888, 62, 92],
  [RIGHT_WALL_MID, 712, ARENA_UNITS - MAP_TILE - 46, 712, 62, 92],
  [RIGHT_WALL_MID, 888, ARENA_UNITS - MAP_TILE - 46, 888, 62, 92],
  [320, BOT_WALL_MID, 320, LOBBY_BOT - 46, 92, 62],
  [704, BOT_WALL_MID, 704, LOBBY_BOT - 46, 92, 62],
];

/** Barrels and stacks, each against a border's inner face. `[x, y, scale]`. */
const BARRELS: readonly (readonly [number, number, number])[] = [
  [140, 652, 1],
  [176, 646, 0.82],
  [968, 656, 1],
  [1000, 644, 0.86],
  [972, 700, 0.78],
  [980, 902, 1],
  [1004, 876, 0.85],
  [140, 966, 0.9],
];

// ---------------------------------------------------------------------------
// The gate assembly — reference A's one bright thing
// ---------------------------------------------------------------------------

/**
 * Bottom to top: the lit threshold you stand on, the portcullis beyond it, the arch, the
 * red BOSS FIGHT sign, the ram-skull crest, and a brazier on each side.
 *
 * **The portcullis sits at y 576..607, not on the gate block.** The gate block
 * (`GATE_MIN_Y..GATE_MAX_Y` = 608..639) is walkable and inside this room's own zone, so R2
 * forbids painting a barrier over it — the doorway you walk into has to read as floor. The
 * tunnel continues one course further up through rows 36–37, which a `ZONE_LOBBY` seat can
 * never reach (`y >= PIT_BOT + 1`), and that is where the bars go. Everything above
 * y 576 is the R3 tower.
 */
const GATE: ReactElement = (
  <g>
    {/* Tower masonry, painted upward over pit floor — legal only under R3. Stepped rather
        than a plain slab: a rectangle of wall colour standing in the void reads as a
        floating panel, which is what the first render of this layer produced. */}
    <path
      d={`M${GATE_CX - 88} ${ROOM_TOP}v-52h16v-20h16v-32h112v32h16v20h16v52z`}
      fill={PAL.cap}
      stroke={PAL.wall}
      strokeWidth={FACE_W * 2}
      paintOrder="stroke"
    />
    <path
      d={`M${GATE_CX - 56} 464h112v${FACE_W}h-112z M${GATE_CX - 88} ${ROOM_TOP - 52}h16v${FACE_W}h-16z M${GATE_CX + 72} ${ROOM_TOP - 52}h16v${FACE_W}h-16z M${GATE_CX - 72} ${ROOM_TOP - 72}h16v${FACE_W}h-16z M${GATE_CX + 56} ${ROOM_TOP - 72}h16v${FACE_W}h-16z`}
      fill={PAL.rim}
    />

    {/* The arch: the tunnel mouth, cut into the two wall courses.

        The outline is THREE-SIDED — jambs and lintel, and never the threshold. A closed
        `rect` strokes its bottom edge centred on `y = GATE_MIN_Y`, which lays half a stroke
        width of `PAL.rim` across the walkable gate block. Measured off the shipped render
        (§ the light budget): that line reads **Y 0.0429**, over the 0.0384 cap, and the
        darkest skin standing on it drops to **1.53:1** — on the one tile every player holds
        still on while the gate reads them. It was also a lie about the room: an arch has no
        line across its floor. The jambs sit at x 470 / 554, both wall tiles, so what is left
        of the stroke cannot touch walkable floor at all. */}
    <rect x={GATE_MIN_X - 10} y={ROOM_TOP} width={GATE_W + 20} height={2 * MAP_TILE} fill="#0a0810" />
    <path
      d={`M${GATE_MIN_X - 10} ${GATE_MIN_Y}V${ROOM_TOP}h${GATE_W + 20}V${GATE_MIN_Y}`}
      fill="none"
      stroke={PAL.rim}
      strokeWidth={3}
    />

    {/* portcullis — beyond the threshold, out of the lobby zone */}
    <g id="gate-portcullis" fill={PAL.ironLit}>
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <rect key={i} x={GATE_MIN_X + 4 + i * 9} y={ROOM_TOP} width={3} height={2 * MAP_TILE} />
      ))}
      <rect x={GATE_MIN_X} y={ROOM_TOP + 7} width={GATE_W} height={3} />
      <rect x={GATE_MIN_X} y={ROOM_TOP + 21} width={GATE_W} height={3} />
      <rect x={GATE_MIN_X} y={ROOM_TOP} width={GATE_W} height={4} fill={PAL.iron} />
    </g>

    {/* BOSS FIGHT — the most saturated red in the frame and the only text */}
    <g id="gate-sign">
      <rect x={GATE_CX - 62} y={524} width={124} height={30} rx={3} fill={PAL.signPanel} stroke={PAL.ironLit} strokeWidth={2} />
      <text
        x={GATE_CX}
        y={545}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize={17}
        fontWeight={700}
        letterSpacing={1.5}
        fill={PAL.sign}
      >
        BOSS FIGHT
      </text>
    </g>

    {/* ram-skull crest over the sign */}
    {skull('gate-crest', GATE_CX, 494, 1.05, '#b9a58f', 0.92)}

    {/* braziers flanking the mouth, both on `#` tiles of the outer course */}
    {torch('gate-l', GATE_MIN_X - 28, ROOM_TOP + 22, 1.25)}
    {torch('gate-r', GATE_MAX_X + 29, ROOM_TOP + 22, 1.25)}
  </g>
);

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/**
 * Mount as `{WAITING}`, in room B's place, as the first child of `#camera`.
 * Do not wrap it, do not give it a changing key, do not pass it anything.
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
      {/* One pool gradient for every torch: `objectBoundingBox` units, so it scales to each
          ellipse's own box and ten lights cost one def. */}
      <radialGradient id="waiting-pool">
        <stop offset="0" stopColor={PAL.torchPool} stopOpacity={POOL_ALPHA} />
        <stop offset="0.55" stopColor={PAL.flameOuter} stopOpacity={POOL_ALPHA * 0.45} />
        <stop offset="1" stopColor={PAL.flameOuter} stopOpacity={0} />
      </radialGradient>

      {/* The room's own bounce, not a lamp. Centred on the floor, well clear of the cap. */}
      <radialGradient
        id="waiting-ambient"
        gradientUnits="userSpaceOnUse"
        r={1}
        cx={0}
        cy={0}
        gradientTransform={`translate(${ARENA_UNITS / 2} ${(LOBBY_TOP + LOBBY_BOT) / 2}) scale(600 300)`}
      >
        <stop offset="0" stopColor={PAL.ambient} stopOpacity={AMBIENT_ALPHA} />
        <stop offset="1" stopColor={PAL.ambient} stopOpacity={0} />
      </radialGradient>

      {/* The gate glow. The only red in the room, and the reason the eye goes there. */}
      <radialGradient
        id="waiting-gate-glow"
        gradientUnits="userSpaceOnUse"
        cx={GATE_CX}
        cy={ROOM_TOP + MAP_TILE}
        r={190}
      >
        <stop offset="0" stopColor="#ff2b3c" stopOpacity={GATE_GLOW_ALPHA} />
        <stop offset="1" stopColor="#ff2b3c" stopOpacity={0} />
      </radialGradient>

      {/* Everything the room is made of is clipped to the room band, so the temple's cavern
          half and the map's pit walls never leak into the waiting area's frame. The gate
          tower is drawn OUTSIDE this clip, which is the R3 exception and the only one. */}
      <clipPath id="waiting-room-clip">
        <rect
          x={-OFF_MAP}
          y={ROOM_TOP}
          width={ARENA_UNITS + 2 * OFF_MAP}
          height={ARENA_UNITS + OFF_MAP - ROOM_TOP}
        />
      </clipPath>
    </defs>

    {/* 1. The void, so the frame can never show raw page behind the room. Reference A's
           outside sampled (10, 9, 22): violet-black, not neutral.

           `vp-void` is load-bearing: `useViewport` resizes every node carrying it to the
           live viewBox inflated by `VIEW_BLEED` (spec section 8 row 1). The attributes below
           are just the pre-layout frame. A generous hardcoded box happens to be wide enough
           today, but "wide enough" is a property of the aspects someone tried, and the class
           makes it a property of the fit rule instead. */}
    <rect
      className="vp-void"
      x={-ARENA_UNITS}
      y={-ARENA_UNITS}
      width={3 * ARENA_UNITS}
      height={3 * ARENA_UNITS}
      fill={PAL.void}
    />

    <g clipPath="url(#waiting-room-clip)">
      {/* 2. Masonry beyond the map border, so the 16-unit edge reads as a thick wall. */}
      <g fill={PAL.offMap}>
        <rect x={-OFF_MAP} y={ROOM_TOP} width={OFF_MAP} height={ARENA_UNITS + OFF_MAP - ROOM_TOP} />
        <rect x={ARENA_UNITS} y={ROOM_TOP} width={OFF_MAP} height={ARENA_UNITS + OFF_MAP - ROOM_TOP} />
        <rect x={-OFF_MAP} y={ARENA_UNITS} width={ARENA_UNITS + 2 * OFF_MAP} height={OFF_MAP} />
      </g>

      {/* 3. The floor: the temple's lower band, regraded warm-violet. The 210x238 source is
             stretched to the 1024 square exactly as `Scene.tsx` stretches it — same
             transform, same asset, different filter. */}
      <g
        transform={`scale(${ARENA_UNITS / TEMPLE_W} ${ARENA_UNITS / TEMPLE_H})`}
        style={{ filter: LOBBY_GRADE }}
      >
        {TEMPLE_PATHS.map(([fill, d], i) => (
          <path key={i} fill={fill} d={d} />
        ))}
      </g>

      {/* 4. The wash. Without it the graded stair rails alone sit at Y 0.0457, over the
             0.0384 legibility cap with no lamp lit — see the WASH_ALPHA block. */}
      <rect x={-OFF_MAP} y={ROOM_TOP} width={ARENA_UNITS + 2 * OFF_MAP} height={ARENA_UNITS + OFF_MAP - ROOM_TOP} fill={WASH} fillOpacity={WASH_ALPHA} />

      {/* 5. Floor light, under the wall mass (spec §8 row 4). The masonry gets its own
             warm halo from each torch's own node instead, so a pool cannot be eaten by the
             wall the way round 1's were. */}
      <rect x={0} y={LOBBY_TOP} width={ARENA_UNITS} height={LOBBY_BOT - LOBBY_TOP} fill="url(#waiting-ambient)" />
      {TORCHES.map(([, , px, py, rx, ry], i) => pool(`p${i}`, px, py, rx, ry))}

      {/* 6. Wall mass, compiled from `MAP_GRID`. The 26 interior pillar blocks are `#`
             tiles and are covered by this same path, so they get the perimeter's own brick
             rather than being left unfilled — a wall tile drawn as floor is exactly the lie
             §3 forbids, and `PAL.wall`'s cool grey on a warm floor was the reason the art
             doc reached for omission instead. */}
      <path d={MAP_FOOT_PATH} fill={PAL.foot} opacity={0.7} />
      <path d={MAP_WALL_PATH} fill={PAL.wall} />
      <path d={MAP_CAP_PATH} fill={PAL.cap} />
      <path d={MAP_COURSE_PATH} fill={PAL.wall} opacity={0.45} />
      <path d={MAP_RIM_PATH} fill={PAL.rim} />
      <path d={MAP_FACE_PATH} fill={PAL.face} />

      {/* 7. Props, one layer: wall-mounted and floor-standing together, so decoration can
             never occlude an actor (spec §8 row 6). Contact shadow is their only depth cue. */}
      {banner('b-l', AISLE_X0 - 44)}
      {banner('b-r', AISLE_X1 + 44)}
      {BARRELS.map(([x, y, s], i) => barrel(`br${i}`, x, y, s))}
      {CHEST}
      {CANDLES}
      {BONES}
      {TORCHES.map(([x, y], i) => torch(`t${i}`, x, y))}
    </g>

    {/* 8. The gate, unclipped: its tower is authored above the room band, over what is
           really pit floor. R3 is the whole of its licence. */}
    <rect x={GATE_CX - 190} y={ROOM_TOP - 174} width={380} height={364} fill="url(#waiting-gate-glow)" />
    {GATE}
  </g>
);

// ---------------------------------------------------------------------------
// Boot check
// ---------------------------------------------------------------------------

/**
 * The legibility cap, re-derived from the three alphas above at import.
 *
 * The failure mode this exists for is silent and has already been shipped once: brighten
 * the floor and the darkest knight walks into it, with no error anywhere and a symptom
 * ("I can't see my guy near the torches") that reads as a rendering bug rather than as a
 * constant. `GRADED_BRIGHTEST` is the graded sRGB of `#70736b`, the brightest temple entry
 * with a meaningful share of the lobby band, under `LOBBY_GRADE` — recompute it if that
 * string ever changes.
 */
{
  const GRADED_BRIGHTEST = [70, 55, 78] as const;
  const NOCTURNE_Y = 0.1136; // darkest skin, area-weighted, from `Scene.tsx`
  const CAP = 0.0384; // (NOCTURNE_Y + 0.05) / 1.85 - 0.05

  const hex = (h: string): readonly number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const over = (src: readonly number[], a: number, dst: readonly number[]): number[] =>
    dst.map((d, i) => a * src[i]! + (1 - a) * d);
  const chan = (v: number): number => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const lum = (c: readonly number[]): number =>
    0.2126 * chan(c[0]!) + 0.7152 * chan(c[1]!) + 0.0722 * chan(c[2]!);

  const washed = over(hex(WASH), WASH_ALPHA, GRADED_BRIGHTEST);
  const lit = over(hex(PAL.torchPool), POOL_ALPHA, over(hex(PAL.ambient), AMBIENT_ALPHA, washed));
  if (lum(lit) > CAP) {
    throw new Error(
      `WaitingRoom: brightest lit floor is Y ${lum(lit).toFixed(4)} > ${CAP} — the darkest ` +
        `skin drops to ${((NOCTURNE_Y + 0.05) / (lum(lit) + 0.05)).toFixed(2)}:1. ` +
        'Lower POOL_ALPHA/AMBIENT_ALPHA or raise WASH_ALPHA.',
    );
  }
  // The gate threshold is walkable floor inside this room's zone, so the red glow is on the
  // same budget as the torches.
  const thresh = over(hex('#ff2b3c'), GATE_GLOW_ALPHA, over(hex(PAL.ambient), AMBIENT_ALPHA, washed));
  if (lum(thresh) > CAP) {
    throw new Error(`WaitingRoom: gate threshold is Y ${lum(thresh).toFixed(4)} > ${CAP}. Lower GATE_GLOW_ALPHA.`);
  }
  // R2, cheaply: the gate block is walkable and in-zone, so nothing opaque may be painted
  // over it. The portcullis lives one wall course further up, out of the lobby's reach.
  if (ROOM_TOP + 2 * MAP_TILE > GATE_MIN_Y) {
    throw new Error('WaitingRoom: the portcullis overlaps the walkable gate block (spec R2)');
  }
  // The arch rect and the tunnel are both drawn `2 * MAP_TILE` deep off this assumption.
  if (GATE_MAX_Y - GATE_MIN_Y + 1 !== 2 * MAP_TILE) {
    throw new Error('WaitingRoom: the gate band is no longer two tiles deep — re-derive the arch');
  }
  if (MAP_CAP_PATH.length === 0 || MAP_COURSE_PATH.length === 0 || MAP_FACE_PATH.length === 0 || MAP_FOOT_PATH.length === 0) {
    throw new Error('WaitingRoom: wall edge geometry compiled empty — check MAP_GRID');
  }
  if (AISLE_X0 >= AISLE_X1 || GATE_MIN_X < AISLE_X0 || GATE_MAX_X >= AISLE_X1) {
    throw new Error('WaitingRoom: the gate is no longer inside the central aisle — recheck the map');
  }
}

/**
 * `docs/art/waiting-room.md` §8 names this layer `WAITING`; `Arena.tsx` has imported it
 * under both that name and `WAITING_ROOM` while the two files were written in parallel.
 * One alias, one element — the same reference either way, so there is no second fact here
 * to drift. Pick one at the merge and delete the other line.
 */
export { WAITING as WAITING_ROOM };
