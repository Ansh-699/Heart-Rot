# BOLT framework fundamentals — research findings

**Researched:** 2026-08-31
**Researcher note:** every claim below is from a primary source (repo source at a
pinned tag, crates.io / npm registry APIs, Solana SDK source) or from a command I
actually ran on this machine. Where I could not verify, it says so.

---

## 0. Headline: BOLT is deprecated

This is the finding that outranks everything else in this document.

`README.md` on `magicblock-labs/bolt@main`, verbatim:

```markdown
> [!WARNING]
> **Deprecation Notice**
>
> Bolt has been deprecated and is no longer actively maintained.
> This repository is kept available for reference only.
```

Added in commit `71906078`, **2026-05-28**, whose entire diff is that banner:

```
@@ -1,3 +1,9 @@
+> [!WARNING]
+> **Deprecation Notice**
+>
+> Bolt has been deprecated and is no longer actively maintained.
+> This repository is kept available for reference only.
+
 <div align="center">
```

Corroborating repo signals (GitHub API, fetched today):

| Signal | Value |
|---|---|
| `archived` | `false` (so it does not *look* dead from the badge) |
| `pushed_at` | 2026-05-28 — and that push **is** the deprecation banner |
| Last commit touching code | `37cfe30b`, **2025-10-19**, a CI fix |
| Last release | `v0.2.6`, 2025-09-24 |
| Stars | 63 |
| Open issues | 29 |

For contrast, `ephemeral-rollups-sdk` published **0.17.0 on 2026-08-26** — five days
ago. The ER platform is alive and moving fast. The ECS layer on top of it is not.

The design spec §5 ("On-chain: MagicBlock BOLT") and §11 ("BOLT over Pinocchio")
were written against a framework that MagicBlock stopped maintaining three months
ago. **This is the single contradiction that matters most.**

---

## 1. Exact pinned versions

Fetched from the crates.io and npm registry APIs today.

### Rust crates (all from `magicblock-labs/bolt`)

| Crate | Latest published | Latest **installable** | Note |
|---|---|---|---|
| `bolt-lang` | 0.2.6 (2025-09-24) | **0.2.4** (2025-07-23) | 0.2.5 and 0.2.6 are **yanked** |
| `bolt-cli` | 0.2.6 (2025-09-24) | **0.2.4** | 0.2.5, 0.2.6 **yanked** |
| `bolt-attribute-bolt-component` | 0.2.6 | 0.2.6 | not yanked |
| `bolt-attribute-bolt-system` | 0.2.6 | 0.2.6 | not yanked |
| `bolt-attribute-bolt-program` | 0.2.6 | 0.2.6 | not yanked |
| `world` (the World program) | 0.2.6 | 0.2.6 | not yanked |

The yanking pattern is odd and worth naming: the two *facade* crates you actually
depend on (`bolt-lang`, `bolt-cli`) are yanked at 0.2.5/0.2.6, while the macro
crates and the World program are not. Net effect: `cargo add bolt-lang` gets you
**0.2.4**, a release from July 2025.

### npm

| Package | `dist-tags.latest` | Published |
|---|---|---|
| `@magicblock-labs/bolt-sdk` | **0.2.4** | 2025-07-23 |
| `@magicblock-labs/bolt-cli` | **0.2.4** | 2025-07-23 |
| `@magicblock-labs/ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 |

### What BOLT v0.2.4 was actually built against

From the committed `Cargo.lock` at tag `v0.2.4`:

```
anchor-lang             0.31.1
anchor-syn              0.31.1
solana-program          2.1.0
solana-sdk              2.1.0
ephemeral-rollups-sdk   0.2.6      <-- current is 0.17.0
session-keys            2.0.7
```

`rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.86.0"
components = ["rustfmt", "clippy"]
```

And `@magicblock-labs/bolt-sdk@0.2.4`'s `package.json` pins:

```json
"dependencies": {
    "@magicblock-labs/ephemeral-rollups-sdk": "0.2.1",
    "@coral-xyz/anchor": "^0.31.1"
}
```

That is an **exact** pin to ER SDK `0.2.1` on the TypeScript side, against a
current `0.17.0`. Any app that uses `bolt-sdk` *and* the modern ER SDK (which the
crank / Magic Action design in spec §5 requires) will carry two incompatible
copies of the ER SDK in `node_modules`.

---

## 2. BOLT v0.2.4 does not compile from crates.io today

I did not take this on inference. Three builds, run on this machine.

### Test 1 — the naive case

```toml
[dependencies]
bolt-lang = "0.2.4"
```

`cargo generate-lockfile` resolves:

```
anchor-lang              0.32.1
anchor-lang              1.1.2
bolt-lang                0.2.4
ephemeral-rollups-sdk    0.17.0
session-keys             2.0.8
solana-program           2.3.0
solana-program           3.0.0
world                    0.2.4
```

`cargo check` **fails**, verbatim:

```
error[E0432]: unresolved import `anchor_lang::solana_program::native_token`
 --> session-keys-2.0.8/src/lib.rs:1:47
  |
1 | use anchor_lang::{prelude::*, solana_program::native_token::LAMPORTS_PER_SOL, system_program};
  |                                               ^^^^^^^^^^^^ could not find `native_token` in `solana_program`

error[E0308]: mismatched types
   --> session-keys-2.0.8/src/lib.rs:112:17
    |
111 |             CpiContext::new(
    |             --------------- arguments to this function are incorrect
112 |                 system_program,
    |                 ^^^^^^^^^^^^^^ expected `Pubkey`, found `AccountInfo<'_>`
    |
note: associated function defined here
   --> anchor-lang-1.1.2/src/context.rs:188:12

error: could not compile `session-keys` (lib) due to 2 previous errors
```

Root cause: every version requirement in BOLT's workspace manifest is a bare
caret-zero.

```toml
anchor-lang        = { version = "^0", features = ["init-if-needed"] }
solana-program     = { version = "^2" }
ephemeral-rollups-sdk = "^0"
session-keys       = { version = "^2", features = ["no-entrypoint"] }
```

`^0` was written when 0.31 was the ceiling. The ecosystem has since shipped
`anchor-lang 1.x` and ER SDK `0.17`, so fresh resolution drags in three anchor
versions and two solana-program majors.

### Test 2 — pin the obvious things

```toml
bolt-lang             = "=0.2.4"
ephemeral-rollups-sdk = "=0.2.6"
anchor-lang           = "=0.31.1"
session-keys          = "=2.0.7"
```

Still fails. The lockfile shows top-level pins do **not** deduplicate the
transitive graph, because 0.x minor bumps are semver-incompatible and cargo is
happy to keep both:

```
anchor-lang              0.31.1, 0.32.1, 1.1.2
ephemeral-rollups-sdk    0.2.6,  0.17.0
solana-program           2.3.0,  3.0.0, 4.1.0
```

### Test 3 — also pin `solana-program = "=2.1.0"`

Still fails, now inside the old ER SDK compiled against a new `solana-program`:

```
error[E0433]: cannot find `system_program` in `solana_program`
   --> ephemeral-rollups-sdk-0.2.6/src/utils.rs:110:44
    |
110 |     target_account.assign(&solana_program::system_program::ID);
    |                                            ^^^^^^^^^^^^^^ could not find `system_program` in `solana_program`

error[E0599]: no method named `realloc` found for reference `&'a AccountInfo<'info>` in the current scope
  --> ephemeral-rollups-sdk-0.2.6/src/utils.rs:93:20
    |
 93 |     target_account.realloc(0, false)
    |                    ^^^^^^^ method not found in `&'a AccountInfo<'info>`

error: could not compile `ephemeral-rollups-sdk` (lib) due to 10 previous errors
```

### A second, independent version landmine

`bolt-lang/src/lib.rs` at v0.2.4 does:

```rust
pub use ephemeral_rollups_sdk::anchor::{DelegationProgram, MagicProgram};
```

In ER SDK **0.17.0** that module is feature-gated (`src/lib.rs`):

```rust
#[cfg(feature = "anchor-support")]
pub mod anchor;
```

and the default feature set is:

```toml
default = ["solana-system-interface"]
```

`anchor-support` is **not** default, and BOLT requests no features. So even if the
anchor/solana skew were resolved, that import would not exist.

`ephem::commit_and_undelegate_accounts` survives, but only as a deprecated
re-export:

```rust
#![allow(deprecated)]
pub use crate::ephem::deprecated::v0::{
    commit_accounts, commit_and_undelegate_accounts, create_schedule_commit_ix,
};
```

### Test 4 — inside the repo, with its own lockfile: **succeeds**

For contrast, building the examples *inside* the cloned repo at `v0.2.4`, which
ships a committed `Cargo.lock`:

```
$ cargo check -p position -p system-apply-velocity
warning: `system-apply-velocity` (lib) generated 2 warnings
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 25.50s
```

Clean, warnings only. So BOLT's code is fine — **the breakage is entirely
dependency resolution.** Given a correct lockfile it compiles today.

### The only path that can work

Since the repo's own lock works, an external project needs the same thing: pin the
**whole BOLT workspace by git rev** via the escape hatch BOLT's own scaffolding
leaves commented out (`crates/bolt-cli/src/templates/workspace/workspace.toml.template`):

```toml
[patch.crates-io]
# Uncomment this to use the latest in-development version of Bolt
# bolt-lang = { git = "https://github.com/magicblock-labs/bolt.git", branch = "main" }
```

…and then hand-freeze `Cargo.lock` to BOLT's own versions (Test 4 shows those
versions do build). That is a maintenance burden you own forever on a dead
framework, and it pins you to `solana-program 2.1` / `anchor-lang 0.31` for the
life of the project — including for any *other* crate in your workspace.

**Note:** `bolt init` scaffolds a workspace with `bolt-lang = "{VERSION}"` and
**no lockfile**, which is precisely Test 1. Expect `bolt init && bolt build` to
fail out of the box.

---

## 3. The model: World / Entity / Component / System

### Three deployed programs form the runtime

| Program | ID (devnet + localnet) | Role |
|---|---|---|
| `world` | `WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n` | the only program allowed to mutate components |
| `bolt-component` | `CmP2djJgABZ4cRokm4ndxuq6LerqpNHLBsaUv2XKEJua` | interface-only stub; defines the CPI shape every component program must expose |
| `bolt-system` | `7X4EFsDJ5aYTcEjKzJ94rD8FRKgQeXC89fkpeTS4KaqP` | interface-only stub; defines `bolt_execute` |

`bolt-component` and `bolt-system` are pure *interface* programs — their handlers
are literally `Ok(())`. They exist so World can build a typed `CpiContext` against
any component or system program that matches the shape.

### The single most important structural fact

> **Every component is its own deployed Solana program, and every system is its own
> deployed Solana program.**

`#[component]` expands to a full Anchor `#[program]` module. From
`crates/bolt-lang/attribute/component/src/lib.rs`:

```rust
let bolt_program = if delegate_set {
    quote! {
        #[delegate(#name)]
        #[bolt_program(#name)]
        pub mod #component_name {
            use super::*;
        }
    }
} else {
    quote! {
        #[bolt_program(#name)]
        pub mod #component_name {
            use super::*;
        }
    }
};
```

and `#[bolt_program]` prepends `#[program]`:

```rust
let additional_macro: Attribute = parse_quote! { #[program] };
TokenStream::from(quote! {
    #additional_macro
    #modified
})
```

For HEARTROT's component set that means **9 component programs + 7 system programs
= 16 separate program deploys**, each with its own program ID, its own buffer, its
own rent, its own upgrade authority, and its own redeploy every time you change a
field. Budget for that in the build order (spec §10 step 0).

### Component declaration — verbatim, from `examples/`

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

With an explicit component id (which becomes the PDA seed) and a variable-length
field:

```rust
use bolt_lang::*;

declare_id!("CbHEFbSQdRN4Wnoby9r16umnJ1zWbULBHg4yqzGQonU1");

#[component(component_id = "component-velocity")]
#[derive(Default)]
pub struct Velocity {
    pub x: i64,
    pub y: i64,
    pub z: i64,
    pub last_applied: i64,
    #[max_len(20)]
    pub description: String,
}
```

### System declaration — verbatim, from `examples/`

Minimal:

```rust
use bolt_lang::*;
use position::Position;

declare_id!("HT2YawJjkNmqWcLNfPAMvNsLdWwPvvvbKA5bpMw4eUpq");

#[system]
pub mod system_fly {

    pub fn execute(ctx: Context<Components>, _args: Vec<u8>) -> Result<Components> {
        let pos = &mut ctx.accounts.position;
        pos.z += 1;
        Ok(ctx.accounts)
    }

    #[system_input]
    pub struct Components {
        pub position: Position,
    }
}
```

With typed arguments and a component addressed by on-chain id:

```rust
use bolt_lang::*;

declare_id!("FSa6qoJXFBR3a7ThQkTAMrC15p6NkchPEjBdd4n6dXxA");

#[system]
pub mod system_simple_movement {
    pub fn execute(ctx: Context<Components>, args: Args) -> Result<Components> {
        // Compute the new position based on the direction
        let (dx, dy) = match args.direction {
            Direction::Left => (-1, 0),
            Direction::Right => (1, 0),
            Direction::Up => (0, 1),
            Direction::Down => (0, -1),
        };
        ctx.accounts.position.x += dx;
        ctx.accounts.position.y += dy;

        Ok(ctx.accounts)
    }

    #[system_input]
    pub struct Components {
        #[component_id("Fn1JzzEdyb55fsyduWS94mYHizGhJZuhvjX6DVvrmGbQ")]
        pub position: Position,
    }

    // Define the structs to deserialize the arguments
    #[arguments]
    struct Args {
        direction: Direction,
    }

    #[arguments]
    pub enum Direction {
        Left,
        Right,
        Up,
        Down,
    }
}
```

With extra (non-component) accounts:

```rust
    #[extra_accounts]
    pub struct ExtraAccounts {
        #[account(address = bolt_lang::solana_program::sysvar::clock::id())]
        pub sysvar_clock: AccountInfo,
        #[account(address = pubkey!("tEsT3eV6RFCWs1BZ7AXTzasHqTtMnMLCB2tjQ42TDXD"))]
        pub some_extra_account: AccountInfo,
        #[account(address = mpl_token_metadata::ID)]
        pub program_metadata: Program<mpl_token_metadata::Metadata>,
    }
```

Read in the body with the generated accessor, which returns `Result` because the
account may simply not have been passed:

```rust
let mut clock = Clock::get()?;
if let Ok(clock_account_info) = ctx.sysvar_clock() {
    clock = Clock::from_account_info(clock_account_info)?;
    ctx.accounts.position.z = 300;
}
```

---

## 4. Account layout, ownership, PDA derivation

### What the macro adds to your struct

`#[component]` does three things to the struct itself:

1. adds `#[account]` — so it is a standard Anchor account with an **8-byte
   discriminator**;
2. adds `#[derive(InitSpace)]`;
3. **appends a `bolt_metadata: BoltMetadata` field** (`bolt-lang/utils/src/lib.rs`
   `add_bolt_metadata`), where

```rust
#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Default, Copy, Clone)]
pub struct BoltMetadata {
    pub authority: Pubkey,
}
```

So **every component silently costs 32 extra bytes** you did not write.

It also generates a `new()` + `<Name>Init` struct so you can construct without
naming `bolt_metadata`.

### Seed and size

```rust
#[automatically_derived]
impl ComponentTraits for #name {
    fn seed() -> &'static [u8] {
        #component_id_value.as_bytes()
    }

    fn size() -> usize {
        8 + <#name>::INIT_SPACE
    }
}
```

`component_id_value` defaults to the **empty string** when you write a bare
`#[component]`. So the default seed is `b""`.

### PDA derivation — authoritative

From the generated `Initialize` accounts struct:

```rust
#[account(init_if_needed, payer = payer, space = <#component_type>::size(),
          seeds = [<#component_type>::seed(), entity.key().as_ref()], bump)]
pub data: Account<'info, #component_type>,
```

So:

```
component_pda = find_program_address(
    [ component_id_string_bytes , entity_pubkey ],
    component_program_id            // <-- NOT the World program
)
```

The TypeScript client agrees exactly (`clients/typescript/src/index.ts`):

```ts
export function FindComponentPda({ componentId, entity, seed }: {
  componentId: PublicKey; entity: PublicKey; seed?: string;
}) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(seed ?? ""), entity.toBytes()],
    componentId,
  )[0];
}
```

The other PDAs, from the World program and the TS client:

| Account | Seeds | Program |
|---|---|---|
| `Registry` | `["registry"]` | World |
| `World` | `["world", world_id.to_be_bytes()]` (big-endian u64) | World |
| `Entity` | `["entity", world_id_be, entity_id_be]`, or `["entity", world_id_be, [0u8;8], extra_seed]` | World |
| Component | `[component_id_bytes, entity_pubkey]` | **the component's own program** |
| Session token | `["session_token", WORLD_PROGRAM_ID, session_signer, authority]` | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` |

`Entity` itself is tiny — it is nothing but a counter:

```rust
#[account]
#[derive(InitSpace, Default, Copy)]
pub struct Entity {
    pub id: u64,
}
```

An "entity" in BOLT is just a pubkey used as a PDA seed. It holds no component
list, no registry of what is attached to it. Enumerating an entity's components is
a client-side concern: you know the component program ids, so you derive.

### Ownership

The component account is **owned by the component's own program**. Not by World,
not by a shared component store. This is the fact that governs the whole Pinocchio
question in §7.

---

## 5. How a System is invoked — and where the design breaks

### The call graph

A gameplay transaction is one top-level instruction: `world::apply`.

```
tx ─▶ world::apply(args)                                 [top-level]
        │
        ├─ CPI ─▶ <your system>::bolt_execute(args)       returns Vec<Vec<u8>>
        │            (components arrive as remaining_accounts)
        │
        └─ for each (component_program, component_account) pair:
             CPI ─▶ <component program>::update(data)     writes the bytes back
```

`apply` verbatim:

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

### The `remaining_accounts` calling convention

From `apply_impl`:

```rust
let mut pairs = Vec::new();
while remaining_accounts.len() >= 2 {
    let program = remaining_accounts.remove(0);
    if program.key() == ID {
        break;
    }
    let component = remaining_accounts.remove(0);
    pairs.push((program, component));
}

let mut components_accounts = pairs
    .iter()
    .map(|(_, component)| component)
    .cloned()
    .collect::<Vec<_>>();
components_accounts.append(&mut remaining_accounts);
let remaining_accounts = components_accounts;
```

So `remaining_accounts` is:

```
[ prog_A, comp_A, prog_B, comp_B, ..., WORLD_PROGRAM_ID (sentinel), extra1, extra2, ... ]
```

The World program id doubles as the terminator between component pairs and extra
accounts. The system then receives `[comp_A, comp_B, ..., extra1, extra2, ...]`.

`#[system_input]` binds `remaining_accounts[i]` positionally to field `i`:

```rust
#field_name: Account::try_from(context.remaining_accounts.as_ref().get(#i)
    .ok_or_else(|| ErrorCode::ConstraintAccountIsNone)?)?,
```

and `#[extra_accounts]` accessors index **past** them:

```rust
fn #field_name(&self) -> Result<&'c AccountInfo<'info>> {
    self.remaining_accounts.get(Self::NUMBER_OF_COMPONENTS + #index)
        .ok_or_else(|| ErrorCode::ConstraintAccountIsNone.into())
}
```

### The 1024-byte return-data ceiling — hard blocker

`#[system]` rewrites your `Ok(ctx.accounts)` into `ctx.accounts.try_to_vec()`, and
`#[system_input]` generates:

```rust
pub fn try_to_vec(&self) -> Result<Vec<Vec<u8>>> {
    Ok(vec![#(#try_to_vec_fields,)*])
}
```

i.e. **every component in the system input is fully serialized and returned as
Solana program return data**, and World then writes each one back.

Solana's cap, from `anza-xyz/solana-sdk`, `cpi/src/lib.rs`:

```rust
/// Maximum size that can be set using [`set_return_data`].
pub const MAX_RETURN_DATA: usize = 1024;
```

Now size HEARTROT's `Bullets` component:

```
128 × { x: i16, y: i16, dx: i8, dy: i8, active: bool }
  = 128 × 7                                    =  896 bytes
+ bolt_metadata.authority (Pubkey)             =   32 bytes
                                                  ─────────
serialized body                                =  928 bytes
+ Vec<Vec<u8>> framing (4 outer + 4 inner)     =    8 bytes
                                                  ─────────
                                               =  936 bytes   (91% of 1024)
+ 8-byte discriminator on the account itself   =  936-byte account
```

`Bullets` **alone**, as the only component in a system, fits with 88 bytes to
spare. Add anything else and it fails.

But `BossTick` per spec §5 must advance bullets *and* test collision against
player positions *and* update `ArenaState` *and* check vent/core. Its natural
system input is `Bullets + ArenaState + Core + Parts + 20 × Position + 20 × Health`
— roughly 44 components, several kilobytes. That is **4× over the hard ceiling**
and cannot be made to fit by tuning.

**This is a direct contradiction of design spec §5.** The `Bullets[128]` pooled-
projectile decision — which the spec correctly reasons is right for *avoiding
account allocation* — collides with a BOLT-specific transport limit the spec did
not know about.

### CU cost, measured by MagicBlock themselves

`docs/REPORT.md` on `main`, generated by PR #200 ("CU measurement"), verbatim:

```
    x-axis ["1C-CPIs:2","2C-CPIs:3","3C-CPIs:4","4C-CPIs:5","5C-CPIs:6","6C-CPIs:7","7C-CPIs:8","8C-CPIs:9","9C-CPIs:10","10C-CPIs:11"]
    y-axis "CU" 5000 --> 200000
    bar [15254,24352,33653,43017,52358,61568,71006,80482,89958,99299]
    bar [6162,11236,16305,21374,26443,31516,36608,41892,46984,52077]
```

Read that carefully. Those are **no-op systems** over `Small` components that
contain *only* `BoltMetadata` — 32 bytes each. It is pure framework overhead, zero
game logic.

| Components | CPIs | CU (upper series) | CU (lower series) |
|---:|---:|---:|---:|
| 1 | 2 | 15,254 | 6,162 |
| 5 | 6 | 52,358 | 26,443 |
| 10 | 11 | 99,299 | 52,077 |

Marginal cost is **~9,340 CU per additional component** on the upper series. The
CPI count is `components + 1`, so the cost is structural: one CPI into the system
plus one `update` CPI per component.

Extrapolating linearly: 20 components ≈ **193,000 CU** of pure overhead, against a
200,000 CU default per-instruction budget (1.4M with an explicit
`SetComputeUnitLimit`). Before a single line of boss logic.

For HEARTROT this says: keep systems to a handful of *written* components, and
push everything read-only into `#[extra_accounts]`.

### The read-only escape hatch

`#[extra_accounts]` fields are plain `AccountInfo`; they are **not** serialized
into the return data and cost no `update` CPI. Combined with the generated
deserializer:

```rust
/// Allows to deserialize a component AccountInfo into a struct.
pub trait ComponentDeserialize: Sized {
    /// Deserializes an `AccountInfo` into a `Self`.
    fn from_account_info(account: &anchor_lang::prelude::AccountInfo) -> Result<Self>;
}
```

whose impl skips the discriminator:

```rust
fn try_deserialize_unchecked(buf: &mut &[u8]) -> bolt_lang::Result<Self> {
    let mut data: &[u8] = &buf[8..];
    bolt_lang::AnchorDeserialize::deserialize(&mut data)
        .map_err(|_| bolt_lang::AccountDidNotDeserializeErrorCode.into())
}
```

So the viable BOLT shape for `BossTick` is: `Bullets` and `ArenaState` as the only
`#[system_input]` components (written), and all 20 player `Position` accounts as
`#[extra_accounts]` (read, never written). The `#[account(...)]` attributes on
extra-account fields are passed straight through, so they can be unconstrained
`AccountInfo` — you are responsible for validating the PDA yourself.

That still leaves `Bullets` (928 B) + `ArenaState` (~50 B) ≈ **990 bytes** against
a 1024-byte cap. It *technically* fits, with ~34 bytes of headroom, and it is one
field away from breaking forever. I would not build on that margin.

### Arguments are JSON, not borsh

An under-advertised cost. `#[system]` rewrites a typed second argument into
`Vec<u8>` plus a `parse_args` call, and `parse_args` is:

```rust
/// Parses the arguments from a byte array.
pub fn parse_args<T: serde::de::DeserializeOwned>(args_p: &[u8]) -> T {
    let args_string = str::from_utf8(args_p).expect("Failed to convert to string");
    let args: T = serde_json::from_str(args_string)
        .unwrap_or_else(|_| panic!("Failed to deserialize args: {:?}", args_string));
    args
}
```

**System arguments are a UTF-8 JSON string, deserialized with `serde_json`
on-chain.** For a movement instruction sent at input rate that is both wire bloat
and real CU. You can avoid it by declaring `args: Vec<u8>` yourself and decoding
manually — the macro only injects `parse_args` when the second argument is *not*
already `Vec<u8>`.

Note also `parse_args` **panics** on malformed input rather than returning an
error.

---

## 6. Zero-copy: not supported

Asked directly, the answer is no, and the source is unambiguous.

- `#[component]` emits `#[account]`, never `#[account(zero_copy)]`.
- `#[system_input]` binds fields as `Account<'info, T>` (the deserializing
  wrapper), not `AccountLoader<'info, T>`.
- The write path is a full deserialize/serialize round trip:

```rust
ctx.accounts.bolt_component.set_inner(<#component_type>::try_from_slice(&data)?);
```

- The transport is `Vec<Vec<u8>>` return data, which is a copy by construction.

There is no `bytemuck`/`Pod` path through the component macro. (`bytemuck_derive`
appears in `bolt-cli`'s dependencies, but that is the CLI's own IDL tooling, not
the component runtime.)

**Consequence:** a 928-byte `Bullets` component is deserialized, mutated,
re-serialized, shipped as return data, and re-deserialized and written by a second
CPI — every single tick, at 400 ms. There is no way to touch one bullet slot in
place.

### Maximum component size

Two ceilings, in order of which you hit first:

| Limit | Value | Source | Bites when |
|---|---:|---|---|
| **Return data** | **1,024 B** | `MAX_RETURN_DATA` | any system that *writes* the component |
| Realloc / CPI growth | 10,240 B | `MAX_PERMITTED_DATA_INCREASE = 1_024 * 10` | `initialize` creates the account via CPI |
| Account data | 10 MiB | `MAX_PERMITTED_DATA_LENGTH = 10 * 1024 * 1024` | never, here |

So: a BOLT component can *exist* up to ~10 KB, but the moment a system writes it,
the effective ceiling is **1,024 bytes minus every other component in the same
system**. Treat 1 KB as the real limit and leave headroom.

---

## 7. Can a non-BOLT (Pinocchio) program touch component accounts?

This is the user's new first-class question. The answer splits cleanly in two.

### Reading: yes, trivially, and this is fully sound

A component account is an ordinary Solana account: 8-byte Anchor discriminator,
then borsh fields in declaration order, then the 32-byte `bolt_metadata.authority`
appended last. Any program can be handed the account and decode it. In Pinocchio:

```rust
// component account layout: [0..8] discriminator, [8..] borsh body
let data = component_account.try_borrow_data()?;
let body = &data[8..];
// then decode your fields positionally; bolt_metadata.authority is the last 32 bytes
```

You must derive and check the PDA yourself —
`find_program_address([component_id_bytes, entity_pubkey], component_program_id)`
— because nothing else will. Reading is cheap, safe, and needs no cooperation from
BOLT.

### Writing: no, not from a top-level Pinocchio instruction

Two independent walls.

**Wall 1 — ownership.** The component account is owned by the component's own
program. Only that program can mutate its data. A Pinocchio program cannot write
those bytes directly; it must CPI into `<component_program>::update`.

**Wall 2 — the caller check.** Every mutating entry point on a component program
performs this, verbatim (`generate_update`):

```rust
pub fn update(ctx: Context<Update>, data: Vec<u8>) -> Result<()> {
    require!(ctx.accounts.bolt_component.bolt_metadata.authority == World::id()
        || (ctx.accounts.bolt_component.bolt_metadata.authority == *ctx.accounts.authority.key
            && ctx.accounts.authority.is_signer), BoltError::InvalidAuthority);

    // Check if the instruction is called from the world program
    let instruction = anchor_lang::solana_program::sysvar::instructions::get_instruction_relative(
        0, &ctx.accounts.instruction_sysvar_account.to_account_info()
    ).map_err(|_| BoltError::InvalidCaller)?;
    require_eq!(instruction.program_id, World::id(), BoltError::InvalidCaller);

    ctx.accounts.bolt_component.set_inner(<#component_type>::try_from_slice(&data)?);
    Ok(())
}
```

The same check appears in `initialize` and `destroy`.

### What that check actually asserts — read it precisely

`get_instruction_relative` from `anza-xyz/solana-sdk`:

```rust
/// Returns the `Instruction` relative to the current `Instruction` in the
/// currently executing `Transaction`.
pub fn get_instruction_relative(
    index_relative_to_current: i64,
    instruction_sysvar_account_info: &AccountInfo,
) -> Result<Instruction, ProgramError> {
    if !check_id(instruction_sysvar_account_info.key) {
        return Err(ProgramError::UnsupportedSysvar);
    }

    let instruction_sysvar = instruction_sysvar_account_info.data.borrow();
    let current_index = load_current_index(&instruction_sysvar) as i64;
    let index = current_index.saturating_add(index_relative_to_current);
    ...
}
```

The instructions sysvar records **only top-level instructions**. So
`get_instruction_relative(0, …)` returns *the outermost transaction instruction
currently executing*, not the direct caller.

Therefore the check means:

> "the **top-level** instruction of this transaction must target the World program"

It does **not** mean "my immediate caller is World." Two consequences:

1. A Pinocchio program invoked **at the top level** that CPIs into a component
   program's `update` will fail with `InvalidCaller`. Its own program id is the
   top-level instruction. **This kills the naive "Pinocchio writes components"
   design.**
2. A Pinocchio program invoked **beneath** a top-level `world::apply` — e.g.
   apply → your BOLT system → CPI → Pinocchio program → CPI → component `update` —
   *would* pass, because the top-level instruction is still World. It also burns
   4 of Solana's 5 CPI depth levels, and it works only by exploiting a check
   MagicBlock knows is too weak.

### MagicBlock tried to close this hole, then reverted it

PR **#196**, ":sparkles: CPI Authentication using a World PDA", merged
2025-08-01. Its own problem statement, verbatim:

> We needed to improve the CPI authentication mechanism to guarantee that the
> instruction is being called from the World program. We couldn't rely on getting
> the relative instructions from sysvar because we could only test against the
> topmost instruction, making it impossible to CPI the World program.

It replaced `instruction_sysvar_account` with a `cpi_auth` **signer** — a World
PDA at hardcoded address `B2f2y3QTBv346wE6nWKor72AUhUvFF6mPk7TWCF2QVhi`. That
shipped in v0.2.5 and v0.2.6.

PR **#213** then **reverted it entirely**, merged 2025-10-17:

> Reverts PR #196
> * Replaced `CpiAuth` with `InstructionSysvarAccount` across SDKs (C#, TypeScript, Rust).
> * Removed `CPI_AUTH_ADDRESS` constant from TypeScript SDK.

So the timeline is:

| Version | Auth mechanism | Status |
|---|---|---|
| **v0.2.4** | instruction sysvar (top-level check) | the only installable release |
| v0.2.5, v0.2.6 | World PDA `cpi_auth` signer | **yanked** on crates.io |
| `main` (unreleased) | reverted to instruction sysvar | never released; repo then deprecated |

The auth model you would build against is the weak one, in a framework that was
deprecated seven months after the revert. Nobody is going to fix this.

### Verdict on the hybrid Pinocchio + BOLT design

| Direction | Verdict |
|---|---|
| Pinocchio **reads** BOLT component accounts | Sound. Do this freely. |
| Pinocchio **writes** BOLT components, top-level | **Blocked.** `InvalidCaller`, by design. |
| Pinocchio writes components under a `world::apply` | Technically passes; depends on a known-weak check; 4 CPI levels deep; do not build on it. |
| Pinocchio program owning its **own** accounts, alongside BOLT | Sound and clean. |

The last row is the only hybrid worth designing. Give the Pinocchio program its
own account space — leaderboard, incarnation counter, treasury accounting — and
have it read BOLT components when it needs to. Do not try to make it a component
writer.

Note also the design spec §11's stated reason for rejecting Pinocchio still holds
independently: `ephemeral-rollups-sdk` uses `solana_program::AccountInfo`, which
is not Pinocchio's `AccountInfo`. ER SDK 0.17.0 does now carry a `compat` module
(`compat::AccountInfo`, `AsModern`, `Modern` traits) which may narrow that gap —
**I did not verify whether `compat` reaches Pinocchio specifically; treat that as
an open question, not a finding.**

---

## 8. Authority and session keys — how the spec's model maps

The spec (§5) wants: platform holds delegation authority, player's session pubkey
is stored on `PlayerMeta`, every player-facing system asserts
`signer == player.session_pubkey`.

BOLT's own model is different, and worth knowing before you fight it.

`initialize` stamps the authority at creation:

```rust
ctx.accounts.data.set_inner(<#component_type>::default());
ctx.accounts.data.bolt_metadata.authority = *ctx.accounts.authority.key;
```

`update` then accepts **either**:

```rust
require!(ctx.accounts.bolt_component.bolt_metadata.authority == World::id()
    || (ctx.accounts.bolt_component.bolt_metadata.authority == *ctx.accounts.authority.key
        && ctx.accounts.authority.is_signer), BoltError::InvalidAuthority);
```

- `authority == World::id()` — the "public" component, writable by anyone who can
  route through World, or
- `authority == signer` — locked to one key.

And `world::apply_impl` gates the transaction:

```rust
if !authority.is_signer && authority.key != &ID {
    return Err(WorldError::InvalidAuthority.into());
}
if !world.permissionless
    && !world.systems().approved_systems.contains(&bolt_system.key())
{
    return Err(WorldError::SystemNotApproved.into());
}
```

A `World` starts `permissionless: true`. Calling `approve_system` flips it to
`false` and begins enforcing an allowlist:

```rust
pub fn approve_system(ctx: Context<ApproveSystem>) -> Result<()> {
    ...
    if ctx.accounts.world.permissionless {
        ctx.accounts.world.permissionless = false;
    }
    let mut world_systems = ctx.accounts.world.systems();
    world_systems.approved_systems.insert(ctx.accounts.system.key());
    ...
}
```

**For HEARTROT: call `approve_system` for all 7 systems.** A permissionless world
lets anyone deploy a system that mutates your components through `apply`. That is
BOLT's "autonomous worlds" feature and it is the opposite of what a raid boss
wants. CLI: `bolt approve-system`, `bolt remove-system`.

There is also a session-key path (`update_with_session`, `apply_with_session`)
using `session-keys 2.0.7` (`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`) with
`session_token.valid_until` expiry. This is arguably a better fit for the spec's
popup-free session wallet than the hand-rolled `PlayerMeta.session_pubkey` check —
but it is another dependency in the same dead tree, and it is the crate that
**caused the compile failure in §2**.

---

## 9. Delegation to the Ephemeral Rollup

`#[component(delegate)]` injects four instructions. Verbatim:

```rust
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

```rust
pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
    ::bolt_lang::commit_and_undelegate_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.delegated_account.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;
    Ok(())
}
```

```rust
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

Two things to plan around.

**Delegation is per-component-account.** Not per-entity, not per-world. HEARTROT
at 20 players has, at minimum:

```
20 players × 4 components (Position, Health, PlayerMeta, Combat)  = 80
boss × 4 (Position, Parts, Core, BossState)                       =  4
arena × 2 (ArenaState, Bullets)                                   =  2
                                                                  ────
                                                                  = 86 accounts
```

86 separate `delegate` instructions at match start, and 86 commits at settlement.
That is the real cost behind spec §9's `/match/start` route, and it is far more
than one transaction — Solana's 1232-byte transaction size cap means you are
batching these across many transactions. Feasible, but budget the time and the
rent.

**Good news on the ER SDK surface:** `DelegateConfig` still has exactly the two
fields BOLT passes, in 0.17.0:

```rust
pub struct DelegateConfig {
    pub commit_frequency_ms: u32,
    pub validator: Option<compat::Pubkey>,
}
```

and `DelegateAccounts` still has the same eight fields. So the *shape* BOLT
targets is unchanged — the breakage in §2 is about types and features, not about
the delegation model.

**Crank:** ER SDK 0.17.0 has a `crank` module with `ScheduleCrankCpi` /
`CancelCrankCpi` wrapping `MagicBlockInstruction::ScheduleTask(ScheduleTaskArgs)`,
which is what spec §5's 400 ms `BossTick` needs. But it is gated behind the
`crank` feature, lives in ER SDK **0.17**, and BOLT v0.2.4 pins ER SDK **0.2.6** —
so the crank is not reachable through `bolt-lang`'s re-exports. You would call it
directly, which reintroduces the two-ER-SDK-versions problem from §2. Detailed
crank semantics are another topic's job; flagging the version coupling here.

---

## 10. The `bolt` CLI

Installed with `cargo install bolt-cli` (gets **0.2.4**), or
`npm i -g @magicblock-labs/bolt-cli` (also 0.2.4).

It is a thin wrapper that **flattens the entire Anchor CLI** into itself:

```rust
#[derive(Subcommand)]
pub enum BoltCommand {
    #[clap(about = "Create a new component")]
    Component(ComponentCommand),
    #[clap(about = "Create a new system")]
    System(SystemCommand),
    // Include all existing commands from anchor_cli::Command
    #[clap(flatten)]
    Anchor(anchor_cli::Command),
    #[clap(about = "Add a new registry instance")]
    Registry(RegistryCommand),
    #[clap(about = "Add a new world instance")]
    World(WorldCommand),
    #[clap(about = "Add a new authority for a world instance")]
    Authorize(AuthorizeCommand),
    #[clap(about = "Remove an authority from a world instance")]
    Deauthorize(DeauthorizeCommand),
    #[clap(about = "Approve a system for a world instance")]
    ApproveSystem(ApproveSystemCommand),
    #[clap(about = "Remove a system from a world instance")]
    RemoveSystem(RemoveSystemCommand),
}
```

So `bolt build`, `bolt test`, `bolt deploy` are Anchor's, and `bolt component`,
`bolt system`, `bolt world`, `bolt registry`, `bolt approve-system` are BOLT's.

Because it embeds `anchor-cli` as a **library** at BOLT's pinned Anchor version,
you are locked to the Anchor toolchain BOLT chose (0.31.x). You cannot mix a newer
Anchor CLI with `bolt build`.

Scaffolded layout (`workspace.toml.template`):

```toml
[workspace]
members = [
    "programs/*",
    "programs-ecs/components/*",
    "programs-ecs/systems/*"
]
```

The README also requires:

```bash
rustup update nightly   # required to generate IDLs
```

Local ER acceleration comes from `@magicblock-labs/ephemeral-validator`, which
BOLT's own `package.json` pins to `^0.1.7`.

---

## 11. How this connects to the HEARTROT architecture

| Design decision (spec §) | Status against verified BOLT behaviour |
|---|---|
| BOLT as the on-chain framework (§5) | **Framework is deprecated** (§0) and does not build from crates.io (§2) |
| `Bullets[128]` as one ~1 KB component (§3, §5) | 936 B serialized vs a **1024 B** return-data cap; survives only as the *sole* component in its system (§5) |
| `BossTick` reads 20 player positions each tick (§3) | Must go through `#[extra_accounts]` + `ComponentDeserialize`, never `#[system_input]` (§5) |
| Hitscan `Shoot` — no projectile entities (§3) | Fine, and BOLT-friendly: small system input, one written component |
| Entity: Arena / Boss / Player×20 (§5) | Fine. Entities are counters; components are per-(component, entity) PDAs (§4) |
| 9 components, 7 systems (§5) | **16 separate program deploys**, not one (§3) |
| Platform holds delegation authority, `PlayerMeta.session_pubkey` checked per system (§5) | Workable, but BOLT's native session-key path (`apply_with_session`) already does this; note it is the crate that breaks the build (§8) |
| Crank ticks `BossTick` at 400 ms (§5) | `crank::ScheduleCrankCpi` exists in ER SDK **0.17**, unreachable via `bolt-lang`'s pinned **0.2.6** (§9) |
| Magic Action chains commit + leaderboard (§5) | Same version-coupling problem (§9) |
| Browser → ER directly, backend never in the hot path (§9) | Unaffected by any of this. Still right. |
| Pinocchio program alongside BOLT, CPI where needed (new) | **Reads: yes. Writes: blocked.** Own-account Pinocchio program alongside: sound (§7) |
| "Pinocchio was evaluated and rejected" (§11) | The rejection reasoning is now weaker: the framework it chose instead is dead, and ER SDK 0.17 has a `compat` layer that may (unverified) ease native integration (§7) |

### Component sizes, computed

| Component | Fields | Body | +32 metadata | +8 disc | Account |
|---|---|---:|---:|---:|---:|
| `Position` | x,y i16; zone,facing u8 | 6 | 38 | 46 | 46 B |
| `Health` | current,max u16; respawn_at i64 | 12 | 44 | 52 | 52 B |
| `PlayerMeta` | session_pubkey 32; skin_id u8; damage_dealt u32 | 37 | 69 | 77 | 77 B |
| `Combat` | last_shot_tick u32 | 4 | 36 | 44 | 44 B |
| `Parts` | 9 × u16 | 18 | 50 | 58 | 58 B |
| `Core` | vent_open bool; core_hp u16 | 3 | 35 | 43 | 43 B |
| `ArenaState` | phase u8; tick u32; incarnation u16; alive_count u8; enrage_at i64 | 16 | 48 | 56 | 56 B |
| **`Bullets`** | **128 × 7** | **896** | **928** | **936** | **936 B** |

Everything except `Bullets` is comfortable. `Bullets` is the whole problem.

### If you stay on BOLT, the shape that actually fits

```rust
#[system]
pub mod boss_tick {
    pub fn execute(ctx: Context<Components>, _args: Vec<u8>) -> Result<Components> {
        // written components only — must stay under 1024 B combined
        // ArenaState (56 B) + Bullets (936 B) = ~992 B serialized. ~32 B headroom.
        ...
        Ok(ctx.accounts)
    }

    #[system_input]
    pub struct Components {
        pub arena_state: ArenaState,
        pub bullets: Bullets,
    }

    // read-only: not serialized, no update CPI, no return-data cost
    #[extra_accounts]
    pub struct ExtraAccounts {
        pub player_0_position: AccountInfo,
        // ... × 20, each read with Position::from_account_info()
    }
}
```

Two hard constraints fall out:

1. **Damage to the boss cannot happen in `BossTick`.** `Parts` and `Core` are
   already over budget once `Bullets` is in. Split into a separate system.
2. **Player damage from bullets cannot be written in `BossTick`** either — 20
   `Health` components is another ~1 KB. You need a second instruction, or you
   record hits into a small field on `ArenaState` and settle them elsewhere.

If shrinking `Bullets` is acceptable, **64 bullets** (`64 × 7 = 448 B` body,
480 B serialized) roughly halves the pressure and buys real headroom. Spec §3 sets
`bullets_per_volley = 3 + alive_players` = 23 at full raid, every 8 ticks; whether
64 in flight is enough depends on bullet lifetime, which the spec does not pin
down. Worth deciding deliberately rather than discovering at the ceiling.

---

## 12. Gotchas and failure modes, ranked

1. **BOLT is deprecated.** No fixes, no releases, no security response. (§0)
2. **`cargo add bolt-lang` produces a build that does not compile.** Reproduced
   three ways. BOLT's *code* is fine — building inside the repo with its own
   lockfile succeeds cleanly — so the only fix is freezing a hand-built lockfile
   forever, which then pins your entire workspace to Anchor 0.31 / solana-program
   2.1. (§2)
3. **1024-byte return-data cap on everything a system writes.** Not documented in
   the BOLT book; discovered only by reading the macro expansion. Kills the
   spec's `BossTick` shape outright. (§5)
4. **~9,340 CU per component, per apply, on empty no-op systems.** MagicBlock's
   own measurement. 20 components ≈ 193K CU before any logic. (§5)
5. **`bolt-lang` 0.2.5 / 0.2.6 are yanked**, so the "latest version" badge on the
   README lies about what you can install. (§1)
6. **The CPI auth model was fixed and then reverted.** The releasable version uses
   a check that only validates the *top-level* instruction. (§7)
7. **No zero-copy.** Full deserialize/serialize round trip per component per
   tick. (§6)
8. **System arguments are JSON.** `serde_json` on-chain, and `parse_args` panics
   on malformed input rather than erroring. (§5)
9. **Every component is a program.** 16 deploys for HEARTROT, each redeployed on
   every field change. (§3)
10. **A `World` is permissionless until you call `approve_system`.** Until then
    anyone can deploy a system and mutate your components. (§8)
11. **`#[component]` silently adds 32 bytes** (`bolt_metadata.authority`) to
    every component. (§4)
12. **Default component seed is the empty string.** Two components on one entity
    without explicit `component_id` collide — different program ids save you, but
    it is a trap worth naming. (§4)
13. **86 delegation instructions at match start** for a 20-player raid. (§9)
14. **The Bolt Book is stale** — it self-describes as documenting "Bolt v0.1.0",
    against a v0.2.6 codebase. Read the source, not the book. (§10)
15. **`bolt-sdk` pins ER SDK `0.2.1` on npm** vs a current `0.17.0`. Two copies in
    `node_modules` if you need modern crank / Magic Actions. (§1)

---

## 13. What I could not verify

- Whether ER SDK 0.17.0's `compat` module makes native **Pinocchio** integration
  practical. The module exists (`compat::AccountInfo`, `AsModern`, `Modern`,
  `Compat`) but I did not confirm it targets Pinocchio's `AccountInfo` rather than
  simply bridging `solana-program` 2.x ↔ 3.x/4.x. **Directly relevant to the
  user's question — worth one focused follow-up.**
- Whether a hand-frozen `Cargo.lock` copied from BOLT's `v0.2.4` tag produces a
  working *external* build. I verified that the lock works **inside** the repo
  (§2, Test 4 — clean compile) but did not reproduce the copy-the-lock-out
  workflow in a standalone crate. High confidence it works; not proven.
- Whether MagicBlock has published a named successor to BOLT. The current
  `docs.magicblock.gg` intro page carries no deprecation notice and no migration
  guidance — it simply documents Ephemeral Rollups and Magic Router with no ECS
  layer at all. The absence of a successor is itself informative.
- Exact CU cost of a *realistic* BOLT system (non-empty components, real logic).
  The only published numbers are for 32-byte no-op components.
- Whether the ER runtime relaxes `MAX_RETURN_DATA`. I found no evidence either
  way and assumed base-layer semantics. Worth confirming before writing off the
  `Bullets` design entirely — if the ER lifts it, item 3 above softens
  considerably.

---

## 14. Recommendation

Three options, in the order I would consider them.

**A. Drop the ECS layer; keep Ephemeral Rollups.** Write plain Anchor programs
against `ephemeral-rollups-sdk 0.17.0` — the part of the stack that is alive,
current, and shipping. You lose the World/Entity/Component scaffolding, which for
a *single fixed game* with a *fixed* set of 20 players and one boss is scaffolding
you do not need. You gain: no 1024-byte cap, no per-component CPI, zero-copy where
you want it, one program instead of sixteen, current Anchor and Solana. Spec §11's
argument for BOLT was "it supplies the scaffolding and the ECS shape matches" —
true, but the scaffolding now costs more than it saves.

**B. Anchor for the game + a Pinocchio program for the hot path.** Same as A, plus
the user's Pinocchio interest satisfied honestly: the Pinocchio program owns its
own accounts (`Bullets` as a zero-copy `Pod` array is *trivial* in Pinocchio and
impossible in BOLT), and the Anchor program handles delegation and settlement. No
CPI auth games, no component ownership fight. This is the design the user is
reaching for, and it becomes *easier* once BOLT is out of the picture.

**C. Stay on BOLT.** Then: pin the whole workspace by git rev, freeze a lockfile,
shrink `Bullets` to 64, split `BossTick` into three systems, move every read-only
component into `#[extra_accounts]`, call `approve_system` on all seven systems,
and accept that no upstream fix is coming. Viable, but every one of those is a
tax, and the spec's build-order step 0 ("a part loses HP on-chain") gets a
multi-day dependency-resolution prologue in front of it.

The spec's §11 reasoning — "making a Pinocchio ER integration a prerequisite puts
a week of CPI reverse-engineering ahead of the first playable frame" — was sound
when BOLT was a maintained shortcut. It is not one any more. Option A or B gets to
the first playable frame faster than C now.

---

## Sources

Every URL below was actually fetched, and every command below was actually run.

### Repository source (read at tag `v0.2.4` via shallow clone, and on `main`)

- https://github.com/magicblock-labs/bolt
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/README.md
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/docs/REPORT.md
- `git clone --depth 1 --branch v0.2.4 https://github.com/magicblock-labs/bolt.git`
  — files read verbatim:
  - `Cargo.toml`, `Cargo.lock`, `Anchor.toml`, `package.json`, `rust-toolchain.toml`, `README.md`, `docs/CHANGELOG.md`
  - `crates/bolt-lang/src/lib.rs`
  - `crates/bolt-lang/attribute/component/src/lib.rs`
  - `crates/bolt-lang/attribute/bolt-program/src/lib.rs`
  - `crates/bolt-lang/attribute/system/src/lib.rs`
  - `crates/bolt-lang/attribute/system-input/src/lib.rs`
  - `crates/bolt-lang/attribute/extra-accounts/src/lib.rs`
  - `crates/bolt-lang/attribute/component-deserialize/src/lib.rs`
  - `crates/bolt-lang/attribute/component-id/src/lib.rs`
  - `crates/bolt-lang/attribute/delegate/src/lib.rs`
  - `crates/bolt-lang/utils/src/lib.rs`
  - `crates/programs/world/src/lib.rs`
  - `crates/programs/bolt-component/src/lib.rs`
  - `crates/programs/bolt-system/src/lib.rs`
  - `crates/bolt-cli/src/lib.rs`, `crates/bolt-cli/Cargo.toml`
  - `crates/bolt-cli/src/templates/workspace/workspace.toml.template`
  - `crates/bolt-cli/src/templates/component/lib.rs.template`
  - `crates/bolt-cli/src/templates/system/lib.rs.template`
  - `clients/typescript/src/index.ts`, `clients/typescript/package.json`
  - `examples/component-position/src/lib.rs`, `examples/component-velocity/src/lib.rs`
  - `examples/system-fly/src/lib.rs`, `examples/system-apply-velocity/src/lib.rs`, `examples/system-simple-movement/src/lib.rs`

### GitHub API (via `gh`)

- `repos/magicblock-labs/bolt` — archived/pushed_at/stars/issues
- `repos/magicblock-labs/bolt/releases` — full release list
- `repos/magicblock-labs/bolt/commits` — commit history on `main`
- `repos/magicblock-labs/bolt/commits/71906078` — the deprecation-banner diff
- `repos/magicblock-labs/bolt/pulls/196` — CPI Authentication using a World PDA
- `repos/magicblock-labs/bolt/pulls/213` — the revert of #196
- `repos/magicblock-labs/bolt/pulls/200` — CU measurement
- `repos/magicblock-labs/bolt/git/trees/main?recursive=1` — file tree

### Registries

- https://crates.io/api/v1/crates/bolt-lang
- https://crates.io/api/v1/crates/bolt-cli
- https://crates.io/api/v1/crates/bolt-attribute-bolt-component
- https://crates.io/api/v1/crates/bolt-attribute-bolt-system
- https://crates.io/api/v1/crates/bolt-attribute-bolt-program
- https://crates.io/api/v1/crates/world
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://registry.npmjs.org/@magicblock-labs%2fbolt-sdk
- https://registry.npmjs.org/@magicblock-labs%2fbolt-cli
- https://registry.npmjs.org/@magicblock-labs%2fephemeral-rollups-sdk

### Ephemeral Rollups SDK 0.17.0

- https://static.crates.io/crates/ephemeral-rollups-sdk/ephemeral-rollups-sdk-0.17.0.crate
  (downloaded and read: `src/lib.rs`, `src/cpi.rs`, `src/crank.rs`, `src/ephem/mod.rs`, `Cargo.toml`)
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/index.html
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/all.html
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/ephem/index.html
- https://docs.rs/ephemeral-rollups-sdk/0.17.0/ephemeral_rollups_sdk/cpi/struct.DelegateConfig.html

### Solana SDK source (for the hard limits)

- https://raw.githubusercontent.com/anza-xyz/solana-sdk/master/cpi/src/lib.rs — `MAX_RETURN_DATA = 1024`
- https://raw.githubusercontent.com/anza-xyz/solana-sdk/master/program/src/program.rs — re-export of `MAX_RETURN_DATA`
- https://raw.githubusercontent.com/anza-xyz/solana-sdk/master/account-info/src/lib.rs — `MAX_PERMITTED_DATA_INCREASE = 1_024 * 10`
- https://raw.githubusercontent.com/anza-xyz/solana-sdk/master/system-interface/src/lib.rs — `MAX_PERMITTED_DATA_LENGTH = 10 * 1024 * 1024`
- https://raw.githubusercontent.com/anza-xyz/solana-sdk/master/instructions-sysvar/src/lib.rs — `get_instruction_relative`

### Docs sites

- https://book.boltengine.gg/ — the Bolt Book (self-describes as "Bolt v0.1.0"; stale)
- https://docs.magicblock.gg/pages/tools/bolt/introduction — no deprecation notice, no ECS content

### Builds run locally on 2026-08-31

- `cargo generate-lockfile` + `cargo check` with `bolt-lang = "0.2.4"` → **fail**
- `cargo check` with `bolt-lang`/`ephemeral-rollups-sdk`/`anchor-lang`/`session-keys` pinned → **fail**
- `cargo check` with the above plus `solana-program = "=2.1.0"` → **fail**
- `cargo check -p position -p system-apply-velocity` inside the cloned repo at
  tag `v0.2.4`, using its committed `Cargo.lock` → **succeeds** (warnings only)
