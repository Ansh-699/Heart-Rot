#!/usr/bin/env python3
"""Throwaway (task: verify:art-judge), part 2: the probes judge2.py got wrong or did not
have. Everything is read off pixels; nothing is a re-derivation of the source.
"""
import re

import numpy as np
from PIL import Image

ROOT = '/home/anshtyagi/Documents/pixel-artgame'
SHOT = f'{ROOT}/docs/art/shipped'
REF_A = '/home/anshtyagi/Downloads/waiting_area_full_vertical.png'
REF_B = '/home/anshtyagi/Downloads/actual_boss_arena.png'
S, E, F, OY = 1.57405, 154.09, -632.15, 47.8      # lobby CTM, stage-png origin
SB, EB, FB = 1.57405, 154.09, 47.84               # arena CTM
out = []
P = out.append


def lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def Y(rgb):
    l = lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def K(a, b):
    hi, lo = np.maximum(a, b), np.minimum(a, b)
    return (hi + 0.05) / (lo + 0.05)


img = lambda p: np.asarray(Image.open(p).convert('RGB'), float)
pxA = lambda x, y: (S * x + E, S * y + F - OY)
pxB = lambda x, y: (SB * x + EB, SB * y + FB - OY)

refA, refB = img(REF_A), img(REF_B)
yA, yB = Y(refA), Y(refB)
lobby = img(f'{SHOT}/plate-lobby-nohud-empty-stage.png')
lobbyNP = img(f'{SHOT}/plate-lobby-noprops-stage.png')
arena = img(f'{SHOT}/plate-arena-nohud-empty-stage.png')
arenaNB = img(f'{SHOT}/plate-arena-noboss-stage.png')
yL, yAr = Y(lobby), Y(arena)

# ---------------------------------------------------------- A. tile pitch, both floors
P('== A. TILE PITCH -- is the edge-density comparison fair? ==')


def pitch(y, box, axis):
    """Dominant spatial period of the coursing, by autocorrelation of the gradient."""
    x0, y0, x1, y1 = box
    sub = y[y0:y1, x0:x1]
    g = np.abs(np.diff(sub, axis=axis))
    prof = g.mean(axis=1 - axis)
    prof = prof - prof.mean()
    ac = np.correlate(prof, prof, 'full')[len(prof) - 1:]
    k = np.argmax(ac[6:60]) + 6
    return int(k), float(ac[k] / max(ac[0], 1e-12))


for lbl, y, box in (('ref A floor', yA, (300, 400, 900, 640)),
                    ('ship A floor', Y(lobbyNP), (700, 700, 1400, 880)),
                    ('ref B floor', yB, (200, 380, 900, 560))):
    kx, sx = pitch(y, box, 1)
    ky, sy = pitch(y, box, 0)
    P(f'   {lbl:13s} dominant period: {kx} px across, {ky} px down  '
      f'(autocorrelation peak {sx:.2f} / {sy:.2f} of lag-0)')
P('   -> the shipped lobby is 1.574 px/unit, so a 16-unit tile is 25.2 px; reference A\'s')
P('      floor tiles measure the period printed above. Scales are within a factor of ~1.')

# ------------------------------------------------- B. floor coursing: is there ANY grid?
P('\n== B. DOES THE FLOOR CARRY TILE COURSING? ==')
P('   method: mean |dL| along each axis over an interior floor patch, and the fraction of')
P('   pixels whose neighbour differs by more than 1/255 in sRGB terms (dL ~ 0.0008 at these')
P('   luminances). A stone floor with grout lines has periodic ridges; a wash has none.')
for lbl, y, box in (('ref A  floor', yA, (300, 400, 900, 640)),
                    ('ship A floor', Y(lobbyNP), (700, 700, 1400, 880)),
                    ('ref B  floor', yB, (200, 380, 900, 560)),
                    ('ship B floor', Y(arenaNB), (300, 750, 900, 950))):
    x0, y0, x1, y1 = box
    sub = y[y0:y1, x0:x1]
    gx = np.abs(np.diff(sub, axis=1))
    gy = np.abs(np.diff(sub, axis=0))
    P(f'   {lbl}: mean|dL| x {gx.mean():.5f} y {gy.mean():.5f}  '
      f'p99 {np.percentile(np.maximum(gx[:-1], gy[:, :-1]), 99):.5f}  '
      f'ridge px (|dL|>0.004) {np.maximum(gx[:-1], gy[:, :-1]).__gt__(0.004).mean():.1%}')

# ------------------------------------------ C. the floor markings: can you see them?
P('\n== C. FLOOR MARKINGS -- medallions, cracks, worn patches ==')
P('   WaitingRoom MARKINGS draws 5 medallions, 5 cracks, 6 worn patches at alpha 0.08-0.10.')
# the centre medallion: world centre of the lobby floor
CXW, CYW = 512, (688 + 1007) / 2
for lbl, dx, dy, r in (('centre medallion', 0, 0, 0.088 * 960 * 0.5),
                       ('corner medallion tl', -0.39 * 960, -0.27 * 320, 0.057 * 960 * 0.5)):
    cx, cy = pxA(CXW + dx, CYW + dy)
    rr = int(r * S)
    x0, y0 = int(cx - rr), int(cy - rr)
    x1, y1 = int(cx + rr), int(cy + rr)
    ring = Y(lobbyNP[y0:y1, x0:x1])
    far = Y(lobbyNP[y0 - 3 * rr:y0 - rr, x0:x1])
    P(f'   {lbl:20s} on-marking Y p95 {np.percentile(ring,95):.5f}  '
      f'floor beside it Y p95 {np.percentile(far,95):.5f}  '
      f'contrast {K(np.percentile(ring,95), np.percentile(far,50)):.3f}:1')
# reference A's medallion, same measurement (the one at ~x 175 y 358 of the png)
med = yA[335:385, 150:205]
around = yA[300:330, 150:205]
P(f'   {"ref A medallion":20s} on-marking Y p95 {np.percentile(med,95):.5f}  '
  f'floor beside it Y p95 {np.percentile(around,95):.5f}  '
  f'contrast {K(np.percentile(med,95), np.percentile(around,50)):.3f}:1')

# -------------------------------------------- D. the gate: mouth, threshold, crest
P('\n== D. THE GATE ==')
# the painted mouth width, row by row, measured as the run darker than the wall's p10
for wy in (600, 620, 640, 656, 672):
    ry = int(pxA(0, wy)[1])
    row = yL[ry]
    xc = int(pxA(512, 0)[0])
    wall = np.concatenate([row[xc - 520:xc - 330], row[xc + 330:xc + 520]])
    thr = np.percentile(wall, 10)
    dark = row < thr
    i = xc
    while i > 0 and dark[i]:
        i -= 1
    j = xc
    while j < len(row) - 1 and dark[j]:
        j += 1
    P(f'   world y {wy}: wall p10 Y {thr:.5f}; run darker than that through the centre '
      f'= {(j-i)/S:.0f} world units  (walkable slot 128, spec cap 144)')
# the threshold rectangle (the G block, world y 656..687): is it a lit floor or a patch?
tx0, ty0 = pxA(448, 656)
tx1, ty1 = pxA(576, 688)
thr_box = yL[int(ty0):int(ty1), int(tx0):int(tx1)]
side = yL[int(ty0):int(ty1), int(tx0) - 90:int(tx0) - 20]
P(f'   threshold block (G rows) Y median {np.median(thr_box):.5f}; wall beside it '
  f'{np.median(side):.5f}; ratio {np.median(thr_box)/max(np.median(side),1e-9):.2f}x')
# the crest: brightest object in the lobby?
P('\n   the value hierarchy of the gate head -- who is the brightest thing in the room?')
crest = yL[int(pxA(0, 470)[1]):int(pxA(0, 520)[1]), int(pxA(455, 0)[0]):int(pxA(570, 0)[0])]
sign = yL[int(pxA(0, 528)[1]):int(pxA(0, 556)[1]), int(pxA(430, 0)[0]):int(pxA(595, 0)[0])]
P(f'   skull crest   Y p95 {np.percentile(crest,95):.4f}  median {np.median(crest):.4f}')
P(f'   BOSS FIGHT    Y p95 {np.percentile(sign,95):.4f}  median {np.median(sign):.4f}')
P(f'   whole lobby   Y p99 {np.percentile(yL,99):.4f}  p99.9 {np.percentile(yL,99.9):.4f}')
P(f'   crest is {np.percentile(crest,95)/max(np.percentile(sign,95),1e-9):.2f}x the sign at p95')
# reference A: crest vs sign
rcrest = yA[60:115, 525:600]
rsign = yA[120:150, 490:640]
P(f'   ref A crest   Y p95 {np.percentile(rcrest,95):.4f}; ref A sign Y p95 '
  f'{np.percentile(rsign,95):.4f}; crest/sign {np.percentile(rcrest,95)/np.percentile(rsign,95):.2f}x')

# --------------------------------------------- E. reference B: creature vs its floor
P('\n== E. HOW MUCH FLOOR DOES THE CREATURE COVER? ==')
# reference B floor ellipse: the ring is centred ~(560,400) with rx 470 ry 200 in the png.
h, w = yB.shape
yy, xx = np.mgrid[0:h, 0:w]
ell = ((xx - 560) / 470.0) ** 2 + ((yy - 400) / 200.0) ** 2 <= 1
# the creature in ref B: the connected warm/mid-value mass in the upper middle. Segment by
# "departs from a smooth radial model of the floor", the same test boss-arena.md used.
r2 = np.sqrt(((xx - 560) / 470.0) ** 2 + ((yy - 400) / 200.0) ** 2)
bins = np.clip((r2 * 20).astype(int), 0, 19)
model = np.zeros_like(yB)
for b in range(20):
    m = ell & (bins == b)
    if m.any():
        model[m] = np.median(yB[m])
dev = np.abs(yB - model) > 0.02
P(f'   ref B: pixels inside the floor ellipse departing >0.02 L from a radial model: '
  f'{(dev & ell).sum() / ell.sum():.1%}')
# shipped: the boss's own mask over the walkable pit was 19.78% (judge2). Its bbox:
d = np.abs(arena - arenaNB).sum(axis=2) > 24
ys_, xs_ = np.nonzero(d)
P(f'   shipped B: boss changed-pixel bbox x {xs_.min()}..{xs_.max()} '
  f'({xs_.max()-xs_.min()} px = {(xs_.max()-xs_.min())/S:.0f} world units wide), '
  f'y {ys_.min()}..{ys_.max()} ({ys_.max()-ys_.min()} px)')
P(f'   shipped B: that bbox is {(xs_.max()-xs_.min())/arena.shape[1]:.1%} of frame width and '
  f'{(ys_.max()-ys_.min())/arena.shape[0]:.1%} of frame height')
# ref B creature bbox, from the deviation mask's largest component (crude: the union above
# the centre line inside the ellipse)
cm = dev & ell & (yy < 400)
ys2, xs2 = np.nonzero(cm)
P(f'   ref B creature-ish mask bbox x {xs2.min()}..{xs2.max()} '
  f'({(xs2.max()-xs2.min())/refB.shape[1]:.1%} of frame width), y {ys2.min()}..{ys2.max()} '
  f'({(ys2.max()-ys2.min())/refB.shape[0]:.1%} of frame height)')

# ---------------------------------------------------- F. torch pools, done properly
P('\n== F. TORCH LIGHT ON THE FLOOR ==')
P('   ref A: floor strip just inside the left wall, at a torch\'s height vs between torches.')
at_torch = yA[250:300, 118:190]
between = yA[400:450, 118:190]
P(f'   ref A: at torch Y median {np.median(at_torch):.5f}; between torches '
  f'{np.median(between):.5f}; ratio {np.median(at_torch)/np.median(between):.2f}x')
# shipped: same geometry -- the floor strip inside the left wall, at every row
lx = int(pxA(32, 0)[0])
strip = yL[:, lx + 5: lx + 75]
rows = np.arange(strip.shape[0])
inroom = (rows > int(pxA(0, 700)[1])) & (rows < int(pxA(0, 1000)[1]))
prof = np.median(strip[inroom], axis=1)
P(f'   ship A: left-wall floor strip, row-median Y min {prof.min():.5f} max {prof.max():.5f} '
  f'ratio {prof.max()/max(prof.min(),1e-9):.2f}x')
P(f'   ref A : the same strip, row-median Y min {np.median(yA[300:660, 118:190], axis=1).min():.5f} '
  f'max {np.median(yA[300:660, 118:190], axis=1).max():.5f} '
  f'ratio {np.median(yA[300:660,118:190],axis=1).max()/np.median(yA[300:660,118:190],axis=1).min():.2f}x')

# ------------------------------------------------ G. wall surface detail
P('\n== G. WALL SURFACE: per-block variation ==')
for lbl, y, box in (('ref A  left wall', yA, (55, 300, 105, 640)),
                    ('ship A left wall', yL, (int(pxA(0, 0)[0]) + 2, int(pxA(0, 720)[1]),
                                              int(pxA(32, 0)[0]) - 2, int(pxA(0, 990)[1]))),
                    ('ref A  top wall', yA, (200, 165, 430, 235)),
                    ('ship A top wall', yL, (int(pxA(120, 0)[0]), int(pxA(0, 570)[1]),
                                             int(pxA(400, 0)[0]), int(pxA(0, 660)[1])))):
    x0, y0, x1, y1 = box
    sub = y[y0:y1, x0:x1]
    P(f'   {lbl:17s} Y median {np.median(sub):.4f}  sd {sub.std():.4f}  '
      f'p95-p5 {np.percentile(sub,95)-np.percentile(sub,5):.4f}  '
      f'sd/median {sub.std()/max(np.median(sub),1e-9):.2f}')

print('\n'.join(out))
open(f'{SHOT}/judge3.txt', 'w').write('\n'.join(out) + '\n')
