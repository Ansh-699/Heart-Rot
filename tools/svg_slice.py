#!/usr/bin/env python3
"""Boss sprite -> per-part <g> rig + on-chain hitboxes, from ONE pass.

px2svg.py emits one <path> per COLOUR covering the whole creature, which is the
right shape for drawing and useless for animating: the rig needs one <g> per body
PART. So this partitions by REGION instead. Rasterise the source back to a pixel
grid, hand every painted pixel to the first part region that contains it, then
run the same run-merge px2svg uses over each part's mask.

Both outputs fall out of that one partition -- the <g> the browser animates and
the rectangle the program raycasts against are literally the same pixels -- which
is the whole reason this is one build step and not two. A hand-maintained hitbox
list drifts from the art the first time someone nudges a horn.
"""
import argparse, collections, json, os, re
import numpy as np

from px2svg import merge_rects

# The four olive greens. They are used by the thorn sprays, the mace ball and the
# crown's ornamental bosses, and by nothing else in the sprite -- verified by
# plotting them alone. That exclusivity is what lets a thorn part be defined as
# "olive pixels inside this box" rather than "everything inside this box": the
# thorns grow out of flesh, so a plain rectangle around one takes a slab of
# shoulder with it and the detach animation tears a hole in the boss.
THORN = ("#69623e", "#5e5430", "#36371c", "#8a7559")

# Ordered, first match wins. `rects` are (x, y, w, h) in sprite pixels and a part
# may take several, because a thorn spray is a diagonal and one box round it
# would swallow the head behind it. `colours` narrows a part to those fills
# within its rects; with no rects it means the whole canvas. The LAST entry has
# neither, which makes it the catch-all -- every painted pixel nobody claimed
# lands there, and that is what makes the partition lossless by construction
# rather than by luck.
#
# `index` is the on-chain part index: it must stay aligned with Boss.parts[9] in
# programs/heartrot/src/state.rs (crown, wolf_l, beast_r, thorn0..3, mace, claws).
# `index: None` is a rig-only group -- animated, not shot at -- except `core`,
# which is shot at but lives in Boss.core_hp rather than in the parts array.
#
# `z` is paint order, back to front, and is NOT the claim order above: claiming
# runs most-specific-first and ends at a catch-all, while stacking has to put the
# torso behind the arms that swing across it. At rest the two agree because the
# source rects never overlap; the moment the rig moves a part they stop agreeing,
# and stacking is what you see.
PARTS = [
    # The scene floor is baked into boss.svg. It is one colour used nowhere else,
    # so match it by colour alone: any rectangle for it would have to cross the
    # legs, which are drawn over it.
    dict(name="ground", z=0, index=None, colours=("#2c3436",), rects=[]),

    # Thorns first, and colour-restricted, so each one is exactly the spray and
    # the limb behind it keeps its silhouette. The boxes stay clear of the crown
    # ornaments at x 132..175 so those stay with the skull.
    dict(name="thorn0", z=1, index=3, colours=THORN, rects=[(92, 22, 28, 42)]),
    dict(name="thorn1", z=2, index=4, colours=THORN, rects=[(176, 30, 54, 40),
                                                            (206, 60, 24, 42)]),
    dict(name="thorn2", z=11, index=5, colours=THORN, rects=[(82, 94, 28, 32)]),
    dict(name="thorn3", z=12, index=6, colours=THORN, rects=[(198, 120, 32, 30)]),

    dict(name="crown",  z=3, index=0, rects=[(120, 0, 76, 50), (132, 45, 44, 21)]),

    dict(name="wolf_l",  z=4, index=1, rects=[(58, 43, 60, 59)]),
    dict(name="beast_r", z=5, index=2, rects=[(172, 43, 46, 61)]),

    # Left arm, its outward spike, then the mace ball. Claimed before `legs` so
    # the ball is not filed as a foot.
    dict(name="mace",  z=9, index=7, rects=[(76, 95, 36, 61), (36, 135, 44, 19),
                                            (0, 150, 104, 90)]),
    # Bottom edge stops at y 206 so the clawed right foot below it falls to legs.
    dict(name="claws", z=10, index=8, rects=[(170, 97, 60, 110)]),

    dict(name="core", z=7, index=None, rects=[(120, 95, 40, 45)]),
    dict(name="legs", z=8, index=None, rects=[(90, 147, 130, 123)]),

    # Catch-all. The shoulders, the fused mass between the heads, everything the
    # boxes above left over.
    dict(name="torso", z=6, index=None, rects=[]),
]

N_CHAIN_PARTS = 9

# The one grammar px2svg emits: an axis-aligned rect as a closed h/v/h path.
_RECT = re.compile(r'M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\3z')
_PATH = re.compile(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"\s*/>')
_SVG = re.compile(r'<svg[^>]*>')
_VIEWBOX = re.compile(r'viewBox="0 0 (\d+) (\d+)"')


def parse(src):
    """-> (opening <svg> tag, w, h, [(x, y, w, h, '#rrggbb')]).

    Deliberately a regex and not an XML parser: this reads exactly what px2svg
    writes, and anything else in the file is a bug we want to hear about loudly
    rather than silently reinterpret.
    """
    s = open(src).read()
    head = _SVG.search(s).group(0)
    w, h = (int(v) for v in _VIEWBOX.search(head).groups())
    out = []
    for colour, d in _PATH.findall(s):
        n = 0
        for m in _RECT.finditer(d):
            x, y, rw, rh = (int(v) for v in m.groups())
            out.append((x, y, rw, rh, colour.lower()))
            n += m.end() - m.start()
        if n != len(d):
            raise SystemExit(f"{src}: path d= holds commands this tool cannot read")
    return head, w, h, out


def rasterize(rects, w, h):
    """-> (idx grid, palette). -1 means transparent.

    px2svg guarantees the rects are disjoint (one run per colour per row, merged
    downward), so painting them in order is order-independent; assert it, because
    an overlap here would make the "zero differing pixels" check meaningless.
    """
    pal = sorted({r[4] for r in rects})
    at = {c: i for i, c in enumerate(pal)}
    idx = np.full((h, w), -1, np.int16)
    for x, y, rw, rh, c in rects:
        if (idx[y:y+rh, x:x+rw] >= 0).any():
            raise SystemExit("source rects overlap; the partition would be ambiguous")
        idx[y:y+rh, x:x+rw] = at[c]
    return idx, pal


def partition(idx, pal):
    """-> owner grid, one PARTS index per painted pixel, -1 where transparent."""
    own = np.full(idx.shape, -1, np.int16)
    painted = idx >= 0
    for i, part in enumerate(PARTS):
        if part["rects"]:
            hit = np.zeros(idx.shape, bool)
            for x, y, rw, rh in part["rects"]:
                hit[y:y+rh, x:x+rw] = True
        else:
            hit = np.ones(idx.shape, bool)  # whole canvas; the catch-all lands here
        if part.get("colours"):
            missing = [c for c in part["colours"] if c not in pal]
            if missing:
                raise SystemExit(f"part {part['name']} wants {missing}, absent from "
                                 f"the source -- re-run px2svg and re-read the palette")
            hit &= np.isin(idx, [pal.index(c) for c in part["colours"]])
        own = np.where((own < 0) & painted & hit, i, own)
    unclaimed = int((painted & (own < 0)).sum())
    if unclaimed:
        raise SystemExit(f"{unclaimed} painted pixels claimed by no part -- the "
                         f"last PARTS entry must be a catch-all")
    return own


def emit_group(name, part_rects):
    """One <g> holding one <path> per colour, exactly as px2svg lays a path out."""
    by = collections.defaultdict(list)
    for x, y, rw, rh, c in part_rects:
        by[c].append((x, y, rw, rh))
    paths = ''.join(
        '<path fill="%s" d="%s"/>' % (
            c, ''.join(f'M{x} {y}h{rw}v{rh}h-{rw}z' for x, y, rw, rh in items))
        for c, items in sorted(by.items(), key=lambda kv: -len(kv[1])))
    return f'<g id="part-{name}">{paths}</g>'


def slice_sprite(src, out_svg, out_json):
    head, w, h, src_rects = parse(src)
    idx, pal = rasterize(src_rects, w, h)
    own = partition(idx, pal)

    groups, boxes = [], {}
    for i, part in enumerate(PARTS):
        mask = own == i
        if not mask.any():
            raise SystemExit(f"part {part['name']} owns no pixels; its rects miss the art")
        runs = [(x, y, rw, rh, pal[c])
                for x, y, rw, rh, c in merge_rects(np.where(mask, idx, -1), -1)]
        groups.append((part["z"], emit_group(part["name"], runs)))
        ys, xs = np.where(mask)
        # The hitbox is the tight bounding box of the pixels the part actually
        # owns, NOT the rectangle above. The rects are a partition tool and are
        # deliberately loose; a raycast against a loose box registers hits on
        # empty air next to the horn.
        boxes[part["name"]] = dict(
            index=part["index"],
            x=int(xs.min()), y=int(ys.min()),
            w=int(xs.max() - xs.min() + 1), h=int(ys.max() - ys.min() + 1),
            pixels=int(mask.sum()))

    os.makedirs(os.path.dirname(out_svg), exist_ok=True)
    open(out_svg, 'w').write(head + ''.join(g for _, g in sorted(groups)) + '</svg>')

    chain = [None] * N_CHAIN_PARTS
    for name, b in boxes.items():
        if b["index"] is not None:
            chain[b["index"]] = name
    if None in chain:
        raise SystemExit(f"on-chain part index {chain.index(None)} has no part")
    open(out_json, 'w').write(json.dumps(dict(
        source=os.path.basename(src), sprite=dict(w=w, h=h),
        # Index-aligned with Boss.parts[9] on chain. `core` is shot at too but
        # lives in Boss.core_hp, so it is in `hitboxes` without an index.
        part_index=chain, hitboxes=boxes), indent=1) + '\n')

    return verify(src, out_svg, w, h, idx, pal), boxes


def verify(src, out_svg, w, h, idx, pal):
    """Re-read what we just wrote, rasterise it, count differing pixels.

    Round-trips the file on disk rather than the in-memory groups, so a bug in
    the emitter is caught as well as a bug in the partition.
    """
    _, w2, h2, rects = parse(out_svg)
    if (w2, h2) != (w, h):
        raise SystemExit("recombined canvas size differs from the source")
    at = {c: i for i, c in enumerate(pal)}
    back = np.full((h, w), -1, np.int16)
    for x, y, rw, rh, c in rects:
        back[y:y+rh, x:x+rw] = at[c]
    return int((back != idx).sum())


if __name__ == '__main__':
    # Defaults resolve against the repo root, not the cwd, so `python3
    # tools/svg_slice.py` does the right thing from anywhere.
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('src', nargs='?', default=f'{root}/assets/sprites/boss.svg')
    a.add_argument('-o', '--out-svg', default=f'{root}/assets/sprites/parts/boss.svg')
    a.add_argument('-j', '--out-json', default=f'{root}/assets/sprites/hitboxes.json')
    n = a.parse_args()

    diff, boxes = slice_sprite(n.src, n.out_svg, n.out_json)
    for name, b in boxes.items():
        tag = '-' if b["index"] is None else str(b["index"])
        print(f"{tag:>2}  {name:<8} {b['x']:3d},{b['y']:3d} {b['w']:3d}x{b['h']:3d}"
              f"  {b['pixels']:5d} px")
    print(f"\n{n.out_svg}\n{n.out_json}")
    print(f"recombined vs original: {diff} differing pixels")
    if diff:
        raise SystemExit("SLICE IS LOSSY -- do not ship this rig")
