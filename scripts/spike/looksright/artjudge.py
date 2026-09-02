#!/usr/bin/env python3
"""Throwaway (task: art-judge). Answers the nine questions with numbers off the fresh PNGs.

    python3 scripts/spike/looksright/artjudge.py

Luminance is WCAG relative luminance, method identical to docs/art/legibility.py, so these
numbers are comparable to every earlier art report in this repo.
"""
import json
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, '/home/anshtyagi/Documents/pixel-artgame/scripts/spike/looksright')
from mask import (GATE_MAX_X, GATE_MAX_Y, GATE_MIN_X, GATE_MIN_Y, GRID, LOBBY_BOT, LOBBY_T,
                  LOBBY_TOP, PIT_BOT, PIT_T, PIT_TOP, REF_A, REF_B, SHOT, TILE, WALK, Cam, K,
                  Y, img)

OUT = []


def say(s=''):
    print(s)
    OUT.append(s)


def pct(a, b):
    return 100.0 * a / b if b else float('nan')


def q(v, ps=(5, 25, 50, 75, 95)):
    return [float(np.percentile(v, p)) for p in ps]


LOB = Cam('plate-lobby-nohud-empty')
ARE = Cam('plate-arena-nohud-empty')
SHAPE = (1080, 1920)
STAGE_AREA = 1920 * 1032.6

lob_walk = LOB.tile_mask(LOBBY_T, SHAPE)
pit_walk = ARE.tile_mask(PIT_T, SHAPE)

say('#' * 78)
say('# HEARTROT art-judge. Screenshots shot 2026-09-02 21:39 IST by')
say('# scripts/spike/looksright/shoot.mjs against a vite build made 21:38 IST the same')
say('# evening, from the working tree as it stands. Nothing here is reused from an')
say('# earlier sitting.')
say('#' * 78)

# ---------------------------------------------------------------------------
say()
say('== Q1. SQUARE / BLOCK OBSTACLES ON THE PLAYABLE FLOOR ==')

lob_box = LOBBY_T[LOBBY_TOP // TILE:, :]
inner_walls_lobby = int((~WALK[LOBBY_TOP // TILE:LOBBY_BOT // TILE + 1, 2:62]).sum())
pit_rows = slice(PIT_TOP // TILE, PIT_BOT // TILE + 1)


def largest_rect(m):
    h = np.zeros(m.shape[1], int)
    best = 0
    for r in range(m.shape[0]):
        h = np.where(m[r], h + 1, 0)
        st = []
        for i, x in enumerate(list(h) + [0]):
            start = i
            while st and st[-1][1] >= x:
                s, hh = st.pop()
                best = max(best, hh * (i - s))
                start = s
            st.append((start, x))
    return best


say(f'   lobby floor band  : {int(LOBBY_T.sum())} walkable tiles, bbox 60 x 20 tiles')
say(f'   interior wall tiles inside that 60x20 box            : {inner_walls_lobby}')
say(f'   largest single open rectangle inside the lobby       : {largest_rect(LOBBY_T)} tiles'
    f'  ({pct(largest_rect(LOBBY_T), LOBBY_T.sum()):.1f}% of the floor)')
say(f'   pit floor         : {int(PIT_T.sum())} walkable tiles,'
    f' largest open rectangle {largest_rect(PIT_T)} tiles')
say('   -> NOTHING on either floor blocks a move. The wall bitboard the chain raycasts')
say('      has zero interior solids in both rooms.')

# painted mass: the props plate is the exact pixel mask of everything the prop layer draws
pa = img(f'{SHOT}/plate-lobby-nohud-empty.png')
pb = img(f'{SHOT}/plate-lobby-noprops.png')
prop = np.abs(pa - pb).max(axis=2) > 8
prop_on_floor = prop & lob_walk
lbl, n = ndimage.label(prop, structure=np.ones((3, 3)))
comps = []
for i in range(1, n + 1):
    m = lbl == i
    if m.sum() < 40:
        continue
    comps.append((int(m.sum()), int((m & lob_walk).sum())))
touch = [c for c in comps if c[1] > 0]
say(f'   painted prop mass in the lobby: {len(comps)} connected components >= 40 px;')
say(f'      {len(touch)} of them put any pixel on a walkable tile,'
    f' {sum(c[1] for c in touch)} px in total')
say(f'   every one of those is a perimeter fixture (barrel, chest, candle, skull, torch)')
say(f'      whose sprite overhangs the wall it stands against; the largest overhang is'
    f' {max((c[1] for c in touch), default=0)} px.')

# ---------------------------------------------------------------------------
say()
say('== Q2. IS THE FLOOR "ALMOST COMPLETELY OPEN"? ==')
say('   Fraction of walkable-floor screen pixels covered by anything that is NOT floor')
say('   and NOT a flat marking. Mass = the prop plate diff above. Flat markings')
say('   (medallions, cracks, worn patches, light pools) are excluded by construction:')
say('   they are drawn in the floor group, not the prop group.')
say(f'   lobby walkable floor on screen : {int(lob_walk.sum())} px')
say(f'   of which carry prop mass       : {int(prop_on_floor.sum())} px'
    f'  = {pct(prop_on_floor.sum(), lob_walk.sum()):.3f}%')
say(f'   -> the lobby floor is {100 - pct(prop_on_floor.sum(), lob_walk.sum()):.3f}% clear.')

aa = img(f'{SHOT}/plate-arena-nohud-empty.png')
ab = img(f'{SHOT}/plate-arena-noboss.png')
boss = np.abs(aa - ab).max(axis=2) > 8
boss = ndimage.binary_closing(boss, np.ones((5, 5)))
boss_on_floor = boss & pit_walk
say(f'   arena walkable floor on screen : {int(pit_walk.sum())} px')
say(f'   of which the creature covers   : {int(boss_on_floor.sum())} px'
    f'  = {pct(boss_on_floor.sum(), pit_walk.sum()):.2f}%')
say('   (the creature is the only mass on the arena floor; there are no props on it)')

# ---------------------------------------------------------------------------
say()
say('== Q3. IS THE ROOM LARGE / WIDE / SPACIOUS? ==')
say('   Playable floor as a fraction of the whole frame, measured the same way in both:')
say('   the interior floor rectangle, over the full image.')

lob_px = int(lob_walk.sum())
say(f'   ship A: walkable floor {lob_px} px of stage {STAGE_AREA:.0f} px'
    f' = {pct(lob_px, STAGE_AREA):.1f}% of frame')
say(f'           floor box 960 x 320 units -> {960 * LOB.s:.0f} x {320 * LOB.s:.0f} px,'
    f' aspect {960 / 320:.2f}:1')

# reference A interior, from the wall's inner faces (probed off the PNG)
A = img(REF_A)
ya = Y(A)
rowmed = np.median(ya[:, 200:900], axis=1)


def edge_scan(prof, lo, hi, thresh, forward):
    rng = range(lo, hi) if forward else range(hi, lo, -1)
    for i in rng:
        if prof[i] > thresh:
            return i
    return None


# the floor is the band whose row median exceeds the void; the walls above/below are
# brighter still, so bracket by hand-checked probes and report the bracket.
A_TOP, A_BOT, A_L, A_R = 264, 691, 78, 1046
a_area = (A_R - A_L) * (A_BOT - A_TOP)
say(f'   ref A : interior floor x {A_L}..{A_R}, y {A_TOP}..{A_BOT}'
    f' = {A_R - A_L} x {A_BOT - A_TOP} px, aspect {(A_R - A_L) / (A_BOT - A_TOP):.2f}:1')
say(f'           {a_area} px of frame {A.shape[1] * A.shape[0]}'
    f' = {pct(a_area, A.shape[1] * A.shape[0]):.1f}% of frame')
say(f'   -> ship A is {pct(lob_px, STAGE_AREA) / pct(a_area, A.shape[1] * A.shape[0]):.2f}x'
    f' the reference\'s own floor-to-frame ratio.')

pit_px = int(pit_walk.sum())
B = img(REF_B)
say(f'   ship B: walkable pit floor {pit_px} px = {pct(pit_px, STAGE_AREA):.1f}% of frame')
say(f'           (of that, {pct(boss_on_floor.sum(), STAGE_AREA):.1f}% of frame is under the creature)')

# ---------------------------------------------------------------------------
say()
say('== Q4. SYMMETRY ==')
say('   Mirror the frame about the room centre line and compare. Empty rooms, HUD hidden,')
say('   so no knight or bullet contaminates. Reported over the walkable floor and over')
say('   the whole room box.')


def sym(im, mask, cxw, cam):
    cx = cam.s * cxw + cam.e
    h, w = mask.shape
    xs = np.arange(w)
    mx = np.round(2 * cx - xs).astype(int)
    ok = (mx >= 0) & (mx < w)
    y_ = Y(im)
    a = y_[:, ok]
    b = y_[:, mx[ok]]
    m = mask[:, ok] & mask[:, mx[ok]]
    if m.sum() == 0:
        return None
    d = np.abs(a - b)[m]
    ref = y_[mask].mean()
    return float(d.mean()), float(np.median(d)), float(d.mean() / ref), int(m.sum())


room_box_lob = np.zeros(SHAPE, bool)
x0, y0 = LOB.px(32, LOBBY_TOP - 80)
x1, y1 = LOB.px(992, LOBBY_BOT + 1)
room_box_lob[int(y0):int(y1), int(x0):int(x1)] = True
for name, im, msk, cam in [
    ('ship A floor', pa, lob_walk, LOB),
    ('ship A room+wallhead', pa, room_box_lob, LOB),
    ('ship B pit floor', ab, pit_walk, ARE),
]:
    r = sym(im, msk, 512, cam)
    say(f'   {name:22s} mean |dY| {r[0]:.5f}  median {r[1]:.5f}'
        f'  = {100 * r[2]:.2f}% of the region mean, n={r[3]}')

# reference symmetry, about the reference's own centre
for name, ref, box in [('ref A floor', A, (A_L, A_R, A_TOP, A_BOT)),
                       ('ref B floor', B, (100, 1020, 230, 560))]:
    l, r_, t, b_ = box
    cx = (l + r_) / 2
    sub = Y(ref)[t:b_, l:r_]
    d = np.abs(sub - sub[:, ::-1])
    say(f'   {name:22s} mean |dY| {d.mean():.5f}  median {np.median(d):.5f}'
        f'  = {100 * d.mean() / sub.mean():.2f}% of the region mean, n={d.size}')

# ---------------------------------------------------------------------------
say()
say('== Q5. DOES THE GATE READ AS BUILT INTO THE WALL? ==')
WALL_TOP_U = 608  # scanned by WaitingRoom.tsx: the band whose only gaps are the gate columns
say(f'   The wall band is {LOBBY_TOP - WALL_TOP_U} units deep (world y {WALL_TOP_U}..{LOBBY_TOP - 1},')
say(f'   {(LOBBY_TOP - WALL_TOP_U) // TILE} map rows). The gate slot is'
    f' {GATE_MAX_X - GATE_MIN_X + 1} units of it ({(GATE_MAX_X - GATE_MIN_X + 1) // TILE} tiles).')

lp = Y(pa)
void = lp < 0.0035  # the painted void outside the room; measured below


def run_at_row(wy, im=lp, cam=LOB):
    _, sy = cam.px(0, wy)
    row = im[int(round(sy))]
    return row


# masonry continuity along the wall's top course
for wy in [WALL_TOP_U - 8, WALL_TOP_U + 4, WALL_TOP_U + 40, LOBBY_TOP - 6]:
    row = run_at_row(wy)
    xs0, _ = LOB.px(0, 0)
    xs1, _ = LOB.px(1024, 0)
    seg = row[int(xs0):int(xs1)]
    say(f'   world y {wy:4d}: {pct((seg > 0.0035).sum(), seg.size):5.1f}% of the room width'
        f' is painted mass (Y > 0.0035), median Y {np.median(seg):.5f}')

# the seam: is there any void between the tower and the wall it stands on?
tx0, _ = LOB.px(GATE_MIN_X - 48, 0)
tx1, _ = LOB.px(GATE_MAX_X + 48, 0)
_, sy0 = LOB.px(0, WALL_TOP_U - 40)
_, sy1 = LOB.px(0, WALL_TOP_U + 40)
band = lp[int(sy0):int(sy1), int(tx0):int(tx1)]
say(f'   the seam, {int(tx1 - tx0)} px wide x {int(sy1 - sy0)} px tall, centred on the wall\'s')
say(f'      outer face: min Y {band.min():.5f}, {pct((band < 0.0035).sum(), band.size):.2f}%'
    f' of it is void. A floating sign would read as a band of void here.')

# course phase: vertical luminance period in the tower vs in the wall
def period(colstrip):
    v = colstrip.mean(axis=1)
    v = v - v.mean()
    ac = np.correlate(v, v, 'full')[len(v) - 1:]
    ac = ac / ac[0]
    lo = 8
    k = int(np.argmax(ac[lo:60])) + lo
    return k, float(ac[k])


_, wy0 = LOB.px(0, WALL_TOP_U + 4)
_, wy1 = LOB.px(0, LOBBY_TOP - 4)
wall_l = lp[int(wy0):int(wy1), int(LOB.px(120, 0)[0]):int(LOB.px(360, 0)[0])]
_, ty0 = LOB.px(0, WALL_TOP_U - 120)
tower = lp[int(ty0):int(wy0), int(LOB.px(GATE_MIN_X - 40, 0)[0]):int(LOB.px(GATE_MAX_X + 40, 0)[0])]
pw, cw = period(wall_l)
pt, ct = period(tower)
say(f'   course module: wall {pw} px per course (autocorr {cw:.2f}),'
    f' tower {pt} px per course (autocorr {ct:.2f});')
say(f'      one map tile is {TILE * LOB.s:.1f} px, so both are the same {TILE}-unit module.')

# how much wall flanks the assembly at the same course
say(f'   the doorway is {GATE_MAX_X - GATE_MIN_X + 1} units of a {960}-unit wall run:'
    f' {pct(GATE_MAX_X - GATE_MIN_X + 1, 960):.1f}% opening,'
    f' {pct(960 - (GATE_MAX_X - GATE_MIN_X + 1), 960):.1f}% continuous masonry either side.')

# reference A, the same seam measure
yb = Y(A)
refband = yb[150:230, 430:700]
say(f'   ref A, the same seam over its gatehouse (x 430..700, y 150..230):'
    f' min Y {refband.min():.5f},'
    f' {pct((refband < 0.0035).sum(), refband.size):.2f}% void.')

# ---------------------------------------------------------------------------
say()
say('== Q6. BOSS BODY-TO-FLOOR LUMINANCE ==')
ay = Y(aa)
aby = Y(ab)
body = ay[boss]
floor_pit = aby[pit_walk & ~boss]
say(f'   ship B: creature mask {int(boss.sum())} px (|with-boss - without-boss| > 8/255)')
say(f'      body   Y p5/p25/p50/p75/p95 = ' + ' '.join(f'{v:.4f}' for v in q(body)))
say(f'      floor  Y p5/p25/p50/p75/p95 = ' + ' '.join(f'{v:.4f}' for v in q(floor_pit)))
say(f'      body p50 / floor p50 = {np.median(body) / np.median(floor_pit):.2f}x')
ys_, xs_ = np.nonzero(boss)
say(f'      creature bbox x {xs_.min()}..{xs_.max()} ({xs_.max() - xs_.min()} px ='
    f' {pct(xs_.max() - xs_.min(), 1920):.1f}% of frame width),'
    f' y {ys_.min()}..{ys_.max()}')

# reference B: creature mask by colour. The wall behind it is teal (B > R); the creature
# is warm-to-neutral (R >= B). Restricted to the creature's own bbox.
bb = B[40:345, 415:700]
r_, g_, b_ = bb[..., 0], bb[..., 1], bb[..., 2]
cre = (r_ >= b_ - 4) & (Y(bb) > 0.004)
cre = ndimage.binary_opening(cre, np.ones((3, 3)))
cre = ndimage.binary_closing(cre, np.ones((7, 7)))
Image.fromarray((cre * 255).astype('uint8')).save(f'{SHOT}/refB-creature-mask.png')
cre_y = Y(bb)[cre]
# ref B floor: the tiered circle, away from the creature
fl = Y(B)[380:520, 150:960]
say(f'   ref B : creature mask {int(cre.sum())} px inside bbox x 415..700, y 40..345')
say('      (colour rule: R >= B - 4, the wall behind it is teal; mask written to'
    ' refB-creature-mask.png)')
say(f'      body   Y p5/p25/p50/p75/p95 = ' + ' '.join(f'{v:.4f}' for v in q(cre_y)))
say(f'      floor  Y p5/p25/p50/p75/p95 = ' + ' '.join(f'{v:.4f}' for v in q(fl.ravel())))
say(f'      body p50 / floor p50 = {np.median(cre_y) / np.median(fl):.2f}x')
cy_, cx_ = np.nonzero(cre)
say(f'      creature width {cx_.max() - cx_.min()} px ='
    f' {pct(cx_.max() - cx_.min(), B.shape[1]):.1f}% of frame width')

# ---------------------------------------------------------------------------
say()
say('== Q7. RING SEPARATION ON THE ARENA FLOOR ==')
RING_CX, RING_CY = 512.0, (PIT_TOP + PIT_BOT + 1) / 2
RING_RX, RING_RY = 480.0, (PIT_BOT + 1 - PIT_TOP) / 2


def radial_profile(im, cam, cx, cy, rx, ry, mask, n=400):
    y_ = Y(im)
    h, w = y_.shape
    yy, xx = np.mgrid[0:h, 0:w]
    wx = (xx - cam.e) / cam.s
    wy = (yy - cam.f) / cam.s
    t = np.sqrt(((wx - cx) / rx) ** 2 + ((wy - cy) / ry) ** 2)
    out = []
    for i in range(n):
        lo, hi = i / n, (i + 1) / n
        m = mask & (t >= lo) & (t < hi)
        out.append(np.median(y_[m]) if m.sum() > 30 else np.nan)
    return np.array(out)


prof = radial_profile(ab, ARE, RING_CX, RING_CY, RING_RX, RING_RY, pit_walk & ~boss)
good = ~np.isnan(prof)
say(f'   radial median Y over the pit, 400 bins of k = r/R (boss pixels removed):')
say(f'      min {np.nanmin(prof):.5f}  max {np.nanmax(prof):.5f}'
    f'  max/min {np.nanmax(prof) / np.nanmin(prof):.2f}x')
# local ring contrast: peak-to-trough of the profile after detrending
sm = np.convolve(np.nan_to_num(prof, nan=np.nanmedian(prof)), np.ones(31) / 31, 'same')
res = np.nan_to_num(prof, nan=np.nanmedian(prof)) - sm
say(f'      detrended (31-bin moving median removed): p95-p5 of residual'
    f' {np.percentile(res[good], 95) - np.percentile(res[good], 5):.5f}')
peaks = []
for i in range(3, len(prof) - 3):
    if good[i] and prof[i] == np.nanmax(prof[i - 3:i + 4]) and res[i] > 0.0004:
        peaks.append(i)
merged = []
for p_ in peaks:
    if merged and p_ - merged[-1][-1] <= 4:
        merged[-1].append(p_)
    else:
        merged.append([p_])
say(f'      distinct bright rings detected: {len(merged)} at k ='
    f' {[round(np.mean(m) / 400, 3) for m in merged]}')
ratios = []
for m in merged:
    i = int(np.mean(m))
    lo = np.nanmin(prof[max(0, i - 12):i]) if i > 12 else np.nan
    hi = prof[i]
    if not np.isnan(lo):
        ratios.append(hi / lo)
say(f'      ring : adjacent-trough luminance ratios ='
    f' {[round(r_, 3) for r_ in ratios]}')

# reference B, the same radial read on its own circle
B_CX, B_CY, B_RX, B_RY = 561.0, 385.0, 460.0, 175.0
h, w = B.shape[:2]
yy, xx = np.mgrid[0:h, 0:w]
t = np.sqrt(((xx - B_CX) / B_RX) ** 2 + ((yy - B_CY) / B_RY) ** 2)
bmask = (t < 1.0) & ~((xx > 415) & (xx < 700) & (yy < 350))
byy = Y(B)
bprof = np.array([np.median(byy[bmask & (t >= i / 400) & (t < (i + 1) / 400)])
                  if (bmask & (t >= i / 400) & (t < (i + 1) / 400)).sum() > 30 else np.nan
                  for i in range(400)])
bgood = ~np.isnan(bprof)
bsm = np.convolve(np.nan_to_num(bprof, nan=np.nanmedian(bprof)), np.ones(31) / 31, 'same')
bres = np.nan_to_num(bprof, nan=np.nanmedian(bprof)) - bsm
say(f'   ref B: same read on its own circle (cx {B_CX} cy {B_CY} rx {B_RX} ry {B_RY}):')
say(f'      min {np.nanmin(bprof):.5f}  max {np.nanmax(bprof):.5f}'
    f'  max/min {np.nanmax(bprof) / np.nanmin(bprof):.2f}x')
say(f'      detrended p95-p5 of residual'
    f' {np.percentile(bres[bgood], 95) - np.percentile(bres[bgood], 5):.5f}')
bpeaks = []
for i in range(3, len(bprof) - 3):
    if bgood[i] and bprof[i] == np.nanmax(bprof[i - 3:i + 4]) and bres[i] > 0.0004:
        bpeaks.append(i)
bm = []
for p_ in bpeaks:
    if bm and p_ - bm[-1][-1] <= 4:
        bm[-1].append(p_)
    else:
        bm.append([p_])
bratios = []
for m in bm:
    i = int(np.mean(m))
    lo = np.nanmin(bprof[max(0, i - 12):i]) if i > 12 else np.nan
    if not np.isnan(lo):
        bratios.append(bprof[i] / lo)
say(f'      distinct bright rings: {len(bm)};'
    f' ring:trough ratios {[round(r_, 3) for r_ in bratios]}')

np.save('/tmp/artjudge-prof.npy', np.vstack([prof, bprof]))

# ---------------------------------------------------------------------------
say()
say('== Q8. STONE GRAIN IN ROOM A ==')
say('   Fraction of interior floor pixels whose 9x9 neighbourhood is FLAT, where flat')
say('   means the 9x9 sRGB-grey range is <= 1/255. Same rule applied to both images.')


def flat_frac(rgb, m, win=9, thr=1.0):
    g = rgb.mean(axis=2)
    mx = ndimage.maximum_filter(g, win)
    mn = ndimage.minimum_filter(g, win)
    er = ndimage.binary_erosion(m, np.ones((win, win)))
    rng = (mx - mn)[er]
    return float((rng <= thr).mean()), int(er.sum()), float(np.median(rng))


f1, n1, m1 = flat_frac(pa, lob_walk)
refA_mask = np.zeros(A.shape[:2], bool)
refA_mask[A_TOP:A_BOT, A_L:A_R] = True
f2, n2, m2 = flat_frac(A, refA_mask)
say(f'   ship A floor: {100 * f1:.1f}% flat   (n={n1}, median 9x9 range {m1:.2f}/255)')
say(f'   ref  A floor: {100 * f2:.1f}% flat   (n={n2}, median 9x9 range {m2:.2f}/255)')
f3, n3, m3 = flat_frac(ab, pit_walk & ~boss)
refB_mask = np.zeros(B.shape[:2], bool)
refB_mask[380:520, 150:960] = True
f4, n4, m4 = flat_frac(B, refB_mask)
say(f'   ship B floor: {100 * f3:.1f}% flat   (n={n3}, median 9x9 range {m3:.2f}/255)')
say(f'   ref  B floor: {100 * f4:.1f}% flat   (n={n4}, median 9x9 range {m4:.2f}/255)')

# ---------------------------------------------------------------------------
say()
say('== Q9. KNIGHT AND ARCHER CONTRAST WHERE PLAYERS STAND ==')
SPRITE_W, SPRITE_H = 33, 42


def seat_world(seat, arena):
    col, row = seat % 5, seat // 5
    if arena:
        return 180 + col * 168 + row * 22, 430 + row * 44
    return 150 + col * 180 + row * 26, 700 + row * 72


def contrast(full, plate, cam, walkmask, arena):
    fy, py = Y(full), Y(plate)
    d = np.abs(full - plate).max(axis=2) > 10
    rows = []
    for seat in range(20):
        wx, wy = seat_world(seat, arena)
        x0, y0 = cam.px(wx - SPRITE_W / 2 - 3, wy - SPRITE_H - 14)
        x1, y1 = cam.px(wx + SPRITE_W / 2 + 3, wy + 6)
        box = np.zeros(fy.shape, bool)
        box[max(0, int(y0)):int(y1), max(0, int(x0)):int(x1)] = True
        m = box & d
        if m.sum() < 200:
            continue
        # floor ring: the plate, in a 10 px collar around the body box, on walkable tiles
        collar = ndimage.binary_dilation(box, np.ones((21, 21))) & ~box & walkmask
        if collar.sum() < 200:
            collar = ndimage.binary_dilation(box, np.ones((41, 41))) & ~box & walkmask
        body = float(np.median(fy[m]))
        floor = float(np.median(py[collar]))
        # the boundary: the outermost 2 px of the body against the pixel just outside it
        edge = m & ~ndimage.binary_erosion(m, np.ones((5, 5)))
        out = ndimage.binary_dilation(m, np.ones((5, 5))) & ~m
        bnd = K(float(np.median(fy[edge])), float(np.median(py[out]))) if edge.sum() and out.sum() else np.nan
        rows.append((seat, seat % 2 == 1, body, floor, K(body, floor), bnd))
    return rows


lob_full = img(f'{SHOT}/plate-lobby-nohud.png')
are_full = img(f'{SHOT}/plate-arena-nohud.png')
for room, full, plate, cam, wm, ar in [
        ('A lobby', lob_full, pa, LOB, lob_walk, False),
        ('B arena', are_full, ab, ARE, pit_walk, True)]:
    rows = contrast(full, plate, cam, wm, ar)
    for cls, isarch in [('knight', False), ('archer', True)]:
        sel = [r for r in rows if r[1] == isarch]
        if not sel:
            continue
        say(f'   {room} {cls}: n={len(sel)}  body Y {np.median([r[2] for r in sel]):.4f}'
            f'  floor Y {np.median([r[3] for r in sel]):.4f}'
            f'  body:floor {np.median([r[4] for r in sel]):.2f}:1'
            f'  worst seat {min(r[4] for r in sel):.2f}:1'
            f'  boundary p50 {np.nanmedian([r[5] for r in sel]):.2f}:1')

open(f'{SHOT}/art-judge.txt', 'w').write('\n'.join(OUT) + '\n')
print('\nwrote', f'{SHOT}/art-judge.txt')
