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
//! | `arena.phase` is not one this instruction accepts | [`HeartrotError::WrongPhase`] | `state::Arena::{try_set_phase, begin_roll, begin_next_incarnation}`, `player::assert_playable`, `shoot::process`, `settle::{begin_muster, settle}`, `delegation::{process_delegate, check_commit_accounts}` |
//! | `last_move_tick` / `last_shot_tick` cooldown has not elapsed | [`HeartrotError::RateLimited`] | `player::move_player`, `shoot::process` |
//! | `slot.hp == 0` | [`HeartrotError::PlayerDead`] | `player::move_player`, `shoot::process` |
//! | `slot.zone` is wrong for the instruction | [`HeartrotError::WrongZone`] | `player::enter_gate`, `shoot::process` |
//! | `boss_tick` signer is not the crank-executor PDA | [`HeartrotError::NotCrankSigner`] | `tick::process` |
//! | the arena is not yet `PHASE_SETTLED` | [`HeartrotError::MatchNotOver`] | `settle::write_leaderboard` |
//! | signer is not the compiled-in treasury | [`HeartrotError::NotTreasury`] | `init::init_arena`, `settle::write_leaderboard` |
//! | signer is not `arena.crank_authority` | [`HeartrotError::NotArenaAuthority`] | `player::join`, `settle::{begin_muster, settle, write_leaderboard}`, `delegation::{process_delegate, check_commit_accounts}` |
//! | `join` with a `session_pubkey` already recorded on a different seat | [`HeartrotError::SessionKeyInUse`] | `player::join` |
//! | `move_player` into a tile `map::WALLS` marks solid | [`HeartrotError::BlockedByWall`] | `player::move_player` |
//! | `enter_gate` from a seat that is not standing on a gate tile | [`HeartrotError::NotOnGate`] | `player::enter_gate` |
//! | `authority` signed but is not the seat's `session_pubkey` | [`HeartrotError::WrongSessionKey`] | `guards::assert_session_authority` |
//! | `next_incarnation` before the settled match reached the leaderboard | [`HeartrotError::MatchNotRecorded`] | `init::next_incarnation` |
//! | a VRF callback not signed by the scoped VRF identity | [`HeartrotError::NotVrfIdentity`] | `roll::consume_roll` |
//! | `begin_muster` with no seat in `ZONE_ARENA` | [`HeartrotError::NoRaiders`] | `guards::assert_any_raider`, from `settle::begin_muster` |
//! | `shoot` with `charged = 1` fewer than `state::CHARGE_SLOTS` ER slots after the seat's last accepted step | [`HeartrotError::NotCharged`] | `shoot::fire` |
//!
//! ## Why the game loop added only two codes
//!
//! The game-loop contract (`docs/architecture/06-game-loop.md`, and `state::PHASE_EDGES`
//! which is its executable copy) makes four conditions look like candidates for a variant
//! each — an illegal phase transition, a match already settled, a roll the oracle never
//! fulfilled, and a second concurrent `next_incarnation`. All four are already
//! [`HeartrotError::WrongPhase`], on purpose, and giving any of them its own code would be
//! the "two rows for one condition" defect this header warns about.
//!
//! The state a game-loop instruction is judged against is the triple
//! `(phase, outcome, next_affix_seed)`, and all three live on the `Arena` the caller
//! already passed. "This instruction is not legal from this state" is *one* condition; a
//! caller who wants to know *which* leg refused reads it straight off that account —
//! `outcome == OUTCOME_WIPE` says the raid never earned a roll, an all-zero
//! `next_affix_seed` says the oracle never answered, and `phase == PHASE_LOBBY` after a
//! `next_incarnation` says another transaction won the race. A second code would carry no
//! information the caller does not already hold, while costing a permanently frozen
//! discriminant.
//!
//! Three codes escape that argument, because none of them is a fact about `arena.phase`:
//! one is about the *`Leaderboard`* being stale relative to a correctly-settled arena, one
//! is about *who signed* a callback, and [`HeartrotError::NoRaiders`] is about *`Players`*
//! — `begin_muster` is legal from `PHASE_LOBBY` and refuses anyway, because the pit is
//! empty. A caller cannot read that off the `Arena` it passed, which is exactly the test
//! the paragraph above applies.
//!
//! There is deliberately no row for "`begin_muster` on an arena whose `crank_task_id` is
//! `<= 0`". Code 16 was `CrankTaskIdUnset` and is retired: nothing can produce a
//! non-positive `crank_task_id`, because both writers floor it — `init::init_arena`'s
//! `(… & i64::MAX).max(1)` and `settle::mint_task_id`'s identical clamp — and no other
//! instruction touches the field. `begin_muster` mints a fresh id over the creation-time
//! value before it schedules anything, so it never even reads a value it could reject.
//! A variant guarding a condition its own writers make unreachable is a false failure
//! mode, and a caller who saw `Custom(16)` would go looking for a bug that cannot exist.
//!
//! ## Why the class byte gets no code
//!
//! Tag 4 grew a `class` byte at `[66]` (`instruction.rs`, and `17-fullscreen-spec.md` §5.4).
//! An out-of-range value is refused with the runtime's `InvalidInstructionData`, and that
//! is the whole of it — no variant here, and `HIGHEST_ISSUED` does not move.
//!
//! It reads like a candidate, so the reason it is not one is recorded rather than left to
//! be re-litigated. The test this file applies is "does a code carry information the caller
//! does not already hold, and does it change what the caller does next?" A bad `class` fails
//! both halves. It is unreachable from a correct client — `CharacterSelect` offers two
//! options and the Worker range-checks the byte before it ever builds a transaction — so
//! the only three ways to produce one are a 66-byte block from an app older than the
//! program, a 67-byte block sent to a program older than the app, and a hand-built
//! transaction. The first two are *already* `InvalidInstructionData` from the length check,
//! and all three have the same remedy: ship the matching build. One condition, "this join
//! payload is not one this program understands", and the header's rule is that exactly one
//! variant — here, one runtime builtin — owns each condition.
//!
//! A second code would also be the expensive kind of wrong. Discriminants are wire ABI and
//! permanent (16 is retired and still spent), so a code is only worth issuing for something
//! a client can *act* on differently, and the thing a player can act on here is a
//! human-readable refusal from the Worker, which happens a full round trip before the chain
//! is involved. Nothing about the dead-spacebar report argues otherwise: that was the client
//! declining to build a transaction at all (`17-fullscreen-spec.md` §0.1, Correction A), so
//! no program code — new or old — was ever available to show. A code cannot fix a refusal
//! the program was never asked to make.
//!
//! The same reasoning covers `class_aim` in general. `shoot::fire` writes it under
//! `& CLASS_MASK` and reads the class back with `>> 7` on a `u8`, which is total: there is
//! no out-of-range class *after* join, so there is nothing left to refuse.
//!
//! ## The client half
//!
//! A code the browser renders as a bare number is only half a diagnosis, and a
//! hand-written `Custom(n) -> string` table in TypeScript would be this enum stored
//! twice — the defect this whole file exists to prevent. No such table exists today: the
//! client surfaces the raw number and this file is the place a reader looks it up. If one
//! is ever wanted, it is *generated* from this file — each variant's number is the `= n`
//! below and its message the first sentence of its doc comment — and never typed out by
//! hand in `packages/client`.

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
    // 16 — `CrankTaskIdUnset`, retired. See the module header: both writers of
    // `crank_task_id` floor it at 1, so the condition it named cannot occur. Retired,
    // not free: a future variant is numbered 17 and up, because a deployed client that
    // still knows 16 must never be handed a different rule under that number.
    /// `next_incarnation` on an arena whose result has not reached the `Leaderboard` yet —
    /// `last_arena_id` / `last_incarnation` do not name this match. Tag 15 zeroes every
    /// `damage_dealt` and flips the phase out of `PHASE_SETTLED`, which is the only phase
    /// `write_leaderboard` accepts, so a tag 15 that beat the leaderboard write would
    /// destroy the match record with no way to reconstruct it.
    ///
    /// Not [`Self::WrongPhase`]: the arena's phase is exactly right, and the stale account
    /// is the *`Leaderboard`*. Not [`Self::MatchNotOver`] either — that one means the fight
    /// has not finished; this one means it finished and has not been *filed*. The
    /// distinction is what the caller does next: this is the retryable one (send tag 10,
    /// then tag 15 again), the way [`Self::NotOnGate`] is the retryable half of
    /// [`Self::WrongZone`].
    MatchNotRecorded = 17,

    /// A VRF callback whose signer is not `vrf::pda::scoped_vrf_identity(heartrot)`. The
    /// entire security perimeter for progression: `consume_roll` is the only writer of
    /// `next_affix_seed`, and non-zero seed bytes *mean* "a proof was verified on chain",
    /// so a callback that accepts any other signer lets a player choose the next boss's
    /// ruleset. Distinct from [`Self::NotCrankSigner`] because the consequences are
    /// opposite: a crank that cannot authorize stops the match clock and pages an
    /// operator, while this one is an attempted forgery that must not be filed under an
    /// operational alarm. Distinct from [`Self::WrongSessionKey`] because no seat is
    /// involved — the deprecated global `VRF_PROGRAM_IDENTITY` is shared with every other
    /// consumer of the queue, so "signed by the VRF program" is not the check; "signed by
    /// the identity scoped to *this* program" is.
    NotVrfIdentity = 18,

    /// `begin_muster` (tag 3) was sent while no seat is in `ZONE_ARENA` — nobody has
    /// walked through the gate, so there is nothing to muster for. Refusing is what makes
    /// "a raid armed with an empty pit" unrepresentable: `spawn_volley` would find
    /// `best_seat == NO_TARGET`, never fire, and burn the whole enrage window on an empty
    /// room before recording `OUTCOME_ENRAGE`.
    ///
    /// **What a client does about it:** nothing, and that is the point — it is the
    /// expected answer for the 19 of 20 clients that auto-POST the start route behind the
    /// first raider through. Treat it exactly like the existing 409: the muster is either
    /// not startable yet or already started, and the arena account says which. Distinct
    /// from [`Self::WrongPhase`] because the arena's phase is legal and the stale account
    /// is `Players`; distinct from [`Self::WrongZone`] because no seat was named at all.
    NoRaiders = 19,

    /// `shoot` (tag 7) was sent with `charged = 1` fewer than `state::CHARGE_SLOTS` ER slots
    /// after the seat's last accepted step, so the hold has not accrued and the shot is not
    /// charged. Refused **before** the cooldown is spent — nothing on the seat changes — so
    /// the client resends the same shot uncharged and loses a round trip, not the shot. The
    /// alternative, landing it quietly at 1× damage, is a number on the HUD that disagrees
    /// with the boss bar, which is this project's signature silent failure.
    ///
    /// Distinct from [`Self::RateLimited`], which is `last_shot_tick` against the **crank**
    /// clock; this is `last_move_tick` against the **ER slot** clock, and the remedy is the
    /// opposite: retry now, uncharged, rather than wait. It is the one code a correct client
    /// expects to see in normal play — a step that landed on chain after the browser
    /// decided the hold was complete is a race, not a bug.
    NotCharged = 20,
}

/// Highest code ever issued, live or **retired**. Every variant is numbered at or below
/// it, and appending one means bumping it — which is the step that stops a retired number
/// (16) being handed to a new rule, since the discriminants are wire ABI and a client in a
/// browser tab cannot be asked to forget one.
#[cfg(test)]
const HIGHEST_ISSUED: u32 = 20;

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
        // Strictly ascending from 1, and never above the high-water mark. Ascending
        // gives distinctness — a copy-pasted append that gives two rules one code fails
        // here — and starting at 1 keeps `Custom(0)`, indistinguishable from
        // "unspecified custom failure" in most tooling, from ever being one of ours.
        //
        // It is deliberately *not* a density check any more. Dense-and-equal-to-`i + 1`
        // was the same fact twice (position and number), and it made retiring a variant
        // impossible: retiring 16 left a list of fifteen whose next append is 17, which
        // a density walk rejects for being exactly right. `HIGHEST_ISSUED` carries the
        // fact density was standing in for — which numbers have been spent — and it is
        // the only line an append has to touch.
        let mut prev = 0u32;
        for (err, code) in ALL {
            assert!(*code > prev, "{err:?} is numbered {code}, after {prev}");
            assert!(
                *code <= HIGHEST_ISSUED,
                "{err:?} is numbered {code}: bump HIGHEST_ISSUED when issuing a new code"
            );
            assert_eq!(ProgramError::from(*err), ProgramError::Custom(*code));
            prev = *code;
        }
        assert!(!ALL.is_empty());
    }
}
