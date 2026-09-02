#!/usr/bin/env python3
"""Pixel art raster -> exact SVG.

Pipeline: coarse-quantize at full res -> MODE downsample (majority real colour
per block, never an invented average) -> frequency-weighted palette merge
(collapses JPEG-noise variants onto the real art colour) -> despeckle ->
run-merge to rects -> emit ONE <path> per colour.

Subpaths are emitted RELATIVE (`m<dx> <dy>h..v..h..z`). The source rasters for the
checked-in art are gone, so `--reencode` re-emits an existing px2svg SVG through the
same encoder and proves it pixel-identical. It is idempotent, so `--check` is the
regression guard: run it on the committed art and a broken encoder reports itself.

    python3 tools/px2svg.py --reencode assets/sprites/temple.svg assets/sprites/parts/boss.svg
    python3 tools/px2svg.py --reencode --check assets/sprites/temple.svg assets/sprites/parts/boss.svg

`assets/sprites/knights.svg` is deliberately NOT in that list: it is read back by
`svg_slice.parse`, whose `_RECT` matches `M` only, so converting it breaks
`tools/gen_knights.py` -- and it is imported by no client code, so converting it
would buy zero shipped bytes. Add it here once that regex reads either form.
"""
import argparse, collections, os, re, zlib
import numpy as np
from PIL import Image, ImageChops

def intra_block_std(arr, s):
    h, w, _ = arr.shape
    nh, nw = h // s, w // s
    if nh < 2 or nw < 2: return 1e9
    a = arr[:nh*s, :nw*s].astype(np.float32).reshape(nh, s, nw, s, 3)
    return float(a.transpose(0, 2, 1, 3, 4).reshape(nh, nw, s*s, 3).std(axis=2).mean())

def detect_scale(arr, maxs=32):
    # ponytail: hint only. Lossy sources inflate variance at the TRUE scale
    # (JPEG ringing sits exactly on native-pixel edges), so a 12x upscale can
    # read as 2x and a heavily-compressed 2x can read as 1x. Verify by eye and
    # pass -s for production assets.
    g = float(arr.astype(np.float32).std()) + 1e-9
    best = 1
    for s in range(2, maxs + 1):
        if arr.shape[0] // s < 8 or arr.shape[1] // s < 8: break
        if intra_block_std(arr, s) / g < 0.12: best = s
    return best

def augment_palette(im, q, pal, extra=6, thresh=45.0, min_px=64):
    """Median-cut allocates boxes by population, so a colour covering a few
    hundred pixels out of millions gets no entry at any `coarse` value -- that
    is how the creature's eye highlights vanished. Find the pixels the first
    pass represented badly and quantize *those* on their own, then splice the
    result in."""
    arr = np.array(im).reshape(-1, 3).astype(np.float32)
    idx = np.array(q).ravel()
    palf = np.array(pal, np.float32)
    far = np.sqrt(((arr - palf[idx]) ** 2).sum(1)) > thresh
    if far.sum() < min_px: return idx.reshape(np.array(q).shape), pal
    cand = arr[far].astype(np.uint8)
    n = min(extra, max(1, len(cand) // min_px))
    sub = Image.fromarray(cand.reshape(-1, 1, 3)).quantize(
        colors=n, method=Image.Quantize.MEDIANCUT, dither=0)
    sp = sub.getpalette()
    new = [tuple(sp[i*3:i*3+3]) for i in range(n)]
    pal2 = list(pal) + new
    p2 = np.array(pal2, np.float32)
    idx[far] = np.argmin(((arr[far][:, None, :] - p2[None, :, :]) ** 2).sum(2), axis=1)
    return idx.reshape(np.array(q).shape), pal2

def mode_downsample(idx, s, k):
    """One native pixel per block = the MAJORITY colour of the block interior.
    Median averages channels independently and can emit a colour present in no
    pixel at all; those invented in-between shades are what read as blur."""
    if s == 1: return idx
    h, w = idx.shape
    nh, nw = h // s, w // s
    b = idx[:nh*s, :nw*s].reshape(nh, s, nw, s).transpose(0, 2, 1, 3)
    m = s // 4
    if s - 2*m >= 1: b = b[:, :, m:s-m, m:s-m]
    flat = b.reshape(nh*nw, -1)
    n = flat.shape[0]
    offs = (np.arange(n)[:, None] * k + flat).ravel()
    return np.bincount(offs, minlength=n*k).reshape(n, k).argmax(1).reshape(nh, nw)

def merge_palette(idx, pal, target, dist):
    """Greedy, frequency-weighted. Real art colours cover large flat areas;
    compression artefacts are rare and sit near a real colour. Seed clusters
    from the most frequent colours and absorb everything within `dist`."""
    counts = np.bincount(idx.ravel(), minlength=len(pal))
    pal_f = np.array(pal, np.float32)
    remap = np.full(len(pal), -1)
    seeds = []
    # Force-seed the luminance extremes before ranking by frequency. In pixel
    # art the brightest and darkest colours are deliberate (eye highlights,
    # outlines) but cover almost no pixels, so pure frequency ranking absorbs
    # them -- that is how the creature lost its white eyes.
    lum = pal_f @ np.array([0.299, 0.587, 0.114], np.float32)
    live = np.where(counts >= 4)[0]
    if len(live):
        for c in ({int(live[np.argmax(lum[live])]), int(live[np.argmin(lum[live])])}):
            seeds.append(c); remap[c] = c
    order = np.argsort(-counts)
    for c in order:
        if counts[c] == 0 or remap[c] != -1: continue
        if len(seeds) < target:
            seeds.append(c); remap[c] = c
            d = np.sqrt(((pal_f - pal_f[c])**2).sum(1))
            for o in np.where((d < dist) & (remap == -1))[0]:
                if counts[o] < counts[c]: remap[o] = c
    unresolved = np.where((remap == -1) & (counts > 0))[0]
    if len(seeds) and len(unresolved):
        sp = pal_f[seeds]
        for o in unresolved:
            remap[o] = seeds[int(np.argmin(((sp - pal_f[o])**2).sum(1)))]
    remap[remap == -1] = 0
    return remap[idx], sorted(set(remap[counts > 0].tolist()))

def despeckle(idx, passes=2):
    """Drop lone pixels that disagree with every orthogonal neighbour."""
    for _ in range(passes):
        p = np.pad(idx, 1, mode='edge')
        up, dn, lf, rt = p[:-2,1:-1], p[2:,1:-1], p[1:-1,:-2], p[1:-1,2:]
        lone = (up != idx) & (dn != idx) & (lf != idx) & (rt != idx)
        agree = (up == dn) & (up == lf) & (up == rt)
        idx = np.where(lone & agree, up, idx)
    return idx

def merge_rects(idx, bg):
    h, w = idx.shape
    out, prev = [], {}
    for y in range(h):
        cur, x = {}, 0
        while x < w:
            c = int(idx[y, x])
            if c == bg: x += 1; continue
            r = 1
            while x + r < w and idx[y, x + r] == c: r += 1
            key = (x, r, c)
            if key in prev:
                out[prev[key]][3] += 1; cur[key] = prev[key]
            else:
                out.append([x, y, r, 1, c]); cur[key] = len(out) - 1
            x += r
        prev = cur
    return out

# The one subpath grammar this tool writes and reads: an axis-aligned rect as a
# closed h/v/h path. `M` is the old absolute form, still readable so `--reencode`
# can convert it; `m` is what is emitted.
_SUB = re.compile(r'([Mm])(-?\d+) (-?\d+)h(\d+)v(\d+)h-\4z')
_PATH = re.compile(r'(<path fill="(#[0-9a-fA-F]{6})" d=")([^"]*)(")')
_VIEWBOX = re.compile(r'viewBox="0 0 (\d+) (\d+)"')


def path_d(items):
    """The subpaths of one <path>, each RELATIVE to the previous subpath's start.

    `z` returns the pen to where the subpath began, so every `m` is a delta between
    two rect origins: 1-3 digits that repeat across the file, instead of 4-7
    absolute ones that never do. Same rects, same pixels, same element count --
    measured -34% brotli on the checked-in art (docs/review/bundle.md, option 1).
    """
    out, px, py = [], 0, 0
    for x, y, rw, rh in items:
        out.append(f'm{x - px} {y - py}h{rw}v{rh}h-{rw}z')
        px, py = x, y
    return ''.join(out)


def parse_d(d):
    """Inverse of `path_d`, absolute or relative -> [(x, y, w, h)].

    Raises on anything else rather than reinterpreting it: this reads exactly what
    `path_d` writes, and a file it cannot read is a bug to hear about loudly.
    """
    out, px, py, n = [], 0, 0, 0
    for m in _SUB.finditer(d):
        x, y = int(m.group(2)), int(m.group(3))
        if m.group(1) == 'm': x, y = px + x, py + y
        out.append((x, y, int(m.group(4)), int(m.group(5))))
        px, py = x, y
        n += m.end() - m.start()
    if n != len(d):
        raise SystemExit('d= holds commands this tool cannot read')
    return out


def paint(src):
    """Expand a whole px2svg file back onto an RGBA bitmap, in document order."""
    w, h = (int(v) for v in _VIEWBOX.search(src).groups())
    a = np.zeros((h, w, 4), np.uint8)
    for _, fill, d, _ in _PATH.findall(src):
        c = [int(fill[i:i + 2], 16) for i in (1, 3, 5)] + [255]
        for x, y, rw, rh in parse_d(d):
            a[y:y + rh, x:x + rw] = c
    return Image.fromarray(a, 'RGBA')


def reencode(path, check=False):
    """Rewrite an existing px2svg SVG through `path_d`, only if it stays identical.

    The rasters these assets were converted from are not in the tree, so this is how
    they are regenerated from the tool instead of hand-edited. It is idempotent, so
    `--check` doubles as the guard: run it on the committed art and a broken encoder
    reports itself.
    """
    src = open(path).read()
    new = _PATH.sub(lambda m: m.group(1) + path_d(parse_d(m.group(3))) + m.group(4), src)
    for tag in ('<path ', '<g id="part-'):
        if src.count(tag) != new.count(tag):
            raise SystemExit(f'{path}: `{tag}` count changed')
    if ImageChops.difference(paint(src), paint(new)).getbbox() is not None:
        raise SystemExit(f'{path}: re-encode moved a pixel')
    if check and new != src:
        raise SystemExit(f'{path}: not the encoder\'s output; re-run without --check')
    if new != src:
        open(path, 'w').write(new)
    gz = lambda s: len(zlib.compress(s.encode(), 9))
    print(f'{os.path.basename(path):16s} {len(src):7d} -> {len(new):7d} B   '
          f'gzip {gz(src):6d} -> {gz(new):6d}   '
          f'{"unchanged" if new == src else "rewritten"}, pixel-identical')


def to_svg(rects, pal, w, h, zoom=4):
    """One <path> per colour. 8.6k <rect> nodes becomes ~15 nodes and a third
    of the bytes, and the browser composites each colour as a single fill."""
    by = collections.defaultdict(list)
    for x, y, rw, rh, c in rects: by[c].append((x, y, rw, rh))
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
         f'width="{w*zoom}" height="{h*zoom}" shape-rendering="crispEdges" '
         f'image-rendering="pixelated">']
    for c, items in sorted(by.items(), key=lambda kv: -len(kv[1])):
        r, g, b = pal[c]
        p.append(f'<path fill="#{r:02x}{g:02x}{b:02x}" d="{path_d(items)}"/>')
    p.append('</svg>')
    return ''.join(p)

def convert(src, dst, colours=16, strip_bg=False, scale=None, coarse=64,
            dist=26, label='', zoom=4):
    im = Image.open(src).convert('RGB')
    arr = np.array(im)
    s = scale or detect_scale(arr)

    q = im.quantize(colors=coarse, method=Image.Quantize.MEDIANCUT, dither=0)
    pf = q.getpalette()
    pal = [tuple(pf[i*3:i*3+3]) for i in range(coarse)]
    full, pal = augment_palette(im, q, pal)
    idx = mode_downsample(full, s, len(pal))
    idx, keep = merge_palette(idx, pal, colours, dist)
    idx = despeckle(idx)

    bg = None
    if strip_bg:
        corners = [idx[0,0], idx[0,-1], idx[-1,0], idx[-1,-1]]
        bg = int(collections.Counter(map(int, corners)).most_common(1)[0][0])

    rects = merge_rects(idx, bg)
    nh, nw = idx.shape
    svg = to_svg(rects, pal, nw, nh, zoom)
    open(dst, 'w').write(svg)
    used = len({r[4] for r in rects})
    print(f"{label:<10} {im.size[0]}x{im.size[1]} @{s}x -> {nw}x{nh}  "
          f"{used:3d} col  {len(rects):6d} rects  {used:3d} nodes  {len(svg)//1024:4d} KB")
    return dict(w=nw, h=nh, scale=s, colours=used, rects=len(rects), kb=len(svg)//1024)

if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('files', nargs='*', metavar='src dst | SVG...')
    a.add_argument('--reencode', action='store_true',
                   help='re-emit existing px2svg SVGs through the current encoder')
    a.add_argument('--check', action='store_true',
                   help='with --reencode: write nothing, exit 1 on drift')
    a.add_argument('-c','--colours',type=int,default=16)
    a.add_argument('-b','--strip-bg',action='store_true')
    a.add_argument('-s','--scale',type=int,default=None)
    a.add_argument('-d','--dist',type=float,default=26)
    a.add_argument('--coarse',type=int,default=64)
    a.add_argument('-l','--label',default='')
    n = a.parse_args()
    if n.reencode:
        for f in n.files: reencode(f, n.check)
    elif len(n.files) == 2:
        convert(*n.files,n.colours,n.strip_bg,n.scale,n.coarse,n.dist,n.label or 'out')
    else:
        a.error('need src and dst, or --reencode with one or more SVGs')
