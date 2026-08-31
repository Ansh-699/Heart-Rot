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
//! One tag byte, then the handler's own little-endian argument block. Tags 0–10 are the
//! client-facing set and match `packages/client/src/instructions.ts` byte for byte; 11
//! and 12 are operator-only and have no builder. They are **append-only**: never
//! renumber, never reuse a retired one. `8` is frozen harder than the rest — it is
//! written into the validator's crank row at schedule time and replayed from there for
//! the life of the match, so it can never move. Its canonical definition is
//! `handlers::settle::IX_BOSS_TICK`, not this table.
//!
//! | Tag | Handler | Layer | Signer |
//! |---|---|---|---|
//! | 0 | `init::init_leaderboard` | base | anyone (permissionless singleton) |
//! | 1 | `init::init_arena` | base | treasury |
//! | 2 | `delegation::process_delegate` | base | treasury (**and fee payer**) |
//! | 3 | `settle::start_match` | ER | treasury |
//! | 4 | `player::join` | ER | treasury |
//! | 5 | `player::enter_gate` | ER | session key |
//! | 6 | `player::move_player` | ER | session key |
//! | 7 | `shoot::process` | ER | session key |
//! | 8 | `tick::process` | ER | crank signer PDA (read-only) |
//! | 9 | `settle::settle` | ER | treasury |
//! | 10 | `settle::write_leaderboard` | base | treasury |
//! | 11 | `delegation::process_commit` | ER | treasury |
//! | 12 | `delegation::process_commit_and_undelegate` | ER | treasury |
//!
//! Plus one instruction that carries no tag of ours at all: the delegation program's
//! undelegation callback, routed by its own 8-byte discriminator before the tag split.

use pinocchio::{entrypoint, error::ProgramError, AccountView, Address, ProgramResult};

use ephemeral_rollups_pinocchio::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR;

pub mod error;
pub mod guards;
pub mod instruction;
pub mod state;

/// The handler modules live in `src/handlers/`, and `handlers/mod.rs` does not exist —
/// an inline module declaration pushes the directory component instead, so each `mod`
/// below resolves to `src/handlers/<name>.rs`. `pub` because `player.rs` reaches across
/// to `crate::handlers::tick::entrance_for`, and because leaving it private would make
/// every helper a module exports but does not itself call read as dead code.
pub mod handlers {
    pub mod delegation;
    pub mod init;
    pub mod player;
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
/// the one handler that must never return `Err`. `10` is absent too — the client sends
/// `write_leaderboard` a 10-byte `(arena_id, incarnation)` block that the handler ignores
/// in favour of the authoritative pair it reads off the `Arena` account.
const ZERO_ARG_TAGS: [u8; 5] = [2, 3, 9, 11, 12];

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
        3 => handlers::settle::start_match(program_id, accounts),
        4 => handlers::player::join(program_id, accounts, data),
        5 => handlers::player::enter_gate(program_id, accounts, data),
        6 => handlers::player::move_player(program_id, accounts, data),
        7 => handlers::shoot::process(program_id, accounts, data),

        // `boss_tick` is the one handler that must never return `Err`. A crank that
        // fails ten times in a row has its task deleted permanently by the validator,
        // ~26 s into the match, and there is no way to re-arm it from inside a crank
        // (ScheduleTask needs a writable signer; a crank may carry none). The handler
        // absorbs its own failures and returns `Ok`; this arm just forwards.
        8 => handlers::tick::process(program_id, accounts),

        9 => handlers::settle::settle(program_id, accounts),
        10 => handlers::settle::write_leaderboard(program_id, accounts),
        11 => handlers::delegation::process_commit(program_id, accounts),
        12 => handlers::delegation::process_commit_and_undelegate(program_id, accounts),

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
    }
}
