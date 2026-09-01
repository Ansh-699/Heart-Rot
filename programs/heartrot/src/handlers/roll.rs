//! The VRF round trip that picks the **next** incarnation's ruleset: tags 13 and 14.
//!
//! Two instructions, one for each half of an asynchronous call. Tag 13 (`request_roll`)
//! asks the MagicBlock VRF oracle for 32 bytes and moves the arena `SETTLING → ROLLING`;
//! tag 14 (`consume_roll`) is the oracle's callback, stores those bytes in
//! `Arena.next_affix_seed` and moves `ROLLING → ROLLED`. `init::next_incarnation` (tag 15)
//! then spends the seed on the base layer. Nothing else in the program writes
//! `next_affix_seed`, and that is the whole verification story — see below.
//!
//! Four properties shape everything in this file. None of them is a preference.
//!
//! 1. **A player asks, never the crank.** `RequestRandomness`'s first account is a
//!    *writable signer*, and a CPI cannot escalate a read-only account to writable. A
//!    crank instruction may carry no writable signer at all, so tag 8 structurally
//!    cannot make this request — it is not that we chose not to. The killing blow's
//!    client sends tag 13 on the popup-free session key it already holds, and the in-ER
//!    queue (`DEFAULT_EPHEMERAL_QUEUE`) is fee-exempt, so a zero-lamport session key can
//!    pay for it. The base-layer `DEFAULT_QUEUE` charges 500,000 lamports and is
//!    deliberately not accepted here.
//!
//! 2. **`consume_roll` must never return `Err`.** The VRF program invokes the callback
//!    with `?` inside its own `ProvideRandomness` transaction, so an `Err` reverts that
//!    transaction *including the queue removal* and the oracle retries the same request
//!    for its full 240-slot TTL. Every rejection — wrong length, wrong signer, stale
//!    incarnation, wrong phase — is therefore `Ok(())`. This is the same discipline
//!    `tick::process` is held to, for a different validator and the same reason.
//!
//!    A rejection that returns `Ok` and writes nothing is invisible, which is the exact
//!    failure class this project keeps producing, so the reason is emitted with
//!    `sol_log_64_` before the `Ok`. [`try_consume_roll`] does the work and returns real
//!    `ProgramError`s; [`consume_roll`] is the thin wrapper that logs one and swallows it.
//!    That is also why [`HeartrotError::NotVrfIdentity`] has a genuine call site rather
//!    than being a code nothing can ever produce.
//!
//! 3. **The scoped identity is the entire security of tag 14.** The callback's signer
//!    must be `vrf::pda::scoped_vrf_identity(program_id)` — PDA `["identity", heartrot]`
//!    under the **VRF** program. The global `VRF_PROGRAM_IDENTITY` is deprecated and is
//!    shared with every other consumer of the queue, so asserting *that* one would let
//!    any other VRF consumer on the network write our next boss's ruleset. Note this is
//!    a different PDA under a different program from the `["identity"]` PDA tag 13 signs
//!    with; mixing the two up is the obvious mistake and the freeze test below rejects it.
//!
//! 4. **All-zero `next_affix_seed` is the sentinel *and* the verification.** There is no
//!    `roll_verified` flag, because the only writer of those bytes is
//!    [`Arena::accept_roll`], reached only from this file's tag 14, which the scoped
//!    identity signs. So "non-zero" already means "a proof was verified on chain", and no
//!    second field exists to fall out of agreement with the first.
//!
//! The phase byte is never assigned here. `begin_roll` and `accept_roll` on
//! [`crate::state::Arena`] perform both edges and check them against `state::PHASE_EDGES`,
//! which is the one place the game loop's control flow is written down.

// `target_os = "solana"` only exists under `cargo build-sbf`; on a host `cargo test` the
// compiler has no way to know it is a real value. The `cfg` on the log is load-bearing —
// the syscall does not exist off-chain — so silence the check rather than dropping it.
#![allow(unexpected_cfgs)]

use ephemeral_rollups_pinocchio::vrf::{
    consts::{DEFAULT_EPHEMERAL_QUEUE, IDENTITY_SEED, VRF_PROGRAM_ID},
    instruction::RequestRandomnessCpi,
    pda::scoped_vrf_identity,
    types::RequestRandomness,
};
use pinocchio::{
    address::address_eq,
    cpi::{Seed, Signer},
    error::ProgramError,
    instruction::InstructionAccount,
    sysvars::slot_hashes::SLOTHASHES_ID,
    AccountView, Address, ProgramResult,
};

use crate::error::HeartrotError;
use crate::guards::{
    assert_owned_by, assert_pda, assert_session_authority, assert_signer, assert_writable,
};
use crate::state::{self, Arena, Players, SEED_PLAYERS};

/// The callback's instruction discriminator, and therefore its dispatch tag.
///
/// **Frozen as hard as `settle::IX_BOSS_TICK`, and for the same kind of reason.** Tag 13's
/// CPI writes this byte into the VRF request as `callback_discriminator`, and the oracle
/// prepends it verbatim on fulfilment for the request's whole life. Renumbering it strands
/// every roll already in flight.
///
/// It is deliberately **one byte**, which is what lets the callback reach `lib.rs`'s
/// ordinary tag split with no pre-tag route of its own: the oracle's discriminator *is*
/// our tag. Widening it past one byte would silently move the callback out of dispatch and
/// into `InvalidInstructionData` forever.
pub const IX_CONSUME_ROLL: u8 = 14;

/// Tag 13's argument block: `seat` u8, and nothing else.
const REQUEST_DATA_LEN: usize = 1;

/// Tag 14's argument block as the oracle assembles it: 32 randomness bytes then the
/// `callback_args` we froze into the request, which is `incarnation` as u16 LE.
const CALLBACK_DATA_LEN: usize = 34;

/// `callback_args` — `incarnation.to_le_bytes()`, two bytes.
///
/// It exists so a fulfilment that lands *after* the arena has already advanced is dropped
/// instead of applied to the wrong boss. The oracle's TTL is 240 slots and
/// `ROLL_TIMEOUT_TICKS` is 25 crank ticks (~10 s), so a callback arriving after the crank
/// abandoned the roll and a human re-ran the chain is a reachable state, not a hypothetical.
const CALLBACK_ARGS_LEN: usize = 2;

/// The frozen callback account list: the scoped identity the oracle inserts at index 0, and
/// `Arena` at index 1. One entry here, because index 0 is not ours to name.
const CALLBACK_METAS_LEN: usize = 1;

/// Exact byte length of the serialized `RequestRandomness` payload, computed from the three
/// lengths above rather than written out — the CPI helper refuses a short buffer, and a
/// hand-counted constant is the same fact stored twice.
const REQUEST_BUF_LEN: usize = RequestRandomness::serialized_size_for(
    1, // callback_discriminator: the single byte `IX_CONSUME_ROLL`
    CALLBACK_METAS_LEN,
    CALLBACK_ARGS_LEN,
);

// ---------------------------------------------------------------------------
// Tag 13 — RequestRoll
// ---------------------------------------------------------------------------

/// Ask the oracle for the next incarnation's seed. ER, signed by a seat's session key.
///
/// Accounts (`instruction.rs` tag 13 is the contract):
///
/// 0. `[w]`   arena — `phase` must be `SETTLING` and `outcome` `WIN`; stamps `roll_requested_tick`
/// 1. `[]`    players — read-only, resolves `slots[seat].session_pubkey`
/// 2. `[w s]` session key — must equal that pubkey, and is forwarded as the VRF payer
/// 3. `[]`    program identity — PDA `["identity"]` under **this** program; we `invoke_signed` it
/// 4. `[w]`   oracle queue — must be `DEFAULT_EPHEMERAL_QUEUE`
/// 5. `[]`    system program
/// 6. `[]`    slot hashes sysvar
/// 7. `[]`    vrf program
///
/// **No rate limiter, on purpose.** `SETTLING → ROLLING` is a one-shot edge in
/// `PHASE_EDGES`, so a second request is refused as an illegal transition rather than as a
/// quota breach — the phase machine already is the limiter, and a per-seat tick counter
/// here would be a second one to keep in agreement with it.
///
/// Any claimed seat may send it, not only the killer: one rule, and if the killer's browser
/// closed between their `shoot` and this transaction the other nineteen can still ask.
pub fn request_roll(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let [arena_ai, players_ai, payer, program_identity, oracle_queue, system_program, slot_hashes, vrf_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Exact-length gate: one seat byte, no more and no fewer. Short is somebody probing
    // for an index panic, long is client/program skew.
    let &[seat] = data else {
        return Err(ProgramError::InvalidInstructionData);
    };
    if data.len() != REQUEST_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    // --- accounts, all of them, before any borrow ---------------------------------
    assert_signer(payer)?;
    // Writable because it becomes the VRF request's payer, and a CPI cannot escalate a
    // read-only account. This is checked here rather than left to the VRF program so the
    // failure names the account instead of arriving as an opaque CPI privilege error.
    assert_writable(payer)?;

    assert_owned_by(arena_ai, program_id)?;
    assert_writable(arena_ai)?;
    assert_owned_by(players_ai, program_id)?;
    // Binds `players` to *this* arena. Without it a caller pairs match A's arena with
    // match B's roster and authorizes the roll with a session key from the wrong match.
    // `arena` itself needs no re-derivation: nothing but this program can mint an account
    // this program owns, and the discriminator check inside `load` covers type confusion.
    assert_pda(players_ai, &[SEED_PLAYERS, arena_ai.address().as_ref()], program_id)?;

    // The identity PDA is ours and we sign for it below, so the bump must be the canonical
    // one this guard searches for — a caller-supplied bump would derive an address the VRF
    // program then rejects as an unauthorized requester.
    let identity_bump = assert_pda(program_identity, &[IDENTITY_SEED], program_id)?;

    // The in-ER queue, and only it. `vrf::consts::DEFAULT_QUEUE` is the base-layer queue
    // and charges 500,000 lamports a request, which a zero-lamport session key cannot pay
    // — accepting it here would turn property 1 above into a runtime surprise.
    if !address_eq(oracle_queue.address(), &DEFAULT_EPHEMERAL_QUEUE) {
        return Err(ProgramError::InvalidAccountData);
    }
    assert_writable(oracle_queue)?;

    if !address_eq(system_program.address(), &pinocchio_system::ID)
        || !address_eq(slot_hashes.address(), &SLOTHASHES_ID)
        || !address_eq(vrf_program.address(), &VRF_PROGRAM_ID)
    {
        return Err(ProgramError::IncorrectProgramId);
    }

    // --- authority: this signer owns this seat ------------------------------------
    {
        let players_data = players_ai.try_borrow()?;
        let players = state::load::<Players>(&players_data)?;
        // `get` bounds-checks the untrusted seat index; `assert_session_authority` is the
        // entire perimeter behind it, and also rejects the all-zero unclaimed sentinel.
        let slot = players
            .slots
            .get(seat as usize)
            .ok_or(HeartrotError::SeatOutOfRange)?;
        assert_session_authority(slot, payer)?;
    }

    // --- state: SETTLING → ROLLING, and copy out what the CPI needs ----------------
    //
    // The borrow is scoped and dropped before the CPI: `invoke_signed` re-enters the
    // runtime with `payer`, and a live `Ref` on any account in the list is a borrow
    // failure at the syscall boundary.
    let (caller_seed, incarnation) = {
        let mut arena_data = arena_ai.try_borrow_mut()?;
        let arena = state::load_mut::<Arena>(&mut arena_data)?;

        // Checks `outcome == OUTCOME_WIN` and the `SETTLING → ROLLING` edge, then stamps
        // `roll_requested_tick` so the crank's timeout is measured from the request rather
        // than from anything the caller supplies. A wipe is refused here.
        arena.begin_roll()?;

        // `caller_seed` is mixed into the oracle's derivation and is public by nature —
        // the unpredictability comes from the oracle's keypair, not from this. The fight's
        // own `affix_seed` is used because it is already unique per `(arena, incarnation)`
        // and costs no hash to produce, and because a *constant* seed across matches is
        // the one value worth avoiding.
        (arena.affix_seed, arena.incarnation)
    };

    // --- the request --------------------------------------------------------------
    //
    // Everything below is frozen into the oracle's row and replayed verbatim on
    // fulfilment: the one-byte discriminator, the single `Arena` meta, and the two
    // `callback_args` bytes. The oracle inserts the scoped identity signer ahead of our
    // metas, which is why `Arena` is the only entry — index 0 is not ours to name.
    //
    // `Boss` is deliberately absent. The boss is rescaled by tag 15 on the base layer, so
    // the frozen list stays at two accounts and never has to name `Players`, which could
    // not fit the request's 25-meta cap anyway.
    let callback_metas = [InstructionAccount::writable(arena_ai.address())];
    let callback_args = incarnation.to_le_bytes();

    let cpi = RequestRandomnessCpi {
        payer,
        program_identity,
        oracle_queue,
        system_program,
        slot_hashes,
        vrf_program,
        request: RequestRandomness {
            // The high-priority queue is a separate discriminator and a separate fee
            // schedule. The in-ER path fulfils in ~100 ms against a 10 s timeout, so
            // paying for priority would buy nothing.
            high_priority: false,
            caller_seed,
            callback_program_id: program_id,
            callback_discriminator: &[IX_CONSUME_ROLL],
            callback_accounts_metas: &callback_metas,
            callback_args: &callback_args,
        },
    };

    // Sized from the same three lengths the request is built from, so it cannot be short.
    let mut buf = [0u8; REQUEST_BUF_LEN];

    // We sign as `["identity"]` under our own program: that signature is the VRF program's
    // proof that the request came from the program that owns the callback, which is what
    // makes the scoped identity meaningful on the way back.
    let bump = [identity_bump];
    let seeds = [Seed::from(IDENTITY_SEED), Seed::from(&bump[..])];
    cpi.invoke_signed(&mut buf, &[Signer::from(&seeds[..])])
}

// ---------------------------------------------------------------------------
// Tag 14 — ConsumeRoll, the oracle's callback
// ---------------------------------------------------------------------------

/// Store a fulfilled VRF seed. **Never returns `Err`** — see property 2 in the module
/// header.
///
/// Accounts, fixed by the request tag 13 froze:
///
/// 0. `[r s]` scoped VRF identity — `["identity", heartrot]` under the **VRF** program
/// 1. `[w]`   arena — `phase` must be `ROLLING`; receives `next_affix_seed`
///
/// Nobody builds this instruction but the VRF program, and there is no client builder for
/// it anywhere in the repo, deliberately.
pub fn consume_roll(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    if let Err(reason) = try_consume_roll(program_id, accounts, data) {
        // The one thing that must not happen here is a silent refusal. `sol_log_64_` is
        // the cheapest signal available (no allocation, no formatting, ~100 CU) and it
        // puts the rejection code in the oracle's own transaction logs, which is the only
        // place an operator can see this instruction at all.
        log_rejection(reason);
    }
    Ok(())
}

/// The real handler. Returns genuine errors so each refusal has a distinct code;
/// [`consume_roll`] is what turns them into `Ok(())`.
fn try_consume_roll(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let [vrf_identity, arena_ai, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (randomness, for_incarnation) = parse_callback(data)?;

    // --- the entire security of this instruction ----------------------------------
    //
    // Ordered first, before any account is read and before `arena` is even looked at: a
    // forged callback must be refused on the signature, not on some later state condition
    // that a patient attacker could arrange to satisfy.
    assert_signer(vrf_identity)?;
    let (expected_identity, _) = scoped_vrf_identity(program_id);
    if !address_eq(vrf_identity.address(), &expected_identity) {
        return Err(HeartrotError::NotVrfIdentity.into());
    }

    assert_owned_by(arena_ai, program_id)?;
    assert_writable(arena_ai)?;

    let mut arena_data = arena_ai.try_borrow_mut()?;
    let arena = state::load_mut::<Arena>(&mut arena_data)?;

    // Total by construction: checks `phase == ROLLING`, the incarnation echo and the
    // all-zero seed, then performs `ROLLING → ROLLED`. `false` means one of those refused.
    // All three are the same condition — "this fulfilment does not belong to this state" —
    // and the arena the caller already holds says which, so they share `WrongPhase`.
    if !arena.accept_roll(&randomness, for_incarnation) {
        return Err(HeartrotError::WrongPhase.into());
    }

    Ok(())
}

/// Split the oracle's callback block: 32 randomness bytes, then the `for_incarnation` u16
/// LE we asked it to echo.
///
/// Exact-length, like every other argument block in this program. A short block is a
/// truncated or forged payload and a long one is skew against a request we no longer
/// build; neither is guessed at.
fn parse_callback(data: &[u8]) -> Result<([u8; 32], u16), ProgramError> {
    if data.len() != CALLBACK_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    // `split_at` cannot panic after the length check, but `try_into` is what produces the
    // arrays without an index expression anywhere.
    let (seed, tail) = data.split_at(32);
    let randomness: [u8; 32] = seed
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let incarnation_bytes: [u8; 2] = tail
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    Ok((randomness, u16::from_le_bytes(incarnation_bytes)))
}

/// Emit a swallowed rejection code so a refused callback is visible instead of silent.
///
/// `sol_log_64_` rather than a formatted message: it takes five `u64`s and does no
/// allocation, which keeps this off the alloc path in a handler that must not fail. The
/// leading `14` tags the line as this instruction's, so it is greppable in a log that also
/// carries the oracle's own output.
#[inline(always)]
fn log_rejection(reason: ProgramError) {
    let code = u64::from(reason);
    #[cfg(target_os = "solana")]
    unsafe {
        pinocchio::syscalls::sol_log_64_(IX_CONSUME_ROLL as u64, 0, 0, 0, code);
    }
    // Off-chain the syscall does not exist. `code` is still computed, so a host build type
    // checks the conversion the on-chain path depends on.
    let _ = code;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// `IX_CONSUME_ROLL` is written into every VRF request as the callback discriminator
    /// and replayed by the oracle for the request's whole TTL, so the dispatch arm in
    /// `lib.rs` has to be the same number — the mirror of
    /// `boss_tick_tag_matches_the_crank_row`. Drift is otherwise only discoverable as a
    /// fulfilment that lands as `InvalidInstructionData` on devnet, minutes later, in
    /// somebody else's transaction.
    ///
    /// The one-byte width is asserted too: it is what lets the callback reach the ordinary
    /// tag split with no pre-tag route, and a wider discriminator would leave the handler
    /// unreachable rather than merely mis-numbered.
    #[test]
    fn callback_discriminator_is_the_dispatch_tag() {
        assert_eq!(IX_CONSUME_ROLL, 14);
        assert_eq!([IX_CONSUME_ROLL].len(), 1);
    }

    /// The two identity PDAs are different derivations under different programs, and
    /// swapping them is the obvious mistake: tag 13 signs with `["identity"]` under
    /// *heartrot*, tag 14 verifies `["identity", heartrot]` under the *VRF program*.
    ///
    /// Asserting the scoped identity is also not the deprecated global
    /// `VRF_PROGRAM_IDENTITY` is the point of the whole check — that one is shared with
    /// every other consumer of the queue, so a callback validated against it is
    /// spoofable by any of them.
    #[test]
    fn scoped_identity_is_distinct_from_both_alternatives() {
        use ephemeral_rollups_pinocchio::vrf::{
            consts::VRF_PROGRAM_IDENTITY, pda::program_identity_pda,
        };

        let program = Address::new_from_array([7u8; 32]);
        let (scoped, _) = scoped_vrf_identity(&program);
        let (own_identity, _) = program_identity_pda(&program);

        assert_ne!(
            scoped.as_ref(),
            own_identity.as_ref(),
            "the callback verifier and the request signer are the same PDA",
        );
        assert_ne!(
            scoped.as_ref(),
            VRF_PROGRAM_IDENTITY.as_ref(),
            "the callback is being verified against the shared, deprecated identity",
        );
    }

    /// The callback block is the one payload this program does not control the encoding
    /// of, so its split is worth pinning: 32 bytes of randomness then the two-byte
    /// incarnation echo, little-endian, and nothing else accepted.
    #[test]
    fn callback_block_is_exact_length_and_splits_as_documented() {
        assert_eq!(CALLBACK_DATA_LEN, 32 + CALLBACK_ARGS_LEN);

        let mut block = [0u8; CALLBACK_DATA_LEN];
        block[..32].copy_from_slice(&[3u8; 32]);
        // 0x0102 = 258, so a big-endian read would answer 513 and fail here.
        block[32] = 0x02;
        block[33] = 0x01;

        let (seed, incarnation) = parse_callback(&block).unwrap();
        assert_eq!(seed, [3u8; 32]);
        assert_eq!(incarnation, 0x0102);

        // One short and one long are both refused, and with the same code the handlers
        // use everywhere else for a malformed block.
        for len in [0usize, 33, 35] {
            let short = vec![0u8; len];
            assert_eq!(
                parse_callback(&short).unwrap_err(),
                ProgramError::InvalidInstructionData,
                "a {len}-byte callback block was accepted",
            );
        }
    }

    /// The CPI helper refuses a buffer shorter than the payload, and the buffer is a
    /// stack array whose length must be a `const`. This pins that constant to the same
    /// three lengths the request is actually built from, so adding a callback meta or a
    /// third `callback_args` byte cannot leave a request that fails to serialize on chain.
    #[test]
    fn request_buffer_fits_the_request_it_is_built_for() {
        let program = Address::new_from_array([7u8; 32]);
        let metas = [InstructionAccount::writable(&program)];
        let args = [0u8; CALLBACK_ARGS_LEN];

        let request = RequestRandomness {
            high_priority: false,
            caller_seed: [0u8; 32],
            callback_program_id: &program,
            callback_discriminator: &[IX_CONSUME_ROLL],
            callback_accounts_metas: &metas,
            callback_args: &args,
        };

        assert_eq!(request.serialized_size(), REQUEST_BUF_LEN);
        assert_eq!(metas.len(), CALLBACK_METAS_LEN);

        // And it really does serialize into exactly that many bytes.
        let mut buf = [0u8; REQUEST_BUF_LEN];
        assert_eq!(request.serialize_into(&mut buf, 10).unwrap(), REQUEST_BUF_LEN);
    }

    /// Every refusal `try_consume_roll` can produce reaches an operator as a number in a
    /// log line and nothing else, so two of them sharing a code would merge an attempted
    /// forgery into a stale fulfilment — the same collapse `guards.rs` refuses for the
    /// session-key checks.
    #[test]
    fn callback_refusals_are_distinct_codes() {
        let codes: [ProgramError; 5] = [
            ProgramError::NotEnoughAccountKeys,
            ProgramError::InvalidInstructionData,
            ProgramError::MissingRequiredSignature,
            HeartrotError::NotVrfIdentity.into(),
            HeartrotError::WrongPhase.into(),
        ];
        for (i, a) in codes.iter().enumerate() {
            for b in &codes[i + 1..] {
                assert_ne!(a, b, "two callback refusals share a code");
            }
            // And every one of them survives the trip through `u64` the log takes.
            // `ProgramError` is not `Copy`, so the conversion takes a clone.
            assert_ne!(
                u64::from(a.clone()),
                0,
                "a refusal logs as 0, indistinguishable from success",
            );
        }
    }
}
