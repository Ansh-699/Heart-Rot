#!/usr/bin/env python3
"""The secret room -- a small chamber behind the lobby's west door, hung with the banners of
the two things the game runs on -- and the table `SecretRoom.tsx` places it with.

    python3 tools/gen_secret.py [--check]

The chamber is cut from the LOBBY PAINTING itself (assets/rooms/lobby.png): a plain stretch
of its west wall for the walls, a clean patch of its cobbles for the floor, the south wall's
top course for the front wall, its standing torch twice, and its east-wall door as the way
out -- so the room is in the painting's own hand, not a second style pasted next to it. The
two banners and the marks on them are drawn here at `ART` px per art pixel: the marks are the
official SVGs rasterised once to assets/sprites/{solana,magicblock}-mark.png, reduced to
`MARK_PX` art pixels, alpha-cut, colour-quantised and outlined, the way every sprite in the
game is. This tool is the only writer of app/src/render/rooms/secret.png and
app/src/render/secret.gen.ts; `--check` diffs both against disk.

World placement reuses the lobby's fit, parsed out of rooms.gen.ts's `LOBBY_IMG`, so the
chamber is drawn at the hall's own units-per-pixel, and the door threshold
(`SECRET_THRESHOLD`) is the door's painted pixels pushed through that same transform onto the
grid the chain walks -- checked here against the grid in assets/map/arena.json.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import pathlib
import re

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOBBY = ROOT / "assets" / "rooms" / "lobby.png"
MAP = ROOT / "assets" / "map" / "arena.json"
ROOMS_TS = ROOT / "app" / "src" / "render" / "rooms.gen.ts"
MARKS = (
    ("solana", "SOLANA", ROOT / "assets" / "sprites" / "solana-mark.png"),
    ("magicblock", "MAGICBLOCK", ROOT / "assets" / "sprites" / "magicblock-mark.png"),
)
OUT_PNG = ROOT / "app" / "src" / "render" / "rooms" / "secret.png"
OUT_TS = ROOT / "app" / "src" / "render" / "secret.gen.ts"

# Crops, in lobby.png pixels: (x0, y0, x1, y1).
WALL = (20, 730, 120, 800)  # a plain stretch of the west wall's face, the wall's full thickness
FLOOR_BAND = (344, 640, 1351, 940)  # the painted floor; the calmest FLOOR_SIZE window of it is the tile
FLOOR_SIZE = (440, 140)
FRONT_BAND = (150, 950, 1550, 1010)  # the south wall's top course; the calmest FRONT_SIZE window of it
FRONT_SIZE = (360, 60)
TORCH = (116, 605, 152, 705)  # the standing torch beside the west door
DOOR_E = (1575, 590, 1675, 725)  # the east wall's door, as painted: the way back out
DOOR_W = (26, 600, 118, 720)  # the west door's arch: the threshold and the glow are measured off it
BANNER_REF = (22, 775, 72, 870)  # the painted banner whose cloth colour the new ones borrow

# The chamber, in the same pixels.
W, H = 720, 460
SIDE = WALL[2] - WALL[0]  # wall thickness: the painting's own
BACK = 120
FRONT_H = FRONT_SIZE[1]
ART = 2  # px per art pixel on the banners and marks
BANNER_W, BANNER_H = 50, 90  # art px
BANNER_TOP = 10
BANNER_X = (200, 420)  # left edges, px: centred on the floor at ±110 of its middle
MARK_PX = 34
TORCH_X = (132, 552)
TORCH_Y = BACK - 25
DOOR_E_AT = (W - (DOOR_E[2] - DOOR_E[0]), BACK + 20)
STAND = (W - SIDE - 24, 300)  # the knight, just inside the door
LIGHT_R_PX = 95  # the lobby's torch reach, 57 units, in these pixels

OUTLINE = (0x0F, 0x0D, 0x12)  # `PAL.outline`
ROD = (0x5A, 0x3A, 0x22)
ROD_KNOB = (0x8A, 0x5A, 0x30)


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
    # Quantise the colours of the shape alone to a few bands: a pixel mark has bands, not a
    # gradient of one-off colours.
    flat = rgb[mask]
    pal_im = Image.fromarray(flat.reshape(1, -1, 3), "RGB").quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    pal = np.asarray(pal_im.getpalette(), np.uint8).reshape(-1, 3)
    idx = np.asarray(pal_im).reshape(-1)
    rgb[mask] = pal[idx]
    h, w = mask.shape
    out = np.zeros((h + 2, w + 2, 4), np.uint8)
    out[1 : h + 1, 1 : w + 1, :3] = rgb
    out[1 : h + 1, 1 : w + 1, 3] = mask * 255
    # Outline: every transparent pixel with a 4-neighbour in the shape.
    padded = np.zeros((h + 2, w + 2), bool)
    padded[1 : h + 1, 1 : w + 1] = mask
    ring = np.zeros_like(padded)
    ring[1:, :] |= padded[:-1, :]
    ring[:-1, :] |= padded[1:, :]
    ring[:, 1:] |= padded[:, :-1]
    ring[:, :-1] |= padded[:, 1:]
    ring &= ~padded
    out[ring, :3] = OUTLINE
    out[ring, 3] = 255
    return out


def banner(cloth: tuple[int, int, int], mark: np.ndarray) -> Image.Image:
    """One hanging banner in art pixels, scaled up by `ART`: a rod, a cloth with a lighter
    trim and a swallowtail hem, the mark centred on it."""
    trim = tuple(min(255, int(c * 1.7) + 12) for c in cloth)
    fold = tuple(int(c * 0.72) for c in cloth)
    px = np.zeros((BANNER_H, BANNER_W, 4), np.uint8)

    def put(x0: int, y0: int, x1: int, y1: int, rgb: tuple[int, int, int]) -> None:
        px[y0:y1, x0:x1, :3] = rgb
        px[y0:y1, x0:x1, 3] = 255

    put(0, 0, BANNER_W, 2, ROD)
    put(0, 0, 3, 3, ROD_KNOB)
    put(BANNER_W - 3, 0, BANNER_W, 3, ROD_KNOB)
    put(4, 2, BANNER_W - 4, BANNER_H, OUTLINE)
    put(5, 3, BANNER_W - 5, BANNER_H - 1, cloth)
    put(6, 4, BANNER_W - 6, 5, trim)
    put(6, 4, 7, BANNER_H - 2, trim)
    put(BANNER_W - 7, 4, BANNER_W - 6, BANNER_H - 2, trim)
    # Two folds where the cloth hangs off the rod.
    put(14, 5, 15, BANNER_H - 8, fold)
    put(BANNER_W - 15, 5, BANNER_W - 14, BANNER_H - 8, fold)
    # The swallowtail: a notch rising from the hem's middle, its edges outlined.
    mid = BANNER_W // 2
    for i in range(10):
        y = BANNER_H - 1 - i
        half = 10 - i
        px[y, mid - half : mid + half, 3] = 0
        for x in (mid - half - 1, mid + half):
            if 4 <= x < BANNER_W - 4:
                px[y, x, :3] = OUTLINE
                px[y, x, 3] = 255
    mh, mw = mark.shape[:2]
    mx, my = (BANNER_W - mw) // 2, 22 + (MARK_PX - mh) // 2
    a = mark[..., 3:4] > 0
    region = px[my : my + mh, mx : mx + mw]
    region[...] = np.where(a, mark, region)
    im = Image.fromarray(px, "RGBA")
    return im.resize((BANNER_W * ART, BANNER_H * ART), Image.Resampling.NEAREST)


def lobby_fit() -> tuple[float, float, float, float]:
    """`LOBBY_IMG` off rooms.gen.ts: (x, y, w, h) in world units."""
    m = re.search(r"LOBBY_IMG: ImgRect = \{ src: lobbyPng, x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+) \}", ROOMS_TS.read_text())
    if m is None:
        raise SystemExit("gen_secret: LOBBY_IMG not found in rooms.gen.ts; run gen_rooms.py first")
    return tuple(float(v) for v in m.groups())  # type: ignore[return-value]


def build() -> tuple[bytes, str]:
    lobby = Image.open(LOBBY).convert("RGB")
    fx, fy, fw, fh = lobby_fit()
    s = fw / lobby.width
    if abs(s - fh / lobby.height) > 1e-3:
        raise SystemExit("gen_secret: the lobby fit is not uniform; rooms.gen.ts is stale")
    spec = json.loads(MAP.read_text())
    tile_px, tiles = spec["tile_size"], spec["map_tiles"]
    units = tile_px * tiles
    grid = spec["grid"]

    floor = crop(lobby, calmest(lobby, FLOOR_BAND, FLOOR_SIZE))
    front = crop(lobby, calmest(lobby, FRONT_BAND, FRONT_SIZE))
    room = Image.new("RGB", (W, H), OUTLINE)
    tile(room, floor, (SIDE, BACK, W - SIDE, H - FRONT_H))
    tile(room, crop(lobby, WALL), (0, 0, W, BACK))
    tile(room, crop(lobby, WALL), (0, 0, SIDE, H))
    tile(room, crop(lobby, WALL), (W - SIDE, 0, W, H))
    tile(room, front, (0, H - FRONT_H, W, H))
    room.paste(crop(lobby, DOOR_E), DOOR_E_AT)
    torch = crop(lobby, TORCH)
    soft = feathered(torch)
    for x in TORCH_X:
        room.paste(soft, (x, TORCH_Y), soft)

    ref = np.asarray(crop(lobby, BANNER_REF))
    cloth = tuple(int(v) for v in np.median(ref[20:60, 12:38].reshape(-1, 3), axis=0))
    labels = []
    for (key, text, path), bx in zip(MARKS, BANNER_X):
        colors = 5 if key == "solana" else 2
        b = banner(cloth, pixel_mark(path, colors))
        room.paste(b, (bx, BANNER_TOP), b)
        labels.append((bx + BANNER_W * ART / 2, BANNER_TOP + BANNER_H * ART + 16, text))

    # The torch's flame, read off the paint: its brightest pixel and that pixel's colour.
    t = np.asarray(torch).astype(int)
    lum = t[..., 0] * 3 + t[..., 1] * 4 + t[..., 2]
    ty, tx = np.unravel_index(int(lum.argmax()), lum.shape)
    flame = "#%02x%02x%02x" % tuple(int(v) for v in t[ty, tx])

    # World placement: centred in the lobby's view, at the lobby's own fit.
    rw, rh = W * s, H * s
    rx, ry = (units - rw) / 2, fy + (fh - rh) / 2

    def to_world(px: float, py: float) -> tuple[float, float]:
        return rx + px * s, ry + py * s

    lights = [dict(zip(("x", "y"), to_world(x + tx, TORCH_Y + ty))) | {"r": LIGHT_R_PX * s, "color": flame} for x in TORCH_X]
    stand = to_world(*STAND)

    # The west door in the LOBBY's world, and the tiles a raider pushes west from: the first
    # floor column right of the arch, the rows whose centre lies within it.
    dx0, dy0 = fx + DOOR_W[0] * s, fy + DOOR_W[1] * s
    dx1, dy1 = fx + DOOR_W[2] * s, fy + DOOR_W[3] * s
    col = math.ceil(dx1 / tile_px)
    rows = [r for r in range(tiles) if dy0 <= r * tile_px + tile_px / 2 < dy1]
    if len(rows) < 3:
        raise SystemExit(f"gen_secret: the door spans only rows {rows}; re-measure DOOR_W")
    for r in rows:
        if grid[r][col] == "#" or grid[r][col - 1] != "#":
            raise SystemExit(f"gen_secret: tile ({col}, {r}) is not floor beside wall; the door has moved off the grid")
    threshold = (col * tile_px, rows[0] * tile_px, tile_px, len(rows) * tile_px)

    # Truecolour, not a 256-colour palette: a median cut over this much brown and grey has no
    # entries left for the marks, and the Solana bars came out one flat teal.
    buf = io.BytesIO()
    room.save(buf, "PNG", optimize=True)

    def f4(v: float) -> str:
        return f"{round(v, 4):g}"

    def rect(x: float, y: float, w: float, h: float) -> str:
        return f"{{ x: {f4(x)}, y: {f4(y)}, w: {f4(w)}, h: {f4(h)} }}"

    lights_ts = ",\n".join(f"  {{ x: {f4(l['x'])}, y: {f4(l['y'])}, r: {f4(l['r'])}, color: '{l['color']}' }}" for l in lights)
    labels_ts = ",\n".join(f"  {{ x: {f4(to_world(x, y)[0])}, y: {f4(to_world(x, y)[1])}, text: '{text}' }}" for x, y, text in labels)
    caption = to_world(W / 2, H - FRONT_H - 14)
    src = f"""// @generated from assets/rooms/lobby.png and assets/sprites/*-mark.png by `python3 tools/gen_secret.py` -- DO NOT EDIT.
//
// The chamber behind the lobby's west door. Every number here is in WORLD UNITS at the
// lobby's own fit (`LOBBY_IMG`), so the room, its lights and the door threshold move with the
// painting. Edit the tool, then re-run the command above.
import secretPng from './rooms/secret.png?no-inline';
import type {{ ImgRect, RoomLight, WorldRect }} from './rooms.gen';

/** The chamber ({W}x{H} px), centred in the lobby's view. Mount with `imageRendering: 'auto'`. */
export const SECRET_IMG: ImgRect = {{ src: secretPng, x: {f4(rx)}, y: {f4(ry)}, w: {f4(rw)}, h: {f4(rh)} }};

/** The two torches, for `roomGlow`. */
export const SECRET_LIGHTS: readonly RoomLight[] = [
{lights_ts},
];

/** Each banner's caption: centre x, baseline y. */
export const SECRET_LABELS: readonly {{ x: number; y: number; text: string }}[] = [
{labels_ts},
];

/** The one-line caption above the front wall: centre x, baseline y. */
export const SECRET_CAPTION = {{ x: {f4(caption[0])}, y: {f4(caption[1])} }} as const;

/** Where the local knight stands, just inside the door: the sprite's centre. */
export const SECRET_STAND = {{ x: {f4(stand[0])}, y: {f4(stand[1])} }} as const;

/** The lobby's west door, the painted arch, for the glow that answers a raider standing at it. */
export const SECRET_DOOR: WorldRect = {rect(dx0, dy0, dx1 - dx0, dy1 - dy0)};

/** The tiles a raider pushes WEST from to open the door: floor column {col}, rows {rows[0]}..{rows[-1]}. */
export const SECRET_THRESHOLD: WorldRect = {rect(*threshold)};
"""
    return buf.getvalue(), src


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="fail if the checked-in files are stale")
    args = ap.parse_args()
    png, src = build()
    if args.check:
        stale = [p.relative_to(ROOT) for p, want in ((OUT_PNG, png), (OUT_TS, src.encode())) if not p.exists() or p.read_bytes() != want]
        if stale:
            raise SystemExit(f"gen_secret: stale: {', '.join(map(str, stale))}; re-run python3 tools/gen_secret.py")
        print(f"gen_secret: {OUT_PNG.relative_to(ROOT)} and {OUT_TS.relative_to(ROOT)} are current")
        return
    OUT_PNG.write_bytes(png)
    OUT_TS.write_text(src)
    print(f"gen_secret: wrote {OUT_PNG.relative_to(ROOT)} ({len(png)} B) and {OUT_TS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
