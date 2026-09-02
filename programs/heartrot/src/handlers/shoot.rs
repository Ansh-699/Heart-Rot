//! `shoot(seat, dx, dy, charged)` — the player attack, hitscan, free aim.
//!
//! No projectile entity is ever allocated. The ray is walked here, in integer steps of
//! one tile, and the damage lands in the same transaction that fired it. That is the
//! whole point of the asymmetry in the design spec §3: the player's own fire must
//! feel instant, so it resolves at send time and the visible tracer is client-side
//! animation only; incoming fire must be dodgeable, so the boss gets travel time and
//! a pooled bullet array advanced by the crank. `MAX_BULLETS` is boss ordnance and
//! nothing a player does can consume a slot of it — twenty shooters put **zero**
//! bullets in the pool, so there is no starvation to police here
//! (`docs/architecture/09-shooting.md` §3.1).
//!
//! Three consequences worth stating, because all three are security properties:
//!
//! - **The cooldown is counted in `Arena.tick`, never milliseconds.** Ticks are the
//!   only clock the ER agrees on — `TICK_MS` is the crank's target, not a contract —
//!   and a wall-clock cooldown would pay out to whoever has the lowest ping. Ticks make
//!   fire rate identical from Ghaziabad and from Frankfurt.
//! - **The cooldown is spent by the attempt, not by the hit.** ER transaction fees
//!   are 0 lamports and the ER runs no fee-payer validation at all, so nothing debits
//!   a spammer (D16). `last_shot_tick` *is* the rate limiter; refunding it on a miss
//!   would hand an attacker an unlimited-rate instruction.
//! - **The charged shot is stateless, and its clock is the ER slot.** A `charged` shot
//!   deals `state::charged_damage` (2.5×) only if the seat's last accepted step is at
//!   least `state::CHARGE_SLOTS` ER slots old — `Clock::get()?.slot` against
//!   `last_move_tick`, which `player::move_clock` stamps from that same sysvar. No
//!   charge timer is stored, so a client cannot start one early, and a step cancels the
//!   hold because it moves the stamp. It is **never** `arena.tick`: that is a crank tick
//!   on another clock, and subtracting the two is the trap `state::SLOT_MS` names. A
//!   short hold is [`HeartrotError::NotCharged`], refused *before* the cooldown is spent,
//!   so the client resends uncharged and the shot is not lost.
//!
//! **Aim is free, not eight-way** (`11-immortals-spec.md` §4.1). With the boss fixed at
//! top centre, a 45° quantisation step can only select a target whose angular size
//! exceeds 45°; measured over 110 pit stands, 8-way aim reaches 5 of 10 targets and
//! **never the core**, from anywhere, at any range. The raid would be unwinnable with no
//! error anywhere. The wire therefore carries the raw `(dx: i8, dy: i8)` the pointer
//! produced and this file normalises it, with the same alpha-max-plus-beta-min routine
//! `tick.rs::unit_velocity` uses on boss ordnance — no table, no generator, no account
//! byte, 0.2354° worst-case direction error over 200,000 angles.
//!
//! **Two classes, one byte, no migration.** The knight (40 damage / 800 ms) and the archer
//! (70 / 1400 ms) are 50 DPS apiece by construction, so the boss needs no rescale. The
//! choice rides bit 7 of `PlayerSlot::class_aim` and the aim it fired along rides bits 6..0
//! of the same byte; nothing grows, nothing moves, and every seat already on chain reads
//! class 0 — the knight it already was. **No projectile is allocated for either class.**
//! The arrows the player sees are a client-side tracer over the same generated tables this
//! file raycasts; putting them in `arena.bullets` was measured at +718 CU per live
//! projectile per tick and rejected on latency, not cost — a projectile puts 229 ms to
//! 1.26 s of flight between the key and the damage, on the one axis the design protects
//! (`17-fullscreen-spec.md` §4.1, §5).
//!
//! **What this file is *not* the fix for.** The reported dead spacebar in the waiting area
//! never reaches this program: `app/src/input/controls.ts` gates the trigger on
//! `phase === PHASE_FIGHTING` before it builds anything, so no transaction is signed and
//! no refusal is issued. Every refusal this file *can* issue is already a distinct code —
//! `WrongPhase`, `WrongZone`, `PlayerDead`, `RateLimited` — and none of them was ever
//! returned for that key press. See [`phase_takes_fire`].
//!
//! **Cost, stated because it is the thing that grew.** `MAX_RAY_STEPS` went 20 → 64 with
//! the arena, so the loop bound tripled, and at `SCALE = 3` the creature covers a third
//! of the map — which is what the [`SHELL_AABB`] gate is for.
//!
//! Counted over 891,392 rays — every floor tile of the generated map × 256 aim
//! directions, against the generated S=3 boss at `BOSS_SPAWN`: **7.56 steps and 2.08 rect
//! scans on the mean ray; worst 62 steps and 40 scans.** So the worst shot is 62 wall
//! lookups + 62 box compares + 360 rect tests + 40 core tests ≈ **520 integer
//! operations**, with no account read and no syscall among them; the mean shot is under
//! 40. Without the gate every one of the 62 steps runs the nine-rect scan — 558 rect
//! tests on *every* shot, not just the worst one. A `shoot` transaction's budget goes to
//! three account deserialisations and five guards, not to the ray.
//!
//! Two honesty notes. That sweep ran in a scratch harness (`cargo test`, whole-map loop),
//! not on chain, so it is an operation count and not a CU number; the CU number is
//! acceptance item 10 of 09-shooting §6 and is still open. And 09-shooting §8.4's
//! published 32.1 steps / 0.32 scans were taken at 1:1 scale against an assumed map — the
//! scan count is 6.5× that at S=3, which is the figure to re-take if `--scale` moves.
//!
//! Everything below is integer. Squared distances are compared against squared radii;
//! there is no `sqrt` and no float anywhere, because a float would make the client's
//! local hit prediction disagree with the chain by exactly the amount that makes a
//! shot look like it landed and score nothing.

use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::error::HeartrotError;
use crate::guards::{
    assert_owned_by, assert_pda_at_bump, assert_session_authority, assert_signer, assert_writable,
};
use crate::handlers::player::octant;
use crate::hitboxes::{Rect, CORE_RADIUS_SQ, CORE_X, CORE_Y, PART_HITBOXES};
use crate::map::{MAP_TILES, TILE, WALLS};
use crate::state::{
    charged_damage, load_mut, vent_pct, Arena, Boss, PlayerSlot, Players, CHARGED_SHOT_BIT,
    CHARGE_SLOTS, CLASS_COOLDOWN_TICKS as CLASS_COOLDOWN, CLASS_DAMAGE, OUTCOME_WIN,
    PHASE_FIGHTING, SEED_BOSS, SEED_PLAYERS, ZONE_ARENA,
};

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------
//
// There is no `TILE` and no `ARENA_SIZE` in this file. Both are `crate::map`'s, compiled
// out of `assets/map/arena.json` alongside the wall table itself, and the ray casts
// `map::TILE` to `i32` at the two places it needs the wider type rather than restating
// the number. A local copy of a tile size is the same defect as a local copy of a
// hitbox: it survives a redraw of the map that it is supposed to describe.

/// The ray advances one tile per step and gives up after this many. **Derived from the
/// map, never tuned**: a shot has to be able to cross the arena it is fired in, and with
/// the boss at top centre and the pit at the bottom the worst stand-to-core range is 865
/// units (11-immortals-spec §4.1) against the 320 the old hand-tuned 20 reached. Two
/// thirds of pit stands could not touch the boss at all.
const MAX_RAY_STEPS: i32 = MAP_TILES as i32;

/// Q12 fixed point for the ray's sub-tile position. The direction is normalised once and
/// then accumulated, so the step is a whole tile *along the aim line* rather than a whole
/// tile on each axis — which is the entire difference between eight directions and all of
/// them.
const Q: i32 = 4096;

/// Worst-case stand-to-core range in the pit, from 11-immortals-spec §4.1's reachability
/// sweep. It is here to be compared against, not to be used.
const WORST_RANGE: i32 = 865;

// The normaliser is alpha-max-plus-beta-min, so `approx_len` overestimates the true length
// by at most 11.8% and a step is therefore never shorter than 0.894 x TILE. Reach is the
// short step times the loop bound; if it ever stops covering the pit, the shot silently
// dies in mid-air with no error anywhere, which is why this is a compile-time check and
// not a comment.
const _: () = assert!(
    MAX_RAY_STEPS * TILE as i32 * 894 / 1000 >= WORST_RANGE,
    "MAX_RAY_STEPS no longer reaches across the pit -- see docs/architecture/09-shooting.md §2.5",
);

/// Is the tile under this arena-space point solid? Off-map is solid, and negatives are
/// walls *before* the divide because `-1 / 16` truncates to tile 0.
///
/// This is the same decision as `handlers::player::is_wall`, over the same generated
/// `map::WALLS` table — that one is `i16` and private to movement, this one is the `i32`
/// the ray already walks in. One table, so a corridor that blocks a step also blocks a
/// shot.
///
/// Note what is *not* a wall: the boss air above the pit. A single wall tile in a column
/// kills every shot in it, so the pit ceiling is a movement clamp (`map::PIT_TOP`), never
/// geometry.
fn is_wall(x: i32, y: i32) -> bool {
    if x < 0 || y < 0 {
        return true;
    }
    let (tx, ty) = ((x / TILE as i32) as usize, (y / TILE as i32) as usize);
    if tx >= MAP_TILES {
        return true;
    }
    match WALLS.get(ty) {
        Some(row) => row & (1u64 << tx) != 0,
        None => true,
    }
}

// ---------------------------------------------------------------------------
// Balance knobs
// ---------------------------------------------------------------------------

/// The two classes, and the one byte that carries a seat's choice.
///
/// The class lives in **bit 7 of [`PlayerSlot::class_aim`]** (offset 3, between `skin_id`
/// and `x`, and what used to be `_pad0`). Bits 6..0 of the same byte carry the aim this
/// file encodes below. Nothing about the account moves: `PlayerSlot` stays 96 bytes,
/// `LAYOUT_VERSION` stays 1, and every seat already on devnet carries 0 there — which is
/// why **class 0 must be the knight**, the behaviour those seats have today. There is no
/// migration, and that is the point (17-fullscreen-spec §5.1).
/// Index forms of `state::CLASS_KNIGHT` / `CLASS_ARCHER`, which are `u8` because they are
/// written into the account byte. **Derived, never restated** — the numbers themselves,
/// and the tables they index, live in `state.rs` beside the byte that carries them.
const CLASS_KNIGHT: usize = crate::state::CLASS_KNIGHT as usize;
const CLASS_ARCHER: usize = crate::state::CLASS_ARCHER as usize;

// Checks, not a second copy of the table: every name below is `state.rs`'s. `state.rs`
// asserts DPS neutrality and that class 0 is the knight; these two are the shape of the
// class that nothing else states — "slower and heavier" — and a balance edit that inverts
// it is otherwise silent, because the raid just gets longer or shorter and nothing says why.
const _: () = {
    assert!(CLASS_COOLDOWN[CLASS_ARCHER] > CLASS_COOLDOWN[CLASS_KNIGHT]);
    assert!(CLASS_DAMAGE[CLASS_ARCHER] > CLASS_DAMAGE[CLASS_KNIGHT]);
};

// There is deliberately **no per-class range**. Measured over 214 pit stands, aimed
// steps-to-end is p50 6 / p95 11 / max 13 against `MAX_RAY_STEPS` = 64, so a range knob
// would have to cut below 13 to change anything at all — which makes a class unplayable
// rather than different (§5.2). Range is bounded by the walls and by the map, and the test
// `no_shot_at_the_boss_can_die_of_range` holds that.

/// Which class this seat fires as. `PlayerSlot::class` is the one decoder; `>> 7` on a
/// `u8` is total, so the index is 0 or 1 and the table lookups need no bounds check.
fn class_of(slot: &PlayerSlot) -> usize {
    slot.class() as usize
}

/// Pack `(dx, dy)` into bits 6..0: three bits of 45° sector, four bits of tangent ratio.
///
/// This exists so a remote client can draw an arrow along the direction the shot was
/// *actually* taken in. `facing` is eight-way, so an arrow drawn from it is up to 22.5°
/// off — 116 units of lateral error at the median 280-unit boss range — and it snaps
/// mid-flight the moment its shooter takes a step, because `move` rewrites `facing` every
/// 50 ms. Nineteen of every twenty arrows on screen are somebody else's.
///
/// Worst reconstruction error is 1.90°, from the quarter-step of a 16-level ratio; a
/// second class bit would cost 4.05° and a 62-unit miss, which is why **two classes is
/// the byte's budget, not a preference** (§5.3).
///
/// Widen to `i32` before `abs`: `i8::MIN.abs()` overflows, `overflow-checks = true` on the
/// release profile turns that into a panic on chain, and `-128` is a legal wire value that
/// any caller can send. This is the same trap [`unit_q12`] documents one screen up.
/// Test-only, and deliberately a *delegation*: the sweep below is the specification of
/// the encoding, so it has to run the encoder that actually ships. A second
/// implementation here would let the two drift and the test would keep passing.
#[cfg(test)]
fn encode_aim(dx: i8, dy: i8) -> u8 {
    let mut probe = <PlayerSlot as bytemuck::Zeroable>::zeroed();
    probe.set_aim(dx, dy);
    probe.class_aim
}

/// `Boss.vent_open`. 1 open, 0 sealed.
const VENT_OPEN: u8 = 1;

/// The percentage the vent threshold is expressed in: the comparison is
/// `sum(parts) × PERCENT < sum(parts_max) × vent_pct(raid_size)`, so no percentage is
/// ever a float.
const PERCENT: u32 = 100;

/// Recompute `Boss.vent_open` from the parts and the raid, and answer whether it is open.
///
/// The vent is **derived state**, cached on the account for the client — never set
/// independently, or it drifts out of agreement with the numbers it summarises. This is
/// the only place in the program that writes it: here it runs on the same line that
/// changed a part, so "the shell crossed the threshold" and "the vent is open" cannot be
/// two different facts, and `boss_tick` calls it every tick because the threshold moves
/// with `Arena.raid_size`, which only the tick can raise.
///
/// `raid_size` is `Arena.raid_size`, the high-water mark of raiders this incarnation, and
/// `state::vent_pct` turns it into the threshold: 65 % of the shell standing for a raid of
/// one, 35 % for twenty. Passed in rather than read off an `Arena` so the function stays
/// callable on a bare `Boss` — which is how every vent test in this file drives it.
///
/// The sums cannot overflow `u32` (9 × 65,535 × 100 ≈ 59 M) but are saturating anyway.
pub(crate) fn recompute_vent(boss: &mut Boss, raid_size: u8) -> bool {
    let shell: u32 = boss.parts.iter().map(|&hp| hp as u32).sum();
    let shell_max: u32 = boss.parts_max.iter().map(|&hp| hp as u32).sum();
    let open = shell.saturating_mul(PERCENT) < shell_max.saturating_mul(vent_pct(raid_size));
    boss.vent_open = u8::from(open);
    open
}

// ---------------------------------------------------------------------------
// Hitboxes
// ---------------------------------------------------------------------------
//
// There is no table here. `crate::hitboxes` is generated from
// `assets/sprites/hitboxes.json` by `tools/gen_hitboxes.py`, in the same pass that
// emits the TypeScript the renderer draws from, so the boss the player sees and the
// boss the ray hits are one fact. The hand-written table this file used to carry
// described a different creature — six of its nine parts had zero overlap with the art
// and two were on the wrong side — which is what a second copy of a fact always
// becomes. Move the art, re-run the tool; never edit coordinates here.

/// Smallest `r` with `r * r >= n`. Const, integer, and only ever called on
/// `CORE_RADIUS_SQ`, which is at most a few thousand — so the loop is a compile-time
/// rounding error.
const fn isqrt_ceil(n: i32) -> i32 {
    let mut r = 0;
    while r * r < n {
        r += 1;
    }
    r
}

/// The union of every part box and the core circle, **folded out of the generated table
/// at compile time**. A hand-written bounding box for a generated table is the exact
/// defect `hitboxes.rs`'s own header warns about, so this is derived and never typed:
/// re-scale the art with `gen_hitboxes.py --scale N` and this moves with it.
///
/// One four-compare test per ray step replaces nine rect tests plus a core test on every
/// step that is nowhere near the creature — measured 72% of them at S=3, and the gate is
/// what stops the 62-step loop from running 558 rect tests on every shot.
///
/// Widened by `isqrt_ceil(CORE_RADIUS_SQ) + 1` on the core's side because [`Rect`] is
/// half-open: without the `+ 1` the point exactly on the core's rightmost pixel would
/// pass the circle test and fail the box that is supposed to contain it.
const SHELL_AABB: Rect = {
    let r = isqrt_ceil(CORE_RADIUS_SQ) + 1;
    let (mut x0, mut y0) = (CORE_X - r, CORE_Y - r);
    let (mut x1, mut y1) = (CORE_X + r, CORE_Y + r);
    let mut i = 0;
    while i < PART_HITBOXES.len() {
        let p = PART_HITBOXES[i];
        if p.x < x0 {
            x0 = p.x;
        }
        if p.y < y0 {
            y0 = p.y;
        }
        if p.x + p.w > x1 {
            x1 = p.x + p.w;
        }
        if p.y + p.h > y1 {
            y1 = p.y + p.h;
        }
        i += 1;
    }
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
};

/// What the ray struck first, as pure geometry. Whether a `Core` hit is *damageable*
/// is a game rule (the vent must be open) and is decided by the caller, not here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hit {
    Part(usize),
    Core,
}

/// Normalise a raw aim vector to a Q12 unit vector, or `None` for the zero vector.
///
/// alpha-max-plus-beta-min, the same routine `tick.rs::unit_velocity` runs on boss
/// ordnance — no `sqrt`, no float, no table. It overestimates the true length by at most
/// 11.8%, so a `TILE`-long step along the result is 0.894..1.000 of a tile: never longer
/// than one, which is what keeps the ray's one-sample-per-tile walk honest.
///
/// Measured over 200,000 angles end to end through the browser's scaling and this
/// normalisation, the worst direction error is 0.2354° — a 3.55-unit lateral miss at the
/// pit's 865-unit worst-case range, a fifth of a player radius (09-shooting §8.2).
fn unit_q12(dx: i8, dy: i8) -> Option<(i32, i32)> {
    // Widen before `abs`: `i8::MIN.abs()` overflows, and -128 is a legal wire value.
    let (vx, vy) = (dx as i32, dy as i32);
    let (ax, ay) = (vx.abs(), vy.abs());
    let approx_len = if ax > ay { ax + ay / 2 } else { ay + ax / 2 };
    if approx_len == 0 {
        return None;
    }
    Some((vx * Q / approx_len, vy * Q / approx_len))
}

/// Walk the ray from `(from_x, from_y)` along the raw aim vector `(dx, dy)`; first hit
/// wins, and a solid tile stops it.
///
/// `(dx, dy)` is whatever the pointer produced — it is normalised here, once, to a Q12
/// unit vector and then accumulated, so every direction costs the same and none is
/// privileged. `(0, 0)` returns `None`; the caller has already rejected it through
/// [`octant`], so that branch is unreachable rather than meaningful.
///
/// A part with 0 HP is destroyed and detached, so the ray passes straight through it
/// — stripping the shell is what opens a lane to the core, and that falls out of the
/// geometry rather than needing a separate "exposed" flag. Order matters: `PART_HITBOXES`
/// is emitted small-and-specific first, so where two boxes overlap the *thorn* wins over
/// the limb it grows out of rather than the other way round.
///
/// Overflow: `|fx|` peaks near `1024 × Q + 64 × Q × TILE ≈ 8.4 M`, four hundred times
/// inside `i32`. The divide is `/ Q`, not `>> 12`: an arithmetic shift floors, and the
/// rest of this file truncates toward zero.
///
/// ponytail: one sample per TILE, so a corner graze can pass through a part -- measured
/// 2.09% of rays that geometrically cross one (docs/architecture/09-shooting.md §8.4).
/// All grazes; a square crossing cannot be skipped because gen_hitboxes.py refuses a box
/// under TILE on either axis. Upgrade path if grazes ever matter: step TILE/2 while the
/// sample is inside SHELL_AABB, which costs ~21 extra samples on the shots that hit.
fn raycast(from_x: i16, from_y: i16, dx: i8, dy: i8, boss: &Boss) -> Option<Hit> {
    let Some((ux, uy)) = unit_q12(dx, dy) else {
        return None;
    };

    let (boss_x, boss_y) = (boss.x as i32, boss.y as i32);
    let (mut fx, mut fy) = ((from_x as i32) * Q, (from_y as i32) * Q);

    for _ in 0..MAX_RAY_STEPS {
        fx += ux * TILE as i32;
        fy += uy * TILE as i32;
        let (x, y) = (fx / Q, fy / Q);

        // Cover. The same generated bitboard movement collides against, so a corridor
        // wall stops a shot exactly where it stops a player. It is also the early-out:
        // off the map and off a corridor are the same rejection.
        if is_wall(x, y) {
            return None;
        }

        let (local_x, local_y) = (x - boss_x, y - boss_y);

        // The gate. Everything below it is the expensive part of the shot.
        if !SHELL_AABB.contains(local_x, local_y) {
            continue;
        }

        for (index, rect) in PART_HITBOXES.iter().enumerate() {
            if boss.parts[index] != 0 && rect.contains(local_x, local_y) {
                return Some(Hit::Part(index));
            }
        }

        let (core_dx, core_dy) = (local_x - CORE_X, local_y - CORE_Y);
        if core_dx * core_dx + core_dy * core_dy <= CORE_RADIUS_SQ {
            return Some(Hit::Core);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// The fight rules
// ---------------------------------------------------------------------------

/// Only a live match takes fire. A `SETTLING` arena has its `outcome` written and is
/// waiting to be committed; a shot landing after that would damage a boss whose match is
/// already scored. `PHASE_MUSTERING` fails this test too, so weapons stay down for the
/// whole muster window without a second rule.
///
/// It is a named function rather than an inline `!=` so the answer for *every* phase is
/// testable without an `AccountView` fixture — the same reason [`fire`] is split out of
/// [`process`]. Relaxing it was considered and refused (§6.1): a lobby shot would spend
/// three write locks and a whole transaction to change no state, at up to 25/s across a
/// full raid. The waiting-area trigger is answered in the browser with a practice arrow
/// that sends nothing.
const fn phase_takes_fire(phase: u8) -> bool {
    phase == PHASE_FIGHTING
}

/// Everything a shot does to the world, given state that has already been proved to
/// belong to this arena and this signer.
///
/// Split out of [`process`] because this is the only part of the instruction with a
/// game in it, and an `AccountView` fixture is not a boss fight. The kill chain — shell
/// down, vent open, core down, match won — is testable end to end against plain structs
/// only if it lives in a function that takes plain structs, and until this split the
/// chain had never been executed anywhere, on chain or off (M4).
///
/// `charged_at` is `Some(slot)` for a shot sent charged — the ER slot it executes in, read
/// by [`process`] from the same sysvar `player::move_clock` stamps `last_move_tick` from —
/// and `None` for an ordinary shot. One value rather than a flag and a slot, so an
/// uncharged shot carries no fabricated slot number and [`process`] can skip the syscall
/// for it. Threaded in rather than read here for the same reason the accounts are: this
/// function takes plain structs and a syscall is not one.
fn fire(
    arena: &mut Arena,
    boss: &mut Boss,
    slot: &mut PlayerSlot,
    dx: i8,
    dy: i8,
    charged_at: Option<u32>,
) -> Result<(), ProgramError> {
    // Aim first, because it is the only thing here that can be malformed rather than
    // merely refused. `octant` rejects `(0, 0)` — the one illegal aim vector — and is
    // shared with `move` so the sprite's eight-way body direction is decided in exactly
    // one place. It is nearest-of-eight, not `signum`: `(30, -120)` is 14° off north and
    // must render as north, or a knight shooting straight up faces diagonally.
    let facing = octant(dx, dy)?;

    // Dead players and lobby players have nothing to shoot with or at. Two separate
    // rules, so two separate codes: "you are dead, wait for respawn" and "you are still
    // in the lobby" are opposite instructions to the player holding the fire key.
    if slot.hp == 0 {
        return Err(HeartrotError::PlayerDead.into());
    }
    if slot.zone != ZONE_ARENA {
        return Err(HeartrotError::WrongZone.into());
    }

    // The class picks both knobs, and it is read from the seat rather than sent, so a
    // client cannot pick the archer's damage on the knight's cooldown.
    let class = class_of(slot);

    // The hold. `last_move_tick` is the ER slot of the seat's last accepted step and
    // `slot_now` the ER slot this shot executes in — slot against slot, the one pair in
    // the layout that is a duration. Not `arena.tick`: that is a crank tick, and the two
    // clocks share nothing but a `u32`. `wrapping_sub` because both are the slot truncated
    // to 32 bits and the stamp may sit just below a wrap; a seat that has never stepped
    // reads 0 and has been standing still since it joined, which is the honest answer.
    //
    // Refused *before* the cooldown is spent, unlike a miss: the shot was not fired, the
    // client resends it uncharged, and what it loses is a round trip rather than a shot.
    // Landing it quietly at 1× instead would put a number on the HUD that disagrees with
    // the boss bar, with no error anywhere.
    let damage = match charged_at {
        Some(slot_now) => {
            if slot_now.wrapping_sub(slot.last_move_tick) < CHARGE_SLOTS {
                return Err(HeartrotError::NotCharged.into());
            }
            charged_damage(class as u8)
        }
        None => CLASS_DAMAGE[class],
    };

    // Rate limit, in ticks. `saturating_add` rather than `+`: a `last_shot_tick`
    // close to u32::MAX must fail the comparison, not wrap into "ready".
    if arena.tick <= slot.last_shot_tick.saturating_add(CLASS_COOLDOWN[class]) {
        return Err(HeartrotError::RateLimited.into());
    }
    slot.last_shot_tick = arena.tick;

    // Firing turns you: `facing` replicates, so a remote client draws the recoil and the
    // tracer along the direction the shot was actually taken in. The aim byte beside it
    // carries the same direction at 1.90° instead of 45°, which is what an arrow is drawn
    // from. `set_aim` is the only writer of that byte, and its `& CLASS_MASK` is the
    // single point of silent failure in the whole feature: drop it and a player changes
    // class on their first shot, with no error anywhere. That is why the write lives in
    // `state.rs` beside the field and not inlined here.
    //
    // The charged flag rides bit 3 of the same `facing` byte: the whole byte is assigned,
    // so an uncharged shot clears it, and `player::commit_move` assigns a bare octant, so
    // a step clears it too. That is exactly the lifetime of the arrow a client draws from
    // it, and it costs no field — the slot has none left to give.
    slot.facing = facing | (u8::from(charged_at.is_some()) << CHARGED_SHOT_BIT);
    slot.set_aim(dx, dy);

    let dealt = match raycast(slot.x, slot.y, dx, dy, boss) {
        Some(Hit::Part(index)) => {
            let part = &mut boss.parts[index];
            // Credit only what was actually removed, or a finishing shot on a
            // 1 HP part would score the full class damage on the leaderboard.
            let dealt = (*part).min(damage);
            // Reaching 0 *is* being destroyed: `raycast` skips a zeroed part, so the
            // limb detaches and the lane behind it opens with no second flag to set.
            *part = part.saturating_sub(damage);
            recompute_vent(boss, arena.raid_size);
            dealt
        }

        // The shell absorbs anything aimed at a sealed vent. The shot is spent, the
        // cooldown is spent, the core is untouched — which is the pressure that makes
        // stripping parts the only route to a kill.
        Some(Hit::Core) if boss.vent_open != VENT_OPEN => 0,

        Some(Hit::Core) => {
            let dealt = boss.core_hp.min(damage);
            boss.core_hp = boss.core_hp.saturating_sub(damage);
            if boss.core_hp == 0 {
                // The raid has won, and the win is *recorded*: `end_fight` writes
                // `outcome = OUTCOME_WIN` and the phase together, so a settled match can
                // still answer "did they win?" long after `phase` has moved on, and the
                // VRF roll for the next incarnation has the `outcome == OUTCOME_WIN`
                // it requires.
                //
                // The `bool` is deliberately dropped. It is `false` only when the fight
                // was already over — `boss_tick` can reach the same conclusion in the
                // same crank window — and the first writer is the true one. Losing that
                // race is not an error: the core is dead either way, and returning `Err`
                // here would roll back the damage that killed it.
                arena.end_fight(OUTCOME_WIN);
            }
            dealt
        }

        // A miss. The cooldown above was already spent — that is deliberate.
        None => 0,
    };

    slot.damage_dealt = slot.damage_dealt.saturating_add(dealt as u32);

    Ok(())
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Accounts, in order:
///
/// | # | Account | |
/// |---|---|---|
/// | 0 | `Arena` | writable — `tick` is read, `phase`/`outcome` are written on the kill |
/// | 1 | `Boss` | writable — parts, vent, core |
/// | 2 | `Players` | writable — the acting seat only |
/// | 3 | `authority` | signer, the browser's session key |
///
/// Tag 7's argument block, parsed and validated as bytes:
/// `[seat: u8, dx: i8, dy: i8, charged: u8 ∈ {0, 1}]` — 5 bytes on the wire with the tag,
/// was 4. Pure, like `player::parse_join`, so the frozen ABI is testable without the four
/// `AccountView`s [`process`] needs.
///
/// An old client sending the 3-byte block gets a clean length refusal here, which is the
/// whole reason this is safe to ship: program and app must ship together, and they will
/// fail loudly rather than read a missing byte as "uncharged". `charged` is range-checked
/// and never masked — a 2 is client/program skew, and skew has to be loud — with the same
/// `InvalidInstructionData` the length check uses, for the reason `error.rs` gives the
/// class byte: it carries nothing a caller can act on differently.
///
/// Every `(dx, dy)` except `(0, 0)` is a legal aim, so there is no range check on the
/// pair; `fire` rejects the zero vector through `octant`.
fn parse_shot(data: &[u8]) -> Result<(u8, i8, i8, bool), ProgramError> {
    let &[seat, dx, dy, charged] = data else {
        return Err(ProgramError::InvalidInstructionData);
    };
    if charged > 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok((seat, dx as i8, dy as i8, charged == 1))
}

/// `program_id` is the runtime's own value, threaded down from the entrypoint like every
/// other handler takes it. There is no hard-coded program address anywhere in this crate:
/// the deployed key is a deploy-time fact the Worker carries in `PROGRAM_ID`, and a
/// constant baked in here would be one more thing to get wrong on a redeploy.
///
/// See `docs/architecture/05-wire-abi.md` for the block, and [`parse_shot`] for the parser.
pub fn process(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [arena_account, boss_account, players_account, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (seat, dx, dy, charged) = parse_shot(data)?;

    // Pinocchio validates nothing, so every one of these is hand-written and every
    // one of them is load-bearing. They run before any state is touched.
    assert_signer(authority)?;
    for account in [&*arena_account, &*boss_account, &*players_account] {
        assert_owned_by(account, program_id)?;
        assert_writable(account)?;
    }

    // Every address this handler needs, copied out before the first borrow:
    // `try_borrow_mut` takes `&mut self`, so `address()` is not callable once the data
    // borrow is held, and the bump the PDA check needs lives *inside* that borrow.
    let arena_key = *arena_account.address();
    let boss_key = *boss_account.address();
    let players_key = *players_account.address();

    let mut arena_data = arena_account.try_borrow_mut()?;
    let arena = load_mut::<Arena>(&mut arena_data)?;
    let mut boss_data = boss_account.try_borrow_mut()?;
    let boss = load_mut::<Boss>(&mut boss_data)?;
    let mut players_data = players_account.try_borrow_mut()?;
    let players = load_mut::<Players>(&mut players_data)?;

    // `Boss` and `Players` must belong to *this* arena. Without these two checks a
    // caller could pair a live `Arena` with the `Boss` of a different match and drain
    // that boss on this match's clock. The `Arena` account itself needs no
    // re-derivation: owner + discriminator already prove it is one of ours, and a
    // rogue arena can only reach the boss and players derived from itself.
    //
    // The bump comes off the account rather than out of a `find_program_address` search
    // because the search is this instruction's single largest cost and its price is
    // arena_id luck: 3,452 CU of guards for an arena whose children land on bump 255,
    // 10,952 for one at 251/254 (docs/review/chain-cost.md). `assert_pda_at_bump` is one
    // hash either way. It is not weaker: `assert_owned_by` above proves only this program
    // wrote byte 2, `load_mut` proves it is the bump field of the layout being read, and
    // the derivation below proves that bump reproduces this exact address — see the
    // guard's own docs for why no account at a non-canonical bump can reach this line.
    // Nothing has been mutated yet; `fire` is the first write.
    assert_pda_at_bump(
        &boss_key,
        &[SEED_BOSS, arena_key.as_ref()],
        program_id,
        boss.bump,
    )?;
    assert_pda_at_bump(
        &players_key,
        &[SEED_PLAYERS, arena_key.as_ref()],
        program_id,
        players.bump,
    )?;

    if !phase_takes_fire(arena.phase) {
        return Err(HeartrotError::WrongPhase.into());
    }

    let slot = players
        .slots
        .get_mut(seat as usize)
        .ok_or(HeartrotError::SeatOutOfRange)?;

    // The entire security perimeter, not one layer of it: this signer must be the
    // session key stored on the seat being fired from.
    assert_session_authority(slot, authority)?;

    // The ER slot, from the sysvar `player::move_clock` stamps `last_move_tick` with — the
    // only clock the charge hold can be measured on (see the module docs). Read only for a
    // charged shot, and after every guard: the syscall is the bulk of the feature's cost —
    // measured in mollusk against the pre-charge handler on identical fixtures, a plain
    // shot is +73..+93 CU and a charged one +202..+222, the 129 CU between them being this
    // one call — and the plain shot is the hot path, a raider holding fire while walking.
    let charged_at = if charged {
        Some(Clock::get()?.slot as u32)
    } else {
        None
    };

    fire(arena, boss, slot, dx, dy, charged_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::BOSS_SPAWN;
    use crate::state::{
        Bullet, BULLET_ACTIVE, CLASS_MASK, MAX_BULLETS, MAX_SEATS, N_PARTS, OUTCOME_UNDECIDED,
        PHASE_SETTLING,
    };
    use bytemuck::Zeroable;

    fn boss_at(x: i16, y: i16) -> Boss {
        let mut boss = Boss::zeroed();
        boss.x = x;
        boss.y = y;
        boss.parts = [100; N_PARTS];
        boss.parts_max = [100; N_PARTS];
        boss.core_hp = 100;
        boss.core_hp_max = 100;
        boss
    }

    /// The boss on the drawn `B` heart tile, read out of the generated map rather than
    /// restated. This used to be `32 * 16` beside a comment claiming `tick.rs` wrote it,
    /// while `init.rs` actually spawned the boss twelve tiles away, in a corridor. The
    /// comment was right about the map and wrong about the program, and a literal cannot
    /// notice that.
    fn standing_boss() -> Boss {
        boss_at(BOSS_SPAWN.0, BOSS_SPAWN.1)
    }

    /// Scale an arbitrary integer vector the way `controls.ts` scales the pointer: the
    /// larger component becomes ±127, the smaller keeps its ratio.
    fn aim_at(dx: i32, dy: i32) -> (i8, i8) {
        let m = dx.abs().max(dy.abs()).max(1);
        ((dx * 127 / m) as i8, (dy * 127 / m) as i8)
    }

    /// A firing position found by searching the generated map and hitbox tables, plus
    /// what the map does to shots that are not so lucky.
    ///
    /// Every geometric test below is anchored to this rather than to typed coordinates,
    /// because the map, the boss anchor and the part indices are all generator output:
    /// `gen_map.py` redraws the arena, `gen_hitboxes.py --scale N` moves every box, and a
    /// test that names tile (20, 28) or part 7 stops testing the ray and starts testing
    /// last week's art. What is asserted is the *behaviour* — first live box wins, a
    /// destroyed limb is transparent, a wall eats the shot — over whatever geometry is
    /// currently compiled in.
    struct Survey {
        /// Where to stand, and the aim vector from there to the vent.
        stand: (i16, i16),
        aim: (i8, i8),
        /// The part that box-blocks that lane, and whose destruction opens it.
        blocker: usize,
        /// How many floor tiles have a wall between them and the vent. Cover exists.
        walled_out: usize,
    }

    /// Sweep every floor tile in the arena, aiming at the vent from each.
    ///
    /// 4,096 stands × at most 64 steps is a rounding error in a test binary, and it is
    /// the same sweep 11-immortals-spec §4.1 ran to establish that eight-way aim cannot
    /// win the fight.
    fn survey() -> Survey {
        let boss = standing_boss();
        let core = (boss.x as i32 + CORE_X, boss.y as i32 + CORE_Y);
        let half = TILE as i32 / 2;
        let mut found: Option<((i16, i16), (i8, i8), usize)> = None;
        let mut walled_out = 0usize;

        for ty in 0..MAP_TILES as i32 {
            for tx in 0..MAP_TILES as i32 {
                let (x, y) = (tx * TILE as i32 + half, ty * TILE as i32 + half);
                if is_wall(x, y) {
                    continue;
                }
                // A stand inside the shell is not a firing position, it is a bug report.
                if SHELL_AABB.contains(x - boss.x as i32, y - boss.y as i32) {
                    continue;
                }
                let (dx, dy) = aim_at(core.0 - x, core.1 - y);
                let mut probe = boss;
                match raycast(x as i16, y as i16, dx, dy, &probe) {
                    None => walled_out += 1,
                    Some(Hit::Part(p)) if found.is_none() => {
                        // Keep it only if stripping that one limb opens the lane behind
                        // it, which is what the vent tests need.
                        probe.parts[p] = 0;
                        if raycast(x as i16, y as i16, dx, dy, &probe) == Some(Hit::Core) {
                            found = Some(((x as i16, y as i16), (dx, dy), p));
                        }
                    }
                    _ => {}
                }
            }
        }

        let (stand, aim, blocker) = found.expect(
            "no floor tile in the arena can shoot a part and then the vent behind it -- \
             the map and the boss no longer agree; re-run tools/gen_map.py and \
             tools/gen_hitboxes.py",
        );
        Survey {
            stand,
            aim,
            blocker,
            walled_out,
        }
    }

    /// A seated player standing where [`survey`] found a lane.
    fn shooter(s: &Survey) -> PlayerSlot {
        let mut slot = PlayerSlot::zeroed();
        slot.zone = ZONE_ARENA;
        slot.x = s.stand.0;
        slot.y = s.stand.1;
        slot.hp = 100;
        slot.hp_max = 100;
        slot
    }

    fn arena_fighting() -> Arena {
        let mut arena = Arena::zeroed();
        arena.phase = PHASE_FIGHTING;
        arena
    }

    /// Advance past *this seat's* cooldown and take one shot along the surveyed lane,
    /// which must be accepted. The wait is read off the class table, never typed, so the
    /// archer's tests wait 1400 ms and the knight's 800 without a second helper.
    fn shoot_lane(s: &Survey, arena: &mut Arena, boss: &mut Boss, slot: &mut PlayerSlot) {
        arena.tick += CLASS_COOLDOWN[class_of(slot)] + 1;
        fire(arena, boss, slot, s.aim.0, s.aim.1, None).expect("a live seat off cooldown may fire");
    }

    /// Invert [`encode_aim`]. Test-only, and it is the *specification* the TypeScript
    /// `decodeAim` mirrors — 17-fullscreen-spec §5.5. Nothing on chain decodes the byte.
    fn decode_aim(byte: u8) -> (f64, f64) {
        let (sector, t) = (byte >> 4, (byte & 0x0f) as f64 / 15.0);
        let (steep, y_neg, x_neg) = (sector & 1 != 0, sector & 2 != 0, sector & 4 != 0);
        let (mut x, mut y) = if steep { (t, 1.0) } else { (1.0, t) };
        if x_neg {
            x = -x;
        }
        if y_neg {
            y = -y;
        }
        (x, y)
    }

    /// A seat that has chosen the archer. Only bit 7 differs from [`shooter`].
    fn archer(s: &Survey) -> PlayerSlot {
        let mut slot = shooter(s);
        slot.class_aim |= CLASS_MASK;
        slot
    }

    /// The whole attack is this function: if it picks the wrong box, or keeps a
    /// destroyed part solid, the game is wrong in a way no account check would catch.
    #[test]
    fn a_shot_hits_the_first_live_part_and_a_destroyed_one_is_transparent() {
        let s = survey();
        let mut boss = standing_boss();

        assert_eq!(
            raycast(s.stand.0, s.stand.1, s.aim.0, s.aim.1, &boss),
            Some(Hit::Part(s.blocker)),
        );

        // Strip it and the same shot reaches the vent behind it: the lane opens out of
        // the geometry, with no "exposed" flag anywhere.
        boss.parts[s.blocker] = 0;
        assert_eq!(
            raycast(s.stand.0, s.stand.1, s.aim.0, s.aim.1, &boss),
            Some(Hit::Core),
        );
    }

    /// A miss is a real outcome, not an error: fired away from the boss the ray finds
    /// floor until it runs out of steps or leaves the map.
    #[test]
    fn a_shot_aimed_away_misses() {
        let s = survey();
        let boss = standing_boss();
        // `aim_at` never produces -128, so negating is safe.
        assert_eq!(
            raycast(s.stand.0, s.stand.1, -s.aim.0, -s.aim.1, &boss),
            None,
        );
    }

    /// Cover, and the off-map rejection that doubles as the ray's early-out. The wall
    /// table is `map::WALLS`, the same one movement collides against, so a shot dies
    /// exactly where a step does.
    #[test]
    fn walls_stop_the_ray() {
        assert!(is_wall(-1, 0), "negative x is solid before the divide");
        assert!(is_wall(0, -1), "negative y is solid before the divide");
        assert!(
            is_wall(MAP_TILES as i32 * TILE as i32, 0),
            "off-map is solid"
        );
        assert!(
            is_wall(0, MAP_TILES as i32 * TILE as i32),
            "past the last row is solid",
        );

        // A ray fired at the map edge dies there rather than sampling negative space.
        assert_eq!(raycast(8, 8, -127, 0, &standing_boss()), None);

        // And cover is not theoretical: some floor of this arena cannot see the vent.
        assert!(
            survey().walled_out > 0,
            "no stand in the arena is behind cover -- the wall branch is untested",
        );
    }

    /// M4, the fight nobody had ever run: shell → vent → core → win, in one sequence,
    /// with the vent crossing its threshold mid-way and the outcome recorded at the end.
    ///
    /// The starting shell is deliberately *not* full: five parts are already gone, which
    /// puts `sum(parts)` at 400 of a 900 maximum — above the 35 % vent threshold by 85,
    /// close enough that stripping the one part in the ray's path crosses it. That is the
    /// only way to observe the crossing rather than assert a state that was true from the
    /// first line. Zeroing parts can only *remove* obstacles, so the surveyed lane still
    /// runs blocker-then-vent.
    #[test]
    fn shell_then_vent_then_core_is_a_recorded_win() {
        let s = survey();
        let mut arena = arena_fighting();
        // A full raid: the threshold is `VENT_PCT_FULL`, 35 %, which the shell numbers below
        // are cut to. The raid-size curve itself is `the_vent_opens_earlier_for_a_smaller_raid`.
        arena.raid_size = MAX_SEATS as u8;
        let mut boss = standing_boss();
        let mut slot = shooter(&s);

        let mut cleared = 0;
        for index in 0..N_PARTS {
            if index != s.blocker && cleared < 5 {
                boss.parts[index] = 0;
                cleared += 1;
            }
        }
        recompute_vent(&mut boss, arena.raid_size);
        assert_eq!(boss.vent_open, 0, "400 of 900 is above the threshold");

        // Two shots into the blocker: the shell drops to 320/900 (35.5 %), still sealed.
        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.parts[s.blocker], 60);
        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.parts[s.blocker], 20);
        assert_eq!(boss.vent_open, 0);

        // A sealed vent absorbs everything: the core is behind the shell and unhurt.
        assert_eq!(boss.core_hp, 100);

        // The third destroys the part, and 300/900 crosses the threshold: vent open.
        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.parts[s.blocker], 0);
        assert_eq!(boss.vent_open, VENT_OPEN);
        // Credited 100, never 120: the finishing shot scores only the 20 it removed.
        assert_eq!(slot.damage_dealt, 100);

        // The destroyed limb has detached, so the same shot now reaches the core.
        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.core_hp, 60);
        assert_eq!(arena.phase, PHASE_FIGHTING);
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);

        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.core_hp, 20);

        // The killing blow. The win is recorded, not implied.
        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.core_hp, 0);
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.outcome, OUTCOME_WIN);
        // 100 off the shell, 100 off the core, and nothing double-counted.
        assert_eq!(slot.damage_dealt, 200);
    }

    /// The shell is not a damage sink with a hole in it: with the vent sealed, a shot
    /// that geometrically reaches the core scores nothing and the cooldown is still
    /// spent. Without this the vent threshold is decorative.
    #[test]
    fn a_sealed_vent_absorbs_a_core_hit() {
        let s = survey();
        let mut arena = arena_fighting();
        let mut boss = standing_boss();
        let mut slot = shooter(&s);
        // The blocker gone so the ray reaches the core, but the shell is otherwise
        // intact, so the vent stays sealed.
        boss.parts[s.blocker] = 0;
        recompute_vent(&mut boss, arena.raid_size);
        assert_eq!(boss.vent_open, 0);
        assert_eq!(
            raycast(slot.x, slot.y, s.aim.0, s.aim.1, &boss),
            Some(Hit::Core),
        );

        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.core_hp, 100);
        assert_eq!(slot.damage_dealt, 0);
        assert_eq!(
            slot.last_shot_tick, arena.tick,
            "the attempt spent the cooldown",
        );
    }

    /// The rate limiter is the only thing standing between one seat and unlimited free
    /// damage: ER fees are zero, so a refused shot must be refused on the tick clock and
    /// on nothing else. A miss spends it exactly like a hit.
    #[test]
    fn the_cooldown_is_ticks_and_a_miss_spends_it() {
        let s = survey();
        let mut arena = arena_fighting();
        let mut boss = standing_boss();
        let mut slot = shooter(&s);

        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        // Same tick, and one tick later: still inside the cooldown window.
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).unwrap_err(),
            HeartrotError::RateLimited.into(),
        );
        arena.tick += 1;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).unwrap_err(),
            HeartrotError::RateLimited.into(),
        );
        assert_eq!(boss.parts[s.blocker], 60, "a refused shot deals nothing");

        // A miss into the empty air behind still burns the shot. Advancing by the
        // cooldown itself, not by a hardcoded 1: the window is a duration (800 ms)
        // divided by TICK_MS, so a literal here would silently stop testing the boundary
        // the moment the tick rate moved — which is exactly what it did.
        arena.tick += CLASS_COOLDOWN[CLASS_KNIGHT] + 1;
        fire(&mut arena, &mut boss, &mut slot, -s.aim.0, -s.aim.1, None).expect("off cooldown");
        assert_eq!(slot.last_shot_tick, arena.tick);
        assert_eq!(boss.parts[s.blocker], 60, "the miss dealt nothing");
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).unwrap_err(),
            HeartrotError::RateLimited.into(),
        );
    }

    /// Player fire is hitscan, so a full bullet pool is the boss's problem and never the
    /// shooter's. This is the "at twenty shooters a naive pool starves and shots silently
    /// vanish" failure, asserted not to exist: 128 active bullets in the air, and the
    /// shot still lands, still credits, and claims no slot.
    #[test]
    fn a_full_bullet_pool_does_not_starve_player_fire() {
        let s = survey();
        let mut arena = arena_fighting();
        let mut boss = standing_boss();
        let mut slot = shooter(&s);

        arena.bullets = [Bullet {
            x: 1,
            y: 2,
            dx: 3,
            dy: 4,
            active: BULLET_ACTIVE,
            _pad0: 0,
        }; MAX_BULLETS];

        shoot_lane(&s, &mut arena, &mut boss, &mut slot);
        assert_eq!(boss.parts[s.blocker], 60, "the shot landed");
        assert_eq!(slot.damage_dealt, CLASS_DAMAGE[CLASS_KNIGHT] as u32);
        assert!(
            arena
                .bullets
                .iter()
                .all(|b| b.active == BULLET_ACTIVE && (b.x, b.y, b.dx, b.dy) == (1, 2, 3, 4)),
            "a hitscan shot must not touch the boss's ordnance",
        );
    }

    /// Free aim is the point of the redesign, so prove the resolution rather than
    /// assuming it: sweep 3,600 aim angles and require that every direction the ray
    /// normalises stays within one degree of the direction asked for, and that no aim
    /// stalls the ray in place.
    #[test]
    fn every_aim_direction_is_distinct_and_stays_on_line() {
        let boss = standing_boss();
        // The zero vector is the one illegal aim, and it is refused before the ray.
        assert_eq!(unit_q12(0, 0), None);
        assert_eq!(raycast(512, 512, 0, 0, &boss), None);

        // Resolution is a property of the normaliser, so it is measured there: for each
        // of 3,600 angles, the Q12 unit vector must point within 1.0 degrees of it.
        let mut worst = 0.0f64;
        for step in 0..3_600 {
            let theta = (step as f64) * std::f64::consts::TAU / 3_600.0;
            let (fx, fy) = (theta.cos(), theta.sin());
            let m = fx.abs().max(fy.abs());
            let (dx, dy) = ((fx / m * 127.0) as i8, (fy / m * 127.0) as i8);
            if dx == 0 && dy == 0 {
                continue;
            }
            let (ux, uy) = unit_q12(dx, dy).expect("a non-zero aim normalises");
            assert!(ux != 0 || uy != 0, "a legal aim must move the ray");
            let got = (uy as f64).atan2(ux as f64);
            let mut err = (got - theta).abs().to_degrees();
            if err > 180.0 {
                err = 360.0 - err;
            }
            worst = worst.max(err);
        }
        assert!(worst < 1.0, "aim resolution regressed to {worst} degrees");
    }

    /// Corpses and lobby-sitters do not shoot, and the two refusals are distinguishable
    /// because they are opposite instructions to the player holding the fire key. The
    /// zero aim vector is refused before either, because it is malformed rather than
    /// merely disallowed.
    #[test]
    fn the_dead_and_the_unentered_cannot_fire() {
        let s = survey();
        let mut arena = arena_fighting();
        arena.tick = 100;
        let mut boss = standing_boss();

        let mut dead = shooter(&s);
        dead.hp = 0;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut dead, s.aim.0, s.aim.1, None).unwrap_err(),
            HeartrotError::PlayerDead.into(),
        );

        let mut in_lobby = shooter(&s);
        in_lobby.zone = crate::state::ZONE_LOBBY;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut in_lobby, s.aim.0, s.aim.1, None).unwrap_err(),
            HeartrotError::WrongZone.into(),
        );

        let mut live = shooter(&s);
        assert_eq!(
            fire(&mut arena, &mut boss, &mut live, 0, 0, None).unwrap_err(),
            ProgramError::InvalidInstructionData,
        );
        assert_eq!(live.last_shot_tick, 0, "a malformed aim spends nothing");

        assert_eq!(boss.parts[s.blocker], 100);
    }

    /// The single point of silent failure in the class feature (§5.3): `fire` writes the
    /// aim into the same byte the class lives in, and without the `& CLASS_MASK` a player
    /// would change class on their first shot with no error anywhere. Twenty shots, and
    /// the archer is still an archer — with the archer's numbers, not the knight's.
    #[test]
    fn the_class_bit_survives_every_shot() {
        let s = survey();
        let mut arena = arena_fighting();
        let mut boss = standing_boss();
        boss.parts = [u16::MAX; N_PARTS];
        boss.parts_max = [u16::MAX; N_PARTS];
        let mut slot = archer(&s);

        for shot in 1..=20u32 {
            shoot_lane(&s, &mut arena, &mut boss, &mut slot);
            assert_eq!(
                slot.class_aim >> 7,
                1,
                "shot {shot} overwrote the class bit with the aim",
            );
            assert_eq!(class_of(&slot), CLASS_ARCHER);
            assert_eq!(
                slot.damage_dealt,
                shot * CLASS_DAMAGE[CLASS_ARCHER] as u32,
                "shot {shot} scored the wrong class's damage",
            );
        }

        // And a knight stays a knight: the aim occupies bits 6..0 and nothing else.
        let mut knight = shooter(&s);
        shoot_lane(&s, &mut arena, &mut boss, &mut knight);
        assert_eq!(class_of(&knight), CLASS_KNIGHT);
        assert_eq!(knight.class_aim & CLASS_MASK, 0);
    }

    /// The whole reason the byte is spent: an arrow drawn from `facing` is eight-way and
    /// up to 22.5° off, and it snaps mid-flight when its shooter steps. The encoded aim
    /// must round-trip to within the 1.90° §5.3 measured — this sweep is the contract the
    /// TypeScript `decodeAim` is written against, over **every** legal wire aim rather
    /// than a sample of them.
    #[test]
    fn the_aim_byte_round_trips_within_two_degrees() {
        fn degrees_between(a: (f64, f64), b: (f64, f64)) -> f64 {
            let mut err = (a.1.atan2(a.0) - b.1.atan2(b.0)).abs().to_degrees();
            if err > 180.0 {
                err = 360.0 - err;
            }
            err
        }

        // All 65,535 legal `(dx, dy)` pairs. -128 is among them, `i8::MIN.abs()`
        // overflows, and `overflow-checks` is on for the release profile — so an
        // un-widened `abs` in `encode_aim` is a panic on chain, not a wrong pixel, and
        // this loop is where it would fire.
        let mut worst = 0.0f64;
        for dx in i8::MIN..=i8::MAX {
            for dy in i8::MIN..=i8::MAX {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let byte = encode_aim(dx, dy);
                assert_eq!(byte & CLASS_MASK, 0, "the aim reached the class bit");
                // A component that quantises to zero has no sign to keep -- the ratio
                // rounded the minor axis away, which is a sub-degree error and not a
                // flip. Every component that survives must point the same way it was
                // fired, and the angle bound below catches anything that does not.
                let got = decode_aim(byte);
                if got.0 != 0.0 {
                    assert_eq!(got.0 < 0.0, dx < 0, "sign of x flipped for ({dx}, {dy})");
                }
                if got.1 != 0.0 {
                    assert_eq!(got.1 < 0.0, dy < 0, "sign of y flipped for ({dx}, {dy})");
                }
                worst = worst.max(degrees_between(got, (dx as f64, dy as f64)));
            }
        }
        assert!(
            worst < 1.91,
            "aim byte resolution regressed to {worst} degrees over the wire aims",
        );

        // End to end, from the continuous angle the pointer produced, through the
        // client's own `as i8` scaling and back out of the byte. The extra ~0.30° over
        // the number above is that scaling's truncation, which the wire has carried since
        // free aim shipped and which this byte neither adds to nor fixes.
        let mut end_to_end = 0.0f64;
        for step in 0..3_600 {
            let theta = (step as f64) * std::f64::consts::TAU / 3_600.0;
            let (fx, fy) = (theta.cos(), theta.sin());
            let m = fx.abs().max(fy.abs());
            let (dx, dy) = ((fx / m * 127.0) as i8, (fy / m * 127.0) as i8);
            if dx == 0 && dy == 0 {
                continue;
            }
            end_to_end = end_to_end.max(degrees_between(decode_aim(encode_aim(dx, dy)), (fx, fy)));
        }
        assert!(
            end_to_end < 2.25,
            "end-to-end aim error regressed to {end_to_end} degrees",
        );
    }

    /// The archer is slower and heavier, and the two rows are 50 DPS apiece so the boss
    /// needs no rescale. The compile-time block up top asserts the arithmetic; this
    /// asserts the *behaviour*, because a table nothing reads is not a balance change.
    #[test]
    fn the_archer_is_slower_and_heavier_at_the_same_dps() {
        let s = survey();
        let mut boss = standing_boss();
        boss.parts = [u16::MAX; N_PARTS];
        boss.parts_max = [u16::MAX; N_PARTS];

        // One shot each, from a shared clock, then the exact tick each may fire again.
        let mut ready_at = [0u32; 2];
        for (class, slot) in [(CLASS_KNIGHT, shooter(&s)), (CLASS_ARCHER, archer(&s))] {
            let mut slot = slot;
            let mut arena = arena_fighting();
            arena.tick = 1_000;
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).expect("first shot is free");
            assert_eq!(slot.damage_dealt, CLASS_DAMAGE[class] as u32);

            // Every tick up to and including the cooldown is refused...
            for wait in 0..=CLASS_COOLDOWN[class] {
                arena.tick = 1_000 + wait;
                assert_eq!(
                    fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).unwrap_err(),
                    HeartrotError::RateLimited.into(),
                    "class {class} fired {wait} ticks early",
                );
            }
            // ...and the next one is not.
            arena.tick = 1_000 + CLASS_COOLDOWN[class] + 1;
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).expect("off cooldown");
            assert_eq!(slot.damage_dealt, 2 * CLASS_DAMAGE[class] as u32);
            ready_at[class] = CLASS_COOLDOWN[class] + 1;
        }

        assert!(
            ready_at[CLASS_ARCHER] > ready_at[CLASS_KNIGHT],
            "the archer must be the slower class, not the faster one",
        );
        // 40 x 14 == 70 x 8: neither class out-damages the other over the same wall clock.
        assert_eq!(
            CLASS_DAMAGE[CLASS_KNIGHT] as u32 * ready_at[CLASS_ARCHER],
            CLASS_DAMAGE[CLASS_ARCHER] as u32 * ready_at[CLASS_KNIGHT],
        );
    }

    /// There is no such thing as an out-of-range shot at this boss, and this is the
    /// measurement that says so rather than the assumption: the ray's *shortest* possible
    /// reach — `MAX_RAY_STEPS` steps of 0.894 tile, the alpha-max-plus-beta-min floor —
    /// covers the distance from every floor tile in the generated map to the core. So a
    /// `None` from [`raycast`] is always cover or the map edge, never exhaustion, and a
    /// per-class range knob would have nothing to cut into (§5.2).
    #[test]
    fn no_shot_at_the_boss_can_die_of_range() {
        let boss = standing_boss();
        let core = (boss.x as i64 + CORE_X as i64, boss.y as i64 + CORE_Y as i64);
        let reach = MAX_RAY_STEPS as i64 * TILE as i64 * 894 / 1000;
        let half = TILE as i32 / 2;

        let (mut worst, mut stands) = (0i64, 0usize);
        for ty in 0..MAP_TILES as i32 {
            for tx in 0..MAP_TILES as i32 {
                let (x, y) = (tx * TILE as i32 + half, ty * TILE as i32 + half);
                if is_wall(x, y) {
                    continue;
                }
                stands += 1;
                let (dx, dy) = (core.0 - x as i64, core.1 - y as i64);
                worst = worst.max(dx * dx + dy * dy);
            }
        }

        assert!(stands > 0, "the generated map has no floor at all");
        assert!(
            worst <= reach * reach,
            "the farthest floor tile is {} units from the core, past the ray's {reach}-unit \
             reach -- a shot can now die of range with no error anywhere",
            (worst as f64).sqrt() as i64,
        );
        // And the const the compile-time reach check is written against still bounds the
        // real map, rather than describing an arena two redraws ago.
        assert!(
            worst <= WORST_RANGE as i64 * WORST_RANGE as i64,
            "WORST_RANGE = {WORST_RANGE} is stale: the map now reaches {}",
            (worst as f64).sqrt() as i64,
        );
    }

    /// Every phase has a defined answer for a trigger pull, and only one of them is yes.
    ///
    /// The two that matter to the reported bug are `PHASE_LOBBY` and `PHASE_MUSTERING`:
    /// both refuse, deliberately, and the refusal is `WrongPhase` and not silence. The
    /// waiting-area spacebar is dead in the *browser*, which drops the key before a
    /// transaction exists — no code below can be the fix for it (§0.1 Correction A).
    #[test]
    fn every_phase_has_a_defined_answer_for_a_trigger_pull() {
        use crate::state::{PHASE_LOBBY, PHASE_MUSTERING, PHASE_ROLLED, PHASE_ROLLING, PHASE_SETTLED};

        for phase in [
            PHASE_LOBBY,
            PHASE_FIGHTING,
            PHASE_SETTLING,
            PHASE_SETTLED,
            PHASE_ROLLING,
            PHASE_ROLLED,
            PHASE_MUSTERING,
        ] {
            assert_eq!(
                phase_takes_fire(phase),
                phase == PHASE_FIGHTING,
                "phase {phase} has the wrong answer for a trigger pull",
            );
        }

        // Weapons stay down for the whole muster without a second rule, and a settled
        // match cannot be damaged after its outcome is written.
        assert!(!phase_takes_fire(PHASE_MUSTERING));
        assert!(!phase_takes_fire(PHASE_LOBBY));
        assert!(!phase_takes_fire(PHASE_SETTLING));
    }

    /// The charged shot: 2.5× — 175 for the archer, 100 for the knight — granted only when
    /// the seat's last step is `CHARGE_SLOTS` ER slots old, slot against slot and never
    /// `arena.tick`, and refused *before* the cooldown is spent so the client's uncharged
    /// resend lands. The refusal must change nothing: not the stamp, not the shell, not the
    /// facing byte. The flag it publishes lives until the next uncharged shot (a step clears
    /// it too — `player.rs`), and the hold survives the slot clock wrapping at 2^32.
    #[test]
    fn a_charged_shot_needs_the_hold_and_deals_two_and_a_half_times() {
        let s = survey();
        let mut arena = arena_fighting();
        arena.tick = 100;
        let mut boss = standing_boss();
        boss.parts = [1_000; N_PARTS];
        boss.parts_max = [1_000; N_PARTS];
        let mut slot = archer(&s);
        slot.last_move_tick = 5_000;
        let aim = octant(s.aim.0, s.aim.1).unwrap();

        // One slot short of the hold: refused, and nothing spent.
        let early = 5_000 + CHARGE_SLOTS - 1;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, Some(early)).unwrap_err(),
            HeartrotError::NotCharged.into(),
        );
        assert_eq!(slot.last_shot_tick, 0, "a refused charge spends no cooldown");
        assert_eq!(slot.facing, 0, "and writes nothing");
        assert_eq!(boss.parts[s.blocker], 1_000);

        // The same shot, same tick, resent uncharged: lands at 70 — the client's recovery.
        fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).expect("uncharged");
        assert_eq!(boss.parts[s.blocker], 1_000 - 70);
        assert_eq!(slot.facing, aim, "an uncharged shot carries no flag");

        // Exactly the hold: 175, and the flag rides `facing` beside the octant.
        arena.tick += CLASS_COOLDOWN[CLASS_ARCHER] + 1;
        fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, Some(5_000 + CHARGE_SLOTS))
            .expect("charged");
        assert_eq!(charged_damage(CLASS_ARCHER as u8), 175);
        assert_eq!(boss.parts[s.blocker], 1_000 - 70 - 175);
        assert_eq!(slot.damage_dealt, 70 + 175);
        assert_eq!(slot.facing, aim | 1 << CHARGED_SHOT_BIT);

        // The next uncharged shot clears it.
        arena.tick += CLASS_COOLDOWN[CLASS_ARCHER] + 1;
        fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, None).expect("uncharged");
        assert_eq!(slot.facing, aim);

        // Held long enough but on cooldown: the hold passes and the cooldown refuses.
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1, Some(9_999)).unwrap_err(),
            HeartrotError::RateLimited.into(),
        );

        // The knight's row: 100, not 175 — the multiplier is per class. A seat that has
        // never stepped reads `last_move_tick == 0` and has been still since it joined.
        let mut knight = shooter(&s);
        let mut arena = arena_fighting();
        arena.tick = 100;
        fire(&mut arena, &mut boss, &mut knight, s.aim.0, s.aim.1, Some(CHARGE_SLOTS))
            .expect("still since it joined");
        assert_eq!(knight.damage_dealt, 100);

        // The slot clock is `u32` and wraps: a step stamped five slots below the wrap and a
        // shot fifteen above it are twenty apart, and the hold must see that.
        let mut wrapped = archer(&s);
        wrapped.last_move_tick = u32::MAX - 4;
        let mut arena = arena_fighting();
        arena.tick = 100;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut wrapped, s.aim.0, s.aim.1, Some(CHARGE_SLOTS - 6))
                .unwrap_err(),
            HeartrotError::NotCharged.into(),
            "nineteen slots across the wrap is still short",
        );
        fire(&mut arena, &mut boss, &mut wrapped, s.aim.0, s.aim.1, Some(CHARGE_SLOTS - 5))
            .expect("twenty slots across the wrap");
    }

    /// The vent threshold reads the raid: the same shell, 60 % standing, is an open vent
    /// for a raid of one and a sealed one for twenty. First through `recompute_vent`, the
    /// only writer of `vent_open`, then through `fire` on the surveyed lane, where the
    /// difference is a core that takes damage against one that absorbs it.
    #[test]
    fn the_vent_opens_earlier_for_a_smaller_raid() {
        let s = survey();
        let mut boss = standing_boss();
        boss.parts = [60; N_PARTS];
        assert!(recompute_vent(&mut boss, 1), "solo: 60 % standing is under 65 %");
        assert!(!recompute_vent(&mut boss, MAX_SEATS as u8), "twenty: 60 % is over 35 %");
        assert!(recompute_vent(&mut boss, 0), "an uncounted raid is a solo raid");

        // The blocker gone, the lane reaches the core (480 of 900 left: 53 %). Whether the
        // core *takes* the hit is the raid's threshold and nothing else.
        boss.parts[s.blocker] = 0;
        for (raid, core_left) in [(1u8, 100 - CLASS_DAMAGE[CLASS_KNIGHT]), (MAX_SEATS as u8, 100)] {
            let mut arena = arena_fighting();
            arena.raid_size = raid;
            let mut boss = boss;
            recompute_vent(&mut boss, arena.raid_size);
            let mut slot = shooter(&s);
            shoot_lane(&s, &mut arena, &mut boss, &mut slot);
            assert_eq!(boss.core_hp, core_left, "raid of {raid}");
        }
    }

    /// Tag 7's wire block, byte for byte: four bytes and only four, and `charged` is 0 or 1.
    /// Every other length is a client on the wrong side of the deploy, and a 2 is skew that
    /// must not be masked into a legal shot.
    #[test]
    fn the_shot_block_is_four_bytes_with_a_binary_flag() {
        assert_eq!(parse_shot(&[3, 5, 0xfa, 0]), Ok((3, 5, -6, false)));
        assert_eq!(parse_shot(&[19, 0x80, 127, 1]), Ok((19, -128, 127, true)));
        let refused: [&[u8]; 7] = [
            &[],
            &[3],
            &[3, 5],
            &[3, 5, 0xfa],
            &[3, 5, 0xfa, 1, 0],
            &[3, 5, 0xfa, 2],
            &[3, 5, 0xfa, 0xff],
        ];
        for bad in refused {
            assert_eq!(
                parse_shot(bad),
                Err(ProgramError::InvalidInstructionData),
                "{bad:?} was accepted",
            );
        }
    }
}
