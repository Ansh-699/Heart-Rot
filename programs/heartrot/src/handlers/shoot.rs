//! `shoot(seat, dx, dy)` — the player attack, hitscan, free aim.
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
//! Two consequences worth stating, because both are security properties:
//!
//! - **The cooldown is counted in `Arena.tick`, never milliseconds.** Ticks are the
//!   only clock the ER agrees on — `TICK_MS` is the crank's target, not a contract —
//!   and a wall-clock cooldown would pay out to whoever has the lowest ping. Ticks make
//!   fire rate identical from Ghaziabad and from Frankfurt.
//! - **The cooldown is spent by the attempt, not by the hit.** ER transaction fees
//!   are 0 lamports and the ER runs no fee-payer validation at all, so nothing debits
//!   a spammer (D16). `last_shot_tick` *is* the rate limiter; refunding it on a miss
//!   would hand an attacker an unlimited-rate instruction.
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

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::HeartrotError;
use crate::guards::{
    assert_owned_by, assert_pda_at_bump, assert_session_authority, assert_signer, assert_writable,
};
use crate::handlers::player::octant;
use crate::hitboxes::{Rect, CORE_RADIUS_SQ, CORE_X, CORE_Y, PART_HITBOXES};
use crate::map::{MAP_TILES, TILE, WALLS};
use crate::state::{
    load_mut, Arena, Boss, PlayerSlot, Players, OUTCOME_WIN, PHASE_FIGHTING, SEED_BOSS,
    SEED_PLAYERS, ZONE_ARENA,
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

/// One accepted shot every 800 ms. The comparison is
/// `arena.tick > last_shot_tick + SHOT_COOLDOWN_TICKS`, so 0 would mean one shot per tick
/// — the hard ceiling the tick clock can express.
const SHOT_COOLDOWN_TICKS: u32 = crate::state::ticks_for(800) - 1;

/// Damage per landed shot, to a part or to the core. Balance against whatever
/// `parts_max` / `core_hp_max` the boss is spawned with; this is the knob to turn
/// when time-to-kill is wrong, not the hitboxes. (Raid size is answered by the
/// `core_hp` top-up in `tick.rs`, never by this or by `parts`.)
const SHOT_DAMAGE: u16 = 40;

/// `Boss.vent_open`. 1 open, 0 sealed.
const VENT_OPEN: u8 = 1;

/// The vent opens at `sum(parts) < 35% of sum(parts_max)`, compared as
/// `sum × 100 < sum_max × 35` so no percentage is ever a float.
const VENT_THRESHOLD_NUM: u32 = 35;
const VENT_THRESHOLD_DEN: u32 = 100;

/// Recompute `Boss.vent_open` from the parts, and answer whether it is open.
///
/// The vent is **derived state**, cached on the account for the client — never set
/// independently, or it drifts out of agreement with the numbers it summarises. This is
/// the only place in this file that writes it, and it runs on the same line that changed
/// a part, so "the shell crossed the threshold" and "the vent is open" cannot be two
/// different facts.
///
/// `pub(crate)` because `boss_tick` re-derives exactly this every tick from its own copy
/// of the rule; that copy is the shell threshold stored twice and should call this
/// instead (see the run's todo).
///
/// The sums cannot overflow `u32` (9 × 65,535 × 100 ≈ 59 M) but are saturating anyway.
pub(crate) fn recompute_vent(boss: &mut Boss) -> bool {
    let shell: u32 = boss.parts.iter().map(|&hp| hp as u32).sum();
    let shell_max: u32 = boss.parts_max.iter().map(|&hp| hp as u32).sum();
    let open =
        shell.saturating_mul(VENT_THRESHOLD_DEN) < shell_max.saturating_mul(VENT_THRESHOLD_NUM);
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

/// Everything a shot does to the world, given state that has already been proved to
/// belong to this arena and this signer.
///
/// Split out of [`process`] because this is the only part of the instruction with a
/// game in it, and an `AccountView` fixture is not a boss fight. The kill chain — shell
/// down, vent open, core down, match won — is testable end to end against plain structs
/// only if it lives in a function that takes plain structs, and until this split the
/// chain had never been executed anywhere, on chain or off (M4).
fn fire(
    arena: &mut Arena,
    boss: &mut Boss,
    slot: &mut PlayerSlot,
    dx: i8,
    dy: i8,
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

    // Rate limit, in ticks. `saturating_add` rather than `+`: a `last_shot_tick`
    // close to u32::MAX must fail the comparison, not wrap into "ready".
    if arena.tick <= slot.last_shot_tick.saturating_add(SHOT_COOLDOWN_TICKS) {
        return Err(HeartrotError::RateLimited.into());
    }
    slot.last_shot_tick = arena.tick;

    // Firing turns you: `facing` replicates, so a remote client draws the recoil and the
    // tracer along the direction the shot was actually taken in.
    slot.facing = facing;

    let dealt = match raycast(slot.x, slot.y, dx, dy, boss) {
        Some(Hit::Part(index)) => {
            let part = &mut boss.parts[index];
            // Credit only what was actually removed, or a finishing shot on a
            // 1 HP part would score a full 40 on the leaderboard.
            let dealt = (*part).min(SHOT_DAMAGE);
            // Reaching 0 *is* being destroyed: `raycast` skips a zeroed part, so the
            // limb detaches and the lane behind it opens with no second flag to set.
            *part = part.saturating_sub(SHOT_DAMAGE);
            recompute_vent(boss);
            dealt
        }

        // The shell absorbs anything aimed at a sealed vent. The shot is spent, the
        // cooldown is spent, the core is untouched — which is the pressure that makes
        // stripping parts the only route to a kill.
        Some(Hit::Core) if boss.vent_open != VENT_OPEN => 0,

        Some(Hit::Core) => {
            let dealt = boss.core_hp.min(SHOT_DAMAGE);
            boss.core_hp = boss.core_hp.saturating_sub(SHOT_DAMAGE);
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
/// Instruction data (after the dispatcher has taken the instruction byte):
/// `[seat: u8, dx: i8, dy: i8]` — 4 bytes on the wire, was 3. An old client sending the
/// old `[tag, seat, dir]` gets a clean length refusal here, which is the whole reason
/// this is safe to ship: program and app must ship together, and they will fail loudly
/// rather than reinterpret a direction index as an aim vector. See
/// `docs/architecture/05-wire-abi.md`.
///
/// Every `(dx, dy)` except `(0, 0)` is a legal aim, so there is no range check on the
/// pair; `fire` rejects the zero vector through `octant`.
///
/// `program_id` is the runtime's own value, threaded down from the entrypoint like every
/// other handler takes it. There is no hard-coded program address anywhere in this crate:
/// the deployed key is a deploy-time fact the Worker carries in `PROGRAM_ID`, and a
/// constant baked in here would be one more thing to get wrong on a redeploy.
pub fn process(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [arena_account, boss_account, players_account, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let &[seat, dx, dy] = data else {
        return Err(ProgramError::InvalidInstructionData);
    };
    let (dx, dy) = (dx as i8, dy as i8);

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

    // Only a live match takes fire. A `SETTLING` arena has its `outcome` written and is
    // waiting to be committed; a shot landing after that would damage a boss whose match
    // is already scored. `PHASE_MUSTERING` fails this test too, so weapons stay down for
    // the whole muster window without a second rule.
    if arena.phase != PHASE_FIGHTING {
        return Err(HeartrotError::WrongPhase.into());
    }

    let slot = players
        .slots
        .get_mut(seat as usize)
        .ok_or(HeartrotError::SeatOutOfRange)?;

    // The entire security perimeter, not one layer of it: this signer must be the
    // session key stored on the seat being fired from.
    assert_session_authority(slot, authority)?;

    fire(arena, boss, slot, dx, dy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::BOSS_SPAWN;
    use crate::state::{
        Bullet, BULLET_ACTIVE, MAX_BULLETS, N_PARTS, OUTCOME_UNDECIDED, PHASE_SETTLING,
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

    /// Advance past the cooldown and take one shot along the surveyed lane, which must be
    /// accepted.
    fn shoot_lane(s: &Survey, arena: &mut Arena, boss: &mut Boss, slot: &mut PlayerSlot) {
        arena.tick += SHOT_COOLDOWN_TICKS + 1;
        fire(arena, boss, slot, s.aim.0, s.aim.1).expect("a live seat off cooldown may fire");
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
        assert!(is_wall(MAP_TILES as i32 * TILE as i32, 0), "off-map is solid");
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
        let mut boss = standing_boss();
        let mut slot = shooter(&s);

        let mut cleared = 0;
        for index in 0..N_PARTS {
            if index != s.blocker && cleared < 5 {
                boss.parts[index] = 0;
                cleared += 1;
            }
        }
        recompute_vent(&mut boss);
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
        recompute_vent(&mut boss);
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
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1).unwrap_err(),
            HeartrotError::RateLimited.into(),
        );
        arena.tick += 1;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1).unwrap_err(),
            HeartrotError::RateLimited.into(),
        );
        assert_eq!(boss.parts[s.blocker], 60, "a refused shot deals nothing");

        // A miss into the empty air behind still burns the shot. Advancing by the
        // cooldown itself, not by a hardcoded 1: the window is a duration (800 ms)
        // divided by TICK_MS, so a literal here would silently stop testing the boundary
        // the moment the tick rate moved — which is exactly what it did.
        arena.tick += SHOT_COOLDOWN_TICKS + 1;
        fire(&mut arena, &mut boss, &mut slot, -s.aim.0, -s.aim.1).expect("off cooldown");
        assert_eq!(slot.last_shot_tick, arena.tick);
        assert_eq!(boss.parts[s.blocker], 60, "the miss dealt nothing");
        assert_eq!(
            fire(&mut arena, &mut boss, &mut slot, s.aim.0, s.aim.1).unwrap_err(),
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
        assert_eq!(slot.damage_dealt, SHOT_DAMAGE as u32);
        assert!(
            arena.bullets.iter().all(|b| b.active == BULLET_ACTIVE
                && (b.x, b.y, b.dx, b.dy) == (1, 2, 3, 4)),
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
            fire(&mut arena, &mut boss, &mut dead, s.aim.0, s.aim.1).unwrap_err(),
            HeartrotError::PlayerDead.into(),
        );

        let mut in_lobby = shooter(&s);
        in_lobby.zone = crate::state::ZONE_LOBBY;
        assert_eq!(
            fire(&mut arena, &mut boss, &mut in_lobby, s.aim.0, s.aim.1).unwrap_err(),
            HeartrotError::WrongZone.into(),
        );

        let mut live = shooter(&s);
        assert_eq!(
            fire(&mut arena, &mut boss, &mut live, 0, 0).unwrap_err(),
            ProgramError::InvalidInstructionData,
        );
        assert_eq!(live.last_shot_tick, 0, "a malformed aim spends nothing");

        assert_eq!(boss.parts[s.blocker], 100);
    }
}
