#!/usr/bin/env python3
"""Compose the archer sheet into one atlas PNG and the frame table the renderer reads.

    python3 tools/gen_knights.py [--check]

`tools/archer_sheet.py` is the art. This tool is the only thing allowed to write
`app/src/render/archer.png` and `app/src/render/knights.gen.ts`; both carry a generated
banner and hand-editing either recreates the defect this project keeps paying for -- one
fact stored twice, drifting.

WHAT IT DOES:

1.  **Compose** every authored direction x pose (5 x 10) into a 33x42 character grid, then
    index it three times -- once per skin -- by swapping the tunic characters for that
    skin's ramp. 150 body frames.

2.  **Derive** two more sets from those, never authored: `sil`, the flat silhouette in
    `PAL.selfRing` (the hit flash; skin-independent, so 50), and `halo`, the silhouette
    grown two pixels and hollowed, in the skin's rim colour (150). Two pixels is a
    device-pixel argument: at the 1 px/unit floor a one-unit rim antialiases to nothing.

3.  **Dedupe and pack.** Frames are keyed by their bytes, so the five `fallen` poses (one
    transposed corpse, whatever the facing) and any coincident silhouettes share one atlas
    rect. Shelf-packed by height into one palette PNG; the renderer crops it with nested
    `<svg viewBox>` elements, so the atlas is one decoded bitmap for all twenty seats.

4.  **Self-check** before writing: no frame empty, every standing body 22..30 px wide
    (the 24-unit `PLAYER_HIT_RADIUS` rule -- `archer_sheet.py` docstring), feet on the
    bottom row (one up on the two pass frames), the atlas under its byte budget.

`--check` regenerates in memory and diffs both outputs against disk, exiting 1 on drift.
"""

from __future__ import annotations

import argparse
import io
import math
import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import archer_sheet as A  # noqa: E402

OUT_PNG = ROOT / "app" / "src" / "render" / "archer.png"
OUT_TS = ROOT / "app" / "src" / "render" / "knights.gen.ts"

# How far the halo grows out of the silhouette, in canvas pixels. See step 2 above.
HALO_PX = 2

# The body-width rule, inclusive. Below it the figure is a sliver inside its own hit
# circle; above it the art takes hits the chain does not score.
BODY_W = (22, 30)

# The atlas budget. It is served hashed and immutable, but it is also decoded on the first
# frame the arena mounts, and it is a bound on how much art a re-author may add.
ATLAS_MAX_BYTES = 80 * 1024

Grid = np.ndarray  # uint8, 0 = transparent, else a palette index


class Palette:
    """Colour -> index, index 0 reserved for transparent."""

    def __init__(self) -> None:
        self.colors: list[str] = ["#000000"]

    def index(self, hex_color: str) -> int:
        if hex_color not in self.colors:
            self.colors.append(hex_color)
        return self.colors.index(hex_color)


def index_grid(chars: list[list[str]], table: dict[str, int]) -> Grid:
    h, w = len(chars), len(chars[0])
    out = np.zeros((h, w), np.uint8)
    for y in range(h):
        for x in range(w):
            c = chars[y][x]
            if c != ".":
                out[y, x] = table[c]
    return out


def halo(mask: np.ndarray) -> np.ndarray:
    """The silhouette grown HALO_PX (4-neighbour, a Manhattan ball) and hollowed."""
    grown = mask.copy()
    for _ in range(HALO_PX):
        step = grown.copy()
        step[1:, :] |= grown[:-1, :]
        step[:-1, :] |= grown[1:, :]
        step[:, 1:] |= grown[:, :-1]
        step[:, :-1] |= grown[:, 1:]
        grown = step
    return grown & ~mask


def check_frame(key: str, chars: list[list[str]], pose: str) -> None:
    mask = np.array([[c != "." for c in row] for row in chars])
    if not mask.any():
        raise SystemExit(f"gen_knights: frame {key} is empty")
    if pose == "fallen":
        return
    cols = np.flatnonzero(mask.any(axis=0))
    width = int(cols[-1] - cols[0] + 1)
    if not BODY_W[0] <= width <= BODY_W[1]:
        raise SystemExit(f"gen_knights: frame {key} is {width} px wide, outside {BODY_W}")
    feet = int(np.flatnonzero(mask.any(axis=1))[-1])
    want = A.FEET_ROW - 1 if pose in ("walk1", "walk3") else A.FEET_ROW
    if feet != want:
        raise SystemExit(f"gen_knights: frame {key} stands on row {feet}, not {want}")


def pack(frames: dict[str, Grid]) -> tuple[dict[str, tuple[int, int, int, int]], Grid]:
    """Shelf-pack the unique frames. -> (key -> (x, y, w, h), atlas)."""
    unique: dict[bytes, tuple[Grid, list[str]]] = {}
    for key, g in frames.items():
        unique.setdefault(g.tobytes() + bytes(g.shape), (g, []))[1].append(key)
    order = sorted(unique.values(), key=lambda u: (-u[0].shape[0], u[1][0]))

    # Roughly square, in whole canvases: the browser decodes one bitmap either way.
    area = sum(g.shape[0] * g.shape[1] for g, _ in order)
    atlas_w = max(A.H, (math.isqrt(area) // A.W) * A.W)

    rects: dict[str, tuple[int, int, int, int]] = {}
    x = y = shelf_h = 0
    for g, keys in order:
        h, w = g.shape
        if x + w > atlas_w:
            x, y, shelf_h = 0, y + shelf_h, 0
        shelf_h = max(shelf_h, h)
        for k in keys:
            rects[k] = (x, y, w, h)
        x += w
    atlas_h = y + shelf_h
    atlas = np.zeros((atlas_h, atlas_w), np.uint8)
    for k, (rx, ry, w, h) in rects.items():
        atlas[ry : ry + h, rx : rx + w] = frames[k]
    return rects, atlas


def encode_png(atlas: Grid, palette: Palette) -> bytes:
    img = Image.fromarray(atlas, "P")
    flat: list[int] = []
    for c in palette.colors:
        flat.extend(int(c[i : i + 2], 16) for i in (1, 3, 5))
    img.putpalette(flat)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True, transparency=0)
    return buf.getvalue()


def build(body: str = A.SHIPPED_BODY) -> tuple[bytes, str, dict]:
    """-> (png bytes, typescript source, stats), for one of `A.BODIES`."""
    tints = A.read_skin_colors()
    self_ring = A.read_self_ring()
    palette = Palette()
    shared = {c: palette.index(hex_c) for c, hex_c in A.PALETTE.items()}
    skins = [dict(shared, **{c: palette.index(h) for c, h in A.skin_palette(t).items()}) for t in tints]
    sil_idx = palette.index(self_ring)
    halo_idx = [palette.index(A.halo_color(t)) for t in tints]

    frames: dict[str, Grid] = {}
    for d in A.DIRS:
        for pose in A.POSES:
            chars = A.compose(d, pose, body)
            check_frame(f"{body}/{d}-{pose}", chars, pose)
            mask = np.array([[c != "." for c in row] for row in chars])
            ring = halo(mask)
            frames[f"sil-{d}-{pose}"] = np.where(mask, sil_idx, 0).astype(np.uint8)
            for s, table in enumerate(skins):
                frames[f"{s}-{d}-{pose}"] = index_grid(chars, table)
                frames[f"halo{s}-{d}-{pose}"] = np.where(ring, halo_idx[s], 0).astype(np.uint8)

    rects, atlas = pack(frames)
    png = encode_png(atlas, palette)
    if len(png) > ATLAS_MAX_BYTES:
        raise SystemExit(f"gen_knights: archer.png is {len(png)} bytes, over {ATLAS_MAX_BYTES}")

    skin_ids = " | ".join(str(i) for i in range(len(tints)))
    dirs = " | ".join(f"'{d}'" for d in A.DIRS)
    poses = " | ".join(f"'{p}'" for p in A.POSES)
    tint_list = ", ".join(f"'{t}'" for t in tints)
    rows = "\n".join(f"  '{k}': [{x}, {y}, {w}, {h}]," for k, (x, y, w, h) in rects.items())
    unique = len({r for r in rects.values()})
    src = f"""// @generated from tools/archer_sheet.py by `python3 tools/gen_knights.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close. `FRAMES` is a contract
// with `app/src/render/Knight.tsx`, which crops `archer.png` through nested
// `<svg viewBox>` elements: a rect that drifts from the atlas draws a slice of some other
// pose and throws nothing. Edit the sheet or the tool, then re-run the command above.

import atlas from './archer.png';

/**
 * The canvas every standing pose is drawn on. **Odd on purpose**: a horizontal flip is
 * an exact permutation of columns only when the canvas has a centre column.
 *
 * `fallen` is the lossless 90-degree transpose and is therefore {A.H}x{A.W}; read every
 * frame's size from `FRAMES`, never from these.
 */
export const SPRITE_W = {A.W};
export const SPRITE_H = {A.H};

/**
 * Index **is** `skin_id` -- `PlayerSlot.skin_id`, offset 2, stored verbatim by
 * `handlers::player::join` and range-checked only by the Worker. `Knight.tsx` clamps on
 * this length; an unclamped lookup would throw inside the render of all twenty seats.
 *
 * The values are `SKIN_COLORS` (`screens/CharacterSelect.tsx`), read by the generator:
 * each skin is that hue on the tunic, so the roster dot and the figure agree.
 */
export const KNIGHT_SKINS = [{tint_list}] as const;

/** The atlas URL (Vite hashes it under `/assets/`), and its size for the `<image>`. */
export const ARCHER_ATLAS: string = atlas;
export const ATLAS_W = {atlas.shape[1]};
export const ATLAS_H = {atlas.shape[0]};

export type Dir = {dirs};
export type Pose = {poses};
export type SkinId = {skin_ids};
export type FrameKey = `${{SkinId}}-${{Dir}}-${{Pose}}` | `sil-${{Dir}}-${{Pose}}` | `halo${{SkinId}}-${{Dir}}-${{Pose}}`;

/**
 * Atlas rect `[x, y, w, h]` per frame. `sil` is the flat silhouette in `PAL.selfRing`;
 * `halo` is the silhouette grown {HALO_PX} px and hollowed, in the skin's rim colour.
 * {len(rects)} keys over {unique} unique rects (identical frames share one).
 */
export const FRAMES: Record<FrameKey, readonly [number, number, number, number]> = {{
{rows}
}};
"""
    stats = dict(frames=len(rects), unique=unique, atlas=atlas.shape, png=len(png), colors=len(palette.colors))
    return png, src, stats


def preview(out: pathlib.Path, scale: int = 4) -> None:
    """Every body, five directions, the poses that show a figure, side by side at `scale`,
    for a human to judge before one becomes `SHIPPED_BODY`. Nothing here is checked in."""
    from PIL import ImageDraw

    poses = ("idle", "walk0", "walk2", "draw", "charge1")
    tint = A.read_skin_colors()[0]
    pal = {**A.PALETTE, **A.skin_palette(tint)}
    cell_w, cell_h = A.W + 3, A.H + 3
    cols = len(A.DIRS) * len(poses)
    rows = len(A.BODIES)
    sheet = Image.new("RGB", (cols * cell_w * scale + 8, rows * (cell_h * scale + 18) + 8), (40, 36, 48))
    draw = ImageDraw.Draw(sheet)
    for r, body in enumerate(A.BODIES):
        y0 = 8 + r * (cell_h * scale + 18)
        draw.text((8, y0), body, fill=(230, 220, 200))
        for c, (d, pose) in enumerate((d, p) for d in A.DIRS for p in poses):
            chars = A.compose(d, pose, body)
            cell = Image.new("RGBA", (A.W, A.H), (0, 0, 0, 0))
            for y, row in enumerate(chars):
                for x, ch in enumerate(row):
                    if ch != ".":
                        h = pal[ch].lstrip("#")
                        cell.putpixel((x, y), (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255))
            big = cell.resize((A.W * scale, A.H * scale), Image.NEAREST)
            sheet.paste(big, (8 + c * cell_w * scale, y0 + 14), big)
    sheet.save(out)
    print(f"gen_knights: wrote {out}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the checked-in files are stale")
    ap.add_argument("--body", choices=sorted(A.BODIES), default=A.SHIPPED_BODY, help="which body to build the atlas from")
    ap.add_argument("--preview", metavar="PNG", help="write a comparison sheet of every body instead of the atlas")
    args = ap.parse_args()

    if args.preview:
        preview(pathlib.Path(args.preview))
        return

    png, src, stats = build(args.body)
    if args.check:
        stale = [
            str(p.relative_to(ROOT))
            for p, want in ((OUT_PNG, png), (OUT_TS, src))
            if not p.exists() or p.read_bytes() != (want if isinstance(want, bytes) else want.encode())
        ]
        if stale:
            raise SystemExit(f"gen_knights: stale: {', '.join(stale)} -- re-run tools/gen_knights.py")
        print(f"gen_knights: outputs are current ({stats['frames']} frames, {stats['png']} bytes)")
        return

    OUT_PNG.write_bytes(png)
    OUT_TS.write_text(src)
    print(
        f"gen_knights: {stats['frames']} frames ({stats['unique']} unique) -> "
        f"{stats['atlas'][1]}x{stats['atlas'][0]} atlas, {stats['colors']} colours, "
        f"{stats['png']} bytes -> {OUT_PNG.relative_to(ROOT)}, {OUT_TS.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
