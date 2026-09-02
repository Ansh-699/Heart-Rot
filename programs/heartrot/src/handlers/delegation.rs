//! Delegation lifecycle: the three ER boundary crossings and the callback that
//! closes the loop.
//!
//! | Handler | Layer | Signer | Does |
//! |---|---|---|---|
//! | [`process_delegate`] | base | treasury (**and tx fee payer**) | hands `Arena`, `Boss`, `Players` to the ER |
//! | [`process_commit`] | ER | treasury | mirrors ER state back to base, keeps the delegation |
//! | [`process_commit_and_undelegate`] | ER | treasury | final commit, ends the session |
//! | [`process_undelegation`] | base | *the delegation program*, via CPI | re-creates the account under our ownership |
//!
//! Everything here is written against `ephemeral-rollups-pinocchio` 0.17.0 as it
//! actually ships, not against the local `magicblock` skill, which is a release
//! behind on several signatures (R22). Three things that differ from every tutorial:
//!
//! - `delegate_account` takes `&mut [AccountView]` — a *positional 7-slot slice* —
//!   plus the bump as a separate argument. It is not the Anchor `DelegateAccounts`
//!   struct, and there is no bump inside the seed slice.
//! - `commit_accounts` / `commit_and_undelegate_accounts` are **not** deprecated in
//!   the Pinocchio crate. The deprecation the skill quotes is on the Anchor SDK's
//!   `ephem::deprecated::v0` free functions. Here they are the first-class API and
//!   `MagicIntentBundleBuilder` is the strictly larger one.
//! - The undelegation callback arrives as an 8-byte discriminator followed by a
//!   borsh `Vec<Vec<u8>>` of seeds, and the SDK's parser rejects trailing bytes.
//!
//! **Account-ceiling note.** The ER refuses any transaction with
//! `program_id_index >= 38` and rejects address lookup tables outright, so ER
//! transactions live under a ~38 total-key ceiling (D3/D18). Nothing here is close:
//! `delegate` is 16 keys but runs on the **base layer**, where that rule does not
//! apply; the two ER-side handlers are 6 metas plus 2 program ids. No split needed.

use ephemeral_rollups_pinocchio::{
    consts::{
        DELEGATION_PROGRAM_ID, EXTERNAL_UNDELEGATE_DISCRIMINATOR, MAGIC_CONTEXT_ID,
        MAGIC_PROGRAM_ID,
    },
    instruction::{commit_accounts, commit_and_undelegate_accounts, delegate_account, undelegate},
    types::DelegateConfig,
};
use pinocchio::{address::address_eq, error::ProgramError, AccountView, Address, ProgramResult};

use crate::error::HeartrotError;
use crate::guards::{assert_owned_by, assert_pda, assert_signer, assert_writable};
use crate::state::{
    load, load_mut, Arena, Boss, Players, PHASE_LOBBY, PHASE_ROLLING, PHASE_SETTLED, SEED_ARENA,
    SEED_BOSS, SEED_PLAYERS,
};

/// `commit_frequency_ms` for every account we delegate.
///
/// `u32::MAX` means "never auto-commit", and it is a correctness setting rather
/// than a tuning knob. Commits 2..=10 of an account cost 100,000 lamports each and
/// commit 11 fails with `0xA0000000` *permanently*, until the account is undelegated
/// and re-delegated. An auto-commit clock would spend that budget within seconds of
/// a six-minute match and then wedge the settle path. HEARTROT commits exactly once,
/// at settle, so every account's quota stays at 1. Some TS builders default this
/// field to `0`; whether that means "never" or "as fast as possible" is unverified,
/// which is why it is always passed explicitly here.
const NEVER_AUTO_COMMIT: u32 = u32::MAX;

/// Number of accounts [`process_delegate`] expects, in the order documented on it.
pub const DELEGATE_ACCOUNT_COUNT: usize = 16;

/// Number of accounts the three ER-side / callback handlers expect.
pub const COMMIT_ACCOUNT_COUNT: usize = 6;
pub const UNDELEGATION_ACCOUNT_COUNT: usize = 4;

// ---------------------------------------------------------------------------
// Base layer: delegate
// ---------------------------------------------------------------------------

/// Delegate `Arena`, `Boss` and `Players` to the match's ER validator. Base layer.
///
/// All three go in one instruction because partial delegation is unrecoverable in
/// practice: an `Arena` on the ER with a `Boss` still on base makes every gameplay
/// transaction fail with `InvalidWritableAccount`, and the fix would be a manual
/// undelegate of whatever did land. One instruction makes it atomic.
///
/// Accounts, in order:
///
/// | # | Account | |
/// |---|---|---|
/// | 0 | `payer` | treasury, **writable signer, and the transaction fee payer** |
/// | 1 | `owner_program` | this program |
/// | 2 | `delegation_program` | `DELeGG…SaeSh` |
/// | 3 | `system_program` | |
/// | 4..8 | `arena`, its delegate buffer, delegation record, delegation metadata | |
/// | 8..12 | `boss` + the same three | |
/// | 12..16 | `players` + the same three | |
///
/// The delegate payer **must** be the transaction fee payer. The delegation program's
/// instruction marks `payer` writable, and it is debited for three sets of
/// record + metadata rent; a treasury that pays the fee while some other key is
/// passed here fails. The client must also raise the compute budget — three
/// delegations means ~12 CPIs and up to 1,924 bytes copied per account, which does
/// not fit the default 200,000 CU.
pub fn process_delegate(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, owner_program, delegation_program, system_program, arena, arena_buffer, arena_record, arena_metadata, boss, boss_buffer, boss_record, boss_metadata, players, players_buffer, players_record, players_metadata] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(payer)?;
    // Not defence in depth — see the fee-payer note above. Asserting it here turns a
    // confusing end-of-transaction "external account lamport spend" into a signature
    // error pointing at the account that is actually wrong.
    assert_writable(payer)?;

    if owner_program.address() != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if delegation_program.address() != &DELEGATION_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !address_eq(system_program.address(), &pinocchio_system::ID) {
        return Err(ProgramError::IncorrectProgramId);
    }

    assert_owned_by(arena, program_id)?;
    assert_owned_by(boss, program_id)?;
    assert_owned_by(players, program_id)?;
    assert_writable(arena)?;
    assert_writable(boss)?;
    assert_writable(players)?;

    // Read every field we need out of all three accounts *before* delegating any of
    // them. `delegate_account` copies the account into the buffer, zeroes the
    // original and reassigns its owner, so a second read of `Arena` after the first
    // delegation sees 1,160 zero bytes and fails the discriminator check.
    let (arena_id, validator, authority) = {
        let data = arena.try_borrow()?;
        let a = load::<Arena>(&data)?;
        // Delegation is a match-start step. Refusing anything but Lobby stops a
        // settled or in-flight arena being pushed back onto the ER, which would
        // resurrect a match whose leaderboard row is already written.
        //
        // `WrongPhase` rather than `InvalidAccountData`: the account is perfectly
        // well-formed and the discriminator matched, so the builtin would be a lie that
        // also collides with every genuine layout failure in this handler. The client
        // renders `Custom(6)` and can tell "this match already started" from "you handed
        // me the wrong account".
        if a.phase != PHASE_LOBBY {
            return Err(HeartrotError::WrongPhase.into());
        }
        (
            a.arena_id,
            Address::new_from_array(a.validator_identity),
            a.crank_authority,
        )
    };

    // The treasury recorded at init is the only key allowed to move these accounts
    // between layers. Delegation is otherwise a griefing primitive: a stranger could
    // delegate the arena to a validator they control, or to no validator at all, and
    // the match would never start.
    if payer.address().as_array() != &authority {
        return Err(ProgramError::IncorrectAuthority);
    }

    // Discriminator checks. `Boss` handed where `Players` belongs would otherwise be
    // delegated under the wrong seeds, which the PDA check below then catches — but it
    // catches it as `InvalidSeeds`, which says nothing about which account was swapped.
    {
        let data = boss.try_borrow()?;
        load::<Boss>(&data)?;
    }
    {
        let data = players.try_borrow()?;
        load::<Players>(&data)?;
    }

    // `Boss` and `Players` are seeded from the Arena *address*, not from `arena_id`,
    // so this one copy serves both derivations.
    let arena_key = *arena.address();
    let arena_id_le = arena_id.to_le_bytes();

    // The discriminator checks above already prove these three are not each other,
    // and the seeds below are what `delegate_account` signs with — a mismatched
    // account would fail the `Assign` CPI. Re-deriving anyway is ~1,500 CU each on a
    // base-layer transaction with room to spare, and it fails at validation time
    // instead of halfway through a state-destroying CPI sequence.
    //
    // The bump comes back from the derivation rather than from the account's own
    // `bump` field: `delegate_account` signs with it, and a stored bump is data the
    // caller could have influenced at init time, while this one is canonical by
    // construction.
    let arena_bump = assert_pda(arena, &[SEED_ARENA, &arena_id_le], program_id)?;
    let boss_bump = assert_pda(boss, &[SEED_BOSS, arena_key.as_ref()], program_id)?;
    let players_bump = assert_pda(players, &[SEED_PLAYERS, arena_key.as_ref()], program_id)?;

    // One validator for the whole match. A transaction whose writable accounts
    // resolve to two different ERs is unbuildable, not merely slow (D13), so the
    // identity recorded on `Arena` at init is the only one any of the three may go to.
    let config = DelegateConfig {
        commit_frequency_ms: NEVER_AUTO_COMMIT,
        validator: Some(validator),
    };

    delegate_one(
        payer,
        arena,
        owner_program,
        arena_buffer,
        arena_record,
        arena_metadata,
        system_program,
        &[SEED_ARENA, &arena_id_le],
        arena_bump,
        config.clone(),
    )?;
    delegate_one(
        payer,
        boss,
        owner_program,
        boss_buffer,
        boss_record,
        boss_metadata,
        system_program,
        &[SEED_BOSS, arena_key.as_ref()],
        boss_bump,
        config.clone(),
    )?;
    delegate_one(
        payer,
        players,
        owner_program,
        players_buffer,
        players_record,
        players_metadata,
        system_program,
        &[SEED_PLAYERS, arena_key.as_ref()],
        players_bump,
        config,
    )
}

/// `delegate_account` destructures a positional 7-slot slice; this is the only
/// place that ordering is written down, rather than three times inline.
#[allow(clippy::too_many_arguments)]
fn delegate_one(
    payer: &AccountView,
    pda: &AccountView,
    owner_program: &AccountView,
    buffer: &AccountView,
    record: &AccountView,
    metadata: &AccountView,
    system_program: &AccountView,
    seeds: &[&[u8]],
    bump: u8,
    config: DelegateConfig,
) -> ProgramResult {
    // `AccountView` is a handle over the runtime's account region, so these copies
    // alias the same memory and the same borrow flags — which is exactly what the
    // SDK's own `DelegateAccountCpiBuilder` does.
    let mut cpi_accounts = [
        *payer,
        *pda,
        *owner_program,
        *buffer,
        *record,
        *metadata,
        *system_program,
    ];
    delegate_account(&mut cpi_accounts, seeds, bump, config)
}

// ---------------------------------------------------------------------------
// ER: commit, and commit + undelegate
// ---------------------------------------------------------------------------

/// Mirror the three delegated accounts back to the base layer, keeping the
/// delegation. Runs on the ER.
///
/// Accounts: `[payer, magic_context, magic_program, arena, boss, players]`.
///
/// This is a mid-match snapshot — a crash-recovery point, not part of the settle
/// path. **It spends the commit quota**: each of the three accounts gets ten commits
/// before `0xA0000000` locks them out until re-delegation, and settle needs one of
/// them. Treat it as something an operator invokes, not something the game loop does.
pub fn process_commit(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, magic_context, magic_program, arena, boss, players] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let committee = check_commit_accounts(
        program_id,
        payer,
        magic_context,
        magic_program,
        arena,
        boss,
        players,
        false,
    )?;

    // `None` fee vault is load-bearing, not a default. The vault sits at account
    // index 2 of the Magic instruction, so passing one when the payer is undelegated
    // makes the Magic program read it as the first committee account. The treasury is
    // an ordinary wallet, so it takes the unsponsored path and is never debited.
    //
    // ponytail: no post-commit actions, so the leaderboard write is a separate
    // base-layer transaction the Worker sends after `GetCommitmentSignature`
    // confirms. Upgrade path when D12's crank-fired settlement is built:
    // `MagicIntentBundleBuilder` in `intent_bundle`, which needs a *delegated* PDA
    // fee payer and therefore a `magic_fee_vault` here.
    commit_accounts(payer, &committee, magic_context, magic_program, None, None)
}

/// Final commit, then hand all three accounts back to the base layer. Runs on the ER.
///
/// Accounts: `[payer, magic_context, magic_program, arena, boss, players]`.
///
/// Moves `phase` to `Settled` first, so the state that lands on the base layer says the
/// match is over — through [`Arena::try_set_phase`], so the legal `→ SETTLED` edges are
/// the one table in `state.rs`. One case is not that:
///
/// - `PHASE_LOBBY` **undelegates without a phase write**. This is the recovery path for an
///   arena that was delegated and never started — the only way its rent comes back — and
///   an arena that never fought must not land on base claiming it finished.
///
/// `PHASE_ROLLING` is **accepted**, and is the reason this handler is the operator's last
/// resort rather than a convenience. Tag 11 still refuses it; see [`apply_commit_phase`].
///
/// Tag 9 `settle` performs the same commit-and-undelegate on the happy path, and also
/// cancels the crank in the same instruction. This handler is what is left when `settle`
/// cannot run: it refuses `PHASE_LOBBY` outright, so a **delegated arena that was never
/// started can only come back through here**. That is the stranded case — two such arenas
/// sit on devnet holding ~0.06 SOL — and it is why this must have a client builder rather
/// than staying a dispatch entry nobody can reach.
///
/// The caller must **cancel the `boss_tick` crank before invoking this**. A crank
/// whose account list is frozen around these three keeps firing into accounts that
/// no longer live on the ER, burning its ten-retry ladder against
/// `InvalidWritableAccount`. Cancellation is the crank module's job, not this one's,
/// but the ordering is not optional.
pub fn process_commit_and_undelegate(
    program_id: &Address,
    accounts: &mut [AccountView],
) -> ProgramResult {
    let [payer, magic_context, magic_program, arena, boss, players] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let committee = check_commit_accounts(
        program_id,
        payer,
        magic_context,
        magic_program,
        arena,
        boss,
        players,
        true,
    )?;

    commit_and_undelegate_accounts(payer, &committee, magic_context, magic_program, None, None)
}

/// Shared validation for the two ER-side handlers, plus the `Settled` transition.
///
/// Returns the committee in the order the Magic program receives it. `Arena` is
/// first because it is the account the client watches for `phase`.
fn check_commit_accounts(
    program_id: &Address,
    payer: &AccountView,
    magic_context: &AccountView,
    magic_program: &AccountView,
    arena: &mut AccountView,
    boss: &AccountView,
    players: &AccountView,
    settle: bool,
) -> Result<[AccountView; 3], ProgramError> {
    // Signer, and deliberately **not** writable — the mirror of `settle`'s payer. The ER
    // rejects a writable non-delegated account with `InvalidWritableAccount`, and the
    // treasury is not delegated, so the meta the client builds must be `r s`. The
    // transaction's own fee payer is then some other key entirely (ER fees are 0 and the
    // ER runs no fee-payer validation), which is also what keeps the fee payer out of the
    // committee below — a fee payer inside the committee set is `IllegalOwner`.
    assert_signer(payer)?;

    if magic_context.address() != &MAGIC_CONTEXT_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if magic_program.address() != &MAGIC_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    // The Magic program appends the committee to this account; a read-only meta makes
    // the whole commit a no-op that still returns `Ok`. `settle` checks it for the same
    // reason and this path had been missing it.
    assert_writable(magic_context)?;

    // Inside the ER a delegated account still reports its original program as owner;
    // on the base layer it reports the delegation program. So this check is also what
    // confines both handlers to the ER — run either one against base-layer accounts
    // and it fails here rather than at some later, stranger place.
    assert_owned_by(arena, program_id)?;
    assert_owned_by(boss, program_id)?;
    assert_owned_by(players, program_id)?;
    assert_writable(arena)?;
    assert_writable(boss)?;
    assert_writable(players)?;

    // Discriminator checks: these three are positional, and `Boss` passed where
    // `Players` belongs would otherwise commit the wrong account and undelegate a
    // different one.
    {
        let data = boss.try_borrow()?;
        load::<Boss>(&data)?;
    }
    {
        let data = players.try_borrow()?;
        load::<Players>(&data)?;
    }

    // Same binding `settle::check_match_accounts` performs, and for the same reason:
    // owner plus discriminator only proves these are *a* boss and *a* roster, not
    // *this* arena's. `init_arena` takes `crank_authority` from its argument block, so
    // the treasury can legitimately mint an arena naming a stranger as authority — and
    // that stranger would otherwise pass the authority check below with their own arena
    // and then commit-and-undelegate a live match's `Boss` and `Players` out of the ER.
    // The seeds are the arena *address*, so a forged arena reaches only its own children.
    let arena_key = *arena.address();
    assert_pda(boss, &[SEED_BOSS, arena_key.as_ref()], program_id)?;
    assert_pda(players, &[SEED_PLAYERS, arena_key.as_ref()], program_id)?;

    {
        let mut data = arena.try_borrow_mut()?;
        let a = load_mut::<Arena>(&mut data)?;

        // ER transaction fees are zero and the ER runs no fee-payer validation, so
        // any keypair can send here for free. Without this check a stranger could
        // burn all ten commits on each account — after which settle itself fails and
        // the match can never leave the ER. The treasury check *is* the rate limit.
        if payer.address().as_array() != &a.crank_authority {
            return Err(ProgramError::IncorrectAuthority);
        }

        apply_commit_phase(a, settle)?;
    }

    Ok([*arena, *boss, *players])
}

/// The phase rule the two ER handlers share.
///
/// Split out because it is the only branching logic in this file and the only part of it
/// reachable without a runtime account — `AccountView` cannot be constructed in a unit
/// test, so a rule left inline in `check_commit_accounts` is a rule nothing can check.
fn apply_commit_phase(a: &mut Arena, settle: bool) -> Result<(), ProgramError> {
    // Tag 11 may not run while a VRF roll is in flight. A mid-roll snapshot buys nothing —
    // it is a crash-recovery point for a match that is already over — and it leaves the
    // oracle's callback aimed at an account whose committed copy is about to disagree with
    // the ER's. Tag 11 writes no phase at all, so without this line it has no transition to
    // be rejected by; this is its only gate.
    //
    // Tag 12 is deliberately **not** refused here, and that asymmetry is the whole point.
    // `ROLLING` has exactly two exits: the VRF callback, and `boss_tick`'s
    // `ROLL_TIMEOUT_TICKS` abandon. The second is measured against `Arena::tick`, which
    // only `boss_tick` advances — so a crank that dies inside the ~10 s roll window freezes
    // the clock its own timeout is read from, and the timeout can never elapse. Refusing
    // tag 12 here left that arena terminal: three accounts delegated to the ER with no
    // instruction in this program able to bring them back, and ~0.06 SOL of rent with them.
    // Undelegating under an in-flight request does cost the oracle retries, but they are
    // bounded by the request's 240-slot TTL, and `roll::consume_roll` returns `Ok` on every
    // rejection path, so a callback that lands on the settled arena is dropped rather than
    // reverting the oracle's transaction into a loop. Bounded beats permanent.
    //
    // The edge itself is `state.rs`'s to declare (`ROLLING -> SETTLED`), and `try_set_phase`
    // below is what performs it. Authority is already established: `check_commit_accounts`
    // rejects any payer that is not `arena.crank_authority` before this runs.
    if !settle && a.phase == PHASE_ROLLING {
        return Err(HeartrotError::WrongPhase.into());
    }

    if settle && a.phase != PHASE_LOBBY {
        // The legal `-> SETTLED` edges are `state.rs`'s table, not a second copy of it
        // here: `SETTLING` on the normal path, `FIGHTING` when the crank died mid-match,
        // `ROLLED` after a roll landed, and `SETTLED` on a retry. A retry is *accepted*
        // rather than refused — `GetCommitmentSignature` throws on every failure path, so
        // the operator route is retried by design, and a second commit-and-undelegate of
        // accounts already leaving the ER fails inside the Magic program, which is a
        // truthful failure rather than one this handler needs to pre-empt.
        //
        // `PHASE_LOBBY` is excluded rather than transitioned: an arena that was delegated
        // and never started has nothing to settle, and `LOBBY -> SETTLED` is illegal
        // precisely because a match that never ran must not be recorded as finished. It
        // still has to *undelegate* — that stranded case is the only way an arena holding
        // 0.0245 SOL of rent comes back — so it commits as-is and lands on the base layer
        // still in `Lobby`, re-delegatable and re-startable.
        a.try_set_phase(PHASE_SETTLED)?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Base layer: the undelegation callback
// ---------------------------------------------------------------------------

/// Re-create one account under our ownership after the ER releases it. Base layer.
///
/// The delegation program CPIs into us once per undelegated account, so this runs
/// three times per match — once for `Arena`, once for `Boss`, once for `Players`.
///
/// Instruction data is [`EXTERNAL_UNDELEGATE_DISCRIMINATOR`] followed by a borsh
/// `Vec<Vec<u8>>` of the account's PDA seeds (without the bump). Dispatch has to
/// route on the full 8 bytes: the first of them is `196`, which is not a tag any
/// hand-written instruction set would otherwise use, but matching only that byte
/// would let a caller reach this handler with a shorter payload.
///
/// Accounts: `[delegated_account, buffer, payer, system_program]`, fixed by the
/// delegation program.
///
/// There is deliberately no authority check. Authentication is structural and lives
/// inside the SDK's `undelegate`: `buffer` must be a signer, must be owned by the
/// delegation program, and must be the canonical `["undelegate-buffer", account]`
/// PDA — only the delegation program can produce that signature. The seeds then have
/// to re-derive `delegated_account` under our program id or the `CreateAccount` CPI
/// fails, so attacker-supplied seeds cannot conjure some other account.
///
/// # Lamports: why sp10 saw undelegation return more than went in, and why it stops
///
/// sp10 measured every account coming back holding **its balance plus its top-up a second
/// time** — Arena 9,772,056 = 8,964,480 + 807,576, Boss 1,350,486, Players 15,568,524. The
/// term that repeats is the sp9 rent shortfall: devnet's rent schedule is ~9% cheaper than
/// the default one the ER computes with, so `Rent::get()` funds less than `(128 + space) ×
/// 6960` and the ER refuses to clone the account.
///
/// The spike paid that shortfall by transferring **after** delegating. That is the whole
/// mechanism. The delegation record snapshots the balance at delegation time, so the
/// snapshot was the devnet minimum while the live base-layer account held the ER minimum,
/// and undelegation settled a delta that should have been zero. Every measured row is
/// `returned = balance + (balance − snapshot)`.
///
/// `init::er_clonable_rent` now funds `max(Rent::get(), (128 + space) × 6960)` at creation,
/// **before** tag 2 ever runs, so snapshot == balance, the delta is zero, and there is
/// nothing to accrete. Nothing in this handler had to change: the amount is
/// `Rent::get()?.try_minimum_balance(buffer.data_len())` computed inside the SDK's
/// `undelegate` and spent through an atomic `CreateAccount`, so there is no lever here
/// even if there were something to correct.
///
/// One thing the sp10 numbers cannot separate, because snapshot happened to equal the
/// devnet minimum in all three rows: whether the returned balance is `balance + delta` (in
/// which case a zero delta returns the full ER-clonable balance and re-delegation for
/// incarnation N+1 just works) or `devnet_minimum + 2 × delta` (in which case a zero delta
/// returns the *devnet* minimum and the arena is under-funded for its next delegation).
/// The two are algebraically identical on that data set. The measurement that separates
/// them is one cycle on an arena funded before delegation: read the base-layer balance
/// after undelegation and compare it against `(128 + 1200) × 6960 = 9,242,880`.
pub fn process_undelegation(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if data.len() < EXTERNAL_UNDELEGATE_DISCRIMINATOR.len()
        || data[..EXTERNAL_UNDELEGATE_DISCRIMINATOR.len()] != EXTERNAL_UNDELEGATE_DISCRIMINATOR
    {
        return Err(ProgramError::InvalidInstructionData);
    }
    let seed_args = &data[EXTERNAL_UNDELEGATE_DISCRIMINATOR.len()..];

    // `system_program` is unused here — the SDK's `undelegate` builds the
    // `CreateAccount` CPI without it — but the delegation program always passes it,
    // and an exact-length pattern is what keeps this positional list honest.
    let [delegated_account, buffer, payer, _system_program] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    undelegate(delegated_account, program_id, buffer, payer, seed_args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{PHASE_FIGHTING, PHASE_ROLLED, PHASE_SETTLING};
    use bytemuck::Zeroable;

    fn arena_in(phase: u8) -> Arena {
        let mut a = Arena::zeroed();
        a.phase = phase;
        a
    }

    /// Tag 12 is the only route back to the base layer for an arena that never started,
    /// and `LOBBY -> SETTLED` is not a legal edge — so the handler has to undelegate a
    /// lobby arena *without* writing a phase. Getting this wrong either strands the two
    /// devnet arenas permanently (refuse) or files a match that never ran as finished
    /// (transition).
    #[test]
    fn commit_and_undelegate_recovers_a_lobby_arena_without_settling_it() {
        let mut a = arena_in(PHASE_LOBBY);
        apply_commit_phase(&mut a, true).expect("a stranded lobby arena must be recoverable");
        assert_eq!(a.phase, PHASE_LOBBY, "a match that never ran is not settled");
    }

    /// Every other phase tag 12 accepts goes through `state.rs`'s table, including the
    /// retry: `GetCommitmentSignature` throws on every failure path, so an operator who
    /// cannot tell whether the first attempt landed must be able to send a second.
    #[test]
    fn commit_and_undelegate_settles_every_phase_that_fought() {
        for phase in [PHASE_FIGHTING, PHASE_SETTLING, PHASE_ROLLED, PHASE_SETTLED] {
            let mut a = arena_in(phase);
            apply_commit_phase(&mut a, true).expect("a fought match settles");
            assert_eq!(a.phase, PHASE_SETTLED);
        }
    }

    /// Tag 11 refuses `PHASE_ROLLING`. A mid-roll snapshot is worth nothing and costs the
    /// oracle a retry; tag 11 writes no phase, so this line is its only gate.
    #[test]
    fn a_snapshot_does_not_run_while_a_roll_is_in_flight() {
        let mut a = arena_in(PHASE_ROLLING);
        assert_eq!(
            apply_commit_phase(&mut a, false).unwrap_err(),
            HeartrotError::WrongPhase.into()
        );
        assert_eq!(a.phase, PHASE_ROLLING, "a refused call writes nothing");
    }

    /// The stranding scenario, end to end, and the highest-consequence path in this file.
    ///
    /// A won raid rolls; the crank dies inside the roll window. `Arena::tick` is advanced by
    /// nothing but `boss_tick`, so the clock `abandon_roll` measures its own timeout against
    /// is frozen — the arena cannot time out however long an operator waits. Tag 12 is then
    /// the only exit, and it must take it.
    #[test]
    fn a_dead_crank_in_rolling_is_still_recoverable() {
        let mut a = arena_in(PHASE_FIGHTING);
        assert!(a.end_fight(crate::state::OUTCOME_WIN));
        a.begin_roll().expect("a won match rolls");
        assert_eq!(a.phase, PHASE_ROLLING);

        // The crank is gone. Nothing advances `tick`, so the timeout never elapses — wait
        // as many wall-clock roll windows as you like and `abandon_roll` still writes
        // nothing. This is what makes tag 12 the last resort rather than a shortcut.
        for _ in 0..(crate::state::ROLL_TIMEOUT_TICKS * 10) {
            assert!(!a.abandon_roll(), "a frozen clock never times the roll out");
        }
        assert_eq!(a.phase, PHASE_ROLLING);

        apply_commit_phase(&mut a, true).expect("tag 12 is the only way these accounts come back");
        assert_eq!(a.phase, PHASE_SETTLED);
        assert_eq!(
            a.next_affix_seed, [0u8; 32],
            "no seed was invented, so `next_incarnation` still refuses loudly"
        );
    }

    /// Tag 11 is a snapshot, not an ending: it must leave the phase exactly as it found it
    /// in every phase it accepts, or a mid-match operator snapshot would end the match.
    #[test]
    fn commit_never_writes_a_phase() {
        for phase in [
            PHASE_LOBBY,
            PHASE_FIGHTING,
            PHASE_SETTLING,
            PHASE_ROLLED,
            PHASE_SETTLED,
        ] {
            let mut a = arena_in(phase);
            apply_commit_phase(&mut a, false).expect("a snapshot is legal outside ROLLING");
            assert_eq!(a.phase, phase);
        }
    }

    /// The only hand-rolled parsing in this file is the discriminator split, and it
    /// is reachable by anyone who can send a transaction — the callback has no
    /// authority check by design. This pins both halves: a payload that is not the
    /// delegation program's is rejected before any account is touched, and a payload
    /// that *is* gets past the check with the seed blob starting at byte 8.
    #[test]
    fn undelegation_callback_gates_on_the_full_discriminator() {
        let program_id = Address::new_from_array([7u8; 32]);
        let empty: &mut [AccountView] = &mut [];

        assert!(matches!(
            process_undelegation(&program_id, empty, &[]),
            Err(ProgramError::InvalidInstructionData)
        ));
        // Right length, wrong bytes — a one-byte tag match would let this through.
        assert!(matches!(
            process_undelegation(&program_id, empty, &[EXTERNAL_UNDELEGATE_DISCRIMINATOR[0]; 8]),
            Err(ProgramError::InvalidInstructionData)
        ));
        // Correct prefix: reaches the account list, which is empty here.
        assert!(matches!(
            process_undelegation(&program_id, empty, &EXTERNAL_UNDELEGATE_DISCRIMINATOR),
            Err(ProgramError::NotEnoughAccountKeys)
        ));
    }
}
