//! `shoot(seat, dir)` — the player attack, hitscan.
//!
//! No projectile entity is ever allocated. The ray is walked here, in integer tile
//! steps, and the damage lands in the same transaction that fired it. That is the
//! whole point of the asymmetry in the design spec §3: the player's own fire must
//! feel instant, so it resolves at send time and the visible tracer is client-side
//! animation only; incoming fire must be dodgeable, so the boss gets travel time and
//! a pooled bullet array advanced by the crank.
//!
//! Two consequences worth stating, because both are security properties:
//!
//! - **The cooldown is counted in `Arena.tick`, never milliseconds.** Ticks are the
//!   only clock the ER agrees on — 400 ms is the crank's target, not a contract — and
//!   a wall-clock cooldown would pay out to whoever has the lowest ping. Ticks make
//!   fire rate identical from Ghaziabad and from Frankfurt.
//! - **The cooldown is spent by the attempt, not by the hit.** ER transaction fees
//!   are 0 lamports and the ER runs no fee-payer validation at all, so nothing debits
//!   a spammer (D16). `last_shot_tick` *is* the rate limiter; refunding it on a miss
//!   would hand an attacker an unlimited-rate instruction.
//!
//! Everything below is integer. Squared distances are compared against squared radii;
//! there is no `sqrt` and no float anywhere, because a float would make the client's
//! local hit prediction disagree with the chain by exactly the amount that makes a
//! shot look like it landed and score nothing.

use pinocchio::{error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::HeartrotError;
use crate::guards::{
    assert_owned_by, assert_pda, assert_session_authority, assert_signer, assert_writable,
};
use crate::hitboxes::{CORE_RADIUS_SQ, CORE_X, CORE_Y, PART_HITBOXES};
use crate::map;
use crate::state::{
    load_mut, Arena, Boss, Players, PHASE_FIGHTING, PHASE_SETTLING, SEED_BOSS, SEED_PLAYERS,
    ZONE_ARENA,
};

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/// Arena space is 16 units per tile over the 64×64 map, so 0..1024 on both axes.
/// `PlayerSlot.x`, `Boss.x` and `Bullet.x` are all in these units — the layout
/// contract requires one shared unit and does not name it, so it is named here.
/// Widened from `map::TILE` rather than re-typed, and asserted equal, so the ray and
/// the wall table can never disagree about how big a tile is.
const TILE: i32 = map::TILE as i32;

/// The ray advances one tile per step and gives up after this many. Range therefore
/// reads as "twenty tiles", which is the number to tune for feel.
const MAX_RAY_STEPS: i32 = 20;

/// Is the tile under this arena-space point solid? Off-map is solid, and negatives are
/// walls *before* the divide because `-1 / 16` truncates to tile 0.
///
/// This is the same decision as `handlers::player::is_wall`, over the same generated
/// `map::WALLS` table — that one is `i16` and private to movement, this one is the `i32`
/// the ray already walks in. One table, so a corridor that blocks a step also blocks a
/// shot; that is what makes a two-player front on a 2-wide corridor mean anything.
fn is_wall(x: i32, y: i32) -> bool {
    if x < 0 || y < 0 {
        return true;
    }
    let (tx, ty) = ((x / TILE) as usize, (y / TILE) as usize);
    if tx >= map::MAP_TILES {
        return true;
    }
    match map::WALLS.get(ty) {
        Some(row) => row & (1u64 << tx) != 0,
        None => true,
    }
}

/// Eight-way `PlayerSlot.facing`, clockwise from north. `y` grows downward, matching
/// screen space and the client's tile grid.
const FACING_STEP: [(i32, i32); 8] = [
    (0, -1),  // 0 N
    (1, -1),  // 1 NE
    (1, 0),   // 2 E
    (1, 1),   // 3 SE
    (0, 1),   // 4 S
    (-1, 1),  // 5 SW
    (-1, 0),  // 6 W
    (-1, -1), // 7 NW
];

// ---------------------------------------------------------------------------
// Balance knobs
// ---------------------------------------------------------------------------

/// One accepted shot every two ticks (~800 ms at the crank's target rate). The
/// comparison is `arena.tick > last_shot_tick + SHOT_COOLDOWN_TICKS`, so 0 would mean
/// one shot per tick — the hard ceiling the tick clock can express.
const SHOT_COOLDOWN_TICKS: u32 = 1;

/// Damage per landed shot, to a part or to the core. Balance against whatever
/// `parts_max` / `core_hp_max` the boss is spawned with; this is the knob to turn
/// when time-to-kill is wrong, not the hitboxes.
const SHOT_DAMAGE: u16 = 40;

/// `Boss.vent_open`. 1 open, 0 sealed.
const VENT_OPEN: u8 = 1;

/// The vent opens at `sum(parts) < 35% of sum(parts_max)`, compared as
/// `sum × 100 < sum_max × 35` so no percentage is ever a float.
const VENT_THRESHOLD_NUM: u32 = 35;
const VENT_THRESHOLD_DEN: u32 = 100;

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

/// What the ray struck first, as pure geometry. Whether a `Core` hit is *damageable*
/// is a game rule (the vent must be open) and is decided by the caller, not here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hit {
    Part(usize),
    Core,
}

/// Walk the ray one tile at a time from `(from_x, from_y)` along `dir`; first hit
/// wins, and a solid tile stops it.
///
/// A part with 0 HP is destroyed and detached, so the ray passes straight through it
/// — stripping the shell is what opens a lane to the core, and that falls out of the
/// geometry rather than needing a separate "exposed" flag.
///
/// All arithmetic widens to `i32` before it is used, which is what makes it safe
/// rather than merely checked: the worst case is two `i16` extremes squared and
/// summed, 2,147,352,578, which still fits `i32::MAX`.
///
/// There is no cheap out-of-reach pre-test any more. The wall test *is* the early
/// out — off the map and off a corridor are the same rejection — and the distance
/// check it replaced needed a hand-guessed "boss half-extent" constant, which is the
/// exact kind of number that drifts away from the art it claims to describe.
fn raycast(from_x: i16, from_y: i16, dir: u8, boss: &Boss) -> Option<Hit> {
    let (step_x, step_y) = FACING_STEP[(dir & 7) as usize];
    let (boss_x, boss_y) = (boss.x as i32, boss.y as i32);
    let (mut x, mut y) = (from_x as i32, from_y as i32);

    for _ in 0..MAX_RAY_STEPS {
        x += step_x * TILE;
        y += step_y * TILE;

        // Cover. The same generated bitboard movement collides against, so a corridor
        // wall stops a shot exactly where it stops a player — that equivalence is the
        // whole reason a 2-tile front is defensible.
        if is_wall(x, y) {
            return None;
        }

        let (local_x, local_y) = (x - boss_x, y - boss_y);

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
// Handler
// ---------------------------------------------------------------------------

/// Accounts, in order:
///
/// | # | Account | |
/// |---|---|---|
/// | 0 | `Arena` | writable — `tick` is read, `phase` is written on the killing blow |
/// | 1 | `Boss` | writable — parts, vent, core |
/// | 2 | `Players` | writable — the acting seat only |
/// | 3 | `authority` | signer, the browser's session key |
///
/// Instruction data (after the dispatcher has taken the instruction byte):
/// `[seat: u8, dir: u8]`.
///
/// `program_id` is the runtime's own value, threaded down from the entrypoint like every
/// other handler takes it. There is no hard-coded program address anywhere in this crate:
/// the deployed key is a deploy-time fact the Worker carries in `PROGRAM_ID`, and a
/// constant baked in here would be one more thing to get wrong on a redeploy.
pub fn process(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [arena_account, boss_account, players_account, authority, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let &[seat, dir] = data else {
        return Err(ProgramError::InvalidInstructionData);
    };
    if dir >= FACING_STEP.len() as u8 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Pinocchio validates nothing, so every one of these is hand-written and every
    // one of them is load-bearing. They run before any state is touched.
    assert_signer(authority)?;
    for account in [&*arena_account, &*boss_account, &*players_account] {
        assert_owned_by(account, program_id)?;
        assert_writable(account)?;
    }

    // `Boss` and `Players` must belong to *this* arena. Without these two checks a
    // caller could pair a live `Arena` with the `Boss` of a different match and drain
    // that boss on this match's clock. The `Arena` account itself needs no
    // re-derivation: owner + discriminator already prove it is one of ours, and a
    // rogue arena can only reach the boss and players derived from itself.
    //
    // The bump is re-derived by the guard rather than read off the account: a stored
    // bump is data the account claims about itself, and a non-canonical one would
    // validate a second, parallel `Boss` for the same arena. These run before the data
    // borrows because every guard takes `&AccountView`.
    let arena_key = *arena_account.address();
    assert_pda(boss_account, &[SEED_BOSS, arena_key.as_ref()], program_id)?;
    assert_pda(players_account, &[SEED_PLAYERS, arena_key.as_ref()], program_id)?;

    let mut arena_data = arena_account.try_borrow_mut()?;
    let arena = load_mut::<Arena>(&mut arena_data)?;
    let mut boss_data = boss_account.try_borrow_mut()?;
    let boss = load_mut::<Boss>(&mut boss_data)?;
    let mut players_data = players_account.try_borrow_mut()?;
    let players = load_mut::<Players>(&mut players_data)?;

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

    // Firing turns you: the client draws the recoil along `facing`, and the next
    // shot's ray starts from the same direction the player last saw.
    slot.facing = dir;

    let dealt = match raycast(slot.x, slot.y, dir, boss) {
        Some(Hit::Part(index)) => {
            let part = &mut boss.parts[index];
            // Credit only what was actually removed, or a finishing shot on a
            // 1 HP part would score a full 40 on the leaderboard.
            let dealt = (*part).min(SHOT_DAMAGE);
            *part = part.saturating_sub(SHOT_DAMAGE);

            // The vent is derived state, recomputed from the parts every time they
            // change — never set independently, or it drifts out of agreement with
            // the numbers it is supposed to summarise. Integer comparison of
            // `sum × 100 < sum_max × 35`; the sums cannot overflow u32
            // (9 × 65,535 × 100 ≈ 59M) but are saturating anyway.
            let shell: u32 = boss.parts.iter().map(|&hp| hp as u32).sum();
            let shell_max: u32 = boss.parts_max.iter().map(|&hp| hp as u32).sum();
            boss.vent_open = u8::from(
                shell.saturating_mul(VENT_THRESHOLD_DEN)
                    < shell_max.saturating_mul(VENT_THRESHOLD_NUM),
            );

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
                // Win. `boss_tick` would reach the same conclusion within 400 ms, but
                // the killing blow should land on the killer's own screen instantly,
                // and the crank re-deriving it costs nothing.
                arena.phase = PHASE_SETTLING;
            }
            dealt
        }

        // A miss. The cooldown above was already spent — that is deliberate.
        None => 0,
    };

    slot.damage_dealt = slot.damage_dealt.saturating_add(dealt as u32);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::N_PARTS;
    use bytemuck::Zeroable;

    const EAST: u8 = 2;
    const WEST: u8 = 6;

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

    /// The boss spawns at the centre of the heart chamber, tile (32, 32), which is
    /// where `tick.rs` puts it and what the map generator asserts.
    const BOSS_XY: i16 = 32 * 16;

    /// The whole attack is this function: if it picks the wrong box, or keeps a
    /// destroyed part solid, or walks through a wall, the game is wrong in a way no
    /// account check would catch.
    ///
    /// The expected indices below are read off the *generated* table, so if the art
    /// moves and the table is regenerated this test is supposed to be re-derived with
    /// it. It is here to prove the ray consults that table in order, not to pin the
    /// coordinates a second time.
    #[test]
    fn ray_takes_the_first_intact_box() {
        let mut boss = boss_at(BOSS_XY, BOSS_XY);

        // Level with the boss centre, twelve tiles west along the open row the west
        // corridor opens onto. Part 7 spans local x −114..−3 at this height, so it is
        // the first box the ray enters.
        assert_eq!(raycast(320, BOSS_XY, EAST, &boss), Some(Hit::Part(7)));

        // Strip it and the same shot reaches the vent behind it.
        boss.parts[7] = 0;
        assert_eq!(raycast(320, BOSS_XY, EAST, &boss), Some(Hit::Core));

        // Fired away from the boss: nothing but floor, then the west edge.
        assert_eq!(raycast(320, BOSS_XY, WEST, &boss), None);
    }

    #[test]
    fn walls_stop_the_ray() {
        // Off the map is solid, so a ray that would leave the arena stops at the edge
        // rather than sampling negative space.
        assert_eq!(raycast(10, BOSS_XY, WEST, &boss_at(BOSS_XY, BOSS_XY)), None);

        // Cover, which is the point of raycasting the map at all. Row y = 28 is a hall
        // row with the chamber's outer rock at tiles 15..23; from tile 10 the geometry
        // would otherwise reach a part, and the wall eats the shot instead.
        let boss = boss_at(BOSS_XY, BOSS_XY);
        assert!(!is_wall(10 * 16, 28 * 16));
        assert!(is_wall(15 * 16, 28 * 16));
        assert_eq!(raycast(10 * 16, 28 * 16, EAST, &boss), None);
    }
}
