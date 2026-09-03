//! HEARTROT account byte layout — the single source of truth for on-chain state.
//!
//! Everything here is plain-old-data cast in place with `bytemuck`. Nothing is
//! serialized, ever: the crank rewrites `Arena` every 400 ms and a borsh round trip
//! of a 1 KB bullet pool at 2.5 Hz is the exact cost that made the ECS design
//! untenable (`01-architecture.md` §0.1).
//!
//! Four accounts, not eighty-six. The ER rejects any transaction whose
//! `program_id_index >= 38`, and Solana's message compiler sorts program ids last,
//! so for a write-heavy transaction that is a ~38 *total account key* ceiling with
//! no escape hatch — address lookup tables are rejected outright by the same
//! validator path (D3, D18, R0.4). Packing is the only lever, so all 20 players
//! live in one account and the crank's frozen account list is 3 entries long.
//!
//! Layout rules, all load-bearing:
//!
//! - `#[repr(C)]` + explicit `_pad` fields. `bytemuck`'s `Pod` derive refuses to
//!   compile on a struct with implicit padding, and an implicit gap is a layout bug
//!   that would only surface as a client decoding garbage.
//! - Byte 0 is a discriminator, byte 1 a version, byte 2 the PDA bump, in every
//!   account type. Pinocchio validates nothing; the discriminator is the only thing
//!   stopping `Boss` being passed where `Players` is expected. It is a security
//!   control, not bookkeeping.
//! - No `bool`, no `Option`, no `Vec`, no enum with a payload, no float. Floats are
//!   non-deterministic across validators; the rest are not `Pod`. Optionality is a
//!   documented sentinel.
//! - Little-endian throughout, matching Solana and matching `packages/client/src/layout.ts`,
//!   which is generated from the same table in `docs/architecture/04-layout-contract.md`.
//!
//! `bytemuck::from_bytes` *panics* on misalignment rather than erroring, so every
//! cast here goes through `try_from_bytes`. In practice the runtime hands us an
//! 8-byte-aligned data pointer (the account region is 8-aligned and the header
//! preceding `data` is exactly 88 bytes), which satisfies every alignment below —
//! but "in practice" is not a thing to bet a program on.

use bytemuck::{Pod, Zeroable};
use core::mem::{align_of, offset_of, size_of};
use pinocchio::error::ProgramError;

use crate::error::HeartrotError;

// ---------------------------------------------------------------------------
// Capacities and layout-defining constants
// ---------------------------------------------------------------------------

/// Seats are fixed and index-addressed. A crank can never see an account it was not
/// handed at schedule time, so every seat must exist before `boss_tick` is armed;
/// lazy join is structurally impossible (R15).
pub const MAX_SEATS: usize = 20;

/// Boss projectiles are a fixed pool — no allocation at bullet-hell rates.
pub const MAX_BULLETS: usize = 128;

/// crown, wolf_l, beast_r, thorn0..3, mace, claws.
pub const N_PARTS: usize = 9;

/// Ring capacity of the base-layer leaderboard: ~6 full 20-player raids of history.
///
/// ponytail: fixed ring, oldest entry is overwritten with no archive. Sized so the
/// whole account (6,176 B) fits in a single `CreateAccount` well under the 10,240-byte
/// per-instruction data-increase limit. Upgrade path when history matters: one
/// account per incarnation, seeds `[b"lb", incarnation.to_le_bytes()]`.
pub const LEADERBOARD_CAP: usize = 128;

/// Byte 0 of every account. 0 is reserved for "freshly allocated, all zeroes", which
/// is what makes an uninitialized account fail every read without an extra flag.
pub const DISC_UNINITIALIZED: u8 = 0;
pub const DISC_ARENA: u8 = 1;
pub const DISC_BOSS: u8 = 2;
pub const DISC_PLAYERS: u8 = 3;
pub const DISC_LEADERBOARD: u8 = 4;

/// Byte 1 of every account. Bumping this is how a redeploy that changes any offset
/// below signals "the accounts on chain are the old shape" instead of silently
/// misreading them.
pub const LAYOUT_VERSION: u8 = 1;

/// `Arena.phase` — **where the match is**, never **how the fight ended**. The outcome is
/// [`Arena::outcome`], a separate byte, because a phase cannot carry it past
/// `PHASE_SETTLED`: "did the raid win?" has to stay answerable after settlement, and
/// encoding it in the phase would need a `SettledWon` / `SettledWiped` pair and then a
/// third for every phase after. One axis each. Values 0..3 are frozen (accounts are live
/// on devnet, and `packages/client` plus `app/` switch on them); 4, 5 and 6 are appended.
///
/// The complete legal-transition table is [`Arena::may_transition`], and every phase write
/// in the program goes through [`Arena::try_set_phase`] or one of the three total helpers
/// beside it. Assigning `arena.phase` directly is how six handlers come to disagree about
/// what a phase means.
pub const PHASE_LOBBY: u8 = 0;
pub const PHASE_FIGHTING: u8 = 1;
/// The fight is over and the result is recorded in `outcome`; nothing is committed yet.
/// Reached on a win, a wipe, an enrage, and on an abandoned VRF roll.
pub const PHASE_SETTLING: u8 = 2;
pub const PHASE_SETTLED: u8 = 3;
/// A VRF request for the next incarnation's seed is in flight. Committing here is refused
/// (tag 11): the callback would land on an account the ER no longer holds, fail, and be
/// retried by the oracle for the whole 240-slot request TTL.
///
/// Undelegating (tags 9 and 12) is *allowed*, and that asymmetry is deliberate. `tick` is
/// advanced only by `boss_tick`, so a crank that dies inside the roll window freezes the
/// clock [`Arena::abandon_roll`] measures against — the timeout can never elapse, and
/// without a `ROLLING → SETTLED` edge nothing in this program could ever hand `Arena`,
/// `Boss` and `Players` back to the base layer. A bounded burst of oracle retries, capped
/// by the request's own TTL, is strictly cheaper than three accounts delegated forever.
pub const PHASE_ROLLING: u8 = 4;
/// The seed is in `next_affix_seed` and the match is ready to settle.
pub const PHASE_ROLLED: u8 = 5;
/// The gate is open and a fixed-length muster window is running. Weapons are down —
/// `shoot` tests `== PHASE_FIGHTING` — but joining, moving and `enter_gate` are legal, so
/// the raid assembles in the pit while the camera pans onto the boss.
///
/// Appended after [`PHASE_ROLLED`] rather than inserted, so 0..=5 keep their meaning for
/// every account already on devnet and for every deployed client's phase switch.
pub const PHASE_MUSTERING: u8 = 6;

/// `Arena.outcome` — how the fight ended. Write-once per incarnation: set by
/// [`Arena::end_fight`] while it is [`OUTCOME_UNDECIDED`], cleared only by
/// [`Arena::begin_next_incarnation`]. It survives settlement, which is the entire reason
/// it is not a phase.
pub const OUTCOME_UNDECIDED: u8 = 0;
/// Core HP reached 0. The only outcome that may roll the next incarnation.
pub const OUTCOME_WIN: u8 = 1;
/// Every seat standing in the arena was dead at the same tick.
pub const OUTCOME_WIPE: u8 = 2;
/// `enrage_at_tick` passed with the core still alive. A wipe for scoring purposes, kept
/// distinct because "you ran out of time" and "you all died" are different sentences on
/// the end screen and there is no other way to tell them apart afterwards.
pub const OUTCOME_ENRAGE: u8 = 3;

/// The crank period, and the only place a simulation rate is chosen.
///
/// Every duration in this program is written in MILLISECONDS and converted through
/// [`ticks_for`], so changing this one number rescales the whole simulation correctly
/// instead of leaving six hand-tuned tick counts to be found and divided by hand. That
/// mattered: a tick count is a duration stored in units of a constant somewhere else,
/// which is the fact-stored-twice shape behind every serious defect this project has had.
///
/// Why 100 ms and not the 50 ms ER slot, which is genuinely the floor: bullet velocity is
/// integer units per tick in an `i8`, so a faster tick makes each step smaller and the
/// direction quantisation coarser. At 400 ms a step was 48 units and the worst angular
/// error ~0.6 degrees; at 100 ms it is 12 units and ~2.4 degrees; at 50 ms it would be 6
/// units and ~4.8 degrees, which is about 2.6 tiles of lateral drift over a long shot —
/// far enough to miss a player the boss was aiming at. Going below 100 ms wants
/// sub-unit velocity in the `Bullet` layout first, which is a layout change, not a knob.
pub const TICK_MS: u32 = 100;

/// A duration in milliseconds as a whole number of ticks, never rounding down to zero —
/// a zero-tick cooldown would be no cooldown at all.
pub const fn ticks_for(ms: u32) -> u32 {
    let n = ms / TICK_MS;
    if n == 0 {
        1
    } else {
        n
    }
}

/// Crank ticks a VRF roll may stay in [`PHASE_ROLLING`] before `boss_tick` abandons it.
///
/// Ten seconds, against a documented in-ER fulfilment of ~100 ms and a hard floor of one ER
/// slot — far past any legitimate callback, still short enough that a VRF outage does not
/// look like a hang. Written as a duration, so it stayed ten seconds when `TICK_MS` went
/// 400 → 100 and the tick count went 25 → 100. `packages/client/src/layout.ts` mirrors this
/// and still carries the 400 ms-era literal `25`; that mirror is wrong, not this.
///
/// Abandoning writes **no seed**. The fallback is deliberately not "derive one from
/// SlotHashes and carry on": a validator-influenceable seed is not verifiable randomness,
/// and an incarnation whose ruleset was quietly chosen by whoever produced a block is the
/// exact property the VRF exists to deny. `begin_next_incarnation` then refuses with
/// `WrongPhase` — loud and recoverable, rather than silent and wrong.
pub const ROLL_TIMEOUT_TICKS: u32 = ticks_for(10_000);

/// How long [`PHASE_MUSTERING`] lasts: twenty seconds from the first knight through the
/// gate to the boss waking up.
///
/// The only number in the muster design with no derivation behind it — a guess at how long
/// a player will stand still. It is one `ticks_for` call in one place, which is the whole
/// reason it is cheap to be wrong about. If fixed-length turns out wrong in principle, the
/// escape hatch is a monotone-decreasing clamp in `begin_muster`
/// (`fight_at_tick = min(fight_at_tick, tick + LOCK_TICKS)`), which cannot be pumped.
pub const MUSTER_TICKS: u32 = ticks_for(20_000);

/// Six minutes of fight before [`OUTCOME_ENRAGE`]. Stamped onto `Arena::enrage_at_tick` by
/// [`Arena::begin_fight`] at the MUSTERING → FIGHTING flip, **not** at `init`: the muster
/// runs on the same clock, so a creation-time stamp would silently spend
/// [`MUSTER_TICKS`] of every fight's budget before anyone could shoot.
pub const ENRAGE_TICKS: u32 = ticks_for(360_000);

/// One volley every 3.2 s. The real period is 33 ticks: `boss_tick` fires on the tick it
/// reads 0 and reloads on the same line.
///
/// It lives here rather than in `handlers::tick` — where it is counted down — because
/// [`Boss::reset_for_incarnation`] seeds `attack_timer` from it, and a duration declared
/// in the module that spends it and again in the module that seeds it is the same
/// duration stored twice.
pub const VOLLEY_INTERVAL_TICKS: u8 = ticks_for(3_200) as u8;

/// Fight HP remaining, in percent of [`Boss::fight_hp`]'s max, at or below which the boss
/// is FURIOUS: the volley reloads from [`FURY_VOLLEY_INTERVAL_TICKS`] with one extra bullet
/// (`tick.rs`) and every client dresses the creature as ENRAGED. Derived from the shell and
/// the core on every read, never stored — `Boss` has no padding left, and a cached flag
/// would be the HP stored twice.
///
/// Distinct from [`OUTCOME_ENRAGE`], which is the six-minute timeout and ENDS the fight.
/// Fury is the last fifth of the fight getting harder; the name is different on purpose so
/// the two never get merged by a grep.
pub const FURY_PCT: u32 = 20;

/// Fight HP at or below this percent and the boss is in PHASE 2: `tick.rs` sweeps the beam
/// (`beam_at`) from here until the core dies. The mid-fight escalation, so the fight reads
/// 100 % normal → 50 % beam → 20 % fury → 0 win; the const-assert below is that ordering.
/// Derived like [`FURY_PCT`], for the same reason: nothing on `Boss` can hold a flag.
pub const PHASE2_PCT: u32 = 50;

/// The volley period while furious: half of [`VOLLEY_INTERVAL_TICKS`], 1.6 s. Declared
/// beside the number it halves so the two cannot drift, `u8` because `tick.rs` writes it
/// into `Boss::attack_timer`.
pub const FURY_VOLLEY_INTERVAL_TICKS: u8 = VOLLEY_INTERVAL_TICKS / 2;

const _: () = {
    assert!(FURY_PCT > 0 && FURY_PCT < 100);
    // The beam is the *mid*-fight escalation: it must start before fury and after 100 %.
    assert!(PHASE2_PCT > FURY_PCT && PHASE2_PCT < 100);
    // Faster, and still a real reload: 0 would fire every tick.
    assert!(FURY_VOLLEY_INTERVAL_TICKS > 0 && FURY_VOLLEY_INTERVAL_TICKS < VOLLEY_INTERVAL_TICKS);
};

// ---------------------------------------------------------------------------
// Difficulty tiers — `Arena.difficulty`, one row per gate
// ---------------------------------------------------------------------------

/// The three gates in the lobby's top wall, left to right: EASY, MEDIUM, HARD. The tier is
/// the index of the `G` block the raid's first raider stood in (`map::gate_at`), written to
/// [`Arena::difficulty`] by `enter_gate` and read by every balance curve below.
///
/// Three, not a `u8` range: each curve is a table with one row per tier, const-asserted in
/// order, and a fourth gate is a fourth row in every table plus a fourth `G` block in the
/// drawn map — `tools/gen_map.py` refuses any other count.
pub const N_TIERS: usize = 3;
pub const TIER_EASY: u8 = 0;
pub const TIER_MEDIUM: u8 = 1;
pub const TIER_HARD: u8 = 2;

/// `tier` clamped into `0..N_TIERS` as a table index. Only `enter_gate` writes the byte,
/// from a gate index, so an out-of-range value cannot be produced by this program; the
/// clamp is what makes every table read below total, with no panic path in the BPF. A byte
/// this program never writes reads as the hardest row, not the easiest.
const fn tier_n(tier: u8) -> usize {
    if tier as usize >= N_TIERS {
        N_TIERS - 1
    } else {
        tier as usize
    }
}

/// `Boss::core_hp` for a solo raid, by tier — the floor, not the value a full raid fights.
///
/// EASY is 200, down from 300 and from 2,000 before that. At 50 DPS the 2,000 floor was
/// 40 s of a solo fight spent entirely on a target that cannot move or be dodged, after
/// the shell was already down. 300 was measured, not felt: a perfect solo kill was 17 s,
/// and a standing solo player under the flat 8-per-bullet volley and 45-per-slam was dead
/// in 5.7 s — the fight was lost three times over before the vent opened. Cutting the core
/// is one third of the solo pass; [`VENT_PCT_SOLO_BY_TIER`] and the incoming side
/// ([`bullet_damage`], [`slam_damage`], `player::PLAYER_HP_MAX`) are the rest. A full raid
/// is untouched, because [`CORE_HP_PER_RAIDER_BY_TIER`] dominates the sum the moment a
/// second player arrives: twenty EASY raiders still fight 57,200.
pub const BOSS_CORE_HP_BY_TIER: [u16; N_TIERS] = [200, 400, 700];

/// The core a boss is *seeded* with — `init_arena` and `next_incarnation` both write it
/// through `Boss::reset_for_incarnation`. It is the EASY row because both run in
/// `PHASE_LOBBY`, where `Arena.difficulty` is 0 by construction; the tick's top-up
/// ([`core_hp_required`]) raises the core to the raid's own row on the first FIGHTING tick,
/// the same way it raises it for a second raider.
pub const BOSS_CORE_HP: u16 = BOSS_CORE_HP_BY_TIER[TIER_EASY as usize];

/// Added to `core_hp_max` for each raider past the first, by tier, by the tick stage that
/// already counts arena occupants.
///
/// The raid-size knob is the core and never `parts`: `parts` carries the incarnation
/// scaling and already saturates `u16` around incarnation 41, and `vent_open` is a ratio
/// over `parts`, so multiplying the shell by raid size would move the vent threshold and
/// collapse the progression curve at the same time. `core_hp_max` is monotone and *is* its
/// own high-water record, so the top-up needs no snapshot field, cannot be gamed by dying
/// or leaving, and tolerates a player arriving late.
///
/// The rows are bounded by the field they are written to: `core_hp` is a `u16` and `Boss`
/// has no padding to widen it, so twenty HARD raiders may owe at most 65,535. 3,600 and
/// 4,500 — the first draft — put twenty MEDIUM raiders at 68,800 and twenty HARD at 86,200,
/// which is a core that saturates the field for every raid past fourteen and stops
/// getting harder there. 3,200 / 3,400 are the largest hundreds that fit; the const block
/// below is what says so. The tiers still lengthen the fight at every raid size — the
/// vent tables and the incoming multipliers carry the rest of it.
pub const CORE_HP_PER_RAIDER_BY_TIER: [u16; N_TIERS] = [3_000, 3_200, 3_400];

/// `raid_size` clamped into `1..=MAX_SEATS`, the domain every raid-size curve in this file
/// is drawn over. 0 is what every account already on chain carries in `raid_size` and what
/// an arena reads before the first raider is counted, and it must mean the solo fight
/// rather than divide by zero; past `MAX_SEATS` cannot happen and must not wrap. Written
/// once so [`vent_pct`], [`bullet_damage`], [`slam_damage`] and [`ttk_s`] cannot disagree
/// about what an uncounted raid is.
const fn raid_n(raid_size: u8) -> u32 {
    if raid_size == 0 {
        1
    } else if raid_size as usize > MAX_SEATS {
        MAX_SEATS as u32
    } else {
        raid_size as u32
    }
}

/// The core a raid of `raid_size` on `tier` fights: the tier's floor plus its per-raider
/// top-up for every raider past the first. The tick raises `core_hp_max` to this on every
/// tick and never lowers it; [`ttk_s_tier`] reads the same function, so the balance model
/// and the crank cannot disagree about what a raid owes. Cannot wrap: the block below
/// proves the twenty-raider value of every row fits the `u16` it is written to.
pub const fn core_hp_required(raid_size: u8, tier: u8) -> u16 {
    let t = tier_n(tier);
    BOSS_CORE_HP_BY_TIER[t] + CORE_HP_PER_RAIDER_BY_TIER[t] * (raid_n(raid_size) as u16 - 1)
}

const _: () = {
    // The top-up runs to `MAX_SEATS` raiders and must not wrap a `u16`, on any row.
    let mut t = 0;
    while t < N_TIERS {
        assert!(
            BOSS_CORE_HP_BY_TIER[t] as u32
                + CORE_HP_PER_RAIDER_BY_TIER[t] as u32 * (MAX_SEATS as u32 - 1)
                <= u16::MAX as u32
        );
        // Each tier owes more core than the one below it, at one raider and at twenty.
        if t > 0 {
            assert!(BOSS_CORE_HP_BY_TIER[t] > BOSS_CORE_HP_BY_TIER[t - 1]);
            assert!(CORE_HP_PER_RAIDER_BY_TIER[t] > CORE_HP_PER_RAIDER_BY_TIER[t - 1]);
        }
        t += 1;
    }
    assert!(BOSS_CORE_HP != 0);
    assert!(core_hp_required(0, TIER_EASY) == BOSS_CORE_HP);
    assert!(core_hp_required(MAX_SEATS as u8, TIER_EASY) == 57_200);
    // A muster that outlives the fight it precedes is a scheduling bug, not a balance one.
    assert!(MUSTER_TICKS < ENRAGE_TICKS);
};

/// Shell remaining, in percent, below which the vent opens — for a raid of one and for a
/// full raid, by tier; [`vent_pct`] draws the line between them.
///
/// The **other** raid-size knob, and the one that reaches the shell. Shell HP is flat at
/// every raid size (see [`CORE_HP_PER_RAIDER_BY_TIER`] for why `parts` can never scale),
/// so moving the *threshold* instead of the shell keeps every `u16` where it is and keeps
/// `vent_open` a ratio over `parts`. One byte on `Arena`, one function, the same tick
/// stage the core top-up already runs in.
///
/// EASY is 98, up from 97 and from 65 before that. A solo raider strips 2 % of 18,000
/// shell HP — 360 damage, 7.2 s at 50 DPS — and the vent opens; twenty still strip 65 %
/// (11,700, 12 s), linear between. The shell is a wall the raid shares, and a wall sized
/// for twenty is a grind for one: solo paid 126 s of it at 65. With [`BOSS_CORE_HP`] a
/// perfect solo EASY fight is 12 s — eight archer hits — where it was 17, and 166 before
/// the first pass; that is what "ten times easier" means when the request is measured
/// rather than felt. A full EASY raid stays at 69 s. MEDIUM and HARD ask for more of the
/// shell at every raid size: 6 % and 12 % solo, 70 % and 75 % at twenty.
pub const VENT_PCT_SOLO_BY_TIER: [u32; N_TIERS] = [98, 94, 88];
pub const VENT_PCT_FULL_BY_TIER: [u32; N_TIERS] = [35, 30, 25];

/// The vent threshold for a raid of `raid_size` on `tier`, in percent of `sum(parts_max)`.
///
/// The comparison at both call sites is `sum(parts) × 100 < sum(parts_max) × vent_pct`, so
/// no percentage is ever a float. Linear in the raid size from the tier's solo row at one
/// raider to its full row at [`MAX_SEATS`], clamped by [`raid_n`]. `const`, so the TTK
/// model below is checked on every `cargo check`.
pub const fn vent_pct(raid_size: u8, tier: u8) -> u32 {
    let t = tier_n(tier);
    VENT_PCT_SOLO_BY_TIER[t]
        - (VENT_PCT_SOLO_BY_TIER[t] - VENT_PCT_FULL_BY_TIER[t]) * (raid_n(raid_size) - 1)
            / (MAX_SEATS as u32 - 1)
}

const _: () = {
    let mut t = 0;
    while t < N_TIERS {
        // A threshold at or above 100 opens the vent on a full shell; one at 0 never opens it.
        assert!(VENT_PCT_SOLO_BY_TIER[t] < 100 && VENT_PCT_FULL_BY_TIER[t] > 0);
        // Solo is the *easier* threshold — more shell may stand. Inverting these makes the
        // integer subtraction in `vent_pct` wrap, which `const` turns into a compile error.
        assert!(VENT_PCT_SOLO_BY_TIER[t] >= VENT_PCT_FULL_BY_TIER[t]);
        let tier = t as u8;
        assert!(vent_pct(0, tier) == VENT_PCT_SOLO_BY_TIER[t] && vent_pct(1, tier) == VENT_PCT_SOLO_BY_TIER[t]);
        assert!(
            vent_pct(MAX_SEATS as u8, tier) == VENT_PCT_FULL_BY_TIER[t]
                && vent_pct(u8::MAX, tier) == VENT_PCT_FULL_BY_TIER[t]
        );
        // A harder tier asks for strictly more of the shell at EVERY raid size, not only at
        // the two endpoints — the rows are close enough that integer rounding could tie
        // them mid-curve, and a tie is a gate that changes nothing for that raid.
        if t > 0 {
            let mut n = 1;
            while n <= MAX_SEATS as u8 {
                assert!(vent_pct(n, tier) < vent_pct(n, tier - 1));
                n += 1;
            }
        }
        t += 1;
    }
    // Every row is defended by the same rule and the index is clamped, so a byte this
    // program never writes reads as HARD rather than as a table miss.
    assert!(vent_pct(1, u8::MAX) == VENT_PCT_SOLO_BY_TIER[N_TIERS - 1]);
};

/// Damage per boss bullet and per hand slam, for a raid of one and for a full raid;
/// [`bullet_damage`] and [`slam_damage`] draw the line between them as [`vent_pct`] does,
/// then scale it by the tier ([`INCOMING_MUL_BY_TIER`]).
///
/// The third raid-size knob, and the one that reaches the PLAYER. The outgoing knobs alone
/// did not make solo playable: with the vent at 97 and the core at 300 a perfect solo kill
/// was 17 s, while a standing solo player took `3 + 1` bullets × 8 every 3.2 s plus 45
/// every 6 s — 17.5 DPS against 100 HP, dead in 5.7 s. The full-raid endpoints are the
/// flat `BULLET_DAMAGE` / `SLAM_DAMAGE` the crank always dealt, so twenty EASY raiders take
/// exactly the hits they took; solo takes a quarter of a bullet and a third of a slam.
/// Against `player::PLAYER_HP_MAX` (150) that is ~40 s standing still, for a 12 s kill.
pub const BULLET_DAMAGE_SOLO: u16 = 2;
pub const BULLET_DAMAGE_FULL: u16 = 8;
pub const SLAM_DAMAGE_SOLO: u16 = 15;
pub const SLAM_DAMAGE_FULL: u16 = 45;

/// What a tier multiplies the raid-size damage curve by: MEDIUM doubles every hit, HARD
/// triples it. A multiplier rather than a second pair of endpoints per row, so the shape of
/// the curve — and the solo-playability argument above — is one curve on every tier.
pub const INCOMING_MUL_BY_TIER: [u16; N_TIERS] = [1, 2, 3];

/// Linear from `solo` at one raider to `full` at [`MAX_SEATS`], in integers, rounding
/// toward solo — the same shape and the same clamp as [`vent_pct`], written once — then
/// scaled by the tier.
const fn raid_lerp(solo: u16, full: u16, raid_size: u8, tier: u8) -> u16 {
    (solo as u32 + (full - solo) as u32 * (raid_n(raid_size) - 1) / (MAX_SEATS as u32 - 1)) as u16
        * INCOMING_MUL_BY_TIER[tier_n(tier)]
}

/// What one boss bullet takes off a raider, for a raid of `raid_size` on `tier`.
pub const fn bullet_damage(raid_size: u8, tier: u8) -> u16 {
    raid_lerp(BULLET_DAMAGE_SOLO, BULLET_DAMAGE_FULL, raid_size, tier)
}

/// What one hand slam takes off a raider caught in its lane, for a raid of `raid_size` on
/// `tier`. The beam deals the same number.
pub const fn slam_damage(raid_size: u8, tier: u8) -> u16 {
    raid_lerp(SLAM_DAMAGE_SOLO, SLAM_DAMAGE_FULL, raid_size, tier)
}

/// One more bullet per volley while `Boss::is_furious`, by tier. `tick.rs` counts it into
/// `volley_size` and its bullet-pool assert names the HARD row, the biggest volley the
/// pool must hold.
pub const FURY_EXTRA_BULLETS_BY_TIER: [usize; N_TIERS] = [1, 2, 3];

const _: () = {
    // Solo is the *gentler* endpoint; inverting either pair wraps `raid_lerp`'s subtraction.
    assert!(BULLET_DAMAGE_SOLO <= BULLET_DAMAGE_FULL && SLAM_DAMAGE_SOLO <= SLAM_DAMAGE_FULL);
    // The endpoints, and the clamp: 0 is solo, past `MAX_SEATS` is a full raid.
    assert!(bullet_damage(0, TIER_EASY) == 2 && bullet_damage(1, TIER_EASY) == 2);
    assert!(bullet_damage(MAX_SEATS as u8, TIER_EASY) == 8 && bullet_damage(u8::MAX, TIER_EASY) == 8);
    assert!(slam_damage(0, TIER_EASY) == 15 && slam_damage(1, TIER_EASY) == 15);
    assert!(slam_damage(MAX_SEATS as u8, TIER_EASY) == 45 && slam_damage(u8::MAX, TIER_EASY) == 45);
    // Each tier hits strictly harder than the one below and fires one more furious bullet;
    // EASY is the curve every account on chain already fights (multiplier 1, one bullet).
    assert!(INCOMING_MUL_BY_TIER[TIER_EASY as usize] == 1 && FURY_EXTRA_BULLETS_BY_TIER[TIER_EASY as usize] == 1);
    let mut t = 1;
    while t < N_TIERS {
        assert!(INCOMING_MUL_BY_TIER[t] > INCOMING_MUL_BY_TIER[t - 1]);
        assert!(FURY_EXTRA_BULLETS_BY_TIER[t] > FURY_EXTRA_BULLETS_BY_TIER[t - 1]);
        t += 1;
    }
    // The hardest hit fits the `u16` it lands in with the player's whole bar to spare.
    assert!(slam_damage(MAX_SEATS as u8, TIER_HARD) == 135 && bullet_damage(MAX_SEATS as u8, TIER_HARD) == 24);
};

/// `PlayerSlot.zone`.
pub const ZONE_LOBBY: u8 = 0;
pub const ZONE_ARENA: u8 = 1;

/// `Boss.target_seat` when no player is alive in the arena. 0xFF is outside
/// `0..MAX_SEATS`, so an unchecked index with it would be caught by bounds checks
/// rather than silently aiming at seat 0.
pub const NO_TARGET: u8 = 0xFF;

/// `Bullet.active`. Anything other than `BULLET_ACTIVE` is treated as free.
pub const BULLET_FREE: u8 = 0;
pub const BULLET_ACTIVE: u8 = 1;

// PDA seed prefixes. The client, the Worker and the crank scheduler all derive the
// same addresses, so the prefixes belong with the layout rather than in each caller.
pub const SEED_ARENA: &[u8] = b"arena";
pub const SEED_BOSS: &[u8] = b"boss";
pub const SEED_PLAYERS: &[u8] = b"players";
pub const SEED_LEADERBOARD: &[u8] = b"leaderboard";

// ---------------------------------------------------------------------------
// Checked casts
// ---------------------------------------------------------------------------

/// Implemented by the four account types. The associated discriminator is what
/// `load`/`load_mut` check, and it is the only type confusion defence that exists.
pub trait AccountLayout: Pod {
    const DISCRIMINATOR: u8;
    const LEN: usize = size_of::<Self>();
}

/// Read-only cast of raw account data.
///
/// Rejects a short account, a misaligned pointer, a wrong discriminator and a wrong
/// layout version. A *longer* account is accepted — nothing but our own program can
/// resize a PDA, and the trailing bytes are unreachable through `&T`.
pub fn load<T: AccountLayout>(data: &[u8]) -> Result<&T, ProgramError> {
    let head = data
        .get(..T::LEN)
        .ok_or(ProgramError::AccountDataTooSmall)?;
    check_header(head, T::DISCRIMINATOR)?;
    bytemuck::try_from_bytes(head).map_err(|_| ProgramError::InvalidAccountData)
}

/// Mutable cast of raw account data. Same checks as [`load`].
pub fn load_mut<T: AccountLayout>(data: &mut [u8]) -> Result<&mut T, ProgramError> {
    let head = data
        .get_mut(..T::LEN)
        .ok_or(ProgramError::AccountDataTooSmall)?;
    check_header(head, T::DISCRIMINATOR)?;
    bytemuck::try_from_bytes_mut(head).map_err(|_| ProgramError::InvalidAccountData)
}

/// Stamp the header of a freshly allocated (all-zero) account and return it typed.
///
/// The `DISC_UNINITIALIZED` check is what makes initialization non-repeatable: a
/// second `init` on a live account is rejected instead of resetting a match in
/// progress. It assumes the rest of the buffer is still zero, which is true for a
/// `CreateAccount` and is not re-verified here — walking 1,924 bytes to prove it
/// would cost more than it buys.
pub fn init<T: AccountLayout>(data: &mut [u8], bump: u8) -> Result<&mut T, ProgramError> {
    let head = data
        .get_mut(..T::LEN)
        .ok_or(ProgramError::AccountDataTooSmall)?;
    check_header(head, DISC_UNINITIALIZED)?;
    // Byte 2 is `bump` in all four layouts; the const blocks below assert it.
    head[..3].copy_from_slice(&[T::DISCRIMINATOR, LAYOUT_VERSION, bump]);
    bytemuck::try_from_bytes_mut(head).map_err(|_| ProgramError::InvalidAccountData)
}

/// Byte 0 is the discriminator and byte 1 the version in every layout in this file,
/// so the check is one function rather than one per type.
fn check_header(head: &[u8], expected_disc: u8) -> Result<(), ProgramError> {
    // `head` is always at least 3 bytes: the smallest layout here is 50.
    let (disc, version) = (head[0], head[1]);
    if disc != expected_disc {
        return Err(ProgramError::InvalidAccountData);
    }
    // An uninitialized account carries version 0, which is deliberately not a valid
    // version — so this check does not need to be skipped for the `init` path.
    if expected_disc != DISC_UNINITIALIZED && version != LAYOUT_VERSION {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Bullet — 8 bytes, the unit of the pool
// ---------------------------------------------------------------------------

/// One slot of the boss projectile pool.
///
/// Integer position *and* integer velocity, because the client extrapolates bullets
/// exactly between the 2.5 Hz crank ticks: same integers, same fixed step, zero
/// prediction error. Any float on either side of that boundary reintroduces drift.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Bullet {
    /// Arena-space position, same units as `PlayerSlot.x` / `Boss.x`.
    pub x: i16,
    pub y: i16,
    /// Per-tick velocity. The client multiplies these by the fractional tick.
    pub dx: i8,
    pub dy: i8,
    /// `BULLET_FREE` or `BULLET_ACTIVE`. u8, not bool — bool is not `Pod`.
    pub active: u8,
    pub _pad0: u8,
}

const _: () = {
    assert!(size_of::<Bullet>() == 8);
    assert!(align_of::<Bullet>() == 2);
    assert!(offset_of!(Bullet, x) == 0);
    assert!(offset_of!(Bullet, y) == 2);
    assert!(offset_of!(Bullet, dx) == 4);
    assert!(offset_of!(Bullet, dy) == 5);
    assert!(offset_of!(Bullet, active) == 6);
};

// ---------------------------------------------------------------------------
// Arena — match clock, crank wiring, bullet pool
// ---------------------------------------------------------------------------

/// Delegated to the ER for the life of a match. Written by `boss_tick` every 400 ms
/// and by `shoot`; this is also the client's liveness heartbeat, since `tick` not
/// advancing is the only signal that the crank died (there is no RPC to ask).
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Arena {
    pub discriminator: u8,
    pub version: u8,
    pub bump: u8,
    /// `PHASE_*`. Authoritative for what all 20 clients render.
    pub phase: u8,
    /// Players alive in `ZONE_ARENA`. Drives `bullets_per_volley = BASE_VOLLEY_BULLETS +
    /// alive_count` (`tick.rs`; one more while [`Boss::is_furious`]), so it is game
    /// balance, not telemetry.
    pub alive_count: u8,
    /// Next slot `boss_tick` probes when claiming a free bullet. Wraps at
    /// `MAX_BULLETS`; a full pool simply drops the spawn.
    pub bullet_cursor: u8,
    /// `OUTCOME_*`. How the fight ended, orthogonal to `phase` and outliving it.
    ///
    /// Claimed out of `_pad0`, which cost nothing: no field moved, the account did not
    /// grow, and every account already on chain carries 0 there — which decodes as
    /// `OUTCOME_UNDECIDED`, the correct reading for a match that has not ended.
    pub outcome: u8,
    /// High-water mark of seats that have stood in `ZONE_ARENA` this incarnation — the
    /// raid size the vent threshold and the core top-up are sized to.
    ///
    /// Written only by `boss_tick` (stage 1b, monotone: it never falls when a player leaves
    /// or dies, so it cannot be gamed) and zeroed by [`Arena::begin_next_incarnation`].
    /// Read by [`vent_pct`] through `shoot::recompute_vent` on every landed shot and every
    /// tick, so the two writers of `vent_open` agree on the threshold by construction.
    ///
    /// Claimed out of `_pad0`, the same move `outcome` made: no field moved, the account did
    /// not grow, `LAYOUT_VERSION` stays 1. Every account already on chain carries 0 here,
    /// which [`vent_pct`] reads as the solo threshold — correct for an arena the crank has
    /// not yet counted, and the first FIGHTING tick overwrites it anyway.
    pub raid_size: u8,
    /// Match identity. Also the `Arena` PDA seed.
    pub arena_id: u64,
    /// Validator-**global** crank namespace, so it must be a wide random positive
    /// value — a collision fails silently *after* the scheduling CPI returns Ok, and
    /// is recorded only to a local table we cannot read. i64, not u64: the crank
    /// arguments are signed and the published docs are wrong about it (D10).
    pub crank_task_id: i64,
    /// The authoritative clock. Never wall-clock: cranks make no timing guarantee,
    /// 400 ms is a target and not a contract.
    pub tick: u32,
    /// Tick at which the raid enrages, or 0 for "no fight is running".
    ///
    /// **Match state, not creation state.** Stamped by [`Arena::begin_fight`] as
    /// `tick + ENRAGE_TICKS` and zeroed by [`Arena::begin_next_incarnation`]; `init` does
    /// not write it. It therefore reads 0 for the whole of [`PHASE_MUSTERING`], which
    /// `tick.rs`'s existing `!= 0` guard already treats as "not armed" — a client drawing
    /// an enrage clock must check the phase, not just this field.
    pub enrage_at_tick: u32,
    /// One bit per seat, low `MAX_SEATS` bits. Lets the Worker allocate a seat from a
    /// single u32 without decoding the 1,924-byte `Players` account.
    pub seat_occupied: u32,
    pub incarnation: u16,
    /// `TIER_EASY..=TIER_HARD` — which of the three gates this raid was opened through.
    ///
    /// Written by `enter_gate` and by nothing else, from the `G` block the seat stands in
    /// (`map::gate_at`), and only for the raid's FIRST raider (`raid_size == 0 &&
    /// alive_count == 0`); every later raider must enter through the same tier or is
    /// refused `WrongGate`. Read by every balance curve — `vent_pct`, `core_hp_required`,
    /// `bullet_damage`, `slam_damage`, the fury bullet — beside `raid_size`, and zeroed
    /// with it by [`Arena::begin_next_incarnation`], the only way back to `PHASE_LOBBY`.
    ///
    /// Claimed out of `_pad1`, the last free byte in the layout: no field moved, the
    /// account did not grow, `LAYOUT_VERSION` stays 1, and every account already on chain
    /// carries 0 here — EASY, which is exactly the tuning it was fighting.
    pub difficulty: u8,
    pub _pad1: [u8; 1],
    /// Treasury address the crank signer PDA derives from:
    /// `find_program_address([b"crank-executor", crank_authority], CRANK_PROGRAM_ID)`.
    /// `boss_tick` authorizes against that PDA and never against a player key.
    pub crank_authority: [u8; 32],
    /// Which ER these accounts live on. A client that resolves its own ER can land on
    /// the wrong one and see a correctly-owned, silently frozen world with zero errors
    /// — the single most likely production failure (R2), and this field is the fix.
    pub validator_identity: [u8; 32],
    /// The seed **this** incarnation is being fought under, and the only stored source of
    /// its ruleset. Incarnation 0 gets `hashv([arena_key, incarnation])` from `init_arena`;
    /// every incarnation after it gets a VRF seed, moved here out of `next_affix_seed` by
    /// [`Arena::begin_next_incarnation`].
    ///
    /// Affixes are **derived from these bytes, never stored** — see `06-game-loop.md` §6
    /// for the byte-range contract. A stored affix table would be the seed twice over, and
    /// the second copy is the one that drifts. Per-tick bullet entropy is likewise derived
    /// (`mix64(seed[0..8] ^ mix64(tick))`), so the client reproduces the volley locally
    /// without waiting on chain state.
    pub affix_seed: [u8; 32],
    pub bullets: [Bullet; MAX_BULLETS],
    // --- appended after `bullets`: everything above keeps its offset ---------------
    /// `tick` at which [`PHASE_ROLLING`] was entered. Ticks, never a slot or a
    /// wall-clock: `tick` is the only clock this program agrees on, and it is the only
    /// one `boss_tick` — the sole handler that can time the roll out — can read.
    ///
    /// Meaningful only while `phase == PHASE_ROLLING`; `begin_next_incarnation` clears it.
    pub roll_requested_tick: u32,
    /// Tick at which [`PHASE_MUSTERING`] flips to [`PHASE_FIGHTING`]. Set by tag 3
    /// `begin_muster` to `tick + MUSTER_TICKS`; the crank performs the flip, so twenty
    /// browsers agree on when the fight starts without talking to each other.
    ///
    /// Claimed out of `_pad2`, the same move `outcome` made out of `_pad0`: no field moves,
    /// the account does not grow, `size_of::<Arena>()` stays 1200 and `LAYOUT_VERSION`
    /// stays 1.
    ///
    /// **Zero means "no muster is scheduled"** — which is what it already means on every
    /// account on devnet, all of which carry zeros here and none of which can be in
    /// `PHASE_MUSTERING` (6 did not exist when they were written). So there is no
    /// migration. [`Arena::begin_fight`] gates on the phase rather than on this field
    /// precisely so a live account cannot be affected by the reinterpretation.
    ///
    /// Cleared at the flip and by [`Arena::begin_next_incarnation`], so it is non-zero
    /// only while a muster is actually running. **This is the last free `u32` in `Arena`**:
    /// `_pad1` (2 B @ 38) is all that remains — `raid_size` took the byte at 7 — and
    /// anything wider has to append past `next_affix_seed`, which grows a delegated account.
    pub fight_at_tick: u32,
    /// The VRF seed for the **next** incarnation, or all-zero for "none".
    ///
    /// Separate from `affix_seed` because the two answer different questions and a late
    /// callback must never be able to rewrite the seed of the fight that was just played
    /// — that seed is the audit trail the `ProvideRandomness` proof is checked against.
    ///
    /// All-zero is the whole verification: the only writer is [`Arena::accept_roll`],
    /// reached only from the tag-14 callback, which the scoped VRF identity signs. So
    /// "non-zero" *means* "a proof was verified on chain", and no separate `verified` flag
    /// exists to fall out of agreement with it.
    pub next_affix_seed: [u8; 32],
}

impl AccountLayout for Arena {
    const DISCRIMINATOR: u8 = DISC_ARENA;
}

const _: () = {
    assert!(size_of::<Arena>() == 1200);
    assert!(align_of::<Arena>() == 8);
    assert!(offset_of!(Arena, discriminator) == 0);
    assert!(offset_of!(Arena, version) == 1);
    assert!(offset_of!(Arena, bump) == 2);
    assert!(offset_of!(Arena, phase) == 3);
    assert!(offset_of!(Arena, alive_count) == 4);
    assert!(offset_of!(Arena, bullet_cursor) == 5);
    assert!(offset_of!(Arena, outcome) == 6);
    assert!(offset_of!(Arena, raid_size) == 7);
    assert!(offset_of!(Arena, arena_id) == 8);
    assert!(offset_of!(Arena, crank_task_id) == 16);
    assert!(offset_of!(Arena, tick) == 24);
    assert!(offset_of!(Arena, enrage_at_tick) == 28);
    assert!(offset_of!(Arena, seat_occupied) == 32);
    assert!(offset_of!(Arena, incarnation) == 36);
    assert!(offset_of!(Arena, difficulty) == 38);
    assert!(offset_of!(Arena, crank_authority) == 40);
    assert!(offset_of!(Arena, validator_identity) == 72);
    assert!(offset_of!(Arena, affix_seed) == 104);
    assert!(offset_of!(Arena, bullets) == 136);
    assert!(offset_of!(Arena, roll_requested_tick) == 1160);
    assert!(offset_of!(Arena, fight_at_tick) == 1164);
    assert!(offset_of!(Arena, next_affix_seed) == 1168);
};

// ---------------------------------------------------------------------------
// The phase machine
// ---------------------------------------------------------------------------

/// Every legal `(from, to)` phase edge, once.
///
/// This table *is* the game loop's control flow. It lives here rather than as an `if` in
/// each handler because the handlers that write `phase` are five files owned by different
/// people, and five independently-edited gates are five chances for two of them to disagree
/// about whether, say, a `ROLLING` arena may be committed. (It may not — tag 11 refuses it
/// outright, since a mid-roll snapshot buys nothing and costs the oracle a retry storm. It
/// may be *undelegated*, which is a different question with a different answer: see
/// `ROLLING → SETTLED` below.)
///
/// Read as "from → the set of `to`":
///
/// | From | To | Performed by |
/// |---|---|---|
/// | `LOBBY` | `MUSTERING` | tag 3 `begin_muster`, and only with a seat in `ZONE_ARENA` |
/// | `MUSTERING` | `FIGHTING` | tag 8 `boss_tick`, at [`Arena::fight_at_tick`] |
/// | `MUSTERING` | `SETTLED` | tag 9 `settle` — dead-crank recovery, as for `FIGHTING` |
/// | `FIGHTING` | `SETTLING` | tag 7 `shoot` (killing blow) · tag 8 `boss_tick` |
/// | `FIGHTING` | `SETTLED` | tag 9 `settle` — dead-crank recovery, must stay legal |
/// | `SETTLING` | `ROLLING` | tag 13 `request_roll`, and only when `outcome == OUTCOME_WIN` |
/// | `SETTLING` | `SETTLED` | tag 9 `settle` · tag 12 `commit_and_undelegate` |
/// | `ROLLING` | `ROLLED` | tag 14 `consume_roll`, the VRF callback |
/// | `ROLLING` | `SETTLING` | tag 8 `boss_tick`, after [`ROLL_TIMEOUT_TICKS`] |
/// | `ROLLING` | `SETTLED` | tag 9 `settle` · tag 12 `commit_and_undelegate` — dead-crank recovery |
/// | `ROLLED` | `SETTLED` | tag 9 `settle` |
/// | `SETTLED` | `SETTLED` | tag 9 retried, and the delegation program's undelegation callback |
/// | `SETTLED` | `LOBBY` | tag 15 `next_incarnation` |
///
/// **The state is the triple `(phase, outcome, next_affix_seed)`, not the phase byte
/// alone**, and two edges above carry a second condition the table cannot express:
/// `SETTLING → ROLLING` additionally requires `outcome == OUTCOME_WIN`, and
/// `SETTLED → LOBBY` additionally requires a non-zero `next_affix_seed`. Both are enforced
/// in the method that performs the edge, and both are refused with the same
/// [`HeartrotError::WrongPhase`] — "this instruction is not legal from this state" is one
/// condition, and the *reason* is readable straight off the account (`outcome` says the
/// raid wiped; an all-zero `next_affix_seed` says the oracle never answered), so a second
/// error code would carry no information the caller does not already hold.
///
/// `ROLLING → SETTLED` is the one edge here that exists *against* a hazard rather than
/// away from one, and it is the highest-consequence line in the table. Undelegating under
/// an in-flight VRF request does aim the callback at an account the ER no longer holds —
/// the fulfilment fails and the oracle re-sends it — but that cost is bounded twice over:
/// by the request's 240-slot TTL, and by `consume_roll` returning `Ok` on every rejection
/// path, so a callback that *does* land on a `SETTLED` arena is dropped rather than
/// reverting the oracle's transaction into a retry loop. The alternative was unbounded.
/// `abandon_roll` — the only other way out of `ROLLING` — is measured against `tick`, and
/// `tick` is advanced only by `boss_tick`; a crank that dies inside the ~10 s roll window
/// therefore freezes the very clock its own timeout is read from. Without this edge that
/// arena is terminal: three accounts delegated to the ER with no instruction in the
/// program able to bring them back. `FIGHTING → SETTLED` and `MUSTERING → SETTLED` are the
/// same edge for the same reason; this is their twin, and both routes to it are already
/// `crank_authority`-gated.
///
/// Everything else is rejected. Three absences carry weight: `LOBBY → SETTLED` (an arena
/// that was never fought has nothing to record — the rule `settle` already enforces
/// and `commit_and_undelegate` routes around), `LOBBY → LOBBY`
/// (which is what makes a second `next_incarnation` a rejection rather than a second reset,
/// and therefore what stops two settlements racing the incarnation counter), and
/// `LOBBY → FIGHTING`, **removed**: a raid could previously be armed with nobody through
/// the gate, which spent six minutes aiming at `NO_TARGET` and recorded an enrage. Every
/// fight now starts out of a muster whose entry condition is at least one raider.
///
/// `MUSTERING → SETTLED` records nothing and burns an arena id — `outcome` is still
/// [`OUTCOME_UNDECIDED`] there, which `write_leaderboard` must refuse. It exists so a crank
/// that dies during the muster cannot wedge three delegated accounts in a phase with no
/// exit; if arenas start burning this way, the crank is dying and that is the real fault.
const PHASE_EDGES: [(u8, u8); 13] = [
    (PHASE_LOBBY, PHASE_MUSTERING),
    (PHASE_MUSTERING, PHASE_FIGHTING),
    (PHASE_MUSTERING, PHASE_SETTLED),
    (PHASE_FIGHTING, PHASE_SETTLING),
    (PHASE_FIGHTING, PHASE_SETTLED),
    (PHASE_SETTLING, PHASE_ROLLING),
    (PHASE_SETTLING, PHASE_SETTLED),
    (PHASE_ROLLING, PHASE_ROLLED),
    (PHASE_ROLLING, PHASE_SETTLING),
    (PHASE_ROLLING, PHASE_SETTLED),
    (PHASE_ROLLED, PHASE_SETTLED),
    (PHASE_SETTLED, PHASE_SETTLED),
    (PHASE_SETTLED, PHASE_LOBBY),
];

impl Arena {
    /// Is `from → to` in [`PHASE_EDGES`]? `const` so callers can assert on it at compile
    /// time, and so the test below can walk the whole 6×6 product.
    pub const fn may_transition(from: u8, to: u8) -> bool {
        let mut index = 0;
        while index < PHASE_EDGES.len() {
            let (a, b) = PHASE_EDGES[index];
            if a == from && b == to {
                return true;
            }
            index += 1;
        }
        false
    }

    /// Move to `to`, or reject the transition.
    ///
    /// The only sanctioned way to write `phase` from a handler that is allowed to fail.
    /// `boss_tick` cannot use it — a crank that returns `Err` ten times is deleted — and
    /// uses [`Self::end_fight`] / [`Self::abandon_roll`], which are total by construction.
    pub fn try_set_phase(&mut self, to: u8) -> Result<(), ProgramError> {
        if !Self::may_transition(self.phase, to) {
            return Err(HeartrotError::WrongPhase.into());
        }
        self.phase = to;
        Ok(())
    }

    /// `MUSTERING → FIGHTING` once [`Arena::fight_at_tick`] has arrived, stamping the
    /// enrage deadline off the same clock.
    ///
    /// Total, because its only caller is `boss_tick` — a crank that returns `Err` ten times
    /// is deleted and the match dies with it. Returns whether it flipped, so the tick stage
    /// can skip `step` on the flip tick: the fight begins on the *next* tick, which keeps
    /// "the first tick of FIGHTING" one thing rather than two.
    ///
    /// The gate is the phase, never `fight_at_tick != 0`. Every account already on devnet
    /// carries zero there and none of them can be in [`PHASE_MUSTERING`], so this cannot
    /// fire on live state. A `MUSTERING` arena that somehow held a zero deadline flips
    /// immediately, which is the safe direction — the alternative is a muster with no end.
    pub fn begin_fight(&mut self) -> bool {
        if self.phase != PHASE_MUSTERING || self.tick < self.fight_at_tick {
            return false;
        }
        self.phase = PHASE_FIGHTING;
        // Saturating rather than wrapping: at u32::MAX ticks (13.6 years at 100 ms) the
        // fight simply never enrages, which beats a deadline that lands in the past.
        self.enrage_at_tick = self.tick.saturating_add(ENRAGE_TICKS);
        self.fight_at_tick = 0;
        true
    }

    /// End the fight: record `outcome` and move `FIGHTING → SETTLING`.
    ///
    /// Total, and idempotent — it returns `false` and writes nothing if the fight is
    /// already over or `outcome` is not a real result. Both matter: `boss_tick` and
    /// `shoot` can reach the same conclusion in the same 400 ms window (a killing blow the
    /// crank also observes), and the *first* one is the true one. Whichever loses must not
    /// overwrite `outcome`, or a win recorded by the killer becomes an enrage recorded by
    /// the crank one tick later.
    ///
    /// One function, so the phase and the outcome cannot be written apart — a `SETTLING`
    /// arena with `OUTCOME_UNDECIDED` is a match nobody can score.
    pub fn end_fight(&mut self, outcome: u8) -> bool {
        if outcome == OUTCOME_UNDECIDED || outcome > OUTCOME_ENRAGE {
            return false;
        }
        if self.phase != PHASE_FIGHTING || self.outcome != OUTCOME_UNDECIDED {
            return false;
        }
        self.outcome = outcome;
        self.phase = PHASE_SETTLING;
        true
    }

    /// `SETTLING → ROLLING` for a won match.
    ///
    /// A wipe earns no roll, and is refused with the same [`HeartrotError::WrongPhase`] as
    /// an illegal phase — the state is `(phase, outcome)` and this pair has no edge. A
    /// caller that wants to know which half failed reads `outcome` off the account it just
    /// passed.
    ///
    /// `tick` is stamped here, so the crank's timeout is measured from the request rather
    /// than from anything the caller supplies.
    pub fn begin_roll(&mut self) -> Result<(), ProgramError> {
        if self.outcome != OUTCOME_WIN {
            return Err(HeartrotError::WrongPhase.into());
        }
        self.try_set_phase(PHASE_ROLLING)?;
        self.roll_requested_tick = self.tick;
        Ok(())
    }

    /// Consume a VRF fulfilment: store `seed` and move `ROLLING → ROLLED`.
    ///
    /// **Total on purpose, and it must stay that way.** The VRF program invokes the
    /// callback with `?` inside its own `ProvideRandomness` transaction, so an `Err` here
    /// reverts that transaction *including the queue removal* — the oracle then retries
    /// the same request until the 240-slot TTL expires. A stale roll, a duplicate, a roll
    /// for another incarnation and an all-zero seed are therefore dropped with `false`,
    /// never raised.
    ///
    /// The all-zero rejection is load-bearing rather than defensive: all-zero is the
    /// "no seed" sentinel `begin_next_incarnation` refuses on, so storing one would be
    /// storing "verified" and "absent" in the same bytes.
    pub fn accept_roll(&mut self, seed: &[u8; 32], for_incarnation: u16) -> bool {
        if self.phase != PHASE_ROLLING || self.incarnation != for_incarnation {
            return false;
        }
        if *seed == [0u8; 32] {
            return false;
        }
        self.next_affix_seed = *seed;
        self.phase = PHASE_ROLLED;
        true
    }

    /// `ROLLING → SETTLING` once [`ROLL_TIMEOUT_TICKS`] have passed with no callback.
    ///
    /// Total, because its only caller is `boss_tick`. It writes **no seed**, which is what
    /// makes the failure loud: `begin_next_incarnation` then refuses, and a human decides
    /// whether to re-roll or to open a fresh chain. The match itself still settles
    /// normally, so a VRF outage costs the progression loop and not the raid.
    ///
    /// Requires `boss_tick` to advance `tick` on **every** execution rather than only
    /// while fighting — see `06-game-loop.md` §5. A clock that stops outside `FIGHTING`
    /// would leave this comparison frozen and wedge the arena in `ROLLING` for good.
    pub fn abandon_roll(&mut self) -> bool {
        if self.phase != PHASE_ROLLING {
            return false;
        }
        if self.tick.saturating_sub(self.roll_requested_tick) <= ROLL_TIMEOUT_TICKS {
            return false;
        }
        self.phase = PHASE_SETTLING;
        true
    }

    /// `SETTLED → LOBBY` for incarnation N+1, in place, in the same three accounts.
    ///
    /// Returns the new incarnation so the caller can scale the boss with it. Refuses with
    /// [`HeartrotError::WrongPhase`] when no verified seed is present — an all-zero
    /// `next_affix_seed` is a state with no edge out of `SETTLED`, and the account itself
    /// says which half failed. This refusal is the design's "refuse to start": the
    /// alternative, reusing the old seed or deriving a
    /// new one from chain state, is an incarnation whose ruleset was not rolled by anyone
    /// who can prove it, silently indistinguishable from one that was.
    ///
    /// What carries over: `arena_id`, `bump`, `crank_authority`, `validator_identity`, and
    /// — because it is a different account entirely — the whole `Leaderboard` ring. What
    /// resets: the clock, the phase, the outcome, the bullet pool, the seat bitmask, the
    /// raid-size high-water (a new raid is sized from its own first tick) and the tier
    /// beside it (the next raid picks its own gate), both deadlines
    /// (`enrage_at_tick` and `fight_at_tick` are match state, and a deadline measured
    /// against a clock that has just been zeroed is already in the past), and (through
    /// [`Players::reset_for_incarnation`] and [`Boss::reset_for_incarnation`]) every seat
    /// and every point of boss HP.
    ///
    /// `crank_task_id` is deliberately left alone: `start_match` mints a fresh one over it
    /// before scheduling, and zeroing it here would only invite a caller to schedule
    /// against 0 — the most collision-prone id on a validator-global namespace.
    ///
    /// The incarnation counter is this field and nothing else. Two settlements cannot race
    /// it: this runs only from `SETTLED` and leaves `LOBBY`, and `LOBBY → LOBBY` is not a
    /// legal edge, so the second transaction is rejected rather than advancing twice.
    pub fn begin_next_incarnation(&mut self) -> Result<u16, ProgramError> {
        if self.next_affix_seed == [0u8; 32] {
            return Err(HeartrotError::WrongPhase.into());
        }
        self.try_set_phase(PHASE_LOBBY)?;

        self.affix_seed = self.next_affix_seed;
        self.next_affix_seed = [0u8; 32];
        self.roll_requested_tick = 0;
        // Saturating rather than checked: at u16::MAX the progression stops advancing,
        // which is harmless — boss part HP already saturates around incarnation 41, so the
        // fight stopped getting harder tens of thousands of incarnations earlier. An error
        // here would name a failure mode no raid can reach.
        self.incarnation = self.incarnation.saturating_add(1);
        self.outcome = OUTCOME_UNDECIDED;
        self.tick = 0;
        self.enrage_at_tick = 0;
        self.fight_at_tick = 0;
        self.alive_count = 0;
        self.raid_size = 0;
        self.difficulty = TIER_EASY;
        self.bullet_cursor = 0;
        self.seat_occupied = 0;
        self.bullets = [Bullet::zeroed(); MAX_BULLETS];
        Ok(self.incarnation)
    }
}

// ---------------------------------------------------------------------------
// Boss — the shell, the core, the aggro target
// ---------------------------------------------------------------------------

/// The boss is a shell, not a health bar: `parts` *is* its health, and the core is
/// only damageable once the shell has been stripped past the vent threshold.
///
/// Its own account rather than a field on `Arena` because `shoot` writes parts on
/// every player shot while the crank writes bullets on every tick; splitting them
/// keeps a hitscan transaction from carrying the 1 KB pool it never touches.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Boss {
    pub discriminator: u8,
    pub version: u8,
    pub bump: u8,
    /// 0 sealed, 1 open. Recomputed every tick and on every landed shot from
    /// `sum(parts) × 100 < sum(parts_max) × vent_pct(arena.raid_size, arena.difficulty)`,
    /// so it is derived state cached for the client, never an independent flag.
    pub vent_open: u8,
    /// Ticks until the next melee/volley beat.
    pub attack_timer: u8,
    /// Seat index of the nearest alive arena player, or `NO_TARGET`.
    pub target_seat: u8,
    pub x: i16,
    pub y: i16,
    /// Kill condition. Only decrements while `vent_open == 1`.
    pub core_hp: u16,
    pub core_hp_max: u16,
    /// Current HP per destructible part, index-aligned with the build-time hitbox
    /// JSON emitted by `tools/svg_slice.py` — one build step produces both the `<g>`
    /// the browser animates and the rectangle this program raycasts against, so the
    /// DOM and the chain cannot drift.
    pub parts: [u16; N_PARTS],
    /// Scaled by `× (1 + incarnation × 0.15)` at spawn, computed in integers.
    pub parts_max: [u16; N_PARTS],
}

impl AccountLayout for Boss {
    const DISCRIMINATOR: u8 = DISC_BOSS;
}

impl Boss {
    /// Re-arm the boss for a new incarnation, in place.
    ///
    /// Takes the already-scaled numbers rather than computing them: `handlers::init` owns
    /// `BOSS_PARTS_BASE` and `scale_for_incarnation`, and a second scaling site here would
    /// be the balance table stored twice — a boss that is one difficulty curve when a match
    /// is created and another when it respawns. This file owns *which fields reset*; that
    /// one owns *what the numbers are*.
    ///
    /// `parts_max` is set from the same array as `parts`, which is what keeps the vent
    /// threshold (`sum(parts) × 100 < sum(parts_max) × vent_pct(raid_size, tier)`) meaningful: a
    /// full shell is exactly 100 % by construction, on every incarnation.
    pub fn reset_for_incarnation(&mut self, parts: [u16; N_PARTS], core_hp: u16, x: i16, y: i16) {
        self.x = x;
        self.y = y;
        self.core_hp = core_hp;
        self.core_hp_max = core_hp;
        self.parts = parts;
        self.parts_max = parts;
        // A full shell is sealed and nobody is in the arena yet. `NO_TARGET` rather than 0
        // so a stale index cannot read as "aiming at seat 0".
        //
        // `attack_timer` is seeded with a full interval, not 0: `boss_tick` reads 0 as
        // *fire now*, so a zero here spends the opening volley on the same tick that first
        // publishes `target_seat`. No client can draw a telegraph for a wind-up that never
        // existed — `volleyTelegraph` needs the phase to be FIGHTING before it draws
        // anything, and the phase and the bullets would arrive together. Every later
        // volley already gets the full interval; this gives the first one the same.
        self.vent_open = 0;
        self.attack_timer = VOLLEY_INTERVAL_TICKS;
        self.target_seat = NO_TARGET;
    }

    /// The fight as ONE number: `(left, max)` — the shell a raid of `raid_size` on `tier`
    /// still has to strip to open the vent, plus the core.
    ///
    /// Shell above the vent threshold never has to come off, so it is not fight HP:
    /// `threshold = shell_max × vent_pct / 100`, `left = max(shell − threshold, 0) +
    /// core_hp`, `max = (shell_max − threshold) + core_hp_max`. This is what the HUD shows
    /// as `boss NN%` and what [`Self::is_furious`] reads, mirrored as `fightHp` in
    /// `layout.ts`; the alternative was a shell bar that read 97 % for a solo fight three
    /// hits from won.
    ///
    /// Integers throughout. `u32`: nine `u16` parts sum to at most 589,815, and the widest
    /// product here is that × 100.
    pub fn fight_hp(&self, raid_size: u8, tier: u8) -> (u32, u32) {
        let shell: u32 = self.parts.iter().map(|&p| p as u32).sum();
        let shell_max: u32 = self.parts_max.iter().map(|&p| p as u32).sum();
        let threshold = shell_max * vent_pct(raid_size, tier) / 100;
        let left = shell.saturating_sub(threshold) + self.core_hp as u32;
        // `vent_pct < 100` is const-asserted, so `threshold <= shell_max` and this cannot
        // wrap; a zeroed account is `(0, 0)`, not a panic.
        let max = (shell_max - threshold) + self.core_hp_max as u32;
        (left, max)
    }

    /// Is the boss in the last [`FURY_PCT`] percent of [`Self::fight_hp`]? `left > 0` keeps
    /// a dead boss out, `max > 0` keeps a zeroed account out, and `≤` on the cross-multiplied
    /// integers is the comparison the client mirror makes — exactly 20 % is furious.
    pub fn is_furious(&self, raid_size: u8, tier: u8) -> bool {
        let (left, max) = self.fight_hp(raid_size, tier);
        max > 0 && left > 0 && left * 100 <= max * FURY_PCT
    }

    /// Is the boss at or below [`PHASE2_PCT`] of [`Self::fight_hp`] — the half of the fight
    /// the beam sweeps through? The same guards and the same cross-multiplied `≤` as
    /// [`Self::is_furious`], mirrored as `isPhase2` in `layout.ts`: exactly 50 % is phase 2,
    /// a dead boss is not, and a zeroed account is not. Fury is *inside* phase 2, not
    /// instead of it — the beam keeps sweeping through the last fifth.
    pub fn is_phase2(&self, raid_size: u8, tier: u8) -> bool {
        let (left, max) = self.fight_hp(raid_size, tier);
        max > 0 && left > 0 && left * 100 <= max * PHASE2_PCT
    }
}

const _: () = {
    assert!(size_of::<Boss>() == 50);
    assert!(align_of::<Boss>() == 2);
    assert!(offset_of!(Boss, discriminator) == 0);
    assert!(offset_of!(Boss, version) == 1);
    assert!(offset_of!(Boss, bump) == 2);
    assert!(offset_of!(Boss, vent_open) == 3);
    assert!(offset_of!(Boss, attack_timer) == 4);
    assert!(offset_of!(Boss, target_seat) == 5);
    assert!(offset_of!(Boss, x) == 6);
    assert!(offset_of!(Boss, y) == 8);
    assert!(offset_of!(Boss, core_hp) == 10);
    assert!(offset_of!(Boss, core_hp_max) == 12);
    assert!(offset_of!(Boss, parts) == 14);
    assert!(offset_of!(Boss, parts_max) == 32);
};

// ---------------------------------------------------------------------------
// Players — all 20 seats in one account
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Classes — the top bit of `PlayerSlot::class_aim`
// ---------------------------------------------------------------------------

/// The class half of [`PlayerSlot::class_aim`]. One bit, and that is the budget: the
/// remaining seven carry the aim, whose quantisation error is 1.90° at 7 bits and 4.05°
/// at 6. A third class costs a 62-unit p95 miss on every drawn arrow (`17-fullscreen-spec`
/// §5.3), which is why [`N_CLASSES`] is 2 and not "2 for now".
pub const CLASS_MASK: u8 = 0b1000_0000;

/// Class 0 **must** stay the knight. Every seat live on devnet carries 0 in this byte
/// today, so 0 is not a choice — it is what the accounts already say, and it is the whole
/// reason this feature has no migration.
pub const CLASS_KNIGHT: u8 = 0;
/// Slower and heavier, never faster: shot rate is notification rate, and the ER budget the
/// raid's latency depends on is the constraint that picked these numbers.
pub const CLASS_ARCHER: u8 = 1;
pub const N_CLASSES: u8 = 2;

/// Milliseconds between accepted shots, per class. Milliseconds, like every other duration
/// in this file — the tick counts below are derived, never typed.
pub const CLASS_PERIOD_MS: [u32; N_CLASSES as usize] = [800, 1_400];

/// Damage per landed shot, per class. Paired with [`CLASS_PERIOD_MS`] to be **DPS-neutral**
/// — `40 × 14 == 70 × 8` — so the boss's HP curve is untouched by the class a raid picks.
/// The equality is asserted below, because a balance pass that changes one of the four
/// numbers and not the others would otherwise rescale every fight silently.
pub const CLASS_DAMAGE: [u16; N_CLASSES as usize] = [40, 70];

/// Shot cooldown in ticks, per class. The comparison at the call site is
/// `arena.tick > last_shot_tick + cooldown`, so this is one *less* than the period in
/// ticks — 0 would mean one shot per tick, the ceiling the tick clock can express.
pub const CLASS_COOLDOWN_TICKS: [u32; N_CLASSES as usize] = [
    ticks_for(CLASS_PERIOD_MS[0]) - 1,
    ticks_for(CLASS_PERIOD_MS[1]) - 1,
];

const _: () = {
    // Class 0 is the knight exactly as it plays today. If either of these moves, every
    // account on devnet silently changes weapon.
    assert!(CLASS_KNIGHT == 0);
    assert!(CLASS_DAMAGE[CLASS_KNIGHT as usize] == 40);
    assert!(CLASS_PERIOD_MS[CLASS_KNIGHT as usize] == 800);
    // DPS neutrality, in the integers the program actually uses.
    assert!(
        CLASS_DAMAGE[0] as u32 * (CLASS_COOLDOWN_TICKS[1] + 1)
            == CLASS_DAMAGE[1] as u32 * (CLASS_COOLDOWN_TICKS[0] + 1)
    );
    // `class_aim >> 7` is 0 or 1 for every u8, which is what makes the table indexes in
    // `PlayerSlot::shot_damage` and `::cooldown_ticks` total without a bounds check.
    assert!(N_CLASSES == 2 && CLASS_MASK == 0b1000_0000);
};

// ---------------------------------------------------------------------------
// The charged shot — a hold, stateless on chain
// ---------------------------------------------------------------------------

/// How long a raider must stand still before a shot may be sent charged. A duration in
/// milliseconds like every other knob here; the chain counts it in ER slots below.
pub const CHARGE_MS: u32 = 1_000;

/// One ER slot, the finest clock a player instruction can read. `PlayerSlot::last_move_tick`
/// is stamped in **this** unit (`player::move_clock` reads `Clock::get()?.slot` in every
/// phase); `Arena.tick` is a crank tick of [`TICK_MS`] and is a different clock. Never
/// subtract one from the other — that trap already shipped once, as a MOVE pill that was
/// permanently green in a fight.
pub const SLOT_MS: u32 = 50;

/// [`CHARGE_MS`] in ER slots: the gap `shoot::fire` requires between the seat's last
/// accepted step and the slot the charged shot lands in. Slot-to-slot, so a client on a
/// bad connection is judged on when its step landed, not on when it was sent.
pub const CHARGE_SLOTS: u32 = CHARGE_MS / SLOT_MS;

/// Charged damage is `CLASS_DAMAGE × CHARGED_NUM / CHARGED_DEN` — 2.5×, in integers.
/// Same cooldown, so it is 2.5× DPS *while rooted*; the vent constants above are the
/// tuning knob for that, and a charged-shot cooldown penalty is written down, not built.
pub const CHARGED_NUM: u16 = 5;
pub const CHARGED_DEN: u16 = 2;

/// The bit of `PlayerSlot::facing` that says "the shot this seat last fired was charged".
/// Bits 0..2 are the octant; 3..7 were the only free bits left in the 96-byte slot, and
/// this spends one of them. Set by `shoot::fire`, cleared by the next `facing` write — a
/// step or an uncharged shot — which is exactly the lifetime of the arrow a client draws
/// from it.
pub const CHARGED_SHOT_BIT: u8 = 3;

/// Damage per landed **charged** shot, per class. Index with [`PlayerSlot::class`], which
/// is total. Exact, never truncated: the block below proves `× 5 / 2` divides for every
/// row and fits the `u16` the boss's parts are counted in.
pub const fn charged_damage(class: u8) -> u16 {
    (CLASS_DAMAGE[class as usize] as u32 * CHARGED_NUM as u32 / CHARGED_DEN as u32) as u16
}

const _: () = {
    assert!(CHARGE_MS % SLOT_MS == 0 && CHARGE_SLOTS > 0);
    // The octant owns bits 0..2 (`player::octant` answers 0..7); the flag must not alias it
    // and must fit the byte.
    assert!(CHARGED_SHOT_BIT >= 3 && CHARGED_SHOT_BIT < 8);
    let mut class = 0;
    while class < N_CLASSES {
        let base = CLASS_DAMAGE[class as usize] as u32;
        // Fits u16 — `boss.parts` and `core_hp` are u16 and the subtraction saturates, but a
        // multiplier that overflowed the cast would silently *shrink* the shot instead.
        assert!(base * CHARGED_NUM as u32 / CHARGED_DEN as u32 <= u16::MAX as u32);
        // ...and divides exactly, so the client's `chargedDamage` mirror and the chain
        // agree to the point, not to the rounding.
        assert!(charged_damage(class) as u32 * CHARGED_DEN as u32 == base * CHARGED_NUM as u32);
        class += 1;
    }
};

// ---------------------------------------------------------------------------
// The super shot — the beam: a longer hold, the same statelessness
// ---------------------------------------------------------------------------

/// How long a raider must stand still before a shot may be sent as a SUPER (wire tier 2).
/// 2.5 s is a stand the boss gets most of a volley period into (one every 3.2 s), so the
/// reward is paid for in exposure rather than in cooldown — which stays the class's.
pub const SUPER_MS: u32 = 2_500;

/// [`SUPER_MS`] in ER slots — the gap `shoot::fire` requires for tier 2, slot against
/// slot exactly as [`CHARGE_SLOTS`] is for tier 1.
pub const SUPER_SLOTS: u32 = SUPER_MS / SLOT_MS;

/// Super damage is `CLASS_DAMAGE × SUPER_NUM / SUPER_DEN` — 5×: the archer's 70 becomes
/// 350, the knight's 40 becomes 200. Twice a charged shot for two and a half times the
/// hold, and it PIERCES (`shoot.rs`): every part on the ray takes it once, and the core
/// takes it if the vent is open once those parts are gone. That is the whole case for a
/// 2.5 s stand in a bullet hell.
pub const SUPER_NUM: u16 = 5;
pub const SUPER_DEN: u16 = 1;

/// The bit of `PlayerSlot::facing` that says "the shot this seat last fired was a super".
/// Bit 4, beside [`CHARGED_SHOT_BIT`]; bits 5..7 are the last free bits in the slot. Set
/// by `shoot::fire`, cleared by the next bare-octant `facing` write like the charged bit,
/// so a client draws the beam for exactly as long as it drew the charged arrow.
pub const SUPER_SHOT_BIT: u8 = 4;

/// Damage per landed **super** shot, per class. Total, exact, `u16`-safe — asserted below.
pub const fn super_damage(class: u8) -> u16 {
    (CLASS_DAMAGE[class as usize] as u32 * SUPER_NUM as u32 / SUPER_DEN as u32) as u16
}

const _: () = {
    assert!(SUPER_MS % SLOT_MS == 0 && SUPER_SLOTS > 0);
    // Strictly longer than the charged hold, or the tiers are not ordered and the client's
    // downgrade ladder on `NotCharged` (super → charged → plain) has nothing to step to.
    assert!(SUPER_SLOTS > CHARGE_SLOTS);
    // Off the octant, off the charged flag, inside the byte.
    assert!(SUPER_SHOT_BIT >= 3 && SUPER_SHOT_BIT < 8 && SUPER_SHOT_BIT != CHARGED_SHOT_BIT);
    let mut class = 0;
    while class < N_CLASSES {
        let base = CLASS_DAMAGE[class as usize] as u32;
        // Fits u16 and divides exactly, for the same reasons as the charged block.
        assert!(base * SUPER_NUM as u32 / SUPER_DEN as u32 <= u16::MAX as u32);
        assert!(super_damage(class) as u32 * SUPER_DEN as u32 == base * SUPER_NUM as u32);
        // A super outdamages a charged shot on every row, or the longer hold is a worse deal.
        assert!(super_damage(class) > charged_damage(class));
        class += 1;
    }
};

// ---------------------------------------------------------------------------
// The time-to-kill model
// ---------------------------------------------------------------------------

/// Time-to-kill, in whole seconds rounded up, for a raid of `raid_size` against a shell of
/// `shell_hp` — the balance model the vent curve was tuned with, uncharged, every shot
/// landing.
///
/// `(shell stripped to open the vent + the core the raid fights) / the raid's DPS`. The
/// shell term is the complement of [`vent_pct`] — the vent opens once `100 − pct` percent
/// of the shell is gone — and the core term is `tick.rs`'s top-up for the same raid size.
/// Per-raider DPS is read off the knight row; the DPS-neutral assert above is what makes
/// that the archer's number too.
///
/// It ignores geometry (the limb in the lane is not always the one you want stripped) and
/// charging (2.5× damage while rooted), so it is a floor, not a forecast: the time a
/// perfect solo player cannot beat.
///
/// The EASY row of [`ttk_s_tier`], kept under its own name because it is the curve every
/// account on chain already fights and the one every number in this file's history was
/// measured against.
pub const fn ttk_s(shell_hp: u32, raid_size: u8) -> u32 {
    ttk_s_tier(shell_hp, raid_size, TIER_EASY)
}

/// [`ttk_s`] on `tier`: the same DPS, the tier's own vent line and the tier's own core —
/// [`vent_pct`] and [`core_hp_required`], the two functions the tick reads, so the model
/// is the crank's arithmetic and not a restatement of it.
pub const fn ttk_s_tier(shell_hp: u32, raid_size: u8, tier: u8) -> u32 {
    let n = raid_n(raid_size);
    let dps = n * (CLASS_DAMAGE[CLASS_KNIGHT as usize] as u32 * 1_000
        / CLASS_PERIOD_MS[CLASS_KNIGHT as usize]);
    let shell = shell_hp * (100 - vent_pct(raid_size, tier)) / 100;
    let core = core_hp_required(raid_size, tier) as u32;
    (shell + core + dps - 1) / dps
}

/// The shell the vent curve was tuned against: `init::BOSS_PARTS_BASE` summed — four thorns
/// at 1,000, the crown at 4,000, four limbs at 2,500 — on the day [`VENT_PCT_SOLO_BY_TIER`] and
/// [`VENT_PCT_FULL_BY_TIER`] were chosen. A modelling input, not a second definition of the shell:
/// that table is private to `init.rs`, which pins this literal to its sum with a const
/// assert (`init::SHELL_HP_BASE`). Retune the shell and this is the number to move; the
/// block below then says whether the curve still lands where the design promised.
pub(crate) const TTK_MODEL_SHELL_HP: u32 = 18_000;

const _: () = {
    let seconds_to_enrage = ENRAGE_TICKS * TICK_MS / 1_000;
    // Solo: 360 shell + 200 core at 50 DPS = 12 s of a 360 s enrage — eight archer hits —
    // down from 17, from 166 and from 274 before that. The curve is the whole difficulty
    // design, so it is asserted rather than described — change a constant and this line
    // names what it did.
    assert!(ttk_s(TTK_MODEL_SHELL_HP, 1) == 12);
    // Twenty: 11,700 shell + 57,200 core at 1,000 DPS = 69 s, as it was at 57,300. A full
    // raid is the fight that was already tuned; the solo pass must not have moved it.
    assert!(ttk_s(TTK_MODEL_SHELL_HP, MAX_SEATS as u8) == 69);
    // THE CURVE POINTS THE OTHER WAY NOW, and that is the point. It used to assert that
    // more raiders kill FASTER: the shell was flat, so every extra bow was pure speed.
    // With the solo pass the shell a lone player must strip is 360 and the core is 200,
    // while twenty still owe 11,700 and 57,200 — so the fight LENGTHENS with the raid, and
    // that is the founding requirement ("more people who join, tougher the battle is")
    // holding as arithmetic instead of as a comment. Difficulty is also bullet density
    // (`bullets_per_volley = BASE_VOLLEY_BULLETS + alive`) and, since the solo pass, the
    // damage of each bullet: `bullet_damage` / `slam_damage` above.
    assert!(ttk_s(TTK_MODEL_SHELL_HP, MAX_SEATS as u8) > ttk_s(TTK_MODEL_SHELL_HP, 1));
    // The LONGEST fight — a full raid — must fit the enrage window twice over. The second
    // half is the allowance for play that is not perfect; `ttk_s` is a floor, not a
    // forecast, and it ignores dodging, deaths and the walk back from a respawn.
    assert!(ttk_s(TTK_MODEL_SHELL_HP, MAX_SEATS as u8) * 2 < seconds_to_enrage);

    // THE TIERS. MEDIUM: 1,080 shell + 400 core solo = 30 s; 12,600 + 61,200 at twenty =
    // 74 s. HARD: 2,160 + 700 solo = 58 s; 13,500 + 65,300 at twenty = 79 s. Pinned like
    // EASY's two, for the same reason; the pair of loops under them is the design — each
    // gate is a strictly longer fight than the one to its left, alone and at twenty —
    // and the last line is HARD's full raid fitting the enrage window twice over, which
    // is the same allowance EASY's full raid gets.
    assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, 1, TIER_MEDIUM) == 30);
    assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, MAX_SEATS as u8, TIER_MEDIUM) == 74);
    assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, 1, TIER_HARD) == 58);
    assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, MAX_SEATS as u8, TIER_HARD) == 79);
    assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, 1, TIER_EASY) == ttk_s(TTK_MODEL_SHELL_HP, 1));
    let mut t = 1;
    while t < N_TIERS {
        let (below, tier) = (t as u8 - 1, t as u8);
        assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, 1, tier) > ttk_s_tier(TTK_MODEL_SHELL_HP, 1, below));
        assert!(
            ttk_s_tier(TTK_MODEL_SHELL_HP, MAX_SEATS as u8, tier)
                > ttk_s_tier(TTK_MODEL_SHELL_HP, MAX_SEATS as u8, below)
        );
        t += 1;
    }
    assert!(ttk_s_tier(TTK_MODEL_SHELL_HP, MAX_SEATS as u8, TIER_HARD) * 2 < seconds_to_enrage);
};

/// One seat. Slot index *is* the seat number, so there is no `seat` field to
/// disagree with it.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PlayerSlot {
    /// `ZONE_LOBBY` or `ZONE_ARENA`. The gate tile flips it.
    pub zone: u8,
    /// Bits 0..2: the octant this seat last stepped or fired along, 0 N … 7 NW, y down —
    /// the sprite's body direction (the arrow is drawn from `class_aim`, at 1.90° rather
    /// than 45°). Bit 3, [`CHARGED_SHOT_BIT`]: the last shot was charged. Bit 4,
    /// [`SUPER_SHOT_BIT`]: it was a super. Bits 5..7 are the last free bits in the slot.
    ///
    /// **A reader wants `facing & 7`**, and that is the client's job (`layout.ts` decodes
    /// the octant and the two flags as three fields); nothing on chain reads the byte back.
    /// Every on-chain writer assigns a bare octant — `move_player` and `enter_gate` — except
    /// `shoot::fire`, which ORs the flags in. So a step clears them, which is the lifetime
    /// of the in-flight arrow, with no second field to expire.
    pub facing: u8,
    pub skin_id: u8,
    /// Class and last aim, packed:
    ///
    /// - bit 7 — class: 0 [`CLASS_KNIGHT`], 1 [`CLASS_ARCHER`]
    /// - bits 6..4 — aim sector: `neg_x << 2 | neg_y << 1 | steep`
    /// - bits 3..0 — aim ratio: `min(|dx|,|dy|) / max(|dx|,|dy|)`, scaled 0..15
    ///
    /// **Zero means knight, aiming due +x, and nothing has been fired.** Claimed out of
    /// `_pad0`: no field moved, the slot is still 96 bytes, `LAYOUT_VERSION` did not move,
    /// and every seat already on chain reads 0 — which is exactly the knight they already
    /// are. There is no migration, and that is the point.
    ///
    /// The aim half is only meaningful once `last_shot_tick != 0`; before the first shot
    /// there is no arrow to draw, and a client must fall back to [`PlayerSlot::facing`].
    /// That pairing is the whole contract: `(x, y)`, `class_aim` and `last_shot_tick` are
    /// enough for **any** client to reconstruct an arrow — its origin, its direction, its
    /// speed and its damage — from account bytes alone, with no event stream and no
    /// projectile allocated on chain.
    ///
    /// Written only by [`PlayerSlot::set_aim`] and [`PlayerSlot::set_class`], never by
    /// hand: an aim write that forgets to preserve bit 7 changes the player's class on
    /// their first shot with no error anywhere, and that is the one silent failure this
    /// feature has.
    pub class_aim: u8,
    pub x: i16,
    pub y: i16,
    /// 0 means dead. Aliveness is derived — `hp != 0 && zone == ZONE_ARENA` — rather
    /// than stored, so there is no second flag to fall out of sync with the number.
    pub hp: u16,
    pub hp_max: u16,
    /// Echoes the client's input sequence number back. Without it an arriving
    /// position is ambiguous as to which input produced it and prediction cannot be
    /// reconciled; the symptom is rubber-banding for every player (D14).
    pub last_move_seq: u16,
    /// Times this seat has hit 0 HP during the current incarnation.
    ///
    /// Claimed out of `_pad1`: no field moved, the account did not grow, and every seat
    /// already on chain reads 0, which is true of a match nobody has died in yet.
    ///
    /// Incremented on exactly the line that stamps `respawn_at_tick`, so there is one
    /// death event and one place it is counted. Saturating — a seat that somehow died
    /// 65,535 times stops counting rather than wrapping to zero and reading as flawless.
    /// It is the only record that a wipe-heavy raid happened: `survived` on the
    /// leaderboard row is a single bit sampled at settle time, and a player who died
    /// nineteen times and respawned before the end is indistinguishable from one who
    /// never took a hit.
    pub deaths: u16,
    /// Tick at which `boss_tick` returns this player to the arena entrance.
    pub respawn_at_tick: u32,
    /// Rate limit for `shoot`. ER transaction fees are zero and the ER runs no
    /// fee-payer validation at all, so nothing debits a spammer and the network
    /// provides no economic backstop. These two counters *are* the rate limiter (D16).
    pub last_shot_tick: u32,
    /// Rate limit for `move`: one accepted move per tick.
    pub last_move_tick: u32,
    /// Cumulative, for the leaderboard.
    pub damage_dealt: u32,
    /// The browser's non-extractable WebCrypto Ed25519 public key. Every player-facing
    /// instruction asserts `authority.is_signer && authority == session_pubkey`. That
    /// is the entire security perimeter, not one layer of it — a single omitted check
    /// is a full compromise (D17).
    ///
    /// All-zero means the seat is unclaimed. This is the sentinel; there is no
    /// occupancy flag.
    pub session_pubkey: [u8; 32],
    /// `sha256(privy DID)`. The durable leaderboard key, and what makes
    /// `/session/init` idempotent when a returning player has lost their session key.
    pub identity: [u8; 32],
}

impl PlayerSlot {
    /// [`CLASS_KNIGHT`] or [`CLASS_ARCHER`]. Total — `>> 7` on a `u8` cannot be anything
    /// else — which is what lets the two accessors below index the class tables with no
    /// bounds check and no panic path in the BPF.
    pub const fn class(&self) -> u8 {
        self.class_aim >> 7
    }

    pub const fn shot_damage(&self) -> u16 {
        CLASS_DAMAGE[self.class() as usize]
    }

    pub const fn cooldown_ticks(&self) -> u32 {
        CLASS_COOLDOWN_TICKS[self.class() as usize]
    }

    /// Set the class, preserving the aim. Refuses an unknown class rather than clamping:
    /// a clamp turns a version skew into a silently wrong weapon, which is indistinguishable
    /// from a balance bug from the outside.
    pub fn set_class(&mut self, class: u8) -> Result<(), ProgramError> {
        if class >= N_CLASSES {
            return Err(ProgramError::InvalidInstructionData);
        }
        self.class_aim = (self.class_aim & !CLASS_MASK) | (class << 7);
        Ok(())
    }

    /// Record the direction of a shot, preserving the class.
    ///
    /// `& CLASS_MASK` is the only thing keeping a player's class off the aim path, so the
    /// write lives here and not at the call site — one line to get right, in the file that
    /// owns the byte, instead of one line to get right in every handler that ever fires.
    ///
    /// `unsigned_abs`, not `abs`: `dx` arrives from the wire and `(-128i8).abs()` overflows.
    pub fn set_aim(&mut self, dx: i8, dy: i8) {
        let (ax, ay) = (dx.unsigned_abs() as u32, dy.unsigned_abs() as u32);
        let sector = ((dx < 0) as u8) << 2 | ((dy < 0) as u8) << 1 | ((ay > ax) as u8);
        let (min, max) = (ax.min(ay), ax.max(ay));
        // Round to nearest, so the reconstructed ray straddles the real one instead of
        // leaning one way for the whole quadrant. `max == 0` is unreachable through
        // `shoot` — `octant` rejects `(0, 0)` — but this is a total function anyway.
        let ratio = if max == 0 {
            0
        } else {
            ((min * 15 + max / 2) / max) as u8
        };
        self.class_aim = (self.class_aim & CLASS_MASK) | (sector << 4) | ratio;
    }
}

const _: () = {
    assert!(size_of::<PlayerSlot>() == 96);
    assert!(align_of::<PlayerSlot>() == 4);
    assert!(offset_of!(PlayerSlot, zone) == 0);
    assert!(offset_of!(PlayerSlot, facing) == 1);
    assert!(offset_of!(PlayerSlot, skin_id) == 2);
    assert!(offset_of!(PlayerSlot, class_aim) == 3);
    assert!(offset_of!(PlayerSlot, x) == 4);
    assert!(offset_of!(PlayerSlot, y) == 6);
    assert!(offset_of!(PlayerSlot, hp) == 8);
    assert!(offset_of!(PlayerSlot, hp_max) == 10);
    assert!(offset_of!(PlayerSlot, last_move_seq) == 12);
    assert!(offset_of!(PlayerSlot, deaths) == 14);
    assert!(offset_of!(PlayerSlot, respawn_at_tick) == 16);
    assert!(offset_of!(PlayerSlot, last_shot_tick) == 20);
    assert!(offset_of!(PlayerSlot, last_move_tick) == 24);
    assert!(offset_of!(PlayerSlot, damage_dealt) == 28);
    assert!(offset_of!(PlayerSlot, session_pubkey) == 32);
    assert!(offset_of!(PlayerSlot, identity) == 64);
};

/// All 20 seats in one account, which is what keeps the crank's frozen account list
/// at three entries and the whole match under the ER's ~38-key ceiling.
///
/// ponytail: one account is also one notification stream. The ER emits at most one
/// account notification per 50 ms slot, so all 20 players share a ~20 Hz update
/// budget instead of getting 20 Hz each, and every move rewrites 1,924 bytes to every
/// subscriber. Fine at the measured 71 KB/s raid budget and invisible under client
/// prediction; if 20 concurrent movers ever starve the stream, shard this into two
/// ten-seat accounts (still 4 crank metas, still far under 38) before considering
/// one account per seat.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Players {
    pub discriminator: u8,
    pub version: u8,
    pub bump: u8,
    pub _pad0: u8,
    pub slots: [PlayerSlot; MAX_SEATS],
}

impl AccountLayout for Players {
    const DISCRIMINATOR: u8 = DISC_PLAYERS;
}

impl Players {
    /// Empty every seat for a new incarnation.
    ///
    /// Seats do **not** carry over, and that is a decision rather than an omission. A seat
    /// is a session key plus a live position, and both are stale by the time a raid
    /// respawns: the browser that held the key may be closed, and `/session/init` is
    /// already idempotent per `identity`, so a returning player is re-seated for free by
    /// the path that seats everyone else. Carrying them would instead mean `seat_occupied`
    /// on `Arena` and `session_pubkey` here disagreeing the moment one player does not come
    /// back, with no instruction able to notice.
    ///
    /// What survives an incarnation is on the `Leaderboard`, which is a base-layer account
    /// this never touches — one row per player per incarnation, keyed on the durable
    /// `identity` rather than on the session key. That is the whole carry-over model.
    ///
    /// A zeroed slot is the unclaimed slot: `session_pubkey == [0; 32]`, `zone == ZONE_LOBBY`,
    /// `hp == 0`. There is no field here whose correct default is non-zero, which is what
    /// makes this one assignment rather than a loop with twenty exceptions.
    pub fn reset_for_incarnation(&mut self) {
        self.slots = [PlayerSlot::zeroed(); MAX_SEATS];
    }
}

const _: () = {
    assert!(size_of::<Players>() == 1924);
    assert!(align_of::<Players>() == 4);
    assert!(offset_of!(Players, discriminator) == 0);
    assert!(offset_of!(Players, version) == 1);
    assert!(offset_of!(Players, bump) == 2);
    assert!(offset_of!(Players, slots) == 4);
};

// ---------------------------------------------------------------------------
// Leaderboard — base layer, never delegated
// ---------------------------------------------------------------------------

/// One player's result in one incarnation.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct LeaderboardEntry {
    pub arena_id: u64,
    /// `sha256(privy DID)`, copied from `PlayerSlot.identity`. Durable across session
    /// keys, which the session pubkey is not.
    pub identity: [u8; 32],
    pub damage_dealt: u32,
    pub incarnation: u16,
    /// 0 or 1.
    pub survived: u8,
    /// `OUTCOME_*` — the *match's* result, copied from `Arena.outcome` at settle, so a
    /// win and an enrage-with-survivors stop producing byte-identical rows.
    ///
    /// This spends what was `_pad0`, so the entry stays 48 bytes and the live account
    /// keeps its size and its rent. The old rows already on chain have a zero there,
    /// which reads as [`OUTCOME_UNDECIDED`] — the honest answer for a row written
    /// before the outcome was recorded, and the reason no version bump is needed.
    pub outcome: u8,
}

const _: () = {
    assert!(size_of::<LeaderboardEntry>() == 48);
    assert!(align_of::<LeaderboardEntry>() == 8);
    assert!(offset_of!(LeaderboardEntry, arena_id) == 0);
    assert!(offset_of!(LeaderboardEntry, identity) == 8);
    assert!(offset_of!(LeaderboardEntry, damage_dealt) == 40);
    assert!(offset_of!(LeaderboardEntry, incarnation) == 44);
    assert!(offset_of!(LeaderboardEntry, survived) == 46);
    assert!(offset_of!(LeaderboardEntry, outcome) == 47);
};

/// Base layer, never delegated, written by the Worker after the ER commit confirms.
///
/// The settle path is retried by design — `GetCommitmentSignature` throws on every
/// failure path and a throw means *unknown*, never *failed* — so this write must be
/// idempotent or a retry duplicates twenty rows.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Leaderboard {
    pub discriminator: u8,
    pub version: u8,
    pub bump: u8,
    pub _pad0: [u8; 5],
    /// Total entries ever written, saturating. Purely for the UI to say "of N runs".
    pub total_written: u32,
    /// Ring write cursor, always `< LEADERBOARD_CAP`.
    pub next: u32,
    /// Idempotency key of the most recent completed write.
    ///
    /// ponytail: this guards the retry case only — the same `(arena_id, incarnation)`
    /// written twice in a row is a no-op, but an out-of-order replay of an older pair
    /// would duplicate. That cannot happen while one Worker settles one match at a
    /// time. Upgrade path if concurrent matches ever settle out of order: scan the
    /// ring for the pair, or move to one account per incarnation.
    pub last_arena_id: u64,
    pub last_incarnation: u16,
    pub _pad1: [u8; 6],
    pub entries: [LeaderboardEntry; LEADERBOARD_CAP],
}

impl AccountLayout for Leaderboard {
    const DISCRIMINATOR: u8 = DISC_LEADERBOARD;
}

const _: () = {
    assert!(size_of::<Leaderboard>() == 6176);
    assert!(align_of::<Leaderboard>() == 8);
    assert!(offset_of!(Leaderboard, discriminator) == 0);
    assert!(offset_of!(Leaderboard, version) == 1);
    assert!(offset_of!(Leaderboard, bump) == 2);
    assert!(offset_of!(Leaderboard, total_written) == 8);
    assert!(offset_of!(Leaderboard, next) == 12);
    assert!(offset_of!(Leaderboard, last_arena_id) == 16);
    assert!(offset_of!(Leaderboard, last_incarnation) == 24);
    assert!(offset_of!(Leaderboard, entries) == 32);
};

/// The header shape `init` and `check_header` assume, asserted once for all four
/// types rather than trusted.
const _: () = {
    assert!(offset_of!(Arena, discriminator) == 0 && offset_of!(Arena, bump) == 2);
    assert!(offset_of!(Boss, discriminator) == 0 && offset_of!(Boss, bump) == 2);
    assert!(offset_of!(Players, discriminator) == 0 && offset_of!(Players, bump) == 2);
    assert!(offset_of!(Leaderboard, discriminator) == 0 && offset_of!(Leaderboard, bump) == 2);
    // Distinct discriminators are the whole type-confusion defence.
    assert!(DISC_ARENA != DISC_BOSS);
    assert!(DISC_ARENA != DISC_PLAYERS && DISC_BOSS != DISC_PLAYERS);
    assert!(DISC_ARENA != DISC_LEADERBOARD && DISC_BOSS != DISC_LEADERBOARD);
    assert!(DISC_PLAYERS != DISC_LEADERBOARD);
    assert!(DISC_ARENA != DISC_UNINITIALIZED && DISC_BOSS != DISC_UNINITIALIZED);
    assert!(DISC_PLAYERS != DISC_UNINITIALIZED && DISC_LEADERBOARD != DISC_UNINITIALIZED);
};

#[cfg(test)]
mod tests {
    use super::*;

    /// The layout is only worth anything if the casts refuse the three ways an
    /// attacker can hand us the wrong bytes: too short, wrong type, stale version.
    /// And `init` must not be repeatable, or a second call resets a live match.
    #[test]
    fn casts_reject_bad_accounts() {
        let mut buf = [0u8; size_of::<Arena>()];

        // Uninitialized: every read fails, no flag needed.
        assert!(load::<Arena>(&buf).is_err());

        let arena = init::<Arena>(&mut buf, 254).expect("init on a zeroed buffer");
        assert_eq!(arena.bump, 254);
        assert_eq!(arena.discriminator, DISC_ARENA);
        assert_eq!(arena.version, LAYOUT_VERSION);

        // Re-init is rejected; the account is no longer uninitialized.
        assert!(init::<Arena>(&mut buf, 1).is_err());

        // Right bytes, wrong type: this is the check Pinocchio does not do for us.
        assert!(load::<Players>(&buf).is_err());

        // Truncated.
        assert!(load::<Arena>(&buf[..size_of::<Arena>() - 1]).is_err());

        // Stale layout version.
        buf[1] = LAYOUT_VERSION.wrapping_add(1);
        assert!(load::<Arena>(&buf).is_err());
        buf[1] = LAYOUT_VERSION;
        assert!(load_mut::<Arena>(&mut buf).is_ok());
    }

    /// Offsets are asserted at compile time above; this pins the two numbers the
    /// TypeScript decoder and the rent math are written against.
    #[test]
    fn sizes_match_the_contract() {
        assert_eq!(size_of::<Arena>(), 1200);
        assert_eq!(size_of::<Boss>(), 50);
        assert_eq!(size_of::<Players>(), 1924);
        assert_eq!(size_of::<Leaderboard>(), 6176);
    }

    const PHASES: [u8; 7] = [
        PHASE_LOBBY,
        PHASE_FIGHTING,
        PHASE_SETTLING,
        PHASE_SETTLED,
        PHASE_ROLLING,
        PHASE_ROLLED,
        PHASE_MUSTERING,
    ];

    /// The whole 7×7 product, so a widened `PHASE_EDGES` cannot quietly legalise an edge
    /// nobody argued for. The ones spelled out below are the ones with consequences.
    #[test]
    fn only_declared_transitions_are_legal() {
        let mut legal = 0;
        for from in PHASES {
            for to in PHASES {
                if Arena::may_transition(from, to) {
                    legal += 1;
                }
            }
        }
        assert_eq!(
            legal,
            PHASE_EDGES.len(),
            "an edge is declared twice, or outside PHASES"
        );

        // The roll's own escape hatch. `abandon_roll` is measured against `tick`, and only
        // `boss_tick` advances `tick` — so a crank that dies inside the roll window freezes
        // the clock its timeout is read from, and this edge is the only thing left that can
        // hand three delegated accounts back to the base layer.
        assert!(Arena::may_transition(PHASE_ROLLING, PHASE_SETTLED));
        // A second `next_incarnation` must be rejected, not advance the counter twice.
        assert!(!Arena::may_transition(PHASE_LOBBY, PHASE_LOBBY));
        // A retried `settle` is by design — `GetCommitmentSignature` throws on every
        // failure path, so "unknown" is the only answer the settle route ever gets.
        assert!(Arena::may_transition(PHASE_SETTLED, PHASE_SETTLED));
        // Dead-crank recovery: a match whose task died can only ever end this way, and a
        // crank that dies during the muster must not wedge three delegated accounts.
        assert!(Arena::may_transition(PHASE_FIGHTING, PHASE_SETTLED));
        assert!(Arena::may_transition(PHASE_MUSTERING, PHASE_SETTLED));
        // Every fight now starts out of a muster, whose entry condition is at least one
        // raider through the gate. Arming a raid with an empty arena is unrepresentable.
        assert!(!Arena::may_transition(PHASE_LOBBY, PHASE_FIGHTING));
        assert!(Arena::may_transition(PHASE_LOBBY, PHASE_MUSTERING));
        assert!(Arena::may_transition(PHASE_MUSTERING, PHASE_FIGHTING));
    }

    /// The muster ends on the tick it was scheduled for, not before, and the enrage clock
    /// starts there — not at `init`, or the muster spends the fight's own budget.
    #[test]
    fn the_muster_ends_on_its_own_deadline() {
        let mut arena = Arena::zeroed();
        arena
            .try_set_phase(PHASE_MUSTERING)
            .expect("the gate opens a muster");
        arena.tick = 40;
        arena.fight_at_tick = arena.tick + MUSTER_TICKS;

        // One tick short, and every tick before it.
        for tick in 0..arena.fight_at_tick {
            arena.tick = tick;
            assert!(
                !arena.begin_fight(),
                "the muster is still running at tick {tick}"
            );
            assert_eq!(arena.phase, PHASE_MUSTERING);
            assert_eq!(
                arena.enrage_at_tick, 0,
                "no enrage clock runs during the muster"
            );
        }

        arena.tick = arena.fight_at_tick;
        assert!(
            arena.begin_fight(),
            "the crank flips it exactly on the deadline"
        );
        assert_eq!(arena.phase, PHASE_FIGHTING);
        assert_eq!(arena.enrage_at_tick, 40 + MUSTER_TICKS + ENRAGE_TICKS);
        assert_eq!(arena.fight_at_tick, 0, "no muster is scheduled any more");

        // Total and single-shot: the next tick changes nothing.
        arena.tick += 1;
        assert!(!arena.begin_fight());
        assert_eq!(arena.enrage_at_tick, 40 + MUSTER_TICKS + ENRAGE_TICKS);

        // And it cannot fire on any live account: they are all pre-`PHASE_MUSTERING`, all
        // carry zero in `fight_at_tick`, and the phase — not that zero — is the gate.
        for phase in PHASES {
            if phase == PHASE_MUSTERING {
                continue;
            }
            let mut live = Arena::zeroed();
            live.phase = phase;
            live.tick = 9_999;
            assert!(!live.begin_fight(), "phase {phase} is not a muster");
            assert_eq!(live.phase, phase);
        }
    }

    /// The outcome is written exactly once, by whichever of `shoot` and `boss_tick` sees
    /// the end of the fight first. If the loser could overwrite it, a win recorded by the
    /// killing blow becomes an enrage recorded by the crank 400 ms later.
    #[test]
    fn the_fight_ends_once() {
        let mut arena = Arena::zeroed();
        arena.phase = PHASE_FIGHTING;

        assert!(arena.end_fight(OUTCOME_WIN));
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.outcome, OUTCOME_WIN);

        // The crank reaching the same tick loses, and changes nothing.
        assert!(!arena.end_fight(OUTCOME_ENRAGE));
        assert_eq!(arena.outcome, OUTCOME_WIN);

        // Not a result, and not a phase this can start from.
        let mut fresh = Arena::zeroed();
        fresh.phase = PHASE_FIGHTING;
        assert!(!fresh.end_fight(OUTCOME_UNDECIDED));
        assert!(!fresh.end_fight(OUTCOME_ENRAGE + 1));
        assert_eq!(fresh.phase, PHASE_FIGHTING);
        fresh.phase = PHASE_LOBBY;
        assert!(!fresh.end_fight(OUTCOME_WIN));
    }

    /// The full win → roll → settle → respawn loop, and the two ways it must refuse.
    #[test]
    fn the_incarnation_loop_closes() {
        let mut arena = Arena::zeroed();
        arena.phase = PHASE_FIGHTING;
        arena.arena_id = 7;
        arena.affix_seed = [1u8; 32];
        arena.tick = 400;
        arena.enrage_at_tick = 400 + ENRAGE_TICKS;
        arena.alive_count = 5;
        arena.raid_size = 5;
        arena.seat_occupied = 0b1_1111;
        arena.bullets[3].active = BULLET_ACTIVE;

        assert!(arena.end_fight(OUTCOME_WIN));
        arena.begin_roll().expect("a won match may roll");
        assert_eq!(arena.phase, PHASE_ROLLING);
        assert_eq!(arena.roll_requested_tick, 400);

        // A roll for another incarnation, and an all-zero seed, are dropped rather than
        // raised: an `Err` here reverts the oracle's whole transaction and it retries.
        assert!(!arena.accept_roll(&[9u8; 32], 99));
        assert!(!arena.accept_roll(&[0u8; 32], 0));
        assert_eq!(arena.phase, PHASE_ROLLING);

        assert!(arena.accept_roll(&[9u8; 32], 0));
        assert_eq!(arena.phase, PHASE_ROLLED);
        // A duplicate fulfilment is a no-op, not a second write.
        assert!(!arena.accept_roll(&[8u8; 32], 0));
        assert_eq!(arena.next_affix_seed, [9u8; 32]);

        arena
            .try_set_phase(PHASE_SETTLED)
            .expect("a rolled match settles");
        let next = arena
            .begin_next_incarnation()
            .expect("a verified seed advances");

        assert_eq!(next, 1);
        assert_eq!(arena.phase, PHASE_LOBBY);
        assert_eq!(
            arena.affix_seed, [9u8; 32],
            "the rolled seed becomes this fight's seed"
        );
        assert_eq!(arena.next_affix_seed, [0u8; 32]);
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);
        assert_eq!(
            (arena.tick, arena.alive_count, arena.seat_occupied),
            (0, 0, 0)
        );
        assert_eq!(
            arena.raid_size, 0,
            "the next raid is sized from its own first tick, not the last raid's peak"
        );
        assert_eq!(
            (arena.enrage_at_tick, arena.fight_at_tick),
            (0, 0),
            "both deadlines are match state; a deadline against a zeroed clock is in the past"
        );
        assert!(arena.bullets.iter().all(|b| b.active == BULLET_FREE));
        assert_eq!(
            arena.arena_id, 7,
            "identity carries over; the match does not"
        );

        // Two settlements cannot race the counter: the second call is a rejected
        // transition, not a second advance.
        assert!(arena.begin_next_incarnation().is_err());
        assert_eq!(arena.incarnation, 1);
    }

    /// A losing raid may not roll, and a raid whose oracle never answered may not start
    /// the next incarnation at all. Both refusals are the point of the design: the
    /// alternative to "refuse" is an incarnation whose ruleset nobody can prove was rolled.
    #[test]
    fn a_missing_roll_refuses_rather_than_degrading() {
        let mut arena = Arena::zeroed();
        arena.phase = PHASE_FIGHTING;
        assert!(arena.end_fight(OUTCOME_WIPE));
        assert_eq!(
            arena.begin_roll().unwrap_err(),
            HeartrotError::WrongPhase.into(),
            "a wipe does not earn a roll"
        );

        // A win whose callback never landed: the crank abandons it after the timeout, and
        // no seed is written.
        let mut arena = Arena::zeroed();
        arena.phase = PHASE_FIGHTING;
        assert!(arena.end_fight(OUTCOME_WIN));
        arena.begin_roll().unwrap();
        assert!(!arena.abandon_roll(), "not yet — the oracle still has time");
        arena.tick = ROLL_TIMEOUT_TICKS + 1;
        assert!(arena.abandon_roll());
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.next_affix_seed, [0u8; 32], "no seed is invented");
        assert!(!arena.abandon_roll(), "and it fires once");

        // The match still settles; only the progression stops, and it stops loudly.
        arena.try_set_phase(PHASE_SETTLED).unwrap();
        assert_eq!(
            arena.begin_next_incarnation().unwrap_err(),
            HeartrotError::WrongPhase.into(),
        );
        assert_eq!(arena.phase, PHASE_SETTLED, "a refusal changes nothing");
        assert_eq!(arena.incarnation, 0);
    }

    /// A new incarnation must not leave a seat holding a dead browser's session key, and
    /// must not leave the boss on the HP the raid just stripped it to.
    #[test]
    fn a_respawn_clears_seats_and_re_arms_the_boss() {
        let mut players = Players::zeroed();
        players.slots[4].session_pubkey = [3u8; 32];
        players.slots[4].damage_dealt = 5_000;
        players.slots[4].deaths = 2;
        players.reset_for_incarnation();
        assert!(players.slots.iter().all(|s| s.session_pubkey == [0u8; 32]));
        assert!(players
            .slots
            .iter()
            .all(|s| s.damage_dealt == 0 && s.deaths == 0));

        let mut boss = Boss::zeroed();
        boss.core_hp = 0;
        boss.vent_open = 1;
        boss.target_seat = 4;
        boss.reset_for_incarnation([1_500; N_PARTS], 2_300, 512, 320);
        assert_eq!(boss.core_hp, 2_300);
        assert_eq!(boss.core_hp_max, 2_300);
        assert_eq!(boss.parts, boss.parts_max, "a full shell is exactly 100 %");
        assert_eq!((boss.vent_open, boss.target_seat), (0, NO_TARGET));
    }
}

#[cfg(test)]
mod rate_tests {
    use super::*;

    /// The rescale is only correct if the DURATIONS survive it. Ticks are an
    /// implementation detail of the crank period; these are the numbers a player feels,
    /// and they must not move when `TICK_MS` does.
    #[test]
    fn durations_survive_the_tick_rate() {
        assert_eq!(ticks_for(3_200) * TICK_MS, 3_200, "respawn stays 3.2 s");
        assert_eq!(
            ticks_for(10_000) * TICK_MS,
            10_000,
            "roll timeout stays 10 s"
        );
        assert_eq!(ENRAGE_TICKS * TICK_MS, 360_000, "enrage stays 6 min");
        assert_eq!(
            MUSTER_TICKS * TICK_MS,
            20_000,
            "the muster window stays 20 s"
        );
        assert_eq!(ROLL_TIMEOUT_TICKS * TICK_MS, 10_000);
        assert_eq!(ticks_for(800) * TICK_MS, 800, "shot cooldown stays 800 ms");
        // Every class's shot period, for the same reason: a cooldown is a duration a
        // player feels, and the tick count is only how the crank spells it.
        for c in 0..N_CLASSES as usize {
            assert_eq!(
                (CLASS_COOLDOWN_TICKS[c] + 1) * TICK_MS,
                CLASS_PERIOD_MS[c],
                "class {c}'s shot period must survive the tick rate"
            );
        }
        // A duration shorter than one tick must still cost a tick, never zero.
        assert_eq!(ticks_for(1), 1, "a sub-tick cooldown is still a cooldown");
        assert_eq!(ticks_for(0), 1);
        // The charge is counted in ER slots, never crank ticks: 1 s is 20 slots and would be
        // 10 ticks, and a chain that compared the two would let a step-then-fire through at
        // half the hold.
        assert_eq!(CHARGE_SLOTS * SLOT_MS, CHARGE_MS, "the charge stays 1 s");
        assert_eq!(CHARGE_SLOTS, 20);
        assert_eq!(
            SUPER_SLOTS * SLOT_MS,
            SUPER_MS,
            "the super hold stays 2.5 s"
        );
        assert_eq!(SUPER_SLOTS, 50);
        assert_eq!(
            FURY_VOLLEY_INTERVAL_TICKS as u32 * TICK_MS,
            1_600,
            "a furious volley stays 1.6 s"
        );
    }
}

/// The two raid-size knobs and the charged multiplier: the numbers a solo player feels.
#[cfg(test)]
mod balance_tests {
    use super::*;

    /// Solo opens the vent with 98 % of the shell standing on EASY, twenty with 35 %, and
    /// every raid size between is between — never a step *down* in difficulty for one
    /// more player walking through the gate. The same shape on every tier, from that
    /// tier's own two endpoints. 0 and anything past `MAX_SEATS` clamp rather than divide
    /// by zero or wrap: 0 is what every live account carries today.
    #[test]
    fn the_vent_threshold_is_linear_in_the_raid() {
        assert_eq!(vent_pct(1, TIER_EASY), 98);
        assert_eq!(vent_pct(MAX_SEATS as u8, TIER_EASY), 35);
        assert_eq!(vent_pct(u8::MAX, TIER_EASY), 35);
        for tier in 0..N_TIERS as u8 {
            let (solo, full) = (VENT_PCT_SOLO_BY_TIER[tier as usize], VENT_PCT_FULL_BY_TIER[tier as usize]);
            assert_eq!(vent_pct(0, tier), vent_pct(1, tier), "an uncounted raid is a solo raid");
            assert_eq!(vent_pct(MAX_SEATS as u8 + 1, tier), vent_pct(MAX_SEATS as u8, tier));
            for n in 1..MAX_SEATS as u8 {
                assert!(
                    vent_pct(n, tier) >= vent_pct(n + 1, tier),
                    "tier {tier}: a {}th raider made the vent harder to open ({} -> {})",
                    n + 1,
                    vent_pct(n, tier),
                    vent_pct(n + 1, tier),
                );
                // One integer step of the line, never a cliff. The bound is the slope
                // itself rounded up — derived, not typed, because the endpoints have moved
                // twice and a literal here silently permits a steeper curve than the one
                // intended.
                let slope_ceil = (solo - full + (MAX_SEATS as u32 - 2)) / (MAX_SEATS as u32 - 1);
                assert!(
                    vent_pct(n, tier) - vent_pct(n + 1, tier) <= slope_ceil,
                    "tier {tier}: the curve is linear, not stepped",
                );
            }
            // The client mirror reads the same two endpoints; the midpoint pins the slope.
            assert_eq!(vent_pct(11, tier), solo - (solo - full) * 10 / (MAX_SEATS as u32 - 1));
        }
        // The table index is clamped, so a byte this program never writes reads as HARD.
        assert_eq!(vent_pct(1, N_TIERS as u8), vent_pct(1, TIER_HARD));
        assert_eq!(vent_pct(1, u8::MAX), vent_pct(1, TIER_HARD));
    }

    /// 2.5× on both rows, exactly — the archer's 70 becomes 175, the knight's 40 becomes
    /// 100 — and the multiplier is the same ratio for every class, so the classes stay
    /// DPS-neutral charged as well as uncharged.
    #[test]
    fn a_charged_shot_is_two_and_a_half_times_the_class_damage() {
        assert_eq!(charged_damage(CLASS_ARCHER), 175);
        assert_eq!(charged_damage(CLASS_KNIGHT), 100);
        for class in [CLASS_KNIGHT, CLASS_ARCHER] {
            assert_eq!(
                charged_damage(class) as u32 * 2,
                CLASS_DAMAGE[class as usize] as u32 * 5,
            );
        }
        assert_eq!(
            charged_damage(CLASS_KNIGHT) as u32 * (CLASS_COOLDOWN_TICKS[1] + 1),
            charged_damage(CLASS_ARCHER) as u32 * (CLASS_COOLDOWN_TICKS[0] + 1),
            "charged DPS is class-neutral too",
        );
    }

    /// The model behind the two vent numbers, over every raid size and not just the two
    /// endpoints the compile-time block pins: time-to-kill RISES with the raid, from 12 s
    /// solo to 69 s at twenty, and a 20-seat raid at the old flat 35 % threshold was the
    /// same 69 s — every pass changed the solo fight, never the full one. And it rises
    /// with the tier at every raid size, which is what the three gates are for.
    #[test]
    fn the_ttk_model_falls_with_every_raider() {
        let shell = TTK_MODEL_SHELL_HP;
        assert_eq!(ttk_s(shell, 1), 12);
        assert_eq!(ttk_s(shell, MAX_SEATS as u8), 69);
        // Monotone the other way: every extra raider makes the fight longer, never
        // shorter. Non-strict because the vent percentage is integer-divided, so adjacent
        // raid sizes can land on the same second.
        for n in 1..MAX_SEATS as u8 {
            assert!(
                ttk_s(shell, n + 1) >= ttk_s(shell, n),
                "raid {} is an easier fight than raid {}",
                n + 1,
                n,
            );
        }
        // Every tier is a strictly longer fight than the one below it, for EVERY raid
        // size — the compile-time block pins solo and twenty; this is the rest of the
        // curve. Strict: the tier tables are far enough apart that integer rounding cannot
        // tie two tiers on one second anywhere.
        for n in 1..=MAX_SEATS as u8 {
            for tier in 1..N_TIERS as u8 {
                assert!(
                    ttk_s_tier(shell, n, tier) > ttk_s_tier(shell, n, tier - 1),
                    "raid {n}: tier {tier} is not a longer fight than tier {}",
                    tier - 1,
                );
            }
        }
        // Solo under the original flat 35 % line and the 2,000 core: 11,700 + 2,000 at
        // 50 DPS. A historical literal on purpose — deriving it from BOSS_CORE_HP made it
        // move with the constant it exists to be compared against, which is a test that
        // can never fail.
        const ORIGINAL_SOLO_S: u32 = 274;
        assert!(ttk_s(shell, 1) * 10 <= ORIGINAL_SOLO_S, "the solo pass must be ~10x");
    }

    /// Incoming damage is the third raid-size knob. Solo takes a quarter-bullet and a
    /// third-slam; twenty take exactly the flat 8 and 45 `tick.rs` dealt before the knob
    /// existed. Monotone between, and the clamp is `vent_pct`'s. The tier multiplies the
    /// whole curve — MEDIUM doubles it, HARD triples it — so its shape is one shape.
    #[test]
    fn incoming_damage_scales_with_the_raid() {
        assert_eq!((bullet_damage(1, TIER_EASY), slam_damage(1, TIER_EASY)), (2, 15));
        assert_eq!(
            (bullet_damage(MAX_SEATS as u8, TIER_EASY), slam_damage(MAX_SEATS as u8, TIER_EASY)),
            (8, 45)
        );
        assert_eq!(
            (bullet_damage(0, TIER_EASY), slam_damage(0, TIER_EASY)),
            (bullet_damage(1, TIER_EASY), slam_damage(1, TIER_EASY)),
            "an uncounted raid is a solo raid"
        );
        assert_eq!((bullet_damage(u8::MAX, TIER_EASY), slam_damage(u8::MAX, TIER_EASY)), (8, 45));
        for tier in 0..N_TIERS as u8 {
            let mul = INCOMING_MUL_BY_TIER[tier as usize];
            for n in 1..=MAX_SEATS as u8 {
                assert_eq!(bullet_damage(n, tier), bullet_damage(n, TIER_EASY) * mul, "bullet at {n} on {tier}");
                assert_eq!(slam_damage(n, tier), slam_damage(n, TIER_EASY) * mul, "slam at {n} on {tier}");
                if n < MAX_SEATS as u8 {
                    assert!(bullet_damage(n, tier) <= bullet_damage(n + 1, tier), "bullet at {n}");
                    assert!(slam_damage(n, tier) <= slam_damage(n + 1, tier), "slam at {n}");
                }
            }
        }
        assert_eq!((bullet_damage(1, TIER_HARD), slam_damage(1, TIER_HARD)), (6, 45));
    }

    /// 5× on both rows, exactly, and strictly more than the charged shot on both — the
    /// longer hold must never be the worse deal.
    #[test]
    fn a_super_shot_is_five_times_the_class_damage() {
        assert_eq!(super_damage(CLASS_ARCHER), 350);
        assert_eq!(super_damage(CLASS_KNIGHT), 200);
        for class in [CLASS_KNIGHT, CLASS_ARCHER] {
            assert_eq!(super_damage(class), CLASS_DAMAGE[class as usize] * 5);
            assert!(super_damage(class) > charged_damage(class));
        }
    }
}

/// Fury is derived from the same two numbers the vent reads, so its edges are arithmetic:
/// exactly 20 % is furious, 21 % is not, and an account with nothing in it is neither
/// furious nor a division by zero.
#[cfg(test)]
mod fury_tests {
    use super::*;

    /// The solo boss the tuning was done on: 18,000 shell, 200 core, vent line at 17,640.
    fn solo_boss() -> Boss {
        let mut boss = Boss::zeroed();
        boss.reset_for_incarnation([2_000; N_PARTS], BOSS_CORE_HP, 0, 0);
        boss
    }

    #[test]
    fn fight_hp_is_the_strippable_shell_plus_the_core() {
        let mut boss = solo_boss();
        assert_eq!(
            boss.fight_hp(1, TIER_EASY),
            (560, 560),
            "360 shell above the line + 200 core"
        );
        // Shell above the line is fight HP: 100 off the crown is 100 off `left`.
        boss.parts[0] -= 100;
        assert_eq!(boss.fight_hp(1, TIER_EASY), (460, 560));
        // Shell below the line is not: strip everything and only the core is left, which is
        // exactly how the vent rule reads it.
        boss.parts = [0; N_PARTS];
        assert_eq!(boss.fight_hp(1, TIER_EASY), (200, 560));
        // The same shell is a different fight for twenty: 65 % of it must come off.
        let full = solo_boss();
        assert_eq!(full.fight_hp(MAX_SEATS as u8, TIER_EASY), (11_900, 11_900));
        // And for a HARD raider: 12 % of it, six times EASY's 2 %, before the core the
        // tick will have raised (this fixture seeds the lobby's 200; `core_hp_required`
        // is the tick's, and stage 1b tops it up on the first FIGHTING tick).
        assert_eq!(full.fight_hp(1, TIER_HARD), (2_360, 2_360));
        assert_eq!(
            full.fight_hp(0, TIER_EASY),
            full.fight_hp(1, TIER_EASY),
            "an uncounted raid is a solo raid"
        );
    }

    #[test]
    fn fury_begins_at_exactly_twenty_percent() {
        let mut boss = solo_boss();
        boss.parts = [0; N_PARTS];
        // max = 560, so the line is 112.
        boss.core_hp = 118;
        assert!(!boss.is_furious(1, TIER_EASY), "21 % is not furious");
        boss.core_hp = 113;
        assert!(
            !boss.is_furious(1, TIER_EASY),
            "one point over the line is not furious"
        );
        boss.core_hp = 112;
        assert!(boss.is_furious(1, TIER_EASY), "20 % is furious");
        boss.core_hp = 1;
        assert!(boss.is_furious(1, TIER_EASY));
        boss.core_hp = 0;
        assert!(!boss.is_furious(1, TIER_EASY), "a dead boss is not furious");
        assert!(!solo_boss().is_furious(1, TIER_EASY), "a full shell is nowhere near");
    }

    #[test]
    fn phase_two_begins_at_exactly_half() {
        let mut boss = solo_boss();
        boss.parts = [0; N_PARTS];
        // max = 560, so the line is 280.
        boss.core_hp = 281;
        assert!(!boss.is_phase2(1, TIER_EASY), "one point over the line is not phase 2");
        boss.core_hp = 280;
        assert!(boss.is_phase2(1, TIER_EASY), "50 % is phase 2");
        boss.core_hp = 112;
        assert!(
            boss.is_phase2(1, TIER_EASY) && boss.is_furious(1, TIER_EASY),
            "fury is inside phase 2, not instead of it"
        );
        boss.core_hp = 0;
        assert!(!boss.is_phase2(1, TIER_EASY), "a dead boss sweeps nothing");
        assert!(!solo_boss().is_phase2(1, TIER_EASY), "a full shell is nowhere near");
    }

    #[test]
    fn an_empty_boss_is_safe_and_calm() {
        let boss = Boss::zeroed();
        assert_eq!(boss.fight_hp(0, TIER_EASY), (0, 0));
        assert_eq!(boss.fight_hp(MAX_SEATS as u8, TIER_EASY), (0, 0));
        assert!(!boss.is_furious(0, TIER_EASY) && !boss.is_furious(u8::MAX, TIER_EASY));
        assert!(!boss.is_phase2(0, TIER_EASY) && !boss.is_phase2(u8::MAX, TIER_EASY));
    }
}

/// The class byte. Three properties, and losing any one of them is silent on chain:
/// zero still means the knight, an aim write never touches the class, and the aim a
/// client decodes is the aim that was fired.
#[cfg(test)]
mod class_tests {
    use super::*;

    /// The client-side decoder, written here as the inverse of [`PlayerSlot::set_aim`].
    /// `shoot`'s encode is the authority; this mirrors it so the round trip is testable,
    /// and floats are legal only because this never runs on a validator.
    fn decode_aim(code: u8) -> (f64, f64) {
        let ratio = (code & 0x0f) as f64 / 15.0;
        let sector = (code >> 4) & 0x07;
        let (x, y) = if sector & 1 != 0 {
            (ratio, 1.0)
        } else {
            (1.0, ratio)
        };
        let sign = |neg: bool, v: f64| if neg { -v } else { v };
        (sign(sector & 4 != 0, x), sign(sector & 2 != 0, y))
    }

    /// Every seat on devnet carries 0 here today. If this test ever fails, a redeploy
    /// changed the weapon of every player already in the game.
    #[test]
    fn a_zeroed_seat_is_the_knight_it_already_was() {
        let slot = PlayerSlot::zeroed();
        assert_eq!(slot.class(), CLASS_KNIGHT);
        assert_eq!(slot.shot_damage(), 40, "the shipped knight's damage");
        assert_eq!(
            slot.cooldown_ticks(),
            ticks_for(800) - 1,
            "the shipped knight's cooldown"
        );
    }

    /// The whole feature's single point of silent failure: an aim write that drops
    /// `& CLASS_MASK` changes the player's class on their first shot, with no error.
    #[test]
    fn an_aim_write_never_changes_the_class() {
        let mut archer = PlayerSlot::zeroed();
        archer.set_class(CLASS_ARCHER).unwrap();
        let mut knight = PlayerSlot::zeroed();

        for i in 0..20i32 {
            let (dx, dy) = ((i * 13 - 127) as i8, (i * -7 + 61) as i8);
            archer.set_aim(dx, dy);
            knight.set_aim(dx, dy);
            assert_eq!(archer.class_aim >> 7, 1, "shot {i} disarmed the archer");
            assert_eq!(
                knight.class(),
                CLASS_KNIGHT,
                "shot {i} re-classed the knight"
            );
            assert_eq!(archer.shot_damage(), 70);
            assert_eq!(archer.cooldown_ticks(), ticks_for(1_400) - 1);
        }
        // And the class write is the mirror image: it must not disturb the aim.
        let aim = archer.class_aim & !CLASS_MASK;
        archer.set_class(CLASS_KNIGHT).unwrap();
        assert_eq!(archer.class_aim, aim, "changing class threw the aim away");
    }

    /// An unknown class is refused, never clamped — a clamp turns a version skew into a
    /// silently wrong weapon.
    #[test]
    fn an_unknown_class_is_refused() {
        let mut slot = PlayerSlot::zeroed();
        slot.set_aim(3, -9);
        let before = slot.class_aim;
        assert!(slot.set_class(N_CLASSES).is_err());
        assert!(slot.set_class(255).is_err());
        assert_eq!(slot.class_aim, before, "a refused class must write nothing");
    }

    /// Seven bits of aim buy 1.90° of worst-case error (`17-fullscreen-spec` §5.3). Every
    /// legal wire aim, both classes, against the direction actually fired.
    #[test]
    fn the_aim_a_client_decodes_is_the_aim_that_was_fired() {
        let mut worst = 0.0f64;
        for dx in i8::MIN..=i8::MAX {
            for dy in i8::MIN..=i8::MAX {
                if dx == 0 && dy == 0 {
                    continue; // `octant` refuses this one; there is no shot.
                }
                for class in [CLASS_KNIGHT, CLASS_ARCHER] {
                    let mut slot = PlayerSlot::zeroed();
                    slot.set_class(class).unwrap();
                    slot.set_aim(dx, dy);
                    assert_eq!(slot.class(), class);

                    let (rx, ry) = decode_aim(slot.class_aim);
                    let fired = (dy as f64).atan2(dx as f64);
                    let drawn = ry.atan2(rx);
                    let mut err = (drawn - fired).abs();
                    if err > core::f64::consts::PI {
                        err = core::f64::consts::TAU - err;
                    }
                    worst = worst.max(err.to_degrees());
                }
            }
        }
        assert!(worst < 1.92, "worst aim error {worst}° — a bit was dropped");
    }
}
