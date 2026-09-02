"""Throwaway (spec task: bundle): re-emit px2svg output with RELATIVE subpath starts.

Every subpath in temple.svg / parts/boss.svg is `M<abs x> <abs y>h..v..h..z`. The absolute
form spends 4-7 digits per rect and defeats the compressor's match finder; the relative form
(`m<dx> <dy>...`) spends 1-3 and repeats. Same element count, same fills, same `<g id="part-*">`
nesting, same rendered pixels - so Scene.tsx's 16-path regex and Boss.tsx's part groups are
untouched. Output goes to a temp dir; this is a measurement, not a generator.
"""
import re, sys, os, subprocess, zlib

SUB = re.compile(r'M(-?\d+) (-?\d+)((?:[hv]-?\d+)+)z')

def relativise(d):
    px = py = 0
    out = []
    for m in SUB.finditer(d):
        x, y, ops = int(m.group(1)), int(m.group(2)), m.group(3)
        out.append(f'm{x - px} {y - py}{ops}z')
        px, py = x, y
    return ''.join(out)

def convert(src):
    return re.sub(r'(<path fill="#[0-9a-fA-F]{6}" d=")([^"]*)(")',
                  lambda m: m.group(1) + relativise(m.group(2)) + m.group(3), src)

def br(b):
    return len(subprocess.run(['brotli', '-q', '11', '-c'], input=b, capture_output=True).stdout)


PATH = re.compile(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"')
ANY = re.compile(r'([Mm])(-?\d+) (-?\d+)((?:[hv]-?\d+)+)z')
VB = re.compile(r'viewBox="0 0 (\d+) (\d+)"')


def paint(src):
    """Expand either form onto a bitmap. The check, not decoration: a byte saving that
    moves a pixel is not a saving, and nothing else in this file would notice."""
    from PIL import Image
    w, h = map(int, VB.search(src).groups())
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    px = img.load()
    for fill, d in PATH.findall(src):
        c = (int(fill[1:3], 16), int(fill[3:5], 16), int(fill[5:7], 16), 255)
        cx = cy = 0
        for m in ANY.finditer(d):
            x, y = int(m.group(2)), int(m.group(3))
            cx, cy = (x, y) if m.group(1) == 'M' else (cx + x, cy + y)
            ops = re.findall(r'([hv])(-?\d+)', m.group(4))
            rw = next((int(v) for k, v in ops if k == 'h' and int(v) > 0), 1)
            rh = next((int(v) for k, v in ops if k == 'v' and int(v) > 0), 1)
            for yy in range(cy, cy + rh):
                for xx in range(cx, cx + rw):
                    if 0 <= xx < w and 0 <= yy < h:
                        px[xx, yy] = c
    return img

if __name__ == '__main__':
    outdir = sys.argv[1] if len(sys.argv) > 1 else '/tmp/art-rel'
    os.makedirs(outdir + '/parts', exist_ok=True)
    for rel in ('temple.svg', 'knights.svg', 'parts/boss.svg'):
        src = open('assets/sprites/' + rel).read()
        new = convert(src)
        assert src.count('<path ') == new.count('<path '), rel
        assert src.count('<g id="part-') == new.count('<g id="part-'), rel
        open(outdir + '/' + rel, 'w').write(new)
        from PIL import ImageChops
        assert ImageChops.difference(paint(src), paint(new)).getbbox() is None, \
            f'{rel}: relative re-encode changed a pixel'
        a, b = src.encode(), new.encode()
        print(f'{rel:16s} raw {len(a):7d} -> {len(b):7d}   gzip {len(zlib.compress(a,9)):6d} -> {len(zlib.compress(b,9)):6d}'
              f'   brotli {br(a):6d} -> {br(b):6d}   pixel-identical')
