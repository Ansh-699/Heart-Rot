# research: rpc-fast — the client send path

Date 2026-09-01. Player in India (Ghaziabad). Target `@solana/kit` 8.2.0, browser app +
Node worker. ER `magicblock-core` 0.14.13 / `solana-core` 4.0.0 (read live from
`getVersion`).

Scope of the question: can the send path issue a transaction without a fresh blockhash per
call; do connection reuse / agent config / HTTP-2 buy anything; do durable nonces help; how
long does a blockhash live on an ER; can transactions be pre-signed and queued.

Everything below is either measured here, quoted from a primary source, or explicitly
marked inferred.

---

## 0. What this run adds that the earlier spikes did not

Three sibling spikes (`submit.md`, `execute.md`, `notify.md`, `clientside.md`) already
established the shape of the budget. This document does not re-derive it. Two things are
new:

1. **A closer ER exists.** `devnet-tee.magicblock.app` answers a warm application round
   trip in **90.1 ms p50** against `devnet-as`'s **125.6 ms p50** from India, at the same
   50 ms slot cadence and the same core version. Since three prior spikes independently
   showed that write-to-visible *equals* one application round trip on a direct ER
   subscription, this is the largest remaining lever after the blockhash cache.
2. **The 1200-block blockhash window is confirmed live and explained.** The ER reports
   `lastValidBlockHeight = blockHeight + ~1182`, not the 150 of the base layer, which is
   why the earlier acceptance measurement found ~58–60 s rather than the 7.5 s a naive
   150-slots-at-50-ms calculation predicts.

Everything else researched here came back negative, which is recorded in §6.

---

## 1. Can `sendTransaction` be issued without a fresh blockhash per call?

**Yes, and this is the headline.** A blockhash is not a nonce that the RPC issues per
call; it is a lifetime token, and the node accepts any blockhash still inside its recent
blockhash queue. Nothing in the JSON-RPC contract requires a fetch per send.

Kit's type system enforces only that a message *has* a lifetime before it can be signed —
`setTransactionMessageLifetimeUsingBlockhash` — not that the value is fresh. Calling it
with a cached value produces a transaction identical in every respect to one built from a
freshly fetched hash.

### Measured live, just now, on `devnet-as`

`getLatestBlockhash` at three commitments against the current `blockHeight` of
565,093,093:

| commitment | `lastValidBlockHeight` | headroom (blocks) |
|---|---|---|
| processed | 565,094,275 | 1,182 |
| confirmed | 565,094,284 | 1,191 |
| finalized | 565,094,286 | 1,193 |

At the measured slot cadence of 50 ms (§4), 1,182 blocks is **≈ 59 s of wall clock**. That
reconciles exactly with the acceptance boundary the sibling spike measured by holding one
hash and resending until refused: last accepted at 58,021 ms / 59,725 ms, first rejected at
60,155 ms / 61,845 ms with `-32003 Blockhash not found` (`docs/perf/execute.md`).

So the ER's window is **not** the base layer's 150 slots. On base, the queue is
`MAX_PROCESSING_AGE = 150` entries, which at 400 ms slots is the familiar ~60 s; the ER
keeps ~1,200 entries at 50 ms slots to land on roughly the same *wall clock* window. Two
independent measurements, one live probe and one send-until-refused, agree on ~59 s.

**A 2 s refresh interval therefore runs at ~30× margin.** Note also that `finalized`
(kit's default) reports a slightly *larger* window than `processed` here — 1,193 vs 1,182
blocks — because a single-validator ER has no fork to roll back. There is no reason to
switch commitment; the difference is 0.5 s of an already 30× margin.

Confidence: **measured** (live probe here; acceptance boundary in `execute.md`).

Sources: [Durable Transaction Nonces, Agave](https://docs.anza.xyz/implemented-proposals/durable-tx-nonces) ·
[Durable Nonces, Solana docs](https://solana.com/docs/core/transactions/durable-nonces)

---

## 2. Durable nonces — structurally unavailable here, and slower even if they were

Durable nonces are the canonical answer to "my blockhash expires". They are the wrong tool
for this problem, for two independent reasons, either of which alone is fatal.

**Reason 1 — a nonce account cannot live on the ER.** The Solana docs state plainly that
"a nonce account is a System Program-owned account", and the runtime detects durable-nonce
usage by requiring `AdvanceNonceAccount` as the *first* instruction with the nonce account
first and writable. MagicBlock's delegation flow does support on-curve (System-owned)
accounts, but it does so by *reassigning ownership to the delegation program*
(`SystemProgram.assign()` then delegate) — after which the account is no longer
System-owned and the System program can no longer advance it. Delegating a nonce account
destroys the thing that makes it a nonce account.

**Reason 2 — it would add back the round trip we are removing.** Agave's own proposal
states the client "must first query its value from account data", and that the advance
"fail[s] if that matches the value already stored there". The new nonce is the cluster's
most recent blockhash at execution time, so it is not predictable client-side. Every send
would need the *previous* send's resulting nonce, learned either by an RPC read (one round
trip per keypress — exactly today's cost) or by waiting for the account notification over
the existing websocket (~130 ms, measured in `notify.md`). At a 50 ms input cadence the
websocket variant caps throughput at one transaction per ~130 ms, which is **worse than
the status quo**, and the single-nonce-account design serialises sends by construction.

Confidence: **documented** (both constraints from primary sources) with the throughput
consequence **inferred** from this repo's measured notification latency.

Sources: [Durable Nonces, Solana docs](https://solana.com/docs/core/transactions/durable-nonces) ·
[Durable Transaction Nonces, Agave](https://docs.anza.xyz/implemented-proposals/durable-tx-nonces) ·
[MagicBlock quickstart — on-curve delegation](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart)

---

## 3. Connection reuse, agent configuration, HTTP/2 — all unavailable or already done

### The browser build of kit ignores dispatcher configuration entirely

Read from the actual shipped source,
`@solana/rpc-transport-http@8.2.0/dist/index.browser.mjs`:

```js
var didWarnDispatcherWasSuppliedInNonNodeEnvironment = false;
function warnDispatcherWasSuppliedInNonNodeEnvironment() {
  console.warn(
    "You have supplied a `Dispatcher` to `createHttpTransport()`. It has been ignored " +
    "because Undici dispatchers only work in Node environments. ..."
  );
}
```

and the request it actually issues:

```js
const requestInfo = {
  ...dispatcherConfig,          // {} in the browser build
  body,
  headers: { ...customHeaders, accept: "application/json",
             "content-type": "application/json; charset=utf-8" },
  method: "POST",
  signal
};
const response = await fetch(url, requestInfo);
```

`dispatcher_NODE_ONLY` is a no-op in the browser (the node build sets
`dispatcherConfig = { dispatcher: config.dispatcher_NODE_ONLY }`; the browser build never
assigns it). So **every undici Agent / Pool / `keepAliveTimeout` / `connections` knob is
unreachable from the app.** Pool tuning is available only to the worker and to spike
scripts, and `submit.md` already showed 0 new sockets across 224 warm sends, so there is
nothing there to win either.

Note also that kit's transport sets **no** `keepalive: true` and no `priority` on the
fetch. `keepalive: true` is not a performance flag — it is the flag that lets a request
outlive page unload, at the cost of a 64 KB body cap and, in Chromium, a different
out-of-renderer request path. It is not a latency lever and may be a regression.

### HTTP/2 is already in use, and is already known to buy nothing

Measured here with curl against both hosts:

| host | ALPN | server | `alt-svc` |
|---|---|---|---|
| `devnet-as.magicblock.app` | **h2** | nginx | *absent* |
| `devnet-router.magicblock.app` | **h2** | cloudflare | *absent* |

The ER negotiates HTTP/2 and the browser will use it automatically. `submit.md` already
measured h1 140.1 vs h2 129.7 p50 serially — inside run-to-run noise — and measured
pipelining as 4.7× *worse*. Nothing to do.

**No HTTP/3.** Neither host advertises `alt-svc`, so there is no QUIC upgrade path, and no
0-RTT or head-of-line-blocking win available on a lossy long-haul link. This was the one
transport-level idea with a plausible tail benefit and it is simply not offered.

Also worth recording: the ER is behind **nginx**, which is a reasonable explanation for the
5–14 ms of "ER think" that `submit.md` isolated between the raw TCP RTT and the warm
send — TLS termination and proxy hop, not validator work.

Confidence: **measured** (SDK source read directly; ALPN and headers probed live).

Sources: [anza-xyz/kit](https://github.com/anza-xyz/kit) ·
[@solana/rpc-transport-http](https://www.npmjs.com/package/@solana/rpc-transport-http) ·
local `node_modules/.pnpm/@solana+rpc-transport-http@8.2.0/...`

---

## 4. A closer ER: `devnet-tee` is 35 ms nearer than `devnet-as` from India

MagicBlock's documented devnet endpoints are Asia, EU, US, TEE, plus the router. I measured
all of them.

### TCP connect handshake (port 443, no server work), n=25–30

| endpoint | resolved | min | **p50** | p90 |
|---|---|---|---|---|
| `devnet-tee.magicblock.app` | 34.87.52.79 | 82.8 | **89.8** | — |
| `devnet-as.magicblock.app` | 67.213.122.145 | 110.5 | **120.1** | 131.6 |
| `devnet.magicblock.app` | 67.213.122.145 | 110.5 | **123.5** | 130.4 |
| `devnet-eu.magicblock.app` | 160.202.131.253 | 159.9 | **176.0** | 254.5 |
| `devnet-router.magicblock.app` | Cloudflare anycast | 165.5 | **184.1** | 190.1 |
| `devnet-us.magicblock.app` | 109.94.98.35 | 225.1 | **483.5** | 537.1 |

`devnet.magicblock.app` and `devnet-as.magicblock.app` resolve to the **same IP**, so the
generic endpoint already *is* the Asia validator from India. There is no un-pinned win
hiding there.

### Warm application round trip (`getSlot` POST on a warmed keep-alive connection), n=40

A TCP handshake can lie when an anycast edge terminates near you and back-hauls far away —
which is exactly what the router does. So I re-measured with a real RPC call:

| endpoint | validator identity | min | **p50** | p90 |
|---|---|---|---|---|
| `devnet-tee` | `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` | 81.7 | **90.1** | 104.2 |
| `devnet-as` | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` | 114.5 | **125.6** | 147.9 |
| `devnet-eu` | `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` | 216.2 | **235.3** | 679.1 |

The application RTT agrees with the handshake RTT on both `as` (125.6 vs 121.7) and `tee`
(90.1 vs 89.8), so neither is an anycast artefact. **TEE is genuinely 35 ms closer at p50
and 44 ms closer at p90.**

### Slot cadence, `slotSubscribe`, 250 notifications each, consecutive gaps only

| endpoint | consec | min | **p50** | p90 | max |
|---|---|---|---|---|---|
| `devnet-as` | 249 | 40 | **50** | 53 | 59 |
| `devnet-tee` | 249 | 7 | **50** | 53 | 92 |

Identical cadence, same `magicblock-core` 0.14.13. The TEE validator's tail is slightly
looser (max 92 ms vs 59 ms) but the median and p90 are the same, so the 50 ms movement
gating in the program is unaffected.

**Why this matters so much:** `execute.md` and `notify.md` both concluded that
send-to-visible on a direct ER subscription *equals* one application round trip — 132 ms
observed against a 133 ms measured `getSlot` RTT, decomposing as ~65 ms out, 0 ms execute,
~65 ms back. If that identity holds on the TEE validator, moving the delegation there
converts a 125.6 ms round trip into a 90.1 ms one and takes ~35 ms straight off
write-to-visible.

**What is NOT measured:** no arena is delegated to `MTEWGuq...`, so the end-to-end saving
is an inference from the RTT, not an observation. The chain behind it is strong — three
independent spikes established RTT-equals-visibility — but the TEE validator's own
execute and notify behaviour, its rate limits, and any per-transaction attestation cost
are unmeasured. This is the one lever in this document that needs a live delegated seat
before anyone should believe the number.

Confidence: **measured** for the RTT, the identity, and the cadence. **Inferred** for the
end-to-end saving.

Sources: [MagicBlock quickstart — endpoints](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart) ·
[Introducing Magic Router](https://medium.com/@magicblock/introducing-magic-router-one-endpoint-every-environment-11b70159da3b)

### Corollary: routing the write through a Cloudflare edge is refuted, not untested

An obvious idea is to POST to a Cloudflare Worker in Mumbai and let Cloudflare's backbone
carry the write to Singapore — attractive because sends are fire-and-forget, so only the
*outbound* leg would matter. The router already is a Cloudflare-fronted path to the same
ER, and it measures **184.1 ms** TCP RTT against the ER's **120.1 ms**. The experiment has
effectively already been run and it is 64 ms slower. Dead.

---

## 5. Pre-signing and queueing — possible, and worth ~0.2 ms

Yes, transactions can be pre-signed and held. A signed transaction is just bytes; nothing
binds it to the moment of signing except its blockhash lifetime, which §1 shows is good for
~59 s on the ER. You could pre-build and pre-sign the next `move` for all four directions
and, at keypress, do nothing but the `fetch`.

The reason not to bother is that `clientside.md` already measured the entire local send
CPU at **0.222 ms p50** — build v0 message 0.000 ms, WebCrypto Ed25519 sign 0.203 ms,
base64 wire encoding 0.005 ms, signature extraction 0.016 ms. That is **0.08 %** of the
295 ms p50. Pre-signing four direction variants per seq costs 4× the signing work in the
background to save 0.2 ms in the foreground.

Worse, it fights the correctness fix. `move` carries a monotonic `u16` seq, so a pre-signed
queue must guess the seq, and any misprediction (a refused move, a dropped input)
invalidates the whole queue and forces a re-sign at exactly the moment you were trying to
make cheap.

**The useful half of "pre-signing" is just the cached blockhash.** Caching the hash is what
removes the round trip; pre-signing on top of it removes 0.2 ms. Do the first, skip the
second.

Confidence: **measured** (the 0.222 ms is from `docs/perf/clientside.md`, n=2000 per stage).

---

## 6. Dead ends

Recorded so nobody re-runs them.

- **Durable nonces.** Structurally impossible on an ER (delegation reassigns ownership away
  from the System program, which is what a nonce account must be owned by) and slower even
  in the counterfactual, because the next nonce is unpredictable and must be read back.
- **Undici Agent / Pool / keep-alive tuning from the app.** Unreachable: kit's browser
  build discards `dispatcher_NODE_ONLY` and warns about it. Verified in the shipped source,
  not inferred.
- **HTTP/2.** Already negotiated (ALPN h2, nginx). Already measured as noise-equivalent to
  h1 serially in `submit.md`.
- **HTTP/3 / QUIC / 0-RTT.** Not offered. Neither the ER nor the router sends `alt-svc`.
  This was the only remaining transport-layer idea with a real tail-latency story.
- **`keepalive: true` on the fetch.** Not a performance flag. It is page-unload survival,
  with a 64 KB cap and a different Chromium request path. Likely neutral-to-negative.
- **`fetch` priority hints.** The game issues roughly one request per 50 ms; there is no
  contention for the browser to prioritise against. Untested because there is nothing for
  it to win.
- **Cheaper RPC method for the blockhash.** `submit.md`: `getLatestBlockhash` 142.4 vs
  `sendTransaction` 140.1 p50 on the same warm socket. The cost is the round trip, not the
  method. Confirmed again here — `getSlot` costs the same as everything else.
- **`devnet.magicblock.app` as an alternative to the pinned `devnet-as`.** Same IP. Same
  box. No difference.
- **`devnet-eu` / `devnet-us`.** 235 ms and 483 ms p50 from India. Far worse.
- **Cloudflare-edge write forwarding.** Refuted by the router's own numbers: the existing
  Cloudflare-fronted path to the same ER is 64 ms *slower* than direct.
- **Pre-signing a queue of transactions.** 0.222 ms of total local CPU to reclaim, and it
  makes seq prediction a new failure mode.
- **HTTP/1.1 pipelining, connection fan-out, DNS, local crypto, request framing.** All
  measured and rejected in `submit.md`. Not revisited.

---

## 7. Ranked levers

| # | lever | expected | confidence |
|---|---|---|---|
| 1 | Cache the ER blockhash in `sendInstructions`, refresh on a ~2 s background timer | **−130 ms p50** | measured |
| 2 | Re-pin delegation from `devnet-as` to `devnet-tee` | **−35 ms p50, −44 ms p90** | RTT + cadence measured; end-to-end inferred |
| 3 | Subscribe on the pinned ER's own websocket instead of the router's | **−32 to −40 ms p50** | measured (`notify.md`), corroborated here |
| 4 | Everything else in this document | **0 ms** | measured |

Levers 1 and 3 are already established by the sibling spikes; this run only confirms their
mechanism from primary sources (§1, §3) and adds independent corroboration for lever 3 (the
router is 64 ms slower than the ER on a bare handshake, which is a second, transport-level
witness to the proxy cost that `notify.md` measured at the application level).

Lever 2 is new.

### Note on lever 1's known hazard

Both `submit.md` and `execute.md` flag it and this research does not dislodge it: a cached
blockhash makes byte-identical messages collide. `move` is safe because its `u16` seq
changes every send. `shoot` carries only `[tag, seat, dir]` and would produce a duplicate
signature, which the ER refuses with `-32003 "This transaction has already been
processed"` — measured, not theorised. `sp_load.ts:249` already solves this with a varying
`SetComputeUnitLimit` as a uniqueness nonce; ER fees are zero and the extra program-id key
is nowhere near the ~38-key ceiling. The cache must also be keyed per RPC endpoint, or an
ER blockhash reaches base devnet through the worker's routes.

---

## Sources

- [anza-xyz/kit — Solana JavaScript SDK](https://github.com/anza-xyz/kit)
- [@solana/rpc-transport-http](https://www.npmjs.com/package/@solana/rpc-transport-http) and the shipped `dist/index.browser.mjs` / `dist/index.node.mjs` in this repo's `node_modules`
- [@solana/rpc](https://www.npmjs.com/package/@solana/rpc)
- [Durable Nonces — Solana docs](https://solana.com/docs/core/transactions/durable-nonces)
- [Durable Transaction Nonces — Agave implemented proposals](https://docs.anza.xyz/implemented-proposals/durable-tx-nonces)
- [Durable Transaction Nonces in the Solana CLI — Agave](https://docs.anza.xyz/cli/examples/durable-nonce)
- [advance_nonce_account — solana-system-interface](https://docs.rs/solana-system-interface/latest/solana_system_interface/instruction/fn.advance_nonce_account.html)
- [MagicBlock — Ephemeral Rollups quickstart](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart)
- [Introducing Magic Router — MagicBlock](https://medium.com/@magicblock/introducing-magic-router-one-endpoint-every-environment-11b70159da3b)
- In-repo prior measurement: `docs/perf/submit.md`, `docs/perf/execute.md`, `docs/perf/notify.md`, `docs/perf/clientside.md`, `docs/spikes/sp-load.md`
