#!/usr/bin/env python3
"""Compile assets/map/arena.json into the arena wall bitboard the chain raycasts
against and the copy the browser predicts against.

    python3 tools/gen_map.py

The ASCII grid in `assets/map/arena.json` is the map. This tool is the only thing
allowed to write `programs/heartrot/src/map.rs` and `packages/client/src/map.ts`;
both carry a "generated" banner and hand-editing either one recreates the exact
defect class this project keeps paying for -- one fact stored twice, drifting.

Why a generated `const` and not an account: the map is static per deployment. An
account would cost rent, would have to be committed and undelegated with the rest
of the arena, and would burn one of the ~38 account keys an ER transaction gets --
a budget with no address lookup tables to relieve it. A `[u64; 64]` in the .so
costs 512 bytes of program image and zero keys. If maps ever need to vary at
runtime, the upgrade path is to keep this table as arena 0's default and add a
`map_id: u8` on `Arena` selecting between several generated tables -- still no
account, still no key.

Everything below fails loudly. There is no "warn and continue": a map that is
wrong in any of these ways produces a game where players walk into invisible
walls or a lobby nobody can leave, and both are cheaper to catch here.
"""

from __future__ import annotations

import json
import re
import sys
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAP_JSON = ROOT / "assets" / "map" / "arena.json"
PLAYER_RS = ROOT / "programs" / "heartrot" / "src" / "handlers" / "player.rs"
TICK_RS = ROOT / "programs" / "heartrot" / "src" / "handlers" / "tick.rs"
STATE_RS = ROOT / "programs" / "heartrot" / "src" / "state.rs"
OUT_RS = ROOT / "programs" / "heartrot" / "src" / "map.rs"
OUT_TS = ROOT / "packages" / "client" / "src" / "map.ts"

WALL = "#"
FLOOR = "."
ENTRANCE = "E"
HEART = "B"
FLOOR_CHARS = {FLOOR, ENTRANCE, HEART}


class MapError(Exception):
    """A map defect. Always fatal -- see the module docstring."""


def die(msg: str) -> None:
    raise MapError(msg)


# ---------------------------------------------------------------------------
# Rust constants
# ---------------------------------------------------------------------------
#
# The spawn and gate constants are read out of the Rust rather than restated here,
# so a spawn point that moves on the chain side moves this validation with it. The
# two spawn *formulas* below are still a transcription of `player::lobby_spawn` and
# `tick::entrance_for` -- a rewrite of either function's shape (not its constants)
# is the one drift this tool cannot see.
#
# `TILE`, `MAP_TILES` and `ARENA_SIZE` are deliberately NOT read from the Rust and
# are not cross-checked against it either: the Rust no longer owns them. This tool
# emits `TILE`/`MAP_TILES` into `map.rs`, `player.rs` re-exports them, and `tick.rs`
# is `const TILE: i32 = map::TILE as i32` with `ARENA_SIZE` derived from it -- so
# every "check" against the Rust would be this tool reading back its own last
# output and agreeing with itself. They come from `arena.json`, the source, and
# `ARENA_SIZE` is computed here the way `tick.rs` computes it: tiles * TILE.


def rust_const(src: Path, name: str, env: dict[str, object]) -> object:
    text = src.read_text()
    m = re.search(rf"^\s*(?:pub\s+)?const\s+{name}\s*:[^=]+=\s*(.+?);", text, re.M)
    if m is None:
        die(f"{src.relative_to(ROOT)} no longer defines `const {name}` -- "
            "this tool validates against it and will not guess a value")
    # Rust `/` on integer types truncates; Python's `/` produces a float, and a
    # float tile index is a crash three frames later instead of a wrong answer
    # here. Every constant read by this tool is integral, so the rewrite is exact.
    expr = m.group(1).strip().replace("/", "//")
    try:
        return eval(expr, {"__builtins__": {}}, dict(env))  # noqa: S307 - build tool, fixed inputs
    except Exception as exc:  # pragma: no cover - only fires on a Rust-side rewrite
        die(f"cannot evaluate `const {name} = {expr}` from "
            f"{src.relative_to(ROOT)}: {exc}")


def read_rust_geometry(tile: int, map_tiles: int) -> dict[str, object]:
    arena_size = map_tiles * tile
    env = {"TILE": tile, "MAP_TILES": map_tiles, "ARENA_SIZE": arena_size}

    g = {
        "TILE": tile,
        "MAP_TILES": map_tiles,
        "ARENA_SIZE": arena_size,
        "MAX_SEATS": rust_const(STATE_RS, "MAX_SEATS", {}),
        "LOBBY_ENTRANCE": rust_const(PLAYER_RS, "LOBBY_ENTRANCE", env),
        "LOBBY_SPACING": rust_const(PLAYER_RS, "LOBBY_SPACING", env),
        "ENTRANCE_SPACING": rust_const(TICK_RS, "ENTRANCE_SPACING", env),
    }
    for corner in ("GATE_MIN_X", "GATE_MAX_X", "GATE_MIN_Y", "GATE_MAX_Y"):
        g[corner] = rust_const(PLAYER_RS, corner, env)
    return g


def fans_along_x(ex: int, ey: int, arena_size: int) -> bool:
    """`tick::fans_along_x`: a door's seats fan along the wall it is set into."""
    to_x_edge = min(ex, arena_size - ex)
    to_y_edge = min(ey, arena_size - ey)
    return to_y_edge <= to_x_edge


def entrance_for(seat: int, doors: list[tuple[int, int]], g: dict[str, object]) -> tuple[int, int]:
    """`tick::entrance_for` in Python: seat -> respawn point, in world units.

    Round-robin over the drawn `E` marks, each door carrying `MAX_SEATS / doors`
    ranks centred on the mark and fanned along that door's wall. The Rust reads the
    same `doors` list -- it is `map::ENTRANCES`, emitted below -- so only the *shape*
    of this formula is a transcription; every number in it is read back from source.
    """
    clamp = lambda v: min(max(v, 0), g["ARENA_SIZE"] - 1)  # noqa: E731 - tick::clamp_arena
    ex, ey = doors[seat % len(doors)]
    offset = (seat // len(doors) - g["MAX_SEATS"] // len(doors) // 2) * g["ENTRANCE_SPACING"]
    if fans_along_x(ex, ey, g["ARENA_SIZE"]):
        return clamp(ex + offset), ey
    return ex, clamp(ey + offset)


def spawn_tiles(grid: list[str], g: dict[str, object]) -> list[tuple[str, tuple[int, int]]]:
    """Every point the program can place a player on, as tile coordinates.

    Mirrors `player::lobby_spawn` (lobby side) and `tick::entrance_for` (arena
    side, also the respawn point). Both clamp into the map, so both are in range
    by construction; what is not guaranteed -- and is the whole reason this list
    exists -- is that the tile underneath is floor. A spawn inside a wall is a
    player who cannot move in any direction for the life of the match.
    """
    tile, max_xy = g["TILE"], g["MAP_TILES"] * g["TILE"] - 1
    half = g["MAX_SEATS"] // 2
    doors = entrance_world(grid, tile)
    out = []
    for seat in range(g["MAX_SEATS"]):
        lx = min(max(g["LOBBY_ENTRANCE"][0] + (seat - half) * g["LOBBY_SPACING"], 0), max_xy)
        ly = min(max(g["LOBBY_ENTRANCE"][1], 0), max_xy)
        out.append((f"lobby_spawn({seat})", (lx // tile, ly // tile)))
        ax, ay = entrance_for(seat, doors, g)
        out.append((f"entrance_for({seat})", (ax // tile, ay // tile)))
    return out


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def load_grid() -> tuple[list[str], int, int]:
    """The map, plus the geometry it defines: (grid, TILE, MAP_TILES)."""
    doc = json.loads(MAP_JSON.read_text())
    grid = doc["grid"]
    tile = doc["tile_size"]

    if not isinstance(grid, list) or not all(isinstance(r, str) for r in grid):
        die("arena.json `grid` must be a list of strings, one per tile row")
    if not isinstance(tile, int) or tile <= 0:
        die(f"arena.json tile_size {tile!r} must be a positive integer")
    if not grid:
        die("arena.json `grid` is empty")
    return grid, tile, len(grid)


def entrance_points(grid: list[str]) -> list[tuple[int, int]]:
    """The `E` tiles in row-major scan order -- the order `ENTRANCES` is emitted in."""
    return [(x, y) for y in range(len(grid)) for x, c in enumerate(grid[y]) if c == ENTRANCE]


def entrance_world(grid: list[str], tile: int) -> list[tuple[int, int]]:
    """`entrance_points` in world units: the tile's top-left corner.

    That is the convention every position in the program is written in --
    `player::LOBBY_ENTRANCE` is `(28 * TILE, 52 * TILE)`, `player::GATE_MIN_X` is
    `30 * TILE`, and `player::is_wall` recovers the tile with `pos / TILE`. Emitting
    tile centres instead would be a half-tile drift nothing downstream could see.
    """
    return [(x * tile, y * tile) for x, y in entrance_points(grid)]


def heart_point(grid: list[str]) -> tuple[int, int]:
    """The single `B` tile: where the boss stands.

    Fatal if there is not exactly one. The whole boss -- 230x270 units of hitbox --
    is centred on this point, so "which tile" is a load-bearing fact and not a
    decoration: drawn in the wrong place, most of the shell sits inside solid rock
    and no ray can reach it.
    """
    hearts = [(x, y) for y, row in enumerate(grid) for x, c in enumerate(row) if c == HEART]
    if len(hearts) != 1:
        die(f"expected exactly one `{HEART}` heart tile, found {len(hearts)}")
    return hearts[0]


def heart_world(grid: list[str], tile: int) -> tuple[int, int]:
    """[`heart_point`] in world units -- the tile's top-left corner, the same
    convention `entrance_world` and every position in the program is written in."""
    x, y = heart_point(grid)
    return (x * tile, y * tile)


def validate(grid: list[str], g: dict[str, object]) -> None:
    n = g["MAP_TILES"]
    tile = g["TILE"]
    max_xy = n * tile - 1
    solid = lambda x, y: grid[y][x] == WALL  # noqa: E731

    if len(grid) != n:
        die(f"arena.json has {len(grid)} rows, MAP_TILES is {n}")
    for y, row in enumerate(grid):
        if len(row) != n:
            die(f"arena.json row {y} is {len(row)} tiles wide, MAP_TILES is {n}")
        bad = set(row) - (FLOOR_CHARS | {WALL})
        if bad:
            die(f"arena.json row {y} uses undeclared tile {sorted(bad)!r} -- "
                f"the legend is {sorted(FLOOR_CHARS | {WALL})!r}")

    # The border ring. `is_wall` treats off-map as solid, but a player clamped to
    # x=0 must also be standing on something solid or the clamp is the only thing
    # holding them in and a coordinate bug walks them off the map.
    for i in range(n):
        for x, y in ((i, 0), (i, n - 1), (0, i), (n - 1, i)):
            if not solid(x, y):
                die(f"border tile ({x}, {y}) is not wall -- the map must be closed")

    # The `B` tile IS the boss spawn -- it is emitted as `map::BOSS_SPAWN` and
    # `init::init_arena` reads it from there. It used to be compared against a
    # hardcoded (ARENA_SIZE/2, ARENA_SIZE/2) that named a `tick.rs::start_match`
    # write which does not exist, while the real spawn lived in `init.rs` as a pair
    # of literals -- and those literals said tile (32, 20), the *north corridor*,
    # two tiles wide, with most of the boss's hitboxes buried in rock. One fact, one
    # place: this tool emits it, nothing restates it.
    heart = heart_point(grid)

    entrances = entrance_points(grid)
    if len(entrances) != 4:
        die(f"expected four `{ENTRANCE}` edge entrances, found {len(entrances)} -- "
            "`ENTRANCES` is a fixed-length array, so the count is part of the ABI")

    # 4-connected on purpose. Movement is 8-way and only tests the destination
    # tile, so a diagonal can squeeze past a corner -- accepting that here would
    # sign off on passages that only exist by accident.
    seen = {heart}
    q = deque([heart])
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < n and 0 <= ny < n and (nx, ny) not in seen and not solid(nx, ny):
                seen.add((nx, ny))
                q.append((nx, ny))

    # Each entrance has to survive the trip the program makes: mark -> world pair (the
    # emitted `ENTRANCES`) -> a floor tile that reaches the heart. `E` is floor by
    # construction, but the emitted pair is not free: `ENTRANCES` is `(i16, i16)` and a
    # position in this program is `i16` everywhere, so a map big enough to push
    # `tile * TILE` past 32767 would wrap into a coordinate inside the arena -- a
    # plausible-looking respawn in the wrong place, which is worse than a crash.
    for (tx, ty), (wx, wy) in zip(entrances, entrance_world(grid, tile)):
        if solid(tx, ty):
            die(f"entrance ({tx}, {ty}) is wall")
        if not (0 <= wx <= max_xy and 0 <= wy <= max_xy) or max(wx, wy) > 32767:
            die(f"entrance ({tx}, {ty}) emits world ({wx}, {wy}), which is outside "
                f"0..={max_xy} or past the i16 `ENTRANCES` is typed as")
        if (tx, ty) not in seen:
            die(f"entrance ({tx}, {ty}) cannot reach the heart chamber {heart} -- "
                "the dungeon is cut in two")

    for label, t in spawn_tiles(grid, g):
        if solid(*t):
            die(f"{label} lands on tile {t}, which is wall")
        if t not in seen:
            die(f"{label} lands on tile {t}, which cannot reach the heart chamber")

    # The gate block is where `enter_gate` demands the player be standing. Walling
    # any of it off is a lobby no one can leave.
    for ty in range(g["GATE_MIN_Y"] // tile, g["GATE_MAX_Y"] // tile + 1):
        for tx in range(g["GATE_MIN_X"] // tile, g["GATE_MAX_X"] // tile + 1):
            if solid(tx, ty):
                die(f"gate tile ({tx}, {ty}) is wall -- no player could ever enter_gate")

    floor = sum(row.count(c) for row in grid for c in FLOOR_CHARS)
    if len(seen) != floor:
        die(f"{floor - len(seen)} floor tiles are sealed off from the heart chamber "
            "-- unreachable floor is a drawing mistake, not a secret room")


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------

BANNER = (
    "GENERATED by tools/gen_map.py from assets/map/arena.json. Do not edit.\n"
    "Redraw the ASCII grid in that file and re-run the tool."
)


def emit_rust(grid: list[str], g: dict[str, object]) -> str:
    n = g["MAP_TILES"]
    rows = []
    for y, row in enumerate(grid):
        bits = sum(1 << x for x, c in enumerate(row) if c == WALL)
        rows.append(f"    0x{bits:016x}, // y={y:<2} {row}")
    body = "\n".join(rows)
    ents = "\n".join(
        f"    ({wx}, {wy}), // tile ({tx}, {ty})"
        for (tx, ty), (wx, wy) in zip(entrance_points(grid), entrance_world(grid, g["TILE"]))
    )
    (htx, hty) = heart_point(grid)
    (hx, hy) = heart_world(grid, g["TILE"])
    return f'''//! Arena wall bitboard.
//!
//! {BANNER.replace(chr(10), chr(10) + "//! ")}
//!
//! Bit *x* of row *y* is set when tile (x, y) is solid, which is the shape
//! `handlers::player::is_wall` already indexes and the cheapest wall test that
//! exists: one shift and one mask, no account, no CU worth measuring.
//!
//! The map is static per deployment, so it lives in the program image rather than
//! in an account. An account would cost rent, would have to be delegated and
//! committed with the arena, and would spend one of the ~38 account keys an ER
//! transaction is allowed -- with no address lookup tables available to buy it
//! back. This table costs {n * 8} bytes of .so and zero keys. If maps ever need to
//! vary at runtime the upgrade path is a second generated table and a `map_id: u8`
//! on `Arena` selecting between them; still no account, still no key.

/// Map edge in tiles -- the width of the ASCII grid in `assets/map/arena.json`,
/// which is also what sizes the table below.
///
/// This is the only declaration of it in the program: `handlers::player` re-exports
/// this constant and `handlers::tick` casts it, so there is nothing left to assert it
/// against. An `assert!(MAP_TILES == player::MAP_TILES)` used to sit here, and once
/// `player.rs` became a `pub use` it was comparing this value to itself -- a drift
/// guard over a fact that is no longer stored twice is theatre, so it is gone.
pub const MAP_TILES: usize = {n};

/// Arena-space units per tile, compiled from `arena.json`'s `tile_size`.
///
/// Same story as `MAP_TILES`: sole declaration, re-exported rather than restated, and
/// `handlers::tick::ARENA_SIZE` is `MAP_TILES * TILE` derived from these two.
pub const TILE: i16 = {g["TILE"]};

/// Wall bitboard: bit *x* of row *y* set means tile (x, y) is solid.
///
/// Layout: a central open heart chamber around the boss spawn, four 2-tile-wide
/// corridors radiating N/S/E/W as the only approaches to it, four large outer
/// halls broken up by 2x2 pillars, and four edge entrances. The 2-wide fronts are
/// the difficulty system -- a corridor has almost no perimeter to defend, a hall
/// has perimeter everywhere.
pub const WALLS: [u64; MAP_TILES] = [
{body}
];

/// The four `E` marks on the drawn map, in world units at the tile's top-left corner --
/// the same convention `handlers::player::LOBBY_ENTRANCE` and `GATE_MIN_X` are written
/// in, and the one `is_wall` inverts with `pos / TILE`.
///
/// Row-major scan order (top to bottom, then left to right), *not* compass order: for
/// the map as drawn that happens to be north, west, east, south, but redrawing the grid
/// re-orders this array and nothing may assume otherwise.
///
/// This exists so respawn points are *read out of the map* instead of restated beside it.
/// `handlers::tick::entrance_for` picks `ENTRANCES[seat % 4]` and fans that door's ranks
/// along the wall it is set into; the `ENTRANCE_X`/`ENTRANCE_Y` pair that used to
/// describe the arena a second time is gone. Move an `E` in the grid, re-run the tool,
/// and the respawn moves with it.
pub const ENTRANCES: [(i16, i16); 4] = [
{ents}
];

/// The `B` heart tile: where the boss stands, in world units at the tile's top-left
/// corner -- the same convention as [`ENTRANCES`].
///
/// `handlers::init` reads this and writes it to `Boss.x`/`Boss.y` on every spawn and
/// respawn. It is here rather than there because the boss's position is a fact about
/// the *map*: the sprite is 230x270 units of hitbox centred on this point, and the
/// drawn heart chamber is the only open space on the grid wide enough to hold it.
///
/// It used to be a pair of literals in `init.rs` reading (512, 320) -- tile (32, 20),
/// which is the two-tile north *corridor*, not the chamber. The shell was mostly
/// inside solid rock, `shoot`'s ray died on the corridor wall before reaching it, and
/// this generator "checked" the spawn against a hardcoded map centre attributed to a
/// `start_match` write that never existed. Three copies, two of them wrong, and the
/// fight had never been run on chain so nothing had noticed.
pub const BOSS_SPAWN: (i16, i16) = ({hx}, {hy}); // tile ({htx}, {hty})

/// Every entrance stands on floor in the table above.
///
/// The generator proves the same thing plus reachability, but only when someone runs it.
/// This fires on every `cargo check`, against the table that actually shipped -- and it
/// is also what keeps `ENTRANCES` from being an unread constant that quietly rots.
const _: () = {{
    let mut i = 0;
    while i < ENTRANCES.len() {{
        let (x, y) = ENTRANCES[i];
        let tx = (x / TILE) as usize;
        let ty = (y / TILE) as usize;
        assert!(
            x >= 0 && y >= 0 && tx < MAP_TILES && ty < MAP_TILES,
            "an entrance in map::ENTRANCES is off the map -- re-run tools/gen_map.py",
        );
        assert!(
            WALLS[ty] & (1u64 << tx) == 0,
            "an entrance in map::ENTRANCES lands in a wall -- redraw assets/map/arena.json \\
             and re-run tools/gen_map.py",
        );
        i += 1;
    }}

    // And the boss stands on floor. Same argument, higher stakes: a boss inside rock
    // is a boss whose shell no ray can strip, which is a match that cannot be won and
    // which nothing at runtime reports.
    let (bx, by) = BOSS_SPAWN;
    assert!(
        WALLS[(by / TILE) as usize] & (1u64 << (bx / TILE)) == 0,
        "map::BOSS_SPAWN lands in a wall -- move the `B` in assets/map/arena.json \\
         and re-run tools/gen_map.py",
    );
}};
'''


def emit_ts(grid: list[str], g: dict[str, object]) -> str:
    n = g["MAP_TILES"]
    rows = "\n".join(f"  '{row}'," for row in grid)
    ents = "\n".join(
        f"  [{wx}, {wy}], // tile ({tx}, {ty})"
        for (tx, ty), (wx, wy) in zip(entrance_points(grid), entrance_world(grid, g["TILE"]))
    )
    (htx, hty) = heart_point(grid)
    (hx, hy) = heart_world(grid, g["TILE"])
    return f'''/**
 * Arena wall map -- the browser's copy of the table the chain raycasts against.
 *
 * {BANNER.replace(chr(10), chr(10) + " * ")}
 *
 * The renderer draws from {{@link MAP_GRID}} and client-side prediction rejects a
 * move with {{@link isWall}}. Both read this one generated table, because a client
 * that disagrees with the chain about a single tile produces a permanent snap-back
 * on that tile that reads as lag rather than as a map bug.
 */

/** Map edge in tiles. */
export const MAP_TILES = {n};

/** Arena-space units per map tile. */
export const MAP_TILE = {g["TILE"]};

/** Highest legal coordinate, matching `handlers::player::MAP_MAX_XY`. */
export const MAP_MAX_XY = MAP_TILES * MAP_TILE - 1;

/**
 * One string per row, one character per tile: `#` wall, `.` floor, `E` entrance,
 * `B` the heart tile the boss spawns on. Row *y*, character *x*.
 */
export const MAP_GRID: readonly string[] = [
{rows}
];

/**
 * The four `E` marks, in arena-space units at the tile's top-left corner -- the exact
 * pairs `map::ENTRANCES` holds on the chain, so the browser can draw and predict a
 * respawn at the same place the program puts one.
 *
 * Row-major scan order (top to bottom, then left to right), *not* compass order.
 */
export const MAP_ENTRANCES: readonly (readonly [number, number])[] = [
{ents}
];

/**
 * The `B` heart tile: where the boss stands, in arena-space units at the tile's
 * top-left corner. The exact pair `map::BOSS_SPAWN` holds on the chain, which
 * `init::init_arena` writes to `Boss.x`/`Boss.y` on every spawn and respawn -- so the
 * browser can draw the boss, and predict a hitscan against it, without restating a
 * position the map already carries.
 */
export const BOSS_SPAWN: readonly [number, number] = [{hx}, {hy}]; // tile ({htx}, {hty})

/** Is this tile solid? Off-map is solid, so a caller that skips the clamp fails closed. */
export function isWallTile(tx: number, ty: number): boolean {{
  if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES) return true;
  return MAP_GRID[ty]![tx] === '#';
}}

/**
 * Is the tile containing this arena-space point solid?
 *
 * Byte-for-byte the same decision as `handlers::player::is_wall`: negative
 * coordinates are wall before the divide (so the truncation direction can never
 * matter), and anything past the edge is wall.
 */
export function isWall(x: number, y: number): boolean {{
  if (x < 0 || y < 0) return true;
  return isWallTile(Math.floor(x / MAP_TILE), Math.floor(y / MAP_TILE));
}}
'''


def self_test(grid: list[str], g: dict[str, object]) -> None:
    """`python3 tools/gen_map.py --self-test` -- prove the validator still bites.

    A validator that has quietly stopped rejecting things is worse than none: it
    is a green check over a map that strands players. Each case below breaks the
    real map one way and asserts the tool refuses it.
    """

    def poke(rows: list[str], x: int, y: int, c: str) -> list[str]:
        out = list(rows)
        out[y] = out[y][:x] + c + out[y][x + 1:]
        return out

    n = g["MAP_TILES"]
    # Seat 0's respawn: a rank *beside* its door, not the `E` tile itself, so walling it
    # is caught by the spawn sweep rather than by the entrance check above it.
    rx, ry = entrance_for(0, entrance_world(grid, g["TILE"]), g)
    cases = {
        "entrance walled in": poke(poke(grid, 31, 1, WALL), 33, 1, WALL),
        "entrance erased": poke(grid, 32, 1, FLOOR),
        "fifth entrance": poke(grid, 1, 2, ENTRANCE),
        "floor sealed off": poke(poke(grid, 2, 1, WALL), 1, 2, WALL),
        "spawn in a wall": poke(grid, rx // g["TILE"], ry // g["TILE"], WALL),
        "gate walled off": poke(grid, g["GATE_MIN_X"] // g["TILE"], g["GATE_MIN_Y"] // g["TILE"], WALL),
        "border breached": poke(grid, n // 2, 0, FLOOR),
        "heart deleted": poke(grid, n // 2, n // 2, FLOOR),
        "row too short": [grid[0][:-1]] + grid[1:],
    }
    for name, broken in cases.items():
        try:
            validate(broken, g)
        except MapError as exc:
            print(f"gen_map: self-test ok -- {name}: {exc}")
            continue
        raise MapError(f"self-test FAILED: `{name}` was accepted")
    validate(grid, g)
    print("gen_map: self-test ok -- the real map still passes")


def main() -> int:
    try:
        grid, tile, map_tiles = load_grid()
        g = read_rust_geometry(tile, map_tiles)
        validate(grid, g)
        if "--self-test" in sys.argv:
            self_test(grid, g)
            return 0
    except MapError as exc:
        print(f"gen_map: MAP REJECTED: {exc}", file=sys.stderr)
        return 1

    OUT_RS.write_text(emit_rust(grid, g))
    OUT_TS.write_text(emit_ts(grid, g))
    walls = sum(row.count(WALL) for row in grid)
    total = g["MAP_TILES"] ** 2
    print(f"gen_map: {g['MAP_TILES']}x{g['MAP_TILES']}, {walls} wall / {total - walls} floor")
    print(f"gen_map: wrote {OUT_RS.relative_to(ROOT)}")
    print(f"gen_map: wrote {OUT_TS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
