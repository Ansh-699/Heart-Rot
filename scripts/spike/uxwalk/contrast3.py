#!/usr/bin/env python3
"""Throwaway (task: ux-walk). Knight-vs-local-floor contrast, ONE frame, no plate.

Per knight sprite: the sprite's screen rect is read from the live DOM (`use[href$="-sil"]`
.getBoundingClientRect), the local floor is the MEDIAN colour of an 8 px annulus just
outside that rect, and every pixel inside the rect is scored against it. Single frame, so
no animation phase can contaminate it. WCAG luminance/contrast, same formula as
docs/art/legibility.py.

What to read: p90 is "the brightest tenth of the sprite" — the part a player actually picks
out of the floor. p50 is dragged down by the transparent corners of the rect and is a floor
on the answer, not the answer.
"""
import json, sys, html
import numpy as np
from PIL import Image

def lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def Y(rgb):
    l = lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]

def contrast(a, b):
    hi, lo = np.maximum(a, b), np.minimum(a, b)
    return (hi + 0.05) / (lo + 0.05)

SKIN = {'0': 'Cobalt', '1': 'Nocturne', '2': 'Argent'}
PAD = 8

def run(tag, shot, rects_json):
    A = np.asarray(Image.open(shot).convert('RGB'), float)
    H, W = A.shape[:2]
    rects = [r for r in json.loads(rects_json) if r[4].endswith('-sil')]
    print(tag)
    per = []
    for x, y, w, h, href in rects:
        x0, y0, x1, y1 = x, y, x + w, y + h
        ox0, oy0, ox1, oy1 = max(0, x0-PAD), max(0, y0-PAD), min(W, x1+PAD), min(H, y1+PAD)
        if x1 > W or y1 > H or x0 < 0 or y0 < 0:
            continue
        outer = A[oy0:oy1, ox0:ox1].reshape(-1, 3)
        inner_mask = np.zeros((oy1-oy0, ox1-ox0), bool)
        inner_mask[y0-oy0:y1-oy0, x0-ox0:x1-ox0] = True
        ring = A[oy0:oy1, ox0:ox1][~inner_mask]
        floor = np.median(ring, axis=0)
        yf = Y(floor)
        px = A[y0:y1, x0:x1].reshape(-1, 3)
        # Sprite pixels only: the rect's transparent corners are the floor showing through
        # and would drag every percentile toward 1.00:1.
        on = np.abs(px - floor).max(axis=1) > 12
        if on.sum() < 60:
            continue
        px = px[on]
        c = contrast(Y(px), yf)
        per.append((SKIN.get(href[2], href), np.percentile(c, 50), np.percentile(c, 90),
                    np.percentile(c, 99), c.max(), yf, len(px)))
    by = {}
    for name, p50, p90, p99, mx, yf, n in per:
        by.setdefault(name, []).append((p50, p90, p99, mx, yf))
    print(f'  {len(per)} sprites, {PAD}px annulus as the local floor')
    for name in sorted(by):
        v = np.array([r[:4] for r in by[name]], float)
        fl = np.array([r[4] for r in by[name]], float)
        print(f'  {name:<9} n={len(v):2d}  p50 {v[:,0].mean():.2f}:1  p90 {v[:,1].mean():.2f}:1  '
              f'p99 {v[:,2].mean():.2f}:1  peak {v[:,3].mean():.2f}:1   local floor Y={fl.mean():.4f}')
    v = np.array([r[1:5] for r in per], float)
    print(f'  ACROSS ALL SPRITES, median sprite pixel: min {v[:,0].min():.2f}:1  median {np.median(v[:,0]):.2f}:1  max {v[:,0].max():.2f}:1')
    print(f'  ACROSS ALL SPRITES, p90 sprite pixel:    min {v[:,1].min():.2f}:1  median {np.median(v[:,1]):.2f}:1  max {v[:,1].max():.2f}:1')
    print(f'  ACROSS ALL SPRITES, peak pixel:          min {v[:,3].min():.2f}:1  median {np.median(v[:,3]):.2f}:1  max {v[:,3].max():.2f}:1')
    print(f'  sprites whose MEDIAN pixel is under 3.0:1 -> {(v[:,0]<3).sum()} of {len(v)}')
    print(f'  sprites whose p90    pixel is under 3.0:1 -> {(v[:,1]<3).sum()} of {len(v)}')

if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2], html.unescape(open(sys.argv[3]).read()))
