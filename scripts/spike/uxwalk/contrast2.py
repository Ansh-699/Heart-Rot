#!/usr/bin/env python3
"""Throwaway (task: ux-walk). Knight-vs-floor contrast off the SHIPPED renderer's pixels.

Two frames of the same scene at the same virtual time, one with 20 seats and one with 0.
Inside each knight sprite's own screen rect (read from the live DOM, not derived), a
"knight pixel" is one that differs from the seat-free plate; the floor colour under it is
the same pixel of that plate. WCAG luminance/contrast exactly as docs/art/legibility.py.
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

def run(tag, shot, plate, rects_json):
    A = np.asarray(Image.open(shot).convert('RGB'), float)
    B = np.asarray(Image.open(plate).convert('RGB'), float)
    rects = [r for r in json.loads(rects_json) if r[4].endswith('-sil')]
    # animation-noise floor: how much do the two frames differ where no knight is?
    covered = np.zeros(A.shape[:2], bool)
    for x, y, w, h, _ in rects:
        covered[max(0,y-6):y+h+6, max(0,x-6):x+w+6] = True
    noise = np.abs(A - B).max(axis=2)[~covered]
    print(f'{tag}')
    print(f'  frame noise off the sprites: p99 {np.percentile(noise,99):.0f}/255, max {noise.max():.0f}/255')
    rows = []
    allc = []
    for x, y, w, h, href in rects:
        a = A[y:y+h, x:x+w]; b = B[y:y+h, x:x+w]
        m = np.abs(a - b).max(axis=2) > 24
        if m.sum() < 50:
            continue
        c = contrast(Y(a[m]), Y(b[m]))
        allc.append(c)
        rows.append((SKIN.get(href[2], href), m.sum(), np.percentile(c, 50), np.percentile(c, 90), c.max()))
    print(f'  {len(rows)} sprites measured')
    by = {}
    for name, n, med, p90, mx in rows:
        by.setdefault(name, []).append((med, p90, mx))
    for name in sorted(by):
        v = np.array(by[name])
        print(f'  {name:<9} n={len(v):2d}  median-pixel {v[:,0].mean():.2f}:1   p90-pixel {v[:,1].mean():.2f}:1   brightest {v[:,2].mean():.2f}:1')
    c = np.concatenate(allc)
    print(f'  ALL knight pixels: p50 {np.percentile(c,50):.2f}:1  p90 {np.percentile(c,90):.2f}:1  p99 {np.percentile(c,99):.2f}:1  max {c.max():.2f}:1')
    print(f'  share of knight pixels under 3.0:1 {100*(c<3).mean():.1f}%   under 4.5:1 {100*(c<4.5).mean():.1f}%')
    # The read that matters: the BRIGHTEST 10% of each sprite is what a player picks out.
    tops = np.array([np.percentile(cc, 90) for cc in allc])
    print(f'  per-sprite p90 pixel contrast: min {tops.min():.2f}:1  median {np.median(tops):.2f}:1  max {tops.max():.2f}:1')

if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2], sys.argv[3], html.unescape(open(sys.argv[4]).read()))
