#!/usr/bin/env python3
"""Compile assets/map/arena.json into the arena wall bitboard the chain raycasts
against and the copy the browser predicts against.

    python3 tools/gen_map.py             # compile
    python3 tools/gen_map.py --check     # exit 1 if either mirror is not what the grid says

The ASCII grid in `assets/map/arena.json` is the map -- written there by
`tools/gen_rooms.py` from the room paintings, never by hand. This tool is the only thing
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
# The browser's copy of the gate blocks, written by gen_rooms.py from the same
# `arena.json`. Cross-checked below, never read as an input: the two generators derive
# the blocks from the painting and the grid respectively, and the gate mark the lobby
# draws over a doorway must be the block `enter_gate` admits through it.
ROOMS_TS = ROOT / "app" / "src" / "render" / "rooms.gen.ts"
OUT_RS = ROOT / "programs" / "heartrot" / "src" / "map.rs"
OUT_TS = ROOT / "packages" / "client" / "src" / "map.ts"

WALL = "#"
FLOOR = "."
ENTRANCE = "E"
HEART = "B"
PIT = "P"
GATE = "G"
FLOOR_CHARS = {FLOOR, ENTRANCE, HEART, PIT, GATE}
# The dais: the tiles a `ZONE_ARENA` seat may stand on, emitted as a second bitboard beside
# `WALLS`. `.` inside the pit rows is the boss's air painted over by nothing -- floor a ray
# crosses and nobody stands on. It exists because the dais narrows upward above its widest
# row, so a wall over its shoulder tiles is a stand from which every upward shot dies.
DAIS_CHARS = {PIT, ENTRANCE, HEART}


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
# The gate corners are NOT read back. They used to be four hand literals in `player.rs`
# that this tool parsed out of Rust source and then validated against the drawn grid --
# one fact stored twice, with the tool agreeing with whichever copy it happened to read.
# They are *drawn*, as the three `G` blocks in `arena.json` (left to right = tier 0..2,
# the count read back from `state::N_TIERS`), and emitted into `map.rs`/`map.ts` as
# `GATES` beside `BOSS_SPAWN` and `PIT_TOP`/`PIT_BOT`. That is what lets `map.rs` carry a
# compile-time assertion that `BOSS_SPAWN` is outside every gate: both come out of the
# same grid.
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
        # One gate per difficulty tier, and the tier tables are `[_; N_TIERS]`: a fourth
        # `G` block would index past every one of them.
        "N_TIERS": rust_const(STATE_RS, "N_TIERS", {}),
        "LOBBY_ENTRANCE": rust_const(PLAYER_RS, "LOBBY_ENTRANCE", env),
        "LOBBY_SPACING": rust_const(PLAYER_RS, "LOBBY_SPACING", env),
        "ENTRANCE_SPACING": rust_const(TICK_RS, "ENTRANCE_SPACING", env),
        # The eight-way step, read back rather than restated: the freeze sweep below is
        # only worth running if it steps exactly as far as `move_player` does.
        "STEP": rust_const(PLAYER_RS, "STEP", env),
        "STEP_DIAG": rust_const(PLAYER_RS, "STEP_DIAG", env),
    }
    return g


def move_steps(g: dict[str, object]) -> list[tuple[int, int]]:
    """`player::MOVE_STEP`, rebuilt from the two constants that define it."""
    s, d = g["STEP"], g["STEP_DIAG"]
    return [(0, -s), (d, -d), (s, 0), (d, d), (0, s), (-d, d), (-s, 0), (-d, -d)]


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


def lobby_spawn(seat: int, g: dict[str, object]) -> tuple[int, int]:
    """`player::lobby_spawn` in Python: seat -> waiting-room spawn, in world units.

    The ONE copy of that formula in this tool. It used to be written twice -- once in
    [`spawn_tiles`], which validates that the spawn is on floor, and once in
    [`lobby_spawn_extent`], which emits `LOBBY_SPAWN_MIN_X`/`MAX_X`/`Y` for the browser
    to frame the waiting room on. The tool would then have validated one set of points
    and shipped another, and the drift would have surfaced as a knight standing outside
    its own frame -- the exact defect `LOBBY_SPAWN_*` was added to close.
    """
    max_xy = g["MAP_TILES"] * g["TILE"] - 1
    offset = (seat - g["MAX_SEATS"] // 2) * g["LOBBY_SPACING"]
    return (
        min(max(g["LOBBY_ENTRANCE"][0] + offset, 0), max_xy),
        min(max(g["LOBBY_ENTRANCE"][1], 0), max_xy),
    )


def spawn_tiles(grid: list[str], g: dict[str, object]) -> list[tuple[str, tuple[int, int]]]:
    """Every point the program can place a player on, as tile coordinates.

    Mirrors `player::lobby_spawn` (lobby side) and `tick::entrance_for` (arena
    side, also the respawn point). Both clamp into the map, so both are in range
    by construction; what is not guaranteed -- and is the whole reason this list
    exists -- is that the tile underneath is floor. A spawn inside a wall is a
    player who cannot move in any direction for the life of the match.
    """
    tile = g["TILE"]
    doors = entrance_world(grid, tile)
    out = []
    for seat in range(g["MAX_SEATS"]):
        lx, ly = lobby_spawn(seat, g)
        out.append((f"lobby_spawn({seat})", (lx // tile, ly // tile)))
        ax, ay = entrance_for(seat, doors, g)
        out.append((f"entrance_for({seat})", (ax // tile, ay // tile)))
    return out


def lobby_spawn_extent(g: dict[str, object]) -> dict[str, int]:
    """The x span every `lobby_spawn` occupies, and the row they share.

    Emitted because the lobby CAMERA has to frame it. `lobby_spawn` fans the seats
    symmetrically about `LOBBY_ENTRANCE`, so seat 0 sits `MAX_SEATS / 2` spacings to its
    left -- 240 units at the shipped numbers -- while a camera centred on the gate alone
    showed x 256..768 and cropped seats 0 and 1 off the left edge entirely. The first
    player to join takes seat 0, so the commonest case was the invisible one.

    Reads [`lobby_spawn`], the same function the floor sweep validates through, so the
    span that ships is the span that was checked.
    """
    seats = [lobby_spawn(seat, g) for seat in range(g["MAX_SEATS"])]
    return {
        "LOBBY_SPAWN_MIN_X": min(x for x, _ in seats),
        "LOBBY_SPAWN_MAX_X": max(x for x, _ in seats),
        "LOBBY_SPAWN_Y": seats[0][1],
    }


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
    `player::LOBBY_ENTRANCE` is `(28 * TILE, 52 * TILE)`, a gate's `min_x` is its first
    column `* TILE`, and `player::is_wall` recovers the tile with `pos / TILE`. Emitting
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

    Drawn as the `P` block. Only the *rows* matter -- the pit is chamfered and the
    doorway is eight tiles wide, so there is no rectangle to speak of -- and the band is
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


def gate_boxes(grid: list[str], tile: int, n_tiers: int) -> list[dict[str, object]]:
    """The gate blocks `enter_gate` demands you stand in, left to right -- one per tier.

    Drawn as separate `G` blocks: the 4-connected components of the `G` tiles, ordered by
    their left edge, so the block order IS the tier order (0 EASY, 1 MEDIUM, 2 HARD) and
    nothing restates it. Each must be a solid rectangle -- `gate_at` is two range tests per
    block, so a stepped or hollow gate would claim tiles nobody drew -- and the blocks may
    not share a column, or "left to right" would name no order at all.

    Exactly `n_tiers` of them, read back from `state::N_TIERS`: every balance table on the
    chain is `[_; N_TIERS]`, indexed by the block the raid's first raider stood in.
    """
    pts = set(marks(grid, GATE))
    if not pts:
        die(f"no `{GATE}` gate tiles drawn -- no player could ever enter_gate")
    blocks: list[set[tuple[int, int]]] = []
    unseen = set(pts)
    while unseen:
        start = min(unseen)
        block = {start}
        q = deque([start])
        while q:
            x, y = q.popleft()
            for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if nb in unseen and nb not in block:
                    block.add(nb)
                    q.append(nb)
        unseen -= block
        blocks.append(block)
    if len(blocks) != n_tiers:
        die(f"{len(blocks)} separate `{GATE}` blocks drawn, `state::N_TIERS` is {n_tiers} -- "
            "one gate per difficulty tier, with wall between them")

    out = []
    for block in sorted(blocks, key=lambda b: min(x for x, _ in b)):
        xs = [x for x, _ in block]
        ys = [y for _, y in block]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        if len(block) != (x1 - x0 + 1) * (y1 - y0 + 1):
            die(f"a `{GATE}` block is not a solid rectangle -- its bounding box is tiles "
                f"({x0},{y0})..({x1},{y1}) but only {len(block)} tiles are drawn, and "
                "`gate_at` is a pair of range tests that would claim the rest")
        if out and x0 <= out[-1]["GATE_TILES"][2]:
            die(f"`{GATE}` blocks overlap in x at column {x0} -- the tier is the block's "
                "position left to right, so two blocks sharing a column have no order")
        out.append({"min_x": x0 * tile, "max_x": (x1 + 1) * tile - 1,
                    "min_y": y0 * tile, "max_y": (y1 + 1) * tile - 1,
                    "GATE_TILES": (x0, y0, x1, y1)})
    return out


def lobby_band(grid: list[str], tile: int, gates: list[dict[str, object]]) -> dict[str, int]:
    """`LOBBY_TOP` / `LOBBY_BOT`: the floor rows below the gates -- the waiting room.

    Emitted for the same reason `PIT_TOP`/`PIT_BOT` are: the renderer frames on it.
    `docs/architecture/17-fullscreen-spec.md` 1.1 builds `VIEW_LOBBY` as this band plus
    208 units of masonry above it and 80 below, and its own self-check asserts the frame
    still lands on `LOBBY_BOT + 1`. Without this pair the browser would retype 640/1008
    beside a map that owns them, which is the one defect this whole tool exists to stop.

    Not a movement rule. The lobby *box* is `PIT_BOT + 1 ..= MAP_MAX_XY`
    (`player::zone_box`) and is wider than this: it includes the gate rows and the
    border ring. This is only where the floor is drawn.
    """
    last_gate_row = max(g["GATE_TILES"][3] for g in gates)
    rows = [y for y in range(last_gate_row + 1, len(grid))
            if any(c != WALL for c in grid[y])]
    if not rows:
        die("no floor row below the gates -- there is no lobby for players to wait in")
    return {"LOBBY_TOP": rows[0] * tile, "LOBBY_BOT": (rows[-1] + 1) * tile - 1,
            "LOBBY_ROWS": (rows[0], rows[-1])}


def gate_rows(gates: list[dict[str, object]]) -> set[int]:
    """Every tile row a gate block occupies."""
    return {y for g in gates for y in range(g["GATE_TILES"][1], g["GATE_TILES"][3] + 1)}


def rooms_gates(tile: int) -> list[tuple[int, int, int, int]] | None:
    """`LOBBY_GATES` out of rooms.gen.ts as `(x0, y0, x1, y1)` tiles, by tier; `None` when
    the file does not exist yet (a fresh clone runs gen_rooms.py first, and gen_rooms.py
    itself is what writes it)."""
    if not ROOMS_TS.exists():
        return None
    m = re.search(r"export const LOBBY_GATES[^=]*=\s*\[(.*?)\];", ROOMS_TS.read_text(), re.S)
    if m is None:
        die(f"{ROOMS_TS.relative_to(ROOT)} no longer exports `LOBBY_GATES` -- re-run "
            "tools/gen_rooms.py")
    rows = re.findall(r"\{\s*x:\s*(\d+),\s*y:\s*(\d+),\s*w:\s*(\d+),\s*h:\s*(\d+),\s*tier:\s*(\d+)\s*\}",
                      m.group(1))
    out = [(int(x) // tile, int(y) // tile, (int(x) + int(w)) // tile - 1, (int(y) + int(h)) // tile - 1)
           for x, y, w, h, tier in sorted(rows, key=lambda r: int(r[4]))]
    if [int(t) for *_, t in sorted(rows, key=lambda r: int(r[4]))] != list(range(len(out))):
        die(f"{ROOMS_TS.relative_to(ROOT)} `LOBBY_GATES` tiers are not 0..n in order")
    return out


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

    # The gate blocks are where `enter_gate` demands the player be standing, one per
    # tier. Walling any of one off is a difficulty no one can pick. The gate is a PORTAL:
    # `enter_gate` teleports the seat to `tick::entrance_for`, so a block owes the map
    # nothing about where it sits relative to the pit -- only that it is floor, that the
    # lobby can walk to it (checked below, inside the lobby box), and that the heart is
    # not on it.
    gates = gate_boxes(grid, tile, g["N_TIERS"])
    for tier, gate in enumerate(gates):
        gx0, gy0, gx1, gy1 = gate["GATE_TILES"]
        for ty in range(gy0, gy1 + 1):
            for tx in range(gx0, gx1 + 1):
                if solid(tx, ty):
                    die(f"gate {tier} tile ({tx}, {ty}) is wall -- no player could ever "
                        "enter_gate through it")
                if (tx, ty) not in seen:
                    die(f"gate {tier} tile ({tx}, {ty}) cannot reach the heart chamber {heart}")

    # The browser draws its gate marks and cuts its portcullises from `LOBBY_GATES`, which
    # gen_rooms.py measured off the painting; the chain admits `GATES`, which this tool
    # reads off the grid gen_rooms.py wrote. Same source, two derivations: a mark over a
    # doorway the chain calls another tier sends the raid to the wrong boss.
    drawn = rooms_gates(tile)
    if drawn is not None and drawn != [gate["GATE_TILES"] for gate in gates]:
        die(f"the `{GATE}` blocks {[gate['GATE_TILES'] for gate in gates]} are not "
            f"{ROOMS_TS.relative_to(ROOT)}'s LOBBY_GATES {drawn} -- re-run tools/gen_rooms.py")

    # `PIT_TOP`/`PIT_BOT` is a *second* kind of barrier, alongside the wall bitboard,
    # and the two can disagree without either one erroring: a player clamped into open
    # floor sees no wall and no message, just a direction that does nothing. Everything
    # below is the guard for that, checked where both facts are still in one place.
    pit = pit_box(grid, tile)
    ptop, pbot = pit["PIT_ROWS"]
    dais = {(x, y) for y, row in enumerate(grid) for x, c in enumerate(row) if c in DAIS_CHARS}

    # The dais has to be one room on its own, not merely reachable *through the air or
    # the lobby*. A raider may only stand on dais tiles, so a pinch in the shaping --
    # the corner rows are the likeliest place -- cannot be walked around, and the whole-map
    # flood above walks straight across the air that a raider cannot.
    start = next(iter(sorted(dais)))
    dais_seen = {start}
    q = deque([start])
    while q:
        x, y = q.popleft()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nb in dais and nb not in dais_seen:
                dais_seen.add(nb)
                q.append(nb)
    if dais_seen != dais:
        die(f"{len(dais) - len(dais_seen)} dais tiles cannot be walked to from the rest "
            "of the dais -- a raider may only stand on the dais, so they cannot go around")

    # Every dais tile has floor over it. The dais narrows upward above its widest row, so
    # each such row's outermost tile has nothing of the dais above it; a player on that
    # tile's top-outer corner -- a tile corner, where every cardinal step lands -- fires
    # every upward shot into whatever the tile above is, and `shoot` tests `is_wall`
    # before any part box. Wall there is a stand from which nothing can be hit: the first
    # whole-dais grid had eight of them, found by `gen_hitboxes.py`'s pit-reach sweep. So
    # the boss's air reaches down past the crest, and this is the row-by-row proof.
    for x, y in sorted(dais):
        if solid(x, y - 1):
            die(f"dais tile ({x}, {y}) has wall directly over it at ({x}, {y - 1}) -- a "
                "raider on its top corner cannot fire upward at all. The boss's air must "
                "reach down to the row above the dais's widest row (tools/gen_rooms.py)")

    # There is deliberately no "the gate sits immediately below the pit and its columns
    # run onto the dais" rule any more. It guarded a freeze that cannot happen: `enter_gate`
    # does not step a seat through the gate, it writes `tick::entrance_for(seat)` -- a
    # dais tile inside the arena box, checked below -- so the gate rows can sit anywhere
    # inside the lobby box (`gy0 > pbot`, the seam test that follows). Three gates cannot
    # all sit under the one stair anyway.
    for tier, gate in enumerate(gates):
        if gate["GATE_TILES"][1] <= pbot:
            die(f"gate {tier} starts on row {gate['GATE_TILES'][1]}, inside the pit rows "
                f"{ptop}..{pbot} -- a lobby seat standing on it would be outside the lobby "
                "box (PIT_BOT + 1 ..= MAP_MAX_XY) and refused every step")

    # The boss stands in the pit band (it is the anchor every hitbox is measured from,
    # and the raid has to be able to reach it) and never on a gate, which would let a
    # player flip zone by standing inside the creature.
    hx, hy = heart
    if not (ptop <= hy <= pbot):
        die(f"the `{HEART}` heart is on row {hy}, outside the pit rows {ptop}..{pbot}")
    for tier, gate in enumerate(gates):
        gx0, gy0, gx1, gy1 = gate["GATE_TILES"]
        if gx0 <= hx <= gx1 and gy0 <= hy <= gy1:
            die(f"the `{HEART}` heart tile {heart} is inside gate block {tier}")

    # Every respawn point lands on the dais, because a respawn is a raider and a raider
    # may only stand on the dais. The `E` marks themselves are not the interesting case --
    # `tick::entrance_for` fans five ranks off each one, and it is a *rank* that drifts
    # off the dais as the doors move. One off it is a seat that respawns onto the air
    # beside the dais, which `move_player` then governs by walls alone (the un-stranding
    # rule) -- legal, but a raider standing where the painting shows no floor.
    doors = entrance_world(grid, tile)
    for seat in range(g["MAX_SEATS"]):
        rx, ry = entrance_for(seat, doors, g)
        if (rx // tile, ry // tile) not in dais:
            die(f"entrance_for({seat}) lands at ({rx}, {ry}), tile "
                f"({rx // tile}, {ry // tile}), which is not a dais tile")

    # -----------------------------------------------------------------------
    # The open-arena rules -- docs/architecture/18-open-arena.md 2 and 6.
    #
    # Everything above proves the map is *playable*. What follows proves it is the
    # map that was drawn. Thirty 2x2 pillars stood in the lobby and every check
    # above passed with them there: they sealed nothing, pinched nothing and moved
    # no constant, so nothing in this tool could see them. These can.
    # -----------------------------------------------------------------------

    # At most ONE contiguous run of floor per row. That single rule is the whole of
    # "no square blocks, no scattered cover tiles, no grid of obstacles": a
    # free-standing block anywhere splits its rows into two runs or more, while the
    # perimeter, the chamfer, the divider and the doorway each leave exactly one.
    # Perimeter architecture, banners, torches, chains, medallions and floor
    # markings are paint on tiles this grid already declares -- never a wall tile.
    #
    # The gate rows are the one exception, by construction: three doorways in one wall
    # are three runs with wall between, and `gate_boxes` above already holds each of
    # them to a solid rectangle -- a stray floor tile on a gate row is a fourth block
    # there, not a cover tile here.
    for y, row in enumerate(grid):
        if y in gate_rows(gates):
            continue
        runs = sum(1 for x, c in enumerate(row)
                   if c != WALL and (x == 0 or row[x - 1] == WALL))
        if runs > 1:
            die(f"row {y} carries {runs} separate runs of floor -- an interior "
                "obstacle splits it. The arena floor is open: perimeter and divider "
                "only, and a decoration may never become a wall tile")

    # Mirror symmetry about the vertical centre line, reading `B` and `E` as the pit
    # terrain they are drawn in. The doors used to sit at cols 10/22/42/54, which is
    # 16 units of respawn offset nobody drew on purpose and which no other check on
    # this page can see -- all four are floor, in the band, and reach the heart.
    for y, row in enumerate(grid):
        flat = row.replace(HEART, PIT).replace(ENTRANCE, PIT)
        if flat != flat[::-1]:
            die(f"row {y} is not symmetric about the vertical centre line:\n"
                f"  {row}\n  {row[::-1]}")
    ecols = {x for x, _ in entrances}
    if {n - 1 - x for x in ecols} != ecols:
        die(f"the respawn doors sit at columns {sorted(ecols)}, which are not mirror "
            f"pairs about {(n - 1) / 2} -- one side of the raid respawns off centre")
    if hx * tile * 2 != n * tile:
        die(f"the `{HEART}` heart is at world x {hx * tile}, not the centre line "
            f"{n * tile // 2} -- the boss must stand top *centre*")

    # Every gate tile is reachable from every lobby spawn WITHOUT leaving the lobby's
    # zone box (`player::zone_box`, `PIT_BOT + 1 ..= MAP_MAX_XY`). The whole-map flood
    # fill above cannot answer this: it walks through the pit, which a `ZONE_LOBBY`
    # seat may not enter. A lobby that cannot reach one of its gates is a difficulty
    # nobody can ever pick. One flood from seat 0's spawn: inside the box the step
    # relation is symmetric, so "seat 0 reaches every spawn and every gate tile" is
    # "every spawn reaches every gate tile".
    lobby_rows = range(pbot + 1, n)
    lobby_open = {(x, y) for y in lobby_rows for x in range(n) if not solid(x, y)}
    lx0, ly0 = lobby_spawn(0, g)
    lobby_seen = {(lx0 // tile, ly0 // tile)}
    q = deque(lobby_seen)
    while q:
        x, y = q.popleft()
        for nb in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if nb in lobby_open and nb not in lobby_seen:
                lobby_seen.add(nb)
                q.append(nb)
    for seat in range(g["MAX_SEATS"]):
        lx, ly = lobby_spawn(seat, g)
        if (lx // tile, ly // tile) not in lobby_seen:
            die(f"lobby_spawn({seat}) at tile ({lx // tile}, {ly // tile}) cannot walk "
                "to the gates without leaving the lobby box -- that seat can never "
                "enter the raid")
    for tier, gate in enumerate(gates):
        gx0, gy0, gx1, gy1 = gate["GATE_TILES"]
        for ty in range(gy0, gy1 + 1):
            for tx in range(gx0, gx1 + 1):
                if (tx, ty) not in lobby_seen:
                    die(f"gate {tier} tile ({tx}, {ty}) cannot be walked to from the lobby "
                        "spawns without leaving the lobby box -- that tier can never be picked")

    # No position in either zone with zero legal moves. `move_player` refuses a step
    # unless `!is_wall(nx, ny) && may_move_to(zone, y, ny) && may_stand_step(..)`, so the
    # wall bitboard, the zone box and the dais table can each remove moves the others
    # left. A position where every one of the eight is refused is a hard freeze with
    # nothing logged anywhere -- the most dangerous defect this map can carry. Replays
    # `player.rs`'s `the_box_never_removes_a_seats_last_legal_move` at the same tile
    # stride, plus the stronger claim that a legal move exists at all. The boss's body
    # (`player::standable`'s other half) is a hitbox fact this tool cannot see; the Rust
    # test is what sweeps it.
    steps = move_steps(g)
    zones = {"ZONE_ARENA": (pit["PIT_TOP"], pit["PIT_BOT"]),
             "ZONE_LOBBY": (pit["PIT_BOT"] + 1, max_xy)}
    wall_at = lambda x, y: (  # noqa: E731 - `player::is_wall`, verbatim
        x < 0 or y < 0 or x // tile >= n or y // tile >= n or solid(x // tile, y // tile))
    for zone, (top, bot) in zones.items():
        over = lambda v: max(top - v, v - bot, 0)  # noqa: E731 - `box_overshoot`
        # `player::standable` less the body: a raider stands on the dais, a lobby seat
        # anywhere its box allows.
        stand = lambda x, y: zone != "ZONE_ARENA" or (x // tile, y // tile) in dais  # noqa: E731
        for ty in range(n):
            for tx in range(n):
                if solid(tx, ty):
                    continue
                x, y = tx * tile, ty * tile
                free = [(dx, dy) for dx, dy in steps if not wall_at(x + dx, y + dy)]
                if not free:
                    die(f"tile ({tx}, {ty}) is floor walled in on all eight steps")
                # `may_move_to` and `may_stand_step`: inside the box and on the dais, or
                # already outside either (stranded seats are governed by walls alone
                # until they walk home).
                if not any((over(y) > 0 or over(y + dy) == 0)
                           and (not stand(x, y) or stand(x + dx, y + dy))
                           for dx, dy in free):
                    die(f"{zone} at ({x}, {y}) -- tile ({tx}, {ty}) -- has no legal "
                        "move: the zone box or the dais removed the last one the walls left")

    floor = sum(row.count(c) for row in grid for c in FLOOR_CHARS)
    if len(seen) != floor:
        die(f"{floor - len(seen)} floor tiles are sealed off from the heart chamber "
            "-- unreachable floor is a drawing mistake, not a secret room")


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------

BANNER = (
    "GENERATED by tools/gen_map.py from assets/map/arena.json. Do not edit.\n"
    "The grid there is written by tools/gen_rooms.py from the room paintings: edit\n"
    "`rooms` in that file, run gen_rooms.py, then re-run this tool."
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
    gates = gate_boxes(grid, g["TILE"], g["N_TIERS"])
    spawn = lobby_spawn_extent(g)
    lobby = lobby_band(grid, g["TILE"], gates)
    ptop, pbot = pit["PIT_ROWS"]
    first_gate_row = min(gate_rows(gates))
    gate_rows_span = f"{first_gate_row}..{max(gate_rows(gates))}"
    gate_body = "\n".join(
        f"    // tier {tier}: tiles ({x0}, {y0})..({x1}, {y1})\n"
        f"    Gate {{ min_x: {gt['min_x']}, max_x: {gt['max_x']}, min_y: {gt['min_y']}, max_y: {gt['max_y']} }},"
        for tier, gt in enumerate(gates)
        for (x0, y0, x1, y1) in [gt["GATE_TILES"]])
    dais_body = "\n".join(
        f"    0x{sum(1 << x for x, c in enumerate(row) if c in DAIS_CHARS):016x}, // y={y:<2}"
        for y, row in enumerate(grid))
    dais_tiles = sum(row.count(c) for row in grid for c in DAIS_CHARS)
    # The boss's air: every row above the gate that carries a `.`, which is rows 1 down to
    # the row above the dais's widest one (tools/gen_rooms.py), and the columns it spans.
    # Both emitted rather than written as `1..PIT_TOP` and `1..MAP_TILES - 1`: the first
    # stopped being true when the dais grew past the boss's feet, the second the moment
    # the side perimeter went to two tiles.
    air_rows = [y for y in range(1, first_gate_row) if FLOOR in grid[y]]
    if air_rows != list(range(air_rows[0], air_rows[-1] + 1)):
        die(f"the boss's air is not one band of rows: {air_rows}")
    air_y0, air_y1 = air_rows[0], air_rows[-1]
    air = [x for y in air_rows for x, c in enumerate(grid[y]) if c != WALL]
    air_x0, air_x1 = min(air), max(air)
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
/// Layout, top to bottom. Open floor for the boss's air, with the whole painted dais
/// laid over its lower rows -- the raid stands on the dais ([`DAIS`]) and the creature
/// stands on it too, in the middle of the band -- then the three gate blocks in the wall
/// under it ([`GATES`], one per difficulty tier), then the painted lobby floor. The whole
/// vertical order is the fight: you walk up the lobby, pick a gate, and the gate puts you
/// on the dais to walk the circle around the creature.
///
/// Both rooms are open floor with zero interior obstacles. `tools/gen_map.py` holds
/// them that way: at most one contiguous run of floor per row, so a free-standing
/// block anywhere splits a row and is refused -- the gate rows excepted, whose three
/// runs are the three doorways, each held to a solid rectangle. Perimeter architecture,
/// banners, torches, chains and floor markings are paint, never wall tiles.
///
/// The rows above the dais's widest row are floor wherever they are not dais, and that
/// is load-bearing rather than lazy drawing -- see [`DAIS`] and [`PIT_TOP`].
pub const WALLS: [u64; MAP_TILES] = [
{body}
];

/// Dais bitboard: bit *x* of row *y* set means a `ZONE_ARENA` seat may stand on tile
/// (x, y). The `P`, `E` and `B` tiles of the drawn grid -- the painted platform ellipse
/// and its stairs, {dais_tiles} tiles -- and a strict subset of the floor in [`WALLS`]
/// (const-asserted below).
///
/// A second table because the two barriers answer different questions. `WALLS` is what
/// stops a RAY: `shoot`'s raycast tests it before any part box, so a wall tile between a
/// stand and the boss kills every shot in that column. This is what stops a STEP:
/// `handlers::player::standable` refuses a raider a destination off it. They differ
/// exactly where the dais narrows upward: above its widest row every row's outermost tile
/// has no dais over it, and a raider on that tile's top corner fires every upward shot into
/// the tile above. Wall there was a stand from which nothing could be hit -- eight of them
/// on the first whole-dais grid, found by `gen_hitboxes.py`'s sweep -- so the tile above
/// is the boss's air: floor for the ray, off the dais for the step. Before the dais grew
/// past the boss's feet the y band [`PIT_TOP`]`..=`[`PIT_BOT`] was the whole of this rule.
///
/// Costs {n * 8} more bytes of .so and, like `WALLS`, zero account keys.
pub const DAIS: [u64; MAP_TILES] = [
{dais_body}
];

/// The four `E` marks on the drawn map, in world units at the tile's top-left corner --
/// the same convention `handlers::player::LOBBY_ENTRANCE` and [`GATES`] are written
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
/// open rows above the dais are the only space on the grid tall enough to hold them.
///
/// It is the creature's feet line, on the dais's own tiles: the boss is drawn upward
/// from here, so the creature fills the top of the frame, and the raid walks the dais
/// around it -- `handlers::player` refuses a step into the body, folded out of the
/// hitbox table, so the pit needs no hole cut where the boss stands. The assertion
/// block at the bottom of this file proves it is on the dais, inside
/// `PIT_TOP..=PIT_BOT`, and outside the gate.
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
/// with nothing logged anywhere. The band holds the lobby below the rim and is the coarse
/// half of the raider's rule; [`DAIS`] is the fine half, tile by tile, since the boss's
/// air now reaches down beside the dais's shoulders. Barriers that can disagree --
/// `tools/gen_map.py` proves the dais is one connected room and that the gate walks onto
/// it, which is the only guard against a rule that boxes someone in open floor.
pub const PIT_TOP: i16 = {pit["PIT_TOP"]}; // tile row {ptop}
pub const PIT_BOT: i16 = {pit["PIT_BOT"]}; // tile row {pbot}, last unit

/// One gate block, in world units, both edges inclusive -- the form `handlers::player`
/// compares a seat's `(x, y)` against.
#[derive(Clone, Copy)]
pub struct Gate {{
    pub min_x: i16,
    pub max_x: i16,
    pub min_y: i16,
    pub max_y: i16,
}}

impl Gate {{
    /// Is this world point inside the block? Two range tests, which is why the generator
    /// holds every drawn block to a solid rectangle.
    pub const fn contains(&self, x: i16, y: i16) -> bool {{
        x >= self.min_x && x <= self.max_x && y >= self.min_y && y <= self.max_y
    }}
}}

/// The gate blocks `enter_gate` demands the player be standing in, compiled from the
/// separate `G` blocks on rows {gate_rows_span} -- left to right, so the index IS the
/// difficulty tier (`state::TIER_EASY..=TIER_HARD`) and `state::N_TIERS` is the length.
///
/// The gate is a portal, not a corridor: `enter_gate` writes `tick::entrance_for(seat)`,
/// so a block owes the pit no adjacency and the three can sit anywhere in the lobby's
/// top wall. What the generator does prove is that each is a solid rectangle of floor
/// inside the lobby box, reachable from every lobby spawn without leaving it, that the
/// three do not share a column, and that the heart stands on none of them -- the last
/// re-proved below on every `cargo check`, against the table that shipped.
///
/// These were four hand literals in `handlers::player` that `gen_map.py` parsed back out
/// of Rust source to validate against the drawn grid: one fact stored twice, with the
/// tool agreeing with whichever copy it read.
pub const GATES: [Gate; {len(gates)}] = [
{gate_body}
];

/// Which gate this world point stands in, as its tier, or `None` off every gate. The
/// predicate `enter_gate` runs; `packages/client/src/map.ts` mirrors it as `gateAt`.
pub const fn gate_at(x: i16, y: i16) -> Option<u8> {{
    let mut tier = 0;
    while tier < GATES.len() {{
        if GATES[tier].contains(x, y) {{
            return Some(tier as u8);
        }}
        tier += 1;
    }}
    None
}}

/// The x span `handlers::player::lobby_spawn` fans the seats across, and their shared row.
///
/// Emitted so the client's lobby camera can frame every spawn instead of guessing. Seat 0
/// sits `MAX_SEATS / 2` spacings left of `LOBBY_ENTRANCE`, which a gate-centred camera
/// cropped off screen -- and seat 0 is what the first player to join always gets.
pub const LOBBY_SPAWN_MIN_X: i16 = {spawn["LOBBY_SPAWN_MIN_X"]};
pub const LOBBY_SPAWN_MAX_X: i16 = {spawn["LOBBY_SPAWN_MAX_X"]};
pub const LOBBY_SPAWN_Y: i16 = {spawn["LOBBY_SPAWN_Y"]};

/// The lobby floor band: the drawn floor rows below the gate ({lobby["LOBBY_ROWS"][0]}..{lobby["LOBBY_ROWS"][1]}), in world
/// units, `LOBBY_BOT` inclusive of the last row's last unit exactly as [`PIT_BOT`] is.
///
/// A *drawing* fact, not a movement rule -- `player::zone_box` holds a `ZONE_LOBBY` seat
/// in `PIT_BOT + 1 ..= MAP_MAX_XY`, which is wider: it also covers the gate rows and the
/// border ring. Emitted because the renderer frames on the floor, not on the box:
/// `docs/architecture/17-fullscreen-spec.md` 1.1 builds `VIEW_LOBBY` as this band plus 208
/// units of masonry above and 80 below, and its self-check asserts the frame still lands
/// on `LOBBY_BOT + 1`. Retyping 640/1008 in the browser beside a map that owns them is the
/// drift this generator exists to prevent.
pub const LOBBY_TOP: i16 = {lobby["LOBBY_TOP"]}; // tile row {lobby["LOBBY_ROWS"][0]}
pub const LOBBY_BOT: i16 = {lobby["LOBBY_BOT"]}; // tile row {lobby["LOBBY_ROWS"][1]}, last unit

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
        assert!(
            DAIS[ty] & (1u64 << tx) != 0,
            "an entrance in map::ENTRANCES is off the dais -- a raider would respawn onto \\
             the boss's air",
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

    // The dais is floor, row by row, and nothing on the dais has wall directly over it:
    // one AND per row each. The first is what lets `standable` skip the wall test's
    // work; the second is the pocket `gen_hitboxes.py`'s sweep found -- a raider on a
    // shoulder tile's top corner whose every upward shot died on the cap above it.
    let mut y = 1;
    while y < MAP_TILES {{
        assert!(
            DAIS[y] & WALLS[y] == 0,
            "a dais tile is a wall -- re-run tools/gen_map.py",
        );
        assert!(
            DAIS[y] & WALLS[y - 1] == 0,
            "a dais tile has wall directly over it: every upward shot from its top corner \\
             dies there -- the boss's air must reach down past it (tools/gen_rooms.py)",
        );
        y += 1;
    }}
    assert!(DAIS[0] == 0, "the top border row is dais");

    // The pit band is non-empty and sits inside the map.
    assert!(PIT_TOP >= 0 && PIT_TOP < PIT_BOT && PIT_BOT < (MAP_TILES as i16) * TILE);

    // The boss is reachable by a raider: its anchor is inside the band they are clamped
    // to and on the dais they walk. A boss above `PIT_TOP` would be a target no one can
    // ever stand level with.
    assert!(
        by >= PIT_TOP && by <= PIT_BOT,
        "map::BOSS_SPAWN is outside PIT_TOP..=PIT_BOT -- the raid is clamped away from \\
         its own boss; redraw assets/map/arena.json and re-run tools/gen_map.py",
    );
    assert!(
        DAIS[(by / TILE) as usize] & (1u64 << (bx / TILE)) != 0,
        "map::BOSS_SPAWN is off the dais -- the raid can never walk up to its own boss",
    );

    // The gates: one per tier, each a real block, in tier order left to right, every one
    // inside the lobby box -- a lobby seat standing on a gate row inside the pit rows
    // would be outside `PIT_BOT + 1 ..= MAP_MAX_XY` and refused every step -- and above
    // the painted lobby floor the browser frames on. And the boss stands on none of
    // them, which would let a player flip zone by walking into the creature: the
    // assertion the four `GATE_*` literals in `handlers::player` could never carry, since
    // it needs both facts to come out of one grid.
    assert!(GATES.len() == crate::state::N_TIERS, "one gate per difficulty tier");
    let mut tier = 0;
    while tier < GATES.len() {{
        let gate = GATES[tier];
        assert!(gate.min_x <= gate.max_x && gate.min_y <= gate.max_y);
        assert!(
            gate.min_y > PIT_BOT && gate.max_y < LOBBY_TOP,
            "a gate is not between the pit and the lobby floor -- re-run tools/gen_map.py",
        );
        assert!(tier == 0 || GATES[tier - 1].max_x < gate.min_x, "gates are tiers, left to right");
        assert!(!gate.contains(bx, by), "map::BOSS_SPAWN is inside a gate block");
        tier += 1;
    }}
    assert!(gate_at(bx, by).is_none());

    // The waiting room the browser frames on is the floor under the gates, and every
    // seat it fans out stands on that floor.
    //
    // These four constants exist only for the renderer -- `VIEW_LOBBY` is
    // `LOBBY_TOP..=LOBBY_BOT` plus masonry, and `LOBBY_SPAWN_MIN_X..MAX_X` is what has to
    // be inside it -- so nothing on the chain would ever notice them drifting. That is
    // exactly why the check is here: a hand-edit of this generated file, which the banner
    // at the top forbids and someone will do anyway, shows up as a knight standing
    // outside its own frame with no error anywhere.
    assert!(
        LOBBY_TOP < LOBBY_BOT && LOBBY_BOT < (MAP_TILES as i16) * TILE,
        "the lobby floor band is empty or off the map -- re-run tools/gen_map.py",
    );
    assert!(
        LOBBY_SPAWN_MIN_X <= LOBBY_SPAWN_MAX_X
            && LOBBY_SPAWN_Y >= LOBBY_TOP
            && LOBBY_SPAWN_Y <= LOBBY_BOT,
        "the lobby spawn row is outside the lobby floor band -- the browser would frame \\
         the waiting room on floor the seats do not stand on",
    );
    // The two seats at the ends of the fan -- the only two this file names, and the pair
    // the frame is built out of. The other eighteen are swept by the generator.
    assert!(
        WALLS[(LOBBY_SPAWN_Y / TILE) as usize]
            & ((1u64 << (LOBBY_SPAWN_MIN_X / TILE)) | (1u64 << (LOBBY_SPAWN_MAX_X / TILE)))
            == 0,
        "an outermost lobby spawn stands in a wall -- redraw assets/map/arena.json and \\
         re-run tools/gen_map.py",
    );
}};

#[cfg(test)]
mod tests {{
    use super::*;

    const fn solid(tx: usize, ty: usize) -> bool {{
        tx >= MAP_TILES || ty >= MAP_TILES || WALLS[ty] & (1u64 << tx) != 0
    }}

    fn floor(tx: usize, ty: usize) -> bool {{
        !solid(tx, ty)
    }}

    fn dais(tx: usize, ty: usize) -> bool {{
        tx < MAP_TILES && ty < MAP_TILES && DAIS[ty] & (1u64 << tx) != 0
    }}

    /// 4-connected flood fill from the boss tile over the tiles `open` admits, confined
    /// to tile rows `top..=bot`.
    ///
    /// 4- and not 8-connected on purpose: movement is 8-way but only tests the
    /// destination tile, so a diagonal can squeeze past a corner. Accepting that here
    /// would sign off on passages that exist by accident.
    ///
    /// Relaxed to a fixpoint rather than queued, so it allocates nothing: 64x64 is four
    /// thousand tiles and this is a test.
    fn reachable(top: usize, bot: usize, open: fn(usize, usize) -> bool) -> [[bool; MAP_TILES]; MAP_TILES] {{
        let mut seen = [[false; MAP_TILES]; MAP_TILES];
        seen[(BOSS_SPAWN.1 / TILE) as usize][(BOSS_SPAWN.0 / TILE) as usize] = true;
        let mut changed = true;
        while changed {{
            changed = false;
            for ty in top..=bot {{
                for tx in 0..MAP_TILES {{
                    if seen[ty][tx] || !open(tx, ty) {{
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
        let seen = reachable(0, MAP_TILES - 1, floor);
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

    /// The dais is one room *on its own terms*. A raider may only stand on dais tiles,
    /// so a pinch in the shaping cannot be walked around through the air the way
    /// [`every_floor_tile_is_one_room`] would let you. The two are not the same test,
    /// and this is the one that catches a shaped dais cut in half.
    #[test]
    fn the_dais_is_one_room_a_raider_can_cross() {{
        let (top, bot) = ((PIT_TOP / TILE) as usize, (PIT_BOT / TILE) as usize);
        let seen = reachable(top, bot, dais);
        let mut tiles = 0usize;
        for ty in 0..MAP_TILES {{
            for tx in 0..MAP_TILES {{
                if dais(tx, ty) {{
                    tiles += 1;
                    assert!(ty >= top && ty <= bot, "dais tile ({{tx}}, {{ty}}) is outside the band");
                    assert!(seen[ty][tx], "dais tile ({{tx}}, {{ty}}) is cut off from the boss");
                }}
            }}
        }}
        assert_eq!(tiles, {dais_tiles}, "the drawn dais changed size");
    }}

    /// Every respawn door is on the dais, inside the pit band. A raider respawned off it
    /// is a seat governed by walls alone until it walks onto the dais, standing where the
    /// painting shows no floor, with nothing logged.
    #[test]
    fn every_door_is_on_the_dais() {{
        for (x, y) in ENTRANCES {{
            assert!(
                y >= PIT_TOP && y <= PIT_BOT,
                "entrance ({{x}}, {{y}}) is outside PIT_TOP..=PIT_BOT",
            );
            assert!(dais((x / TILE) as usize, (y / TILE) as usize));
        }}
    }}

    /// Every gate block is walkable end to end, with wall on both sides of it on every one
    /// of its rows, and `gate_at` answers its own tier on every unit of it and nothing on
    /// the wall beside it. Walling any of a block is a tier nobody can pick; a block that
    /// runs into its neighbour is two tiers `gate_at` cannot tell apart.
    #[test]
    fn every_gate_is_a_walled_block_that_names_its_tier() {{
        for (tier, gate) in GATES.iter().enumerate() {{
            for ty in (gate.min_y / TILE)..=(gate.max_y / TILE) {{
                for tx in (gate.min_x / TILE)..=(gate.max_x / TILE) {{
                    assert!(!solid(tx as usize, ty as usize), "gate {{tier}} tile ({{tx}}, {{ty}}) is wall");
                    assert_eq!(gate_at(tx * TILE, ty * TILE), Some(tier as u8));
                    assert_eq!(gate_at(tx * TILE + TILE - 1, ty * TILE + TILE - 1), Some(tier as u8));
                }}
                assert!(solid((gate.min_x / TILE - 1) as usize, ty as usize), "gate {{tier}} is open to the west");
                assert!(solid((gate.max_x / TILE + 1) as usize, ty as usize), "gate {{tier}} is open to the east");
                assert_eq!(gate_at(gate.min_x - 1, ty * TILE), None);
                assert_eq!(gate_at(gate.max_x + 1, ty * TILE), None);
            }}
            assert_eq!(gate_at(gate.min_x, gate.min_y - 1), None);
            assert_eq!(gate_at(gate.min_x, gate.max_y + 1), None);
        }}
    }}

    /// The boss's air is open floor. `handlers::shoot`'s raycast tests `is_wall` before
    /// the part rectangles, so one wall tile between a stand and the boss kills every
    /// shot in that column -- a raid that cannot be won, reporting nothing. The air is
    /// held off the raid by `DAIS`, a movement rule, and this is the test that keeps it
    /// from becoming wall the next time someone redraws the grid.
    ///
    /// Both spans are generated -- rows {air_y0}..={air_y1}, columns {air_x0}..={air_x1} --
    /// rather than written as `1..PIT_TOP` and `1..MAP_TILES - 1`: the first form stopped
    /// being true when the dais grew past the boss's feet and the air had to reach down
    /// beside its shoulders, the second the moment the side perimeter was drawn two
    /// tiles thick.
    #[test]
    fn the_boss_air_is_open() {{
        for ty in {air_y0}..={air_y1} {{
            for tx in {air_x0}..={air_x1} {{
                assert!(
                    !solid(tx, ty),
                    "tile ({{tx}}, {{ty}}) is wall in the boss's air -- every shot in that \\
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
    gates = gate_boxes(grid, g["TILE"], g["N_TIERS"])
    spawn = lobby_spawn_extent(g)
    lobby = lobby_band(grid, g["TILE"], gates)
    ptop, pbot = pit["PIT_ROWS"]
    gate_rows_span = f"{min(gate_rows(gates))}..{max(gate_rows(gates))}"
    gate_body = "\n".join(
        f"  // tier {tier}: tiles ({x0}, {y0})..({x1}, {y1})\n"
        f"  {{ minX: {gt['min_x']}, maxX: {gt['max_x']}, minY: {gt['min_y']}, maxY: {gt['max_y']} }},"
        for tier, gt in enumerate(gates)
        for (x0, y0, x1, y1) in [gt["GATE_TILES"]])
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
 * Everything but `#` is floor to a ray. A raider stands only on the dais -- `P`, `E`,
 * `B`, see {{@link isDaisTile}} -- and the `.` rows and shoulders around it are the boss's
 * air. A renderer that keys off `.` alone will draw the pit and the gate as holes.
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
 * the chain's raycast dies on any wall tile between a player and the boss. The band is
 * the coarse half of that rule; {{@link onDais}} is the fine half.
 */
export const PIT_TOP = {pit["PIT_TOP"]};
export const PIT_BOT = {pit["PIT_BOT"]};

/** One gate block in arena-space units, both edges inclusive -- `map::Gate`. */
export interface Gate {{
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}}

/**
 * The gate blocks `enter_gate` demands the player be standing in -- the separate drawn `G`
 * blocks on rows {gate_rows_span}, left to right, so the index IS the difficulty tier
 * (`TIER_EASY..=TIER_HARD` in layout.ts) and the length is `N_TIERS`. The exact numbers
 * `map::GATES` holds on the chain, out of the same grid; `rooms.gen.ts`'s `LOBBY_GATES`
 * are the same blocks as the painting measured them, cross-checked by `gen_map.py`.
 *
 * The lobby's gate glow keys off the *predicted* local position against these blocks, so
 * it lights the instant you step on rather than a round trip later; the `enter_gate`
 * transaction still goes through the authoritative poll.
 */
export const GATES: readonly Gate[] = [
{gate_body}
];

/**
 * The x span `handlers::player::lobby_spawn` fans the seats across, and their shared row.
 *
 * The lobby camera frames THIS, not just the gate: seat 0 sits `MAX_SEATS / 2` spacings
 * left of the entrance, and a gate-centred camera showed x 256..768 while seat 0 stood at
 * 208 -- the first player to join could not see their own knight.
 */
export const LOBBY_SPAWN_MIN_X = {spawn["LOBBY_SPAWN_MIN_X"]};
export const LOBBY_SPAWN_MAX_X = {spawn["LOBBY_SPAWN_MAX_X"]};
export const LOBBY_SPAWN_Y = {spawn["LOBBY_SPAWN_Y"]};

/**
 * The lobby floor band: the drawn floor rows below the gate (tile rows {lobby["LOBBY_ROWS"][0]}..{lobby["LOBBY_ROWS"][1]}), in
 * arena-space units, `LOBBY_BOT` inclusive of the last row's last unit exactly as
 * {{@link PIT_BOT}} is.
 *
 * A drawing fact, not a movement rule -- a `ZONE_LOBBY` seat is held in
 * `PIT_BOT + 1 ..= MAP_MAX_XY`, which also covers the gate rows and the border ring. This
 * is what the waiting room is framed on: `VIEW_LOBBY` is this band plus 208 units of
 * masonry above and 80 below (spec 1.1), so the frame moves when the map is redrawn
 * instead of drifting off a hardcoded 640/1008.
 */
export const LOBBY_TOP = {lobby["LOBBY_TOP"]};
export const LOBBY_BOT = {lobby["LOBBY_BOT"]};

/**
 * Which gate this arena-space point stands in, as its tier, or `null` off every gate --
 * `map::gate_at`, the predicate `enter_gate` runs, byte for byte.
 */
export function gateAt(x: number, y: number): number | null {{
  for (let tier = 0; tier < GATES.length; tier++) {{
    const g = GATES[tier]!;
    if (x >= g.minX && x <= g.maxX && y >= g.minY && y <= g.maxY) return tier;
  }}
  return null;
}}

/** Is this arena-space point inside any gate block? {{@link gateAt}} for callers that light a floor. */
export function onGate(x: number, y: number): boolean {{
  return gateAt(x, y) !== null;
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

/**
 * May a raider stand on this tile? The `P`, `E` and `B` tiles -- the painted platform and
 * its stairs -- exactly the bits of the chain's `map::DAIS`. Off-map is not dais.
 *
 * A second question from the same grid, because the two barriers differ: a `.` tile
 * inside the pit rows is the boss's air beside the dais's shoulders -- floor to the
 * chain's raycast (a wall there was a stand from which every upward shot died) and off
 * limits to a step. `handlers::player::standable` refuses a raider a destination off the
 * dais, and prediction mirrors it through {{@link onDais}}.
 */
export function isDaisTile(tx: number, ty: number): boolean {{
  if (tx < 0 || ty < 0 || tx >= MAP_TILES || ty >= MAP_TILES) return false;
  const c = MAP_GRID[ty]![tx];
  return c === 'P' || c === 'E' || c === 'B';
}}

/** Is the tile containing this arena-space point dais? `handlers::player::on_dais`, byte for byte. */
export function onDais(x: number, y: number): boolean {{
  if (x < 0 || y < 0) return false;
  return isDaisTile(Math.floor(x / MAP_TILE), Math.floor(y / MAP_TILE));
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
    gates = gate_boxes(grid, g["TILE"], g["N_TIERS"])
    (gx0, gy0, gx1, gy1) = gates[0]["GATE_TILES"]
    (hx0, _, hx1, _) = gates[-1]["GATE_TILES"]
    (ptop, pbot) = pit_box(grid, g["TILE"])["PIT_ROWS"]
    lobby_last = lobby_band(grid, g["TILE"], gates)["LOBBY_ROWS"][1]
    # The dais's outermost tile on its widest row: the tile above it is air, not dais.
    shoulder = min((x, y) for y, row in enumerate(grid) for x, c in enumerate(row)
                   if c in DAIS_CHARS and grid[y - 1][x] == FLOOR)
    cases = {
        "entrance erased": poke(grid, ex0, ey0, PIT),
        "fifth entrance": poke(grid, ex0, ey0 - 1, ENTRANCE),
        "spawn in a wall": poke(grid, rx // g["TILE"], ry // g["TILE"], WALL),
        # A `.` on a gate row is refused as a block that is not a rectangle (the `G`s
        # beside it are still one component), not by the one-run rule that skips the
        # gate rows -- so this is also the proof that skipping them lost nothing.
        "gate corner erased": poke(grid, gx1, gy1, FLOOR),
        "gate corner walled": poke(grid, gx0, gy0, WALL),
        # Two doorways fused into one wide block: the wall between tiers 0 and 1 drawn as
        # gate. Two blocks where the tables have three rows.
        "two gates fused": [
            r if y not in (gy0, gy1) else
            r[:gx1 + 1] + GATE * (gates[1]["GATE_TILES"][0] - gx1 - 1) + r[gates[1]["GATE_TILES"][0]:]
            for y, r in enumerate(grid)
        ],
        # A fourth doorway, walled off from the others: the tables have no fourth row.
        "a fourth gate": poke(poke(grid, gx0 - 2, gy0, GATE), gx0 - 2, gy1, GATE),
        # Still three blocks, but two of them share a column, one above the other (the
        # HARD doorway walled up, a copy of the EASY one drawn two rows under it on the
        # lobby floor): no left-to-right order names a tier.
        "gates stacked": [
            r if y not in (gy0, gy1, gy1 + 2)
            else r[:hx0] + WALL * (hx1 - hx0 + 1) + r[hx1 + 1:] if y in (gy0, gy1)
            else r[:gx0] + GATE * (gx1 - gx0 + 1) + r[gx1 + 1:]
            for y, r in enumerate(grid)
        ],
        "doorway sealed": [
            r if y != pbot else WALL * n for y, r in enumerate(grid)
        ],
        "stray pit tile in the lobby": poke(grid, gx0, n - 2, PIT),
        "boss out of the pit": poke(poke(grid, *heart_point(grid), PIT), 32, ptop - 1, HEART),
        # The pocket: wall over the dais's outermost tile on a row where it narrows
        # upward. Both shoulders, so the mirror rule is not what refuses it.
        "a lid over the dais's shoulder": poke(
            poke(grid, shoulder[0], shoulder[1] - 1, WALL), n - 1 - shoulder[0], shoulder[1] - 1, WALL),
        "a respawn rank on the air": poke(poke(grid, rx // g["TILE"], ry // g["TILE"], FLOOR),
                                          n - 1 - rx // g["TILE"], ry // g["TILE"], FLOOR),
        "border breached": poke(grid, n // 2, 0, FLOOR),
        "heart deleted": poke(grid, *heart_point(grid), PIT),
        "row too short": [grid[0][:-1]] + grid[1:],
        # The three below are the open-arena rules. The first is the pillar grid in
        # miniature: one tile of cover, blocking nothing, sealing nothing, moving no
        # constant -- accepted by every check this tool had before it.
        # On the lobby's last FLOOR row, read off the band: the painting's foot is wall
        # already, and a cover tile poked onto wall is no cover tile.
        "a cover tile in the open lobby": poke(
            poke(grid, n // 2, lobby_last, WALL), n - 1 - n // 2, lobby_last, WALL),
        "a respawn door off the centre line": poke(
            poke(grid, ex0, ey0, PIT), ex0 + 1, ey0, ENTRANCE),
        "the gate cut off from the lobby": [
            r if y != gy1 + 1 else WALL * n for y, r in enumerate(grid)
        ],
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

    outputs = ((OUT_RS, emit_rust(grid, g)), (OUT_TS, emit_ts(grid, g)))
    check = "--check" in sys.argv
    if check:
        # The same drift test `gen_hitboxes` and `gen_errors` have: a hand edit to either
        # mirror, or a grid regenerated and not recompiled, exits 1 here instead of being
        # silently overwritten by the "check" that was supposed to catch it.
        stale = [p.relative_to(ROOT) for p, text in outputs if not p.exists() or p.read_text() != text]
        if stale:
            print(f"gen_map: stale: {', '.join(map(str, stale))}; re-run without --check", file=sys.stderr)
            return 1
    else:
        for p, text in outputs:
            p.write_text(text)
    walls = sum(row.count(WALL) for row in grid)
    total = g["MAP_TILES"] ** 2
    print(f"gen_map: {g['MAP_TILES']}x{g['MAP_TILES']}, {walls} wall / {total - walls} floor")
    verb = "matches" if check else "wrote"
    print(f"gen_map: {verb} {OUT_RS.relative_to(ROOT)}")
    print(f"gen_map: {verb} {OUT_TS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
