# BOLT + ER Delegation Lifecycle

Research date: **2026-08-31**. Target: Solana **devnet**.
Scope: how BOLT entities/components get delegated to a MagicBlock Ephemeral Rollup and back,
who signs, who pays, how authority is checked, and whether HEARTROT's planned
"platform holds delegation authority, session pubkey on `PlayerMeta` checked by each system"
model actually works.

---

## 0. Bottom line up front

Three findings, in order of how much they cost us if ignored.

### 0.1 BOLT is deprecated. This contradicts the frozen design spec.

The `magicblock-labs/bolt` README on `main` opens with this, verbatim:

```markdown
> [!WARNING]
> **Deprecation Notice**
>
> Bolt has been deprecated and is no longer actively maintained.
> This repository is kept available for reference only.
```

Added in commit `719060783fe6`, **2026-05-28**, message `Update README.md`. That is the most recent
commit on the repo. Corroborating evidence:

| Signal | Value |
| --- | --- |
| Last *code* commit to `main` | `2025-10-19` (CI fix, #212) — over 10 months stale |
| `bolt-lang` latest crates.io version | **0.2.4** (2025-07-23) |
| `bolt-lang` 0.2.5 and 0.2.6 | published Sept 2025, then **YANKED** 2025-10-17 |
| `@magicblock-labs/bolt-sdk` npm `latest` dist-tag | **0.2.4** (0.2.5/0.2.6 published but not tagged latest) |
| `bolt-cli` crates.io | **0.2.4** |
| BOLT pages in `docs.magicblock.gg/llms.txt` | **zero** — the entire BOLT section has been removed from the docs |
| README's own docs link (`docs.magicblock.gg/pages/tools/bolt/introduction`) | dead, no longer in the docs index |

By contrast, the non-BOLT MagicBlock stack is actively maintained — `magicblock-validator`,
`delegation-program`, and `ephemeral-rollups-sdk` all had commits pushed within the **last 3 days**
(2026-08-28 → 2026-08-31), and `ephemeral-rollups-sdk` is at **0.17.0** (2026-08-26).

**The on-chain programs are still live on devnet**, so BOLT is not bricked — see §1.3. But the spec's
"On-chain: MagicBlock BOLT (Anchor-based ECS)" line was written against a framework its own authors
have retired.

### 0.2 A fresh `cargo build` of a BOLT program will not compile today.

BOLT's workspace `Cargo.toml` uses unpinned wildcards:

```toml
anchor-lang           = { version = "^0", features = ["init-if-needed"] }
ephemeral-rollups-sdk = "^0"
```

And `crates/bolt-lang/Cargo.toml` requests:

```toml
ephemeral-rollups-sdk = { workspace = true, features = ["anchor"]}
```

`^0` means "any 0.x". Today those resolve to `anchor-lang 0.32.1` (the last 0.x, released 2025-10-10)
and `ephemeral-rollups-sdk 0.17.0`. That combination is broken, because **ER SDK 0.14.0 redefined what
the `anchor` feature means**. From `ephemeral-rollups-sdk-0.17.0/Cargo.toml`:

```toml
anchor = ["anchor-modern"]
anchor-compat = [
    "anchor-support",
    "backward-compat",
    "anchor-lang-compat",
    "ephemeral-vrf-sdk?/anchor-compat",
]
anchor-modern = [
    "anchor-support",
    "anchor-lang-current",
    "ephemeral-vrf-sdk?/anchor-modern",
]

[dependencies.anchor-lang-compat]
version = ">=0.28.0, <1.0.0"
optional = true
package = "anchor-lang"

[dependencies.anchor-lang-current]
version = "1.0"
optional = true
package = "anchor-lang"
```

So `features = ["anchor"]` now pulls **anchor-lang ^1.0**, while `bolt-lang` itself pulls
**anchor-lang 0.32.1**. Cargo will happily link both (they are semver-incompatible, so they coexist),
but the types do not unify: `bolt_lang`'s `Signer<'info>` / `AccountInfo<'info>` are anchor-0.32.1
types being handed to `DelegateAccounts`, which is now built from anchor-1.x types. Guaranteed
type-mismatch compile error.

I verified exactly where the break landed by diffing the feature table across published SDK versions:

| ER SDK | `anchor` feature maps to | anchor-lang constraint | Compatible with BOLT? |
| --- | --- | --- | --- |
| 0.10.1 | `["anchor-lang"]` | `>=0.28.0` | yes |
| 0.11.0 | `["anchor-lang"]` | `>=0.28.0` | yes |
| 0.12.0 | `["anchor-lang"]` | `>=0.28.0` | yes |
| **0.13.0** | `["anchor-lang"]` | `>=0.28.0` | **yes — last good version** |
| 0.14.3 | `["anchor-modern"]` | `1.0` | **no** |
| 0.17.0 | `["anchor-modern"]` | `1.0` | **no** |

**Fix if we proceed with BOLT anyway** — pin the SDK in our workspace `Cargo.toml`:

```toml
[workspace.dependencies]
ephemeral-rollups-sdk = "=0.13.0"
anchor-lang           = { version = "=0.32.1", features = ["init-if-needed"] }
```

That pins us to a June-2026-era SDK and forfeits every ER feature added in 0.14–0.17
(`MagicIntentBundleBuilder`, `delegate_account_with_actions`, the modern Magic Actions builders,
the fee-vault commit-sponsorship path). Note this directly undercuts the spec's
"Settlement: a Magic Action chains the base-layer commit + leaderboard write" — see §7.3.

> Confidence: **high** but *derived from manifests, not from an observed build*. This is
> mechanically checkable in about two minutes: `cargo add ephemeral-rollups-sdk && cargo build`
> in a `bolt init` project. Do that before acting on it.

### 0.3 A native Pinocchio program **cannot** CPI into the BOLT World program.

This is the answer to the new open question, and it comes straight from MagicBlock's own maintainers.
PR **#196** ("CPI Authentication using a World PDA", merged 2025-08-01) opens with, verbatim:

> ## Problem
>
> We needed to improve the CPI authentication mechanism to guarantee that the instruction is being
> called from the World program. **We couldn't rely on getting the relative instructions from sysvar
> because we could only test against the topmost instruction, making it impossible to CPI the World
> program.**

They fixed it by swapping the sysvar check for a hardcoded World PDA
(`B2f2y3QTBv346wE6nWKor72AUhUvFF6mPk7TWCF2QVhi`). Then PR **#213** (merged **2025-10-17**) reverted
the whole thing — "Replaced `CpiAuth` with `InstructionSysvarAccount` across SDKs (C#, TypeScript,
Rust)". So `main` is back on the sysvar mechanism, which they explicitly documented as
*making CPI into World impossible*.

Worse for us: the World-PDA CPI auth only ever shipped in **0.2.5 and 0.2.6**, and both are
**yanked**. There is therefore **no usable BOLT release that supports CPI into the World program**.
Full detail and the mechanism in §6.

---

## 1. What BOLT actually is, and what is actually delegated

### 1.1 The three-program structure

BOLT is an ECS layer on top of Anchor. Three on-chain pieces matter for delegation:

| Piece | Program ID | Role |
| --- | --- | --- |
| **World** | `WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n` | Registry, entity creation, and the `apply` entrypoint that runs systems |
| **Component program** | one per component type (yours) | Owns the component PDA; exposes `initialize` / `update` / `update_with_session` / `delegate` / `undelegate` |
| **`bolt-component` reference** | `CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua` | The canonical component-program shape |

Systems are separate programs invoked by World via CPI; they are pure — they receive component data
and return new bytes, and World writes those bytes back.

### 1.2 The delegated account is the **component PDA** — not the entity, not the world

This is the central question of the topic, and the answer is unambiguous. From
`crates/bolt-lang/attribute/delegate/src/lib.rs`, the `#[component(delegate)]` macro injects this
`delegate` instruction verbatim:

```rust
#[automatically_derived]
pub fn delegate(ctx: Context<DelegateInput>, commit_frequency_ms: u32, validator: Option<Pubkey>) -> Result<()> {
    let pda_seeds: &[&[u8]] = &[<#component_type>::seed(), &ctx.accounts.entity.key().to_bytes()];

    let del_accounts = ::bolt_lang::DelegateAccounts {
        payer: &ctx.accounts.payer,
        pda: &ctx.accounts.account,
        owner_program: &ctx.accounts.owner_program,
        buffer: &ctx.accounts.buffer,
        delegation_record: &ctx.accounts.delegation_record,
        delegation_metadata: &ctx.accounts.delegation_metadata,
        delegation_program: &ctx.accounts.delegation_program,
        system_program: &ctx.accounts.system_program,
    };

    let config = ::bolt_lang::DelegateConfig {
        commit_frequency_ms,
        validator,
    };

    ::bolt_lang::delegate_account(
        del_accounts,
        pda_seeds,
        config,
    )?;

    Ok(())
}
```

The delegated PDA is `[Component::seed(), entity_pubkey]`, owned by the **component program**
(`owner_program`), not by World. Consequences:

- **The entity account is never delegated.** It is passed in read-only, purely to derive the seed.
  It stays owned by World on the base layer for the whole match.
- **The world account is never delegated.** `World::apply` reads `Account<'info, World>`
  non-mutably; if the world PDA were delegated, `apply` could not be executed on the base layer at all.
- **Delegation granularity is one account per (component type × entity).** There is no
  "delegate this entity" or "delegate this world" operation anywhere in the framework.

Supporting seed derivations, from `crates/programs/world/src/lib.rs`:

```rust
// Entity PDA
seeds = [Entity::seed(), &world.id.to_be_bytes(),
    &match extra_seed {
        Some(ref _seed) => [0; 8],
        None => world.entities.to_be_bytes()
    },
    match extra_seed {
        Some(ref seed) => seed,
        None => &[],
    }]
```

```rust
// Component PDA, from the #[bolt_program] macro's generated Initialize
#[account(init_if_needed, payer = payer, space = <#component_type>::size(), seeds = [<#component_type>::seed(), entity.key().as_ref()], bump)]
pub data: Account<'info, #component_type>,
```

where `Component::seed()` is the component program's own ID as a byte string:

```rust
fn seed() -> &'static [u8] {
    #component_id_value.as_bytes()
}
```

### 1.3 There is no auto-delegation

I searched the full repo tree (264 blobs) for any auto-delegation path: nothing. Every component is
delegated by an explicit `delegate` instruction, one instruction per component account. There is no
"delegate on first write", no lazy delegation, no batch-delegate helper. `DelegateComponent()` in the
TS SDK builds exactly one instruction for exactly one component.

This matters enormously for HEARTROT's account count — see §7.1.

### 1.4 The programs are still deployed on devnet

Verified live against `api.devnet.solana.com` on 2026-08-31:

| Program | Owner | Executable |
| --- | --- | --- |
| `WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n` | `BPFLoaderUpgradeab1e11111111111111111111111` | `true` |
| `CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua` | `BPFLoaderUpgradeab1e11111111111111111111111` | `true` |
| `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | `BPFLoaderUpgradeab1e11111111111111111111111` | `true` |

So the deprecation is a maintenance decision, not a shutdown. A BOLT game deployed on devnet today
will run. It just will not get fixes, and its build is already broken against current dependencies (§0.2).

---

## 2. Exact pinned versions

Everything below was read off crates.io / npmjs.com / the live repo on **2026-08-31**.

### BOLT (deprecated)

| Package | Latest usable | Notes |
| --- | --- | --- |
| `bolt-lang` (crates.io) | **0.2.4** (2025-07-23) | 0.2.5, 0.2.6 yanked 2025-10-17 |
| `bolt-cli` (crates.io) | **0.2.4** | |
| `@magicblock-labs/bolt-sdk` (npm) | **0.2.4** | `latest` dist-tag; 0.2.5/0.2.6 exist but untagged |
| `world` program | `WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n` | live on devnet |
| `bolt-component` program | `CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua` | live on devnet |

### The live MagicBlock stack (actively maintained)

| Package | Version | Date |
| --- | --- | --- |
| `ephemeral-rollups-sdk` (crates.io) | **0.17.0** | 2026-08-26 |
| `@magicblock-labs/ephemeral-rollups-sdk` (npm) | **0.17.0** | 2026-08-26 |
| `@magicblock-labs/ephemeral-validator` (npm) | **0.14.10** | 2026-08-16 |
| `anchor-lang` (crates.io) | **1.1.2** stable; `2.0.0-rc.1` exists | 2026-06-26 / 2026-08-12 |
| `anchor-lang` last 0.x | **0.32.1** | 2025-10-10 |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | live |
| Magic Program | `Magic11111111111111111111111111111111111111` | |
| Magic Context | `MagicContext1111111111111111111111111111111` | |

> The local `magicblock` skill states ER SDK **0.14.3** and Anchor **1.0.2**. Both are stale as of
> today — the SDK is on 0.17.0 and Anchor stable is 1.1.2. The skill's *patterns* still hold
> (`MagicIntentBundleBuilder` is present and current in 0.17.0); only its version table drifted.

### Endpoints (devnet)

```bash
SOLANA_RPC_ENDPOINT=https://rpc.magicblock.app/devnet
ROUTER_ENDPOINT=https://devnet-router.magicblock.app/
# ER endpoint: use the `fqdn` returned by router getDelegationStatus, e.g.
EPHEMERAL_PROVIDER_ENDPOINT=https://devnet-as.magicblock.app/
```

---

## 3. The delegation lifecycle in BOLT, end to end

### 3.1 The canonical working example

`clients/typescript/test/intermediate-level/acceleration.ts` is the only end-to-end delegation test in
the repo, and it is the authoritative reference. Verbatim, in order:

```ts
it("Create accelerated entity", async () => {
  const createAcceleratedEntity = await AddEntity({
    payer: framework.provider.wallet.publicKey,
    world: framework.worldPda,
    connection: framework.provider.connection,
  });

  framework.acceleratedEntityPda = createAcceleratedEntity.entityPda;

  await framework.provider.sendAndConfirm(
    createAcceleratedEntity.transaction,
  );
});

it("Create accelerated component position", async () => {
  const createAcceleratedComponentPosition = await InitializeComponent({
    payer: framework.provider.wallet.publicKey,
    entity: framework.acceleratedEntityPda,
    componentId: framework.exampleComponentPosition.programId,
  });

  framework.acceleratedComponentPositionPda =
    createAcceleratedComponentPosition.componentPda;

  await framework.provider.sendAndConfirm(
    createAcceleratedComponentPosition.transaction,
  );
});

it("Check component delegation to accelerator", async () => {
  const delegateComponent = await DelegateComponent({
    payer: framework.provider.wallet.publicKey,
    entity: framework.acceleratedEntityPda,
    componentId: framework.exampleComponentPosition.programId,
  });

  await framework.provider.sendAndConfirm(
    delegateComponent.transaction,
    [],
    {
      skipPreflight: true,
      commitment: "confirmed",
    },
  );
  const acc = await framework.provider.connection.getAccountInfo(
    delegateComponent.componentPda,
  );
  expect(acc?.owner.toBase58()).to.equal(DELEGATION_PROGRAM_ID.toBase58());
});

it("Apply Simple Movement System (Up) on Entity 1 on Accelerator 10 times", async () => {
  for (let i = 0; i < 10; i++) {
    let applySystem = await ApplySystem({
      authority: framework.provider.wallet.publicKey,
      systemId: framework.systemSimpleMovement.programId,
      world: framework.worldPda,
      entities: [
        {
          entity: framework.acceleratedEntityPda,
          components: [
            { componentId: framework.exampleComponentPosition.programId },
          ],
        },
      ],
      args: {
        direction: Direction.Up,
      },
    });

    await framework.acceleratorProvider.sendAndConfirm(
      applySystem.transaction,
      [],
      {
        skipPreflight: true,
        commitment: "processed",
      },
    );
    // Wait for 50ms
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});
```

Read the routing carefully — it is the part people get wrong:

| Step | Connection |
| --- | --- |
| `AddEntity` | base layer (`framework.provider`) |
| `InitializeComponent` | base layer |
| `DelegateComponent` | **base layer**, `skipPreflight: true` |
| `ApplySystem` | **ER** (`framework.acceleratorProvider`), `skipPreflight: true` |

The post-delegation assertion is the invariant to test against:
`componentPda.owner == DELEGATION_PROGRAM_ID` on the base layer.

**Note what is missing: there is no undelegate test anywhere in the BOLT repo.** The undelegate path
is shipped but untested by its authors. Treat §3.4 as unvalidated.

### 3.2 Declaring a component as delegatable

One attribute. From `examples/component-position/src/lib.rs`, complete file:

```rust
use bolt_lang::*;

declare_id!("Fn1JzzEdyb55fsyduWS94mYHizGhJZuhvjX6DVvrmGbQ");

#[component(delegate)]
#[derive(Copy, Default)]
pub struct Position {
    pub x: i64,
    pub y: i64,
    pub z: i64,
}
```

`#[component(delegate)]` injects six items into the module: `delegate` + `DelegateInput`,
`process_undelegation` + `InitializeAfterUndelegation`, and `undelegate` + `Undelegate`.

### 3.3 The generated `DelegateInput` accounts

```rust
#[automatically_derived]
#[derive(Accounts)]
pub struct DelegateInput<'info> {
    pub payer: Signer<'info>,
    #[account()]
    pub entity: Account<'info, Entity>,
    /// CHECK:
    #[account(mut)]
    pub account: AccountInfo<'info>,
    /// CHECK:`
    pub owner_program: AccountInfo<'info>,
    /// CHECK:
    #[account(mut)]
    pub buffer: AccountInfo<'info>,
    /// CHECK:`
    #[account(mut)]
    pub delegation_record: AccountInfo<'info>,
    /// CHECK:`
    #[account(mut)]
    pub delegation_metadata: AccountInfo<'info>,
    /// CHECK:`
    pub delegation_program: AccountInfo<'info>,
    /// CHECK:`
    pub system_program: AccountInfo<'info>,
}
```

Nine accounts per delegate instruction. Three of them (`buffer`, `delegation_record`,
`delegation_metadata`) are PDAs **created and rent-funded during delegation**, so every delegated
component costs four base-layer accounts, not one.

### 3.4 Undelegation — two instructions, and they run on different layers

`undelegate` is the ER-side trigger:

```rust
#[automatically_derived]
pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
    ::bolt_lang::commit_and_undelegate_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.delegated_account.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;
    Ok(())
}

#[automatically_derived]
#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    /// CHECK: The delegated component
    pub delegated_account: AccountInfo<'info>,
    #[account(mut, address = ::bolt_lang::MAGIC_CONTEXT_ID)]
    /// CHECK:`
    pub magic_context: AccountInfo<'info>,
    #[account()]
    /// CHECK:`
    pub magic_program: Program<'info, MagicProgram>
}
```

`process_undelegation` is the base-layer callback the delegation program invokes to restore ownership:

```rust
#[automatically_derived]
pub fn process_undelegation(ctx: Context<InitializeAfterUndelegation>, account_seeds: Vec<Vec<u8>>) -> Result<()> {
    let [delegated_account, buffer, payer, system_program] = [
        &ctx.accounts.delegated_account,
        &ctx.accounts.buffer,
        &ctx.accounts.payer,
        &ctx.accounts.system_program,
    ];
    ::bolt_lang::undelegate_account(
        delegated_account,
        &id(),
        buffer,
        payer,
        system_program,
        account_seeds,
    )?;
    Ok(())
}
```

**BOLT uses the deprecated free function.** `commit_and_undelegate_accounts` carries
`#[deprecated(since = "0.7.0", note = "Use MagicIntentBundleBuilder instead")]` in the current SDK. It
still exists in 0.17.0 (re-exported from `src/ephem/mod.rs`, defined in `src/ephem/deprecated/v0.rs`),
so this is a warning rather than a break — but it means BOLT never gained access to the modern
intent-bundle API, and therefore never gained **Magic Actions**. See §7.3.

### 3.5 The TS client, and a naming trap in it

`DelegateComponent` (from `clients/typescript/src/delegation/delegate.ts`) derives all three
delegation PDAs for you:

```ts
const delegationRecord = delegationRecordPdaFromDelegatedAccount(
  accounts.account,
);

const delegationMetadata = delegationMetadataPdaFromDelegatedAccount(
  accounts.account,
);

const bufferPda = delegateBufferPdaFromDelegatedAccountAndOwnerProgram(
  accounts.account,
  accounts.ownerProgram,
);
```

The undelegate builder has a **misleading field name** worth flagging before someone loses an hour to it:

```ts
export interface UndelegateInstructionAccounts {
  payer: web3.PublicKey;
  delegatedAccount: web3.PublicKey;
  componentPda: web3.PublicKey;
}

// ...
  return new web3.TransactionInstruction({
    programId: accounts.componentPda,
    keys,
    data,
  });
```

The field called `componentPda` is used as the **`programId`**. You must pass the component
*program ID*, not the component PDA, or the instruction routes to a non-executable account. Nothing in
the repo calls this function, so the naming was never exercised.

---

## 4. Who signs and who pays

### Delegation (base layer)

- **Signer:** `payer` in `DelegateInput`. That is the only signer.
- **Payer:** the same `payer` funds rent for `buffer`, `delegation_record`, and `delegation_metadata`.
- **No authority check.** `DelegateInput` has no constraint tying `payer` to the component's
  `bolt_metadata.authority`, and no constraint on `validator`. See §5.3 — this is a real hole.

**Trap:** the TS client marks payer as **not writable** at the instruction level:

```ts
{
  pubkey: accounts.payer,
  isWritable: false,
  isSigner: true,
},
```

and the Rust `DelegateInput` declares `pub payer: Signer<'info>` with **no `mut`**. Delegation
nonetheless needs to debit the payer for rent. This works only because Solana's transaction fee payer
is always writable at the message level regardless of per-instruction metas. **So the delegate payer
must be the transaction fee payer.** If you build a transaction where a treasury key pays the fee but a
*different* key is passed as `payer` to `DelegateComponent`, delegation fails. Directly relevant to
our treasury-funds-the-session-wallet model.

### Writes on the ER

- **Signer:** the `authority` on `World::apply` (or `apply_with_session`).
- **Payer:** whoever pays the ER transaction fee. ER fees are negligible; this is the session keypair.

### Commits and undelegation — the hard numbers

From the MagicBlock fees documentation (current, non-BOLT):

| Situation | Cost |
| --- | --- |
| Commit 1, no delegated fee payer | free |
| Commits 2–10, no fee payer | **100,000 lamports (0.0001 SOL)** each, deducted from the deposit at undelegation |
| Commit 11, no fee payer | **fails with error `0xA0000000`** |
| Commits 1–25, with a delegated fee payer | free |
| Commit 26+, with a fee payer | 100,000 lamports per account, charged live |
| Undelegation session charge | **300,000 lamports** |

The delegation deposit is the two rent-exempt accounts (record + metadata); it is refundable, and at
undelegation the protocol "takes no more than the amount held in the two deposit accounts", returning
the remainder to the original rent payer.

**The 11-commit cliff is the single most dangerous number for HEARTROT.** See §7.2.

---

## 5. Authority: how a delegated component write is actually checked

This is the section that decides whether our plan works. The short version: **BOLT's default authority
model is fully permissionless, and it does not do what the spec assumes.**

### 5.1 `World::apply` does not check per-component authority at all

From `crates/programs/world/src/lib.rs`, `apply_impl` — the entire check, verbatim:

```rust
fn apply_impl<'info>(
    authority: &Signer<'info>,
    world: &Account<'info, World>,
    bolt_system: &UncheckedAccount<'info>,
    cpi_context: CpiContext<'_, '_, '_, 'info, bolt_system::cpi::accounts::BoltExecute<'info>>,
    args: Vec<u8>,
    mut remaining_accounts: Vec<AccountInfo<'info>>,
) -> Result<(Vec<(AccountInfo<'info>, AccountInfo<'info>)>, Vec<Vec<u8>>)> {
    if !authority.is_signer && authority.key != &ID {
        return Err(WorldError::InvalidAuthority.into());
    }
    if !world.permissionless
        && !world
            .systems()
            .approved_systems
            .contains(&bolt_system.key())
    {
        return Err(WorldError::SystemNotApproved.into());
    }
    // ... no further authority logic
```

Two checks only:
1. `authority` is *a* signer (any signer at all — its key is never compared to anything).
2. If the world is not permissionless, the system program must be in `approved_systems`.

There is **no comparison of `authority` against any component's stored authority** anywhere in the
World program. Whitelisting is per-*system*, never per-*player*.

Also note `World::default()` sets `permissionless: true`, so even the system whitelist is off unless
you explicitly call `approve_system` (which flips `permissionless` to `false` on first use).

### 5.2 The component's own check, and why it is a no-op in practice

Each component program's generated `update` carries the only per-component authority logic in the
framework. From `crates/bolt-lang/attribute/bolt-program/src/lib.rs`, verbatim:

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

The `require!` passes if **either**:

- **(a)** `bolt_metadata.authority == World::id()` — the short-circuit. Nothing about the caller is
  checked. **Any signer can write.**
- **(b)** `bolt_metadata.authority == authority.key && authority.is_signer` — a real check, but only
  reachable when the component was initialized with a specific authority.

And the default is (a). The TS SDK's `InitializeComponent`:

```ts
authority: authority ?? PROGRAM_ID,
```

where `PROGRAM_ID` is the **World program ID**. So out of the box every component takes branch (a) and
is writable by any signer who can construct an `apply`. The authority stored at init is:

```rust
ctx.accounts.data.bolt_metadata.authority = *ctx.accounts.authority.key;
```

and `BoltMetadata` is exactly one field:

```rust
#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Default, Copy, Clone)]
pub struct BoltMetadata {
    pub authority: Pubkey,
}
```

**One `Pubkey`. Not a list, not a role, not a session-key slot.**

### 5.3 `delegate` and `undelegate` are entirely unauthenticated

Neither generated instruction checks `bolt_metadata.authority`:

- `DelegateInput` — `payer: Signer`, no authority constraint. Anyone can delegate any initialized
  component, **and choose the `validator` pubkey it is delegated to**.
- `Undelegate` — `payer: Signer`, no authority constraint. Anyone can undelegate any delegated
  component mid-match.

Griefing consequences for a public raid arena:

- An attacker delegates our components to a validator **they** control before we do, and our
  `DelegateComponent` then fails because the account is already owned by the delegation program.
- An attacker calls `undelegate` on `ArenaState` or `Bullets` mid-fight. Those accounts return to the
  base layer, the ER can no longer write them, and the raid stalls for every player at once.

Neither is exotic — both are single instructions against public program IDs with derivable PDAs.

### 5.4 Verdict on our stated plan

> *Our plan: platform holds delegation authority, session pubkey stored on PlayerMeta and checked by
> each system. Validate that.*

Splitting it in three:

**"Platform holds delegation authority" — does not exist in BOLT.** There is no delegation authority
concept. `delegate` takes any signer (§5.3). We can *convention* our way to the platform always being
the one to call delegate, but nothing enforces it and an attacker can front-run it.

**"Session pubkey stored on PlayerMeta" — fine, but it is inert data.** A `Pubkey` field on a
component is just bytes. Nothing in World or the component program reads it.

**"...and checked by each system" — this is the part that does not work.** BOLT systems are **pure
functions**. From the World `apply` CPI, a system receives component data and returns new bytes:

```rust
let results = bolt_system::cpi::bolt_execute(
    cpi_context.with_remaining_accounts(remaining_accounts),
    args,
)?
.get();
```

The system's only account is `BoltExecute { authority }`:

```rust
let cpi_accounts = bolt_system::cpi::accounts::BoltExecute {
    authority: self.authority.to_account_info(),
};
```

So a system *can* see `authority` and *can* compare it to a `session_pubkey` field it deserialized out
of `PlayerMeta`, and return an error on mismatch. **That much works.** But understand what it buys:

- It is an *application-level* check inside a system, not an account-model check. It protects only the
  components that system writes, only when routed through that system.
- It does **not** protect against a different, unapproved system writing the same component — unless
  we call `approve_system` to flip the world out of permissionless mode and whitelist every system.
  That is a mandatory hardening step our spec does not currently mention.
- It does **not** protect `delegate` / `undelegate` at all (§5.3). Those bypass systems entirely.
- Anti-cheat scope: a player who signs with their own session key can still ask a system to write
  *another player's* `Position` or `Health`, unless every single system independently re-derives which
  `PlayerMeta` corresponds to the signing authority and rejects mismatches. That check must be written
  by us, correctly, in every system, with no framework support and no default-deny.

**Conclusion: the plan is implementable but the framework contributes nothing to it.** Every guarantee
is ours to write and ours to get right, and two of the three attack surfaces (`delegate`,
`undelegate`) are not reachable from systems at all, so they cannot be defended this way.

### 5.5 The session-keys alternative, and its limitation

BOLT does support MagicBlock session keys via `apply_with_session` → `update_with_session`:

```rust
#[automatically_derived]
pub fn update_with_session(ctx: Context<UpdateWithSession>, data: Vec<u8>) -> Result<()> {
    if ctx.accounts.bolt_component.bolt_metadata.authority == World::id() {
        require!(Clock::get()?.unix_timestamp < ctx.accounts.session_token.valid_until, bolt_lang::session_keys::SessionError::InvalidToken);
    } else {
        let validity_ctx = bolt_lang::session_keys::ValidityChecker {
            session_token: ctx.accounts.session_token.clone(),
            session_signer: ctx.accounts.authority.clone(),
            authority: ctx.accounts.bolt_component.bolt_metadata.authority.clone(),
            target_program: World::id(),
        };
        require!(ctx.accounts.session_token.validate(validity_ctx)?, bolt_lang::session_keys::SessionError::InvalidToken);
        require_eq!(ctx.accounts.bolt_component.bolt_metadata.authority, ctx.accounts.session_token.authority, bolt_lang::session_keys::SessionError::InvalidToken);
    }
    // ... same instruction-sysvar caller check
}
```

Note the same short-circuit: when `authority == World::id()` (the default), the *only* check is that
the session token has not expired — **the token's owner is never compared to anything**. Any valid,
unexpired session token from any user passes.

To get a real session-key binding you must initialize each player's components with
`authority = <player's main wallet>`, taking branch (b). That is a genuine, framework-enforced
per-player check and it is closer to what the spec wants than the `PlayerMeta` approach. Its cost:
`bolt_metadata.authority` is one pubkey, so a component is bound to exactly one wallet. `ArenaState`,
`Bullets`, `Parts`, and `Core` are shared and must stay `World::id()`-authored, i.e. permissionless —
which is precisely where the crank writes and where griefing hurts most.

---

## 6. The Pinocchio question: can a non-BOLT program touch BOLT component accounts?

### 6.1 Writing through World via CPI: **no**

Both `update` and `update_with_session` end with:

```rust
// Check if the instruction is called from the world program
let instruction = anchor_lang::solana_program::sysvar::instructions::get_instruction_relative(
    0, &ctx.accounts.instruction_sysvar_account.to_account_info()
).map_err(|_| BoltError::InvalidCaller)?;
require_eq!(instruction.program_id, World::id(), BoltError::InvalidCaller);
```

The instructions sysvar records **top-level instructions only**; `get_instruction_relative(0, ...)`
returns the currently-executing *top-level* instruction, not the immediate CPI caller. So:

| Call shape | `get_instruction_relative(0).program_id` | Result |
| --- | --- | --- |
| top-level `World::apply` → CPI → `component::update` | `World::id()` | ✅ passes |
| top-level `Pinocchio::foo` → CPI → `World::apply` → CPI → `component::update` | `Pinocchio program id` | ❌ `InvalidCaller` |

This is not my inference — it is MagicBlock's own stated reason for attempting PR #196, quoted in §0.3:
*"we could only test against the topmost instruction, making it impossible to CPI the World program."*
They built the fix, shipped it in 0.2.5/0.2.6, then reverted it in #213 and yanked both releases.

**There is no released, non-yanked BOLT version in which a Pinocchio program can CPI into World.**

### 6.2 Writing component accounts directly: **no**

Once delegated, the component PDA is owned by `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` on the
base layer and by the component program inside the ER. Solana's account model permits mutation only by
the owning program. A Pinocchio program can never be that owner for a BOLT component. Undelegated, the
owner is the component program — still not ours.

### 6.3 What a Pinocchio program *can* soundly own

Reading is always fine — any program can deserialize any account it is passed. And a Pinocchio program
can own its own accounts freely and delegate them to the same ER using `ephemeral-rollups-sdk`
directly, since delegation is a property of an account, not of a framework. Two BOLT-independent
programs can have their accounts delegated to the same validator and be written in the same ER
transaction.

**The clean split, if we keep both:**

| Owns | Program | Rationale |
| --- | --- | --- |
| Entities, components, all gameplay state | BOLT World + component programs | it is the only thing allowed to write them |
| Leaderboard, treasury, match receipts, settlement records | native Pinocchio | no BOLT dependency, cheap, we control the account layout |

The two communicate by **account reads and separate top-level instructions in the same transaction**,
never by CPI into World. That is architecturally sound and sidesteps every problem above.

**What will not work:** a Pinocchio "orchestrator" instruction that internally applies a BOLT system,
or that writes a component. Both are blocked by §6.1 / §6.2.

> Given §0.1, the more honest framing: if we drop BOLT, the Pinocchio program stops being a
> *sidecar* and becomes the natural home for all of it. See §8.

---

## 7. How this lands on the HEARTROT architecture

### 7.1 Account count and delegation cost at match start

The spec's entity/component set, expanded to actual PDAs:

| Component | Entities carrying it | PDAs |
| --- | --- | --- |
| `Position` | 20 players + boss | 21 |
| `Health` | 20 players + boss | 21 |
| `PlayerMeta` | 20 players | 20 |
| `Combat` | 20 players | 20 |
| `Parts` | boss | 1 |
| `Core` | boss | 1 |
| `ArenaState` | arena | 1 |
| `Bullets[128]` | arena | 1 |
| **Total** | | **86 component PDAs** |

Because delegation is one account at a time (§1.3) and each costs four base-layer accounts:

- **86 `delegate` instructions** at 9 accounts each. Solana's 1,232-byte transaction limit allows
  roughly 4–5 of these per transaction, so **~18–22 base-layer transactions** just to start a match,
  each ~400ms and each needing to land.
- **344 base-layer accounts** (86 components + 86 records + 86 metadata + 86 buffers).
- At undelegation: **86 × 300,000 lamports ≈ 0.0258 SOL** in session charges alone, before commit
  charges, per match. Treasury-funded, per the spec. Devnet SOL is free but rate-limited; this is a
  real number for the faucet strategy and a serious one if this ever moves to mainnet.

The spec's decision to make `Bullets[128]` a single pooled component instead of per-bullet entities is
**strongly validated** by this — an entity per bullet would mean a delegate transaction per bullet.
The same reasoning, applied consistently, argues for collapsing `Position`/`Health`/`Combat` into one
component per player (20 PDAs instead of 61) and folding boss state into fewer accounts. That is the
single highest-leverage change available if we stay on BOLT.

### 7.2 The crank vs. the 11-commit cliff

The spec's crank ticks the boss at **~400ms**. Ticks are ER transactions and are cheap — that part is
fine. The danger is `commit_frequency_ms`, and there is a live inconsistency here:

- Rust SDK: `DelegateAccountArgs::default()` sets `commit_frequency_ms: u32::MAX` — effectively
  "never auto-commit, the program will trigger commits".
- **BOLT TS client:** `createDelegateInstruction(accounts, commitFrequencyMs: number = 0, ...)` — and
  `DelegateComponent()` never passes a value, so it serializes **`0`**.

The delegation program stores whatever it is given, documented as:

```rust
/// The frequency at which the validator should commit the account data
/// if no commit is triggered by the owning program
pub commit_frequency_ms: u32,
```

If `0` is interpreted literally as "commit as often as possible", then with a 10-commit free
allowance every delegated component hits **`0xA0000000`** within seconds of match start, across all 86
accounts. If `0` is special-cased to mean "never", it is harmless. **I could not resolve which, from
the delegation-program or validator source, in the time available.** This is the highest-value
unknown in this document and it is cheap to settle — see §9.

Regardless of the answer: **pass `commit_frequency_ms` explicitly** (`u32::MAX` for
crank-driven-commits-only) rather than relying on the BOLT TS default. Note `DelegateComponent()` does
not expose the parameter, so we would call `createDelegateInstruction` directly.

### 7.3 Magic Actions are not reachable from BOLT

The spec says: *"Settlement: a Magic Action chains the base-layer commit + leaderboard write."*

Magic Actions are built with `MagicIntentBundleBuilder` / `add_post_commit_actions(...)` in
`ephemeral-rollups-sdk` ≥ 0.11. BOLT's generated `undelegate` calls the deprecated
`commit_and_undelegate_accounts` free function (§3.4), and BOLT can only build against SDK ≤ 0.13
(§0.2). The generated `Undelegate` context exposes only `payer`, `delegated_account`, `magic_context`,
`magic_program` — there is no hook to attach post-commit actions.

**So the Magic Action settlement path does not exist through BOLT's generated instructions.** Options:
(a) write our own non-BOLT undelegate instruction in a separate program that owns nothing BOLT-related
and drives the intent bundle itself, or (b) do the leaderboard write as an ordinary base-layer
transaction after commit, losing atomicity. Neither is what the spec assumes.

### 7.4 What is unaffected

The rest of the spec is orthogonal to delegation and stands:

- Hitscan player shots and the pooled bullet component — sound, and validated by §7.1.
- No server game loop; crank-driven ticks — fine.
- Browser → ER directly, never through the Worker — correct, and the acceleration test confirms the
  dual-connection shape (`framework.acceleratorProvider` with `skipPreflight: true`).
- SVG sprite rig, `px2svg.py`, the 4 cold-path routes, Privy onboarding — untouched by any of this.
- Zero wallet popups during gameplay — achievable, but note §5.5: BOLT's session-key path is
  weakly checked by default, so the popup-free property will come from our session keypair signing ER
  transactions, not from BOLT's session tokens.

---

## 8. Recommendation

Stated plainly, because the spec is frozen and this is the kind of finding that should unfreeze it.

**Do not build HEARTROT on BOLT.** The framework is deprecated by its authors, its last release is
13 months old, its build is broken against current dependencies, its docs have been deleted, its
undelegate path is untested, its authority model is permissionless by default, and the CPI story the
new Pinocchio question depends on was explicitly attempted and reverted.

**The lazy path that keeps almost all of the design:** drop the ECS layer, keep everything else.

- Write **one Anchor or Pinocchio program** that owns a small number of accounts — `Arena`
  (phase/tick/incarnation/alive_count/enrage_at + the 128-bullet pool), `Boss` (parts + core), and one
  `Player` account per participant. That is **~22 accounts instead of 86**, so ~22 delegations instead
  of 86, and roughly a quarter of the rent and session charges.
- Delegate those directly with `ephemeral-rollups-sdk` **0.17.0** using the patterns in the local
  `magicblock` skill (`#[ephemeral]`, `#[delegate]`, `#[commit]`, `MagicIntentBundleBuilder`), which
  are current and maintained.
- Authority becomes a normal Anchor/Pinocchio constraint — store `session_pubkey` on the player
  account and enforce `has_one` / an explicit signer check. This is the check the spec wanted, and
  outside BOLT it is one line per instruction and actually enforced.
- Magic Actions work, so the spec's settlement design (`commit + leaderboard write`, atomic) becomes
  achievable rather than blocked (§7.3).
- The Pinocchio question dissolves: with no World program in the way, there is no CPI barrier, and we
  choose Pinocchio vs Anchor per program on CU-cost grounds alone.

The ECS decomposition in the spec (`Position`, `Health`, `PlayerMeta`, `Combat`, `Parts`, `Core`,
`ArenaState`, `Bullets`) survives as **struct fields** rather than as separate accounts. Nothing about
the game design, the destructible-parts boss, the hitscan/bullet-pool asymmetry, or the rendering
approach has to change.

**If BOLT is kept anyway** (e.g. the grant explicitly names it), the mandatory hardening list:

1. Pin `ephemeral-rollups-sdk = "=0.13.0"` and `anchor-lang = "=0.32.1"` (§0.2).
2. Call `approve_system` for every system, taking the world out of `permissionless` mode (§5.1).
3. Initialize per-player components with `authority = player wallet`, not the World default, so
   branch (b) of the authority check is live (§5.2, §5.5).
4. Pass `commit_frequency_ms` explicitly via `createDelegateInstruction`; never use
   `DelegateComponent()`'s default (§7.2).
5. Accept that `delegate` / `undelegate` griefing is unfixable without forking BOLT (§5.3).
6. Delegate defensively at match start, immediately after `InitializeComponent`, in the same
   transaction where possible, to shrink the front-running window.
7. Ensure the delegate `payer` is always the transaction fee payer (§4).
8. Give up on Magic Action settlement or build it outside BOLT (§7.3).

---

## 9. Open questions worth resolving before committing

1. **What does `commit_frequency_ms = 0` mean to the validator?** Highest-value unknown (§7.2).
   Cheap test: delegate one account with `0`, delegate another with `u32::MAX`, idle for 60s, and
   count base-layer commits via `getSignaturesForAddress` on each delegation record. If the `0`
   account accumulates commits, BOLT's TS default is a live footgun and every project using
   `DelegateComponent()` hits the `0xA0000000` cliff.
2. **Does a `bolt init` project actually fail to build today?** §0.2 is derived from manifests, not an
   observed build. `cargo install bolt-cli && bolt init x && cd x && bolt build` settles it in minutes
   and either confirms the pin requirement or removes a blocker.
3. **Is the 300,000-lamport session charge per delegated account or per delegation session?** The docs
   phrase it per-undelegation, which reads as per-account. At 86 accounts the difference is
   0.0258 SOL vs 0.0003 SOL per match — a 86× swing in the treasury model.
4. **Is `bolt_metadata.authority` writable after init?** I found no instruction that updates it.
   If it is genuinely immutable, per-player component authority must be set at
   `InitializeComponent` time, which forces us to know the player's wallet before their first
   component exists — awkward for the "never used a wallet" onboarding flow.
5. **Did MagicBlock publish a stated successor to BOLT?** The docs simply deleted the section rather
   than pointing anywhere. Worth asking in Discord before assuming raw `ephemeral-rollups-sdk` is the
   intended migration target (it is the obvious one, but confirmation is free).

---

## Sources

Every URL below was actually fetched and read for this document.

**BOLT repository (primary source — read directly)**
- https://github.com/magicblock-labs/bolt
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/README.md
- https://api.github.com/repos/magicblock-labs/bolt
- https://api.github.com/repos/magicblock-labs/bolt/commits?per_page=15
- https://api.github.com/repos/magicblock-labs/bolt/commits/main
- https://api.github.com/repos/magicblock-labs/bolt/releases?per_page=8
- https://api.github.com/repos/magicblock-labs/bolt/git/trees/main?recursive=1
- https://api.github.com/repos/magicblock-labs/bolt/pulls/196
- https://api.github.com/repos/magicblock-labs/bolt/pulls/213
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/crates/bolt-lang/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/crates/bolt-lang/attribute/delegate/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/crates/bolt-lang/attribute/component/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/crates/bolt-lang/attribute/bolt-program/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/crates/programs/world/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/crates/programs/bolt-component/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/examples/component-position/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/clients/typescript/src/delegation/delegate.ts
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/clients/typescript/src/delegation/undelegate.ts
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/clients/typescript/src/world/transactions.ts
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/clients/typescript/src/generated/instructions/initializeComponent.ts
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/clients/typescript/test/intermediate-level/acceleration.ts

**Ephemeral Rollups SDK (crate sources downloaded and read)**
- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.17.0.crate
- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.14.3.crate
- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.13.0.crate
- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.12.0.crate
- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.11.0.crate
- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.10.1.crate
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk/versions

**Delegation program and validator (via `gh api`)**
- https://github.com/magicblock-labs/delegation-program — `dlp-api/src/args/delegate.rs`
- https://github.com/magicblock-labs/delegation-program — `dlp-api/src/state/delegation_record.rs`
- https://github.com/magicblock-labs/delegation-program — `src/processor/fast/delegate.rs`
- https://github.com/magicblock-labs/magicblock-validator — `magicblock-chainlink/src/cloner/mod.rs`
- https://github.com/magicblock-labs/magicblock-validator — `magicblock-chainlink/src/chainlink/fetch_cloner/delegation.rs`
- https://github.com/magicblock-labs/magicblock-validator — `magicblock-chainlink/src/testing/deleg.rs`
- https://github.com/magicblock-labs/magicblock-validator — `docs/chainlink-account-materialization.md`
- https://api.github.com/repos/magicblock-labs/magicblock-validator
- https://api.github.com/repos/magicblock-labs/delegation-program
- https://api.github.com/repos/magicblock-labs/ephemeral-rollups-sdk

**MagicBlock documentation**
- https://docs.magicblock.gg/llms.txt
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/runtime-limits.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/fees-and-commit-economics.md
- https://docs.magicblock.gg/pages/get-started/introduction/bolt (fetched; contains no BOLT content)

**Registries**
- https://crates.io/api/v1/crates/bolt-lang
- https://crates.io/api/v1/crates/bolt-lang/versions
- https://crates.io/api/v1/crates/bolt-cli
- https://crates.io/api/v1/crates/anchor-lang
- https://crates.io/api/v1/crates/anchor-lang/versions
- https://registry.npmjs.org/@magicblock-labs/bolt-sdk
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk
- https://registry.npmjs.org/@magicblock-labs/ephemeral-validator

**Live chain queries**
- https://api.devnet.solana.com — `getAccountInfo` for `WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n`, `CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua`, `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

**Local**
- `/home/anshtyagi/.claude/skills/magicblock/delegation.md`
- `/home/anshtyagi/.claude/skills/magicblock/resources.md`
