#!/usr/bin/env python3
"""Draw the hellfire atlas -- pixel-art flame frames and the rune ring -- and the `<symbol>`
table that crops it.

    python3 tools/gen_fire.py [--check]

Procedural, Pillow + numpy, no source art, the same pipeline as `gen_ordnance.py`: this tool
is the only thing allowed to write `app/src/render/fire.png` and `fire.gen.ts`. The fire is
drawn in the room's own idiom -- a chunky pixel flame with a dark outline and four colour
bands, jagged 1-px tongues, embers and spark crosses above it -- because a painted or vector
fire dropped into a pixel-art scene reads as pasted on, which is what every previous cut did.

WHAT IT DRAWS:

1.  **A flame pillar loop**, `PILLAR_FRAMES` frames of `PW` x `PH` side by side in one
    strip. Each frame is four nested silhouettes (red, orange, yellow, cream), every one a
    rounded envelope with its own tongues that rise and gutter across the loop, quantised to
    the pixel and outlined. Embers and crosses drift up above the tip. Frame-to-frame the
    tongues MOVE -- that is the animation; `Arena.tsx` steps the strip with `steps()`.
2.  **A rune ring**, `RING_FRAMES` frames of `RW` x `RH`: the slam's circle on the stone,
    an ellipse band with eight rune marks, pulsing between the frames.

Everything is drawn straight into an 8-entry palette (index 0 transparent) and saved as a
paletted PNG, byte-identical run to run. `--check` diffs the outputs against disk.
"""
from __future__ import annotations

import argparse
import io
import math
import pathlib

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_PNG = ROOT / "app" / "src" / "render" / "fire.png"
OUT_TS = ROOT / "app" / "src" / "render" / "fire.gen.ts"

PALETTE = (
    (0x00, 0x00, 0x00),  # 0 transparent
    (0x2a, 0x08, 0x06),  # 1 outline, near-black red
    (0x8c, 0x1a, 0x10),  # 2 dark red, the rim inside the outline
    (0xd8, 0x30, 0x1a),  # 3 red
    (0xff, 0x7a, 0x1a),  # 4 orange
    (0xff, 0xc8, 0x30),  # 5 yellow
    (0xff, 0xf4, 0xc8),  # 6 cream, the core
    (0xff, 0x4a, 0x1c),  # 7 ember
)
T, OUTLINE, DARK, RED, ORANGE, YELLOW, CREAM, EMBER = range(8)

PW, PH, PILLAR_FRAMES = 56, 96, 8
RW, RH, RING_FRAMES = 128, 56, 2
RING_RX, RING_RY = 60, 24

ATLAS_W = max(PW * PILLAR_FRAMES, RW * RING_FRAMES)
ATLAS_H = PH + RH


def h(*xs: float) -> float:
    """A stable pseudo-random in [0, 1) off a few numbers."""
    v = math.sin(xs[0] * 127.1 + (xs[1] if len(xs) > 1 else 0) * 311.7 + (xs[2] if len(xs) > 2 else 0) * 74.7) * 43758.5453
    return v - math.floor(v)


TONGUES = [
    # (base x, base half-width, full height, phase): five tongues, the tallest off-centre,
    # every one rising and falling on its own phase so the loop never shows the same shape.
    (-15, 5.5, 44, 0.05),
    (-7, 5.0, 60, 0.42),
    (1, 6.5, 80, 0.0),
    (9, 5.0, 56, 0.66),
    (16, 5.0, 40, 0.28),
]


def tongue_mask(cx: float, hw: float, height: float, f: int, seed: int, sway: float) -> np.ndarray:
    """One tongue: narrowing to a point, leaning with the loop, jagged by the pixel."""
    m = np.zeros((PH, PW), bool)
    base_y = PH - 3
    phase = f / PILLAR_FRAMES
    hgt = max(3, int(round(height)))
    for r in range(hgt):
        t = r / hgt
        half = hw * (1 - t) ** 0.62 + 0.4
        # The lean: the tip drifts, the base stays. Jitter is per row and per frame, so
        # every edge is stepped and every frame is a different flame.
        lean = sway * math.sin(t * 2.6 + phase * 2 * math.pi + seed) * t
        jit = (h(r, f, seed) - 0.5) * 2.2
        xc = cx + lean + jit
        x0 = int(round(xc - half))
        x1 = int(round(xc + half))
        y = base_y - r
        if y < 1:
            break
        x0 = max(1, x0)
        x1 = min(PW - 2, x1)
        if x1 >= x0:
            m[y, x0 : x1 + 1] = True
    return m


def pillar(f: int) -> np.ndarray:
    frame = np.zeros((PH, PW), np.uint8)
    phase = f / PILLAR_FRAMES
    cx0 = PW / 2
    base_y = PH - 3
    red = np.zeros((PH, PW), bool)
    orange = np.zeros((PH, PW), bool)
    yellow = np.zeros((PH, PW), bool)
    cream = np.zeros((PH, PW), bool)
    tips = []
    for i, (bx, hw, H, ph) in enumerate(TONGUES):
        # Height breathes over the loop; the tallest also throws its tip off as an ember.
        cyc = (phase + ph) % 1.0
        hgt = H * (0.7 + 0.3 * math.sin(cyc * 2 * math.pi))
        cx = cx0 + bx + (h(i, f) - 0.5) * 2
        sway = 3.5 + i % 2
        red |= tongue_mask(cx, hw, hgt, f, i, sway)
        orange |= tongue_mask(cx, hw * 0.78, hgt * 0.8, f, i + 10, sway)
        yellow |= tongue_mask(cx, hw * 0.55, hgt * 0.58, f, i + 20, sway)
        cream |= tongue_mask(cx, hw * 0.32, hgt * 0.34, f, i + 30, sway)
        tips.append((cx, hgt, cyc))
    # The pool at the foot binds the tongues into one fire.
    red |= tongue_mask(cx0, 24, 16, f, 40, 0.5)
    orange |= tongue_mask(cx0, 19, 11, f, 41, 0.5)
    yellow |= tongue_mask(cx0, 13, 7, f, 42, 0.5)
    cream |= tongue_mask(cx0, 7, 4, f, 43, 0.5)
    frame[red] = RED
    frame[orange] = ORANGE
    frame[yellow] = YELLOW
    frame[cream] = CREAM
    # The rim: red pixels touching transparency turn dark red, then a 1-px outline outside.
    isred = frame == RED
    inner = isred.copy()
    filled = frame != T
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        inner &= np.roll(filled, (dy, dx), (0, 1))
    frame[isred & ~inner] = DARK
    filled = frame != T
    edge = np.zeros_like(filled)
    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        edge |= np.roll(filled, (dy, dx), (0, 1))
    # No outline under the foot: the fire stands ON the ring, and a dark bar there read as
    # a plinth.
    edge[base_y + 1 :, :] = False
    frame[edge & ~filled] = OUTLINE
    # Embers: a tongue past the top of its rise throws its tip off, and it climbs away.
    for i, (cx, hgt, cyc) in enumerate(tips):
        if cyc < 0.25 or cyc > 0.75:
            continue
        lift = (cyc - 0.25) / 0.5
        ex = int(round(cx + (h(i, 7) - 0.5) * 6 + math.sin(lift * 3) * 3))
        ey = int(round(base_y - hgt - 4 - lift * 22))
        if 2 <= ex < PW - 2 and 2 <= ey < PH - 2 and frame[ey, ex] == T:
            size = 2 if lift < 0.5 else 1
            frame[ey : ey + size, ex : ex + size] = EMBER if lift < 0.6 else RED
    for k in range(4):
        t = (phase + h(k, 9)) % 1.0
        ex = int(round(cx0 + (h(k, 11) - 0.5) * 40))
        ey = int(round(base_y - 70 - t * 20))
        if 2 <= ex < PW - 2 and 2 <= ey < PH - 2 and frame[ey, ex] == T and t < 0.7:
            frame[ey, ex] = ORANGE
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                if frame[ey + dy, ex + dx] == T:
                    frame[ey + dy, ex + dx] = RED
    return frame


def ring(f: int) -> np.ndarray:
    frame = np.zeros((RH, RW), np.uint8)
    cx, cy = RW / 2, RH / 2
    yy, xx = np.mgrid[0:RH, 0:RW]
    d = np.sqrt(((xx + 0.5 - cx) / RING_RX) ** 2 + ((yy + 0.5 - cy) / RING_RY) ** 2)
    band = (d >= 0.93) & (d <= 1.03)
    frame[band] = ORANGE if f == 0 else YELLOW
    frame[(d >= 1.03) & (d <= 1.075)] = DARK
    frame[(d >= 0.88) & (d < 0.93)] = RED if f == 0 else ORANGE
    for k in range(8):
        a = k * math.pi / 4 + math.pi / 8
        rx, ry = cx + math.cos(a) * RING_RX * 0.98, cy + math.sin(a) * RING_RY * 0.98
        x0, y0 = int(rx), int(ry)
        frame[y0 - 1 : y0 + 1, x0 - 1 : x0 + 1] = CREAM if (k + f) % 2 == 0 else YELLOW
    return frame


def build():
    atlas = np.zeros((ATLAS_H, ATLAS_W), np.uint8)
    frames = [pillar(f) for f in range(PILLAR_FRAMES)]
    for f, fr in enumerate(frames):
        if f and np.array_equal(fr, frames[f - 1]):
            raise SystemExit(f"gen_fire: pillar frames {f - 1} and {f} are identical")
        if fr[0, :].any() or fr[:, 0].any() or fr[:, -1].any():
            raise SystemExit(f"gen_fire: pillar frame {f} is clipped by its {PW}x{PH} frame")
        atlas[0:PH, f * PW : (f + 1) * PW] = fr
    for f in range(RING_FRAMES):
        atlas[PH : PH + RH, f * RW : (f + 1) * RW] = ring(f)
    if atlas.max() >= len(PALETTE):
        raise SystemExit("gen_fire: an index outside the palette")
    im = Image.frombytes("P", (ATLAS_W, ATLAS_H), atlas.tobytes())
    im.putpalette([v for rgb in PALETTE for v in rgb])
    buf = io.BytesIO()
    im.save(buf, "PNG", transparency=0, optimize=True)
    src = f"""// @generated by `python3 tools/gen_fire.py` -- DO NOT EDIT.
//
// The ids below are a contract with `Arena.tsx` (`#fire-pillar`, `#fire-ring`): a dangling
// href renders nothing and throws nothing. Edit the tool, then re-run it.
import FIRE_ATLAS from './fire.png';

/** The flame loop: `frames` frames of `w` x `h` side by side in ONE symbol. Show it through
 *  a `w` x `h` window and step `translateX` by `-w` per frame; the base is 3 px above the
 *  frame's bottom edge. */
export const FIRE_PILLAR = {{ w: {PW}, h: {PH}, frames: {PILLAR_FRAMES} }} as const;

/** The rune ring on the stone, `frames` frames pulsing; centred on its frame, rx {RING_RX} ry {RING_RY}. */
export const FIRE_RING = {{ w: {RW}, h: {RH}, frames: {RING_FRAMES} }} as const;

const IMG = `<image href="${{FIRE_ATLAS}}" width="{ATLAS_W}" height="{ATLAS_H}"/>`;

/** The `<defs>` markup, mounted once by whichever component owns the arena `<svg>`. */
export const FIRE_DEFS =
  `<symbol id="fire-pillar" viewBox="0 0 {PW * PILLAR_FRAMES} {PH}">${{IMG}}</symbol>` +
  `<symbol id="fire-ring" viewBox="0 {PH} {RW * RING_FRAMES} {RH}">${{IMG}}</symbol>`;
"""
    return buf.getvalue(), src


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the checked-in files are stale")
    args = ap.parse_args()
    png, src = build()
    if args.check:
        stale = [p.relative_to(ROOT) for p, want in ((OUT_PNG, png), (OUT_TS, src.encode())) if not p.exists() or p.read_bytes() != want]
        if stale:
            raise SystemExit(f"gen_fire: stale: {', '.join(map(str, stale))} -- re-run tools/gen_fire.py")
        print(f"gen_fire: {OUT_PNG.relative_to(ROOT)} and {OUT_TS.relative_to(ROOT)} are current")
        return
    OUT_PNG.write_bytes(png)
    OUT_TS.write_text(src)
    print(f"gen_fire: wrote {OUT_PNG.relative_to(ROOT)} ({len(png)} B) and {OUT_TS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
