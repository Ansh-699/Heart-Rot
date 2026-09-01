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
//!
//! ## Who is supposed to return these
//!
//! A game rule fails here, never as `ProgramError::InvalidArgument`. `InvalidArgument`
//! is one code for every rule at once, and the only diagnostic a failed ER transaction
//! hands back is that code — see the "distinct errors" property in `guards.rs`.
//! The mapping, handler by handler:
//!
//! | Condition | Variant |
//! |---|---|
//! | seat byte `>= MAX_SEATS`, or a slot lookup that misses | [`HeartrotError::SeatOutOfRange`] |
//! | `claim_seat` on a seat held by a different `identity`, and no free seat left | [`HeartrotError::SeatOccupied`] |
//! | a named seat whose `session_pubkey` is still the all-zero sentinel | [`HeartrotError::SeatUnclaimed`] |
//! | `arena.phase` is not one this instruction accepts | [`HeartrotError::WrongPhase`] |
//! | `last_move_tick` / `last_shot_tick` already equals the current tick | [`HeartrotError::RateLimited`] |
//! | `slot.hp == 0` | [`HeartrotError::PlayerDead`] |
//! | `slot.zone` wrong for the instruction, or not standing on the gate | [`HeartrotError::WrongZone`] |
//! | `boss_tick` signer is not the crank-executor PDA | [`HeartrotError::NotCrankSigner`] |
//! | `settle` while the match is still running | [`HeartrotError::MatchNotOver`] |
//!
//! Variants 1, 4 and 5 are only reachable once tags 4 and 6 carry the explicit `seat`
//! byte the ABI in `instruction.rs` specifies — a handler that scans for the
//! signer's own slot instead can never see "that seat is someone else's". They are kept
//! for that reason; do not delete them because the current handler shape misses them.

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

#[cfg(test)]
mod tests {
    use super::*;

    /// The discriminants are wire ABI. The client renders a failure as `Custom(n)` and
    /// has no IDL to look the name up in, so inserting a variant in the middle silently
    /// relabels every error a deployed client already knows. This table is the only
    /// thing enforcing the "never renumber; append instead" rule in the module header —
    /// adding a variant means adding a row, which is the point.
    #[test]
    fn codes_are_frozen() {
        const CODES: [(HeartrotError, u32); 10] = [
            (HeartrotError::WrongSessionKey, 1),
            (HeartrotError::NotCrankSigner, 2),
            (HeartrotError::SeatOutOfRange, 3),
            (HeartrotError::SeatOccupied, 4),
            (HeartrotError::SeatUnclaimed, 5),
            (HeartrotError::WrongPhase, 6),
            (HeartrotError::RateLimited, 7),
            (HeartrotError::PlayerDead, 8),
            (HeartrotError::WrongZone, 9),
            (HeartrotError::MatchNotOver, 10),
        ];

        for (i, (err, code)) in CODES.iter().enumerate() {
            // `Custom(0)` is indistinguishable from "unspecified custom failure" in most
            // tooling, so it must never be one of ours.
            assert_ne!(*code, 0);
            // Dense and ascending: a gap here means a variant was deleted rather than
            // retired in place, and a deleted variant's number must never be reused.
            assert_eq!(*code as usize, i + 1);
            assert_eq!(*err as u32, *code);
            assert_eq!(ProgramError::from(*err), ProgramError::Custom(*code));
        }
    }
}
