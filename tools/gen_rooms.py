#!/usr/bin/env python3
"""Compile the two room paintings into the map grid, the room PNGs and `rooms.gen.ts`.

    python3 tools/gen_rooms.py            # rewrites every output below
    python3 tools/gen_rooms.py --check    # regenerates in memory; exit 1 on drift

Inputs, hand-authored:
    assets/rooms/lobby.png, assets/rooms/arena.png   the reference paintings, verbatim
    assets/map/arena.json  `rooms`                   the shapes measured off them, in PIXELS

Outputs, never hand-edited:
    assets/map/arena.json  `grid`                    the ASCII map `gen_map.py` compiles
    app/src/render/rooms/{lobby,arena,gate}.png      256-colour copies Vite hashes under
                                                     /assets/ (served immutable, never base64)
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

  lobby  fitted to the room's HEIGHT, `ROOM_H = LOBBY_HEAD + lobby band + LOBBY_FOOT`
         (the head and foot are read out of `viewport.ts`, the band is the rows the rim
         leaves under the gate), top edge on `VIEW_LOBBY.y`, centred in x. The painted floor
         must then land exactly on the lobby rows -- checked, because `LOBBY_HEAD` is the
         painting's own proportion (248 px of masonry over a 442 px floor) and a wrong
         head is a floor that starts a row early.

WALKABLE. A tile is floor when at least `COVER` of its 16 x 16 world area maps inside the
shape (pit: the WHOLE platform ellipse or the stairs; lobby: the floor rect; gate: the
portcullis opening's x-span), sampled `SUB` x `SUB`. Then mirror-symmetrised -- a tile is
floor only if its mirror about the centre line is too -- so a measurement a pixel off
centre cannot ship an asymmetric arena. The boss's body is not cut out of the pit here:
it is a movement barrier in `player.rs` (the fold of the hitbox table), never a wall,
because a wall tile kills every ray in its column. Everything else `gen_map.py` already
proves (reachability, one run per row, spawn fans, the seam) is left to it.
"""

from __future__ import annotations

import io
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

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
# Depth of the `G` block, in rows: the seam `enter_gate` demands you stand in.
GATE_ROWS = 2
# The arena painting's scale. A contract with the boss pipeline, not a taste -- see the
# module docstring. Never a float other than 1 unless `gen_hitboxes.py --scale` moves too.
ARENA_UNITS_PER_PX = 1
# Coverage at which a tile is floor, and the sampling grid it is measured on.
COVER = 0.5
SUB = 8
# Palette size of the served PNGs. Median cut with error diffusion keeps the paintings'
# soft gradients; the other quantisers posterise the floor (measured on the lobby crop).
COLOURS = 256
# The hole behind the lifted portcullis is painted the colour the painting already uses
# between the bars: the median of the darkest tenth of the gate rect.
THROAT_DECILE = 0.1
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


def in_xspan(r: dict[str, float]):
    x0, x1 = r["x"], r["x"] + r["w"]
    return lambda px, py: x0 <= px < x1


def in_ellipse(e: dict[str, float]):
    cx, cy, rx, ry = e["cx"], e["cy"], e["rx"], e["ry"]
    return lambda px, py: ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1


def covered(tx: int, ty: int, tile: int, fit: Fit, inside) -> bool:
    """Does at least `COVER` of tile (tx, ty)'s world area map inside `inside` (px space)?"""
    n = 0
    for j in range(SUB):
        wy = ty * tile + (j + 0.5) * tile / SUB
        for i in range(SUB):
            wx = tx * tile + (i + 0.5) * tile / SUB
            if inside(*fit.to_px(wx, wy)):
                n += 1
    return n >= COVER * SUB * SUB


def symmetric(tiles: set[tuple[int, int]], n: int) -> set[tuple[int, int]]:
    return {(tx, ty) for tx, ty in tiles if (n - 1 - tx, ty) in tiles}


# ---------------------------------------------------------------------------
# Layout: from the authored shapes to every row of the map
# ---------------------------------------------------------------------------


def layout(doc: dict, lobby_im: Image.Image, arena_im: Image.Image) -> dict:
    tile, n = doc["tile_size"], doc["map_tiles"]
    units = n * tile
    are = doc["rooms"]["arena"]
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
    lobby_rows = (rim_row + GATE_ROWS, n - 2)
    if not (1 < pit_rows[0] <= air_rows[1] < pit_rows[1] < gate_rows[0] <= lobby_rows[0]
            <= lobby_rows[1]):
        die(f"rows do not fit: pit {pit_rows}, air {air_rows}, gate {gate_rows}, lobby "
            f"{lobby_rows} on a {n}-row map")
    if not (pit_rows[0] <= by <= pit_rows[1]):
        die(f"boss tile ({bx}, {by}) is on row {by}, outside the dais rows {pit_rows}: a "
            "raider is clamped to those rows and could never stand level with the boss")

    # The lobby: fitted to the room's height, top edge on VIEW_LOBBY.y, centred in x.
    head, foot = viewport_tiles("LOBBY_HEAD"), viewport_tiles("LOBBY_FOOT")
    room_h = (head + foot + lobby_rows[1] + 1 - lobby_rows[0]) * tile
    sl = room_h / lobby_im.height
    lobby = Fit(sl, (units - lobby_im.width * sl) / 2, (lobby_rows[0] - head) * tile, lobby_im.size)

    return {
        "tile": tile, "n": n, "units": units,
        "arena": arena, "lobby": lobby,
        "pit_rows": pit_rows, "air_rows": air_rows, "gate_rows": gate_rows, "lobby_rows": lobby_rows,
        "room_h": room_h, "head": head, "foot": foot,
        "boss": (bx * tile, by * tile),
    }


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
    span = in_xspan(lob["gate_px"])
    gate = symmetric({(tx, ty)
                      for ty in range(lay["gate_rows"][0], lay["gate_rows"][1] + 1)
                      for tx in range(n)
                      if covered(tx, ty, tile, lobby, span)}, n)
    floor = in_rect(lob["floor_rect_px"])
    hall = symmetric({(tx, ty) for ty in range(n) for tx in range(n)
                      if covered(tx, ty, tile, lobby, floor)}, n)

    rows = sorted({ty for _, ty in hall})
    if not rows or (rows[0], rows[-1]) != lay["lobby_rows"] or len(rows) != rows[-1] - rows[0] + 1:
        die(f"the painted lobby floor lands on rows {rows[:1]}..{rows[-1:]}, but the rim leaves "
            f"rows {lay['lobby_rows']} for it: re-measure floor_rect_px, or LOBBY_HEAD in "
            "viewport.ts is not the painting's proportion")
    for tx, ty in pit:
        grid[ty][tx] = PIT
    for tx, ty in gate:
        grid[ty][tx] = GATE
    for tx, ty in hall:
        grid[ty][tx] = FLOOR
    if not gate:
        die("gate_px spans no whole tile column: no player could ever enter_gate")
    for tx, _ in gate:
        if grid[lay["pit_rows"][1]][tx] != PIT:
            die(f"gate column {tx} runs into wall on the pit's last row {lay['pit_rows'][1]}: "
                "the stairs do not reach the rim -- extend stairs_px to the painting's bottom edge")
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


def world_shapes(doc: dict, lay: dict, grid: list[str]) -> dict:
    """The world-unit rects the renderer mounts, plus the checks it can then assume."""
    tile, n = lay["tile"], lay["n"]
    lob, are = doc["rooms"]["lobby"], doc["rooms"]["arena"]
    arena, lobby = lay["arena"], lay["lobby"]
    floor = lobby.rect(lob["floor_rect_px"])
    gate_img = lobby.rect(lob["gate_px"])
    crop = arena.rect(are["boss_crop_px"])

    # Every walkable lobby tile lies inside the painted floor -- the renderer's boot check,
    # proven here so the >= COVER rule can never ship a tile that pokes out of the paint.
    for ty in range(lay["lobby_rows"][0], lay["lobby_rows"][1] + 1):
        for tx in range(n):
            if grid[ty][tx] == WALL:
                continue
            if not (floor["x"] <= tx * tile and (tx + 1) * tile <= floor["x"] + floor["w"]
                    and floor["y"] <= ty * tile and (ty + 1) * tile <= floor["y"] + floor["h"]):
                die(f"lobby tile ({tx}, {ty}) is walkable but not wholly inside the painted floor "
                    f"{floor}: nudge floor_rect_px by a pixel or two")
    # The gate cut-out covers the G block, so the portcullis is what a player stands under.
    gx = [tx for tx in range(n) if grid[lay["gate_rows"][0]][tx] == GATE]
    g0, g1, gy0, gy1 = min(gx) * tile, (max(gx) + 1) * tile, lay["gate_rows"][0] * tile, (lay["gate_rows"][1] + 1) * tile
    if not (gate_img["x"] <= g0 and g1 <= gate_img["x"] + gate_img["w"]
            and gate_img["y"] <= gy0 and gy1 <= gate_img["y"] + gate_img["h"]):
        die(f"gate_px maps to {gate_img}, which does not cover the G block "
            f"x {g0}..{g1} y {gy0}..{gy1}")
    return {"floor": floor, "gate_img": gate_img, "crop": crop,
            "platform": arena.ellipse(are["platform_ellipse_px"])}


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def png_bytes(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def quantised(im: Image.Image) -> bytes:
    palette = im.quantize(COLOURS, method=Image.Quantize.MEDIANCUT)
    return png_bytes(im.quantize(COLOURS, palette=palette, dither=Image.Dither.FLOYDSTEINBERG))


def throat_colour(lobby_im: Image.Image, gate: dict[str, int]) -> tuple[int, int, int]:
    px = np.asarray(lobby_im.crop((gate["x"], gate["y"], gate["x"] + gate["w"], gate["y"] + gate["h"])))
    flat = px.reshape(-1, 3)
    darkest = np.argsort(flat.sum(axis=1))[: max(1, int(len(flat) * THROAT_DECILE))]
    return tuple(int(v) for v in np.median(flat[darkest], axis=0))


def void_colour(im: Image.Image) -> str:
    a = np.asarray(im)
    k = VOID_RING_PX
    ring = np.concatenate([a[:k].reshape(-1, 3), a[-k:].reshape(-1, 3),
                           a[:, :k].reshape(-1, 3), a[:, -k:].reshape(-1, 3)])
    r, g, b = (int(v) for v in np.median(ring, axis=0))
    return f"#{r:02x}{g:02x}{b:02x}"


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
        else:
            d.ellipse([s["cx"] - s["rx"], s["cy"] - s["ry"], s["cx"] + s["rx"], s["cy"] + s["ry"]],
                      outline=colour, width=2)
    return Image.alpha_composite(base, ov).convert("RGB").quantize(COLOURS, method=Image.Quantize.MEDIANCUT)


# ---------------------------------------------------------------------------
# Emit
# ---------------------------------------------------------------------------


def num(v: float) -> str:
    return str(int(v)) if float(v).is_integer() else repr(round(float(v), 4))


def obj(d: dict[str, float]) -> str:
    return "{ " + ", ".join(f"{k}: {num(v)}" for k, v in d.items()) + " }"


def emit_ts(lay: dict, shapes: dict, void: dict[str, str], lobby_im: Image.Image, arena_im: Image.Image) -> str:
    lobby, arena = lay["lobby"], lay["arena"]
    lob = {"x": lobby.x, "y": lobby.y, "w": lobby.w, "h": lobby.h}
    are = {"x": arena.x, "y": arena.y, "w": arena.w, "h": arena.h}
    img = lambda src, r: "{ src: " + src + ", " + obj(r)[2:]  # noqa: E731
    return f'''// @generated from assets/map/arena.json `rooms` and assets/rooms/*.png by `{REGEN}` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the painting on screen
// and the grid the chain walks stop being the same room. Edit `rooms` in arena.json, re-run
// the command above, then `python3 tools/gen_map.py`.
//
// `?no-inline` keeps every painting a hashed file under /assets/ (served immutable by
// app/public/_headers) rather than a base64 string in the bundle, whatever its size.
import arenaPng from './rooms/arena.png?no-inline';
import gatePng from './rooms/gate.png?no-inline';
import lobbyPng from './rooms/lobby.png?no-inline';

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

/**
 * The waiting hall ({lobby_im.width}x{lobby_im.height} px), fitted to the room's height at {num(lobby.scale)} units per
 * px, so `y` is `VIEW_LOBBY.y` and `h` is `ROOM_H`, centred in x with {num((lay["units"] - lobby.w) / 2)} units of void
 * each side. Mount it with `imageRendering: 'auto'`: the painting is not pixel art.
 */
export const LOBBY_IMG: ImgRect = {img("lobbyPng", lob)};

/**
 * The fight arena ({arena_im.width}x{arena_im.height} px) at one unit per px -- the scale the boss crop and its
 * hitboxes are cut at -- with its bottom edge on the pit rim (`PIT_BOT + 1`) and centred
 * in x, so it overhangs the frame by {num(-arena.x)} units a side and leaves {num(arena.y - ((lay["pit_rows"][1] + 1) * lay["tile"] - lay["room_h"]))} units of void
 * above its top edge in `VIEW_ARENA`.
 */
export const ARENA_IMG: ImgRect = {img("arenaPng", are)};

/**
 * The portcullis, cut out of the lobby painting (which has the hole painted throat-dark
 * underneath), for `WaitingRoom` to mount as the one `#gate-portcullis` node the passage
 * lifts. Covers the whole `G` block.
 */
export const GATE_IMG: ImgRect = {img("gatePng", shapes["gate_img"])};

/** What the `.vp-void` rect paints per room: the median of that painting's outermost ring. */
export const VOID: Readonly<Record<'lobby' | 'arena', string>> = {{
  lobby: '{void["lobby"]}',
  arena: '{void["arena"]}',
}};

/** The painted lobby floor. Every walkable lobby tile lies wholly inside it (generator-proven). */
export const LOBBY_FLOOR: WorldRect = {obj(shapes["floor"])};

/** The painted platform the pit is cut from: the walkable pit is this whole ellipse, less the boss. */
export const ARENA_PLATFORM: WorldEllipse = {obj(shapes["platform"])};

/**
 * The boss crop, in world units: `gen_boss.py` cuts exactly this out of the arena painting,
 * so `BOSS_SPAWN + BOSS_ANCHOR === {{ x, y }}` here -- the rig sits on its own paint pixel-exact.
 */
export const BOSS_CROP: WorldRect = {obj(shapes["crop"])};

// Warm the paintings at import, so the first mount of either room does not flash void.
if (typeof Image !== 'undefined') {{
  for (const src of [lobbyPng, arenaPng, gatePng]) new Image().src = src;
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
    shapes = world_shapes(doc, lay, grid)
    void = {"lobby": void_colour(lobby_im), "arena": void_colour(arena_im)}

    g = lob["gate_px"]
    box = (g["x"], g["y"], g["x"] + g["w"], g["y"] + g["h"])
    holed = lobby_im.copy()
    ImageDraw.Draw(holed).rectangle([box[0], box[1], box[2] - 1, box[3] - 1], fill=throat_colour(lobby_im, g))
    pngs = {
        OUT_PNG_DIR / "lobby.png": quantised(holed),
        OUT_PNG_DIR / "arena.png": quantised(arena_im),
        OUT_PNG_DIR / "gate.png": quantised(lobby_im.crop(box)),
    }
    docs = {
        DOC_DIR / "overlay-lobby.png": overlay(lobby_im, lay["lobby"], grid, lay, [
            ("rect", lob["floor_rect_px"], (0, 255, 0, 255)), ("rect", lob["gate_px"], (255, 220, 0, 255))]),
        DOC_DIR / "overlay-arena.png": overlay(arena_im, lay["arena"], grid, lay, [
            ("ellipse", are["platform_ellipse_px"], (0, 255, 0, 255)),
            ("rect", are["stairs_px"], (255, 220, 0, 255)),
            ("rect", are["boss_crop_px"], (255, 0, 255, 255))]),
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
