//! The boss's body as a movement barrier.
//!
//! The pit is the whole painted dais and the creature stands in the middle of it: a
//! raider walks the circle, and must not walk through the boss. That barrier cannot be
//! wall -- `shoot`'s raycast tests `is_wall` before any part box, so wall tiles under the
//! boss would make it unhittable from every column it covers. It cannot be a tile mask
//! either, because the body is not a fact about the map: it is the hitbox table, which
//! the art pipeline moves and `hitboxes.rs` is generated from. So it is the union of the
//! nine part boxes, folded out of that table at compile time, and `handlers::player`
//! refuses a step whose destination lies inside it at `map::BOSS_SPAWN`. The boss never
//! moves -- `init` writes `BOSS_SPAWN` on every spawn and respawn and `tick` never
//! touches `Boss.x`/`Boss.y` -- so the spawn is the position, and `move_player` needs no
//! `Boss` account to know where the body is.
//!
//! `handlers::shoot::SHELL_AABB` is this same fold widened by the core circle: two folds
//! of one generated table, deliberately, until `shoot.rs` is next opened -- it was not
//! this change's file. The client mirror is `packages/client/src/body.ts`, which folds
//! the same generated `PART_HITBOXES` so prediction refuses the step the chain refuses.

use crate::hitboxes::{Rect, PART_HITBOXES};
use crate::map::BOSS_SPAWN;

/// The union of every part box, boss-local, in arena units. Half-open like every
/// [`Rect`], so the unit just outside the claws is a stand and the unit inside is not.
pub const BOSS_BODY: Rect = {
    let mut u = PART_HITBOXES[0];
    let mut i = 1;
    while i < PART_HITBOXES.len() {
        let p = PART_HITBOXES[i];
        let x0 = if p.x < u.x { p.x } else { u.x };
        let y0 = if p.y < u.y { p.y } else { u.y };
        let x1 = if p.x + p.w > u.x + u.w { p.x + p.w } else { u.x + u.w };
        let y1 = if p.y + p.h > u.y + u.h { p.y + p.h } else { u.y + u.h };
        u = Rect {
            x: x0,
            y: y0,
            w: x1 - x0,
            h: y1 - y0,
        };
        i += 1;
    }
    u
};

/// Is this arena-space point inside the boss's body, with the boss at [`BOSS_SPAWN`]?
pub fn in_body(x: i16, y: i16) -> bool {
    BOSS_BODY.contains(x as i32 - BOSS_SPAWN.0 as i32, y as i32 - BOSS_SPAWN.1 as i32)
}

const _: () = {
    // The body at its spawn lies inside the map, so the i16 world coordinates a caller
    // hands `in_body` never need a range check of their own.
    let (bx, by) = (BOSS_SPAWN.0 as i32, BOSS_SPAWN.1 as i32);
    let edge = (crate::map::MAP_TILES as i32) * (crate::map::TILE as i32);
    assert!(bx + BOSS_BODY.x >= 0 && by + BOSS_BODY.y >= 0);
    assert!(bx + BOSS_BODY.x + BOSS_BODY.w <= edge && by + BOSS_BODY.y + BOSS_BODY.h <= edge);
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The fold is the bounding box and nothing looser: every part box lies inside it and
    /// each of its four edges is some part's edge. A box that was merely a superset would
    /// keep a raider off floor no limb occupies, and a hand-typed one would be the drift
    /// `hitboxes.rs`'s header warns about.
    #[test]
    fn the_body_is_the_tight_union_of_the_part_boxes() {
        let (mut left, mut top, mut right, mut bottom) = (false, false, false, false);
        for p in PART_HITBOXES.iter() {
            assert!(p.x >= BOSS_BODY.x && p.x + p.w <= BOSS_BODY.x + BOSS_BODY.w);
            assert!(p.y >= BOSS_BODY.y && p.y + p.h <= BOSS_BODY.y + BOSS_BODY.h);
            left |= p.x == BOSS_BODY.x;
            top |= p.y == BOSS_BODY.y;
            right |= p.x + p.w == BOSS_BODY.x + BOSS_BODY.w;
            bottom |= p.y + p.h == BOSS_BODY.y + BOSS_BODY.h;
        }
        assert!(left && top && right && bottom, "the fold is looser than the table");

        // Half-open at the spawn: the last unit inside is body, the next one is floor.
        let (bx, by) = BOSS_SPAWN;
        let x1 = bx + BOSS_BODY.x as i16 + BOSS_BODY.w as i16;
        let y1 = by + BOSS_BODY.y as i16 + BOSS_BODY.h as i16;
        assert!(in_body(x1 - 1, y1 - 1) && !in_body(x1, y1 - 1) && !in_body(x1 - 1, y1));
        assert!(in_body(bx + BOSS_BODY.x as i16, by + BOSS_BODY.y as i16));
        assert!(!in_body(bx + BOSS_BODY.x as i16 - 1, by + BOSS_BODY.y as i16 - 1));
    }
}
