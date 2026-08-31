# HEARTROT — Decisions, Risks, Build Order

**Date:** 2026-09-01
**Status:** Post-research, **re-verified 2026-09-01**. Supersedes parts of
`00-game-design-spec.md` — every supersession is listed explicitly in §1.
A second verification pass landed on five research docs *after* this document's
first draft; §1 D18/D19, §2.0 R0.4, and risks R4a/R4b/R15 carry those corrections.
**Inputs:** the 15 research docs under `docs/research/`.

This document exists to stop a week disappearing into something a one-hour spike
would have caught. It is deliberately blunt about what is likely to break.

**The three sentences that matter most:**

1. **BOLT is deprecated and does not compile.** The spec's entire on-chain
   foundation was retired by its authors on 2026-05-28, three months before the
   spec was written. Everything in §5 of the spec has to be re-cut against plain
   Anchor + `ephemeral-rollups-sdk` 0.17.0.
2. **The session wallet needs zero SOL.** ER fees are 0 and the ER runs no
   fee-payer validation at all. Spec §8's four-tier funding ladder solves a cost
   that does not exist — the riskiest step in the build order was the one that
   turned out to be unnecessary.
3. **"10 ms ER latency" is not a latency budget.** Real move-to-confirm from India
   is 136–196 ms. Client-side prediction is mandatory, not a polish item, and
   `Position` needs a sequence number to make it reconcilable.
4. **The ER caps a transaction at ~38 account keys and rejects address lookup
   tables outright.** Both are hard, unconditional, and undocumented. Together
   they make the account packing in D3 *mandatory rather than merely cheaper* —
   the spec's 20-separate-player-entities layout (~46 accounts) is rejected at
   every single crank tick and permanently kills the match ~26 s in.

---

## 1. DECISIONS

Settled by research. Each row names what was rejected and the evidence that
settles it. "Spec impact" says what in `00-game-design-spec.md` changes.

| # | Decision | Rejected alternative | Evidence | Spec impact |
|---|---|---|---|---|
| **D1** | **Drop BOLT.** One plain Anchor program against `ephemeral-rollups-sdk` 0.17.0. | MagicBlock BOLT ECS (spec §5). | README on `main`: *"Bolt has been deprecated and is no longer actively maintained"* (commit `71906078`, 2026-05-28). Last code commit 2025-10-19. `bolt-lang` 0.2.5/0.2.6 **yanked**; 0.2.4 **does not compile from crates.io** (reproduced three ways — bare `^0` requirements pull anchor-lang 0.31.1 + 0.32.1 + 1.1.2 simultaneously). All BOLT pages deleted from docs.magicblock.gg. `bolt-core.md`, `bolt-delegation.md`, `bolt-pinocchio-cpi.md` independently reached this. | **§5 rewritten.** ECS components become struct fields on ~4 accounts. §11 "BOLT over Pinocchio" is void — both premises were false. |
| **D2** | **No Pinocchio program in v1.** Single Anchor program owns all game state. | The user's proposed native Pinocchio program CPI-ing into BOLT. | Blocked twice over: Solana's owner rule, and BOLT's generated `component::update` asserting `get_instruction_relative(0).program_id == World::id()` — the instructions sysvar records only *top-level* instructions, so a Pinocchio-rooted transaction fails at any CPI depth. MagicBlock's own PR #196 says it is *"impossible to CPI the World program"*; PR #213 reverted the fix, which shipped only in the yanked releases. Independently, the CU case is negative: one CPI hop is 946–2,500 CU to save ~500 CU of framework overhead. | §11's Pinocchio paragraph is **factually wrong** and must be replaced — `ephemeral-rollups-pinocchio` 0.17.0 shipped 2026-08-26 with delegate/commit/undelegate/crank/VRF/Magic Actions. The *conclusion* survives; every stated reason for it does not. |
| **D3** | **~4 accounts, not 86.** `Arena` (state + 128-bullet pool), `Boss` (position + parts + core + bossstate), `Players[20]` packed into one account, `Leaderboard`. | Per-entity-per-component PDAs (BOLT's model). | Delegation is one explicit instruction per *component account* with no auto-delegation. BOLT's decomposition = 86 PDAs = ~18–22 base-layer transactions at match start, 344 accounts, ~0.0258 SOL/match in session fees (300,000 lamports **per account**, confirmed in `devnet-faucet.md` from `process_delegation_cleanup`). **Decisively: the ER rejects any transaction with `program_id_index >= 38`** (`validate_supported_transaction_shape`, unconditional, two unit tests on the 37/38 boundary). Solana's message compiler sorts program ids *last*, so for a write-heavy transaction that collapses to a **~38 total-account-key ceiling**. Crank account lists are frozen at schedule time and the crank transaction goes through the same `prepare_transaction` path, so a ~46-account layout is rejected **at every tick**, burns the 10-retry ladder, and permanently deletes the task ~26 s into the match. `MAX_TX_ACCOUNT_LOCKS` (64) is *not* enforced by the ER (`get_account_locks_unchecked()`) — the 38 is the only real ceiling and it is tighter. 40 account deserializations would also dominate a 400 K CU tick. | §5's component tree survives as struct fields. Delegation cost drops ~20×. |
| **D4** | **Backend is TypeScript** (`@solana/kit` 8.2.0), in the same Worker as the frontend. | A separate Rust Worker. | Rust was **proven to work** end-to-end (a Worker under workerd loaded a treasury key, signed a System transfer, self-verified, and Node independently verified the signature) — and is still the wrong call. `solana-client` does not build for wasm32 (48 `mio` errors), so JSON-RPC is hand-rolled; and a Rust backend cannot live inside the JS frontend Worker, so it becomes a second deployable. workerd's WebCrypto does native BoringSSL Ed25519, so there is no cryptographic reason for Rust. `workers-rust.md` (verification stage), `workers-ts-solana.md`. | **Confirms spec §9.** No change. `workers-rust.md` is kept as proof-on-file if a CPU-bound cold path ever appears. |
| **D5** | **Vite + React SPA on Workers static assets + one Worker for the 4 routes.** Drop Next.js. ⚠️ **Needs user sign-off — this amends a frozen spec line.** | Next.js via vinext (spec §9); Next.js via OpenNext. | Cloudflare *does* now recommend vinext over OpenNext, verbatim — the spec is right about that. But vinext is `1.0.0-beta.8`, ~6 months old, weekly beta cadence, no GA date, with four open Cloudflare-specific issues, and its own README says *"If you need a mature, well-tested way to run Next.js outside Vercel, OpenNext is the safer choice."* Decisive: *"vinext server-renders all pages on each request"* — every load of our static game shell becomes a billed Worker invocation, while Cloudflare docs state *"Requests to static assets are free and unlimited."* The build-time-prerender escape hatch is blocked by open issue #2911 (any server module importing `cloudflare:workers` crashes prerender — exactly our 4 route handlers). HEARTROT uses essentially none of the Next.js API surface. `not_found_handling: "single-page-application"` + `run_worker_first: ["/api/*"]` is verbatim Cloudflare's own documented SPA pattern, and it **structurally enforces** the spec's "gameplay never touches the backend" rule. | **§9 stack line changes.** Route-handler *bodies* are byte-identical either way, so this is reversible cheaply if overridden. If overridden: vinext, not OpenNext. |
| **D6** | **Session wallet needs zero SOL. Delete the funding tiers.** | Spec §8's four-tier ladder + `/faucet/status` as a player-funding gate. | ER transaction fee is **0**, verified three ways: the validator's `getFeeForMessage` returns a hardcoded `0_u64`; `validate_transaction_fee_payer` has been **deleted** from the vendored SVM (magicblock-engine 0.3.3); and a live probe with a freshly-random never-existent pubkey as fee payer *executed* (reached instruction 0, failed only on the transfer amount). Base layer rejects the identical transaction with `AccountNotFound`. `session-keys.md` and `devnet-faucet.md` reached this independently. | **§8 deleted.** §7 card 2 deleted (onboarding drops to two cards). §10 step 4 loses its risky half. `/faucet/status` becomes a *treasury* gauge (reads rate-limit headers via `getHealth`, which is free). Route count stays 4. |
| **D7** | **Privy is identity only.** JWT verified in the Worker with `jose` + JWKS. No Privy SDK in the Worker, no Privy signature anywhere. | Privy signing gameplay or setup transactions. | Access token is a plain ES256 JWT (`iss privy.io`, `aud` = appId) against a **public** JWKS at `https://api.privy.io/v1/apps/{appId}/jwks.json` — probed directly, no auth header needed. ~10 lines with `jose`. Privy's fastest signing path is a cross-origin iframe round trip; its TEE path is an internet RTT; and signatures are metered at **$0.01 each above 50K/month** — 20 players at gameplay rates burn the free tier in under an hour. | §7 unchanged in shape. Use `@privy-io/node` 0.34.0, **not** `@privy-io/server-auth` (last stable 2025-09-17, effectively abandoned) — or skip both and use `jose` directly. |
| **D8** | **Session key = non-extractable WebCrypto Ed25519 in IndexedDB.** | `localStorage` secret (spec §7). | `crypto.subtle.generateKey({name:'Ed25519'}, false, ...)` is available in every engine (Firefox 129, Safari 17, Chrome 137). `CryptoKey` is structured-cloneable so it persists in IndexedDB. Same effort; removes one-shot key exfiltration via XSS. Bridge to web3.js via `tx.addSignature(pubkey, sig)`. | §7 wording change only. |
| **D9** | **Pure-SVG path rig, one `<g>` per part.** Sprites stay as px2svg paths. | Spec §6's `<image>`-per-part raster rig. | Measured on the real `boss.svg`: **7,589 rects in 8 groups animating `transform` ran at 143.3 fps** (median 6.9 ms, zero frames >20 ms) — identical to static — on *software GL*. The same DOM animating `fill-opacity` collapsed to 74.8 fps. Source-verified in Blink: `ObjectTypeSupportsCompositedTransformAnimation` admits `<g>`; the group gets its own `cc::Layer` and rects rasterise once. Spec §6 rule 2 conflates *rects* with *animated nodes* — rects inside a group are never animated individually. | **§6 rule 2's performance argument is refuted.** The separate art-fidelity objection ("does not match the reference art") is not a performance question and is still open — see Q7. |
| **D10** | **One crank per match**, 400 ms, `iterations` covering the full match, `task_id` = wide random positive **i64** stored on `ArenaState`. | `taskId: 1` (the official example's value); re-arming cranks. | `task_id` is a validator-**global** namespace; a collision fails *silently after your CPI returned Ok*, recorded only to a local `failed_scheduling` table. A crank **cannot re-arm itself** (`ScheduleTask`'s payer meta is a writable signer; crank instructions may carry no writable signers). `iterations` is i64 with no upper bound — 90,000 covers ~10 h. Args are **i64**, not u64 as the docs and the local skill say. Use `ephemeral_rollups_sdk::crank::ScheduleCrankCpi`, not hand-rolled bincode. | §5 crank paragraph gains `task_id` and the cancel-before-undelegate ordering. |
| **D11** | **VRF: one draw per incarnation, requested from the killing-blow player transaction**, hash-expanded per tick for bullet patterns. | The crank requesting VRF (implied by spec §5's crank-owns-the-boss model); per-tick VRF. | `validate_cranks_instructions` rejects any scheduled instruction carrying a signer other than the read-only crank signer PDA; the VRF request needs `AccountMeta::new(payer, true)` — a writable signer. Both doors shut. The killing-blow tx is already signed by the session keypair, so still zero popups. In-ER VRF is **free** (`is_fee_exempt_ephemeral_queue`). Per-tick VRF is structurally impossible: never same-slot fulfilment, 240-slot TTL, callback/crank account contention. | §5 and §12's VRF item. Store `affix_seed: [u8;32]` on `ArenaState`; `tick_entropy = hashv([affix_seed, tick])`. |
| **D12** | **Magic Action settlement fires from the crank via a delegated PDA fee payer + `magic_fee_vault`.** `/match/settle` stays and is now load-bearing, not a fallback. | The spec's implicit "crank fires a Magic Action" with no extra accounts; treating commit success as proof the leaderboard was written. | A crank **can** fire one (`validate_cranks_instructions`'s blocklist covers only account-cloning/program-management; it never inspects nested CPIs). But it needs a *delegated* PDA payer (writable non-delegated accounts are rejected: `InvalidWritableAccount`), which makes `magic_fee_vault` mandatory (`try_get_fee_vault` returns `Some` only when `payer.delegated() && !payer.confined()`), which makes `lamportsDelegatedTransferIx` the required top-up path. Plus the undocumented `as_signer` workaround and the "never put the fee payer in the committee set" `IllegalOwner` trap. And atomicity is weaker than assumed — a failing BaseAction can be *removed* and the commit retried without it. | §5 settlement paragraph gains ~4 accounts. §9's `/match/settle` description changes from "fallback" to "the recovery path the design depends on". Leaderboard write must be **idempotent** keyed by `(incarnation, arena)`. |
| **D13** | **One validator per match** (`devnet-as` / `MAS1Dt9…`, Singapore). Identity stored on `ArenaState`. Router for subscriptions, direct ER for sends. | Per-client ER discovery; using the router as a drop-in `Connection`. | `Resolver.resolveForTransaction` returns a bare `undefined` when writable accounts span two validators. Reading a delegated account from the **wrong ER returns correctly-owned but silently frozen data** with zero errors and zero WS notifications — the owner-check heuristic cannot detect it. Router adds **~0 ms** in steady state (p50 −4 ms over 488 matched slots) and transparently proxies `accountSubscribe`. But plain `getLatestBlockhash` on the router returns an **ER** blockhash — using it for a base-layer tx signs against the wrong chain. | **`ArenaState` gains `validator_identity`.** `/match/start` and `/session/init` return the resolved fqdn. Not a fifth route. |
| **D14** | **Client-side prediction is mandatory. `Position` gains `last_seq: u16`.** | Rendering purely from authoritative ER state. | Measured RTT India→devnet-as: **196 ms median / 136 ms min**. Move-to-confirm is RTT + one 50 ms block. Spec §10 step 2's gate "it feels instant" cannot be met by the ER alone. Without a sequence number an arriving `Position` is ambiguous as to which input it reflects — the symptom is rubber-banding, and retrofitting it later is far more expensive than 2 bytes now. | §5 `Position`. §10 step 2's gate. **§9's "10 ms" must never be used as a latency budget anywhere.** |
| **D15** | **Paid RPC provider for the Worker's base-layer calls.** | `api.devnet.solana.com` from the Worker. | Returned **HTTP 403** `"Your IP or provider is blocked from this endpoint"` to a Worker while the identical POST from the host shell returned 200. | §9 secrets table gains an RPC key. Browser-side calls are unaffected. |
| **D16** | **Rate limiting lives inside the program, as tick counters.** | Relying on transaction fees as the economic backstop. | Zero fees means zero rate limit. Nothing debits the payer, so any keypair can flood the ER for free. `Combat.last_shot_tick` already does this for `Shoot`; `Move` needs the equivalent. | §5. New invariant test per system. |
| **D17** | **Every system asserts `authority.is_signer && authority.key() == player.session_pubkey`.** | Treating that check as defence-in-depth on top of framework authority. | Under BOLT it was the *entire* perimeter (World-authority components are writable by any signer). Under D1's single Anchor program it becomes a normal `has_one` + `Signer` constraint — which is strictly better, but it is still the only thing standing between a stolen key and an arena-wide cheat. One forgotten check is a full compromise. | §5 authority model. Needs a per-system invariant test. |
| **D18** | **No HEARTROT transaction sent to the ER may carry an address lookup table.** v0 transactions are fine; ALTs are not. | Using ALTs to fit large account lists — the standard Solana answer to exactly the problem D3 solves. | `validate_supported_transaction_shape` returns *"v0 transactions with address lookup tables are not supported"* with **no feature flag**. This is project-wide: gameplay transactions, the crank's scheduled instruction, and settlement all hit the same path. It also means the ~38-key ceiling in D3 has **no escape hatch** — packing is the only lever. | **New constraint, absent from the spec entirely.** Any client code that reaches for `AddressLookupTableAccount` is wrong by construction. |
| **D19** | **Accept Privy's TEE default for embedded wallets. Change no wallet-mode setting.** | Requesting `legacy-embedded-wallets-only` (on-device) — which the first research pass recommended. | Privy's docs: *"By default, Privy uses trusted execution environments (TEEs)… On-device execution is an advanced configuration. Please reach out to enable this setting."* On-device→TEE migration is explicitly **one-way**. Requesting on-device means opening a Privy support ticket on a grant deadline — for a benefit of exactly zero, because D7 already decided HEARTROT takes **no Privy signature at all**. | §7. One less thing to configure. The reversed recommendation is recorded so nobody re-derives the wrong answer from the research doc's first draft. |

---

## 2. RISK REGISTER

### 2.0 Refuted during verification — do NOT design around these

These were load-bearing claims in the first research pass that the verification
stage killed. They are listed first because acting on any of them wastes time
solving a non-problem, or (worse) builds a mitigation for a failure mode that
does not exist while the real one goes unhandled.

| # | Claim | Status | What is actually true |
|---|---|---|---|
| R0.1 | "The deployed devnet validator cannot see crank execution failures — a reverting BossTick is recorded as SUCCESS and the game silently freezes while transactions keep flowing." | **REFUTED** | `solana_rpc_client`'s `send_transaction` sends `skip_preflight: false`, and the ER's handler routes that to `scheduler.execute().await?`, which propagates failures. The repo's own `test_schedule_error.rs` **at the deployed commit** asserts a failing task lands in `failed_tasks` with its counter never incremented. |
| R0.2 | "The 10-retry-then-permanent-death policy is an unreleased dev-branch change, so the two versions fail in opposite directions." | **REFUTED** | `MAX_TASK_EXECUTION_RETRIES = 10`, 100 ms base doubling, 5 s cap, and the `failed_tasks` move are **all present in deployed 0.14.11**. Both versions behave identically: ~26.3 s of retries, then permanent death. **Design the watchdog for this, not for the phantom "ticks forever" mode.** |
| R0.3 | "Crank CU ceiling could be anywhere from a few thousand to 400 K." | **RESOLVED → 400,000 CU** | `magicblock-processor` calls stock Agave `process_compute_budget_instructions` with no override. Neither `Magic111…` nor `Crank111…` is in Agave's compile-time builtin cost table, so both crank instructions classify `NotBuiltin` → 2 × 200,000. (The research doc's stated reasoning was wrong — `ExecuteCrank` is built against `CRANK_PROGRAM_ID`, not the Magic program — but the result is unaffected, since neither is a builtin.) Bullets[128] is very likely fine. Still measure (SP2) — but the panic is over. |
| R0.4 | "The 1232-byte transaction cap hard-blocks the 20-player crank account list." | **REFUTED — but the real limit is *tighter*, and the first correction was also wrong** | Two rounds of correction, so read this one carefully. (a) The 1232-byte claim is wrong: `prepare_transaction` does base58/base64 decode + bincode deserialize with **no size check**, and 1232 is a UDP/QUIC packet constraint while the ER is reached over HTTP JSON-RPC. (b) The *first* verification pass then said "the nearest real ceilings are `MAX_TX_ACCOUNT_LOCKS` (64) and a 38-entry table… 46 accounts is in the danger zone but not provably fatal." **That is wrong in both directions.** `MAX_TX_ACCOUNT_LOCKS` is **not enforced** by the ER (`get_account_locks_unchecked()`). The 38-entry limit **is** enforced unconditionally, and because program ids sort last in a compiled message it is effectively a **~38 total-account-key ceiling**. A ~46-account layout is therefore **provably fatal**, not borderline: rejected every tick, retry ladder burned, task deleted ~26 s in. D3's packing is **mandatory**. See also D18 — ALTs cannot rescue it. |
| R0.5 | "A validator restart loses your crank with zero signal." | **OVERSTATED** | `TaskSchedulerService::start()` calls `load_persisted_tasks()` and re-queues every row, clamping the first re-fire to 2× slot interval. Loss requires `reset=true`, a different validator, or disk loss. |
| R0.6 | "The Magic Router costs ~840 ms extra on first-notification latency." | **DID NOT REPRODUCE** | Measured ~70 ms setup and steady-state **p50 −4 ms** over 488 matched slots. Use the router for subscriptions. Do not put 840 ms in any budget. |
| R0.7 | "`output: 'export'` cannot host route handlers at all." | **REFUTED (narrower)** | Static export supports `GET` handlers marked `force-static`. The real ban is on handlers that *read* `Request`. HEARTROT's conclusion is unchanged (all 4 routes read the request) but the stated rule was wrong. |
| R0.8 | "Privy's zero-popup signing is one config line." | **INCOMPLETE — and this one could still bite** | `showWalletUIs: false` removes the modal, but the legacy headless path first runs `initializeWalletProxy(15_000)` and `recoverEmbeddedWallet()`. So the **first** signature of a session has a **15-second ceiling**, and with user-controlled recovery it **throws with no modal fallback**. Moot under D7 (we never sign with Privy) — but if anyone reintroduces a Privy signature, this is the trap. **Note it describes the *legacy on-device* path, which per D19 is not even the default** and cannot be enabled without emailing Privy. |
| R0.9 | "Omitting `solana.rpcs` makes Privy fall back to its hosted RPCs, reintroducing the shared-IP airdrop problem." | **REFUTED** | `defaultSolanaRpcsPlugin` is opt-in; without it `useSolanaRpcClient` throws. There is no default. Just do not register the plugin. |
| R0.10 | "The Cloudflare Rate Limiting binding is GA." | **UNVERIFIED** | The docs page carries no stability label at all. The `wrangler >= 4.36.0` requirement is real, and so is the load-bearing fact: **it is per-Cloudflare-location, not global.** |
| R0.11 | `workers-rust.md`'s bundle sizes (450,913 B raw / 181,001 B gzip). | **WRONG by ~35%** | Clean rebuild: 613,046 B / 238,863 B. Conclusion ("size is a non-issue") survives; the numbers did not. Also: the doc's §2 listed `solana-pubkey`/`solana-hash` backwards, and its "verbatim" config files were not the files on disk. Treat that doc's *narrative* as sound and its *numbers* as suspect. |
| R0.12 | "The `api.devnet.solana.com` 403 is our ISP being IP-blocked, so it says nothing about how a *deployed* Worker will behave." | **REFUTED, and it points the wrong way** | Same machine, same IP, same minute: the Worker's `fetch` got 403 three times while plain `curl` got **HTTP 200** with a live blockhash. An IP block cannot produce that asymmetry. `curl` was re-run in seven header shapes (empty UA, `UA=undici`, `UA=Cloudflare-Workers`, forced HTTP/1.1, …) and **all seven returned 200**, exhausting the header hypothesis. The block keys on the **workerd request shape** (most likely TLS/ALPN fingerprint), not the IP. Consequence: a deployed Worker runs the same runtime **and** egresses from Cloudflare IPs, so it is **more** likely to be blocked, not less. **D15 (paid RPC) is mandatory, not prudent.** |
| R0.13 | "Six consecutive 200 OK at 298–459 ms" for the Worker's hand-rolled JSON-RPC helper. | **DOES NOT REPRODUCE** | Those figures were taken against `api.devnet.solana.com`, which now 403s the Worker every time (484–995 ms). The *capability* claim survives — re-verified against `rpc.magicblock.app/devnet` and Helius — but do not put those latency numbers in any budget. Related: Helius's keyless endpoint returns `{"result":"ok"}` for `getHealth`, so "it rejects keyless calls" is **not** a usable health signal. |

### 2.1 Live risks, ranked

Ranked by likelihood × blast radius. "Cheap experiment" is the earliest thing
that proves or kills it.

| # | Risk | Likelihood | Blast radius | Cheapest experiment | Fallback |
|---|---|---|---|---|---|
| **R1** | **Building anything on BOLT.** Deprecated, non-compiling, 16 deploys, 1024-byte return-data ceiling that `Bullets[128]` (936 B) already fills. | **Certain** if the spec is followed as written | **Total.** Weeks lost to dependency pinning and a BossTick redesign, on a framework whose author moved on. | Already done — three independent research passes. `cargo add bolt-lang && cargo check` reconfirms in 5 minutes. | **D1.** Plain Anchor + ER SDK 0.17.0. This is not a fallback, it is the plan. |
| **R2** | **Wrong-ER subscription.** A client resolving to a different validator than the match was delegated to sees a **completely frozen boss, zero console errors, zero WS notifications**. | High in a 10–20 player raid unless explicitly handled | Severe and *invisible* — looks like a game bug, not a config bug. Will be diagnosed as "the chain is slow". | Subscribe to a known-delegated account on the wrong ER for 15 s; count notifications (expect 0, no error, socket stays open). Already done once — it reproduces. | Pin `validator_identity` on `ArenaState` (D13); every client reads it, never discovers. `ArenaState.tick` watchdog (R6) catches it anyway. |
| **R3** | **Magic Action from the crank does not work first try.** Needs a delegated PDA payer, `magic_fee_vault`, the payer's delegation record, `program_id` in the commit context, a lamports top-up path, and the **undocumented `as_signer` workaround** (`MagicIntentBundleBuilder::build()` copies `is_signer` verbatim, so a crank's PDA payer arrives `is_signer:false` and Magic rejects with `MissingRequiredSignature`). Plus the `IllegalOwner` trap if the fee payer ends up in the committee set. | **High** | 3–5 days of blind debugging. Each of these is individually a multi-day hole. | **SP5.** Standalone: schedule a crank that commits one account and writes one base-layer counter. Pass = the counter increments on base layer. | `/match/settle` called from the client on win detection. Slower, one extra round trip, and it already exists in the spec. Ship on this if SP5 costs more than a day. |
| **R4** | **`Position` ships without `last_seq`.** Prediction becomes unreconcilable. | Certain if not decided now | Rubber-banding for every player, and the fix is a program redeploy + full redelegate mid-project. | Zero — it is a 2-byte field decision. | None. Add it in slice 1. Costs <1% of a notification. |
| **R4a** | **workerd's WebCrypto refuses `importKey("raw", …)` for an Ed25519 *private* key.** The obvious three-line way to load a 32-byte treasury seed in the Worker **works in Node and fails in workerd**. workerd's `importEddsa` restricts `format == "raw"` to `CryptoKeyUsageSet::verify()` — public keys only. | **Certain** if hand-rolled | Medium but *maximally annoying*: the failure appears only when running under workerd, so a local Node test suite passes and the Worker 500s. Classic day-lost bug. | **SP11.** One `importKey` call under `wrangler dev`. 15 minutes. | Use `@solana/kit`'s pkcs8 path (`createKeyPairFromPrivateKeyBytes`) — it is the reason kit works on Workers at all. If hand-rolling, prepend the DER header `302e020100300506032b657004220420` and import as `pkcs8`. Same trap applies to the browser session key (D8) on any engine that follows the same rule. |
| **R4b** | **Someone reaches for an address lookup table** to fit a large account list — the standard Solana move, and the exact thing D3's ~38-key ceiling appears to call for. | Medium–high | The transaction is rejected by the ER outright with no feature flag and no fallback. Wasted redesign in whichever direction it is discovered. | Free — send one ALT-bearing v0 transaction to the ER in SP1. | **D18.** There is no workaround. Pack accounts (D3); that is the only lever. |
| **R5** | **Real BossTick exceeds the 400 K CU crank budget.** No `ComputeBudget` instruction is attached to the crank transaction and **you do not construct it**, so the ceiling is fixed and unraisable. 128 bullets × 20 players = 2,560 pair checks. | Medium | The boss stops fighting after 10 retries (~26.3 s) and the task is deleted **permanently**. Match is dead. | **SP2**, then measure the real tick in slice 2 from the crank transaction's `consumed X of Y` log line. | Bitboard the bullet-active mask and per-zone player occupancy (the user has done exactly this before on a 4,096-cell automaton). Then: 64 bullets instead of 128. Then: split into two crank instructions. |
| **R6** | **Silently dead game loop.** 10 failures → task moved to `failed_tasks` and it never ticks again. There is **no RPC to query task liveness**. | Medium | Match freezes with no signal to anyone. | Free — comes with slice 2. Kill the crank's target account mid-run and watch. | **Two-threshold client watchdog on `ArenaState.tick`: 3 s soft (show "reconnecting"), 45 s hard (call `/match/settle`).** A single 3 s trigger would settle matches that were about to recover from the retry ladder. **Use 45 s, not 30 s:** the ~26.3 s figure counts only the sleeps between the 11 attempts, excludes each attempt's execution round-trip, and the ladder's base term is `slot_interval.max(100ms)` — a validator with a slower slot stretches it. MagicBlock's own `test_schedule_error.rs` polls up to **45 s** before asserting the task is dead. |
| **R7** | **Browser zoom kills SVG compositing.** `EffectiveZoom() != 1` disqualifies SVG transform animations from the compositor **outright**. A player at 110 % silently gets a main-thread rig. | Medium (users do zoom) | Framerate collapse for an unknown fraction of players. **No CSS workaround. Invisible in local testing at 100 %.** | **SP6b.** Load the rig prototype at 110 % zoom, measure fps. 10 minutes. | Animate an HTML `<div>` wrapper per part instead of a `<g>`. Structural change — decide before the rig is built, not after. |
| **R8** | **All rendering measurements were on software GL** (`--enable-unsafe-swiftshader`), no phone tested. The `will-change: transform` recommendation for 128 bullets **directly contradicts MDN's blanket guidance** and won 44 fps on a machine where GPU memory was not the binding constraint. On a phone it could invert. | Medium | The bullet-hell layer — the visual core of the game — janks on real devices. | **SP6a.** Open the existing prototype on hardware GL and on a mid-range Android. 30 minutes. | Drop to 64 bullets (also helps R5). The canvas-overlay alternative measured *worse* (58 fps regardless of draw count) but that too was software GL — re-test it if SVG loses. |
| **R9** | **Latency feel.** 136–196 ms move-to-confirm from India. Spec step 2's gate is "it feels instant". | High that naive rendering fails the gate | Step 2 stalls; the whole build order backs up behind it. | **SP4.** Measure own-account write→`accountSubscribe` delivery once slice 1 exists. This is the single most important number for tuning prediction. | Prediction + reconciliation for own player; interpolate other players ~1 update behind (**never extrapolate** — they stop, you overshoot, you snap); extrapolate bullets exactly (integer `{x,y,dx,dy}` + fixed integer step = zero prediction error). |
| **R10** | **Reconnect blindness.** A dropped socket = **measured 1,681 ms** of blind gameplay = 4 missed crank ticks. Notifications resume only on the **next write** — subscribing delivers nothing about current state, so a player standing still sees a stale world forever. | High over a 6-minute match | Player is probably dead, and visibly teleports when state resumes. | Free — kill a socket in slice 3. Already reproduced. | **Mandatory explicit `getMultipleAccounts` snapshot on every WS `open`.** Not an optimisation. Plus a reconnecting overlay. |
| **R11** | **Thundering herd on reconnect.** web3.js retries at a **fixed 1000 ms with no jitter or backoff**, and `_updateSubscriptions` retries a *failed* subscribe with **zero delay, recursing immediately** (upstream comment: `// TODO: Maybe add an errored state or a retry limit?`). 20 clients retry in lockstep. | Medium | Hot CPU loop against a sick ER; 20 clients hammering it in unison. | Kill the ER connection for 20 s with 3 clients open; watch the retry pattern. | Own the socket lifecycle instead of letting `Connection` manage it. Add jitter. |
| **R12** | **Zero fees = zero rate limit.** Any keypair can flood the ER for free. | Medium (devnet, low profile — but trivial to do) | Arena-wide degradation for everyone in the match. | Script 500 tx/s at a test arena from one keypair. | **D16.** Tick counters per player inside every system. `Combat.last_shot_tick` is the existing pattern. |
| **R13** | **One forgotten `signer == session_pubkey` check** turns a stolen or guessed key into an arena-wide cheat. | Medium (7 systems, human error) | Full compromise of match integrity. | A test per system that asserts a foreign signer is rejected. Cheap, and it is the only real defence. | None. Write the invariant tests in slice 1 when there are 2 systems, not in slice 6 when there are 7. |
| **R14** | **Unauthenticated `delegate`/`undelegate`** (if any BOLT-era delegation code survives): **anyone can undelegate `ArenaState` mid-raid**, stalling every player at once. Also: an attacker can delegate our accounts to *their* validator first, after which our own delegate call fails. | Low–medium | Match-killing grief, unfixable without forking. | Call `undelegate` on our own delegated account from an unrelated keypair. 15 minutes. | Under D1 we control the program, so re-check whether the current `ephemeral-rollups-sdk` 0.17.0 delegate path is authenticated. **This is an open question (Q4), not a settled risk.** |
| **R15** | **Frozen crank account list.** The crank can *never* see an account it was not given at schedule time, so all 20 player slots must exist before scheduling. Lazy join is structurally impossible without cancel + reschedule. | Certain (design constraint, not a bug) | Match-start UX and the 20-player target. | Free — falls out of D3's packing. | D3 makes this a non-issue: one `Players[20]` account is *one* meta. This is the strongest argument for the packing — and per the R0.4 correction it is no longer merely an argument but a **hard requirement**, since ~46 metas breaches the ER's ~38-key ceiling and kills the task every tick. |
| **R16** | **Sub-pixel shimmer** at fractional `devicePixelRatio`. Test machine reported dpr 1.1875; `crispEdges` snaps to the device grid giving alternating 4/5-device-px sprite pixels. | Medium | Cosmetic but very visible on pixel art — the thing the whole art direction rests on. | **SP6c.** Screenshot-diff at dpr 1.25 and 1.5. The claim is arithmetic-derived; the browser crashed before visual confirmation. | Size the SVG so `cssScale × devicePixelRatio` is an integer. |
| **R17** | **`transform-box: fill-box` pivot drift.** SVG 2 defines a container's bbox as the union over descendants **with their transforms applied**. The current `app/rig-prototype.html` uses `fill-box` + percentage origins — correct for a flat rig, a latent bug the moment an animated wrapper `<g>` (screen shake, knockback, incarnation entrance) wraps animated parts. | Medium | "The crown pivots wrong when the mace swings." Painful to diagnose. | Wrap the rig in an animated `<g>` and look. 10 minutes. | Leave `transform-box` at its `view-box` default and emit **absolute origins in viewBox units** — which the slicer already produces. |
| **R18** | **vinext beta churn** (only if D5 is overridden). `1.0.0-beta.8`, weekly cadence, no GA date, four open Cloudflare-specific issues including #2965 (the scaffolded deploy script points at the wrong path and cannot work). | High, if that path is taken | Weeks of upstream tracking during the grant period, for zero product benefit. | `vinext init --platform cloudflare` and try to deploy. 1 hour. | **D5** — the Vite SPA. Route bodies are identical, so this stays cheap to reverse either way. |
| **R19** | **Worker CPU limit** (10 ms/request on Free). Constructing an Anchor `Program` per request parses the whole IDL — a realistic overrun. | Medium on Free, zero on Paid | 4 cold routes start 500ing under load. | Time one `/match/start` locally with `wrangler dev`. | Keep Anchor out of the Worker (`BorshCoder` directly, or a Codama-generated kit client), or go Paid. **Do NOT cache a `Program` in a module-level variable** — that is request-scoped state in global scope and it leaks across requests. |
| **R20** | **Treasury refill ceiling.** 1 airdrop per IP per 24 h, keyed on **IP not address**, and a *failed* airdrop still burns the quota. ~50 matches/day from one box. | Certain | Fine for a grant demo, fatal for an open beta. **Also: a co-located 10–20 player lobby behind one wifi/CGNAT shares ONE airdrop between them.** | Already measured (this machine's quota is spent). | D6 removes player funding entirely, so this only limits *our* treasury refill. Pre-load the treasury before demo day. |
| **R21** | **ER fee = 0 is described as "current release."** If MagicBlock enables ER fees, the zero-SOL session wallet assumption breaks **everywhere simultaneously**. | Low | Total onboarding rework. | **SP9** — an integration test asserting `getFeeForMessage == 0`, run in CI. | The deleted funding tiers come back. Keep §8 in git history rather than deleting the text outright. |
| **R22** | **Local skills are materially stale and will produce non-compiling code.** `magicblock` skill: ER SDK 0.14.3 (actual 0.17.0), `ephemeral-vrf-sdk` 0.3.0 (**yanked**), u64 crank args (actual i64), hand-rolled bincode (superseded by `ScheduleCrankCpi`), deprecated global `VRF_PROGRAM_IDENTITY`, a `wss://` value in a field that throws on non-http. `pinocchio-development` skill: documents 0.10 API (`AccountInfo`/`Pubkey`/`key()`), all renamed in 0.11 (`AccountView`/`Address`/`address()`). | **Certain** if followed | A debugging session per skill, with misleading name-resolution errors rather than a "wrong version" signal. | None needed — verified across four research docs. | **Update both skills before slice 1.** Cheapest fix on this whole list. |
| **R23** | **Docs actively lie.** The official VRF quickstart and reference program call `create_request_scoped_randomness_ix`, **which does not exist in 0.17.0** (they pin a git rev). Worse: `create_request_randomness_ix` **inverted meaning** between that rev (legacy global identity) and 0.17.0 (scoped) — old copy-pasted code compiles cleanly while **silently changing the security model**. The crank docs declare u64 where source is i64. The Bolt Book documents "v0.1.0" against a v0.2.6 codebase. | High | Silent security downgrade; wasted debugging. | Read `docs.rs` for the published crate, never the docs page. | Pin exact versions; verify every API against docs.rs at the pinned version before use. |
| **R24** | **A callback that errors is a 240-slot retry loop, not a dropped roll.** `provide_randomness` invokes the callback with `?`, so an error reverts the queue removal. Any `require!` on state a concurrent player tx changed, or `random_u8_with_range`'s `assert`, bricks the incarnation roll for ~2 minutes. | Medium | The boss never respawns. Match loop dead. | Deliberately panic in the callback on devnet and watch. | **Callbacks must be total — log-and-`Ok` on unexpected state, never `require!`.** Also note `rnd` helpers read *overlapping* byte offsets, so successive calls on one seed are **correlated**; only `random_u8_with_range` is unbiased. |
| **R25** | **`bolt-sdk` / duplicate-dependency hell** (only if any BOLT client code survives D1). `@magicblock-labs/bolt-sdk` 0.2.4 hard-pins `ephemeral-rollups-sdk` **0.2.1** against a current 0.17.0, and `@coral-xyz/anchor` ^0.31.1. Nested duplicates mean `instanceof PublicKey` fails across the boundary and `DELEGATION_PROGRAM_ID` will not compare equal. | Low under D1 | Silent cross-instance comparison failures — the worst class of bug to find. | `npm ls @solana/web3.js` after install. | D1 removes bolt-sdk entirely. If it survives for any reason: import shared constants from **one** package only, and add an npm `overrides` block. |

---

## 3. OPEN QUESTIONS

Unresolved after research. Each has a resolution method, not a shrug.

| # | Question | Why it matters | How to resolve | Owner / when |
|---|---|---|---|---|
| **Q1** | **Real write→notify latency from India on our own accounts.** Everything measured so far was other people's accounts (write time unknown). | The single most important number for tuning prediction and the interpolation buffer. Decides whether step 2's "feels instant" gate is reachable. | Once slice 1 exists: timestamp the send, timestamp the `accountSubscribe` delivery, 200 samples, report p50/p95. Also run it once from the Azure box (`20.51.226.176`) for an in-region baseline. | **Slice 1. Blocking for slice 4.** |
| **Q2** | **Real BossTick CU** against the 400 K ceiling. Only published numbers are for 32-byte no-op components under BOLT, which we are dropping. | Decides 128 vs 64 bullets, and whether the tick needs bitboarding. | Read `consumed X of Y compute units` from the crank transaction logs in slice 2. | **Slice 2. Blocking for the bullet count.** |
| **Q3** | **Does the ER lift `MAX_RETURN_DATA = 1024`?** Mostly moot under D1 (no return-data round trip in a plain Anchor program) but it decides whether any BOLT-shaped fallback exists at all. | Low priority now. Was the deciding experiment before D1. | Deploy a throwaway program returning 928 bytes and `apply` it on the ER. | **Skip unless D1 is reversed.** |
| **Q4** | **Is `delegate`/`undelegate` authenticated in `ephemeral-rollups-sdk` 0.17.0?** Confirmed unauthenticated in BOLT's wrappers; unverified in the current SDK. | R14 — griefing. If unauthenticated, anyone can undelegate `ArenaState` mid-raid and there is no fix. | Delegate an account, then call `undelegate` from an unrelated keypair. 15 minutes, no program needed. | **Spike SP10. Before slice 6.** |
| **Q5** | **`commit_frequency_ms = 0`: "never" or "as often as possible"?** The Rust SDK defaults to `u32::MAX`; BOLT's TS defaulted to `0`. | If `0` means "as often as possible", the 10-commit free allowance is burned in seconds and commit 11 fails with `0xA0000000`. | Delegate two accounts (one `0`, one `u32::MAX`), idle 60 s, count commits via `getSignaturesForAddress` on each delegation record. | **Spike, with SP1. Cheap.** |
| **Q6** | **Does an ER cap the number of delegated accounts per validator or per transaction?** The runtime-limits doc specifies CU, tx size, account size and slot time, and is **silent on account counts**. | D3 keeps us at ~4, so this is now low risk — but the settle path touches all of them at once. | Ask MagicBlock in Discord. Free. | **Any time. Non-blocking.** |
| **Q7** | **Path-based `<g>` rig or `<image>`-per-part rig?** D9 kills the *performance* argument for `<image>`, but spec §6's separate art-fidelity objection ("does not match the reference art anyway") is not a performance question and research cannot judge it. | Everything in slice 3 is built on one or the other. The repo currently contains only path-based assets. | **User decision.** Look at `app/rig-prototype.html` against the reference sheet and call it. | **Before slice 3. User only.** |
| **Q8** | **Is "Next.js" a frozen constraint or an implementation detail?** (D5) | Decides whether the frontend ships on a `1.0.0-beta.8` framework. | **User decision.** The recommendation is Vite SPA; route bodies are identical either way so it is cheap to reverse. | **Before slice 3. User only.** |
| **Q9** | **How many player rigs are on screen simultaneously, and do player parts need their own `<g>` animations at all?** 73 animated nodes measured clean; 201 needed `will-change`. | Directly sets the rendering budget. A single translated group per player is far cheaper than 3 parts × 20. | Falls out of slice 3 with placeholder art. | **Slice 3.** |
| **Q10** | **`escrow_auth` / `escrow` ordering in the `#[action]` macro.** The macro *appends* them `(escrow_auth, escrow)`; the troubleshooting doc says the *first two* action accounts are injected `(escrow, escrow_auth)`. **Position and order both disagree.** | Anything indexing into the action account list is a coin flip. | Verify on devnet in SP5 before depending on an index. | **SP5.** |
| **Q11** | **How is the action's escrow funded, and what happens when it is empty?** Likely `ephemeral_balance_seeds_from_payer`, unverified. | Settlement silently stops working when the escrow drains. | Read the delegation program source, or drain one on devnet. | **SP5 or slice 6.** |
| **Q12** | **~~Does a deployed Worker get the same 403?~~ RESOLVED — assume yes.** | ~~Decides whether a paid RPC is mandatory.~~ | **Answered by R0.12:** the 403 keys on the workerd request shape, not the IP (curl got 200 from the same IP in the same minute; seven header variations all got 200). A deployed Worker runs that same runtime *and* egresses from Cloudflare IPs. **D15 is mandatory.** SP7 is now only worth running to learn whether the free endpoint is a usable *fallback* — it is not on the critical path. | **Closed.** |
| **Q18** | **Does the ER's ~38-key ceiling apply to gameplay transactions the same way it applies to crank transactions?** Both go through `prepare_transaction`, so it should — but only the crank path was traced end to end. | If a `shoot` touching Arena + Boss + Players + the session key ever approaches 38 keys, it fails the same way. D3 keeps us at ~4, so there is large headroom — but the headroom should be *known*, not assumed. | Send a deliberately wide (40-key) gameplay transaction to the ER in SP1 and confirm the rejection message matches. 10 minutes. | **SP1.** |
| **Q13** | **Does `@privy-io/node` 0.34.0 work in workerd?** README lists Workers as supported; untested here. | `/session/init` depends on it — or does not, if we use `jose` directly. | Import it in a Worker and verify one token. Or sidestep entirely with `jose` (~10 lines) and never find out. | **Sidestep. Use `jose`.** |
| **Q14** | **Is there any way to observe crank health besides watching `ArenaState.tick`?** No task-query RPC was found. | R6's watchdog is the only detector we have. | Ask MagicBlock. | **Non-blocking. The watchdog is required regardless.** |
| **Q15** | **Firefox and Safari SVG compositing rules.** Everything in §D9/R7 is Blink-specific; `EffectiveZoom` and the independent-transform-property restriction are Chromium implementation details, not spec. | An unknown fraction of players. | Run the rig prototype in both. 20 minutes. | **SP6d.** |
| **Q16** | **Does the ER's JIT clone of a base-layer account cause a first-use latency spike, and what is the real p50/p99 propagation delay after a confirmed delegate?** The official example just sleeps a blind 3 s. | The join flow needs a real timeout, not a magic sleep. | Measure on our own accounts in slice 1: confirmed-delegate → first accepted ER write. | **Slice 1.** |
| **Q17** | **Re-registration behaviour when a Privy user returns on a new device or with cleared storage.** Does `/session/init` just overwrite `session_pubkey`, or does it need an undelegate/redelegate cycle? | Determines whether key loss is recoverable mid-match. Key loss = character loss otherwise (IndexedDB is evictable and per-origin). | Falls out of slice 5. Make `/session/init` idempotent by construction. | **Slice 5.** |

---

## 4. BUILD ORDER

Vertical slices. Ordered so the **riskiest unknowns are dead by slice 2**, not
discovered in slice 6.

The two things most likely to sink this project are (a) the crank/ER/Magic-Action
plumbing and (b) latency feel. Both are attacked before any art exists.

> **Slice 4 is the first visibly playable build** — you control a knight, you shoot,
> the boss shoots back. Slice 3 is the first *visible* one (you watch the boss
> fight an empty arena in a browser), but you cannot play it.

---

### Slice 0 — Spikes
**~1 day.** See §5. Nothing else starts until SP1, SP2, SP5 have verdicts. SP11 is 15 minutes and blocks the Worker half of slice 5 — run it in the same sitting.

**Done when:** each spike in §5 has a written pass/fail and the go/no-go on D5 and Q7 has been made by the user.

---

### Slice 1 — One program, one account, one ER round trip
Plain Anchor program. `Arena` account (state + a 4-slot bullet stub), `Boss`
account (position, parts, core), `Players[20]` packed. One `shoot` instruction
doing a hitscan raycast against part hitboxes. `Position` **includes
`last_seq: u16`** (D14/R4). Delegate on base, write on ER, commit, undelegate.
Session-key signer check on every instruction plus its invariant test (R13) —
written now while there are two instructions, not later when there are seven.

**Done when:**
- A node script delegates the accounts to `devnet-as`, sends a `shoot` from a
  zero-SOL browser-shaped keypair, and a boss part's HP drops on the ER.
- The same script's `accountSubscribe` sees the change, and **Q1's latency number
  is written down** (p50/p95 over 200 samples).
- **Q16 measured:** confirmed-delegate → first accepted ER write.
- A foreign signer is rejected by the invariant test.
- Commit + undelegate return the state to base layer.

**Kills:** R1, R4, R13. **Answers:** Q1, Q16, Q5.

---

### Slice 2 — The crank owns the fight
`BossTick` at 400 ms via `ScheduleCrankCpi` (i64 args, `task_id` = random i64
stored on `ArenaState`). Full 128-bullet advance + collision against all 20
player slots. Volley spawn at `3 + alive_players`. No client.

**Done when:**
- The crank runs unattended for **10 minutes** and `ArenaState.tick` advances
  monotonically.
- The crank transaction log shows `consumed X of 400000` and **X is written
  down** (Q2). If X > ~300 K, bitboard it or drop to 64 bullets now.
- Killing the crank's target account deliberately shows the ~26.3 s retry ladder
  and then `failed_tasks` (R6 confirmed as R0.2 describes, not as R0.1 claimed).
- `/match/settle` cancels the task before undelegating.

**Kills:** R5, R6, R15. **Answers:** Q2.

---

### Slice 3 — The browser watches
Vite + React SPA (or Next, per Q8). Sliced SVG rig from `tools/svg_slice.py`
(pixel-identical, verified 0/62,100 differing pixels) with the per-part hitbox
JSON feeding the on-chain hitboxes — **one build step produces both, so the DOM
and the chain cannot drift**. `accountSubscribe` over the router. Interpolation
for bullets (exact — integer step, zero prediction error). Snapshot-on-open
(R10). Two-threshold watchdog on `ArenaState.tick` — 3 s soft / **45 s** hard (R6).

**Done when:**
- You open a browser tab and **watch the boss fight an empty arena**, at 60 fps,
  bullets moving smoothly between 2.5 Hz ticks.
- Killing the socket produces a "reconnecting" overlay and a clean resnapshot,
  not a teleport into a stale world.
- Pointing the client at the wrong ER produces the watchdog, not silence (R2).

**Kills:** R2, R10, R7/R8/R16/R17 if the SP6 spikes were skipped. **Answers:** Q7, Q9.

---

### Slice 4 — ▶ FIRST PLAYABLE
Non-extractable WebCrypto Ed25519 session key in IndexedDB (D8). `move` and
`shoot` from the browser straight to the ER. Client-side prediction +
reconciliation on `last_seq`; other players interpolated one update behind
(never extrapolated). Tick counters rate-limiting `Move` (D16/R12).

**Done when:**
- You move a knight with WASD, shoot a boss part off, and take a bullet — **with
  no wallet, no popup, and zero SOL in the session key**.
- It passes the spec's step-2 gate: it feels instant. If it does not, Q1's number
  tells you whether that is prediction tuning or a physics problem.
- 500 tx/s from one keypair is rejected by the tick counter, not absorbed.

**Kills:** R9, R12. This is the build you demo.

---

### Slice 5 — A stranger can play
Privy identity (D7 — `jose` + JWKS in the Worker, no Privy signature ever).
`/session/init` (idempotent, R/Q17). Two onboarding cards, not three — card 2 is
deleted along with §8. `/faucet/status` returns a treasury gauge.

**Done when:** someone who has never used a wallet signs in with email and is
shooting the boss inside 60 seconds, with the funding step absent rather than
fast.

**Kills:** the spec's step 4, which was flagged as "where projects of this shape
usually die" — and which D6 mostly deleted.

---

### Slice 6 — The loop closes
Lobby + gate + `/match/start`. Win/wipe detection. Commit + undelegate. **Magic
Action settlement** (D12) with `/match/settle` as the live recovery path. VRF
incarnation roll from the killing-blow transaction (D11), callback scoped to
Arena + Boss only (25-account cap), **total — log-and-`Ok`, never `require!`**
(R24). Incarnation counter increments.

**Done when:** boss dies → leaderboard row on base layer → everyone back in the
lobby → next incarnation has different affixes → and the leaderboard row is
correct even when the Magic Action is dropped (idempotent on `(incarnation, arena)`).

**Kills:** R3, R14, R24. **Answers:** Q4, Q10, Q11.

---

### Slice 7 — 20 players
Load test with 20 real clients. Concurrent-match `task_id` collision check.
Bandwidth (projected ~71 KB/s, worst case ~132 KB/s — a non-issue, do not spend
time here). Reconnect storm behaviour (R11).

**Done when:** 20 browsers in one arena for a full 6-minute match with no
desync, no frozen client, and no crank death.

---

### Slice 8 — Art and polish
Final tileset, boss parts, knight skins, UI. Everything above is placeholder art
by design — none of it blocks the risk work.

---

**What moved versus spec §10:** rendering (old step 1) drops from second to third
because it de-risks nothing; the crank (old step 3) moves to second because it
carries the highest technical risk; onboarding (old step 4) moves *later* rather
than earlier, because D6 removed the part of it that was dangerous.

---

## 5. SPIKES

Throwaway. Run before committing. Priority order — SP1, SP2 and SP5 are the ones
that could each save a week.

| # | Spike | Time | PASS criterion | FAIL means |
|---|---|---|---|---|
| **SP1** | **Anchor 1.x + `ephemeral-rollups-sdk` 0.17.0 hello-world.** One account: init on base, delegate, write on ER, commit, undelegate. Pin `=0.17.0`. **While you are connected, run three 10-minute shape checks in the same session:** (a) send an ALT-bearing v0 transaction to the ER and confirm it is rejected (R4b/D18); (b) send a deliberately 40-key transaction and confirm the `program_id_index` rejection (Q18); (c) Q5's `commit_frequency_ms` test. | 3–4 h | All five steps succeed on devnet from one script, and (a) and (b) fail with the *expected* errors rather than succeeding or failing for some other reason. | The migration target itself is broken. Stop and re-evaluate before writing any game code. **Cargo pinning note:** a `=` requirement in `Cargo.toml` **cannot pull a transitive dependency down** — Cargo unifies only within a semver-compatible range, so a top-level `=0.13.0` happily coexists with a dependency's `^0` resolving to 0.17.0. This was measured and it made resolution *strictly worse* (three `anchor-lang` copies). The fix is a lockfile operation: `cargo generate-lockfile && cargo update -p <crate> --precise <version>`. Verify with `cargo tree -d`, not by reading the manifest. |
| **SP2** | **Crank CU ceiling.** Schedule a trivial crank; read the transaction log. | 1 h | Log reads `consumed X of 400000`. | If Y ≠ 400,000, R0.3's source analysis is wrong and the entire BossTick budget is unknown. Re-derive before slice 2. |
| **SP5** | **Magic Action from a crank.** Delegated PDA payer + `magic_fee_vault` + `as_signer` workaround; commit one account and write one base-layer counter. Verify Q10's `escrow_auth`/`escrow` ordering while you are in there. | 1 day (budget it) | The base-layer counter increments after a crank-triggered commit. | Settlement moves to client-triggered `/match/settle`. **Decide this at the 1-day mark and do not keep debugging** — the fallback already exists in the spec and costs one round trip. |
| **SP4** | **Write→notify latency, own account.** (Depends on SP1.) 200 samples, India; one run from the Azure box for an in-region baseline. | 1 h | A written p50/p95. There is no pass/fail — the number *is* the deliverable. | — |
| **SP3** | **Crank with a fat account list.** Schedule with 25 account metas. | 1 h | It schedules and fires. | The frozen-list constraint bites harder than D3 assumes; pack further. |
| **SP6** | **Rendering reality check**, four parts: **(a)** existing prototype on hardware GL + a mid-range Android; **(b)** at 110 % browser zoom; **(c)** screenshot-diff at dpr 1.25/1.5; **(d)** Firefox + Safari. | 2 h total | (a) 201 nodes ≥ 60 fps on both. (b) The degradation is characterised and survivable, or the `<div>`-wrapper fallback is chosen **before** the rig is built. (c) No visible pixel alternation. (d) No catastrophic difference. | (a) fail → 64 bullets, or re-test the canvas overlay on hardware. (b) fail → HTML `<div>` wrappers instead of `<g>`, decided now not later. |
| **SP10** | **Delegation griefing (Q4).** Delegate an account, then `undelegate` it from an unrelated keypair. | 15 min | The unrelated keypair is **rejected**. | R14 is live. Either accept it as a devnet-only risk and document it, or pin the validator and keep match windows short. |
| **SP7** | **Deployed Worker → RPC (Q12).** Two-line Worker, `wrangler deploy`, `getLatestBlockhash` against `api.devnet.solana.com` and against a paid provider. | 30 min | Paid provider returns a blockhash. | Nothing — D15 already assumes the paid provider. This spike only tells you whether the free endpoint is a usable fallback. |
| **SP9** | **ER fee assertion (R21).** `getFeeForMessage` on the ER, wired as a CI test. | 15 min | Returns 0. | The whole zero-SOL onboarding model is void. Restore §8 from git history. |
| **SP11** | **workerd Ed25519 key import (R4a).** In `wrangler dev`, try `crypto.subtle.importKey("raw", seed32, "Ed25519", …)` for a **private** key, then the pkcs8 path, then `@solana/kit`'s `createKeyPairFromPrivateKeyBytes`. | 15 min | At least one path yields a usable signing key **inside workerd** (not Node), and it is the one written into `/session/init`. | The Worker cannot hold a treasury key at all. Falls back to signing entirely browser-side, which changes who pays base-layer rent — a real design change, so find this out now and not in slice 5. |
| **SP8** | **Skill refresh (R22).** Update `~/.claude/skills/magicblock/` (versions, i64 crank args, `ScheduleCrankCpi`, scoped VRF identity, `task_id` scoping, failure semantics) and `pinocchio-development/` (0.11 renames). | 1 h | Both skills produce compiling code against the pinned versions. | — Cheapest item on this list and it prevents a debugging session per skill. |

**Total spike budget: ~2 days.** Against a build order where a single one of R1,
R3 or R5 landing late costs a week each, that is the best-value time in the
project.

---

## Appendix — pinned versions

Every one of these was verified on 2026-08-31. `bolt-*` is listed only to make
the removal explicit.

```
# On-chain
anchor-lang               = "1.1.2"        # 2.0.0-rc.1 exists (2026-08-12) — do not use yet
ephemeral-rollups-sdk     = "=0.17.0"      # 2026-08-26; features: anchor, crank, vrf
ephemeral-vrf-sdk         = "=0.17.0"      # 0.3.0/0.3.1/0.4.0 are YANKED
ephemeral-rollups-pinocchio = "0.17.0"     # exists (contra spec §11) — not used in v1
pinocchio                 = "0.11.2"       # AccountView/Address API — not used in v1
bolt-lang                 = REMOVED        # deprecated 2026-05-28; 0.2.5/0.2.6 yanked

# Client
@solana/kit               = "8.2.0"        # pin exactly; v7 and v8 both broke in 6 weeks
@solana/web3.js           = "1.98.4"       # only where Anchor needs it
@coral-xyz/anchor         = "0.32.1"
@magicblock-labs/ephemeral-rollups-sdk = "0.17.0"
@privy-io/react-auth      = "3.39.0"
@privy-io/node            = "0.34.0"       # NOT @privy-io/server-auth (abandoned)
jose                      = "^6.1.0"
@magicblock-labs/bolt-sdk = REMOVED

# Infra
wrangler                  = "4.127.1"
compatibility_date        >= "2026-08-04"  # nodejs_compat is then default — omit the flag

# Live devnet, verified
World / BOLT programs     live but unused
Delegation Program        DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh
Magic Program             Magic11111111111111111111111111111111111111
VRF Program               Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz
VRF ephemeral queue       5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc   # fee-exempt
ER validator (devnet-as)  MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57
ER fqdn                   https://devnet-as.magicblock.app/
Magic Router              https://devnet-router.magicblock.app/
ER runtime                magicblock-core 0.14.11 / solana-core 4.0.0 / cec4cf5
```

**Constants worth memorising:** crank CU ceiling **400,000** · crank retries **10
then permanent death (~26.3 s)** · `MAX_CALLBACK_ACCOUNTS` **25** · VRF queue TTL
**240 slots** · `COMMIT_LIMIT` **10 per committed account** (`0xA0000000`) ·
undelegation session fee **300,000 lamports per account** · ER block time **50 ms**
· ER transaction fee **0**.
