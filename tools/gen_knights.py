#!/usr/bin/env python3
"""Compile the knight sheet into the renderer's `<defs>` block.

    python3 tools/gen_knights.py [--check]

`assets/sprites/knights.svg` is the map. This tool is the only thing allowed to write
`app/src/render/knights.gen.ts`; that file carries a generated banner and hand-editing it
recreates the defect this project keeps paying for -- one fact stored twice, drifting.

WHAT IT DOES, and why each step is the step (spec 11 §8.2, docs/art/knights.md):

1.  **Crop the caption strip by ROW RANGE, never by colour.** Rows 130..139 of the sheet
    are the reference's own captions, and they are `#ffffff` / `#fdffff` -- which are ALSO
    185 px of specular highlight *inside* the knights. Dropping the strip by colour paints
    a cream rectangle over the arena and flattens every helm highlight; dropping it by row
    keeps both facts straight. This is the single most likely way to misread the spec.

2.  **Split the sheet into three by x-band.** The three knights sit in the bands below,
    hand-authored and then VERIFIED here: each band's painted bbox must fall inside it and
    no painted pixel may fall between bands. A sheet re-traced at another size fails loudly
    rather than emitting two knights and half of a third.

3.  **Half resolution.** At 1:1 the drawn body is 2.11x the 24-unit chain hit diameter; at
    half it is 1.06x. The alternative -- full res -- would need `PLAYER_HIT_RADIUS` 12 ->
    ~25 in `tick.rs` and would rebalance every bullet in the game. `mode_downsample` takes
    the majority colour of each block rather than a mean, so no in-between shade is invented.

4.  **Five poses per skin.** `rest` (also the walk's pass frame, with a 1-unit bob applied
    by the renderer), `contactL` / `contactR` (the leg band slid two columns, same pixels),
    `fallen` (a lossless 90 degree transpose, so it lands on a TRANSPOSED 42x33 canvas --
    `Knight.tsx::poseBox` anchors off exactly that), and `sil` (the flat union, emitted with
    `fill="currentColor"` so the hit flash colours it from the `<use>`).

The canvas is 33x42, ODD on purpose: a horizontal flip is an exact permutation of columns
only when there is a centre column, so a mirrored knight lands on pixels instead of half a
unit off.

`--check` regenerates in memory and diffs against the file on disk, exiting 1 on drift.
"""

from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import px2svg  # noqa: E402
import svg_slice  # noqa: E402

SHEET = ROOT / "assets" / "sprites" / "knights.svg"
OUT_TS = ROOT / "app" / "src" / "render" / "knights.gen.ts"

# The canvas every pose but `fallen` is emitted on. Mirrored in `Knight.tsx` by import,
# never by a second literal.
W, H = 33, 42

# The caption strip, by row. See step 1 above -- this is a row range and must stay one.
CAPTION_ROWS = (130, 140)

# The sheet's paper. Only ever removed OUTSIDE a knight's own bbox, so the highlights the
# same two whites make inside the armour survive.
PAPER = {"#ffffff", "#fdffff"}

# Hand-authored, verified below: one half-open x-band per knight, left to right.
# 0 Cobalt (blue crest, horned helm, kite shield)
# 1 Nocturne (black mantle, gold trim, raised sword)
# 2 Argent (silver plate, cross-emblem round shield)
BANDS = ((0, 70), (70, 149), (149, 216))
SKIN_NAMES = ("Cobalt", "Nocturne", "Argent")

# The lower part of the canvas that a contact frame slides. 0.62 puts the split just under
# the belt on all three knights; it is a fraction of the canvas, not a row, so it survives
# a resolution change.
LEG_BAND_TOP = 0.62
# Columns a contact frame slides the leg band. One is invisible at half resolution, three
# detaches the legs from the hips.
CONTACT_DX = 2

POSES = ("rest", "contactL", "contactR", "fallen", "sil", "halo", "halo-fallen")

# How far the halo grows out of the silhouette, in canvas pixels. TWO, and that is a
# device-pixel argument rather than a taste one: at the 1.000 px/unit floor of the smallest
# supported stage (17-fullscreen-spec section 1.3) a one-unit rim is a single device pixel
# and antialiases to nothing. `docs/art/legibility.md` section 3.2 derives the same 2.
HALO_PX = 2

# The flat silhouette's fill. `currentColor` so `Knight.tsx` can set the flash colour on
# the `<use>` and have it reach the path.
SIL_FILL = "currentColor"


def band_rects(rects, x0, x1):
    """The sheet's rects for one knight: inside the band, off the caption strip, no paper."""
    keep = [
        r
        for r in rects
        if x0 <= r[0] < x1
        and not (CAPTION_ROWS[0] <= r[1] < CAPTION_ROWS[1])
        and r[4] not in PAPER
    ]
    if not keep:
        raise SystemExit(f"gen_knights: band {x0}..{x1} is empty -- the sheet was re-traced")
    return keep


def verify_bands(rects):
    """The hand-authored table, checked against the art it claims to describe.

    Two failures are possible and both are silent: a band that clips its own knight, and a
    painted pixel that belongs to no band at all. Neither shows up as an error later -- the
    first emits a knight with no shield, the second drops one entirely.
    """
    edges = [b[0] for b in BANDS] + [BANDS[-1][1]]
    for x0, x1 in BANDS:
        inside = band_rects(rects, x0, x1)
        left = min(r[0] for r in inside)
        right = max(r[0] + r[2] for r in inside)
        if left < x0 or right > x1:
            raise SystemExit(f"gen_knights: band {x0}..{x1} clips art spanning {left}..{right}")
    stray = [
        r
        for r in rects
        if r[4] not in PAPER
        and not (CAPTION_ROWS[0] <= r[1] < CAPTION_ROWS[1])
        and not any(x0 <= r[0] < x1 for x0, x1 in BANDS)
    ]
    if stray:
        raise SystemExit(
            f"gen_knights: {len(stray)} painted rects fall outside every band, first at "
            f"x={stray[0][0]} y={stray[0][1]} -- BANDS is stale"
        )
    return edges


def to_grid(rects):
    """Crop to the band's bbox, rasterise, halve, centre on the 33x42 canvas.

    -> (grid, palette). -1 is transparent.
    """
    bx0 = min(r[0] for r in rects)
    by0 = min(r[1] for r in rects)
    bx1 = max(r[0] + r[2] for r in rects)
    by1 = max(r[1] + r[3] for r in rects)
    moved = [(x - bx0, y - by0, w, h, c) for x, y, w, h, c in rects]
    idx, pal = svg_slice.rasterize(moved, bx1 - bx0, by1 - by0)
    # `rasterize` marks transparent as -1 and `mode_downsample` counts with `bincount`,
    # which needs non-negative indices -- so shift, downsample, shift back.
    small = px2svg.mode_downsample(idx + 1, 2, len(pal) + 1) - 1

    out = np.full((H, W), -1, np.int16)
    sh, sw = small.shape
    if sh > H or sw > W:
        raise SystemExit(
            f"gen_knights: a knight is {sw}x{sh} after halving and does not fit {W}x{H}"
        )
    # Centred horizontally, bottom-aligned vertically: the feet are the anchor. A knight
    # centred in y would stand a different distance above its own shadow per skin.
    ox = (W - sw) // 2
    out[H - sh :, ox : ox + sw] = small
    return out, pal


def halo(grid):
    """The silhouette grown {HALO_PX} px and hollowed out -- the boundary ring, not the body.

    This is what a knight is separated from the floor by. The shipped key light was `sil`
    offset one unit up-left, which covers only 11.5-15.8 % of the body and leaves the
    DOWN-RIGHT side with no boundary at all: there the outermost pixels are the sprite's
    own keyline, 1.06:1 against room B's p95 floor. A dilation has no side.

    4-neighbour, applied `HALO_PX` times, so the ring is a Manhattan ball -- a chamfered
    corner rather than a square one, which is what a 45-degree armour edge needs.

    `ponytail:` the ring is clipped by the canvas, which costs 7.8-11.7 % of it per skin
    (measured). The bottom row is the whole of the loss that matters and it is the feet,
    where the seat's own contact shadow already carries 7.02-7.04:1 against the floor. The
    upgrade is a larger canvas, which moves W/H, `poseBox`, the anchor and every offset
    `Knight.tsx` derives from them -- far more than a rim is worth.
    """
    mask = grid >= 0
    grown = mask.copy()
    for _ in range(HALO_PX):
        step = grown.copy()
        step[1:, :] |= grown[:-1, :]
        step[:-1, :] |= grown[1:, :]
        step[:, 1:] |= grown[:, :-1]
        step[:, :-1] |= grown[:, 1:]
        grown = step
    # Hollow: the body is drawn over this by the poses themselves, and a filled halo would
    # be a solid slab of rim colour with a knight on top of it.
    return np.where(grown & ~mask, 0, -1).astype(np.int16)


def shear(grid, dx):
    """A contact frame: the leg band slid `dx` columns. Same pixels, a different silhouette."""
    lo = int(H * LEG_BAND_TOP)
    out = grid.copy()
    out[lo:, :] = -1
    band = grid[lo:, :]
    if dx >= 0:
        out[lo:, dx:] = band[:, : W - dx]
    else:
        out[lo:, : W + dx] = band[:, -dx:]
    return out


def paths(grid, pal, flat=None):
    """`px2svg.merge_rects` over the grid, one `<path>` per colour."""
    if flat is not None:
        grid = np.where(grid >= 0, 0, -1).astype(np.int16)
        pal = [flat]
    by: dict[str, list[str]] = {}
    n = 0
    for x, y, w, h, c in px2svg.merge_rects(grid, -1):
        by.setdefault(pal[c], []).append(f"M{x} {y}h{w}v{h}h-{w}z")
        n += 1
    return "".join(f'<path fill="{c}" d="{"".join(d)}"/>' for c, d in by.items()), n


def build():
    """-> (typescript source, total subpath count)."""
    _, sheet_w, sheet_h, rects = svg_slice.parse(str(SHEET))
    verify_bands(rects)

    groups: list[str] = []
    total = 0
    for skin, (x0, x1) in enumerate(BANDS):
        grid, pal = to_grid(band_rects(rects, x0, x1))
        drawn = {
            "rest": (grid, None),
            "contactL": (shear(grid, -CONTACT_DX), None),
            "contactR": (shear(grid, CONTACT_DX), None),
            # Lossless: a transpose is a relabelling, so no pixel is invented or lost. It
            # lands on a 42x33 canvas, which is what `poseBox('fallen')` returns.
            "fallen": (grid.T, None),
            "sil": (grid, SIL_FILL),
            # Derived from art already checked in -- never authored, never hand-edited.
            # `currentColor` exactly as `sil` is, which is what lets `Knight.tsx` set the
            # per-skin rim colour on the one `<use>` and have it reach the path.
            "halo": (halo(grid), SIL_FILL),
            "halo-fallen": (halo(grid.T), SIL_FILL),
        }
        for pose in POSES:
            g, flat = drawn[pose]
            d, n = paths(g, pal, flat)
            groups.append(f'<g id="k{skin}-{pose}">{d}</g>')
            total += n

    defs = "".join(groups)
    skin_list = ", ".join(f"'{n}'" for n in SKIN_NAMES)
    src = f'''// @generated from assets/sprites/knights.svg by `python3 tools/gen_knights.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close. The ids below are a
// contract with `app/src/render/Knight.tsx`, which emits `<use href="#k{{skin}}-{{pose}}">`:
// a dangling href renders nothing and throws nothing, so a drifted id is twenty invisible
// knights and no error anywhere. Edit the sheet or the tool, then re-run the command above.

/**
 * The canvas every pose but `fallen` is drawn on. **Odd on purpose**: a horizontal flip is
 * an exact permutation of columns only when the canvas has a centre column.
 *
 * `fallen` is the lossless 90-degree transpose and is therefore {H}x{W}.
 */
export const SPRITE_W = {W};
export const SPRITE_H = {H};

/**
 * Index **is** `skin_id` -- `PlayerSlot.skin_id`, offset 2, stored verbatim by
 * `handlers::player::join` and range-checked only by the Worker. `Knight.tsx` clamps on
 * this length; an unclamped lookup would throw inside the render of all twenty seats.
 */
export const KNIGHT_SKINS = [{skin_list}] as const;

/**
 * The `<defs>` markup: {len(POSES)} poses x {len(BANDS)} skins = {len(groups)} `<g>` groups,
 * {total} subpaths total. Mounted once, in a `useMemo([], ...)`, by whichever component owns
 * the arena `<svg>`; React must never walk it again.
 */
export const KNIGHT_DEFS = {defs!r};
'''
    return src, total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the checked-in file is stale")
    args = ap.parse_args()

    src, total = build()
    if args.check:
        if not OUT_TS.exists() or OUT_TS.read_text() != src:
            raise SystemExit(f"gen_knights: {OUT_TS} is stale -- re-run tools/gen_knights.py")
        print(f"gen_knights: {OUT_TS} is current ({total} subpaths)")
        return

    OUT_TS.write_text(src)
    print(
        f"gen_knights: {len(BANDS)} skins x {len(POSES)} poses -> {len(BANDS) * len(POSES)} groups, "
        f"{total} subpaths, {len(src)} bytes -> {OUT_TS.relative_to(ROOT)}"
    )


if __name__ == "__main__":
    main()
