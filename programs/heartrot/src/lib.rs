//! HEARTROT — a fully on-chain co-op boss raid. Program entrypoint and dispatch.
//!
//! Native Pinocchio 0.11.2, which means the entrypoint hands us `&mut [AccountView]`
//! (not `AccountInfo` — 0.11 dropped Pinocchio's own account type and re-exports Anza's
//! `solana-account-view`) and validates **nothing**. Every owner check, signer check,
//! PDA re-derivation, discriminator check and arithmetic bound in this program is
//! hand-written; see `guards.rs` for the checks and `state.rs` for the typed casts.
//! There is no framework to fall back on and one omission is a full compromise.
//!
//! This file does exactly three things: declare the entrypoint, split the leading tag
//! byte off the instruction data, and call a handler with the rest. It holds no game
//! logic and touches no account, so that "which instruction ran?" is answerable by
//! reading one match. Argument parsing lives in the handler that owns the arguments —
//! each one length-checks its own `data` — so there is no second place for a wire
//! format to drift out of agreement with the code that consumes it.
//!
//! **There is no `crate::ID`.** The program id arrives as the entrypoint's `program_id`
//! argument and is threaded into every handler; owner checks and PDA derivations compare
//! against that. A `const ID` would have to be pasted in after the first
//! `solana program deploy` and would then be a second source of truth that a redeploy to
//! a fresh key invalidates silently — the failure mode being every `assert_owned_by` in
//! the program rejecting every account it is handed. Every handler called below takes
//! `program_id` for that reason, including the four in `delegation`.
//!
//! ## Wire ABI
//!
//! One tag byte, then the handler's own little-endian argument block. Tags 0–10, 13 and
//! 15 are the client-facing set and match `packages/client/src/instructions.ts` byte for
//! byte; 11 and 12 are operator-only and have no builder, and 14 has none because the VRF
//! program builds it. They are **append-only**: never renumber, never reuse a retired one.
//!
//! Two of them are frozen harder than the rest, both because a *validator* replays them
//! from a row we can no longer edit. `8` is written into the crank row at schedule time and
//! replayed every `state::TICK_MS` for the life of the match; its canonical definition is
//! `handlers::settle::IX_BOSS_TICK`, not this table. `14` is written into the VRF request
//! as the callback discriminator and replayed by the oracle on fulfilment. Renumbering
//! either one strands every match already in flight.
//!
//! | Tag | Handler | Layer | Signer |
//! |---|---|---|---|
//! | 0 | `init::init_leaderboard` | base | anyone (permissionless singleton) |
//! | 1 | `init::init_arena` | base | treasury |
//! | 2 | `delegation::process_delegate` | base | treasury (**and fee payer**) |
//! | 3 | `settle::begin_muster` | ER | treasury |
//! | 4 | `player::join` | ER | treasury |
//! | 5 | `player::enter_gate` | ER | session key |
//! | 6 | `player::move_player` | ER | session key |
//! | 7 | `shoot::process` | ER | session key |
//! | 8 | `tick::process` | ER | crank signer PDA (read-only) |
//! | 9 | `settle::settle` | ER | treasury |
//! | 10 | `settle::write_leaderboard` | base | treasury |
//! | 11 | `delegation::process_commit` | ER | treasury |
//! | 12 | `delegation::process_commit_and_undelegate` | ER | treasury |
//! | 13 | `roll::request_roll` | ER | session key (writable — the VRF request needs one) |
//! | 14 | `roll::consume_roll` | ER | scoped VRF identity PDA (read-only) |
//! | 15 | `init::next_incarnation` | base | treasury |
//!
//! Plus one instruction that carries no tag of ours at all: the delegation program's
//! undelegation callback, routed by its own 8-byte discriminator before the tag split.
//! The VRF callback (tag 14) needs no such route *because* its discriminator was chosen to
//! be the single byte `14`: the oracle prepends the discriminator we handed it at request
//! time, so it lands in the ordinary tag split. Widening that discriminator past one byte
//! would silently move it out of the dispatch and into `InvalidInstructionData` forever.

use pinocchio::{entrypoint, error::ProgramError, AccountView, Address, ProgramResult};

use ephemeral_rollups_pinocchio::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR;

pub mod error;
pub mod guards;
pub mod instruction;
pub mod state;

/// Generated tables. Neither file is hand-editable: `hitboxes` is compiled from
/// `assets/sprites/hitboxes.json` by `tools/gen_hitboxes.py` (same pass that emits the
/// TS copy the renderer imports), `map` from `assets/map/arena.json` by `tools/gen_map.py`.
/// Both exist because the alternative — a hand-written Rust copy of data the art and the
/// client also hold — is the one defect this codebase keeps producing: the drawn boss and
/// the raycast boss stopped being the same boss. Edit the asset, re-run the tool.
pub mod hitboxes;
pub mod map;

/// The handler modules live in `src/handlers/`, and `handlers/mod.rs` does not exist —
/// an inline module declaration pushes the directory component instead, so each `mod`
/// below resolves to `src/handlers/<name>.rs`. `pub` because `player.rs` reaches across
/// to `crate::handlers::tick::entrance_for`, and because leaving it private would make
/// every helper a module exports but does not itself call read as dead code.
pub mod handlers {
    pub mod delegation;
    pub mod init;
    pub mod player;
    pub mod roll;
    pub mod settle;
    pub mod shoot;
    pub mod tick;
}

/// Cap on the accounts the entrypoint will parse into the stack array.
///
/// Pinocchio's default is `MAX_TX_ACCOUNTS` (255), which reserves a slot per account in
/// the entrypoint's stack frame for a program whose largest instruction — `delegate`,
/// with three PDAs each needing a buffer, a delegation record and a metadata account —
/// uses 16. The ER refuses any transaction with `program_id_index >= 38`, and since
/// Solana's message compiler sorts program ids last, that is a ~38 total-key ceiling on
/// everything we send (D3/D18, and address lookup tables are rejected outright, so there
/// is no escape hatch). 40 sits just above that ceiling: no transaction this program can
/// legally receive on the ER is truncated, and the base-layer setup instructions are far
/// smaller still.
///
/// ponytail: accounts past index 39 are dropped *silently* by the entrypoint. Handlers
/// destructure with exact slice patterns, so a truncated list fails as
/// `NotEnoughAccountKeys` rather than executing on the wrong accounts. If a base-layer
/// instruction ever legitimately needs more, raise this constant — it costs 8 bytes of
/// entrypoint stack per slot and nothing else.
const MAX_ACCOUNTS: usize = 40;

/// Tags whose handler takes no `data` parameter and therefore cannot reject a trailing
/// payload itself. A long argument block is either client/program version skew or someone
/// parking bytes where a later version of this program might read them; neither is
/// something to accept quietly, and the handlers that *do* take `data` all reject it.
///
/// `8` is deliberately absent: nothing may stand between the crank and `tick::process`,
/// the one handler that must never return `Err`. `14` is absent for exactly the same
/// reason with a different validator on the other end — it is the VRF oracle's callback,
/// and an `Err` there reverts the oracle's `ProvideRandomness` transaction, which it then
/// retries for the request's full 240-slot TTL. `10` is absent too, but only for
/// compatibility: the client sends `write_leaderboard` a 10-byte
/// `(arena_id, incarnation)` block that the handler ignores in favour of the authoritative
/// pair it reads off the `Arena` account.
const ZERO_ARG_TAGS: [u8; 6] = [2, 3, 9, 11, 12, 15];

entrypoint!(process_instruction, MAX_ACCOUNTS);

/// `#[inline(never)]` is Pinocchio's own advice for a program with a real dispatch
/// table: without it the compiler is free to inline every handler's call tree into the
/// generated `entrypoint`, and the summed stack frame overflows BPF's 4 KB.
#[inline(never)]
pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    // The undelegation callback is not ours to number: the delegation program CPIs into
    // us with its own 8-byte discriminator followed by a borsh `Vec<Vec<u8>>` of the
    // account's seeds, so it has to be routed before the tag split or its first byte
    // (196) reads as an unknown instruction and the three match accounts can never leave
    // the ER. Routing on all eight bytes rather than on the leading 196 is what keeps a
    // truncated payload from reaching the handler at all. It is still only a *route*,
    // never an authorization — authentication is the buffer PDA's signature, and that is
    // proved inside the SDK's `undelegate`.
    if instruction_data.starts_with(&EXTERNAL_UNDELEGATE_DISCRIMINATOR) {
        return handlers::delegation::process_undelegation(program_id, accounts, instruction_data);
    }

    // Empty data is rejected rather than defaulting to tag 0 — an empty slice is not a
    // request to initialize the leaderboard.
    let (&tag, data) = instruction_data
        .split_first()
        .ok_or(ProgramError::InvalidInstructionData)?;

    if ZERO_ARG_TAGS.contains(&tag) && !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    match tag {
        0 => handlers::init::init_leaderboard(program_id, accounts, data),
        1 => handlers::init::init_arena(program_id, accounts, data),
        2 => handlers::delegation::process_delegate(program_id, accounts),
        3 => handlers::settle::begin_muster(program_id, accounts),
        4 => handlers::player::join(program_id, accounts, data),
        5 => handlers::player::enter_gate(program_id, accounts, data),
        6 => handlers::player::move_player(program_id, accounts, data),
        7 => handlers::shoot::process(program_id, accounts, data),

        // `boss_tick` is the one handler that must never return `Err`. A crank that
        // fails ten times in a row has its task deleted permanently by the validator —
        // seconds into the match at `state::TICK_MS` — and there is no way to re-arm it
        // from inside a crank (ScheduleTask needs a writable signer; a crank may carry
        // none). That is also why the muster is spent out of the same iteration budget
        // rather than topped up later. The handler absorbs its own failures and returns
        // `Ok`; this arm just forwards.
        8 => handlers::tick::process(program_id, accounts),

        9 => handlers::settle::settle(program_id, accounts),
        10 => handlers::settle::write_leaderboard(program_id, accounts),
        11 => handlers::delegation::process_commit(program_id, accounts),
        12 => handlers::delegation::process_commit_and_undelegate(program_id, accounts),
        13 => handlers::roll::request_roll(program_id, accounts, data),

        // The VRF oracle's callback. It reaches the ordinary tag split rather than a
        // pre-tag route because `request_roll` hands the VRF program a one-byte callback
        // discriminator that *is* this tag; the oracle prepends it and appends the 32
        // randomness bytes plus our `callback_args`. Like `boss_tick`, this handler must
        // never return `Err` — an `Err` reverts the oracle's fulfilment transaction and it
        // retries for the request's whole TTL — so this arm just forwards, and 14 is kept
        // out of `ZERO_ARG_TAGS` so nothing can reject on its behalf first.
        14 => handlers::roll::consume_roll(program_id, accounts, data),

        15 => handlers::init::next_incarnation(program_id, accounts),

        _ => Err(ProgramError::InvalidInstructionData),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Routing is this file's only logic, and the part of it that needs no runtime is the
    /// pre-tag work: the empty payload, the boundary between "this is the undelegation
    /// callback" and "this is tag 196", and the trailing-byte gate.
    ///
    /// Every case here is checked against `InvalidInstructionData` specifically rather
    /// than `is_err()`. With an empty account slice a handler that was reached would
    /// answer `NotEnoughAccountKeys`, so the exact error is what proves the request was
    /// rejected *before* dispatch — which is the whole claim.
    #[test]
    fn routing_rejects_before_dispatch() {
        let id = Address::new_from_array([0u8; 32]);
        let mut none: [AccountView; 0] = [];

        assert_eq!(
            process_instruction(&id, &mut none, &[]).unwrap_err(),
            ProgramError::InvalidInstructionData,
        );

        // The callback's leading byte alone must not reach `process_undelegation`.
        assert_eq!(
            process_instruction(&id, &mut none, &[EXTERNAL_UNDELEGATE_DISCRIMINATOR[0]])
                .unwrap_err(),
            ProgramError::InvalidInstructionData,
        );

        for tag in ZERO_ARG_TAGS {
            assert_eq!(
                process_instruction(&id, &mut none, &[tag, 0]).unwrap_err(),
                ProgramError::InvalidInstructionData,
                "tag {tag} accepted a trailing byte",
            );
        }

        // Everything above the highest issued tag is unknown, and stays unknown.
        assert_eq!(
            process_instruction(&id, &mut none, &[16]).unwrap_err(),
            ProgramError::InvalidInstructionData,
        );
    }

    /// Two tags are replayed by a validator from a row this program can no longer edit:
    /// `8` from the crank's SQLite row, `14` from the VRF request's frozen callback. Both
    /// must reach their handler and both must answer `Ok` even when the request is
    /// unusable — ten consecutive `Err`s delete the crank task permanently, and one `Err`
    /// on the callback reverts the oracle's fulfilment transaction into a 240-slot retry
    /// loop. So neither may appear in `ZERO_ARG_TAGS`, where a trailing byte would be
    /// rejected *before* dispatch and turn a cosmetic mismatch into a dead match.
    ///
    /// With an empty account slice both handlers are reached and find nothing to work on,
    /// which is the cheapest reachable instance of "unusable request": an `Err` here is
    /// the exact failure this test exists to catch.
    #[test]
    fn validator_replayed_tags_never_err_before_their_handler() {
        assert!(!ZERO_ARG_TAGS.contains(&handlers::settle::IX_BOSS_TICK));
        assert!(!ZERO_ARG_TAGS.contains(&14));

        let id = Address::new_from_array([0u8; 32]);
        let mut none: [AccountView; 0] = [];

        // Tag 8 as the crank row holds it: the bare byte, plus the trailing-payload case
        // that `ZERO_ARG_TAGS` must not be extended to cover.
        assert!(process_instruction(&id, &mut none, &[handlers::settle::IX_BOSS_TICK]).is_ok());
        assert!(process_instruction(&id, &mut none, &[handlers::settle::IX_BOSS_TICK, 0]).is_ok());

        // Tag 14 as the oracle builds it — discriminator, 32 randomness bytes,
        // `for_incarnation` u16 LE — and the truncated block an attacker sends instead.
        let mut callback = [0u8; 35];
        callback[0] = 14;
        assert!(process_instruction(&id, &mut none, &callback).is_ok());
        assert!(process_instruction(&id, &mut none, &[14]).is_ok());
        assert!(process_instruction(&id, &mut none, &[14, 1, 2, 3]).is_ok());
    }

    /// `IX_BOSS_TICK` is frozen into every live crank row, so the dispatch arm above has to
    /// be the same number. They are written in two files because the crank row is built in
    /// `settle.rs` and the route lives here; this is the assertion that keeps the two from
    /// drifting, which is otherwise only discoverable by a match dying seconds in on devnet.
    #[test]
    fn boss_tick_tag_matches_the_crank_row() {
        assert_eq!(handlers::settle::IX_BOSS_TICK, 8);
    }
}
