# MagicBlock VRF on Ephemeral Rollups — research for HEARTROT

Research date: **2026-08-31**. Target: **Solana devnet**.
Scope: verifiable randomness for rolling each new boss incarnation's ruleset/affixes.

Everything below was read from primary sources (crate registry, repo source, validator
source, live status API) on the date above. Where I could not verify something I say so
and mark it explicitly. The `## Sources` section at the bottom lists every URL fetched.

---

## 0. TL;DR — the five things that actually matter

1. **The versions in our local `magicblock` skill are badly stale.** The skill says
   `ephemeral-vrf-sdk = "0.3.0"`. The real current crate is **0.17.0** (published
   2026-08-26, five days ago). The whole SDK is now a **version-aligned monorepo** —
   `ephemeral-rollups-sdk`, `ephemeral-vrf-sdk` and `ephemeral-rollups-pinocchio` all
   ship as 0.17.0 from one repo.
2. **VRF inside an Ephemeral Rollup is free.** The VRF program explicitly exempts
   `DEFAULT_EPHEMERAL_QUEUE` from the per-request fee. Base-layer requests cost
   **500,000 lamports** (regular) or **800,000 lamports** (high priority). We should
   never touch the base-layer queue.
3. **A crank cannot request VRF directly.** The validator rejects any scheduled
   instruction containing a signer other than a read-only `crank_signer_pda`. The VRF
   request instruction requires `payer` as a **writable signer**. This contradicts the
   design assumption that the crank owns all boss-side logic. Fix is easy — see §7.
4. **The global `VRF_PROGRAM_IDENTITY` is deprecated.** New integrations must validate a
   **scoped, per-callback-program identity PDA**. Using the old constant leaves the
   callback authenticated against an identity shared with every other VRF consumer.
5. **The official docs quickstart and the official reference program do not compile
   against the published 0.17.0 crate.** They call
   `create_request_scoped_randomness_ix`, which does not exist in 0.17.0. See §3.1 — this
   will burn a day if nobody warns you.

---

## 1. What MagicBlock VRF is

A request/callback oracle randomness primitive, shipped as a standalone Solana program
plus an integration SDK.

- Randomness is a VRF over **Curve25519's Ristretto group**, proven with a Schnorr-like
  signature per **RFC 9381**. Key derivation is HKDF, hashing is SHA-512.
- Flow: your program CPIs `RequestRandomness` into the VRF program → the request lands in
  an **oracle queue account** → an off-chain oracle picks it up, computes the VRF output
  and proof → oracle submits `ProvideRandomness` → the VRF program **verifies the proof
  on-chain** → the VRF program `invoke_signed`s **your callback instruction**, passing the
  32 random bytes as instruction data, signed by a VRF identity PDA.
- The security property you get: reaching your callback body proves the VRF identity PDA
  signed, and the proof verified on-chain. You do not verify anything yourself; you just
  check the signer.
- Audited: *2025-08-06 VRF Program Audit Report by Zenith*, in `security_audits/` of the
  program repo.

**Repo rename to know about:** `magicblock-labs/ephemeral-vrf` now redirects to
**`magicblock-labs/solana-vrf`** (confirmed via the GitHub API: repo id 947207447,
`full_name: magicblock-labs/solana-vrf`, not archived, last pushed 2026-08-31). Our skill
still links the old name. The SDK crates moved separately, into
`magicblock-labs/ephemeral-rollups-sdk`.

---

## 2. Exact pinned versions (verified 2026-08-31)

### Crates — all version-aligned at 0.17.0

| Crate | Version | Published | Source repo |
|---|---|---|---|
| `ephemeral-vrf-sdk` | **0.17.0** | 2026-08-26 | `magicblock-labs/ephemeral-rollups-sdk` |
| `ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | same |
| `ephemeral-rollups-pinocchio` | **0.17.0** | 2026-08-26 | same |

The monorepo has a `version_align.sh` at its root and a single workspace version, which is
why these move in lockstep. Prior `ephemeral-vrf-sdk` releases were on a separate
numbering line (0.4.1 on 2026-06-12, then it jumped straight to 0.17.0 when it was
absorbed into the monorepo). **Do not read the version jump 0.4.1 → 0.17.0 as 13 major
releases of churn — it is a renumbering.**

### npm

| Package | Version |
|---|---|
| `@magicblock-labs/ephemeral-rollups-sdk` | **0.17.0** |

Its declared deps: `@solana/web3.js ^1.98.0`, `@noble/curves ^1.4.2`, `@noble/hashes
^1.4.0`, `bs58 ^6.0.0`, `tweetnacl ^1.0.3`, `rpc-websockets ^9.0.4`, `@phala/dcap-qvl
^0.3.9`. Note it is still **web3.js v1**, not Kit — relevant to our Next.js frontend.

### Toolchain (from the current engine example README, 2026-08-31)

| Software | Version |
|---|---|
| Solana | 3.1.9 |
| Rust | 1.89.0 |
| Anchor | 1.0.2 |
| Node | 24.10.0 |

```sh
agave-install init 3.1.9
rustup install 1.89.0
avm use 1.0.2
```

### Program IDs and queue addresses (read from `vrf-sdk/src/consts.rs` @ main)

| Constant | Address |
|---|---|
| `VRF_PROGRAM_ID` | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
| `DEFAULT_QUEUE` (base layer, mainnet+devnet) | `Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh` |
| `DEFAULT_EPHEMERAL_QUEUE` (in-ER, mainnet+devnet) | `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc` |
| `DEFAULT_TEST_QUEUE` (localnet base) | `GKE6d7iv8kCBrsxr78W3xVdjGLLLJnxsGiuzrsZCGEvb` |
| `DEFAULT_EPHEMERAL_TEST_QUEUE` (localnet ER) | `Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT` |
| `VRF_PROGRAM_IDENTITY` — **DEPRECATED** | `9irBy75QS2BN81FUgXuHcjqceJJRuc9oDkAe8TKVvvAw` |

Devnet and mainnet share queue addresses; only the cluster differs.

### Dependency block to actually use

The current docs recommend the **unified SDK** rather than the standalone VRF crate. I
confirmed `ephemeral_rollups_sdk::vrf` is a straight re-export (`rust/sdk/src/vrf.rs` is
literally `pub use ephemeral_vrf_sdk::*;`) and that the `vrf` feature gates both the
module and the `vrf`/`vrf_callback` macros:

```toml
[dependencies]
anchor-lang = { version = "1.0.2", features = ["init-if-needed"] }
ephemeral-rollups-sdk = { version = "0.17.0", features = ["anchor", "vrf"] }
```

Feature notes read from `rust/sdk/Cargo.toml`:
- `anchor` → Anchor 1.0.x. `anchor-compat` → Anchor >=0.28, <1.0 (implies `backward-compat`).
- `anchor-modern` and `anchor-compat` are mutually exclusive — there is a `compile_error!`
  guard for this, and another forbidding `anchor-modern` + `backward-compat`.
- `vrf = ["dep:ephemeral-vrf-sdk", "ephemeral-vrf-sdk-vrf-macro/ephemeral-rollups-sdk"]`.
  That second flag is what makes the macro emit `::ephemeral_rollups_sdk::vrf` paths
  instead of `::ephemeral_vrf_sdk`. **If you add the standalone `ephemeral-vrf-sdk` crate
  alongside the unified one, the macro-generated paths and your import paths can
  disagree.** Pick one. Use the unified crate.

---

## 3. The API, verbatim

### 3.1 The naming trap — read this before writing a line of code

`ephemeral-vrf-sdk` **0.17.0** exports exactly four request builders
(confirmed against docs.rs for 0.17.0 *and* against `main`):

```rust
/// Requests randomness using the scoped (per-callback-program) VRF identity, regular priority.
pub fn create_request_randomness_ix(params: RequestRandomnessParams) -> compat::Instruction {
    let mut ix = build_request_ix(params);
    ix.data[0] = 10;
    ix
}

/// Scoped (per-callback identity) randomness request, high priority.
pub fn create_request_high_priority_scoped_randomness_ix(
    params: RequestRandomnessParams,
) -> compat::Instruction {
    let mut ix = build_request_ix(params);
    ix.data[0] = 11;
    ix
}

#[deprecated(note = "Legacy global-identity request (high priority). Use create_request_randomness_ix (scoped, regular) or create_request_high_priority_scoped_randomness_ix.")]
pub fn create_request_legacy_randomness_ix(params: RequestRandomnessParams) -> compat::Instruction

#[deprecated(note = "Legacy global-identity request (regular priority). Use create_request_randomness_ix (scoped, regular).")]
pub fn create_request_regular_randomness_ix(params: RequestRandomnessParams) -> compat::Instruction
```

There is **no `create_request_scoped_randomness_ix` in 0.17.0.**

But the official docs quickstart tells you to write:

```rust
use ephemeral_rollups_sdk::vrf::instructions::{create_request_scoped_randomness_ix, RequestRandomnessParams};
```

…and the official minimal reference program (`solana-vrf`'s `use-randomness` integration
test) does the same. That program's `Cargo.toml` explains why:

```toml
anchor-lang = "=0.31.1"
ephemeral-rollups-sdk = { git = "https://github.com/magicblock-labs/ephemeral-rollups-sdk", rev = "60761a7f76b3b417496d4a5fcca8412e35d44f5b", features = [
    "anchor-compat",
] }
```

It pins a **git rev**, not the published crate. At that rev the scoped builder was named
`create_request_scoped_randomness_ix` and `create_request_randomness_ix` was the *legacy*
one. By 0.17.0 they renamed the scoped builder to `create_request_randomness_ix` and
renamed the legacy one to `create_request_legacy_randomness_ix`.

**Consequence, and it is nasty: the meaning of `create_request_randomness_ix` inverted
between those two versions.** On the old rev it gives you legacy global identity; on
0.17.0 it gives you scoped identity. Copying the docs quickstart against a 0.17.0
dependency fails to compile (good). Copying an old blog/example that calls
`create_request_randomness_ix` against 0.17.0 **compiles fine and silently changes your
security model** (bad). Pin 0.17.0 and use `create_request_randomness_ix`.

### 3.2 Request params

```rust
#[derive(Default)]
pub struct RequestRandomnessParams {
    pub payer: Pubkey,
    pub oracle_queue: Pubkey,
    pub callback_program_id: Pubkey,
    pub callback_discriminator: Vec<u8>,
    pub accounts_metas: Option<Vec<SerializableAccountMeta>>,
    pub caller_seed: [u8; 32],
    pub callback_args: Option<Vec<u8>>,
}
```

`callback_args` is newer than our skill's snapshot — arbitrary bytes appended to the
callback instruction data **after** the 32 randomness bytes. Useful for us: it lets the
callback know *which* incarnation this roll was for, without extra accounts.

The instruction built by `build_request_ix` has this fixed account list:

```rust
accounts: vec![
    compat::latest::AccountMeta::new(payer, true),                                   // 0 writable signer
    compat::latest::AccountMeta::new_readonly(program_identity, true),               // 1 readonly signer
    compat::latest::AccountMeta::new(oracle_queue, false),                           // 2 writable
    compat::latest::AccountMeta::new_readonly(compat::latest::system_program::ID, false), // 3
    compat::latest::AccountMeta::new_readonly(compat::latest::slot_hashes::ID, false),    // 4
],
```

where `program_identity = find_program_address(&[consts::IDENTITY], &callback_program_id).0`.

### 3.3 Two different "identity" PDAs — do not confuse them

This is the single most confusing part of the API. There are two PDAs both seeded
`"identity"`, and they are unrelated:

| | Seeds | Program | Who signs it | Role |
|---|---|---|---|---|
| **Requester identity** | `["identity"]` | **your** program | your program, via `invoke_signed` | proves the request came from the program that owns the callback |
| **Scoped VRF identity** | `["identity", callback_program_id]` | **VRF** program | the VRF program, on fulfillment | proves the callback came from VRF, bound to your program |

```rust
/// Seed of the identity PDA
pub const IDENTITY: &[u8] = b"identity";

/// Scoped, per-callback-program VRF identity PDA: `PDA([IDENTITY, callback_program_id], vrf)`.
pub fn scoped_vrf_identity(callback_program_id: &Pubkey) -> Pubkey {
    use crate::compat::{Compat, Modern};
    crate::compat::latest::Pubkey::find_program_address(
        &[IDENTITY, callback_program_id.modern().as_ref()],
        &VRF_PROGRAM_ID.modern(),
    )
    .0
    .compat()
}
```

The legacy global `VRF_PROGRAM_IDENTITY` is a single PDA shared by *every* VRF consumer on
the network. Its doc comment in `consts.rs`:

> `/// VRF program identity PDA (legacy, global). Deprecated: new integrations should validate [scoped_vrf_identity] instead (the default).`

**Use scoped.** HEARTROT gets its own identity bound to our program id.

### 3.4 The `#[vrf]` macro — what it actually injects

Read from `rust/vrf-macro/src/lib.rs`. It rewrites your `#[derive(Accounts)]` struct,
appending any of these fields you did not declare yourself:

```rust
/// CHECK: Used to verify the identity of the program
#[account(seeds = [b"identity"], bump)]
pub program_identity: UncheckedAccount<'info>,

pub vrf_program: Program<'info, VrfProgram>,

/// CHECK: Slot hashes sysvar
#[account(address = slot_hashes::ID)]
pub slot_hashes: UncheckedAccount<'info>,

pub system_program: Program<'info, System>,
```

It requires you to declare `oracle_queue` yourself (its address is your choice, so the
macro cannot inject it) and emits a clear compile error if you forget:

> ``"`#[vrf]` requires an `oracle_queue` account field, used by `invoke_signed_vrf`"``

It then generates the helper:

```rust
impl<'info> #struct_name<'info> {
    fn invoke_signed_vrf<'a>(&self, payer: &'a AccountInfo<'info>, ix: &Instruction) -> ProgramResult {
        let bump = Pubkey::try_find_program_address(&[IDENTITY], &crate::ID).ok_or(ProgramError::InvalidSeeds)?;
        // `#[vrf]` issues scoped randomness requests by default: the fulfillment signs
        // the callback with the per-program scoped identity PDA, which the callback
        // validates (see `#[vrf_callback]`). Map any legacy request discriminator to its
        // scoped equivalent (3/11 -> 11 high priority, else -> 10).
        let mut ix = ix.clone();
        if let Some(disc) = ix.data.first_mut() {
            *disc = if *disc == 3 || *disc == 11 { 11 } else { 10 };
        }
        invoke_signed(
            &ix,
            &[
                payer.clone(),
                self.program_identity.to_account_info(),
                self.oracle_queue.to_account_info(),
                self.system_program.to_account_info(),
                self.slot_hashes.to_account_info(),
            ],
            &[&[IDENTITY, &[bump.1]]],
        )
    }
}
```

Two things worth noting. **The macro force-rewrites the discriminator to a scoped
variant** — so if you go through `invoke_signed_vrf`, you cannot accidentally issue a
legacy request even if you called a deprecated builder. And it signs *only* the requester
identity PDA — `payer` is passed through as a plain `AccountInfo` and must already be a
signer from somewhere. That second fact is what breaks the crank path (§7).

### 3.5 The `#[vrf_callback]` macro

New since our skill snapshot. Placed **above** `#[derive(Accounts)]`, it prepends:

```rust
/// Scoped VRF identity PDA, bound to this program. Its presence as a signer proves
/// the callback was issued by the VRF program for this program.
#[account(address = scoped_vrf_identity(&crate::ID))]
pub vrf_program_identity: Signer<'info>,
```

The docs are blunt about what happens if you skip it:

> The `#[vrf_callback]` attribute "enforces that only the VRF program (via CPI) can invoke
> the callback — omitting it leaves the callback spoofable by any caller."

For HEARTROT this is the whole ballgame. A spoofable `consume_incarnation_roll` means any
player can pick the affixes for the next boss. Use the macro.

### 3.6 Randomness helpers

From `vrf-sdk/src/rnd.rs`. All take `&[u8; 32]`:

| Fn | Behaviour |
|---|---|
| `random_u8(bytes)` | `bytes[30]` |
| `random_u8_with_range(bytes, min, max)` | **rejection-sampled, inclusive range**, unbiased |
| `random_u32(bytes)` | LE from `bytes[28..32]` |
| `random_i32`, `random_i64` | casts of the u32/u64 |
| `random_u64(bytes)` | LE from bytes 0,4,8,12,16,20,24,28 |
| `random_bool(bytes)` | `bytes[31] % 2 == 0` |

`random_u8_with_range` is the only one that avoids modulo bias — it scans bytes in reverse
for one below `256 / range * range`, falling back to a slightly-biased `bytes[31] % range`
only if all 32 bytes miss (astronomically rare). It asserts `min <= max`; **an `assert!`
in a Solana program is a panic, so validate your range bounds before calling it.**

Note that these helpers all read *fixed byte offsets* and heavily overlap
(`random_u8` = `bytes[30]`, `random_u32` covers `bytes[28..32]`, `random_bool` =
`bytes[31]`). **If you call several of them on the same seed you get correlated values,
not independent draws.** The `rewards-delegated-vrf` example is aware of this and rotates
the buffer before the second draw:

```rust
// Use a different slice of randomness to pick which mint
// to send — avoids correlation with the reward selection.
let mut rnd_bytes = [0u8; 32];
rnd_bytes.copy_from_slice(&randomness);
rnd_bytes.rotate_left(4);
let rnd_mint = ephemeral_vrf_sdk::rnd::random_u32(&rnd_bytes);
```

For HEARTROT rolling several affixes off one seed, do the same, or better — hash-expand
(see §8.2).

---

## 4. Does it work inside an Ephemeral Rollup? Yes, and that is the cheap path

Confirmed three ways.

**1. The docs say so explicitly:**

> "Because the request and consume steps occur inside the ephemeral execution window,
> users get real-time results with verifiable fairness."

**2. There is a dedicated delegated queue.** `DEFAULT_EPHEMERAL_QUEUE` is itself an account
that has been delegated to the ER. The rule is symmetric: request from the queue that
matches where your transaction runs. Base-layer tx → `DEFAULT_QUEUE`. In-ER tx →
`DEFAULT_EPHEMERAL_QUEUE`. Getting this wrong means writing to an account the runtime you
are on does not own, and the transaction fails.

**3. The fee code exempts it.** From `program/src/fees.rs`:

```rust
/// Whether `queue` is exempt from the per-request fee (and the matching oracle payout).
/// `DEFAULT_EPHEMERAL_QUEUE` is always exempt; the local test queue only with the
/// `ephemeral-test-queue` feature, so production builds never exempt it.
pub fn is_fee_exempt_ephemeral_queue(queue: &Pubkey) -> bool {
    if queue == &DEFAULT_EPHEMERAL_QUEUE {
        return true;
    }
    #[cfg(feature = "ephemeral-test-queue")]
    if queue == &DEFAULT_EPHEMERAL_TEST_QUEUE {
        return true;
    }
    false
}
```

and the call site in `request_randomness.rs`:

```rust
// Transfer request cost to the queue PDA (unless this is a fee-exempt ephemeral queue)
if !crate::fees::is_fee_exempt_ephemeral_queue(oracle_queue_info.key) {
    let cost = if high_priority {
        VRF_HIGH_PRIORITY_LAMPORTS_COST
    } else {
        VRF_LAMPORTS_COST
    };
    invoke(
        &system_instruction::transfer(signer_info.key, oracle_queue_info.key, cost),
        &[
            signer_info.clone(),
            oracle_queue_info.clone(),
            system_program_info.clone(),
        ],
    )?;
}
```

### Cost

```rust
pub const VRF_HIGH_PRIORITY_LAMPORTS_COST: u64 = 800000;
pub const VRF_LAMPORTS_COST: u64 = 500000;
```

| Path | Cost per request |
|---|---|
| In-ER via `DEFAULT_EPHEMERAL_QUEUE` | **0 lamports** (fee-exempt) |
| Base layer, regular | 500,000 lamports = **0.0005 SOL** |
| Base layer, high priority | 800,000 lamports = **0.0008 SOL** |

At 0.0005 SOL a roll, even the base-layer path would be affordable for a once-per-incarnation
roll — but there is no reason to pay it. **HEARTROT requests in-ER, and pays nothing.**

This matters for the treasury model in the design spec: the session wallet funding tier
does not need a VRF budget line at all.

### Latency

From the current docs quickstart page:

> Base-layer VRF callback "can take up to 10s" with typical response of "1-5s." Delegated
> VRF dApp advertises "within 100 ms onchain" execution.

There is also a **hard floor enforced on-chain**. From `provide_randomness.rs`:

```rust
// Ensure that fulfillment happens in a different (later) slot than the request
if Clock::get()?.slot <= item.slot {
    return Err(ProgramError::from(
        EphemeralVrfError::OracleMustProvideInDifferentSlot,
    ));
}
```

So fulfilment is **never same-slot**. Minimum one ER slot. Our crank ticks at 400ms, ER
slots are ~10-50ms, so a ~100ms fulfilment is roughly a quarter of one boss tick. Fine for
an incarnation roll; see §8 for why it is nowhere near fine for per-tick randomness.

### Devnet availability — live-checked today

`https://status.magicblock.app/api/services` publishes a `vrf_oracle` service per region.
Queried 2026-08-31:

| Network | Region | FQDN | `vrf_oracle` | `er` |
|---|---|---|---|---|
| devnet | asia | `devnet-as.magicblock.app` | Operational | Operational |
| devnet | europe | `devnet-eu.magicblock.app` | Operational | Operational |
| devnet | usa | `devnet-us.magicblock.app` | Operational | Operational |
| devnet | tee | `devnet-tee-as.magicblock.app` | Operational | Operational |

Downtime over the published 10-day window (2026-08-22 → 2026-08-31, minutes/day, UTC):

- `vrf_oracle`: **0 minutes on every devnet region.**
- `er`: 10 minutes total, all on `devnet-as` on 2026-08-30.

So on devnet today VRF is *more* reliable than the ER itself. Re-check before launch:

```bash
curl -sS https://status.magicblock.app/api/services \
  | jq '.environments.devnet.regions | to_entries[] | {region: .key, servers: (.value.servers | to_entries[] | {fqdn: .key, vrf: .value.live_status.vrf_oracle})}'
```

---

## 5. Working code pattern for HEARTROT

Adapted to our entities, on **0.17.0** naming. This is the shape I would write; it
combines the verified 0.17.0 API surface with the delegated-queue pattern from the
`rewards-delegated-vrf` example.

```rust
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{vrf, vrf_callback};
use ephemeral_rollups_sdk::vrf::consts::DEFAULT_EPHEMERAL_QUEUE;
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::rnd::random_u32;

/// Called from the player transaction that lands the killing blow on the boss core.
/// Flips the arena into Phase::Rolling and asks the VRF oracle for one seed.
pub fn request_incarnation_roll(ctx: Context<RequestIncarnationRoll>, client_seed: u8) -> Result<()> {
    let arena = &mut ctx.accounts.arena_state;
    require!(arena.phase == Phase::CoreDead, HeartrotError::WrongPhase);

    arena.phase = Phase::Rolling;
    arena.roll_requested_tick = arena.tick;

    let ix = create_request_randomness_ix(RequestRandomnessParams {
        payer: ctx.accounts.payer.key(),
        oracle_queue: ctx.accounts.oracle_queue.key(),
        callback_program_id: crate::ID,
        callback_discriminator: crate::instruction::ConsumeIncarnationRoll::DISCRIMINATOR.to_vec(),
        caller_seed: [client_seed; 32],
        // The callback needs to write ArenaState and Boss. Order here is the order
        // they arrive as remaining_accounts / declared fields in the callback ctx.
        accounts_metas: Some(vec![
            SerializableAccountMeta {
                pubkey: ctx.accounts.arena_state.key(),
                is_signer: false,
                is_writable: true,
            },
            SerializableAccountMeta {
                pubkey: ctx.accounts.boss.key(),
                is_signer: false,
                is_writable: true,
            },
        ]),
        // Bind this roll to the incarnation it was requested for, so a late
        // callback for a stale incarnation can be detected and dropped.
        callback_args: Some(arena.incarnation.to_le_bytes().to_vec()),
        ..Default::default()
    });

    ctx.accounts
        .invoke_signed_vrf(&ctx.accounts.payer.to_account_info(), &ix)?;
    Ok(())
}

#[vrf]
#[derive(Accounts)]
pub struct RequestIncarnationRoll<'info> {
    /// The browser session keypair. Already a signer of this gameplay tx —
    /// no wallet popup, per the onboarding requirement.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub arena_state: Account<'info, ArenaState>,
    #[account(mut)]
    pub boss: Account<'info, Boss>,
    /// CHECK: address-constrained to the delegated (in-ER) queue
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

/// VRF fulfilment lands here. `#[vrf_callback]` injects the scoped-identity signer check.
pub fn consume_incarnation_roll(
    ctx: Context<ConsumeIncarnationRoll>,
    randomness: [u8; 32],
    for_incarnation: u32,
) -> Result<()> {
    let arena = &mut ctx.accounts.arena_state;

    // Drop stale/duplicate fulfilments instead of erroring — erroring here would
    // fail the oracle's whole tx and make it retry forever (see §6.2).
    if arena.phase != Phase::Rolling || arena.incarnation != for_incarnation {
        msg!("stale VRF roll for incarnation {}, ignoring", for_incarnation);
        return Ok(());
    }

    let affixes = affix_set_from_seed(&randomness);
    ctx.accounts.boss.apply_affixes(affixes);
    arena.affix_seed = randomness;      // keep the seed: it is the audit trail
    arena.incarnation = arena.incarnation.saturating_add(1);
    arena.phase = Phase::Fighting;

    msg!("incarnation {} rolled affixes {:?}", arena.incarnation, affixes);
    Ok(())
}

#[vrf_callback]
#[derive(Accounts)]
pub struct ConsumeIncarnationRoll<'info> {
    #[account(mut)]
    pub arena_state: Account<'info, ArenaState>,
    #[account(mut)]
    pub boss: Account<'info, Boss>,
}
```

`#[vrf_callback]` prepends `vrf_program_identity: Signer<'info>` constrained to
`scoped_vrf_identity(&crate::ID)`, so the struct above really has three accounts.

### Verbatim reference: the in-ER request from `rewards-delegated-vrf`

This is the official example that runs VRF against a **delegated** account, which is our
exact situation. Its request context (note the `DEFAULT_EPHEMERAL_QUEUE` address
constraint and the delegation-record account):

```rust
#[vrf]
#[derive(Accounts)]
pub struct RequestRandomReward<'info> {
    /// CHECK: User/destination
    pub user: UncheckedAccount<'info>,
    #[account(constraint = admin.key() == reward_distributor.super_admin || reward_distributor.admins.contains(&admin.key()) || reward_distributor.whitelist.contains(&admin.key()))]
    pub admin: Signer<'info>,
    pub reward_distributor: Account<'info, state::RewardDistributor>,
    pub reward_list: Account<'info, state::RewardsList>,
    #[account(seeds = [constants::TRANSFER_LOOKUP_TABLE_SEED], bump)]
    pub transfer_lookup_table: Account<'info, state::TransferLookupTable>,
    /// CHECK: Validated by address constraint against the known VRF oracle queue
    #[account(mut, address = ephemeral_vrf_sdk::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
    /// CHECK: Delegation record for reward_list — authority field contains the validator, used to derive magic_fee_vault for the callback
    #[account(address = ephemeral_rollups_sdk::pda::delegation_record_pda_from_delegated_account(&reward_list.key()))]
    pub delegation_record_reward_list: UncheckedAccount<'info>,
}
```

That example is pinned to `ephemeral-vrf-sdk = "0.3.0"` / `ephemeral-rollups-sdk = "0.16.2"`
and still uses the deprecated global identity in its callback
(`#[account(address = ephemeral_vrf_sdk::consts::VRF_PROGRAM_IDENTITY)]`). **Treat it as a
structural reference, not a version reference.**

### The callback can chain a Magic Action — this is important for us

The design spec says settlement is "a Magic Action chains the base-layer commit +
leaderboard write". The `rewards-delegated-vrf` example proves a **VRF callback can itself
schedule base-layer work**: its callback context is declared `#[commit]`, it receives
`magic_context` and `magic_program`, and it calls `schedule_transfer_action(...)` which
CPIs the Magic program.

To make that work it has to pass the fee vault *through the VRF request*, since the
callback's account list is fixed at request time. The example derives it by reading the
validator out of the delegation record:

```rust
// DelegationRecord layout: [8 discriminator][32 authority (validator)][...]
// Read validator pubkey directly from raw bytes to avoid importing the struct.
let delegation_record_data = ctx.accounts.delegation_record_reward_list.try_borrow_data()?;
require!(
    delegation_record_data.len() >= 40,
    crate::errors::RewardError::InvalidDelegationRecord
);
let validator = Pubkey::try_from(&delegation_record_data[8..40])
    .map_err(|_| error!(crate::errors::RewardError::InvalidDelegationRecord))?;
drop(delegation_record_data);
// Seeds: ["magic-fee-vault", validator] under the delegation program
let (magic_fee_vault, _) = Pubkey::find_program_address(
    &[b"magic-fee-vault", validator.as_ref()],
    &ephemeral_rollups_sdk::id(),
);
```

and then includes `magic_fee_vault`, `MAGIC_PROGRAM_ID` and `MAGIC_CONTEXT_ID` in
`accounts_metas`. If HEARTROT ever wants the incarnation roll to *also* trigger the
base-layer leaderboard commit in one shot, this is the pattern — copy it exactly.

---

## 6. Gotchas and failure modes

### 6.1 Hard limits, from the VRF program source

| Limit | Value | Where enforced |
|---|---|---|
| `callback_discriminator` length | **≤ 8 bytes** | `request_randomness.rs`, else `ArgumentSizeTooLarge` |
| `callback_accounts_metas` count | **≤ 25** (`MAX_CALLBACK_ACCOUNTS`) | `api/src/state/queue.rs` |
| `callback_args` length | **≤ 512 bytes** | `api/src/state/queue.rs` |
| Request TTL | **240 slots** (`QUEUE_TTL_SLOTS`, ~2 min at 500ms base slots) | `api/src/consts.rs` |
| Fulfilment slot | must be **strictly later** than request slot | `provide_randomness.rs` |

Anchor discriminators are exactly 8 bytes, so we are at the cap, not over it. The 25-account
cap is comfortable for us (we need ArenaState + Boss + identity), but note it is the ceiling
if we ever want the callback to touch all 20 Player entities — **it cannot.** Design the
callback to touch the Arena and Boss only.

### 6.2 A panicking callback is a retry loop, not a dropped roll

In `provide_randomness.rs` the callback is invoked with `?`:

```rust
solana_program::program::invoke_signed(&ix, &all_accounts, pda_signer_seeds)?;
```

If your callback returns an error, the entire `ProvideRandomness` transaction fails and
reverts — **including the queue removal**. The request stays in the queue and the oracle
will keep retrying until the 240-slot TTL expires and `purge_expired_requests` clears it.

Practical rule for HEARTROT: **the callback must be total.** Never `require!` on game
state inside it. Handle stale/duplicate/unexpected state by logging and `Ok(())`, exactly
as in the §5 pattern. A `require!` on `phase == Rolling` would mean that if a player
transaction changed the phase in between, the oracle burns two minutes of retries and the
incarnation never rolls.

Also relevant: `random_u8_with_range` **asserts** `min <= max`. A panic is an error is a
retry loop. Bound-check before you call it.

### 6.3 Executable-account allow-list (legacy path only)

`provide_randomness.rs` defines `ALLOWED_EXECUTABLE_CALLBACK_ACCOUNTS: [Pubkey; 8]` and
rejects callbacks whose remaining accounts include an executable not on that list —
`InvalidCallbackAccounts`. Reading the match arms, this check runs **only on the legacy
global-identity path**; the scoped path skips it (the scoped identity is already bound to
one callback program, so the attack it defends against does not apply). One more reason to
use scoped: fewer surprise restrictions on what you can pass. If you nonetheless need to
pass a program account to the callback on the legacy path, expect this error.

### 6.4 Devnet and mainnet share queue addresses

`DEFAULT_QUEUE` / `DEFAULT_EPHEMERAL_QUEUE` are identical on devnet and mainnet — only the
cluster differs. There is **no compile-time signal** that you pointed a devnet build at the
right cluster. Localnet is the only one with distinct constants
(`DEFAULT_TEST_QUEUE` / `DEFAULT_EPHEMERAL_TEST_QUEUE`), and the local validator clones
those from devnet.

### 6.5 The randomness helpers overlap

Covered in §3.6. `random_u8` / `random_u32` / `random_bool` all read from `bytes[28..32]`.
Do not treat successive calls as independent rolls.

### 6.6 Don't mix the two SDK crates

Adding both `ephemeral-rollups-sdk` (with `vrf`) and standalone `ephemeral-vrf-sdk` means
the `vrf`/`vrf_callback` macros emit paths through whichever the `ephemeral-rollups-sdk`
feature flag on the macro crate selected, while your `use` statements may name the other.
Pick the unified crate and use `ephemeral_rollups_sdk::vrf::*` exclusively.

---

## 7. Can a crank request VRF? — **No, not directly.** This contradicts the design.

The design spec says the boss is ticked by a MagicBlock crank at ~400ms and there is
deliberately no server game loop. The natural reading is that the crank also rolls the new
incarnation. **It cannot, as written.** Here is the proof from the validator source.

### 7.1 Cranks allow exactly one signer, and it is read-only

`programs/magicblock/src/schedule_task/mod.rs`:

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
        // ... privileged MagicBlock instructions also rejected ...
    }
    Ok(())
}
```

with

```rust
pub const CRANK_SEED: &[u8] = b"crank-executor";
pub fn crank_signer_pda(authority: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[CRANK_SEED, authority.as_ref()],
        &crate::CRANK_PROGRAM_ID,
    )
    .0
}
```

`authority` is the payer that scheduled the task. This is validated **twice** — once at
schedule time (`process_schedule_task.rs`) and again at execution time
(`process_execute_task.rs`, with the comment *"This check prevents the validator from
manually sending transactions disguised as cranks."*). Execution then does:

```rust
for ix in instructions {
    invoke_context.native_invoke(ix, &[crank_signer])?;
}
```

So the crank signer PDA is the only signature a crank instruction ever gets, and it is
forbidden from being writable.

### 7.2 Why that blocks VRF

The VRF request needs `AccountMeta::new(payer, true)` — a **writable signer**. The crank
signer PDA is forcibly **read-only**, and a CPI cannot escalate a read-only account to
writable. So the crank signer cannot be the VRF payer.

### 7.3 The fix — and it is the boring one

**Request the roll from the player transaction that lands the killing blow on the core.**

That transaction already has a real signer: the browser session keypair, which per the
design spec signs all gameplay transactions and produces zero wallet popups. It costs us
nothing, adds no infrastructure, and removes the crank from the critical path entirely.
The crank keeps doing what it is good at — advancing the 128-bullet pool and the tick
counter — and simply observes `phase == Rolling` and holds the boss inert until the
callback flips it back to `Fighting`.

This also happens to be more robust: if the killing-blow transaction's VRF request fails,
the player sees it immediately and can retry, rather than the failure being buried in a
crank the client cannot observe.

### 7.4 The workaround, if you insist the crank must own it

*Marked low confidence — reasoned from source, not empirically tested.*

Nothing stops the crank from invoking a HEARTROT instruction whose account list contains a
**writable, non-signer PDA of our own program**, which our program then signs for via
`invoke_signed` at CPI time. That satisfies `validate_cranks_instructions` (not a signer at
the top level) and satisfies the VRF program (a signer by the time the CPI lands). Because
the ephemeral queue is fee-exempt, no lamports move, so the payer PDA does not need funding
or system ownership.

Two catches: the `#[vrf]` macro's `invoke_signed_vrf` signs **only** `[IDENTITY, bump]`, so
you would have to hand-roll `invoke_signed` with both seed sets; and I have not verified
that the VRF program is happy with a non-system-owned payer when the transfer is skipped.
Test it before betting on it. **Recommendation: take §7.3 instead.** This is a lot of
machinery to avoid one signer we already have.

### 7.5 Other crank facts our skill has wrong

While verifying the above I found the skill's `cranks.md` is stale in ways that will bite:

- **The manual `bincode::serialize(&MagicBlockInstruction::ScheduleTask(...))` pattern is
  obsolete.** The SDK now ships `ephemeral_rollups_sdk::crank::{ScheduleCrankCpi,
  CancelCrankCpi}`. From the current `crank-counter` example:

  ```rust
  use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};

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
  ```

- **`task_id`, `execution_interval_millis` and `iterations` are `i64`, not `u64`.** The
  skill says `u64`. There is also a `CancelCrankCpi { crank_id: i64, .. }`.
- **Validated bounds:** `iterations >= 1`, and `0 < execution_interval_millis < u32::MAX`.
  Our 400ms tick is fine. The validator's own floor is `min-interval = "10ms"` in
  `[task-scheduler]` config.
- **`iterations` is finite.** There is no "run forever". A long raid needs a large
  iterations value or periodic rescheduling — worth a line in the arena lifecycle design.
- Scheduled instructions may not reference the validator authority, and may not be
  privileged MagicBlock instructions (`ModifyAccounts`, `CloneAccount`, `SetProgramAuthority`,
  `FinalizeProgramFromBuffer`, …).

---

## 8. How this wires into the rest of HEARTROT

### 8.1 Where the roll sits in the arena lifecycle

```
Phase::Fighting
    players hitscan shell parts   (player txs, ER, session key)
    crank advances Bullets[128]   (400ms, no signer needed)
        │
        │ shell integrity < 35%  →  Core::vent_open = true
        ▼
Phase::Fighting (core exposed)
        │
        │ core_hp reaches 0, in a player tx
        ▼
Phase::CoreDead ──► same tx calls request_incarnation_roll()
                     → CPI to VRF, DEFAULT_EPHEMERAL_QUEUE, 0 lamports
                     → phase = Rolling, roll_requested_tick = tick
        │
Phase::Rolling
    crank keeps ticking but the boss does not act
    (~1 ER slot to ~100ms typical; budget a few ticks)
        │
        │ VRF fulfils → consume_incarnation_roll(randomness, for_incarnation)
        ▼
Phase::Fighting   incarnation += 1, affixes applied, affix_seed stored
```

Storing `affix_seed: [u8; 32]` on ArenaState is what makes the raid *verifiably* fair —
anyone can recompute the affix set from the seed and check it against the on-chain
`ProvideRandomness` proof.

### 8.2 One seed per incarnation, expanded — never one VRF call per tick

This is the most important architectural point in this document.

Per-tick VRF is **impossible**, not merely expensive:
- fulfilment can never be same-slot, so a 400ms tick could not get its own randomness in
  time even at best-case ER latency;
- requests carry a 240-slot TTL and share a queue with every other consumer;
- and the callback would contend with the crank for the same writable accounts every tick.

The correct pattern is **one VRF seed per incarnation, hash-expanded deterministically**:

```rust
// One VRF draw per incarnation. Everything the boss does for the rest of that
// incarnation is derived from it, deterministically, with zero further oracle calls.
fn tick_entropy(affix_seed: &[u8; 32], tick: u32) -> [u8; 32] {
    anchor_lang::solana_program::hash::hashv(&[affix_seed, &tick.to_le_bytes()]).to_bytes()
}
```

Bullet spread, volley angles and part-targeting for tick *n* all come from
`tick_entropy(&arena.affix_seed, n)`. This is unpredictable to players in practice (they
cannot know the seed until it is revealed), free, synchronous, and — because it is pure —
**the client can render exactly the same bullet pattern locally without waiting for chain
state.** That is a real win for a bullet-hell renderer at 400ms ticks.

The verifiable-fairness property that actually matters for a raid is *"the boss's ruleset
was not chosen by anyone"*, and one seed per incarnation delivers that fully.

Note the spec's `bullets_per_volley = 3 + alive_players` stays deterministic and untouched —
VRF picks the *ruleset/affixes*, the difficulty curve stays a pure function of player count.

### 8.3 Which program hosts the callback — the Pinocchio question

This is where VRF intersects the open architectural question, so let me be precise about
what I verified and what I did not.

**Verified: `ephemeral-rollups-pinocchio` 0.17.0 ships a first-class, `no_std`,
allocation-free VRF CPI module** at `rust/pinocchio/src/vrf/`. Its module doc:

> This is the `no_std`, allocation-free counterpart to the canonical `ephemeral_vrf_sdk`,
> intended for on-chain pinocchio programs that request randomness via CPI and consume the
> result inside a callback instruction.

It exposes `RequestRandomnessCpi`, `program_identity_pda`, `scoped_vrf_identity`, the same
queue constants, and the same `rnd` helpers. Its own test suite asserts the instruction it
builds is **byte-for-byte identical** to the Anchor SDK's:

```rust
// Program id and data must match the canonical instruction byte-for-byte.
assert_eq!(view.program_id.as_ref(), ix.program_id.as_ref());
assert_eq!(view.data, ix.data.as_slice());

// Account order, keys, and signer/writable flags must match.
assert_eq!(view.accounts.len(), ix.accounts.len());
for (got, expected) in view.accounts.iter().zip(ix.accounts.iter()) {
    assert_eq!(got.address.as_ref(), expected.pubkey.as_ref());
    assert_eq!(got.is_signer, expected.is_signer);
    assert_eq!(got.is_writable, expected.is_writable);
}
```

and a matching test asserts `scoped_vrf_identity` derives identically across both SDKs.
There is also a documented usage sketch in the module header:

```rust
let request = RequestRandomness {
    caller_seed: [0u8; 32],
    callback_program_id: *crate_program_id,
    callback_discriminator: &[/* callback ix discriminator */],
    callback_accounts_metas: &[],
    callback_args: &[],
};
let cpi = RequestRandomnessCpi::new(
    payer, program_identity, oracle_queue, system_program, slot_hashes, request,
);

let bump = [identity_bump];
let seeds = [Seed::from(IDENTITY), Seed::from(&bump)];
let signer = Signer::from(&seeds);

let mut data = [0u8; 256]; // >= cpi.serialized_size()
cpi.invoke_signed(&mut data, &[signer])?;
```

(One inconsistency to be aware of: this doc example calls `RequestRandomnessCpi::new(...)`
with six args, but the struct in `instruction.rs` has **seven** public fields — it also
carries `vrf_program: &AccountView` — and I found no `new()` constructor in that file. The
doc comment appears to lag the struct. Build it with struct literal syntax, as the crate's
own test does.)

Note the Pinocchio `RequestRandomness` type carries a `high_priority: bool` field that
selects between discriminators 10 and 11, whereas the Anchor `RequestRandomnessParams`
does not — priority is chosen by which builder function you call. Same wire format, two
different ergonomics.

**So: a native Pinocchio program can both request and consume VRF.** That part of the
user's proposal is sound and directly supported.

**The constraint that decides the architecture is not VRF, it is account ownership.** The
VRF callback is a plain `invoke_signed` into `callback_program_id`. For that callback to
mutate an account, Solana requires the callback program to **own** that account. BOLT
component accounts are owned by their BOLT component programs. Therefore:

> A native Pinocchio program cannot be the VRF callback that writes a BOLT component
> account. Whichever program owns `ArenaState`/`Boss` must host `consume_incarnation_roll`.

Concretely, for HEARTROT the incarnation-roll callback belongs in the **BOLT side**, because
ArenaState and Boss are BOLT components. A Pinocchio program could own its own separate
state and consume its own VRF rolls, but it cannot reach into component accounts.

*Confidence: high on the Solana ownership rule and on the VRF callback being a plain
`invoke_signed` (both read from source). Medium on the specific claim about BOLT component
account ownership — I did not read BOLT's world/component source in this pass (the file
path I tried 404'd) and there is no BOLT-specific VRF integration anywhere in the SDK.
**The BOLT-topic research should confirm component ownership and the `apply` authority
model before this is treated as settled.***

### 8.4 Backend and frontend impact: none

The four cold-path routes (`session/init`, `match/start`, `match/settle`, `faucet/status`)
are unaffected. The VRF request rides inside an existing gameplay transaction that goes
browser → ER directly, and the fulfilment arrives as an oracle-submitted ER transaction.
**No VRF traffic passes through the Cloudflare Worker**, which preserves the 10ms ER
latency the design is built around.

Frontend consequence: the client must handle `Phase::Rolling` as a real, renderable state —
a brief "the heart reforms" beat between incarnations, on the order of one to a few ticks.
Do not build the UI assuming the incarnation flips synchronously on the killing blow. That
beat is also a free place to hide the boss re-rig on the SVG sprite rig.

Treasury consequence: **zero.** In-ER VRF costs nothing, so no funding tier needs a VRF
line item.

---

## 9. Fallback if VRF is unavailable

VRF looked perfectly healthy on devnet today (§4), but the design should degrade rather
than deadlock. Three layers, cheapest first.

### 9.1 Timeout → deterministic seed (recommended)

Because we already store `roll_requested_tick`, the crank can detect a roll that never
landed and self-heal. No new infrastructure, no new accounts:

```rust
// In the crank's tick handler. If the VRF callback has not landed within
// ROLL_TIMEOUT_TICKS, fall back to a chain-derived seed so the raid continues.
// ponytail: SlotHashes is validator-influenceable, not verifiable randomness.
// Acceptable only as a liveness fallback; flag the incarnation as unverified.
const ROLL_TIMEOUT_TICKS: u32 = 25; // ~10s at a 400ms tick

if arena.phase == Phase::Rolling
    && arena.tick.saturating_sub(arena.roll_requested_tick) > ROLL_TIMEOUT_TICKS
{
    let sh = &ctx.accounts.slot_hashes.try_borrow_data()?[16..48];
    let seed = hashv(&[sh, &arena.tick.to_le_bytes(), arena.key().as_ref()]).to_bytes();
    arena.affix_seed = seed;
    arena.affix_verified = false;   // <- surfaced in the UI and excluded from records
    ctx.accounts.boss.apply_affixes(affix_set_from_seed(&seed));
    arena.incarnation = arena.incarnation.saturating_add(1);
    arena.phase = Phase::Fighting;
}
```

Set the timeout generously — the docs' in-ER figure is ~100ms and the TTL is 240 slots, so
25 ticks (~10s) is far past any legitimate fulfilment while still invisible to players as a
hang. The `affix_verified` flag is the honest part: an unverified incarnation should be
visibly marked and should not count toward the leaderboard written by the settlement Magic
Action.

Note this timeout branch runs in the crank and needs **no signer** — it only writes accounts
the crank already has. That is precisely why it works where the VRF request does not.

### 9.2 Pre-committed seed chain (if unverified incarnations are unacceptable)

At `match/start`, draw **one** VRF seed and store `H^n(seed)` on-chain. Reveal one preimage
per incarnation, in reverse order. Each reveal is checkable against the stored commitment,
so every incarnation stays verifiable with exactly one VRF call per match, and a VRF outage
mid-match cannot stall the raid at all. Cost: a fixed cap on incarnations per match, and
the reveal has to come from somewhere trusted-but-checkable. Only worth it if §9.1's
unverified marker is judged unacceptable.

### 9.3 Base-layer queue as a last resort

If the ER's `vrf_oracle` is down but the base-layer one is up, the same request can go to
`DEFAULT_QUEUE` from a base-layer transaction, at 500,000 lamports and 1-5s (up to 10s)
latency, paid by the treasury. This is a bad fit for a live raid — it is a base-layer
round-trip in the middle of gameplay, which is exactly what the ER architecture exists to
avoid — and I would not build it. Listed for completeness.

**Recommendation: ship §9.1 only.** It is about fifteen lines, needs no new accounts, and
covers the realistic failure. §9.2 is the upgrade path if verifiability of every incarnation
becomes a requirement.

---

## 10. Contradictions with the stated design assumptions

Collected in one place, most consequential first.

1. **"A MagicBlock crank ticks the boss… there is deliberately NO server game loop"** — as a
   consequence the crank looks like the natural owner of the incarnation roll. It cannot be:
   crank instructions may not carry a writable signer, and the VRF request requires one
   (§7). Move the request into the killing-blow player transaction. The crank stays, and
   still owns the tick and the fallback (§9.1).

2. **Skill/spec versions are stale.** `ephemeral-vrf-sdk 0.3.0` → **0.17.0**;
   `ephemeral-rollups-sdk 0.14.3` → **0.17.0**; npm `0.14.3` → **0.17.0**. The repo
   `magicblock-labs/ephemeral-vrf` is now `magicblock-labs/solana-vrf`, and the SDK crates
   live in `magicblock-labs/ephemeral-rollups-sdk`.

3. **`VRF_PROGRAM_IDENTITY` is deprecated** in favour of scoped per-program identity. Our
   skill's callback pattern (`#[account(address = VRF_PROGRAM_IDENTITY)]`) is the old one.
   Use `#[vrf_callback]`.

4. **The official docs and reference program will not compile against 0.17.0** — they call
   `create_request_scoped_randomness_ix`, which does not exist there. Worse, the name
   `create_request_randomness_ix` **changed meaning** between the rev they pin and 0.17.0
   (legacy → scoped) (§3.1).

5. **Crank args are `i64`, not `u64`**, and the manual bincode `ScheduleTask` pattern in our
   skill is superseded by `ScheduleCrankCpi` (§7.5). `iterations` is finite — there is no
   infinite crank.

6. **"Bullets[128] advanced by a crank every tick"** is fine, but if anyone imagined
   per-tick VRF for bullet patterns, that is not merely costly, it is structurally
   impossible (never same-slot, 240-slot TTL, account contention). Use one seed per
   incarnation, hash-expanded per tick (§8.2) — which also lets the client predict bullet
   patterns locally.

7. **The VRF callback cannot touch all 20 Player entities** — 25-account cap, and the
   callback's account list is frozen at request time. Scope it to Arena + Boss.

8. **The Pinocchio proposal is supported for VRF specifically** — there is a real,
   tested, `no_std` Pinocchio VRF module at 0.17.0 — but a Pinocchio program cannot host a
   callback that writes BOLT component accounts, because it does not own them (§8.3). That
   ownership question, not VRF, is what should drive the BOLT/Pinocchio split.

---

## 11. Open questions

- **Does the VRF program accept a program-owned PDA as `payer` when the fee transfer is
  skipped?** Decides whether §7.4's crank workaround is viable at all. Testable in an
  afternoon on devnet; not worth doing unless §7.3 is rejected.
- **BOLT component account ownership and the `apply` authority model.** Determines whether
  the incarnation-roll callback must live in a BOLT component program, and therefore where
  the BOLT/Pinocchio boundary falls. Belongs to the BOLT research topic.
- **Actual observed in-ER fulfilment latency on devnet.** The "within 100 ms" figure is
  marketing copy from the docs, not a measurement. The only hard guarantee I could verify
  in source is "strictly later slot". Measure it before setting `ROLL_TIMEOUT_TICKS`.
- **Oracle queue contention.** `DEFAULT_EPHEMERAL_QUEUE` is shared across all consumers on
  the cluster. I found the per-request limits but no documented queue depth cap or
  rate limit. If a queue-full condition exists, it is a failure mode I have not
  characterised.
- **Is `create_request_scoped_randomness_ix` coming back as an alias in 0.18?** The docs
  currently describe an API the published crate does not have. Worth re-checking at upgrade
  time rather than guessing.

---

## Sources

Every URL below was fetched and read while writing this document, on 2026-08-31.

**Crate / package registries**
- https://crates.io/api/v1/crates/ephemeral-vrf-sdk
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/ephemeral-rollups-pinocchio
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk/latest
- https://docs.rs/ephemeral-vrf-sdk/0.17.0/ephemeral_vrf_sdk/instructions/index.html
- https://docs.rs/ephemeral-vrf-sdk/0.17.0/ephemeral_vrf_sdk/consts/index.html

**SDK monorepo source (`magicblock-labs/ephemeral-rollups-sdk`, branch `main`)**
- https://api.github.com/repos/magicblock-labs/ephemeral-rollups-sdk/contents/
- https://api.github.com/repos/magicblock-labs/ephemeral-rollups-sdk/contents/rust
- https://api.github.com/repos/magicblock-labs/ephemeral-rollups-sdk/git/trees/main?recursive=1
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/src/consts.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/src/instructions.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/src/types.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/src/rnd.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/src/anchor.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-sdk/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/vrf-macro/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/vrf.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/crank.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/anchor.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/sdk/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/vrf/mod.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/vrf/consts.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/vrf/instruction.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/vrf/pda.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/vrf/types.rs
- https://raw.githubusercontent.com/magicblock-labs/ephemeral-rollups-sdk/main/rust/pinocchio/src/vrf/rnd.rs

**VRF program source (`magicblock-labs/solana-vrf`, branch `main`)**
- https://github.com/magicblock-labs/ephemeral-vrf  *(redirects — see next)*
- https://api.github.com/repositories/947207447  *(resolves the rename to `solana-vrf`)*
- https://api.github.com/repos/magicblock-labs/solana-vrf/git/trees/main?recursive=1
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/README.md
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/program/src/request_randomness.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/program/src/provide_randomness.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/program/src/fees.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/api/src/consts.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/api/src/state/queue.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/vrf-oracle/src/oracle/processor.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/program/tests/integration/use-randomness/programs/use-randomness/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/solana-vrf/main/program/tests/integration/use-randomness/programs/use-randomness/Cargo.toml

**Validator source (`magicblock-labs/magicblock-validator`, branch `master`)** — crank rules
- https://api.github.com/repos/magicblock-labs/magicblock-validator/git/trees/master?recursive=1
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/docs/task-scheduler.md
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/programs/magicblock/src/schedule_task/mod.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/programs/magicblock/src/schedule_task/process_schedule_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/programs/magicblock/src/schedule_task/process_execute_task.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/master/magicblock-magic-program-api/src/pda.rs

**Engine examples (`magicblock-labs/magicblock-engine-examples`, branch `main`)**
- https://api.github.com/repos/magicblock-labs/magicblock-engine-examples/git/trees/main?recursive=1
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/README.md
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/programs/rewards-delegated-vrf/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/programs/rewards-delegated-vrf/src/instructions/request_random_reward.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/programs/rewards-delegated-vrf/src/instructions/consume_random_reward.rs
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/rewards-delegated-vrf/anchor/programs/rewards-delegated-vrf/Cargo.toml
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/crank-counter/anchor/programs/crank-counter/src/lib.rs

**Documentation and live status**
- https://docs.magicblock.gg/pages/tools/randomness/technical-details
- https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/how-to-guide/quickstart
- https://docs.magicblock.gg/pages/tools/crank/introduction
- https://docs.magicblock.gg/pages/tools/randomness/integration  *(redirects to a generic landing page; no VRF specifics)*
- https://status.magicblock.app/api/services

**Fetched but yielded nothing usable**
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/programs/world/src/lib.rs  *(HTTP 404 — BOLT component ownership left unverified, see §8.3)*
