#!/usr/bin/env python3
"""hitboxes.json -> the Rust hitbox table AND the TypeScript one, from ONE pass.

`gen_boss.py` already partitions the boss into parts and writes the tight bounds
of the pixels each part actually owns. Those bounds are the only truthful hitboxes
there are: they came off the same partition that produced the atlas cells the
browser draws, so a box and its art cannot disagree by construction.

Everything downstream of that used to re-state them. `shoot.rs` carried a
hand-written `PART_HITBOXES` and the two described different creatures -- six of
nine parts had zero overlap and two were mirrored, so a shot at a visible limb
missed and a shot at empty air hit. The fix is not to correct the copy; it is to
delete the copy. This emits both consumers from the JSON, so the only way to move
a hitbox is to move the art.

    python3 tools/gen_hitboxes.py        # rewrites both generated files
    python3 tools/gen_hitboxes.py --scale 2   # the lever: twice the creature, one command

Outputs (checked in, never hand-edited):
    programs/heartrot/src/hitboxes.rs
    packages/client/src/hitboxes.ts


THE ANCHOR
----------
`hitboxes.json` is in **sprite pixels**, origin top-left of a W x H canvas. The
program raycasts in **boss-local** arena units, origin at `Boss.x` / `Boss.y`.
One sprite pixel is SCALE arena units, so the two spaces differ by a uniform scale
about the canvas centre and nothing else -- no flip, no shear.

The translation is the scaled sprite's own centre:

    ANCHOR_X = -round(W * S / 2)  local_x = sprite_x * S + ANCHOR_X
    ANCHOR_Y = -round(H * S / 2)  local_y = sprite_y * S + ANCHOR_Y

i.e. `Boss.x`/`Boss.y` is the middle of the sprite canvas. That is derived from
the sprite and from nothing else, which is the point: any other offset would be a
number living outside the art, and a number living outside the art is what drifts.
The renderer must place the sprite's top-left at `(Boss.x + ANCHOR_X,
Boss.y + ANCHOR_Y)` -- it is exported from the TS output so it, too, is stated once.

The canvas centre deliberately includes the transparent lower half `gen_boss.py`
pads on: the canvas centre is the creature's feet line, so `Boss.x`/`Boss.y` IS
`BOSS_SPAWN` on the pit rim, and the rig's top-left is `BOSS_SPAWN + ANCHOR` --
the identity the room renderer checks at boot.


THE SCALE
---------
`--scale` (default 1) is how big the creature is drawn in arena units per sprite
pixel. It is a PARAMETER OF THIS TOOL and never a constant in Rust or TypeScript,
because it moves every hitbox, every muzzle, the anchor and the core radius at
once. The default is 1 because the boss is cut out of the arena painting, which is
drawn at one unit per pixel: any other scale would lift the rig off the paint it
is meant to sit on pixel-exact.

    local = sprite * SCALE + ANCHOR        ANCHOR = -round(canvas * SCALE / 2)

The core centre and radius are computed in SPRITE space and scaled afterwards.
Scaling a centre is not the same as centring a scaled box; this file does the
former.
"""
import argparse, json, math, os

# Arena units per tile, mirroring `TILE` in programs/heartrot/src/handlers/shoot.rs.
# The ray samples ONE point per tile, so a box thinner than this in either axis can
# be stepped clean over and is unhittable from some angles. Checked, not assumed.
TILE = 16

REGEN = "python3 tools/gen_hitboxes.py"

# What ONE ray step is actually worth, in arena units.
#
# `shoot.rs::unit_q12` is alpha-max-plus-beta-min, which OVERESTIMATES the true vector
# length by up to 11.8%, so a `TILE`-long step along the normalised direction covers
# 0.894..1.000 of a tile -- never more. Walking a full 16.0 here credits 64 x 16 = 1024
# units of reach against the 915 the program guarantees: 108 units, 11.8%, of range this
# tool would swear exists and the chain does not have. That is the difference between a
# guard and a rubber stamp, so the walk steps the SHORT step -- the one the program is
# contractually never worse than. It is also never coarser than the program's finest
# sample, so a box this walk steps over is a box the ray can step over too.
RAY_STEP = TILE * 894 // 1000


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
    for name in order:
        if not name.startswith("thorn"):
            continue
        m = boxes[name].get("muzzle")
        # The muzzle is a DRAWN pixel, which only the slicer knows. Refusing here is
        # the whole point: falling back to the box centre is how three of four volleys
        # came to spawn in mid-air beside the creature.
        if not (isinstance(m, list) and len(m) == 2 and all(isinstance(v, int) for v in m)):
            raise SystemExit(
                f"{path}: {name} is a volley emitter with no `muzzle: [x, y]`. "
                f"`tools/gen_boss.py` writes it -- the drawn pixel nearest the part's "
                f"mask centroid. A box centre is not a substitute; it is usually air.")
    return order, boxes, sprite["w"], sprite["h"]


def to_local(boxes, order, w, h, scale):
    """-> ([(name, x, y, w, h) in chain order], (ax, ay), (core_x, core_y, core_r_sq)).

    The core is a circle on chain (a squared radius against a squared distance --
    this program has no sqrt), so its box becomes the INSCRIBED circle: half the
    shorter side, so the circle never claims a pixel the vent does not draw. Its
    centre and radius are taken in SPRITE space and scaled afterwards; centring the
    already-scaled box would land a unit off for odd widths.

    The TILE floor is checked on the SCALED box, because the scaled box is what the
    ray steps over.
    """
    ax, ay = -round(w * scale / 2), -round(h * scale / 2)
    parts = []
    for name in order:
        b = boxes[name]
        bw, bh = b["w"] * scale, b["h"] * scale
        if bw < TILE or bh < TILE:
            raise SystemExit(
                f"{name} is {bw}x{bh} at scale {scale}, thinner than TILE={TILE}: the ray "
                f"samples one point per tile and would step over it. Widen the part in "
                f"gen_boss.py, or raise --scale.")
        parts.append((name, b["x"] * scale + ax, b["y"] * scale + ay, bw, bh))
    c = boxes["core"]
    # Floor division, not round(), so the centre is reproducible in any language.
    core = (((2 * c["x"] + c["w"]) // 2) * scale + ax,
            ((2 * c["y"] + c["h"]) // 2) * scale + ay,
            ((min(c["w"], c["h"]) // 2) * scale) ** 2)
    if core[2] < TILE * TILE:
        raise SystemExit(
            f"the vent radius is {int(core[2] ** 0.5)} units at scale {scale}, under one "
            f"TILE: the ray steps one tile at a time and would miss the core entirely.")
    return parts, (ax, ay), core


def to_muzzles(boxes, parts, anchor, scale):
    """-> [(part index, name, muzzle x, muzzle y)] for every thorn, in chain order.

    A thorn is a part the slicer named `thorn*`; the emitters are not a separate list
    living somewhere else, or that list is the next thing to drift.

    THE POINT IS A DRAWN PIXEL, not the box centre. A thorn is a diagonal spray inside
    an axis-aligned box that is 8-13% full, so its centre is usually transparent: three
    of the four muzzles used to sit in mid-air beside the creature, and thorn1's sat
    inside `beast_r`'s box where the raycast could not even reach it. `gen_boss.py`
    writes the drawn pixel nearest each thorn's mask centroid into `hitboxes.json`; this
    reads it and scales it exactly as it scales the boxes. `load()` refuses a thorn with
    no muzzle, so there is no box-centre fallback left to silently regress to.
    """
    ax, ay = anchor
    out = []
    for i, (name, x, y, w, h) in enumerate(parts):
        if not name.startswith("thorn"):
            continue
        sx, sy = boxes[name]["muzzle"]
        mx, my = sx * scale + ax, sy * scale + ay
        # Half-open containment, the same test the Rust emits. This one CAN fire: a
        # muzzle is authored pixel data, not derived from the box.
        if not (x <= mx < x + w and y <= my < y + h):
            raise SystemExit(
                f"{name}: muzzle sprite ({sx},{sy}) -> local ({mx},{my}) is outside its own "
                f"box ({x},{y},{w},{h}). A volley would spawn on a limb it is not gated on.")
        out.append((i, name, mx, my))
    if not out:
        raise SystemExit("no part is named thorn*: the boss has no volley emitters")
    return out


def check_pit_reach(map_path, parts, core):
    """Refuse a boss the pit cannot shoot. Three properties, all of them silent failures.

    `MAX_RAY_STEPS` is `map::MAP_TILES`, so the ray reaches `MAP_TILES * RAY_STEP` units
    and dies on the first wall tile. Deepen the pit, widen it, move `B`, or drop `--scale`
    and part of the arena goes dead WITH NO ERROR ANYWHERE -- a player stands in the pit,
    fires at a boss filling the screen, and nothing happens. This is that error, and an
    enlarged pit is exactly the change that causes it.

    Every walkable stand in the pit is swept, not every pit tile: the origin is each of
    the four corners of the tile, because a player's position is a unit and the tile
    corner nearest the far wall is 21 units further from the boss than the tile itself.

    **1. Shell intact.** Some part or the vent is reachable, so the fight can start.

    **2. Shell stripped -- `parts=[]`.** `raycast` skips a part with 0 HP, so in the
    endgame the vent circle is the ONLY target on the map, 7.5 tiles across where the
    whole shell spans 41. A pit that reaches the mace and not the vent is a raid
    that cannot be finished, from a stand that looked fine in property 1. This is the
    property the old version of this check did not test at all.

    **3. Every part is killable from the pit.** First-match order means a box can be
    wholly claimed by a lower-indexed one; `no_part_is_shadowed_out_of_the_fight` proves
    a part keeps a tile of box, and this proves a ray from a place a player can stand
    actually lands on it. Aim points are sampled from the part's OWN points -- the ones
    first-match awards to it -- because a part's box centre often belongs to a thorn.

    The ray is walked as an exact float line rather than through the chain's integer
    normaliser: over 200,000 angles that normaliser measures 0.2354 degrees of direction
    error, which is 3.55 units of lateral miss at the worst-case 865-unit range -- under a
    quarter tile, and every box here is at least a tile. Approximating it costs nothing a
    reachability guard can see, and mirroring it here would be `unit_velocity` stated twice.
    The step length is NOT approximated: see [`RAY_STEP`].

    Skipped, loudly, when the map carries no `P`: the pit markers are `gen_map.py`'s and
    this tool must not fail because that file has not been redrawn yet.
    """
    try:
        grid = json.load(open(map_path))["grid"]
    except (OSError, KeyError, ValueError) as e:
        print(f"pit reach: SKIPPED, cannot read {map_path} ({e})")
        return
    # `B` and `E` are pit terrain with a marker painted on them, not a different floor:
    # the respawn doors are where a raider re-enters and stands, and the boss anchor is
    # inside the movement box like every other pit tile. Sweeping only `P` left the four
    # doors -- the tiles a player is GUARANTEED to stand on -- unchecked.
    pit = [(tx, ty) for ty, row in enumerate(grid)
           for tx, c in enumerate(row) if c in 'PBE']
    if not pit:
        print(f"pit reach: SKIPPED, no pit terrain in {os.path.basename(map_path)} yet")
        return
    spawn = [(tx, ty) for ty, row in enumerate(grid) for tx, c in enumerate(row) if c == 'B']
    if len(spawn) != 1:
        raise SystemExit(f"{map_path}: {len(spawn)} `B` markers, expected exactly 1")
    bx, by = spawn[0][0] * TILE, spawn[0][1] * TILE
    steps = len(grid)                      # MAX_RAY_STEPS == map::MAP_TILES
    reach = steps * RAY_STEP
    cx, cy, crsq = core

    def blocked(x, y):
        tx, ty = x // TILE, y // TILE
        return not (0 <= ty < len(grid) and 0 <= tx < len(grid[ty])) or grid[ty][tx] == '#'

    def in_core(x, y):
        dx, dy = x - (bx + cx), y - (by + cy)
        return dx * dx + dy * dy <= crsq

    def first_part(x, y):
        """`raycast`'s rule: the FIRST part in index order whose box claims the point."""
        for i, (_, px, py, pw, ph) in enumerate(parts):
            if bx + px <= x < bx + px + pw and by + py <= y < by + py + ph:
                return i
        return None

    # Property 1 and 2 differ ONLY in which targets exist, which is the difference the
    # program itself draws on `boss.parts[index] != 0`. One walker, two target sets.
    def hits_shell(x, y):
        return first_part(x, y) is not None or in_core(x, y)

    # Stands, in WORLD units: every corner of every pit tile a player can occupy.
    stands = [(tx * TILE + ox, ty * TILE + oy)
              for tx, ty in pit for ox in (0, TILE - 1) for oy in (0, TILE - 1)]

    # Targets in WORLD units: the nine part boxes, plus nine points across the vent.
    # Aim is free (`shoot.rs` takes the raw pointer vector), so a stand counts as reaching
    # the vent if ANY line into the circle gets there -- one that clears a doorway jamb the
    # centre line clips is a shot a player really has. Nine points, all inside the circle
    # at 2/3 radius, is enough angular spread to say so without pretending to sweep 256
    # directions per stand.
    r23 = math.isqrt(crsq) * 2 // 3
    core_aims = [(bx + cx + dx, by + cy + dy)
                 for dx in (-r23, 0, r23) for dy in (-r23, 0, r23)]
    core_aim = (bx + cx, by + cy)
    aims = [(bx + x + w // 2, by + y + h // 2) for _, x, y, w, h in parts] + core_aims

    def sweep(what, targets, hit, worst_of=None):
        """Every stand must reach `hit` by aiming at one of `targets`. -> worst range."""
        dead, worst = [], 0
        for sx, sy in stands:
            for ax, ay in targets:
                if _walk(sx, sy, ax, ay, steps, blocked, hit):
                    break
            else:
                dead.append((sx // TILE, sy // TILE))
            if worst_of is not None:
                worst = max(worst, math.dist((sx, sy), worst_of))
        if dead:
            raise SystemExit(
                f"{len(dead)} of {len(stands)} pit stands cannot reach {what} within "
                f"{steps} ray steps ({reach} units) -- e.g. tiles {sorted(set(dead))[:6]}. "
                f"Move `B` down, shrink the pit, or lower --scale. A player standing there "
                f"fires at the boss and nothing happens.")
        return worst

    sweep("ANY boss part or the vent", aims, hits_shell)
    worst = sweep("THE VENT with the shell stripped", core_aims, in_core, core_aim)

    # Property 3. Aim at points the part actually owns; a box centre is often a thorn's.
    for i, (name, px, py, pw, ph) in enumerate(parts):
        # Half a tile is the finest a ray can be expected to resolve, so scanning the box
        # at that stride is as good as scanning it whole. beast_r is the reason this is a
        # scan and not a grid of quarter-points: thorn1's box swallows all but a 24-unit
        # strip down its left edge, and every quarter-point of beast_r lies in that strip's
        # shadow. `no_part_is_shadowed_out_of_the_fight` proves the strip exists; this
        # proves a player can put a shot in it.
        own = [(bx + px + x, by + py + y)
               for y in range(TILE // 2, ph, TILE // 2)
               for x in range(TILE // 2, pw, TILE // 2)
               if first_part(bx + px + x, by + py + y) == i][:32]
        if not own:
            raise SystemExit(
                f"part {i} ({name}) owns none of its sampled points: a lower-indexed box "
                f"has swallowed it and no shot can ever damage it.")
        if not any(_walk(sx, sy, ax, ay, steps, blocked,
                         lambda x, y, i=i: first_part(x, y) == i)
                   for ax, ay in own for sx, sy in stands):
            raise SystemExit(
                f"part {i} ({name}) is unhittable from every one of {len(stands)} pit "
                f"stands: it is behind a wall, out of range, or shadowed by a lower-indexed "
                f"box. That limb can never be destroyed and the vent never opens.")

    print(f"pit reach: {len(pit)} pit tiles / {len(stands)} stands, all reach a part AND "
          f"the bare vent within {steps} x {RAY_STEP} = {reach} units "
          f"(worst stand-to-vent {worst:.0f}); all {len(parts)} parts hittable")


def _walk(ox, oy, ax, ay, steps, blocked, hits):
    """One ray, [`RAY_STEP`] per step, aborting on the first wall -- `shoot.rs::raycast`."""
    vx, vy = ax - ox, ay - oy
    d = math.hypot(vx, vy)
    if d == 0:
        return True
    vx, vy = vx / d * RAY_STEP, vy / d * RAY_STEP
    x, y = float(ox), float(oy)
    for _ in range(steps):
        x += vx
        y += vy
        if blocked(int(x), int(y)):
            return False
        if hits(int(x), int(y)):
            return True
    return False


def header(src, p):
    """`p` is the line prefix: `//!` for a Rust inner doc comment, `//` for TS."""
    return (f"{p} @generated from {src} by `{REGEN}` -- DO NOT EDIT.\n"
            f"{p}\n"
            f"{p} Hand-editing this file re-creates the defect it exists to close: the drawn\n"
            f"{p} boss and the raycast boss stop being the same boss. Move the art, re-run\n"
            f"{p} `python3 tools/gen_boss.py`, then re-run the command above.\n")


def emit_rust(parts, anchor, core, muzzles, src, w, h, scale):
    ax, ay = anchor
    cx, cy, crsq = core
    rows = "\n".join(
        f"    Rect {{ x: {x:4}, y: {y:4}, w: {rw:3}, h: {rh:3} }}, // {i} {name}"
        for i, (name, x, y, rw, rh) in enumerate(parts))
    muzzle_rows = "\n".join(
        f"    Muzzle {{ part: {i}, x: {mx:4}, y: {my:4} }}, // {name}"
        for i, name, mx, my in muzzles)
    return f"""{header(src, "//!")}//!
//! Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y`.
//!
//! `{src}` is in sprite pixels on a {w}x{h} canvas, origin top-left; one sprite
//! pixel is {scale} arena units (`--scale {scale}`, a generator argument and never a
//! constant here). `Boss.x`/`Boss.y` is the centre of that scaled canvas, so the two
//! spaces differ by `local = sprite * {scale} + ({ax}, {ay})` and nothing else -- no
//! flip, no shear. See the tool's docstring for the derivation.
//!
//! **Why the `rustfmt::skip`s below.** This file is emitted, and `--check` compares it
//! byte for byte against a fresh emission. Let rustfmt reflow it and a perfectly synced
//! tree reports STALE -- 94 lines of pure reformatting with not one number changed. A
//! check that cries wolf on every run is a check everyone learns to ignore, and then a
//! real drift is ignored too. The generator owns the formatting of its own output.
//! (A single `#![rustfmt::skip]` on the file would say this once, but an inner attribute
//! outside the crate root is `custom_inner_attributes` and does not compile on stable.)

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
#[rustfmt::skip]
pub const PART_HITBOXES: [Rect; crate::state::N_PARTS] = [
{rows}
];

/// The vent: centre offset from `Boss.x`/`Boss.y` and a *squared* radius, compared
/// against a squared distance because this program has no sqrt. It is the circle
/// inscribed in the `core` box, so it never claims a pixel the vent does not draw.
pub const CORE_X: i32 = {cx};
pub const CORE_Y: i32 = {cy};
pub const CORE_RADIUS_SQ: i32 = {crsq};

/// Where a volley leaves the boss: the `Boss.parts` index of the thorn that fires, and
/// the boss-local point it fires from.
#[derive(Clone, Copy)]
pub struct Muzzle {{
    /// Index into `Boss.parts` / [`PART_HITBOXES`]. Destroy that part and the emitter
    /// goes quiet — the gate is this index, so it cannot name a different limb than the
    /// one the muzzle sits in.
    pub part: usize,
    pub x: i32,
    pub y: i32,
}}

/// One entry per thorn the slicer found, in chain order.
pub const N_MUZZLES: usize = {len(muzzles)};

/// The volley emitters, derived from the same boxes `PART_HITBOXES` is derived from, in
/// the same pass. `tick.rs` used to describe the boss a second time here — first as
/// hand-written offsets that had drifted into the mace and the claws, then as a `const`
/// block re-deriving the centres beside its own copy of "which parts are thorns". Both
/// are the same defect: geometry stated twice. Move a thorn in the art, re-run the
/// command at the top of this file, and the muzzles move with it.
///
/// Each point is a DRAWN pixel — the one nearest that thorn's mask centroid, written into
/// `hitboxes.json` by `tools/gen_boss.py`. A thorn is a diagonal spike inside an
/// axis-aligned box that is mostly air, so the box centre is usually transparent: three of
/// the four volleys used to spawn in mid-air beside the creature, and thorn1's spawned
/// inside `beast_r`'s box. That is invisible while the boss is a circle and glaring the
/// moment the art is on screen.
#[rustfmt::skip]
pub const MUZZLES: [Muzzle; N_MUZZLES] = [
{muzzle_rows}
];

const _: () = {{
    // Every muzzle stands in the thorn it names. A muzzle is authored pixel data, not
    // derived from its box, so this is a real constraint rather than an identity — the
    // generator checks it too, and this catches a hand-edit of the generated file.
    let mut i = 0;
    while i < N_MUZZLES {{
        let m = MUZZLES[i];
        assert!(m.part < crate::state::N_PARTS);
        assert!(
            PART_HITBOXES[m.part].contains(m.x, m.y),
            "a muzzle is outside its own hitbox -- this file is generated, do not edit it",
        );
        i += 1;
    }}
}};

#[cfg(test)]
#[rustfmt::skip]
mod tests {{
    use super::*;
    use crate::map::TILE;
    use crate::state::N_PARTS;

    /// `handlers::shoot::raycast` in miniature: the FIRST part in index order whose box
    /// contains the sample wins. Every test below is about that one rule, because it is
    /// the rule that decides which limb a shot damages.
    fn first_match(x: i32, y: i32) -> Option<usize> {{
        PART_HITBOXES.iter().position(|r| r.contains(x, y))
    }}

    /// The union of the nine part boxes. Deliberately NOT exported: `shoot.rs` folds its
    /// own gate, which also has to cover the core circle, and two constants of the same
    /// name with different extents is the trap this file exists to prevent.
    fn parts_union() -> Rect {{
        let mut u = PART_HITBOXES[0];
        for r in PART_HITBOXES.iter() {{
            let (x0, y0) = (u.x.min(r.x), u.y.min(r.y));
            let (x1, y1) = ((u.x + u.w).max(r.x + r.w), (u.y + u.h).max(r.y + r.h));
            u = Rect {{ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }};
        }}
        u
    }}

    /// Every index `shoot.rs` and `tick.rs` reach for is in range and points at geometry.
    /// `shoot.rs` indexes `boss.parts[index]` straight out of the `PART_HITBOXES` walk;
    /// `tick.rs` gates each emitter on `boss.parts[muzzle.part]`.
    #[test]
    fn every_index_the_program_uses_exists() {{
        assert_eq!(PART_HITBOXES.len(), N_PARTS);
        assert_eq!(MUZZLES.len(), N_MUZZLES);
        for m in MUZZLES.iter() {{
            assert!(m.part < N_PARTS, "muzzle names part {{}} of {{}}", m.part, N_PARTS);
            assert!(
                PART_HITBOXES[m.part].contains(m.x, m.y),
                "muzzle for part {{}} is outside its own box",
                m.part,
            );
        }}
    }}

    /// A thorn is a volley emitter AND a target. If a lower-indexed box claims the point
    /// a thorn fires from, a player shooting at the horn shooting at them damages some
    /// other limb -- the defect the index renumbering exists to close. Assert the claim
    /// order and the paint order agree at the one point where it is provable.
    #[test]
    fn every_muzzle_resolves_to_its_own_part() {{
        for m in MUZZLES.iter() {{
            assert_eq!(
                first_match(m.x, m.y),
                Some(m.part),
                "part {{}} fires from a point another part claims",
                m.part,
            );
        }}
    }}

    /// Boxes overlap on purpose -- a diagonal spray inside an axis-aligned box is mostly
    /// air, and first-match resolves the overlap. What must never happen is a part being
    /// shadowed so completely that no ray can ever damage it. The floor is one tile of
    /// area, because the ray samples one point per tile: a region smaller than that can
    /// be stepped clean over.
    #[test]
    fn no_part_is_shadowed_out_of_the_fight() {{
        let tile = TILE as i32;
        for (i, r) in PART_HITBOXES.iter().enumerate() {{
            let mut reachable = 0i64;
            for y in r.y..r.y + r.h {{
                for x in r.x..r.x + r.w {{
                    if first_match(x, y) == Some(i) {{
                        reachable += 1;
                    }}
                }}
            }}
            assert!(
                reachable >= (tile * tile) as i64,
                "part {{}} keeps only {{}} of {{}} units of box: under one tile of area, so the raycast steps over it and the limb is unkillable",
                i,
                reachable,
                r.w as i64 * r.h as i64,
            );
        }}
    }}

    /// The vent is not a part: `raycast` tests it only after every box has missed, and
    /// `fire()` refuses `Hit::Core` while the shell is sealed. A part box overlapping the
    /// circle would make some of the vent permanently unhittable, since the box wins.
    #[test]
    fn the_vent_is_disjoint_from_every_part() {{
        for (i, r) in PART_HITBOXES.iter().enumerate() {{
            // Closest point on the box to the centre, then compare squared distances.
            let nx = CORE_X.max(r.x).min(r.x + r.w - 1);
            let ny = CORE_Y.max(r.y).min(r.y + r.h - 1);
            let (dx, dy) = (nx - CORE_X, ny - CORE_Y);
            assert!(
                dx * dx + dy * dy > CORE_RADIUS_SQ,
                "part {{}} overlaps the vent circle: that slice of the vent is unhittable",
                i,
            );
        }}
    }}

    /// The vent has to be findable by a ray that moves one tile at a time, and it has to
    /// sit on the creature -- inside the shell, not floating beside it.
    #[test]
    fn the_vent_is_where_the_spec_puts_it() {{
        let tile = TILE as i32;
        assert!(
            CORE_RADIUS_SQ >= tile * tile,
            "vent radius^2 {{}} is under one tile: a ray stepping by tiles would miss it",
            CORE_RADIUS_SQ,
        );
        // The WHOLE circle is on the creature, not just its centre: a vent hanging off
        // an edge is drawn glowing in mid-air beside the boss.
        let mut r = 0i32;
        while (r + 1) * (r + 1) <= CORE_RADIUS_SQ {{
            r += 1;
        }}
        let u = parts_union();
        assert!(CORE_X - r >= u.x && CORE_X + r <= u.x + u.w, "the vent hangs off the boss");
        assert!(CORE_Y - r >= u.y && CORE_Y + r <= u.y + u.h, "the vent hangs off the boss");
        // Where on the body is NOT asserted: the vent is the painting's own orb, authored
        // as the `core` polygon in `tools/gen_boss.py`, and the ram skull towering over the
        // chest puts it below the union's midpoint by construction.
    }}

    /// A sample outside every part box hits nothing -- the property `shoot.rs`'s early-out
    /// gate relies on. It folds its own, wider gate (it must also cover the core circle),
    /// so what is checked here is the half this file owns: the part boxes.
    #[test]
    fn nothing_is_hittable_outside_the_part_boxes() {{
        let u = parts_union();
        assert_eq!(first_match(u.x - 1, CORE_Y), None);
        assert_eq!(first_match(u.x + u.w, CORE_Y), None);
        assert_eq!(first_match(CORE_X, u.y - 1), None);
        assert_eq!(first_match(CORE_X, u.y + u.h), None);
    }}
}}
"""


def emit_ts(parts, anchor, core, muzzles, src, w, h, scale):
    ax, ay = anchor
    cx, cy, crsq = core
    rows = "\n".join(
        f"  {{ x: {x}, y: {y}, w: {rw}, h: {rh} }}, // {i} {name}"
        for i, (name, x, y, rw, rh) in enumerate(parts))
    tuple_t = ", ".join(["Rect"] * len(parts))
    muzzle_rows = "\n".join(
        f"  {{ part: {i}, x: {mx}, y: {my} }}, // {name}"
        for i, name, mx, my in muzzles)
    muzzle_t = ", ".join(["Muzzle"] * len(muzzles))
    return f"""{header(src, "//")}/**
 * Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y` -- the exact
 * numbers `programs/heartrot/src/hitboxes.rs` raycasts against, emitted from the same
 * JSON in the same pass. Client-side hit prediction that disagrees with the chain is
 * the bug this file exists to make impossible.
 *
 * `{src}` is in sprite pixels on a {w}x{h} canvas, origin top-left; one sprite pixel
 * is {scale} arena units. The two spaces differ by `local = sprite * BOSS_SCALE +
 * BOSS_ANCHOR_*` and nothing else -- the renderer must use exactly that, or the drawn
 * boss and the raycast boss stop being the same boss.
 */

/** A boss-local axis-aligned box, in arena units relative to `Boss.x` / `Boss.y`. */
export interface Rect {{
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}}

/** The source canvas, in SPRITE pixels. Multiply by {{@link BOSS_SCALE}} for arena units. */
export const BOSS_SPRITE_W = {w};
export const BOSS_SPRITE_H = {h};

/**
 * Arena units per sprite pixel. The renderer draws the sprite at
 * `scale(BOSS_SCALE)` inside the boss group; every number below is already scaled,
 * so nothing else in the client may multiply by it a second time.
 */
export const BOSS_SCALE = {scale};

/**
 * Where the SCALED sprite's top-left corner goes, relative to `Boss.x` / `Boss.y`.
 * The sprite's own viewBox is in unscaled pixels, so the group is exactly:
 *
 *     translate(boss.x + BOSS_ANCHOR_X, boss.y + BOSS_ANCHOR_Y) scale(BOSS_SCALE)
 *
 * in that order, and nothing else. It is the scaled canvas centre, derived from the
 * sprite's own dimensions -- import it rather than recomputing it, or the art and the
 * raycast drift apart again.
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

/** Where a volley leaves the boss: the `BossAccount.parts` index that fires, and the
 * boss-local point it fires from. */
export interface Muzzle {{
  readonly part: number;
  readonly x: number;
  readonly y: number;
}}

/**
 * The volley emitters — the exact points `programs/heartrot/src/hitboxes.rs` spawns
 * bullets at, emitted from the same JSON in the same pass, so a locally predicted volley
 * and the chain's volley leave the same thorn.
 *
 * Each point is a DRAWN pixel of its thorn -- the one nearest the mask centroid, written
 * by `tools/gen_boss.py` -- so a volley leaves paint and not the air beside it.
 */
export const MUZZLES: readonly [{muzzle_t}] = [
{muzzle_rows}
];
"""


if __name__ == '__main__':
    # Defaults resolve against the repo root, not the cwd, so `python3
    # tools/gen_hitboxes.py` does the right thing from anywhere.
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    a = argparse.ArgumentParser(description=__doc__)
    a.add_argument('src', nargs='?', default=f'{root}/assets/sprites/hitboxes.json')
    a.add_argument('-r', '--out-rust', default=f'{root}/programs/heartrot/src/hitboxes.rs')
    a.add_argument('-t', '--out-ts', default=f'{root}/packages/client/src/hitboxes.ts')
    a.add_argument('-s', '--scale', type=int, default=1,
                   help='arena units per sprite pixel (default 1: the boss is cut from '
                        'the room painting at one unit per pixel). It moves every hitbox, '
                        'muzzle, anchor and the core radius in one pass. PULLING THE LEVER '
                        'MEANS CHANGING THIS DEFAULT: --check re-derives with it, so a tree '
                        'generated at one scale and checked at another reads as stale.')
    a.add_argument('-m', '--map', default=f'{root}/assets/map/arena.json',
                   help='arena.json, for the pit-reachability check')
    a.add_argument('-c', '--check', action='store_true',
                   help='write nothing; exit non-zero if either checked-in file is stale')
    n = a.parse_args()

    if n.scale < 1:
        raise SystemExit('--scale must be at least 1')
    order, boxes, w, h = load(n.src)
    parts, anchor, core = to_local(boxes, order, w, h, n.scale)
    muzzles = to_muzzles(boxes, parts, anchor, n.scale)
    check_pit_reach(n.map, parts, core)
    rel = os.path.relpath(n.src, root)
    want = {n.out_rust: emit_rust(parts, anchor, core, muzzles, rel, w, h, n.scale),
            n.out_ts: emit_ts(parts, anchor, core, muzzles, rel, w, h, n.scale)}

    # `--check` IS the test for this tool: it re-derives both files and proves the
    # committed ones are what the art currently says. Anything that would silently
    # reintroduce the drift -- editing a generated file, moving a part in
    # gen_boss.py and not re-running -- fails here loudly.
    if n.check:
        stale = [p for p, text in want.items()
                 if not os.path.exists(p) or open(p).read() != text]
        if stale:
            raise SystemExit("STALE, re-run `%s`:\n  %s" % (REGEN, "\n  ".join(stale)))
    else:
        for p, text in want.items():
            open(p, 'w').write(text)

    print(f"scale {n.scale}  anchor {anchor}  sprite {w}x{h}")
    for i, (name, x, y, rw, rh) in enumerate(parts):
        print(f"{i:>2}  {name:<8} {x:4},{y:4} {rw:3}x{rh:3}")
    print(f" -  core     {core[0]:4},{core[1]:4} r^2={core[2]}")
    for i, name, mx, my in muzzles:
        print(f"{i:>2}  {name:<8} muzzle {mx:4},{my:4}")
    print(f"\n{n.out_rust}\n{n.out_ts}")
