# Pinocchio Program Fundamentals — research for HEARTROT

**Researched:** 2026-08-31
**Status:** evidence-backed; every version and code block below was read from crates.io,
docs.rs, or a fresh `git clone` of the upstream repo on this date.
**Scope:** what Pinocchio is at 0.11.x, what it can and cannot do with foreign accounts,
what CPI actually costs, and whether a native Pinocchio program can live next to the
BOLT programs in HEARTROT.

> **Read this first.** The local `pinocchio-development` skill at
> `/home/anshtyagi/.claude/skills/pinocchio-development/` documents the **0.10 API and is
> stale in a way that will not compile**. It teaches `AccountInfo`, `Pubkey`,
> `account.key()`, `pinocchio::instruction::Instruction`, `AccountMeta`, and
> `pinocchio = "0.10"`. None of those names exist in 0.11.x. Corrected names are in §2.
>
> **And the frozen design spec is wrong on one factual point.** §11 of
> `docs/architecture/00-game-design-spec.md` says a Pinocchio ER integration means
> hand-rolling delegate/commit/undelegate/ScheduleTask CPIs and that
> "`pinocchio-ephemeral-rollups` does not exist". **`ephemeral-rollups-pinocchio` v0.17.0
> exists, is published by MagicBlock Labs, and shipped five days ago.** See §10.

---

## 1. What Pinocchio is

Pinocchio is Anza's minimal Rust library for writing Solana programs. Its whole idea:
the runtime hands the program one serialized byte buffer, and Pinocchio reads that buffer
**in place** through raw pointers instead of deserializing it into owned Rust structs.
An account handle is a pointer into the input region, not a `Rc<RefCell<&mut [u8]>>`.

The crate is `#![no_std]` (verbatim, first line of `sdk/src/lib.rs`) and pulls no
general-purpose dependencies — only the four purpose-built Solana on-chain type crates
listed in §2.

Practical consequences, all confirmed in source:

- No Borsh, no `solana-program`, no `std` in the dependency tree.
- Heap allocation is opt-in (`alloc` feature + `default_allocator!`) and can be banned
  outright with `no_allocator!`.
- The entrypoint parses the input buffer with pointer arithmetic; there is a "lazy"
  variant that parses nothing until you ask.
- No IDL, no account-validation DSL, no `#[derive(Accounts)]`. You write the checks.

---

## 2. Exact pinned versions (crates.io, read 2026-08-31)

| Crate | Latest | Released | Notes |
|---|---|---|---|
| `pinocchio` | **0.11.2** | 2026-06-09 | 25 versions, 904,940 total downloads |
| `pinocchio-system` | **0.6.1** | 2026-04-23 | System program CPI helpers |
| `pinocchio-token` | **0.7.0** | 2026-07-29 | SPL Token + Token-2022 via `TokenInterface` |
| `pinocchio-token-2022` | **0.4.0** | 2026-08-03 | |
| `pinocchio-associated-token-account` | **0.4.0** | 2026-04-09 | |
| `pinocchio-log` | **0.5.1** | 2025-10-03 | |
| `pinocchio-pubkey` | **0.3.0** | 2025-07-24 | ⚠️ predates the 0.11 rename; verify before use |
| **`ephemeral-rollups-pinocchio`** | **0.17.0** | **2026-08-26** | **MagicBlock official — see §10** |
| `ephemeral-rollups-sdk` | 0.17.0 | 2026-08-26 | the Anchor/`solana_program` one |
| `bolt-lang` | 0.2.4 | 2025-07-23 | 0.2.5 and 0.2.6 are **yanked** |
| `anchor-lang` | 1.1.2 stable / 2.0.0-rc.1 | 2026-06-26 / 2026-08-12 | BOLT pins `anchor-lang = "^0"` |

`pinocchio` 0.11.2's own manifest (`sdk/Cargo.toml`, verbatim):

```toml
[features]
account-resize = []
alloc = ["solana-instruction-view?/slice-cpi"]
copy = ["solana-account-view/copy", "solana-address/copy"]
cpi = ["dep:solana-instruction-view"]
default = ["alloc", "copy", "sha2"]
sha2 = ["solana-address/sha2"]
unsafe-account-resize = []

[dependencies]
solana-account-view = { workspace = true }
solana-address = { workspace = true, features = ["syscalls"] }
solana-instruction-view = { workspace = true, features = ["cpi"], optional = true }
solana-program-error = { workspace = true }
```

Workspace pins: `solana-account-view = "2.0"`, `solana-address = "2.0"`,
`solana-instruction-view = "2.1"`, `solana-program-error = "3.0"`,
`solana-define-syscall = "5.0"`, `rust-version = "1.89.0"`, `edition = "2021"`.

### 2.1 The 0.11 breaking rename — this is the thing that bites

`pinocchio` no longer defines its own account type. It **re-exports** Anza's unified
on-chain base types. From `sdk/src/lib.rs`, verbatim:

```rust
// Re-export for downstream use:
//   - `solana_account_view`
//   - `solana_address`
//   - `solana_program_error`
pub use {
    solana_account_view::{self as account, AccountView},
    solana_address::{self as address, Address},
    solana_program_error::{self as error, ProgramResult},
};
// Re-export the `solana_instruction_view` for downstream use.
#[cfg(feature = "cpi")]
pub use {solana_instruction_view as instruction, solana_instruction_view::cpi};
```

Rename table (old → new):

| 0.10 and earlier | 0.11.x |
|---|---|
| `pinocchio::account_info::AccountInfo` | `pinocchio::AccountView` |
| `pinocchio::pubkey::Pubkey` | `pinocchio::Address` |
| `account.key()` | `account.address()` |
| `account.try_borrow_data()` | `account.try_borrow()` |
| `account.try_borrow_mut_data()` | `account.try_borrow_mut()` (**`&mut self`**) |
| `account.is_owned_by(&id)` | `account.owned_by(&id)` |
| `pinocchio::instruction::Instruction` | `pinocchio::instruction::InstructionView` |
| `pinocchio::instruction::AccountMeta` | `pinocchio::instruction::InstructionAccount` |
| `pinocchio::program::invoke` | `pinocchio::cpi::invoke` |
| `accounts: &[AccountInfo]` | `accounts: &mut [AccountView]` |
| `account.realloc(n, false)` | `Resize::resize(&mut acct, n)` behind a feature |

Other 0.11.0 breaking changes, from the release notes: `assign`, `close` and
`try_borrow_mut` now take `&mut AccountView`; resize was removed from the type and moved
into two traits, `Resize` (feature `account-resize`, costs ~2 CU per account of entrypoint
overhead) and `UnsafeResize` (feature `unsafe-account-resize`, zero overhead, no bounds
validation). A `Batch` instruction was added for cheaper repeated CPI.

Because `process_instruction` now takes `&mut [AccountView]`, the idiomatic slice-pattern
destructure yields `&mut AccountView` bindings, which is exactly what `assign` and
`try_borrow_mut` need.

---

## 3. Entrypoints

Three shapes. Verbatim from `sdk/src/lib.rs` module docs.

### 3.1 Standard

```rust
use pinocchio::{
  AccountView,
  Address,
  entrypoint,
  ProgramResult
};
use solana_program_log::log;

entrypoint!(process_instruction);

pub fn process_instruction(
  program_id: &Address,
  accounts: &mut [AccountView],
  instruction_data: &[u8],
) -> ProgramResult {
  log!("Hello from my pinocchio program!");
  Ok(())
}
```

`entrypoint!` is exactly equivalent to:

```rust
program_entrypoint!(process_instruction);
default_allocator!();
default_panic_handler!();
```

### 3.2 Lazy — parse nothing until asked

```rust
use pinocchio::{
  default_allocator,
  default_panic_handler,
  entrypoint::InstructionContext,
  lazy_program_entrypoint,
  ProgramResult
};

lazy_program_entrypoint!(process_instruction);
default_allocator!();
default_panic_handler!();

pub fn process_instruction(
  mut context: InstructionContext
) -> ProgramResult {
  Ok(())
}
```

`InstructionContext` exposes `remaining()`, `next_account()`, `instruction_data()`,
`program_id()`. The docs are explicit about the tradeoff: *"suitable for programs that
have a single or very few instructions, since it requires the program to handle the
parsing, which can become complex as the number of instructions increases. For larger
programs, the `program_entrypoint!` will likely be easier and more efficient to use."*

`lazy_program_entrypoint!` sets up **no** allocator and **no** panic handler; you must
declare both yourself.

### 3.3 No allocator

```rust
program_entrypoint!(process_instruction);
default_panic_handler!();
no_allocator!();
```

Bans `Vec`, `String`, `Box`. The 32 KiB heap region goes unused, so `no_allocator!` emits
an `allocate_unchecked` helper for manual static placement:

```rust
// static allocation:
//    - 0 is the offset when the type will be allocated
//    - `allocate_unchecked` returns a mutable reference to the allocated type
let lamports = unsafe { allocate_unchecked::<u64>(0) };
*lamports = 1_000_000_000;
```

*"it is the developer's responsibility to ensure that types do not overlap in memory."*

### 3.4 Library-mode entrypoint gating (required if HEARTROT's TS/test side links the crate)

```rust
#[cfg(feature = "bpf-entrypoint")]
mod entrypoint {
  use pinocchio::{ AccountView, Address, entrypoint, ProgramResult };

  entrypoint!(process_instruction);

  pub fn process_instruction(
    program_id: &Address,
    accounts: &mut [AccountView],
    instruction_data: &[u8],
  ) -> ProgramResult {
    Ok(())
  }
}
```

Built with `cargo build-sbf --features bpf-entrypoint`.

---

## 4. `AccountView` — the complete surface

From docs.rs, `solana-account-view` **2.0.0**. This is the whole public API; there is
nothing else:

```rust
pub unsafe fn new_unchecked(raw: *mut RuntimeAccount) -> Self
pub fn address(&self) -> &Address
pub fn owner(&self) -> &Address
pub fn is_signer(&self) -> bool
pub fn is_writable(&self) -> bool
pub fn executable(&self) -> bool
pub fn data_len(&self) -> usize
pub fn lamports(&self) -> u64
pub fn set_lamports(&mut self, lamports: u64)
pub fn is_data_empty(&self) -> bool
pub fn owned_by(&self, program: &Address) -> bool
pub unsafe fn assign(&mut self, new_owner: &Address)
pub fn is_borrowed(&self) -> bool
pub fn is_borrowed_mut(&self) -> bool
pub unsafe fn borrow_unchecked(&self) -> &[u8]
pub unsafe fn borrow_unchecked_mut(&mut self) -> &mut [u8]
pub fn try_borrow(&self) -> Result<Ref<'_, [u8]>, ProgramError>
pub fn try_borrow_mut(&mut self) -> Result<RefMut<'_, [u8]>, ProgramError>
pub fn check_borrow(&self) -> Result<(), ProgramError>
pub fn check_borrow_mut(&self) -> Result<(), ProgramError>
pub fn close(&mut self) -> ProgramResult
pub unsafe fn close_unchecked(&mut self)
pub fn account_ptr(&self) -> *const RuntimeAccount
pub fn account_mut_ptr(&mut self) -> *mut RuntimeAccount
pub const fn data_ptr(&self) -> *const u8
pub fn data_mut_ptr(&mut self) -> *mut u8
```

Note what is **absent**: no `key()`, no `realloc()`, no `resize()` (moved to the `Resize`
trait), no `lamports` refcell. `set_lamports` mutates directly — the runtime, not the
type, enforces who is allowed to.

### 4.1 The input buffer layout (why this is zero-copy)

Verbatim from `sdk/src/entrypoint/mod.rs`:

```text
┌─ 8 bytes unsigned (u64): number of accounts
│
├─ For each account:
|   |
│   ├─ 1 byte: indicating if this is a duplicate account, if not a duplicate then
│   │          the value is 0xFF, otherwise the value is the index of the account
│   │          it is a duplicate of.
|   │
│   ├─ If the account is a duplicate:
|   |     |
│   │     └─ 7 bytes of padding
|   │
│   └─ If the account is not a duplicate:
|         |
│         ├─ 1 byte boolean, true if account is a signer
|         |
│         ├─ 1 byte boolean, true if account is writable
|         |
|         ├─ 1 byte boolean, true if account is executable
|         |
│         ├─ 4 bytes of padding (account data length stored here with `account-resize` feature)
|         |
│         ├─ 32 bytes: address of the account
|         |
│         ├─ 32 bytes: address of the program account owner
|         |
│         ├─ 8 bytes unsigned (u64): lamports held by the account
|         |
│         ├─ 8 bytes unsigned (u64): number of bytes of account data
|         |
│         ├─ <variable> bytes of account data
|         |
│         ├─ 10240 bytes of padding (used for resize)
|         |
│         ├─ <variable> bytes to align the offset to 8 bytes
|         |
│         └─ 8 bytes unsigned (u64): rent epoch of the account (not used)
```

An `AccountView` is a pointer into this. `try_borrow()` returns a `Ref` over the account
data slice **in the input buffer**, not a copy. That is the entire performance story.

Relevant constants: `MAX_TX_ACCOUNTS = 255`, `MAX_HEAP_LENGTH = 256 * 1024`,
`NON_DUP_MARKER = 0xFF`, `SUCCESS = 0`.

---

## 5. Zero-copy account state

Pinocchio ships no serialization. You define a `#[repr(C)]` struct and cast. The
`bytemuck` approach in the local skill still works — `bytemuck` is a normal crate, and the
struct-alignment advice in `resources/` and `docs/edge-cases.md` is still correct — but the
borrow calls in those files must be renamed per §2.1. Corrected shape:

```rust
use bytemuck::{Pod, Zeroable};
use pinocchio::{AccountView, error::ProgramError};

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct ArenaState {
    pub discriminator: u8,
    pub phase: u8,
    pub incarnation: u8,
    pub alive_count: u8,
    pub _pad: [u8; 4],       // align the u64s
    pub tick: u64,
    pub enrage_at: u64,
}

impl ArenaState {
    pub const LEN: usize = core::mem::size_of::<Self>();
    const _SIZE_CHECK: () = assert!(Self::LEN == 24);
}
```

The one rule that causes runtime panics: **after any field smaller than its successor's
alignment, pad to the boundary.** `bytemuck::from_bytes` panics on misalignment; it does
not return an error.

Alternative worth knowing about: `solana-zero-copy` is already in the pinocchio workspace
(`solana-zero-copy = "1.0.0"`), so Anza is standardizing a zero-copy layer; it is not yet
a `pinocchio` dependency.

---

## 6. CPI **out of** a Pinocchio program

This is the `cpi` feature. Types come from `solana-instruction-view` **2.1.0**.

### 6.1 Types, verbatim from source

```rust
pub const MAX_STATIC_CPI_ACCOUNTS: usize = 64;
pub const MAX_CPI_ACCOUNTS: usize = 128;
pub const MAX_RETURN_DATA: usize = 1024;

#[repr(C)]
pub struct InstructionView<'a, 'b, 'c, 'd> where 'a: 'b {
    pub program_id: &'c Address,
    pub data: &'d [u8],
    pub accounts: &'b [InstructionAccount<'a>],
}

#[repr(C)]
pub struct InstructionAccount<'a> {
    pub address: &'a Address,
    pub is_writable: bool,
    pub is_signer: bool,
}

// constructors
pub const fn new(address: &'a Address, is_writable: bool, is_signer: bool) -> Self
pub const fn readonly(address: &'a Address) -> Self
pub const fn writable(address: &'a Address) -> Self
pub const fn readonly_signer(address: &'a Address) -> Self
pub const fn writable_signer(address: &'a Address) -> Self

#[repr(C)]
pub struct Seed<'bytes>   { /* ptr + len */ }
#[repr(C)]
pub struct Signer<'bytes, 'seeds> { /* ptr + len */ }

impl<'bytes> From<&'bytes [u8]> for Seed<'bytes>
impl<'bytes, const SIZE: usize> From<&'bytes [u8; SIZE]> for Seed<'bytes>
impl<'bytes, 'seeds> From<&'seeds [Seed<'bytes>]> for Signer<'bytes, 'seeds>
impl<'bytes, 'seeds, const SIZE: usize> From<&'seeds [Seed<'bytes>; SIZE]> for Signer<'bytes, 'seeds>
```

Invocation functions:

```rust
pub fn invoke<const ACCOUNTS: usize, A: AsRef<AccountView>>(
    instruction: &InstructionView,
    account_views: &[A; ACCOUNTS],
) -> ProgramResult

pub fn invoke_signed<const ACCOUNTS: usize, A: AsRef<AccountView>>(
    instruction: &InstructionView,
    account_views: &[A; ACCOUNTS],
    signers_seeds: &[Signer],
) -> ProgramResult

pub fn invoke_with_bounds<const MAX_ACCOUNTS: usize, A: AsRef<AccountView>>(
    instruction: &InstructionView,
    account_views: &[A],
) -> ProgramResult

pub fn invoke_signed_with_bounds<const MAX_ACCOUNTS: usize, A: AsRef<AccountView>>(
    instruction: &InstructionView,
    account_views: &[A],
    signers_seeds: &[Signer],
) -> ProgramResult

pub unsafe fn invoke_signed_unchecked(
    instruction: &InstructionView,
    accounts: &[CpiAccount],
    signers_seeds: &[Signer],
)

pub fn set_return_data(data: &[u8])
pub fn get_return_data() -> Option<ReturnData>
```

`invoke`/`invoke_signed` take a **fixed-size array** and check borrows.
`*_with_bounds` take a slice with a compile-time max. `*_unchecked` skips the Rust
aliasing check and requires you to have verified `is_borrowed()` yourself — this is what
every helper crate uses in its hot path.

### 6.2 A complete real CPI, verbatim

`pinocchio-system` 0.6.1, `programs/system/src/instructions/transfer.rs`, whole file body.
This is the canonical shape for hand-rolling any CPI:

```rust
use {
    core::{mem::MaybeUninit, ptr::copy_nonoverlapping, slice::from_raw_parts},
    pinocchio::{
        cpi::{invoke_signed_unchecked, CpiAccount, Signer},
        error::ProgramError,
        instruction::{InstructionAccount, InstructionView},
        AccountView, ProgramResult,
    },
};

pub struct Transfer<'account> {
    pub from: &'account AccountView,
    pub to: &'account AccountView,
    pub lamports: u64,
}

impl Transfer<'_> {
    pub const DISCRIMINATOR: u32 = 2;

    #[inline(always)]
    pub fn invoke(&self) -> ProgramResult {
        self.invoke_signed(&[])
    }

    #[inline(always)]
    pub fn invoke_signed(&self, signers: &[Signer]) -> ProgramResult {
        // Instruction accounts.
        let mut instruction_accounts = [const { MaybeUninit::<InstructionAccount>::uninit() }; 2];
        instruction_accounts[0].write(InstructionAccount::writable_signer(self.from.address()));
        instruction_accounts[1].write(InstructionAccount::writable(self.to.address()));

        // instruction data
        // - [0..4 ]: instruction discriminator
        // - [4..12]: lamports amount
        let mut instruction_data = [const { MaybeUninit::<u8>::uninit() }; 12];
        // SAFETY: All writes are within bounds of the allocated data.
        unsafe {
            let dst = instruction_data.as_mut_ptr() as *mut u8;
            copy_nonoverlapping(Self::DISCRIMINATOR.to_le_bytes().as_ptr(), dst, size_of::<u32>());
            copy_nonoverlapping(self.lamports.to_le_bytes().as_ptr(), dst.add(4), size_of::<u64>());
        }

        let instruction = InstructionView {
            program_id: &crate::ID,
            // SAFETY: `instruction_accounts` was initialized.
            accounts: unsafe { from_raw_parts(instruction_accounts.as_ptr() as _, 2) },
            // SAFETY: `instruction_data` was initialized.
            data: unsafe { from_raw_parts(instruction_data.as_ptr() as _, 12) },
        };

        if self.from.is_borrowed() | self.to.is_borrowed() {
            return Err(ProgramError::AccountBorrowFailed);
        }

        let mut accounts = [const { MaybeUninit::<CpiAccount>::uninit() }; 2];
        CpiAccount::init_from_account_view(self.from, &mut accounts[0]);
        CpiAccount::init_from_account_view(self.to, &mut accounts[1]);

        // SAFETY: `accounts` was initialized and not borrowed.
        unsafe {
            invoke_signed_unchecked(
                &instruction,
                from_raw_parts(accounts.as_ptr() as _, 2),
                signers,
            )
        };

        Ok(())
    }
}
```

### 6.3 PDA signing, verbatim

From `ephemeral-rollups-pinocchio` 0.17.0, `src/instruction/delegate.rs` — real production
code, so this is the pattern to copy:

```rust
    // Buffer PDA seeds
    let pda_key_bytes: &[u8; 32] = pda_acc.address().as_array();

    // Find buffer PDA bump
    let buffer_pda_bump = find_buffer_pda_bump(pda_key_bytes.as_ref(), owner_program.address());

    // Buffer signer seeds
    let buffer_bump_slice = [buffer_pda_bump];
    let buffer_seed_binding = [
        Seed::from(BUFFER),
        Seed::from(pda_key_bytes.as_ref()),
        Seed::from(&buffer_bump_slice),
    ];
    let buffer_signer_seeds = Signer::from(&buffer_seed_binding);

    let data_len = pda_acc.data_len();

    CreateAccount {
        from: payer,
        to: buffer_acc,
        lamports: 0,
        space: data_len as u64,
        owner: owner_program.address(),
    }
    .invoke_signed(&[buffer_signer_seeds])?;
```

Note `let buffer_bump_slice = [buffer_pda_bump];` bound to a named local **before** being
referenced by a `Seed`. `Seed` holds a raw pointer with a `PhantomData` lifetime; a
temporary here compiles in some positions and dangles in others. Always bind the bump byte.

And the account-destructure idiom, from the same file:

```rust
    let [payer, pda_acc, owner_program, buffer_acc, delegation_record, delegation_metadata, system_program] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if !payer.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
```

---

## 7. What CPI actually costs — the number that decides this architecture

Solana's CPI cost model (SIMD-0339 active):

```
invocation_cost              = 946 CU   (1,000 CU without SIMD-0339)
instruction_data_cost        = instruction_data_len / 250
account_meta_cost            = (num_account_metas × 34) / 250
account_info_cost            = (num_account_infos × 80) / 250
per_account_data_cost        = account_data_len / 250   per non-executable account
+ callee_execution_cost
```

Measured framework overheads, from `solana-program-rosetta` (Solana Foundation's
cross-language CU benchmark suite):

| Benchmark | Rust (`solana-program`) | Pinocchio | Assembly |
|---|---|---|---|
| helloworld | 105 | — | 104 |
| transfer-lamports | 459 | **27** | 30 |
| CPI (total) | 3,698 | **2,771** | — |
| CPI (minus syscalls) | 1,198 | **271** | — |

Anchor, from the Accelerate 2025 memo-program benchmark: ~649 CU, ~281 hand-optimized;
Pinocchio ~108; assembly ~104.

**Read the CPI row carefully.** The gap between `solana-program` and Pinocchio on a CPI is
927 CU total (3,698 → 2,771), of which the syscall itself is a fixed ~2,500 CU that
neither framework can avoid. So:

> **One CPI hop costs roughly 1,000–2,500 CU. The entire framework saving of choosing
> Pinocchio over Anchor for one instruction is roughly 500 CU.**

A design that splits work into a Pinocchio program which then CPIs into a BOLT program
**spends more CU than it saves**, by a factor of two or more. Pinocchio pays off when it
*replaces* a hop, never when it *adds* one. That is the single most important number in
this document for the HEARTROT decision.

---

## 8. What a Pinocchio program can and cannot do with an account it does not own

This is a **runtime rule, not a framework rule**. Pinocchio, Anchor, BOLT and hand-written
native programs are all bound identically. Verbatim from the Solana docs' modification
rules:

**Data**
- *"Only the owner can modify data"* — `can_data_be_changed()` checks
  `is_owned_by_current_program()`.
- *"Read-only accounts cannot have data modified."*
- *"Only the owner can resize data"* when `new_len != old_len`.
- *"Max growth per instruction: 10 KiB"* (`MAX_PERMITTED_DATA_INCREASE`).

**Lamports**
- *"Only the owner can debit lamports"* — `set_lamports()` verifies
  `is_owned_by_current_program()` when the balance decreases.
- *"Any program can credit lamports to a writable account"* — no ownership restriction.
- *"Lamports must balance across an instruction"* — the delta must be zero.

**Owner**
- *"Only the current owner can reassign the owner"*, the account must be writable, and
  *"Data must be zero-initialized"* before reassignment.

So, concretely, for a HEARTROT Pinocchio program against a BOLT component account:

| Operation on a foreign account | Allowed? |
|---|---|
| Read `address()`, `owner()`, `lamports()`, `data_len()` | ✅ free |
| `try_borrow()` and read the raw component bytes | ✅ free, zero-copy |
| Decode those bytes yourself (skip Borsh, cast the struct) | ✅ and this is Pinocchio's real superpower here |
| `try_borrow_mut()` and write | ❌ runtime rejects the instruction |
| `set_lamports()` downward | ❌ rejected |
| `set_lamports()` upward (credit) | ✅ if writable |
| `assign()` a new owner | ❌ rejected |
| `Resize::resize()` | ❌ rejected |
| CPI into the owner program to make it write | ✅ — but see §9, BOLT blocks this specific path |

`AccountView` will let you *call* `try_borrow_mut()` and write bytes. The failure surfaces
at instruction end, when the runtime compares the account against its pre-image and aborts
the transaction. There is no compile-time or borrow-time guard. **Always check
`owned_by()` before mutating** — Pinocchio gives you no `#[account(mut)]` to do it for you.

CPI data sync, which matters for a read-only Pinocchio observer:
- **Pre-CPI (caller → callee):** the runtime copies the caller's in-flight modifications
  into the callee's view — lamports, data length, data content, owner. So a Pinocchio
  callee sees the caller's *uncommitted* writes, not stale on-chain state.
- **Post-CPI (callee → caller):** for writable accounts only. Lamports and owner always
  sync back; data length and content sync if modified.

---

## 9. Being CPI-called **by** an Anchor/BOLT program

### 9.1 The type-mismatch fear is misplaced

The design spec's concern — *"`ephemeral-rollups-sdk` … uses `solana_program::AccountInfo`,
which is incompatible with Pinocchio's own `AccountInfo`"* — is real, but it is a
**compile-time linking** problem, not a **CPI boundary** problem.

At a CPI boundary there are no Rust types. The caller serializes an instruction; the
runtime re-serializes the input buffer for the callee; the callee parses it with whatever
library it likes. An Anchor program calling a Pinocchio program uses `AccountInfo` on its
side and the Pinocchio program parses `AccountView` on its side, and nothing notices.

The incompatibility only bites when you try to **link** a crate that hands you
`solana_program::AccountInfo` into a Pinocchio program that wants `AccountView`. That is
precisely the problem `ephemeral-rollups-pinocchio` was published to solve (§10).

### 9.2 How Anchor/BOLT calls out to an arbitrary program

Raw `invoke`. BOLT's own World program does exactly this — verbatim from
`crates/programs/world/src/lib.rs`:

```rust
                anchor_lang::solana_program::program::invoke(
                    &anchor_lang::solana_program::system_instruction::transfer(
                        ctx.accounts.authority.key,
                        ctx.accounts.world.to_account_info().key,
                        lamports_diff,
                    ),
                    &[
                        ctx.accounts.authority.to_account_info(),
                        ctx.accounts.world.to_account_info(),
                        ctx.accounts.system_program.to_account_info(),
                    ],
                )?;
```

Swap the `system_instruction::transfer(..)` for a hand-built
`Instruction { program_id, accounts, data }` targeting the Pinocchio program and it works
unchanged. The Pinocchio side owns the wire format: pick a **1-byte discriminator**, define
the account order, and document both.

The typed alternative is Anchor's `declare_program!()`, which generates a CPI module from
an IDL placed in `/idls`. It needs an Anchor-shaped IDL, which Pinocchio does not emit.
Options: Shank (mature, Metaplex), or `pinocchio-idl` 0.1.1 — **41 total downloads, two
releases, single-author, unaudited; do not build on it.** For a four-instruction internal
program, hand-writing the `Instruction` builder is cheaper than either.

### 9.3 The BOLT-specific blocker — this is the finding that decides §11 of the spec

A BOLT component account is owned by that component's own generated Anchor program. So per
§8, a Pinocchio program cannot write it directly and would have to CPI into the component
program's `update`. **That CPI cannot succeed.** Verbatim, from BOLT 0.2.4's component
code generator, `crates/bolt-lang/attribute/bolt-program/src/lib.rs`:

```rust
            pub fn update(ctx: Context<Update>, data: Vec<u8>) -> Result<()> {
                require!(ctx.accounts.bolt_component.bolt_metadata.authority == World::id() || (ctx.accounts.bolt_component.bolt_metadata.authority == *ctx.accounts.authority.key && ctx.accounts.authority.is_signer), BoltError::InvalidAuthority);

                // Check if the instruction is called from the world program
                let instruction = anchor_lang::solana_program::sysvar::instructions::get_instruction_relative(
                    0, &ctx.accounts.instruction_sysvar_account.to_account_info()
                ).map_err(|_| BoltError::InvalidCaller)?;
                require_eq!(instruction.program_id, World::id(), BoltError::InvalidCaller);

                ctx.accounts.bolt_component.set_inner(<#component_type>::try_from_slice(&data)?);
                Ok(())
            }
```

`get_instruction_relative(0, ..)` reads the **instructions sysvar**, which contains only
the **top-level** instructions of the transaction — inner/CPI instructions are not
represented there. Offset `0` therefore resolves to the currently-executing *top-level*
instruction. The check demands that its `program_id` equal
`WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n`.

Consequence: **a transaction whose top-level instruction targets a Pinocchio program can
never write a BOLT component, at any CPI depth.** The only writer of a BOLT component is a
transaction that enters through `world::apply`.

### 9.4 The one shape that does work: Pinocchio as a BOLT *System*

Reading the World program's `apply` (verbatim, `crates/programs/world/src/lib.rs`):

```rust
    pub fn apply<'info>(
        ctx: Context<'_, '_, '_, 'info, Apply<'info>>,
        args: Vec<u8>,
    ) -> Result<()> {
        let (pairs, results) = apply_impl(
            &ctx.accounts.authority,
            &ctx.accounts.world,
            &ctx.accounts.bolt_system,
            ctx.accounts.build(),
            args,
            ctx.remaining_accounts.to_vec(),
        )?;
        for ((program, component), result) in pairs.into_iter().zip(results.into_iter()) {
            bolt_component::cpi::update(
                build_update_context(
                    program,
                    component,
                    ctx.accounts.authority.clone(),
                    ctx.accounts.instruction_sysvar_account.clone(),
                ),
                result,
            )?;
        }
        Ok(())
    }
```

and the System interface it CPIs into (`crates/programs/bolt-system/src/lib.rs`):

```rust
#[program]
pub mod bolt_system {
    use super::*;
    pub fn bolt_execute(_ctx: Context<BoltExecute>, _args: Vec<u8>) -> Result<Vec<Vec<u8>>> {
        Ok(Vec::new())
    }
}

#[derive(Accounts, Clone)]
pub struct BoltExecute<'info> {
    /// CHECK: authority check
    #[account()]
    pub authority: AccountInfo<'info>,
}
```

So a BOLT System is a program that:
1. answers the 8-byte Anchor discriminator for `bolt_execute` (`sha256("global:bolt_execute")[..8]`),
2. receives `authority` plus `remaining_accounts` = the component accounts (read-only) then any extras,
3. Borsh-decodes a `Vec<u8>` argument,
4. returns `Vec<Vec<u8>>` — one blob per component pair, in order — via `set_return_data`.

**A Pinocchio program can implement all four.** That is the only architecturally sound
place to put Pinocchio inside a BOLT world. Whether it is *worth* it is a different
question, and §7's CU math says no: the System is already reached through one CPI and its
results go back through another CPI per component. Making the middle hop 500 CU cheaper
does not move a needle that a 946-CU-per-hop pipeline is already pinning.

### 9.5 The 1,024-byte return-data ceiling on `BossTick` — flag this regardless of Pinocchio

Anchor implements a non-unit return type with `sol_set_return_data`, and
`MAX_RETURN_DATA = 1024` bytes. Every BOLT `apply` therefore has a hard budget: **all
components written by one `apply` must Borsh-serialize into under 1,024 bytes combined.**

HEARTROT's `Bullets` component is `[128] × {x: i16, y: i16, dx: i8, dy: i8, active: bool}`.
Borsh packs without padding: 7 bytes × 128 = **896 bytes**, plus `Vec<Vec<u8>>` framing
(4-byte outer count + 4-byte inner length) = **904 bytes**. That leaves ~120 bytes for
`ArenaState`, `Parts`, `Core` and `BossState` in the same tick — and BOLT components carry
a `bolt_metadata` field on top of the declared fields.

This is tight enough that it needs measuring before step 3 of the build order, and it fails
outright if the bullet struct is ever `#[repr(C)]`-padded to 8 bytes per bullet (1,024 +
framing > 1,024) or if a fifth component joins the tick. Mitigations, in laziness order:
shrink the pool below 128; split `BossTick` into two `apply` calls; or move the bullet pool
out of BOLT entirely into a plain program-owned account — which is where a Pinocchio
program would genuinely earn its keep, since it would then *own* that account and skip the
whole return-data round trip.

---

## 10. **`ephemeral-rollups-pinocchio` exists** — the spec's §11 rejection rests on a false premise

| | |
|---|---|
| Crate | `ephemeral-rollups-pinocchio` |
| Version | **0.17.0**, published **2026-08-26** |
| First published | 2025-08-27 (a full year of releases, ~30 versions) |
| Publisher | Magicblock Labs `<dev@magicblock.gg>` |
| Repository | `github.com/magicblock-labs/ephemeral-rollups-sdk`, path `rust/pinocchio` |
| Downloads | 5,655 |
| Dependencies | `pinocchio ^0.11`, `pinocchio-system ^0.6`, `solana-address >=2,<3`, `bincode 2.0.1` |

It is version-locked to the same `0.17.0` as the Anchor `ephemeral-rollups-sdk`, released
the same day, from the same workspace. It is `#![no_std]`.

Module list, verbatim from `rust/pinocchio/src/lib.rs`:

```rust
#![no_std]

extern crate alloc;

pub mod acl;
pub mod consts;
pub mod crank;
pub mod ephemeral_accounts;
pub mod instruction;
pub mod intent_bundle;
pub mod pda;
pub mod seeds;
pub mod spl;
pub mod types;
pub mod utils;
pub mod vrf;
```

Every single thing §11 of the spec says would have to be hand-rolled is already in there:

| Spec claims must be hand-rolled | Actual API in `ephemeral-rollups-pinocchio` 0.17.0 |
|---|---|
| delegate | `instruction::delegate::delegate_account(accounts, seeds, bump, config)` and `delegate_account_with_any_validator(..)`; plus `delegate_with_actions` |
| commit | `instruction::commit::commit_accounts(payer, accounts, magic_context, magic_program, magic_fee_vault, signer_seeds)` |
| undelegate | `instruction::undelegate::undelegate(delegated_account, owner_program, buffer, payer, callback_args)` and `commit_and_undelegate_accounts(..)` |
| `ScheduleTask` / the crank | the whole `crank` module — `ScheduleCrankCpi`, `ScheduleCrankCpiBuilder`, `ScheduleCrankArgs`, `CrankInstruction` |
| (not in spec) VRF | `vrf` module |
| (not in spec) Magic Actions | `delegate_with_actions`, `intent_bundle` |
| (not in spec) permissions | `acl` module |
| (not in spec) SPL in ER | `spl` module |

The crank builder, verbatim from `src/crank.rs` — this is HEARTROT's 400 ms `BossTick`
scheduling, in Pinocchio, today:

```rust
const SCHEDULE_CRANK_DISCRIMINANT: [u8; 4] = 6_u32.to_le_bytes();

pub struct ScheduleCrankArgs<'a> {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
    pub instructions: &'a [CrankInstruction<'a>],
}

pub struct ScheduleCrankCpi<'a> {
    pub payer: AccountView,
    pub magic_program: AccountView,
    pub instruction_accounts: &'a [AccountView],
    pub args: ScheduleCrankArgs<'a>,
}

impl<'a> ScheduleCrankCpi<'a> {
    pub fn builder(payer: AccountView, magic_program: AccountView) -> ScheduleCrankCpiBuilder<'a>
    pub fn invoke<const MAX_ACCOUNT_INFOS: usize>(&self, data_buf: &mut [u8]) -> ProgramResult
    pub fn invoke_signed<const MAX_ACCOUNT_INFOS: usize>(
        &self, data_buf: &mut [u8], signers_seeds: &[Signer<'_, '_>],
    ) -> ProgramResult
}
```

Builder chain: `.instruction_accounts(..)`, `.task_id(..)`, `.execution_interval_millis(400)`,
`.iterations(n)`, `.instructions(..)`, `.build()?`.

Program IDs, verbatim from `src/consts.rs`:

```rust
pub const DELEGATION_PROGRAM_ID: Address = address!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
pub const MAGIC_PROGRAM_ID: Address = address!("Magic11111111111111111111111111111111111111");
pub const MAGIC_CONTEXT_ID: Address = address!("MagicContext1111111111111111111111111111111");
pub const EPHEMERAL_VAULT_ID: Address = address!("MagicVau1t999999999999999999999999999999999");
pub const DELEGATION_RECORD: &[u8] = b"delegation";
pub const DELEGATION_METADATA: &[u8] = b"delegation-metadata";
pub const BUFFER: &[u8] = b"buffer";
pub const COMMIT_STATE: &[u8] = b"state-diff";
pub const COMMIT_RECORD: &[u8] = b"commit-state-record";
pub const EXTERNAL_UNDELEGATE_DISCRIMINATOR: [u8; 8] = [196, 28, 41, 206, 48, 37, 51, 167];
pub const MAX_POST_DELEGATION_SIGNERS: usize = 16;
```

**Bonus finding, directly relevant to spec §8's funding math.** `src/ephemeral_accounts.rs`
opens with:

> *"Ephemeral accounts are zero-balance accounts that exist only in the ephemeral rollup.
> Rent is paid by a sponsor account at 32 lamports/byte—109x cheaper than Solana's base
> rent."*

with `EPHEMERAL_RENT_PER_BYTE: u64 = 32`, `ACCOUNT_OVERHEAD: u32 = 60`, and an
`EphemeralAccount::new(..).with_signers(..).create(len)? / .resize(len)? / .close()?`
builder. The spec's "~0.005 SOL per player because the backend pays every base-layer cost"
may be an order of magnitude pessimistic if player entities can be ephemeral accounts. This
belongs in the MagicBlock research thread, but it changes the treasury sizing either way.

**What this does *not* change:** §9.3 still stands. `ephemeral-rollups-pinocchio` makes a
Pinocchio program a first-class ER citizen — it can delegate, commit, undelegate and crank
its own accounts. It does **not** let a Pinocchio program write BOLT component accounts.
The correct reading of §11 is therefore not "BOLT because Pinocchio can't reach the ER" —
that premise is dead — but "BOLT **or** Pinocchio, and mixing them buys nothing."

---

## 11. How this wires into HEARTROT

### 11.1 The three candidate placements, scored

**(a) Pinocchio as a BOLT System (`bolt_execute` implementer).**
Mechanically possible (§9.4). Requires hand-implementing the Anchor discriminator, Borsh
`Vec<u8>` decode and `Vec<Vec<u8>>` encode inside a `no_std` program — i.e. reimplementing
the parts of Anchor you were trying to escape. Saves ~500 CU on a path that already spends
~2,000 CU on two CPI hops. **Not worth it.**

**(b) Pinocchio as a separate program CPI-called by BOLT, owning its own accounts.**
Sound, and the only version with a real payoff. The Pinocchio program owns a plain
`#[repr(C)]` account — the obvious candidate being the **128-bullet pool**, which is the
one piece of HEARTROT state that is (i) large, (ii) rewritten in full every 400 ms tick,
(iii) pure arithmetic, and (iv) the exact thing about to collide with the 1,024-byte BOLT
return-data ceiling (§9.5). Outside BOLT it is a flat array a Pinocchio system can advance
in place with zero serialization. Cost: one extra ~1,000 CU CPI hop per tick, a second
program to delegate to the ER, and a second delegation lifecycle to get right.

**(c) Pinocchio program touching BOLT component accounts directly.**
**Impossible.** Read-only always (§8); writes are blocked twice over — by the runtime owner
check, and by BOLT's `get_instruction_relative` top-level-caller assertion (§9.3).

### 11.2 The lazy recommendation

Ship BOLT-only, as the spec already decided, and revisit Pinocchio only if `BossTick`
actually breaks the 1,024-byte ceiling. The spec's §11 *conclusion* survives; its
*reasoning* does not, and the reasoning is what needs correcting in the doc, because "we
can't reach the ER from Pinocchio" is now false and someone will act on it later.

The correct restatement is:

> Pinocchio was rejected not because ER integration is unavailable — `ephemeral-rollups-pinocchio`
> 0.17.0 provides delegate, commit, undelegate, crank, VRF and Magic Actions natively — but
> because a Pinocchio program cannot write BOLT component accounts at all, so mixing the two
> adds a ~1,000 CU CPI hop per tick to save ~500 CU of framework overhead, and BOLT's ECS
> shape already matches the design.

Two things to keep on the radar, in build-order terms:

- **Before step 3** (crank + bullet pool): measure the serialized return-data size of one
  `BossTick` apply. If it exceeds 1,024 bytes, placement (b) stops being an optimization
  and becomes the fix.
- **Before step 4** (funding): price ephemeral accounts against the 0.005 SOL/player
  assumption.

### 11.3 What stays unaffected

Nothing in the frontend, the four cold-path Worker routes, the session-key model or the
funding tiers is touched by any of this. This is entirely a programs/ decision.

---

## 12. Gotchas and failure modes

**API / build**
1. Any tutorial, blog post or skill file using `AccountInfo`/`Pubkey`/`key()` is pre-0.11 and will not compile. Check the version stamp before copying.
2. `entrypoint!` requires `accounts: &mut [AccountView]`. A `&[AccountView]` signature fails to match the macro.
3. `lazy_program_entrypoint!` installs no allocator and no panic handler. You must add both.
4. `no_allocator!` bans `Vec`/`String`/`Box` — including any pulled in transitively by a dependency.
5. Resizing needs the `account-resize` (validated, ~2 CU/account) or `unsafe-account-resize` (unvalidated, free) feature. `AccountView` has no `realloc`.
6. Upstream BPF target (`target_arch = "bpf"`) has no `std`: needs `#![no_std]`, `nostd_panic_handler!`, and `solana-define-syscall = { version = "5.0", features = ["unstable-static-syscalls"] }`.
7. Pinocchio is **unaudited**.
8. `pinocchio-pubkey` 0.3.0 last shipped 2025-07-24, before the rename. Verify it against 0.11 before adding it.

**Memory / zero-copy**
9. `bytemuck::from_bytes` **panics** on misalignment — it does not return an error. Pad every struct to its widest field's alignment and assert `size_of` at compile time.
10. `try_borrow` / `try_borrow_mut` are `RefCell`-style. Two live immutable borrows are fine; an immutable plus a mutable is a runtime `AccountBorrowFailed`. Drop the first, or scope it.
11. Before any `*_unchecked` CPI you must check `is_borrowed()` yourself. `pinocchio-system` does exactly this: `if self.from.is_borrowed() | self.to.is_borrowed() { return Err(ProgramError::AccountBorrowFailed); }`.

**Security — Pinocchio checks nothing for you**
12. **Owner check.** No `#[account(mut)]` equivalent. Call `owned_by(program_id)` before every mutation. Omitting it is the classic Solana account-substitution bug, and Pinocchio will happily let you write the bytes; the runtime aborts the whole transaction at instruction end.
13. **Signer check.** `is_signer()` on every authority, explicitly.
14. **PDA check.** Derive and compare, or store the bump and `create_program_address`. `find_program_address` costs up to 255 iterations — never in a per-tick loop.
15. **Overflow.** Use `checked_add`/`checked_sub`. Keep `overflow-checks = true` in `[profile.release]`.
16. **Discriminator.** One byte, unique per account type, checked on every read. There is no framework-supplied 8-byte tag.

**Seeds / CPI lifetimes**
17. Bind the bump array to a named local before wrapping it in a `Seed`. `Seed` is a raw pointer plus `PhantomData`; a temporary can dangle where the borrow checker does not catch it.
18. `MAX_CPI_ACCOUNTS = 128`, `MAX_STATIC_CPI_ACCOUNTS = 64`. `invoke_*_with_bounds::<N, _>` fails at runtime if `N` exceeds either.
19. Max CPI depth is 4.

**Interop**
20. `get_return_data()` caps at `MAX_RETURN_DATA = 1024` bytes — the same ceiling BOLT's `apply` hits (§9.5).
21. No IDL. The TypeScript client for a Pinocchio program is hand-written, Shank+Codama-generated, or nothing.
22. Any Rust crate whose API hands you `solana_program::AccountInfo` cannot be linked into a Pinocchio program. This is what forced MagicBlock to ship a separate `ephemeral-rollups-pinocchio` crate rather than feature-gating the existing SDK.

---

## 13. Confidence and open questions

**High confidence** (read from source or crates.io on 2026-08-31): all version numbers;
the 0.11 rename and its full API surface; every code block quoted verbatim; the runtime
account-modification rules; BOLT's `bolt_execute` interface and the `get_instruction_relative`
caller assertion; the existence, publisher, version and module list of
`ephemeral-rollups-pinocchio`.

**Medium confidence:** the CU benchmark figures come from `solana-program-rosetta` and the
Accelerate 2025 memo benchmark, not from a HEARTROT-shaped workload; treat them as
order-of-magnitude. The 946 CU CPI invocation cost assumes SIMD-0339 is active on devnet,
which I did not verify for the MagicBlock ER specifically.

**Open:**
1. Does the MagicBlock ER validator enforce the instructions sysvar identically to base-layer SVM? BOLT's `get_instruction_relative` check depends on it, and so does §9.3's conclusion. Everything I read assumes it does; I did not find a MagicBlock statement either way.
2. What is the exact Borsh size of one HEARTROT `apply` writeback, including each component's `bolt_metadata`? Needs measuring, not reasoning (§9.5).
3. Does `ephemeral-rollups-pinocchio` have a working end-to-end example? The crate has 5,655 downloads and a `dev-dependencies` test setup, but I found no published example program.
4. Is SIMD-0339 (946 CU CPI) live on devnet as of 2026-08-31?
5. BOLT looks quiet: `bolt-lang` 0.2.4 is from 2025-07-23, 0.2.5/0.2.6 are yanked, the last non-README commit is 2025-10-19, and it pins `anchor-lang = "^0"` while Anchor is at 1.1.2 stable / 2.0.0-rc.1. Whether that is stability or abandonment is a question for the BOLT research thread, but it is the strongest *remaining* argument for the Pinocchio direction and it has nothing to do with CU.

---

## Sources

Fetched and read on 2026-08-31.

**Crate registry (crates.io API)**
- https://crates.io/api/v1/crates/pinocchio
- https://crates.io/api/v1/crates/pinocchio-system
- https://crates.io/api/v1/crates/pinocchio-token
- https://crates.io/api/v1/crates/pinocchio-pubkey
- https://crates.io/api/v1/crates/pinocchio-log
- https://crates.io/api/v1/crates/pinocchio-associated-token-account
- https://crates.io/api/v1/crates/bolt-lang
- https://crates.io/api/v1/crates/anchor-lang
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk/0.17.0/dependencies
- https://crates.io/api/v1/crates/ephemeral-rollups-pinocchio
- https://crates.io/api/v1/crates/ephemeral-rollups-pinocchio/0.17.0/dependencies
- https://crates.io/api/v1/crates/pinocchio-idl
- https://crates.io/api/v1/crates?q=pinocchio&per_page=60

**Source, read from fresh clones**
- https://github.com/anza-xyz/pinocchio — `sdk/Cargo.toml`, `sdk/src/lib.rs`, `sdk/src/entrypoint/mod.rs`, `programs/system/src/instructions/transfer.rs`, `programs/system/src/instructions/create_account.rs`, `programs/token/Cargo.toml`, `programs/token/src/instructions/transfer.rs`, workspace `Cargo.toml`
- https://github.com/magicblock-labs/ephemeral-rollups-sdk — `rust/pinocchio/Cargo.toml`, `rust/pinocchio/src/lib.rs`, `src/crank.rs`, `src/consts.rs`, `src/pda.rs`, `src/utils.rs`, `src/ephemeral_accounts.rs`, `src/instruction/{delegate,commit,commit_and_undelegate,undelegate}.rs` (HEAD `ee4635c7`, 2026-08-28)
- https://github.com/magicblock-labs/bolt — `crates/programs/world/src/lib.rs`, `crates/programs/bolt-system/src/lib.rs`, `crates/programs/bolt-component/src/lib.rs`, `crates/bolt-lang/attribute/bolt-program/src/lib.rs`, `crates/bolt-lang/attribute/system/src/lib.rs`, `examples/system-apply-velocity/src/lib.rs`, workspace `Cargo.toml` (v0.2.4)
- https://api.github.com/repos/magicblock-labs/bolt/commits
- https://api.github.com/repos/magicblock-labs/bolt/tags
- https://raw.githubusercontent.com/anza-xyz/pinocchio/main/README.md
- https://github.com/anza-xyz/pinocchio/releases

**API documentation**
- https://docs.rs/pinocchio/0.11.2/pinocchio/
- https://docs.rs/solana-account-view/latest/solana_account_view/struct.AccountView.html
- https://docs.rs/solana-instruction-view/latest/solana_instruction_view/cpi/index.html
- https://docs.rs/solana-instruction-view/2.1.0/src/solana_instruction_view/cpi.rs.html
- https://docs.rs/solana-instruction-view/latest/solana_instruction_view/cpi/struct.Signer.html
- https://docs.rs/solana-instruction-view/latest/solana_instruction_view/struct.InstructionView.html
- https://docs.rs/solana-instruction-view/latest/solana_instruction_view/struct.InstructionAccount.html
- https://docs.rs/solana-program/latest/solana_program/sysvar/instructions/fn.get_instruction_relative.html
- https://docs.rs/solana-program/latest/solana_program/sysvar/instructions/index.html

**Runtime rules and cost model**
- https://solana.com/docs/core/accounts/modification-rules
- https://solana.com/docs/core/cpi/cpi-cost-model
- https://solana.com/docs/core/instructions/instruction-introspection
- https://docs.anza.xyz/proposals/return-data

**Benchmarks and background**
- https://raw.githubusercontent.com/joncinque/solana-program-rosetta/main/README.md
- https://raw.githubusercontent.com/deanmlittle/solana-program-rosetta/main/README.md
- https://www.helius.dev/blog/pinocchio
- https://docs.chainstack.com/docs/solana-pinocchio-vs-quasar
- https://www.anchor-lang.com/docs/features/declare-program
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup
- https://docs.magicblock.gg/pages/tools/bolt/getting-started/create-system

**Local (stale, corrected above)**
- `/home/anshtyagi/.claude/skills/pinocchio-development/SKILL.md` and `resources/cpi-reference.md`, `docs/edge-cases.md` — documents pinocchio 0.10 API
