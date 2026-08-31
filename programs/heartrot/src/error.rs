//! Program-specific errors.
//!
//! Every variant here maps to `ProgramError::Custom(n)` with an **explicit** `n`, and
//! those numbers are wire ABI: the client surfaces them by number, not by name, because
//! a Pinocchio program emits no IDL for anything to look them up in. Never renumber a
//! variant; append instead.
//!
//! Conditions the Solana runtime already has a name for are *not* duplicated here — a
//! missing signature is `ProgramError::MissingRequiredSignature`, a bad PDA is
//! `InvalidSeeds`, a wrong discriminator is `InvalidAccountData`, malformed instruction
//! data is `InvalidInstructionData`. This enum only covers game rules, which is why it
//! is short.

use pinocchio::error::ProgramError;

/// Custom error codes. Numbering starts at 1 so that `Custom(0)` — which some tooling
/// renders indistinguishably from "an unspecified custom failure" — is never one of ours.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum HeartrotError {
    /// `authority` signed, but it is not the session key recorded on that seat. This is
    /// the entire security perimeter for player-facing instructions (D17), so it gets
    /// its own code rather than sharing one with a generic authority failure.
    WrongSessionKey = 1,

    /// The `boss_tick` signer is not `[b"crank-executor", arena.crank_authority]` under
    /// the crank program. Distinct from `WrongSessionKey`: a crank failing to authorize
    /// means the match clock has stopped, which is an operational alarm, not cheating.
    NotCrankSigner = 2,

    /// Seat index is `>= MAX_SEATS`. Raised at the instruction-data boundary before any
    /// account is touched, so a probe for an out-of-bounds slot index never reaches state.
    SeatOutOfRange = 3,

    /// `claim_seat` on a seat whose `session_pubkey` is already non-zero and whose
    /// `identity` differs — a returning player with the same identity is allowed to
    /// overwrite their own key.
    SeatOccupied = 4,

    /// A player instruction named a seat whose `session_pubkey` is still all-zero.
    SeatUnclaimed = 5,

    /// The arena is not in the phase this instruction requires.
    WrongPhase = 6,

    /// The seat's `last_move_tick` / `last_shot_tick` cooldown has not elapsed. ER
    /// transaction fees are zero and the ER runs no fee-payer validation at all, so this
    /// counter *is* the rate limiter — there is no economic backstop behind it (D16).
    RateLimited = 7,

    /// The seat's `hp` is 0. Dead players wait for `respawn_at_tick`; they do not act.
    PlayerDead = 8,

    /// The seat is in the wrong zone for this instruction — shooting from the lobby, or
    /// walking through the gate while already in the arena.
    WrongZone = 9,

    /// `settle` before the boss died, the raid wiped, or `enrage_at_tick` elapsed.
    MatchNotOver = 10,
}

impl From<HeartrotError> for ProgramError {
    #[inline(always)]
    fn from(e: HeartrotError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
