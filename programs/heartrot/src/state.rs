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

/// `Arena.phase`.
pub const PHASE_LOBBY: u8 = 0;
pub const PHASE_FIGHTING: u8 = 1;
pub const PHASE_SETTLING: u8 = 2;
pub const PHASE_SETTLED: u8 = 3;

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
    pub _pad0: [u8; 2],
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
    /// `hashv([arena_key, incarnation])` in v1; a VRF callback fills it in v1.1 and
    /// nothing else changes. Per-tick bullet entropy is `hashv([affix_seed, tick])`,
    /// which the client can reproduce locally without waiting on chain state.
    pub affix_seed: [u8; 32],
    pub bullets: [Bullet; MAX_BULLETS],
}

impl AccountLayout for Arena {
    const DISCRIMINATOR: u8 = DISC_ARENA;
}

const _: () = {
    assert!(size_of::<Arena>() == 1160);
    assert!(align_of::<Arena>() == 8);
    assert!(offset_of!(Arena, discriminator) == 0);
    assert!(offset_of!(Arena, version) == 1);
    assert!(offset_of!(Arena, bump) == 2);
    assert!(offset_of!(Arena, phase) == 3);
    assert!(offset_of!(Arena, alive_count) == 4);
    assert!(offset_of!(Arena, bullet_cursor) == 5);
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
};

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
    pub _pad1: [u8; 2],
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
        assert_eq!(size_of::<Arena>(), 1160);
        assert_eq!(size_of::<Boss>(), 50);
        assert_eq!(size_of::<Players>(), 1924);
        assert_eq!(size_of::<Leaderboard>(), 6176);
    }
}
