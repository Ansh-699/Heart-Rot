#!/usr/bin/env python3
"""Compile the two room paintings into the map grid, the room PNGs and `rooms.gen.ts`.

    python3 tools/gen_rooms.py            # rewrites every output below
    python3 tools/gen_rooms.py --check    # regenerates in memory; exit 1 on drift

Inputs, hand-authored:
    assets/rooms/lobby.png, assets/rooms/arena.png   the reference paintings, verbatim
    assets/map/arena.json  `rooms`                   the shapes measured off them, in PIXELS

Outputs, never hand-edited:
    assets/map/arena.json  `grid`                    the ASCII map `gen_map.py` compiles
    app/src/render/rooms/{lobby,arena,gate0..2}.png  the copies Vite hashes under /assets/
                                                     (served immutable, never base64): the
                                                     lobby and its doorways true colour, the
                                                     demon-less arena on a 256 palette (COLOURS)
    app/src/render/rooms.gen.ts                      where each painting sits, in world units
    docs/art/rooms/overlay-{lobby,arena}.png         the grid over the paintings: the human check

WHY THE GRID IS GENERATED. The rooms are paintings now, and the one rule the chain and
the renderer share is that the painted floor is SET-EQUAL to the walkable tiles: a tile
under paint that is wall is a step the browser draws and the chain refuses (reads as lag),
a walkable tile under painted wall is a knight standing in masonry. Hand-drawing the grid
against a painting is the same fact stored twice, so the grid is derived from the shapes
measured off the paintings and nothing else. Edit `rooms`, re-run, then `gen_map.py`.

THE TWO TRANSFORMS, derived from each painting's own size so a higher-resolution source
with its `_px` fields re-measured is a drop-in:

  arena  1 px = 1 unit (`ARENA_UNITS_PER_PX`). The arena painting is the boss's sprite
         source: `gen_boss.py` cuts `boss_crop_px` out of it and `gen_hitboxes.py --scale 1`
         raycasts it, with `BOSS_ANCHOR = -(w/2, h/2)` -- pixels ARE units there, so they
         are units here too, or the rig lifts off the paint it sits on. Anchored by the
         boss tile: the crop's centre (the creature's feet line, which is why gen_boss pads
         the crop's height) lands on `BOSS_SPAWN`, and the painting is centred in x. Its
         bottom edge is then the pit RIM: the last pit row, the gate rows and the lobby's
         first row all follow from it, and the first pit row from the dais's crest, which
         is how one authored tile fixes every row.

         The SERVED arena painting has the demon painted out (`bossless`). The rig
         (`Boss.tsx`) is the only demon on screen: a destroyed part is removed and the wall
         and dais show through the hole, which they cannot while the painting underneath
         still carries the living limb. `assets/rooms/arena.png` itself stays verbatim --
         it is what `gen_boss.py` cuts the rig out of, and cutting from the filled copy
         would be a rig of cloned floor.

  lobby  fitted to the room's HEIGHT, `ROOM_H = LOBBY_HEAD + lobby band + LOBBY_FOOT`
         (the head and foot are read out of `viewport.ts`), top edge on `VIEW_LOBBY.y`,
         centred in x. The BAND -- how many floor rows the lobby has -- is the painting's
         own proportion: the rows its floor spans once head and foot are tile counts, so
         `band = floor_h * (head + foot) / (image_h - floor_h)`, which the authored painting
         is padded to make a whole number (the shipped one: 425 px of floor in 1086 rows
         with head 20 and foot 5 is 16 rows, 1695 px wide is 1024 units -- the frame's
         width exactly). The painted floor must then land on exactly those rows --
         checked, because a wrong head is a floor that starts a row early.

WALKABLE. A tile is floor when at least `COVER` of its 16 x 16 world area maps inside the
shape (pit: the WHOLE platform ellipse or the stairs; lobby: the UNION of `floor_px` -- a
list, because the stalls, the pen and the tent along the lobby's walls are furniture a
knight must not walk through and one rectangle cannot both reach the outer gates and
stop short of them; gate: each doorway's x-span on the gate rows), sampled `SUB` x `SUB`.
Then mirror-symmetrised -- a tile is floor only if its mirror about the centre line is
too -- so a measurement a pixel off centre cannot ship an asymmetric arena. The boss's
body is not cut out of the pit here: it is a movement barrier in `player.rs` (the fold of
the hitbox table), never a wall, because a wall tile kills every ray in its column.
Everything else `gen_map.py` already proves (reachability, one run per row, spawn fans,
every gate reachable from every lobby spawn) is left to it.

THREE GATES. `gates_px` names the three doorways left to right, tier 0..2 (EASY, MEDIUM,
HARD): each is a separate `G` block on the gate rows with wall between, which is how
`gen_map.py` tells them apart and `enter_gate` reads the tier off the block the seat
stands in. The gate is a PORTAL -- `enter_gate` teleports to an arena entrance -- so no
gate needs to sit under the stairs; what each needs is lobby floor under it.

LIGHT. `lights_px` marks the painted torches and braziers; the renderer hangs a static
glow under each and flickers it in CSS. Their colours are read off the paint here (the
brightest tenth of a small window at the flame) rather than typed, as are the tier
colours the gate marks wear (`LOBBY_GATE_COLORS`, the light each doorway's bars already
carry), so a repaint moves the glow with it.
"""

from __future__ import annotations

import colorsys
import io
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

try:
    import cv2
except ImportError:  # pragma: no cover - the one-line fix is the message
    sys.exit("gen_rooms: needs OpenCV for the bossless arena: python3 -m pip install --user opencv-python-headless")

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_boss  # noqa: E402  the boss silhouette, so the fill's mask IS the rig's cut

ROOT = Path(__file__).resolve().parent.parent
MAP_JSON = ROOT / "assets" / "map" / "arena.json"
VIEWPORT_TS = ROOT / "app" / "src" / "render" / "viewport.ts"
OUT_PNG_DIR = ROOT / "app" / "src" / "render" / "rooms"
OUT_TS = ROOT / "app" / "src" / "render" / "rooms.gen.ts"
DOC_DIR = ROOT / "docs" / "art" / "rooms"
REGEN = "python3 tools/gen_rooms.py"

WALL, FLOOR, PIT, GATE, ENTRANCE, HEART = "#", ".", "P", "G", "E", "B"

# Side perimeter of the boss's air, in tiles. Two, as the open-arena map drew it: that
# thickness is what keeps the lobby's far corner inside `shoot.rs`'s WORST_RANGE.
BORDER = 2
# Depth of each `G` block, in rows: the seam `enter_gate` demands you stand in.
GATE_ROWS = 2
# The tiers, left to right. Three, and `gates_px` must name each exactly once.
TIERS = 3
# The arena painting's scale. A contract with the boss pipeline, not a taste -- see the
# module docstring. Never a float other than 1 unless `gen_hitboxes.py --scale` moves too.
ARENA_UNITS_PER_PX = 1
# Coverage at which a tile is floor, and the sampling grid it is measured on.
COVER = 0.5
SUB = 8
# Palette size of the overlay docs and of the served ARENA. The served lobby is true
# colour: a 256-colour palette of it turns the EASY sign's green (130,203,53) brown
# (96,71,59) -- the few hundred lit pixels that name a tier lose the median cut to a
# million of cobbles, and weighting them into the palette still lands at (110,110,56).
# 2.5 MB, once, immutable. The arena names nothing in a few pixels, so it keeps the cut
# that halves it (474 KB against 1,047 KB): the demon-less fill dithers clean, mean error
# 1.9/255 over `boss_crop_px`, measured.
COLOURS = 256
# The hole behind a lifted portcullis is painted the colour the painting already uses
# between the bars: the median of the darkest tenth of that doorway's rect.
THROAT_DECILE = 0.1
# A light's colour is the median of the brightest tenth of a (2k+1)-square at the flame:
# the flame body, not its white-hot core and not the wall behind it.
LIGHT_WINDOW_PX = 6
BRIGHT_DECILE = 0.1
# A doorway's tier colour: the hue and saturation of its most coloured tenth (the lit
# bars -- the grey jambs and the black throat have none), and the brighter half of those
# so the reading is the light and not the shadow between bars. The paint is dim, a glow
# on dark iron (EASY reads 70,81,32), and the mark's halo is a UI mark, so it wears that
# hue at a fixed brightness.
GATE_LIGHT_DECILE = 0.1
GATE_LIGHT_V = 0.85
# The boss silhouette is grown this far before it is filled, so the anti-aliased rim the
# painter blended the demon into the floor with goes too and no dark halo is left
# around a hole. Two, not more: the ring outside the rig shows the fill at all times.
FILL_DILATE_PX = 2
# Inside the dais a hidden pixel is filled from its own ring, turned this far round toward
# its side of the room (and further, in `FILL_TURN_STEP_DEG` steps, until the sample is
# off the demon): the cobbles are concentric rings, so a pixel on the same ring is the
# same course of stone, and a turn -- not the nearest visible pixel -- keeps the joints
# between stones where a turn would put them instead of smearing one stone round the arc.
FILL_TURN_DEG = 50.0
FILL_TURN_STEP_DEG = 10.0
# Void colour per room: the median of the painting's outermost ring, so the frame's
# surplus beyond the painting is the painting's own edge and not a seam.
VOID_RING_PX = 8


class RoomsError(Exception):
    """A geometry defect. Always fatal -- see the module docstring."""


def die(msg: str) -> None:
    raise RoomsError(msg)


# ---------------------------------------------------------------------------
# Transforms
# ---------------------------------------------------------------------------


class Fit:
    """A painting placed in the world: `world = px * scale + (x, y)`."""

    def __init__(self, scale: float, x: float, y: float, size: tuple[int, int]) -> None:
        self.scale, self.x, self.y = scale, x, y
        self.w, self.h = size[0] * scale, size[1] * scale

    def to_px(self, wx: float, wy: float) -> tuple[float, float]:
        return (wx - self.x) / self.scale, (wy - self.y) / self.scale

    def rect(self, r: dict[str, float]) -> dict[str, float]:
        return {"x": self.x + r["x"] * self.scale, "y": self.y + r["y"] * self.scale,
                "w": r["w"] * self.scale, "h": r["h"] * self.scale}

    def ellipse(self, e: dict[str, float]) -> dict[str, float]:
        return {"cx": self.x + e["cx"] * self.scale, "cy": self.y + e["cy"] * self.scale,
                "rx": e["rx"] * self.scale, "ry": e["ry"] * self.scale}

    def point(self, x: float, y: float) -> tuple[float, float]:
        return self.x + x * self.scale, self.y + y * self.scale


def viewport_tiles(name: str) -> int:
    """`const NAME = <n> * MAP_TILE;` out of viewport.ts -- read, never restated."""
    m = re.search(rf"^const {name} = (\d+) \* MAP_TILE;$", VIEWPORT_TS.read_text(), re.M)
    if m is None:
        die(f"{VIEWPORT_TS.relative_to(ROOT)} no longer defines `const {name} = <n> * MAP_TILE`"
            " -- this tool fits the lobby painting to it and will not guess")
    return int(m.group(1))


def in_rect(r: dict[str, float]):
    x0, y0, x1, y1 = r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]
    return lambda px, py: x0 <= px < x1 and y0 <= py < y1


def in_union(rects: list[dict[str, float]]):
    tests = [in_rect(r) for r in rects]
    return lambda px, py: any(t(px, py) for t in tests)


def in_xspan(r: dict[str, float]):
    x0, x1 = r["x"], r["x"] + r["w"]
    return lambda px, py: x0 <= px < x1


def in_ellipse(e: dict[str, float]):
    cx, cy, rx, ry = e["cx"], e["cy"], e["rx"], e["ry"]
    return lambda px, py: ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1


def coverage(tx: int, ty: int, tile: int, fit: Fit, inside) -> float:
    """The fraction of tile (tx, ty)'s world area that maps inside `inside` (px space)."""
    n = 0
    for j in range(SUB):
        wy = ty * tile + (j + 0.5) * tile / SUB
        for i in range(SUB):
            wx = tx * tile + (i + 0.5) * tile / SUB
            if inside(*fit.to_px(wx, wy)):
                n += 1
    return n / (SUB * SUB)


def covered(tx: int, ty: int, tile: int, fit: Fit, inside) -> bool:
    return coverage(tx, ty, tile, fit, inside) >= COVER


def symmetric(tiles: set[tuple[int, int]], n: int) -> set[tuple[int, int]]:
    return {(tx, ty) for tx, ty in tiles if (n - 1 - tx, ty) in tiles}


def runs(cols: list[int]) -> list[tuple[int, int]]:
    """Sorted columns -> maximal contiguous (first, last) runs, left to right."""
    out: list[tuple[int, int]] = []
    for c in sorted(cols):
        if out and out[-1][1] == c - 1:
            out[-1] = (out[-1][0], c)
        else:
            out.append((c, c))
    return out


# ---------------------------------------------------------------------------
# Layout: from the authored shapes to every row of the map
# ---------------------------------------------------------------------------


def layout(doc: dict, lobby_im: Image.Image, arena_im: Image.Image) -> dict:
    tile, n = doc["tile_size"], doc["map_tiles"]
    units = n * tile
    lob, are = doc["rooms"]["lobby"], doc["rooms"]["arena"]
    crop = are["boss_crop_px"]
    bx, by = are["boss_tile"]

    if crop["w"] % 2 or crop["h"] % 2:
        die(f"boss_crop_px is {crop['w']}x{crop['h']}: both must be even, so the canvas centre "
            "(the feet line) is a whole pixel and BOSS_ANCHOR = -(w/2, h/2) is integral")

    # The arena: 1 px = 1 unit, the crop centre on the boss tile, centred in x.
    sa = ARENA_UNITS_PER_PX
    feet_py = crop["y"] + crop["h"] / 2
    arena = Fit(sa, (units - arena_im.width * sa) / 2, by * tile - feet_py * sa, arena_im.size)
    want_cx = (bx * tile - arena.x) / sa
    if crop["x"] + crop["w"] / 2 != want_cx:
        die(f"boss_crop_px is centred on px x {crop['x'] + crop['w'] / 2:g}, but the boss tile "
            f"({bx}, {by}) sits at px x {want_cx:g} in the arena painting: the rig would land "
            "beside its own paint")
    rim = arena.y + arena.h
    if rim != int(rim) or int(rim) % tile:
        die(f"the arena painting's bottom edge lands at world y {rim:g}, not on a tile row: "
            "the rim must be a row edge (move boss_tile or re-measure boss_crop_px)")
    rim_row = int(rim) // tile
    # The pit is the WHOLE painted dais, so its first row is the first row wholly under the
    # ellipse's crest, and everything above that is the boss's air. Not the first row the
    # ellipse *enters*: at the shipped numbers the crest is 8 px into row 11, which
    # `covered` at COVER = 0.5 reads as a two-tile nub on the centre line -- and a pit row
    # that is wall everywhere but a two-tile hole is a lid over the dais that every ray
    # from the shoulders to the crown dies on (`shoot` tests `is_wall` before the part
    # boxes). The pit used to start on the boss's feet row instead, which is what held the
    # raid below the creature's feet line; the boss now stands INSIDE the band and its
    # body is a movement barrier of its own (`player.rs`), which is why the feet row is
    # asserted to be a pit row and no longer defines one.
    ell = are["platform_ellipse_px"]
    pit_rows = (math.ceil((arena.y + (ell["cy"] - ell["ry"]) * sa) / tile), rim_row - 1)
    # The boss's air reaches down to the row above the dais's widest one, not merely to
    # the row above the dais. Above its widest row the ellipse narrows upward, so every
    # row's outermost tile has NO dais tile over it -- and a player standing on that tile's
    # top-outer corner (a tile corner is where every cardinal step lands) fires every
    # upward shot into whatever the tile above is. Wall there is a stand from which
    # nothing can be hit (`gen_hitboxes.py`'s sweep: 8 such stands the first time this
    # was tried); air is a shot that flies. Below the widest row the row above is always
    # at least as wide, so there is nothing to keep open.
    air_rows = (1, int((arena.y + ell["cy"] * sa) // tile) - 1)
    gate_rows = (rim_row, rim_row + GATE_ROWS - 1)

    # The lobby: its band is the painting's own proportion (module docstring), then the
    # painting is fitted to the room's height, top edge on VIEW_LOBBY.y, centred in x.
    head, foot = viewport_tiles("LOBBY_HEAD"), viewport_tiles("LOBBY_FOOT")
    fy0 = min(r["y"] for r in lob["floor_px"])
    fy1 = max(r["y"] + r["h"] for r in lob["floor_px"])
    band = round((fy1 - fy0) * (head + foot) / (lobby_im.height - (fy1 - fy0)))
    lobby_rows = (rim_row + GATE_ROWS, rim_row + GATE_ROWS + band - 1)
    if not (1 < pit_rows[0] <= air_rows[1] < pit_rows[1] < gate_rows[0] <= lobby_rows[0]
            <= lobby_rows[1] <= n - 2):
        die(f"rows do not fit: pit {pit_rows}, air {air_rows}, gate {gate_rows}, lobby "
            f"{lobby_rows} on a {n}-row map (the lobby band is {band} rows from the painting's "
            "floor proportion)")
    if not (pit_rows[0] <= by <= pit_rows[1]):
        die(f"boss tile ({bx}, {by}) is on row {by}, outside the dais rows {pit_rows}: a "
            "raider is clamped to those rows and could never stand level with the boss")
    room_h = (head + band + foot) * tile
    sl = room_h / lobby_im.height
    lobby = Fit(sl, (units - lobby_im.width * sl) / 2, (lobby_rows[0] - head) * tile, lobby_im.size)
    if lobby.w > units:
        die(f"the lobby painting is {lobby.w:.1f} units wide at the fit, wider than the {units}-unit "
            "frame: its side walls would be cropped off. Pad its height (see the docstring) or "
            "trim its width")

    return {
        "tile": tile, "n": n, "units": units,
        "arena": arena, "lobby": lobby,
        "pit_rows": pit_rows, "air_rows": air_rows, "gate_rows": gate_rows, "lobby_rows": lobby_rows,
        "room_h": room_h, "head": head, "foot": foot,
        "boss": (bx * tile, by * tile),
    }


def gates_by_tier(lob: dict) -> list[dict]:
    """`gates_px` checked and ordered by tier, which must also be left-to-right."""
    gates = sorted(lob["gates_px"], key=lambda g: g["tier"])
    if [g["tier"] for g in gates] != list(range(TIERS)):
        die(f"gates_px must name tiers 0..{TIERS - 1} exactly once, got {[g['tier'] for g in gates]}")
    if [g["x"] for g in gates] != sorted(g["x"] for g in gates):
        die("gates_px tiers must run left to right: gen_map.py numbers the G blocks in that order")
    return gates


def build_grid(doc: dict, lay: dict) -> list[str]:
    tile, n = lay["tile"], lay["n"]
    lob, are = doc["rooms"]["lobby"], doc["rooms"]["arena"]
    arena, lobby = lay["arena"], lay["lobby"]
    grid = [[WALL] * n for _ in range(n)]

    # The boss's air: open floor, or `shoot`'s raycast dies on it. See gen_map.py. It
    # reaches down past the dais's crest to the row above its widest row (`layout`), and
    # the dais is painted over it below: a `.` tile inside the pit rows is floor a ray
    # crosses and no raider may stand on -- `gen_map.py` emits the dais as its own bitboard
    # for `move_player` beside the wall table for `shoot`.
    for ty in range(lay["air_rows"][0], lay["air_rows"][1] + 1):
        for tx in range(BORDER, n - BORDER):
            grid[ty][tx] = FLOOR

    ell, stairs = in_ellipse(are["platform_ellipse_px"]), in_rect(are["stairs_px"])
    # The whole ellipse and nothing else. There used to be a kerb fill here -- every column
    # filled bottom-up to the pit's first row -- because the pit began on the boss's feet
    # row, where the dais is still widening, and a tile poking out under a narrower row had
    # a wall capping its column: a pocket from whose corner every upward ray died
    # (`gen_hitboxes.py`'s pit-reach sweep found (3, 23) and its mirror). Over the whole
    # dais that fill would square the upper half off into floor the painting shows as
    # temple flagstones beside a raised dais. The air above the widest row is what closes
    # the pocket now, without adding a stand anywhere.
    pit = symmetric({(tx, ty)
                     for ty in range(lay["pit_rows"][0], lay["pit_rows"][1] + 1)
                     for tx in range(n)
                     if covered(tx, ty, tile, arena, lambda px, py: ell(px, py) or stairs(px, py))}, n)
    # Each doorway's x-span on the gate rows is one block; symmetrised as a whole, so the
    # EASY block's mirror is the HARD block and the MEDIUM block is its own.
    blocks = [{(tx, ty)
               for ty in range(lay["gate_rows"][0], lay["gate_rows"][1] + 1)
               for tx in range(n)
               if covered(tx, ty, tile, lobby, in_xspan(g))} for g in gates_by_tier(lob)]
    gate = symmetric(set().union(*blocks), n)
    blocks = [b & gate for b in blocks]
    floor = in_union(lob["floor_px"])
    hall = symmetric({(tx, ty) for ty in range(n) for tx in range(n)
                      if covered(tx, ty, tile, lobby, floor)}, n)

    rows = sorted({ty for _, ty in hall})
    if not rows or (rows[0], rows[-1]) != lay["lobby_rows"] or len(rows) != rows[-1] - rows[0] + 1:
        die(f"the painted lobby floor lands on rows {rows[:1]}..{rows[-1:]}, but the rim leaves "
            f"rows {lay['lobby_rows']} for it: re-measure floor_px, or LOBBY_HEAD in "
            "viewport.ts is not the painting's proportion")
    for tx, ty in pit:
        grid[ty][tx] = PIT
    for tx, ty in gate:
        grid[ty][tx] = GATE
    for tx, ty in hall:
        grid[ty][tx] = FLOOR
    for tier, b in enumerate(blocks):
        if not b:
            die(f"gates_px tier {tier} spans no whole tile column: no player could ever enter it")
        cols = sorted({tx for tx, _ in b})
        if len(runs(cols)) != 1 or len(b) != len(cols) * GATE_ROWS:
            die(f"gate tier {tier} is not one solid block on the gate rows (cols {cols})")
        for tx in cols:
            if grid[lay["lobby_rows"][0]][tx] != FLOOR:
                die(f"gate tier {tier} column {tx} has wall under it on the lobby's first row: "
                    "no seat could step onto the block -- widen floor_px to reach that doorway")
    for a, b in zip(blocks, blocks[1:]):
        if max(tx for tx, _ in a) + 1 >= min(tx for tx, _ in b):
            die("two gate blocks touch: gen_map.py separates them as connected components, so a "
                "wall column is needed between every pair -- re-measure gates_px")
    for i in range(n):
        for x, y in ((i, 0), (i, n - 1), (0, i), (n - 1, i)):
            if grid[y][x] != WALL:
                die(f"a painted shape reaches the map border at tile ({x}, {y}): the map must be closed")

    for ex, ey in are["entrances_tiles"]:
        if grid[ey][ex] != PIT:
            die(f"entrance tile ({ex}, {ey}) is not pit floor under the painting")
        grid[ey][ex] = ENTRANCE
    bx, by = are["boss_tile"]
    if grid[by][bx] != PIT:
        die(f"boss tile ({bx}, {by}) is not pit floor under the painting")
    grid[by][bx] = HEART
    return ["".join(row) for row in grid]


def gate_blocks(grid: list[str], lay: dict) -> list[tuple[int, int]]:
    """The `G` runs on the gate row, left to right -- tier order, as gen_map.py reads them."""
    return runs([tx for tx, c in enumerate(grid[lay["gate_rows"][0]]) if c == GATE])


def world_shapes(doc: dict, lay: dict, grid: list[str], lobby_im: Image.Image, arena_im: Image.Image) -> dict:
    """The world-unit shapes the renderer mounts, plus the checks it can then assume."""
    tile, n = lay["tile"], lay["n"]
    lob, are = doc["rooms"]["lobby"], doc["rooms"]["arena"]
    arena, lobby = lay["arena"], lay["lobby"]
    crop = arena.rect(are["boss_crop_px"])

    # Every walkable lobby tile lies inside the painted floor -- the renderer's boot check,
    # proven here so the >= COVER rule can never ship a tile that pokes out of the paint.
    # `coverage`, not a rect test: the floor is a union and a tile may straddle two of its
    # rects and still be wholly on the cobbles.
    floor = in_union(lob["floor_px"])
    for ty in range(lay["lobby_rows"][0], lay["lobby_rows"][1] + 1):
        for tx in range(n):
            if grid[ty][tx] != WALL and coverage(tx, ty, tile, lobby, floor) < 1:
                die(f"lobby tile ({tx}, {ty}) is walkable but not wholly inside the painted floor: "
                    "nudge floor_px by a pixel or two")
    # Each doorway cut-out spans its G block's rows, so the portcullis is what a player
    # stands under and its lift clears the whole seam.
    gy0, gy1 = lay["gate_rows"][0] * tile, (lay["gate_rows"][1] + 1) * tile
    gates = gates_by_tier(lob)
    blocks = gate_blocks(grid, lay)
    if len(blocks) != TIERS:
        die(f"the gate row carries {len(blocks)} G blocks, not {TIERS}")
    gate_imgs, lobby_gates, gate_colours = [], [], []
    for tier, (g, (c0, c1)) in enumerate(zip(gates, blocks)):
        img = lobby.rect(g)
        if not (img["y"] <= gy0 and gy1 <= img["y"] + img["h"]):
            die(f"gates_px tier {tier} maps to y {img['y']:.1f}..{img['y'] + img['h']:.1f}, which does "
                f"not span the gate rows {gy0}..{gy1}")
        gate_imgs.append(img)
        lobby_gates.append({"x": c0 * tile, "y": gy0, "w": (c1 + 1 - c0) * tile, "h": gy1 - gy0, "tier": tier})
        gate_colours.append(gate_colour(lobby_im, g))
    return {
        "floors": [lobby.rect(r) for r in lob["floor_px"]],
        "gate_imgs": gate_imgs, "lobby_gates": lobby_gates, "gate_colours": gate_colours,
        "crop": crop, "platform": arena.ellipse(are["platform_ellipse_px"]),
        "lobby_lights": lights(lobby_im, lobby, lob["lights_px"]),
        "arena_lights": lights(arena_im, arena, are["lights_px"]),
    }


def lights(im: Image.Image, fit: Fit, lights_px: list[list[int]]) -> list[dict]:
    out = []
    for x, y, r in lights_px:
        wx, wy = fit.point(x, y)
        out.append({"x": wx, "y": wy, "r": r * fit.scale, "color": light_colour(im, x, y)})
    return out


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def quantised(im: Image.Image) -> bytes:
    # Median cut with error diffusion keeps the painting's soft gradients; the other
    # quantisers posterise the floor (measured on the lobby crop).
    palette = im.quantize(COLOURS, method=Image.Quantize.MEDIANCUT)
    return png_bytes(im.quantize(COLOURS, palette=palette, dither=Image.Dither.FLOYDSTEINBERG))


def hex_of(rgb) -> str:
    r, g, b = (int(v) for v in rgb)
    return f"#{r:02x}{g:02x}{b:02x}"


def throat_colour(im: Image.Image, gate: dict[str, int]) -> tuple[int, int, int]:
    px = np.asarray(im.crop((gate["x"], gate["y"], gate["x"] + gate["w"], gate["y"] + gate["h"])))
    flat = px.reshape(-1, 3)
    darkest = np.argsort(flat.sum(axis=1))[: max(1, int(len(flat) * THROAT_DECILE))]
    return tuple(int(v) for v in np.median(flat[darkest], axis=0))


def brightest_median(flat: np.ndarray) -> str:
    top = np.argsort(flat.sum(axis=1))[-max(1, int(len(flat) * BRIGHT_DECILE)):]
    return hex_of(np.median(flat[top], axis=0))


def light_colour(im: Image.Image, x: int, y: int) -> str:
    k = LIGHT_WINDOW_PX
    return brightest_median(np.asarray(im.crop((x - k, y - k, x + k + 1, y + k + 1))).reshape(-1, 3))


def gate_colour(im: Image.Image, gate: dict[str, int]) -> str:
    flat = np.asarray(im.crop((gate["x"], gate["y"], gate["x"] + gate["w"], gate["y"] + gate["h"]))).astype(int).reshape(-1, 3)
    sat = flat.max(axis=1) - flat.min(axis=1)
    lit = flat[np.argsort(sat)[-max(1, int(len(flat) * GATE_LIGHT_DECILE)):]]
    lit = lit[np.argsort(lit.sum(axis=1))[len(lit) // 2:]]
    r, g, b = (v / 255 for v in np.median(lit, axis=0))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s < 0.25:
        die(f"gates_px tier {gate['tier']} carries no coloured light on its bars to read a tier colour from")
    return hex_of(v * 255 for v in colorsys.hsv_to_rgb(h, s, GATE_LIGHT_V))


def void_colour(im: Image.Image) -> str:
    a = np.asarray(im)
    k = VOID_RING_PX
    ring = np.concatenate([a[:k].reshape(-1, 3), a[-k:].reshape(-1, 3),
                           a[:, :k].reshape(-1, 3), a[:, -k:].reshape(-1, 3)])
    return hex_of(np.median(ring, axis=0))


def bossless(arena_im: Image.Image, crop: dict[str, int], ell: dict[str, float], wall_bay: int) -> Image.Image:
    """The arena painting with the demon painted out -- the copy the room serves.

    Not an inpainter: OpenCV's Telea and Navier-Stokes both turn a 300 px hole into one
    smooth blob with colour fans off the braziers (tried, both). The hole has two kinds of
    background and each has a structure to copy: inside the dais the cobbles run in rings
    about the ellipse's centre, so a hidden pixel is filled from ITS OWN RING turned toward
    its side of the room; above the dais the back wall is bays between pillars on a pitch
    (`wall_bay_px`), so a hidden pixel is the same pixel one bay over -- the demon is
    narrower than two bays, so one bay out is always in the open.

    The mask is the rig's own silhouette (`gen_boss.BODY`, the cut the atlas alpha is)
    plus every demon-coloured pixel inside its convex hull -- the tentacles in the
    concavities the polygon skips, which Telea smeared purple across the whole fill --
    grown by `FILL_DILATE_PX`.
    """
    k = arena_im.width // gen_boss.REF_W
    src = np.asarray(arena_im)
    body = gen_boss.rasterise(gen_boss.scaled(gen_boss.BODY, k), arena_im.width, arena_im.height)
    ys, xs = np.nonzero(body)
    if not (crop["x"] <= xs.min() and xs.max() < crop["x"] + crop["w"]
            and crop["y"] <= ys.min() and ys.max() < crop["y"] + crop["h"]):
        die("gen_boss.BODY reaches outside boss_crop_px: the rig would not cover its own hole")
    hull = np.zeros_like(body, dtype=np.uint8)
    cv2.fillConvexPoly(hull, cv2.convexHull(np.column_stack([xs, ys]).astype(np.int32)), 1)
    warm = src[..., 0].astype(int) > src[..., 2].astype(int)  # the demon is brown on a blue room
    d = FILL_DILATE_PX * k
    mask = cv2.dilate((body | (hull.astype(bool) & warm)).astype(np.uint8), np.ones((2 * d + 1, 2 * d + 1), np.uint8)).astype(bool)

    out = src.copy()
    h, w = mask.shape
    my, mx = np.nonzero(mask)
    cx, cy, rx, ry = ell["cx"] * k, ell["cy"] * k, ell["rx"] * k, ell["ry"] * k
    u, v = (mx - cx) / rx, (my - cy) / ry
    r = np.hypot(u, v)
    on_dais = r <= 1
    # The dais: the same ring, turned toward the pixel's side of the room. The two halves
    # meet on the centre line, where the torso -- never destroyed -- sits anyway.
    theta = np.arctan2(v, u)
    side = np.where(u >= 0, 1.0, -1.0)
    todo = on_dais.copy()
    for i in range(int(360 / FILL_TURN_STEP_DEG)):
        if not todo.any():
            break
        t = theta[todo] + side[todo] * math.radians(FILL_TURN_DEG + i * FILL_TURN_STEP_DEG)
        sx = np.clip(np.rint(cx + rx * r[todo] * np.cos(t)).astype(int), 0, w - 1)
        sy = np.clip(np.rint(cy + ry * r[todo] * np.sin(t)).astype(int), 0, h - 1)
        ok = ~mask[sy, sx]
        idx = np.nonzero(todo)[0][ok]
        out[my[idx], mx[idx]] = src[sy[ok], sx[ok]]
        todo[idx] = False
    if todo.any():
        die(f"{int(todo.sum())} dais pixels under the demon have no visible pixel on their ring")
    # The wall: the same pixel one bay over, on the pixel's side of the room.
    bay = wall_bay * k
    wy, wx = my[~on_dais], mx[~on_dais]
    sx = wx + np.where(wx >= cx, bay, -bay)
    if ((sx < 0) | (sx >= w)).any() or mask[wy, np.clip(sx, 0, w - 1)].any():
        die("the demon hides more of the back wall than one bay: wall_bay_px is wrong or the "
            "painting changed")
    out[wy, wx] = src[wy, sx]
    return Image.fromarray(out)


def overlay(im: Image.Image, fit: Fit, grid: list[str], lay: dict, shapes: list) -> Image.Image:
    """The painting at half brightness, the tile grid, walkable tint and the authored shapes."""
    tile, n = lay["tile"], lay["n"]
    base = Image.fromarray((np.asarray(im) // 2).astype(np.uint8)).convert("RGBA")
    ov = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    tint = {PIT: (0, 255, 0, 80), FLOOR: (80, 140, 255, 60), GATE: (255, 220, 0, 110),
            ENTRANCE: (0, 255, 255, 170), HEART: (255, 0, 255, 170)}
    for ty in range(n):
        for tx in range(n):
            x0, y0 = fit.to_px(tx * tile, ty * tile)
            x1, y1 = fit.to_px((tx + 1) * tile, (ty + 1) * tile)
            if not (x1 > 0 and y1 > 0 and x0 < base.width and y0 < base.height):
                continue
            c = tint.get(grid[ty][tx])
            if c:
                d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=c)
            d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 255, 255, 40))
            if tx % 8 == 0 and ty % 8 == 0:
                d.text((x0 + 2, y0 + 1), f"{tx},{ty}", fill=(255, 255, 255, 200))
    for kind, s, colour in shapes:
        if kind == "rect":
            d.rectangle([s["x"], s["y"], s["x"] + s["w"] - 1, s["y"] + s["h"] - 1], outline=colour, width=2)
        elif kind == "ellipse":
            d.ellipse([s["cx"] - s["rx"], s["cy"] - s["ry"], s["cx"] + s["rx"], s["cy"] + s["ry"]],
                      outline=colour, width=2)
        else:
            x, y, r = s
            d.ellipse([x - r, y - r, x + r, y + r], outline=colour, width=2)
    return Image.alpha_composite(base, ov).convert("RGB").quantize(COLOURS, method=Image.Quantize.MEDIANCUT)


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------


def num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else repr(round(float(v), 4))


def obj(d: dict) -> str:
    return "{ " + ", ".join(f"{k}: {v!r}" if isinstance(v, str) else f"{k}: {num(v)}" for k, v in d.items()) + " }"


def rows(items: list[dict]) -> str:
    return "[\n" + "".join(f"  {obj(d)},\n" for d in items) + "]"


def emit_ts(lay: dict, shapes: dict, void: dict[str, str], lobby_im: Image.Image, arena_im: Image.Image) -> str:
    lobby, arena = lay["lobby"], lay["arena"]
    lob = {"x": lobby.x, "y": lobby.y, "w": lobby.w, "h": lobby.h}
    are = {"x": arena.x, "y": arena.y, "w": arena.w, "h": arena.h}
    img = lambda src, r: "{ src: " + src + ", " + obj(r)[2:]  # noqa: E731
    gate_imgs = "[\n" + "".join(f"  {img(f'gate{i}Png', r)},\n" for i, r in enumerate(shapes["gate_imgs"])) + "]"
    gate_imports = "".join(f"import gate{i}Png from './rooms/gate{i}.png?no-inline';\n" for i in range(TIERS))
    gate_names = ", ".join(f"gate{i}Png" for i in range(TIERS))
    band = lay["lobby_rows"][1] + 1 - lay["lobby_rows"][0]
    return f'''// @generated from assets/map/arena.json `rooms` and assets/rooms/*.png by `{REGEN}` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the painting on screen
// and the grid the chain walks stop being the same room. Edit `rooms` in arena.json, re-run
// the command above, then `python3 tools/gen_map.py`.
//
// `?no-inline` keeps every painting a hashed file under /assets/ (served immutable by
// app/public/_headers) rather than a base64 string in the bundle, whatever its size.
import arenaPng from './rooms/arena.png?no-inline';
{gate_imports}import lobbyPng from './rooms/lobby.png?no-inline';

/** A painting placed in the world: `<image href={{src}} x={{x}} y={{y}} width={{w}} height={{h}}>`. */
export interface ImgRect {{
  readonly src: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}}

/** A world-space rectangle in arena units. */
export interface WorldRect {{
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}}

/** A world-space axis-aligned ellipse in arena units. */
export interface WorldEllipse {{
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
}}

/** One `G` block, in world units, with the difficulty tier `enter_gate` reads off it. */
export interface LobbyGate extends WorldRect {{
  readonly tier: number;
}}

/** A painted torch or brazier: where its flame is, how far its glow reaches, its colour off the paint. */
export interface RoomLight {{
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly color: string;
}}

/**
 * The waiting hall ({lobby_im.width}x{lobby_im.height} px), fitted to the room's height at {num(lobby.scale)} units per
 * px, so `y` is `VIEW_LOBBY.y` and `h` is `ROOM_H`, centred in x with {num((lay["units"] - lobby.w) / 2)} units of void
 * each side. Its floor is the {band}-row lobby band. Mount it with `imageRendering: 'auto'`: the
 * painting is not pixel art.
 */
export const LOBBY_IMG: ImgRect = {img("lobbyPng", lob)};

/**
 * The fight arena ({arena_im.width}x{arena_im.height} px) at one unit per px -- the scale the boss crop and its
 * hitboxes are cut at -- with its bottom edge on the pit rim (`PIT_BOT + 1`) and centred
 * in x, so it overhangs the frame by {num(-arena.x)} units a side and leaves {num(arena.y - ((lay["pit_rows"][1] + 1) * lay["tile"] - lay["room_h"]))} units of void
 * above its top edge in `VIEW_ARENA`. The demon is painted out of this copy: the rig is
 * the only demon on screen, so a destroyed part leaves a hole the room shows through.
 */
export const ARENA_IMG: ImgRect = {img("arenaPng", are)};

/**
 * The three portcullises, by tier, cut out of the lobby painting (which has each throat
 * painted dark underneath), for `WaitingRoom` to mount as the `.gate-portcullis` nodes the
 * passage lifts. Each spans its `G` block's rows.
 */
export const GATE_IMGS: readonly ImgRect[] = {gate_imgs};

/** The `G` blocks by tier, tile-aligned: what `map.ts`'s `GATES` must equal, both from one grid. */
export const LOBBY_GATES: readonly LobbyGate[] = {rows(shapes["lobby_gates"])};

/** Each doorway's own light, read off its bars: the colour its mark's halo wears. */
export const LOBBY_GATE_COLORS: readonly string[] = [{", ".join(repr(c) for c in shapes["gate_colours"])}];

/** What the `.vp-void` rect paints per room: the median of that painting's outermost ring. */
export const VOID: Readonly<Record<'lobby' | 'arena', string>> = {{
  lobby: '{void["lobby"]}',
  arena: '{void["arena"]}',
}};

/** The painted lobby floor, a union. Every walkable lobby tile lies wholly inside it (generator-proven). */
export const LOBBY_FLOOR: readonly WorldRect[] = {rows(shapes["floors"])};

/** The painted platform the pit is cut from: the walkable pit is this whole ellipse, less the boss. */
export const ARENA_PLATFORM: WorldEllipse = {obj(shapes["platform"])};

/**
 * The boss crop, in world units: `gen_boss.py` cuts exactly this out of the arena painting,
 * so `BOSS_SPAWN + BOSS_ANCHOR === {{ x, y }}` here -- the rig sits on its own paint pixel-exact.
 */
export const BOSS_CROP: WorldRect = {obj(shapes["crop"])};

/** The lobby's painted torches, for the glow the room hangs under each. */
export const LOBBY_LIGHTS: readonly RoomLight[] = {rows(shapes["lobby_lights"])};

/** The arena's painted braziers, likewise. */
export const ARENA_LIGHTS: readonly RoomLight[] = {rows(shapes["arena_lights"])};

// Warm the paintings at import, so the first mount of either room does not flash void.
if (typeof Image !== 'undefined') {{
  for (const src of [lobbyPng, arenaPng, {gate_names}]) new Image().src = src;
}}
'''


def dump_json(doc: dict) -> str:
    """indent=2, with every all-number list or object on one line: a tile, not a column."""
    text = json.dumps(doc, indent=2)
    text = re.sub(
        r"\[\s*((?:-?\d+(?:\.\d+)?\s*,\s*)*-?\d+(?:\.\d+)?)\s*\]",
        lambda m: "[" + ", ".join(re.findall(r"-?\d+(?:\.\d+)?", m.group(1))) + "]",
        text,
    )
    text = re.sub(
        r"\{\s*((?:\"\w+\": -?\d+(?:\.\d+)?,?\s*)+)\}",
        lambda m: "{ " + ", ".join(re.findall(r"\"\w+\": -?\d+(?:\.\d+)?", m.group(1))) + " }",
        text,
    )
    return text + "\n"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def generate(doc: dict) -> tuple[list[str], str, dict[Path, bytes], dict[Path, Image.Image]]:
    lob, are = doc["rooms"]["lobby"], doc["rooms"]["arena"]
    lobby_im = Image.open(ROOT / lob["src"]).convert("RGB")
    arena_im = Image.open(ROOT / are["src"]).convert("RGB")
    lay = layout(doc, lobby_im, arena_im)
    grid = build_grid(doc, lay)
    shapes = world_shapes(doc, lay, grid, lobby_im, arena_im)
    void = {"lobby": void_colour(lobby_im), "arena": void_colour(arena_im)}

    holed = lobby_im.copy()
    pngs = {}
    for g in gates_by_tier(lob):
        box = (g["x"], g["y"], g["x"] + g["w"], g["y"] + g["h"])
        ImageDraw.Draw(holed).rectangle([box[0], box[1], box[2] - 1, box[3] - 1], fill=throat_colour(lobby_im, g))
        pngs[OUT_PNG_DIR / f"gate{g['tier']}.png"] = png_bytes(lobby_im.crop(box))
    pngs[OUT_PNG_DIR / "lobby.png"] = png_bytes(holed)
    pngs[OUT_PNG_DIR / "arena.png"] = quantised(bossless(arena_im, are["boss_crop_px"], are["platform_ellipse_px"], are["wall_bay_px"]))
    light = (255, 140, 40, 255)
    docs = {
        DOC_DIR / "overlay-lobby.png": overlay(lobby_im, lay["lobby"], grid, lay,
            [("rect", r, (0, 255, 0, 255)) for r in lob["floor_px"]]
            + [("rect", g, (255, 220, 0, 255)) for g in lob["gates_px"]]
            + [("light", l, light) for l in lob["lights_px"]]),
        DOC_DIR / "overlay-arena.png": overlay(arena_im, lay["arena"], grid, lay, [
            ("ellipse", are["platform_ellipse_px"], (0, 255, 0, 255)),
            ("rect", are["stairs_px"], (255, 220, 0, 255)),
            ("rect", are["boss_crop_px"], (255, 0, 255, 255))]
            + [("light", l, light) for l in are["lights_px"]]),
    }
    return grid, emit_ts(lay, shapes, void, lobby_im, arena_im), pngs, docs


def main() -> int:
    check = "--check" in sys.argv
    doc = json.loads(MAP_JSON.read_text())
    try:
        grid, ts, pngs, docs = generate(doc)
    except RoomsError as exc:
        print(f"gen_rooms: REJECTED: {exc}", file=sys.stderr)
        return 1

    if check:
        stale = []
        if doc.get("grid") != grid:
            stale.append(str(MAP_JSON.relative_to(ROOT)) + " (grid)")
        if not OUT_TS.exists() or OUT_TS.read_text() != ts:
            stale.append(str(OUT_TS.relative_to(ROOT)))
        stale += [str(p.relative_to(ROOT)) for p, b in pngs.items() if not p.exists() or p.read_bytes() != b]
        if stale:
            print("gen_rooms: STALE, re-run `%s`:\n  %s" % (REGEN, "\n  ".join(stale)), file=sys.stderr)
            return 1
        print("gen_rooms: up to date")
        return 0

    doc["grid"] = grid
    MAP_JSON.write_text(dump_json(doc))
    OUT_PNG_DIR.mkdir(parents=True, exist_ok=True)
    DOC_DIR.mkdir(parents=True, exist_ok=True)
    for p, b in pngs.items():
        p.write_bytes(b)
    for p, im in docs.items():
        im.save(p, format="PNG", optimize=True)
    OUT_TS.write_text(ts)
    walk = sum(row.count(c) for row in grid for c in (FLOOR, PIT, GATE, ENTRANCE, HEART))
    print(f"gen_rooms: {len(grid)}x{len(grid)} grid, {walk} walkable tiles -> {MAP_JSON.relative_to(ROOT)}")
    for p, b in pngs.items():
        print(f"gen_rooms: wrote {p.relative_to(ROOT)} ({len(b) // 1024} KB)")
    for p in docs:
        print(f"gen_rooms: wrote {p.relative_to(ROOT)}")
    print(f"gen_rooms: wrote {OUT_TS.relative_to(ROOT)}; now run `python3 tools/gen_map.py`")
    return 0


if __name__ == "__main__":
    sys.exit(main())
