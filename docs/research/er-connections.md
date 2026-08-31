# ER endpoints, the router, and the dual-connection pattern

Research date: **2026-08-31**. Target: **Solana devnet**.

Everything in this document that is marked *verified live* was probed against the real
devnet endpoints on 2026-08-31 with `curl` and a Node 24 WebSocket client. Version numbers
come from the npm registry and crates.io APIs, not from memory.

---

## 1. What this is

A MagicBlock deployment is **three different RPC surfaces**, not one:

| Surface | Devnet URL | What it is | What lives there |
|---|---|---|---|
| **Base layer** | `https://api.devnet.solana.com` (or `https://rpc.magicblock.app/devnet`) | Ordinary Solana devnet | Undelegated accounts, delegation records, committed state |
| **Router** | `https://devnet-router.magicblock.app/` | MagicBlock's routing proxy | Nothing. It forwards to base or to the right ER, per account |
| **ER validator** | `https://devnet-as.magicblock.app/` (and eu/us/tee) | One ephemeral rollup validator | Delegated accounts, hot game state |

An account is **delegated** to exactly one ER validator at a time. Its base-layer owner
flips to the delegation program `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`; on the ER
that owns it, it still shows the original program as owner and is writable there.

> `https://rpc.magicblock.app/devnet` is **not MagicBlock infrastructure** — a plain GET
> returns `<title>Triton One RPC</title>`. It is a Triton-operated Solana devnet RPC that
> MagicBlock points at for convenience. It reported `solana-core 4.3.0-beta.2`. Treat it
> as interchangeable with `api.devnet.solana.com`, and do not assume it knows anything
> about ERs — it returns `-32601 Method not found` for `getBlockhashForAccounts`
> (*verified live*).

---

## 2. Exact pinned versions

All MagicBlock packages were version-aligned to **0.17.0** on **2026-08-26**, five days
before this research. This is a large jump from what most tutorials and the local
`magicblock` skill describe.

### npm (*verified live against registry.npmjs.org*)

```json
{
  "dependencies": {
    "@magicblock-labs/ephemeral-rollups-sdk": "0.17.0",
    "@coral-xyz/anchor": "0.32.1"
  }
}
```

| Package | Latest | Published | Use when |
|---|---|---|---|
| `@magicblock-labs/ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | web3.js v1 stack (what BOLT's TS client uses) |
| `@magicblock-labs/ephemeral-rollups-kit` | **0.17.0** | 2026-08-26 | `@solana/kit` v4 stack |

The two packages are the same library published against two different Solana client
generations. `...-sdk` depends on `@solana/web3.js ^1.98.0`; `...-kit` depends on
`@solana/kit ^4.0.0` + `@solana/transaction-confirmation ^4.0.0`.
**HEARTROT should use `-sdk`**, because BOLT / Anchor's TypeScript client is web3.js v1.

### crates.io (*verified live*)

| Crate | Latest | Published | Note |
|---|---|---|---|
| `ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | |
| `ephemeral-vrf-sdk` | **0.17.0** | 2026-08-26 | jumped 0.4.1 → 0.17.0; **0.3.x and 0.4.0 are yanked** |
| `magicblock-magic-program-api` | **0.14.10** | 2026-08-16 | did *not* move to 0.17; still on its own line |

### Live devnet infrastructure (*verified live via `getVersion`*)

All four devnet ER validators reported identical builds:

```json
{"magicblock-core":"0.14.11","solana-core":"4.0.0","git-commit":"cec4cf5","feature-set":3718597879}
```

Note the split: the **validator** is `magicblock-core 0.14.11` while the **SDKs** are
`0.17.0`. These are independent version lines. Do not try to match them.

---

## 3. The devnet endpoint map

### Authoritative source: `getRoutes` on the router

Do not hardcode a table. Ask the router. *Verified live, full output:*

```bash
curl -sS -X POST https://devnet-router.magicblock.app/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getRoutes"}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": [
    { "identity": "MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e",
      "fqdn": "https://devnet-eu.magicblock.app/",  "baseFee": 0, "blockTimeMs": 50, "countryCode": "DEU" },
    { "identity": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
      "fqdn": "https://devnet-tee.magicblock.app/", "baseFee": 0, "blockTimeMs": 50, "countryCode": "SGP" },
    { "identity": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
      "fqdn": "https://devnet-as.magicblock.app/",  "baseFee": 0, "blockTimeMs": 50, "countryCode": "SGP" },
    { "identity": "MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd",
      "fqdn": "https://devnet-us.magicblock.app/",  "baseFee": 0, "blockTimeMs": 50, "countryCode": "USA" }
  ]
}
```

`blockTimeMs: 50` on every devnet ER. **HEARTROT's 400ms crank tick is 8 ER blocks** —
comfortable headroom, and player hitscan shots can land inside a single tick.

Mainnet (`https://router.magicblock.app/`) returns the same four identities at
`as/eu/us/mainnet-tee.magicblock.app`. **The validator identity pubkeys are identical
across devnet and mainnet** — identity does not tell you which network you are on.

### Aliases (*verified live via `getIdentity`*)

| URL | Identity | Verdict |
|---|---|---|
| `https://devnet-as.magicblock.app/` | `MAS1Dt9…` | canonical (in `getRoutes`) |
| `https://devnet.magicblock.app/` | `MAS1Dt9…` | **legacy alias for devnet-as**, not in `getRoutes` — don't use |
| `https://devnet-tee.magicblock.app/` | `MTEWGuq…` | canonical (in `getRoutes`) |
| `https://devnet-tee-as.magicblock.app/` | `MTEWGuq…` | alias; this is the name the **status API** uses |

**Contradiction:** the `getRoutes` FQDN for TEE (`devnet-tee.magicblock.app`) and the
status API's `serverFqdn` (`devnet-tee-as.magicblock.app`) are different strings for the
same validator. If you key a health map by FQDN string you will get a miss. **Key by
validator identity, not by hostname.**

### Status API

`https://status.magicblock.app/api/services` — JSON, no auth (*verified live*).

```bash
curl -sS https://status.magicblock.app/api/services \
  | jq '.environments.devnet.regions.asia.servers["devnet-as.magicblock.app"].live_status'
```

Shape: `.environments[mainnet|devnet].regions[asia|europe|usa|tee].servers[fqdn]`, with
`.live_status[er|rpc_router|pricing_oracle|vrf_oracle]` (`true`/`false`/absent) and
`.metrics[service]` = downtime minutes per day aligned to `.meta.days` (UTC).

At time of research all four devnet ERs reported `er: true`. Both TEE rows report
`rpc_router: false` with `metrics.rpc_router` all `null` — that is "no router on the TEE
box", not an outage.

---

## 4. `getDelegationStatus` — the one method that answers "where is this account?"

*Verified live.* Single account per call, passed as a bare string in a one-element array.

```bash
curl -sS -X POST https://devnet-router.magicblock.app/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getDelegationStatus","params":["2aiRcZjSxx93vXXtXfyjapb84NnAsGvUF5i2GxvdXKXL"]}'
```

Delegated (*real devnet response, captured 2026-08-31*):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "isDelegated": true,
    "fqdn": "https://devnet-as.magicblock.app/",
    "delegationRecord": {
      "authority": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
      "owner": "FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4",
      "delegationSlot": 476246577,
      "lamports": 1447680
    }
  }
}
```

Not delegated — **note there is no `fqdn` key at all**, not `fqdn: null`:

```json
{"jsonrpc":"2.0","id":1,"result":{"isDelegated":false}}
```

So `status.fqdn` is `undefined` for an undelegated account. Any code doing
`new Connection(status.fqdn)` without a guard throws.

- `delegationRecord.authority` = the ER validator identity. Join to `getRoutes` to get the FQDN.
- `delegationRecord.owner` = the account's **original** program (for HEARTROT, the BOLT world program).
- `delegationRecord.lamports` = lamports escrowed at delegation time, **not** the account's live balance.

### The router-free fallback: read the delegation record PDA yourself

The router is a single point of failure. You can derive and read the record directly from
the base layer. *Verified live* — derived the PDA for the account above and read it back:

```
delegation record PDA: 9EnqKyrUR4FT3HryxfgfqMtJgYW923XHgPoRej5yKUoj
owner: DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh   len: 96
validator @ bytes 8..40: MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57   ← matches router
```

This is exactly what the SDK does. Verbatim from
`@magicblock-labs/ephemeral-rollups-sdk@0.17.0/lib/resolver.js`:

```js
function parseDelegationRecordAccount(account) {
    const isDelegated = account !== null &&
        account.owner.equals(constants_js_1.DELEGATION_PROGRAM_ID) &&
        account.lamports !== 0;
    return isDelegated
        ? {
            status: DelegationStatus.Delegated,
            validator: new web3_js_1.PublicKey(account.data.subarray(8, 40)),
        }
        : { status: DelegationStatus.Undelegated };
}
```

Seeds are `["delegation", <delegated account pubkey>]` under the delegation program:

```js
const seed = new TextEncoder().encode("delegation");
const seeds = [seed, pubkey.toBytes()];
const [delegationRecord] = PublicKey.findProgramAddressSync(seeds, DELEGATION_PROGRAM_ID);
```

The three delegated-ness signals are: record account exists, owner is the delegation
program, **and lamports != 0**. A zero-lamport record counts as undelegated.

---

## 5. The router's actual method surface (*verified live*)

The docs say the router "implements almost all standard Solana RPC methods". That is
misleading. Probed method-by-method against `https://devnet-router.magicblock.app/`:

### HTTP

| Method | Router | Note |
|---|---|---|
| `getDelegationStatus` | ✅ | router-only |
| `getRoutes` | ✅ | router-only |
| `getIdentity` | ✅ | returns `{identity, fqdn}` — the *closest* ER, not your account's ER |
| `getBlockhashForAccounts` | ✅ | router-only, chain-aware |
| `getLatestBlockhash` | ✅ | **returns an ER blockhash — see the trap below** |
| `getAccountInfo` | ✅ | transparently proxies to the account's real home |
| `getSignatureStatuses` | ✅ | documented |
| `getVersion` | ❌ | `-32601 Method not found` |
| `getHealth` | ❌ | `-32601` |
| `getSlot` | ❌ | `-32601` |
| `getBlockHeight` | ❌ | `-32601` |

You cannot health-check the router with `getHealth` or `getVersion`. Use `getRoutes` (cheap,
router-only, no params) as the liveness probe.

### WebSocket (`wss://devnet-router.magicblock.app/`)

*Verified live with a real WS handshake + subscribe.*

| Subscription | Router | ER |
|---|---|---|
| `accountSubscribe` | ✅ | ✅ |
| `signatureSubscribe` | ✅ | ✅ |
| `programSubscribe` | ❌ `-32601` | ✅ |
| `logsSubscribe` | ❌ `-32601` | ✅ |
| `slotSubscribe` | ❌ `-32601` | ✅ |

The router WS supports exactly the two subscriptions a routing client needs. If HEARTROT
wants `programSubscribe` to watch all Bullets/Player components at once, that must go
**direct to the ER**, not the router.

---

## 6. `getBlockhashForAccounts` — the mechanism that makes one endpoint work

This is the most important method in the whole system and the least documented.

A base-layer blockhash is invalid on the ER and vice versa (the two chains run wildly
different block heights — measured live: base ≈ 478.8M, ER ≈ 563.4M). So before you can
send a transaction you must already know which chain it is going to. `getBlockhashForAccounts`
inverts that: you hand it the transaction's **writable accounts** and it hands back a
blockhash for whichever chain those accounts live on.

*Verified live, same second, three calls:*

| `params[0]` | `lastValidBlockHeight` returned | Which chain |
|---|---|---|
| `[<delegated account>]` | 563,480,222 | **ER** (ER height was 563,480,269) |
| `[<undelegated account>]` | 478,844,362 | **base** (base height was 478,844,345) |
| `[<delegated>, <undelegated>]` | 563,480,260 | **ER** |

**One delegated writable account routes the entire transaction to the ER.** This is the
rule the whole architecture rests on.

The request shape is a nested array — the params array contains one array of addresses
(1–100 addresses):

```json
{"jsonrpc":"2.0","id":1,"method":"getBlockhashForAccounts",
 "params":[["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU","9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]]}
```

Response is **flat** — `result.blockhash`, not `result.value.blockhash`:

```json
{"jsonrpc":"2.0","id":1,"result":{"blockhash":"9tJWqpCLuFZ8PWQZJaYqydTXzhTCNmrtGraG2wyZXrP7","lastValidBlockHeight":399468682}}
```

### ⚠ The `getLatestBlockhash` trap

Calling plain `getLatestBlockhash` **on the router** returns an **ER** blockhash
(*verified live*: `lastValidBlockHeight: 563474661`, in the ER's height range). If you use
the router as a drop-in `Connection` and let web3.js call `getLatestBlockhash()` for a
base-layer transaction — the `delegate` instruction, a treasury transfer, session-wallet
funding — the transaction is signed against an ER blockhash and dies on the base layer.

**Never let a generic code path fetch a blockhash from the router.** Either use
`getBlockhashForAccounts` explicitly, or use the SDK's `ConnectionMagicRouter`, which does
it for you.

---

## 7. `ConnectionMagicRouter` — verbatim source and its rough edges

From `@magicblock-labs/ephemeral-rollups-sdk@0.17.0/lib/magic-router.js`. This is the
real published code, not a paraphrase:

```js
function getWritableAccounts(transaction) {
    const writableAccounts = new Set();
    if (transaction.feePayer) {
        writableAccounts.add(transaction.feePayer.toBase58());
    }
    for (const instruction of transaction.instructions) {
        for (const key of instruction.keys) {
            if (key.isWritable) {
                writableAccounts.add(key.pubkey.toBase58());
            }
        }
    }
    return Array.from(writableAccounts);
}

class ConnectionMagicRouter extends web3_js_1.Connection {
    async getLatestBlockhashForTransaction(transaction, options) {
        const writableAccounts = getWritableAccounts(transaction);
        const blockHashResponse = await fetch(this.rpcEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "getBlockhashForAccounts",
                params: [writableAccounts],
            }),
        });
        const blockHashData = await blockHashResponse.json();
        return blockHashData.result;
    }

    async sendTransaction(transaction, signersOrOptions, options) {
        if (transaction instanceof web3_js_1.Transaction) {
            const latestBlockhash = await this.getLatestBlockhashForTransaction(transaction);
            transaction.recentBlockhash = latestBlockhash.blockhash;
            transaction.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
            if (Array.isArray(signersOrOptions)) {
                transaction.sign(...signersOrOptions);
            }
            const wireTx = transaction.serialize();
            return this.sendRawTransaction(wireTx, options);
        }
        else {
            return super.sendTransaction(transaction, signersOrOptions);
        }
    }
}
```

Construction (from the official docs):

```typescript
import { ConnectionMagicRouter } from "@magicblock-labs/ephemeral-rollups-sdk";

const connection = new ConnectionMagicRouter(
  "https://devnet-router.magicblock.app/",
  { wsEndpoint: "wss://devnet-router.magicblock.app/" }
);
```

### Four real defects in this class — read before you depend on it

1. **`VersionedTransaction` is not routed.** The `else` branch calls
   `super.sendTransaction(...)`, i.e. plain web3.js, which will use whatever blockhash is
   already baked into the message. If HEARTROT uses v0 transactions with an address lookup
   table (very likely — Arena + Boss + 20 Players + Bullets is a lot of account keys), the
   router's blockhash logic **silently does not apply**. Build v0 messages by calling
   `getLatestBlockhashForTransaction` yourself first.

2. **`transaction.sign(...)` not `partialSign(...)`.** `sign()` wipes existing signatures.
   A session-keypair-signed transaction that also needs a treasury co-signature cannot go
   through `sendTransaction` with a partial signer set.

3. **The TypeScript return type of `getDelegationStatus` is wrong.** The `.d.ts` declares:

   ```typescript
   getDelegationStatus(account: PublicKey | string): Promise<{ isDelegated: boolean; }>;
   ```

   The runtime returns `fqdn` and `delegationRecord` too. You must cast to reach them.

4. **`getDelegationStatus` POSTs to `${this.rpcEndpoint}/getDelegationStatus`** — it appends
   a path segment, unlike every other method in the class which POSTs to `this.rpcEndpoint`.
   With the trailing slash in the recommended endpoint this produces a double slash. *Verified
   live: the router ignores the path and answers correctly (`HTTP 200`, correct result).*
   It works today, but it is accidental — a future gateway that routes on path would break it.
   Prefer your own `fetch` to the bare router URL.

---

## 8. When to use `skipPreflight`

**Always `true` for ER transactions**, and the official examples use `true` for base-layer
transactions too.

Reason: preflight is a simulation run by the node you submit to. An ER transaction touches
accounts whose live state exists only inside that ER's bank. Simulation on any node with a
different view — and, critically, the base layer's view of a delegated account is the
*stale committed* copy owned by the delegation program — rejects the transaction before it
is ever sent.

The kit SDK makes this the default. Verbatim from
`@magicblock-labs/ephemeral-rollups-kit@0.17.0/lib/connection.js`:

```js
async sendTransaction(transaction, signers, options) {
    const { skipPreflight = true, preflightCommitment = "confirmed" } = options ?? {};
    ...
}
```

Note `skipPreflight` defaults to **`true`**, the opposite of stock web3.js.

The cost you accept: a malformed transaction returns a signature and then silently fails,
so you must actually check the confirmation status. HEARTROT's shot-fire path should
fire-and-forget for latency but still surface `meta.err` on a sampled basis, or a player
whose Combat component is misconfigured will just see nothing happen forever.

---

## 9. Waiting for state propagation

### After `delegate` (base layer → ER)

The official example's answer is a hardcoded sleep. Verbatim from
`counter/anchor/tests/public-counter.ts` in `magicblock-engine-examples`:

```typescript
const txHash = await provider.sendAndConfirm(tx, [provider.wallet.payer], {
  skipPreflight: true,
  commitment: "confirmed",
});
const duration = Date.now() - start;
console.log(`${duration}ms (Base Layer) Delegate txHash: ${txHash}`);
await new Promise((resolve) => setTimeout(resolve, 3000));
```

3000ms, blind. For HEARTROT this is unacceptable — a player joining a live raid cannot eat
a fixed 3s stall, and 3s is not actually a guarantee. Poll instead: after the delegate
transaction confirms on base, poll `getDelegationStatus` until `isDelegated` is true **and**
then poll `getAccountInfo` on the returned `fqdn` until the ER reports the account owned by
your program. The ER-side check is the one that matters — the router can report delegated
before the ER has cloned the account, which is exactly the `InvalidWritableAccount` window.

### After `commit` / `undelegate` (ER → base layer)

Use `GetCommitmentSignature`. It works by **scraping the ER transaction's log messages**
for the scheduled-commit signature, then confirming that signature. Verbatim from
`lib/utils.js` (v0.17.0):

```js
async function GetCommitmentSignature(transactionSignature, ephemeralConnection) {
    const txSchedulingSgn = await ephemeralConnection.getTransaction(transactionSignature, { maxSupportedTransactionVersion: 0 });
    if (txSchedulingSgn?.meta == null) {
        throw new Error("Transaction not found or meta is null");
    }
    const scheduledCommitSgn = parseScheduleCommitsLogsMessage(txSchedulingSgn.meta.logMessages ?? []);
    if (scheduledCommitSgn == null) {
        throw new Error("ScheduledCommitSent signature not found");
    }
    const latestBlockhash = await ephemeralConnection.getLatestBlockhash();
    await ephemeralConnection.confirmTransaction({
        signature: scheduledCommitSgn,
        ...latestBlockhash,
    });
    const txCommitInfo = await ephemeralConnection.getTransaction(scheduledCommitSgn, { maxSupportedTransactionVersion: 0 });
    if (txCommitInfo?.meta == null) {
        throw new Error("Transaction not found or meta is null");
    }
    const commitSignature = parseCommitsLogsMessage(txCommitInfo.meta.logMessages ?? []);
    if (commitSignature == null) {
        throw new Error("Unable to find Commitment signature");
    }
    return commitSignature;
}

function parseScheduleCommitsLogsMessage(logMessages) {
    for (const message of logMessages) {
        const signaturePrefix = "ScheduledCommitSent signature: ";
        if (message.includes(signaturePrefix)) {
            return message.split(signaturePrefix)[1];
        }
    }
    return null;
}

function parseCommitsLogsMessage(logMessages) {
    for (const message of logMessages) {
        const signaturePrefix = "ScheduledCommitSent signature[0]: ";
        if (message.includes(signaturePrefix)) {
            return message.split(signaturePrefix)[1];
        }
    }
    return null;
}
```

Usage, verbatim from the official test:

```typescript
const txCommitSgn = await GetCommitmentSignature(
  txHash,
  providerEphemeralRollup.connection,
);
```

**Fragility warning:** this parses two hardcoded English log prefixes,
`"ScheduledCommitSent signature: "` and `"ScheduledCommitSent signature[0]: "`. It is a
string-matching contract against validator log output, not a stable API. It throws rather
than returns null on every failure path. `parseCommitsLogsMessage` only ever reads index
`[0]`, so a commit bundling multiple accounts gives you the first signature only. Wrap
every call in try/catch and treat a throw as "unknown, retry" — not "commit failed".

Also note it takes the **ephemeral** connection, not the base one, despite returning a
base-layer signature.

---

## 10. Detecting an ER that has moved or died

### The silent-failure mode you must design against

This is the most dangerous finding in this document. **Reading a delegated account from the
wrong ER does not error. It returns plausible, correctly-owned, silently stale data.**

*Verified live.* Same delegated account, polled three times over ~10 seconds against the
correct ER (`devnet-as`, its real home), the wrong ER (`devnet-eu`), and the base layer:

```
iter 1
  correct-ER(as) : 46qk2n8QI99YH/MIAAAAAPv///+AuwAAAAAAAKg+9wgAAAAAQcCVagAAAAAqCwAA
  wrong-ER  (eu) : 46qk2n8QI9/HQpIKAAAAAPv///+n4AAAAAAAALeZiQoAAAAA3W1WagAAAAAqCwAA
  base           : 46qk2n8QI9/HQpIKAAAAAPv///+n4AAAAAAAALeZiQoAAAAA3W1WagAAAAAqCwAA
iter 2
  correct-ER(as) : 46qk2n8QI9+qAvMIAAAAAPv////SngAAAAAAALM89wgAAAAAR8CVagAAAAAqCwAA
  wrong-ER  (eu) : 46qk2n8QI9/HQpIKAAAAAPv///+n4AAAAAAAALeZiQoAAAAA3W1WagAAAAAqCwAA
  base           : 46qk2n8QI9/HQpIKAAAAAPv///+n4AAAAAAAALeZiQoAAAAA3W1WagAAAAAqCwAA
```

The correct ER's data changes every poll. The wrong ER is frozen at the last committed
base state — and it reports `owner: FTPP4jEWW1n8s2FEccwVfS9KCPjpndaswg7Nkkuz4ER4`, the
original program, exactly like the correct ER does.

**This breaks the ownership heuristic.** The local `magicblock` skill's debugging runbook
says "on the ER RPC returned in `fqdn`, `getAccountInfo` shows the account owned by the
original program" — true, but it does *not* discriminate, because the *wrong* ER shows the
same thing. Checking the owner tells you the account is delegated somewhere. It does not
tell you that you are talking to the right ER.

For HEARTROT this is the "boss is frozen" bug: 20 players, a couple of them resolve to the
wrong ER fqdn, and those players watch a motionless boss with no console error while
everyone else fights. **The only reliable check is `delegationRecord.authority` (or the
record PDA's bytes 8..40) matching the identity of the endpoint you are actually talking to.**

The WebSocket version of the same test is even starker (*verified live*, 15s window,
`accountSubscribe` on one delegated account):

| Endpoint | accountNotifications in 15s | First notification |
|---|---|---|
| `wss://devnet-router.magicblock.app/` | **271** | 1581 ms |
| `wss://devnet-as.magicblock.app/` (correct ER) | **287** | 738 ms |
| `wss://devnet-eu.magicblock.app/` (wrong ER) | **0** | — |
| `wss://rpc.magicblock.app/devnet` (base) | **0** | — |

Zero notifications, zero errors, connection stays open. A wrong-ER subscription looks
exactly like a quiet game.

### The headline result: the router WS follows the account for you

271 vs 287 notifications — **the router's `accountSubscribe` transparently proxies to the
correct ER and delivers essentially the same stream.** One WS connection to
`wss://devnet-router.magicblock.app/`, no fqdn resolution, and it keeps working when the
account is re-delegated to a different validator. Cost: ~840ms extra on first-notification
latency (subscription setup), zero on steady-state throughput.

**For HEARTROT's render loop this is the right default.** Subscribe to Arena, Boss, Core,
Parts and Bullets over the router. Fall back to a direct ER subscription only if you need
`programSubscribe` (router doesn't support it) or want to shave that ~840ms setup.

### The SDK's `Resolver` — live re-routing via the base layer

`Resolver` watches the **delegation record PDA on the base layer** over WebSocket, so it
learns the moment an account is delegated, undelegated, or moved. Verbatim from
`lib/resolver.js@0.17.0`:

```js
async trackAccount(pubkey) {
    const pubkeyStr = pubkey.toString();
    if (this.delegations.has(pubkeyStr)) {
        const record = this.delegations.get(pubkeyStr);
        if (record !== undefined) {
            return record;
        }
        throw new Error(`Expected a delegation record for ${pubkeyStr}, but found undefined.`);
    }
    const seed = new TextEncoder().encode("delegation");
    const seeds = [seed, pubkey.toBytes()];
    const [delegationRecord] = web3_js_1.PublicKey.findProgramAddressSync(seeds, constants_js_1.DELEGATION_PROGRAM_ID);
    const id = this.ws.onAccountChange(delegationRecord, (acc) => this.updateStatus(acc, pubkey), "confirmed");
    this.subs.add(id);
    const accountInfo = await this.chain.getAccountInfo(delegationRecord, "confirmed");
    return this.updateStatus(accountInfo, pubkey);
}

async resolveForTransaction(tx) {
    const validators = new Set();
    for (const { pubkey, isWritable } of tx.instructions.flatMap((i) => i.keys)) {
        if (!isWritable)
            continue;
        const record = await this.trackAccount(pubkey);
        if (record.status === DelegationStatus.Delegated) {
            validators.add(record.validator.toString());
        }
    }
    const vs = [...validators];
    return vs.length === 1
        ? this.routes.get(vs[0])
        : validators.size === 0
            ? this.chain
            : undefined;
}
```

**`resolveForTransaction` returns `undefined` when writable accounts are split across two
or more validators.** There is no error, no message — a bare `undefined` you will
dereference. This is a hard architectural constraint on HEARTROT, see §11.

Constructing it — and a footgun in the field name:

```typescript
import { Resolver } from "@magicblock-labs/ephemeral-rollups-sdk";

// routes: Map<validatorIdentity, erFqdn> — build this from getRoutes
const routes = new Map(
  (await getRoutes()).map((r) => [r.identity, r.fqdn])
);

const resolver = new Resolver(
  {
    chain: "https://api.devnet.solana.com",
    websocket: "https://api.devnet.solana.com", // ← must be http(s), NOT wss://
  },
  routes,
);
```

*Verified live:* the field is named `websocket`, but internally it is
`this.ws = new Connection(config.websocket)` and web3.js throws
``Endpoint URL must start with `http:` or `https:`.`` on a `wss://` value. Pass the HTTPS
URL and let web3.js derive the socket. The local skill's
`WS_ROUTER_ENDPOINT=wss://devnet-router.magicblock.app/` env var will crash this
constructor if fed in directly.

Also note `trackAccount` opens **one base-layer WS subscription per writable account** and
never deduplicates against program IDs or the fee payer, and the web3.js `Resolver` has a
`terminate()` to clean them up — the kit version does not.

### Router liveness probe

`getHealth` and `getVersion` are `-32601` on the router. Use `getRoutes`:

```bash
curl -sS --max-time 5 -X POST https://devnet-router.magicblock.app/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getRoutes"}'
```

For a specific ER, `getVersion` works and is cheap. Cross-check against
`https://status.magicblock.app/api/services`, keyed by **identity**, not FQDN (§3).

The kit SDK's own router-detection probe is worth stealing — it distinguishes a router from
an ER from a base RPC in one call. Verbatim from `kit/lib/utils.js@0.17.0`:

```js
async function isRouter(clusterUrlHttp) {
    const response = await fetch(clusterUrlHttp, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getBlockhashForAccounts",
            params: [[]],
        }),
    });
    const { result } = (await response.json());
    return (result != null &&
        typeof result.blockhash === "string" &&
        result.blockhash.length > 0);
}
```

*Verified live* against all three surfaces — it discriminates correctly, but for a subtle
reason worth knowing: the **ER also accepts `getBlockhashForAccounts`** and answers it as
if it were `getLatestBlockhash`, returning the nested `result.value.blockhash` shape. The
probe returns false only because it checks the *flat* `result.blockhash`. Base returns
`-32601`. Router returns flat. Three-way discrimination by response shape.

---

## 11. How this wires into HEARTROT

### Connection topology

```
Browser (Next.js on Cloudflare Workers)
├── baseConnection   → https://api.devnet.solana.com
│     init entities, delegate, undelegate, settle, read leaderboard
├── routerConnection → https://devnet-router.magicblock.app/
│     getRoutes, getDelegationStatus, getBlockhashForAccounts
├── erConnection     → resolved fqdn, e.g. https://devnet-as.magicblock.app/
│     ALL gameplay txs: move, shoot, tick
└── routerWS         → wss://devnet-router.magicblock.app/
      accountSubscribe on Arena, Boss, Core, Parts, Bullets

Cloudflare Worker (4 cold routes only) → base layer only. Never touches the ER.
```

The spec's "gameplay transactions go browser → ER DIRECTLY and must NEVER pass through the
backend" is **correct and confirmed** — ER blockTimeMs is 50, a Worker hop would dominate.

### Hard constraint: every raid entity must be delegated to ONE validator

HEARTROT's shoot instruction writes Boss `Parts`, Boss `Core`, `ArenaState.tick`, and the
firing player's `PlayerMeta.damage_dealt`. That is four component accounts in one
transaction. From §10, `resolveForTransaction` returns `undefined` if they resolve to
different validators, and from §6 a mixed set routes to the ER — which means a transaction
spanning two ERs cannot be built at all, and one spanning ER+base will fail on the
non-delegated account.

**Therefore: pin one validator identity per match and delegate every entity to it.**
`ArenaState`, `Boss`, `Parts`, `Core`, `Bullets`, and all 20 `Player` entities. Store the
chosen identity in the Arena account (or in `match/start`'s response) so every client and
the crank agree.

You choose the ER at **delegation time** by passing the validator identity as a remaining
account. Verbatim from the official example:

```typescript
const isLocal =
  providerEphemeralRollup.connection.rpcEndpoint.includes("localhost") ||
  providerEphemeralRollup.connection.rpcEndpoint.includes("127.0.0.1");
const validatorPubkey = new web3.PublicKey(
  process.env.VALIDATOR ||
    (isLocal
      ? "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
      : "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"),
);
const remainingAccounts = [
  { pubkey: validatorPubkey, isSigner: false, isWritable: false },
];
let tx = await program.methods
  .delegate()
  .accounts({
    payer: provider.wallet.publicKey,
    pda: counterPDA,
  })
  .remainingAccounts(remainingAccounts)
  .transaction();
```

`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (devnet-as, SGP) is the default. For a
Ghaziabad-based developer and an India-heavy playtest audience, `devnet-as` (Singapore) is
the right pick anyway; `devnet-eu`/`devnet-us` would add trans-continental RTT to every shot.

### Dual-provider pattern for BOLT

BOLT's world program is Anchor, so the canonical two-provider / two-Program pattern applies
directly. Verbatim from `counter/anchor/tests/public-counter.ts`:

```typescript
const provider = new anchor.AnchorProvider(
  new anchor.web3.Connection(
    process.env.PROVIDER_ENDPOINT ||
      process.env.ANCHOR_PROVIDER_URL ||
      "https://api.devnet.solana.com",
    {
      wsEndpoint: process.env.WS_ENDPOINT || undefined,
      commitment: "confirmed",
    },
  ),
  anchor.Wallet.local(),
);
anchor.setProvider(provider);

const providerEphemeralRollup = new anchor.AnchorProvider(
  new anchor.web3.Connection(
    process.env.EPHEMERAL_PROVIDER_ENDPOINT ||
      "https://devnet-as.magicblock.app/",
    {
      wsEndpoint:
        process.env.EPHEMERAL_WS_ENDPOINT ||
        "wss://devnet-as.magicblock.app/",
      commitment: "confirmed",
    },
  ),
  anchor.Wallet.local(),
);

const program = anchor.workspace.PublicCounter as Program<PublicCounter>;
const programEphemeral = new Program<PublicCounter>(
  program.idl,
  providerEphemeralRollup,
);
```

Two `Program` objects, same IDL, different provider. In the browser, swap
`anchor.Wallet.local()` for a wallet adapter wrapping the **session keypair** — which is
exactly what delivers the zero-wallet-popup requirement, since the session key signs every
ER transaction with no user interaction.

### Zero wallet popups

Nothing in the endpoint/router layer forces a popup. The session keypair lives in the
browser and signs locally; the router and ER only see signed wire transactions. The only
base-layer signatures (delegate, settle) are paid and signed by the platform treasury, not
the player. **Confirmed compatible with the design.**

### The crank

The 400ms boss crank is a MagicBlock-side scheduled task running against the ER. It writes
`Bullets`, `ArenaState.tick`, and Boss `Position`. Those accounts must be delegated to the
same validator the crank runs on — which is another reason the per-match validator identity
must be fixed and recorded, not discovered per-client.

### Settlement

The Magic Action chains base-layer instructions onto the ER commit. Confirm it with
`GetCommitmentSignature` (§9), and treat a throw as "unknown, poll base layer" rather than
"failed" — the parser is a log-scraper.

### Funding tiers

The browser-side airdrop tier must call `requestAirdrop` on the **base layer**
(`https://api.devnet.solana.com`), never the router — the router does not implement it, and
a session wallet needs base-layer lamports before anything can be delegated on its behalf.

---

## 12. Gotchas and failure modes — quick table

| # | Failure | Symptom | Fix |
|---|---|---|---|
| 1 | Wrong ER read | Frozen state, **no error** | Match `delegationRecord.authority` to endpoint `getIdentity` |
| 2 | Wrong ER write | `InvalidWritableAccount`, log `Account <i>: <pk> was illegally used as writable` | Re-resolve via router `fqdn` |
| 3 | `getLatestBlockhash` on router for a base tx | Base tx rejected, blockhash not found | Use `getBlockhashForAccounts` |
| 4 | `status.fqdn` on undelegated account | `undefined`, `new Connection(undefined)` throws | Guard on `isDelegated` first |
| 5 | Entities split across validators | `resolveForTransaction` → `undefined` | Pin one validator identity per match |
| 6 | v0 / lookup-table tx via `ConnectionMagicRouter` | Silently unrouted (falls to `super`) | Fetch blockhash manually |
| 7 | `Resolver({websocket: "wss://..."})` | ``Endpoint URL must start with `http:` `` | Pass the https URL |
| 8 | Race after `delegate` | `InvalidWritableAccount` right after a confirmed delegate | Poll ER `getAccountInfo`, don't sleep 3s |
| 9 | `GetCommitmentSignature` throws | Log-prefix parse failure | try/catch, treat as unknown + retry |
| 10 | Health map keyed by FQDN | TEE row never matches | Key by validator identity |
| 11 | `getHealth`/`getVersion` on router | `-32601 Method not found` | Probe with `getRoutes` |
| 12 | `programSubscribe` on router | `-32601` | Subscribe direct to the ER |
| 13 | `skipPreflight: false` on ER | Rejected before send | Always `true` |
| 14 | Pinned `ephemeral-vrf-sdk` 0.3.0 | Yanked crate | Use 0.17.0 |

---

## 13. Contradictions with the stated design assumptions and the local skill

Flagged explicitly, as requested.

1. **Version drift — the biggest one.** The local `magicblock` skill pins
   `@magicblock-labs/ephemeral-rollups-sdk` and the Rust `ephemeral-rollups-sdk` at
   **0.14.3**. Both are **0.17.0** as of 2026-08-26. It also pins `ephemeral-vrf-sdk 0.3.0`,
   which is **yanked** on crates.io. Do not use the skill's dependency block verbatim.

2. **The skill's ER-ownership debugging heuristic is not sufficient.** It states that on the
   correct ER the account shows the original program as owner — true, but §10 proves the
   *wrong* ER shows exactly the same thing with stale data. The heuristic cannot detect the
   most likely misconfiguration.

3. **`WS_ROUTER_ENDPOINT=wss://devnet-router.magicblock.app/`** from the skill's env block
   crashes the `Resolver` constructor (§10) and is only valid for raw WS clients.

4. **The skill's FQDN table lists `devnet-tee-as.magicblock.app`**; `getRoutes` — which is
   what the SDK and router actually use — says `devnet-tee.magicblock.app`. Same validator,
   different string (§3).

5. **`https://rpc.magicblock.app/devnet` is presented as "the base RPC"** in the skill. It is
   a Triton One Solana RPC. Harmless, but it is not MagicBlock infrastructure and confers no
   ER awareness.

6. **The design spec's "browser → ER directly" is right, but under-specified.** The spec
   implies a single known ER endpoint. In reality the endpoint is a function of *which
   validator the match's entities were delegated to*, which is a per-match decision that has
   to be made at delegation time and propagated to every client and the crank. This is a
   real schema requirement: **the Arena entity (or `match/start`'s response) needs a
   `validator_identity` field.** The spec's component list does not have one.

7. **The spec's 4-cold-route backend does not include a route for validator selection.**
   `match/start` must now also return the chosen validator identity and its FQDN. That is a
   payload change, not a new route — the count of 4 survives.

8. **Not contradicted, confirmed:** 400ms crank vs 50ms ER blocks is comfortable; hitscan
   (no bullet entities) avoids the account-creation problem entirely; zero wallet popups is
   unaffected by the routing layer; `bullets_per_volley = 3 + alive_players` is a program
   concern with no endpoint implication.

---

## 14. Open questions this research could not close

- **Does the router's `accountSubscribe` survive a live re-delegation to a different
  validator without resubscribing?** Strongly implied by its design and by the fact that it
  proxies transparently, but proving it requires delegating an account I control and moving
  it mid-subscription. **Not verified.**
- **Whether a non-BOLT Pinocchio program can touch BOLT component accounts.** Out of scope
  here, but relevant: the engine examples repo contains
  `00-LEGACY_EXAMPLES/pinocchio-private-counter/` (Rust program + both `tests/kit` and
  `tests/web3js` clients), which proves *native Pinocchio programs delegate and run on ERs
  normally*. It says nothing about cross-program access to BOLT-owned component accounts.
  The `counter/` directory also carries `native-rust` alongside `anchor`. Whoever researches
  the Pinocchio question should start there.
- **Per-IP or per-key rate limits on the devnet router.** Nothing documented; no limit hit
  during this research, but the probe volume was low. 20 players polling could differ.
- **TEE endpoint auth.** The RPC docs note "TEE RPC endpoints may require an authentication
  token for certain methods". Unverified and irrelevant unless HEARTROT wants a private ER.
- **`getBlockhashForAccounts` behaviour when accounts span two different ERs.** Only the
  delegated/undelegated mix was testable (§6). The two-ER case needs two accounts delegated
  to different validators.

---

## Sources

Every URL below was actually fetched or probed during this research on 2026-08-31.

**Live JSON-RPC endpoints probed**
- https://devnet-router.magicblock.app/
- https://router.magicblock.app/
- https://devnet-as.magicblock.app/
- https://devnet-eu.magicblock.app/
- https://devnet-us.magicblock.app/
- https://devnet-tee.magicblock.app/
- https://devnet-tee-as.magicblock.app/
- https://devnet.magicblock.app/
- https://rpc.magicblock.app/devnet
- wss://devnet-router.magicblock.app/
- wss://devnet-as.magicblock.app/
- wss://devnet-eu.magicblock.app/
- wss://devnet-us.magicblock.app/
- wss://devnet-tee.magicblock.app/
- wss://devnet-tee-as.magicblock.app/
- wss://rpc.magicblock.app/devnet

**Status API**
- https://status.magicblock.app/api/services

**Official documentation**
- https://docs.magicblock.gg/llms.txt
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getDelegationStatus
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/getBlockhashForAccounts.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/introduction
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/rpc/introduction.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router.md

**Package registries (version pinning)**
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-kit
- https://crates.io/api/v1/crates/ephemeral-rollups-sdk
- https://crates.io/api/v1/crates/ephemeral-vrf-sdk
- https://crates.io/api/v1/crates/magicblock-magic-program-api

**Source read directly (published tarballs, v0.17.0)**
- `@magicblock-labs/ephemeral-rollups-sdk@0.17.0` — `lib/magic-router.js`, `lib/resolver.js`, `lib/utils.js`, `lib/constants.js`, `lib/pda.d.ts`, `lib/__test__/magic-router.test.js`, `lib/__test__/resolver.test.js`
- `@magicblock-labs/ephemeral-rollups-kit@0.17.0` — `lib/connection.js`, `lib/utils.js`, `lib/resolver.d.ts`, `lib/confirmation.d.ts`

**Repository source (via GitHub API)**
- https://github.com/magicblock-labs/magicblock-engine-examples — file tree at `main`
- https://raw.githubusercontent.com/magicblock-labs/magicblock-engine-examples/main/README.md
- `counter/anchor/tests/public-counter.ts` (fetched via `gh api .../contents/...`)

**Secondary (background only, not relied on for any claim)**
- https://www.magicblock.xyz/blog/a-guide-to-ephemeral-rollups
- https://github.com/magicblock-labs/ephemeral-rollups-sdk
