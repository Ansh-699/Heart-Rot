# Magic Actions, Commit Sponsorship, and the Fee Vault

Research for HEARTROT settlement. Verified against live primary sources on **2026-08-31**.

> **Read this first.** The local `magicblock` skill at `~/.claude/skills/magicblock` is
> **stale**. It pins `ephemeral-rollups-sdk 0.14.3`; crates.io publishes **0.17.0**
> (2026-08-26). Between those versions `CallHandler` was deprecated, `ShortAccountMeta.pubkey`
> changed type, `ScheduleTaskArgs` fields changed from `u64` to `i64`, and the crank CPI got a
> first-class SDK helper. Several code blocks in the local skill will not compile against the
> current SDK. Details in [Where the local skill is wrong](#where-the-local-skill-is-wrong).
> The upstream skill (`magicblock-labs/magicblock-dev-skill`) is current and is a better base.

---

## 1. What a Magic Action actually is

A Magic Action is a **base-layer instruction scheduled from inside an ER transaction**, which
the committor executes on Solana immediately after the corresponding commit lands.

```
ER transaction                          Base layer (Solana)
─────────────                           ───────────────────
your ix on the rollup
  └─ CPI → Magic Program
       ScheduleIntentBundle
         ├ commit(accounts)      ──────► committed account state written
         └ post_commit_actions   ──────► your #[action] handler runs, reading
                                          the freshly committed state
```

Official framing: Magic Actions let you "attach one or more call instructions that run
automatically on the Solana base layer immediately after an Ephemeral Rollup (ER) commit."
Documented uses are state synchronization, cross-program interaction, workflow automation, and
conditional logic branching on committed state.

Two things that are **not** Magic Actions and are easy to confuse:

| Feature | Runs where | When | SDK surface |
|---|---|---|---|
| **Magic Action** (post-commit action) | Base layer | After a commit is sealed | `MagicIntentBundleBuilder … .add_post_commit_actions()` |
| **Post-delegation action** | Inside the ER | Right after an account is delegated | `delegate_account_with_actions(...)` + `.cleartext()` |

The engine-examples directory named `delegation-actions/` is the **second** one. The post-commit
Magic Actions example currently only exists at `00-LEGACY_EXAMPLES/magic-actions/`. Do not copy
`delegation-actions` expecting post-commit behaviour.

---

## 2. Pinned versions (verified 2026-08-31)

| Component | Version | Evidence |
|---|---|---|
| `ephemeral-rollups-sdk` (Rust) | **0.17.0**, published 2026-08-26 | crates.io API |
| previous: 0.16.2 (2026-07-22), 0.16.1, 0.16.0 (2026-07-15), 0.15.5 (2026-06-16) | | crates.io API |
| `@magicblock-labs/ephemeral-rollups-sdk` (npm) | **0.17.0** | npm registry |
| `ephemeral-rollups-pinocchio` (Rust) | separate crate in same repo, `rust/pinocchio/` | repo `Cargo.toml` |
| `anchor-lang` used by current examples | **1.0.2** | example `Cargo.toml`s |
| `magicblock-magic-program-api` | **0.10.1** | crank docs / examples |
| `bolt-lang` (Rust) | **0.2.6**, released **2025-09-24** | GitHub releases |
| `@magicblock-labs/bolt-sdk` (npm) | **0.2.4**, depends on ER SDK **`0.2.1`** | npm registry |

SDK cargo features on 0.17.0 (30 total; only `solana-system-interface` is default):
`access-control`, `anchor`, `anchor-compat`, `crank`, `encryption`, `instruction`, `modular-sdk`,
`spl`, `vrf`, … There is **no `pinocchio` feature** — Pinocchio support is the separate
`ephemeral-rollups-pinocchio` crate.

Example manifests, verbatim:

```toml
# delegation-actions/anchor/programs/delegation-actions/Cargo.toml
anchor-lang = { version = "1.0.2", features = ["init-if-needed"] }
ephemeral-rollups-sdk = { version = "0.16.2", features = ["anchor"] }
```

```toml
# crank-counter/anchor/programs/crank-counter/Cargo.toml
anchor-lang = { version = "1.0.2", features = ["init-if-needed"] }
# TODO: Remove this once the SDK is published to crates.io
ephemeral-rollups-sdk = { git = "https://github.com/magicblock-labs/ephemeral-rollups-sdk.git", rev = "0fc4604157de51df28693e02e5a1a6a4a08c8a03", features = [
    "anchor",
    "crank",
] }
```

Note the crank example is still on a **git rev**, not a crates.io release, even though 0.17.0
ships a `crank` feature. Their TODO says to switch once published. Treat the crank surface as the
least stable part of this stack.

Devnet ER health at time of writing (`status.magicblock.app/api/services`): `er`, `rpc_router`,
`pricing_oracle`, `vrf_oracle` all `true` for asia/europe/usa. TEE devnet has `rpc_router: false`.

---

## 3. The API surface in 0.17.0

`add_post_commit_actions` is **not** a method on `MagicIntentBundleBuilder`. It lives on the
sub-builders that `.commit()` and `.commit_and_undelegate()` return.

```rust
// MagicIntentBundleBuilder
pub fn new(payer: AccountInfo<'info>, magic_context: AccountInfo<'info>, magic_program: AccountInfo<'info>) -> Self
pub fn magic_fee_vault(self, vault: AccountInfo<'info>) -> Self
pub fn commit(self, accounts: &[AccountInfo<'info>]) -> CommitIntentBuilder<'info>
pub fn commit_and_undelegate(self, accounts: &[AccountInfo<'info>]) -> CommitAndUndelegateIntentBuilder<'info>
pub fn add_standalone_actions(self, actions: impl IntoIterator<Item = CallHandler<'info>>) -> Self
pub fn build(self) -> IntentInstructions<'info>
pub fn build_and_invoke(self) -> ProgramResult
pub fn build_and_invoke_signed(self, signers_seeds: &[&[&[u8]]]) -> ProgramResult

// CommitIntentBuilder (and CommitAndUndelegateIntentBuilder)
pub fn add_post_commit_actions(self, actions: impl IntoIterator<Item = CallHandler<'info>>) -> Self
pub fn add_post_commit_action(self, action: CallHandler<'info>) -> ActionBuilder<'info, CommitIntentBuilder<'info>, impl FnOnce(...)>
```

`CommitAndUndelegateIntentBuilder` additionally exposes `add_post_undelegate_actions`.

### Deprecations in 0.17.0

docs.rs marks these **Deprecated** in `ephemeral_rollups_sdk::ephem`:
`CallHandler`, `ActionCallback`, `CommitAndUndelegate`, `MagicInstructionBuilder`, `CommitType`,
`MagicAction`, `UndelegateType`, plus the whole `deprecated::{v0, v1}` module.

`CallHandler` being deprecated is awkward: it is still the parameter type of
`add_post_commit_actions` in the same release, and the current shipped examples still construct it.
Read this as "deprecated, still the only way", not "there is a replacement you should find". Expect
churn here in 0.18.

### `ShortAccountMeta` changed type

```rust
pub struct ShortAccountMeta {
    pub pubkey: Address,   // was Pubkey; now `Address` from the SDK's `compat` module
    pub is_writable: bool,
}
```

It deliberately has no `is_signer`. Because `pubkey` is now `Address`, code written against
older SDKs breaks. The legacy example writes `pubkey: ctx.accounts.leaderboard.key()`; the
current upstream skill writes `pubkey: ctx.accounts.leaderboard.key().to_bytes().into()`. On
0.16/0.17 use the `.to_bytes().into()` form.

`ShortAccountMeta`, `ActionArgs`, and `CallHandlerArgs` are re-exported from
`magicblock_magic_program_api::args` / `dlp_api::args` through the SDK root.

---

## 4. Verbatim working pattern: commit + post-commit action

Source: `00-LEGACY_EXAMPLES/magic-actions/programs/magic-actions/src/lib.rs`, transcribed exactly.
This compiles against the SDK version that example pins; on 0.16/0.17 apply the
`ShortAccountMeta` change from §3.

### Imports

```rust
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::anchor::{action, commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
```

### The base-layer handler, marked `#[action]`

```rust
pub fn update_leaderboard(ctx: Context<UpdateLeaderboard>) -> Result<()> {
    let leaderboard = &mut ctx.accounts.leaderboard;
    let counter_info = &mut ctx.accounts.counter.to_account_info();
    let mut data: &[u8] = &counter_info.try_borrow_data()?;
    let counter = Counter::try_deserialize(&mut data)?;

    if counter.count > leaderboard.high_score {
        leaderboard.high_score = counter.count;
    }

    msg!(
        "Leaderboard updated! High score: {}",
        leaderboard.high_score
    );
    Ok(())
}

#[action]
#[derive(Accounts)]
pub struct UpdateLeaderboard<'info> {
    #[account(mut, seeds = [LEADERBOARD_SEED], bump)]
    pub leaderboard: Account<'info, Leaderboard>,
    /// CHECK: PDA owner depends on: 1) Delegated: Delegation Program; 2) Undelegated: Your program ID
    pub counter: UncheckedAccount<'info>,
}
```

The committed account is read as `UncheckedAccount` + manual `try_deserialize`, not as a typed
`Account`. That is deliberate: while delegated, the account is **owned by the delegation program**,
so Anchor's owner check on a typed `Account` would reject it.

### What `#[action]` does

The macro appends two fields to the accounts struct if absent (`rust/action-attribute/src/lib.rs`):

```rust
/// CHECK: Escrow Authority is an account used to derive `escrow` with `escrow_index`, it is used to verify that action is scheduled with expected authority
pub escrow_auth: UncheckedAccount<'info>
/// CHECK: Escrow account that is a `signer` in callback, it is derived from `escrow_auth` and `escrow_index` one specified in `ActionArgs`
pub escrow: UncheckedAccount<'info>
```

Do **not** list `escrow_auth`/`escrow` in your `ShortAccountMeta` vector; the dispatcher supplies
them. (The published troubleshooting page says "the first two action accounts are injected
(`escrow`, `escrow_auth`)" while the macro *appends* them in the order `escrow_auth`, `escrow`.
Position and order disagree between doc and source — verify empirically on devnet before relying
on a specific index.)

### Scheduling the commit + action

```rust
pub fn commit_and_update_leaderboard(ctx: Context<CommitAndUpdateLeaderboard>) -> Result<()> {
    // Build the post-commit action that updates the leaderboard on base layer
    let instruction_data =
        anchor_lang::InstructionData::data(&crate::instruction::UpdateLeaderboard {});
    let action_args = ActionArgs::new(instruction_data);
    let action_accounts = vec![
        ShortAccountMeta {
            pubkey: ctx.accounts.leaderboard.key(),
            is_writable: true,
        },
        ShortAccountMeta {
            pubkey: ctx.accounts.counter.key(),
            is_writable: false,
        },
    ];
    let action = CallHandler {
        destination_program: crate::ID,
        accounts: action_accounts,
        args: action_args,
        // Signer that pays transaction fees for the action from its escrow PDA
        escrow_authority: ctx.accounts.payer.to_account_info(),
        compute_units: 200_000,
    };

    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit(&[ctx.accounts.counter.to_account_info()])
    .add_post_commit_actions([action])
    .build_and_invoke()?;

    Ok(())
}

#[commit]
#[derive(Accounts)]
pub struct CommitAndUpdateLeaderboard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: Account<'info, Counter>,

    /// CHECK: Leaderboard PDA - not mut here, writable set in handler
    #[account(seeds = [LEADERBOARD_SEED], bump)]
    pub leaderboard: UncheckedAccount<'info>,

    /// CHECK: Your program ID
    pub program_id: AccountInfo<'info>,
}
```

**`program_id` must be in the outer commit context.** The ER transaction needs the destination
program account present to schedule the action, even though it is not one of the handler's data
accounts. The local skill's version of this struct omits `program_id` — that omission will fail.

### `CallHandler` fields

| Field | Type | Meaning |
|---|---|---|
| `destination_program` | `Pubkey` | Program executing the action on base layer; normally `crate::ID` |
| `accounts` | `Vec<ShortAccountMeta>` | Handler's accounts. `is_writable: true` for anything it mutates |
| `args` | `ActionArgs` | `ActionArgs::new(anchor_lang::InstructionData::data(&...))` |
| `escrow_authority` | `AccountInfo` | Pays the action's base-layer fees from its escrow PDA |
| `compute_units` | `u32` | Base-layer CU budget **per action**, not per bundle |

---

## 5. Commit sponsorship and the fee vault — exact mechanics

This is the part where the marketing number ("10 free commits") maps onto real code. All of the
following is from `magicblock-validator`, `programs/magicblock/src/`.

### The constants

```rust
// programs/magicblock/src/magic_sys.rs
pub const COMMIT_LIMIT: u64 = 10;
pub const COMMIT_LIMIT_ERR: u32 = 0xA000_0000;
```

### The branch: vault or limit, never both

`process_schedule_intent_bundle.rs` chooses one path:

```rust
let magic_fee_vault = try_get_fee_vault(
    /* ... */
);
if let Some(magic_fee_vault) = magic_fee_vault {
    /* ... */
    charge_delegated_payer(&payer_account, &magic_fee_vault, fee)?;
} else {
    check_commit_limits(commit_accounts, invoke_context)?;
}
```

### `try_get_fee_vault` — the vault is required **only when the payer is delegated**

```rust
pub(crate) fn try_get_fee_vault<'a, 'ix_data>(
    transaction_context: &'a TransactionContext<'ix_data>,
    invoke_context: &InvokeContext,
    payer_idx: u16,
    fee_vault_idx: u16,
) -> Result<Option<InstructionAccount<'a, 'ix_data>>, InstructionError> {
    let payer_account =
        get_instruction_account_with_idx(transaction_context, payer_idx)?;
    let payer_requires_fee_vault = {
        let payer = payer_account.to_account_shared_data()?;
        payer.delegated() && !payer.confined()
    };
    if !payer_requires_fee_vault {
        return Ok(None);
    }

    let vault_pubkey =
        get_instruction_pubkey_with_idx(transaction_context, fee_vault_idx)?;
    if vault_pubkey != &magic_fee_vault_pubkey() {
        ic_msg!(
            invoke_context,
            "ScheduleCommit ERR: invalid magic fee vault account {}",
            vault_pubkey
        );
        return Err(InstructionError::MissingAccount);
    }

    let vault_account =
        get_instruction_account_with_idx(transaction_context, fee_vault_idx)?;
    let is_vault_writable =
        get_writable_with_idx(transaction_context, fee_vault_idx)?;
    if !vault_account.to_account_shared_data()?.delegated()
        || !is_vault_writable
    {
        ic_msg!(
            invoke_context,
            "ScheduleCommit ERR: magic fee vault must be writable and delegated"
        );
        return Err(InstructionError::IllegalOwner);
    }

    Ok(Some(vault_account))
}
```

Three consequences:

1. An **undelegated** payer never needs a vault and is never charged a live commit fee.
2. A **delegated** payer **must** pass the vault, or `MissingAccount`.
3. The vault itself must be **writable and delegated**, or `IllegalOwner`.

And critically, when the payer is undelegated the vault must **not** be passed at all — it sits at
index 2, so an unexpected vault account is read as the first committee account.

### `check_commit_limits` — the sponsored path

```rust
pub(crate) fn check_commit_limits(
    commits: &[CommittedAccount],
    invoke_context: &InvokeContext,
) -> Result<(), InstructionError> {
    let mut nonces = fetch_current_commit_nonces(commits)?;
    let mut limit_exceeded = false;
    for account in commits {
        let nonce = nonces
            .remove(&account.pubkey)
            .ok_or(InstructionError::Custom(MISSING_COMMIT_NONCE_ERR))?;
        if nonce >= COMMIT_LIMIT {
            ic_msg!(
                invoke_context,
                "ScheduleCommit ERR: sponsored commit limit exceeded for account {}: current commit nonce {} reached the limit of {}. Undelegate and re-delegate the account or use a delegated account as the payer",
                account.pubkey,
                nonce,
                COMMIT_LIMIT
            );
            limit_exceeded = true;
        }
    }
    if limit_exceeded {
        Err(InstructionError::Custom(COMMIT_LIMIT_ERR))
    } else {
        Ok(())
    }
}
```

The limit is **per committed account**, tracked by a commit nonce — not per session, not per payer.
The error message names both escapes verbatim: re-delegate, or use a delegated payer.

### Fee vault derivation

```rust
pub(crate) fn magic_fee_vault_pubkey() -> Pubkey {
    let validator_authority = crate::validator::validator_authority_id();
    Pubkey::find_program_address(
        &[b"magic-fee-vault", validator_authority.as_ref()],
        &crate::utils::DELEGATION_PROGRAM_ID,
    )
    .0
}
```

Seeds `["magic-fee-vault", validator]` under the **delegation program**
(`DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`). The vault is **per validator**, so you must read
the validator out of the delegation record at runtime rather than hardcoding it.

Client-side program-side derivation, verbatim from
`rewards-delegated-vrf/.../instructions/remove_reward.rs`:

```rust
// DelegationRecord layout: [8 discriminator][32 authority = validator][...]
let delegation_record_data = ctx.accounts.delegation_record_reward_list.try_borrow_data()?;
require!(delegation_record_data.len() >= 40, crate::errors::RewardError::InvalidDelegationRecord);
let validator = Pubkey::try_from(&delegation_record_data[8..40])
    .map_err(|_| error!(crate::errors::RewardError::InvalidDelegationRecord))?;
drop(delegation_record_data);
let (expected_fee_vault, _) = Pubkey::find_program_address(
    &[b"magic-fee-vault", validator.as_ref()],
    &ephemeral_rollups_sdk::id(),
);
require_keys_eq!(
    ctx.accounts.magic_fee_vault.key(),
    expected_fee_vault,
    crate::errors::RewardError::InvalidDelegationRecord
);
```

`ephemeral_rollups_sdk::id()` **is** the delegation program — not the SDK's own id:

```rust
pub const fn id() -> compat::Pubkey {
    compat::Pubkey::new_from_array(consts::DELEGATION_PROGRAM_ID.to_bytes())
}
```

So the skill's `&ephemeral_rollups_sdk::id()` and the validator's `&DELEGATION_PROGRAM_ID` agree.
Confusing, but correct.

### The builder side

```rust
/// Sets an optional magic fee vault account to be passed at index 2
/// (right after payer and magic_context). Required when the payer is delegated.
pub fn magic_fee_vault(mut self, vault: compat::AccountInfo<'info>) -> Self
```

### Published fee schedule

From the official fees page:

- No delegated fee payer: commits 1–10 accepted; **commit 11 fails with `0xA0000000`**.
- Session fee: **300,000 lamports (0.0003 SOL)**, taken from the deposit at undelegation.
- Deposit-charged commits: commit 1 adds no charge; commits 2, 3, 4, … add **100,000 lamports** each.
- With a delegated fee payer + `magic_fee_vault`: commits **1–25** carry no extra live commit fee;
  from commit **26** onward, **100,000 lamports per committed account**, charged immediately from
  the fee payer. **No hard commit limit applies.**
- Leftover deposit is refunded to the recorded `rent_payer` at undelegation. If the charge exceeds
  the deposit, MagicBlock takes only what is there and creates no debt.

---

## 6. Topping up a delegated fee payer: `lamportsDelegatedTransferIx`

Once your fee payer is a delegated PDA, it needs lamports **on the ER side**. You cannot just
`SystemProgram.transfer` to it. The SDK routes lamports through a single-use PDA under the
Ephemeral SPL Token program.

Verbatim from `ts/web3js/src/instructions/ephemeral-spl-token-program/ephemeralAta.ts`:

```typescript
export function lamportsDelegatedTransferIx(
  payer: PublicKey,
  destination: PublicKey,
  amount: bigint,
  salt: Uint8Array,
): TransactionInstruction {
  if (amount < 0n) {
    throw new Error("amount must be non-negative");
  }
  if (salt.length !== 32) {
    throw new Error("salt must be exactly 32 bytes");
  }

  const [rentPda] = deriveRentPda();
  const [lamportsPda] = deriveLamportsPda(payer, destination, salt);
  const destinationDelegationRecord =
    delegationRecordPdaFromDelegatedAccount(destination);

  const data = Buffer.alloc(41);
  data[0] = 20;
  data.writeBigUInt64LE(amount, 1);
  Buffer.from(salt).copy(data, 9);

  return new TransactionInstruction({
    programId: EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: rentPda, isSigner: false, isWritable: true },
      { pubkey: lamportsPda, isSigner: false, isWritable: true },
      // … delegate buffer, delegation record, delegation program, system program
    ],
  });
}
```

```typescript
export function deriveLamportsPda(
  payer: PublicKey,
  destination: PublicKey,
  salt: Uint8Array,
): [PublicKey, number] {
  if (salt.length !== 32) {
    throw new Error("salt must be exactly 32 bytes");
  }

  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("lamports"),
      payer.toBuffer(),
      destination.toBuffer(),
      Buffer.from(salt),
    ],
    EPHEMERAL_SPL_TOKEN_PROGRAM_ID,
  );
}
```

Instruction discriminator is **20**. Seeds are `["lamports", payer, destination, salt]`.

**Two SDK flavours — do not mix them.** The local skill shows an `async` signature returning
`Promise<Instruction>` with `Address` params. That is the **kit** variant
(`ts/kit/…`, `export async function`). The **web3js** variant above is **synchronous** and takes
`PublicKey`. Pick one and stay in it.

Rules that matter:
- Submit to **base layer**, not the ER. It creates accounts and triggers a delegation.
- Salt must be **exactly 32 bytes**, and **fresh per call** — a repeated
  `(payer, destination, salt)` resolves to an existing PDA and fails.
  `crypto.getRandomValues(new Uint8Array(32))`.
- The destination must **already be delegated**; the instruction reads its delegation record to
  route to the right ER.
- Payer pays the base-layer fee **and** the shuttled `amount`.

Working references: `spl-tokens/anchor/app/src/App.tsx` (`handleLamportsTransfer`) and
`rewards-delegated-vrf/anchor/dashboard/lib/instructions/sponsoredLamports.ts` — the latter tops
up a delegated PDA (`rewardListPda`) that acts as the commit fee payer, which is exactly our shape.

---

## 7. Can a crank trigger a Magic Action?

**Yes — but only with a delegated PDA payer, a fee vault, and an explicit `is_signer` workaround.**
This is the load-bearing answer for HEARTROT's settlement plan, so here is the evidence chain.

### 7a. The scheduler does not forbid it

`programs/magicblock/src/schedule_task/mod.rs`, verbatim:

```rust
// Assert that the task instructions do not have signers aside from the crank signer
// Assert they don't use the validator either
// Assert they are not a privileged instruction
pub(crate) fn validate_cranks_instructions(
    invoke_context: &mut InvokeContext,
    authority: &Pubkey,
    instructions: &[Instruction],
) -> Result<(), InstructionError> {
    let crank_signer = crank_signer_pda(authority);
    for instruction in instructions {
        for account in &instruction.accounts {
            if account.is_signer && account.pubkey.ne(&crank_signer) {
                ic_msg!(
                    invoke_context,
                    "Crank ERR: only the crank signer PDA can be a signer in cranks (invalid signer: '{}')",
                    account.pubkey,
                );
                return Err(InstructionError::MissingRequiredSignature);
            } else if account.is_writable && account.pubkey.eq(&crank_signer) {
                ic_msg!(
                    invoke_context,
                    "Crank ERR: the crank signer PDA cannot be a writable account in cranks",
                );
                return Err(InstructionError::Immutable);
            } else if account.pubkey.eq(&effective_validator_authority_id()) {
                ic_msg!(
                    invoke_context,
                    "Crank ERR: the validator authority cannot be used in cranks",
                );
                return Err(InstructionError::IncorrectAuthority);
            }
        }

        if !instruction.program_id.eq(&crate::ID) {
            continue;
        }
        // … decode as MagicBlockInstruction …
        match decoded_instruction {
            ModifyAccounts { .. }
            | CloneAccount { .. }
            | CloneAccountInit { .. }
            | CloneAccountContinue { .. }
            | SetProgramAuthority { .. }
            | DisableExecutableCheck
            | EnableExecutableCheck
            | FinalizeProgramFromBuffer { .. }
            | FinalizeV1ProgramFromBuffer { .. }
            | CleanupPartialClone { .. } => {
                ic_msg!(
                    invoke_context,
                    "Crank ERR: privileged instruction is not allowed in cranks",
                );
                return Err(InstructionError::InvalidInstructionData);
            }
            _ => continue,
        }
    }
    Ok(())
}
```

The privileged blocklist is account-cloning and program-management only.
`ScheduleIntentBundle` / `ScheduleCommit` / `ScheduleCommitAndUndelegate` / `AddActionCallback`
are **not** blocked (`_ => continue`). And this validator only inspects the **top-level scheduled
instructions** — a CPI from your own program into the Magic Program is not inspected at all.

### 7b. But the signer rule kills the obvious approach

The scheduled inner instruction may carry **no signer meta except the read-only crank signer PDA**.
The Magic Program requires the intent payer to be a signer:

```rust
// process_schedule_intent_bundle.rs
if !signers.contains(&payer_pubkey) {
    return Err(InstructionError::MissingRequiredSignature);
}
```

and the builder emits the payer as `is_signer: true, is_writable: true`.

So `#[account(mut)] pub payer: Signer<'info>` — the shape every example uses — **cannot appear in a
crank-scheduled instruction**. The payer must be a **PDA of your program**, listed in the scheduled
instruction as `is_signer: false, is_writable: true`, with the signature supplied by
`build_and_invoke_signed(&[payer_seeds])` at the nested CPI. A program may always sign for its own
PDAs regardless of who invoked it, and `ScheduleCrankCpi` exposes `invoke_signed` so a PDA can even
schedule the task.

### 7c. Which forces the vault, and one nasty workaround

- On the ER, a **writable account that is not delegated is rejected** with
  `InvalidWritableAccount`. The payer PDA is writable, so it must be **delegated**.
- A delegated payer makes `try_get_fee_vault` return `Some` ⇒ `.magic_fee_vault(...)` becomes
  **mandatory**, and the vault must be writable + delegated.
- A delegated payer needs lamports on the ER ⇒ `lamportsDelegatedTransferIx` top-ups (§6). This is
  precisely the hole that API fills.

Now the trap. From `rewards-delegated-vrf/.../instructions/shared.rs`, verbatim:

```rust
/// Workaround for ephemeral-rollups-sdk ≥0.11: `MagicIntentBundleBuilder::build()`
/// copies `is_signer` verbatim from each input AccountInfo
/// (ephem/mod.rs:233). For PDA payers and PDA escrow authorities that arrive via
/// callbacks (e.g. VRF) with `is_signer=false`, the SDK then builds the Magic
/// CPI with `is_signer=false` — and Magic rejects with `MissingRequiredSignature`.
/// We return a fresh AccountInfo with `is_signer=true`; the seeds passed to
/// `build_and_invoke_signed` give the runtime authority to honor the claim.
///
/// Inconsistent with the same builder's `build_callback_ixs`, which already
/// hardcodes `is_signer=true` for the payer (ephem/mod.rs:189). Remove once the
/// SDK applies the same convention in `build()`.
fn as_signer<'info>(signer: AccountInfo<'info>) -> AccountInfo<'info> {
    AccountInfo {
        is_signer: true,
        ..signer
    }
}
```

A crank-delivered `AccountInfo` arrives with `is_signer = false` by construction. Without
`as_signer`, the bundle fails with `MissingRequiredSignature`. **Budget for this.** It is an
upstream bug with a known local fix, not something you will guess from the docs.

### 7d. The reference implementation

`rewards-delegated-vrf/.../shared.rs::schedule_transfer_action` is the closest published analogue
to HEARTROT settlement — a PDA pays, a PDA is the escrow authority, the fee vault is attached, and
a post-commit action fires:

```rust
let action = CallHandler {
    destination_program: crate::ID,
    accounts: action_accounts,
    args: action_args,
    escrow_authority: as_signer(source.authority_info()),
    compute_units: 200_000,
};

MagicIntentBundleBuilder::new(
    payer.to_account_info(),
    magic_context.to_account_info(),
    magic_program.to_account_info(),
)
.magic_fee_vault(magic_fee_vault.to_account_info())
.commit(&[reward_list.to_account_info()])
.add_post_commit_actions([action])
.build_and_invoke_signed(payer_seeds)?;
```

with `let payer = as_signer(payer);` applied before the builder call.

### 7e. The `IllegalOwner` self-undelegation trap

From `hydra/crates/hydra-cranker/src/delegation.rs`, verbatim:

```
/// **The instruction's payer must not be the cranker**, which is why `payer` is
/// a throwaway keypair rather than the cranker itself. `process_schedule_commit`
/// marks every committee account undelegated (`set_delegated(false)`) and only
/// *then* calls `charge_delegated_payer`, which requires the payer to still be
/// delegated. With the cranker as both payer and sole committee it clears its
/// own flag and fails its own check with `IllegalOwner`.
```

**Never put the fee-payer PDA in the `commit_and_undelegate` committee set.** Undelegation clears
`delegated` on every committee account before the payer is charged; if the payer is in that set, it
fails its own check. HEARTROT's settlement undelegates the arena — keep the fee payer out of it.

Hydra's own escape is instructive: use a **throwaway undelegated keypair** as the intent payer,
which takes the no-vault path and is never debited. That works because Hydra sends the instruction
from a client that can produce a real signature. A crank cannot, so HEARTROT cannot use that trick
for the crank-fired path.

---

## 8. Wiring into HEARTROT

### The settlement path as designed

> "Settlement: a Magic Action chains the base-layer commit + leaderboard write."
> "A MagicBlock crank ticks the boss at ~400ms."
> Fire the Magic Action from the crank when it detects a win.

That is achievable. Concretely:

1. **Boss tick crank** runs the ECS tick system on the ER at ~400ms. Cheap, ER-local, no commits.
2. The tick system checks `Core.core_hp == 0` (incarnation over) and `ArenaState.phase`.
3. On a win, the **same crank iteration** builds the intent bundle:
   `.magic_fee_vault(vault).commit_and_undelegate(&[arena, boss, players…])
    .add_post_commit_actions([leaderboard_write]).build_and_invoke_signed(&[treasury_pda_seeds])`.
4. The leaderboard write handler is `#[action]`-marked, lives on base layer, and reads the
   freshly-committed `PlayerMeta.damage_dealt`.

### Accounts you must add that the spec does not mention

| Account | Why | Where it comes from |
|---|---|---|
| **Settlement fee-payer PDA** | crank cannot carry a wallet signer; must be delegated and writable | your program, delegated at match start |
| **`magic_fee_vault`** | mandatory once the payer is delegated | `["magic-fee-vault", validator]` under the delegation program, read validator from the delegation record at runtime |
| **`delegation_record` of the payer** | to recover the validator for the vault derivation | derived from the payer |
| **`program_id`** in the commit context | required to schedule the action | `crate::ID` |
| **Leaderboard PDA** | action target | base layer, never delegated |

The treasury already exists in the design ("A platform treasury funds that session wallet and pays
ALL base-layer rent and delegation costs"). Make the **settlement fee payer a distinct delegated
PDA**, topped up from the treasury via `lamportsDelegatedTransferIx` at match start. Do not reuse
the session keypair: session keys are browser-generated and undelegated, and the crank cannot sign
with them anyway.

### Commit budget

With 20 players + arena + boss delegated, the **10-commit limit is per account**. A single
end-of-match `commit_and_undelegate` is commit #1 for each. You only approach the cap if you commit
mid-match. Two viable postures:

- **Cheap:** commit only at settlement. No fee vault needed *if* the payer is undelegated — but the
  crank forces a delegated payer, so the vault is needed anyway. Attach it and stay under 25 for
  free.
- **Checkpointed:** commit every N incarnations for crash-resistance. With the vault attached,
  commits 1–25 are free per the published schedule, then 100,000 lamports per committed account.
  At 22 accounts that is 2.2M lamports (~0.0022 SOL) per commit past 25. Budget accordingly.

### Zero wallet popups

Nothing here breaks that goal — Magic Actions and cranks are program-side. The escrow authority is a
PDA, the payer is a PDA, the crank signs with a derived PDA. The player's session keypair is not
involved in settlement at all, which is exactly right.

### The `Bullets[128]` component

Worth flagging: a 128-bullet component is a large account. Commit fees past the free tier are
charged **per committed account**, not per byte, so size does not change fee arithmetic — but it
does affect the commit transaction's size and the base-layer write. Consider **not** committing
`Bullets` at settlement; it is pure transient combat state with no post-match meaning. Commit
`ArenaState`, `PlayerMeta`, and `Core`; leave `Bullets` and `Position` uncommitted.

---

## 9. Gotchas and failure modes

### Atomicity is weaker than "atomic" suggests — and the docs disagree with each other

The published troubleshooting page says "any action failure causes the entire commit to revert."
The upstream skill says something materially different and more precise:

> Within each attempted base-layer transaction, the commit and actions execute atomically. If any
> BaseAction fails, however, the committor removes all BaseActions in that affected
> `TransactionStrategy` and retries its remaining commit strategy.

Under the second description the **commit can land without your action ever running**. For a
leaderboard write that is survivable; for anything paying out value it is not. Treat
"commit succeeded" as **not** proof the action ran. Design settlement as:

- `settling` and `settled` are distinct UI states.
- The leaderboard handler is **idempotent**, keyed by `(incarnation, arena)` — a replay must not
  double-credit.
- Reconcile the base-layer effect independently before declaring a match settled.

This directly qualifies the spec's "a Magic Action chains the base-layer commit + leaderboard write"
— chained, yes; guaranteed-together, no.

### Ordered checklist of the traps

1. **`is_signer` is copied verbatim by `build()`** — PDA payer/escrow arriving with
   `is_signer=false` ⇒ `MissingRequiredSignature`. Apply `as_signer`. (§7c)
2. **Payer in the undelegate committee set** ⇒ `IllegalOwner`. (§7e)
3. **Missing `program_id` in the `#[commit]` context** ⇒ the action cannot be scheduled. (§4)
4. **Missing `#[action]`** on the handler's accounts context ⇒ not dispatchable.
5. **Vault passed with an undelegated payer** ⇒ read as the first committee account. (§5)
6. **Vault not writable, or not delegated** ⇒ `IllegalOwner`.
7. **Wrong vault pubkey** (hardcoded, wrong validator) ⇒ `MissingAccount`. The vault is
   per-validator; derive it from the delegation record.
8. **Typed `Account<'info, T>` for a committed account in the action handler** ⇒ owner check fails
   while delegated. Use `UncheckedAccount` + `try_deserialize`.
9. **`compute_units` is per action.** Three actions at 200,000 declares 600,000.
10. **`is_writable` mismatch** between the outer `#[commit]` context and the `ShortAccountMeta`
    list. They describe different transactions.
11. **Commit 11 on the sponsored path** ⇒ `0xA0000000`. Per account, not per session.
12. **Reused 32-byte salt** in `lamportsDelegatedTransferIx` ⇒ PDA already exists, fails.
13. **Crank `task_id` collisions** — the ID is **validator-global** within a scheduler instance.
    Derive a collision-resistant ID from program + arena + authority. A naive `1` will collide with
    another app.
14. **Crank scheduling is asynchronous.** A successful schedule transaction means *request
    accepted*, not *registered*. Observe registration before depending on the task.
15. **`skipPreflight: true`** for ER transactions; the ER often cannot simulate the scheduler CPI.

---

## 10. Contradictions with the frozen design spec

Listed most severe first.

### 10.1 BOLT is effectively dormant and pins a 15-versions-old ER SDK — **critical**

The spec's first line of on-chain architecture is "MagicBlock BOLT (Anchor-based ECS)". Evidence:

- `magicblock-labs/bolt` last release **v0.2.6 on 2025-09-24** — 11 months ago.
- Last substantive code commit **2025-10-19** (a CI fix). The only 2026 activity is a README edit
  on 2026-05-28. Not archived, 63 stars.
- `@magicblock-labs/bolt-sdk` npm **0.2.4** depends on
  `"@magicblock-labs/ephemeral-rollups-sdk": "0.2.1"` — against a current **0.17.0**.
- BOLT's Rust manifests use `ephemeral-rollups-sdk = "^0"` and `anchor-lang = "^0"`. On a 0.x crate,
  `^0` means `>=0.0.0, <1.0.0`, so cargo will happily float BOLT onto **0.17.0** — a version it has
  never been tested against, in which `CallHandler` is deprecated and `ShortAccountMeta.pubkey`
  changed type.
- `anchor-lang = "^0"` also means BOLT is on **Anchor 0.x**, while every current ER example pins
  **Anchor 1.0.2**. The SDK's `anchor` feature targets Anchor 1.0.x; `anchor-compat` targets 0.32.1.
  BOLT combining `features = ["anchor"]` with `anchor-lang ^0` is a live version conflict.

**Everything in this document is verified against the plain ER SDK, not against BOLT.** Before
committing to BOLT, spike exactly one thing on devnet: a BOLT system that calls
`MagicIntentBundleBuilder … .add_post_commit_actions(...)` and compiles. If that spike fails, the
options are (a) plain Anchor + ER SDK with a hand-rolled ECS, or (b) the Pinocchio path in §10.4.
This is the single highest-risk assumption in the spec and it is cheap to falsify early.

### 10.2 "Atomically chained" overstates the guarantee — **high**

Spec: "a Magic Action chains the base-layer commit + leaderboard write." Per §9, a failing
BaseAction can be **removed** and the commit retried without it. Add idempotency and a
reconciliation state; do not treat commit success as settlement.

### 10.3 The crank cannot fire settlement as naively drawn — **high**

The spec implies the crank simply fires a Magic Action on win. It can, but only after adding a
delegated fee-payer PDA, a fee vault, a lamports top-up path, and the `as_signer` workaround (§7).
That is roughly four extra accounts and one non-obvious upstream bug workaround. None of it appears
in the spec's account list. This is real, budgetable work, not a footnote.

### 10.4 The Pinocchio question — **supports the idea, with a caveat**

The user's open question — a native Pinocchio program alongside BOLT, doing CPI between them — has
a partial answer here: **MagicBlock ships a first-class Pinocchio SDK**, crate
`ephemeral-rollups-pinocchio`, in `rust/pinocchio/` of the same repo. It has real intent-bundle
support:

```
rust/pinocchio/src/intent_bundle/{args,commit,commit_and_undelegate,mod,no_vec,serialize,types}.rs
rust/pinocchio/src/instruction/delegate_with_actions.rs
rust/pinocchio/src/seeds.rs          # contains b"magic-fee-vault"
rust/pinocchio/src/acl/…             # permission program
rust/pinocchio/src/spl/…             # ephemeral SPL token
```

Its features are `delegation-actions` and `intent-bundle` (the latter is a documented no-op:
"Compatibility no-op for downstream manifests; remove in the next breaking release"). There is a
working `counter/pinocchio/` example with Rust integration tests.

So committing + undelegating from a native Pinocchio program is supported. **What I did not verify**
is whether the Pinocchio intent bundle exposes post-commit *actions* (the `CallHandler` equivalent)
— the file listing shows `commit` and `commit_and_undelegate` but no `action`/`call_handler` module
alongside them, and `delegate_with_actions` is the post-*delegation* feature. Treat
"Pinocchio can fire a Magic Action" as **unverified**; "Pinocchio can commit and undelegate" as
supported. The broader question of whether a non-BOLT program may touch BOLT component accounts is
out of this topic's scope and belongs to the sibling research.

### 10.5 Minor

- Cranks do **not** settle state to base automatically. "commit/undelegate separately when the
  resulting state must settle to base." The spec's boss-tick crank must explicitly commit; ticking
  alone changes nothing on Solana.
- The spec says "There is deliberately NO server game loop." Consistent with cranks — but note the
  crank makes **no wall-clock guarantee**. A 400ms interval is a target, not a contract. Boss
  timing logic must be tick-driven (`ArenaState.tick`), never wall-clock-driven.

---

## 11. Where the local skill is wrong

Deltas found between `~/.claude/skills/magicblock` and verified upstream/source. Fix these before
anyone codes from the local copy.

| # | Local skill says | Truth | Impact |
|---|---|---|---|
| 1 | `ephemeral-rollups-sdk = "0.14.3"` | **0.17.0** on crates.io; examples on 0.16.2 | stale by 3 minors |
| 2 | `@magicblock-labs/ephemeral-rollups-sdk: 0.14.3` | **0.17.0** | stale |
| 3 | `ScheduleCrankArgs { task_id: u64, execution_interval_millis: u64, iterations: u64 }` | all three are **`i64`** | will not compile |
| 4 | Crank via manual `bincode::serialize(&MagicBlockInstruction::ScheduleTask(...))` + `magicblock-magic-program-api` dep | SDK now ships `ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs}` behind the `crank` feature | obsolete pattern |
| 5 | `CommitAndUpdateLeaderboard` context has no `program_id` field | `program_id` is **required** | action will not schedule |
| 6 | Imports omit `use ephemeral_rollups_sdk::anchor::action;` | required for `#[action]` | will not compile |
| 7 | `ShortAccountMeta { pubkey: ctx.accounts.x.key() }` | `pubkey` is now `Address`; use `.key().to_bytes().into()` on 0.16+ | type error |
| 8 | `lamportsDelegatedTransferIx` shown as `async` returning `Promise<Instruction>` with `Address` | that is the **kit** variant; the **web3js** variant is sync, returns `TransactionInstruction`, takes `PublicKey` | wrong flavour |
| 9 | Does not mention `CallHandler` deprecation | deprecated in 0.17.0 (still required) | churn risk unflagged |
| 10 | Does not mention the `as_signer` / `is_signer` bug | real upstream bug, blocks every PDA-payer flow | would cost days |
| 11 | Does not mention the payer-in-committee `IllegalOwner` trap | real | would cost days |
| 12 | Presents commit+action as unconditionally atomic | committor can drop BaseActions and retry the commit | correctness |
| 13 | Fee vault "lifts the cap" with no numbers | 1–10 free sponsored; with vault 1–25 free then 100k lamports/account; session fee 300k | planning |
| 14 | Doesn't note `ephemeral_rollups_sdk::id()` == delegation program | it does | confusion |
| 15 | No mention of `ephemeral-rollups-pinocchio` | exists, with intent-bundle support | missed option |

Two things the local skill gets **right** that looked wrong at first glance: the fee vault seed
`["magic-fee-vault", validator]` under `ephemeral_rollups_sdk::id()` is correct (because that id
*is* the delegation program), and the delegation-record byte range `[8..40]` for the validator is
correct.

---

## 12. Open questions

1. Does BOLT 0.2.6 compile and run against ER SDK 0.16.2/0.17.0 with Anchor 1.0.2? **Spike this
   first.** (§10.1)
2. Does the Pinocchio intent bundle support post-commit *actions*, or only commit/undelegate? (§10.4)
3. `escrow_auth` / `escrow` ordering: macro appends `escrow_auth, escrow`; docs say the *first two*
   accounts are injected as `escrow, escrow_auth`. Which is it on-chain?
4. How is the action's **escrow funded**? `escrow_authority` pays "from its escrow PDA", but no
   source read here showed the escrow top-up path or what happens when it is empty. Likely
   `ephemeral_balance_seeds_from_payer` (re-exported from `dlp_api`), unverified.
5. Exact `CU` ceiling for a bundle with N actions — is the sum bounded by the base-layer 1.4M cap?
6. Is `COMMIT_LIMIT = 10` per delegation epoch or per account lifetime? The nonce resets on
   re-delegation per the error message, but the reset mechanics were not read.

---

## Sources

Every URL below was actually fetched during this research.

**Registries**
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/bolt-lang
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk/latest
- https://registry.npmjs.org/@magicblock-labs/bolt-sdk/latest

**docs.rs (SDK 0.17.0)**
- https://docs.rs/ephemeral-rollups-sdk/latest/ephemeral_rollups_sdk/ephem/index.html
- https://docs.rs/ephemeral-rollups-sdk/latest/ephemeral_rollups_sdk/ephem/struct.MagicIntentBundleBuilder.html
- https://docs.rs/ephemeral-rollups-sdk/latest/ephemeral_rollups_sdk/ephem/trait.FoldableIntentBuilder.html
- https://docs.rs/ephemeral-rollups-sdk/latest/ephemeral_rollups_sdk/ephem/commit_intent_builder/struct.CommitIntentBuilder.html
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/crank/index.html
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/struct.ShortAccountMeta.html
- https://docs.rs/crate/ephemeral-rollups-sdk/0.17.0/features

**Official documentation**
- https://docs.magicblock.gg/llms.txt
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/magic-actions/overview.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/magic-actions/implementation.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/magic-actions/troubleshooting.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics.md
- https://docs.magicblock.gg/pages/tools/crank/implementation.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/magic-actions
- https://status.magicblock.app/api/services

**Upstream skill (`magicblock-labs/magicblock-dev-skill`)**
- https://github.com/magicblock-labs/magicblock-dev-skill
- repos/magicblock-labs/magicblock-dev-skill/contents/skill/references/magic-actions.md
- repos/magicblock-labs/magicblock-dev-skill/contents/skill/references/cranks.md
- repos/magicblock-labs/magicblock-dev-skill/contents/skill/references/composition-patterns.md

**SDK source (`magicblock-labs/ephemeral-rollups-sdk`, main)**
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/consts.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/crank.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/ephem/mod.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/action-attribute/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/ts/web3js/src/instructions/ephemeral-spl-token-program/ephemeralAta.ts

**Validator / Magic Program source (`magicblock-labs/magicblock-validator`)**
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/programs/magicblock/src/schedule_transactions/mod.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/programs/magicblock/src/schedule_transactions/process_schedule_intent_bundle.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/programs/magicblock/src/schedule_task/mod.rs
- https://github.com/magicblock-labs/magicblock-validator/blob/9c7a94470af1785d88f4c671571f87c146a93779/programs/magicblock/src/schedule_task/mod.rs
- https://github.com/magicblock-labs/magicblock-validator/blob/9c7a94470af1785d88f4c671571f87c146a93779/programs/magicblock/src/schedule_task/process_execute_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/test-integration/configs/accounts/magic-fee-vault.json
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/test-integration/configs/accounts/magic-fee-vault-delegation-record.json

**Engine examples (`magicblock-labs/magicblock-engine-examples`, main)**
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/00-LEGACY_EXAMPLES/magic-actions/programs/magic-actions/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/programs/crank-counter/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/programs/crank-counter/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/delegation-actions/anchor/programs/delegation-actions/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/delegation-actions/anchor/programs/delegation-actions/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/programs/rewards-delegated-vrf/src/instructions/remove_reward.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/programs/rewards-delegated-vrf/src/instructions/shared.rs

**Other MagicBlock repos**
- https://raw.githubusercontent.com/magicblock-labs/hydra/main/crates/hydra-cranker/src/delegation.rs
- https://github.com/magicblock-labs/bolt (releases, commits, metadata via GitHub API)
