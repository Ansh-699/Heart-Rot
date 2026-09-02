#!/usr/bin/env python3
"""Throwaway (task: ux-walk). Re-measures knight-vs-floor contrast off the SHIPPED
renderer's real pixels.

Method = docs/art/legibility.py's: WCAG relative luminance, sRGB->linear with
0.2126/0.7152/0.0722, contrast (hi+.05)/(lo+.05).

The knight mask is a DIFF of two frames of the same scene, one with 20 seats and one with
0, so a "knight pixel" is a pixel the knight actually painted and the floor colour under it
is the same pixel from the seat-free plate. No source colour is re-derived.
"""
import sys
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

def run(tag, with_knights, floor_plate):
    A = np.asarray(Image.open(with_knights).convert('RGB'), float)
    B = np.asarray(Image.open(floor_plate).convert('RGB'), float)
    diff = np.abs(A - B).max(axis=2)
    mask = diff > 6                      # a pixel the knight layer actually painted
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        print(f'{tag}: no knight pixels found'); return
    ya, yb = Y(A[mask]), Y(B[mask])
    c = contrast(ya, yb)
    # Per-sprite: cluster by connected columns is overkill; label by the 20 seed points
    print(f'{tag}: {mask.sum()} knight pixels over {len(np.unique(xs))} columns')
    print(f'  contrast knight-pixel vs the floor pixel it covers:')
    for q in (1, 5, 25, 50, 75, 95, 99):
        print(f'    p{q:<3} {np.percentile(c, q):.2f}:1')
    print(f'    min {c.min():.2f}:1   max {c.max():.2f}:1   mean {c.mean():.2f}:1')
    for thr in (3.0, 4.5):
        print(f'    share of knight pixels under {thr}:1 -> {100*(c<thr).mean():.1f}%')
    # Per-sprite worst/median, by splitting the mask into 8-connected blobs.
    return

if __name__ == '__main__':
    run('ARENA (pit floor)', '/tmp/uxshots/arena-1920-hud.png', '/tmp/uxshots/arena-floor-hud.png')
    print()
    run('LOBBY (waiting room floor)', '/tmp/uxshots/lobby-1920-hud.png', '/tmp/uxshots/lobby-floor-hud.png')
