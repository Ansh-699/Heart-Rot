#!/usr/bin/env python3
"""hitboxes.json -> the Rust hitbox table AND the TypeScript one, from ONE pass.

`svg_slice.py` already partitions the boss into parts and writes the tight bounds
of the pixels each part actually owns. Those bounds are the only truthful hitboxes
there are: they came off the same partition that produced the `<g>` groups the
browser draws, so a box and its art cannot disagree by construction.

Everything downstream of that used to re-state them. `shoot.rs` carried a
hand-written `PART_HITBOXES` and the two described different creatures -- six of
nine parts had zero overlap and two were mirrored, so a shot at a visible limb
missed and a shot at empty air hit. The fix is not to correct the copy; it is to
delete the copy. This emits both consumers from the JSON, so the only way to move
a hitbox is to move the art.

    python3 tools/gen_hitboxes.py        # rewrites both generated files

Outputs (checked in, never hand-edited):
    programs/heartrot/src/hitboxes.rs
    packages/client/src/hitboxes.ts


THE ANCHOR
----------
`hitboxes.json` is in **sprite pixels**, origin top-left of a W x H canvas. The
program raycasts in **boss-local** arena units, origin at `Boss.x` / `Boss.y`.
One sprite pixel is one arena unit (`render/sprites.ts` draws it 1:1), so the two
spaces differ by a pure translation and nothing else -- no scale, no flip.

The translation is the sprite's own centre:

    ANCHOR_X = -round(W / 2)      local_x = sprite_x + ANCHOR_X
    ANCHOR_Y = -round(H / 2)      local_y = sprite_y + ANCHOR_Y

i.e. `Boss.x`/`Boss.y` is the middle of the sprite canvas. That is derived from
the sprite and from nothing else, which is the point: any other offset would be a
number living outside the art, and a number living outside the art is what drifts.
The renderer must place the sprite's top-left at `(Boss.x + ANCHOR_X,
Boss.y + ANCHOR_Y)` -- it is exported from the TS output so it, too, is stated once.

The canvas centre deliberately includes the baked-in `ground` strip: it is part of
the drawn canvas, the renderer translates the whole canvas, and excluding it would
put the art and the raycast 27 units apart again for no gain.
"""
import argparse, json, os

# Arena units per tile, mirroring `TILE` in programs/heartrot/src/handlers/shoot.rs.
# The ray samples ONE point per tile, so a box thinner than this in either axis can
# be stepped clean over and is unhittable from some angles. Checked, not assumed.
TILE = 16

REGEN = "python3 tools/gen_hitboxes.py"


def load(path):
    """-> (part names in chain-index order, {name: box}, sprite w, h).

    Every failure here is loud. A missing index or a stray one means the JSON and
    `Boss.parts[N]` have drifted, and generating a table anyway would bake the
    drift into both languages at once.
    """
    d = json.load(open(path))
    order, boxes, sprite = d["part_index"], d["hitboxes"], d["sprite"]
    for i, name in enumerate(order):
        b = boxes.get(name)
        if b is None:
            raise SystemExit(f"{path}: part_index[{i}] = {name!r} has no hitbox")
        if b["index"] != i:
            raise SystemExit(
                f"{path}: {name} is part_index[{i}] but its box says index {b['index']}")
    indexed = sorted(b["index"] for b in boxes.values() if b["index"] is not None)
    if indexed != list(range(len(order))):
        raise SystemExit(f"{path}: chain indices are {indexed}, expected 0..{len(order)-1}")
    if "core" not in boxes:
        raise SystemExit(f"{path}: no 'core' box -- the vent has no geometry")
    return order, boxes, sprite["w"], sprite["h"]


def to_local(boxes, order, w, h):
    """-> ([(name, x, y, w, h) in chain order], (core_x, core_y, core_r_sq)).

    The core is a circle on chain (a squared radius against a squared distance --
    this program has no sqrt), so its box becomes the INSCRIBED circle: half the
    shorter side, so the circle never claims a pixel the vent does not draw.
    """
    ax, ay = -round(w / 2), -round(h / 2)
    parts = []
    for name in order:
        b = boxes[name]
        if b["w"] < TILE or b["h"] < TILE:
            raise SystemExit(
                f"{name} is {b['w']}x{b['h']}, thinner than TILE={TILE}: the ray samples "
                f"one point per tile and would step over it. Widen the part in svg_slice.py.")
        parts.append((name, b["x"] + ax, b["y"] + ay, b["w"], b["h"]))
    c = boxes["core"]
    # Floor division, not round(), so the centre is reproducible in any language.
    core = ((2 * c["x"] + c["w"]) // 2 + ax,
            (2 * c["y"] + c["h"]) // 2 + ay,
            (min(c["w"], c["h"]) // 2) ** 2)
    return parts, (ax, ay), core


def header(src, p):
    """`p` is the line prefix: `//!` for a Rust inner doc comment, `//` for TS."""
    return (f"{p} @generated from {src} by `{REGEN}` -- DO NOT EDIT.\n"
            f"{p}\n"
            f"{p} Hand-editing this file re-creates the defect it exists to close: the drawn\n"
            f"{p} boss and the raycast boss stop being the same boss. Move the art, re-run\n"
            f"{p} `python3 tools/svg_slice.py`, then re-run the command above.\n")


def emit_rust(parts, anchor, core, src, w, h):
    ax, ay = anchor
    cx, cy, crsq = core
    rows = "\n".join(
        f"    Rect {{ x: {x:4}, y: {y:4}, w: {rw:3}, h: {rh:3} }}, // {i} {name}"
        for i, (name, x, y, rw, rh) in enumerate(parts))
    return f"""{header(src, "//!")}//!
//! Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y`.
//!
//! `{src}` is in sprite pixels on a {w}x{h} canvas, origin top-left; one sprite
//! pixel is one arena unit. `Boss.x`/`Boss.y` is the centre of that canvas, so the
//! two spaces differ by the translation ({ax}, {ay}) and nothing else -- no scale,
//! no flip. See the tool's docstring for the derivation.

/// A boss-local axis-aligned box, in arena units relative to `Boss.x` / `Boss.y`.
#[derive(Clone, Copy)]
pub struct Rect {{
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}}

impl Rect {{
    /// Half-open on both axes, so touching rectangles cannot both claim a step.
    pub const fn contains(&self, x: i32, y: i32) -> bool {{
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }}
}}

/// Index-aligned with `Boss.parts`. The length is written as `crate::state::N_PARTS`
/// on purpose: if the slicer's `part_index` and the on-chain array ever disagree,
/// this file stops compiling instead of silently mis-indexing a limb.
///
/// Every box is at least `TILE` (16) units on both axes -- the generator refuses to
/// emit one that is not, because the ray samples one point per tile and would step
/// straight over anything thinner.
pub const PART_HITBOXES: [Rect; crate::state::N_PARTS] = [
{rows}
];

/// The vent: centre offset from `Boss.x`/`Boss.y` and a *squared* radius, compared
/// against a squared distance because this program has no sqrt. It is the circle
/// inscribed in the `core` box, so it never claims a pixel the vent does not draw.
pub const CORE_X: i32 = {cx};
pub const CORE_Y: i32 = {cy};
pub const CORE_RADIUS_SQ: i32 = {crsq};
"""


def emit_ts(parts, anchor, core, src, w, h):
    ax, ay = anchor
    cx, cy, crsq = core
    rows = "\n".join(
        f"  {{ x: {x}, y: {y}, w: {rw}, h: {rh} }}, // {i} {name}"
        for i, (name, x, y, rw, rh) in enumerate(parts))
    tuple_t = ", ".join(["Rect"] * len(parts))
    return f"""{header(src, "//")}/**
 * Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y` -- the exact
 * numbers `programs/heartrot/src/hitboxes.rs` raycasts against, emitted from the same
 * JSON in the same pass. Client-side hit prediction that disagrees with the chain is
 * the bug this file exists to make impossible.
 *
 * `{src}` is in sprite pixels on a {w}x{h} canvas, origin top-left; one sprite pixel
 * is one arena unit. The two spaces differ by `BOSS_ANCHOR_*` and nothing else.
 */

/** A boss-local axis-aligned box, in arena units relative to `Boss.x` / `Boss.y`. */
export interface Rect {{
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}}

/** The sprite canvas, in arena units (1 sprite pixel = 1 arena unit). */
export const BOSS_SPRITE_W = {w};
export const BOSS_SPRITE_H = {h};

/**
 * Where the sprite's top-left corner goes, relative to `Boss.x` / `Boss.y`:
 * `translate(boss.x + BOSS_ANCHOR_X, boss.y + BOSS_ANCHOR_Y)`. It is the canvas
 * centre, derived from the sprite's own dimensions -- import it rather than
 * recomputing it, or the art and the raycast drift apart again.
 */
export const BOSS_ANCHOR_X = {ax};
export const BOSS_ANCHOR_Y = {ay};

/** Index-aligned with `BossAccount.parts`: {", ".join(n for n, *_ in parts)}. */
export const PART_HITBOXES: readonly [{tuple_t}] = [
{rows}
];

/**
 * The vent, as the circle inscribed in the `core` box. `radiusSq` is squared to match
 * the program, which compares squared distances and never takes a square root.
 */
export const CORE: {{ readonly x: number; readonly y: number; readonly radiusSq: number }} = {{
  x: {cx},
  y: {cy},
  radiusSq: {crsq},
}};
"""


if __name__ == '__main__':
    # Defaults resolve against the repo root, not the cwd, so `python3
    # tools/gen_hitboxes.py` does the right thing from anywhere.
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('src', nargs='?', default=f'{root}/assets/sprites/hitboxes.json')
    a.add_argument('-r', '--out-rust', default=f'{root}/programs/heartrot/src/hitboxes.rs')
    a.add_argument('-t', '--out-ts', default=f'{root}/packages/client/src/hitboxes.ts')
    a.add_argument('-c', '--check', action='store_true',
                   help='write nothing; exit non-zero if either checked-in file is stale')
    n = a.parse_args()

    order, boxes, w, h = load(n.src)
    parts, anchor, core = to_local(boxes, order, w, h)
    rel = os.path.relpath(n.src, root)
    want = {n.out_rust: emit_rust(parts, anchor, core, rel, w, h),
            n.out_ts: emit_ts(parts, anchor, core, rel, w, h)}

    # `--check` IS the test for this tool: it re-derives both files and proves the
    # committed ones are what the art currently says. Anything that would silently
    # reintroduce the drift -- editing a generated file, moving a part in
    # svg_slice.py and not re-running -- fails here loudly.
    if n.check:
        stale = [p for p, text in want.items()
                 if not os.path.exists(p) or open(p).read() != text]
        if stale:
            raise SystemExit("STALE, re-run `%s`:\n  %s" % (REGEN, "\n  ".join(stale)))
    else:
        for p, text in want.items():
            open(p, 'w').write(text)

    print(f"anchor {anchor}  sprite {w}x{h}")
    for i, (name, x, y, rw, rh) in enumerate(parts):
        print(f"{i:>2}  {name:<8} {x:4},{y:4} {rw:3}x{rh:3}")
    print(f" -  core     {core[0]:4},{core[1]:4} r^2={core[2]}")
    print(f"\n{n.out_rust}\n{n.out_ts}")
