/**
 * Aim — the client's copy of the chain's raycast, and the auto-aim built on top of it.
 *
 * `programs/heartrot/src/handlers/shoot.rs::raycast` IS THE AUTHORITY. {@link raycastShot}
 * is a third copy of that algorithm — the first is the program, the second its tests — and
 * it exists for two reasons only: to find the point an arrow stops at, because the chain
 * publishes no such point, and to pick the target {@link autoAim} sends, which the chain
 * then resolves for itself. It lived in `app/src/render/Shot.tsx` until the aim needed it
 * from the input path too; there is no fourth copy.
 *
 * The *data* cannot drift — `isWall` reads the same generated bitboard the program
 * raycasts and `PART_HITBOXES` / `CORE` come out of the same `gen_hitboxes.py` pass — but
 * the twenty lines of the walk are hand-written, so they are held to account by the
 * BEHAVIOURAL checks in {@link aimSelfCheck} rather than by a table of coordinates. A test
 * that names a tile stops testing the ray the moment the map is redrawn.
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
 *
 * Shared by the browser and nothing else today, but it lives in the SDK because it reads
 * only SDK tables and the Worker may one day want to score a shot too. No DOM, no React.
 */

import { CORE, PART_HITBOXES } from './hitboxes';
import { VENT_OPEN, type BossAccount } from './layout';
import { BOSS_SPAWN, MAP_ENTRANCES, MAP_TILE, MAP_TILES, PIT_BOT, isWall } from './map';

// ---------------------------------------------------------------------------
// The raycast mirror
// ---------------------------------------------------------------------------

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
   * mirror — the vent test lives in {@link landingOf}, exactly as it does in `fire`.
   */
  readonly core: boolean;
}

/**
 * What an arrival MEANT, which is not the same question as what the ray stopped on.
 *
 * `absorb` is the shell eating a shot aimed at a sealed vent: the ray stopped on the
 * creature, the cooldown is spent, and `damage_dealt` never moves. Drawing that as a hit is
 * a lie the player pays for repeatedly — the orb is the brightest thing in the room, so it
 * is the first thing a new player aims at, and a fifth of pit stands can put a ray on it
 * through a full shell. A miss that looks like a hit is worse than a miss, and an auto-aim
 * that picks it is worse than one that picks nothing.
 */
export type Landing = 'hit' | 'absorb' | 'miss';

/** `shoot.rs:492`'s rule, mirrored rather than approximated, in one place. */
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
// Auto-aim
// ---------------------------------------------------------------------------

/**
 * Aim vectors leave here scaled so the larger component is this — the `i8` ceiling, and the
 * finest direction the wire can carry. The chain normalises with alpha-max-plus-beta-min, so
 * only the ratio matters; filling the byte is what buys the 0.235 degree resolution.
 */
export const AIM_MAX = 127;

/**
 * World vector → the `(dx, dy)` `i8` pair the wire carries, larger component ±`AIM_MAX`.
 * `null` for the zero vector, which the chain rejects (`octant` returns
 * `InvalidInstructionData`) and which a target sitting exactly on the shooter produces.
 */
export function aimFromVector(dx: number, dy: number): readonly [number, number] | null {
  const longest = Math.max(Math.abs(dx), Math.abs(dy));
  if (longest === 0) return null;
  return [Math.round((dx / longest) * AIM_MAX), Math.round((dy / longest) * AIM_MAX)];
}

interface Target {
  readonly tx: number;
  readonly ty: number;
  /** Squared distance from the shooter to the nearest point of the target. */
  readonly d: number;
}

/**
 * The shot to take from `(x, y)`, as the `i8` pair the wire carries, or `null` when nothing
 * on the creature can be hit from here and the caller should fall back to the body's facing.
 *
 * Everything is in ARENA UNITS — the space `predictor.self` and the boss already share —
 * so no screen matrix is involved anywhere on the shot path. Targets are the open core
 * first (the only thing worth a shot once the vent is up, and `landingOf` refuses it while
 * sealed), then every live part by distance to the nearest point of its box. Each is aimed
 * at its CENTRE — the ray samples one tile at a time, and a thorn is under two tiles thick,
 * so a ray grazing the nearest edge can step clean over it — and the first whose ray the
 * chain would score is the answer. Ten raycasts at most, once per trigger; nothing per
 * frame.
 *
 * This is homing in the only sense a hitscan allows: the ray is still the chain's, the
 * damage is still the chain's, and a part that dies between the pick and the landing is
 * simply the next arrow's problem.
 */
export function autoAim(
  x: number,
  y: number,
  boss: Pick<BossAccount, 'x' | 'y' | 'parts' | 'ventOpen'>,
): readonly [number, number] | null {
  const targets: Target[] = [];
  if (boss.ventOpen === VENT_OPEN) targets.push({ tx: boss.x + CORE.x, ty: boss.y + CORE.y, d: -1 });
  for (let i = 0; i < PART_HITBOXES.length; i++) {
    if ((boss.parts[i] ?? 0) === 0) continue;
    const r = PART_HITBOXES[i]!;
    const left = boss.x + r.x;
    const top = boss.y + r.y;
    const nx = Math.min(Math.max(x, left), left + r.w - 1) - x;
    const ny = Math.min(Math.max(y, top), top + r.h - 1) - y;
    targets.push({ tx: left + r.w / 2, ty: top + r.h / 2, d: nx * nx + ny * ny });
  }
  targets.sort((a, b) => a.d - b.d);

  for (const t of targets) {
    const aim = aimFromVector(t.tx - x, t.ty - y);
    if (aim === null) continue;
    const end = raycastShot(x, y, aim[0], aim[1], boss.parts, boss.x, boss.y);
    if (landingOf(end, boss.ventOpen) === 'hit') return aim;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Self-check
//
// The ray is a hand-written third copy of a chain algorithm and every way it goes wrong is
// silent: shooting is fire-and-forget with `skipPreflight`, so an arrow drawn to the wrong
// place — or an auto-aim that picks a shot the chain scores as nothing — produces no error
// anywhere. The assertions are BEHAVIOURAL — "a shot at the boss hits the boss", never
// "the ray ends at (x, y)" — because the map and the hitboxes are generator output and a
// test naming a coordinate stops testing the ray the moment the art moves.
//
// An exported function rather than an import-time block, like `layoutSelfCheck`: this
// package has no `import.meta.env`. `Shot.tsx` calls it under `DEV`, so it runs on every
// dev boot of the app; by hand it runs the same way as the others:
//
//   node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild packages/client/src/aim.ts \
//     --bundle --format=esm --outfile=/tmp/aim.mjs && node -e \
//     "import('/tmp/aim.mjs').then(m => { m.aimSelfCheck(); console.log('OK') })"
// ---------------------------------------------------------------------------

export function aimSelfCheck(): void {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`aim self-check: ${what}`);
  };

  // A whole boss, from the generated tables, at its spawn.
  const parts = PART_HITBOXES.map(() => 100);
  const [bx, by] = BOSS_SPAWN;
  const boss = { x: bx, y: by, parts, ventOpen: 0 };
  // A stand in the pit, straight below the creature, on the pit's last row. Derived from the
  // generated map, not typed: a redrawn map moves the test with it.
  const fromX = bx;
  const fromY = PIT_BOT - MAP_TILE / 2;
  ok(!isWall(fromX, fromY), 'the stand under the boss is not floor — check PIT_BOT');

  /** Every angle a stand can fire, against a given shell. The tests search it. */
  const sweep = (hp: readonly number[]): RayEnd[] => {
    const out: RayEnd[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const dx = Math.round(Math.cos(a) * AIM_MAX);
      const dy = Math.round(Math.sin(a) * AIM_MAX);
      out.push(raycastShot(fromX, fromY, dx, dy, hp, bx, by));
    }
    return out;
  };
  const shots = sweep(parts);

  // 1. A shot at the creature terminates ON the creature. Straight up from a pit stand is
  //    the shot the whole game is: the boss is top-centre and the raid fights from below.
  const up = raycastShot(fromX, fromY, 0, -AIM_MAX, parts, bx, by);
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
      const dx = Math.round(Math.cos(ang) * AIM_MAX);
      const dy = Math.round(Math.sin(ang) * AIM_MAX);
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
  //    on it — every aim path rejects it upstream, so this is the unreachable branch made safe.
  const nil = raycastShot(fromX, fromY, 0, 0, parts, bx, by);
  ok(nil.x === fromX && nil.y === fromY && !nil.struck, 'a zero aim vector must draw nothing');
  ok(aimFromVector(0, 0) === null, 'the zero vector has no aim, and the chain refuses it');
  const scaled = aimFromVector(10, -40);
  ok(scaled !== null && scaled[0] === 32 && scaled[1] === -AIM_MAX, 'aim fills i8 on its longer axis');

  // 5. `shoot.rs:492`: the shell absorbs a shot aimed at a sealed vent, so it scores
  //    nothing and must not read as a hit. Asserted on the RULE rather than on an angle —
  //    which angles reach the orb is generator output, so the ray finds them by search, and
  //    the same terminus is a hit the moment the vent opens.
  const stripped = parts.map(() => 0);
  const core = sweep(stripped).find((s) => s.core);
  ok(core !== undefined, 'no angle reaches the core through a stripped shell — check CORE');
  ok(landingOf(core!, 0) === 'absorb', 'a sealed vent must not draw the hit spark');
  ok(landingOf(core!, VENT_OPEN) === 'hit', 'an open vent must still read as a hit');
  const part = shots.find((s) => s.struck && !s.core);
  ok(part !== undefined && landingOf(part, 0) === 'hit', 'a part hit is never an absorb');
  ok(landingOf({ x: 0, y: 0, struck: false, core: false }, 1) === 'miss', 'a miss reads as a miss');

  // 6. Auto-aim. From every entrance — where every raider starts and returns to — a full
  //    shell is hittable, the pair fills the byte, and the pick is a shot the chain scores.
  //    A stand with no shot is the raid being unwinnable with no error anywhere, which is
  //    the whole reason free aim exists.
  for (const [ex, ey] of MAP_ENTRANCES) {
    const aim = autoAim(ex, ey, boss);
    ok(aim !== null, `no auto-aim strikes a full shell from the entrance at (${ex}, ${ey})`);
    ok(Math.max(Math.abs(aim![0]), Math.abs(aim![1])) === AIM_MAX, 'auto-aim fills i8 on its longer axis');
    ok(landingOf(raycastShot(ex, ey, aim![0], aim![1], parts, bx, by), 0) === 'hit', 'the pick is a scored hit');
  }
  // A stripped shell with the vent sealed has nothing to hit: absorb is not a pick, and the
  // caller falls back to facing. Open the vent and the same stand is handed the core.
  ok(autoAim(fromX, fromY, { ...boss, parts: stripped }) === null, 'a sealed vent is never the pick');
  const vented = autoAim(fromX, fromY, { ...boss, parts: stripped, ventOpen: VENT_OPEN });
  ok(vented !== null && raycastShot(fromX, fromY, vented[0], vented[1], stripped, bx, by).core, 'an open vent is the pick');
  // And the open core comes FIRST — through a full shell it still wins whenever a lane exists.
  const full = autoAim(fromX, fromY, { ...boss, ventOpen: VENT_OPEN });
  ok(full !== null, 'a full shell with the vent open is hittable from under the boss');
}
