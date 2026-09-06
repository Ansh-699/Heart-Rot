#!/usr/bin/env python3
"""The secret room -- the chamber behind the lobby's west door, hung with the banners of
the two things the game runs on -- painted onto exactly the tiles the chain calls it.

    python3 tools/gen_secret.py [--check]

The chamber is cut from the LOBBY PAINTING itself (assets/rooms/lobby.png): a plain stretch
of its west wall for the walls, the calmest patch of its cobbles for the floor, the south
wall's top course for the front wall, its standing torch twice, and its east-wall door as the
way out -- so the room is in the painting's own hand, not a second style pasted next to it.
The two banners and the marks on them are drawn here at `ART` px per art pixel: the marks are
the official SVGs rasterised once to assets/sprites/{solana,magicblock}-mark.png, reduced to
`MARK_PX` art pixels, alpha-cut, colour-quantised and outlined, the way every sprite in the
game is. This tool is the only writer of app/src/render/rooms/secret.png and
app/src/render/secret.gen.ts; `--check` diffs both against disk.

WHERE IT GOES is not this tool's decision. The room is a zone on the chain (`ZONE_SECRET`),
and its floor is `secret.room_tiles` in assets/map/arena.json, which gen_map.py compiles to
`map::SECRET_ROOM` and `map.ts`'s `SECRET_ROOM`. This tool sizes the painting's floor to
EXACTLY that block, in world units, at the lobby's own units-per-pixel (parsed out of
rooms.gen.ts's `LOBBY_IMG`), so a seat the chain puts inside the room is drawn on the floor
with no offset anywhere. Its door is drawn over `secret.exit_tiles`. And the lobby door the
seat pushes -- `secret.door_tiles` -- is re-derived here from the painted arch's pixels
through the same transform and must agree, or the tool refuses: the arch on screen and the
tiles the chain answers the knock from are one fact.
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
DOOR_E_ARCH = (12, 10, 88, 130)  # the arch inside that crop, for the glow on the exit
DOOR_W = (26, 600, 118, 720)  # the west door's arch: the threshold and the glow are measured off it
BANNER_REF = (22, 775, 72, 870)  # the painted banner whose cloth colour the new ones borrow

# The chamber's walls, in the same pixels. The FLOOR is sized from the chain's tiles.
SIDE = WALL[2] - WALL[0]  # wall thickness: the painting's own
BACK = 120
FRONT_H = FRONT_SIZE[1]
ART = 2  # px per art pixel on the banners and marks
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
    tile_px = spec["tile_size"]
    secret = spec["secret"]
    rc, rr, rcols, rrows = secret["room_tiles"]
    ec, er, ecols, erows = secret["exit_tiles"]

    # The floor, in world units, is the chain's block; in pixels it is that at the lobby's
    # fit, rounded, and the per-axis scale is then whatever makes the two edges meet exactly.
    room_x, room_y, room_w, room_h = rc * tile_px, rr * tile_px, rcols * tile_px, rrows * tile_px
    floor_w, floor_h = round(room_w / s), round(room_h / s)
    sx, sy = room_w / floor_w, room_h / floor_h
    W, H = floor_w + 2 * SIDE, floor_h + BACK + FRONT_H
    img_x, img_y = room_x - SIDE * sx, room_y - BACK * sy

    def to_world(px: float, py: float) -> tuple[float, float]:
        return img_x + px * sx, img_y + py * sy

    floor = crop(lobby, calmest(lobby, FLOOR_BAND, FLOOR_SIZE))
    front = crop(lobby, calmest(lobby, FRONT_BAND, FRONT_SIZE))
    room = Image.new("RGB", (W, H), OUTLINE)
    tile(room, floor, (SIDE, BACK, W - SIDE, H - FRONT_H))
    tile(room, crop(lobby, WALL), (0, 0, W, BACK))
    tile(room, crop(lobby, WALL), (0, 0, SIDE, H))
    tile(room, crop(lobby, WALL), (W - SIDE, 0, W, H))
    tile(room, front, (0, H - FRONT_H, W, H))

    # The way out: the painted east door, on the east wall, its arch over the exit tiles.
    if ec + ecols != rc + rcols:
        raise SystemExit("gen_secret: exit_tiles are not the room's east column")
    door_e = crop(lobby, DOOR_E)
    exit_top_px = BACK + (er - rr) * tile_px / sy
    exit_h_px = erows * tile_px / sy
    door_at = (W - SIDE, round(exit_top_px + (exit_h_px - door_e.height) / 2))
    room.paste(door_e, door_at)
    ax0, ay0, ax1, ay1 = DOOR_E_ARCH
    arch_room = (*to_world(door_at[0] + ax0, door_at[1] + ay0), (ax1 - ax0) * sx, (ay1 - ay0) * sy)

    torch = crop(lobby, TORCH)
    soft = feathered(torch)
    torch_x = (SIDE + TORCH_INSET, W - SIDE - TORCH_INSET - torch.width)
    for x in torch_x:
        room.paste(soft, (x, TORCH_Y), soft)

    ref = np.asarray(crop(lobby, BANNER_REF))
    cloth = tuple(int(v) for v in np.median(ref[20:60, 12:38].reshape(-1, 3), axis=0))
    mid = SIDE + floor_w / 2
    labels = []
    for (key, text, path), cx in zip(MARKS, (mid - BANNER_GAP, mid + BANNER_GAP)):
        colors = 5 if key == "solana" else 2
        b = banner(cloth, pixel_mark(path, colors))
        bx = round(cx - BANNER_W * ART / 2)
        room.paste(b, (bx, BANNER_TOP), b)
        labels.append((cx, BANNER_TOP + BANNER_H * ART + 16, text))

    # The torch's flame, read off the paint: its brightest pixel and that pixel's colour.
    t = np.asarray(torch).astype(int)
    lum = t[..., 0] * 3 + t[..., 1] * 4 + t[..., 2]
    ty, tx = np.unravel_index(int(lum.argmax()), lum.shape)
    flame = "#%02x%02x%02x" % tuple(int(v) for v in t[ty, tx])
    lights = [dict(zip(("x", "y"), to_world(x + tx, TORCH_Y + ty))) | {"r": LIGHT_R_PX * s, "color": flame} for x in torch_x]

    # The lobby's west door, in the LOBBY's world: the painted arch (for the glow), and the
    # tiles a seat pushes west from -- the first floor column right of the arch, the rows
    # whose centre lies within it -- which MUST be what arena.json calls the door.
    dx0, dy0 = fx + DOOR_W[0] * s, fy + DOOR_W[1] * s
    dx1, dy1 = fx + DOOR_W[2] * s, fy + DOOR_W[3] * s
    col = math.ceil(dx1 / tile_px)
    rows = [r for r in range(spec["map_tiles"]) if dy0 <= r * tile_px + tile_px / 2 < dy1]
    derived = [col, rows[0], 1, len(rows)] if rows else None
    if derived != secret["door_tiles"]:
        raise SystemExit(
            f"gen_secret: the painted arch {DOOR_W} lands on tiles {derived}, but arena.json's "
            f"secret.door_tiles is {secret['door_tiles']} -- re-measure one of them"
        )

    buf = io.BytesIO()
    # Truecolour, not a 256-colour palette: a median cut over this much brown and grey has no
    # entries left for the marks, and the Solana bars came out one flat teal.
    room.save(buf, "PNG", optimize=True)

    def f4(v: float) -> str:
        return f"{round(v, 4):g}"

    def rect(x: float, y: float, w: float, h: float) -> str:
        return f"{{ x: {f4(x)}, y: {f4(y)}, w: {f4(w)}, h: {f4(h)} }}"

    lights_ts = ",\n".join(f"  {{ x: {f4(l['x'])}, y: {f4(l['y'])}, r: {f4(l['r'])}, color: '{l['color']}' }}" for l in lights)
    labels_ts = ",\n".join(f"  {{ x: {f4(to_world(x, y)[0])}, y: {f4(to_world(x, y)[1])}, text: '{text}' }}" for x, y, text in labels)
    caption = to_world(W / 2, H - FRONT_H - 14)
    src = f"""// @generated from assets/map/arena.json `secret`, assets/rooms/lobby.png and assets/sprites/*-mark.png
// by `python3 tools/gen_secret.py` -- DO NOT EDIT.
//
// The chamber behind the lobby's west door, painted onto the chain's own tiles. Every number
// here is in WORLD UNITS: the painting's floor is exactly `SECRET_ROOM` (map.ts), so a seat
// the chain puts in `ZONE_SECRET` is drawn on the floor with no offset anywhere. Edit the
// tool or arena.json's `secret` block, then re-run the command above.
import secretPng from './rooms/secret.png?no-inline';
import type {{ ImgRect, RoomLight, WorldRect }} from './rooms.gen';

/** The chamber ({W}x{H} px), its floor on `SECRET_ROOM`. Mount with `imageRendering: 'auto'`. */
export const SECRET_IMG: ImgRect = {{ src: secretPng, x: {f4(img_x)}, y: {f4(img_y)}, w: {f4(W * sx)}, h: {f4(H * sy)} }};

/** The painted floor, which `SecretRoom.tsx` holds equal to `SECRET_ROOM` at boot. */
export const SECRET_FLOOR: WorldRect = {rect(room_x, room_y, room_w, room_h)};

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

/** The lobby's west door, the painted arch: the glow when a seat stands in `SECRET_DOOR`. */
export const SECRET_ARCH_LOBBY: WorldRect = {rect(dx0, dy0, dx1 - dx0, dy1 - dy0)};

/** The room's east door, the painted arch: the glow when a seat stands in `SECRET_EXIT`. */
export const SECRET_ARCH_ROOM: WorldRect = {rect(*arch_room)};
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
