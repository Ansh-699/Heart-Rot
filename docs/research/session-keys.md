# Session keypairs and popup-free ER signing

**Research date:** 2026-08-31
**Topic owner:** HEARTROT / on-chain co-op boss raid, Solana devnet
**Status:** research complete, one headline finding contradicts the frozen design spec

---

## 0. Headline findings

1. **Ephemeral Rollup transactions cost zero lamports, and the ER runtime performs no
   fee-payer balance check at all.** Verified three ways: the ER's `getFeeForMessage`
   RPC handler returns a hardcoded `0`; the ER's forked SVM has had
   `validate_transaction_fee_payer` *deleted* — there is no balance check, no
   rent-exempt check, no `AccountNotFound`; and a live probe of `devnet-as.magicblock.app`
   returns fee `0` for a message paid by a freshly-random pubkey that has never existed
   on any chain.

2. **Therefore the session wallet needs zero SOL — on the ER *and* on base layer —
   for gameplay.** This contradicts design spec §8, which funds ~0.005 SOL per player
   "because the session wallet only ever pays ER fees." That cost is zero. The entire
   four-tier funding ladder in §8 is solving a problem that does not exist, *provided*
   the session key never signs a base-layer transaction. Per §9 it never does.

3. **MagicBlock does have a first-class session-key concept**, in two layers: the
   `session-keys` Anchor program (`KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5`,
   crate `session-keys` **3.1.1**), and BOLT's built-in `world::apply_with_session` /
   `component::update_with_session` path. **HEARTROT should not use either.** The spec's
   own design — `session_pubkey` stored on `PlayerMeta`, systems assert
   `signer == session_pubkey` — is strictly simpler, costs one less base-layer account
   per player, and avoids a documented authorization hole in BOLT's session path
   (§5.3 below).

4. **BOLT is effectively unmaintained.** `bolt-lang` on crates.io is pinned at **0.2.4**
   (2025-07-23); **0.2.5 and 0.2.6 are both yanked**; the last non-README commit to
   `magicblock-labs/bolt` was 2025-10-19. Meanwhile `ephemeral-rollups-sdk` shipped
   **0.17.0** on 2026-08-26. This is outside my assigned topic but it is load-bearing
   for it, so it is flagged in §10.

5. **The right browser hardening is a non-extractable WebCrypto Ed25519 key in
   IndexedDB, not a raw secret in `localStorage`.** Ed25519 landed in Chrome 137
   (May 2026) and has been in Firefox 129 and Safari 17 for longer, so it is now
   available in every engine. A non-extractable `CryptoKey` cannot be exfiltrated by
   XSS or a malicious extension — an attacker must stay resident in the page to abuse
   it. `@solana/kit` 8.2.0 is built natively around exactly this.

---

## 1. What the pattern is

Generate an Ed25519 keypair in the browser. Persist it locally. Use it as the signer
(and fee payer) of every gameplay transaction sent to the Ephemeral Rollup, so the user
never sees a wallet confirmation during play. The user's real wallet (Privy embedded or
an injected wallet) is used exactly twice: to establish identity at onboarding, and
never again during a match.

Two distinct things get conflated under the name "session key", and HEARTROT needs to
be precise about which it is using:

| | **Bare session keypair** | **Session key + session token (Gum / MagicBlock)** |
|---|---|---|
| What exists on chain | nothing extra | a `SessionToken` PDA on base layer |
| Who authorizes it | your own program logic | the `session-keys` program, via PDA seeds |
| Expiry | whatever you build | on-chain `valid_until`, hard-capped at 7 days |
| Revocation | whatever you build | `revoke_session` instruction |
| Program scoping | none | `target_program` field |
| Base-layer cost | zero | rent for the token PDA, per player |
| Reads on the ER | n/a | requires a JIT clone of the token PDA into the ER |

HEARTROT's spec picks column 1 and it is the right pick. Column 2 buys expiry,
revocation and program-scoping — all three of which are near-worthless when the session
key controls no assets and the match itself lasts six minutes.

---

## 2. Pinned versions (all verified 2026-08-31)

### Live devnet ER, probed directly

```
$ curl -sS https://devnet-as.magicblock.app/ -X POST -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getVersion"}'
{"jsonrpc":"2.0","result":{"magicblock-core":"0.14.11","feature-set":3718597879,
 "solana-core":"4.0.0","git-commit":"cec4cf5"},"id":1}
```

### Rust

| Crate | Version | Date | Note |
|---|---|---|---|
| `ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | local `magicblock` skill says 0.14.3 — **stale** |
| `ephemeral-vrf-sdk` | **0.17.0** | 2026-08-26 | version-unified with the ER SDK |
| `session-keys` | **3.1.1** | 2026-05-26 | repo `magicblock-labs/gum-program-library` |
| `session-keys-macros-attribute` | **3.1.1** | 2026-05-26 | |
| `bolt-lang` | **0.2.4** | 2025-07-23 | 0.2.5 + 0.2.6 **yanked**; repo main is 0.2.6 |
| `magicblock-engine-nucleus` | git tag **0.3.3** | | the ER's SVM runtime |

### npm

| Package | Version | Date | Note |
|---|---|---|---|
| `@magicblock-labs/ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | |
| `@magicblock-labs/ephemeral-validator` | **0.14.10** | 2026-08-16 | localnet validator |
| `@magicblock-labs/bolt-sdk` | **0.2.4** | 2025-07-23 | 13 months old |
| `@magicblock-labs/gum-sdk` | **3.0.10** | 2025-11-26 | the session-keys TS client |
| `@solana/kit` | **8.2.0** | 2026-08-29 | WebCrypto-native, non-extractable keys |
| `@solana/web3.js` | **1.98.4** | 2025-07-31 | `rc` tag is at 3.0.0-rc.2 |
| `@privy-io/react-auth` | **3.39.0** | 2026-08-31 | |
| `@privy-io/server-auth` | **1.32.5** | 2025-09-17 | |

> **Docs bug:** MagicBlock's session-keys page tells you to
> `import { createSessionToken } from "@session-keys/anchor"`. **That package does not
> exist on npm** (registry returns "Not found"). The real client is
> `@magicblock-labs/gum-sdk`, or BOLT's own `@magicblock-labs/bolt-sdk` helpers.

### Program IDs

| Program | Address |
|---|---|
| Session Keys | `KeyspM2ssCJbqUhQ4k7sveSiY4WjnYsrXkC8oDbwde5` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic Program | `Magic11111111111111111111111111111111111111` |
| Magic Context | `MagicContext1111111111111111111111111111111` |

---

## 3. The ER fee model — does the session wallet need lamports?

**No.** This is the single most consequential finding in this document, so here is the
full evidence chain rather than an assertion.

### 3.1 `getFeeForMessage` returns a hardcoded zero

`magicblock-validator/magicblock-aperture/src/requests/http/get_fee_for_message.rs`,
branch `dev`, verbatim tail of the handler:

```rust
        SanitizedMessage::try_new(
            sanitized_versioned_message,
            SimpleAddressLoader::Disabled,
            &Default::default(),
        )
        .map_err(RpcError::transaction_verification)?;

        let slot = self.engine.blocks().latest().slot;
        Ok(ResponsePayload::encode(&request.id, 0_u64, slot))
    }
```

The message is decoded and sanitized purely to validate it. The response value is the
literal `0_u64`. There is no fee calculator in the path.

### 3.2 The ER's SVM has no fee-payer validation

The ER runs a fork of the Solana SVM vendored at
`magicblock-engine` tag `0.3.3`, `solana/svm/src/`. Stock Agave has a
`validate_transaction_fee_payer` that rejects a payer with zero lamports
(`AccountNotFound`) and enforces a post-fee rent-exempt minimum. **That function does
not exist in the fork.** `load_transaction_accounts` simply loads every account key:

```rust
    // Attempt to load all of the transaction accounts
    for account_key in account_keys.iter() {
        let loaded_account = load_transaction_account(account_loader, message, account_key);
        collect_loaded_account(account_key, loaded_account)?;
    }
```

`fee_details` survives only as metadata that is copied through and never applied:

```rust
pub struct LoadedTransaction {
    /// Transaction accounts in message account-key order.
    pub accounts: Vec<KeyedAccountSharedData>,
    pub(crate) program_indices: Vec<IndexOfAccount>,
    /// Fee metadata carried through for callers that still consume it.
    pub fee_details: FeeDetails,
    ...
}
```

And the ER's own access guard says so in a comment —
`solana/svm/src/access_permissions.rs`:

```rust
        // The payer is writable in Solana messages even when fees are disabled
        // here; reject it only if execution actually changed immutable state.
        if payer.1.dirty() && !payer.1.mutable() {
            let error = format!("Program log: ({}) Feepayer account is readonly", payer.0);
            logs.push(error);
            self.execution_details.status = Err(TransactionError::InvalidAccountForFee);
            return false;
        }
```

### 3.3 Live devnet probe with a pubkey that has never existed

```
payer pubkey: 6pzoGvvQG4NxU5rW8AH3ZZ76Zaion5hs5Mfo9rWgMDbR   (freshly random, 0 lamports)

ER getFeeForMessage   -> {"result":{"context":{"slot":563477296},"value":0}}
ER getBalance(random) -> {"result":{"context":{"slot":563477314},"value":0}}
ER requestAirdrop     -> {"error":{"code":-32600,
                          "message":"invalid request: free airdrop faucet is disabled"}}
```

Fee is zero for a payer with zero lamports that has never been on chain.

### 3.4 What *does* exist: the ephemeral balance escrow (and why HEARTROT can ignore it)

MagicBlock has an escrow concept for fee payers. On base layer you call
`top_up_ephemeral_balance`, which funds a PDA at
`ephemeral_balance_pda_from_payer(payer, 0)`; the ER then clones that PDA alongside the
payer whenever the payer submits a transaction —
`magicblock-chainlink/src/chainlink/mod.rs`:

```rust
        let feepayer = &tx.static_account_keys()[0];

        let balance_pda = ephemeral_balance_pda_from_payer(feepayer, 0);

        // Determine if we need to clone the escrow account for the feepayer
        let clone_escrow = !self.contains_account(&balance_pda);

        // If cloning escrow, add the balance PDA
        if clone_escrow {
            trace!(
                balance_pda = %balance_pda,
                feepayer = %feepayer,
                "Adding balance PDA for feepayer"
            );
            pubkeys.push(balance_pda);
        }
```

The validator's own tests confirm all three states are legal, including *no escrow at
all* (`magicblock-chainlink/tests/12_feepayer.rs`):

```rust
#[tokio::test]
async fn fee_payer_without_ephemeral_balance_gets_placeholder() {
    ...
    ctx.chainlink
        .ensure_transaction_accounts(&fee_payer_transaction(&ctx, &payer))
        .await
        .unwrap();

    assert_cloned_as_undelegated!(ctx.bank, &[payer.pubkey()]);
    assert_cloned_as_empty_placeholder!(ctx.bank, &[balance]);
    assert_subscribed!(ctx.chainlink, &[&payer.pubkey(), &balance]);
}
```

The top-up instruction pair, verbatim from
`test-integration/test-tools/src/dlp_interface.rs`:

```rust
pub fn create_topup_ixs(
    payer: Pubkey,
    recvr: Pubkey,
    lamports: u64,
    validator: Option<Pubkey>,
) -> Vec<Instruction> {
    let topup_ix = dlp_api::instruction_builder::top_up_ephemeral_balance(
        payer,
        recvr,
        Some(lamports),
        None,
    );
    let mut ixs = vec![topup_ix];
    if let Some(validator) = validator {
        let delegate_ix =
            dlp_api::instruction_builder::delegate_ephemeral_balance(
                payer,
                recvr,
                DelegateEphemeralBalanceArgs {
                    delegate_args: DelegateArgs {
                        validator: Some(validator),
                        ..Default::default()
                    },
                    ..Default::default()
                },
            );
        ixs.push(delegate_ix);
    }
    ixs
}
```

**HEARTROT does not need this.** The escrow exists so a *delegated* account can pay for
its own base-layer commits past the sponsored quota. In HEARTROT the platform is the
delegation authority and pays all commits (spec §5), so the escrow belongs — if
anywhere — to the platform's payer, never to a player's session key.

Related, same reasoning: `lamportsDelegatedTransferIx` (discriminator `20`,
`@magicblock-labs/ephemeral-rollups-sdk`) tops up a *delegated* account's ER-side
lamports via a single-use PDA derived from `[b"lamports", payer, destination, salt]`,
submitted on **base layer**. A session key is never delegated, so this never applies to
it. Noted only so nobody reaches for it by mistake.

### 3.5 The one hard rule this creates

`access_is_valid` is enforced after execution
(`solana/svm/src/transaction_processor.rs:229`) and rejects any write to a
non-`mutable` account. `AccountMode::mutable()` is:

```rust
impl AccountMode {
    /// Returns `true` for modes that may be mutated by user programs.
    pub fn mutable(&self) -> bool {
        use AccountMode::*;
        matches!(self, Delegated | Ephemeral)
    }
}
```

A session keypair on the ER is `Placeholder` (never existed on chain) or `ReadOnly`
(exists on base, not delegated). Neither is mutable.

> **Rule: no gameplay instruction may ever debit or credit the session wallet inside the
> ER.** It may sign, and it may be fee payer. The moment an instruction moves a lamport
> in or out of it, the transaction fails with `InvalidAccountForFee`. Any instruction
> writing to *any* other undelegated account fails with `InvalidWritableAccount`.

---

## 4. Browser-side: how to hold the key

### 4.1 The spec's version (localStorage secret) — works, but is the weaker option

Spec §7: "The session wallet is a `Keypair` generated in the browser, secret held in
`localStorage`." This is functional. Its weakness is that the raw 64 bytes are readable
by any script running on the origin, so a single XSS or a malicious extension
exfiltrates the key permanently, in one shot, and can then use it from anywhere forever.

### 4.2 The better version: non-extractable WebCrypto Ed25519 in IndexedDB

Ed25519 in WebCrypto is now available across all engines — Firefox 129 (Aug 2024),
Safari 17, and Chrome 137 (May 2026). A non-extractable private key exists only as an
opaque handle; `exportKey` and `wrapKey` throw. `CryptoKey` is structured-cloneable, so
the handle persists in IndexedDB across reloads. `@solana/kit` documents exactly this,
and its `generateKeyPair()` is the native call with `extractable = false`:

```javascript
const keyPair = await crypto.subtle.generateKey(
  { name: 'Ed25519' },
  false,
  ['sign', 'verify'],
);
```

Solana signatures are raw RFC 8032 Ed25519 over the serialized message, which is exactly
what `crypto.subtle.sign({name:'Ed25519'}, privateKey, message)` produces — so this is a
drop-in at the cryptographic level.

**Bridging to the web3.js v1 / Anchor 0.32.1 client that BOLT emits.** web3.js v1
`Signer` requires a `secretKey`, which a non-extractable key does not have. Use the
external-signature path instead; both transaction types expose it
(`@solana/web3.js@1.98.4` type defs):

```typescript
    /**
     * @param {PublicKey} pubkey Public key that will be added to the transaction.
     * @param {Buffer} signature An externally created signature to add to the transaction.
     */
    addSignature(pubkey: PublicKey, signature: Buffer): void;
    ...
    addSignature(publicKey: PublicKey, signature: Uint8Array): void;   // VersionedTransaction
```

Composed pattern (assembled from the two verified APIs above — not copied from a doc,
so treat it as a sketch to test, not as canon):

```typescript
// --- one-time, at onboarding ---
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)); // public IS extractable
const sessionPubkey = new PublicKey(raw);
await idbPut("heartrot-session", kp);   // store the CryptoKeyPair handle, not bytes

// --- per gameplay transaction, on the ER ---
tx.feePayer = sessionPubkey;
tx.recentBlockhash = (await erConnection.getLatestBlockhash()).blockhash;
const sig = new Uint8Array(
  await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, tx.serializeMessage()),
);
tx.addSignature(sessionPubkey, Buffer.from(sig));
await erConnection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
```

`skipPreflight: true` is the standing MagicBlock recommendation for ER transactions.

### 4.3 Why not just sign with the Privy embedded wallet directly

Privy *can* sign without a modal — `@privy-io/react-auth` 3.39.0 exposes
`useSignTransaction` from `@privy-io/react-auth/solana`, and the docs state: "To hide
confirmation modals, set `options.uiOptions.showWalletUIs` to `false`."

So "zero popups" is achievable without a session key at all. It is still the wrong
choice for HEARTROT: every signature crosses into Privy's cross-origin iframe and its
key-shard machinery, which is orders of magnitude slower than an in-process
`crypto.subtle.sign`. At a 400 ms tick with hitscan shots, that hop is the same mistake
as routing gameplay through the Worker. Keep Privy for identity and recovery, per
spec §7 — that division is correct.

---

## 5. MagicBlock's first-class session-key concept

### 5.1 The `session-keys` program (crate 3.1.1)

Full source read at
`magicblock-labs/session-keys/programs/gpl_session/src/lib.rs`. The account:

```rust
#[account]
#[derive(Copy)]
pub struct SessionToken {
    pub authority: Pubkey,
    pub target_program: Pubkey,
    pub session_signer: Pubkey,
    pub valid_until: i64,
}
```

PDA seeds: `["session_token", target_program, session_signer, authority]`
(V2 uses prefix `"session_token_v2"` and adds a `fee_payer: Pubkey`).

Validity is capped at one week, defaulting to one hour:

```rust
fn process_session_params(top_up: Option<bool>, valid_until: Option<i64>) -> Result<(bool, i64)> {
    let top_up = top_up.unwrap_or(false);
    let valid_until = valid_until.unwrap_or(Clock::get()?.unix_timestamp + 60 * 60);
    Ok((top_up, valid_until))
}
```

```rust
    // Valid until can't be greater than a week
    require!(
        valid_until <= Clock::get()?.unix_timestamp + (60 * 60 * 24 * 7),
        SessionError::ValidityTooLong
    );
```

`create_session_with_payer` and V2's `fee_payer` field let a **treasury pay the token's
rent while the user's wallet signs as authority** — which is precisely the split
HEARTROT's spec §5 describes ("the platform administers; the player acts"). If the
session-token route is ever taken, this is the instruction to use.

The built-in funding hook — note this is an **anti-pattern for HEARTROT**:

```rust
    // Top up the session signer account with some lamports to pay for the transaction fees
    if top_up {
        let amount = lamports.unwrap_or(LAMPORTS_PER_SOL / 100);
        invoke(
            &system_instruction::transfer(payer.key, session_signer_account.key, amount),
            &[payer, session_signer_account, system_program],
        )?;
    }
```

Default 0.01 SOL moved onto the browser-held key. Since ER fees are zero, this only
creates a drainable balance on the least-protected key in the system. **Always pass
`top_up = false` / omit `topUp`.**

Two behaviours worth knowing:

- **V1 `is_expired` is misnamed.** `SessionToken::is_expired()` returns
  `now < self.valid_until` — i.e. `true` while the token is *still valid*. Because
  `validate()` returns that value directly as the "is valid" result, the composite
  behaviour is correct. It is a naming bug, not a security bug. V2 fixes it
  (`now >= valid_until`, and `validate` returns `!expired`).
- **Anyone can revoke a V1 token.** `RevokeSessionToken.authority` is a
  `SystemAccount`, not a `Signer`; rent goes to the authority regardless of who calls.
  The source comments say this is deliberate. V2 requires the authority to sign while
  the session is still active.

### 5.2 BOLT's session path exists and is wired end to end

`bolt-lang` depends on `session-keys = { version = "^2", features = ["no-entrypoint"] }`
and the `#[component]` macro generates a session variant of `update`. Verbatim from
`bolt/crates/bolt-lang/attribute/bolt-program/src/lib.rs`:

```rust
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
                ...
            }
```

driven from the world program (`bolt/crates/programs/world/src/lib.rs`):

```rust
    pub fn apply_with_session<'info>(
        ctx: Context<'_, '_, '_, 'info, ApplyWithSession<'info>>,
        args: Vec<u8>,
    ) -> Result<()> {
        let (pairs, results) = apply_impl(...)?;
        for ((program, component), result) in pairs.into_iter().zip(results.into_iter()) {
            bolt_component::cpi::update_with_session(
                build_update_context_with_session(
                    program,
                    component,
                    ctx.accounts.authority.clone(),
                    ctx.accounts.instruction_sysvar_account.clone(),
                    ctx.accounts.session_token.clone(),
                ),
                result,
            )?;
        }
        Ok(())
    }
```

TypeScript side, verbatim from `bolt/clients/typescript/src/world/transactions.ts`:

```typescript
export async function CreateSession({
  sessionSigner,
  authority,
  topUp,
  validity,
}: {
  sessionSigner?: Keypair;
  authority: PublicKey;
  topUp?: BN;
  validity?: BN;
}): Promise<{
  instruction: TransactionInstruction;
  transaction: Transaction;
  session: Session;
}> {
  sessionSigner = sessionSigner ?? Keypair.generate();
  const sessionToken = FindSessionTokenPda({
    sessionSigner: sessionSigner.publicKey,
    authority,
  });
  const lamports = topUp ?? null;
  const shouldTopUp = topUp ? true : false;
  let instruction = await SessionProgram.methods
    .createSession(shouldTopUp, validity ?? null, lamports)
    .accounts({
      sessionSigner: sessionSigner.publicKey,
      authority,
      targetProgram: WORLD_PROGRAM_ID,
      sessionToken,
    })
    .instruction();
  const transaction = new Transaction().add(instruction);
  return {
    instruction,
    transaction,
    session: new Session(sessionSigner, sessionToken),
  };
}
```

and usage, verbatim from `bolt/clients/typescript/test/intermediate-level/session.ts`:

```typescript
      const applySystem = await ApplySystem({
        authority: session.signer.publicKey,
        systemId: framework.systemFly.programId,
        world: framework.worldPda,
        session,
        entities: [
          {
            entity: entity,
            components: [
              { componentId: framework.exampleComponentPosition.programId },
            ],
          },
        ],
      });
      await framework.provider.sendAndConfirm(applySystem.transaction, [
        session.signer,
      ]);
```

### 5.3 Why HEARTROT should skip it — the World-authority branch

Look again at the first branch of `update_with_session`. When a component's authority is
`World::id()`, **the only check is that the presented session token has not expired.**
There is no check that `session_token.session_signer == authority`, and no check that
the token belongs to the caller at all. Any unexpired session token from any user
satisfies it.

This is not a hidden exploit so much as a consequence of BOLT's design: a component
whose authority is `World::id()` is *permissionless by construction*. The plain
non-session `update` has the same shape —

```rust
require!(ctx.accounts.bolt_component.bolt_metadata.authority == World::id() || (ctx.accounts.bolt_component.bolt_metadata.authority == *ctx.accounts.authority.key && ctx.accounts.authority.is_signer), BoltError::InvalidAuthority);
```

— so a World-authority component is writable by any signer either way. **The session
token adds exactly zero authorization to a World-authority component.**

The alternative — setting each player component's `bolt_metadata.authority` to the
player — is worse for HEARTROT, because that authority is a fixed pubkey baked at
`initializeComponent` time and the design wants the *session* key to act. That is the
gap the session token is meant to fill, but it costs a base-layer PDA per player plus a
JIT clone into the ER on first use.

**So: all authorization in HEARTROT must live in the systems, exactly as spec §5 already
says.** BOLT systems do receive the signer — `bolt_system::cpi::accounts::BoltExecute`
is:

```rust
#[derive(Accounts, Clone)]
pub struct BoltExecute<'info> {
    /// CHECK: authority check
    #[account()]
    pub authority: AccountInfo<'info>,
}
```

and the world's `Apply`/`ApplyWithSession` declare `pub authority: Signer<'info>`, so by
the time a system runs, `authority` is a verified signer. The spec's
`require_keys_eq!(ctx.accounts.authority.key(), player_meta.session_pubkey)` is sound.

> Note it is `AccountInfo`, not `Signer`, inside the system. Assert
> `ctx.accounts.authority.is_signer` defensively in the system anyway — it costs one
> comparison and removes a whole class of "someone changed the world program" bug.

---

## 6. How this wires into the rest of HEARTROT

```
ONBOARDING (cold, one time, base layer)
  Privy sign-in  ──▶ identity
  browser        ──▶ crypto.subtle.generateKey Ed25519, extractable=false
                     store CryptoKeyPair in IndexedDB
                     export public key ──▶ sessionPubkey (32 bytes)
  POST /session/init { privyToken, sessionPubkey }      (a guest: { guest: {pubkey, ts, signature} } instead)
       Worker verifies Privy token, or the guest proof's Ed25519 signature
       Worker (treasury signs, treasury pays):
         AddEntity ─ InitializeComponent × N ─ set PlayerMeta.session_pubkey
         ─ delegate all player components to the ER
       ** no SOL is sent to sessionPubkey **

GAMEPLAY (hot, every tick, ER only, ZERO popups, ZERO lamports)
  browser builds tx { feePayer: sessionPubkey, ix: world.apply(Move|Shoot|EnterGate) }
  crypto.subtle.sign(Ed25519, privateKey, tx.serializeMessage())
  tx.addSignature(sessionPubkey, sig)
  erConnection.sendRawTransaction(..., { skipPreflight: true })
  system asserts: authority.is_signer && authority.key == PlayerMeta.session_pubkey

SETTLEMENT (cold, platform pays)
  BossTick crank detects win ─▶ Magic Action ─▶ base-layer commit + leaderboard
```

Changes this research implies to the frozen spec:

| Spec section | Change |
|---|---|
| §7 card 2, "Fund the session wallet" | **Delete the card.** Nothing to fund. Onboarding goes from three cards to two, or card 2 becomes the entity-creation loader. |
| §8, entire funding-tier ladder | **Delete**, conditional on the session key never signing base-layer. Keep the treasury only for the platform's own base-layer costs. Keep tier 1 ("connected wallet with SOL") *only* if you later want players to self-fund something — right now there is nothing to fund. |
| §7, "secret held in `localStorage`" | Change to a non-extractable `CryptoKey` in IndexedDB. Same UX, materially better blast radius. |
| §5, "Authority model" | Confirmed correct and *load-bearing*. Add the defensive `is_signer` assert. |
| §9, "browser → ER directly" | Confirmed correct and now also free. |
| §10 build order, step 4 | Step 4 shrinks from "session wallet + funding tiers + 3-card onboarding" to "session wallet + 2-card onboarding". Funding tiers were the risky part; they are gone. |

---

## 7. Security boundary: what a stolen session key gets an attacker

Assume the worst case actually reachable: an attacker fully compromises a player's
browser origin and extracts (or can drive) the session key.

**What they CAN do**

- Play as that player: move them, fire their hitscan shots, walk them onto the gate.
- Grief that specific player — walk them into bullets, waste their damage, ruin their
  leaderboard number.
- **Spam the ER for free.** Because ER fees are zero and the payer is never debited,
  there is *no economic rate limit whatsoever* on ER transactions. This is the real
  risk, and it is not specific to a stolen key — it is true of every session key,
  including honest ones. Anyone who learns a valid session pubkey's private half can
  flood the validator.
- Nothing that requires cross-checking against Privy, because the ER systems only see a
  pubkey.

**What they CANNOT do**

- Touch any SOL. The session wallet holds zero, by design, on both layers.
- Touch the user's Privy wallet or any external wallet.
- Write to any account that is not delegated (`InvalidWritableAccount`).
- Move lamports in or out of the session wallet on the ER (`InvalidAccountForFee`).
- Affect any other player's components — provided every system asserts against that
  player's own `PlayerMeta.session_pubkey`. **This assertion is the entire security
  perimeter of the game.** A single system that forgets it turns a stolen key into a
  cheat for the whole arena.
- Undelegate, commit, or settle — the platform holds delegation authority.

**Mitigations worth actually building**

1. Non-extractable key (§4.2). Converts a one-shot exfiltration into a
   "attacker must stay resident" problem, and kills the extension-reads-localStorage
   vector outright.
2. Per-player rate limiting **inside the system**, not at the RPC. `Combat.last_shot_tick`
   is already in the spec and already does this for shooting; make sure `Move` has an
   equivalent tick gate, otherwise a stolen key can spam `Move` at line rate.
3. Rotate the session key per match rather than per device. It costs one
   `PlayerMeta.session_pubkey` write on the ER (free, fast) and bounds a stolen key to
   one six-minute match.
4. Do not put the session pubkey in any public API response. It is not a secret, but
   there is no reason to hand a spammer the target list.

**What session *tokens* would add, honestly assessed:** on-chain expiry and a
revoke button. HEARTROT's key controls no assets and its matches last six minutes, so
expiry buys nothing that per-match rotation does not, and revocation has nothing to
protect. Correctly skipped.

---

## 8. Comparison to the wider Solana landscape

| Pattern | What it is | Fit for HEARTROT |
|---|---|---|
| **Bare session keypair + app-level authority field** (spec's choice) | Keypair in the browser; program stores the pubkey and checks the signer | **Best fit.** Zero extra accounts, zero rent, zero latency |
| **Gum / MagicBlock session tokens** | Keypair + on-chain `SessionToken` PDA with expiry + program scoping | Overkill here; adds a base-layer account and an ER clone per player |
| **Fee-payer sponsorship / relayer** | Solana has a native fee-payer field, so any account can pay for another; app builds tx, user signs, relayer co-signs and broadcasts | Standard answer to "gasless" on base layer. **Irrelevant on the ER**, where fees are already zero — and it would reintroduce exactly the backend round-trip spec §9 forbids |
| **Smart wallets with delegated signers** (Swig, Squads-style) | On-chain account with scoped delegate keys, spend limits, asset-class restrictions | Built for wallets holding value. HEARTROT's session key holds none |
| **Privy embedded wallet with `showWalletUIs: false`** | Sign through Privy's iframe with the modal suppressed | Achieves zero popups, but pays an iframe hop per signature. Wrong for a 400 ms tick |

The general Solana insight worth carrying: unlike EVM, gas sponsorship needs no
paymaster contract because the fee payer is a native transaction field. On the ER, even
that is moot.

---

## 9. Gotchas and failure modes

| # | Failure | Cause / fix |
|---|---|---|
| 1 | `InvalidAccountForFee` on an ER tx | An instruction mutated the fee payer. The session key is not delegated, so it is not `mutable`. Never debit/credit it on the ER |
| 2 | `InvalidWritableAccount` on an ER tx | Writing an account that is not `Delegated` or `Ephemeral`. Every component the tx touches must be delegated first |
| 3 | `requestAirdrop` fails on the ER | Deliberate: `Err(RpcError::invalid_request("free airdrop faucet is disabled"))`. Airdrops are base-layer only |
| 4 | You fund the session wallet "for ER fees" | There are none. You have created a drainable balance on the weakest key in the system for zero benefit. Also `createSession(top_up = true)` does this by default — pass `false` |
| 5 | `import { createSessionToken } from "@session-keys/anchor"` fails | That package does not exist on npm. Use `@magicblock-labs/gum-sdk` 3.0.10 |
| 6 | Session token appears to authorize, but does not | World-authority components accept *any* unexpired token (§5.3). Authorize in the system |
| 7 | Key vanishes; player loses their character | IndexedDB and localStorage are both evictable, per-browser, per-origin. Privy identity must be the durable record; the session pubkey must be re-registerable against the same Privy user, and `/session/init` must be idempotent on re-registration |
| 8 | Non-extractable key cannot be used with the Anchor/web3.js signer path | Correct — use `tx.addSignature(pubkey, sig)` after `crypto.subtle.sign` (§4.2) |
| 9 | Preflight failures on the ER | Use `skipPreflight: true`; standing MagicBlock guidance for ER transactions |
| 10 | Free ER spam | Zero fees means zero economic rate limit. Rate-limit per player *in the system*, using tick counters |
| 11 | Following the local `magicblock` skill's pinned versions | `~/.claude/skills/magicblock/resources.md` says `ephemeral-rollups-sdk` 0.14.3; crates.io and npm are both at **0.17.0**. The skill file is stale — update it |

---

## 10. Contradictions with the frozen design spec

1. **§8 in full, and §7 card 2.** "Funding is ~0.005 SOL per player, because … the
   session wallet only ever pays ER fees." ER fees are zero (§3). The four-tier funding
   ladder, the treasury drain cap for player funding, the browser-side airdrop and its
   per-IP reasoning, and the `GET /faucet/status` route all exist to solve a
   non-existent cost. This is the largest simplification available to the project and it
   removes the exact step §10 identifies as "where projects of this shape usually die."
   *(The treasury itself is still needed — for base-layer rent, delegation and commits,
   which the platform pays. Only the player-facing funding path goes away.)*

2. **§7, "secret held in `localStorage`."** Works, but is now the weaker of two
   universally-available options. Non-extractable WebCrypto Ed25519 is same-effort and
   strictly better (§4.2).

3. **§5, "The platform holds delegation authority … every player-facing system asserts
   `signer == player.session_pubkey`."** Not a contradiction — a confirmation, and a
   stronger one than the spec realises. BOLT's component-level authority gives you
   *nothing* here (§5.3), so this assertion is not defence-in-depth, it is the only
   defence. It should be written down as an invariant with a test per system, not as an
   implementation detail.

4. **§11, "BOLT over Pinocchio."** Outside my topic, but the version evidence is
   uncomfortable and it directly constrains everything above: `bolt-lang` 0.2.4 is from
   2025-07-23, 0.2.5 and 0.2.6 are **yanked** on crates.io, `@magicblock-labs/bolt-sdk`
   is 13 months stale, and the last non-README commit to the repo was 2025-10-19 — while
   `ephemeral-rollups-sdk` shipped 0.17.0 five days ago. BOLT also pins
   `session-keys = "^2"` against a current 3.1.1. Whoever owns the BOLT-vs-Pinocchio
   research topic should treat "is BOLT still maintained, and does 0.2.4 work against a
   0.14.11 validator" as the primary question, not a footnote.

---

## 11. Open questions

- Does `world::apply` (BOLT 0.2.4) function correctly against ER `magicblock-core`
  0.14.11? Untested here, and the 13-month version gap makes it a real question.
- Is there a per-connection or per-IP transaction rate limit on the public devnet ER?
  Nothing in the source read suggested one, and fees provide no backstop. **Confidence:
  low.** Worth measuring before assuming 20 players × several tx/sec is fine.
- Does the ER's JIT clone of a base-layer session-token PDA impose a first-use latency
  spike? Relevant only if the session-token route is taken, which §5.3 recommends
  against.
- Does `@coral-xyz/anchor` 0.32.1's transaction builder cleanly accept an externally
  attached signature for the fee payer, or does it try to sign? Needs a spike.
- Exact behaviour when a session pubkey is re-registered for an existing Privy user
  (device change, cleared storage): does `/session/init` update
  `PlayerMeta.session_pubkey` on the ER, or does it require an undelegate/redelegate
  cycle?

---

## Sources

Every URL below was actually fetched or probed during this research.

**MagicBlock validator and ER runtime (source read)**
- https://github.com/magicblock-labs/magicblock-validator (cloned, branch `dev`, 2026-08-31)
- https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/dev/magicblock-chainlink/src/chainlink/mod.rs
- https://github.com/magicblock-labs/magicblock-engine (cloned, tag `0.3.3`)
- https://github.com/magicblock-labs/magicblock-validator/pull/704
- https://github.com/magicblock-labs/magicblock-svm/pull/5

**Live RPC probes (2026-08-31)**
- https://devnet-as.magicblock.app/ — `getVersion`, `getFeeForMessage`, `getBalance`, `requestAirdrop`
- https://devnet.magicblock.app/ — `getVersion`
- https://devnet-router.magicblock.app/ — `getVersion`
- https://api.devnet.solana.com — `getFeeForMessage` (control)

**Session keys**
- https://github.com/magicblock-labs/session-keys
- https://raw.githubusercontent.com/magicblock-labs/session-keys/master/programs/gpl_session/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/session-keys/master/programs/gpl_session/macros/attribute/src/lib.rs
- https://raw.githubusercontent.com/magicblock-labs/session-keys/master/programs/gpl_session/macros/src/lib.rs
- https://crates.io/api/v1/crates/session-keys
- https://crates.io/api/v1/crates/session-keys-macros-attribute
- https://docs.magicblock.gg/pages/tools/session-keys/introduction
- https://docs.magicblock.gg/pages/tools/session-keys/integrating-sessions-in-your-program

**BOLT**
- https://github.com/magicblock-labs/bolt (cloned, branch `main`)
- https://raw.githubusercontent.com/magicblock-labs/bolt/main/Cargo.toml
- https://crates.io/api/v1/crates/bolt-lang
- https://registry.npmjs.org/@magicblock-labs/bolt-sdk

**Versions / registries**
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/ephemeral-vrf-sdk
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk
- https://registry.npmjs.org/@magicblock-labs/gum-sdk
- https://registry.npmjs.org/@solana/kit
- https://registry.npmjs.org/@solana/web3.js
- https://registry.npmjs.org/@privy-io/react-auth
- https://registry.npmjs.org/@privy-io/server-auth
- https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/lib/index.d.ts

**Client-side crypto**
- https://www.solanakit.com/docs/concepts/keypairs
- https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/generateKey
- https://blogs.igalia.com/jfernandez/2025/08/25/ed25519-support-lands-in-chrome-what-it-means-for-developers-and-the-web/
- https://blog.ipfs.tech/2025-08-ed25519/
- https://github.com/WICG/webcrypto-secure-curves/blob/main/explainer.md

**Privy**
- https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction

**Wider Solana patterns**
- https://www.helius.dev/blog/solana-smart-wallets
- https://www.openfort.io/blog/solana-gasless-transactions

**Local (not a URL, but consulted)**
- `/home/anshtyagi/.claude/skills/magicblock/` — `resources.md`, `lamports-topup.md`, `delegation.md`. Note: `resources.md` version table is stale (see §9 gotcha 11).
