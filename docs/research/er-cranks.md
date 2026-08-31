# Cranks / Scheduled Tasks — the HEARTROT game loop

Research date: **2026-08-31**. Target: **Solana devnet**.
Everything below was read from primary source (validator source at the exact commit
devnet is running, the SDK repo, crates.io/npm registries) rather than from memory or
from the local `magicblock` skill. Where the skill or the public docs disagree with the
source, the source wins and the disagreement is called out.

---

## 0. TL;DR for the architecture

| Question | Answer | Confidence |
|---|---|---|
| Can we tick at 400 ms? | Yes. Validator minimum is **10 ms**; 400 ms is far above it. | High |
| Is `iterations` finite? | Yes, but the type is `i64` and the only check is `>= 1`. No upper bound. A match-length crank is trivially expressible. | High |
| Can a crank re-arm itself? | **Almost certainly not** — the validator rejects any crank instruction carrying a writable signer, and `ScheduleTask` needs a writable signer payer. Re-arm must come from an outside transaction. | High (that the obvious path is blocked) / Low (on the readonly-payer loophole, §6.2) |
| Who pays for execution? | The **ER validator's own authority** signs and pays every crank transaction. Not you. | High |
| Does a failing crank retry, skip, or stop? | **Retries 10× with backoff (~26 s total), then the task is permanently deleted and never ticks again.** This is the behaviour on devnet **today** at 0.14.11, not a future change. | High (verified against source + the repo's own integration test `test_schedule_error`) |
| Schedulable from base layer? | **No.** `Magic11111111111111111111111111111111111111` does not exist on Solana devnet. Must be sent to the ER. | High (verified by RPC) |
| Per-validator concurrent task cap? | **None in the source.** Unbounded SQLite table + unbounded parallel submission. The repo's own README flags this as a concern. | Medium |
| Can we raise the crank's compute budget? | **No** — but the ceiling is now known: **400,000 CU** for the whole crank transaction. The ER uses stock Agave's `process_compute_budget_instructions`; neither `Magic111…` nor `Crank111…` is in Agave's builtin cost table, so the two-instruction crank tx gets `2 × 200,000`. | High (derivation) / confirm empirically before freezing `BossTick` |
| How many accounts may the crank touch? | **≤ 38 total account keys, hard-enforced.** `validate_supported_transaction_shape` rejects `program_id_index >= 38`, and program ids always sort last. A 46-account layout is rejected at every tick and kills the task in ~26 s. Packing all players into one `Players[20]` account is **mandatory**. | High (source at `cec4cf5`) |
| Can we use address lookup tables anywhere on the ER? | **No.** The ER rejects v0 transactions with `address_table_lookups` outright — gameplay transactions included. | High (source at `cec4cf5`) |

---

## 1. What a crank actually is

A crank is **not** an on-chain timer and **not** a smart contract that wakes itself up.
It is a row in a **SQLite database running inside the ER validator process**, plus a
`tokio` delay queue. When the delay expires, the validator constructs a normal Solana
transaction, **signs it with its own validator authority**, and submits it to itself.

```
your program  ──CPI──▶  Magic program (ScheduleTask)
                            │
                            ▼  TlsManager::enqueue(TaskRequest::Schedule)
                        validator engine
                            │
                            ▼  INSERT OR REPLACE INTO tasks
                        SQLite (tasks table)  ◀──┐
                            │                    │
                            ▼  tokio DelayQueue  │ requeue at
                        validator builds tx      │ last_exec + interval
                            │                    │
                            ▼  signs as VALIDATOR AUTHORITY
                        [noop(counter), ExecuteCrank{authority, instructions}]
                            │
                            ▼  native_invoke_as(crank_signer_pda)
                        your instruction runs ───┘
```

Three consequences fall straight out of this picture and drive everything else in
this document:

1. **The instruction list is frozen at schedule time.** `program_id`, the full
   `Vec<AccountMeta>`, and the instruction `data` are all serialized into the SQLite
   row. The crank replays exactly those bytes forever. It cannot discover new accounts.
2. **The validator is the fee payer**, so it also owns the transaction's compute budget.
3. **Task state lives in the validator's local database**, not on-chain. It is not
   part of ER state and does not survive being moved to a different validator. It
   *does* survive an ordinary restart of the same validator — `TaskSchedulerService::start`
   calls `load_persisted_tasks()`, which re-queues every row in `tasks` (§5.5).

---

## 2. Exact pinned versions

### 2.1 What devnet is actually running (verified live, 2026-08-31)

```console
$ curl -s -X POST https://devnet-as.magicblock.app/ \
    -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}'
{"jsonrpc":"2.0","result":{"feature-set":3718597879,"git-commit":"cec4cf5",
 "solana-core":"4.0.0","magicblock-core":"0.14.11"},"id":1}
```

Identical response from `devnet-us.magicblock.app` and `devnet-eu.magicblock.app` — all
three devnet regions run the same build.

`cec4cf5` resolves to `cec4cf574ace267029e9487b61780d5218256b42`, commit message
`release v0.14.11 (#1586)`, dated **2026-08-20**. Every "deployed" claim in this
document was read at that commit, not at `dev`.

### 2.2 Crates and packages

| Thing | Pin | Note |
|---|---|---|
| ER validator (devnet) | `magicblock-core 0.14.11` @ `cec4cf5` | solana-core 4.0.0 |
| `ephemeral-rollups-sdk` (crates.io) | **0.17.0** (2026-08-26) | has the `crank` module |
| `magicblock-magic-program-api` (crates.io) | **0.14.10** (2026-08-16) | one patch *behind* deployed 0.14.11 |
| `@magicblock-labs/ephemeral-rollups-sdk` (npm) | **0.17.0** (2026-08-26) | |
| `anchor-lang` | `1.0.2` | per the official crank example |
| `@coral-xyz/anchor` (npm) | `^0.32.1` | stays on 0.32.x even against an Anchor 1.0 program |

> **The local `magicblock` skill is stale.** It pins `ephemeral-rollups-sdk = 0.14.3`
> (actual: 0.17.0) and `magicblock-magic-program-api = 0.10.1` (actual: 0.14.10), and
> its crank recipe is the superseded hand-rolled-`bincode` pattern. Use §3 instead.

### 2.3 Program IDs

Read from `magicblock-magic-program-api/src/lib.rs` @ `cec4cf5`:

```rust
declare_id!("Magic11111111111111111111111111111111111111");

pub const CRANK_PROGRAM_ID: Pubkey =
    pubkey!("Crank11111111111111111111111111111111111111");

pub const CALLBACK_PROGRAM_ID: Pubkey =
    pubkey!("CaLLback11111111111111111111111111111111111");
```

---

## 3. The current correct code pattern

### 3.1 Use the SDK's `ScheduleCrankCpi` — do not hand-roll bincode

Both the public docs page and the local skill tell you to write
`bincode::serialize(&MagicBlockInstruction::ScheduleTask(...))` by hand and to add
`magicblock-magic-program-api`, `bincode` and `sha2` as direct dependencies. That is
the old pattern. `ephemeral-rollups-sdk` 0.17.0 ships
`ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, CancelCrankCpi, ScheduleTaskArgs}`,
which owns the encoding for you. Verbatim from
`rust/sdk/src/crank.rs` on the SDK's `main` branch:

```rust
pub struct ScheduleCrankCpi<'a> {
    pub payer: &'a compat::AccountInfo<'a>,
    pub magic_program: &'a compat::AccountInfo<'a>,
    pub instruction_accounts: &'a [compat::AccountInfo<'a>],
    pub args: ScheduleTaskArgs,
}

impl<'a> ScheduleCrankCpi<'a> {
    pub fn instruction(&self) -> compat::Instruction {
        let mut accounts = Vec::with_capacity(1 + self.instruction_accounts.len());
        accounts.push(AccountMeta::new(*self.payer.key.as_modern(), true));
        accounts.extend(self.instruction_accounts.iter().map(|ai| AccountMeta {
            pubkey: *ai.key.as_modern(),
            is_signer: ai.is_signer,
            is_writable: ai.is_writable,
        }));

        Instruction::new_with_bincode(
            *self.magic_program.key.as_modern(),
            &MagicBlockInstruction::ScheduleTask(self.args.clone()),
            accounts,
        )
        .compat()
    }

    pub fn invoke(&self) -> compat::ProgramResult { /* ... */ }
    pub fn invoke_signed(&self, signers_seeds: &[&[&[u8]]]) -> compat::ProgramResult { /* ... */ }
}
```

Note it constructs the payer meta as `AccountMeta::new(payer, true)` — **writable
signer**. Remember that; §6.2 turns on it.

### 3.2 `ScheduleTaskArgs` — the fields are `i64`, not `u64`

Verbatim from `magicblock-magic-program-api/src/args.rs` @ `cec4cf5` (deployed):

```rust
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct ScheduleTaskArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
    pub instructions: Vec<Instruction>,
}
```

> **CONTRADICTS the docs and the skill.** Both
> `https://docs.magicblock.gg/pages/tools/crank/implementation` and the local skill's
> `cranks.md` declare the wrapper args struct with `u64` fields. bincode encodes `u64`
> and `i64` identically as 8 little-endian bytes, so a `u64` wrapper happens to work on
> the wire for values under 2^63 — but your Anchor IDL will advertise `u64` to the
> TypeScript client, and the on-chain validation is written against signed values.
> Declare `i64`. The official example already does.

### 3.3 Full working program pattern (official `crank-counter` example, verbatim)

From `magicblock-engine-examples/crank-counter/anchor/programs/crank-counter/src/lib.rs`
on `main`:

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::MagicIntentBundleBuilder;

use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};

pub const COUNTER_SEED: &[u8] = b"counter";

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct ScheduleIncrementArgs {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
}

    // Schedules crank for increment counter
    pub fn schedule_increment<'info>(
        ctx: Context<'info, ScheduleIncrement<'info>>,
        args: ScheduleIncrementArgs,
    ) -> Result<()> {
        let increment_ix = Instruction {
            program_id: crate::ID,
            accounts: vec![AccountMeta::new(ctx.accounts.counter.key(), false)],
            data: anchor_lang::InstructionData::data(&crate::instruction::Increment {}),
        };

        ScheduleCrankCpi {
            payer: &ctx.accounts.payer,
            magic_program: &&ctx.accounts.magic_program,
            instruction_accounts: &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.counter.to_account_info(),
            ],
            args: ScheduleTaskArgs {
                task_id: args.task_id,
                execution_interval_millis: args.execution_interval_millis,
                iterations: args.iterations,
                instructions: vec![increment_ix],
            },
        }
        .invoke()?;

        Ok(())
    }
```

And the accounts context — note `UncheckedAccount`, not `Account<T>`:

```rust
#[derive(Accounts)]
pub struct ScheduleIncrement<'info> {
    /// CHECK: used for CPI
    #[account()]
    pub magic_program: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Passed to CPI - using UncheckedAccount to avoid Anchor re-serializing stale data after CPI
    #[account(mut, seeds = [COUNTER_SEED], bump)]
    pub counter: UncheckedAccount<'info>,
    /// CHECK: used for CPI
    pub program: UncheckedAccount<'info>,
}
```

**Why `UncheckedAccount` matters:** if you use `Account<'info, Counter>`, Anchor
writes the struct back out at the end of the instruction from its *pre-CPI* cached
copy, clobbering anything the CPI changed. The docs call this out and the example
enforces it. Applies to any BOLT component account you pass through the schedule
instruction.

Dependency declaration from that example's `Cargo.toml`:

```toml
[dependencies]
anchor-lang = { version = "1.0.2", features = ["init-if-needed"] }
# TODO: Remove this once the SDK is published to crates.io
ephemeral-rollups-sdk = { git = "https://github.com/magicblock-labs/ephemeral-rollups-sdk.git", rev = "0fc4604157de51df28693e02e5a1a6a4a08c8a03", features = [
    "anchor",
    "crank",
] }
```

The `TODO` is now stale — 0.17.0 is on crates.io and `docs.rs` confirms the `crank`
module is present in the published crate. Prefer:

```toml
ephemeral-rollups-sdk = { version = "0.17.0", features = ["anchor", "crank"] }
```

`crank` is declared as `crank = []` in the SDK's `Cargo.toml`, and `pub mod crank;`
is **unconditional** in `rust/sdk/src/lib.rs` — so the feature is currently inert and
the module compiles in regardless. Pass it anyway; it is what the example does and it
protects you if they later gate the module.

### 3.4 Client side (verbatim from the example's test)

**Must be sent to the ER provider, not the base-layer provider.**

```typescript
import { MAGIC_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";

const txHash = await programEphemeral.methods
  .scheduleIncrement({
    taskId: new BN(1), // Task ID can be arbitrary, used mostly to cancel cranks.
    executionIntervalMillis: new BN(1000), // Milliseconds between executions.
    iterations: new BN(3), // Number of times to execute the task.
  })
  .accounts({
    magicProgram: MAGIC_PROGRAM_ID,
    payer: providerEphemeralRollup.wallet.publicKey,
    program: program.programId,
  })
  .rpc({ skipPreflight: true, commitment: "confirmed" });
```

> The comment "Task ID can be arbitrary" is **wrong and dangerous on a shared devnet
> validator**. See §6.1.

### 3.5 Cancelling

```rust
pub struct CancelCrankCpi<'a> {
    pub authority: &'a compat::AccountInfo<'a>,
    pub task_context: &'a compat::AccountInfo<'a>,
    pub magic_program: &'a compat::AccountInfo<'a>,
    pub crank_id: i64,
}
```

> **`task_context` is a dead account — but you must still pass something.** The deployed
> `process_cancel_task` reads only index 0 (`TASK_AUTHORITY_IDX: u16 = 0`) and never touches
> index 1, and the validator's own `InstructionUtils::cancel_task_instruction` passes the
> authority alone. The SDK's `CancelCrankCpi` nonetheless emits
> `AccountMeta::new(task_context, false)` — a **writable** meta — at index 1.
> **Decision: pass the arena PDA.** It is already delegated and writable in the ER, it is
> already in `/match/settle`'s account list, and it costs nothing. Do not invent a new
> account for a field the program ignores. (If you would rather not carry the meta at all,
> build `MagicBlockInstruction::CancelTask { task_id }` with the single authority meta, the
> way the validator's own util does — but then you own the bincode/wincode encoding
> yourself, which §6.4 argues against.)

The on-chain handler only checks that `authority` is a signer; the scheduler then
checks that the stored `task.authority` matches. Verbatim from
`process_cancel_task.rs` @ `cec4cf5`:

```rust
    // Validate that the task authority is a signer
    let task_authority_pubkey = get_instruction_pubkey_with_idx(
        transaction_context,
        TASK_AUTHORITY_IDX,
    )?;
    if !signers.contains(task_authority_pubkey) { /* MissingRequiredSignature */ }
```

and in the scheduler, a mismatch is a **silent no-op**, not an error:

```rust
        // Check if the task authority is the same as the cancel request authority
        if task.authority != cancel_request.authority {
            error!(
                "Task authority {} does not match cancel request authority {}",
                task.authority, cancel_request.authority
            );
            return Ok(());
        }
```

**The task authority is whoever signed as payer on the `ScheduleTask` CPI**, captured
at schedule time (`authority: payer_pubkey` in `process_schedule_task`). For HEARTROT
that means: whichever key `/match/start` uses to schedule is the only key that can
ever cancel that match's crank.

---

## 4. The parameters, precisely

### 4.1 `execution_interval_millis` — 400 ms is comfortably legal

On-chain validation, verbatim from `process_schedule_task.rs` @ `cec4cf5`:

```rust
    // Enforce valid interval
    if args.execution_interval_millis <= 0
        || args.execution_interval_millis >= u32::MAX as i64
    {
        ic_msg!(
            invoke_context,
            "ScheduleTask ERR: execution interval must be between 1 and {} milliseconds",
            u32::MAX - 1
        );
        return Err(InstructionError::InvalidInstructionData);
    }
```

Then the scheduler service clamps it to the validator's floor:

```rust
        task.execution_interval_millis = task
            .execution_interval_millis
            .clamp(self.min_interval.as_millis() as i64, u32::MAX as i64);
```

The floor is configurable per validator:

```rust
// magicblock-config/src/consts.rs
pub const DEFAULT_TASK_SCHEDULER_MIN_INTERVAL_MILLIS: u64 = 10;
```

```toml
[task-scheduler]
reset = false
min-interval = "10ms"
failed-task-retention = "7d"
failed-task-cleanup-interval = "1h"
```

**Minimum viable interval: 10 ms** on a default-configured validator. 400 ms is 40×
that. No concern.

Note the clamp is silent: ask for 1 ms and you get 10 ms with no error. And note the
interval is a *floor on scheduling*, not a real-time guarantee — the next fire is
computed as `last_execution + interval`, so the tick will drift under load rather than
catch up. Never derive game time from wall-clock; derive it from
`ArenaState.tick`, which the design already does.

### 4.2 `iterations` — finite, but the ceiling is `i64::MAX`

The only check:

```rust
    // Enforce minimal number of iterations
    if args.iterations < 1 {
        ic_msg!(
            invoke_context,
            "ScheduleTask ERR: iterations must be at least 1"
        );
        return Err(InstructionError::InvalidInstructionData);
    }
```

**There is no upper bound and no "infinite" sentinel.** `-1` does *not* mean forever —
it is rejected. The value is stored as `executions_left` and decremented once per
*successful* execution:

```rust
        if task.executions_left > 1 {
            success_updates.push(CrankSuccessUpdate { /* decrement */ });
        } else {
            success_removals.push(CrankSuccessRemoval { /* DELETE FROM tasks */ });
        }
```

```sql
UPDATE tasks SET executions_left = executions_left - 1,
    last_execution_millis = ?, updated_at = ?
 WHERE id = ? AND updated_at = ?
```

Practically: at 400 ms, `iterations = 90_000` covers a 10-hour match. Exhaustion is a
non-problem if you size it generously and `CancelTask` at match end. **`iterations`
running out is not the failure mode you need to defend against** — §5 is.

### 4.3 What a crank instruction may not contain

Verbatim from `programs/magicblock/src/schedule_task/mod.rs`:

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
                // "only the crank signer PDA can be a signer in cranks"
                return Err(InstructionError::MissingRequiredSignature);
            } else if account.is_writable && account.pubkey.eq(&crank_signer) {
                // "the crank signer PDA cannot be a writable account in cranks"
                return Err(InstructionError::Immutable);
            } else if account.pubkey.eq(&effective_validator_authority_id()) {
                // "the validator authority cannot be used in cranks"
                return Err(InstructionError::IncorrectAuthority);
            }
        }
        // ... privileged MagicBlock instructions rejected ...
    }
```

This check runs **twice**: once at schedule time, and again inside `ExecuteCrank`
("This check prevents the validator from manually sending transactions disguised as
cranks").

The only signer your crank instruction may declare is the **crank signer PDA**:

```rust
pub const CRANK_SEED: &[u8] = b"crank-executor";
pub fn crank_signer_pda(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CRANK_SEED, authority.as_ref()],
        &crate::CRANK_PROGRAM_ID,   // Crank11111111111111111111111111111111111111
    )
    .0
}
```

and it is passed as a signer by the runtime:

```rust
    for ix in instructions {
        invoke_context.native_invoke_as(crate::id(), ix, &[crank_signer])?;
    }
```

**For HEARTROT:** `BossTick` must not require any player's session key as a signer.
Its authorization must be "the caller is the crank signer PDA for our known
scheduling authority" — a `crank_signer_pda(match_start_authority)` constant you can
derive off-chain and store on `ArenaState` at spawn, then assert against.

---

## 5. Failure modes — read this section twice

### 5.1 A failing crank dies permanently after 10 retries — on devnet, today

> **CORRECTED 2026-08-31 (verification pass).** An earlier draft of this document
> claimed the deployed validator is blind to execution failures and would tick forever
> recording successes. **That is wrong.** The deployed validator sees execution failures,
> retries them, and then permanently kills the task. Evidence below.

`send_crank_batch` @ `cec4cf5` (deployed):

```rust
                let ixs = vec![
                    InstructionUtils::noop_instruction(
                        tx_counter.fetch_add(1, Ordering::Relaxed),
                    ),
                    InstructionUtils::execute_task_instruction(
                        task.authority,
                        task.instructions.clone(),
                    ),
                ];
                let tx = Transaction::new(
                    &[validator_authority()],
                    Message::new(&ixs, Some(&validator_authority_id())),
                    blockhash,
                );
                let res = rpc_client
                    .send_transaction(&tx)
                    .await
                    .map_err(Box::new)
                    .map_err(TaskSchedulerError::from);
                (task, res)
```

It looks fire-and-forget — `send_transaction` returning `TaskSchedulerResult<Signature>`
reads like submission-only. **It is not**, because of what is on the other end of that
RPC call.

`solana_rpc_client`'s `send_transaction` sends `RpcSendTransactionConfig::default()`,
i.e. **`skip_preflight: false`**. And the ER's own `sendTransaction` handler branches on
exactly that flag — verbatim from
`magicblock-aperture/src/requests/http/send_transaction.rs` @ `cec4cf5`:

```rust
        // Based on the preflight flag, either execute and await the result,
        // or schedule (fire-and-forget) for background processing.
        if config.skip_preflight {
            TRANSACTION_SKIP_PREFLIGHT.inc();
            self.transactions_scheduler.schedule(transaction).await?;
        } else {
            self.transactions_scheduler.execute(transaction).await?;
        }
```

`execute()` is documented in `magicblock-core/src/link/transactions.rs` as "Submits a
transaction for execution and **asynchronously awaits its result** … Use it when you
need to act upon the transaction's success or failure." The `?` propagates a failed
execution out as an RPC error, which the scheduler maps to `TaskSchedulerError::Rpc`.

And `Rpc` is the retryable class:

```rust
fn is_retryable_task_execution_error(error: &TaskSchedulerError) -> bool {
    // `send_crank_batch` maps Solana send and verification failures to Rpc.
    matches!(error, TaskSchedulerError::Rpc(_))
}
```

The retry policy is **already in the deployed build** (`magicblock-task-scheduler/src/service.rs`
@ `cec4cf5`, not just on `dev`):

```rust
const MAX_TASK_EXECUTION_RETRIES: u32 = 10;
const TASK_EXECUTION_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);
const TASK_EXECUTION_RETRY_MAX_DELAY: Duration = Duration::from_secs(5);
```

`prepare_crank_failure_outcome` / `apply_crank_failure_outcome` then either re-queue with
backoff or — at `retries >= MAX_TASK_EXECUTION_RETRIES`, or for any *non*-retryable error —
push a `CrankFailedMove`, which moves the row out of `tasks` into `failed_tasks`.

**The repo's own integration test at the deployed commit proves the end-to-end behaviour**
(`test-integration/test-task-scheduler/tests/test_schedule_error.rs`, comment: *"Test that
a task with an error is unscheduled"*): it schedules a deliberately-failing task, waits,
then asserts `failed_tasks.len() == 1`, `get_task_ids().len() == 0`, `get_task(task_id)`
is `None`, and — decisively — that **the counter was never incremented**. A failing crank
is not silently counted as a success.

**Therefore, on devnet today:** if `BossTick` reverts, hits a constraint, or exhausts
compute units, the crank is retried with delays of roughly
100, 200, 400, 800, 1600, 3200, 5000, 5000, 5000, 5000 ms — **about 26 seconds** — and is
then **deleted permanently**. It never ticks again. `executions_left` is untouched by
retries; only a success decrements it.

**Detection is still entirely your responsibility.** Nothing is written on-chain, there is
no task-status RPC, and your client gets no signal. The only in-band signal is that
`ArenaState.tick` stops advancing. §7.3 is therefore mandatory — for a sharper reason than
before: you have a ~26 s window between first failure and permanent death.

### 5.2 The unreleased `dev` branch changes the plumbing, not the semantics

> **CORRECTED.** An earlier draft framed `dev` as *flipping* the behaviour. It does not.
> Deployed and `dev` both do "10 retries, then permanent death"; `dev` only changes how the
> failure reaches the scheduler — engine call instead of an RPC round-trip to itself.

On `magicblock-validator@dev`, `submit_crank` goes through the engine and flattens
the execution result:

```rust
    async fn submit_crank(
        engine: &Engine,
        message: Message,
    ) -> TaskSchedulerResult<()> {
        engine
            .transaction(message)
            .map_err(|err| TaskSchedulerError::TransactionExecution(err.to_string()))?
            .execute()
            .await
            .map_err(|err| TaskSchedulerError::TransactionExecution(err.to_string()))?
            .map_err(|err| TaskSchedulerError::TransactionExecution(err.to_string()))?;
        Ok(())
    }
```

and the retry classifier widens:

```rust
fn is_retryable_task_execution_error(error: &TaskSchedulerError) -> bool {
    // `send_crank_batch` maps engine submission and execution failures to
    // TransactionExecution; legacy Rpc failures remain retryable too.
    matches!(
        error,
        TaskSchedulerError::Rpc(_)
            | TaskSchedulerError::TransactionExecution(_)
    )
}
```

With the retry policy:

```rust
const MAX_TASK_EXECUTION_RETRIES: u32 = 10;
const TASK_EXECUTION_RETRY_BASE_DELAY: Duration = Duration::from_millis(100);
const TASK_EXECUTION_RETRY_MAX_DELAY: Duration = Duration::from_secs(5);
```

```rust
    fn task_execution_retry_delay(&self, retry: u32) -> Duration {
        let multiplier = 1u32
            .checked_shl(retry.saturating_sub(1))
            .unwrap_or(u32::MAX);
        self.slot_interval
            .max(TASK_EXECUTION_RETRY_BASE_DELAY)
            .checked_mul(multiplier)
            .unwrap_or(TASK_EXECUTION_RETRY_MAX_DELAY)
            .min(TASK_EXECUTION_RETRY_MAX_DELAY)
    }
```

The constants and the failure-outcome code are **identical to the deployed build**. The
only real difference is the error variant (`TransactionExecution` instead of `Rpc`) and
the removal of the self-directed RPC hop. Net effect on HEARTROT: **none**. Both versions
do 10 retries with backoff, then permanent death.

One second-order difference worth noting: on `dev` the engine call is direct, so a
*submission-layer* problem (blockhash staleness, RPC congestion) that today surfaces as a
retryable `Rpc` error may stop occurring. That makes `dev` slightly *more* reliable, not
less. Build the watchdog in §7.3 either way.

### 5.3 Compute units — you cannot raise the ceiling

The crank transaction is `[noop, ExecuteCrank]`. **No `ComputeBudgetInstruction` is
attached**, in either the deployed or the `dev` version. You do not construct this
transaction, so you cannot add one.

`ExecuteCrank` then `native_invoke_as`-es each of your instructions *inside* that
budget, so your system's cost, plus CPI overhead, plus BOLT's `apply` dispatch, all
come out of one fixed pot.

**The number is 400,000 CU.** Derived from source in the verification pass:

1. The ER does **not** override the compute budget. `magicblock-processor/src/executor/processing.rs`
   @ `cec4cf5` calls stock Agave directly:

   ```rust
   let limits = process_compute_budget_instructions(
       txn.program_instructions_iter(),
       &self.feature_set,
   )?;
   ```

2. With no `SetComputeUnitLimit` present, Agave's
   `ComputeBudgetInstructionDetails::calculate_default_compute_unit_limit` computes
   `non_migratable_builtins × 3_000 + non_builtins × 200_000`, capped at
   `MAX_COMPUTE_UNIT_LIMIT` (1,400,000).

3. Classification is done by `BuiltinProgramsFilter::check_program_kind`, which consults
   Agave's **compile-time** `solana-builtins-default-costs` table. `Magic11111111111111111111111111111111111111`
   is a MagicBlock builtin, not an *Agave* builtin, so it is absent from that table and is
   classified `ProgramKind::NotBuiltin`.

4. The two crank instructions are on **two different** programs, and neither is an Agave
   builtin. `InstructionUtils::noop_instruction` builds `MagicBlockInstruction::Noop`
   against `crate::id()` (`Magic111…`), while `execute_task_instruction` builds
   `MagicBlockInstruction::ExecuteCrank` against **`CRANK_PROGRAM_ID`** (`Crank111…`) —
   verified verbatim in `programs/magicblock/src/utils/instruction_utils.rs` @ `cec4cf5`.
   Both are absent from Agave's table, so both classify `NotBuiltin` and the arithmetic
   is unchanged.

⇒ 2 instructions × 200,000 = **400,000 CU** for the entire crank transaction, shared by
the noop, `ExecuteCrank` dispatch, the BOLT `world::apply` overhead, and your system.

This is comfortably more than the pessimistic "a few thousand" the first draft feared, and
Bullets[128] is very likely to fit. **Still measure it once** before freezing `BossTick` —
schedule a trivial crank on devnet and read `consumed X of Y compute units` from the crank
transaction's logs. If `Y` comes back as 400,000, the derivation above is confirmed and no
further worry is warranted.

This is the top risk to `Bullets[128]` + 20-player collision in a single tick. See
§7.2 for the mitigation.

### 5.4 Undelegation kills the crank silently

If the arena components are undelegated (match settle, or an operator undelegate)
while a crank is still armed, the crank's target accounts are no longer writable in
the ER. Given the corrected §5.1, the crank then fails, burns its 10 retries over ~26 s,
and is permanently deleted — leaving a stale `failed_tasks` row and no way to resume. Not
catastrophic, but noisy and unrecoverable. **Always `CancelTask` before undelegating**,
and treat cancel as part of the settle path, not a nicety.

### 5.5 Task state is validator-local and not durable in the way you'd hope

The `tasks` table is SQLite on the validator's disk. `[task-scheduler] reset = false`
implies operators can start with `reset = true` and wipe every pending task.

**Correction from the verification pass: an ordinary restart does NOT lose your crank.**
`TaskSchedulerService::start()` calls `load_persisted_tasks()`, which reads every row from
`tasks` and re-queues it, skipping only rows with an invalid interval or
`executions_left <= 0` (those are deleted). The earliest re-fire is clamped to
`2 × slot_interval` "to avoid scheduling before the first blockhash is produced on restart."
So the real loss vectors are narrower than feared: `reset = true` on startup, a move to a
*different* validator (region failover), or disk loss. There is still no on-chain record of
the schedule that you can read back to check.
**There is no RPC to query "is my task still alive."** Liveness must be inferred from
`ArenaState.tick` (§7.3).

---

## 6. Gotchas

### 6.1 `task_id` is a GLOBAL namespace across the whole validator — not per-program

The `tasks` table is keyed on `id` alone. The authority is checked only *after* a
lookup by id:

```rust
        // Check if the task already exists in the database
        if let Some(db_task) = self.db.get_task(task_id).await? {
            if db_task.authority != task.authority {
                return Err(TaskSchedulerError::UnauthorizedReplacing(
                    task_id,
                    db_task.authority.to_string(),
                    task.authority.to_string(),
                ));
            }
        }
```

So on a **shared devnet ER**, if any other dApp has already scheduled `task_id = 1`,
your `task_id = 1` schedule **fails**. And the failure is recorded to a local
`failed_scheduling` table — your `ScheduleTask` CPI already returned `Ok`, so your
transaction succeeds and you get no error at all.

> **CONTRADICTS the official example**, whose test comment reads "Task ID can be
> arbitrary, used mostly to cancel cranks," and which uses `taskId: new BN(1)`.

**For HEARTROT:** never use small sequential ids. Derive a wide random `i64` per match
(e.g. the first 8 bytes of the arena PDA, masked to positive) and store it on
`ArenaState` so `/match/settle` can cancel it. Two concurrent matches must never share
an id — the second would silently replace the first's crank.

### 6.2 A crank cannot re-arm itself (the obvious path is blocked)

This directly threatens "the crank runs the game, no daemon."

`ScheduleTask` requires its payer at index 0 to be a **signer**, and `ScheduleCrankCpi`
builds it as `AccountMeta::new(payer, true)` — writable *and* signer. Now apply
`validate_cranks_instructions` to a crank instruction that tries to schedule:

- payer ≠ crank signer → `is_signer && pubkey != crank_signer` → **`MissingRequiredSignature`**
- payer = crank signer → `is_writable && pubkey == crank_signer` → **`Immutable`**

Both doors are shut. A crank cannot contain a `ScheduleTask` built the normal way.

**The loophole is more plausible than the first draft allowed — and still the wrong
choice.** `process_schedule_task` only checks `signers.contains(&payer_pubkey)`; it never
checks `is_writable`. And the verification pass found a *deployed-commit integration test*
that proves the shape is legal:
`test-integration/test-task-scheduler/tests/test_use_crank_signer.rs` schedules a crank
whose instruction carries `AccountMeta::new_readonly(crank_signer, true)` and asserts the
counter increments — so a read-only `crank_signer` signer inside a crank both passes
`validate_cranks_instructions` and is actually signed at execution time. A nested
`ScheduleTask` with `AccountMeta::new_readonly(crank_signer, true)` as payer therefore has
a real chance of working.

**Decision: do not use it.** Two reasons that do not depend on whether it works. (1) The
re-armed task's `authority` becomes the crank signer PDA, so your scheduling key can no
longer `CancelTask` it — you would create a crank you cannot stop, on a validator with no
task-status RPC. (2) It is untested by MagicBlock, undocumented, and the `dev` branch is
already rewriting this code path.

**Use the boring answer:** `iterations` has no upper bound (§4.2). Schedule once at
`/match/start` with `iterations` sized well past any plausible match, and `CancelTask` at
settle. Re-arming becomes unnecessary, which is exactly the lazy path.

### 6.3 The crank's account list is frozen at schedule time

The full `Vec<AccountMeta>` is serialized into the SQLite row and replayed verbatim.
**A crank cannot see an account you did not name when you scheduled it.**

**For HEARTROT this is a hard design constraint.** `BossTick` advances 128 bullets and
must collide them against player positions, and `bullets_per_volley = 3 + alive_players`
requires reading player state. Every `Position` and `Health` component account for all
20 player slots must therefore be in the crank's account list from the moment it is
scheduled. Consequences:

- **Pre-allocate all 20 player entities at `/match/start`**, before scheduling, and
  pass all of their component accounts. Do not create player entities lazily on join.
- If you must support joins that create new accounts mid-match, the only way to extend
  the account list is `CancelTask` + re-`ScheduleTask` with the new list — from an
  outside transaction, since §6.2 blocks doing it from inside the crank.

**Account-count budget (revised in the verification pass).** Each account in the frozen
list is paid for twice: 34 bytes inside the serialized `ScheduleTask` instruction *data*
(`AccountMeta` = 32 + is_signer + is_writable), plus ~33 bytes in the outer transaction's
account-key table and index list. Call it ~67 bytes per account. 20 players × 2 components
+ arena + boss + bullets + world + program + payer ≈ 46 accounts ≈ 3.1 KB.

> **CORRECTED 2026-09-01 (second verification pass).** The first draft called this a hard
> block against a 1232-byte transaction limit; the first verification pass demoted it to a
> "danger zone" bounded by `MAX_TX_ACCOUNT_LOCKS` (64). **Both are wrong, and the real
> ceiling is tighter than either.** Corrected below.

Three separate things were confirmed by reading the deployed aperture:

1. **There is no byte-size check.** `prepare_transaction` in
   `magicblock-aperture/src/requests/http/mod.rs` @ `cec4cf5` base64/base58-decodes and
   `bincode::deserialize`s with no length check. 1232 is a UDP/QUIC packet constraint and
   you reach the ER over HTTP JSON-RPC, so it does not apply.

2. **`MAX_TX_ACCOUNT_LOCKS` (64) is NOT enforced by the ER.**
   `magicblock-processor/src/executor/processing.rs` @ `cec4cf5` calls
   `transaction.get_account_locks_unchecked()`, and the ER's own `sanitize` impl
   (`magicblock-core/src/link/transactions.rs`) goes straight to
   `SanitizedTransaction::try_create` with no lock validation. So 64 is not a real ceiling
   here either.

3. **The real, hard ceiling is ~38 total account keys**, and it *is* enforced — on every
   transaction, at both schedule time and every tick.
   `validate_supported_transaction_shape` (`transaction_validation.rs` @ `cec4cf5`) is
   called unconditionally from `prepare_transaction` and rejects any instruction whose
   `program_id_index >= 38`:

   ```rust
   // Solana's builtin-program filters in compute-budget processing assume program
   // indices fit within a packet-bounded pubkey table (1232 / 32 = 38).
   const MAX_RUNTIME_PROGRAM_ID_INDEX_EXCLUSIVE: usize = 1232 / size_of::<Pubkey>();
   ```

   That is a limit on the *index*, not the count — but Solana's message compiler
   (`CompiledKeys::try_into_message_components`) emits account keys in the order
   *writable signers → readonly signers → writable non-signers → **readonly non-signers***,
   and program ids are always readonly non-signers. **Program ids therefore sort last**, so
   "program_id_index ≤ 37" collapses to **"the transaction must have ≤ 38 distinct account
   keys"** in any transaction whose accounts are mostly writable — which is exactly the
   shape of a `BossTick`.

**What this does to the 46-account layout: it kills it outright.** The validator-built
crank transaction (`execute_task_instruction` @ `cec4cf5`) puts *every* frozen account into
the message — validator authority, `crank_signer_pda`, each instruction's `program_id`, and
each instruction account — and is then submitted through the same `prepare_transaction`
path. With ~44 writable component accounts, `Magic111…` and `Crank111…` land at indices
~45+ and the crank transaction is **rejected at every single tick**. It fails as
`TaskSchedulerError::Rpc`, which is retryable, so it burns the 10-retry ladder and the task
is permanently deleted ~26 s after `/match/start` (§5.1). The scheduling transaction from
the browser hits the same wall for the same reason.

**Decision (now mandatory, not prudential): pack player state into one array account.**
Store all 20 players' `Position` and `Health` in a single `Players[20]` component account,
exactly the way `Bullets[128]` is already a single account. The frozen list becomes
≈ 10 keys — validator authority, `crank_signer_pda`, `Magic111…`, `Crank111…`, world
program, boss-tick system program, arena, boss, bullets, players — comfortably under 38,
and it also removes 40 account deserializations from a CU budget you cannot raise (§5.3).

**Address lookup tables cannot rescue a wide layout.** Two independent reasons: the metas
live in the instruction *data*, not the message's account keys; and the ER **rejects v0
transactions carrying address table lookups outright** —
`"v0 transactions with address lookup tables are not supported"`, same function. That second
point is project-wide, not crank-specific: no HEARTROT transaction sent to the ER, gameplay
included, may use an ALT.

### 6.4 The wire format is changing from bincode to wincode

The deployed devnet program decodes with bincode:

```rust
// programs/magicblock/src/magicblock_processor.rs @ cec4cf5
    bincode::deserialize(
```

The `dev` branch has already migrated:

```rust
// programs/magicblock/src/magicblock_processor.rs @ dev
use wincode::{SchemaRead, config::DefaultConfig};

fn deserialize_instruction<T>(invoke_context: &mut InvokeContext) -> Result<T, InstructionError>
where T: for<'de> SchemaRead<'de, DefaultConfig, Dst = T>
{
    wincode::deserialize(/* ... */).map_err(|_| InstructionError::InvalidInstructionData)
}
```

with the schedule/cancel builders switched to `Instruction::new_with_wincode`, and a
`backward-compat` feature gating the old bincode path.

**Today, bincode is correct on devnet.** But this is a breaking wire change already
merged upstream and unreleased. When devnet moves past 0.14.11, a program compiled
against a bincode-era SDK will start failing `ScheduleTask` with
`InvalidInstructionData`. Using `ScheduleCrankCpi` from the SDK (§3.1) rather than
hand-rolling bincode means this becomes a dependency bump instead of a rewrite — a
concrete, non-hypothetical reason to prefer the SDK path over the skill's recipe.

### 6.5 A crank cannot be scheduled from the base layer

Verified by direct RPC against Solana devnet:

```console
$ curl -s -X POST https://api.devnet.solana.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
       "params":["Magic11111111111111111111111111111111111111",{"encoding":"base64"}]}'
{"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.0-beta.2","slot":491053092},"value":null},"id":1}
```

`value: null` — the account does not exist. Same for
`Crank11111111111111111111111111111111111111`. The Magic program is a **native builtin
of the ER runtime**, not a deployed BPF program. A base-layer CPI to it cannot resolve.

**The `ScheduleTask` transaction must be sent to the ER endpoint**, after the target
accounts are already delegated. Ordering at `/match/start` is therefore forced:
initialize on base → delegate on base → wait for delegation to propagate → schedule on
the ER. That is three sequential round-trips before the first tick; budget for it in
the match-start UX.

### 6.6 No per-validator concurrent task limit exists in the source

I searched the scheduler for any cap (`max_tasks`, `task_limit`, `MAX_CONCURRENT`,
capacity checks) and found **none**. Tasks go into an unbounded SQLite table and an
unbounded `tokio_util::time::DelayQueue`, and each due task is submitted as its own
transaction via an unbounded `JoinSet`. The repo's own README flags this:

> "Same-tick delay-queue draining; crank sends parallelize `send_transaction`
> (consider bounding concurrency under heavy load)."

So the practical limit is the validator's transaction throughput and the operator's
patience, not an enforced number. Two things follow:

- **One crank per match, not one per entity.** 20 player cranks × N matches would put
  you in exactly the "heavy load" regime the maintainers are worried about. The design
  spec's single `BossTick` crank is the right shape — keep it that way.
- **You are sharing a devnet validator with everyone else.** Your 400 ms tick competes
  with other tenants' tasks for the same submission path. Delegating to a specific
  validator (via `DelegateConfig { validator: Some(pubkey) }`, which the example
  supports through `remaining_accounts`) at least makes which validator you're
  contending on a deliberate choice rather than a lottery.

Confidence: **Medium**. Absence of a cap in the source is solid; whether MagicBlock
enforces one operationally, out of band, is not something I could verify.

---

## 7. How this wires into HEARTROT

### 7.1 The `BossTick` crank instruction is a BOLT `apply`, hand-built

BOLT systems execute through the World program's `apply` instruction, so the
`Instruction` you hand to `ScheduleTaskArgs.instructions` is a `world::apply` call, not
a direct call into your program:

```rust
let boss_tick_ix = Instruction {
    program_id: WORLD_PROGRAM_ID,
    accounts: vec![
        // world, boss-tick system program, then every component account
        // BossTick will touch — arena, boss, bullets, and all 20 players.
        // FROZEN HERE FOR THE LIFE OF THE CRANK. See §6.3.
    ],
    data: /* world apply discriminator + BossTick args */,
};
```

Build it explicitly rather than through the Anchor client — you need exact control over
the metas, and **none of them may be marked `is_signer`** (§4.3).

### 7.2 Reconcile the 128-bullet pool with the unraisable CU ceiling

The design's central bet — a fixed 128-bullet pool advanced by the crank, rather than
an entity per bullet — is *correct*, and for a better reason than the spec states: it
is not just about avoiding account creation, it is that the crank's account list is
frozen (§6.3), so per-bullet entities would be structurally impossible, not merely
expensive. Keep the pool.

But the pool must fit in a compute budget you cannot raise — **400,000 CU**, derived from
source in §5.3. Before writing `BossTick`:

1. Confirm the 400,000 empirically once, from a trivial crank's `consumed X of Y` log line.
2. Cost one tick: 128 bullet position updates + 128×20 collision tests is 2,560 pair
   checks. Against 400k CU that is comfortable if the inner loop is arithmetic on data
   already in registers — and *not* comfortable if each check re-reads an account. This is
   the second reason to pack all players into one `Players[20]` account (§6.3): 40 account
   deserializations would dominate the tick.
3. If it still does not fit, the lazy fixes in order: spatial-hash the collision test by
   zone so a bullet only tests players in its own zone; drop the pool to 64; or split
   the work across two interleaved cranks at 800 ms each with different `task_id`s
   (bullets 0-63 and 64-127) — but note that two cranks means two independent things
   that can die, doubling the surface area of §5.

The user's prior CU-optimisation work on a 4,096-cell bitboard automaton is directly
applicable: bitboard the bullet-active mask and the per-zone player occupancy.

### 7.3 The liveness watchdog is mandatory, not optional

Because a failing crank dies permanently after ~26 s of retries (§5.1) and there is no
RPC to ask whether a task is alive, the client must detect a stalled crank itself.

The browser already holds an `accountSubscribe` to `ArenaState`. **Two thresholds, not
one** — the corrected retry timeline (§5.1) makes a single 3 s trigger wrong, because a
crank that has missed 7 ticks is very often mid-backoff and will recover:

```
if (now - lastTickChangeAt > 3000ms)   → soft: show "reconnecting", freeze input prediction
if (now - lastTickChangeAt > 45000ms)  → hard: the task is gone for good
    → POST /match/settle (which cancels + settles from last committed state)
```

3 s ≈ 7 missed 400 ms ticks: enough to tell the player something is wrong, early enough not
to leave them staring at a frozen boss.

**The hard threshold is 45 s, not 30 s** (corrected in the second verification pass). The
arithmetic ladder is ≈ 26.3 s
(`slot_interval.max(100ms) × 2^(retry-1)`, capped at 5 s: 100+200+400+800+1600+3200+5000×4),
but that counts only the *sleep* between attempts — it excludes the execution round-trip of
each of the 11 attempts, and the base term is `slot_interval.max(100ms)`, so a validator
with a slot interval above 100 ms stretches the whole early ladder. MagicBlock's own
integration test at the deployed commit (`test_schedule_error.rs`) polls for up to **45 s**
before asserting the task has reached `failed_tasks`; matching their number is the safe
call. Settling earlier would abandon matches that were about to recover on their own.

**This is the one place the design's "no server game loop" stance needs a caveat.**
There is still no server *loop* — but there must be a client-side liveness check and a
cold-path recovery route, because the crank has failure modes it cannot signal. The
existing `/match/settle` fallback route is exactly the right hook; this document just
makes it load-bearing rather than a fallback.

### 7.4 Concrete `/match/start` sequence

1. **Base layer.** Initialize arena, boss, bullets, and the **single packed `Players[20]`
   component account** (§6.3) — every account the crank will ever touch must exist now.
   Platform treasury pays rent.
2. **Base layer.** Delegate every one of them, pinning a specific validator via
   `DelegateConfig { validator: Some(er_validator_pubkey), .. }`.
3. Poll router `getDelegationStatus` until delegation has propagated; take the `fqdn`
   for the ER connection.
4. **ER.** Send `schedule_boss_tick` with:
   - `task_id`: wide random positive `i64`, derived from the arena PDA, **stored on
     `ArenaState`** (§6.1)
   - `execution_interval_millis: 400`
   - `iterations`: generous (e.g. `90_000` ≈ 10 h at 400 ms) — §4.2
   - payer: the platform scheduling key. **This key, and only this key, can cancel.**
     Store its `crank_signer_pda` on `ArenaState` so `BossTick` can authorize its
     caller (§4.3).
5. Client subscribes to `ArenaState` and starts the §7.3 watchdog.

`/match/settle` must **`CancelTask` before undelegating** (§5.4).

### 7.5 Note for the open Pinocchio question

Not this topic's remit, but directly relevant and worth flagging to whoever owns it:
**there is a published, first-party native Pinocchio crank module.** It is a *separate
crate* from the Anchor SDK — `ephemeral-rollups-pinocchio`, version **0.17.0**, published to
crates.io on 2026-08-26 (same release train as `ephemeral-rollups-sdk` 0.17.0), source at
`rust/pinocchio/src/crank.rs`. `pub mod crank;` is unconditional in its `lib.rs` — no
feature flag needed:

```toml
ephemeral-rollups-pinocchio = "0.17.0"
```

It provides `ScheduleCrankCpi`, `ScheduleCrankArgs`, `CrankInstruction`, and a builder, with
the same `i64` field types as the Anchor SDK. It hand-serializes the bincode wire format:

```rust
const SCHEDULE_CRANK_DISCRIMINANT: [u8; 4] = 6_u32.to_le_bytes();
```

I verified that discriminant is right: `ScheduleTask` is the 7th variant (index 6) of
`MagicBlockInstruction` at the deployed commit — after `ModifyAccounts`,
`ScheduleCommit`, `ScheduleCommitAndUndelegate`, `AcceptScheduleCommits`,
`ScheduledCommitSent`, `ScheduleBaseIntent`.

So a native Pinocchio program **can** schedule and cancel cranks without Anchor. That
is a real, supported, first-party path, and it removes one objection to the
Pinocchio-alongside-BOLT proposal. It says nothing about whether a Pinocchio program
may *touch BOLT component accounts*, which remains the actual open question. Also note
the discriminant is hardcoded — it will need updating when §6.4's wincode migration
lands.

---

## 8. Corrections to the local `magicblock` skill

The skill at `~/.claude/skills/magicblock/cranks.md` and `resources.md` should be
updated. Specifically:

| Skill says | Actually |
|---|---|
| `ephemeral-rollups-sdk = "0.14.3"` | **0.17.0** |
| `magicblock-magic-program-api = "0.10.1"` | **0.14.10** (devnet runs 0.14.11) |
| `@magicblock-labs/ephemeral-rollups-sdk: "0.14.3"` | **0.17.0** |
| Hand-roll `bincode::serialize(&MagicBlockInstruction::ScheduleTask(..))`; add `bincode` + `sha2` deps | Use `ephemeral_rollups_sdk::crank::ScheduleCrankCpi`; drop the direct `magicblock-magic-program-api`, `bincode`, `sha2` deps |
| `ScheduleCrankArgs` fields are `u64` | **`i64`** |
| `AccountMeta::new(payer, true)` + `AccountMeta::new(my_account, false)` passed manually | `ScheduleCrankCpi { payer, magic_program, instruction_accounts, args }` |
| `Solana 3.1.9` | devnet ER reports **solana-core 4.0.0** |
| (silent on task_id scoping) | `task_id` is a **validator-global** namespace — §6.1 |
| (silent on failure semantics) | §5.1 / §5.2 — the defining operational risk |

The `execution_interval_millis` / `iterations` / `task_id` field *names* and the
"must be sent to the ER, not base layer" rule are all correct.

---

## Sources

Fetched and read on 2026-08-31.

**Live endpoints queried**
- `https://devnet-as.magicblock.app/` — `getVersion` (also `devnet-us`, `devnet-eu`)
- `https://api.devnet.solana.com` — `getAccountInfo` for `Magic111…` and `Crank111…`

**MagicBlock docs**
- https://docs.magicblock.gg/pages/tools/crank/introduction
- https://docs.magicblock.gg/pages/tools/crank/implementation.md
- https://docs.magicblock.gg/llms.txt

**magicblock-validator @ `cec4cf5` (v0.14.11 — what devnet runs)**
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-magic-program-api/src/args.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-magic-program-api/src/instruction.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-magic-program-api/src/pda.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-magic-program-api/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-magic-program-api/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/programs/magicblock/src/magicblock_processor.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/programs/magicblock/src/schedule_task/mod.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/programs/magicblock/src/schedule_task/process_schedule_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-task-scheduler/src/service.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-config/src/consts.rs

**magicblock-validator @ `dev` (unreleased — the behaviour change in §5.2 / §6.4)**
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/docs/task-scheduler.md
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-task-scheduler/README.md
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-task-scheduler/src/service.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-task-scheduler/src/db.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-task-scheduler/src/errors.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-task-scheduler/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-config/src/config/scheduler.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-magic-program-api/src/args.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-magic-program-api/src/instruction.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-magic-program-api/src/pda.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-magic-program-api/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/programs/magicblock/src/magicblock_processor.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/programs/magicblock/src/schedule_task/mod.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/programs/magicblock/src/schedule_task/process_schedule_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/programs/magicblock/src/schedule_task/process_cancel_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/programs/magicblock/src/schedule_task/process_execute_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/programs/magicblock/src/utils/instruction_utils.rs

**ephemeral-rollups-sdk**
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/crank.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/crank.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/Cargo.toml
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/
- https://docs.rs/magicblock-magic-program-api/0.14.10/magicblock_magic_program_api/args/struct.ScheduleTaskArgs.html

**Official example**
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/programs/crank-counter/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/programs/crank-counter/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/tests/crank-counter.ts
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/package.json

**Registries**
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/magicblock-magic-program-api
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk

**Compute budget reference (stock Agave, for the §5.3 caveat)**
- https://raw.githubusercontent.com/anza-xyz/agave/master/compute-budget/src/compute_budget_limits.rs
- https://raw.githubusercontent.com/anza-xyz/agave/master/compute-budget-instruction/src/compute_budget_instruction_details.rs

---

## Verification

Adversarial verification pass, **2026-08-31**, independent of the original research. Every
URL below was fetched fresh; nothing was taken on the first draft's word.

### Confirmed unchanged

| Claim | How it was re-checked |
|---|---|
| Devnet ERs run `magicblock-core 0.14.11`, `git-commit cec4cf5`, `solana-core 4.0.0` | Live `getVersion` POST to `devnet-as` / `devnet-us` / `devnet-eu`. Identical on all three. |
| `Magic111…` and `Crank111…` do not exist on Solana devnet base layer | Live `getAccountInfo` on `api.devnet.solana.com`, both return `value: null` (apiVersion 4.3.0-beta.2). |
| `ScheduleTaskArgs` fields are `i64`, not `u64` | Read `magicblock-magic-program-api/src/args.rs` @ `cec4cf5` directly. Confirmed. The docs page still shows `u64` — re-fetched and confirmed the contradiction. |
| `ScheduleTask` is variant index 6; Pinocchio's `SCHEDULE_CRANK_DISCRIMINANT = 6_u32.to_le_bytes()` is correct | Counted the `MagicBlockInstruction` enum at `cec4cf5`: ModifyAccounts(0), ScheduleCommit(1), ScheduleCommitAndUndelegate(2), AcceptScheduleCommits(3), ScheduledCommitSent(4), ScheduleBaseIntent(5), **ScheduleTask(6)**. |
| `ephemeral-rollups-sdk` 0.17.0 (2026-08-26) really ships a `crank` module | crates.io API + docs.rs module index for the *published* 0.17.0 — `crank` is listed alongside compat/consts/cpi/delegate_args/ephem/pda/types/utils. Not just a `main`-branch feature. |
| `magicblock-magic-program-api` 0.14.10, npm `@magicblock-labs/ephemeral-rollups-sdk` 0.17.0 | crates.io and npm registry APIs. |
| `ScheduleCrankCpi` / `CancelCrankCpi` shapes, `AccountMeta::new(payer, true)` | Read `rust/sdk/src/crank.rs`; the crate's own unit test `schedule_instruction_marks_payer_writable_signer` asserts exactly that meta. |
| Official example uses `ScheduleCrankCpi`, `i64` args, `taskId: new BN(1)` with the "arbitrary" comment | Re-fetched `crank-counter` lib.rs, Cargo.toml and the TS test. All as described. |
| `validate_cranks_instructions` rules; only `crank_signer_pda` may sign; interval and iteration checks | Read `schedule_task/mod.rs` and `process_schedule_task.rs` @ `cec4cf5`, including their in-file unit tests. |
| `DEFAULT_TASK_SCHEDULER_MIN_INTERVAL_MILLIS = 10` | `magicblock-config/src/consts.rs` @ `cec4cf5`. |
| `task_id` is a validator-global namespace | `db.rs` @ `cec4cf5`: `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY …)` + `INSERT OR REPLACE INTO tasks`, and the `UnauthorizedReplacing` check in `service.rs` happens *after* lookup by id. |
| `CancelTask` authority mismatch is a silent no-op | `process_cancel_task.rs` @ `cec4cf5` (the first draft cited only the `dev` copy; the deployed one is identical). |
| No concurrent-task cap in source | Re-grepped `service.rs` @ `cec4cf5`: unbounded `DelayQueue`, unbounded `JoinSet`, no capacity check. |
| The crank tx is `[noop, ExecuteCrank]` with no ComputeBudget instruction | `send_crank_batch` @ `cec4cf5`. Confirmed. |

### Refuted and corrected

1. **"The deployed validator cannot see execution failures; a failing crank is recorded as
   a SUCCESS and ticks uselessly forever."** — **Wrong.** `RpcClient::send_transaction`
   sends `skip_preflight: false`, and the ER's `sendTransaction` handler routes that to
   `transactions_scheduler.execute(...).await?`, which awaits the execution result and
   propagates failures. The scheduler sees them as `TaskSchedulerError::Rpc`, retries, and
   after 10 failures moves the task to `failed_tasks`. The repo's own integration test at
   the deployed commit, `test_schedule_error.rs`, asserts the failing task ends up
   unscheduled *and that its counter was never incremented*. §5.1 rewritten.

2. **"The retry policy (10 retries, backoff, permanent kill) is an unreleased `dev`
   change."** — **Wrong.** `MAX_TASK_EXECUTION_RETRIES = 10`, the backoff constants, and
   `prepare_crank_failure_outcome` / `apply_crank_failure_outcome` are all present at
   `cec4cf5`. `dev` changes only the error variant and removes a self-directed RPC hop.
   §5.2 rewritten; the "two versions behave oppositely" framing is gone.

3. **"The crank CU ceiling is unknown, plausibly a few thousand."** — **Resolved to
   400,000 CU.** `magicblock-processor` calls stock Agave `process_compute_budget_instructions`
   with no override; Agave classifies `Magic111…` as `NotBuiltin` (it is not in the
   compile-time `solana-builtins-default-costs` table); both crank instructions are on the
   Magic program; default limit = 2 × 200,000. §5.3 rewritten. This substantially de-risks
   Bullets[128].

4. **"A validator restart can plausibly lose your crank."** — **Overstated.**
   `TaskSchedulerService::start()` calls `load_persisted_tasks()`, which re-queues every
   persisted row (clamping the first re-fire to `2 × slot_interval`). Loss requires
   `reset = true`, a move to a different validator, or disk loss. §5.5 corrected.

5. **"20 players' component accounts cannot fit — the `ScheduleTask` instruction must fit
   in a 1232-byte transaction."** — **Not established.** `prepare_transaction` @ `cec4cf5`
   decodes and `bincode::deserialize`s with no size check; 1232 is a UDP/QUIC packet
   constraint and you reach the ER over HTTP. The nearest real limits are
   `MAX_TX_ACCOUNT_LOCKS` (64) and a 38-entry packet-bounded pubkey table the ER references
   in `transaction_validation.rs`. ~46 accounts is in the danger zone but not provably
   fatal. §6.3 corrected — and the *decision* is forced anyway: pack players into one
   `Players[20]` account, which is also the right call for CU.

   > **SUPERSEDED by the second verification pass (2026-09-01).** The "danger zone, not
   > provably fatal" verdict is wrong in both directions: `MAX_TX_ACCOUNT_LOCKS` is *not*
   > enforced by the ER at all (`get_account_locks_unchecked`), while the 38-entry table
   > *is* enforced on every transaction and, because program ids sort last in a compiled
   > message, it is provably fatal at ~46 accounts. See the rewritten §6.3.

6. **Misquote:** §4.3 rendered the validator-authority guard as `engine_authority()`. The
   actual identifier at `cec4cf5` is `effective_validator_authority_id()`. Fixed.

### Decisions forced (where the first draft hedged)

- **§6.2 re-arm loophole:** the first draft called it "unverified, LOW confidence." The
  verification pass found `test_use_crank_signer.rs` proving `AccountMeta::new_readonly(crank_signer, true)`
  *is* legal inside a crank, so the loophole is more likely to work than stated. **Decision:
  still do not use it** — the re-armed task's authority becomes the crank signer PDA, so you
  would own a crank you cannot cancel on a validator with no task-status RPC. Use large
  `iterations` + `CancelTask` at settle.
- **§6.3 ECS layout:** the first draft said "budget this before committing." **Decision:
  one packed `Players[20]` component account.** ~7 accounts in the frozen list instead of
  ~46, under every ceiling, and 40 fewer account deserializations per tick.
- **§7.3 watchdog:** the first draft's single 3 s trigger would settle matches that were
  mid-backoff. **Decision: two thresholds** — 3 s soft ("reconnecting"), 30 s hard (settle),
  the latter chosen to clear the ~26.3 s retry ladder.

### Still unverified

- The **400,000 CU** figure is derived from source, not measured. Confirm once on devnet
  from a trivial crank's `consumed X of Y compute units` log line before freezing `BossTick`.
- Whether the ER actually **accepts a >1232-byte transaction** over HTTP JSON-RPC in
  practice, and what its effective account-lock ceiling is. Moot if the packed-`Players`
  decision is followed.
- Whether the readonly-payer **re-arm loophole** works end to end. Deliberately not tested —
  the decision is not to use it.
- Whether MagicBlock enforces a **concurrent-task cap operationally**, out of band. Not
  expressible from source. Worth asking them.
- **When the wincode migration ships to devnet**, and whether `backward-compat` keeps
  bincode clients working across the cutover. Confirmed only that `dev` has migrated and
  `cec4cf5` has not.
- What pubkey the SDK's `CancelCrankCpi.task_context` is meant to be. The deployed
  `process_cancel_task` reads only index 0 (the authority) and ignores index 1, so it
  appears inert today, but no example passes a concrete value.
- Whether a **Pinocchio program may touch BOLT component accounts** — the SDK's native
  Pinocchio crank module (verified present, discriminant 6, `i64` args) proves Pinocchio can
  *schedule* cranks and nothing more. Still belongs to the Pinocchio research topic.

### Additional sources fetched during verification (beyond the original list)

- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-aperture/src/requests/http/send_transaction.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-aperture/src/requests/http/mod.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-aperture/src/requests/http/transaction_validation.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-core/src/link/transactions.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-processor/src/executor/processing.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-task-scheduler/src/db.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/magicblock-task-scheduler/src/errors.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/programs/magicblock/src/schedule_task/process_cancel_task.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/programs/magicblock/src/utils/instruction_utils.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/test-integration/test-task-scheduler/tests/test_schedule_error.rs`
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/cec4cf5/test-integration/test-task-scheduler/tests/test_use_crank_signer.rs`
- `https://raw.githubusercontent.com/anza-xyz/agave/master/compute-budget-instruction/src/builtin_programs_filter.rs`
- `https://api.github.com/repos/magicblock-labs/magicblock-validator/git/trees/cec4cf5?recursive=1`

---

## Verification — second adversarial pass (2026-09-01)

A second, independent pass run against the *already-verified* document, on the assumption
that the first verification pass was itself wrong somewhere. Every source below was fetched
fresh at the deployed commit `cec4cf5`; nothing was taken on either earlier draft's word.
The GitHub tree API was used first to confirm every cited path actually exists at that
commit before any file was read.

### Re-confirmed (the first pass's big reversals hold up)

| Claim | How it was independently re-checked |
|---|---|
| Devnet ERs run `magicblock-core 0.14.11` / `cec4cf5` / `solana-core 4.0.0` | Live `getVersion` POST to `devnet-as` and `devnet-us`, 2026-09-01. Byte-identical, `feature-set 3718597879`. |
| `Magic111…` absent from Solana devnet base layer | Live `getAccountInfo` on `api.devnet.solana.com` → `value: null`, slot 491072350. |
| **The deployed validator DOES see execution failures** | Chased the whole chain rather than the summary. `service.rs` imports `solana_rpc_client::nonblocking::rpc_client::RpcClient` and calls `send_transaction` (skip_preflight defaults false) → `send_transaction.rs` @ `cec4cf5` branches `if config.skip_preflight { …schedule() } else { …execute().await? }` → `link/transactions.rs` documents `execute()` as "asynchronously awaits its result" and its private `send()` returns the inner `TransactionResult<()>`, so a transaction that executes and *fails* returns `Err`. The original researcher's "fire-and-forget, records success" claim is **refuted**. |
| Retry-then-permanent-death is on the **deployed** build, not `dev` | `MAX_TASK_EXECUTION_RETRIES = 10` at line 43 of `service.rs` @ `cec4cf5`; `TaskSchedulerError` @ `cec4cf5` has **no** `TransactionExecution` variant, confirming that variant is `dev`-only; `test_schedule_error.rs` exists at `cec4cf5` and asserts `failed_tasks.len() == 1`, `get_task_ids().len() == 0`, and `counter.count == 0`. |
| Restart does not lose tasks | Read `load_persisted_tasks()` in full. It re-queues every row, deleting only rows with an invalid interval or `executions_left <= 0`, and clamps the first re-fire to `2 × slot_interval`. |
| `ScheduleTaskArgs` fields are `i64` | `args.rs` @ `cec4cf5` lines 173-178. The docs page was re-fetched on 2026-09-01 and still shows `u64` plus the hand-rolled `bincode::serialize` pattern — the contradiction stands. |
| `ScheduleTask` is variant index 6 | Enumerated `MagicBlockInstruction` @ `cec4cf5`: ModifyAccounts(0), ScheduleCommit(1), ScheduleCommitAndUndelegate(2), AcceptScheduleCommits(3), ScheduledCommitSent(4), ScheduleBaseIntent(5), **ScheduleTask(6)**, CancelTask(7). |
| `task_id` is validator-global | `db.rs` @ `cec4cf5` line 183: `CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY`, plus `INSERT OR REPLACE INTO tasks`. Not namespaced by program or authority. |
| Interval / iterations validation | `process_schedule_task.rs` @ `cec4cf5`: `iterations < 1` rejected (its own unit test uses `-100`), interval `<= 0 || >= u32::MAX` rejected (unit test iterates `[-12345, 0, u32::MAX+1]`). |
| The readonly-`crank_signer` loophole is real | `test_use_crank_signer.rs` @ `cec4cf5` schedules a crank carrying `AccountMeta::new_readonly(crank_signer, true)` and asserts the counter reaches `iterations`. |
| Versions | crates.io: `ephemeral-rollups-sdk` max **0.17.0** (2026-08-26), `magicblock-magic-program-api` max **0.14.10** (2026-08-16). npm `@magicblock-labs/ephemeral-rollups-sdk` dist-tag latest **0.17.0** (2026-08-26). |
| The `crank` module is in the **published** crate, not just `main` | Downloaded and unpacked `ephemeral-rollups-sdk-0.17.0.crate` from static.crates.io. `src/crank.rs` is present, `pub mod crank;` in `lib.rs` carries no `#[cfg]`, and `crank = []` is an inert feature. |
| Official example uses `i64` and `taskId: new BN(1)` | Re-fetched `crank-counter` lib.rs / Cargo.toml / test. All three confirmed, including the misleading "Task ID can be arbitrary" comment. |
| CU derivation formula | `magicblock-processor` calls stock `process_compute_budget_instructions` with no override. Agave's `calculate_default_compute_unit_limit` was read at tag **v4.0.0** (matching the ER's reported `solana-core`), not just `master` — the two files are byte-identical (25,565 bytes), so the formula `builtins × 3,000 + non-builtins × 200,000`, capped at `MAX_COMPUTE_UNIT_LIMIT`, is stable across both. |

### Newly refuted / corrected in this pass

1. **§5.3 step 4 was factually wrong about the crank transaction's programs.** It claimed
   both instructions run on the Magic program. `InstructionUtils::execute_task_instruction`
   @ `cec4cf5` builds `ExecuteCrank` against **`CRANK_PROGRAM_ID`** (`Crank111…`), not
   `crate::id()`. The 400,000 CU figure survives — neither program is an Agave builtin — but
   the reasoning as written was not checkable. Fixed in §5.3.

2. **§6.3's account ceiling was wrong in both directions — this is the pass's most
   consequential finding.**
   - `MAX_TX_ACCOUNT_LOCKS` (64) is **not enforced** anywhere on the ER path:
     `processing.rs` uses `get_account_locks_unchecked()`, and the ER's `sanitize` impl goes
     straight to `SanitizedTransaction::try_create`.
   - The 38-entry limit **is** enforced, unconditionally, on every transaction —
     `validate_supported_transaction_shape` is called from `prepare_transaction` and rejects
     `program_id_index >= 38` (the ER ships two unit tests for exactly the 37/38 boundary).
   - Because `CompiledKeys::try_into_message_components` orders keys
     *writable signers → readonly signers → writable non-signers → readonly non-signers*
     and program ids are always readonly non-signers, **program ids sort last**. For a
     write-heavy transaction that turns the index limit into a ~38 **total account key**
     ceiling.
   - `execute_task_instruction` puts every frozen account into the crank transaction's
     message, and that transaction is submitted through the same `prepare_transaction` path.
     So a ~46-account layout is rejected **at every tick**, as a retryable `Rpc` error,
     which burns the 10-retry ladder and permanently deletes the task ~26 s into the match.

   §6.3 rewritten. The packed-`Players[20]` decision is upgraded from "don't gamble" to
   **mandatory**; the earlier "danger zone but not provably fatal" line is marked superseded
   in the first pass's own list.

3. **New project-wide constraint, previously unrecorded: the ER rejects address lookup
   tables outright.** `"v0 transactions with address lookup tables are not supported"`, same
   function, no feature flag. The document had only said ALTs "would not have helped" for
   the crank's instruction data; in fact no HEARTROT transaction sent to the ER — gameplay
   transactions included — may carry an ALT. Recorded in §6.3 and the TL;DR.

4. **§7.3's 30 s hard watchdog threshold was cutting it too fine. Raised to 45 s.** The
   ≈26.3 s arithmetic counts only the sleeps between the 11 attempts, and the ladder's base
   term is `slot_interval.max(100ms)`, so a validator with a slot interval above 100 ms
   stretches it. MagicBlock's own `test_schedule_error.rs` polls up to 45 s before asserting
   the task is dead; matching their number is the safe call.

### Decisions forced (where the document still hedged)

- **§3.5 `CancelCrankCpi.task_context`** was listed as an open question ("no example passes a
  concrete value"). Resolved: `process_cancel_task` @ `cec4cf5` reads only
  `TASK_AUTHORITY_IDX = 0` and never index 1, while the SDK emits
  `AccountMeta::new(task_context, false)` — a *writable* meta — regardless.
  **Decision: pass the arena PDA.** Already delegated, already writable in the ER, already
  in `/match/settle`'s account list. Do not invent an account for a field the program
  ignores, and do not hand-roll `CancelTask` just to drop one meta.
- **§7.5 Pinocchio** named a file path but no dependency. Resolved: the native crank module
  ships in a **separate published crate**, `ephemeral-rollups-pinocchio = "0.17.0"`
  (crates.io, 2026-08-26 — verified by downloading and unpacking the `.crate`; `src/crank.rs`
  present, `pub mod crank;` unconditional, no feature flag, `i64` args, discriminant 6).
  It is *not* the `ephemeral-rollups-sdk` crate and *not* a git dependency.

### Still unverified after two passes

- **The 400,000 CU figure is derived, never measured.** The derivation is now solid at the
  exact Agave version the ER reports, but the ER could still diverge in a way not visible in
  `magicblock-processor`. Schedule a trivial crank on devnet and read `consumed X of Y
  compute units` from the crank transaction's logs before freezing `BossTick`. This remains
  the top unresolved item.
- **The exact ~38-key ceiling has not been probed empirically.** The source reading is
  unambiguous, but the precise cutoff depends on how `Magic111…` and `Crank111…` sort by raw
  bytes within the readonly group. Moot if the packed-`Players` decision is followed, which
  it should be regardless.
- **HTTP request-body size limits in the aperture server** were not audited
  (`magicblock-aperture/src/server/http/*` not read). Irrelevant at ~10 accounts.
- Whether MagicBlock enforces a **concurrent-task cap operationally**, out of band.
- **When the wincode migration ships to devnet**, and whether `backward-compat` is a
  transition period or a hard cutover.
- Whether a **Pinocchio program may touch BOLT component accounts**. Two passes have now
  confirmed only that Pinocchio can *schedule* cranks. The actual architectural question
  belongs to the Pinocchio research topic and is untouched by this one.

### Sources fetched in the second pass

Live: `https://devnet-as.magicblock.app/`, `https://devnet-us.magicblock.app/`,
`https://api.devnet.solana.com` (all 2026-09-01).

`magicblock-validator` @ `cec4cf5` — `git/trees/cec4cf5?recursive=1` (path existence check),
`magicblock-aperture/src/requests/http/send_transaction.rs`,
`magicblock-aperture/src/requests/http/mod.rs`,
`magicblock-aperture/src/requests/http/transaction_validation.rs`,
`magicblock-core/src/link/transactions.rs`,
`magicblock-processor/src/executor/processing.rs`,
`magicblock-task-scheduler/src/{service.rs,errors.rs,db.rs}`,
`programs/magicblock/src/schedule_task/{mod.rs,process_schedule_task.rs,process_execute_task.rs,process_cancel_task.rs}`,
`programs/magicblock/src/utils/instruction_utils.rs`,
`magicblock-magic-program-api/src/{args.rs,instruction.rs}`,
`test-integration/test-task-scheduler/tests/{test_schedule_error.rs,test_use_crank_signer.rs}`.

Agave / Solana SDK — `compute-budget-instruction/src/compute_budget_instruction_details.rs`
at **v4.0.0** and `master`, `compute-budget/src/compute_budget_limits.rs` at v4.0.0,
`anza-xyz/solana-sdk` `message/src/compiled_keys.rs`.

Registries and packed crates — crates.io API for `ephemeral-rollups-sdk`,
`magicblock-magic-program-api`, `ephemeral-rollups-pinocchio`; npm registry for
`@magicblock-labs/ephemeral-rollups-sdk`; downloaded and unpacked
`ephemeral-rollups-sdk-0.17.0.crate` and `ephemeral-rollups-pinocchio-0.17.0.crate` from
static.crates.io.

Docs and example — `docs.magicblock.gg/pages/tools/crank/implementation.md`,
`magicblock-engine-examples/crank-counter/anchor/{programs/crank-counter/src/lib.rs,programs/crank-counter/Cargo.toml,tests/crank-counter.ts}`.
