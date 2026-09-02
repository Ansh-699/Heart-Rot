#!/usr/bin/env python3
"""Draw the boss's ordnance atlas and the `<symbol>` table that crops it.

    python3 tools/gen_ordnance.py [--check]

Procedural, Pillow + numpy, no source art: the whole sheet is a few hundred lines of
arithmetic, so there is nothing to trace and nothing to re-trace. This tool is the only
thing allowed to write `app/src/render/ordnance.png` and `ordnance.gen.ts`; both carry
a generated banner and hand-editing either recreates the defect this project keeps
paying for -- one fact stored twice, drifting.

WHAT IT DRAWS, and why each shape is the shape:

1.  **Sixteen bullet frames**, one per 22.5 degree velocity sector. A bullet is a thorn
    seed -- a 14 px dark-olive core with an ember rim and two hot pixels -- dragging a
    22 px ember tail that tapers and cools behind it. The chain moves a bullet 42 units
    a tick, which at 60 Hz is ~7 units a frame: a dot that size strobes, and the tail is
    what makes 420 u/s legible rather than merely correct (it replaces `Arena.tsx`'s old
    `<line>` capsule, which carried the same argument). Each frame is DRAWN at its angle
    rather than rotated from one master: a rotated bitmap resamples into mush, a drawn
    one lands on pixels. The seed sits at the exact centre of every frame, so a `<use>`
    placed at `(-w/2, -h/2)` puts the bullet's published position on the seed and the
    tail trails behind it whatever the sector.

2.  **A three-frame muzzle burst**, laid out as a strip so ONE `<symbol>` holds the whole
    animation: `Arena.tsx` shows it through a frame-sized window and steps a translate
    across the strip with WAAPI. Radial spokes that widen and cool, frame to frame.

3.  **One hit splat**, 18 px: what a seed does when it lands on a knight. `Knight.tsx`
    flashes it on the hurt edge.

Everything is drawn straight into an 8-entry palette (index 0 transparent) and saved as
a paletted PNG, so the file is a few kilobytes and byte-identical run to run.

`--check` regenerates both outputs in memory and diffs them against disk, exiting 1 on
drift. The build asserts below are the test: a seed off its centre or a tail clipped by
its frame would be a bullet drawn beside its own hitbox, silently.
"""

from __future__ import annotations

import argparse
import io
import math
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_PNG = ROOT / "app" / "src" / "render" / "ordnance.png"
OUT_TS = ROOT / "app" / "src" / "render" / "ordnance.gen.ts"

# Index 0 is transparent. Seven paints: the seed's olive, then five embers from char to
# white heat. `#ffb020` (index 5) is the amber the old `<line>` bullet was drawn in, so the
# contrast argument `Shot.tsx` makes for its arrow colours still holds against the seed.
PALETTE = (
    (0x00, 0x00, 0x00),  # 0 transparent
    (0x3a, 0x3f, 0x12),  # 1 dark olive, the seed's core
    (0x6b, 0x2a, 0x10),  # 2 char, the cold end of the tail
    (0xb8, 0x3a, 0x14),  # 3 ember red
    (0xf0, 0x7a, 0x1c),  # 4 ember orange
    (0xff, 0xb0, 0x20),  # 5 amber
    (0xff, 0xe0, 0x7a),  # 6 hot yellow
    (0xff, 0xff, 0xf0),  # 7 white heat
)
OLIVE, CHAR, RED, ORANGE, AMBER, YELLOW, WHITE = range(1, 8)

SECTORS = 16

# The seed: 14 px across, a 1.5 px rim around a dark core.
SEED_R = 7.0
CORE_R = 5.5
# The tail, measured back from the seed's rim. Half-width at the rim, tapering to a point.
TAIL = 22.0
TAIL_HALF_W = 3.0
# The tail's four heats, as fractions of its length: amber at the seed, char at the end.
TAIL_BANDS = ((0.0, 0.25, AMBER), (0.25, 0.5, ORANGE), (0.5, 0.78, RED), (0.78, 1.01, CHAR))
# Loose sparks off the tail: (px behind the rim, px off the axis). The side alternates
# per sector so sixteen frames do not share one silhouette.
SPARKS = ((9.0, 3.5, AMBER), (14.0, 4.5, ORANGE), (19.0, 3.0, RED))

# Frame size: the seed centred, the tail's far end one pixel short of the edge whatever
# the angle. Even, so `-w/2` is a whole unit.
BULLET = int(2 * math.ceil(SEED_R + TAIL) + 2)

BURST = 32
BURST_FRAMES = 3
HIT = 18

# Atlas: bullets in two rows of eight, then the burst strip and the splat on a third row.
COLS = 8
ATLAS_W = COLS * BULLET
ATLAS_H = (SECTORS // COLS) * BULLET + BURST
BURST_Y = (SECTORS // COLS) * BULLET
HIT_X = BURST_FRAMES * BURST


def grid(size: int):
    """Pixel-centre coordinates relative to the frame's centre."""
    yy, xx = np.mgrid[0:size, 0:size]
    c = size / 2
    return xx + 0.5 - c, yy + 0.5 - c


def stamp(idx, cx: float, cy: float, r: float, colour: int) -> None:
    """A filled disc, in frame pixels."""
    yy, xx = np.mgrid[0 : idx.shape[0], 0 : idx.shape[1]]
    idx[(xx + 0.5 - cx) ** 2 + (yy + 0.5 - cy) ** 2 <= r * r] = colour


def ring(idx, r0: float, r1: float, colour: int) -> None:
    """The annulus `r0 < d <= r1` around the frame's centre."""
    px, py = grid(idx.shape[0])
    d = np.hypot(px, py)
    idx[(d > r0) & (d <= r1)] = colour


def spokes(idx, r0: float, r1: float, colour: int, phase: float, n: int = 8) -> None:
    """`n` one-pixel rays from `r0` to `r1`, the first at angle `phase`."""
    c = idx.shape[0] / 2
    for j in range(n):
        a = phase + j * 2 * math.pi / n
        for t in np.arange(r0, r1, 0.5):
            idx[int(c + math.sin(a) * t), int(c + math.cos(a) * t)] = colour


def bullet(k: int):
    """Sector `k`: velocity at `k * 22.5` degrees, clockwise from +x with y down --
    exactly `Math.atan2(dy, dx)` in the SVG the frame is drawn into."""
    a = k * 2 * math.pi / SECTORS
    ux, uy = math.cos(a), math.sin(a)
    px, py = grid(BULLET)
    c = BULLET / 2
    idx = np.zeros((BULLET, BULLET), np.uint8)

    # Position along the heading (+ ahead of the seed) and distance off its axis.
    along = px * ux + py * uy
    across = np.abs(px * uy - py * ux)

    # The tail, drawn first so the seed sits on top of its root.
    s = -along - SEED_R
    t = s / TAIL
    in_tail = (s >= 0) & (s <= TAIL) & (across <= TAIL_HALF_W * (1 - t) + 0.5)
    for lo, hi, colour in TAIL_BANDS:
        idx[in_tail & (t >= lo) & (t < hi)] = colour
    for j, (back, off, colour) in enumerate(SPARKS):
        side = 1 if (k + j) % 2 == 0 else -1
        x = c - ux * (SEED_R + back) - uy * side * off
        y = c - uy * (SEED_R + back) + ux * side * off
        idx[int(y), int(x)] = colour

    # The seed: lit rim on the leading half, ember on the trailing half, dark core.
    d = np.hypot(px, py)
    rim = (d <= SEED_R) & (d > CORE_R)
    idx[rim & (along >= 0)] = ORANGE
    idx[rim & (along < 0)] = RED
    idx[d <= CORE_R] = OLIVE
    # Two hot pixels just ahead of centre, either side of the heading.
    for side in (-1, 1):
        idx[int(c + uy * 2.5 + ux * side * 1.5), int(c + ux * 2.5 - uy * side * 1.5)] = WHITE
    return idx


def burst(f: int):
    """Frame `f` of the muzzle flash: a core that dims while its spokes reach out and cool."""
    idx = np.zeros((BURST, BURST), np.uint8)
    c = BURST / 2
    phase = f * math.pi / 12
    if f == 0:
        spokes(idx, 6.5, 9.5, AMBER, phase)
        ring(idx, 4.5, 6.5, YELLOW)
        stamp(idx, c, c, 4.5, WHITE)
    elif f == 1:
        spokes(idx, 8.0, 13.0, ORANGE, phase)
        spokes(idx, 13.0, 14.5, RED, phase)
        ring(idx, 5.0, 7.5, YELLOW)
        stamp(idx, c, c, 2.5, WHITE)
    else:
        spokes(idx, 11.5, 15.0, RED, phase)
        spokes(idx, 15.0, 15.9, CHAR, phase)
        ring(idx, 9.5, 10.5, CHAR)
        stamp(idx, c, c, 1.5, ORANGE)
    return idx


def hit():
    """The splat: an ember burst with the seed's olive shards flung around it."""
    idx = np.zeros((HIT, HIT), np.uint8)
    c = HIT / 2
    for j in range(5):
        a = math.radians(20 + j * 72)
        stamp(idx, c + math.cos(a) * 5.5, c + math.sin(a) * 5.5, 2.2, RED)
        b = a + math.radians(36)
        stamp(idx, c + math.cos(b) * 7.2, c + math.sin(b) * 7.2, 1.2, OLIVE)
    stamp(idx, c, c, 5.0, RED)
    stamp(idx, c, c, 3.5, ORANGE)
    stamp(idx, c, c, 1.8, YELLOW)
    idx[int(c) - 1, int(c) + 1] = WHITE
    idx[int(c) + 1, int(c) - 2] = WHITE
    return idx


def build():
    """-> (png bytes, typescript source)."""
    atlas = np.zeros((ATLAS_H, ATLAS_W), np.uint8)
    for k in range(SECTORS):
        frame = bullet(k)
        # The contract with `Arena.tsx`: the seed is centred, and nothing touches the
        # frame's edge -- a clipped tail is the first sign the frame size is stale.
        if frame[BULLET // 2, BULLET // 2] != OLIVE:
            raise SystemExit(f"gen_ordnance: sector {k} has no seed at its centre")
        if frame[0, :].any() or frame[-1, :].any() or frame[:, 0].any() or frame[:, -1].any():
            raise SystemExit(f"gen_ordnance: sector {k} is clipped by its {BULLET} px frame")
        x, y = (k % COLS) * BULLET, (k // COLS) * BULLET
        atlas[y : y + BULLET, x : x + BULLET] = frame
    frames = [burst(f) for f in range(BURST_FRAMES)]
    for f, frame in enumerate(frames):
        if f and np.array_equal(frame, frames[f - 1]):
            raise SystemExit(f"gen_ordnance: burst frames {f - 1} and {f} are identical")
        atlas[BURST_Y : BURST_Y + BURST, f * BURST : (f + 1) * BURST] = frame
    splat = hit()
    if not splat.any():
        raise SystemExit("gen_ordnance: the hit splat is empty")
    atlas[BURST_Y : BURST_Y + HIT, HIT_X : HIT_X + HIT] = splat
    if atlas.max() >= len(PALETTE):
        raise SystemExit("gen_ordnance: an index outside the palette")

    im = Image.frombytes("P", (ATLAS_W, ATLAS_H), atlas.tobytes())
    im.putpalette([v for rgb in PALETTE for v in rgb])
    buf = io.BytesIO()
    im.save(buf, "PNG", transparency=0, optimize=True)

    def sym(sid: str, x: int, y: int, w: int, h: int) -> str:
        return f"  `<symbol id=\"{sid}\" viewBox=\"{x} {y} {w} {h}\">${{IMG}}</symbol>`"

    syms = [sym(f"ord-b{k}", (k % COLS) * BULLET, (k // COLS) * BULLET, BULLET, BULLET) for k in range(SECTORS)]
    syms.append(sym("ord-burst", 0, BURST_Y, BURST_FRAMES * BURST, BURST))
    syms.append(sym("ord-hit", HIT_X, BURST_Y, HIT, HIT))
    src = f"""// @generated by `python3 tools/gen_ordnance.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close. The ids below are a
// contract with `Arena.tsx` (`<use href="#ord-b{{sector}}">`, `#ord-burst`) and
// `Knight.tsx` (`#ord-hit`): a dangling href renders nothing and throws nothing, so a
// drifted id is an invisible volley and no error anywhere. Edit the tool, then re-run it.
import ORDNANCE_ATLAS from './ordnance.png';

/**
 * One bullet frame: the thorn seed at the exact centre, its tail trailing away from the
 * velocity. Place the `<use>` at `(-w/2, -h/2)` and translate it to the bullet's position.
 */
export const ORD_BULLET = {{ w: {BULLET}, h: {BULLET} }} as const;

/**
 * The muzzle burst, `frames` frames of `w` x `h` side by side in ONE symbol. Show it
 * through a `w` x `h` window and step `translateX` by `-w` per frame.
 */
export const ORD_BURST = {{ w: {BURST}, h: {BURST}, frames: {BURST_FRAMES} }} as const;

/** The impact splat, centred on its frame. */
export const ORD_HIT = {{ w: {HIT}, h: {HIT} }} as const;

const IMG = `<image href="${{ORDNANCE_ATLAS}}" width="{ATLAS_W}" height="{ATLAS_H}"/>`;

/**
 * The `<defs>` markup: {SECTORS} velocity sectors (`ord-b0` at +x, clockwise with y down,
 * 22.5 degrees a step -- `Math.round(Math.atan2(dy, dx) / (Math.PI / 8)) & 15`), the burst
 * strip and the splat, each a `<symbol>` whose `viewBox` crops the one atlas. Mounted once
 * by whichever component owns the arena `<svg>`; React must never walk it again.
 */
export const ORDNANCE_DEFS =
{chr(10).join(s + ' +' for s in syms[:-1])}
{syms[-1]};
"""
    return buf.getvalue(), src


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the checked-in files are stale")
    args = ap.parse_args()

    png, src = build()
    if args.check:
        stale = [
            p.relative_to(ROOT)
            for p, want in ((OUT_PNG, png), (OUT_TS, src.encode()))
            if not p.exists() or p.read_bytes() != want
        ]
        if stale:
            raise SystemExit(f"gen_ordnance: stale: {', '.join(map(str, stale))} -- re-run tools/gen_ordnance.py")
        print(f"gen_ordnance: {OUT_PNG.relative_to(ROOT)} and {OUT_TS.relative_to(ROOT)} are current")
        return

    OUT_PNG.write_bytes(png)
    OUT_TS.write_text(src)
    print(
        f"gen_ordnance: {SECTORS} sectors x {BULLET}px + burst {BURST_FRAMES}x{BURST}px + hit {HIT}px "
        f"-> {ATLAS_W}x{ATLAS_H} atlas, {len(png)} bytes PNG, {len(src)} bytes TS"
    )


if __name__ == "__main__":
    main()
