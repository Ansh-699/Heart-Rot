#!/usr/bin/env python3
"""The boss, cut out of the arena painting so the live rig sits on the paint pixel-exact.

    python3 tools/gen_boss.py                 # rewrites the three outputs below
    python3 tools/gen_boss.py --check         # exit non-zero if any of them is stale
    python3 tools/gen_boss.py --preview out.png   # the parts tinted over the crop, for eyes

Inputs
    assets/rooms/arena.png            the room painting (A1's committed source; `--src`)
    assets/map/arena.json             `rooms.arena.boss_crop_px`, when A1 has written it

Outputs (checked in, never hand-edited)
    assets/sprites/boss_parts.png     RGBA atlas: one tight cell per part, alpha = its mask
    assets/sprites/hitboxes.json      the schema `tools/gen_hitboxes.py` reads, unchanged
    app/src/render/boss.gen.ts        BOSS_ATLAS, ATLAS_W/H, BOSS_PARTS, EYES_PX

THE CUT
-------
The painting is one flat image: the demon is not separable from the floor by colour (its
r-b sits at -10 against the floor's -13; the whole picture is graded blue), so the
partition is AUTHORED, as polygons in source pixels, and the tool does the rest:

  * `BODY` is the silhouette. Outside it every pixel is transparent.
  * `PARTS` is walked in order and the FIRST polygon containing a pixel owns it -- the
    thorns come first because a spike's polygon overlaps the head or the hand it grows
    from; `torso` is the catch-all and owns whatever is left of the body.
  * A part's hitbox is the tight bounding box of the pixels it owns, so the box and the
    art cannot disagree by construction. Its muzzle is the drawn pixel nearest its own
    centroid: a diagonal spike's box centre is usually air.

The lossless check pastes every atlas cell back at its crop position and compares the
result with `crop AND body`, pixel for pixel. Any difference is a bug in the packer and
the tool exits non-zero rather than shipping a rig that is not the painting.

THE CROP
--------
The canvas is centred on the painting's pixel that lands on `BOSS_SPAWN` under the room
transform (`world = (px - 49, py - 4)` at 1122x612, the fixed contract, so PNG (561, 356)),
and it is padded so the canvas CENTRE is that point: `gen_hitboxes.py`'s anchor is
`-(W/2, H/2)`, so `Boss.x`/`Boss.y` is the canvas centre, and putting the centre on the
feet line is what makes `BOSS_SPAWN + BOSS_ANCHOR` the crop's top-left in world units --
the one identity the room renderer checks at boot. The lower half of the canvas is mostly
below the painting's bottom edge and entirely transparent; that costs nothing, since the
atlas holds tight cells and never the canvas.

When `arena.json` carries `rooms.arena.boss_crop_px` the crop is read from there and must
agree with this derivation; until then it is derived and printed so A1 can copy it.

A source at another resolution is a drop-in: every polygon is authored at 1122 px wide and
scaled by the source's own width, the atlas is cut at source resolution, and the hitboxes
are emitted in 1x pixels (= arena units at `gen_hitboxes.py --scale 1`). `BOSS_PARTS.w/h`
are world units and the atlas cell is `ATLAS_SCALE` times that, which is exactly what the
renderer's nested `<svg viewBox>` absorbs.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGEN = "python3 tools/gen_boss.py"

# The width every polygon below was authored against. The source's own width divided by
# this is the scale applied to all of them.
REF_W = 1122

# PNG pixel that lands on `map::BOSS_SPAWN` (512, 352) under the room transform
# `world = (px - 49, py - 4)`, i.e. `px = 512 + 49`, `py = 352 + 4`. Restated here rather
# than read from the map because it is a property of the ROOM fit, which `gen_rooms.py`
# owns; when `arena.json` carries `boss_crop_px` the two are checked against each other.
CROP_CENTRE = (561, 356)

# The nine parts the chain knows, in `Boss.parts` order -- `state.rs::N_PARTS`. The four
# thorns are 0..3 on purpose: `Hud.tsx` and `tick.rs` both rely on the emitters being the
# first four slots.
PART_INDEX = ["thorn0", "thorn1", "thorn2", "thorn3", "crown", "wolf_l", "beast_r", "mace", "claws"]

# The silhouette, clockwise from the top of the ram skull, in 1122-wide source pixels.
BODY = [
    (548, 66), (562, 58), (582, 55), (602, 56), (618, 62), (630, 76), (636, 96), (632, 118),
    (622, 130), (608, 136),                                    # outer horn, down to its tip
    (602, 128), (599, 114), (601, 100), (606, 92), (600, 86),  # back up the inside of the curl
    (594, 98), (591, 112), (593, 126), (597, 138), (603, 147), (614, 145),  # back of the skull
    (622, 154), (647, 111), (655, 115), (634, 156),            # thorn1, the spear
    (648, 146), (654, 134), (666, 150), (700, 152), (702, 157), (676, 160),
    (684, 184), (712, 202), (716, 210), (688, 214), (676, 216),  # beast head and its whisker
    (670, 226), (678, 232), (676, 256), (672, 286), (666, 306),  # right tentacle
    (666, 300), (666, 262), (656, 258),                        # back up the gap between the tentacle and the arm
    (656, 290), (662, 302), (664, 320), (668, 336), (662, 346), (650, 348), (630, 347), (612, 344), (602, 336),  # right hand
    (590, 330), (566, 334), (548, 336), (530, 334), (512, 330), (500, 336), (496, 336), (484, 345),  # underside
    (472, 345), (462, 334), (452, 337), (444, 343), (436, 336), (433, 322), (438, 304),  # left hand, floor between the fingers left out
    (428, 300), (403, 299), (403, 291), (424, 286), (442, 283),  # the bone spike
    (448, 282), (452, 270), (452, 250), (452, 242),            # up the left arm
    (438, 242), (424, 238), (414, 226), (415, 208), (426, 198), (440, 190), (446, 176),  # wolf snout and cheek
    (440, 160), (442, 140), (452, 138), (466, 164), (478, 170),  # left ear
    (492, 158), (482, 106), (487, 102), (504, 148),            # thorn0, the spear
    (503, 132), (508, 140), (512, 158), (516, 168),            # right ear
    (526, 172), (540, 176), (560, 174), (556, 166), (550, 154), (544, 142), (532, 132), (518, 126),  # the ram's jaw
    (512, 118), (520, 108), (534, 96),                         # ram snout, up to the dome
]

# First match wins. `core` is the vent; `torso` owns what nobody else claims.
PARTS = [
    ("thorn0", [(478, 98), (490, 98), (508, 148), (494, 160)]),
    ("thorn1", [(645, 108), (658, 113), (638, 162), (620, 156)]),
    ("thorn2", [(402, 282), (446, 280), (452, 306), (402, 306)]),
    ("thorn3", [(650, 224), (680, 226), (682, 260), (672, 292), (662, 306), (646, 306), (660, 262)]),
    ("crown", [(508, 118), (530, 94), (548, 62), (580, 54), (604, 54), (622, 62), (636, 80),
               (638, 112), (630, 132), (608, 140), (596, 132), (592, 152), (568, 172), (540, 170),
               (524, 152), (510, 134)]),
    ("wolf_l", [(438, 136), (454, 136), (472, 166), (488, 160), (506, 128), (512, 164), (513, 178),
                (506, 198), (494, 216), (478, 242), (452, 248), (430, 246), (412, 228), (412, 206),
                (430, 192), (444, 172)]),
    ("beast_r", [(596, 150), (606, 130), (618, 146), (630, 124), (642, 144), (654, 132), (668, 150),
                 (704, 148), (674, 164), (686, 186), (718, 202), (718, 214), (680, 218), (672, 236),
                 (650, 240), (624, 238), (600, 224), (586, 202), (586, 170)]),
    ("core", [(546 + round(32 * math.cos(t * math.pi / 12)), 248 + round(32 * math.sin(t * math.pi / 12)))
              for t in range(24)]),
    # The two arms' inner edges follow the shadow seam between the limb and the torso's
    # strands, and their tops wander along the tentacle bundle: a dead limb charred inside
    # a straight-sided polygon reads as a slab, not a limb.
    ("mace", [(450, 252), (462, 246), (474, 244), (484, 250), (491, 258), (489, 280), (491, 300),
              (486, 318), (490, 336), (484, 348), (430, 352), (403, 300), (402, 284), (440, 282),
              (446, 270)]),
    ("claws", [(598, 250), (608, 242), (620, 246), (634, 240), (648, 246), (662, 240), (674, 236),
               (682, 302), (696, 318), (698, 336), (680, 350), (598, 352), (594, 330), (599, 305), (595, 280),
               (600, 262)]),
    ("torso", None),
]

# The skull's eyes, the two bright cyan blocks the painting lights from within.
EYES = [(540, 196), (554, 196)]

# The atlas is packed on shelves no wider than this, in atlas pixels.
SHELF_W = 512


def scaled(pts, k):
    return [(x * k, y * k) for x, y in pts]


def rasterise(poly, w, h):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).polygon(poly, fill=1)
    return np.asarray(m, dtype=bool)


def partition(k, crop):
    """-> [(name, mask)] in PARTS order, every mask disjoint, their union == body."""
    x0, y0, w, h = crop
    shift = lambda pts: [(x - x0, y - y0) for x, y in scaled(pts, k)]
    body = rasterise(shift(BODY), w, h)
    if not body.any():
        raise SystemExit("BODY rasterises to nothing")
    out, claimed = [], np.zeros_like(body)
    for name, poly in PARTS:
        mask = body & ~claimed if poly is None else rasterise(shift(poly), w, h) & body & ~claimed
        if not mask.any():
            raise SystemExit(f"{name} owns no pixel: its polygon is outside BODY or fully claimed")
        claimed |= mask
        out.append((name, mask))
    return out, body


def derive_crop(k, boss_crop_px):
    """The canvas: centred on CROP_CENTRE, even W and H, containing BODY. Source pixels."""
    cx, cy = CROP_CENTRE[0] * k, CROP_CENTRE[1] * k
    xs, ys = zip(*scaled(BODY, k))
    half_w = max(cx - min(xs), max(xs) - cx)
    half_h = max(cy - min(ys), max(ys) - cy)
    # Even in 1x pixels so the anchor is a whole unit, then scaled.
    w = 2 * math.ceil(half_w / k + 1) * k
    h = 2 * math.ceil(half_h / k + 1) * k
    derived = (int(cx - w // 2), int(cy - h // 2), int(w), int(h))
    if boss_crop_px is None:
        return derived
    # arena.json carries the dict form gen_rooms.py writes: {x, y, w, h}.
    got = tuple(int(boss_crop_px[k]) for k in ("x", "y", "w", "h"))
    if got != derived:
        raise SystemExit(
            f"arena.json rooms.arena.boss_crop_px is {list(got)}, this tool derives "
            f"{list(derived)} from BODY and CROP_CENTRE. One of them moved; they must agree.")
    return got


def tight(mask):
    ys, xs = np.nonzero(mask)
    return int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)


def muzzle(mask):
    """The drawn pixel nearest the mask's centroid."""
    ys, xs = np.nonzero(mask)
    cx, cy = xs.mean(), ys.mean()
    i = int(np.argmin((xs - cx) ** 2 + (ys - cy) ** 2))
    return int(xs[i]), int(ys[i])


def pack(cells):
    """Shelf packing. cells: [(w, h)] -> ([(ax, ay)], atlas_w, atlas_h). Deterministic."""
    order = sorted(range(len(cells)), key=lambda i: (-cells[i][1], -cells[i][0], i))
    pos, x, y, shelf_h, atlas_w = [None] * len(cells), 0, 0, 0, 0
    for i in order:
        w, h = cells[i]
        if x > 0 and x + w > SHELF_W:
            y, x, shelf_h = y + shelf_h, 0, 0
        pos[i] = (x, y)
        x, shelf_h, atlas_w = x + w, max(shelf_h, h), max(atlas_w, x + w)
    return pos, atlas_w, y + shelf_h


def build(src, boss_crop_px):
    im = Image.open(src).convert("RGBA")
    if im.width % REF_W:
        raise SystemExit(f"{src} is {im.width} px wide, not a whole multiple of {REF_W}")
    k = im.width // REF_W
    crop = derive_crop(k, boss_crop_px)
    x0, y0, w, h = crop
    # PIL pads a crop that leaves the image with transparent black, which is exactly what
    # the canvas's lower half is.
    rgba = np.asarray(im.crop((x0, y0, x0 + w, y0 + h)))
    parts, body = partition(k, crop)

    # Every box in 1x (world) pixels: floor the origin, ceil the far edge, so the box
    # covers the pixels at any k. The atlas cell is the box scaled back up.
    boxes = {}
    for name, mask in parts:
        tx, ty, tw, th = tight(mask)
        bx, by = tx // k, ty // k
        boxes[name] = (bx, by, math.ceil((tx + tw) / k) - bx, math.ceil((ty + th) / k) - by)

    cells = [(boxes[n][2] * k, boxes[n][3] * k) for n, _ in parts]
    pos, aw, ah = pack(cells)
    atlas = np.zeros((ah, aw, 4), dtype=np.uint8)
    for (name, mask), (ax, ay), (cw, ch) in zip(parts, pos, cells):
        bx, by = boxes[name][0] * k, boxes[name][1] * k
        cell = rgba[by:by + ch, bx:bx + cw].copy()
        cell[..., 3] = np.where(mask[by:by + ch, bx:bx + cw], 255, 0)
        cell[cell[..., 3] == 0] = 0
        atlas[ay:ay + ch, ax:ax + cw] = cell

    # THE LOSSLESS CHECK: the atlas, put back, is the crop inside the body and nothing
    # else. The cells are pasted, not blended, so a pixel two cells both claim would show
    # up here as a difference too.
    want = rgba.copy()
    want[..., 3] = np.where(body, 255, 0)
    want[~body] = 0
    got = np.zeros_like(want)
    for (name, _), (ax, ay), (cw, ch) in zip(parts, pos, cells):
        bx, by = boxes[name][0] * k, boxes[name][1] * k
        cell = atlas[ay:ay + ch, ax:ax + cw]
        on = cell[..., 3] == 255
        got[by:by + ch, bx:bx + cw][on] = cell[on]
    if not np.array_equal(got, want):
        raise SystemExit(f"atlas is lossy: {int((got != want).any(-1).sum())} pixels differ from crop AND body")

    hit = {}
    for i, (name, mask) in enumerate(parts):
        bx, by, bw, bh = boxes[name]
        entry = {"index": PART_INDEX.index(name) if name in PART_INDEX else None,
                 "x": bx, "y": by, "w": bw, "h": bh, "pixels": int(mask.sum())}
        if name.startswith("thorn"):
            mx, my = muzzle(mask)
            entry["muzzle"] = [mx // k, my // k]
        hit[name] = entry
    hitboxes = {
        "source": f"{os.path.relpath(src, ROOT)} crop {list(crop)} (source px)",
        "crop_px": list(crop),
        "sprite": {"w": w // k, "h": h // k},
        "part_index": PART_INDEX,
        "hitboxes": hit,
    }
    ts_parts = [dict(name=name, index=hit[name]["index"], ax=ax, ay=ay,
                     w=boxes[name][2], h=boxes[name][3], cx=boxes[name][0], cy=boxes[name][1])
                for (name, _), (ax, ay) in zip(parts, pos)]
    eyes = [((x * k - x0) // k, (y * k - y0) // k) for x, y in EYES]
    return dict(atlas=atlas, k=k, aw=aw, ah=ah, crop=crop, hitboxes=hitboxes, parts=ts_parts,
                eyes=eyes, masks=parts, rgba=rgba, src=src)


def emit_ts(b):
    src = os.path.relpath(b["src"], ROOT)
    # Paint order is PARTS order reversed: torso and core behind, the thorns in front, so
    # a limb flung outward by a break-off crosses over the body and not under it.
    rows = ",\n".join(
        f"  {{ name: '{p['name']}', index: {'null' if p['index'] is None else p['index']}, "
        f"ax: {p['ax']}, ay: {p['ay']}, w: {p['w']}, h: {p['h']}, cx: {p['cx']}, cy: {p['cy']} }}"
        for p in reversed(b["parts"]))
    eyes = ", ".join(f"[{x}, {y}]" for x, y in b["eyes"])
    return f"""// @generated from {src} by `{REGEN}` -- DO NOT EDIT.
//
// The boss, cut out of the arena painting. Every rect below is a cell of
// `assets/sprites/boss_parts.png` and its place on the crop canvas `hitboxes.json`
// describes -- the same partition `gen_hitboxes.py` turns into the chain's boxes, so
// the drawn limb and the hittable limb are one limb. Edit `tools/gen_boss.py`, re-run.
import atlas from '../../../assets/sprites/boss_parts.png';

/** The atlas URL. Vite hashes the file under `/assets/`; it is never inlined. */
export const BOSS_ATLAS: string = atlas;
/** The atlas bitmap, in atlas pixels -- the `<image>`'s own width and height. */
export const ATLAS_W = {b['aw']};
export const ATLAS_H = {b['ah']};
/** Atlas pixels per crop pixel: the source was {b['k']}x the 1122 px authoring width. */
export const ATLAS_SCALE = {b['k']};

export interface BossPart {{
  readonly name: string;
  /** The `Boss.parts` slot, or `null` for a rig-only group (`torso`, `core`). */
  readonly index: number | null;
  /** The cell's top-left in the atlas, in atlas pixels; the cell is `w * ATLAS_SCALE` by `h * ATLAS_SCALE`. */
  readonly ax: number;
  readonly ay: number;
  /** The part's tight box on the crop canvas, in crop pixels (= arena units at `--scale 1`). */
  readonly w: number;
  readonly h: number;
  readonly cx: number;
  readonly cy: number;
}}

/** Paint order, back to front. */
export const BOSS_PARTS: readonly BossPart[] = [
{rows},
];

/** The skull's two eyes, in crop pixels -- the bright blocks the painting lights from within. */
export const EYES_PX: readonly (readonly [number, number])[] = [{eyes}];
"""


def png_bytes(atlas):
    buf = io.BytesIO()
    Image.fromarray(atlas, "RGBA").save(buf, "PNG", optimize=True)
    return buf.getvalue()


def preview(b, path):
    """The crop, each part tinted, boxes and muzzles drawn, at 3x -- for a pair of eyes."""
    tints = [(255, 80, 80), (255, 160, 40), (255, 240, 60), (160, 255, 60), (60, 255, 200),
             (60, 160, 255), (160, 80, 255), (255, 60, 220), (200, 200, 200), (255, 255, 255), (90, 90, 90)]
    out = b["rgba"][..., :3].astype(int)
    for (name, mask), t in zip(b["masks"], tints):
        out[mask] = (out[mask] * 0.55 + np.array(t) * 0.45)
    im = Image.fromarray(out.astype(np.uint8)).resize((out.shape[1] * 3, out.shape[0] * 3), Image.NEAREST)
    d = ImageDraw.Draw(im)
    k = b["k"]
    for name, e in b["hitboxes"]["hitboxes"].items():
        x, y, w, h = e["x"] * k * 3, e["y"] * k * 3, e["w"] * k * 3, e["h"] * k * 3
        d.rectangle([x, y, x + w - 1, y + h - 1], outline=(255, 255, 255))
        d.text((x + 2, y + 2), name, fill=(255, 255, 255))
        if "muzzle" in e:
            mx, my = e["muzzle"][0] * k * 3, e["muzzle"][1] * k * 3
            d.ellipse([mx - 4, my - 4, mx + 4, my + 4], outline=(255, 0, 0), width=2)
    for x, y in b["eyes"]:
        d.ellipse([x * k * 3 - 6, y * k * 3 - 6, x * k * 3 + 6, y * k * 3 + 6], outline=(0, 255, 255), width=2)
    im.save(path)


if __name__ == "__main__":
    a = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--src", default=f"{ROOT}/assets/rooms/arena.png")
    a.add_argument("--map", default=f"{ROOT}/assets/map/arena.json")
    a.add_argument("--out-png", default=f"{ROOT}/assets/sprites/boss_parts.png")
    a.add_argument("--out-json", default=f"{ROOT}/assets/sprites/hitboxes.json")
    a.add_argument("--out-ts", default=f"{ROOT}/app/src/render/boss.gen.ts")
    a.add_argument("--preview", help="write the tinted partition here, for eyes")
    a.add_argument("-c", "--check", action="store_true",
                   help="write nothing; exit non-zero if any output is stale")
    n = a.parse_args()

    boss_crop_px = None
    try:
        boss_crop_px = json.load(open(n.map))["rooms"]["arena"]["boss_crop_px"]
    except (OSError, KeyError, ValueError):
        pass
    b = build(n.src, boss_crop_px)
    if n.preview:
        preview(b, n.preview)

    want_png = png_bytes(b["atlas"])
    want = {n.out_json: json.dumps(b["hitboxes"], indent=1) + "\n", n.out_ts: emit_ts(b)}
    if n.check:
        stale = [p for p, text in want.items() if not os.path.exists(p) or open(p).read() != text]
        try:
            same = np.array_equal(np.asarray(Image.open(n.out_png).convert("RGBA")), b["atlas"])
        except OSError:
            same = False
        if not same:
            stale.append(n.out_png)
        if stale:
            raise SystemExit("STALE, re-run `%s`:\n  %s" % (REGEN, "\n  ".join(stale)))
    else:
        for p, text in want.items():
            open(p, "w").write(text)
        open(n.out_png, "wb").write(want_png)

    hb = b["hitboxes"]
    print(f"crop {b['crop']} (source px, {b['k']}x)  sprite {hb['sprite']['w']}x{hb['sprite']['h']}  "
          f"atlas {b['aw']}x{b['ah']} {len(want_png)} bytes"
          + ("" if boss_crop_px else "  <- arena.json has no rooms.arena.boss_crop_px yet; A1 copies this crop"))
    for name, e in hb["hitboxes"].items():
        idx = "-" if e["index"] is None else e["index"]
        print(f"{idx:>2}  {name:<8} {e['x']:4},{e['y']:4} {e['w']:3}x{e['h']:3}  {e['pixels']:6} px"
              + (f"  muzzle {e['muzzle']}" if "muzzle" in e else ""))
    print(f" eyes {b['eyes']}")
