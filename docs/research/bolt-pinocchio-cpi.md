# BOLT ↔ Pinocchio CPI — is the hybrid sound?

**Date:** 2026-08-31
**Status:** Research complete. Recommendation is a rejection with one carve-out.
**Scope:** The user's open question — "a native Pinocchio program alongside the BOLT
programs, doing CPI between them where needed."

---

## TL;DR

| Question | Answer | Confidence |
|---|---|---|
| Can a BOLT System CPI into an arbitrary Pinocchio program? | **Yes.** `#[extra_accounts]` is present and byte-identical in the installable 0.2.4. (The in-repo example demonstrating it exists only on `main` — see §2.) | High — read the source at both refs |
| Can that Pinocchio program **write** BOLT component accounts? | **No.** Two independent locks. | High — read the source |
| Can it **read** them? | Yes, trivially. Any program can read any account. | High |
| Is "BOLT owns ECS, Pinocchio owns its own account" the sane split? | It is the only split that permits *writes* — but it is **not needed**, see the next row. | High |
| Is there a CU or latency benefit for *this* game? | **No.** Not from Pinocchio. There is one from *not round-tripping through BOLT*, which is a different thing. | High |
| Should HEARTROT build the hybrid as the user framed it? | **No.** | High |
| Is there a legitimate use for a separate program here? | **No — corrected on verification.** The 1024-byte return-data ceiling is real and forces `BossTick` to split, but it forces a split into **two `world::apply` instructions**, not a second program. See §4.1. | High |

**And the finding that outranks the question that was asked:** BOLT appears
unmaintained. It has been removed from MagicBlock's documentation index, its last
functional commit is 2025-10-19, and `bolt-lang` 0.2.5 and 0.2.6 are **yanked** from
crates.io. Meanwhile `ephemeral-rollups-pinocchio` 0.17.0 shipped five days ago. See
§7 — this contradicts spec §11 head-on and deserves a decision before more code lands.

**And the finding that outranks *that*, added on verification:** `bolt-lang` 0.2.4 as
published **does not resolve to a buildable dependency set today.** Its unpinned
`ephemeral-rollups-sdk = { version = "^0", features = ["anchor"] }` now resolves to
0.17.0, whose `anchor` feature pulls **anchor-lang 1.1.2**, while `bolt-lang`'s own
`anchor-lang = "^0"` caps at **0.32.1** — two semver-incompatible majors of the same
crate linked at once, across a type boundary `bolt-lang` re-exports. **`solana-program`
is duplicated the same way (2.3.0 + 3.0.0).** Both are now *measured* from a real
lockfile, not inferred. The fix is one `cargo update --precise` on the lockfile —
**manifest `=` pins do not work and actively make it worse.** See §7.5.

---

## 1. What BOLT actually does when you call a System

This is the load-bearing fact, and almost every intuition about "a system writes a
component" is wrong. A BOLT System **never writes a component account.** It is a pure
function: it reads component bytes and *returns* new component bytes. The World
program then writes them, by CPI, through the component program.

Verbatim from `crates/programs/world/src/lib.rs` (bolt @ `main`,
`WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n`):

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

and the execute half:

```rust
    let results = bolt_system::cpi::bolt_execute(
        cpi_context.with_remaining_accounts(remaining_accounts),
        args,
    )?
    .get();

    if results.len() != pairs.len() {
        return Err(WorldError::InvalidSystemOutput.into());
    }
```

Note what `BoltExecute` takes — one account:

```rust
#[derive(Accounts, Clone)]
pub struct BoltExecute<'info> {
    /// CHECK: authority check
    #[account()]
    pub authority: AccountInfo<'info>,
}
```

Everything else arrives as `remaining_accounts`. The System has no writable component
in its accounts struct at all. It cannot write one even if it wanted to.

### The call graph

```
tx (top-level ix)  →  world::apply                              depth 1
                        ├─ CPI  bolt_system::bolt_execute       depth 2
                        │        └─ returns Vec<Vec<u8>> via return-data buffer
                        ├─ CPI  component_a::update(bytes)      depth 2
                        ├─ CPI  component_b::update(bytes)      depth 2
                        └─ ...  one CPI per touched component
```

`#[system]` rewrites your `execute` to serialize each returned component with Borsh.
From `crates/bolt-lang/attribute/system/src/lib.rs`:

```rust
item_fn.sig.output = parse_quote! { -> Result<Vec<Vec<u8>>> };
```
```rust
pub fn bolt_execute<'a, 'b, 'info>(ctx: Context<'a, 'b, 'info, 'info, VariadicBoltComponents<'info>>, args: Vec<u8>) -> Result<Vec<Vec<u8>>> {
    let mut components = Components::try_from(&ctx)?;
    let bumps = ComponentsBumps {};
    let context = Context::new(ctx.program_id, &mut components, ctx.remaining_accounts, bumps);
    execute(context, args)
}
```

---

## 2. Q1 — Can a BOLT System CPI into an arbitrary Pinocchio program?

**Yes.** This is a plain Anchor program calling `invoke`. Nothing about BOLT blocks it.

The mechanism is `#[extra_accounts]`, and BOLT ships a working example of exactly this
pattern. Verbatim, `examples/escrow-funding/src/lib.rs` — **on `main` only**:

> **Version caveat, added on verification.** `examples/escrow-funding/` returns **404
> at tag `v0.2.4`**, the newest installable release. At `v0.2.4` the whole `examples/`
> directory is just `component-position`, `component-velocity`,
> `system-apply-velocity`, `system-fly`, `system-simple-movement`. The escrow example
> — and the `system-with-N-components` series — exist only on `main`, i.e. only in the
> **yanked** 0.2.5/0.2.6 line. This is exactly the trap flagged in §9 gotcha 2.
>
> **The Q1 answer still stands**, because the *mechanism* is not version-scoped:
> `crates/bolt-lang/attribute/extra-accounts/src/lib.rs` is **byte-identical** at
> `main`, `v0.2.4` and `v0.2.3` (106 lines, verified by diff), and `bolt-lang` 0.2.4's
> `src/lib.rs:17` re-exports it: `pub use bolt_attribute_bolt_extra_accounts::extra_accounts;`
> Treat the code below as a correct illustration of a supported feature, not as
> something you can `git checkout` from the version you will install.

```rust
use bolt_lang::anchor_lang::*;
use bolt_lang::*;
use small::Small;

declare_id!("4Um2d8SvyfWyLLtfu2iJMFhM77DdjjyQusEy7K3VhPkd");

#[system]
pub mod escrow_funding {
    pub fn execute(ctx: Context<Components>, args: Args) -> Result<Components> {
        let receiver = ctx.accounts.receiver.to_account_info();
        let sender = ctx.sender()?.clone();
        let system_program = ctx.system_program()?.clone();

        let cpi_accounts = system_program::Transfer {
            from: sender,
            to: receiver,
        };
        let cpi_ctx = CpiContext::new(system_program, cpi_accounts);
        system_program::transfer(cpi_ctx, args.amount)?;

        Ok(ctx.accounts)
    }

    #[system_input]
    pub struct Components {
        pub receiver: Small,
    }

    #[arguments]
    pub struct Args {
        amount: u64,
    }

    #[extra_accounts]
    pub struct ExtraAccounts {
        #[account(mut)]
        pub sender: AccountInfo,
        #[account(address = bolt_lang::solana_program::system_program::id())]
        pub system_program: AccountInfo,
    }
}
```

Swap `system_program::id()` for your Pinocchio program's id, swap the typed
`CpiContext` for a hand-built `Instruction` + `invoke`, and it works identically. The
callee's framework is irrelevant — a CPI is a program id, an account list, and a byte
buffer.

`#[extra_accounts]` fields are read out of `remaining_accounts` *after* the components,
via generated accessors (`crates/bolt-lang/attribute/extra-accounts/src/lib.rs`):

```rust
fn #field_name(&self) -> Result<&'c AccountInfo<'info>> {
    self.remaining_accounts.get(Self::NUMBER_OF_COMPONENTS + #index).ok_or_else(|| ErrorCode::ConstraintAccountIsNone.into())
}
```

**Depth budget:** `world::apply` is depth 1, `bolt_execute` is depth 2, your CPI is
depth 3. Agave's default instruction stack depth is **5** (9 with SIMD-0268). You have
room, but you are already three deep before your own code runs.

---

## 3. Q2 — Can the Pinocchio program WRITE component accounts?

**No.** Two independent locks, either of which is fatal on its own.

### Lock 1 — Solana's ownership rule

From the official account model docs:

> "Only the account's owner program can modify its data or debit lamports."

A BOLT component account is a PDA owned by the component program — the program the
`#[component]` macro generates. The generated `Initialize` proves it:

```rust
#[account(init_if_needed, payer = payer, space = <#component_type>::size(), seeds = [<#component_type>::seed(), entity.key().as_ref()], bump)]
pub data: Account<'info, #component_type>,
```

Your Pinocchio program is not that owner. Write to the buffer and the runtime rejects
the transaction with an external-account-data-modified violation when the instruction
returns. There is no flag, no config, no delegation setting that changes this. It is
the SVM's core invariant.

### Lock 2 — the component program refuses non-World callers

The only *legal* write path is CPI-ing the component program's `update`. That
instruction is explicitly locked to the World program. Verbatim, from
`crates/bolt-lang/attribute/bolt-program/src/lib.rs`:

```rust
#[automatically_derived]
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

`initialize` and `destroy` carry the same `InvalidCaller` guard.

The instructions sysvar holds **only top-level instructions**:

> "The Instructions sysvar only contains top-level instructions from the transaction
> message. Inner instructions invoked via CPI are not accessible through this sysvar."

So `get_instruction_relative(0, ...)` returns the *top-level* instruction of the
transaction, whatever the CPI depth. Send a transaction whose top-level instruction is
addressed to your Pinocchio program and that check fails with `InvalidCaller`, always.

### The one narrow loophole — and why you must not use it

Because the check reads the **top-level** instruction, a program reached from *inside*
a `world::apply` chain still sees `World::id()`. So in principle: `world::apply` →
`bolt_execute` → your Pinocchio program → `component::update` would pass both the
`InvalidCaller` check *and* the authority check (components initialized with the World
as authority satisfy `bolt_metadata.authority == World::id()` trivially).

Do not do this. It requires you to hand-encode Anchor's `update` discriminator
(`db c8 58 b0 9e 3f fd 7f`, = first 8 bytes of `sha256("global:update")`), Borsh-encode
the entire component including its appended `bolt_metadata`, forward the authority
signer, and pass the instructions sysvar — to accomplish precisely what `world::apply`
does for free on the very next line after your system returns. It is undocumented, it
depends on an internal check MagicBlock has already tried to change once (PR #196
"CPI Authentication using a World PDA", **reverted** in #213 on 2025-10-17), and it
would double-write the component if the system also returns it.

**Reading is always fine.** Deserializing a component account inside a Pinocchio
program is legal and cheap. It is writing that is closed.

---

## 4. Q3 — The real constraint, and what it actually forces

"BOLT owns ECS game state; the native program owns a separate account it fully owns"
is the only split that permits *writes* — §3 proves that.

There is also a concrete, evidence-backed constraint that forces `BossTick` to change
shape, and it has nothing to do with Pinocchio being fast. **But on verification it
does not force a second program.** Read §4.1 before acting on anything below.

### BOLT's 1024-byte return-data ceiling breaks the bullet pool

System output travels through Solana's return-data buffer (Anchor's CPI `Return<T>`
reads `sol_get_return_data`; the World program calls `.get()` on it, §1). That buffer
is hard-capped:

> "The callee can set the return data using a new system call
> `sol_set_return_data(buf: *const u8, length: u64)`. There is a limit of **1024 bytes**
> for the returndata."

Now measure the spec's `Bullets` component. Per design spec §3, one bullet is
`{x: i16, y: i16, dx: i8, dy: i8, active: bool}`:

| Item | Bytes |
|---|---|
| One bullet, Borsh (2+2+1+1+1) | 7 |
| `[Bullet; 128]` — fixed array, no length prefix | 896 |
| `bolt_metadata: BoltMetadata { authority: Pubkey }` appended by `#[component]` | 32 |
| **Component payload** | **928** |
| inner `Vec<u8>` length prefix | 4 |
| outer `Vec<Vec<u8>>` length prefix | 4 |
| **Total return data, Bullets alone** | **936** |
| Budget | 1024 |
| **Headroom for every other component in the same `apply`** | **88 bytes** |

88 bytes buys you exactly one small component (an `ArenaState` of ~16 bytes plus its
32-byte `bolt_metadata` plus a 4-byte prefix ≈ 52 bytes). Then you are done.

The spec's `BossTick` is supposed to advance bullets **and** run boss attack logic
**and** check vent/core state **and** evaluate win/wipe. That means writing `Bullets` +
`ArenaState` + `BossState` + `Core` + `Parts` + some `Health`. Through `world::apply`,
**that transaction cannot exist.** It is not slow; it is impossible.

That is the real, defensible reason to put the bullet pool in its own program-owned
account. Not compute units. Not Pinocchio. A hard runtime ceiling in BOLT's data path.

*Original confidence note (now superseded):* "the 1024-byte limit is a base-layer
runtime constant… I am assuming the base-layer cap holds on the ER. Test this."

### 4.1 — VERIFIED: the ER does NOT raise the cap, and the fix is not a second program

**Two things were resolved by reading MagicBlock's validator source, and both change
the recommendation.**

**(a) The ER inherits 1024. This is settled — do not spend ten minutes on it.**

`magicblock-labs/magicblock-validator` (`Cargo.toml`) forks exactly four *Solana* upstream
crates via `[patch.crates-io]`, all pointing at `magicblock-labs/magicblock-svm` rev
`0395009`:

```
solana-account   solana-program-runtime   solana-svm   solana-transaction-context
```

`agave-syscalls` is **not** among them — the workspace takes it straight from
crates.io at `= 4.0.0`. And that unforked crate is where the limit is enforced
(`agave-syscalls-4.0.0/src/lib.rs`):

```rust
use solana_cpi::MAX_RETURN_DATA;          // line 20
...
if len > MAX_RETURN_DATA as u64 {         // line 1898
    return Err(SyscallError::ReturnDataTooLarge(len, MAX_RETURN_DATA as u64).into());
}
```

`solana-cpi` 3.1.0 (the version `agave-syscalls` 4.0.0 pins), line 330:

```rust
pub const MAX_RETURN_DATA: usize = 1024;
```

The fork's own `TransactionContext::set_return_data` carries no length check at all,
which is a red herring — enforcement lives in the syscall, and the syscall is stock.
Confirming the same fork is stock on compute too, `magicblock-svm/program-runtime/src/execution_budget.rs`:
`MAX_COMPUTE_UNIT_LIMIT = 1_400_000`, `DEFAULT_INSTRUCTION_COMPUTE_UNIT_LIMIT = 200_000`,
`MAX_INSTRUCTION_STACK_DEPTH = 5` (9 with SIMD-0268), `DEFAULT_INVOCATION_COST = 1000`
(946 with SIMD-0339). The §5 table below is correct from source, not just from docs.

**So: 936 > 88 bytes of headroom. `BossTick` must split. Confirmed.**

**(b) But the split it forces is two `world::apply` calls, not a second program.**

Return data is a single per-transaction buffer that is **reset at the start of every
instruction** — `magicblock-svm/program-runtime/src/invoke_context.rs:570`:

```rust
self.transaction_context.set_return_data(program_id, Vec::new())?;
```

Every top-level instruction therefore gets its own fresh 1024-byte window. And the
crank already takes a list: `ScheduleTaskArgs { task_id, execution_interval_millis,
iterations, instructions: Vec<Instruction> }` — present as far back as
`magicblock-magic-program-api` 0.8.5 (what `ephemeral-rollups-sdk` 0.13.0 pins), and
in the Pinocchio SDK as `ScheduleCrankArgs.instructions: &[CrankInstruction]`.

```
crank tick (one scheduled task, two instructions)
  ├─ world::apply(BulletTick)   → Bullets only          936 B ✓ fits
  └─ world::apply(BossLogic)    → ArenaState, BossState,
                                   Core, Parts, Health    small ✓ fits
```

That is the whole fix. It costs one extra `Vec` entry in the crank schedule. It needs
no second program, no second build toolchain, no hand-encoded instruction boundary, no
hand-written byte decoder in the frontend (the BOLT TypeScript client keeps decoding
`Bullets` for free), and no third CPI depth level.

**Decision, forced: split `BossTick` into two `world::apply` instructions. Do not
build a bullet program.** Build one only if profiling later shows the 928-byte Borsh
round-trip actually costs something at 2.5 Hz — which on a 200,000 CU budget it will
not. This reverses §6's "Accept, narrowly."

**The leaderboard is a weaker candidate still.** Cold-path, written once per match,
tiny, already handled by the Magic Action in spec §5. Leave it.

---

## 5. Q4 — Is there a CU or latency benefit?

### Latency: none. Zero. Not close.

ER slot time is ~10 ms. Compute for 128 bullet steps plus a raycast against ~10 part
hitboxes is arithmetic on a few hundred bytes — call it low tens of thousands of CU
against a 200,000 CU per-instruction budget. Compute is not the bottleneck, is not
near the bottleneck, and shaving it changes nothing a player can perceive.

The MagicBlock ER gives you **no extra CU headroom** either, per its own Runtime Limits
page:

| Limit | Solana base layer | Ephemeral Rollup |
|---|---|---|
| CU per instruction (default) | 200,000 | 200,000 |
| CU per transaction (max, via `SetComputeUnitLimit`) | 1,400,000 | 1,400,000 |
| Transaction size | 1,232 bytes | 64 KB |
| Account size | 10 MiB | 10 MiB |
| Slot time | ~400 ms | ~10 ms |

### CU: yes, but not from Pinocchio

Pinocchio's advertised 88–95% savings come from account *deserialization* and entrypoint
overhead — the per-account fixed cost of an Anchor `Account<'info, T>`. They do not
come from arithmetic being faster. Your arithmetic is the same arithmetic.

The overhead that actually exists in this design is **structural, not framework**:

- `world::apply` = 1 CPI to the system + **one CPI per touched component**
- CPI base cost: **1,000 CU** each (946 with SIMD-0339 active)
- plus, per component: Borsh serialize in the system → write to return data → read back
  in World → Borsh deserialize in `update` → `set_inner`

Touch six components and you have paid ~7,000 CU in CPI overhead alone before any
game logic runs, plus six Borsh round-trips over the wire format. Moving the bullet
pool out removes the largest of those round-trips entirely — a 928-byte serialize and
deserialize per tick, 2.5 times a second, forever.

So: the CU win is real, and it comes from **not round-tripping through BOLT**, which
you would get from a plain Anchor program just as well. Pinocchio adds maybe a few
hundred CU on top of that. It is a rounding error on a budget you are not close to
exhausting.

**Pick Pinocchio for the bullet program because it is the right tool for a fixed-layout
no-alloc buffer and you already know it — not because the CU numbers demand it.** If
the honest answer is "I want to write Pinocchio," that is a fine reason for a side
program that owns one account. It is not a reason to bend the architecture.

---

## 6. Q5 — The recommendation

**Reject the hybrid as framed. Accept one carve-out.**

### Reject

"A Pinocchio program alongside BOLT, doing CPI between them where needed" — if "where
needed" means Pinocchio operating on ECS state — is **architecturally impossible for
writes** (§3) and **pointless for reads** (a BOLT system can already read every
component it declares, for free, with no CPI). There is no version of this that pays
for its complexity. It would add: a second program to deploy and version, a second
build toolchain in the workspace, a hand-rolled instruction encoding at the boundary,
a third CPI level of stack depth, and an entire class of "why is this account not
updating" bugs — in exchange for nothing.

Spec §11 already reached the right conclusion, for a slightly wrong reason. It said
the boss stopped being a cellular automaton so the CU justification evaporated. True.
This research adds the stronger reason: **even if CU mattered, the write path is
closed.**

### ~~Accept, narrowly~~ → REJECT THIS TOO (corrected on verification)

The original recommendation here was "one program that owns one account holding
`[Bullet; 128]`," justified by the 1024-byte ceiling. **The ceiling is real and
verified (§4.1a), but it does not justify a second program.** Two top-level
`world::apply` instructions in the same crank task each get a fresh 1024-byte return-
data window (§4.1b), which solves it inside BOLT for the cost of one array element in
`ScheduleTaskArgs.instructions`.

**Build no second program.** At spec §10 step 3, write `BossTick` as two BOLT systems
— `BulletTick` (`#[system_input]` = `Bullets` alone) and `BossLogic` (everything else)
— and schedule both in one crank task. If the 928-byte Borsh round-trip ever shows up
in a CU profile at 2.5 Hz, revisit; it will not.

The ten-minute return-data experiment this document originally called for is **no
longer needed** — the answer was read out of `magicblock-validator`'s dependency graph
and is 1024. Spend that time on §7.5 instead, which is a live build blocker.

### The thing you should not skip

Read §7 before you commit to BOLT at all. The Pinocchio question turns out to be a
smaller decision than the one sitting underneath it.

---

## 7. Contradictions with the frozen design spec

Three, in descending order of how much they should worry you.

### 7.1 — BOLT looks unmaintained (spec §5 depends on it entirely)

Evidence, all primary:

| Signal | Finding |
|---|---|
| MagicBlock docs index (`docs.magicblock.gg/llms.txt`, 227 lines, fetched 2026-08-31) | **Zero** occurrences of "bolt". Every other product — ER, Magic Router, cranks, VRF, session keys, Ephemeral SPL Token, PERs, oracle — is listed. |
| BOLT doc pages (`/pages/tools/bolt/*`) | Return HTTP 200 but serve the generic landing page. Orphaned, not routed. |
| Last functional commit to `magicblock-labs/bolt` | **2025-10-19** (`Fixing CI error report #212`). One README-only commit since, 2026-05-28. |
| `bolt-lang` on crates.io | Newest installable is **0.2.4** (2025-07-23). **0.2.5 and 0.2.6 are YANKED.** |
| `@magicblock-labs/bolt-cli` / `bolt-sdk` on npm | **0.2.4**. |
| Repo workspace version | `0.2.6` — the repo is ahead of anything you can install. |
| GitHub stars | 63. |
| Notable reverted work | PR #196 "CPI Authentication using a World PDA" → reverted in #213. |

**What still works:** all three BOLT programs are live and executable on devnet right
now (verified via `getAccountInfo`):

```
WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n   world       executable ✓
7X4EFsDJ5aYTcEjKzJ94rD8FRKgQeXC89fkpeTS4KaqP  bolt-system executable ✓
CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua  component   executable ✓
```

So BOLT is not broken. You can ship HEARTROT on it. The risk is that you are building
on a framework with no upstream fixes, no docs, a yanked latest release, and a pinned
`anchor-lang = "^0"` / `solana-program = "^2"` that nobody is updating. For a devnet
game jam that is survivable. For anything you intend to maintain it is a real cost,
and it is a cost the spec never priced.

### 7.2 — Spec §11's factual claim about Pinocchio + ER is wrong today

Spec §11 states:

> "`ephemeral-rollups-sdk` supports native Rust call sites but uses
> `solana_program::AccountInfo`, which is incompatible with Pinocchio's own
> `AccountInfo`; a Pinocchio integration means hand-rolling the delegate, commit,
> undelegate, and `ScheduleTask` CPIs. That is a worthwhile standalone project
> (`pinocchio-ephemeral-rollups` does not exist)"

It exists. It is called **`ephemeral-rollups-pinocchio`**, it is MagicBlock's own crate
in the `ephemeral-rollups-sdk` repo at `rust/pinocchio/`, and **version 0.17.0 was
published on 2026-08-26 — five days before this research.** 5,655 downloads.

It covers every CPI §11 says you would have to hand-roll:

```
rust/pinocchio/src/instruction/delegate.rs
rust/pinocchio/src/instruction/commit.rs
rust/pinocchio/src/instruction/commit_and_undelegate.rs
rust/pinocchio/src/instruction/undelegate.rs
rust/pinocchio/src/instruction/delegate_with_actions.rs
rust/pinocchio/src/crank.rs                    ← ScheduleTask / schedule-crank
rust/pinocchio/src/ephemeral_accounts.rs
rust/pinocchio/src/acl/…                       ← permissions
rust/pinocchio/src/intent_bundle/…             ← Magic Actions
rust/pinocchio/src/spl/…                       ← ephemeral ATAs
```

Verbatim from `rust/pinocchio/src/crank.rs` — the crank the spec calls
`MagicBlockInstruction::ScheduleTask`:

```rust
const SCHEDULE_CRANK_DISCRIMINANT: [u8; 4] = 6_u32.to_le_bytes();

pub struct ScheduleCrankArgs<'a> {
    pub task_id: i64,
    pub execution_interval_millis: i64,
    pub iterations: i64,
    pub instructions: &'a [CrankInstruction<'a>],
}

impl<'a> ScheduleCrankArgs<'a> {
    #[inline(always)]
    pub const fn execution_interval_millis(mut self, execution_interval_millis: i64) -> Self {
        self.execution_interval_millis = execution_interval_millis;
        self
    }

    #[inline(always)]
    pub const fn iterations(mut self, iterations: i64) -> Self {
        self.iterations = iterations;
        self
    }
}
```

Manifest — **corrected on verification** to the *published* 0.17.0 crate rather than
the workspace-templated one on `main` (the `main` version uses `workspace = true`
placeholders that hide the real pins):

```toml
[package]
name    = "ephemeral-rollups-pinocchio"
version = "0.17.0"
edition = "2021"

[features]
default             = []
delegation-actions  = ["pinocchio/alloc", "pinocchio/cpi",
                       "magicblock-delegation-program-api"]
intent-bundle       = []

[dependencies.pinocchio]
version          = "0.11"
default-features = false
features         = ["cpi", "alloc", "account-resize", "copy"]

[dependencies.pinocchio-system]
version = "0.6"

[dependencies.solana-address]
version  = ">=2, <3"
features = ["curve25519", "decode"]

[dependencies.magicblock-delegation-program-api]
version  = "3.1.0"
optional = true
```

Note what the published manifest shows that the `main` snippet did not: `pinocchio`
0.11 is a **non-optional** dependency with `cpi` already enabled, so the `cpi`-feature
gotcha (§9 item 7) does not bite you through this crate — only in your own program's
direct `pinocchio` dependency. The published crate also ships a `vrf/` module the
original file listing omitted (`vrf/instruction.rs`, `vrf/rnd.rs`, `vrf/pda.rs`),
which is relevant to spec §1's VRF-varied incarnations.

The `AccountInfo` incompatibility §11 describes is also gone — Pinocchio 0.11 renamed
the type to `AccountView`, and the ER crate uses `AccountView` natively:

```rust
use pinocchio::{
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};

pub fn delegate_account(
    accounts: &mut [AccountView],
    seeds: &[&[u8]],
    bump: u8,
    config: DelegateConfig,
) -> ProgramResult
```

**This does not reverse the recommendation in §6.** A pure-Pinocchio HEARTROT would
mean writing the World/Entity/Component scaffolding by hand, which is a week you do not
have and the reason §11 chose BOLT in the first place. That reasoning still holds. But
the *stated fact* it rests on is false, and combined with §7.1 the balance has shifted
enough that "BOLT vs. plain Anchor + `ephemeral-rollups-sdk` vs. Pinocchio + `ephemeral-rollups-pinocchio`"
deserves a fresh look before step 0 is written — not a re-litigation now, a
decision made with current facts.

### 7.3 — Spec §5's `BossTick` cannot be one `world::apply`

Covered in §4. `Bullets` alone consumes 936 of the 1024 available return-data bytes,
and §4.1a confirms the ER does not raise 1024. The spec's single-system tick that
touches bullets, boss state, core, parts and player health does not fit.

**Fix (decided, §4.1b): two BOLT systems, two `world::apply` instructions, one crank
task.** Not a second program. Spec §5 needs its `BossTick` bullet rewritten to name
`BulletTick` and `BossLogic` as separate systems, and its **Systems** line updated to
`Move · Shoot · EnterGate · BulletTick · BossLogic · Damage · Respawn · Settle`.

### 7.4 — The local `pinocchio-development` skill is stale

If you follow the skill's snippets verbatim, they will not compile.

| Skill says | Actual, verified 2026-08-31 |
|---|---|
| `pinocchio = "0.10"` | **0.11.2** (2026-06-09) |
| `pinocchio-system = "0.4"` | **0.6.1** (2026-04-23) |
| `pinocchio-token = "0.4"` | not verified this session |
| `use pinocchio::account_info::AccountInfo` | **`use pinocchio::AccountView`** — type renamed, module reorganized |
| `accounts: &[AccountInfo]` in the entrypoint | **`accounts: &mut [AccountView]`** |
| `pubkey::Pubkey` | **`Address`** |
| `pinocchio::program::invoke` | **`pinocchio::cpi::invoke`** |
| `program_error::ProgramError` | **`pinocchio::error::ProgramError`** |

Current entrypoint shape, verbatim from `sdk/src/lib.rs` in `anza-xyz/pinocchio` @ `main`:

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

Pinocchio 0.11 also restructured into upstream Solana crates — `solana-account-view`,
`solana-address`, `solana-instruction-view`, `solana-program-error` — behind feature
flags (`cpi`, `alloc`, `copy`, `sha2`, `account-resize`). `set_return_data` /
`get_return_data` now live in `pinocchio::cpi` and **require the `cpi` feature**.
Verified from the published `pinocchio` 0.11.2 manifest and `src/lib.rs:360-367`:
`default = ["alloc", "copy", "sha2"]`, and the `instruction`/`cpi` re-export is
`#[cfg(feature = "cpi")]`.

### 7.5 — NEW: `bolt-lang` 0.2.4 does not resolve to a buildable set today

This is the practical blocker, and it was an unanswered open question in the original
draft. It is now answered: **no, not with default resolution.**

`magicblock-labs/bolt` `Cargo.toml` at **both** `v0.2.4` and `main` pins its
dependencies as open caret ranges that nobody has updated since July 2025:

```toml
anchor-lang           = { version = "^0", features = ["init-if-needed"] }
solana-program        = { version = "^2" }
ephemeral-rollups-sdk = "^0"
```

and `bolt-lang` enables the SDK's `anchor` feature and re-exports its types straight
into BOLT's own Anchor world (`crates/bolt-lang/src/lib.rs`, v0.2.4):

```rust
pub use ephemeral_rollups_sdk::anchor::{DelegationProgram, MagicProgram};
pub use ephemeral_rollups_sdk::cpi::{delegate_account, undelegate_account,
                                     DelegateAccounts, DelegateConfig};
pub use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;
```

Trace what those ranges resolve to on 2026-08-31:

| Range | Resolves to | Consequence |
|---|---|---|
| `ephemeral-rollups-sdk = "^0"` | **0.17.0** (2026-08-26) | its `anchor` feature → `anchor-modern` → `anchor-lang-current`, which is `package = "anchor-lang", version = "1.0"` |
| `anchor-lang = "^0"` (bolt's own) | **0.32.1** — newest pre-1.0 | BOLT's `#[derive(Accounts)]`, `Context`, `AccountInfo` all come from the 0.x line |

Those are two semver-incompatible majors of `anchor-lang` linked into the same binary,
and they meet at the re-export above: `DelegationProgram`/`MagicProgram` are anchor-1.x
types being placed inside anchor-0.x account structs. Cargo will not unify them and
the types will not typecheck. Anchor is now at **1.1.2**, with **2.0.0-rc.1** published
— BOLT is two majors behind on an unbounded range.

**MEASURED, not inferred (verification pass, 2026-09-01).** `cargo 1.98.0` *was*
available and the experiment has now been run. A scratch crate whose only dependency is
`bolt-lang = "=0.2.4"`, resolved with `cargo generate-lockfile`, produces:

```
anchor-lang     0.32.1  AND  1.1.2      ← two majors, as predicted
solana-program  2.3.0   AND  3.0.0      ← a SECOND double-major, NOT predicted
ephemeral-rollups-sdk           0.17.0
```

Two corrections to the original draft fall out of this:

- The conflicting `anchor-lang` is **1.1.2**, not 1.0 — `anchor-lang-current`'s `"1.0"`
  is a caret range, so it floats to the newest 1.x.
- **`solana-program` is duplicated too** (bolt's `^2` → 2.3.0; SDK 0.17.0's
  non-optional `solana-program = "3.0.0"` → 3.0.0). The original draft missed this.
  Same root cause, same fix.

### The fix — and why the originally prescribed one is WRONG

The original draft told you to add four manifest pins. **Do not do that. It was tested
and it makes the problem worse.** With `bolt-lang = "=0.2.4"`, `bolt-system = "=0.2.4"`,
`ephemeral-rollups-sdk = "=0.13.0"` and `anchor-lang = "=0.31.1"` all declared as
direct dependencies, the lockfile comes out as:

```
anchor-lang            0.31.1  AND  0.32.1  AND  1.1.2   ← now THREE
ephemeral-rollups-sdk  0.13.0  AND  0.17.0            ← now TWO
solana-program          2.3.0  AND   3.0.0            ← unchanged
```

The reason is Cargo's unification rule: it unifies only *within* a semver-compatibility
range, and for `0.x` the minor defines that range. A top-level `=0.13.0` sits in the
`0.13` range; bolt's transitive `^0` still greedily takes `0.17.0` in the `0.17` range.
Both requirements are satisfiable simultaneously by two copies, so Cargo ships two
copies rather than backtracking. `anchor-lang = "=0.31.1"` fails the same way against
bolt's `^0` → 0.32.1 — **verified independently: that pin alone yields `0.31.1` AND
`0.32.1`.** A manifest pin cannot pull a transitive dependency *down*; it only adds a
requirement alongside it.

**The correct fix is a lockfile operation, not a manifest pin.** Declare `bolt-lang`
alone, then force the transitive SDK down:

```bash
cargo generate-lockfile
cargo update -p ephemeral-rollups-sdk --precise 0.13.0
```

Measured result — everything collapses to one copy each:

```
anchor-lang            0.32.1     ✓ single
solana-program          2.3.0     ✓ single
ephemeral-rollups-sdk  0.13.0     ✓ single
bolt-system             0.2.4     ✓ (pinned `=0.2.4` by bolt-lang itself)
```

Commit `Cargo.lock`. That is what holds the resolution — nothing in `Cargo.toml` does.

Note the landing version is **`anchor-lang` 0.32.1, not 0.31.1.** Do not try to force
0.31.1: as shown above the manifest pin duplicates it, and `cargo update -p anchor-lang
--precise 0.31.1` would be a second unnecessary deviation from what bolt's own `^0`
selects. Take 0.32.1 unless it actually fails to compile.

Why `ephemeral-rollups-sdk` 0.13.0 specifically, verified by downloading each crate and
reading its published manifest:

| SDK version | `anchor-lang` dependency | Usable with BOLT? |
|---|---|---|
| 0.12.0, 0.13.0 | one dep, `version = ">=0.28.0"`, feature `anchor = ["anchor-lang"]`; `solana-program` is `>=1.16, <3` and optional | **Yes** — unifies with bolt's `^0` at 0.32.1 |
| 0.14.0 → 0.17.0 | split into `anchor-lang-compat` `>=0.28.0, <1.0.0` **and** `anchor-lang-current` `"1.0"`; feature `anchor = ["anchor-modern"]` selects the latter. `solana-program` becomes non-optional `3.0.0` | **No** |

`0.13.0` (published 2026-05-01) still carries everything spec §5 needs: `crank.rs`
with `ScheduleCrankCpi` / `ScheduleTaskArgs`, and via `magicblock-magic-program-api`
0.8.5 that struct is already `{ task_id, execution_interval_millis, iterations,
instructions: Vec<Instruction> }` (verified by reading the published 0.8.5 source) — so
the two-instruction crank of §4.1b works on the downgraded SDK, not only on 0.17.0.

**Confidence and its limit:** the *resolution* is now measured, not inferred — the
lockfiles above are real output. What is still **not** verified is that the unified set
actually **compiles**: `cargo check` was attempted and died on `Disk quota exceeded`
partway through the dependency tree, not on a type error. Single-copy resolution is
necessary for the build to work and was the specific failure predicted; it is not by
itself proof of success. Re-run `cargo check` on a volume with a few GB free before
treating step 0 as closed.

---

## 8. Pinned versions

Everything below was read from crates.io / npm / the repos on **2026-08-31**.

### On-chain program IDs (all verified live and executable on Solana devnet)

| Program | ID |
|---|---|
| BOLT World | `WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n` |
| BOLT System interface | `7X4EFsDJ5aYTcEjKzJ94rD8FRKgQeXC89fkpeTS4KaqP` |
| BOLT Component interface | `CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua` |

### Crates

| Crate | Installable | Published | Note |
|---|---|---|---|
| `bolt-lang` | **0.2.4** | 2025-07-23 | 0.2.5, 0.2.6 **YANKED** |
| `bolt-system` | 0.2.6 | 2025-09-24 | not yanked — version skew vs `bolt-lang` |
| `bolt-cli` | 0.2.4 | — | |
| `anchor-lang` | 0.32.1 is newest 0.x | — | **1.0.0 / 1.0.3 / 1.1.1 / 1.1.2 exist, plus 2.0.0-rc.1.** BOLT's `^0` cannot reach them. **Take 0.32.1 — do NOT pin `=0.31.1`, it duplicates (§7.5, measured)** |
| `ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | actively maintained — **but BOLT needs 0.13.0, forced via `cargo update --precise`, not a manifest pin (§7.5)** |
| `ephemeral-rollups-sdk` (BOLT-safe) | **0.13.0** | 2026-05-01 | last release before the anchor-1.0 feature split; still has `crank.rs` |
| `magicblock-magic-program-api` (via SDK 0.13.0) | 0.8.5 | — | `ScheduleTaskArgs.instructions: Vec<Instruction>` already present |
| `ephemeral-rollups-pinocchio` | **0.17.0** | 2026-08-26 | **exists**, contra spec §11 |
| `pinocchio` | **0.11.2** | 2026-06-09 | `AccountView`, not `AccountInfo` |
| `pinocchio-system` | **0.6.1** | 2026-04-23 | |
| `magicblock-delegation-program-api` | 3.1.0 | 2026-07-08 | |
| `magicblock-magic-program-api` | 0.14.10 | 2026-08-16 | |

### npm

| Package | Version |
|---|---|
| `@magicblock-labs/bolt-cli` | 0.2.4 |
| `@magicblock-labs/bolt-sdk` | 0.2.4 |

### Runtime constants

| Constant | Value | Source |
|---|---|---|
| `MAX_RETURN_DATA` | **1,024 bytes — on the ER too** | `solana-cpi` 3.1.0 `src/lib.rs:330`; enforced in `agave-syscalls` 4.0.0 `src/lib.rs:1898`, which `magicblock-validator` takes **unpatched** from crates.io |
| CPI base cost | 1,000 CU (946 with SIMD-0339) | Solana compute budget docs |
| Max instruction stack depth | 5 (9 with SIMD-0268) | Solana compute budget docs |
| CU per instruction, default | 200,000 (both base layer and ER) | Solana docs / MagicBlock Runtime Limits |
| CU per transaction, max | 1,400,000 (both) | same |
| Transaction size | 1,232 B base / 64 KB ER | MagicBlock Runtime Limits |
| Account size | 10 MiB (both) | MagicBlock Runtime Limits |
| ER slot time | ~10 ms | MagicBlock Runtime Limits |

### Anchor discriminators (computed: first 8 bytes of `sha256("global:<name>")`)

| Instruction | Hex | Bytes |
|---|---|---|
| `bolt_execute` | `4bce3ed234d7686d` | `[75, 206, 62, 210, 52, 215, 104, 109]` |
| `update` | `dbc858b09e3ffd7f` | `[219, 200, 88, 176, 158, 63, 253, 127]` |
| `update_with_session` | `dd37d48d39553db6` | `[221, 55, 212, 141, 57, 85, 61, 182]` |
| `initialize` | `afaf6d1f0d989bed` | `[175, 175, 109, 31, 13, 152, 155, 237]` |
| `apply` | `f8f391186932a2e1` | `[248, 243, 145, 24, 105, 50, 162, 225]` |
| `apply_with_session` | `d5451de68e6b8667` | `[213, 69, 29, 230, 142, 107, 134, 103]` |

You need these only if you go against the recommendation and hand-encode a BOLT call
from a non-Anchor program. They are listed so that if you try it, you try it with the
right bytes rather than guessed ones.

---

## 9. Gotchas and failure modes

Ranked by how likely they are to cost you a day.

1. **The 1024-byte return-data ceiling is silent until it isn't.** It is not documented
   in BOLT at all. You will discover it the first time `BossTick` grows past two
   components, as an opaque transaction failure inside `sol_set_return_data`. It fails
   loudly at runtime rather than corrupting data — small mercy — but nothing warns you
   at compile time. Budget it up front.

2. **`bolt-lang` 0.2.5 and 0.2.6 are yanked.** `cargo add bolt-lang` gives you 0.2.4
   from July 2025. The repo's workspace is at 0.2.6. If you copy a pattern out of the
   repo's `main` branch it may not exist in the crate you can actually install —
   `Implicit execute lifetimes` (#203) shipped in 0.2.5/0.2.6, both yanked. **Pin
   `bolt-lang = "=0.2.4"` and read the 0.2.4 tag, not `main`.** Confirmed concretely:
   `examples/escrow-funding/` — the example §2 leans on — is a 404 at `v0.2.4`, as is
   the entire `system-with-N-components` series. Only five examples exist at that tag.

2b. **BOLT 0.2.4 does not resolve to a buildable dep set out of the box — and the fix
   is a lockfile command, not a manifest pin.** Measured: `bolt-lang = "=0.2.4"` alone
   pulls **two** `anchor-lang` majors (0.32.1 + 1.1.2) *and* two `solana-program`
   majors (2.3.0 + 3.0.0). Adding `=` pins to `Cargo.toml` makes it **worse** (three
   `anchor-lang`, two SDK copies) because a manifest requirement cannot pull a
   transitive dependency down. The fix is:
   `cargo generate-lockfile && cargo update -p ephemeral-rollups-sdk --precise 0.13.0`,
   then commit `Cargo.lock`. This is the single most likely thing to eat your first
   day. Full derivation and measured lockfiles in §7.5.

3. **`get_instruction_relative(0)` reads the TOP-LEVEL instruction, not the caller.**
   This trips people in both directions. It means a Pinocchio program can never be the
   top-level entry point of a transaction that also writes components. It also means
   the `InvalidCaller` guard is weaker than it looks — anything reached from inside a
   `world::apply` chain passes it. Do not rely on that guard as a security boundary in
   your own code, and do not exploit it either (§3).

4. **CPI depth. You start at 3.** `world::apply` (1) → `bolt_execute` (2) → your CPI
   (3). Limit is 5. If your Pinocchio program then CPIs the System Program to create an
   account, you are at 4. One more level and you are out.

5. ~~**Return-data on the ER is unverified.**~~ **RESOLVED — the ER cap is 1024.**
   `magicblock-validator` patches only `solana-account`, `solana-program-runtime`,
   `solana-svm` and `solana-transaction-context`; the syscall crate that enforces the
   limit, `agave-syscalls 4.0.0`, is unpatched. See §4.1a. No experiment needed.

6. **Pinocchio 0.10 → 0.11 is a breaking rename, and every tutorial you find is 0.10.**
   `AccountInfo` → `AccountView`, `Pubkey` → `Address`, `program::invoke` →
   `cpi::invoke`, `program_error::ProgramError` → `error::ProgramError`. The local
   `pinocchio-development` skill is on the old API (§7.4). Check `docs.rs/pinocchio` for
   the version banner before trusting any snippet, including the ones in that skill.

7. **`set_return_data` needs the `cpi` feature.** In 0.11 it lives in `pinocchio::cpi`
   and is gated. Default features include `alloc`, `copy`, `sha2` — **not `cpi`**. You
   will get a confusing unresolved-import error otherwise.

8. **A BOLT system cannot conditionally skip a component write.** It returns one blob
   per component pair, and World checks `results.len() != pairs.len()` →
   `InvalidSystemOutput`. Every component you declare in `#[system_input]` gets written
   every call, whether it changed or not — that is a `component::update` CPI plus a full
   Borsh round-trip per component per tick, paid unconditionally. It is another reason
   to keep `#[system_input]` sets small.

9. ~~**Version skew between `bolt-lang` (0.2.4) and `bolt-system` (0.2.6).**~~
   **OVERSTATED — corrected on verification.** `bolt-lang` 0.2.4's published manifest
   pins `bolt-system = "=0.2.4"` (exact, along with `world` and every
   `bolt-attribute-*` crate). Cargo *cannot* drift `bolt-system` to 0.2.6 underneath
   it, and the measured lockfile confirms 0.2.4. The skew only bites if **you** declare
   `bolt-system` as your own direct dependency without a pin — so simply do not declare
   it; take it transitively.

10. **If a Pinocchio program is ever handed a delegated account, ownership differs by
    layer.** On the base layer a delegated account is owned by the delegation program;
    inside the ER the original owner is restored. Any ownership assertion you write has
    to account for which side it runs on. I did not verify the exact ER behaviour this
    session — **low confidence, check before relying on it.**

---

## 10. What to actually do

```
Now         Nothing. Do not build the hybrid. Spec §11's conclusion stands.
            Build no second program at all — the bullet-pool carve-out was
            withdrawn on verification (§4.1b).

Step 0,     ALREADY RUN (2026-09-01). Two anchor-lang majors AND two
first hour   solana-program majors do appear. Apply the §7.5 fix, which is
             a lockfile command, NOT the manifest pins the first draft
             prescribed (those make it worse — measured):
                 cargo generate-lockfile
                 cargo update -p ephemeral-rollups-sdk --precise 0.13.0
             then commit Cargo.lock. Then run `cargo check` on a volume
             with free space — that half is still unproven (§7.5).

Before      Decide BOLT vs. plain Anchor + ephemeral-rollups-sdk, with §7.1,
step 0      §7.2 and now §7.5 on the table. §7.5 is a real thumb on the scale:
            BOLT's unmaintained open ranges have already broken once.

Step 3      Write BossTick as TWO BOLT systems, BulletTick (Bullets only,
            936 B) and BossLogic (everything else), scheduled as two
            instructions in one crank task. No new program, no new toolchain.

Never       A Pinocchio program that writes BOLT component accounts.
            The SVM does not permit it.
Never       The 1024-byte ER return-data experiment. Already answered: 1024.
```

---

## Sources

Every URL below was fetched and read during this research on 2026-08-31.

### BOLT source (read via GitHub API, `magicblock-labs/bolt` @ `main`)
- https://github.com/magicblock-labs/bolt
- https://github.com/magicblock-labs/bolt/blob/main/crates/programs/world/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/programs/bolt-system/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/programs/bolt-component/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/bolt-lang/attribute/system/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/bolt-lang/attribute/component/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/bolt-lang/attribute/bolt-program/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/bolt-lang/attribute/extra-accounts/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/crates/bolt-lang/utils/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/examples/escrow-funding/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/examples/system-apply-velocity/src/lib.rs
- https://github.com/magicblock-labs/bolt/blob/main/Cargo.toml
- https://api.github.com/repos/magicblock-labs/bolt/releases
- https://api.github.com/repos/magicblock-labs/bolt/commits

### Ephemeral Rollups SDK source (`magicblock-labs/ephemeral-rollups-sdk` @ `main`)
- https://github.com/magicblock-labs/ephemeral-rollups-sdk/blob/main/rust/pinocchio/Cargo.toml
- https://github.com/magicblock-labs/ephemeral-rollups-sdk/blob/main/rust/pinocchio/README.md
- https://github.com/magicblock-labs/ephemeral-rollups-sdk/blob/main/rust/pinocchio/src/crank.rs
- https://github.com/magicblock-labs/ephemeral-rollups-sdk/blob/main/rust/pinocchio/src/instruction/delegate.rs

### Pinocchio source (`anza-xyz/pinocchio` @ `main`)
- https://github.com/anza-xyz/pinocchio
- https://github.com/anza-xyz/pinocchio/blob/main/sdk/src/lib.rs
- https://github.com/anza-xyz/pinocchio/blob/main/sdk/Cargo.toml
- https://docs.rs/pinocchio/latest/pinocchio/cpi/index.html
- https://docs.rs/pinocchio/latest/pinocchio/cpi/fn.set_return_data.html

### Solana runtime primary docs
- https://docs.anza.xyz/proposals/return-data
- https://solana.com/docs/core/accounts
- https://solana.com/docs/core/instructions/instruction-introspection
- https://solana.com/docs/core/fees/compute-budget
- https://docs.rs/solana-program/latest/solana_program/sysvar/instructions/fn.get_instruction_relative.html

### MagicBlock docs
- https://docs.magicblock.gg/llms.txt
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/runtime-limits.md
- https://docs.magicblock.gg/pages/tools/bolt/introduction (HTTP 200, serves landing page — orphaned)
- https://docs.magicblock.gg/pages/tools/bolt/getting-started/create-system (same)
- https://book.boltengine.gg/introduction/ecs.html

### Registries (JSON APIs)
- https://crates.io/api/v1/crates/bolt-lang
- https://crates.io/api/v1/crates/bolt-system
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/ephemeral-rollups-pinocchio
- https://crates.io/api/v1/crates/pinocchio
- https://crates.io/api/v1/crates/pinocchio-system
- https://crates.io/api/v1/crates/magicblock-delegation-program-api
- https://crates.io/api/v1/crates/magicblock-magic-program-api
- https://registry.npmjs.org/@magicblock-labs/bolt-cli
- https://registry.npmjs.org/@magicblock-labs/bolt-sdk

### Live chain
- `https://api.devnet.solana.com` — `getAccountInfo` on the three BOLT program IDs

---

## Verification

Adversarial re-check, **2026-09-01**, independent of the original research pass. Every
source below was fetched fresh; nothing was taken on the original author's word. Where
possible, claims were tested by *execution* (crates.io tarballs downloaded and grepped,
`cargo generate-lockfile` actually run, devnet RPC actually called) rather than by
reading prose about them.

### Confirmed — checked directly, no change needed

| Claim | How it was verified | Result |
|---|---|---|
| `MAX_RETURN_DATA = 1024` | Downloaded `solana-cpi-3.1.0.crate`, `src/lib.rs:330` | `pub const MAX_RETURN_DATA: usize = 1024;` ✓ |
| The limit is enforced in `agave-syscalls`, not the forked crates | Downloaded `agave-syscalls-4.0.0.crate`; `src/lib.rs:1898` `if len > MAX_RETURN_DATA` → `ReturnDataTooLarge`; its manifest pins `solana-cpi 3.1.0` | ✓ |
| **The ER inherits 1024** (§4.1a — the load-bearing claim) | Fetched `magicblock-validator/Cargo.toml`. `[patch.crates-io]` patches `solana-account`, `solana-program-runtime`, `solana-svm`, `solana-transaction-context` (all → magicblock-svm rev `0395009`), plus `solana-storage-proto`, `libsodium-rs`, `rocksdb`. **`agave-syscalls = "=4.0.0"` and `solana-cpi = "3.1"` are NOT patched.** | ✓ Confirmed. No experiment needed. |
| The `InvalidCaller` guard exists in the **installable** 0.2.4 | Downloaded `bolt-attribute-bolt-program-0.2.4.crate`. `src/lib.rs:232` = `require_eq!(instruction.program_id, World::id(), BoltError::InvalidCaller);`; `initialize`/`destroy` carry it at :153 and :190 | ✓ Not a `main`-only artifact |
| `BoltMetadata` is 32 bytes | `bolt-lang-0.2.4/src/lib.rs:73` = `struct BoltMetadata { authority: Pubkey }`; `bolt-attribute-bolt-component-0.2.4/src/lib.rs:54` calls `add_bolt_metadata` on every component | ✓ The 936-byte arithmetic holds |
| Systems return `Vec<Vec<u8>>` | `bolt-attribute-bolt-system-0.2.4/src/lib.rs:130` `item_fn.sig.output = parse_quote! { -> Result<Vec<Vec<u8>>> }` | ✓ |
| `#[extra_accounts]` is in 0.2.4 and is 106 lines | Downloaded the 0.2.4 attribute crate; `wc -l` = 106 | ✓ |
| `examples/escrow-funding` is `main`-only | HTTP status by ref: `main` 200, **`v0.2.4` 404**, `v0.2.6` 200 | ✓ The §2 caveat is real |
| bolt-lang 0.2.5/0.2.6 yanked; 0.2.4 newest installable | crates.io API | ✓ |
| `bolt-system` 0.2.6 not yanked | crates.io API | ✓ (but see the gotcha-9 correction) |
| pinocchio 0.11.2 / pinocchio-system 0.6.1 | crates.io API | ✓ |
| **Pinocchio 0.11 renamed `AccountInfo`→`AccountView`, `Pubkey`→`Address`** | docs.rs 0.11.2 item index: `AccountView` ✓, `Address` ✓, `cpi` module ✓; **no `AccountInfo`, no `Pubkey`, no `account_info` module, no `pubkey` module** | ✓ The stale-skill warning (§7.4) is correct |
| `set_return_data` needs the non-default `cpi` feature | `pinocchio-0.11.2/Cargo.toml`: `default = ["alloc","copy","sha2"]`, `cpi = ["dep:solana-instruction-view"]`; `src/lib.rs:366` `#[cfg(feature = "cpi")]` gates the `cpi` re-export | ✓ |
| `ephemeral-rollups-pinocchio` 0.17.0 exists (contra spec §11) | crates.io API: 0.17.0, 2026-08-26, **5,656 downloads**. Deps: `pinocchio ^0.11`, `pinocchio-system ^0.6`. Separately confirmed the literal name `pinocchio-ephemeral-rollups` **does not exist** — so spec §11's *name* was right, its *conclusion* was wrong | ✓ |
| BOLT unmaintained signals | `llms.txt` = 227 lines, **0 case-insensitive matches for "bolt"** while crank/VRF/router/session/prediction-markets all appear. Repo: 63 stars, `archived: false`, last functional commit **2025-10-19** (`#212`), one README commit 2026-05-28. PR **#196 reverted by #213 on 2025-10-17** — both visible in the commit log | ✓ Every signal reproduced |
| ER runtime limits table | Fetched MagicBlock Runtime Limits page: 200,000 CU/ix and 1,400,000 CU/tx **on both layers**; tx size 1,232 B vs 64 KB; account 10 MiB both; slot ~400 ms vs ~10 ms. Page is **silent on return data**, exactly as the doc says | ✓ |
| All three BOLT programs live on devnet | `getAccountInfo` against `api.devnet.solana.com`: all three `executable: true`, owner `BPFLoaderUpgradeab1e…` | ✓ |
| npm `bolt-cli` / `bolt-sdk` = 0.2.4 | registry.npmjs.org — both `latest` 0.2.4, published 2025-07-23 | ✓ |
| `ScheduleTaskArgs.instructions: Vec<Instruction>` in 0.8.5 | Downloaded `magicblock-magic-program-api-0.8.5.crate`; `src/args.rs:174-179` | ✓ The two-instruction crank works on the downgraded SDK |
| All six Anchor discriminators | Recomputed `sha256("global:<name>")` locally — `update` = `dbc858b09e3ffd7f`, `bolt_execute` = `4bce3ed234d7686d`, `apply` = `f8f391186932a2e1`, etc. | ✓ All six match exactly |
| §7.5 root cause | `bolt-lang-0.2.4/Cargo.toml`: `ephemeral-rollups-sdk = { version = "^0", features = ["anchor"] }` and `anchor-lang = "^0"`. `ephemeral-rollups-sdk-0.17.0/Cargo.toml`: `anchor = ["anchor-modern"]` → `anchor-modern = [… "anchor-lang-current" …]` → `[dependencies.anchor-lang-current] version = "1.0", package = "anchor-lang"` | ✓ Diagnosis exactly right |

### Corrected in place

1. **§7.5 / §9 gotcha 2b / §10 / TL;DR — the prescribed fix was wrong.** This is the
   material finding of the verification pass. The *diagnosis* was correct, but the
   remedy — four `=` pins in `Cargo.toml` — was never executed by the original author
   and **does not work.** Measured with `cargo 1.98.0`:

   - `bolt-lang = "=0.2.4"` alone → `anchor-lang` **0.32.1 + 1.1.2**, `solana-program`
     **2.3.0 + 3.0.0**, `ephemeral-rollups-sdk` 0.17.0.
   - With the four prescribed pins → `anchor-lang` **0.31.1 + 0.32.1 + 1.1.2** (three),
     `ephemeral-rollups-sdk` **0.13.0 + 0.17.0** (two). **Strictly worse.**
   - `anchor-lang = "=0.31.1"` tested in isolation → **0.31.1 + 0.32.1.** The pin the
     doc recommended is itself a duplication source.
   - Working fix: `cargo generate-lockfile && cargo update -p ephemeral-rollups-sdk
     --precise 0.13.0` → single `anchor-lang` 0.32.1, single `solana-program` 2.3.0,
     single `ephemeral-rollups-sdk` 0.13.0, `bolt-system` 0.2.4.

   Root cause of the bad advice: a manifest requirement cannot pull a *transitive*
   dependency down. Cargo unifies only within a semver-compat range (for `0.x`, the
   minor), so a top-level `=0.13.0` coexists with bolt's `^0`→`0.17.0` instead of
   overriding it.

2. **A second double-major was missed.** `solana-program` 2.3.0 + 3.0.0, from bolt's
   `^2` against SDK 0.17.0's non-optional `solana-program = "3.0.0"`. Same fix.

3. **"anchor-lang 1.0" → 1.1.2.** `anchor-lang-current`'s `"1.0"` is a caret range and
   floats to the newest 1.x. Cosmetic, but the doc stated a resolved version.

4. **"no Rust toolchain was available in this session" was false.** `cargo 1.98.0` is
   installed at `~/.cargo/bin/cargo`. The experiment the doc deferred to "step 0,
   first hour" has now been run and its results are recorded above.

5. **Gotcha 9 (`bolt-lang`/`bolt-system` skew) was overstated.** `bolt-lang` 0.2.4 pins
   `bolt-system = "=0.2.4"` exactly in its published manifest, so Cargo *cannot* drift
   it. Rewritten: the risk only exists if you declare `bolt-system` yourself.

6. **§4.1a "forks exactly four upstream crates"** → "four *Solana* upstream crates".
   There are seven `[patch.crates-io]` entries; four point at magicblock-svm. The
   load-bearing point (`agave-syscalls` unpatched) is unaffected.

### Nothing refuted

No claim in the document was found to be false in substance. The architectural
conclusions — Q1 yes, Q2 no (both locks real), Q3 the split is two `world::apply`
instructions and **not** a second program, Q4 no CU/latency benefit, Q5 reject the
hybrid — all survive verification. §4.1's self-correction (withdrawing the bullet-pool
carve-out) was independently re-derived and is right: the 1024 cap is per-instruction,
return data is reset on every instruction push, and `ScheduleTaskArgs` takes a `Vec`,
so two `world::apply` calls in one crank task is the cheapest thing that works.

### Still unverified — do not treat as settled

1. **That the unified dependency set actually compiles.** Resolution is proven; the
   build is not. `cargo check` was attempted and aborted with
   `Disk quota exceeded (os error 122)` in `/tmp` partway through the tree — it failed
   on storage, **not on a type error**, so it is neither pass nor fail. Single-copy
   resolution is necessary but not sufficient. **Re-run `cargo check` with a few GB
   free before calling step 0 done.** This is the highest-value remaining experiment,
   and it replaces the return-data experiment the original draft nominated.
2. **Delegated-account ownership inside the ER vs base layer** (§9 gotcha 10). Still
   not checked, still low confidence. Only matters if a native program ever asserts
   ownership — which, given the recommendation to build no second program, it should
   not have to.
3. **Whether BOLT is abandoned or merely quiet.** Every circumstantial signal was
   reproduced, but no statement from MagicBlock was obtained. A one-line answer in
   their Discord still outweighs all of the above.
4. **Whether `anchor-lang` 0.32.1 (rather than 0.31.1) works with bolt 0.2.4 at the
   type level.** It is what bolt's own `^0` selects and what unifies cleanly, so it is
   the right default — but this is the same unproven-compile question as item 1.
5. **Runtime behaviour of the two-instruction crank on a live ER.** The mechanism is
   confirmed from source and manifests; it has not been executed against a validator.
