#!/usr/bin/env python3
"""Throwaway (task: looks-right). Measures the SHIPPED frames against the two references.

Everything below is read off the PNGs `shoot.mjs` wrote, plus the world->screen CTM the
browser reported, so no number here is a re-derivation of the source. Method matches
docs/art/legibility.py exactly (WCAG relative luminance, sRGB->linear 0.2126/0.7152/0.0722,
contrast (hi+.05)/(lo+.05)) so the two sets of numbers are comparable.

    python3 scripts/spike/looksright/measure.py
"""
import json
import re
import sys

import numpy as np
from PIL import Image

ROOT = '/home/anshtyagi/Documents/pixel-artgame'
SHOT = f'{ROOT}/docs/art/shipped'
REF_A = '/home/anshtyagi/Downloads/waiting_area_full_vertical.png'
REF_B = '/home/anshtyagi/Downloads/actual_boss_arena.png'

MAP_TILE = 16
PIT_TOP, PIT_BOT = 384, 607
LOBBY_TOP, LOBBY_BOT = 640, 1007
GATE = (480, 543, 608, 639)
ARENA_UNITS = 1024
SPRITE_W, SPRITE_H = 33, 42
SKINS = ['Cobalt', 'Nocturne', 'Argent']


def lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def Y(rgb):
    l = lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def K(a, b):
    hi, lo = np.maximum(a, b), np.minimum(a, b)
    return (hi + 0.05) / (lo + 0.05)


def img(p):
    return np.asarray(Image.open(p).convert('RGB'), float)


GRID = re.findall(r"'([^']*)'", re.search(
    r'MAP_GRID[^=]*=\s*\[(.*?)\]\s*;', open(f'{ROOT}/packages/client/src/map.ts').read(), re.S).group(1))
assert len(GRID) == 64 and len(GRID[0]) == 64


class Cam:
    """world -> screen, from the CTM the browser reported (a === d, no rotation)."""

    def __init__(self, g):
        c = g['geom']['ctm']
        self.s, self.e, self.f = c['a'], c['e'], c['f']
        st = g['geom']['stage']
        self.stage = (st['x'], st['y'], st['w'], st['h'])
        self.vb = [float(v) for v in g['geom']['viewBox'].split()]

    def px(self, x, y):
        return self.s * x + self.e, self.s * y + self.f

    def box(self, x0, y0, x1, y1):
        a = self.px(x0, y0)
        b = self.px(x1, y1)
        return (int(round(a[0])), int(round(a[1])), int(round(b[0])), int(round(b[1])))


GEOM = {g['name']: g for g in json.load(open(f'{SHOT}/geometry.json'))}


def seat_world(seat, arena):
    col, row = seat % 5, seat // 5
    if arena:
        return 180 + col * 168 + row * 22, 430 + row * 44
    return 150 + col * 180 + row * 26, 700 + row * 72


def crop(a, b):
    x0, y0, x1, y1 = b
    x0, y0 = max(0, x0), max(0, y0)
    return a[y0:y1, x0:x1]


out = []
P = out.append


# ---------------------------------------------------------------- 1. the frame
P('== 1. framing: what actually reaches the screen ==')
for name in ('lobby-1920', 'arena-1920', 'lobby-1366', 'arena-1366'):
    g = GEOM[name]
    c = Cam(g)
    vx, vy, vw, vh = c.vb
    room_frac = ARENA_UNITS / vw
    off = (vw - ARENA_UNITS) / vw
    P(f'   {name:12s} stage {c.stage[2]:6.1f}x{c.stage[3]:6.1f}  {c.s:.4f} px/unit  '
      f'knight {SPRITE_H * c.s:5.1f} px  room fills {room_frac:5.1%} of frame width, '
      f'off-room {off:5.1%}')

# how much of that off-room surplus is painted masonry vs raw void
a = img(f'{SHOT}/plate-lobby-nohud-empty.png')
b = img(f'{SHOT}/plate-arena-nohud-empty.png')
c = Cam(GEOM['lobby-1920'])
mid = int(c.stage[1] + c.stage[3] * 0.5)
row_a, row_b = Y(a[mid]), Y(b[mid])
lx, _ = c.px(0, 0)
rx, _ = c.px(ARENA_UNITS, 0)
P(f'   room edges on screen: x {lx:.0f}..{rx:.0f} of 0..1920')
for lbl, row in (('lobby', row_a), ('arena', row_b)):
    left = row[: int(lx)]
    right = row[int(rx):]
    dark = np.concatenate([left, right])
    P(f'   {lbl:5s} off-room strip at mid-height: {len(dark)} px ({len(dark)/1920:.1%} of width), '
      f'Y p50 {np.percentile(dark, 50):.4f}  p95 {np.percentile(dark, 95):.4f}  '
      f'in-room floor Y p50 {np.percentile(row[int(lx):int(rx)], 50):.4f}')

# ------------------------------------------------------------- 2. floor & palette
P('\n== 2. floor: shipped vs reference (percentiles p5 p25 p50 p75 p95) ==')


def floor_stats(a, box):
    c = crop(a, box).reshape(-1, 3)
    return np.percentile(Y(c), [5, 25, 50, 75, 95]), c.mean(axis=0)


ca = Cam(GEOM['lobby-1920'])
cb = Cam(GEOM['arena-1920'])
# Shipped floor crops: walkable stone only, clear of walls, props and the boss.
SHIP_A = ca.box(200, 700, 820, 980)
SHIP_B = cb.box(120, 500, 900, 600)
REF_BOX_A = (150, 300, 980, 690)
REF_BOX_B = (200, 300, 920, 520)

rows = [
    ('ref A', img(REF_A), REF_BOX_A),
    ('ship A', img(f'{SHOT}/plate-lobby-nohud-empty.png'), SHIP_A),
    ('ref B', img(REF_B), REF_BOX_B),
    ('ship B', img(f'{SHOT}/plate-arena-nohud-empty.png'), SHIP_B),
]
floors = {}
for lbl, a, box in rows:
    p, m = floor_stats(a, box)
    floors[lbl] = (p, m)
    P(f'   {lbl:7s} Y {np.round(p, 4)}  mean sRGB ({m[0]:5.1f},{m[1]:5.1f},{m[2]:5.1f})  '
      f'R-B {m[0]-m[2]:+6.1f}  G-B {m[1]-m[2]:+6.1f}')

P('\n   the two rooms\' own wall-vs-floor separation (reference A\'s signature):')
WALL_A_REF = (48, 300, 92, 650)        # reference A's left wall column: lit stone, no torch
WALL_A_SHIP = ca.box(200, 590, 820, 630)
for lbl, a, wbox, fbox in (('ref A', img(REF_A), WALL_A_REF, REF_BOX_A),
                           ('ship A', img(f'{SHOT}/plate-lobby-nohud-empty.png'), WALL_A_SHIP, SHIP_A)):
    w = np.percentile(Y(crop(a, wbox).reshape(-1, 3)), 50)
    f = np.percentile(Y(crop(a, fbox).reshape(-1, 3)), 50)
    P(f'   {lbl:7s} wall Y {w:.4f}  floor Y {f:.4f}  wall/floor contrast {K(w, f):.2f}:1')

# ------------------------------------------------------- 3. knights vs the floor
P('\n== 3. knights: body and boundary against the floor they stand on ==')
P('   body mask = |20-seat frame - 1-seat plate| per seat box; floor = the plate under it.')


def knight_measure(full_png, plate_png, cam, arena, seats=range(1, 20)):
    full, plate = img(full_png), img(plate_png)
    d = np.abs(full - plate).sum(axis=2)
    res = []
    for seat in seats:
        wx, wy = seat_world(seat, arena)
        # sprite box: 33 x 42 units, feet at wy (FEET_Y = 20 of 42 from the group origin)
        x0, y0, x1, y1 = cam.box(wx - SPRITE_W / 2 - 3, wy - 30, wx + SPRITE_W / 2 + 3, wy + 14)
        if x0 < 0 or y0 < 0 or x1 > full.shape[1] or y1 > full.shape[0]:
            continue
        sub_d = d[y0:y1, x0:x1]
        body = sub_d > 24
        if body.sum() < 60:
            continue
        # floor beside it, from the plate, in a ring one sprite-width out
        px0, py0, px1, py1 = cam.box(wx - SPRITE_W, wy - 34, wx + SPRITE_W, wy + 18)
        ring = np.ones((py1 - py0, px1 - px0), bool)
        ix0, iy0 = x0 - px0, y0 - py0
        ring[iy0:iy0 + (y1 - y0), ix0:ix0 + (x1 - x0)] = False
        floor_px = plate[py0:py1, px0:px1][ring]
        if floor_px.size == 0:
            continue
        yb = Y(full[y0:y1, x0:x1][body])
        yf = Y(floor_px)
        # the boundary: body pixels adjacent to non-body, i.e. the outline the eye reads
        pad = np.pad(body, 1)
        edge = body & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
        ye = Y(full[y0:y1, x0:x1][edge])
        res.append(dict(seat=seat, skin=SKINS[seat % 3], cls='archer' if seat % 2 else 'knight',
                        body_px=int(body.sum()),
                        body_med=float(np.median(yb)), body_p90=float(np.percentile(yb, 90)),
                        edge_p90=float(np.percentile(ye, 90)),
                        edge_med=float(np.median(ye)),
                        floor_med=float(np.median(yf))))
    return res


for lbl, full, plate, cam, arena in (
        ('A waiting', f'{SHOT}/plate-lobby-nohud.png', f'{SHOT}/plate-lobby-nohud-empty.png', ca, False),
        ('B arena', f'{SHOT}/plate-arena-nohud.png', f'{SHOT}/plate-arena-nohud-empty.png', cb, True)):
    r = knight_measure(full, plate, cam, arena)
    P(f'   -- room {lbl}: {len(r)} seats measured --')
    for cls in ('knight', 'archer'):
        s = [x for x in r if x['cls'] == cls]
        if not s:
            continue
        bm = np.median([x['body_med'] for x in s])
        fm = np.median([x['floor_med'] for x in s])
        e90 = np.median([x['edge_p90'] for x in s])
        emd = np.median([x['edge_med'] for x in s])
        worst = min(K(x['body_med'], x['floor_med']) for x in s)
        P(f'      {cls:6s} n={len(s):2d}  body Y {bm:.4f} vs floor Y {fm:.4f} = '
          f'{K(bm, fm):.2f}:1 (worst seat {worst:.2f}:1)')
        P(f'             boundary ring Y p50 {emd:.4f} = {K(emd, fm):.2f}:1  '
          f'p90 {e90:.4f} = {K(e90, fm):.2f}:1   <- the outline the eye actually reads')
    for skin in SKINS:
        s = [x for x in r if x['skin'] == skin]
        if s:
            bm = np.median([x['body_med'] for x in s])
            fm = np.median([x['floor_med'] for x in s])
            P(f'      {skin:9s} body {bm:.4f} vs floor {fm:.4f} = {K(bm, fm):.2f}:1')

# -------------------------------------------------------- 4. rim / halo, in px
P('\n== 4. rim light: is it there, and how thick in CSS px ==')
defs = open(f'{ROOT}/app/src/render/knights.gen.ts').read()
has_halo = 'id="k0-halo"' in defs
P(f'   knights.gen.ts carries the dilated halo groups: {has_halo}')
P(f'   ids present: {sorted(set(re.findall(chr(39) + r"|" + chr(34) + r"?id=\"(k0-[a-zA-Z-]+)\"", defs)))}')
src = open(f'{ROOT}/app/src/render/Knight.tsx').read()
P(f'   Knight.tsx HAS_HALO branch -> rimPose = ' +
  ('halo (2 units, symmetric)' if has_halo else "'sil' offset ONE unit up-left (the fallback)"))
for name in ('lobby-1920', 'arena-1920', 'lobby-1366', 'arena-1366'):
    s = Cam(GEOM[name]).s
    P(f'   {name:12s} 1 unit = {s:.3f} css px   ->  shipped rim is {1*s:.2f} px thick; '
      f'the spec\'s 2-unit halo would be {2*s:.2f} px')

# --------------------------------------------------- 5. the boss vs its backdrop
P('\n== 5. the boss: silhouette against what is behind it ==')
full = img(f'{SHOT}/plate-arena-nohud-empty.png')
noboss = img(f'{SHOT}/plate-arena-noboss.png')
d = np.abs(full - noboss).sum(axis=2)
mask = d > 12
# The stage only: the shell's header wordmark and the error bar are outside it and both
# differ between two browser launches.
sx, sy, sw, sh = Cam(GEOM['arena-1920']).stage
keep = np.zeros_like(mask)
keep[int(sy) + 4:int(sy + sh) - 4, int(sx):int(sx + sw)] = True
mask &= keep
ys, xs = np.nonzero(mask)
bx0, bx1, by0, by1 = xs.min(), xs.max(), ys.min(), ys.max()
stage = Cam(GEOM['arena-1920']).stage
P(f'   boss mask {mask.sum():,} px, bbox x {bx0}..{bx1} ({bx1-bx0} px) y {by0}..{by1} ({by1-by0} px)')
P(f'   as a fraction of the stage: width {(bx1-bx0)/stage[2]:.1%}  height {(by1-by0)/stage[3]:.1%}  '
  f'area {mask.sum()/(stage[2]*stage[3]):.1%}')
# The orb is not the creature. CORE is boss-local arena units, the boss group is a plain
# translate(boss.x, boss.y), so world core = (512 + 75, 400 - 54) and the spill reaches
# CORE_R * 2.6. Excluded, or "the boss body" would be measuring its own light source.
cx, cy = cb.px(512 + 75, 400 - 54)
gy, gx = np.mgrid[0:mask.shape[0], 0:mask.shape[1]]
orb = ((gx - cx) ** 2 + (gy - cy) ** 2) <= (60 * 2.6 * cb.s) ** 2
body_mask = mask & ~orb
P(f'   orb + spill excluded: {(mask & orb).sum():,} px of the mask')
yb = Y(full[body_mask])
ybg = Y(noboss[body_mask])     # exactly what the creature covers up
P(f'   boss body    Y p5 {np.percentile(yb,5):.4f}  p50 {np.percentile(yb,50):.4f}  '
  f'p90 {np.percentile(yb,90):.4f}  p99 {np.percentile(yb,99):.4f}  (p50->p99 spread '
  f'{np.percentile(yb,99)/max(np.percentile(yb,50),1e-6):.1f}x)')
P(f'   backdrop it covers Y p50 {np.percentile(ybg,50):.4f}')
P(f'   silhouette contrast, body p50 vs its own backdrop p50: {K(np.percentile(yb,50), np.percentile(ybg,50)):.2f}:1')
for step in (1.5, 2, 3, 4.5):
    frac = (K(yb, ybg) >= step).mean()
    P(f'      fraction of the creature\'s pixels clearing {step}:1 against what it covers: {frac:.3f}')

# reference B's creature, hand box, same statistic
refb = img(REF_B)
RB_BOSS = (430, 60, 680, 350)   # reference B's creature, hand-boxed off the plate
rb = Y(crop(refb, RB_BOSS).reshape(-1, 3))
rbg = Y(crop(refb, (120, 60, 380, 350)).reshape(-1, 3))   # the wall beside it
P(f'   reference B creature Y p5 {np.percentile(rb,5):.4f}  p50 {np.percentile(rb,50):.4f}  '
  f'p90 {np.percentile(rb,90):.4f}  p99 {np.percentile(rb,99):.4f}  (spread '
  f'{np.percentile(rb,99)/np.percentile(rb,50):.1f}x)')
P(f'   reference B wall beside it Y p50 {np.percentile(rbg,50):.4f}')
P(f'   reference B creature box {RB_BOSS[2]-RB_BOSS[0]}x{RB_BOSS[3]-RB_BOSS[1]} px of a '
  f'{refb.shape[1]}x{refb.shape[0]} plate = {(RB_BOSS[2]-RB_BOSS[0])/refb.shape[1]:.1%} of frame width, '
  f'{(RB_BOSS[3]-RB_BOSS[1])/refb.shape[0]:.1%} of frame height')
P('')
P(f'   >> THE INVERSION: reference creature p50 / its floor p50 = '
  f'{np.percentile(rb,50)/floors["ref B"][0][2]:.2f}x  (the creature is DARKER than the floor)')
P(f'   >>                shipped   creature p50 / its floor p50 = '
  f'{np.percentile(yb,50)/floors["ship B"][0][2]:.2f}x  (the creature is the BRIGHTEST large mass)')

# a knight standing in front of the creature
P('\n   knights that overlap the creature (the worst background in the room):')
r = knight_measure(f'{SHOT}/plate-arena-nohud.png', f'{SHOT}/plate-arena-nohud-empty.png', cb, True)
over = []
for x in r:
    wx, wy = seat_world(x['seat'], True)
    sx, sy = cb.px(wx, wy - 10)
    if 0 <= int(sy) < mask.shape[0] and 0 <= int(sx) < mask.shape[1] and mask[int(sy), int(sx)]:
        over.append(x)
if over:
    bm = np.median([x['body_med'] for x in over])
    fm = np.median([x['floor_med'] for x in over])
    e90 = np.median([x['edge_p90'] for x in over])
    P(f'      {len(over)} of {len(r)} seats  body {bm:.4f} vs backdrop {fm:.4f} = {K(bm, fm):.2f}:1  '
      f'boundary p90 {e90:.4f} = {K(e90, fm):.2f}:1')
else:
    P('      none in this layout')

# ------------------------------------------ 6. decoration over walkable floor
P('\n== 6. decoration over walkable floor (room A) ==')
props_on = img(f'{SHOT}/plate-lobby-nohud-empty.png')
props_off = img(f'{SHOT}/plate-lobby-noprops.png')
pd = np.abs(props_on - props_off).sum(axis=2)
prop = pd > 10
tot_walk = 0
hit_walk = 0
hard = 0
h, w = prop.shape
for ty in range(64):
    for tx in range(64):
        if GRID[ty][tx] == '#':
            continue
        wy = ty * MAP_TILE
        if not (LOBBY_TOP <= wy <= LOBBY_BOT):
            continue
        x0, y0, x1, y1 = ca.box(tx * MAP_TILE, wy, tx * MAP_TILE + MAP_TILE, wy + MAP_TILE)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(w, x1), min(h, y1)
        if x1 <= x0 or y1 <= y0:
            continue
        tot_walk += 1
        cov = prop[y0:y1, x0:x1].mean()
        if cov > 0.02:
            hit_walk += 1
        if cov > 0.5:
            hard += 1
P(f'   walkable lobby tiles on screen: {tot_walk}')
P(f'   touched by any prop pixel (>2 % of the tile): {hit_walk} ({hit_walk/tot_walk:.1%})')
P(f'   more than half covered:                       {hard} ({hard/tot_walk:.1%})')
solid = pd > 90
P(f'   prop pixels, any change  : {prop.sum():,} = {prop.sum()/(stage[2]*stage[3]):.2%} of the stage')
P(f'   prop pixels, OPAQUE mass : {solid.sum():,} = {solid.sum()/(stage[2]*stage[3]):.2%} '
  '(the rest is torch light, which is paint, not an object)')
hard2 = 0
for ty in range(64):
    for tx in range(64):
        if GRID[ty][tx] == '#':
            continue
        wy = ty * MAP_TILE
        if not (LOBBY_TOP <= wy <= LOBBY_BOT):
            continue
        x0, y0, x1, y1 = ca.box(tx * MAP_TILE, wy, tx * MAP_TILE + MAP_TILE, wy + MAP_TILE)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(w, x1), min(h, y1)
        if x1 > x0 and y1 > y0 and solid[y0:y1, x0:x1].mean() > 0.25:
            hard2 += 1
P(f'   walkable tiles with OPAQUE mass over a quarter of them: {hard2} ({hard2/tot_walk:.1%})')
# how much of that lands over walkable floor rather than on the wall
wall_mask = np.zeros_like(prop)
for ty in range(64):
    for tx in range(64):
        if GRID[ty][tx] != '#':
            continue
        x0, y0, x1, y1 = ca.box(tx * MAP_TILE, ty * MAP_TILE, tx * MAP_TILE + MAP_TILE, ty * MAP_TILE + MAP_TILE)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(w, x1), min(h, y1)
        if x1 > x0 and y1 > y0:
            wall_mask[y0:y1, x0:x1] = True
P(f'   of those, {(prop & ~wall_mask).sum()/max(prop.sum(),1):.1%} sits over non-wall tiles '
  '(light pools count here, and they are paint, not mass)')

# ------------------------------------------------- 7. the local-player marker
P('\n== 7. the local marker in a crowd of twenty ==')
for lbl, full_png, plate_png, cam, arena in (
        ('A waiting', f'{SHOT}/plate-lobby-nohud.png', f'{SHOT}/plate-lobby-nohud-empty.png', ca, False),
        ('B arena', f'{SHOT}/plate-arena-nohud.png', f'{SHOT}/plate-arena-nohud-empty.png', cb, True)):
    full = img(full_png)
    wx, wy = seat_world(0, arena)
    x0, y0, x1, y1 = cam.box(wx - 22, wy - 42, wx + 22, wy + 16)
    sub = full[max(0, y0):y1, max(0, x0):x1]
    ysub = Y(sub)
    peak = ysub.max()
    # the whole stage, so "is it the brightest thing near a knight" is answerable
    sx, sy, sw, sh = cam.stage
    whole = Y(full[int(sy):int(sy + sh), int(sx):int(sx + sw)])
    P(f'   room {lbl}: marker box peak Y {peak:.4f}   stage p99.9 {np.percentile(whole, 99.9):.4f}  '
      f'stage max {whole.max():.4f}')
    P(f'      pixels in the whole stage at or above the marker peak: '
      f'{(whole >= peak - 1e-4).sum():,} ({(whole >= peak - 1e-4).mean():.3%})')
    # marker footprint: how many px of it are actually painted
    mk = (ysub >= peak * 0.75)
    P(f'      marker-bright pixels inside its own box: {mk.sum()} px '
      f'({mk.sum()/(ysub.size):.1%} of a {ysub.shape[1]}x{ysub.shape[0]} box), '
      f'chevron is {int(round(16*cam.s))}x{int(round(12*cam.s))} px')

print('\n'.join(out))
open(f'{ROOT}/docs/art/shipped/measurements.txt', 'w').write('\n'.join(out) + '\n')


# ------------------------------------------------ 8. room B: the floor rings
out2 = []
Q = out2.append
Q('\n== 8. room B: are the floor rings and medallions actually visible ==')
plate = img(f'{SHOT}/plate-arena-nohud-empty.png')
# ring family, spec section 2.2: centre (512, 496), semi-axes (496, 112), k = .22 .44 .65 .87 1.0
for k in (0.22, 0.44, 0.65, 0.87, 1.00):
    rx, ry = 496 * k, 112 * k
    on, off = [], []
    for t in np.linspace(0, 2 * np.pi, 720):
        wx, wy = 512 + rx * np.cos(t), 496 + ry * np.sin(t)
        if not (0 <= wx < ARENA_UNITS and PIT_TOP <= wy <= PIT_BOT):
            continue
        px, py = cb.px(wx, wy)
        qx, qy = cb.px(wx, wy + 6)
        px, py, qx, qy = int(px), int(py), int(qx), int(qy)
        if 0 <= py < plate.shape[0] and 0 <= px < plate.shape[1] and 0 <= qy < plate.shape[0]:
            on.append(Y(plate[py, px]))
            off.append(Y(plate[qy, qx]))
    if not on:
        continue
    on, off = np.array(on), np.array(off)
    l8_on = 255 * (np.clip(on, 0, 1) ** (1 / 2.2))
    l8_off = 255 * (np.clip(off, 0, 1) ** (1 / 2.2))
    Q(f'   ring k={k:.2f}  rx {rx:.0f} ry {ry:.0f}   on-ring L8 {l8_on.mean():5.1f}  '
      f'6 u inside L8 {l8_off.mean():5.1f}   delta {abs(l8_on.mean()-l8_off.mean()):4.1f} L8  '
      f'contrast {K(on.mean(), off.mean()):.2f}:1')
Q('   (spec section 2.2 predicted 4.9-13.1 L8 of mortar separation at wash 0.70;')
Q('    under ~1 L8 is what that section calls invisible)')

# how much of room B is featureless, against reference B
Q('\n== 9. how full the frame is: local contrast, shipped B vs reference B ==')
def texture(a, box, cam=None):
    c = crop(a, box)
    g = Y(c)
    # local range in a 9x9 window, cheap: max-min over shifted stacks
    st = np.stack([np.roll(np.roll(g, dy, 0), dx, 1) for dy in (-4, 0, 4) for dx in (-4, 0, 4)])
    rng = st.max(0) - st.min(0)
    return rng
sb = img(f'{SHOT}/plate-arena-nohud-empty.png')
rb2 = img(REF_B)
LEFT_SHIP = cb.box(20, 300, 300, 580)      # the left third of room B, clear of the boss
LEFT_REF = (30, 60, 330, 520)
for lbl, a, box in (('ship B left third', sb, LEFT_SHIP), ('ref B left third', rb2, LEFT_REF)):
    r = texture(a, box)
    yy = Y(crop(a, box))
    Q(f'   {lbl:20s} Y p50 {np.percentile(yy,50):.4f} p95 {np.percentile(yy,95):.4f}  '
      f'local 9x9 luminance range p50 {np.percentile(r,50):.4f} p95 {np.percentile(r,95):.4f}  '
      f'fraction of px in a window with range < 0.005: {(r < 0.005).mean():.1%}')

print('\n'.join(out2))
open(f'{ROOT}/docs/art/shipped/measurements.txt', 'a').write('\n'.join(out2) + '\n')
