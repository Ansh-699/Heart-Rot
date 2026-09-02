#!/usr/bin/env python3
"""Reproduces every number in `docs/art/legibility.md`.

    python3 docs/art/legibility.py                 # against the two reference PNGs
    python3 docs/art/legibility.py shot.png A      # against a real screenshot, scene A
    python3 docs/art/legibility.py shot.png B      # ... scene B

Method, identical to `docs/review/art.md` so its numbers reproduce exactly:
  * WCAG 2.x relative luminance, sRGB -> linear, 0.2126 / 0.7152 / 0.0722.
  * Contrast (Lhi + 0.05) / (Llo + 0.05).
  * A knight is AREA-WEIGHTED over the surviving pixels of its own `k{skin}-rest` group
    in `app/src/render/knights.gen.ts`, which is the shipped art, not a redraw of it.

No dependency beyond numpy + Pillow, both already installed for `tools/`.
"""
import colorsys
import math
import re
import sys

import numpy as np
from PIL import Image

ROOT = __file__.rsplit('/docs/', 1)[0]
REF_A = '/home/anshtyagi/Downloads/waiting_area_full_vertical.png'
REF_B = '/home/anshtyagi/Downloads/actual_boss_arena.png'
# Floor-only crops: stone the raiders stand on, walls / props / boss / dais excluded.
BOX_A = (150, 300, 980, 690)
BOX_B = (200, 300, 920, 520)

SKINS = ['Cobalt', 'Nocturne', 'Argent']
ACCENT = {'Cobalt': '#2f5585', 'Nocturne': '#b97055', 'Argent': '#b4b4c1'}
SHIPPED_KEY = {'Cobalt': '#95b4da', 'Nocturne': '#d5aa9a', 'Argent': '#b4b4c1'}
SELF_RING = '#eafff4'
KEYLINE = '#05060a'
CONTACT_SHADOW, CONTACT_ALPHA = '#0f0d12', 0.45
SPRITE_W, SPRITE_H = 33, 42


def hx(h):
    return np.array([int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)], float)


def tohex(t):
    return '#%02x%02x%02x' % tuple(int(round(max(0, min(255, v)))) for v in t)


def _lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def Y(rgb):
    l = _lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def K(a, b):
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


# --------------------------------------------------------------- the shipped art
_defs = re.search(
    r"export const KNIGHT_DEFS = '(.*)';",
    open(f'{ROOT}/app/src/render/knights.gen.ts').read(),
    re.S,
).group(1)
_SUB = re.compile(r'M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\d+z')


def _group(skin, pose='rest'):
    i = _defs.index(f'<g id="k{skin}-{pose}">')
    return _defs[i : _defs.index('</g>', i)]


def body_luminance(skin):
    """Area-weighted relative luminance of one `rest` pose, and its pixel count."""
    counts = {}
    for pm in re.finditer(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"', _group(skin)):
        n = sum(int(s.group(3)) * int(s.group(4)) for s in _SUB.finditer(pm.group(2)))
        counts[pm.group(1).lower()] = counts.get(pm.group(1).lower(), 0) + n
    total = sum(counts.values())
    return sum(Y(hx(h)) * n for h, n in counts.items()) / total, total


def silhouette(skin):
    m = np.zeros((SPRITE_H, SPRITE_W), bool)
    for pm in re.finditer(r'd="([^"]*)"', _group(skin)):
        for s in _SUB.finditer(pm.group(1)):
            x, y, w, h = map(int, s.groups())
            m[y : y + h, x : x + w] = True
    return m


def dilate(m, n):
    o = m.copy()
    for _ in range(n):
        p = np.pad(o, 1, constant_values=False)
        o = p[1:-1, 1:-1] | p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:]
    return o


# ------------------------------------------------------------------ the ground
def floor_percentiles(path, box):
    a = np.asarray(Image.open(path).convert('RGB'), float)
    c = a[box[1] : box[3], box[0] : box[2]].reshape(-1, 3)
    raw = np.percentile(Y(c), [5, 25, 50, 75, 95])
    shad = np.percentile(
        Y(c * (1 - CONTACT_ALPHA) + hx(CONTACT_SHADOW) * CONTACT_ALPHA), [5, 25, 50, 75, 95]
    )
    return raw, shad, c.mean(axis=0)


def lift_to(hexcol, target_y):
    """Raise HSL lightness until relative luminance reaches `target_y`. Hue and saturation held."""
    r, g, b = [v / 255 for v in hx(hexcol)]
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    lo, hi = l, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if Y(np.array([c * 255 for c in colorsys.hls_to_rgb(h, mid, s)])) < target_y:
            lo = mid
        else:
            hi = mid
    return tohex([c * 255 for c in colorsys.hls_to_rgb(h, hi, s)])


# ----------------------------------------------------- `.stage::after`, styles.css
def stage_overlay(yfrac, xfrac=0.5):
    """The alpha and colour `.stage::after` composites over the SVG at screen row `yfrac`."""
    stops = [
        (0.00, (159, 199, 232), 0.10),
        (0.26, (159, 199, 232), 0.00),
        (0.56, (13, 22, 34), 0.14),
        (0.88, (8, 13, 20), 0.42),
        (1.00, (8, 13, 20), 0.70),
    ]
    col, a_lin = np.array([8, 13, 20], float), 0.70
    for (y0, c0, a0), (y1, c1, a1) in zip(stops, stops[1:]):
        if y0 <= yfrac <= y1:
            t = 0 if y1 == y0 else (yfrac - y0) / (y1 - y0)
            col = np.array(c0, float) * (1 - t) + np.array(c1, float) * t
            a_lin = a0 * (1 - t) + a1 * t
            break
    r = math.hypot((xfrac - 0.5) / 1.15, (yfrac - 0.34) / 0.85)
    a_vig = 0.0 if r <= 0.52 else min(1.0, (r - 0.52) / 0.48) * 0.62
    return col, a_lin, a_vig


def under_stage(rgb, yfrac, xfrac=0.5):
    col, a_lin, a_vig = stage_overlay(yfrac, xfrac)
    out = np.asarray(rgb, float) * (1 - a_lin) + col * a_lin
    return out * (1 - a_vig) + np.array([8, 13, 20], float) * a_vig


# ------------------------------------------------------------------ usePixelFit
def pixel_fit(css_min, dpr):
    """`Arena.tsx::usePixelFit` — returns (svg CSS px, knight CSS px, crisp)."""
    raw = css_min * dpr / 1024
    scale = math.floor(raw) if raw >= 1 else raw
    svg = 1024 * scale / dpr
    return svg, SPRITE_H * svg / 1024, raw >= 1


def main():
    ref_a, ref_b, box_a, box_b = REF_A, REF_B, BOX_A, BOX_B
    if len(sys.argv) >= 3:  # measure a real screenshot instead
        im = Image.open(sys.argv[1])
        w, h = im.size
        box = (int(w * 0.15), int(h * 0.38), int(w * 0.87), int(h * 0.88))
        if sys.argv[2].upper() == 'A':
            ref_a, box_a = sys.argv[1], box
        else:
            ref_b, box_b = sys.argv[1], box

    print('== 1. shipped knight art, area-weighted relative luminance ==')
    body = {}
    for s, n in enumerate(SKINS):
        body[n], px = body_luminance(s)
        print(f'   {n:9s} {px:4d} px   Y={body[n]:.4f}')

    print('\n== 2. reference floors, luminance percentiles (p5 p25 p50 p75 p95) ==')
    fa, pa, ma = floor_percentiles(ref_a, box_a)
    fb, pb, mb = floor_percentiles(ref_b, box_b)
    print(f'   A waiting  mean sRGB ({ma[0]:.0f},{ma[1]:.0f},{ma[2]:.0f})  bare {fa.round(4)}')
    print(f'              + contact shadow {CONTACT_SHADOW} @{CONTACT_ALPHA}   {pa.round(4)}')
    print(f'   B arena    mean sRGB ({mb[0]:.0f},{mb[1]:.0f},{mb[2]:.0f})  bare {fb.round(4)}')
    print(f'              + contact shadow                       {pb.round(4)}')
    floors = list(fa) + list(fb)
    shadowed = list(pa) + list(pb)

    print('\n== 3. body vs floor — the metric that CANNOT be fixed without re-tracing ==')
    for n in SKINS:
        print(
            f'   {n:9s} A p50 {K(body[n], fa[2]):.2f}:1  B p50 {K(body[n], fb[2]):.2f}:1  '
            f'worst over both scenes {min(K(body[n], f) for f in floors):.2f}:1'
        )
    for lbl, f in (('A p50', fa[2]), ('B p50', fb[2]), ('B p95', fb[4])):
        need = 4.5 * (f + 0.05) - 0.05
        print(
            f'   4.5:1 vs {lbl} needs body Y={need:.4f} = '
            f'{need / body["Nocturne"]:.2f}x Nocturne, {need / body["Cobalt"]:.2f}x Cobalt'
        )

    print('\n== 4. the rim luminance the two scenes demand, and the lifted key lights ==')
    need = 4.5 * (max(floors) + 0.05) - 0.05
    print(f'   brightest floor sampled Y={max(floors):.4f}  ->  rim needs Y >= {need:.4f}')
    rim = {n: lift_to(a, need) for n, a in ACCENT.items()}
    for n in SKINS:
        y = Y(hx(rim[n]))
        print(
            f'   {n:9s} {SHIPPED_KEY[n]} (Y={Y(hx(SHIPPED_KEY[n])):.4f}, worst '
            f'{min(K(Y(hx(SHIPPED_KEY[n])), f) for f in floors):.2f}:1)'
            f'  ->  {rim[n]} (Y={y:.4f}, worst {min(K(y, f) for f in floors):.2f}:1,'
            f' on a shadowed floor {min(K(y, f) for f in shadowed):.2f}:1)'
        )
    print(f'   rim vs the sprite keyline Y=0.0076: {K(Y(hx(rim["Cobalt"])), 0.0076):.1f}:1')

    print('\n== 5. halo width: area, and the aggregate it buys (still not 4.5) ==')
    for s, n in enumerate(SKINS):
        m = silhouette(s)
        b = m.sum()
        for u in (1, 2):
            halo = (dilate(m, u) & ~m).sum()
            y = (b * body[n] + halo * Y(hx(rim[n]))) / (b + halo)
            print(
                f'   {n:9s} {u}-unit halo +{halo:3d}px ({halo / b:.0%})  aggregate Y={y:.4f}  '
                f'A p50 {K(y, fa[2]):.2f}:1  B p50 {K(y, fb[2]):.2f}:1'
            )

    print('\n== 6. the local-seat marker ==')
    for lbl, h in (('self ring/chevron', SELF_RING), ('marker keyline', KEYLINE)):
        y = Y(hx(h))
        print(
            f'   {lbl:18s} {h} Y={y:.4f}  vs floor worst {min(K(y, f) for f in floors):.2f}:1  '
            f'vs an ally rim {min(K(y, Y(hx(v))) for v in rim.values()):.2f}:1'
        )

    print('\n== 7. `.stage::after` — what the DOM overlay costs the rim, per screen row ==')
    for lbl, world_y, floor in (
        ('pit centre  y=496', 496, hx('#282b35')),
        ('gate        y=624', 624, hx('#282b35')),
        ('lobby spawn y=832', 832, hx('#302838')),
        ('bottom edge y=1000', 1000, hx('#302838')),
    ):
        yf = world_y / 1024
        _, a_lin, a_vig = stage_overlay(yf)
        f0 = Y(floor)
        f1 = Y(under_stage(floor, yf))
        before = min(K(Y(hx(v)), f0) for v in rim.values())
        after = min(K(Y(under_stage(hx(v), yf)), f1) for v in rim.values())
        print(
            f'   {lbl}  a_linear={a_lin:.3f} a_vignette={a_vig:.3f}   '
            f'rim vs floor {before:.2f}:1 -> {after:.2f}:1'
        )

    print('\n== 8. usePixelFit: how much of the stage the arena actually uses ==')
    print(f'   {"css":>5} {"dpr":>4} {"svg css":>8} {"knight":>7} {"stage used":>11} {"crisp":>6}')
    for css in (700, 800, 900, 1000, 1200, 1400):
        for dpr in (1, 1.5, 2, 3):
            svg, kn, crisp = pixel_fit(css, dpr)
            print(f'   {css:5d} {dpr:4} {svg:8.0f} {kn:7.1f} {svg / css:11.0%} {str(crisp):>6}')

    print('\n== 9. CVD: the three rims carry no information, and must not ==')
    M = np.array([[17.8824, 43.5161, 4.11935],
                  [3.45565, 27.1554, 3.86714],
                  [0.0299566, 0.184309, 1.46709]])
    Mi = np.linalg.inv(M)
    SIM = {
        'protan': np.array([[0, 2.02344, -2.52581], [0, 1, 0], [0, 0, 1]]),
        'deutan': np.array([[1, 0, 0], [0.494207, 0, 1.24827], [0, 0, 1]]),
        'tritan': np.array([[1, 0, 0], [0, 1, 0], [-0.395913, 0.801109, 0]]),
    }
    for kind, S in SIM.items():
        sim = {n: tohex(Mi @ (S @ (M @ hx(v)))) for n, v in rim.items()}
        ys = {n: Y(hx(v)) for n, v in sim.items()}
        pairs = [(a, b, K(ys[a], ys[b])) for i, a in enumerate(ys) for b in list(ys)[i + 1:]]
        a, b, k = min(pairs, key=lambda t: t[2])
        print(f'   {kind:7s} ' + ' '.join(f'{n[:3]}={sim[n]}' for n in sim)
              + f'   closest pair {a}/{b} = {k:.2f}:1')

    print('\n== 10. arrows: colour cannot separate them from boss ordnance ==')
    for name, h in (('bullet amber', '#ffb020'), ('arrow pale cyan', '#cfeeff'),
                    ('arrow ice', '#e6f7ff'), ('arrow mint', '#d6ffe8')):
        y = Y(hx(h))
        print(f'   {name:16s} {h} Y={y:.4f}  worst-vs-floor '
              f'{min(K(y, f) for f in floors):.2f}:1  vs bullet amber {K(y, Y(hx("#ffb020"))):.2f}:1')


if __name__ == '__main__':
    main()
