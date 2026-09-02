#!/usr/bin/env python3
"""Throwaway (task: verify:art-judge). Answers the user's six demands with numbers, read
off the freshly-shot PNGs in docs/art/shipped/ and off the two reference PNGs. Constants
come from packages/client/src/map.ts by parse, never retyped.

    python3 scripts/spike/looksright/judge2.py
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

SRC = open(f'{ROOT}/packages/client/src/map.ts').read()


def const(n):
    return int(re.search(rf'export const {n} = (-?\d+)', SRC).group(1))


MAP_TILE = const('MAP_TILE') if 'MAP_TILE ' in SRC else 16
PIT_TOP, PIT_BOT = const('PIT_TOP'), const('PIT_BOT')
LOBBY_TOP, LOBBY_BOT = const('LOBBY_TOP'), const('LOBBY_BOT')
GATE = (const('GATE_MIN_X'), const('GATE_MAX_X'), const('GATE_MIN_Y'), const('GATE_MAX_Y'))
ARENA_UNITS = 1024
GRID = re.findall(r"'([^']*)'", re.search(r'MAP_GRID[^=]*=\s*\[(.*?)\]\s*;', SRC, re.S).group(1))
assert len(GRID) == 64 and all(len(r) == 64 for r in GRID), (len(GRID), len(GRID[0]))
GEOM = {g['name']: g for g in json.load(open(f'{SHOT}/geometry.json'))}
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


def img(p):
    return np.asarray(Image.open(p).convert('RGB'), float)


class Cam:
    """world -> STAGE-png coords (the -stage.png crop starts at stage.x/stage.y)."""

    def __init__(self, name):
        g = GEOM[name]['geom']
        c = g['ctm']
        self.s, self.e, self.f = c['a'], c['e'], c['f']
        st = g['stage']
        self.ox, self.oy, self.w, self.h = st['x'], st['y'], st['width' if 'width' in st else 'w'], st['h']

    def px(self, x, y):
        return self.s * x + self.e - self.ox, self.s * y + self.f - self.oy

    def box(self, x0, y0, x1, y1):
        a, b = self.px(x0, y0), self.px(x1, y1)
        return tuple(int(round(v)) for v in (a[0], a[1], b[0], b[1]))


CA, CB = Cam('lobby-1920'), Cam('arena-1920')


def tile_mask(cam, chars, shape):
    """Boolean mask over a stage png: pixels whose world tile is one of `chars`."""
    h, w = shape
    xs = (np.arange(w) + 0.5 + cam.ox - cam.e) / cam.s
    ys = (np.arange(h) + 0.5 + cam.oy - cam.f) / cam.s
    tx = np.floor(xs / MAP_TILE).astype(int)
    ty = np.floor(ys / MAP_TILE).astype(int)
    ok = (tx >= 0) & (tx < 64)
    oky = (ty >= 0) & (ty < 64)
    g = np.array([[c for c in r] for r in GRID])
    m = np.zeros((h, w), bool)
    idx = np.ix_(ty[oky], tx[ok])
    sub = np.isin(g[idx], list(chars))
    m[np.ix_(oky, ok)] = sub
    return m


# ================================================================= 1. OBSTACLES
P('== 1. SQUARE / BLOCK OBSTACLES ON THE PLAYABLE FLOOR ==')
PERIM = lambda r, c: r in (0, 63) or c in (0, 1, 62, 63)
DIV = lambda r: 35 <= r <= 42
interior_walls = [(r, c) for r in range(64) for c in range(64)
                  if GRID[r][c] == '#' and not PERIM(r, c) and not DIV(r)]
P(f'   MAP_GRID wall tiles that are neither perimeter (rows 0/63, cols 0-1/62-63)')
P(f'   nor the rows 35-42 divider/gate structure: {len(interior_walls)}')
# room-by-room: any wall tile inside the movement box of either zone
lobby_walls = [(r, c) for r in range(64) for c in range(64)
               if GRID[r][c] == '#' and LOBBY_TOP <= r * MAP_TILE <= LOBBY_BOT and 1 < c < 62]
pit_walls = [(r, c) for r in range(64) for c in range(64)
             if GRID[r][c] == '#' and PIT_TOP <= r * MAP_TILE <= PIT_BOT and 1 < c < 62]
P(f'   inside the LOBBY movement box (world y {LOBBY_TOP}..{LOBBY_BOT}, cols 2..61): {len(lobby_walls)} wall tiles')
P(f'   inside the PIT   movement box (world y {PIT_TOP}..{PIT_BOT}, cols 2..61): {len(pit_walls)} wall tiles'
  f'   (the chamfer + divider shoulders, rows {sorted({r for r,_ in pit_walls})})')
# per-row run counting: an obstacle splits a floor row into >1 run
def runs(row_s, chars):
    return len([m for m in re.finditer(r'[' + chars + r']+', row_s)])
bad = [(r, runs(GRID[r], r'\.')) for r in range(43, 63) if runs(GRID[r], r'\.') != 1]
P(f'   lobby rows 43-62 whose floor is NOT one single run (i.e. something splits it): {len(bad)}')
bad2 = [(r, runs(GRID[r], 'PBE')) for r in range(24, 41) if runs(GRID[r], 'PBE') != 1]
P(f'   pit rows 24-40 whose floor is NOT one single run: {len(bad2)}')

# and the pixel check: is any *painted* wall mass sitting on a walkable tile?
P('\n   pixel check -- painted wall colour standing on a walkable tile:')
for lbl, png, cam, chars in (('lobby', 'plate-lobby-nohud-empty-stage.png', CA, '.'),
                             ('arena', 'plate-arena-nohud-empty-stage.png', CB, 'PBE')):
    a = img(f'{SHOT}/{png}')
    walk = tile_mask(cam, chars, a.shape[:2])
    wall = tile_mask(cam, '#', a.shape[:2])
    yw = Y(a)
    # wall mass reference: the median luminance of tiles the bitboard calls wall
    wall_med = np.median(yw[wall])
    floor_med = np.median(yw[walk])
    # count walkable pixels as bright as the wall's own median
    hits = (yw[walk] >= wall_med).sum()
    P(f'   {lbl:5s} wall median Y {wall_med:.4f}  floor median Y {floor_med:.4f}  '
      f'walkable px at or above wall median: {hits/walk.sum():.2%} ({hits} of {walk.sum()})')

# ============================================================== 2. FLOOR OPENNESS
P('\n== 2. IS THE FLOOR "ALMOST COMPLETELY OPEN"? ==')
P('   mask = |full frame - the same frame with that layer hidden|, restricted to walkable tiles.')
full = img(f'{SHOT}/plate-lobby-nohud-empty-stage.png')
nop = img(f'{SHOT}/plate-lobby-noprops-stage.png')
walkA = tile_mask(CA, '.', full.shape[:2])
d = np.abs(full - nop).sum(axis=2)
propmask = d > 24
P(f'   LOBBY: props/decoration nodes hidden = 1 group. prop pixels total {propmask.sum()}')
P(f'          of which ON WALKABLE FLOOR: {(propmask & walkA).sum()} px = '
  f'{(propmask & walkA).sum()/walkA.sum():.3%} of the walkable floor')
# the same question for the arena: what covers the pit? the creature.
fullB = img(f'{SHOT}/plate-arena-nohud-empty-stage.png')
nobB = img(f'{SHOT}/plate-arena-noboss-stage.png')
walkB = tile_mask(CB, 'PBE', fullB.shape[:2])
dB = np.abs(fullB - nobB).sum(axis=2)
bossmask = dB > 24
P(f'   ARENA: boss pixels total {bossmask.sum()}')
P(f'          of which ON WALKABLE PIT FLOOR: {(bossmask & walkB).sum()} px = '
  f'{(bossmask & walkB).sum()/walkB.sum():.3%} of the walkable pit')
# reference B: the creature's share of its own floor ellipse
refB = img(REF_B)
P(f'   reference B for comparison is measured in section 3.')

# ============================================================ 3. SIZE / SPACIOUSNESS
P('\n== 3. IS THE ROOM LARGE, WIDE AND SPACIOUS? playable area / frame ==')


def ref_floor_box(a, lo, hi):
    """Reference floor extent: the rows/cols whose median luminance is inside the floor band."""
    y = Y(a)
    return y


refA = img(REF_A)
yA = Y(refA)
P(f'   reference A png {refA.shape[1]}x{refA.shape[0]}')
# find the interior floor rectangle: scan the centre column/row for the wall band edges.
# the walls are markedly BRIGHTER than the floor in ref A; the void outside is darker.
midcol = yA[:, refA.shape[1] // 2]
midrow = yA[refA.shape[0] // 2, :]
fl = np.median(yA[380:600, 300:800])
P(f'   ref A floor median Y {fl:.4f}')
# horizontal: walk in from the centre until luminance leaves the floor band
def extent(prof, c, band):
    lo, hi = band
    i = c
    while i > 0 and lo <= prof[i] <= hi:
        i -= 1
    j = c
    while j < len(prof) - 1 and lo <= prof[j] <= hi:
        j += 1
    return i, j

# robust: use a smoothed profile of per-row/col medians over the middle band
colmed = np.median(yA[350:640, :], axis=0)
rowmed = np.median(yA[:, 250:850], axis=1)
band = (fl * 0.35, fl * 2.2)
l, r = extent(colmed, refA.shape[1] // 2, band)
t, b = extent(rowmed, refA.shape[0] // 2, band)
refA_floor = (r - l) * (b - t)
P(f'   ref A interior floor box x {l}..{r} ({r-l}px), y {t}..{b} ({b-t}px) '
  f'= {refA_floor/(refA.shape[0]*refA.shape[1]):.1%} of the png')
# shipped: walkable tiles projected to the stage
for lbl, cam, chars, shp in (('ship A lobby', CA, '.', full.shape[:2]),
                             ('ship B arena', CB, 'PBE', fullB.shape[:2])):
    m = tile_mask(cam, chars, shp)
    P(f'   {lbl}: walkable pixels {m.sum()} = {m.sum()/(shp[0]*shp[1]):.1%} of the '
      f'{shp[1]}x{shp[0]} stage')
    ys, xs = np.where(m)
    P(f'                  on-screen extent x {xs.min()}..{xs.max()} ({xs.max()-xs.min()}px, '
      f'{(xs.max()-xs.min())/shp[1]:.1%} of frame width), y {ys.min()}..{ys.max()} '
      f'({ys.max()-ys.min()}px, {(ys.max()-ys.min())/shp[0]:.1%} of frame height)')
refBimg = img(REF_B)
yB = Y(refBimg)
P(f'   reference B png {refBimg.shape[1]}x{refBimg.shape[0]}')

# ================================================================= 4. SYMMETRY
P('\n== 4. SYMMETRY ==')
asym = sum(1 for r in GRID if [{'B': 'P', 'E': 'P'}.get(c, c) for c in r]
           != [{'B': 'P', 'E': 'P'}.get(c, c) for c in r[::-1]])
P(f'   MAP_GRID rows not mirror-symmetric about x=31.5 (B/E read as P): {asym} of 64')


def mirror_err(a, cam):
    """mean |L - mirrored L| over the room, as a fraction of the room's own L range."""
    y = Y(a)
    cx = cam.px(ARENA_UNITS / 2, 0)[0]
    half = int(min(cx, a.shape[1] - cx)) - 1
    x0, x1 = int(round(cx)) - half, int(round(cx)) + half
    L = y[:, x0:x1]
    R = y[:, x0:x1][:, ::-1]
    rng = np.percentile(L, 99) - np.percentile(L, 1)
    return float(np.mean(np.abs(L - R)) / rng), float(np.mean(np.abs(L - R))), half


for lbl, png, cam in (('ship A lobby (empty plate)', 'plate-lobby-nohud-empty-stage.png', CA),
                      ('ship B arena (empty plate)', 'plate-arena-nohud-empty-stage.png', CB),
                      ('ship B arena, no boss', 'plate-arena-noboss-stage.png', CB)):
    f, raw, half = mirror_err(img(f'{SHOT}/{png}'), cam)
    P(f'   {lbl:28s} mean |L-mirror| {raw:.5f} = {f:.2%} of the frame\'s own L range '
      f'(+/-{half}px about the room centre line)')
# reference A, mirrored about its own floor centre
yy = Y(refA)
cx = (l + r) / 2
half = int(min(cx, refA.shape[1] - cx)) - 1
LA = yy[:, int(cx) - half:int(cx) + half]
RA = LA[:, ::-1]
rngA = np.percentile(LA, 99) - np.percentile(LA, 1)
P(f'   {"ref A":28s} mean |L-mirror| {np.mean(np.abs(LA-RA)):.5f} = '
  f'{np.mean(np.abs(LA-RA))/rngA:.2%} of its own L range (+/-{half}px)')

# ============================================================ 5. THE GATE
P('\n== 5. THE GATE: built into the wall, or a floating sign? ==')
gx0, gx1, gy0, gy1 = GATE
P(f'   walkable slot from map.ts: world x {gx0}..{gx1} = {gx1-gx0+1} units, '
  f'{(gx1-gx0+1)/(60*MAP_TILE):.1%} of the 960-unit interior')
a = img(f'{SHOT}/plate-lobby-nohud-empty-stage.png')
ya = Y(a)
# the painted mouth: at the wall's own vertical middle, find the dark hole
wall_rows = CA.box(0, 35 * MAP_TILE, 0, 43 * MAP_TILE)
P(f'   divider rows 35..42 on the stage: y {wall_rows[1]}..{wall_rows[3]}')
for wy in (38, 39, 40, 41, 42):
    ry = int(CA.px(0, wy * MAP_TILE + 8)[1])
    if not (0 <= ry < a.shape[0]):
        continue
    row = ya[ry]
    xc = int(CA.px(ARENA_UNITS / 2, 0)[0])
    wallY = np.median(np.concatenate([row[xc - 500:xc - 300], row[xc + 300:xc + 500]]))
    dark = row < wallY * 0.55
    # the run containing the centre
    i = xc
    while i > 0 and dark[i]:
        i -= 1
    j = xc
    while j < len(row) - 1 and dark[j]:
        j += 1
    wid_u = (j - i) / CA.s
    P(f'   row {wy} (world y {wy*MAP_TILE+8}): wall Y {wallY:.4f}, painted dark opening '
      f'{j-i} px = {wid_u:.0f} world units  (slot is {gx1-gx0+1}; cap is slot+16 = {gx1-gx0+17})')
# does the coursing stop at the pier face? measure horizontal-joint density in the pier
# columns vs the plain wall columns, on the same rows.
def joint_density(y0, y1, x0, x1):
    sub = ya[y0:y1, x0:x1]
    dv = np.abs(np.diff(sub, axis=0))
    return float((dv > 0.004).mean())


ry0 = int(CA.px(0, 36 * MAP_TILE)[1])
ry1 = int(CA.px(0, 42 * MAP_TILE)[1])
xc = int(CA.px(ARENA_UNITS / 2, 0)[0])
pier_l = (int(CA.px(gx0 - 60, 0)[0]), int(CA.px(gx0 - 8, 0)[0]))
plain = (int(CA.px(150, 0)[0]), int(CA.px(300, 0)[0]))
P(f'   horizontal-joint density (fraction of px with a vertical L step > 0.004), rows 36..41:')
P(f'     left pier   x{pier_l[0]}..{pier_l[1]}: {joint_density(ry0, ry1, *pier_l):.3f}')
P(f'     plain wall  x{plain[0]}..{plain[1]}: {joint_density(ry0, ry1, *plain):.3f}')
# does the tower have mass ABOVE the wall line, and is it continuous with the wall?
top_wall = int(CA.px(0, 35 * MAP_TILE)[1])
P(f'   wall line (row 35 top) on stage: y {top_wall}')
colslice = ya[:top_wall, xc - 200:xc + 200]
lit = (colslice > np.median(ya[top_wall + 20:top_wall + 60, plain[0]:plain[1]]) * 0.6)
if lit.any():
    rows_lit = np.where(lit.any(axis=1))[0]
    P(f'   painted structure above the wall line spans stage y {rows_lit.min()}..{rows_lit.max()} '
      f'= {(top_wall-rows_lit.min())/CA.s:.0f} world units of tower above the wall')
    # continuity: is every row between the tower top and the wall line occupied?
    gaps = [int(r) for r in range(rows_lit.min(), top_wall) if not lit[r].any()]
    P(f'   rows between the tower top and the wall line with NO structure (a floating gap): '
      f'{len(gaps)}')

# ============================================================= 6. ELEMENTS PRESENT
P('\n== 6. REFERENCE ELEMENTS ==')
P(f'   svg node counts (geometry.json): lobby {GEOM["lobby-1920"]["geom"]["svgNodes"]}, '
  f'arena {GEOM["arena-1920"]["geom"]["svgNodes"]}')
# floor detail: how much variation does the floor actually carry?
P('\n   floor DETAIL -- edge density and local contrast on the floor itself:')


def detail(y, m):
    gy = np.abs(np.diff(y, axis=0))[:, :-1]
    gx = np.abs(np.diff(y, axis=1))[:-1, :]
    mm = m[:-1, :-1]
    g = np.maximum(gx, gy)[mm]
    return float((g > 0.004).mean()), float(np.percentile(g, 95)), float(y[m].std())


for lbl, png, cam, chars in (('ship A lobby floor', 'plate-lobby-noprops-stage.png', CA, '.'),
                             ('ship B pit floor', 'plate-arena-noboss-stage.png', CB, 'PBE')):
    a = img(f'{SHOT}/{png}')
    m = tile_mask(cam, chars, a.shape[:2])
    e, p95, sd = detail(Y(a), m)
    P(f'   {lbl:20s} edge px {e:.1%}  |grad| p95 {p95:.5f}  L sd {sd:.5f}')
# references, over their floor boxes only
mA = np.zeros(refA.shape[:2], bool)
mA[t + 30:b - 30, l + 30:r - 30] = True
e, p95, sd = detail(yA, mA)
P(f'   {"ref A floor":20s} edge px {e:.1%}  |grad| p95 {p95:.5f}  L sd {sd:.5f}')
mB = np.zeros(refBimg.shape[:2], bool)
mB[380:560, 150:950] = True
e, p95, sd = detail(yB, mB)
P(f'   {"ref B floor":20s} edge px {e:.1%}  |grad| p95 {p95:.5f}  L sd {sd:.5f}')

# torch pools: does a torch actually light the floor?
P('\n   torch pools -- floor luminance at the pool centre vs the floor median:')
a = img(f'{SHOT}/plate-lobby-noprops-stage.png')
afull = img(f'{SHOT}/plate-lobby-nohud-empty-stage.png')
ya2 = Y(afull)
mA2 = tile_mask(CA, '.', afull.shape[:2])
fmed = float(np.median(ya2[mA2]))
POOLS = [(196, 694), (324, 694), (700, 694), (828, 694), (62, 712), (62, 888),
         (962, 712), (962, 888), (320, 961), (704, 961)]
vals = []
for (px_, py_) in POOLS:
    x0, y0, x1, y1 = CA.box(px_ - 12, py_ - 12, px_ + 12, py_ + 12)
    if x0 < 0 or y0 < 0 or y1 > afull.shape[0] or x1 > afull.shape[1]:
        continue
    vals.append(float(np.median(ya2[y0:y1, x0:x1])))
P(f'   floor median Y {fmed:.4f}; pool centres Y {["%.4f" % v for v in vals]}')
if vals:
    P(f'   brightest pool / floor median = {max(vals)/max(fmed,1e-9):.2f}x, '
      f'median pool / floor = {np.median(vals)/max(fmed,1e-9):.2f}x')
# reference A: the same, at its torches (left wall torch pool ~ x 95 y 265)
refpool = float(np.median(yA[290:330, 105:165]))
reffl = float(np.median(yA[t + 30:b - 30, l + 30:r - 30]))
P(f'   ref A: floor median Y {reffl:.4f}, left-wall torch pool Y {refpool:.4f} '
  f'= {refpool/reffl:.2f}x')

print('\n'.join(out))
open(f'{SHOT}/judge2.txt', 'w').write('\n'.join(out) + '\n')
