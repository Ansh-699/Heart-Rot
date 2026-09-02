#!/usr/bin/env python3
"""Throwaway (task: art-judge). Reads the frames judge.mjs shot and reports contrast
AT THE REAL STANDS, rim thickness in css px, and floor obscured by the boss.

WCAG method, same as docs/art/legibility.py: sRGB -> linear, Y = .2126R+.7152G+.0722B,
K = (hi+.05)/(lo+.05).
"""
import json
import numpy as np
from PIL import Image

OUT = '/home/anshtyagi/Documents/pixel-artgame/docs/art/shipped/judge'
SKINS = ['Cobalt', 'Nocturne', 'Argent']
SPRITE_W, SPRITE_H = 33, 42


def lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def Y(rgb):
    l = lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def K(a, b):
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


img = lambda n: np.asarray(Image.open(f'{OUT}/{n}.png').convert('RGB'), float)
META = {m['name']: m for m in json.load(open(f'{OUT}/meta.json'))}

out = []
P = out.append


def px(m, x, y):
    c = m['geom']['ctm']
    return c['a'] * x + c['e'], c['a'] * y + c['f']


def seat_stats(name, plate):
    """Body mask = |frame - plate| inside each seat's sprite box; floor = the plate there."""
    m = META[name]
    f, p = img(name), img(plate)
    s = m['geom']['ctm']['a']
    d = np.abs(f - p).max(axis=2)
    rows = []
    for i, (wx, wy, skin, _) in enumerate(m['at']):
        if i == 0:
            continue  # parked local seat, wears the chevron
        cx, cy = px(m, wx, wy)
        # the sprite is drawn centred on the seat point; take a generous box and let the
        # diff mask pick out the body.
        x0, x1 = int(cx - SPRITE_W * s / 2) - 4, int(cx + SPRITE_W * s / 2) + 5
        y0, y1 = int(cy - SPRITE_H * s / 2) - 4, int(cy + SPRITE_H * s / 2) + 5
        if x0 < 0 or y0 < 0 or x1 > f.shape[1] or y1 > f.shape[0]:
            continue
        bf, bp = f[y0:y1, x0:x1], p[y0:y1, x0:x1]
        mask = d[y0:y1, x0:x1] > 12
        if mask.sum() < 120:
            continue
        body = float(np.median(Y(bf)[mask]))
        # floor = the plate under the box, excluding nothing: this is what the eye compares to
        floor = float(np.median(Y(bp)))
        # boundary ring: the mask's outer 2-px shell in the FRAME (the rim, if there is one)
        rows.append((body, floor, K(body, floor)))
    return rows


def report(sets):
    for setname, label in sets:
        P(f'\n-- {label} --')
        for skin in range(3):
            for cls, suffix in (('knight', ''), ('archer', '-arch')):
                nm = f'{setname}-s{skin}{suffix}'
                if nm not in META:
                    continue
                rows = seat_stats(nm, f'{setname}-plate')
                if not rows:
                    P(f'   {SKINS[skin]:9s} {cls:6s}  NO SEATS RESOLVED')
                    continue
                ks = sorted(r[2] for r in rows)
                bodies = [r[0] for r in rows]
                floors = [r[1] for r in rows]
                P(f'   {SKINS[skin]:9s} {cls:6s} n={len(rows):2d}  body Y {np.median(bodies):.4f}'
                  f'  floor Y {np.median(floors):.4f}  contrast median {np.median(ks):.2f}:1'
                  f'  worst {ks[0]:.2f}:1  best {ks[-1]:.2f}:1')


P('== contrast at the stands the chain actually produces (1920x1080) ==')
P('   body = median Y of the changed pixels in the seat box; floor = median Y of the same')
P('   box on the empty plate. n is the number of seats that resolved.')
report([('spawn', 'room A: the lobby spawn row, map.ts LOBBY_SPAWN_Y 832, x 208..664, 19 seats'),
        ('walk', 'room A: the aisle walk from the spawn row onto the gate block, 12 seats'),
        ('pools', 'room A: standing in the CENTRE of each of the ten torch pools, 10 seats'),
        ('pit', 'room B: the arena pit, y 440..596 across x 140..860, 19 seats')])

# ------------------------------------------------------------------ rim thickness
P('\n== rim light: measured off an 8x-zoomed knight, not asserted ==')
m = META['rim-s0']
s = m['geom']['ctm']['a']
f, p = img('rim-s0'), img('rim-plate')
d = np.abs(f - p).max(axis=2)
mask = d > 10
ys, xs = np.nonzero(mask)
if xs.size == 0:
    P('   SKIPPED: the 8x-zoom seat is off the page under the new camera; not re-measured.')
    print('\n'.join(out))
    open(f'{OUT}/../judge-report.txt', 'w').write('\n'.join(out) + '\n')
    raise SystemExit(0)
P(f'   1 world unit = {s:.3f} css px at this zoom (8x of the shipped 1.574)')
P(f'   changed-pixel bbox {xs.max()-xs.min()+1} x {ys.max()-ys.min()+1} px'
  f'  = {(xs.max()-xs.min()+1)/s:.1f} x {(ys.max()-ys.min()+1)/s:.1f} world units'
  f'  (sprite is {SPRITE_W}x{SPRITE_H})')
# The rim is the brightest ring just inside the mask boundary. Walk the mask's widest row
# and count how many px at each end are rim-coloured (much brighter than the floor).
mid = int(np.median(ys))
row = mask[mid]
xi = np.nonzero(row)[0]
lumrow = Y(f[mid])
floor = float(np.median(Y(p[mid][xi.min():xi.max()])))
runL = 0
for x in range(xi.min(), xi.max()):
    if lumrow[x] > floor * 3:
        runL += 1
    elif runL:
        break
P(f'   widest scanline y={mid}: floor Y {floor:.4f}; leading bright run {runL} px'
  f' = {runL/s:.2f} world units = {runL/s*1.574:.2f} css px at the shipped 1920 zoom')

# ------------------------------------------------------------------ boss over the pit
P('\n== room B: how much of the walkable pit the creature covers ==')
SH = '/home/anshtyagi/Documents/pixel-artgame/docs/art/shipped'
gm = {g['name']: g for g in json.load(open(f'{SH}/geometry.json'))}
c = gm['arena-1920']['geom']['ctm']
full = np.asarray(Image.open(f'{SH}/plate-arena-nohud-empty.png').convert('RGB'), float)
noboss = np.asarray(Image.open(f'{SH}/plate-arena-noboss.png').convert('RGB'), float)
bossmask = np.abs(full - noboss).max(axis=2) > 10
PIT_TOP, PIT_BOT = 384, 607
x0 = int(c['a'] * 0 + c['e'])
x1 = int(c['a'] * 1024 + c['e'])
y0 = int(c['a'] * PIT_TOP + c['f'])
y1 = int(c['a'] * (PIT_BOT + 1) + c['f'])
y0c, y1c = max(0, y0), min(full.shape[0], y1)
pit = bossmask[y0c:y1c, max(0, x0):min(full.shape[1], x1)]
P(f'   pit band on screen: x {x0}..{x1}, y {y0}..{y1} (clipped to {y0c}..{y1c})')
P(f'   creature covers {pit.mean():.1%} of the walkable pit rectangle'
  f'  ({pit.sum():,} of {pit.size:,} px)')
# the reference's creature over its own floor, for the same ratio
open(f'{OUT}/../judge-report.txt', 'w').write('\n'.join(out) + '\n')
print('\n'.join(out))
