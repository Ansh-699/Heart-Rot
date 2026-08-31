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
//!   "InvalidAccountData" for all nine failure modes is not a signal.
//! - **Fail closed.** Every function returns `Ok` on exactly one path.
//!
//! This module deliberately does *not* re-implement [`crate::state`]'s typed casts.
//! `state::load` / `state::load_mut` / `state::init` work on a `&mut [u8]` and check
//! discriminator + version for the four `AccountLayout` types; the pair here works on
//! an `AccountView`, owns the borrow-flag guard and the writability check, and is
//! generic over any `Pod`. The intended handler shape for a known account type is
//!
//! ```ignore
//! assert_owned_by(arena_ai, &crate::ID)?;
//! let bump = assert_pda(arena_ai, &[SEED_ARENA, &arena_id.to_le_bytes()], &crate::ID)?;
//! let mut bytes = arena_ai.try_borrow_mut()?;
//! let arena = state::load_mut::<Arena>(&mut bytes)?;   // checks disc + version
//! ```
//!
//! and [`load_mut`] / [`load_zeroed`] here are for the cases `state` cannot express:
//! an account whose type is not one of the four, or the freshly-created account that
//! has no discriminator yet. When you use them on typed data, pair them with
//! [`assert_discriminator`] on the same bytes *before* the cast.

// `target_os = "solana"` only exists under `cargo build-sbf`; on a host `cargo test` the
// compiler has no way to know it is a real value. The `cfg` below is load-bearing, so
// silence the check rather than dropping it.
#![allow(unexpected_cfgs)]

use {
    crate::state::{DISC_UNINITIALIZED, LAYOUT_VERSION, PlayerSlot},
    bytemuck::Pod,
    core::mem::size_of,
    pinocchio::{
        account::{AccountView, RefMut},
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
// Header guard
// ---------------------------------------------------------------------------

/// Reject account bytes whose type tag or layout version is not what the handler
/// expects.
///
/// Byte 0 is the discriminator and byte 1 the layout version in all four account types
/// (`state` §1). Without this, `Boss` (50 bytes) passed where `Players` (1,924 bytes)
/// is expected differs only in length, and two same-sized types would not differ at
/// all — the tag is the *only* type-confusion defence that exists.
///
/// An all-zero (freshly allocated) account reports `UninitializedAccount` rather than
/// `InvalidAccountData`, because those two mean very different things when a match
/// fails to start and the only diagnostic is the error code.
pub fn assert_discriminator(data: &[u8], expected: u8) -> Result<(), ProgramError> {
    let (Some(&disc), Some(&version)) = (data.first(), data.get(1)) else {
        return Err(ProgramError::AccountDataTooSmall);
    };
    if disc != expected {
        return Err(if disc == DISC_UNINITIALIZED {
            ProgramError::UninitializedAccount
        } else {
            ProgramError::InvalidAccountData
        });
    }
    // Checked *after* the tag so a stale account reports "wrong version" and not "wrong
    // type". Accounts are recreated per match, so the practical migration is "settle the
    // in-flight match, then deploy" — this check is what makes that loud rather than a
    // client decoding an old layout as garbage.
    if version != LAYOUT_VERSION {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
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
/// Three ways it fails, and all three matter:
/// signature missing, seat never claimed (the all-zero sentinel must not authorize
/// anyone), and a real signer against the wrong seat.
pub fn assert_session_authority(
    player_slot: &PlayerSlot,
    signer: &AccountView,
) -> Result<(), ProgramError> {
    assert_signer(signer)?;
    // Ordered before the comparison so an unclaimed seat can never be entered by
    // whatever key happens to equal the sentinel.
    if player_slot.session_pubkey == UNCLAIMED {
        return Err(ProgramError::UninitializedAccount);
    }
    let expected = Address::new_from_array(player_slot.session_pubkey);
    if address_eq(&expected, signer.address()) {
        Ok(())
    } else {
        Err(ProgramError::IncorrectAuthority)
    }
}

// ---------------------------------------------------------------------------
// Checked casts
// ---------------------------------------------------------------------------

/// Cast the head of an account's data to `T`, or return an error.
///
/// `bytemuck::from_bytes_mut` *panics* on a length or alignment mismatch, so the
/// `try_` form is the only one that may appear anywhere in this program. Both
/// conditions are checked: a short account yields `AccountDataTooSmall`, a misaligned
/// pointer `InvalidAccountData`. The alignment arm should be unreachable — the runtime
/// places account data 88 bytes past an 8-aligned account header — but "should be" is
/// exactly the assumption a panic in a crank would be built on.
///
/// A *longer* account is accepted. Nothing but this program can resize its own PDAs,
/// and the trailing bytes are unreachable through `&mut T`.
fn cast_mut<T: Pod>(bytes: &mut [u8]) -> Result<&mut T, ProgramError> {
    let head = bytes
        .get_mut(..size_of::<T>())
        .ok_or(ProgramError::AccountDataTooSmall)?;
    bytemuck::try_from_bytes_mut(head).map_err(|_| ProgramError::InvalidAccountData)
}

/// Mutably borrow an account and cast it to `T`.
///
/// Takes the writability check with it: a handler that reaches for a mutable view has
/// already decided it is going to write, and a silently-discarded write is a far worse
/// failure than a rejected transaction (see [`assert_writable`]). The returned guard
/// holds the account's borrow flag, so a duplicate account meta cannot be mutably
/// aliased — that is `AccountBorrowFailed`, not undefined behaviour.
///
/// This does **not** check a discriminator; `T` is any `Pod`. Call
/// [`assert_discriminator`] first, or use `state::load_mut` on the borrowed bytes when
/// `T` is one of the four account layouts.
pub fn load_mut<'a, T: Pod>(account: &'a mut AccountView) -> Result<RefMut<'a, T>, ProgramError> {
    assert_writable(account)?;
    let bytes = account.try_borrow_mut()?;
    RefMut::try_map(bytes, cast_mut::<T>).map_err(|(_, e)| e)
}

/// Mutably borrow an account that must still be all zeroes, and cast it to `T`.
///
/// The initialization path. Demanding a zero head is what makes `init` non-repeatable
/// without a separate flag: byte 0 of a live account is a non-zero discriminator, so a
/// second `init` against a match in progress is rejected rather than resetting it.
/// Every byte of `T` is checked, not just the discriminator, so an account that was
/// closed and re-opened with stale contents is caught too.
pub fn load_zeroed<'a, T: Pod>(account: &'a mut AccountView) -> Result<RefMut<'a, T>, ProgramError> {
    assert_writable(account)?;
    let bytes = account.try_borrow_mut()?;
    RefMut::try_map(bytes, |raw| {
        let typed = cast_mut::<T>(raw)?;
        if bytemuck::bytes_of(typed).iter().any(|b| *b != 0) {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
        Ok(typed)
    })
    .map_err(|(_, e)| e)
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
        crate::state::{Arena, DISC_ARENA, DISC_BOSS, SEED_ARENA, SEED_BOSS},
        bytemuck::Zeroable,
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
    fn discriminator_guard_rejects_short_uninitialized_wrong_type_and_stale_version() {
        // Nothing to read, and a one-byte account has no version to read either.
        assert_eq!(
            assert_discriminator(&[], DISC_ARENA).unwrap_err(),
            ProgramError::AccountDataTooSmall
        );
        assert_eq!(
            assert_discriminator(&[DISC_ARENA], DISC_ARENA).unwrap_err(),
            ProgramError::AccountDataTooSmall
        );
        // A freshly allocated account is distinguishable from a wrong-type one.
        assert_eq!(
            assert_discriminator(&[DISC_UNINITIALIZED, 0], DISC_ARENA).unwrap_err(),
            ProgramError::UninitializedAccount
        );
        // The type-confusion case: Boss handed to a handler expecting Arena.
        assert_eq!(
            assert_discriminator(&[DISC_BOSS, LAYOUT_VERSION], DISC_ARENA).unwrap_err(),
            ProgramError::InvalidAccountData
        );
        // Right type, layout from a previous deploy.
        assert_eq!(
            assert_discriminator(
                &[DISC_ARENA, LAYOUT_VERSION.wrapping_add(1)],
                DISC_ARENA
            )
            .unwrap_err(),
            ProgramError::InvalidAccountData
        );
        assert!(assert_discriminator(&[DISC_ARENA, LAYOUT_VERSION], DISC_ARENA).is_ok());
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

        // A real signer against somebody else's seat — the arena-wide cheat.
        slot.session_pubkey = *addr(43).as_array();
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            ProgramError::IncorrectAuthority
        );

        // The unclaimed sentinel must authorize nobody, including a signer whose key
        // is somehow all zeroes.
        slot.session_pubkey = UNCLAIMED;
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            ProgramError::UninitializedAccount
        );
        let mut zero_signer = raw::<8>(Address::new_from_array(UNCLAIMED), PROGRAM, true, false);
        let v = view!(zero_signer);
        assert_eq!(
            assert_session_authority(&slot, &v).unwrap_err(),
            ProgramError::UninitializedAccount
        );
    }

    #[test]
    fn cast_rejects_short_and_misaligned_buffers() {
        #[repr(C, align(8))]
        struct Aligned([u8; 16]);
        let mut buf = Aligned([0u8; 16]);

        // Too small for the target type.
        assert_eq!(
            cast_mut::<u64>(&mut buf.0[..4]).unwrap_err(),
            ProgramError::AccountDataTooSmall
        );
        // Right length, wrong alignment — `bytemuck::from_bytes_mut` would panic here.
        assert_eq!(
            cast_mut::<u64>(&mut buf.0[1..9]).unwrap_err(),
            ProgramError::InvalidAccountData
        );
        // Control.
        assert!(cast_mut::<u64>(&mut buf.0[..8]).is_ok());
    }

    #[test]
    fn load_mut_rejects_readonly_short_and_already_borrowed_accounts() {
        // Read-only: refused before any store happens.
        let mut ro = raw::<{ size_of::<Arena>() }>(addr(1), PROGRAM, false, false);
        let mut v = view!(ro);
        assert_eq!(
            load_mut::<Arena>(&mut v).err(),
            Some(ProgramError::Immutable)
        );

        // Writable but far too small to hold an `Arena`.
        let mut small = raw::<8>(addr(1), PROGRAM, false, true);
        let mut v = view!(small);
        assert_eq!(
            load_mut::<Arena>(&mut v).err(),
            Some(ProgramError::AccountDataTooSmall)
        );

        // The duplicate-account-meta case: the same account already mutably borrowed
        // through another `AccountView`. Must be an error, never an alias.
        let mut dup = raw::<{ size_of::<Arena>() }>(addr(1), PROGRAM, false, true);
        dup.header.borrow_state = 0;
        let mut v = view!(dup);
        assert_eq!(
            load_mut::<Arena>(&mut v).err(),
            Some(ProgramError::AccountBorrowFailed)
        );
    }

    #[test]
    fn load_zeroed_rejects_a_live_account() {
        let mut r = raw::<{ size_of::<Arena>() }>(addr(1), PROGRAM, false, true);
        let mut v = view!(r);

        // Control: a freshly created account casts and is all zeroes.
        {
            let arena = load_zeroed::<Arena>(&mut v).expect("zeroed account");
            assert_eq!(arena.discriminator, DISC_UNINITIALIZED);
        }

        // Once initialized, `load_zeroed` must refuse — this is what stops a second
        // `init` resetting a match in progress.
        {
            let mut arena = load_mut::<Arena>(&mut v).expect("writable account");
            arena.discriminator = DISC_ARENA;
        }
        assert_eq!(
            load_zeroed::<Arena>(&mut v).err(),
            Some(ProgramError::AccountAlreadyInitialized)
        );

        // Stale bytes anywhere in the struct count, not just the discriminator: a
        // closed-and-reopened account is not a fresh one.
        {
            let mut arena = load_mut::<Arena>(&mut v).expect("writable account");
            arena.discriminator = DISC_UNINITIALIZED;
            arena.tick = 1;
        }
        assert_eq!(
            load_zeroed::<Arena>(&mut v).err(),
            Some(ProgramError::AccountAlreadyInitialized)
        );
    }
}
