#!/usr/bin/env python3
"""THROWAWAY. Emit the `<defs>` block `tools/gen_knights.py` is specified to emit, so the
frame budget can be measured WITH the knight art that does not exist in the tree yet.

This is a cost model, not the generator. It follows spec 11 §8.2 for the two things that
decide raster cost — half resolution onto a 33x42 odd canvas, five poses per skin, three
skins — and does NOT attempt the pose authoring (contact frames are the rest frame with the
leg band sheared, `fallen` is the lossless transpose, `sil` is the flat union). Subpath
count and painted area are what the compositor charges for, and those are faithful.

Written to `defs.json` for the harness to inline. Nothing under tools/ is touched.
"""
import json
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tools"))
import px2svg  # noqa: E402
import svg_slice  # noqa: E402

W, H = 33, 42
# render-scale.md §1: the two paper fills, and the x-band valleys the three knights split on.
PAPER = {"#fdffff", "#ffffff"}
BANDS = [(0, 70), (70, 149), (149, 216)]
# The caption strip. Spec §8.2: crop by ROW RANGE, never by colour — those two whites are
# also 185 px of specular highlight inside the knights themselves.
CAPTION_ROWS = (130, 140)


def sprite(rects, x0, x1):
    keep = [r for r in rects if x0 <= r[0] < x1 and not (CAPTION_ROWS[0] <= r[1] < CAPTION_ROWS[1])]
    keep = [r for r in keep if r[4] not in PAPER]
    if not keep:
        raise SystemExit(f"band {x0}..{x1} is empty after the paper fills are dropped")
    return keep


def to_grid(rects):
    """Crop to the band's own bbox, rasterise, half-resolution, centre on the 33x42 canvas."""
    bx0 = min(r[0] for r in rects)
    by0 = min(r[1] for r in rects)
    bx1 = max(r[0] + r[2] for r in rects)
    by1 = max(r[1] + r[3] for r in rects)
    moved = [(x - bx0, y - by0, w, h, c) for x, y, w, h, c in rects]
    idx, pal = svg_slice.rasterize(moved, bx1 - bx0, by1 - by0)
    # rasterize uses -1 for transparent; mode_downsample needs non-negative indices.
    small = px2svg.mode_downsample(idx + 1, 2, len(pal) + 1) - 1
    out = np.full((H, W), -1, np.int16)
    sh, sw = small.shape
    ch, cw = min(H, sh), min(W, sw)
    oy, ox = (H - ch) // 2, (W - cw) // 2
    out[oy:oy + ch, ox:ox + cw] = small[:ch, :cw]
    return out, pal


def paths(grid, pal, transpose=False, flat=None):
    g = grid.T if transpose else grid
    if flat is not None:
        g = np.where(g >= 0, 0, -1).astype(np.int16)
        pal = [flat]
    rects = px2svg.merge_rects(g, -1)
    by = {}
    for x, y, w, h, c in rects:
        by.setdefault(pal[c], []).append(f"M{x} {y}h{w}v{h}h-{w}z")
    return "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in by.items()), len(rects)


def shear(grid, lo, hi, dx):
    """A contact frame: the leg band slid dx columns. Same pixels, a different silhouette."""
    out = grid.copy()
    out[lo:hi, :] = -1
    band = grid[lo:hi, :]
    if dx >= 0:
        out[lo:hi, dx:] = band[:, : W - dx]
    else:
        out[lo:hi, : W + dx] = band[:, -dx:]
    return out


def main():
    _, w, h, rects = svg_slice.parse(str(ROOT / "assets/sprites/knights.svg"))
    total = 0
    defs = []
    counts = {}
    for skin, (x0, x1) in enumerate(BANDS):
        grid, pal = to_grid(sprite(rects, x0, x1))
        legs = int(H * 0.62), H  # the lower ~38% of the canvas is the leg band
        poses = {
            "rest": grid,
            "contactL": shear(grid, legs[0], legs[1], -2),
            "contactR": shear(grid, legs[0], legs[1], 2),
        }
        for name, g in poses.items():
            d, n = paths(g, pal)
            defs.append(f'<g id="k{skin}-{name}">{d}</g>')
            total += n
            counts[f"k{skin}-{name}"] = n
        d, n = paths(grid, pal, transpose=True)
        defs.append(f'<g id="k{skin}-fallen">{d}</g>')
        total += n
        counts[f"k{skin}-fallen"] = n
        d, n = paths(grid, pal, flat="#ffffff")
        defs.append(f'<g id="k{skin}-sil">{d}</g>')
        total += n
        counts[f"k{skin}-sil"] = n
    out = "".join(defs)
    (pathlib.Path(__file__).parent / "defs.json").write_text(
        json.dumps({"defs": out, "subpaths": total, "bytes": len(out), "perPose": counts})
    )
    print(f"sheet {w}x{h}, {len(rects)} subpaths -> 15 pose groups, {total} subpaths, {len(out)} bytes")


if __name__ == "__main__":
    main()
