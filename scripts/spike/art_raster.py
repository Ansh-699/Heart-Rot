"""Throwaway (spec task: bundle): what the sprite art weighs if it stops being SVG.

Both assets are px2svg output — one <path> per palette colour, every subpath an axis-aligned
rect. Expanding them back to a bitmap is lossless, so the PNG numbers below are the exact
alternative encoding of the same pixels, not an approximation.
"""
import re, sys, zlib, subprocess, os
from PIL import Image

RECT = re.compile(r'M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\d+z')
PATH = re.compile(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"')
GROUP = re.compile(r'<g id="part-([a-z0-9_]+)">(.*?)</g>', re.S)
VB = re.compile(r'viewBox="0 0 (\d+) (\d+)"')

def rects(d):
    for m in re.finditer(r'M(-?\d+) (-?\d+)((?:h-?\d+|v-?\d+)+)z', d):
        x, y = int(m.group(1)), int(m.group(2))
        ops = re.findall(r'([hv])(-?\d+)', m.group(3))
        w = next((int(v) for k, v in ops if k == 'h' and int(v) > 0), 1)
        h = next((int(v) for k, v in ops if k == 'v' and int(v) > 0), 1)
        yield x, y, w, h

def paint(src, w, h):
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    px = img.load()
    n = 0
    for fill, d in PATH.findall(src):
        c = (int(fill[1:3], 16), int(fill[3:5], 16), int(fill[5:7], 16), 255)
        for x, y, rw, rh in rects(d):
            n += rw * rh
            for yy in range(y, y + rh):
                for xx in range(x, x + rw):
                    if 0 <= xx < w and 0 <= yy < h:
                        px[xx, yy] = c
    return img, n

def emit(name, img):
    p = f'/tmp/art-{name}.png'
    img.save(p, optimize=True)
    a = os.path.getsize(p)
    # palette form
    q = img.convert('RGB').quantize(colors=256, method=Image.MEDIANCUT) if img.mode == 'RGBA' and img.getextrema()[3][0] == 255 else None
    b = None
    if q is not None:
        q.save(p + '.p8.png', optimize=True); b = os.path.getsize(p + '.p8.png')
    # webp lossless
    img.save(p + '.webp', lossless=True, quality=100, method=6)
    c = os.path.getsize(p + '.webp')
    print(f'{name:14s} {img.size[0]}x{img.size[1]}  png={a:7d}  png8={b if b else "-":>7}  webp={c:7d}')
    return a, b, c

for label, f in [('temple', 'assets/sprites/temple.svg'), ('boss(flat)', 'assets/sprites/parts/boss.svg')]:
    src = open(f).read()
    w, h = map(int, VB.search(src).groups())
    img, n = paint(src, w, h)
    print(f'{label}: svg={os.path.getsize(f)}B painted_px={n} canvas={w*h}')
    emit(label, img)

# boss, rigged: one PNG per part group (the rig needs them separable)
src = open('assets/sprites/parts/boss.svg').read()
w, h = map(int, VB.search(src).groups())
tot = 0
for name, body in GROUP.findall(src):
    img, _ = paint(body, w, h)
    bb = img.getbbox()
    if bb is None: continue
    a, b, c = emit('part-' + name, img.crop(bb))
    tot += a
print(f'boss rig, 13 cropped PNGs total = {tot} B')
