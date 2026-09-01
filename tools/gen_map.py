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
# `TILE` and `MAP_TILES` are deliberately NOT read from the Rust: this tool emits
# them into `map.rs`, and `player.rs` re-exports them from there, so reading them
# back would validate the map against the tool's own last output. They come from
# `arena.json` -- the source -- and are cross-checked against the only definitions
# the Rust still owns independently, `tick.rs`'s `TILE` and `ARENA_SIZE`.


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
    env = {"TILE": tile, "MAP_TILES": map_tiles}

    tick_tile = rust_const(TICK_RS, "TILE", {})
    if tick_tile != tile:
        die(f"TILE disagrees: arena.json tile_size {tile}, tick.rs {tick_tile}")

    arena_size = rust_const(TICK_RS, "ARENA_SIZE", env)
    if arena_size != map_tiles * tile:
        die(f"tick.rs ARENA_SIZE {arena_size} != arena.json grid {map_tiles} tiles "
            f"* {tile} = {map_tiles * tile}")
    env["ARENA_SIZE"] = arena_size

    g = {
        "TILE": tile,
        "MAP_TILES": map_tiles,
        "ARENA_SIZE": arena_size,
        "MAX_SEATS": rust_const(STATE_RS, "MAX_SEATS", {}),
        "LOBBY_ENTRANCE": rust_const(PLAYER_RS, "LOBBY_ENTRANCE", env),
        "LOBBY_SPACING": rust_const(PLAYER_RS, "LOBBY_SPACING", env),
        "ENTRANCE_X": rust_const(TICK_RS, "ENTRANCE_X", env),
        "ENTRANCE_Y": rust_const(TICK_RS, "ENTRANCE_Y", env),
        "ENTRANCE_SPACING": rust_const(TICK_RS, "ENTRANCE_SPACING", env),
    }
    for corner in ("GATE_MIN_X", "GATE_MAX_X", "GATE_MIN_Y", "GATE_MAX_Y"):
        g[corner] = rust_const(PLAYER_RS, corner, env)
    return g


def spawn_tiles(g: dict[str, object]) -> list[tuple[str, tuple[int, int]]]:
    """Every point the program can place a player on, as tile coordinates.

    Mirrors `player::lobby_spawn` (lobby side) and `tick::entrance_for` (arena
    side, also the respawn point). Both clamp into the map, so both are in range
    by construction; what is not guaranteed -- and is the whole reason this list
    exists -- is that the tile underneath is floor. A spawn inside a wall is a
    player who cannot move in any direction for the life of the match.
    """
    tile, max_xy = g["TILE"], g["MAP_TILES"] * g["TILE"] - 1
    half = g["MAX_SEATS"] // 2
    out = []
    for seat in range(g["MAX_SEATS"]):
        lx = min(max(g["LOBBY_ENTRANCE"][0] + (seat - half) * g["LOBBY_SPACING"], 0), max_xy)
        ly = min(max(g["LOBBY_ENTRANCE"][1], 0), max_xy)
        out.append((f"lobby_spawn({seat})", (lx // tile, ly // tile)))
        ax = min(max(g["ENTRANCE_X"] + (seat - half) * g["ENTRANCE_SPACING"], 0), max_xy)
        ay = min(max(g["ENTRANCE_Y"], 0), max_xy)
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


def validate(grid: list[str], g: dict[str, object]) -> None:
    n = g["MAP_TILES"]
    tile = g["TILE"]
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

    hearts = [(x, y) for y in range(n) for x, c in enumerate(grid[y]) if c == HEART]
    if len(hearts) != 1:
        die(f"expected exactly one `{HEART}` heart tile, found {len(hearts)}")
    heart = hearts[0]
    boss = (g["ARENA_SIZE"] // 2 // tile, g["ARENA_SIZE"] // 2 // tile)
    if heart != boss:
        die(f"heart tile {heart} is not the boss spawn {boss} that "
            "tick.rs::start_match writes (ARENA_SIZE/2, ARENA_SIZE/2)")

    entrances = [(x, y) for y in range(n) for x, c in enumerate(grid[y]) if c == ENTRANCE]
    if len(entrances) != 4:
        die(f"expected four `{ENTRANCE}` edge entrances, found {len(entrances)}")

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

    for e in entrances:
        if e not in seen:
            die(f"entrance {e} cannot reach the heart chamber {heart} -- "
                "the dungeon is cut in two")

    for label, t in spawn_tiles(g):
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
/// which is also what sizes the table below. `handlers::player` re-exports this
/// rather than declaring its own; the assertion under it is what turns a
/// re-declaration back into a compile error instead of a silent second copy.
pub const MAP_TILES: usize = {n};

const _: () = assert!(MAP_TILES == crate::handlers::player::MAP_TILES);

/// Arena-space units per tile, compiled from `arena.json`'s `tile_size` and checked
/// by the generator against `handlers::tick::TILE` -- the one place the Rust still
/// spells this number out for itself.
pub const TILE: i16 = {g["TILE"]};

const _: () = assert!(TILE == crate::handlers::player::TILE);

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
'''


def emit_ts(grid: list[str], g: dict[str, object]) -> str:
    n = g["MAP_TILES"]
    rows = "\n".join(f"  '{row}'," for row in grid)
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
    cases = {
        "entrance walled in": poke(poke(grid, 31, 1, WALL), 33, 1, WALL),
        "floor sealed off": poke(poke(grid, 2, 1, WALL), 1, 2, WALL),
        "spawn in a wall": poke(grid, g["ENTRANCE_X"] // g["TILE"], g["ENTRANCE_Y"] // g["TILE"], WALL),
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
