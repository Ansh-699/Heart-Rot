//! @generated from assets/sprites/hitboxes.json by `python3 tools/gen_hitboxes.py` -- DO NOT EDIT.
//!
//! Hand-editing this file re-creates the defect it exists to close: the drawn
//! boss and the raycast boss stop being the same boss. Move the art, re-run
//! `python3 tools/svg_slice.py`, then re-run the command above.
//!
//! Boss-local hitboxes, in arena units relative to `Boss.x` / `Boss.y`.
//!
//! `assets/sprites/hitboxes.json` is in sprite pixels on a 230x270 canvas, origin top-left; one sprite
//! pixel is one arena unit. `Boss.x`/`Boss.y` is the centre of that canvas, so the
//! two spaces differ by the translation (-115, -135) and nothing else -- no scale,
//! no flip. See the tool's docstring for the derivation.

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
pub const PART_HITBOXES: [Rect; crate::state::N_PARTS] = [
    Rect { x:    7, y: -128, w:  67, h:  59 }, // 0 crown
    Rect { x:  -47, y:  -86, w:  50, h:  53 }, // 1 wolf_l
    Rect { x:   57, y:  -83, w:  46, h:  52 }, // 2 beast_r
    Rect { x:  -16, y: -107, w:  21, h:  36 }, // 3 thorn0
    Rect { x:   65, y:  -98, w:  48, h:  65 }, // 4 thorn1
    Rect { x:  -30, y:  -37, w:  20, h:  23 }, // 5 thorn2
    Rect { x:   88, y:   -8, w:  24, h:  17 }, // 6 thorn3
    Rect { x: -114, y:  -33, w: 111, h: 137 }, // 7 mace
    Rect { x:   55, y:  -38, w:  52, h: 110 }, // 8 claws
];

/// The vent: centre offset from `Boss.x`/`Boss.y` and a *squared* radius, compared
/// against a squared distance because this program has no sqrt. It is the circle
/// inscribed in the `core` box, so it never claims a pixel the vent does not draw.
pub const CORE_X: i32 = 25;
pub const CORE_Y: i32 = -18;
pub const CORE_RADIUS_SQ: i32 = 400;
