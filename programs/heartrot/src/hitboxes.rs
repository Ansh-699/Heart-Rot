//! @generated from assets/sprites/hitboxes.json by `python3 tools/gen_hitboxes.py` -- DO NOT EDIT.
//!
//! Hand-editing this file re-creates the defect it exists to close: the drawn
//! boss and the raycast boss stop being the same boss. Move the art, re-run
//! `python3 tools/gen_boss.py`, then re-run the command above.
//!
//! Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y`.
//!
//! `assets/sprites/hitboxes.json` is in sprite pixels on a 318x604 canvas, origin top-left; one sprite
//! pixel is 1 arena units (`--scale 1`, a generator argument and never a
//! constant here). `Boss.x`/`Boss.y` is the centre of that scaled canvas, so the two
//! spaces differ by `local = sprite * 1 + (-159, -302)` and nothing else -- no
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
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    /// Half-open on both axes, so touching rectangles cannot both claim a step.
    pub const fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// Index-aligned with `Boss.parts`. The length is written as `crate::state::N_PARTS`
/// on purpose: if the slicer's `part_index` and the on-chain array ever disagree,
/// this file stops compiling instead of silently mis-indexing a limb.
///
/// Every box is at least `TILE` (16) units on both axes -- the generator refuses to
/// emit one that is not, because the ray samples one point per tile and would step
/// straight over anything thinner.
#[rustfmt::skip]
pub const PART_HITBOXES: [Rect; crate::state::N_PARTS] = [
    Rect { x:  -79, y: -254, w:  27, h:  59 }, // 0 thorn0
    Rect { x:   59, y: -245, w:  36, h:  52 }, // 1 thorn1
    Rect { x: -158, y:  -76, w:  50, h:  27 }, // 2 thorn2
    Rect { x:   85, y: -132, w:  33, h:  83 }, // 3 thorn3
    Rect { x:  -49, y: -301, w: 125, h: 118 }, // 4 crown
    Rect { x: -147, y: -223, w: 100, h: 116 }, // 5 wolf_l
    Rect { x:   25, y: -222, w: 131, h: 107 }, // 6 beast_r
    Rect { x: -129, y: -114, w:  67, h: 106 }, // 7 mace
    Rect { x:   33, y: -120, w:  87, h: 113 }, // 8 claws
];

/// The vent: centre offset from `Boss.x`/`Boss.y` and a *squared* radius, compared
/// against a squared distance because this program has no sqrt. It is the circle
/// inscribed in the `core` box, so it never claims a pixel the vent does not draw.
pub const CORE_X: i32 = -15;
pub const CORE_Y: i32 = -108;
pub const CORE_RADIUS_SQ: i32 = 1024;

/// Where a volley leaves the boss: the `Boss.parts` index of the thorn that fires, and
/// the boss-local point it fires from.
#[derive(Clone, Copy)]
pub struct Muzzle {
    /// Index into `Boss.parts` / [`PART_HITBOXES`]. Destroy that part and the emitter
    /// goes quiet — the gate is this index, so it cannot name a different limb than the
    /// one the muzzle sits in.
    pub part: usize,
    pub x: i32,
    pub y: i32,
}

/// One entry per thorn the slicer found, in chain order.
pub const N_MUZZLES: usize = 4;

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
    Muzzle { part: 0, x:  -67, y: -222 }, // thorn0
    Muzzle { part: 1, x:   77, y: -217 }, // thorn1
    Muzzle { part: 2, x: -130, y:  -62 }, // thorn2
    Muzzle { part: 3, x:  102, y:  -93 }, // thorn3
];

const _: () = {
    // Every muzzle stands in the thorn it names. A muzzle is authored pixel data, not
    // derived from its box, so this is a real constraint rather than an identity — the
    // generator checks it too, and this catches a hand-edit of the generated file.
    let mut i = 0;
    while i < N_MUZZLES {
        let m = MUZZLES[i];
        assert!(m.part < crate::state::N_PARTS);
        assert!(
            PART_HITBOXES[m.part].contains(m.x, m.y),
            "a muzzle is outside its own hitbox -- this file is generated, do not edit it",
        );
        i += 1;
    }
};

#[cfg(test)]
#[rustfmt::skip]
mod tests {
    use super::*;
    use crate::map::TILE;
    use crate::state::N_PARTS;

    /// `handlers::shoot::raycast` in miniature: the FIRST part in index order whose box
    /// contains the sample wins. Every test below is about that one rule, because it is
    /// the rule that decides which limb a shot damages.
    fn first_match(x: i32, y: i32) -> Option<usize> {
        PART_HITBOXES.iter().position(|r| r.contains(x, y))
    }

    /// The union of the nine part boxes. Deliberately NOT exported: `shoot.rs` folds its
    /// own gate, which also has to cover the core circle, and two constants of the same
    /// name with different extents is the trap this file exists to prevent.
    fn parts_union() -> Rect {
        let mut u = PART_HITBOXES[0];
        for r in PART_HITBOXES.iter() {
            let (x0, y0) = (u.x.min(r.x), u.y.min(r.y));
            let (x1, y1) = ((u.x + u.w).max(r.x + r.w), (u.y + u.h).max(r.y + r.h));
            u = Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
        u
    }

    /// Every index `shoot.rs` and `tick.rs` reach for is in range and points at geometry.
    /// `shoot.rs` indexes `boss.parts[index]` straight out of the `PART_HITBOXES` walk;
    /// `tick.rs` gates each emitter on `boss.parts[muzzle.part]`.
    #[test]
    fn every_index_the_program_uses_exists() {
        assert_eq!(PART_HITBOXES.len(), N_PARTS);
        assert_eq!(MUZZLES.len(), N_MUZZLES);
        for m in MUZZLES.iter() {
            assert!(m.part < N_PARTS, "muzzle names part {} of {}", m.part, N_PARTS);
            assert!(
                PART_HITBOXES[m.part].contains(m.x, m.y),
                "muzzle for part {} is outside its own box",
                m.part,
            );
        }
    }

    /// A thorn is a volley emitter AND a target. If a lower-indexed box claims the point
    /// a thorn fires from, a player shooting at the horn shooting at them damages some
    /// other limb -- the defect the index renumbering exists to close. Assert the claim
    /// order and the paint order agree at the one point where it is provable.
    #[test]
    fn every_muzzle_resolves_to_its_own_part() {
        for m in MUZZLES.iter() {
            assert_eq!(
                first_match(m.x, m.y),
                Some(m.part),
                "part {} fires from a point another part claims",
                m.part,
            );
        }
    }

    /// Boxes overlap on purpose -- a diagonal spray inside an axis-aligned box is mostly
    /// air, and first-match resolves the overlap. What must never happen is a part being
    /// shadowed so completely that no ray can ever damage it. The floor is one tile of
    /// area, because the ray samples one point per tile: a region smaller than that can
    /// be stepped clean over.
    #[test]
    fn no_part_is_shadowed_out_of_the_fight() {
        let tile = TILE as i32;
        for (i, r) in PART_HITBOXES.iter().enumerate() {
            let mut reachable = 0i64;
            for y in r.y..r.y + r.h {
                for x in r.x..r.x + r.w {
                    if first_match(x, y) == Some(i) {
                        reachable += 1;
                    }
                }
            }
            assert!(
                reachable >= (tile * tile) as i64,
                "part {} keeps only {} of {} units of box: under one tile of area, so the raycast steps over it and the limb is unkillable",
                i,
                reachable,
                r.w as i64 * r.h as i64,
            );
        }
    }

    /// The vent is not a part: `raycast` tests it only after every box has missed, and
    /// `fire()` refuses `Hit::Core` while the shell is sealed. A part box overlapping the
    /// circle would make some of the vent permanently unhittable, since the box wins.
    #[test]
    fn the_vent_is_disjoint_from_every_part() {
        for (i, r) in PART_HITBOXES.iter().enumerate() {
            // Closest point on the box to the centre, then compare squared distances.
            let nx = CORE_X.max(r.x).min(r.x + r.w - 1);
            let ny = CORE_Y.max(r.y).min(r.y + r.h - 1);
            let (dx, dy) = (nx - CORE_X, ny - CORE_Y);
            assert!(
                dx * dx + dy * dy > CORE_RADIUS_SQ,
                "part {} overlaps the vent circle: that slice of the vent is unhittable",
                i,
            );
        }
    }

    /// The vent has to be findable by a ray that moves one tile at a time, and it has to
    /// sit on the creature -- inside the shell, not floating beside it.
    #[test]
    fn the_vent_is_where_the_spec_puts_it() {
        let tile = TILE as i32;
        assert!(
            CORE_RADIUS_SQ >= tile * tile,
            "vent radius^2 {} is under one tile: a ray stepping by tiles would miss it",
            CORE_RADIUS_SQ,
        );
        // The WHOLE circle is on the creature, not just its centre: a vent hanging off
        // an edge is drawn glowing in mid-air beside the boss.
        let mut r = 0i32;
        while (r + 1) * (r + 1) <= CORE_RADIUS_SQ {
            r += 1;
        }
        let u = parts_union();
        assert!(CORE_X - r >= u.x && CORE_X + r <= u.x + u.w, "the vent hangs off the boss");
        assert!(CORE_Y - r >= u.y && CORE_Y + r <= u.y + u.h, "the vent hangs off the boss");
        // Where on the body is NOT asserted: the vent is the painting's own orb, authored
        // as the `core` polygon in `tools/gen_boss.py`, and the ram skull towering over the
        // chest puts it below the union's midpoint by construction.
    }

    /// A sample outside every part box hits nothing -- the property `shoot.rs`'s early-out
    /// gate relies on. It folds its own, wider gate (it must also cover the core circle),
    /// so what is checked here is the half this file owns: the part boxes.
    #[test]
    fn nothing_is_hittable_outside_the_part_boxes() {
        let u = parts_union();
        assert_eq!(first_match(u.x - 1, CORE_Y), None);
        assert_eq!(first_match(u.x + u.w, CORE_Y), None);
        assert_eq!(first_match(CORE_X, u.y - 1), None);
        assert_eq!(first_match(CORE_X, u.y + u.h), None);
    }
}
