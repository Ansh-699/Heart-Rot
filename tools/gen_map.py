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
PIT = "P"
GATE = "G"
FLOOR_CHARS = {FLOOR, ENTRANCE, HEART, PIT, GATE}


class MapError(Exception):
    """A map defect. Always fatal -- see the module docstring."""


def die(msg: str) -> None:
    raise MapError(msg)


# ---------------------------------------------------------------------------
# Rust constants
# ---------------------------------------------------------------------------
#
# The two *spawn* constants are read out of the Rust rather than restated here, so a
# spawn point that moves on the chain side moves this validation with it. The spawn
# formulas below are still a transcription of `player::lobby_spawn` and
# `tick::entrance_for` -- a rewrite of either function's shape (not its constants)
# is the one drift this tool cannot see.
#
# The four `GATE_*` corners are NOT read back any more. They used to be hand literals
# in `player.rs` that this tool parsed out of Rust source and then validated against
# the drawn grid -- one fact stored twice, with the tool agreeing with whichever copy
# it happened to read. They are now *drawn*, as the `G` block in `arena.json`, and
# emitted into `map.rs`/`map.ts` beside `BOSS_SPAWN` and `PIT_TOP`/`PIT_BOT`. That is
# what lets `map.rs` carry a compile-time assertion that `BOSS_SPAWN` is outside the
# gate box: both come out of the same grid.
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


def marks(grid: list[str], ch: str) -> list[tuple[int, int]]:
    """Every tile carrying `ch`, in row-major scan order."""
    return [(x, y) for y, row in enumerate(grid) for x, c in enumerate(row) if c == ch]


def entrance_points(grid: list[str]) -> list[tuple[int, int]]:
    """The `E` tiles in row-major scan order -- the order `ENTRANCES` is emitted in."""
    return marks(grid, ENTRANCE)


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

    Fatal if there is not exactly one. Every part rectangle in
    `programs/heartrot/src/hitboxes.rs` is measured as an offset from this point, so
    "which tile" is a load-bearing fact and not a decoration: drawn in the wrong place,
    the shell sits inside solid rock and no ray can reach it.
    """
    hearts = marks(grid, HEART)
    if len(hearts) != 1:
        die(f"expected exactly one `{HEART}` heart tile, found {len(hearts)}")
    return hearts[0]


def heart_world(grid: list[str], tile: int) -> tuple[int, int]:
    """[`heart_point`] in world units -- the tile's top-left corner, the same
    convention `entrance_world` and every position in the program is written in."""
    x, y = heart_point(grid)
    return (x * tile, y * tile)


def pit_box(grid: list[str], tile: int) -> dict[str, int]:
    """`PIT_TOP` / `PIT_BOT`: the y band a `ZONE_ARENA` player is confined to.

    Drawn as the `P` block. Only the *rows* matter -- the pit is corner-shaped and the
    doorway is four tiles wide, so there is no rectangle to speak of -- and the band is
    inclusive of the last row's last unit, which is the form `move_player` compares a
    destination against.

    This is a movement rule and deliberately not a wall. The rows above the pit are open
    floor because `shoot`'s raycast tests `is_wall` before the part rectangles: one wall
    tile between a player and the boss would kill every shot in that column, silently.
    """
    pts = marks(grid, PIT)
    if not pts:
        die(f"no `{PIT}` pit tiles drawn -- the raider box has nowhere to be")
    rows = sorted({y for _, y in pts})
    if rows != list(range(rows[0], rows[-1] + 1)):
        gaps = [y for y in range(rows[0], rows[-1] + 1) if y not in rows]
        die(f"`{PIT}` spans rows {rows[0]}..{rows[-1]} but rows {gaps} carry none -- "
            "PIT_TOP/PIT_BOT are a bounding band, so a stray pit tile silently "
            "stretches the box over floor that is not the pit")
    return {"PIT_TOP": rows[0] * tile, "PIT_BOT": (rows[-1] + 1) * tile - 1,
            "PIT_ROWS": (rows[0], rows[-1])}


def gate_box(grid: list[str], tile: int) -> dict[str, int]:
    """The four `GATE_*` corners: the block `enter_gate` demands you stand in.

    Drawn as the `G` block, which must be a solid rectangle -- `on_gate` is two range
    tests, so a stepped or hollow gate would claim tiles nobody drew.

    These used to be hand literals in `player.rs` that this tool parsed back out of
    Rust source. Drawing them instead is what lets `map.rs` prove `BOSS_SPAWN` is not
    inside the gate at compile time.
    """
    pts = marks(grid, GATE)
    if not pts:
        die(f"no `{GATE}` gate tiles drawn -- no player could ever enter_gate")
    xs = [x for x, _ in pts]
    ys = [y for _, y in pts]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    if len(pts) != (x1 - x0 + 1) * (y1 - y0 + 1):
        die(f"the `{GATE}` block is not a solid rectangle -- its bounding box is "
            f"tiles ({x0},{y0})..({x1},{y1}) but only {len(pts)} tiles are drawn, and "
            "`on_gate` is a pair of range tests that would claim the rest")
    return {"GATE_MIN_X": x0 * tile, "GATE_MAX_X": (x1 + 1) * tile - 1,
            "GATE_MIN_Y": y0 * tile, "GATE_MAX_Y": (y1 + 1) * tile - 1,
            "GATE_TILES": (x0, y0, x1, y1)}


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
    gate = gate_box(grid, tile)
    gx0, gy0, gx1, gy1 = gate["GATE_TILES"]
    for ty in range(gy0, gy1 + 1):
        for tx in range(gx0, gx1 + 1):
            if solid(tx, ty):
                die(f"gate tile ({tx}, {ty}) is wall -- no player could ever enter_gate")
            if (tx, ty) not in seen:
                die(f"gate tile ({tx}, {ty}) cannot reach the heart chamber {heart}")

    # `PIT_TOP`/`PIT_BOT` is a *second* kind of barrier, alongside the wall bitboard,
    # and the two can disagree without either one erroring: a player clamped into open
    # floor sees no wall and no message, just a direction that does nothing. Everything
    # below is the guard for that, checked where both facts are still in one place.
    pit = pit_box(grid, tile)
    ptop, pbot = pit["PIT_ROWS"]

    # The pit has to be one room on its own, not merely reachable *through the lobby*.
    # The corner shaping on the bottom rows is the thing most likely to pinch it in two,
    # and a raider confined by PIT_TOP/PIT_BOT cannot walk around the outside to fix it.
    inside = {(x, y) for y in range(ptop, pbot + 1)
              for x in range(n) if not solid(x, y)}
    start = next(iter(sorted(inside)))
    pit_seen = {start}
    q = deque([start])
    while q:
        x, y = q.popleft()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nb in inside and nb not in pit_seen:
                pit_seen.add(nb)
                q.append(nb)
    if pit_seen != inside:
        die(f"{len(inside) - len(pit_seen)} tiles inside the PIT_TOP..PIT_BOT band "
            f"(rows {ptop}..{pbot}) cannot be walked to from the rest of the pit -- "
            "a raider is clamped into that band, so they cannot go around")

    # The gate sits below the pit and its columns walk straight into it. If they did
    # not, a player who flipped zone on the gate would be outside PIT_TOP..=PIT_BOT
    # with no legal destination inside it: a hard freeze with nothing logged.
    if gy0 != pbot + 1:
        die(f"the gate starts at row {gy0} but the pit ends at row {pbot} -- the gate "
            "must sit immediately below the pit or stepping through it is a teleport")
    for tx in range(gx0, gx1 + 1):
        if grid[pbot][tx] not in FLOOR_CHARS:
            die(f"gate column {tx} runs into wall at the pit's last row {pbot} -- "
                "a player who enters the gate here can never step into the pit")

    # The boss stands in the pit band (it is the anchor every hitbox is measured from,
    # and the raid has to be able to reach it) and never on the gate, which would let a
    # player flip zone by standing inside the creature.
    hx, hy = heart
    if not (ptop <= hy <= pbot):
        die(f"the `{HEART}` heart is on row {hy}, outside the pit rows {ptop}..{pbot}")
    if gx0 <= hx <= gx1 and gy0 <= hy <= gy1:
        die(f"the `{HEART}` heart tile {heart} is inside the gate block")

    # Every respawn point lands in the pit, because a respawn is a raider and a raider
    # is clamped to the pit. The `E` marks themselves are not the interesting case --
    # `tick::entrance_for` fans five ranks off each one, and it is a *rank* that drifts
    # out of the band as the doors move. One outside it is a seat that respawns onto
    # open floor and can never move again, with nothing logged anywhere.
    doors = entrance_world(grid, tile)
    for seat in range(g["MAX_SEATS"]):
        rx, ry = entrance_for(seat, doors, g)
        if not (ptop <= ry // tile <= pbot):
            die(f"entrance_for({seat}) lands at ({rx}, {ry}), outside the pit rows "
                f"{ptop}..{pbot} -- that seat is clamped out of every legal move")

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
    pit = pit_box(grid, g["TILE"])
    gate = gate_box(grid, g["TILE"])
    ptop, pbot = pit["PIT_ROWS"]
    gx0, gy0, gx1, gy1 = gate["GATE_TILES"]
    pit_floor = sum(sum(1 for c in row if c != WALL) for row in grid[ptop:pbot + 1])
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
/// Layout, top to bottom -- the 33 Immortals composition. Open floor for the boss's
/// air, then the shaped pit the raid fights from, then a rim wall pierced by one
/// four-tile doorway, then the gate block, then a pillared temple approach for the
/// lobby. The whole vertical order is the fight: you walk up the temple, through the
/// gate, out of the doorway into the pit, and the creature is above you.
///
/// The rows above the pit are floor, not wall, and that is load-bearing rather than
/// lazy drawing -- see [`PIT_TOP`].
pub const WALLS: [u64; MAP_TILES] = [
{body}
];

/// The four `E` marks on the drawn map, in world units at the tile's top-left corner --
/// the same convention `handlers::player::LOBBY_ENTRANCE` and `GATE_MIN_X` are written
/// in, and the one `is_wall` inverts with `pos / TILE`.
///
/// Row-major scan order (top to bottom, then left to right), *not* compass order.
/// Redrawing the grid re-orders this array and nothing may assume otherwise.
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
/// the *map*: every rectangle in `hitboxes.rs` is an offset from this point, and the
/// open rows above the pit are the only space on the grid tall enough to hold them.
///
/// It sits at the *top* of the pit band rather than in the middle of the map: the boss
/// is drawn upward from here, so the creature fills the top of the frame and the raid
/// shoots up at it from the pit below. The assertion block at the bottom of this file
/// proves it is on floor, inside `PIT_TOP..=PIT_BOT`, and outside the gate.
///
/// It used to be a pair of literals in `init.rs` reading (512, 320) -- tile (32, 20),
/// which was a two-tile corridor on the map of the time. The shell was mostly inside
/// solid rock and `shoot`'s ray died on the corridor wall before reaching it, while
/// this generator "checked" the spawn against a hardcoded map centre attributed to a
/// `start_match` write that never existed. Three copies, two of them wrong, and the
/// fight had never been run on chain so nothing had noticed.
pub const BOSS_SPAWN: (i16, i16) = ({hx}, {hy}); // tile ({htx}, {hty})

/// The raider box: a `ZONE_ARENA` player's y is confined to `PIT_TOP..=PIT_BOT`.
///
/// Compiled from the `P` block's bounding rows ({ptop}..{pbot}) -- inclusive of the last
/// row's last unit, which is the form `move_player` compares a *destination* against.
/// Comparing the destination and not the current position is load-bearing: a player who
/// flips zone while standing on the gate is below `PIT_BOT`, and a current-position test
/// would refuse every direction and freeze them there for the match.
///
/// This is a movement rule and deliberately **not** a wall. The rows above the pit are
/// open floor because `shoot`'s raycast tests `is_wall` before the part rectangles, so a
/// single wall tile between a player and the boss would kill every shot in that column
/// with nothing logged anywhere. The clamp holds raiders out of the boss's air; the
/// bitboard holds bullets and rays to the map. Two barriers, and they can disagree --
/// `tools/gen_map.py` proves the pit is one connected room and that the gate walks into
/// it, which is the only guard against a clamp that boxes someone in open floor.
pub const PIT_TOP: i16 = {pit["PIT_TOP"]}; // tile row {ptop}
pub const PIT_BOT: i16 = {pit["PIT_BOT"]}; // tile row {pbot}, last unit

/// The gate block `enter_gate` demands the player be standing in, compiled from the `G`
/// rectangle -- tiles ({gx0}, {gy0})..({gx1}, {gy1}).
///
/// These were four hand literals in `handlers::player` that `gen_map.py` parsed back out
/// of Rust source to validate against the drawn grid: one fact stored twice, with the
/// tool agreeing with whichever copy it read. Drawing them is what lets the assertion
/// below prove `BOSS_SPAWN` is outside the gate on every `cargo check`.
pub const GATE_MIN_X: i16 = {gate["GATE_MIN_X"]};
pub const GATE_MAX_X: i16 = {gate["GATE_MAX_X"]};
pub const GATE_MIN_Y: i16 = {gate["GATE_MIN_Y"]};
pub const GATE_MAX_Y: i16 = {gate["GATE_MAX_Y"]};

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

    // The pit band is non-empty and sits inside the map.
    assert!(PIT_TOP >= 0 && PIT_TOP < PIT_BOT && PIT_BOT < (MAP_TILES as i16) * TILE);
    assert!(GATE_MIN_X <= GATE_MAX_X && GATE_MIN_Y <= GATE_MAX_Y);

    // The boss is reachable by a raider: its anchor is inside the band they are clamped
    // to. A boss above `PIT_TOP` would be a target no one can ever stand level with.
    assert!(
        by >= PIT_TOP && by <= PIT_BOT,
        "map::BOSS_SPAWN is outside PIT_TOP..=PIT_BOT -- the raid is clamped away from \\
         its own boss; redraw assets/map/arena.json and re-run tools/gen_map.py",
    );

    // And it is not standing on the gate, which would let a player flip zone by walking
    // into the creature. This is the assertion the four `GATE_*` literals in
    // `handlers::player` could never carry: it needs both facts to come out of one grid.
    assert!(
        !(bx >= GATE_MIN_X && bx <= GATE_MAX_X && by >= GATE_MIN_Y && by <= GATE_MAX_Y),
        "map::BOSS_SPAWN is inside the gate block",
    );

    // The gate is immediately below the pit, so stepping out of it lands in the band.
    assert!(
        GATE_MIN_Y == PIT_BOT + 1,
        "the gate does not adjoin the pit -- a player who flips zone on it would have \\
         no legal destination inside PIT_TOP..=PIT_BOT and would freeze",
    );
}};

#[cfg(test)]
mod tests {{
    use super::*;

    const fn solid(tx: usize, ty: usize) -> bool {{
        tx >= MAP_TILES || ty >= MAP_TILES || WALLS[ty] & (1u64 << tx) != 0
    }}

    /// 4-connected flood fill from the boss tile, confined to tile rows `top..=bot`.
    ///
    /// 4- and not 8-connected on purpose: movement is 8-way but only tests the
    /// destination tile, so a diagonal can squeeze past a corner. Accepting that here
    /// would sign off on passages that exist by accident.
    ///
    /// Relaxed to a fixpoint rather than queued, so it allocates nothing: 64x64 is four
    /// thousand tiles and this is a test.
    fn reachable(top: usize, bot: usize) -> [[bool; MAP_TILES]; MAP_TILES] {{
        let mut seen = [[false; MAP_TILES]; MAP_TILES];
        seen[(BOSS_SPAWN.1 / TILE) as usize][(BOSS_SPAWN.0 / TILE) as usize] = true;
        let mut changed = true;
        while changed {{
            changed = false;
            for ty in top..=bot {{
                for tx in 0..MAP_TILES {{
                    if seen[ty][tx] || solid(tx, ty) {{
                        continue;
                    }}
                    let touching = (ty > top && seen[ty - 1][tx])
                        || (ty < bot && seen[ty + 1][tx])
                        || (tx > 0 && seen[ty][tx - 1])
                        || (tx + 1 < MAP_TILES && seen[ty][tx + 1]);
                    if touching {{
                        seen[ty][tx] = true;
                        changed = true;
                    }}
                }}
            }}
        }}
        seen
    }}

    /// One room, not several. `tools/gen_map.py` proves this against `arena.json`, but
    /// only when someone runs it; this proves it against the table that actually
    /// shipped, and it is what stands behind "the gate is reachable from every lobby
    /// spawn" -- both are floor, and every floor tile is in the same component.
    #[test]
    fn every_floor_tile_is_one_room() {{
        let seen = reachable(0, MAP_TILES - 1);
        for ty in 0..MAP_TILES {{
            for tx in 0..MAP_TILES {{
                assert_eq!(
                    !solid(tx, ty),
                    seen[ty][tx],
                    "tile ({{tx}}, {{ty}}) is floor but sealed off from the boss",
                );
            }}
        }}
    }}

    /// The border ring is closed, so the coordinate clamp is never the only thing
    /// holding a player on the map.
    #[test]
    fn the_border_is_closed() {{
        for i in 0..MAP_TILES {{
            for (x, y) in [(i, 0), (i, MAP_TILES - 1), (0, i), (MAP_TILES - 1, i)] {{
                assert!(solid(x, y), "border tile ({{x}}, {{y}}) is not wall");
            }}
        }}
    }}

    /// The pit is one room *on its own terms*. A raider is clamped to
    /// `PIT_TOP..=PIT_BOT`, so a pinch in the corner shaping cannot be walked around the
    /// way [`every_floor_tile_is_one_room`] would let you. The two are not the same
    /// test, and this is the one that catches a shaped pit cut in half.
    #[test]
    fn the_pit_is_one_room_a_raider_can_cross() {{
        let (top, bot) = ((PIT_TOP / TILE) as usize, (PIT_BOT / TILE) as usize);
        let seen = reachable(top, bot);
        let mut floor = 0usize;
        for ty in top..=bot {{
            for tx in 0..MAP_TILES {{
                if !solid(tx, ty) {{
                    floor += 1;
                    assert!(seen[ty][tx], "pit tile ({{tx}}, {{ty}}) is cut off from the boss");
                }}
            }}
        }}
        assert_eq!(floor, {pit_floor}, "the drawn pit changed size");
    }}

    /// Every respawn door is inside the pit band. A raider respawned above `PIT_TOP` or
    /// below `PIT_BOT` is a seat clamped out of every legal move, with nothing logged.
    #[test]
    fn every_door_is_inside_the_raider_box() {{
        for (x, y) in ENTRANCES {{
            assert!(
                y >= PIT_TOP && y <= PIT_BOT,
                "entrance ({{x}}, {{y}}) is outside PIT_TOP..=PIT_BOT",
            );
            assert!(!solid((x / TILE) as usize, (y / TILE) as usize));
        }}
    }}

    /// The gate block is walkable end to end, and its columns step straight into the
    /// pit. Walling any of it is a lobby nobody can leave; a gate that does not adjoin
    /// the pit is a player who flips zone and then cannot move.
    #[test]
    fn the_gate_is_floor_and_walks_into_the_pit() {{
        for ty in (GATE_MIN_Y / TILE)..=(GATE_MAX_Y / TILE) {{
            for tx in (GATE_MIN_X / TILE)..=(GATE_MAX_X / TILE) {{
                assert!(!solid(tx as usize, ty as usize), "gate tile ({{tx}}, {{ty}}) is wall");
            }}
        }}
        let last_pit_row = (PIT_BOT / TILE) as usize;
        for tx in (GATE_MIN_X / TILE)..=(GATE_MAX_X / TILE) {{
            assert!(
                !solid(tx as usize, last_pit_row),
                "gate column {{tx}} runs into wall at the pit's last row",
            );
        }}
    }}

    /// The boss's air is open floor. `handlers::shoot`'s raycast tests `is_wall` before
    /// the part rectangles, so one wall tile above the pit kills every shot in that
    /// column -- a raid that cannot be won, reporting nothing. The pit ceiling is
    /// `PIT_TOP`, a movement rule, and this is the test that keeps it from becoming a
    /// wall the next time someone redraws the grid.
    #[test]
    fn the_boss_air_above_the_pit_is_open() {{
        let top = (PIT_TOP / TILE) as usize;
        for ty in 1..top {{
            for tx in 1..MAP_TILES - 1 {{
                assert!(
                    !solid(tx, ty),
                    "tile ({{tx}}, {{ty}}) is wall above PIT_TOP -- every shot in that \\
                     column dies on it before reaching the boss",
                );
            }}
        }}
    }}
}}
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
    pit = pit_box(grid, g["TILE"])
    gate = gate_box(grid, g["TILE"])
    ptop, pbot = pit["PIT_ROWS"]
    gx0, gy0, gx1, gy1 = gate["GATE_TILES"]
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
 * One string per row, one character per tile: `#` wall, `.` floor, `P` pit floor,
 * `G` gate, `E` entrance, `B` the heart tile the boss spawns on. Row *y*, character *x*.
 *
 * Everything but `#` is walkable. A renderer that keys off `.` alone will draw the pit
 * and the gate as holes.
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

/**
 * The raider box: a `ZONE_ARENA` player's y is confined to `PIT_TOP..=PIT_BOT`, the
 * bounding rows of the drawn `P` block (tile rows {ptop}..{pbot}).
 *
 * The exact pair `map::PIT_TOP`/`map::PIT_BOT` hold on the chain, and `move_player`
 * compares a move's *destination* y against them. Client-side prediction must apply the
 * same clamp, on the same side of the move: a step the browser allows and the chain
 * refuses is a permanent snap-back on that tile, which reads as lag rather than as a
 * rule. And it is a rule, not a wall -- the rows above the pit are open floor, because
 * the chain's raycast dies on any wall tile between a player and the boss.
 */
export const PIT_TOP = {pit["PIT_TOP"]};
export const PIT_BOT = {pit["PIT_BOT"]};

/**
 * The gate block `enter_gate` demands the player be standing in -- the drawn `G`
 * rectangle, tiles ({gx0}, {gy0})..({gx1}, {gy1}), in arena-space units.
 *
 * The lobby's gate glow keys off the *predicted* local position against this box, so it
 * lights the instant you step on rather than a round trip later; the `enter_gate`
 * transaction still goes through the authoritative poll. Same four numbers as
 * `map::GATE_MIN_X`..`GATE_MAX_Y`, out of the same grid.
 */
export const GATE_MIN_X = {gate["GATE_MIN_X"]};
export const GATE_MAX_X = {gate["GATE_MAX_X"]};
export const GATE_MIN_Y = {gate["GATE_MIN_Y"]};
export const GATE_MAX_Y = {gate["GATE_MAX_Y"]};

/** Is this arena-space point inside the gate block? `handlers::player::on_gate`. */
export function onGate(x: number, y: number): boolean {{
  return x >= GATE_MIN_X && x <= GATE_MAX_X && y >= GATE_MIN_Y && y <= GATE_MAX_Y;
}}

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
    (ex0, ey0) = entrance_points(grid)[0]
    (gx0, gy0, gx1, gy1) = gate_box(grid, g["TILE"])["GATE_TILES"]
    (ptop, pbot) = pit_box(grid, g["TILE"])["PIT_ROWS"]
    cases = {
        "entrance erased": poke(grid, ex0, ey0, PIT),
        "fifth entrance": poke(grid, ex0, ey0 - 1, ENTRANCE),
        "spawn in a wall": poke(grid, rx // g["TILE"], ry // g["TILE"], WALL),
        "gate corner erased": poke(grid, gx1, gy1, FLOOR),
        "doorway sealed": [
            r if y != pbot else WALL * n for y, r in enumerate(grid)
        ],
        "stray pit tile in the lobby": poke(grid, gx0, n - 2, PIT),
        "boss out of the pit": poke(poke(grid, *heart_point(grid), PIT), 32, ptop - 1, HEART),
        "border breached": poke(grid, n // 2, 0, FLOOR),
        "heart deleted": poke(grid, *heart_point(grid), PIT),
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
