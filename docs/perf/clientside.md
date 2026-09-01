# PERF-CLIENTSIDE — the browser's own contribution to write-to-visible

**Verdict: the read hop is 16 µs and not worth touching. The send path hides a full
extra round trip — `sendInstructions` fetches a blockhash before every keypress, and that
POST is a measured p50 of 122–129 ms to `devnet-as`.**

Script `scripts/spike/perf_clientside.ts`, run twice against real devnet on 2026-09-01.
Program `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, arena `1788266869`
(`8tSqFZJ57sRdERfu5qMZd2y7wQo5LhEUJCAazpwD75YZ`), player in India, ER
`https://devnet-as.magicblock.app/` (Singapore).

Every decoder, the store and the signer are the production objects — `decodeArena`,
`decodeBoss`, `decodePlayers` and `createSessionSigner` come from `packages/client`, and
`createStore` from `app/src/state/store.ts`. Nothing is a stand-in except `fromBase64`,
which is module-private in `subscribe.ts` and is copied verbatim.

## Method

- **CPU stages**: n = 2,000 individually-timed iterations each, 300 warm-up, per-call
  `process.hrtime.bigint()`. Timer overhead (~40 ns) is reported into the numbers rather
  than subtracted. Every result is fed to a sink so V8 cannot eliminate the call.
- **Network stages**: n = 120 sequential round trips, 20 ms apart.
- **Payloads**: real account bytes for the newest arena the leaderboard names, read at
  `getMultipleAccounts … encoding: 'base64'`. Sizes came back exactly as the layout
  contract says: **Arena 1,200 B** (1,600 B base64), **Boss 50 B** (68 B), **Players
  1,924 B** (2,568 B).
- **Envelope caveat, stated plainly.** The script opens the router WebSocket
  (`wss://devnet-router.magicblock.app/`) and `accountSubscribe`s all three accounts to
  capture whole frames. **No match was live during either run, so it captured 0 frames**
  and the `accountNotification` envelope was reconstructed around the same real base64
  payload (Players 2,854 B, Arena 1,886 B, Boss 352 B). Envelope parse cost scales with
  the base64 blob inside it, which is real; the surrounding ~290 B of JSON is not the term
  that matters. Re-run during a live raid to replace this with captured frames.
- **Not measured: React's commit.** No DOM runtime is installed and adding one would be a
  dependency bought for a microbenchmark. What can be said without measuring it: the store
  notification is bounded by one 60 fps frame (16.7 ms) by construction, and the renderer
  interpolates every frame regardless of whether a notification arrived, so a re-render
  cannot delay the frame a notification is visible in by more than one frame. If it ever
  needs a number, it needs a browser profile, not this script.

## 1. The read path — 16 µs, and that is the whole answer

Bytes off the socket → decoded state in the store. Median of 2,000, run 2 in brackets
where it differed.

| stage | p50 ms | p95 ms | p99 ms | max ms |
|---|---|---|---|---|
| `JSON.parse` — Players envelope (2,854 B) | 0.001 | 0.002 | 0.005 | 0.180 |
| `JSON.parse` — Arena envelope (1,886 B) | 0.001 | 0.003 | 0.008 | 0.301 |
| `JSON.parse` — Boss envelope (352 B) | 0.001 | 0.001 | 0.001 | 0.071 |
| `fromBase64` — Players (2,568 → 1,924 B) | 0.004 | 0.006 | 0.010 | 0.144 |
| `fromBase64` — Arena (1,600 → 1,200 B) | 0.002 | 0.008 | 0.014 | 0.774 |
| `fromBase64` — Boss (68 → 50 B) | 0.000 | 0.000 | 0.000 | 0.086 |
| `decodePlayers` — **builds 20 slot objects** | 0.006 | 0.012 [0.017] | 0.050 | 1.165 |
| `decodeArena` — builds 64 bullet objects | 0.004 | 0.004 | 0.009 | 0.086 |
| `decodeBoss` | 0.000 | 0.001 | 0.001 | 0.073 |
| **whole hop, Players**: parse → base64 → decode → `store.setWorld` | **0.011** [0.014] | 0.020 | 0.065 | 0.159 |
| **whole hop, Arena**: same, end to end | **0.005** | 0.007 | 0.017 | 0.084 |

The task asked whether decoding twenty player slots at ~10 Hz is 1 ms or 20 ms. **It is
6 µs.** The whole read hop for one crank tick — an Arena notification and a Players
notification, parsed, base64-decoded, decoded into objects, and pushed through
`setWorld` including `recordWorld`'s metrics bookkeeping — is **0.016 ms**.

That is **0.005 % of the 295 ms p50** the app reports. Write-to-visible would have to
improve by three orders of magnitude before any of it were visible. `Uint8Array.fromBase64`
was probed as a replacement for the per-byte `atob` loop and is not present in Node 24
anyway; at 4 µs there is nothing for it to win.

**No lever here. Do not touch the decoders, the base64 helper, or the store.**

## 2. The send path — 0.22 ms of CPU sitting behind a 122 ms round trip

`App.tsx` calls `recordSend(seq)` and then `sendInstructions(er, signer, [ix])`, whose
first line is:

```ts
const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
```

That is a full HTTP POST to Singapore, awaited, **before the transaction is even built** —
and `recordSend` has already started the clock, so it is inside every latency number the
telemetry panel shows.

| stage | p50 ms | p95 ms | p99 ms | note |
|---|---|---|---|---|
| **`getLatestBlockhash` → ER** | **122.4 / 129.1** | 222.1 / 145.0 | 348.7 / 207.7 | n = 120 per run, two runs |
| `getSlot` → ER (control) | 124.4 / 126.2 | 138.9 / 192.0 | 365.1 / 331.4 | same cost, different method |
| build v0 message (`pipe`, 3 keys) | 0.000 | 0.001 | 0.001 | free |
| **sign** — WebCrypto Ed25519, non-extractable | 0.203 | 0.394 | 1.328 | the only CPU worth naming |
| `getBase64EncodedWireTransaction` | 0.005 | 0.010 | 0.039 | free |
| `getSignatureFromTransaction` | 0.016 | 0.025 | 0.052 | free |
| **all local CPU per send** | **0.222** | — | — | 0.08 % of p50 |

`getSlot` costs the same as `getLatestBlockhash`, so this is the POST round trip to
`devnet-as`, not an expensive method. It is not shavable by picking a cheaper RPC call —
only by not making the call.

Signing is not free but it is not a lever either: 0.2 ms of WebCrypto against a 122 ms
round trip. The non-extractable key stays.

### The arithmetic reconciles

| term | ms |
|---|---|
| blockhash round trip (measured here) | 122 |
| POST + execute + notification back (`docs/spikes/sp-load.md`, cached blockhash) | 141 |
| ER slot coalescing, one notification per account per 50 ms slot | 0–50 |
| client CPU, both halves (measured here) | 0.24 |
| **modelled total** | **263–313** |
| **observed live p50** | **295** |

And `sp-load.md` measured write-to-visible at **p50 200 ms** — with a **cached** blockhash.
The app's 295 ms and the spike's 200 ms differ by roughly one blockhash fetch, which is
exactly what this measurement says the app is paying and the spike was not.

## 3. The lever

**Cache the ER blockhash in the browser and refresh it on a background timer.** Estimated
saving **~120 ms at p50, ~150–220 ms at p95** — about 40 % of write-to-visible, and larger
than anything else identified so far.

Confidence: the 122 ms round trip is **measured** twice here; the resulting saving is
arithmetic on it, not a separate measurement. It is not confirmed end-to-end because that
needs a live delegated seat.

Prior art in this repo, so this is not speculation about whether the ER accepts it:
`scripts/spike/sp_load.ts` (lines 1226–1238) ran exactly this — a cached blockhash on a
**4,000 ms** refresh loop — while sustaining 242 tx/s across two 50 s phases with 20 seats,
and `sp-load.md` reports no blockhash failures.

Three things the change must get right:

1. **Refresh interval.** A Solana blockhash lives 150 slots; at the ER's 50 ms slot that
   is ~7.5 s. A 1–2 s refresh keeps every send ~20–40 slots inside the window. The refresh
   itself is off the hot path — nothing waits on it.
2. **`shoot` needs a uniqueness nonce.** `move` carries an incrementing `seq`, so two moves
   never compile to the same message. `shoot` carries no sequence number, so two identical
   shots from the same seat in the same direction *under the same cached blockhash* are
   byte-identical, produce the same signature, and the node silently deduplicates the
   second — a phantom dropped shot. `sp_load.ts` hit this and solved it with a varying
   `SetComputeUnitLimit` (`computeBudgetNonce`, line 249). Same fix applies; ER fees are
   zero and one extra program-id key is nowhere near the ~38-key cap.
3. **First send after a reconnect or re-delegation.** The cache must be seeded from the
   pinned ER and re-seeded whenever the match re-pins, or a send goes out against a
   blockhash from a different chain.

The change belongs in `packages/client/src/connection.ts` (the blockhash source) and
`app/src/App.tsx` (owning the refresh timer). **`App.tsx` is frozen for this run**, so the
in-scope half is a cached-blockhash send in the SDK; the caller wiring is recorded as a
todo rather than made.

## 4. Dead ends, recorded so nobody re-checks them

- **Decoder cost.** 6 µs for twenty seats. Rewriting `decodePlayers` into a flat typed
  array, or decoding lazily, buys at most 6 µs of a 295 ms budget.
- **`JSON.parse` of the envelope.** 1 µs. A binary subscription encoding would save 1 µs.
- **The `atob` per-byte loop.** 4 µs on the largest payload. `Uint8Array.fromBase64` is not
  in Node 24 and is not needed anywhere.
- **`store.setWorld` and `recordWorld`.** Inside the 11 µs whole-hop figure; the store is
  an object spread over ten fields and a listener loop.
- **A cheaper RPC method for the blockhash.** `getSlot` costs the same 124 ms. The cost is
  the POST, not the method.
- **Signing.** 0.2 ms. The non-extractable WebCrypto key costs nothing worth reclaiming.
