#!/usr/bin/env python3
"""The side rooms off the lobby -- the secret room, the keep, the range -- painted onto exactly
the tiles the chain calls them, and the table `SideRooms.tsx` places them with.

    python3 tools/gen_side_rooms.py [--check]

Every chamber is cut from the LOBBY PAINTING itself (assets/rooms/lobby.png): a plain stretch
of its west wall for the walls, the calmest patch of its cobbles for the floor, the south
wall's top course for the front wall, its standing torch, and its own doors and stairs as the
way out -- so each room is in the painting's own hand, not a second style pasted next to it.
The furniture -- banners, tablets, a chest, a mirror, a bow rack, hay bales, the straw men --
is drawn here at `ART` px per art pixel the way the ordnance is, with a keyline and a few
colour bands. The marks on the secret room's banners are the official SVGs rasterised once to
assets/sprites/{solana,magicblock}-mark.png and pixelised here. This tool is the only writer
of app/src/render/rooms/{secret,keep,range}.png, app/src/render/siderooms-props.png (each
arch drawn open and the stair lit -- the cue a doorway gives while a seat stands at it -- and
the range's straw man, a sprite so it can flinch) and app/src/render/siderooms.gen.ts;
`--check` diffs them all against disk.

WHERE EACH ROOM GOES is not this tool's decision. The rooms are zones on the chain, their
floors `doors.rooms[i].room_tiles` in assets/map/arena.json, which gen_map.py compiles to
`map::ROOMS` / `map.ts`'s `SIDE_ROOMS`. This tool sizes each painting's floor to EXACTLY that
block, in world units, at the lobby's own units-per-pixel (parsed out of rooms.gen.ts's
`LOBBY_IMG`), so a seat the chain puts inside a room is drawn on its floor with no offset
anywhere; each room's door is drawn on the edge it is left by, over its `exit_tiles`. The two
lobby arches are re-derived here from their painted pixels through the same transform and
must land on the rooms' `door_tiles`, or the tool refuses: the arch on screen and the tiles
the chain answers the knock from are one fact. The stairs have no arch; their glow is the
painted stair itself.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import pathlib
import re
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import archer_sheet as A  # noqa: E402  -- the archer's bow and palette, for the rack

LOBBY = ROOT / "assets" / "rooms" / "lobby.png"
MAP = ROOT / "assets" / "map" / "arena.json"
ROOMS_TS = ROOT / "app" / "src" / "render" / "rooms.gen.ts"
MARKS = (
    ("solana", "SOLANA", ROOT / "assets" / "sprites" / "solana-mark.png"),
    ("magicblock", "MAGICBLOCK", ROOT / "assets" / "sprites" / "magicblock-mark.png"),
)
OUT_DIR = ROOT / "app" / "src" / "render"
OUT_TS = OUT_DIR / "siderooms.gen.ts"

# Crops, in lobby.png pixels: (x0, y0, x1, y1).
WALL = (20, 730, 120, 800)  # a plain stretch of the west wall's face, the wall's full thickness
FLOOR_BAND = (344, 640, 1351, 940)  # the painted floor; the calmest FLOOR_SIZE window of it is the tile
FLOOR_SIZE = (440, 140)
FRONT_BAND = (150, 950, 1550, 1010)  # the south wall's top course; the calmest FRONT_SIZE window of it
FRONT_SIZE = (360, 60)
TORCH = (116, 605, 152, 705)  # the standing torch beside the west door
DOOR_E = (1575, 590, 1675, 725)  # the east wall's door, as painted
DOOR_W = (20, 590, 120, 725)  # the west wall's door, as painted (the whole wall thickness)
ARCH_W_PX = (32, 600, 108, 720)  # the west arch alone, in the lobby: threshold, glow, the open frame
ARCH_E_PX = (1587, 600, 1663, 720)  # the east arch alone, in the lobby
DOOR_W_ARCH = tuple(v - o for v, o in zip(ARCH_W_PX, (DOOR_W[0], DOOR_W[1], DOOR_W[0], DOOR_W[1])))
DOOR_E_ARCH = tuple(v - o for v, o in zip(ARCH_E_PX, (DOOR_E[0], DOOR_E[1], DOOR_E[0], DOOR_E[1])))
STAIRS = (757, 966, 943, 1086)  # the stair between its two pillars, the wall's exact height
STAIRS_PX = (790, 996, 910, 1086)  # the treads alone, in the lobby: the glow on the way down
STAIRS_ARCH = tuple(v - o for v, o in zip(STAIRS_PX, (STAIRS[0], STAIRS[1], STAIRS[0], STAIRS[1])))
OUT_PROPS = OUT_DIR / "siderooms-props.png"
THROAT = (0x0C, 0x0A, 0x14)  # the dark inside an open doorway
GLOW_RGB = (0xFF, 0xB0, 0x4A)  # the room's light spilling through it
BANNER_REF = (22, 775, 72, 870)  # the painted banner whose cloth colour the new ones borrow

# The chambers' walls, in the same pixels. Each FLOOR is sized from the chain's tiles.
SIDE = WALL[2] - WALL[0]  # wall thickness: the painting's own
BACK = 120
FRONT_H = FRONT_SIZE[1]
ART = 2  # px per art pixel on every piece of furniture
BANNER_W, BANNER_H = 50, 90  # art px
BANNER_TOP = 10
BANNER_GAP = 110  # each banner's centre from the floor's middle, px
MARK_PX = 34
TORCH_INSET = 40  # the torches' distance in from the side walls
TORCH_Y = BACK - 25
LIGHT_R_PX = 95  # the lobby's torch reach, 57 units, in these pixels

OUTLINE = (0x0F, 0x0D, 0x12)  # `PAL.outline`
ROD = (0x5A, 0x3A, 0x22)
ROD_KNOB = (0x8A, 0x5A, 0x30)
STONE = ((0x3A, 0x36, 0x44), (0x55, 0x50, 0x62), (0x76, 0x70, 0x86), (0x2A, 0x27, 0x33))  # dark, mid, light, crack
GOLD = ((0x8A, 0x5E, 0x1E), (0xD9, 0xA4, 0x41), (0xF2, 0xCF, 0x6B))
WOOD = ((0x3F, 0x2A, 0x17), (0x6B, 0x4A, 0x2C), (0xA8, 0x81, 0x4F))
STRAW = ((0x8A, 0x6E, 0x2E), (0xC9, 0xA2, 0x4A), (0xE8, 0xC8, 0x72))
GLASS = ((0x10, 0x14, 0x22), (0x1C, 0x24, 0x3A), (0x3A, 0x48, 0x66))
BONE = ((0xB8, 0xB0, 0x9C), (0xE6, 0xDF, 0xCC), (0xFF, 0xFA, 0xEE))
RUBY = (0xC9, 0x3A, 0x4A)
SAND = ((0xD0, 0x9A, 0x3C), (0xF0, 0xC4, 0x66))


# ---------------------------------------------------------------------------
# Painting helpers
# ---------------------------------------------------------------------------


def crop(im: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    return im.crop(box)


def tile(dst: Image.Image, src: Image.Image, box: tuple[int, int, int, int]) -> None:
    """Fill `box` of `dst` with `src` repeated, every other column and row mirrored: a mirror
    seam is continuous where a butt seam is a visible edge, and the repeat reads less as a
    stamp."""
    x0, y0, x1, y1 = box
    sw, sh = src.size
    for row, y in enumerate(range(y0, y1, sh)):
        band = src.transpose(Image.Transpose.FLIP_TOP_BOTTOM) if row % 2 else src
        for col, x in enumerate(range(x0, x1, sw)):
            piece = band.transpose(Image.Transpose.FLIP_LEFT_RIGHT) if col % 2 else band
            dst.paste(piece.crop((0, 0, min(sw, x1 - x), min(sh, y1 - y))), (x, y))


def calmest(im: Image.Image, band: tuple[int, int, int, int], size: tuple[int, int]) -> tuple[int, int, int, int]:
    """The `size` window inside `band` with the least luminance variance: plain paint, no
    torch, marking or prop in it. Deterministic, stepped by 10 px."""
    x0, y0, x1, y1 = band
    w, h = size
    lum = np.asarray(im.convert("L"), np.float32)
    best = None
    for y in range(y0, y1 - h + 1, 10):
        for x in range(x0, x1 - w + 1, 10):
            v = float(lum[y : y + h, x : x + w].std())
            if best is None or v < best[0]:
                best = (v, x, y)
    assert best is not None
    return (best[1], best[2], best[1] + w, best[2] + h)


def feathered(im: Image.Image) -> Image.Image:
    """A crop with its rectangle dissolved: alpha 1 in an elliptical core, 0 at the edge, so
    the paint behind the torch fades into whatever it is pasted on."""
    w, h = im.size
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.sqrt(((xx + 0.5 - w / 2) / (w / 2)) ** 2 + ((yy + 0.5 - h / 2) / (h / 2)) ** 2)
    a = np.clip(1.7 - 1.7 * r, 0, 1)
    out = im.convert("RGBA")
    out.putalpha(Image.fromarray((a * 255).astype(np.uint8), "L"))
    return out


# ---------------------------------------------------------------------------
# Art pixels
# ---------------------------------------------------------------------------

RGB = tuple[int, int, int]


class Art:
    """An RGBA canvas in art pixels, pasted onto a painting at `ART` px per pixel."""

    def __init__(self, w: int, h: int) -> None:
        self.px = np.zeros((h, w, 4), np.uint8)
        self.w, self.h = w, h

    def put(self, x0: int, y0: int, x1: int, y1: int, rgb: RGB) -> None:
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, self.w), min(y1, self.h)
        if x1 > x0 and y1 > y0:
            self.px[y0:y1, x0:x1, :3] = rgb
            self.px[y0:y1, x0:x1, 3] = 255

    def dot(self, x: int, y: int, rgb: RGB) -> None:
        self.put(x, y, x + 1, y + 1, rgb)

    def clear(self, x0: int, y0: int, x1: int, y1: int) -> None:
        self.px[max(y0, 0) : y1, max(x0, 0) : x1, 3] = 0

    def outline(self, rgb: RGB = OUTLINE) -> None:
        """A keyline on every transparent pixel with a 4-neighbour in the shape."""
        m = self.px[..., 3] > 0
        ring = np.zeros_like(m)
        ring[1:, :] |= m[:-1, :]
        ring[:-1, :] |= m[1:, :]
        ring[:, 1:] |= m[:, :-1]
        ring[:, :-1] |= m[:, 1:]
        ring &= ~m
        self.px[ring, :3] = rgb
        self.px[ring, 3] = 255

    def blit(self, other: "Art", x: int, y: int) -> None:
        h, w = other.px.shape[:2]
        x0, y0 = max(x, 0), max(y, 0)
        x1, y1 = min(x + w, self.w), min(y + h, self.h)
        if x1 <= x0 or y1 <= y0:
            return
        src = other.px[y0 - y : y1 - y, x0 - x : x1 - x]
        a = src[..., 3:4] > 0
        dst = self.px[y0:y1, x0:x1]
        dst[...] = np.where(a, src, dst)

    def image(self) -> Image.Image:
        return Image.fromarray(self.px, "RGBA").resize((self.w * ART, self.h * ART), Image.Resampling.NEAREST)


def rounded(art: Art, x0: int, y0: int, x1: int, y1: int, r: int, rgb: RGB) -> None:
    """A rectangle with its top corners rounded by `r` art px -- the slab and tablet shape."""
    art.put(x0, y0 + r, x1, y1, rgb)
    for i in range(r):
        inset = r - int(math.sqrt(r * r - (r - i - 0.5) ** 2) + 0.5)
        art.put(x0 + inset, y0 + i, x1 - inset, y0 + i + 1, rgb)


def premultiplied_reduce(im: Image.Image, size: tuple[int, int]) -> np.ndarray:
    """Box-reduce an RGBA image without the dark fringe a straight resize leaves on the edge
    of a transparent shape: premultiply, reduce each channel, divide back out."""
    a = np.asarray(im.convert("RGBA")).astype(np.float32) / 255.0
    rgb = a[..., :3] * a[..., 3:4]
    chans = [Image.fromarray(c, "F").resize(size, Image.Resampling.BOX) for c in (rgb[..., 0], rgb[..., 1], rgb[..., 2], a[..., 3])]
    out = np.stack([np.asarray(c) for c in chans], axis=-1)
    alpha = out[..., 3:4]
    out[..., :3] = np.where(alpha > 0, out[..., :3] / np.maximum(alpha, 1e-6), 0)
    return np.clip(out, 0, 1)


def pixel_mark(path: pathlib.Path, colors: int) -> np.ndarray:
    """The official mark as `MARK_PX` art pixels: reduced, alpha-cut, quantised to `colors`,
    with a one-pixel outline. Returns RGBA uint8 (h, w, 4)."""
    src = Image.open(path).convert("RGBA")
    src = src.crop(src.getbbox())
    sw, sh = src.size
    scale = (MARK_PX - 2) / max(sw, sh)
    size = (max(1, round(sw * scale)), max(1, round(sh * scale)))
    small = premultiplied_reduce(src, size)
    mask = small[..., 3] >= 0.5
    rgb = (small[..., :3] * 255).round().astype(np.uint8)
    flat = rgb[mask]
    pal_im = Image.fromarray(flat.reshape(1, -1, 3), "RGB").quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = np.asarray(pal_im.getpalette(), np.uint8).reshape(-1, 3)
    idx = np.asarray(pal_im).reshape(-1)
    rgb[mask] = pal[idx]
    h, w = mask.shape
    art = Art(w + 2, h + 2)
    art.px[1 : h + 1, 1 : w + 1, :3] = rgb
    art.px[1 : h + 1, 1 : w + 1, 3] = mask * 255
    art.outline()
    return art.px


def banner(cloth: RGB, mark: np.ndarray) -> Image.Image:
    """One hanging banner: a rod, a cloth with a lighter trim and a swallowtail hem, the mark
    centred on it."""
    trim = tuple(min(255, int(c * 1.7) + 12) for c in cloth)
    fold = tuple(int(c * 0.72) for c in cloth)
    art = Art(BANNER_W, BANNER_H)
    art.put(0, 0, BANNER_W, 2, ROD)
    art.put(0, 0, 3, 3, ROD_KNOB)
    art.put(BANNER_W - 3, 0, BANNER_W, 3, ROD_KNOB)
    art.put(4, 2, BANNER_W - 4, BANNER_H, OUTLINE)
    art.put(5, 3, BANNER_W - 5, BANNER_H - 1, cloth)
    art.put(6, 4, BANNER_W - 6, 5, trim)
    art.put(6, 4, 7, BANNER_H - 2, trim)
    art.put(BANNER_W - 7, 4, BANNER_W - 6, BANNER_H - 2, trim)
    art.put(14, 5, 15, BANNER_H - 8, fold)
    art.put(BANNER_W - 15, 5, BANNER_W - 14, BANNER_H - 8, fold)
    mid = BANNER_W // 2
    for i in range(10):
        y = BANNER_H - 1 - i
        half = 10 - i
        art.clear(mid - half, y, mid + half, y + 1)
        for x in (mid - half - 1, mid + half):
            if 4 <= x < BANNER_W - 4:
                art.dot(x, y, OUTLINE)
    mh, mw = mark.shape[:2]
    m = Art(mw, mh)
    m.px[...] = mark
    art.blit(m, (BANNER_W - mw) // 2, 22 + (MARK_PX - mh) // 2)
    return art.image()


def tablet(w: int, h: int) -> Image.Image:
    """A stone tablet for the records: a rounded slab with a chiselled panel; the panel is
    where `SideRooms.tsx` writes the rows."""
    art = Art(w, h)
    rounded(art, 1, 1, w - 1, h - 1, 6, STONE[1])
    rounded(art, 3, 3, w - 3, h - 3, 4, STONE[2])
    art.put(4, 6, w - 4, h - 4, STONE[0])
    # A few chips and a crack, so three are not one stamp.
    art.dot(2, h - 3, STONE[3])
    art.put(w - 5, 2, w - 3, 3, STONE[3])
    for i in range(4):
        art.dot(5 + i, h - 5 - i, STONE[3])
    art.outline()
    return art.image()


def chest() -> Image.Image:
    """A banded chest on a stone plinth, lid shut, a lock on the front."""
    w, h = 34, 30
    art = Art(w, h)
    art.put(1, 21, w - 1, h - 1, STONE[1])  # the plinth
    art.put(3, 22, w - 3, 23, STONE[2])
    art.put(4, 10, 30, 21, WOOD[1])  # the body
    art.put(4, 10, 30, 12, WOOD[2])
    rounded(art, 4, 4, 30, 11, 4, WOOD[1])  # the lid
    rounded(art, 5, 5, 29, 8, 3, WOOD[2])
    for x in (7, 16, 25):  # bands
        art.put(x, 4, x + 2, 21, GOLD[1])
        art.put(x, 4, x + 1, 21, GOLD[0])
    art.put(15, 12, 19, 17, GOLD[1])  # the lock
    art.put(16, 13, 18, 15, GOLD[0])
    art.dot(17, 15, OUTLINE)
    art.put(4, 20, 30, 21, WOOD[0])
    art.outline()
    return art.image()


def mirror() -> tuple[Image.Image, tuple[int, int, int, int]]:
    """A framed standing mirror, dark glass; returns the glass rect in art px, where the
    archer's own reflection is drawn."""
    w, h = 58, 92
    art = Art(w, h)
    art.put(22, 86, 36, 91, WOOD[1])  # the foot
    art.put(18, 90, 40, 91, WOOD[0])
    rounded(art, 3, 1, w - 3, 87, 14, GOLD[0])  # the frame
    rounded(art, 5, 3, w - 5, 85, 13, GOLD[1])
    rounded(art, 7, 5, w - 7, 83, 12, GLASS[0])  # the glass
    art.put(9, 10, 11, 70, GLASS[1])  # a sheen
    art.put(10, 8, 12, 10, GLASS[2])
    art.outline()
    return art.image(), (7, 5, w - 7, 83)


def bow_rack() -> Image.Image:
    """A wooden rack with two of the archer's own bows on it, drawn from the sheet's block."""
    bow = A.strip_chars(A.BOW, "")
    bh, bw = len(bow), len(bow[0])
    w, h = 44, bh + 12
    art = Art(w, h)
    art.put(1, 1, 5, h - 1, WOOD[1])  # the posts
    art.put(w - 5, 1, w - 1, h - 1, WOOD[1])
    art.put(1, 4, w - 1, 6, WOOD[2])  # the rails
    art.put(1, h - 8, w - 1, h - 6, WOOD[2])
    pal = {**A.PALETTE, **A.skin_palette(A.read_skin_colors()[0])}
    for bx in (9, 25):
        for y, row in enumerate(bow):
            for x, ch in enumerate(row):
                if ch != ".":
                    hexc = pal[ch].lstrip("#")
                    art.dot(bx + x, 6 + y, (int(hexc[0:2], 16), int(hexc[2:4], 16), int(hexc[4:6], 16)))
    art.outline()
    return art.image()


def dummy() -> Image.Image:
    """A straw training dummy on a post, a ring target on its chest."""
    w, h = 22, 44
    art = Art(w, h)
    art.put(9, 30, 13, 43, WOOD[1])  # the post
    art.put(6, 41, 16, 43, WOOD[0])
    rounded(art, 4, 2, 18, 12, 6, STRAW[1])  # the head
    art.put(6, 4, 9, 6, STRAW[2])
    rounded(art, 2, 12, 20, 32, 5, STRAW[1])  # the body
    art.put(2, 30, 20, 32, STRAW[0])
    art.put(1, 15, 3, 24, STRAW[0])
    art.put(19, 15, 21, 24, STRAW[0])
    for r, c in ((6, RUBY), (4, BONE[1]), (2, RUBY)):  # the target rings
        art.put(11 - r, 21 - r, 11 + r, 21 + r, c)
    art.outline()
    return art.image()


def bale() -> Image.Image:
    """A hay bale, two rope bands round it: the range's backstop."""
    w, h = 30, 18
    art = Art(w, h)
    rounded(art, 1, 1, w - 1, h - 1, 4, STRAW[1])
    art.put(2, h - 4, w - 2, h - 1, STRAW[0])
    art.put(3, 2, w - 3, 4, STRAW[2])
    for x in (9, 20):
        art.put(x, 1, x + 2, h - 1, WOOD[0])
    for i in range(6):  # loose stalks
        art.dot(4 + i * 4, 6 + (i % 3), STRAW[2])
    art.outline()
    return art.image()


# ---------------------------------------------------------------------------
# The rooms
# ---------------------------------------------------------------------------


# The leaf inside an arch crop, in that crop's pixels: a rectangle with a round top. The two
# arches are mirror images at the same place in their crops (the painting is symmetric), so
# one shape fits both. Checked by eye against docs/art/rooms/doors-open.png.
LEAF = (13, 20, 63, 111)  # x0, y0, x1, y1
LEAF_R = 25  # the round top's radius


def leaf_mask(w: int, h: int) -> np.ndarray:
    x0, y0, x1, y1 = LEAF
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = (x0 + x1) / 2, y0 + LEAF_R
    body = (xx >= x0) & (xx < x1) & (yy >= cy) & (yy < y1)
    top = ((xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2 <= LEAF_R * LEAF_R) & (yy < cy)
    return body | top


def open_arch(lobby: Image.Image, arch: tuple[int, int, int, int]) -> Image.Image:
    """The painted doorway with its leaf gone: the stones stay, the wood becomes a dark
    throat with the room's light spilling up from its floor."""
    im = np.asarray(crop(lobby, arch)).astype(np.float32)
    h, w = im.shape[:2]
    leaf = leaf_mask(w, h)
    yy, xx = np.mgrid[0:h, 0:w]
    t = yy / max(h - 1, 1)
    throat = np.stack([np.full((h, w), c, np.float32) for c in THROAT], axis=-1)
    d = np.sqrt(((xx + 0.5 - w / 2) / (w * 0.55)) ** 2 + ((yy + 0.5 - h * 0.95) / (h * 0.6)) ** 2)
    glow = np.clip(1 - d, 0, 1) ** 1.5 * 0.85
    lit = throat + (np.array(GLOW_RGB, np.float32) - throat) * glow[..., None]
    lit += 16 * t[..., None]  # the floor catches more than the lintel
    # A step of lit stone at the sill, so the throat has a floor.
    sill = leaf & (yy >= LEAF[3] - 6)
    lit = np.where(sill[..., None], im * 0.9 + np.array(GLOW_RGB, np.float32) * 0.25, lit)
    out = np.where(leaf[..., None], lit, im)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def lit_stairs(lobby: Image.Image) -> Image.Image:
    """The stair treads with light coming up them from below."""
    im = np.asarray(crop(lobby, STAIRS_PX)).astype(np.float32)
    h, w = im.shape[:2]
    t = (np.arange(h, dtype=np.float32) / max(h - 1, 1))[:, None, None]
    out = im * (1.05 + 0.4 * t) + np.array(GLOW_RGB, np.float32) * (0.06 + 0.2 * t)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")


def prop_frames(lobby: Image.Image) -> tuple[Image.Image, dict[str, tuple[int, int, int, int]]]:
    """The props side by side in one atlas: the west arch and east arch drawn open, the stair
    lit, and the range's straw man. Returns the atlas and each frame's rect in it."""
    frames = [("west", open_arch(lobby, ARCH_W_PX)), ("east", open_arch(lobby, ARCH_E_PX)), ("stairs", lit_stairs(lobby)), ("dummy", dummy())]
    W = sum(f.width for _, f in frames)
    H = max(f.height for _, f in frames)
    atlas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rects = {}
    x = 0
    for name, f in frames:
        atlas.paste(f, (x, 0))
        rects[name] = (x, 0, f.width, f.height)
        x += f.width
    return atlas, rects


def lobby_fit() -> tuple[float, float, float, float]:
    """`LOBBY_IMG` off rooms.gen.ts: (x, y, w, h) in world units."""
    m = re.search(r"LOBBY_IMG: ImgRect = \{ src: lobbyPng, x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+) \}", ROOMS_TS.read_text())
    if m is None:
        raise SystemExit("gen_side_rooms: LOBBY_IMG not found in rooms.gen.ts; run gen_rooms.py first")
    return tuple(float(v) for v in m.groups())  # type: ignore[return-value]


class Shell:
    """One chamber's walls, floor and front, sized to its floor tiles, plus the world
    transform every anchor goes through."""

    def __init__(self, lobby: Image.Image, s: float, room: dict, tile_px: int, floor: Image.Image, front: Image.Image) -> None:
        rc, rr, rcols, rrows = room["room_tiles"]
        self.room_x, self.room_y = rc * tile_px, rr * tile_px
        room_w, room_h = rcols * tile_px, rrows * tile_px
        self.floor_w, self.floor_h = round(room_w / s), round(room_h / s)
        self.sx, self.sy = room_w / self.floor_w, room_h / self.floor_h
        self.W, self.H = self.floor_w + 2 * SIDE, self.floor_h + BACK + FRONT_H
        self.img_x, self.img_y = self.room_x - SIDE * self.sx, self.room_y - BACK * self.sy
        self.tile_px = tile_px
        self.s = s
        self.im = Image.new("RGB", (self.W, self.H), OUTLINE)
        tile(self.im, floor, (SIDE, BACK, self.W - SIDE, self.H - FRONT_H))
        wall = crop(lobby, WALL)
        tile(self.im, wall, (0, 0, self.W, BACK))
        tile(self.im, wall, (0, 0, SIDE, self.H))
        tile(self.im, wall, (self.W - SIDE, 0, self.W, self.H))
        tile(self.im, front, (0, self.H - FRONT_H, self.W, self.H))
        self.lights: list[dict] = []
        self.labels: list[tuple[float, float, str]] = []
        self.anchors: dict[str, tuple[float, float, float, float]] = {}

    def to_world(self, px: float, py: float) -> tuple[float, float]:
        return self.img_x + px * self.sx, self.img_y + py * self.sy

    def rect_world(self, x0: float, y0: float, x1: float, y1: float) -> tuple[float, float, float, float]:
        wx, wy = self.to_world(x0, y0)
        return wx, wy, (x1 - x0) * self.sx, (y1 - y0) * self.sy

    def tile_px_x(self, col: int) -> float:
        return SIDE + (col * self.tile_px - self.room_x) / self.sx

    def tile_px_y(self, row: int) -> float:
        return BACK + (row * self.tile_px - self.room_y) / self.sy

    def torches(self, lobby: Image.Image, xs: tuple[int, ...] | None = None) -> None:
        torch = crop(lobby, TORCH)
        soft = feathered(torch)
        t = np.asarray(torch).astype(int)
        lum = t[..., 0] * 3 + t[..., 1] * 4 + t[..., 2]
        ty, tx = np.unravel_index(int(lum.argmax()), lum.shape)
        flame = "#%02x%02x%02x" % tuple(int(v) for v in t[ty, tx])
        for x in xs or (SIDE + TORCH_INSET, self.W - SIDE - TORCH_INSET - torch.width):
            self.im.paste(soft, (x, TORCH_Y), soft)
            wx, wy = self.to_world(x + tx, TORCH_Y + ty)
            self.lights.append({"x": wx, "y": wy, "r": LIGHT_R_PX * self.s, "color": flame})

    def label(self, cx: float, baseline: float, text: str) -> None:
        self.labels.append((cx, baseline, text))

    def anchor(self, key: str, x0: float, y0: float, x1: float, y1: float) -> None:
        self.anchors[key] = self.rect_world(x0, y0, x1, y1)

    def paste(self, piece: Image.Image, x: int, y: int) -> None:
        self.im.paste(piece, (x, y), piece if piece.mode == "RGBA" else None)


def exit_span(shell: Shell, room: dict) -> tuple[float, float, float, float]:
    """The exit tiles' rect in the painting's px: (x0, y0, x1, y1)."""
    ec, er, ecols, erows = room["exit_tiles"]
    return shell.tile_px_x(ec), shell.tile_px_y(er), shell.tile_px_x(ec + ecols), shell.tile_px_y(er + erows)


def door_east(shell: Shell, lobby: Image.Image, room: dict) -> tuple[float, float, float, float]:
    """The painted east door on the east wall, its arch centred on the exit rows."""
    door = crop(lobby, DOOR_E)
    _, y0, _, y1 = exit_span(shell, room)
    at = (shell.W - SIDE, round(y0 + (y1 - y0 - door.height) / 2))
    shell.paste(door, *at)
    ax0, ay0, ax1, ay1 = DOOR_E_ARCH
    return shell.rect_world(at[0] + ax0, at[1] + ay0, at[0] + ax1, at[1] + ay1)


def door_west(shell: Shell, lobby: Image.Image, room: dict) -> tuple[float, float, float, float]:
    """The painted west door on the west wall, its arch centred on the exit rows."""
    door = crop(lobby, DOOR_W)
    _, y0, _, y1 = exit_span(shell, room)
    at = (0, round(y0 + (y1 - y0 - door.height) / 2))
    shell.paste(door, *at)
    ax0, ay0, ax1, ay1 = DOOR_W_ARCH
    return shell.rect_world(at[0] + ax0, at[1] + ay0, at[0] + ax1, at[1] + ay1)


def stairs_north(shell: Shell, lobby: Image.Image, room: dict) -> tuple[float, float, float, float]:
    """The lobby's painted stair on the back wall, centred over the exit columns: the way up."""
    st = crop(lobby, STAIRS)
    x0, _, x1, _ = exit_span(shell, room)
    at = (round((x0 + x1) / 2 - st.width / 2), BACK - st.height)
    shell.paste(st, *at)
    tx0, ty0 = STAIRS_PX[0] - STAIRS[0], STAIRS_PX[1] - STAIRS[1]
    tx1, ty1 = STAIRS_PX[2] - STAIRS[0], STAIRS_PX[3] - STAIRS[1]
    return shell.rect_world(at[0] + tx0, at[1] + ty0, at[0] + tx1, at[1] + ty1)


def dress_secret(shell: Shell, lobby: Image.Image) -> None:
    shell.torches(lobby)
    ref = np.asarray(crop(lobby, BANNER_REF))
    cloth = tuple(int(v) for v in np.median(ref[20:60, 12:38].reshape(-1, 3), axis=0))
    mid = SIDE + shell.floor_w / 2
    for (key, text, path), cx in zip(MARKS, (mid - BANNER_GAP, mid + BANNER_GAP)):
        b = banner(cloth, pixel_mark(path, 5 if key == "solana" else 2))
        shell.paste(b, round(cx - b.width / 2), BANNER_TOP)
        shell.label(cx, BANNER_TOP + b.height + 16, text)
    shell.label(shell.W / 2, shell.H - FRONT_H - 14, "every step and every arrow is a transaction")


def dress_keep(shell: Shell, lobby: Image.Image) -> None:
    """Records on the back wall, the vault against the east wall, the armoury on the west."""
    shell.torches(lobby, (SIDE + 8, shell.W - SIDE - 8 - (TORCH[2] - TORCH[0])))
    # Three tablets across the back wall, their panels the rows' text boxes.
    tw, th = 44, 50
    t_img = tablet(tw, th)
    gap = 12
    total = 3 * t_img.width + 2 * gap
    x = round(SIDE + shell.floor_w / 2 - total / 2)
    for i in range(3):
        shell.paste(t_img, x, 8)
        shell.anchor(f"tablet{i}", x + 4 * ART, 8 + 6 * ART, x + (tw - 4) * ART, 8 + (th - 4) * ART)
        x += t_img.width + gap
    shell.label(SIDE + shell.floor_w / 2, 8 + t_img.height + 16, "RECORDS")
    # The vault: a chest on its plinth against the east wall, and the glow of what is in it.
    c = chest()
    cx, cy = shell.W - SIDE - c.width - 16, BACK + 24
    shell.paste(c, cx, cy)
    shell.anchor("chest", cx - 30, cy + c.height + 4, cx + c.width + 30, cy + c.height + 40)
    fx, fy = shell.to_world(cx + c.width / 2, cy + c.height / 2)
    shell.lights.append({"x": fx, "y": fy, "r": 34 * shell.s, "color": "#f2cf6b"})
    shell.label(cx + c.width / 2, cy - 10, "VAULT")
    # The armoury: the rack and the dummy on the west, the mirror between them.
    r = bow_rack()
    rx, ry = SIDE + 14, BACK + 18
    shell.paste(r, rx, ry)
    m, glass = mirror()
    mx, my = rx + r.width + 16, BACK + 4
    shell.paste(m, mx, my)
    shell.anchor("mirror", mx + glass[0] * ART, my + glass[1] * ART, mx + glass[2] * ART, my + glass[3] * ART)
    d = dummy()
    dx, dy = mx + m.width + 14, BACK + 30
    shell.paste(d, dx, dy)
    shell.label((rx + dx + d.width) / 2, my + m.height + 22, "ARMOURY")
    shell.label(shell.W / 2, shell.H - FRONT_H - 14, "what the chain remembers, what pays for it, who you are")


def dress_range(shell: Shell, lobby: Image.Image) -> None:
    """A long hall: a firing line of posts and rope a quarter in from the west wall, hay bales
    stacked against the east wall, and three straw men in front of them. The straw men are
    NOT painted -- `SideRooms.tsx` draws them from the props atlas so they can flinch -- only
    their stands are, and their rects are the anchors that are also their hitboxes."""
    shell.torches(lobby, (SIDE + 40, shell.W - SIDE - 40 - (TORCH[2] - TORCH[0])))
    post = Art(6, 20)
    post.put(2, 0, 4, 18, WOOD[1])
    post.put(2, 0, 4, 2, WOOD[2])
    post.put(1, 17, 5, 20, WOOD[0])
    post.outline()
    p_img = post.image()
    line_x = SIDE + round(shell.floor_w * 0.28)
    y0, y1 = BACK + 6, shell.H - FRONT_H - 6
    rope = Image.new("RGBA", (ART, y1 - y0), (*WOOD[2], 255))
    shell.paste(rope, line_x + 2 * ART, y0)
    for y in range(y0, y1 - p_img.height, 56):
        shell.paste(p_img, line_x, y)
    b_img = bale()
    bx = shell.W - SIDE - b_img.width - 8
    for i, y in enumerate(range(BACK + 10, shell.H - FRONT_H - b_img.height, b_img.height + 6)):
        shell.paste(b_img, bx - (8 if i % 2 else 0), y)
    dw, dh = 22 * ART, 44 * ART
    dx = bx - 44 - dw
    for i, frac in enumerate((0.2, 0.5, 0.8)):
        dy = round(BACK + shell.floor_h * frac - dh / 2)
        shell.anchor(f"dummy{i}", dx, dy, dx + dw, dy + dh)
        stand = Art(16, 4)
        stand.put(0, 0, 16, 4, STONE[0])
        stand.put(1, 0, 15, 1, STONE[2])
        stand.outline()
        st = stand.image()
        shell.paste(st, dx + (dw - st.width) // 2, dy + dh - st.height + 2)
        for k in range(16):
            sx = dx + (k * 19) % (dw + 36) - 18
            sy = dy + dh - 4 + (k * 5) % 12
            shell.im.putpixel((max(0, min(shell.W - 1, sx)), max(0, min(shell.H - 1, sy))), STRAW[1 if k % 3 else 2])
    # Over the firing line, clear of the stair on the back wall.
    shell.label(line_x + 3 * ART, BACK - 14, "THE RANGE")
    shell.label(shell.W / 2, shell.H - FRONT_H - 14, "loose at the straw \u00b7 every arrow is a transaction")


DRESS = {"secret": dress_secret, "keep": dress_keep, "range": dress_range}
DOOR = {2: door_east, 6: door_west, 0: stairs_north}  # by the room's `leave` octant
LEAVE_OF = {"W": 2, "E": 6, "S": 0, "N": 4}
# The open frame drawn at each of a room's two doorways, by knock: the lobby's arch, and
# the room's own door, which is the opposite arch (or the same stair).
DOOR_KINDS = {"W": ("west", "east"), "E": ("east", "west"), "S": ("stairs", "stairs")}


def build() -> tuple[dict[str, bytes], bytes, str]:
    lobby = Image.open(LOBBY).convert("RGB")
    fx, fy, fw, fh = lobby_fit()
    s = fw / lobby.width
    if abs(s - fh / lobby.height) > 1e-3:
        raise SystemExit("gen_side_rooms: the lobby fit is not uniform; rooms.gen.ts is stale")
    spec = json.loads(MAP.read_text())
    tile_px = spec["tile_size"]
    rooms = spec["doors"]["rooms"]
    floor = crop(lobby, calmest(lobby, FLOOR_BAND, FLOOR_SIZE))
    front = crop(lobby, calmest(lobby, FRONT_BAND, FRONT_SIZE))

    def lobby_rect(px: tuple[int, int, int, int]) -> tuple[float, float, float, float]:
        return fx + px[0] * s, fy + px[1] * s, (px[2] - px[0]) * s, (px[3] - px[1]) * s

    def arch_tiles(px: tuple[int, int, int, int], knock: str) -> list[int]:
        """The tiles a painted arch answers the knock from: the first floor column beside it
        (or the row under it), the rows (columns) whose centre lies within it."""
        x0, y0, x1, y1 = lobby_rect(px)
        x1, y1 = x0 + x1, y0 + y1
        n = spec["map_tiles"]
        if knock == "W":
            col = math.ceil(x1 / tile_px)
            rows = [r for r in range(n) if y0 <= r * tile_px + tile_px / 2 < y1]
            return [col, rows[0], 1, len(rows)]
        if knock == "E":
            col = math.floor(x0 / tile_px) - 1
            rows = [r for r in range(n) if y0 <= r * tile_px + tile_px / 2 < y1]
            return [col, rows[0], 1, len(rows)]
        raise SystemExit(f"gen_side_rooms: no arch rule for knock {knock}")

    LOBBY_GLOW = {"W": ARCH_W_PX, "E": ARCH_E_PX, "S": STAIRS_PX}

    pngs: dict[str, bytes] = {}
    entries = []
    for room in rooms:
        name, knock = room["name"], room["knock"]
        if knock in ("W", "E"):
            derived = arch_tiles(LOBBY_GLOW[knock], knock)
            dc, dr, _, drows = room["door_tiles"]
            # The block may be taller than the arch (a seat pushing the wall a tile above or
            # below it still goes through), but the arch must lie inside it, in its column.
            if not (derived[0] == dc and dr <= derived[1] and derived[1] + derived[3] <= dr + drows):
                raise SystemExit(
                    f"gen_side_rooms: {name}: the painted arch {LOBBY_GLOW[knock]} lands on tiles {derived}, "
                    f"outside arena.json's door_tiles {room['door_tiles']} -- re-measure one of them"
                )
        shell = Shell(lobby, s, room, tile_px, floor, front)
        arch_room = DOOR[LEAVE_OF[knock]](shell, lobby, room)
        DRESS[name](shell, lobby)
        buf = io.BytesIO()
        shell.im.save(buf, "PNG", optimize=True)
        pngs[name] = buf.getvalue()
        entries.append((name, shell, lobby_rect(LOBBY_GLOW[knock]), arch_room, DOOR_KINDS[knock]))

    props_atlas, prop_rects = prop_frames(lobby)
    dbuf = io.BytesIO()
    props_atlas.save(dbuf, "PNG", optimize=True)

    def f4(v: float) -> str:
        return f"{round(v, 4):g}"

    def rect(r: tuple[float, float, float, float]) -> str:
        return f"{{ x: {f4(r[0])}, y: {f4(r[1])}, w: {f4(r[2])}, h: {f4(r[3])} }}"

    parts = []
    for name, sh, glow_lobby, arch_room, (door_lobby, door_room) in entries:
        def block(items: list[str], open_: str, close: str) -> str:
            return open_ + close if not items else open_ + "\n" + "".join(f"      {it},\n" for it in items) + "    " + close

        lights = block([f"{{ x: {f4(l['x'])}, y: {f4(l['y'])}, r: {f4(l['r'])}, color: '{l['color']}' }}" for l in sh.lights], "[", "]")
        labels = block([f"{{ x: {f4(sh.to_world(x, y)[0])}, y: {f4(sh.to_world(x, y)[1])}, text: '{t}' }}" for x, y, t in sh.labels], "[", "]")
        anchors = block([f"{k}: {rect(v)}" for k, v in sh.anchors.items()], "{", "}")
        parts.append(
            f"  {name}: {{\n"
            f"    img: {{ src: {name}Png, x: {f4(sh.img_x)}, y: {f4(sh.img_y)}, w: {f4(sh.W * sh.sx)}, h: {f4(sh.H * sh.sy)} }},\n"
            f"    floor: {rect((sh.room_x, sh.room_y, sh.floor_w * sh.sx, sh.floor_h * sh.sy))},\n"
            f"    lights: {lights},\n"
            f"    labels: {labels},\n"
            f"    archLobby: {rect(glow_lobby)},\n"
            f"    archRoom: {rect(arch_room)},\n"
            f"    doorLobby: '{door_lobby}',\n"
            f"    doorRoom: '{door_room}',\n"
            f"    anchors: {anchors},\n"
            f"  }},"
        )
    imports = "\n".join(f"import {name}Png from './rooms/{name}.png?no-inline';" for name, *_ in entries)
    prop_rects_ts = ", ".join(f"{k}: {{ x: {x}, y: {y}, w: {w}, h: {h} }}" for k, (x, y, w, h) in prop_rects.items())
    symbol_ids = {"west": "door-west-open", "east": "door-east-open", "stairs": "door-stairs-open", "dummy": "range-dummy"}
    prop_defs = " +\n  ".join(
        f"`<symbol id=\"{symbol_ids[k]}\" viewBox=\"{x} {y} {w} {h}\">${{PROP_IMG}}</symbol>`" for k, (x, y, w, h) in prop_rects.items()
    )
    names = " | ".join(f"'{name}'" for name, *_ in entries)
    src = f"""// @generated from assets/map/arena.json `doors`, assets/rooms/lobby.png and assets/sprites/*-mark.png
// by `python3 tools/gen_side_rooms.py` -- DO NOT EDIT.
//
// The side rooms off the lobby, each painted onto the chain's own tiles. Every number here is
// in WORLD UNITS: a painting's floor is exactly its `SIDE_ROOMS[i].floor` (map.ts), so a seat
// the chain puts in a room's zone is drawn on its floor with no offset anywhere. Edit the
// tool or arena.json's `doors` block, then re-run the command above.
{imports}
import propsPng from './siderooms-props.png';

// Warm the paintings at import, as rooms.gen.ts warms the hall's: the first crossing into a
// room otherwise shows its veil and nothing else until the PNG lands, 0.3-1.5 s on the
// owner's own route.
if (typeof Image !== 'undefined') {{
  for (const src of [{', '.join(f'{name}Png' for name, *_ in entries)}, propsPng]) new Image().src = src;
}}
import type {{ ImgRect, RoomLight, WorldRect }} from './rooms.gen';

export type SideRoomName = {names};

/** The three doorways a seat can stand at, drawn open: the two painted arches and the stair. */
export type DoorKind = 'west' | 'east' | 'stairs';
/** Everything in the props atlas: the three open doorways and the range's straw man. */
export type PropKind = DoorKind | 'dummy';

export interface SideRoomArt {{
  /** The chamber, its floor on the chain's block. Mount with `imageRendering: 'auto'`. */
  readonly img: ImgRect;
  /** The painted floor, which `SideRooms.tsx` holds equal to the chain's block at boot. */
  readonly floor: WorldRect;
  /** The torches (and the vault's glow), for `roomGlow`. */
  readonly lights: readonly RoomLight[];
  /** Captions: centre x, baseline y. */
  readonly labels: readonly {{ x: number; y: number; text: string }}[];
  /** The painted doorway in the LOBBY the room is knocked on: the glow when a seat stands at it. */
  readonly archLobby: WorldRect;
  /** The painted doorway in the ROOM it is left by: the glow when a seat stands at the exit. */
  readonly archRoom: WorldRect;
  /** Which open frame each doorway shows: `archLobby`'s and `archRoom`'s. */
  readonly doorLobby: DoorKind;
  readonly doorRoom: DoorKind;
  /** Where the room's furniture takes text or a picture: tablets, the chest, the mirror, the slabs. */
  readonly anchors: Readonly<Record<string, WorldRect>>;
}}

export const SIDE_ROOM_ART: Readonly<Record<SideRoomName, SideRoomArt>> = {{
{chr(10).join(parts)}
}};

/** The props' rects in `siderooms-props.png`: each arch with its leaf gone, the stair lit, the straw man. */
export const PROP_FRAMES: Readonly<Record<PropKind, {{ x: number; y: number; w: number; h: number }}>> = {{ {prop_rects_ts} }};

const PROP_IMG = `<image href="${{propsPng}}" width="{props_atlas.width}" height="{props_atlas.height}"/>`;

/** The `<defs>` markup for the props, mounted once by whichever component owns the arena `<svg>`. */
export const PROP_DEFS =
  {prop_defs};
"""
    return pngs, dbuf.getvalue(), src


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="fail if the checked-in files are stale")
    args = ap.parse_args()
    pngs, props_png, src = build()
    outputs = [(OUT_DIR / "rooms" / f"{name}.png", png) for name, png in pngs.items()]
    outputs += [(OUT_PROPS, props_png), (OUT_TS, src.encode())]
    if args.check:
        stale = [p.relative_to(ROOT) for p, want in outputs if not p.exists() or p.read_bytes() != want]
        if stale:
            raise SystemExit(f"gen_side_rooms: stale: {', '.join(map(str, stale))}; re-run python3 tools/gen_side_rooms.py")
        print(f"gen_side_rooms: {len(outputs)} files are current")
        return
    for p, data in outputs:
        p.write_bytes(data)
        print(f"gen_side_rooms: wrote {p.relative_to(ROOT)} ({len(data)} B)")


if __name__ == "__main__":
    main()
