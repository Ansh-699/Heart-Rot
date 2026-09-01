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
//!
//! This table is the contract, not a description of what the handlers currently do:
//! **exactly one** variant owns each condition, and the site named in the third column
//! is the site that must raise it. A handler returning a runtime builtin where a row
//! below names a variant is a defect in that handler, and two rows describing the same
//! condition is a defect *here* — it licenses two handlers to disagree, which is how
//! `enter_gate` ended up answering `WrongZone` for a player who was simply not on the
//! tile yet.
//!
//! | Condition | Variant | Raised by |
//! |---|---|---|
//! | seat byte `>= MAX_SEATS`, or a slot lookup that misses | [`HeartrotError::SeatOutOfRange`] | `player::{join, enter_gate, move_player}`, `shoot::process` |
//! | `join` names a free seat that is already claimed by another `identity` | [`HeartrotError::SeatOccupied`] | `player::join` |
//! | a named seat whose `session_pubkey` is still the all-zero sentinel | [`HeartrotError::SeatUnclaimed`] | `guards::assert_session_authority` |
//! | `arena.phase` is not one this instruction accepts | [`HeartrotError::WrongPhase`] | `player`, `shoot`, `settle`, `delegation` |
//! | `last_move_tick` / `last_shot_tick` cooldown has not elapsed | [`HeartrotError::RateLimited`] | `player::move_player`, `shoot::process` |
//! | `slot.hp == 0` | [`HeartrotError::PlayerDead`] | `player::move_player`, `shoot::process` |
//! | `slot.zone` is wrong for the instruction | [`HeartrotError::WrongZone`] | `player::enter_gate`, `shoot::process` |
//! | `boss_tick` signer is not the crank-executor PDA | [`HeartrotError::NotCrankSigner`] | `tick::process` |
//! | the arena is not yet `PHASE_SETTLED` | [`HeartrotError::MatchNotOver`] | `settle::write_leaderboard` |
//! | signer is not the compiled-in treasury | [`HeartrotError::NotTreasury`] | `init::init_arena`, `settle::write_leaderboard` |
//! | signer is not `arena.crank_authority` | [`HeartrotError::NotArenaAuthority`] | `player::join`, `settle::{start_match, settle}`, `delegation` |
//! | `join` with a `session_pubkey` already recorded on a different seat | [`HeartrotError::SessionKeyInUse`] | `player::join` |
//! | `move_player` into a tile `map::WALLS` marks solid | [`HeartrotError::BlockedByWall`] | `player::move_player` |
//! | `enter_gate` from a seat that is not standing on a gate tile | [`HeartrotError::NotOnGate`] | `player::enter_gate` |
//! | `start_match` on an arena whose `crank_task_id` is `<= 0` | [`HeartrotError::CrankTaskIdUnset`] | `settle::start_match` |
//! | `authority` signed but is not the seat's `session_pubkey` | [`HeartrotError::WrongSessionKey`] | `guards::assert_session_authority` |
//!
//! ## The client half
//!
//! A code the browser renders as a bare number is only half a diagnosis, and a
//! hand-written `Custom(n) -> string` table in TypeScript would be this enum stored
//! twice — the defect this whole file exists to prevent. The client table is generated
//! from *this file*: each variant's number is the `= n` below and its message is the
//! first sentence of its doc comment. Add a variant here and re-run the generator; never
//! edit the emitted table.

use pinocchio::error::ProgramError;

/// Declares [`HeartrotError`] and, under `cfg(test)`, the table the freeze test walks.
///
/// The enum and the table expand from the same tokens, so a variant cannot exist without
/// a row: the previous shape kept a hand-copied `[(HeartrotError, u32); 16]` in the test
/// and a comment asserting that "adding a variant means adding a row", which nothing
/// enforced — a 17th variant compiled and the freeze test went on passing over the first
/// sixteen. One list, or the guard is decoration.
macro_rules! heartrot_errors {
    ($( $(#[$doc:meta])* $name:ident = $code:literal, )*) => {
        /// Custom error codes. Numbering starts at 1 so that `Custom(0)` — which some
        /// tooling renders indistinguishably from "an unspecified custom failure" — is
        /// never one of ours.
        #[derive(Clone, Copy, PartialEq, Eq, Debug)]
        #[repr(u32)]
        pub enum HeartrotError {
            $( $(#[$doc])* $name = $code, )*
        }

        /// Every variant, in declaration order. Test-only: nothing on chain enumerates
        /// the enum, and a `pub` copy would be public API with no caller.
        #[cfg(test)]
        const ALL: &[(HeartrotError, u32)] = &[ $( (HeartrotError::$name, $code), )* ];
    };
}

heartrot_errors! {
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

    /// `join` on a seat whose `session_pubkey` is already non-zero and whose `identity`
    /// differs — a returning player with the same identity is allowed to overwrite their
    /// own key.
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
    /// walking through the gate while already in the arena. Standing in the right zone
    /// but on the wrong *tile* is [`Self::NotOnGate`], not this.
    WrongZone = 9,

    /// The arena has not reached `PHASE_SETTLED`, so it has no result to record. Raised
    /// by `write_leaderboard`, which is the one place the condition is decidable:
    /// `PHASE_SETTLED` is written by `settle` itself, so any other phase here means the
    /// settlement has not happened yet. Distinct from [`Self::WrongPhase`], which is a
    /// wrong-order call; this one is a call that is merely early.
    MatchNotOver = 10,

    /// The signer is not the compiled-in [`crate::handlers::init::TREASURY`]. Raised by
    /// `init_arena` (which creates accounts at the payer's expense) and by
    /// `write_leaderboard` (the ring is a program-wide singleton, and `crank_authority`
    /// is per-arena, so only the treasury constant can gate it). Distinct from
    /// [`Self::NotArenaAuthority`]: this one means "wrong key for the *program*", which
    /// is a deployment/config fault, not a wrong key for one match.
    NotTreasury = 11,

    /// The signer is not the `crank_authority` recorded on this `Arena`. The rule behind
    /// `join` (seats are administered by the Worker, not self-served), `start_match` (the
    /// scheduling payer becomes the task authority, so a mismatch schedules a task nobody
    /// can cancel), `settle` (the scheduler treats a cancel from the wrong authority as a
    /// silent no-op), and `delegate` / `commit`, where ER fees are zero and this check is
    /// the only rate limit on burning the ten commits an account gets.
    NotArenaAuthority = 12,

    /// `join` was handed a `session_pubkey` that is already recorded on a *different*
    /// seat. Distinct from [`Self::SeatOccupied`], which is about the seat: this is about
    /// the key. Accepting it would let one browser drive two seats and double-count its
    /// damage on the leaderboard.
    SessionKeyInUse = 13,

    /// `move_player`'s destination tile is solid in `crate::map::WALLS`. Expected and
    /// frequent — a player holding a direction into a corridor wall produces one of these
    /// per tick — so the client must treat it as "prediction rejected, resnap", never as
    /// an error to surface. It has its own code precisely so it can be filtered.
    BlockedByWall = 14,

    /// `enter_gate` from a seat whose `(x, y)` is not on a gate tile. Split out of
    /// [`Self::WrongZone`] because the two are opposite diagnoses of the same failed
    /// call: `WrongZone` means the player is already through, this means the chain has
    /// not yet seen the move that put them on the tile (F2 — the client must retry,
    /// not give up).
    NotOnGate = 15,

    /// `start_match` on an `Arena` whose `crank_task_id` is `<= 0`. `task_id` is a
    /// validator-global namespace and a collision fails *silently* after the CPI returns
    /// `Ok`, so an unset or non-positive id must fail loudly here rather than schedule a
    /// task that never ticks (H4).
    CrankTaskIdUnset = 16,
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
    /// relabels every error a deployed client already knows, and reusing a retired number
    /// relabels it twice over.
    ///
    /// `ALL` expands from the same tokens as the enum, so this walks every variant by
    /// construction — there is no second list to forget to update.
    #[test]
    fn codes_are_frozen() {
        for (i, (err, code)) in ALL.iter().enumerate() {
            // Dense and ascending from 1. This is the whole check: a gap means a variant
            // was deleted rather than retired in place (and a deleted number must never
            // be reused), a repeat means a copy-pasted append gave two rules one code,
            // and starting at 1 keeps `Custom(0)` — indistinguishable from "unspecified
            // custom failure" in most tooling — from ever being one of ours.
            assert_eq!(*code as usize, i + 1, "{err:?} is numbered {code}");
            assert_eq!(ProgramError::from(*err), ProgramError::Custom(*code));
        }
        // The count is asserted so that a *truncating* edit — deleting the tail of the
        // enum — fails here rather than passing a shorter, still-dense walk.
        assert_eq!(ALL.len(), 16);
    }
}
