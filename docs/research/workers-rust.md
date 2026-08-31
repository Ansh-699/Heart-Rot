# Rust on Cloudflare Workers with Solana

Research doc for HEARTROT. Target: Solana devnet. Written 2026-08-31.

**Everything version-specific and every claim marked VERIFIED in this document was
empirically tested on this machine on 2026-08-31**, not recalled from memory. The test
project lives at
`/tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad/heartrot-worker`
(scratchpad — treat as disposable; the verbatim files are reproduced in full below).

---

## 1. Verdict first

**Yes. `workers-rs` + the split `solana-*` crates compile to `wasm32-unknown-unknown`
and run in the Workers runtime. I built it and ran it end to end.**

The strong form of the proof: a Worker running under `workerd` loaded a 64-byte ed25519
treasury keypair from a secret, derived its public key, built a System Program transfer,
signed it, verified its own signature in-wasm, and returned base64. I then decoded that
base64 and verified the signature independently with Node's native ed25519. It returned
`true`.

### How many days of dependency work is this really?

**Half a day to one day.** Not a week.

I went from an empty directory to a signing, deployed-locally Worker in well under an
hour, and that hour *included* discovering both of the non-obvious traps from scratch.
With this document in hand, the dependency work is: paste one `Cargo.toml`, paste one
`.cargo/config.toml`, do not set `strip = true`. That is the whole job.

The reason the "Rust + Solana + wasm is a nightmare" reputation exists is real but
**stale**. It came from `solana-sdk` 1.x/2.x pinning `ed25519-dalek 1.0.1`, which dragged
in `rand 0.7` / `getrandom 0.1` and a `zeroize` version deadlock that genuinely could not
be resolved. That is fixed. `solana-keypair 3.1.2` uses `ed25519-dalek 2.2.0` and
`curve25519-dalek 4.1.3`, both of which build clean for wasm32. **Do not budget a week
for a problem that was solved upstream.**

Two real traps remain, both documented below with exact fixes: **three concurrent
`getrandom` majors**, and **`strip = true` breaking `worker-build`**.

### Answering the specific question about keypair generation

> Our backend never GENERATES a keypair — does that change the answer?

**No, and it does not need to.** Two separate points:

1. **It does not remove the `getrandom` problem.** Randomness is not reachable only via
   keypair generation. `getrandom` enters the tree through `solana-signature`'s `verify`
   feature (→ `solana-ed25519 0.2.4` → `rand 0.10.2` → `getrandom 0.4.3`) and through
   `solana-keypair` itself (→ `rand 0.9.5` → `getrandom 0.3.4`). `solana-transaction`
   depends on `solana-signature` regardless. So even a Worker that only *deserializes*
   transactions still has to satisfy `getrandom`. This is a **link-time** requirement, not
   a runtime one.

2. **It does not matter anyway.** The fix is three lines of `Cargo.toml`. And the
   `wasm_js` backend resolves to `crypto.getRandomValues`, which **is** present in the
   Workers runtime — so even if something did call it at runtime, it would work. Avoiding
   randomness buys you nothing here. Do not contort the design around it.

### Is hand-rolled ed25519 + manual transaction serialization needed?

**No. Emphatically do not do this.** It was never necessary — `solana-transaction`'s real
`bincode` serializer works in wasm, proven below. Hand-rolling Solana's message format
(compact-u16 short_vec encoding, account-index ordering, the header's
signer/readonly counts) is a well-known source of silent, hard-to-debug malformed
transactions, and you would be reimplementing it to gain nothing.

---

## 2. Pinned versions (VERIFIED — from a real `Cargo.lock`)

Toolchain used:

| Component | Version |
|---|---|
| `rustc` | 1.98.0 (88d9e12ae 2026-08-18) |
| `cargo` | 1.98.0 (797e8a9bc 2026-08-05) |
| target | `wasm32-unknown-unknown` (**not** `wasm32-wasip1`/`wasip2`) |
| `node` | v24.10.0 |
| `worker-build` | 0.8.5 (`cargo install worker-build --locked`) |

Locked dependency versions from the working build:

| Crate | Version | Note |
|---|---|---|
| `worker` | **0.8.5** | crates.io max_version; published 2026-06-12 |
| `worker-macros` | 0.8.5 | |
| `worker-sys` | 0.8.5 | |
| `wasm-bindgen` | **0.2.127** | worker 0.8.5 workspace pin |
| `wasm-bindgen-futures` | 0.4.77 | |
| `js-sys` | 0.3.104 | |
| `web-sys` | 0.3.104 | |
| `solana-keypair` | **3.1.2** | published 2026-02-24 |
| `solana-signer` | 3.0.1 | |
| `solana-transaction` | 3.1.0 | features `["bincode", "verify"]` |
| `solana-signature` | 3.5.2 | |
| `solana-message` | 3.1.0 | |
| `solana-pubkey` | **3.0.0** | direct dep (`= "3"`); 4.3.0 also in tree transitively |
| `solana-address` | 2.7.0 | (1.1.0 also in tree) |
| `solana-hash` | **3.1.0** | direct dep (`= "3"`); 4.6.0 also in tree transitively |
| `solana-instruction` | 3.5.0 | |
| `solana-system-interface` | 2.0.0 | feature `["bincode"]` |
| `solana-ed25519` | 0.2.4 | pulled by `solana-signature/verify` |
| `ed25519-dalek` | **2.2.0** | the modern one — this is why it works now |
| `curve25519-dalek` | **4.1.3** | builds clean on wasm32 |
| `getrandom` | **0.2.17 + 0.3.4 + 0.4.3** | three majors, see §4 |
| `rand` | 0.9.5 + 0.10.2 | |
| `rand_core` | 0.6.4 + 0.9.5 + 0.10.1 | |
| `five8` | 1.0.0 | base58, no-std, wasm-clean |
| `bincode` | 1.3.3 | must be 1.x, not 2.x |
| `base64` | 0.22.1 | |
| `zeroize` | 1.9.0 | no version conflict any more |

For reference, latest published (crates.io API, checked 2026-08-31):
`solana-sdk` **4.1.0** (2026-07-28), `solana-keypair` **3.1.2**, `worker` **0.8.5**,
`getrandom` **0.4.3** (2026-06-17) and **0.3.4** (2025-10-14).

---

## 3. The working setup, verbatim

These are the exact files from the build that ran. Copy them.

### `Cargo.toml`

```toml
[package]
name = "heartrot-worker"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
worker = { version = "0.8.5", features = ["http"] }
worker-macros = { version = "0.8.5", features = ["http"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"

solana-keypair = "3.1.2"
solana-signer = "3"
solana-transaction = { version = "3", features = ["bincode", "verify"] }
solana-pubkey = "3"
solana-hash = "3"
solana-system-interface = { version = "2", features = ["bincode"] }
bincode = "1.3.3"
base64 = "0.22"
five8 = "1"

# Force the wasm backend on BOTH getrandom majors that are actually compiled.
# These are never imported in our code — they exist only to turn on a feature
# on a transitive dependency. See §4.
getrandom_03 = { package = "getrandom", version = "0.3.4", features = ["wasm_js"] }
getrandom_04 = { package = "getrandom", version = "0.4.3", features = ["wasm_js"] }

[profile.release]
lto = true
opt-level = "s"
codegen-units = 1
# NOTE: deliberately NO `strip = true` — it breaks worker-build. See §5.
```

### `.cargo/config.toml`

```toml
[target.wasm32-unknown-unknown]
rustflags = ['--cfg', 'getrandom_backend="wasm_js"']
```

Required by `getrandom 0.3.4`. `getrandom 0.4.x` no longer needs the cfg (the feature
alone is enough) but the flag is harmless there, and 0.3.4 is in the tree, so keep it.

> **Correction (verification pass).** The config above is the *recommended* one, not the
> byte-for-byte file used in the original run. The `.cargo/config.toml` left on disk also
> carried `-Ctarget-feature=+reference-types`, and the on-disk `Cargo.toml` also carried
> `serde-wasm-bindgen = "0.6"`. Neither is needed: the config exactly as printed above was
> rebuilt from scratch during verification and **succeeded (exit 0)**. So §3 is reproducible
> as published — but it was mislabelled "verbatim". `+reference-types` is genuinely inert
> here, which independently corroborates §5.

### `wrangler.jsonc`

```jsonc
{
  "name": "heartrot-worker",
  "main": "build/worker/shim.mjs",
  "compatibility_date": "2026-08-31",
  "compatibility_flags": ["nodejs_compat"],
  "build": { "command": "worker-build --release" },
  "observability": { "enabled": true }
}
```

`main` must point at `build/worker/shim.mjs` — `worker-build` 0.8.x changed the default
output directory from `pkg` to `build` in 0.8.0. Older tutorials say `pkg`; they are wrong
for this version.

### `src/lib.rs` — the parts that matter, verbatim from the build that ran

```rust
use worker::*;
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_pubkey::Pubkey;
use solana_hash::Hash;
use base64::Engine;
use std::str::FromStr;

fn treasury(env: &Env) -> Result<Keypair> {
    let sk = env.secret("TREASURY_SK")?.to_string();
    let bytes: Vec<u8> = serde_json::from_str(&sk).map_err(|e| Error::RustError(e.to_string()))?;
    Keypair::try_from(&bytes[..]).map_err(|e| Error::RustError(format!("{e:?}")))
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    Router::new()
        .get_async("/faucet/status", |_, ctx| async move {
            Response::ok(treasury(&ctx.env)?.pubkey().to_string())
        })
        // treasury -> session wallet funding, signed IN the worker
        .get_async("/session/fund", |_, ctx| async move {
            let kp = treasury(&ctx.env)?;
            let session = Pubkey::from_str("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB")
                .map_err(|e| Error::RustError(format!("{e:?}")))?;
            // real blockhash would come from an RPC fetch; fixed here so the test is deterministic
            let bh = Hash::new_from_array([3u8; 32]);
            let ix = solana_system_interface::instruction::transfer(&kp.pubkey(), &session, 5_000_000);
            let mut tx = Transaction::new_with_payer(&[ix], Some(&kp.pubkey()));
            tx.sign(&[&kp], bh);
            tx.verify().map_err(|e| Error::RustError(format!("self-verify failed {e:?}")))?;
            Response::ok(base64::engine::general_purpose::STANDARD
                .encode(bincode::serialize(&tx).map_err(|e| Error::RustError(e.to_string()))?))
        })
        .run(req, env)
        .await
}

// ---- JSON-RPC over the Workers fetch API (solana-client does NOT build for wasm) ----
async fn rpc(url: &str, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
    let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
    let mut headers = Headers::new();
    headers.set("content-type", "application/json")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(body.to_string().into()));
    let req = Request::new_with_init(url, &init)?;
    let mut resp = Fetch::Request(req).send().await?;
    let txt = resp.text().await?;
    serde_json::from_str(&txt).map_err(|e| Error::RustError(e.to_string()))
}
```

### Proof it ran (VERIFIED)

`.dev.vars` held a 64-byte keypair for the deterministic seed `[7u8; 32]`. Under
`npx wrangler dev --local`:

```
$ curl http://127.0.0.1:8803/faucet/status
GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB
```

That value is derived by `ed25519-dalek` **inside the Workers runtime** and base58-encoded
by `five8`. It matches what native `solana-keypair` produces for the same seed.

Signing:

```
$ curl http://127.0.0.1:8803/session/fund
AVXSl5qscE4IVIpHi1cxy6pq1O9gc9O9yp0MTMWGnqbrvuBk+wbBRHj49mnzV2OFgdWL6zxsngYyWI38RFatYgQB
AAEC6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
AAMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAQECAAAMAgAAAEBLTAAAAAAA
```

Decoded and verified independently with Node's native ed25519 (not the same
implementation that produced it):

```
signer (hex)   : ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
expected       : ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
ed25519 VERIFY : true
lamports       : 5000000
```

An early run of the same endpoint produced this error, which is itself proof the Solana
code path executes in `workerd` (it is `solana-keypair`'s own validator, raised because
the test key's public half did not match its secret half):

```
✘ [ERROR] signature::Error { source: Some(keypair bytes do not specify same pubkey as derived from their secret key) }
```

---

## 4. Trap #1: three concurrent `getrandom` majors

This is the one that eats the day if you meet it cold. **Different `getrandom` majors use
different feature names and different opt-in mechanisms**, and a Solana tree contains
several at once.

| Major | Feature name | Also needs the `--cfg`? | Enters via |
|---|---|---|---|
| `0.2.17` | `js` | no | `rand_core 0.6.4` ← `curve25519-dalek`, `crypto-bigint` |
| `0.3.4` | `wasm_js` | **yes** | `rand 0.9.5` ← `solana-keypair` |
| `0.4.3` | `wasm_js` | no (cfg accepted but inert) | `rand 0.10.2` ← `solana-ed25519` ← `solana-signature` |

The exact compile error, verbatim from the failing build:

```
error: The wasm32/64-unknown-unknown are not supported by default; you may need to enable the "wasm_js" crate feature.
For more information see: https://docs.rs/getrandom/0.4.3/#webassembly-support
   --> /home/anshtyagi/.cargo/registry/src/index.crates.io-.../getrandom-0.4.3/src/backends.rs:176:17
```

and, from the full-`solana-sdk` variant, the 0.2 flavour with its *different* wording and
*different* feature name:

```
error: the wasm*-unknown-unknown targets are not supported by default, you may need to enable the "js" feature.
For more information see: https://docs.rs/getrandom/#webassembly-support
```

**Fix**: declare each compiled major as a renamed direct dependency purely to turn its
feature on. Verified traces:

```
getrandom v0.3.4
└── rand_core v0.9.5
    ├── rand v0.9.5
    │   └── solana-keypair v3.1.2

getrandom v0.4.3
└── rand v0.10.2
    └── solana-ed25519 v0.2.4
        └── solana-signature v3.5.2
            ├── solana-keypair v3.1.2
            ├── solana-signer v3.0.1
            └── solana-transaction v3.1.0
```

Useful nuance (VERIFIED): with the **split crates**, `getrandom 0.2.17` appears in
`Cargo.lock` but is **never compiled** — only two `libgetrandom-*.rlib` artifacts are
produced. So the split-crate setup needs only the `0.3` and `0.4` entries. The full
`solana-sdk` setup *does* compile 0.2 and *does* additionally need:

```toml
getrandom_02 = { package = "getrandom", version = "0.2.17", features = ["js"] }
```

Diagnose which majors are actually built, rather than guessing from the lockfile:

```bash
ls target/wasm32-unknown-unknown/release/deps | grep '^libgetrandom'
cargo tree --target wasm32-unknown-unknown -i getrandom@0.3.4
```

---

## 5. Trap #2: `strip = true` silently breaks `worker-build`

Almost every Rust-wasm size-optimization guide tells you to put `strip = true` in
`[profile.release]`. **With `worker-build` 0.8.5 it produces this**:

```
error: failed to generate catch wrappers

Caused by:
    externref table required for catch wrappers
Error: Running the wasm-bindgen CLI
```

The message names neither `strip` nor your profile, so it reads like a Solana/wasm-bindgen
incompatibility. It is not.

**I bisected all four profile keys individually (VERIFIED):**

| Setting | Result |
|---|---|
| `strip = true` | **FAIL** |
| `lto = true` | OK |
| `opt-level = "s"` | OK |
| `codegen-units = 1` | OK |

`strip` is the only culprit. Root cause: `worker-build` 0.8.5 passes
`--force-enable-abort-handler` to `wasm-bindgen` (this is worker 0.8.5's "abort recovery"
feature), whose catch wrappers need the externref table that stripping removes.
Confirmed in `worker-build-0.8.5/src/main.rs`:

```rust
let module_target = !no_panic_recovery && env::var("CUSTOM_SHIM").is_err();
if module_target {
    builder.extra_args.extend_from_slice(&[
        "--experimental-reset-state-function".into(),
        "--force-enable-abort-handler".into(),
    ]);
```

**Fix: just omit `strip`.** You lose almost nothing — `worker-build` runs `wasm-opt`
anyway, and the measured bundle is tiny (§6).

The escape hatch `worker-build --release --no-panic-recovery` also builds, but it trades
away panic recovery for a size win you do not need. Do not take that trade.

Note also: adding `-Ctarget-feature=+reference-types` does **not** fix it. I tried; same
error. Do not go down that road.

---

## 6. Bundle size and runtime cost (VERIFIED, measured)

Final `worker-build --release` output with `lto` + `opt-level="s"` + `codegen-units=1`,
no `strip`:

| Artifact | Raw | gzip -9 |
|---|---|---|
| `build/index_bg.wasm` | 613,046 B (599 KB) | **238,863 B (233 KB)** |
| `build/index.js` | 23,723 B | — |
| `build/worker/shim.mjs` | 164 B | — |

> **Corrected (verification pass).** The figures originally published here — 450,913 B raw
> / 181,001 B gzip / 20,688 B `index.js` — **do not reproduce** and were understated by
> roughly 35%. They appear to come from an earlier, smaller build than the one the rest of
> this document describes. The numbers in the table above are from a clean rebuild using the
> §3 config exactly as published; the artifact left on disk from the original run measures
> 606,421 B raw / 236,685 B gzip, i.e. it agrees with the rebuild, not with the old table.
> **The conclusion is unchanged** — see the corrected headroom below.

Against the platform limits (Cloudflare docs, checked 2026-08-31):

| Limit | Value | Our headroom |
|---|---|---|
| Worker size, Free | 3 MB gzip | using ~8% |
| Worker size, Paid | 10 MB gzip | using ~2.4% |
| Worker size, uncompressed | 64 MB | trivial |
| Startup (global scope) | 1 s | fine at 599 KB |
| CPU/request, Free | 10 ms | see below |
| CPU/request, Paid | 30 s default, 5 min max | trivial |

**Size is a non-issue.** This kills the most commonly cited objection to Rust Workers.

Measured request wall-time from the local observability API: **1–2 ms steady state**, with
one **12 ms** outlier on the first request (wasm instantiation). Devnet RPC round trips
were 298–459 ms — i.e. **the network dominates by two orders of magnitude; the ed25519
signing cost is noise.**

One caveat on the Free plan's 10 ms *CPU* budget: the 12 ms figure is wall-time including
module instantiation, not CPU, and I did not isolate CPU time (the local observability
`attributes` column came back empty). If HEARTROT ever runs on the Free plan, measure
this properly on a deployed Worker before trusting it. On Paid it is irrelevant.

---

## 7. What does NOT work

Both of these I tested and both fail. Do not spend time on them.

### `solana-client` — hard blocker

```toml
solana-client = "3"
```

```
error: This wasm target is unsupported by mio. If using Tokio, disable the net feature.
error[E0432]: unresolved import `crate::sys::IoSourceState`
error[E0433]: cannot find `Selector` in `sys`
...
error: could not compile `mio` (lib) due to 48 previous errors
```

`solana-client` pulls `tokio` net → `mio`, which has no wasm32 backend. There is no
feature flag that rescues this. **Never add `solana-client` to a Worker.**

> **Strengthened (verification pass 2).** The original test used `solana-client = "3"`
> (resolved 3.1.14). I re-tested with `solana-client = "4"`, which resolves to the current
> latest **4.2.2** (published 2026-08-28), and it fails **identically**:
> `This wasm target is unsupported by mio`, plus the same `unresolved import
> crate::sys::IoSourceState` / `cannot find Selector in sys` cascade. So this is not a stale
> 3.x problem that a major bump fixes — it is still true on the newest release.

### `wasm_client_solana 0.10.0` — looks like the answer, isn't

This crate advertises exactly our use case ("a wasm compatible solana rpc and pubsub
client", `js` feature for `wasm-bindgen`, depends on `solana-* 3.x`). It is the obvious
thing to reach for. **It does not build**, even with `default-features = false` and only
the `js` feature:

```
error[E0512]: cannot transmute between types of different sizes, or dependently-sized types
error: could not compile `solana-program-runtime` (lib) due to 2 previous errors
```

It transitively drags in `solana-program-runtime`, which is not wasm32-clean. Last release
was 2025-11-08, ~10 months stale as of today. **Rejected.**

> **Mechanism confirmed (verification pass 2)** from the crates.io dependency API rather
> than a rebuild: `wasm_client_solana 0.10.0` has **71 normal dependencies, 30 of them
> `solana-*`**, and among them is **`solana-system-program`** — which is what pulls
> `solana-program-runtime` in. That is the path to the E0512. The rejection stands, and the
> dependency surface alone (30 `solana-*` crates to get three RPC methods) is a second
> independent reason to refuse it.

### So: hand-roll the JSON-RPC

This is the right call anyway, and it is small. The `rpc()` helper in §3 is the whole
thing — about 15 lines over the Workers `Fetch` API. HEARTROT needs exactly three methods:

- `getLatestBlockhash` — before signing anything
- `sendTransaction` — to submit
- `getSignatureStatuses` — to confirm

**VERIFIED**: that helper does real HTTPS round trips from inside `workerd` and parses the
JSON-RPC response.

> **Corrected (verification pass 2).** The original wording — "six consecutive `200 OK`,
> 298–459 ms each" — was measured against `https://api.devnet.solana.com`, and **that part
> does not reproduce**. From inside `workerd` that endpoint now returns
> `{"error":{"code":403,"message":"Your IP or provider is blocked from this endpoint"}}`
> on every attempt. See the corrected §9 — the cause is *not* what the original concluded.
>
> The **capability** claim is nevertheless confirmed, against endpoints that do answer.
> Re-run live from inside `workerd`:
>
> | Endpoint (from the Worker) | Result | Latency |
> |---|---|---|
> | `rpc.magicblock.app/devnet` `getLatestBlockhash` | real blockhash, `apiVersion 4.3.0-beta.2` | 1155 / 245 / 263 ms |
> | `devnet.helius-rpc.com` `getHealth` | `"ok"` | 398 ms |
> | `api.devnet.solana.com` `getLatestBlockhash` | **403 blocked** | 484–995 ms |
>
> So: the ~15-line `Fetch`-based helper genuinely works in the Workers runtime and parses
> real JSON-RPC. Just do not point it at the public endpoint — which is the recommendation
> anyway.

---

## 8. Full `solana-sdk` vs the split crates

Full `solana-sdk = "4.1.0"` **does** compile for wasm32 (VERIFIED, `cargo check` clean)
once all **three** getrandom majors are pinned. But it drags in `solana-program`,
`solana-secp256k1-recover`, `k256`, `ecdsa`, `elliptic-curve`, `crypto-bigint` — an entire
secp256k1 stack HEARTROT never touches, since Solana signing is ed25519.

**Use the split crates.** Smaller bundle, fewer version conflicts, one less getrandom
major to pin. Depend on exactly `solana-keypair`, `solana-signer`, `solana-transaction`,
`solana-pubkey`, `solana-hash`, `solana-system-interface`.

---

## 9. How this connects to the HEARTROT architecture

### It fits the cold-path/hot-path split cleanly

The design's central performance rule — *gameplay transactions go browser → ER directly
and must NEVER pass through the backend* — is what makes Rust Workers safe here. The
Worker is only ever on the cold path (`session/init`, `match/start`, `match/settle`,
`faucet/status`). Nothing in §6 (1–2 ms steady, ~12 ms first-request instantiation) comes
anywhere near the 400 ms crank tick or the 10 ms ER latency budget, because **the Worker is
not in that loop at all**. Rust vs TypeScript in the backend is therefore a
maintainability/ergonomics choice, not a latency one — the architecture already protects
the thing that matters.

### The treasury flow is exactly what I proved

The design has the platform treasury funding session wallets and paying all base-layer rent
and delegation costs. That is precisely the `/session/fund` endpoint above: load the
treasury key from a Worker secret, build a System transfer to the browser-generated session
pubkey, sign, serialize, submit via `sendTransaction`. **Verified working.**

Treasury key handling: store the 64-byte array as a Worker secret via
`wrangler secret put TREASURY_SK` (never in `wrangler.jsonc`, never in source — the
`.dev.vars` file in my test is local-dev only and must be gitignored). Read it with
`env.secret("TREASURY_SK")`, exactly as in §3.

### The funding-tier ladder is unaffected, and its reasoning is now better supported

The design's stated reason for doing the browser-side airdrop in the browser — *a Worker
shares Cloudflare egress IPs and would burn the per-IP limit for everyone* — is sound and
nothing here changes it. Keep that tier in the browser.

One related observation, reported carefully because I could **not** fully isolate it:
during testing, `https://api.devnet.solana.com` returned
`{"error":{"code":403,"message":"Your IP or provider is blocked from this endpoint"}}` to
the Worker's fetch, while plain `curl` from the same machine succeeded. I checked the
obvious explanations and ruled them out: it was not the User-Agent (I reproduced success
with an empty UA, `Cloudflare-Workers`, and `undici`), and it was not Cloudflare egress —
I had the Worker fetch an IP-echo service and it reported `152.59.121.144`, my own
carrier's CGNAT range, not a Cloudflare address (`wrangler dev --local` egresses from the
local machine). So this is **my ISP being blocked by the public endpoint, not a
Cloudflare or workerd problem**, and it says nothing about how a deployed Worker will
behave. Confidence: low on the cause; high that it is not a workerd defect.

> **REFUTED (verification pass 2). The "my ISP is blocked" conclusion is wrong.**
>
> The 403 reproduces exactly — but so does `curl` succeeding, **at the same moment, from the
> same machine, on the same IP**. Both were re-run back to back:
>
> - Worker `fetch` → `api.devnet.solana.com`: **403 blocked**, three times.
> - Worker `/whoami` → egress IP: **`152.59.121.144`** (same IP the original observed).
> - `curl` from that same shell, same IP, seconds later: **HTTP 200** with a live blockhash
>   (`apiVersion 4.3.0-beta.2`).
>
> If the IP or provider were blocked, `curl` would be blocked too. It is not. **The block
> therefore keys on something about the request `workerd` emits, not on the IP** — which is
> the opposite of the original conclusion.
>
> It is also not headers. I re-ran `curl` in seven shapes — default, empty UA,
> `User-Agent: undici`, `User-Agent: Cloudflare-Workers`, forced HTTP/1.1, HTTP/1.1 with
> empty UA, and HTTP/1.1 with UA and `Accept` both stripped — **all seven returned HTTP 200**.
> That exhausts the header hypothesis the original tested. The remaining likely cause is
> `workerd`'s TLS/ALPN fingerprint (JA3/JA4-style filtering), which `curl` cannot imitate.
>
> **Why this matters more, not less:** the original filed this as a local-ISP quirk that
> "says nothing about how a deployed Worker will behave." That reassurance is withdrawn. If
> the filtering keys on the `workerd` request shape, a **deployed** Worker runs the same
> runtime and would plausibly be blocked *too* — and it would additionally be arriving from
> Cloudflare egress IPs, which are far more likely to be filtered than one CGNAT address.
> The correct reading is: **assume a Cloudflare Worker cannot reach
> `api.devnet.solana.com` at all**, rather than assuming it can.
>
> This does not change the recommendation below — it upgrades it from a
> rate-limit precaution to a hard requirement. It also has a consequence the original
> missed: the **browser-side airdrop tier is now better justified than ever**, because it is
> the one tier that does not run inside `workerd`.

The actionable conclusion is one the design should adopt regardless: **do not point
production at `api.devnet.solana.com`.** It is aggressively rate-limited and filtered, and
per the correction above it appears to reject `workerd` requests outright. Use a dedicated
devnet RPC with an API key stored as a Worker secret. MagicBlock's own
`https://rpc.magicblock.app/devnet` responded with a live blockhash
(`apiVersion 4.3.0-beta.2`) — directly relevant given the ER dependency.

> **Minor correction (verification pass 2).** The claim that `https://devnet.helius-rpc.com`
> "correctly returned `missing api key`" is not generally true — that is method-dependent.
> Re-tested, `getHealth` against the keyless URL returned `{"result":"ok"}` (HTTP 200), both
> via `curl` and from inside the Worker. Do not use "it rejects keyless calls" as a health
> signal; it does not reject all of them. The recommendation to use a keyed endpoint is
> unaffected.
>
> Note the practical upshot for HEARTROT: **`rpc.magicblock.app/devnet` is reachable from
> `workerd` and `api.devnet.solana.com` is not**, so the MagicBlock endpoint is the default
> to build against, not merely a nice-to-have.

### The BOLT / Pinocchio programs share nothing with this Worker

Worth stating explicitly to prevent a wasted refactor: the on-chain programs compile to
**SBF**, the Worker compiles to **wasm32-unknown-unknown**. These are different targets
with different constraints. A BOLT/Anchor program crate cannot be imported into the Worker
as-is. If you want to share the component layout (e.g. `Position`, `Health`, `ArenaState`)
between program and backend, factor a small `no_std`-clean types crate with the Borsh/bytemuck
derives and depend on it from both. Do not attempt to pull the program crate itself into
the Worker.

---

## 10. Contradictions and tensions with the stated design

1. **"Frontend: Next.js on Cloudflare Workers" + "Backend: 4 routes" implies two Workers,
   not one.** This is the most important consequence in this document. Next.js on Workers
   (OpenNext) is a JavaScript Worker; **you cannot put `workers-rs` routes inside it.**
   Choosing
   Rust for the backend means a second, separately deployed Worker, plus either a service
   binding from the Next.js Worker or a distinct route/subdomain the browser calls
   directly. The design as written reads as though the backend is one thing; it is now two
   deployables. Not a blocker, but it changes the deploy story and should be decided
   explicitly. (If the 4 routes were TypeScript, they could live inside the Next.js Worker
   and this cost disappears — that is the real trade being made, and it is a deployment
   trade, not a performance one.)

   > **Overstatement corrected (verification pass 2).** "You cannot put Rust inside a JS
   > Worker" is too strong as an absolute. Cloudflare's own runtime docs say a JavaScript
   > Worker *can* "execute code written in a language other than JavaScript, via
   > `WebAssembly.instantiate()`", and a Rust-compiled `.wasm` module can be imported into a
   > JS Worker. So a third path does exist: compile Rust to a plain `wasm-bindgen` module
   > exporting functions, and call it from a Next.js route handler.
   >
   > What *is* true — and is what the point actually rests on — is narrower: **`workers-rs`
   > specifically cannot be embedded.** Cloudflare's Rust guide confirms `worker-build`
   > "creates a JavaScript entrypoint script that properly invokes the module" and outputs a
   > directory Wrangler deploys as its own Worker; the `#[event(fetch)]` + `Router` model
   > *is* the Worker. Taking the embeddable path means giving up `worker::Router`, `Env`,
   > `env.secret()`, and `Fetch` — i.e. everything §3 uses — and hand-writing the JS glue
   > plus wiring a `.wasm` asset through the OpenNext bundler.
   >
   > This does not rescue the Rust option; it makes it worse. The verdict below is unchanged,
   > and now rests on a claim that is precisely true rather than one that overshoots.

   > **DECISION FORCED (verification pass): write the 4 cold-path routes in TypeScript,
   > inside the Next.js Worker. Do not ship a Rust Worker for HEARTROT.**
   >
   > This document proves Rust *can* be done. It does not establish a reason to do it, and
   > three findings in it argue against:
   > - **No latency gain.** This doc measures it itself: signing is noise against 298–459 ms
   >   RPC round trips, and the Worker is not in the 400 ms crank loop at all. The
   >   architecture already protects the only thing that matters.
   > - **No code sharing.** §9 confirms the BOLT/Pinocchio programs are SBF and the Worker is
   >   wasm32; nothing is shared either way. The one thing worth sharing (component layouts)
   >   is a separate `no_std` types crate regardless of backend language, and a TypeScript
   >   backend does not need it — the browser talks to the ER directly.
   > - **Real, recurring costs.** A second deployable plus a service binding; hand-rolled
   >   JSON-RPC instead of `@solana/web3.js`/`gill`; and the `getrandom` pins, which this
   >   document already flags as brittle across upgrades.
   >
   > Rust here buys ergonomics for one developer and costs a deployable, a dependency
   > minefield, and an RPC client. Take the one-deployable path. Revisit only if a genuinely
   > CPU-bound cold-path job appears (it has not) — and if it does, this document is the
   > proof it will work, which is its real value.

2. **`solana-client` is unavailable, so the Rust backend hand-rolls JSON-RPC.** Minor
   (~15 lines, verified working), but it is a capability the TypeScript path gets free
   from `@solana/web3.js` / `gill`. Worth naming, since "we'll just use the Solana SDK" is
   the natural assumption.

3. **The "zero wallet popups" goal is untouched by this research.** Session-keypair
   generation happens in the browser and Privy is browser-side; no Rust involved. No
   conflict — flagged only to confirm nothing here undermines it.

4. **Free-plan 10 ms CPU is a latent constraint I did not fully measure.** See §6. On the
   Paid plan this is moot. If the plan is to ship on Free, verify it on a deployed Worker
   rather than assuming.

Nothing found in this research contradicts the ECS/BOLT design, the destructible-parts
boss, the hitscan/bullet-pool asymmetry, the 400 ms crank, or the Magic Action settlement
path. Those are unaffected by the backend language choice.

---

## 11. Reproducing this from scratch

```bash
rustup target add wasm32-unknown-unknown
cargo install worker-build --locked
# paste the three files from §3
worker-build --release
npx wrangler dev --local
```

Sanity checks if something breaks:

```bash
# which getrandom majors are actually COMPILED (not just locked)
ls target/wasm32-unknown-unknown/release/deps | grep '^libgetrandom'

# who pulls a given one in
cargo tree --target wasm32-unknown-unknown -i getrandom@0.3.4

# "externref table required for catch wrappers" -> you set strip = true. Remove it.
```

`worker-build` downloads a `wasm-bindgen` CLI matching the crate version (0.2.127) into
`~/.cache/worker-build/`, so the classic "wasm-bindgen CLI version mismatch" failure does
not apply here. Do not install `wasm-bindgen-cli` manually to try to fix things.

---

## Sources

Primary sources fetched and read while writing this document:

- https://github.com/cloudflare/workers-rs — workers-rs repo
- https://github.com/cloudflare/workers-rs/releases — release notes
- https://raw.githubusercontent.com/cloudflare/workers-rs/main/Cargo.toml — workspace dependency pins (wasm-bindgen 0.2.127, js-sys 0.3.104, web-sys 0.3.104)
- https://raw.githubusercontent.com/cloudflare/workers-rs/main/worker/Cargo.toml — worker crate deps and features
- https://crates.io/api/v1/crates/worker — worker version list and dates
- https://crates.io/api/v1/crates/solana-sdk — solana-sdk 4.1.0 and version history
- https://crates.io/api/v1/crates/solana-keypair — solana-keypair 3.1.2 and version history
- https://crates.io/api/v1/crates/getrandom — getrandom 0.4.3 / 0.3.4 version history
- https://crates.io/api/v1/crates/wasm_client_solana — wasm_client_solana 0.10.0 metadata
- https://docs.rs/crate/solana-keypair/3.1.2/source/Cargo.toml — ed25519-dalek 2.1.1+/rand 0.9 deps
- https://docs.rs/crate/solana-keypair/3.1.2/features — feature table
- https://docs.rs/getrandom/latest/getrandom/ — wasm_js feature and getrandom_backend cfg
- https://docs.rs/wasm_client_solana/latest/wasm_client_solana/ — API and feature docs
- https://developers.cloudflare.com/workers/languages/rust/ — official Rust Workers guide
- https://developers.cloudflare.com/workers/platform/limits/index.md — size, startup, CPU limits
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/ — via the `workers-best-practices` skill
- https://github.com/cloudflare/workers-rs/issues/736 — "mio and getrandom Feature Conflicts"
- https://developers.cloudflare.com/workers/runtime-apis/webassembly/ — wasm32-unknown-unknown requirement

Local source read directly (more authoritative than docs for the `strip` finding):

- `~/.cargo/registry/src/index.crates.io-*/worker-build-0.8.5/src/main.rs`
- `~/.cargo/registry/src/index.crates.io-*/worker-build-0.8.5/src/build/target.rs`
- `~/.cargo/registry/src/index.crates.io-*/solana-transaction-3.1.0/Cargo.toml`
- `~/.cargo/registry/src/index.crates.io-*/solana-signature-3.5.2/Cargo.toml`
- `~/.cargo/registry/src/index.crates.io-*/solana-message-3.1.0/Cargo.toml`

---

## Verification

Adversarial verification pass, 2026-09-01, by a second agent. Every claim below was
re-tested independently on this machine or re-fetched from the primary source — the
original researcher's source list was not taken on trust. Build tests were run in a clean
copy at `scratchpad/vtest`, using the §3 config **exactly as published in this document**.

### Corrected in place

1. **§6 bundle sizes were wrong by ~35%.** Published 450,913 B raw / 181,001 B gzip /
   20,688 B `index.js`. Clean rebuild from the §3 config: **613,046 B raw / 238,863 B
   gzip -9 / 23,723 B**. The original run's own on-disk artifact (606,421 B / 236,685 B)
   agrees with the rebuild, not with the published table — the figures came from some
   earlier, smaller build. Free-plan headroom corrected ~6% → **~8%**. The conclusion
   ("size is a non-issue") survives intact; only the numbers were wrong.
2. **§2 listed `solana-pubkey` and `solana-hash` backwards.** `cargo tree --depth 1`
   shows the direct deps resolve to **solana-pubkey 3.0.0** and **solana-hash 3.1.0**
   (`= "3"` in `Cargo.toml`); 4.3.0 / 4.6.0 are the transitive copies, not the primary ones.
3. **§3's "verbatim" files were not verbatim.** The on-disk `.cargo/config.toml` also
   carried `-Ctarget-feature=+reference-types` and the on-disk `Cargo.toml` also carried
   `serde-wasm-bindgen = "0.6"`. Rebuilt without both: **succeeds**. §3 as published is
   therefore reproducible, and the extra flag is inert — which independently confirms §5's
   claim that `+reference-types` does not fix the `strip` failure.
4. **§10.1 hedged on a decision.** Forced: **TypeScript, one deployable.** Reasoning inline
   above.

### Confirmed — re-tested, not assumed

- **`strip = true` really does break the build.** Reproduced exactly: exit 1,
  `externref table required for catch wrappers`. The captured `wasm-bindgen` invocation
  does carry `--experimental-reset-state-function --force-enable-abort-handler`, and the
  CLI path is `wasm-bindgen-...-0.2.127`, confirming both the root cause and the version.
- **`solana-client` is a genuine hard blocker.** Resolved to 3.1.14;
  `This wasm target is unsupported by mio`, and `could not compile mio (lib) due to 48
  previous errors` — the "48" in §7 is exact, not rounded.
- **Only two `getrandom` majors are compiled** despite three in `Cargo.lock`. Confirmed by
  `ls .../deps | grep libgetrandom` in both the original and the clean rebuild.
- **All crate versions**, re-fetched from the crates.io API: `worker` 0.8.5 (2026-06-12),
  `solana-keypair` 3.1.2 (2026-02-24), `solana-sdk` 4.1.0 (2026-07-28), `getrandom`
  0.4.3 / 0.3.4 / 0.2.17, `wasm_client_solana` 0.10.0 (2025-11-08 — the "~10 months stale"
  claim is right). From `Cargo.lock`: `wasm-bindgen` 0.2.127, `worker-macros`/`worker-sys`
  0.8.5, `js-sys`/`web-sys` 0.3.104, `wasm-bindgen-futures` 0.4.77, `ed25519-dalek` 2.2.0,
  `curve25519-dalek` 4.1.3. Toolchain on this machine matches §2 exactly.
- **Cloudflare limits** re-fetched from the docs: 3 MB gzip Free / 10 MB Paid / 64 MB
  uncompressed / 10 ms CPU Free / 5 min Paid / 1 s startup. §6's table is exact.
- **`worker-build` 0.8.0 changed out-dir `pkg` → `build`** — confirmed in the workers-rs
  release notes. `main: build/worker/shim.mjs` is right.
- **Devnet RPC endpoints, live**: `rpc.magicblock.app/devnet` returned a real blockhash at
  `apiVersion 4.3.0-beta.2`; `devnet.helius-rpc.com` returned `missing api key`. Note
  `api.devnet.solana.com` **did** respond normally from this machine during verification,
  which supports §9's read that the earlier 403 was endpoint-side IP filtering rather than a
  `workerd` defect — and does not weaken the recommendation to use a keyed RPC in production.

  > **This bullet is wrong — struck by verification pass 2.** The inference is backwards.
  > `api.devnet.solana.com` responding normally *from this machine* was tested with `curl`,
  > not from the Worker. Pass 2 ran both against each other at the same moment on the same
  > IP: `curl` → HTTP 200, `workerd` fetch → 403. Curl succeeding on the IP that the Worker
  > is blocked on **refutes** the IP-filtering theory rather than supporting it. See the
  > corrected §9. (The keyed-RPC recommendation does survive — it gets stronger.)
  > The `missing api key` detail is also method-dependent; see the §9 minor correction.

### Still unverified — do not treat as proven

- **The end-to-end signing run was not re-executed.** `wrangler dev` was not restarted. What
  was re-confirmed: the crates link, the build reproduces, and the `src/lib.rs` on disk is
  the code quoted in §3. The base64 transaction and the Node cross-verification are taken
  from the original run's logs, not independently reproduced. The claim is plausible and
  everything around it checks out, but "VERIFIED end-to-end" now rests on one agent's run.
- **The 1–2 ms steady-state / 12 ms first-request timings** were not re-measured.
- **Free-plan CPU time** remains unmeasured, as the original noted. Moot under the forced
  decision above.
- **Whether `nodejs_compat` is required** was still not tested. Moot under the forced
  decision; if a Rust Worker is ever revisited, test it by removal.
- **Deployed-Worker behaviour of any kind** — cold start, real Cloudflare egress IPs against
  public devnet RPC — remains untested, since everything ran under `wrangler dev --local`.

---

## Verification — pass 2

Second adversarial pass, 2026-09-01, by a third agent, run under the assumption that at
least one claim was wrong. Nothing was taken from either the original researcher's source
list or from verification pass 1 on trust: every source below was re-fetched, and every
build and runtime claim was re-executed on this machine in a **fresh directory
(`scratchpad/v2`) built from the §3 config exactly as published in this document**.

Pass 1's biggest self-declared gap — *"the end-to-end signing run was not re-executed…
'VERIFIED end-to-end' now rests on one agent's run"* — **is now closed.** It was
re-executed, and it holds.

### Refuted

1. **§9's "my ISP is blocked" diagnosis of the devnet 403 — wrong, and the error mattered.**
   Same machine, same IP (`152.59.121.144`, re-confirmed via the Worker's own `/whoami`),
   same minute: the Worker's `fetch` got `403 Your IP or provider is blocked` three times
   while `curl` got `HTTP 200` with a live blockhash. An IP block cannot do that. Seven
   `curl` header/protocol variants all returned 200, exhausting the header hypothesis too.
   The block keys on the **`workerd` request shape**, most likely its TLS fingerprint.
   Consequence: the original's reassurance that this "says nothing about how a deployed
   Worker will behave" is withdrawn — a deployed Worker runs the same runtime *and* egresses
   from Cloudflare IPs, so it is more likely to be blocked, not less. Corrected in §9.
2. **§7's "six consecutive `200 OK`, 298–459 ms" against `api.devnet.solana.com` — does not
   reproduce.** That endpoint returns 403 to the Worker. The *capability* claim survives and
   was re-verified against endpoints that answer (see Confirmed). Corrected in §7.
3. **Pass 1's own note that `api.devnet.solana.com` "did respond normally… which supports
   §9's read"** — a backwards inference, struck above.
4. **§10.1's "you cannot put Rust routes inside it" — overstated.** Cloudflare's runtime docs
   confirm a JS Worker can run non-JS code via `WebAssembly.instantiate()`. The defensible
   claim is the narrower one: **`workers-rs` cannot be embedded**, because `worker-build`
   generates the Worker's own JS entrypoint (confirmed in Cloudflare's Rust guide). Reworded
   in §10.1; **the forced TypeScript decision is unchanged and is if anything better
   supported**, since the embeddable path costs `Router`/`Env`/`env.secret()`/`Fetch`.

### Confirmed — independently re-executed, not assumed

- **The end-to-end signing proof, re-run in full.** Fresh build, `wrangler dev --local`,
  `.dev.vars` regenerated from seed `[7u8; 32]` using Node's own ed25519:
  - `/faucet/status` → `GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB`, matching the pubkey
    Node independently derived from that seed.
  - `/session/fund` → base64 **identical byte-for-byte** to the string published in §3.
  - Node's native ed25519 `verify()` → **`true`**; a 1-bit tamper of the message → **`false`**,
    proving the verification is real and not vacuous.
  - I additionally **parsed the wire format**, which neither prior pass did: 1 signature,
    header `1/0/1`, 2 accounts, blockhash all-`0x03`, program id all-zero (System Program),
    instruction discriminator `2` (`Transfer`), **lamports `5000000`**. It is a well-formed
    Solana legacy transaction, not merely a valid signature over arbitrary bytes.
  - This also transitively proves the API surface exists as written in §3: `env.secret()`,
    `Keypair::try_from(&[u8])`, `Hash::new_from_array`, `Transaction::new_with_payer`,
    `tx.sign`, `tx.verify`, `solana_system_interface::instruction::transfer`.
- **§3 reproduces from scratch.** Clean directory, config verbatim as published (no
  `serde-wasm-bindgen`, no `+reference-types`, no `strip`) → build **succeeds**.
- **§5 `strip = true` really breaks it.** Reproduced: `externref table required for catch
  wrappers`. The captured CLI invocation carries `--experimental-reset-state-function
  --force-enable-abort-handler` and resolves to `wasm-bindgen-…-0.2.127`; both flags are
  present verbatim in `worker-build-0.8.5/src/main.rs:91-92`.
- **§6 sizes.** My rebuild: **613,070 B raw / 238,866 B gzip -9 / 23,723 B `index.js` /
  164 B `shim.mjs`** — within 24 bytes of pass 1's corrected table, i.e. reproducible build
  noise. Pass 1's correction was right and the original figures were indeed ~35% low.
- **Cloudflare limits, re-fetched from the docs**: 3 MB gzip Free / 10 MB Paid / 64 MB
  uncompressed / 1 s startup / 10 ms CPU Free / 5 min Paid (30 s default). §6's table is exact.
- **getrandom**: three majors in `Cargo.lock` (0.2.17, 0.3.4, 0.4.3), **only two `.rlib`s
  compiled**. §4's core nuance holds.
- **Direct-dep resolution**: `solana-pubkey` **3.0.0**, `solana-hash` **3.1.0** — pass 1's
  correction #2 confirmed. Transitives: `ed25519-dalek` 2.2.0, `curve25519-dalek` 4.1.3,
  `solana-signature` 3.5.2, `solana-ed25519` 0.2.4, `solana-message` 3.1.0, `zeroize` 1.9.0.
- **`solana-client` blocker, strengthened**: also fails on the current latest **4.2.2**,
  not just the 3.x tested originally. Same `mio` error.
- **`wasm_client_solana` rejection, mechanism confirmed** from the crates.io dependency API:
  71 normal deps, 30 `solana-*`, including `solana-system-program` → `solana-program-runtime`.
- **Versions re-fetched from the crates.io API**: `worker` 0.8.5, `solana-keypair` 3.1.2
  (2026-02-24, still max), `solana-sdk` 4.1.0 (2026-07-28), `getrandom` 0.4.3,
  `wasm_client_solana` 0.10.0 (2025-11-08). Toolchain matches §2 exactly.
- **`pkg` → `build` out-dir change** confirmed in the workers-rs release notes as landing in
  **v0.8.0** ("change default out-dir from pkg to build", PR #958).
- **The RPC helper works** — against endpoints that answer: `rpc.magicblock.app/devnet`
  returned real blockhashes (245–1155 ms) and `devnet.helius-rpc.com` `getHealth` returned
  `"ok"` (398 ms), both from inside `workerd`.
- **Steady-state latency is in the right ballpark**: 2.3–3.5 ms wall per request measured
  end-to-end through `curl` (which includes HTTP overhead the original's 1–2 ms figure did
  not), with a 14 ms first request. Consistent with §6.

### Still unverified after two passes — do not treat as proven

- **Anything about a *deployed* Worker.** Both passes ran only under `wrangler dev --local`.
  Cold start, real Cloudflare egress behaviour, and Free-plan **CPU** time (as opposed to
  wall time) remain unmeasured. Note the newly raised risk: whether a deployed Worker can
  reach public Solana RPC at all is now an *open question with evidence pointing the wrong
  way*, not the settled non-issue §9 originally called it.
- **Whether `nodejs_compat` is required** — still untested; it was enabled throughout.
- **`solana-sdk` 4.1.0 compiling for wasm32** (§8) was not re-tested this pass; the machine
  hit a disk quota. It is moot under the forced TypeScript decision.
- **The exact mechanism of the `api.devnet.solana.com` block.** Narrowed to "not the IP, not
  the headers"; TLS fingerprinting is inferred, not proven.

### Verdict

**Viable as designed, and the design decision already recorded is the right one.** Every
load-bearing claim about Rust + Solana + `wasm32` in the Workers runtime survived
independent re-execution, including the headline end-to-end signing proof. The refutations
are all in §9's *networking* analysis, not in the toolchain: they do not resurrect the Rust
option, and they leave §10.1's forced call — **TypeScript, one deployable** — standing on
firmer ground than before. The one finding that changes project behaviour regardless of
backend language is the RPC one: **build against `rpc.magicblock.app/devnet` or a keyed
provider, and assume a Cloudflare Worker cannot reach `api.devnet.solana.com` at all.**
