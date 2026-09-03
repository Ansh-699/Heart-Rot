//! The match lifecycle outside combat: arm the crank, end the match, record the result.
//!
//! Three instructions, and they are the whole module: `start_match` (tag 3, ER) flips the
//! arena to `Fighting` and schedules `boss_tick` for the rest of the match, `settle`
//! (tag 9, ER) cancels that crank and commits the three delegated accounts home, and
//! `write_leaderboard` (tag 10, base layer) appends the result to the ring.
//!
//! The VRF round trip that picks the *next* incarnation's ruleset is deliberately not
//! here: `handlers::roll` owns tags 13 and 14, and `handlers::init` owns tag 15. What this
//! module owes them is the two orderings below — `settle` must refuse to commit a `Rolling`
//! arena, and `write_leaderboard` must have run before tag 15 zeroes the roster.
//!
//! The phase byte is never assigned here. Every transition goes through
//! `state::Arena`'s methods, which check it against `state::PHASE_EDGES` — the one place
//! the game loop's control flow is written down, shared with the four other files that
//! move `phase`. That is what makes the refusal above structural rather than a rule this
//! file has to remember.
//!
//! Four validator behaviours drive nearly every decision below. All four were read from
//! `magicblock-core` 0.14.11 at commit `cec4cf5`, which is what devnet runs today
//! (`docs/research/er-cranks.md`):
//!
//! 1. **`task_id` is a validator-global namespace and a collision fails *silently*
//!    after the scheduling CPI returns `Ok`.** The failure is recorded only to a table
//!    inside the validator that no RPC exposes. So the id must be wide and random, it
//!    lives on `Arena.crank_task_id` where `settle` can find it again, and it is an `i64`
//!    — the published docs say `u64` and are wrong. Because that namespace is shared with
//!    everyone, the id must also be *unguessable*: an id anyone can precompute can be
//!    squatted before the match starts and the match then never ticks, with no error
//!    anywhere. [`mint_task_id`] is where that is dealt with.
//! 2. **A crank instruction may carry no writable signer**, only the read-only
//!    `crank_signer` PDA, and **a crank cannot re-arm itself** — `ScheduleTask` needs a
//!    writable signer. Every iteration of the match is therefore scheduled up front.
//! 3. **A crank's account list is frozen at schedule time and replayed verbatim
//!    forever**, and the crank transaction goes through the same ~38-key validation as
//!    everything else. `boss_tick`'s list is `[Arena, Boss, Players, crank_signer]` —
//!    four metas plus two program ids, six keys against the ceiling.
//! 4. **A failing crank retries ten times over ~26 s and is then deleted permanently.**
//!    Undelegating while a task is still armed therefore does not merely orphan it, it
//!    burns the ladder and leaves an unrecoverable row. That is why the cancel lives
//!    *inside* [`settle`], immediately before the commit, rather than in an instruction
//!    of its own: a second ER round trip is a window in which the two can be reordered,
//!    and the ordering is not optional.

use ephemeral_rollups_pinocchio::{
    consts::{MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID},
    crank::{CancelCrankCpi, CrankInstruction, ScheduleCrankArgs, ScheduleCrankCpi},
    instruction::commit_and_undelegate_accounts,
};
use pinocchio::{
    error::ProgramError, instruction::InstructionAccount, sysvars::slot_hashes, AccountView,
    Address, ProgramResult,
};

use crate::error::HeartrotError;
use crate::guards::{
    assert_any_raider, assert_owned_by, assert_pda, assert_signer, assert_writable,
};
// The single deploy-time treasury key, declared once in `handlers::init`. It is imported
// rather than re-declared here on purpose: a second copy is a second thing to fill in at
// deploy time, and forgetting one half bricks either arena creation or result recording
// with nothing failing to compile.
use crate::handlers::init::TREASURY;
use crate::state::{
    load, load_mut, Arena, Leaderboard, LeaderboardEntry, Players, ENRAGE_TICKS, LEADERBOARD_CAP,
    MUSTER_TICKS, OUTCOME_UNDECIDED, PHASE_MUSTERING, PHASE_SETTLED, ROLL_TIMEOUT_TICKS, SEED_BOSS,
    SEED_LEADERBOARD, SEED_PLAYERS,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// `Crank11111111111111111111111111111111111111`, the ER's native crank builtin.
///
/// Written as raw bytes rather than base58: the crank program id is not exported by
/// `ephemeral-rollups-pinocchio`, and `pinocchio-pubkey` cannot be added because its
/// latest release pins `pinocchio ^0.9` and would drag a second, semver-incompatible
/// pinocchio into the tree. Round-tripped against base58 when it was written.
pub const CRANK_PROGRAM_ID: Address = Address::new_from_array([
    3, 9, 115, 187, 171, 86, 176, 95, 66, 206, 3, 79, 119, 118, 67, 48, 79, 137, 61, 97, 116, 104,
    235, 217, 161, 243, 44, 64, 0, 0, 0, 0,
]);

/// Seed of the PDA the ER signs crank instructions with:
/// `find_program_address([CRANK_SIGNER_SEED, task_authority], CRANK_PROGRAM_ID)`.
pub const CRANK_SIGNER_SEED: &[u8] = b"crank-executor";

/// The dispatch byte this module *emits*: `start_match` freezes it into the crank row and
/// the validator replays it at us every 400 ms, so `lib.rs` must keep routing it to
/// `tick::process` or the whole match goes inert with nothing to look at.
pub const IX_BOSS_TICK: u8 = 8;

/// Target gap between ticks. A floor, not a guarantee — the scheduler re-queues at
/// `last_execution + interval`, so ticks drift under load rather than catching up.
/// Nothing in the game may read wall-clock time; `Arena.tick` is the only clock.
const TICK_INTERVAL_MS: i64 = crate::state::TICK_MS as i64;

/// Ticks the crank is armed for: the whole muster plus the whole fight, at 1.25×.
///
/// **Derived, never a literal.** A match now spans [`MUSTER_TICKS`] before anyone can
/// shoot and [`ENRAGE_TICKS`] after, and the crank **cannot be topped up** — `ScheduleTask`
/// needs a writable signer and a scheduled instruction carries none. The old literal
/// `4_500` came with a comment claiming "900 ticks = 6 minutes, so 5× headroom"; both
/// halves predate `TICK_MS` 400 → 100, the real budget is 3,800 ticks, and 4,500 was 1.18×.
/// Getting this wrong is a raid that goes inert mid-fight with nothing failing anywhere.
const TICK_ITERATIONS: i64 = (MUSTER_TICKS as i64 + ENRAGE_TICKS as i64) * 5 / 4;

/// The budget, stated as a relation rather than as the number it currently comes to.
/// A match runs [`MUSTER_TICKS`] + [`ENRAGE_TICKS`] at the outside, and the settle that
/// follows may sit through a whole [`ROLL_TIMEOUT_TICKS`] before the task is cancelled;
/// the crank has to outlive all three. An `== 4_750` here would be the same fact stored
/// twice and would pass unchanged the day one of the durations moves.
const _: () = assert!(
    TICK_ITERATIONS >= (MUSTER_TICKS + ENRAGE_TICKS + ROLL_TIMEOUT_TICKS) as i64,
    "TICK_ITERATIONS must outlive muster + enrage + the roll timeout; a crank cannot be topped up"
);

/// `ScheduleTask` payload: 4 discriminant + 32 args header + one `CrankInstruction`
/// (32 program id + 8 count + 4×34 metas + 8 len + 1 data) = 221 bytes. Rounded up.
/// The SDK bounds-checks against `serialized_size()` and errors rather than truncating,
/// so an under-sized buffer surfaces as `InvalidInstructionData`, not corruption.
const SCHEDULE_BUF_LEN: usize = 256;

/// Hash domain for [`mint_task_id`]. Distinct from `init_arena`'s `b"crank"` domain so
/// the two derivations over the same arena can never land on the same id.
const DOMAIN_TASK: &[u8] = b"crank-task";

/// `[Arena, Boss, Players]` plus the payer the SDK prepends. This constant is passed as
/// `ScheduleCrankCpi::invoke`'s const parameter, which must equal `1 + instruction
/// accounts` exactly — the SDK `copy_from_slice`s into a fixed array of this size.
const SCHEDULE_CPI_ACCOUNTS: usize = 4;

// ---------------------------------------------------------------------------
// begin_muster — open the muster window and arm the boss loop
// ---------------------------------------------------------------------------

/// Open a fixed-length muster and arm `boss_tick` for the whole match. Sent to the
/// **ER**, after every account is delegated — `Magic11111…` is a runtime builtin, not a
/// deployed program, so a base-layer CPI to it cannot resolve.
///
/// The phase transition and the scheduling are one instruction on purpose, and now the
/// crank is what *ends* the muster: [`Arena::begin_fight`] flips `MUSTERING → FIGHTING`
/// at [`Arena::fight_at_tick`], so no player, host or Worker has to act and a raid can
/// never fail to start. An arena left in `Lobby` with a live crank would tick to no
/// effect; a `Mustering` arena with no crank would never reach the fight. Neither half is
/// useful without the other.
///
/// It refuses over an empty pit ([`assert_any_raider`], `NoRaiders`): the first knight
/// through the gate is what opens the window, and a muster armed with nobody in
/// `ZONE_ARENA` spawns no volley and burns the whole enrage budget on an empty room.
/// Nineteen of twenty clients race this and get the phase refusal instead; the twentieth
/// may legitimately get `NoRaiders` if its own `enter_gate` has not landed yet. Both are
/// the design, and the Worker treats them alike.
///
/// Accounts (unchanged — tag 3 keeps its ABI):
/// 0. `payer` — treasury, writable signer. Becomes the task authority, and therefore
///    the only key that can ever cancel this task, so it must be the same key
///    `Arena.crank_authority` names.
/// 1. `arena` — writable, frozen into the crank row
/// 2. `boss` — writable, frozen into the crank row
/// 3. `players` — writable, frozen into the crank row, and now *read* for the raider check
/// 4. `magic_program`
pub fn begin_muster(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, arena, boss, players, magic_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(payer)?;
    assert_writable(payer)?;
    if magic_program.address() != &MAGIC_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    check_match_accounts(program_id, arena, boss, players)?;
    assert_writable(arena)?;
    assert_writable(boss)?;
    assert_writable(players)?;

    // The pit must not be empty. Borrowed and dropped before the arena borrow below, so
    // the two never overlap, and before `schedule_entropy` so a refusal costs no syscall.
    {
        let roster_data = players.try_borrow()?;
        assert_any_raider(load::<Players>(&roster_data)?)?;
    }

    // Read outside the borrow purely for readability; a failure here reverts the whole
    // instruction, so ordering against the state write carries no risk either way.
    let entropy = schedule_entropy()?;
    let arena_key = *arena.address();

    // One borrow that validates, transitions, mints the id, and copies out the two fields
    // the CPI needs. The borrow must be dropped before the CPI: it re-enters the runtime
    // with these same accounts, and a live `Ref` would make that a borrow failure.
    let (task_id, crank_authority) = {
        let mut data = arena.try_borrow_mut()?;
        let state = load_mut::<Arena>(&mut data)?;

        // The scheduling payer *is* the task authority the ER records, and `boss_tick`
        // authorizes its caller against `crank_signer_pda(arena.crank_authority)`. If
        // those two keys disagree the task schedules fine and then fails every tick.
        if payer.address().as_ref() != state.crank_authority.as_slice() {
            return Err(HeartrotError::NotArenaAuthority.into());
        }

        // The id the task is actually registered under is minted *here*, one instruction
        // before the CPI that registers it, and written back over the creation-time value
        // so `settle` cancels the same id that was scheduled. `init_arena`'s value is kept
        // only as one more input to the mix; it is public, so it carries no secrecy of its
        // own and a zero there is harmless rather than a thing to reject.
        let task_id = mint_task_id(program_id, &arena_key, state.crank_task_id, &entropy);

        // Only a lobby arena musters, and `LOBBY → MUSTERING` is the single edge that says
        // so — `MUSTERING → MUSTERING` is absent from `PHASE_EDGES` precisely because a
        // second `begin_muster` would schedule a *second* crank against the same accounts,
        // doubling the tick rate with no way to tell the two apart, and would leave the
        // id minted above over the first, stranding the original task where `settle` can
        // no longer cancel it. That refusal is also what makes the client's fire-and-forget
        // auto-start safe: nineteen of twenty raiders get it and nothing is armed twice.
        // Last, so a rejected transition writes no id.
        state.try_set_phase(PHASE_MUSTERING)?;
        // The deadline twenty browsers agree on without talking to each other. `begin_fight`
        // (from the crank, in `tick::heartbeat`) is what consumes it and stamps
        // `enrage_at_tick`; nothing here writes the enrage clock, or the muster would come
        // out of the fight's own budget.
        state.fight_at_tick = state.tick.saturating_add(MUSTER_TICKS);
        state.crank_task_id = task_id;
        (task_id, state.crank_authority)
    };

    let crank_authority = Address::new_from_array(crank_authority);
    let (crank_signer, _) = Address::find_program_address(
        &[CRANK_SIGNER_SEED, crank_authority.as_ref()],
        &CRANK_PROGRAM_ID,
    );

    // Frozen for the life of the task. The crank signer is a *read-only* signer: the
    // validator rejects it outright if it is writable, and rejects any other signer.
    let tick_metas = [
        InstructionAccount::writable(arena.address()),
        InstructionAccount::writable(boss.address()),
        InstructionAccount::writable(players.address()),
        InstructionAccount::readonly_signer(&crank_signer),
    ];
    let tick_data = [IX_BOSS_TICK];
    let tick_ix = [CrankInstruction::new(*program_id, &tick_metas, &tick_data)];

    let instruction_accounts = [*arena, *boss, *players];
    let cpi = ScheduleCrankCpi::new(
        *payer,
        *magic_program,
        &instruction_accounts,
        ScheduleCrankArgs::new(task_id, &tick_ix)
            .execution_interval_millis(TICK_INTERVAL_MS)
            .iterations(TICK_ITERATIONS),
    );

    let mut buf = [0u8; SCHEDULE_BUF_LEN];
    cpi.invoke::<SCHEDULE_CPI_ACCOUNTS>(&mut buf)
}

/// 32 bytes of chain state that **did not exist when the arena was created**.
///
/// This is the whole anti-squat argument, so it is worth being precise about. Every other
/// input to a task id is public and stable: `program_id` is fixed, `arena_id` is
/// `Leaderboard.last_arena_id + 1`, and the arena PDA is `[b"arena", arena_id]` — a pure
/// function of that id. Anyone can compute all three for the next dozen matches and squat
/// their ids at leisure, which is exactly the hole this closes.
///
/// The only source is the most recent **SlotHashes** entry: the ER's own block hash for
/// the previous slot. A block hash is not a function of anything an outsider holds — it
/// does not exist until the validator produces that block, so it cannot be precomputed at
/// any lead time at all, and by the time it is readable the very next instruction (the
/// `ScheduleTask` CPI below) has already claimed the id derived from it. It is read
/// through `sol_get_sysvar`, which needs no account: the frozen tag-3 account list has no
/// room for one, and the ~38-key ceiling has no room to spare either.
///
/// That syscall is also why there is no address or owner check to write here, and why the
/// absence of one is not the usual pinocchio-validates-nothing hole. `fetch_into` addresses
/// the sysvar by `slot_hashes::SLOTHASHES_ID`, a constant compiled into the SDK
/// (`SysvarS1otHashes111111111111111111111111111`, verified by round-trip), and the runtime
/// resolves it from its own sysvar cache. No account reaches this function, so there is
/// nothing a caller can substitute: the guard an account-based read would need is replaced
/// by there being no account. A sysvar the runtime does not hold returns `SYSVAR_NOT_FOUND`
/// → `UnsupportedSysvar` rather than any attacker-shaped data.
///
/// There is deliberately **no fallback**. The obvious one is the `Clock`, and it is not
/// entropy at all against this attacker: slot, timestamp and the two epochs are public and
/// enumerable, so an outsider can grind candidate tuples across the window between
/// `init_arena` and `start_match` and pre-squat one id per candidate — free, because ER
/// fees are zero — which is precisely the hole this function exists to close. A weaker id
/// does not degrade gracefully: a squatted id makes `ScheduleTask` return `Ok` and the
/// match then never ticks, with the failure recorded only in a validator-local table and
/// no crank re-arm possible. A `start_match` that refuses is recoverable and visible; a
/// match scheduled under a guessable id is neither.
///
/// So a missing sysvar (`UnsupportedSysvar`), a rejected read (`InvalidArgument`), an empty
/// sysvar or an all-zero hash all fail loudly and `start_match` reverts. If that ever fires
/// on the target ER, the fix is to give the validator a SlotHashes sysvar, not to soften
/// this. The two distinct errors are kept apart on purpose: the first time this fires on
/// devnet, "the ER has no SlotHashes at all" and "the read was malformed" want different
/// fixes and there is no other signal to tell them apart.
fn schedule_entropy() -> Result<[u8; 32], ProgramError> {
    // `[count: u64 | slot: u64 | hash: [u8; 32]]` — the header plus the most recent entry,
    // which is the only one wanted. The header is read rather than skipped so an *empty*
    // sysvar is a declared fact rather than something inferred from the bytes: reading from
    // offset 8 makes `fetch_into` return the buffer's capacity instead of the real count,
    // and then a validator that hands back a populated-looking zero region is
    // indistinguishable from one that has entries.
    //
    // Both checks below are load-bearing rather than paranoia. Off-chain — every host build
    // and every `cargo test` — `get_sysvar_unchecked` returns `Ok` without writing a byte,
    // so a buffer that did not start zeroed would mint an id from uninitialised stack.
    let mut head = [0u8; 48];
    let entries = slot_hashes::raw::fetch_into(&mut head, 0)?;
    if entries == 0 || head[16..].iter().all(|b| *b == 0) {
        return Err(ProgramError::UnsupportedSysvar);
    }

    let mut out = [0u8; 32];
    out.copy_from_slice(&head[16..]);
    Ok(out)
}

/// Mix the arena's identity with [`schedule_entropy`] into a wide, positive `i64`.
///
/// Pure and total: no syscall, no failure path, and the arena key binds the id to *this*
/// match so two arenas that somehow read the same entropy still get different ids.
/// `derive_address` is PDA derivation used as a hash, for the reason `init_arena` gives —
/// SHA-256 is not otherwise reachable from pinocchio 0.11 on both targets.
///
/// Nothing outside this program ever reproduces this derivation: the minted id is written
/// to `Arena.crank_task_id` and read back from there by `settle`. It is one fact in one
/// place, so the client needs no copy of the formula and there is nothing to drift.
fn mint_task_id(program_id: &Address, arena_key: &Address, base: i64, entropy: &[u8; 32]) -> i64 {
    let hash = Address::derive_address(
        &[
            DOMAIN_TASK,
            arena_key.as_ref(),
            &entropy[..],
            &base.to_le_bytes()[..],
        ],
        None,
        program_id,
    )
    .to_bytes();

    let mut head = [0u8; 8];
    head.copy_from_slice(&hash[..8]);
    // Sign bit cleared and floored at 1: the crank arguments are `i64`, a negative id is
    // rejected, and 0 is both unusable and the most collision-prone value on the cluster.
    (i64::from_le_bytes(head) & i64::MAX).max(1)
}

// ---------------------------------------------------------------------------
// settle — disarm, commit, undelegate
// ---------------------------------------------------------------------------

/// End the match: stamp `PHASE_SETTLED`, cancel the crank, then commit and undelegate the
/// three delegated accounts in one intent. Sent to the **ER**.
///
/// The cancel is not a separate instruction. A task still armed when its accounts leave
/// the ER fires into accounts it can no longer write, burns its ten retries against
/// `InvalidWritableAccount` and lands in `failed_tasks` with no way to resume — so the
/// only safe ordering is cancel-then-commit, and putting the two in one instruction is
/// what makes that ordering structural instead of a rule the caller has to remember.
///
/// Magic Actions are deliberately not used to chain the leaderboard write. A failing
/// `BaseAction` can be *removed* from the transaction strategy and the commit retried
/// without it, so "the commit landed" is not proof the action ran. Once the leaderboard
/// write has to be idempotent and independently reconciled anyway, the action buys a
/// saved round trip in exchange for a delegated fee-payer PDA, a `magic_fee_vault`, a
/// delegation record, a lamports top-up path, an undocumented `is_signer` workaround and
/// an `IllegalOwner` trap. Two transactions instead.
///
/// Accounts:
/// 0. `payer` — treasury signer; must equal `Arena.crank_authority`, which is also the
///    task authority, because the scheduler only accepts a cancel from that key
/// 1. `arena` — writable, committed; also stands in as the cancel's `task_context`
/// 2. `boss` — writable, committed
/// 3. `players` — writable, committed
/// 4. `magic_context` — writable
/// 5. `magic_program`
pub fn settle(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, arena, boss, players, magic_context, magic_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(payer)?;
    if magic_program.address() != &MAGIC_PROGRAM_ID || magic_context.address() != &MAGIC_CONTEXT_ID
    {
        return Err(ProgramError::IncorrectProgramId);
    }
    assert_writable(magic_context)?;
    check_match_accounts(program_id, arena, boss, players)?;
    assert_writable(arena)?;
    assert_writable(boss)?;
    assert_writable(players)?;

    let task_id = {
        let mut arena_data = arena.try_borrow_mut()?;
        let state = load_mut::<Arena>(&mut arena_data)?;
        if payer.address().as_ref() != state.crank_authority.as_slice() {
            return Err(HeartrotError::NotArenaAuthority.into());
        }
        // Which phases may settle is `PHASE_EDGES`'s to say, not this handler's, and
        // routing through `try_set_phase` is what buys the second refusal this
        // instruction needs. One absence does the work:
        //
        // - `LOBBY → SETTLED`: an arena never fought was never delegated with players in
        //   it and has nothing to record.
        //
        // `ROLLING → SETTLED` used to be a second absence, on the commit-during-fulfilment
        // hazard, and the advice was to wait `ROLL_TIMEOUT_TICKS` for `boss_tick` to
        // abandon the roll back to `SETTLING`. That advice was wrong in the case it
        // mattered: `abandon_roll`'s timeout is measured against `arena.tick`, and `tick`
        // is advanced only by `boss_tick`, so a crank that died inside the roll window
        // froze the clock its own timeout is read off and the wait never ended. The edge
        // is legal now (see `PHASE_EDGES`), which makes this handler accept it too — the
        // same `crank_authority` gate above, and a bounded hazard on the other side: the
        // oracle retries for the request's 240-slot TTL and `consume_roll` returns `Ok` on
        // every rejection path, so a callback landing on a `SETTLED` arena is dropped
        // rather than looped. Tag 12 is still the better of the two recovery routes,
        // because it also cancels the crank.
        //
        // `FIGHTING → SETTLED` stays legal on purpose: it is the dead-crank recovery
        // path, the only way a match whose task died can ever end. That is also why
        // `MatchNotOver` is *not* raised here — "the match is still running" is not a fact
        // this program can establish, since a stalled crank and a healthy one look
        // identical on chain. The Worker samples `tick` twice to tell them apart.
        //
        // `outcome` is deliberately left alone. A `FIGHTING` arena settled by this path
        // keeps `OUTCOME_UNDECIDED`, which is the honest record: the fight was cut short
        // by an operator, not won, wiped or timed out. Writing a result here would be
        // inventing one.
        state.try_set_phase(PHASE_SETTLED)?;
        state.crank_task_id
    };

    // The scheduler compares the cancel authority against the stored task authority and a
    // mismatch is a **silent no-op**, not an error — the CPI returns `Ok` and the crank
    // keeps ticking. The `crank_authority` check above is the only thing that turns that
    // into a failure anyone can see. A retried settle cancels an id the scheduler has
    // already forgotten, which is the same silent no-op and equally harmless.
    //
    // `task_context` is dead weight — the deployed `process_cancel_task` reads only
    // account 0 — but the SDK still emits a writable meta for it. Passing the arena costs
    // nothing: it is already delegated, already writable, and already here.
    CancelCrankCpi {
        authority: *payer,
        task_context: *arena,
        magic_program: *magic_program,
        crank_id: task_id,
    }
    .invoke()?;

    // ponytail: no `magic_fee_vault`. `try_get_fee_vault` returns `Some` only for a
    // *delegated* payer, and the treasury is not delegated — but the ER also rejects
    // writable non-delegated accounts, so this works only while the treasury signs
    // read-only (a throwaway keypair can be the transaction fee payer; ER fees are 0
    // and the ER runs no fee-payer validation). `assert_writable` is deliberately not
    // applied to `payer` for that reason, and `CancelCrankCpi` above already emits a
    // read-only signer meta when the authority is read-only. If that shape is rejected on
    // devnet, the fix is a delegated settlement PDA plus its `magic_fee_vault` as a
    // seventh account.
    let committee = [*arena, *boss, *players];
    commit_and_undelegate_accounts(payer, &committee, magic_context, magic_program, None, None)
}

// ---------------------------------------------------------------------------
// write_leaderboard — base layer, idempotent
// ---------------------------------------------------------------------------

/// Record the match on the base layer, after the ER commit has confirmed.
///
/// Idempotency is required, not a nicety. `GetCommitmentSignature` *throws* on every
/// failure path, and a throw means "unknown, retry" — never "failed" — so the settle
/// route is retried by design and this instruction can legitimately run twice for one
/// match. Without the `(arena_id, incarnation)` guard a retry duplicates twenty rows.
///
/// Accounts:
/// 0. `payer` — the treasury, signer. Checked against [`TREASURY`], not against the
///    arena's own `crank_authority`: the ring is a singleton and the arena is not.
/// 1. `leaderboard` — writable, `[b"leaderboard"]`, never delegated
/// 2. `arena` — read; undelegated and owned by us again by now
/// 3. `players` — read
pub fn write_leaderboard(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [payer, leaderboard, arena, players, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(payer)?;
    // The program-wide gate, and the only one that matters here. Everything below merely
    // proves the *rows* are well formed; this is what proves the writer is allowed to add
    // rows at all. `Arena.crank_authority` alone cannot do it: `init_arena` is
    // treasury-gated, but it takes `crank_authority` from the tag-1 argument block rather
    // than from the payer, so an arena can legitimately name an authority that is not the
    // treasury — and the ring is a program-wide singleton that such an authority must not
    // be able to fill with twenty rows of its choosing. The frozen layout has no spare
    // bytes to hold an admin key on the account itself, so the gate is this constant.
    if payer.address() != &TREASURY {
        return Err(HeartrotError::NotTreasury.into());
    }

    assert_owned_by(leaderboard, program_id)?;
    assert_writable(leaderboard)?;
    assert_pda(leaderboard, &[SEED_LEADERBOARD], program_id)?;

    let arena_key = *arena.address();
    assert_owned_by(arena, program_id)?;
    assert_owned_by(players, program_id)?;
    assert_pda(players, &[SEED_PLAYERS, arena_key.as_ref()], program_id)?;

    let arena_data = arena.try_borrow()?;
    let arena_state = load::<Arena>(&arena_data)?;
    // Kept alongside the treasury check rather than replaced by it: it is what stops the
    // treasury recording a match some other authority ran.
    if payer.address().as_ref() != arena_state.crank_authority.as_slice() {
        return Err(HeartrotError::NotArenaAuthority.into());
    }
    // Only a settled match has a result. A mid-flight arena would record damage totals
    // that are still moving. `MatchNotOver` rather than `WrongPhase` because this is the
    // one place the condition is decidable: `PHASE_SETTLED` is written by `settle` itself,
    // so anything else here means the settlement has not happened yet.
    if arena_state.phase != PHASE_SETTLED {
        return Err(HeartrotError::MatchNotOver.into());
    }
    // `MUSTERING → SETTLED` (the dead-crank recovery edge) settles an arena that never
    // fought, so `PHASE_SETTLED` no longer implies a result. A row whose outcome is
    // `OUTCOME_UNDECIDED` says nothing and is indistinguishable from an unwritten row's
    // zero, so it must not reach the ring at all.
    if arena_state.outcome == OUTCOME_UNDECIDED {
        // ABANDONED, not unfinished: `PHASE_SETTLED` says the settlement happened, and an
        // undecided outcome on a settled arena means the fight was cut short — the last
        // player pressed Exit, or the crank died in the muster. No row is written (the
        // outcome byte would be 0, which is what an unwritten row reads), but the head
        // still moves. Without this the Worker's arena scan, which starts at
        // `last_arena_id`, started at the same dead id forever: on devnet the head sat at
        // 1788266869 while fourteen abandoned raids piled up after it and the only warm
        // room was seventeen ids past it, every join re-walking the gap and each new
        // abandon adding a step, until the scan window would have filled and no join
        // could succeed at all. Refusing here with `MatchNotOver`, as this used to, was
        // what made that unfixable from the Worker.
        let mut lb_data = leaderboard.try_borrow_mut()?;
        let board = load_mut::<Leaderboard>(&mut lb_data)?;
        mark_abandoned(board, arena_state.arena_id, arena_state.incarnation);
        return Ok(());
    }

    let players_data = players.try_borrow()?;
    let roster = load::<Players>(&players_data)?;
    let mut lb_data = leaderboard.try_borrow_mut()?;
    let board = load_mut::<Leaderboard>(&mut lb_data)?;

    append_results(
        board,
        roster,
        arena_state.arena_id,
        arena_state.incarnation,
        arena_state.outcome,
    );
    Ok(())
}

/// Append one row per occupied seat to the ring, unless this exact match was the last
/// thing written. Returns whether anything was written, which is what the test asserts.
///
/// Split out from [`write_leaderboard`] only so the ring arithmetic and the idempotency
/// guard can be exercised without a runtime: an off-by-one in the cursor silently
/// overwrites live history, which is not a defect a devnet run would surface.
///
/// `outcome` is the *match's* result (`Arena.outcome`) and `survived` is the *seat's*.
/// Both are stored because neither implies the other: an enrage leaves survivors, and a
/// win leaves corpses. Passed in rather than read from an `Arena` here so this stays a
/// pure function over the two accounts it actually writes.
fn append_results(
    board: &mut Leaderboard,
    roster: &Players,
    arena_id: u64,
    incarnation: u16,
    outcome: u8,
) -> bool {
    if board.last_arena_id == arena_id && board.last_incarnation == incarnation {
        return false;
    }

    let mut wrote = false;
    for slot in roster.slots.iter() {
        // Occupancy is derived from the session key, per the layout contract — there is
        // no occupancy flag on the slot to disagree with it.
        if slot.session_pubkey == [0u8; 32] {
            continue;
        }
        let cursor = (board.next as usize) % LEADERBOARD_CAP;
        board.entries[cursor] = LeaderboardEntry {
            arena_id,
            identity: slot.identity,
            damage_dealt: slot.damage_dealt,
            incarnation,
            survived: u8::from(slot.hp != 0),
            outcome,
        };
        board.next = ((cursor + 1) % LEADERBOARD_CAP) as u32;
        board.total_written = board.total_written.saturating_add(1);
        wrote = true;
    }

    // Only a settle that actually appended rows claims the idempotency key. **Do not
    // hoist this out of the `if`.** The key is a single global slot, so an unconditional
    // stamp lets a seatless arena — one whose seats were never claimed, which has nothing
    // to record — overwrite a different match's key; that match's legitimate retry then
    // matches nothing, is treated as a duplicate, and its rows are dropped for good.
    // Observed on devnet, not theorised. A zero-row settle needs no key of its own:
    // replaying it appends nothing either way, so it is already idempotent by having no
    // effect at all, and leaving the previous match's key standing is what keeps *that*
    // match's retry a no-op.
    if wrote {
        board.last_arena_id = arena_id;
        board.last_incarnation = incarnation;
    }
    wrote
}

/// Move the head past an abandoned match without writing a row.
///
/// Stamps the same `(last_arena_id, last_incarnation)` pair `append_results` uses as its
/// idempotency key, and that is a deliberate, bounded compromise: the account has no
/// spare aligned 8 bytes for a separate cursor (5 B of padding at 3 and 6 B at 26), and
/// the head is the one thing the scan reads. The cost is the interleaving
/// `append_results`'s comment warns about — a recorded match's *retry* landing after an
/// abandon has moved the key would append its rows a second time. That needs the
/// record's HTTP response to be lost and a different raid to be abandoned inside the
/// retry window, and it duplicates leaderboard rows rather than losing them. Accepted,
/// because the alternative was a join path that stopped working after ~76 abandons.
fn mark_abandoned(board: &mut Leaderboard, arena_id: u64, incarnation: u16) {
    board.last_arena_id = arena_id;
    board.last_incarnation = incarnation;
}

// ---------------------------------------------------------------------------
// Shared account checks
// ---------------------------------------------------------------------------

/// The three delegated accounts, checked together because both ER instructions in this
/// module need the same three facts about them.
///
/// `Boss` and `Players` are bound to the **address** of the `Arena` that was passed, not
/// to an `arena_id`. That is what stops a caller pairing a throwaway arena they control
/// with the real boss and roster: a forged arena can only ever reach its own children.
/// The arena itself needs no seed check — owner, discriminator and the
/// `crank_authority` signer comparison already confine it.
fn check_match_accounts(
    program_id: &Address,
    arena: &AccountView,
    boss: &AccountView,
    players: &AccountView,
) -> Result<(), ProgramError> {
    assert_owned_by(arena, program_id)?;
    assert_owned_by(boss, program_id)?;
    assert_owned_by(players, program_id)?;

    let arena_key = arena.address();
    assert_pda(boss, &[SEED_BOSS, arena_key.as_ref()], program_id)?;
    assert_pda(players, &[SEED_PLAYERS, arena_key.as_ref()], program_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        DISC_LEADERBOARD, DISC_PLAYERS, LAYOUT_VERSION, OUTCOME_ENRAGE, OUTCOME_WIN,
    };
    use bytemuck::Zeroable;

    fn roster(occupied: usize) -> Players {
        let mut p = Players::zeroed();
        p.discriminator = DISC_PLAYERS;
        p.version = LAYOUT_VERSION;
        for (i, slot) in p.slots.iter_mut().enumerate().take(occupied) {
            slot.session_pubkey = [(i as u8) + 1; 32];
            slot.identity = [(i as u8) + 100; 32];
            slot.damage_dealt = 1_000 + i as u32;
            slot.hp = if i % 2 == 0 { 10 } else { 0 };
        }
        p
    }

    fn board() -> Leaderboard {
        let mut b = Leaderboard::zeroed();
        b.discriminator = DISC_LEADERBOARD;
        b.version = LAYOUT_VERSION;
        b
    }

    /// The crank is armed once and can never be topped up, so the one way this number is
    /// wrong is a raid that goes inert mid-fight with nothing failing anywhere: the task
    /// simply stops being replayed, `arena.tick` stops advancing, and every timeout that
    /// would have recovered the match is measured in ticks that no longer happen.
    ///
    /// The const-assert above is the real gate — this test is what says *why* out loud,
    /// and what fails audibly if either duration is retuned. Both are relations over
    /// `ticks_for` constants; neither mentions 4,750.
    #[test]
    fn the_crank_outlives_the_longest_possible_match() {
        let match_ticks = (MUSTER_TICKS + ENRAGE_TICKS) as i64;
        assert!(
            TICK_ITERATIONS >= match_ticks,
            "{TICK_ITERATIONS} iterations cannot cover a {match_ticks}-tick match"
        );

        // What the surplus is *for*: a match that runs to enrage still has to be settled,
        // and a settle that went through a VRF request can sit in `ROLLING` for a whole
        // `ROLL_TIMEOUT_TICKS` before `abandon_roll` frees it — all of it on ticks this
        // task has to still be delivering.
        let surplus = TICK_ITERATIONS - match_ticks;
        assert!(
            surplus >= ROLL_TIMEOUT_TICKS as i64,
            "{surplus} spare ticks does not cover the {ROLL_TIMEOUT_TICKS}-tick roll window"
        );
    }

    /// The property H4 rests on: the minted id moves when the entropy moves, and stays
    /// inside the range the crank arguments accept. If mixing ever stops depending on the
    /// entropy — a dropped seed, a truncation — every arena goes back to a precomputable
    /// id and the squat is back, silently, because a collision returns `Ok`.
    #[test]
    fn task_id_depends_on_entropy_and_is_positive() {
        let program_id = Address::new_from_array([9u8; 32]);
        let arena = Address::new_from_array([4u8; 32]);
        let other_arena = Address::new_from_array([5u8; 32]);

        let a = mint_task_id(&program_id, &arena, 7, &[1u8; 32]);
        let b = mint_task_id(&program_id, &arena, 7, &[2u8; 32]);
        let c = mint_task_id(&program_id, &other_arena, 7, &[1u8; 32]);
        let d = mint_task_id(&program_id, &arena, 8, &[1u8; 32]);

        assert_ne!(a, b, "entropy must reach the id");
        assert_ne!(a, c, "the arena must reach the id");
        assert_ne!(a, d, "the creation-time value must reach the id");
        for id in [a, b, c, d] {
            assert!(id > 0, "crank ids are i64 and 0 is not usable: {id}");
        }
        // Deterministic for a fixed input, which is what lets `settle` cancel what
        // `start_match` scheduled — the id is stored, but a wandering derivation would
        // mean the stored value and the scheduled one could ever disagree.
        assert_eq!(a, mint_task_id(&program_id, &arena, 7, &[1u8; 32]));
    }

    /// The degraded path L4 is about, in the one shape a host test can reach: off-chain,
    /// `sol_get_sysvar` returns `Ok` and writes nothing, so the read "succeeds" and yields
    /// no entropy at all. It must refuse. If this ever passes, `start_match` is minting a
    /// task id from a constant — precomputable, squattable, and silent when squatted.
    #[test]
    fn entropy_refuses_rather_than_degrading() {
        assert_eq!(
            schedule_entropy().unwrap_err(),
            ProgramError::UnsupportedSysvar
        );
    }

    /// The three ways this write goes wrong in production: a retried settle duplicating
    /// twenty rows, the ring cursor walking off the end, and unclaimed seats being
    /// recorded as players.
    #[test]
    fn leaderboard_write_is_idempotent_and_wraps() {
        let mut b = board();
        let p = roster(3);

        assert!(append_results(&mut b, &p, 7, 2, OUTCOME_WIN));
        assert_eq!(b.next, 3);
        assert_eq!(b.total_written, 3);
        assert_eq!(b.entries[0].identity, [100u8; 32]);
        assert_eq!(b.entries[0].survived, 1);
        assert_eq!(b.entries[1].survived, 0);
        // Seat 3 was never claimed, so it is not a row.
        assert_eq!(b.entries[3].arena_id, 0);

        // The retry the settle route is designed to perform.
        assert!(!append_results(&mut b, &p, 7, 2, OUTCOME_WIN));
        assert_eq!(b.next, 3);
        assert_eq!(b.total_written, 3);

        // A different incarnation of the same arena is a different match.
        assert!(append_results(&mut b, &p, 7, 3, OUTCOME_WIN));
        assert_eq!(b.next, 6);

        // Wrap: fill to the last slot, then one more match must land at index 0 without
        // running off the end of `entries`.
        b.next = (LEADERBOARD_CAP - 1) as u32;
        assert!(append_results(&mut b, &roster(2), 8, 1, OUTCOME_WIN));
        assert_eq!(b.next, 1);
        assert_eq!(b.entries[LEADERBOARD_CAP - 1].arena_id, 8);
        assert_eq!(b.entries[0].arena_id, 8);
        assert_eq!(b.last_arena_id, 8);
        assert_eq!(b.last_incarnation, 1);
    }

    /// F1: the permanent record must tell a victory from a defeat. Before the `outcome`
    /// byte, an enrage that left survivors and a win produced byte-identical rows, so
    /// eight of the ten rows already on devnet say `survived: true` and cannot be read.
    /// `survived` stays per-seat: seat 0 lives through both matches, and that is not what
    /// distinguishes them.
    #[test]
    fn an_abandoned_match_moves_the_head_and_writes_no_row() {
        let mut b = Leaderboard::zeroed();
        let p = roster(2);
        assert!(append_results(&mut b, &p, 7, 1, OUTCOME_WIN));
        assert_eq!((b.last_arena_id, b.last_incarnation, b.total_written), (7, 1, 2));
        mark_abandoned(&mut b, 9, 1);
        assert_eq!((b.last_arena_id, b.last_incarnation), (9, 1), "the head follows the abandon");
        assert_eq!(b.total_written, 2, "and nothing was written for it");
        assert_eq!(b.next, 2);
    }

    #[test]
    fn win_and_enrage_rows_differ() {
        let mut b = board();
        let p = roster(2);

        assert!(append_results(&mut b, &p, 7, 1, OUTCOME_WIN));
        assert!(append_results(&mut b, &p, 8, 1, OUTCOME_ENRAGE));

        assert_eq!(b.entries[0].outcome, OUTCOME_WIN);
        assert_eq!(b.entries[2].outcome, OUTCOME_ENRAGE);
        assert_ne!(
            bytemuck::bytes_of(&b.entries[0])[8..],
            bytemuck::bytes_of(&b.entries[2])[8..],
            "a win row and an enrage row must not be byte-identical past the arena id"
        );
        // The survivor flag is the seat's fact and is unchanged by the match's.
        assert_eq!(b.entries[0].survived, 1);
        assert_eq!(b.entries[2].survived, 1);
    }

    /// F7, observed on devnet: a seatless arena's settle stamped the idempotency key over
    /// a concurrently-settling match's, and that match's legitimate retry was then dropped
    /// as a duplicate. A settle that writes nothing must claim nothing.
    #[test]
    fn zero_row_settle_does_not_steal_the_idempotency_key() {
        let mut b = board();

        assert!(append_results(&mut b, &roster(2), 7, 1, OUTCOME_WIN));
        // The seatless arena: no session key, so no rows.
        assert!(!append_results(&mut b, &roster(0), 9, 1, OUTCOME_ENRAGE));
        assert_eq!(b.last_arena_id, 7);
        assert_eq!(b.last_incarnation, 1);
        assert_eq!(b.total_written, 2);

        // Match 7's retry is still recognised as the duplicate it is.
        assert!(!append_results(&mut b, &roster(2), 7, 1, OUTCOME_WIN));
        assert_eq!(b.next, 2);
        assert_eq!(b.total_written, 2);
    }
}
