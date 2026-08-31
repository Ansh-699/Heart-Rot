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

use crate::guards::{
    assert_owned_by, assert_pda, assert_session_authority, assert_signer, assert_writable,
};
use crate::state::{
    load_mut, Arena, Boss, Players, N_PARTS, PHASE_FIGHTING, PHASE_SETTLING, SEED_BOSS,
    SEED_PLAYERS, ZONE_ARENA,
};

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/// Arena space is 16 units per tile over the 64×64 map, so 0..1024 on both axes.
/// `PlayerSlot.x`, `Boss.x` and `Bullet.x` are all in these units — the layout
/// contract requires one shared unit and does not name it, so it is named here.
const TILE: i32 = 16;
const ARENA_SIZE: i32 = 64 * TILE;

/// The ray advances one tile per step and gives up after this many. Range therefore
/// reads as "twenty tiles", which is the number to tune for feel.
const MAX_RAY_STEPS: i32 = 20;

/// Cheap rejection before walking anything: the boss centre must be within reach at
/// all. `MAX_RAY_STEPS * TILE` of ray plus a generous boss half-extent (the far
/// corner of the sprite box is ~148 units from centre).
const MAX_REACH_SQ: i32 = (MAX_RAY_STEPS * TILE + 160) * (MAX_RAY_STEPS * TILE + 160);

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

/// A boss-local axis-aligned box, in arena units relative to `Boss.x` / `Boss.y`.
#[derive(Clone, Copy)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl Rect {
    /// Half-open on both axes, so touching rectangles cannot both claim a step.
    fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

/// Index-aligned with `Boss.parts`: crown, wolf_l, beast_r, thorn0..3, mace, claws.
///
/// ponytail: hand-written numbers for a hand-drawn boss, which is exactly what build
/// step 0b calls for ("hitscan against hardcoded hitboxes"). The upgrade path is
/// already designed — `tools/svg_slice.py` emits `<part>.hitboxes.json` with integer
/// x/y/w/h per part from the same slice that produces the `<g>` groups the browser
/// animates — so this table becomes generated, and the DOM and the chain stop being
/// able to drift. Until that file exists these numbers are the contract, and the
/// renderer must be positioned from them rather than the other way round.
///
/// Every box is at least one `TILE` wide and tall on purpose: the ray samples one
/// point per tile, so anything narrower could be stepped straight over.
const PART_HITBOXES: [Rect; N_PARTS] = [
    Rect { x: -40, y: -112, w: 80, h: 40 }, // 0 crown
    Rect { x: -96, y: -80, w: 56, h: 56 },  // 1 wolf_l
    Rect { x: 40, y: -80, w: 56, h: 56 },   // 2 beast_r
    Rect { x: -88, y: -16, w: 32, h: 32 },  // 3 thorn0
    Rect { x: 56, y: -16, w: 32, h: 32 },   // 4 thorn1
    Rect { x: -88, y: 48, w: 32, h: 32 },   // 5 thorn2
    Rect { x: 56, y: 48, w: 32, h: 32 },    // 6 thorn3
    Rect { x: 56, y: 80, w: 40, h: 48 },    // 7 mace
    Rect { x: -96, y: 80, w: 40, h: 48 },   // 8 claws
];

/// The vent is round, so it is a circle rather than a rectangle: centre offset from
/// `Boss.x`/`Boss.y` and a *squared* radius, compared against a squared distance.
const CORE_X: i32 = 0;
const CORE_Y: i32 = 16;
const CORE_RADIUS_SQ: i32 = 24 * 24;

/// What the ray struck first, as pure geometry. Whether a `Core` hit is *damageable*
/// is a game rule (the vent must be open) and is decided by the caller, not here.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hit {
    Part(usize),
    Core,
}

/// Walk the ray one tile at a time from `(from_x, from_y)` along `dir`; first hit
/// wins, and a step outside the arena is a wall that stops it.
///
/// A part with 0 HP is destroyed and detached, so the ray passes straight through it
/// — stripping the shell is what opens a lane to the core, and that falls out of the
/// geometry rather than needing a separate "exposed" flag.
///
/// All arithmetic widens to `i32` before it is used, which is what makes it safe
/// rather than merely checked: the worst case is two `i16` extremes squared and
/// summed, 2,147,352,578, which still fits `i32::MAX`.
fn raycast(from_x: i16, from_y: i16, dir: u8, boss: &Boss) -> Option<Hit> {
    let (step_x, step_y) = FACING_STEP[(dir & 7) as usize];
    let (boss_x, boss_y) = (boss.x as i32, boss.y as i32);
    let (mut x, mut y) = (from_x as i32, from_y as i32);

    // Out of reach entirely — skip 20 steps × 10 boxes of work. Squared distance
    // against a squared radius; there is no sqrt in this program.
    let (to_boss_x, to_boss_y) = (boss_x - x, boss_y - y);
    if to_boss_x * to_boss_x + to_boss_y * to_boss_y > MAX_REACH_SQ {
        return None;
    }

    for _ in 0..MAX_RAY_STEPS {
        x += step_x * TILE;
        y += step_y * TILE;

        // Wall. The arena boundary is the only wall the chain knows about.
        //
        // ponytail: interior cover is not modelled, so a shot passes through any
        // pillar the map art draws. Upgrade path when the map gains real cover: a
        // 64×64 wall bitmask (512 B) on `Arena`, sampled with the same tile step this
        // loop already walks.
        if x < 0 || y < 0 || x >= ARENA_SIZE || y >= ARENA_SIZE {
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
        return Err(ProgramError::InvalidArgument);
    }

    let slot = players
        .slots
        .get_mut(seat as usize)
        .ok_or(ProgramError::InvalidInstructionData)?;

    // The entire security perimeter, not one layer of it: this signer must be the
    // session key stored on the seat being fired from.
    assert_session_authority(slot, authority)?;

    // Dead players and lobby players have nothing to shoot with or at.
    if slot.hp == 0 || slot.zone != ZONE_ARENA {
        return Err(ProgramError::InvalidArgument);
    }

    // Rate limit, in ticks. `saturating_add` rather than `+`: a `last_shot_tick`
    // close to u32::MAX must fail the comparison, not wrap into "ready".
    if arena.tick <= slot.last_shot_tick.saturating_add(SHOT_COOLDOWN_TICKS) {
        return Err(ProgramError::InvalidArgument);
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

    /// The whole attack is this function: if it picks the wrong box, or keeps a
    /// destroyed part solid, or walks through a wall, the game is wrong in a way no
    /// account check would catch.
    #[test]
    fn ray_takes_the_first_intact_box() {
        let mut boss = boss_at(512, 512);

        // Level with the boss centre, 200 units west: the thorn cluster at local
        // x −88..−56 is the first box the ray enters.
        assert_eq!(raycast(312, 512, EAST, &boss), Some(Hit::Part(3)));

        // Strip that thorn and the same shot reaches the vent behind it.
        boss.parts[3] = 0;
        assert_eq!(raycast(312, 512, EAST, &boss), Some(Hit::Core));

        // Fired away from the boss: nothing in 20 tiles.
        assert_eq!(raycast(312, 512, WEST, &boss), None);
    }

    #[test]
    fn walls_and_range_stop_the_ray() {
        // A ray that would leave the arena stops at the boundary rather than
        // sampling negative space.
        let corner_boss = boss_at(100, 100);
        assert_eq!(raycast(10, 100, WEST, &corner_boss), None);

        // Out of reach: rejected before a single step is walked.
        assert_eq!(raycast(20, 20, EAST, &boss_at(512, 512)), None);
    }
}
