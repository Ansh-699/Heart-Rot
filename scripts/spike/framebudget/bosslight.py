#!/usr/bin/env python3
"""THROWAWAY. Reproduces every table in docs/art/boss-light.md.

Inputs are screenshots of the SHIPPED renderer taken by the .mjs drivers beside this file
(lightshot.mjs -> light/, lightfix.mjs -> fix/, lightfix2.mjs -> fix2/) plus the art
reference at ~/Downloads/actual_boss_arena.png. No product file is read for colour: every
number below comes out of a real Chrome raster, so the grade is measured as the browser
actually applies it rather than as a colour-matrix model predicts it.

  python3 bosslight.py            # all tables
"""
import os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.expanduser('~/Downloads/actual_boss_arena.png')
KS = (1.5, 2.0, 2.5, 3.0, 4.0)


def ld(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.float64)


def relL(x):
    """WCAG relative luminance. Input 0..255."""
    c = np.asarray(x, float) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]


def cr(a, b):
    la, lb = float(relL(a)), float(relL(b))
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


def dilate(m, k):
    o = m.copy()
    for _ in range(k):
        o = o | np.roll(o, 1, 0) | np.roll(o, -1, 0) | np.roll(o, 1, 1) | np.roll(o, -1, 1)
    return o


def ladder(L, bg):
    """Fraction of the creature's own pixels reaching each contrast step vs its background."""
    return [float((L >= k * (bg + 0.05) - 0.05).mean()) for k in KS]


# --- the shipped boss: silhouette from ungraded-minus-empty, so the drop-shadow rim is
#     NOT in the mask and can be measured separately -------------------------------------
nb = ld(os.path.join(HERE, 'light/noboss.png'))
ug = ld(os.path.join(HERE, 'light/ungraded.png'))
MASK = (np.abs(ug - nb).max(axis=2) > 6)
H, W = MASK.shape
RING = dilate(MASK, 28) & ~dilate(MASK, 12)      # 12..28 px of cavern around the creature
BG = float(relL(nb[RING]).mean())

# --- the reference ---------------------------------------------------------------------
ref = ld(REF)
rbox = np.zeros(ref.shape[:2], bool)
rbox[60:345, 410:700] = True                      # the creature, hand-bounded
RMASK = rbox & (relL(ref) > 0.028)                # its wall sits below 0.028
RBG = float(relL(ref[120:300, 330:400].reshape(-1, 3)).mean())


def row(name, L, bg):
    p = np.percentile(L * 255, [50, 75, 90, 95, 99])
    print('%-16s %s   %s' % (name, ' '.join('%5.3f' % v for v in ladder(L, bg)),
                             ' '.join('%5.1f' % v for v in p)))


def table_ladder(dirs):
    print('%-16s %-29s  %s' % ('build', 'frac of body >=1.5/2/2.5/3/4 : 1',
                               'body L255 p50/p75/p90/p95/p99'))
    row('REFERENCE', relL(ref[RMASK]), RBG)
    for d in dirs:
        p = os.path.join(HERE, d)
        for f in sorted(os.listdir(p)):
            if f.endswith('.png') and f[:-4] not in ('noboss',):
                row(d + '/' + f[:-4], relL(ld(os.path.join(p, f))[MASK]), BG)


def table_rim(img, base, tag):
    """The drop-shadow rim: how many px of it survive uncovered, and what it is worth."""
    r = (np.abs(img - base).max(axis=2) > 1) & ~MASK
    ys, xs = np.nonzero(r)
    th = []
    for y, x in zip(ys[::5], xs[::5]):
        d = 0
        while d < 10 and y + d + 1 < H and x + d + 1 < W and not MASK[y + d + 1, x + d + 1] and r[y + d, x + d]:
            d += 1
        th.append(d)
    inside = img[np.clip(ys + 4, 0, H - 1), np.clip(xs + 4, 0, W - 1)]
    print('%-24s px %6d  exposed band %.2f px (median %.0f)  L255 %5.1f  vs bg %.2f:1  vs body %.2f:1'
          % (tag, r.sum(), np.mean(th), np.median(th), relL(img[r]).mean() * 255,
             cr(img[r].mean(axis=0), nb[r].mean(axis=0)), cr(img[r].mean(axis=0), inside.mean(axis=0))))


def table_orb(names):
    """Radial profile through the chest orb. Reference radii are scaled by 1.875 = the ratio
    of creature widths (576 px shipped / 289 px reference at their own render sizes)."""
    Y, X = np.mgrid[0:H, 0:W]
    d = np.hypot(X - 587.5, Y - 345.5)            # BOSS_SPAWN + CORE, in arena units
    La = relL(ref)
    Ya, Xa = np.mgrid[0:ref.shape[0], 0:ref.shape[1]]
    da = np.hypot(Xa - 541.9, Ya - 255.3)         # centroid of the reference's cyan blob
    imgs = {n: relL(ld(os.path.join(HERE, p))) for n, p in names}
    print(' r (units) ' + ' '.join('%6s' % n for n, _ in names) + '  |    ref')
    for r0 in range(0, 140, 10):
        s = (d >= r0) & (d < r0 + 10)
        sa = (da >= r0 / 1.875) & (da < (r0 + 10) / 1.875)
        print('  %3d-%3d  ' % (r0, r0 + 10)
              + ' '.join('%6.1f' % (imgs[n][s].mean() * 255) for n, _ in names)
              + '  | %6.1f' % (La[sa].mean() * 255))


def table_flatness():
    """Why no tone curve can manufacture the reference's lit tail: the art is flat-shaded."""
    Lu = np.round(relL(ug[MASK]) * 255).astype(int)
    h = np.bincount(Lu, minlength=256)
    top = np.argsort(h)[::-1][:8]
    print('ungraded boss, 8 most common L255 values:',
          [(int(v), round(float(h[v] / h.sum()), 3)) for v in sorted(top)])
    print('share of the creature on just those 8 values: %.3f' % (h[top].sum() / h.sum()))


if __name__ == '__main__':
    print('local cavern behind the boss: relL %.5f (L255 %.1f)' % (BG, BG * 255))
    print('reference wall behind the creature: relL %.5f (L255 %.1f)\n' % (RBG, RBG * 255))
    table_ladder(['light', 'fix', 'fix2'])
    print()
    table_flatness()
    print()
    table_rim(ld(HERE + '/light/shipped.png'), ld(HERE + '/light/gradeonly.png'), 'shipped rim 2u a.25')
    table_rim(ld(HERE + '/fix2/g3.png'), ld(HERE + '/fix2/g3norim.png'), 'proposed rim 3u a.30')
    print()
    table_orb([('shipped', 'light/shipped.png'), ('g3', 'fix2/g3.png')])
