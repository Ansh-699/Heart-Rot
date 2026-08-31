# TypeScript Solana on Cloudflare Workers

Research date: **2026-08-31**. Every claim marked VERIFIED below was executed on that date
against a real `workerd` runtime on this machine, or read from primary source (npm registry
JSON, workerd C++ source, package `.d.ts`, live JSON-RPC endpoints). Sources at the bottom.

The companion doc `docs/research/nextjs-cloudflare.md` covers the *framework* question
(vinext vs OpenNext). This doc covers the *Solana library* question: what actually runs
inside the Workers runtime, and what breaks.

---

## 0. TL;DR for HEARTROT

1. **`@solana/kit` is the correct choice for the 4 cold-path Worker routes.** It works in
   `workerd` with zero polyfills, uses the runtime's native Ed25519, and ships a dedicated
   `workerd` export condition. Bundle cost measured at **134.39 KiB / 30.51 KiB gzip** for a
   trivial worker, vs **662.50 KiB / 132.79 KiB gzip** for `@solana/web3.js@1.98.4`.
2. **No polyfill is needed.** `@solana/webcrypto-ed25519-polyfill` is *not* required on
   Workers. `crypto.subtle` in workerd implements standard Secure-Curves `Ed25519`
   including `generateKey`, `importKey('pkcs8'|'jwk'|'raw')`, `exportKey`, `sign`, `verify`.
   VERIFIED end to end.
3. **No compatibility flag gates Ed25519.** There is no `ed25519` flag in workerd's
   `compatibility-date.capnp`. And as of `compatibility_date >= "2026-08-04"`,
   **`nodejs_compat` is on by default** — you no longer have to list it. Set it anyway (see §4).
4. **Anchor / BOLT TS clients DO work in Workers**, with exactly one break:
   `import { Wallet } from '@coral-xyz/anchor'` is `undefined` because bundlers resolve
   Anchor's `browser` field. Hand-roll the wallet object — 8 lines, given verbatim in §7.
   `new Program(idl, provider)` and `.methods.x().instruction()` then work. VERIFIED.
5. **Sending a transaction to a MagicBlock ER from a Worker works.** A memo tx built and
   signed with kit inside workerd and POSTed to `https://devnet-as.magicblock.app/` came
   back with a real signature. `createSolanaRpcSubscriptions('wss://devnet-as.magicblock.app/')`
   also works inside a Worker request. VERIFIED.
6. **The Magic Router is NOT a full Solana RPC.** `getSlot` and `getVersion` return
   `-32601 Method not found`. Anything that calls `getSlot` — including
   `web3.js Connection.getSlot()` and kit's `rpc.getSlot()` — fails against
   `devnet-router.magicblock.app`. This is a real trap for `sendAndConfirmTransaction`
   helpers. Use the router only for its own methods and for the methods it proxies.
7. **`https://api.devnet.solana.com` returns HTTP 403 to the Worker**:
   `{"code": 403,"message":"Your IP or provider is blocked from this endpoint"}` — while
   the identical request from the host shell returns 200. Budget for a paid RPC
   (Helius/Triton/QuickNode) for the Worker's base-layer reads. See §10.4 for the caveat
   on how conclusive this is.

---

## 1. Test environment (so you can reproduce this)

```
node            v24.10.0
npm             11.19.1
wrangler        4.127.1        (npm dist-tag latest, published 2026-08-28)
workerd         1.20260828.1   (pinned dependency of wrangler 4.127.1)
miniflare       5.20260828.0-alpha
esbuild         0.28.1
@cloudflare/unenv-preset  2.16.1
```

`wrangler.jsonc` used for every runtime probe:

```jsonc
{
  "name": "kit-probe",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-28",
  "compatibility_flags": ["nodejs_compat"]
}
```

Every probe was run under `wrangler dev` (local `workerd`, not a mock) and hit with `curl`.
A second identical run used `"compatibility_flags": []` — results were identical (see §4).

---

## 2. Exact pinned versions (npm registry, 2026-08-31)

| Package | latest | published | Notes |
|---|---|---|---|
| `@solana/kit` | **8.2.0** | 2026-08-29 | `engines.node >= 20.18.0`. Has a `workerd` export condition. |
| `@solana/web3.js` | **1.98.4** | 2025-07-31 | Legacy line. Still `latest`. |
| `@solana/web3.js` | `3.0.0-rc.2` (tag `rc`) | — | A thin compat layer **on top of `@solana/kit ^6.8.0`**. Not stable. Do not adopt. |
| `@solana/webcrypto-ed25519-polyfill` | 8.2.0 | 2026-08-29 | Not needed on Workers. Deps: `@noble/ed25519 ^3.1.0`. |
| `@coral-xyz/anchor` | **0.32.1** | 2025-10-10 | Depends on `@solana/web3.js ^1.69.0`. |
| `@magicblock-labs/ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | Deps incl. `@solana/web3.js ^1.98.0`, `@phala/dcap-qvl ^0.3.9`, `tweetnacl`, `rpc-websockets`. |
| `@magicblock-labs/bolt-sdk` | **0.2.4** | 2025-07-23 | **Stale.** Pins `@magicblock-labs/ephemeral-rollups-sdk` at exactly `0.2.1` and `@coral-xyz/anchor ^0.31.1`. |
| `wrangler` | **4.127.1** | 2026-08-28 | `engines.node >= 22.0.0`. |
| `@opennextjs/cloudflare` | 1.20.5 | 2026-08-31 | See `nextjs-cloudflare.md`. |
| `@solana-program/system` | 0.14.0 | 2026-08-21 | Codama client, kit-native. |
| `@solana-program/compute-budget` | 0.18.0 | 2026-08-21 | Codama client, kit-native. |
| `@privy-io/server-auth` | 1.32.5 | 2025-09-17 | Unverified on Workers — see §12. |

### The `bolt-sdk` version trap

`@magicblock-labs/bolt-sdk@0.2.4` installs its **own nested copies**:

```
node_modules/@magicblock-labs/bolt-sdk/node_modules/@coral-xyz/anchor            0.31.1
node_modules/@magicblock-labs/bolt-sdk/node_modules/@magicblock-labs/ephemeral-rollups-sdk  0.2.1
node_modules/@coral-xyz/anchor                                                   0.32.1   (top level)
node_modules/@magicblock-labs/ephemeral-rollups-sdk                              0.17.0   (top level)
```

Two consequences:

- **Duplicate bundle weight.** A worker importing only `@magicblock-labs/bolt-sdk` measured
  **1611.01 KiB / 282.86 KiB gzip**. Importing only `@magicblock-labs/ephemeral-rollups-sdk`
  measured **1670.14 KiB / 304.24 KiB gzip**.
- **`instanceof` hazard.** A `PublicKey` produced by bolt-sdk's nested `web3.js` and one
  produced by your top-level `web3.js` are different classes. Anchor and web3.js do
  `instanceof` checks in several places. If you use bolt-sdk in the Worker, use
  *its* re-exports (`bolt.web3`, `bolt.BN`, `bolt.anchor`) rather than mixing.
  bolt-sdk deliberately re-exports them for this reason.

**Recommendation:** keep `bolt-sdk` out of the Worker. The Worker only needs to build a
handful of instructions; do it with a Codama/Anchor client generated from your own BOLT
IDLs, or with raw `TransactionInstruction`s. Keep bolt-sdk in the browser bundle and in
scripts, where the size does not matter.

---

## 3. Ed25519 in workerd — the primary-source answer

### 3.1 What the runtime implements

From `cloudflare/workerd`, `src/workerd/api/crypto/ec.c++` (fetched 2026-08-31), the EdDSA
import path:

```cpp
kj::Own<CryptoKey::Impl> CryptoKey::Impl::importEddsa(jsg::Lock& js,
    kj::StringPtr normalizedName,
    kj::StringPtr format,
    SubtleCrypto::ImportKeyData keyData,
    SubtleCrypto::ImportKeyAlgorithm&& algorithm,
    bool extractable,
    kj::ArrayPtr<const kj::String> keyUsages) {

  // BoringSSL doesn't support ED448.
  if (normalizedName == "NODE-ED25519") {
    kj::StringPtr namedCurve = JSG_REQUIRE_NONNULL(
        algorithm.namedCurve, TypeError, "Missing field \"namedCurve\" in \"algorithm\".");
    JSG_REQUIRE(namedCurve == "NODE-ED25519", DOMNotSupportedError, "EDDSA curve \"", namedCurve,
        "\" isn't supported.");
  }

  auto importedKey = [&] {
    auto nid = normalizedName == "X25519" ? NID_X25519 : NID_ED25519;
    if (format != "raw") {
      return importAsymmetricForWebCrypto(js, format, kj::mv(keyData), normalizedName, extractable,
          keyUsages,
          [nid, normalizedName = kj::str(normalizedName)](
              SubtleCrypto::JsonWebKey keyDataJwk) -> kj::Own<EVP_PKEY> {
        return ellipticJwkReader(nid, kj::mv(keyDataJwk), normalizedName);
      },
          normalizedName == "X25519" ? CryptoKeyUsageSet::derivationKeyMask()
                                     : CryptoKeyUsageSet::sign() | CryptoKeyUsageSet::verify());
    } else {
      return importEllipticRaw(js, kj::mv(keyData), nid, normalizedName, keyUsages,
          normalizedName == "X25519" ? CryptoKeyUsageSet() : CryptoKeyUsageSet::verify());
    }
  }();
  ...
}
```

Read that carefully — it is the whole answer:

- `format != "raw"` → `importAsymmetricForWebCrypto`, which handles **`pkcs8`, `spki`, `jwk`**.
- `format == "raw"` → `importEllipticRaw`, whose allowed usage set for Ed25519 is
  `CryptoKeyUsageSet::verify()` only, i.e. **public keys only**. This is the
  "Cloudflare will not support raw import of private keys" line in the docs. It matches the
  WebCrypto spec; it is not a Cloudflare restriction that hurts us.
- JWK export for Ed25519 emits `kty: "OKP"`, `crv: "Ed25519"`, `alg: "EdDSA"`, and `d` for
  private keys.

### 3.2 Why that exactly matches what kit needs

`@solana/keys@8.2.0`, `dist/index.node.mjs`, verbatim:

```js
var ED25519_ALGORITHM_IDENTIFIER = (
  // Resist the temptation to convert this to a simple string; As of version 133.0.3, Firefox
  // requires the object form of `AlgorithmIdentifier` and will throw a `DOMException` otherwise.
  Object.freeze({ name: "Ed25519" })
);
function addPkcs8Header(bytes) {
  return new Uint8Array([
    48, 46, 2, 1, 0, 48, 5, 6, 3, 43, 101, 112, 4, 34, 4, 32,
    ...bytes
  ]);
}
async function createPrivateKeyFromBytes(bytes, extractable = false) {
  const actualLength = bytes.byteLength;
  if (actualLength !== 32) {
    throw new SolanaError(SOLANA_ERROR__KEYS__INVALID_PRIVATE_KEY_BYTE_LENGTH, {
      actualLength
    });
  }
  const privateKeyBytesPkcs8 = addPkcs8Header(bytes);
  return await crypto.subtle.importKey("pkcs8", privateKeyBytesPkcs8, ED25519_ALGORITHM_IDENTIFIER, extractable, [
    "sign"
  ]);
}
async function getPublicKeyFromPrivateKey(privateKey, extractable = false) {
  assertKeyExporterIsAvailable();
  if (privateKey.extractable === false) {
    throw new SolanaError(SOLANA_ERROR__SUBTLE_CRYPTO__CANNOT_EXPORT_NON_EXTRACTABLE_KEY, { key: privateKey });
  }
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return await crypto.subtle.importKey(
    "jwk",
    {
      crv: "Ed25519",
      ext: extractable,
      key_ops: ["verify"],
      kty: "OKP",
      x: jwk.x
    },
    "Ed25519",
    extractable,
    ["verify"]
  );
}
```

kit needs `pkcs8` import, `jwk` export, `jwk` import, `raw` public export, `generateKey`,
`sign`, `verify`. workerd implements all seven.

### 3.3 VERIFIED — actual probe output from `wrangler dev`

```json
{
  "generateKeyPair":            {"ok": true, "v": {"alg": {"name": "Ed25519"}, "ext": false}},
  "generateKeyPairSigner+address": {"ok": true, "v": "9RDiGFsgaUsEpu9HSNA2JUEioivZq4sCcQtjFyYbxa7R"},
  "createKeyPairFromPrivateKeyBytes(32)": {"ok": true, "v": "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"},
  "createKeyPairFromBytes(64)": {"ok": true, "v": "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB"},
  "signBytes":                  {"ok": true, "v": 64},
  "exportKey_jwk_extractable":  {"ok": true, "v": {"crv": "Ed25519", "kty": "OKP"}},
  "buildAndSignTx":             {"ok": true, "v": {"sig": "31j8Hwixio91tw7cYCb7s23YKDJ4dEDr6m8ZeXgHXvyKsjFAaCJNcH6RVWnVs53mJsqkrsN5BoY47oGuFf5HvZw2", "wireLen": 232}},
  "createSolanaRpc_constructs": {"ok": true, "v": "function"},
  "nodeCryptoSign":             {"ok": true, "v": 64}
}
```

Note the last line: **`node:crypto` Ed25519 signing also works** under `nodejs_compat`:

```ts
const { createPrivateKey, sign } = await import('node:crypto');
const der = Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), // same PKCS#8 prefix kit builds
  Buffer.alloc(32, 5),                                    // the 32-byte seed
]);
const k = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
sign(null, Buffer.from('hi'), k); // → 64-byte Buffer
```

That is a valid fallback, but **prefer WebCrypto**: it is smaller, it is what kit uses
anyway, and the non-extractable `CryptoKey` gives you a treasury key the Worker code
physically cannot exfiltrate.

### 3.4 Do NOT use `NODE-ED25519`

It still exists in workerd for backwards compatibility, but it requires
`{ name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }` and is not what kit emits. Use the
standard `{ name: 'Ed25519' }`. Never install `@solana/webcrypto-ed25519-polyfill` on
Workers — it swaps native BoringSSL Ed25519 for `@noble/ed25519` JS, which is both slower
and eats your CPU-time budget (§10.1).

---

## 4. compatibility_date and compatibility_flags

### 4.1 Primary source

From `cloudflare/workerd`, `src/workerd/io/compatibility-date.capnp`, verbatim:

```capnp
  nodeJsCompat @21 :Bool
      $compatEnableFlag("nodejs_compat")
      $compatDisableFlag("no_nodejs_compat")
      $compatEnableDate("2026-08-04");
  # Enables nodejs compat imports in the application.
```

```capnp
  nodeJsCompatV2 @50 :Bool
      $compatEnableFlag("nodejs_compat_v2")
      $compatDisableFlag("no_nodejs_compat_v2")
      $impliedByAfterDate(name = "nodeJsCompat", date = "2024-09-23")
      $compatEnableDate("2026-08-04");
  # Implies nodeJSCompat with the following additional modifications:
  # * Node.js Compat built-ins may be imported/required with or without the node: prefix
  # * Node.js Compat the globals Buffer and process are available everywhere
```

Cloudflare's docs say the same thing in prose:

> "For compatibility dates from `2024-09-23` through `2026-08-03`, add the `nodejs_compat`
> compatibility flag to your Wrangler configuration file to opt in."

and for dates **2026-08-04 or later**, Node.js support is on by default.

**This is why the flag-less probe passed.** With `compatibility_date: "2026-08-28"` and
`compatibility_flags: []`, every single probe — including `@solana/web3.js` `Keypair.generate()`
and `Transaction.serialize()`, which need `Buffer` — returned `ok: true`.

### 4.2 What to actually put in `wrangler.jsonc`

```jsonc
{
  "name": "heartrot-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-28",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

Keep `nodejs_compat` listed explicitly even though the date implies it. Reasons:
it documents the dependency, it survives someone rolling `compatibility_date` *backwards*
to debug a regression, and `wrangler types` / editor tooling keys off the flag list.

There is **no flag for Ed25519** — a full grep of `compatibility-date.capnp` (1674 lines)
for `ed25519` / `curve` returns nothing. The only crypto-adjacent flags are
`strict_crypto_checks` and `crypto_preserve_public_exponent`, neither of which affects us.

---

## 5. `@solana/kit` vs `@solana/web3.js` on Workers

### 5.1 kit is workerd-aware by construction

`@solana/kit@8.2.0` `package.json` `exports` field, verbatim:

```json
"exports": {
  ".": {
    "node":        { "import": "./dist/index.node.mjs",    "require": "./dist/index.node.cjs" },
    "types":       "./dist/types/index.d.ts",
    "browser":     { "import": "./dist/index.browser.mjs", "require": "./dist/index.browser.cjs" },
    "workerd":     { "import": "./dist/index.node.mjs",    "require": "./dist/index.node.cjs" },
    "edge-light":  { "import": "./dist/index.node.mjs",    "require": "./dist/index.node.cjs" },
    "react-native": "./dist/index.native.mjs"
  }
}
```

There is a first-class `workerd` condition, and it maps to the **node** build, not the
browser build. Verified consequence: `@solana/keys`'s node build statically imports
`fs/promises` and `path` (for `writeKeyPair`). Under `nodejs_compat` — or a
`compatibility_date >= 2026-08-04` — those resolve fine and the module loads. This is
exactly why you should not drop `nodejs_compat` on a whim.

### 5.2 Measured bundle cost

`wrangler deploy --dry-run` on a minimal worker that imports a handful of symbols:

| Worker imports | Total Upload | gzip |
|---|---|---|
| `@solana/kit` | **134.39 KiB** | **30.51 KiB** |
| `@solana/web3.js@1.98.4` | 662.50 KiB | 132.79 KiB |
| `@coral-xyz/anchor@0.32.1` | 1297.89 KiB | 240.05 KiB |
| `@magicblock-labs/bolt-sdk@0.2.4` | 1611.01 KiB | 282.86 KiB |
| `@magicblock-labs/ephemeral-rollups-sdk@0.17.0` | 1670.14 KiB | 304.24 KiB |

Free-plan Worker limit is 3 MB compressed; paid is 10 MB. Even the worst case fits. But
kit is 4.3x smaller than web3.js on the wire and it matters for cold-start.

### 5.3 Decision for HEARTROT

**Use `@solana/kit@8.2.0` in the Worker.** Use `@solana/web3.js@1.98.4` only where a
dependency forces it (Anchor, bolt-sdk, ephemeral-rollups-sdk all sit on the v1 line and
that is not changing soon). Do **not** adopt `@solana/web3.js@3.0.0-rc.2` — it is a
release candidate that wraps `@solana/kit ^6.8.0`, i.e. it would pin you two majors behind
current kit.

---

## 6. Verbatim working patterns

All of the following ran inside `workerd` 1.20260828.1 and returned `ok: true`.

### 6.1 Session/treasury key from a Workers Secret, non-extractable

```ts
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Encoder } from '@solana/kit';

// TREASURY_SECRET_KEY is a base58 64-byte secret key stored via `wrangler secret put`.
// We slice to the 32-byte seed; kit derives the public half via WebCrypto.
async function treasurySigner(env: Env) {
  const bytes = getBase58Encoder().encode(env.TREASURY_SECRET_KEY);
  // extractable defaults to false → the CryptoKey can never be exported back out.
  return await createKeyPairSignerFromPrivateKeyBytes(bytes.slice(0, 32));
}
```

`createKeyPairSignerFromPrivateKeyBytes` and `createKeyPairSignerFromBytes` both exist in
kit 8.2.0 (checked against the runtime export list — 958 exports).

### 6.2 Build, sign, encode a transaction

```ts
import {
  address, appendTransactionMessageInstruction, blockhash, compileTransaction,
  createSolanaRpc, createTransactionMessage, generateKeyPairSigner,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, pipe,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';

const rpc = createSolanaRpc('https://devnet-as.magicblock.app/');
const signer = await generateKeyPairSigner();
const bh = await rpc.getLatestBlockhash().send();

const msg = pipe(
  createTransactionMessage({ version: 0 }),
  m => setTransactionMessageFeePayerSigner(signer, m),
  m => setTransactionMessageLifetimeUsingBlockhash(bh.value, m),
  m => appendTransactionMessageInstruction({
    programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
    data: new Uint8Array([104, 105]),
    accounts: [],
  }, m),
);

const signed = await signTransactionMessageWithSigners(msg);
const wire   = getBase64EncodedWireTransaction(signed);
const sig    = getSignatureFromTransaction(signed);
```

VERIFIED output inside workerd:
`{"wire": "AeXf15KiTm98WJVNcs3gSpF/srQCv9RF...", "sig": "5bZhA71SkT1L9BLU292ZbPS82HReTGgGw3qpjjsBQBakbxdfaCvXaH617zB7PjFqN31pH6bXykxijWk69WLVfkKL"}`

### 6.3 Actually sending it to the ER

```ts
const signature = await rpc
  .sendTransaction(wire, { encoding: 'base64', skipPreflight: true })
  .send();
```

VERIFIED against `https://devnet-as.magicblock.app/` from inside a Worker — returned
`"4RQ7FYddYDJGuZFhjMH1GK4vW5KtZUcdcFF9QRTVfwa6JZPyVJDpbQDJ8JG7Cpg49G33JMbzTC61S3V94gnekHBY"`.

### 6.4 RPC with an auth header (for the paid base-layer provider)

The `headers` field is on `HttpTransportConfig`, from `@solana/rpc-transport-http`'s own
`.d.ts`, verbatim:

```ts
import { createHttpTransport } from '@solana/rpc-transport-http';

const transport = createHttpTransport({
    headers: {
        // Authorize with the RPC using a bearer token
        Authorization: `Bearer ${process.env.RPC_AUTH_TOKEN}`,
    },
    url: 'https://several-neat-iguana.quiknode.pro',
});
```

For HEARTROT, in a Worker:

```ts
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from '@solana/kit';

const transport = createDefaultRpcTransport({
  url: env.BASE_RPC_URL,
  headers: { Authorization: `Bearer ${env.BASE_RPC_TOKEN}` },
});
const rpc = createSolanaRpcFromTransport(transport);
```

**Header restrictions are type-enforced.** From `http-transport-headers.d.ts`:

```ts
type DisallowedHeaders = 'Accept' | 'Content-Length' | 'Content-Type' | 'Solana-Client';
type ForbiddenHeaders = 'Accept-Charset' | 'Access-Control-Request-Headers' | ... | `Sec-${string}`;
```

Also note `createDefaultRpcTransport`'s documented behaviour includes
"[node-only] An automatically-set `Accept-Encoding` request header" — that branch is inert
in workerd, harmless.

`HttpTransportConfig` type-imports from `undici-types`, which **is a real runtime
dependency** of `@solana/rpc-transport-http@8.2.0` (`"undici-types": "^8.10.0"`), so
`tsc --noEmit` will not complain about a missing type package. It is types-only; nothing
from undici is bundled.

### 6.5 WebSocket subscriptions from inside a Worker — this works

```ts
import { createSolanaRpcSubscriptions } from '@solana/kit';

const subs = createSolanaRpcSubscriptions('wss://devnet-as.magicblock.app/');
const ac = new AbortController();
const notifications = await subs.slotNotifications().subscribe({ abortSignal: ac.signal });
for await (const n of notifications) { ac.abort(); return n; }
```

VERIFIED inside workerd, returned
`{"slot":"563505436","parent":"563505435","root":"563505436"}`.

Use this sparingly. See §10.3 — a Worker is the wrong place to hold a subscription open.

---

## 7. Anchor / BOLT-generated TS clients in Workers

### 7.1 What works

VERIFIED inside workerd with `nodejs_compat`:

- `import('@coral-xyz/anchor')` — `BN`, `AnchorProvider`, `Program`, `BorshCoder` all present.
- `new Program(idl, provider)` with the real BOLT World IDL
  (`@magicblock-labs/bolt-sdk/lib/generated/idl/world.json`, `address:
  WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n`, `metadata.spec 0.1.0`).
- `await program.methods.initializeRegistry().accounts({ payer }).instruction()` →
  `{"programId":"WorLD15A7CrDwLcLy4fRqtaTb9fbd8o8iqiEMUDse2n","dataLen":8,"keys":3,"disc":[189,181,20,17,174,57,249,59]}`
- `new BorshCoder(idl)` constructs.
- `import('@magicblock-labs/bolt-sdk')` — `FindWorldPda({ worldId: new BN(0) })` →
  `JBupPMmv4zaXa5c8EdubsCPvoHZwCK7mwnDfmfs8dC5Y`.

So: **a BOLT-generated Anchor TS client does work in a Worker.** The IDL is just JSON;
`import worldIdl from './world.json'` is bundled by esbuild with no config.

### 7.2 The one break: `Wallet` is undefined

```
FAIL anchor.Program.fromWorldIdl => "a.Wallet is not a constructor"
```

Root cause, VERIFIED locally:

```
$ node -e "const b=require('@coral-xyz/anchor/dist/browser/index.js'); console.log(typeof b.Wallet)"
undefined
$ node -e "const c=require('@coral-xyz/anchor/dist/cjs/index.js');     console.log(typeof c.Wallet)"
function
```

`@coral-xyz/anchor@0.32.1` has **no `exports` map**, only:

```json
"main":    "./dist/cjs/index.js",
"module":  "./dist/esm/index.js",
"browser": "./dist/browser/index.js"
```

wrangler's esbuild resolves the `browser` field for workerd, and the browser build drops
`NodeWallet` (it reads a keypair off disk). `AnchorProvider`, `Program` and `BN` survive.

**Fix — hand-roll the wallet. VERIFIED working:**

```ts
import * as anchor from '@coral-xyz/anchor';
import { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';

const kp = Keypair.generate(); // or from a Workers Secret

const wallet: anchor.Wallet = {
  publicKey: kp.publicKey,
  payer: kp,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) tx.sign([kp]); else tx.partialSign(kp);
    return tx;
  },
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map(t => this.signTransaction(t)));
  },
};

const provider = new anchor.AnchorProvider(
  new Connection(env.ER_URL, 'confirmed'), wallet, { commitment: 'confirmed' },
);
const program = new anchor.Program(worldIdl, provider);
```

The `anchor.Wallet` *type* is still exported from the `.d.ts` (types come from
`dist/cjs/index.d.ts` regardless of which runtime bundle is chosen), so this type-checks.

### 7.3 Better: don't put Anchor in the Worker at all

Anchor costs 1.3 MB and drags in all of web3.js v1. For 4 cold-path routes that each emit
one or two instructions, generate a **Codama** client from the BOLT IDL instead — it emits
kit-native instruction builders with no runtime framework, the same way
`@solana-program/system@0.14.0` and `@solana-program/compute-budget@0.18.0` are built.
That keeps the Worker on kit-only (30 KiB gzip) and keeps Anchor in the browser/script
side where it already has to live.

Mark this as a design preference, not a verified requirement — Codama generation for BOLT
component/system IDLs was not exercised in this research (§12).

---

## 8. Talking to MagicBlock from a Worker

### 8.1 Endpoints (verified live, 2026-08-31)

| Role | URL |
|---|---|
| Magic Router (devnet) | `https://devnet-router.magicblock.app` / `wss://devnet-router.magicblock.app` |
| ER validator, Asia | `https://devnet-as.magicblock.app/` / `wss://devnet-as.magicblock.app/` |
| ER validator, Europe | `https://devnet-eu.magicblock.app/` |
| ER validator, USA | `https://devnet-us.magicblock.app/` |
| ER validator, TEE | `https://devnet-tee.magicblock.app/` |
| Base layer (MagicBlock-hosted) | `https://rpc.magicblock.app/devnet` |
| Status API | `https://status.magicblock.app/api/services` |

Live `getRoutes` response from the router, verbatim:

```json
{"jsonrpc":"2.0","id":1,"result":[
  {"identity":"MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e","fqdn":"https://devnet-eu.magicblock.app/","baseFee":0,"blockTimeMs":50,"countryCode":"DEU"},
  {"identity":"MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo","fqdn":"https://devnet-tee.magicblock.app/","baseFee":0,"blockTimeMs":50,"countryCode":"SGP"},
  {"identity":"MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57","fqdn":"https://devnet-as.magicblock.app/","baseFee":0,"blockTimeMs":50,"countryCode":"SGP"},
  {"identity":"MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd","fqdn":"https://devnet-us.magicblock.app/","baseFee":0,"blockTimeMs":50,"countryCode":"USA"}
]}
```

`blockTimeMs: 50` across all four regions. Note that against a 50 ms ER block time, the
spec's ~400 ms crank tick is 8 ER blocks — comfortable.

### 8.2 The router's non-standard RPC methods

You do not need `@magicblock-labs/ephemeral-rollups-sdk` in the Worker to use these. From
`lib/magic-router.js` in `ephemeral-rollups-sdk@0.17.0`, verbatim:

```js
class ConnectionMagicRouter extends web3_js_1.Connection {
    async getClosestValidator() {
        const response = await fetch(this.rpcEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity", params: [] }),
        });
        const identityData = (await response.json())?.result;
        if (identityData === null || identityData.identity === undefined) {
            throw new Error("Invalid response");
        }
        return identityData;
    }
    async getDelegationStatus(account) {
        const accountAddress = typeof account === "string" ? account : account.toBase58();
        const response = await fetch(`${this.rpcEndpoint}/getDelegationStatus`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "getDelegationStatus", params: [accountAddress],
            }),
        });
        return (await response.json()).result;
    }
    async getLatestBlockhashForTransaction(transaction, options) {
        const writableAccounts = getWritableAccounts(transaction);
        const blockHashResponse = await fetch(this.rpcEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [writableAccounts],
            }),
        });
        const blockHashData = await blockHashResponse.json();
        return blockHashData.result;
    }
    ...
}
```

Note `getDelegationStatus` is POSTed to `${rpcEndpoint}/getDelegationStatus`, not to the
bare endpoint — that path suffix is in the SDK source and is not a typo on my part.

VERIFIED from a Worker (`fetch`, no SDK):

```
getIdentity               → {"identity":"MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57","fqdn":"https://devnet-as.magicblock.app/"}
getBlockhashForAccounts   → {"blockhash":"E6QtsLccNXZi6RyCt2AX17uxqVWyCvG2FBkgtiPrGftF","lastValidBlockHeight":478850047}
getDelegationStatus       → {"isDelegated":false}
getRoutes                 → (see above)
```

VERIFIED with the SDK too: `new ConnectionMagicRouter(ROUTER,'confirmed').getClosestValidator()`
returned the same identity from inside a Worker.

### 8.3 The router is not a full RPC — the trap

```
FAIL net.kit.createSolanaRpc.getSlot(router)   => "JSON-RPC error: The method does not exist / is not available (Method not found)"
FAIL net.web3js.Connection.getSlot(router)     => "failed to get slot: Method not found"
```

Confirmed with a raw curl too: `getVersion` on the router → `-32601 Method not found`.
Meanwhile `getLatestBlockhash` on the router **works** (routed to base layer, response
`apiVersion 3.1.5`) and `getAccountInfo` **works** (routed to the ER, response
`apiVersion 4.3.0-alpha.2`). So the router proxies a curated subset and rejects the rest.

Consequences you must design around:

- Never point kit's `sendAndConfirmTransactionFactory` or web3.js's
  `confirmTransaction`/`sendAndConfirmTransaction` at the router; their internals reach for
  slot/version methods.
- If you need a slot, ask a concrete ER (`devnet-as.magicblock.app` → VERIFIED
  `getSlot` = `563505430`) or your base-layer provider.
- Resolve the ER once via `getRoutes`/`getIdentity`, cache the `fqdn`, and talk to that ER
  directly for anything beyond the router's own methods.

---

## 9. How this wires into HEARTROT

The design spec says: exactly 4 cold-path routes, gameplay never touches the backend. That
survives contact with this research intact. Concretely:

| Route | What the Worker does | Library |
|---|---|---|
| `POST /session/init` | Validate Privy/wallet identity. Load treasury signer from a Secret. Fund the browser-generated session pubkey (SystemProgram transfer on base layer) if tier 2. Return the funded status + the resolved ER `fqdn` from `getRoutes`. | kit + `@solana-program/system@0.14.0` |
| `POST /match/start` | Build + sign + send the base-layer delegation / world-init instructions with the treasury key. Return the arena/entity PDAs. | kit (+ Codama BOLT client, or Anchor if you accept the 1.3 MB) |
| `POST /match/settle` | Build the Magic Action that chains commit + leaderboard write, sign with treasury, send. | kit + ER SDK's `createCommitAndUndelegateInstruction` if needed |
| `GET /faucet/status` | Read balances. Return whether tier-2 treasury funding or tier-3 browser airdrop is required. | kit `getBalance` against the paid base RPC |

Load-bearing details:

- **The treasury key never leaves the Worker as bytes.** Store the base58 secret via
  `wrangler secret put TREASURY_SECRET_KEY`, and hand it to
  `createKeyPairSignerFromPrivateKeyBytes(bytes, /* extractable */ false)`. The resulting
  `CryptoKey` cannot be `exportKey`'d — kit itself throws
  `SOLANA_ERROR__SUBTLE_CRYPTO__CANNOT_EXPORT_NON_EXTRACTABLE_KEY`. That is a genuine
  security win over a Rust backend holding raw bytes in memory.
- **The session keypair is browser-side and stays browser-side.** Nothing in this research
  changes that. The Worker only ever learns its *public* key.
- **The browser-side airdrop decision is reinforced, not just preserved.** §10.4 shows the
  Worker's egress being refused by the public devnet endpoint outright. A Worker-side
  airdrop was already ruled out on per-IP-limit grounds; it now looks like it would not
  even get a connection.
- **`getRoutes` gives you the ER endpoint to hand the browser.** `/session/init` should
  return the chosen `fqdn` so the browser opens its direct ER connection to the same
  validator the Worker delegated to. Do not let the browser and the Worker independently
  resolve — they can land in different regions.

---

## 10. Gotchas and failure modes

### 10.1 Free-plan CPU time is 10 ms — that is the real constraint

Cloudflare's limits page: **Free plan 10 ms CPU per HTTP request**; paid plan is far
higher. Ed25519 sign in BoringSSL is microseconds, but base58 decode, borsh encode, and
Anchor's IDL processing are not free. `new Program(idl, provider)` parses and lays out the
whole IDL on every construction. On the free plan, a route that constructs an Anchor
`Program` per request is a realistic 10 ms overrun.

Mitigations, in order of laziness: (a) don't use Anchor in the Worker; (b) if you do,
build the instruction with `BorshCoder` once rather than the full `Program` builder;
(c) go paid. Do **not** cache a `Program` in a module-level variable to "fix" this — that
is request-scoped state in global scope and will bite you (Workers best practice, and
`AnchorProvider` holds a `Connection`).

### 10.2 Never `await response.text()` an RPC response you didn't bound

Workers memory limit is 128 MB. `getProgramAccounts` over a BOLT world with 20 player
entities is small, but `getProgramAccounts` with no filter on a busy program is not.
Always pass `dataSlice`/`filters`.

### 10.3 WebSocket subscriptions work but do not belong in a Worker

`createSolanaRpcSubscriptions` VERIFIED working, but: a Worker gets "up to six connections
simultaneously waiting for response headers", and an HTTP request handler is not a durable
process. Holding an ER subscription open per request is a leak waiting to happen.

If you ever need a server-side subscription (you probably do not — the browser subscribes
directly), it belongs in a **Durable Object**, not in a `fetch` handler. Load the
`durable-objects` skill before writing that.

For confirming the 2 or 3 transactions the cold routes send: **poll
`getSignatureStatuses`** against the concrete ER or base RPC. Do not reach for
`sendAndConfirmTransactionFactory` — it wants an `rpcSubscriptions` and, against the
router, will trip over §8.3.

### 10.4 `api.devnet.solana.com` refuses the Worker

VERIFIED from inside workerd:

```json
{"status": 403, "body": " {\"jsonrpc\":\"2.0\",\"error\":{\"code\": 403,\"message\":\"Your IP or provider is blocked from this endpoint\"}, \"id\": 1 } "}
```

The identical POST from the host shell on the same machine returned HTTP 200 with a slot.

**Honest caveat on how conclusive this is:** this machine has HTTP proxy environment
variables set, and `wrangler dev` prints "Proxy environment variables detected. We'll use
your proxy for fetch requests." So the Worker's egress and the shell's egress may not be
the same path, and I cannot prove from here that a *deployed* Worker on Cloudflare's edge
gets the same 403. What I can say: the error is Solana's own application-level block
message, not a proxy error, and Solana Labs documents the public endpoint as not for
production. **Plan for a paid RPC provider for the Worker's base-layer calls.** Confirm
the exact behaviour with one `wrangler deploy` of a two-line worker before you architect
around it.

Note the ER and router endpoints answered the Worker fine over the same path — so this is
about Solana's public endpoint specifically, not about Workers networking.

### 10.5 `@coral-xyz/anchor` `Wallet` — see §7.2

The failure message is `a.Wallet is not a constructor`, which reads like a bundler bug and
is not. Anything else Anchor exposes only from `dist/cjs` will fail the same way. Check
`node -e "console.log(Object.keys(require('@coral-xyz/anchor/dist/browser/index.js')))"`
before assuming an Anchor export exists in a Worker.

### 10.6 `ephemeral-rollups-sdk` pulls WASM through its barrel export

`lib/index.js` re-exports `./access-control/index.js`, which re-exports `./verify.js`,
which does `require("@phala/dcap-qvl")` — a TEE quote verifier. You get it in your bundle
whether or not you use TEE attestation; it is a chunk of the 1670 KiB. Bundling did
succeed and importing did not throw, so this is a size problem, not a correctness problem.
If size matters, deep-import (`require('@magicblock-labs/ephemeral-rollups-sdk/lib/pda.js')`)
or just copy the ~15 lines of PDA derivation you need.

### 10.7 bolt-sdk's nested duplicates — see §2

### 10.8 `wrangler dev` will fight itself on the inspector port

Two concurrent `wrangler dev` processes both try to bind `127.0.0.1:9229` and the second
dies with `Address already in use`. `--port` does not move the inspector. Run local probes
one at a time.

### 10.9 Do not `pkill -f wrangler` from a shell script that contains the word "wrangler"

`pkill -f` matches the invoking shell's own command line and kills the script. Cost me two
probe runs. Use `pkill -f workerd`, or match on the config path.

---

## 11. What contradicts the stated design assumptions

Three things, all mild:

1. **"Backend: exactly 4 cold-path routes."** Still correct and now better supported —
   nothing in this research needs a fifth route. But `/session/init` should also **return
   the resolved ER `fqdn`** (from the router's `getRoutes`), otherwise the browser picks
   its own ER and may land on a different validator than the one the Worker delegated to.
   That is a change to the route's *response shape*, not a new route.

2. **"Gameplay transactions go browser → ER directly."** Fully compatible, and this
   research strengthens the reasoning: a Worker adds a datacenter hop and, against the
   Magic Router specifically, cannot even use half the RPC surface (§8.3). No change.

3. **The implicit assumption that a Rust backend would be needed for Ed25519 / Solana
   signing.** That is now falsified. workerd's WebCrypto does native BoringSSL Ed25519, and
   kit uses it. There is no cryptographic reason to keep a Rust backend. If a Rust backend
   is kept, it should be for a reason this research did not examine (a long-lived crank
   process, for instance — which a Worker genuinely cannot host, and which the spec already
   assigns to a MagicBlock crank anyway).

One thing that is *not* a contradiction but is worth flagging: the spec says the ER ticks
at ~400 ms. The router reports `blockTimeMs: 50` for every devnet validator. The 400 ms
crank is a game-design choice on top of a 50 ms chain, which is fine — just don't let
anyone "optimise" the crank to 50 ms without recosting the bullet-pool advance.

---

## 12. Open questions / what I could not verify

- **Deployed-Worker egress vs `api.devnet.solana.com`.** Local dev goes through this
  machine's proxy. One `wrangler deploy` of a two-line worker settles it. (§10.4)
- **`@privy-io/server-auth@1.32.5` on Workers.** Not tested. Its version is nearly a year
  old (2025-09-17) relative to everything else here, and server-side JWT verification
  usually needs `jose` or `node:crypto`, both of which are fine on Workers — but I did not
  run it. Test before committing `/session/init` to it.
- **Codama codegen from a BOLT component/system IDL.** §7.3 recommends it; I verified that
  Codama-generated *clients* (`@solana-program/*`) exist and are current, but I did not
  generate one from a BOLT IDL. BOLT IDLs are Anchor IDLs with `spec 0.1.0`, so it should
  work; unverified.
- **Whether `@magicblock-labs/bolt-sdk` will be updated.** It is 13 months stale (2025-07-23)
  while `ephemeral-rollups-sdk` shipped 0.17.0 six days ago. Ask MagicBlock before building
  on the pinned `0.2.1` transitive.
- **Magic Actions from a Worker.** The `/match/settle` route depends on Magic Actions; I
  verified transaction send but not the Magic Action instruction construction. See
  `docs/research/er-magic-actions.md`.
- **Paid-plan CPU limit exact value.** Cloudflare's limits page as fetched today reads
  "5 minutes default (adjustable up to 300 seconds per request)", which is self-inconsistent.
  Treat the free-plan 10 ms as the hard number and re-check the paid number before relying on it.

---

## Sources

Fetched or executed on 2026-08-31.

**npm registry (read directly, not via a mirror UI)**
- https://registry.npmjs.org/@solana/kit
- https://registry.npmjs.org/@solana/kit/latest
- https://registry.npmjs.org/@solana%2fkit/8.2.0
- https://registry.npmjs.org/@solana/web3.js
- https://registry.npmjs.org/@solana%2fweb3.js/3.0.0-rc.2
- https://registry.npmjs.org/@solana/webcrypto-ed25519-polyfill
- https://registry.npmjs.org/@coral-xyz/anchor
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk
- https://registry.npmjs.org/@magicblock-labs/bolt-sdk
- https://registry.npmjs.org/wrangler
- https://registry.npmjs.org/@opennextjs/cloudflare
- https://registry.npmjs.org/@solana-program/system
- https://registry.npmjs.org/@solana-program/compute-budget
- https://registry.npmjs.org/@privy-io/server-auth

**workerd source**
- https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/crypto/ec.c++
- https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/crypto/impl.h
- https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/io/compatibility-date.capnp
- https://api.github.com/repos/cloudflare/workerd/contents/src/workerd/api/crypto
- https://github.com/cloudflare/workerd/pull/500 (Secure Curves API implementation)

**Cloudflare docs**
- https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- https://developers.cloudflare.com/workers/platform/limits/

**Solana / MagicBlock docs**
- https://www.solanakit.com/docs/concepts/keypairs
- https://github.com/anza-xyz/kit/releases
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router

**Live endpoints exercised**
- https://devnet-router.magicblock.app (`getIdentity`, `getRoutes`, `getBlockhashForAccounts`, `getDelegationStatus`, `getLatestBlockhash`, `getAccountInfo`; `getSlot`/`getVersion` → `-32601`)
- https://devnet-as.magicblock.app/ (`getSlot`, `getLatestBlockhash`, `sendTransaction`)
- wss://devnet-as.magicblock.app/ (`slotNotifications`)
- https://api.devnet.solana.com (200 from host shell, 403 from workerd)

**Package sources read from `node_modules` after install**
- `@solana/keys@8.2.0` → `dist/index.node.mjs`
- `@solana/rpc-transport-http@8.2.0` → `dist/types/http-transport-config.d.ts`, `dist/types/http-transport-headers.d.ts`
- `@solana/rpc@8.2.0` → `dist/types/rpc-transport.d.ts`
- `@magicblock-labs/ephemeral-rollups-sdk@0.17.0` → `lib/magic-router.js`, `lib/magic-router.d.ts`, `lib/resolver.d.ts`, `lib/index.js`
- `@magicblock-labs/bolt-sdk@0.2.4` → `lib/index.js`, `lib/generated/idl/world.json`
- `@coral-xyz/anchor@0.32.1` → `package.json`, `dist/browser/index.js`, `dist/cjs/index.js`

**Local skill consulted first**
- `~/.claude/skills/workers-best-practices` (rules quick reference, anti-pattern list)
- `~/.claude/skills/magicblock/resources.md` (endpoint table — cross-checked live)
