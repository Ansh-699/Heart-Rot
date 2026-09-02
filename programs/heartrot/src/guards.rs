//! The security perimeter.
//!
//! Pinocchio validates nothing. There is no `#[account(...)]` attribute, no owner
//! check, no signer check, no discriminator check and no PDA re-derivation happening
//! anywhere in the runtime path — the entrypoint hands a handler a `&mut [AccountView]`
//! of whatever the transaction listed, in whatever order, owned by whoever, and every
//! single assertion about those accounts is the program's own job. That is the whole
//! reason this file exists: one place where each check is written once, correctly, so a
//! handler's job is to *call* them rather than to remember them.
//!
//! Three properties every function here holds to, because a guard that panics or
//! silently narrows is worse than no guard at all:
//!
//! - **Total.** No `unwrap`, no `expect`, no `[i]` indexing, no `[a..b]` slicing, no
//!   unchecked arithmetic. Every failure is a `ProgramError`. A panic inside a guard
//!   aborts the transaction, which looks like a rejection until the day it happens
//!   inside the crank — where an abort burns a retry off the 10-retry ladder and, ten
//!   ticks later, deletes the task permanently.
//! - **Distinct errors.** Each guard returns a different `ProgramError` variant. The
//!   only debugging signal a failed ER transaction gives back is that variant, and
//!   "InvalidAccountData" for every failure mode is not a signal.
//! - **Fail closed.** Every function returns `Ok` on exactly one path.
//!
//! This module deliberately does *not* re-implement [`crate::state`]'s typed casts.
//! `state::load` / `state::load_mut` / `state::init` work on a `&mut [u8]` and already
//! own the discriminator and version check for the four `AccountLayout` types; every
//! handler reaches state through them. What is left over is what a `&mut [u8]` cannot
//! see: who owns the account, who signed, whether the runtime will keep the write, and
//! whether the address really is the PDA it claims to be. That is this file, and the
//! intended handler shape is
//!
//! ```ignore
//! assert_owned_by(arena_ai, &crate::ID)?;
//! assert_writable(arena_ai)?;                          // before the borrow, not after
//! let bump = assert_pda(arena_ai, &[SEED_ARENA, &arena_id.to_le_bytes()], &crate::ID)?;
//! let mut bytes = arena_ai.try_borrow_mut()?;
//! let arena = state::load_mut::<Arena>(&mut bytes)?;   // checks disc + version
//! ```
//!
//! The ordering of the first three lines is the one thing this module cannot enforce for
//! its caller, and [`assert_writable`] is the line most easily left out: `try_borrow_mut`
//! succeeds happily on a read-only account, so a missing writability check does not fail
//! — it produces a handler that computes a correct new state, returns `Ok`, and has the
//! write discarded by the runtime. Call it on every account a handler intends to write,
//! before the borrow.

// `target_os = "solana"` only exists under `cargo build-sbf`; on a host `cargo test` the
// compiler has no way to know it is a real value. The `cfg` below is load-bearing, so
// silence the check rather than dropping it.
#![allow(unexpected_cfgs)]

use {
    crate::{
        error::HeartrotError,
        state::{PlayerSlot, Players, ZONE_ARENA},
    },
    pinocchio::{
        account::AccountView,
        address::{Address, address_eq},
        error::ProgramError,
    },
};

/// A seat that was never claimed carries an all-zero session key (`state` §6). It is a
/// sentinel, so it must never compare equal to a real signer.
const UNCLAIMED: [u8; 32] = [0u8; 32];

// ---------------------------------------------------------------------------
// Account-flag guards
// ---------------------------------------------------------------------------

/// Reject an account this program does not own.
///
/// The check that stops a caller substituting an attacker-created account of the right
/// *size and shape* for one of ours. The discriminator check catches confusion between
/// our own types; this catches everything else, and it is the one that must come first,
/// because a foreign account's bytes are entirely attacker-chosen — including the
/// discriminator and the version.
#[inline(always)]
pub fn assert_owned_by(account: &AccountView, program_id: &Address) -> Result<(), ProgramError> {
    if account.owned_by(program_id) {
        Ok(())
    } else {
        Err(ProgramError::IllegalOwner)
    }
}

/// Reject an account that did not sign the transaction.
///
/// On the ER this is load-bearing in a way it is not on the base layer: transaction
/// fees are zero and the ER runs no fee-payer validation, so being *named* in a
/// transaction costs an attacker nothing at all. Signature is the only thing that
/// separates "this key" from "any key".
#[inline(always)]
pub fn assert_signer(account: &AccountView) -> Result<(), ProgramError> {
    if account.is_signer() {
        Ok(())
    } else {
        Err(ProgramError::MissingRequiredSignature)
    }
}

/// Reject an account the transaction did not mark writable.
///
/// The runtime rejects the write at the end of the instruction anyway, but by then the
/// handler has already spent its compute and, worse, has already decided the write
/// *succeeded* — a `boss_tick` that advances `tick` in memory and gets discarded is a
/// stalled match with no error to look at. Fail before the first store.
#[inline(always)]
pub fn assert_writable(account: &AccountView) -> Result<(), ProgramError> {
    if account.is_writable() {
        Ok(())
    } else {
        Err(ProgramError::Immutable)
    }
}

// ---------------------------------------------------------------------------
// PDA guard
// ---------------------------------------------------------------------------

/// Re-derive the canonical PDA for `seeds` and reject any account that is not it,
/// returning the canonical bump for the caller to sign with.
///
/// Ownership alone is not address identity: every account in this program is owned by
/// this program, so without this check `shoot` would happily accept the `Players`
/// account of a *different, live match* and let one raid's players damage another
/// raid's boss. Seeds are the only thing tying an account to the match it belongs to.
///
/// The bump is searched rather than accepted from the caller on purpose. Several bumps
/// can yield a valid off-curve address for the same seeds; trusting a supplied one lets
/// an attacker create a second, parallel `Arena` for an `arena_id` that already has one
/// (the classic bump-canonicalization hole). `sol_try_find_program_address` is the only
/// primitive that answers "which bump is *the* bump", so it is what runs on chain, at
/// roughly 1,500 CU per candidate — a handful of thousand CU against a 400,000 CU crank
/// ceiling, and the cheapest correct answer available.
///
/// ponytail: the host build takes a different path. `Address::try_find_program_address`
/// is compiled out off-chain unless `solana-address/curve25519` is enabled (it is not,
/// and adding it would pull `curve25519-dalek` into a program build), and the off-curve
/// test it relies on `panic!`s off-chain. The `#[cfg]` below substitutes a scan that
/// compares each candidate against the account's own address and skips the curve test,
/// so it agrees with the on-chain path on every input except one: an account sitting at
/// a *non-canonical* bump is rejected on chain and accepted on the host. That case
/// cannot be constructed against a live program (only this program can create these
/// accounts, and it only ever creates them at the canonical bump), and the tests below
/// exercise the rejection paths, which are identical. Upgrade path if it ever needs to
/// be identical: add `curve25519` as a dev-only feature on `solana-address`.
pub fn assert_pda<const N: usize>(
    account: &AccountView,
    seeds: &[&[u8]; N],
    program_id: &Address,
) -> Result<u8, ProgramError> {
    #[cfg(any(target_os = "solana", target_arch = "bpf"))]
    {
        let (expected, bump) = Address::try_find_program_address(seeds, program_id)
            .ok_or(ProgramError::InvalidSeeds)?;
        if address_eq(account.address(), &expected) {
            Ok(bump)
        } else {
            Err(ProgramError::InvalidSeeds)
        }
    }

    #[cfg(not(any(target_os = "solana", target_arch = "bpf")))]
    {
        // Walks 255 down to 0 and takes the first bump that reproduces this account's
        // address. `derive_address` is the plain SHA-256 derivation, available on both
        // targets; only the off-curve validation is missing here.
        let mut bump = u8::MAX;
        loop {
            if address_eq(
                account.address(),
                &Address::derive_address(seeds, Some(bump), program_id),
            ) {
                break Ok(bump);
            }
            match bump.checked_sub(1) {
                Some(next) => bump = next,
                None => break Err(ProgramError::InvalidSeeds),
            }
        }
    }
}

/// Same question as [`assert_pda`] — "is this address the PDA for `seeds`?" — answered in
/// one hash instead of a search, using the bump the account already stores.
///
/// [`assert_pda`] costs ~1,500 CU *per candidate bump it rejects*, so its price is decided
/// by which `arena_id` happened to be rolled: measured, an arena whose children land on
/// bump 255 pays 3,452 CU in `shoot`'s guards and one at 251/254 pays 10,952
/// (`docs/review/chain-cost.md`). This function is flat at one `sol_sha256` regardless,
/// which is why the caller passes the bump rather than having it searched for.
///
/// **A forged bump is not acceptable here, and cannot be supplied.** The bump is read out
/// of the account's own byte 2 (`state::init` is its only writer) *after* two checks the
/// caller must already have made, and those two are what make this equivalent to the
/// search:
///
/// - [`assert_owned_by`] — only this program may write these bytes;
/// - `state::load`/`load_mut` — the discriminator proves the byte is the bump of the type
///   the caller thinks it is holding, not some other layout's field.
///
/// The hole [`assert_pda`]'s search closes is the bump-canonicalization one: a caller
/// supplying non-canonical bump `B` for which `derive(seeds, B)` is still a valid
/// off-curve address, and standing a *second, parallel* account there. That address is
/// unreachable for this program. Only `init::create_pda_account` creates these accounts,
/// it derives canonically and signs with the canonical bump, so the program never signs
/// `seeds ‖ B`; without that signature the System Program will not `assign` the address to
/// us, and an account we do not own fails `assert_owned_by`. An address that is *on* the
/// curve is worse for the attacker, not better — a keypair can `assign` it to us, but only
/// this program may then write its data, so it stays zeroed and fails the discriminator.
/// So a non-canonical-bump account that reaches this function does not exist, and the one
/// that does reach it proves its own bump by reproducing its own address.
///
/// Rejection is [`ProgramError::InvalidSeeds`], the same code [`assert_pda`] returns, so
/// swapping one for the other does not change what a failed transaction tells a caller.
///
/// Takes the address rather than the `AccountView` because `try_borrow_mut` takes
/// `&mut self`: the bump is only readable while the data borrow is held, and `address()`
/// is not callable then. Copy the address out before borrowing.
#[inline(always)]
pub fn assert_pda_at_bump<const N: usize>(
    address: &Address,
    seeds: &[&[u8]; N],
    program_id: &Address,
    bump: u8,
) -> Result<(), ProgramError> {
    if address_eq(
        address,
        &Address::derive_address(seeds, Some(bump), program_id),
    ) {
        Ok(())
    } else {
        Err(ProgramError::InvalidSeeds)
    }
}

// ---------------------------------------------------------------------------
// Session authority
// ---------------------------------------------------------------------------

/// The single check standing between a stolen session key and an arena-wide cheat.
///
/// Every player-facing instruction resolves a seat index to a `PlayerSlot` and then
/// must prove the transaction was signed by *that seat's* key. Omitting it does not
/// weaken the game a little — it lets any keypair move, shoot and claim damage as any
/// of the twenty seats, on a network where transactions are free. This is the entire
/// perimeter for player actions, not one layer of it.
///
/// Three ways it fails, and all three matter, so all three answer differently:
///
/// - the transaction is not signed at all — `MissingRequiredSignature`, the runtime's own
///   name for the condition, which this file does not duplicate;
/// - the seat was never claimed, so its key is the all-zero sentinel and must authorize
///   nobody — [`HeartrotError::SeatUnclaimed`];
/// - a real signer against somebody else's seat — [`HeartrotError::WrongSessionKey`].
///
/// The last two used to return the builtin `UninitializedAccount` and `IncorrectAuthority`.
/// Both are wrong, and the second is the expensive one: `IncorrectAuthority` is also what
/// six unrelated authority checks return, so the one signal that says *the arena is being
/// cheated* arrived indistinguishable from a misconfigured crank or a treasury typo — on a
/// network where the error code is the only diagnostic a failed ER transaction hands back.
/// `UninitializedAccount` is merely imprecise: the `Players` account is perfectly well
/// initialized, one seat inside it is empty, and a caller who went looking for an
/// uninitialized account would find nothing wrong with any of them.
pub fn assert_session_authority(
    player_slot: &PlayerSlot,
    signer: &AccountView,
) -> Result<(), ProgramError> {
    assert_signer(signer)?;
    // Ordered before the comparison so an unclaimed seat can never be entered by
    // whatever key happens to equal the sentinel.
    if player_slot.session_pubkey == UNCLAIMED {
        return Err(HeartrotError::SeatUnclaimed.into());
    }
    let expected = Address::new_from_array(player_slot.session_pubkey);
    if address_eq(&expected, signer.address()) {
        Ok(())
    } else {
        Err(HeartrotError::WrongSessionKey.into())
    }
}

// ---------------------------------------------------------------------------
// Raid readiness
// ---------------------------------------------------------------------------

/// Reject a muster armed over an empty pit.
///
/// `begin_muster` (tag 3) reads no `Players` account today, so a raid can be armed with
/// nobody through the gate: `spawn_volley` finds `best_seat == NO_TARGET`, no volley ever
/// spawns, and the crank burns the whole enrage window on an empty room before recording
/// `OUTCOME_ENRAGE`. This is the check that makes that state unrepresentable, and it is
/// the reason tag 3 gains a `Players` account.
///
/// `zone` alone is the whole test, and it is sufficient rather than lazy: a zeroed slot is
/// `ZONE_LOBBY`, and the only writer of `ZONE_ARENA` is `enter_gate`, which already passed
/// [`assert_session_authority`] and a gate-tile check. So a seat in the arena is by
/// construction a claimed seat that walked there. Checking `hp` as well would be wrong,
/// not merely redundant — a raider who died to the previous incarnation's last volley is
/// still a raider, and a muster is not a fight.
#[inline(always)]
pub fn assert_any_raider(players: &Players) -> Result<(), ProgramError> {
    if players.slots.iter().any(|slot| slot.zone == ZONE_ARENA) {
        Ok(())
    } else {
        Err(HeartrotError::NoRaiders.into())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// Every test here asserts a *rejection*. A guard that accepts the good case and also
/// accepts the bad one passes a happy-path test and is worth nothing; the refusal is
/// the entire product. Accepting cases appear only as the control that proves the
/// rejection was caused by the defect under test and not by the fixture.
#[cfg(test)]
mod tests {
    use {
        super::*,
        crate::state::{SEED_ARENA, SEED_BOSS},
        bytemuck::Zeroable,
        core::mem::size_of,
        pinocchio::account::{NOT_BORROWED, RuntimeAccount},
    };

    const PROGRAM: Address = Address::new_from_array([7u8; 32]);
    const OTHER: Address = Address::new_from_array([9u8; 32]);

    /// The runtime's in-memory shape: an 88-byte header immediately followed by the
    /// account data. `AccountView` reaches the data as `header_ptr + 88`, so the two
    /// must be one `#[repr(C)]` allocation and nothing may sit between them.
    #[repr(C)]
    struct Raw<const N: usize> {
        header: RuntimeAccount,
        data: [u8; N],
    }

    fn raw<const N: usize>(
        address: Address,
        owner: Address,
        signer: bool,
        writable: bool,
    ) -> Raw<N> {
        Raw {
            header: RuntimeAccount {
                borrow_state: NOT_BORROWED,
                is_signer: signer as u8,
                is_writable: writable as u8,
                executable: 0,
                padding: (N as u32).to_le_bytes(),
                address,
                owner,
                lamports: 1,
                data_len: N as u64,
            },
            data: [0u8; N],
        }
    }

    /// `Raw` must not be moved after this runs — the view holds a raw pointer into it.
    macro_rules! view {
        ($raw:expr) => {
            unsafe { AccountView::new_unchecked(core::ptr::addr_of_mut!($raw) as *mut RuntimeAccount) }
        };
    }

    fn addr(byte: u8) -> Address {
        Address::new_from_array([byte; 32])
    }

    /// The fixture above hard-codes the runtime's header size. If that ever moves,
    /// every test in this module would be reading the wrong bytes and still passing.
    #[test]
    fn fixture_matches_the_runtime_account_layout() {
        assert_eq!(size_of::<RuntimeAccount>(), 88);
        assert_eq!(core::mem::align_of::<RuntimeAccount>(), 8);
    }

    #[test]
    fn owner_guard_rejects_a_foreign_account() {
        let mut r = raw::<8>(addr(1), OTHER, false, false);
        let v = view!(r);
        assert_eq!(
            assert_owned_by(&v, &PROGRAM).unwrap_err(),
            ProgramError::IllegalOwner
        );

        let mut ours = raw::<8>(addr(1), PROGRAM, false, false);
        let v = view!(ours);
        assert!(assert_owned_by(&v, &PROGRAM).is_ok());
    }

    #[test]
    fn signer_guard_rejects_an_unsigned_account() {
        let mut r = raw::<8>(addr(1), PROGRAM, false, true);
        let v = view!(r);
        assert_eq!(
            assert_signer(&v).unwrap_err(),
            ProgramError::MissingRequiredSignature
        );
    }

    #[test]
    fn writable_guard_rejects_a_readonly_account() {
        let mut r = raw::<8>(addr(1), PROGRAM, true, false);
        let v = view!(r);
        assert_eq!(assert_writable(&v).unwrap_err(), ProgramError::Immutable);
    }

    #[test]
    fn pda_guard_rejects_wrong_seeds_and_wrong_program() {
        let arena_id = 7u64.to_le_bytes();
        let seeds: [&[u8]; 2] = [SEED_ARENA, &arena_id];
        let derived = Address::derive_address(&seeds, Some(u8::MAX), &PROGRAM);

        let mut r = raw::<8>(
            Address::new_from_array(*derived.as_array()),
            PROGRAM,
            false,
            false,
        );
        let v = view!(r);

        // Control: the account really is this PDA.
        assert_eq!(assert_pda(&v, &seeds, &PROGRAM).unwrap(), u8::MAX);

        // Same account, different seeds — this is the check that stops one match's
        // accounts being driven by another match's instruction.
        let wrong_seeds: [&[u8]; 2] = [SEED_BOSS, &arena_id];
        assert_eq!(
            assert_pda(&v, &wrong_seeds, &PROGRAM).unwrap_err(),
            ProgramError::InvalidSeeds
        );

        // Same seeds, a program that could have created a look-alike account.
        assert_eq!(
            assert_pda(&v, &seeds, &OTHER).unwrap_err(),
            ProgramError::InvalidSeeds
        );
    }

    /// The cheap guard must refuse everything the searching one refuses, on the same
    /// code. The bump is the interesting axis: it is the one input the searching guard
    /// never took, so the wrong bump against the right address is the case that decides
    /// whether swapping the two is safe.
    #[test]
    fn cheap_pda_guard_rejects_wrong_seeds_wrong_program_and_wrong_bump() {
        let arena_id = 7u64.to_le_bytes();
        let seeds: [&[u8]; 2] = [SEED_ARENA, &arena_id];
        // Bump 254, not 255 — a fixture at the top of the search would let an
        // implementation that ignores `bump` entirely pass this test.
        let derived = Address::derive_address(&seeds, Some(254), &PROGRAM);

        // Control: the address really is this PDA at this bump.
        assert!(assert_pda_at_bump(&derived, &seeds, &PROGRAM, 254).is_ok());

        // Every other bump for the same seeds. This is the bump-canonicalization case,
        // and it must fail on all 255 of them.
        for bump in 0..=u8::MAX {
            if bump == 254 {
                continue;
            }
            assert_eq!(
                assert_pda_at_bump(&derived, &seeds, &PROGRAM, bump).unwrap_err(),
                ProgramError::InvalidSeeds,
                "bump {bump} validated an address it does not derive"
            );
        }

        // One match's account driven by another match's instruction.
        let wrong_seeds: [&[u8]; 2] = [SEED_BOSS, &arena_id];
        assert_eq!(
            assert_pda_at_bump(&derived, &wrong_seeds, &PROGRAM, 254).unwrap_err(),
            ProgramError::InvalidSeeds
        );

        // A program that could have created a look-alike account.
        assert_eq!(
            assert_pda_at_bump(&derived, &seeds, &OTHER, 254).unwrap_err(),
            ProgramError::InvalidSeeds
        );
    }

    /// The two PDA guards must agree on the canonical account, or `shoot` and `boss_tick`
    /// would be enforcing different rules about the same `Boss`.
    #[test]
    fn both_pda_guards_agree_on_the_canonical_account() {
        let arena_id = 7u64.to_le_bytes();
        let seeds: [&[u8]; 2] = [SEED_ARENA, &arena_id];
        let derived = Address::derive_address(&seeds, Some(u8::MAX), &PROGRAM);

        let mut r = raw::<8>(
            Address::new_from_array(*derived.as_array()),
            PROGRAM,
            false,
            false,
        );
        let v = view!(r);

        let searched = assert_pda(&v, &seeds, &PROGRAM).unwrap();
        assert!(assert_pda_at_bump(v.address(), &seeds, &PROGRAM, searched).is_ok());
    }

    #[test]
    fn session_authority_rejects_unsigned_unclaimed_and_stolen_seats() {
        let mut slot = PlayerSlot::zeroed();
        let player = addr(42);

        // Correct key, but the transaction is not signed by it.
        slot.session_pubkey = *player.as_array();
        let mut unsigned = raw::<8>(
            Address::new_from_array(*player.as_array()),
            PROGRAM,
            false,
            false,
        );
        let v = view!(unsigned);
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            ProgramError::MissingRequiredSignature
        );

        let mut signed = raw::<8>(
            Address::new_from_array(*player.as_array()),
            PROGRAM,
            true,
            false,
        );
        let v = view!(signed);

        // Control: the seat's own key, signing.
        assert!(assert_session_authority(&slot, &v).is_ok());

        // A real signer against somebody else's seat — the arena-wide cheat. It must be
        // `WrongSessionKey` and nothing else: the builtin `IncorrectAuthority` this used
        // to return is shared with every other authority check in the program, so a
        // stolen session key reached an operator looking exactly like a misconfigured
        // crank.
        slot.session_pubkey = *addr(43).as_array();
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            HeartrotError::WrongSessionKey.into()
        );

        // The unclaimed sentinel must authorize nobody, including a signer whose key
        // is somehow all zeroes.
        slot.session_pubkey = UNCLAIMED;
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            HeartrotError::SeatUnclaimed.into()
        );
        let mut zero_signer = raw::<8>(Address::new_from_array(UNCLAIMED), PROGRAM, true, false);
        let v = view!(zero_signer);
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            HeartrotError::SeatUnclaimed.into()
        );
    }

    /// The refusal is the product: an empty pit must not arm a raid. The accepting case
    /// is the control, and it uses the *last* seat so an implementation that only looks at
    /// `slots[0]` fails here rather than passing by luck.
    #[test]
    fn raider_guard_rejects_a_pit_nobody_walked_into() {
        let mut players = Players::zeroed();
        assert_eq!(
            assert_any_raider(&players).unwrap_err(),
            HeartrotError::NoRaiders.into()
        );

        // A claimed seat that never reached the gate is still not a raider.
        players.slots[0].session_pubkey = [3u8; 32];
        players.slots[0].hp = 100;
        assert_eq!(
            assert_any_raider(&players).unwrap_err(),
            HeartrotError::NoRaiders.into()
        );

        // Control.
        players.slots[crate::state::MAX_SEATS - 1].zone = ZONE_ARENA;
        assert!(assert_any_raider(&players).is_ok());

        // A dead raider is still a raider: the muster is not a fight, and refusing here
        // would wedge a lobby whose only occupant died to the previous incarnation.
        players.slots[crate::state::MAX_SEATS - 1].hp = 0;
        assert!(assert_any_raider(&players).is_ok());
    }

    /// The three refusals above are the entire perimeter for player actions, and the only
    /// thing that reaches a caller is the code. Two of them sharing one would collapse
    /// "this seat was never claimed" into "somebody is driving a seat that is not theirs",
    /// which is precisely the merge that hid the cheat behind `IncorrectAuthority`.
    #[test]
    fn session_authority_refusals_are_three_distinct_codes() {
        let codes = [
            ProgramError::MissingRequiredSignature,
            HeartrotError::SeatUnclaimed.into(),
            HeartrotError::WrongSessionKey.into(),
        ];
        for (i, a) in codes.iter().enumerate() {
            for b in &codes[i + 1..] {
                assert_ne!(a, b, "two session-authority refusals share a code");
            }
        }
    }
}
