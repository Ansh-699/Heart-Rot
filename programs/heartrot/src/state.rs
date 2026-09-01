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
/// on devnet, and `packages/client` plus `app/` switch on them); 4 and 5 are appended.
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
/// A VRF request for the next incarnation's seed is in flight. The accounts must **not**
/// be committed or undelegated here: the callback would land on an account the ER no
/// longer holds, fail, and be retried by the oracle for the whole 240-slot request TTL.
pub const PHASE_ROLLING: u8 = 4;
/// The seed is in `next_affix_seed` and the match is ready to settle.
pub const PHASE_ROLLED: u8 = 5;

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

/// Crank ticks a VRF roll may stay in [`PHASE_ROLLING`] before `boss_tick` abandons it.
///
/// 25 ticks ≈ 10 s at the crank's 400 ms target, against a documented in-ER fulfilment of
/// ~100 ms and a hard floor of one ER slot — so this is far past any legitimate callback
/// while still short enough that a VRF outage does not look like a hang.
///
/// Abandoning writes **no seed**. The fallback is deliberately not "derive one from
/// SlotHashes and carry on": a validator-influenceable seed is not verifiable randomness,
/// and an incarnation whose ruleset was quietly chosen by whoever produced a block is the
/// exact property the VRF exists to deny. `begin_next_incarnation` then refuses with
/// `WrongPhase` — loud and recoverable, rather than silent and wrong.
pub const ROLL_TIMEOUT_TICKS: u32 = 25;

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
    let head = data.get(..T::LEN).ok_or(ProgramError::AccountDataTooSmall)?;
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
    /// Players alive in `ZONE_ARENA`. Drives `bullets_per_volley = 3 + alive_count`,
    /// so it is game balance, not telemetry.
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
    pub _pad0: u8,
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
    /// 6-minute timeout expressed in ticks.
    pub enrage_at_tick: u32,
    /// One bit per seat, low `MAX_SEATS` bits. Lets the Worker allocate a seat from a
    /// single u32 without decoding the 1,924-byte `Players` account.
    pub seat_occupied: u32,
    pub incarnation: u16,
    pub _pad1: [u8; 2],
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
    pub _pad2: [u8; 4],
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
    assert!(offset_of!(Arena, arena_id) == 8);
    assert!(offset_of!(Arena, crank_task_id) == 16);
    assert!(offset_of!(Arena, tick) == 24);
    assert!(offset_of!(Arena, enrage_at_tick) == 28);
    assert!(offset_of!(Arena, seat_occupied) == 32);
    assert!(offset_of!(Arena, incarnation) == 36);
    assert!(offset_of!(Arena, crank_authority) == 40);
    assert!(offset_of!(Arena, validator_identity) == 72);
    assert!(offset_of!(Arena, affix_seed) == 104);
    assert!(offset_of!(Arena, bullets) == 136);
    assert!(offset_of!(Arena, roll_requested_tick) == 1160);
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
/// about whether, say, a `ROLLING` arena may be committed. (It may not: the VRF callback
/// would land on an undelegated account and be retried by the oracle for two minutes.)
///
/// Read as "from → the set of `to`":
///
/// | From | To | Performed by |
/// |---|---|---|
/// | `LOBBY` | `FIGHTING` | tag 3 `start_match` |
/// | `FIGHTING` | `SETTLING` | tag 7 `shoot` (killing blow) · tag 8 `boss_tick` |
/// | `FIGHTING` | `SETTLED` | tag 9 `settle` — dead-crank recovery, must stay legal |
/// | `SETTLING` | `ROLLING` | tag 13 `request_roll`, and only when `outcome == OUTCOME_WIN` |
/// | `SETTLING` | `SETTLED` | tag 9 `settle` · tag 12 `commit_and_undelegate` |
/// | `ROLLING` | `ROLLED` | tag 14 `consume_roll`, the VRF callback |
/// | `ROLLING` | `SETTLING` | tag 8 `boss_tick`, after [`ROLL_TIMEOUT_TICKS`] |
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
/// Everything else is rejected. Three absences carry weight: `ROLLING → SETTLED` (the
/// commit-during-fulfilment hazard above), `LOBBY → SETTLED` (an arena that was never
/// fought has nothing to record — the rule `settle` already enforces), and `LOBBY → LOBBY`
/// (which is what makes a second `next_incarnation` a rejection rather than a second reset,
/// and therefore what stops two settlements racing the incarnation counter).
const PHASE_EDGES: [(u8, u8); 10] = [
    (PHASE_LOBBY, PHASE_FIGHTING),
    (PHASE_FIGHTING, PHASE_SETTLING),
    (PHASE_FIGHTING, PHASE_SETTLED),
    (PHASE_SETTLING, PHASE_ROLLING),
    (PHASE_SETTLING, PHASE_SETTLED),
    (PHASE_ROLLING, PHASE_ROLLED),
    (PHASE_ROLLING, PHASE_SETTLING),
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
    /// What carries over: `arena_id`, `bump`, `crank_authority`, `validator_identity`,
    /// `enrage_at_tick` (a rule of the fight, not match state), and — because it is a
    /// different account entirely — the whole `Leaderboard` ring. What
    /// resets: the clock, the phase, the outcome, the bullet pool, the seat bitmask, and
    /// (through [`Players::reset_for_incarnation`] and [`Boss::reset_for_incarnation`])
    /// every seat and every point of boss HP.
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
        self.alive_count = 0;
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
    /// 0 sealed, 1 open. Recomputed every tick from `sum(parts) < 35% of sum(parts_max)`,
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
    /// threshold (`sum(parts) × 100 < sum(parts_max) × 35`) meaningful: a full shell is
    /// exactly 100 % by construction, on every incarnation.
    pub fn reset_for_incarnation(&mut self, parts: [u16; N_PARTS], core_hp: u16, x: i16, y: i16) {
        self.x = x;
        self.y = y;
        self.core_hp = core_hp;
        self.core_hp_max = core_hp;
        self.parts = parts;
        self.parts_max = parts;
        // A full shell is sealed, the first attack beat is the crank's to schedule, and
        // nobody is in the arena yet. `NO_TARGET` rather than 0 so a stale index cannot
        // read as "aiming at seat 0".
        self.vent_open = 0;
        self.attack_timer = 0;
        self.target_seat = NO_TARGET;
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

/// One seat. Slot index *is* the seat number, so there is no `seat` field to
/// disagree with it.
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct PlayerSlot {
    /// `ZONE_LOBBY` or `ZONE_ARENA`. The gate tile flips it.
    pub zone: u8,
    /// 0..7, eight-way. Hitscan raycasts along it.
    pub facing: u8,
    pub skin_id: u8,
    pub _pad0: u8,
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

const _: () = {
    assert!(size_of::<PlayerSlot>() == 96);
    assert!(align_of::<PlayerSlot>() == 4);
    assert!(offset_of!(PlayerSlot, zone) == 0);
    assert!(offset_of!(PlayerSlot, facing) == 1);
    assert!(offset_of!(PlayerSlot, skin_id) == 2);
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
    pub _pad0: u8,
}

const _: () = {
    assert!(size_of::<LeaderboardEntry>() == 48);
    assert!(align_of::<LeaderboardEntry>() == 8);
    assert!(offset_of!(LeaderboardEntry, arena_id) == 0);
    assert!(offset_of!(LeaderboardEntry, identity) == 8);
    assert!(offset_of!(LeaderboardEntry, damage_dealt) == 40);
    assert!(offset_of!(LeaderboardEntry, incarnation) == 44);
    assert!(offset_of!(LeaderboardEntry, survived) == 46);
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

    const PHASES: [u8; 6] = [
        PHASE_LOBBY,
        PHASE_FIGHTING,
        PHASE_SETTLING,
        PHASE_SETTLED,
        PHASE_ROLLING,
        PHASE_ROLLED,
    ];

    /// The whole 6×6 product, so a widened `PHASE_EDGES` cannot quietly legalise an edge
    /// nobody argued for. The four spelled out below are the ones with consequences.
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
        assert_eq!(legal, PHASE_EDGES.len(), "an edge is declared twice, or outside PHASES");

        // Committing an arena whose VRF callback is still in flight lands the callback on
        // an undelegated account; the oracle then retries it for the request's whole TTL.
        assert!(!Arena::may_transition(PHASE_ROLLING, PHASE_SETTLED));
        // A second `next_incarnation` must be rejected, not advance the counter twice.
        assert!(!Arena::may_transition(PHASE_LOBBY, PHASE_LOBBY));
        // A retried `settle` is by design — `GetCommitmentSignature` throws on every
        // failure path, so "unknown" is the only answer the settle route ever gets.
        assert!(Arena::may_transition(PHASE_SETTLED, PHASE_SETTLED));
        // Dead-crank recovery: a match whose task died can only ever end this way.
        assert!(Arena::may_transition(PHASE_FIGHTING, PHASE_SETTLED));
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
        arena.alive_count = 5;
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

        arena.try_set_phase(PHASE_SETTLED).expect("a rolled match settles");
        let next = arena.begin_next_incarnation().expect("a verified seed advances");

        assert_eq!(next, 1);
        assert_eq!(arena.phase, PHASE_LOBBY);
        assert_eq!(arena.affix_seed, [9u8; 32], "the rolled seed becomes this fight's seed");
        assert_eq!(arena.next_affix_seed, [0u8; 32]);
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);
        assert_eq!((arena.tick, arena.alive_count, arena.seat_occupied), (0, 0, 0));
        assert!(arena.bullets.iter().all(|b| b.active == BULLET_FREE));
        assert_eq!(arena.arena_id, 7, "identity carries over; the match does not");

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
        assert!(players.slots.iter().all(|s| s.damage_dealt == 0 && s.deaths == 0));

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
