# PERF-SUBMIT — the submit hop, decomposed

**Verdict: the hop itself is at the physics floor and not worth touching. The app pays it
twice.**

The warm submit hop is 130 ms p50, of which ~124 ms is one round trip to Singapore and
~1.3 ms is everything this codebase controls. There is no handshake being paid per send,
HTTP/2 is already negotiated, and pipelining makes it worse. The one real finding is that
`sendInstructions` fetches a fresh blockhash before **every** send, so a keypress costs two
serial round trips — **269–307 ms p50 instead of 130 ms**.

Script: `scripts/spike/perf_submit.ts`. Endpoint `https://devnet-as.magicblock.app/`,
identity `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`, from India. Transactions are real
`move` instructions built and signed through `packages/client` (`movePlayer` + kit), posted
as the exact JSON-RPC body kit puts on the wire.

```
./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/perf_submit.ts --bundle --platform=node --format=esm \
  --define:import.meta.env='{"DEV":false}' \
  --alias:undici=./node_modules/.pnpm/undici@7.29.0/node_modules/undici \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=/tmp/perf_submit.mjs && PERF_N=224 PERF_PACE=100 node /tmp/perf_submit.mjs
```

Four runs. Run 4 is the run of record (it is the only one carrying every phase); runs 1–3
are replication and are quoted where the point is stability. Raw per-sample arrays land in
`docs/perf/submit-raw.json`. 224 samples per phase, paced at 100 ms — half the app's send
rate, so nothing here is queueing behind itself.

---

## 1. The measurement

All figures milliseconds. Run 4.

| phase | n | min | p50 | p90 | p95 | p99 | max | mean |
|---|---|---|---|---|---|---|---|---|
| dns lookup | 60 | 0.1 | **0.2** | 0.2 | 0.3 | 9.7 | 9.7 | 0.3 |
| tcp connect (cold) | 40 | 114.6 | **125.1** | 131.7 | 132.5 | 170.0 | 170.0 | 125.4 |
| tls handshake (cold) | 40 | 125.0 | **136.7** | 180.9 | 233.1 | 271.3 | 271.3 | 146.3 |
| local sign+encode | 224 | 0.2 | **0.3** | 0.6 | 0.6 | 2.9 | 9.4 | 0.4 |
| h1 keep-alive send · total | 224 | 123.8 | **140.1** | 180.2 | 214.5 | 296.6 | 379.9 | 150.3 |
| h1 keep-alive send · decide→bytes written | 224 | 0.1 | **1.2** | 1.3 | 1.7 | 2.3 | 3.0 | 1.2 |
| h1 keep-alive send · written→first resp byte | 224 | 122.5 | **138.7** | 178.9 | 212.1 | 295.3 | 378.6 | 148.9 |
| h1 keep-alive send · resp headers→body read | 224 | 0.1 | **0.1** | 0.2 | 0.3 | 0.6 | 0.9 | 0.1 |
| h1 keep-alive getLatestBlockhash | 224 | 119.4 | **142.4** | 204.6 | 229.5 | 243.8 | 249.4 | 157.4 |
| cold-connection send · total | 224 | 366.7 | **445.0** | 552.8 | 613.2 | 5642.0 | 6619.6 | 551.6 |
| cold-connection send · decide→bytes written | 224 | 240.9 | **293.5** | 373.8 | 410.9 | 5502.5 | 6418.2 | 399.5 |
| cold-connection send · written→first resp byte | 224 | 115.9 | **137.7** | 202.7 | 210.9 | 252.9 | 319.6 | 151.9 |
| h2 native, one session, serial | 224 | 113.9 | **129.7** | 145.8 | 185.9 | 219.6 | 296.4 | 135.5 |
| h1 pipelining=8 (burst of 8) | 224 | 120.7 | **652.7** | 1150.2 | 1227.1 | 1373.3 | 1459.8 | 665.5 |
| h2 native multiplexed (burst of 8) | 224 | 120.8 | **169.4** | 325.3 | 362.1 | 367.2 | 428.5 | 206.9 |
| h1 8 connections (burst of 8) | 224 | 124.2 | **152.6** | 238.2 | 240.5 | 257.4 | 257.4 | 166.1 |
| **APP PATH: blockhash+send** | 224 | 240.3 | **307.2** | 405.8 | 410.3 | 479.6 | 548.8 | 316.8 |

Run 4's network was the noisiest of the four (note the 6.6 s cold outlier and the raised
p90s). The p50s across all four runs:

| phase | run 1 | run 2 | run 3 | run 4 |
|---|---|---|---|---|
| h1 keep-alive send | 129.5 | 133.6 | 129.7 | 140.1 |
| h2 native serial | — | — | 134.6 | 129.7 |
| cold-connection send | 378.7 | 395.0 | 412.4 | 445.0 |
| **APP PATH: blockhash+send** | **260.0** | **277.0** | **269.3** | **307.2** |
| app-path minus warm send | +130.5 | +143.4 | +139.6 | +167.1 |

That last row is one round trip, four times over.

---

## 2. Where the 130 ms goes

Warm send, p50, run 4:

```
decide to send                     0.0
  build + sign + base64            0.3   ← packages/client, kit, WebCrypto Ed25519
  hand to the HTTP client → bytes on the wire
                                   1.2   ← undici request framing
  bytes written → first response byte
                                 138.7   ← Singapore and back, plus the node's think
  response headers → body read     0.1
                                 -----
  sendTransaction returns        140.1
```

**One RTT is 124 ms.** That is the TCP connect handshake measured directly — a SYN, a
SYN/ACK, nothing else — so it is a clean one-way-and-back with no server work in it.
The warm send's in-flight leg is 128–139 ms depending on run, i.e. **one RTT plus roughly
4–14 ms of node think** for sigverify and admission under `skipPreflight`.

So of the submit half:

| | ms | share |
|---|---|---|
| physics — one RTT to `devnet-as` | ~124 | **~89 %** |
| ER think (sigverify + admit) | ~5–14 | ~4–10 % |
| everything this codebase controls (sign, encode, frame, drain) | **1.6** | **~1 %** |

**There is 1.6 ms of addressable overhead in the submit hop.** The remainder is the
speed of light through a NAT64 path to Singapore and a validator doing its job.

A note on a prior number: the brief anchors on *"raw ICMP-equivalent RTT India→devnet-as
was measured at 196 ms median"*. This spike measures **125 ms p50** for a TCP handshake to
`devnet-as.magicblock.app:443` (40 samples, min 114.6, max 170.0), and every warm request
in every phase agrees with it. The 196 ms figure does not reproduce here. Whatever it
measured, the transport-level RTT on the path the game actually uses is ~125 ms, and the
warm submit hop is already sitting on it.

---

## 3. The hypotheses

### H1 — is a fresh TCP+TLS connection paid per send? **No. Rejected.**

Warm keep-alive: **0 new sockets in 224 sends** (the diagnostics_channel counter,
`undici:client:connected`, fired once at the start of the run and never again).

Forced-cold, a new connection per send, is exactly three round trips and the decomposition
says so:

| | p50 | what it is |
|---|---|---|
| cold, decide→bytes written | 293.5 | DNS (0.2) + TCP (125) + TLS (137) — the handshake |
| cold, written→first byte | 137.7 | the request itself, same as warm |
| cold, total | 445.0 | 3 × RTT |
| warm, total | 140.1 | 1 × RTT |

Cold costs **3.2×** warm. If the app were paying this, it would be the whole story — and it
is not paying it. Confirmed measured for Node; for the browser it is *inferred*: the ER
negotiates ALPN `h2` (measured, below), and browsers hold one pooled HTTP/2 connection per
origin, so the app's second and subsequent sends reuse it. What is **not** covered: the
very first send of a session, and any send after the browser has idled the connection out,
each pay the full 445 ms. Nobody has instrumented that in the live app.

DNS is a non-issue at 0.2 ms p50 — the OS stub resolver caches it, and it is inside the
handshake cost anyway.

### H2 — HTTP/2 vs HTTP/1.1. **The ER speaks h2. It makes no difference serially.**

Measured directly off the TLS handshake: `ALPN negotiated: h2`. The server's own SETTINGS
frame, read with `node:http2`:

```
maxConcurrentStreams: 256   initialWindowSize: 65536   maxFrameSize: 16777215
```

Serial sends, one warm connection: **h1 140.1 p50 / h2 129.7 p50**. Within run-to-run
noise of each other (run 3: h1 129.7, h2 134.6). At one request in flight there is nothing
for multiplexing to do, and the difference is a header-compression rounding error.

**A trap worth recording.** An earlier pass ran the h2 phase through
`undici`'s `allowH2: true`, and it produced a perfect 8-deep serial ramp on a burst —
p50 590 ms, p90 983 ms — identical to HTTP/1.1 pipelining. That reads as a server-side
queue and is not one: the same eight concurrent `sendTransaction` calls on a native
`node:http2` session all return in **~130 ms**. The serialisation was undici's h2 client,
not the ER. The script now uses `node:http2` for every h2 phase, which is also the
browser-faithful thing to measure.

### H3 — does pipelining help? **No. It is 4.7× worse. Rejected.**

| burst of 8, one send each | p50 | p90 |
|---|---|---|
| h1, `pipelining: 8`, one connection | **652.7** | 1150.2 |
| h2, multiplexed, one native session | **169.4** | 325.3 |
| h1, 8 separate warm connections | **152.6** | 238.2 |

HTTP/1.1 pipelining is head-of-line blocked by construction: response *k* cannot be read
until response *k−1* is, so a burst of eight costs eight round trips. h2 multiplexing and a
connection fan-out both do the honest thing and finish in ~1.2 RTT. There is no lever here
for this game — it sends one small transaction per 50 ms slot and never has eight in
flight — but it is the reason the app must not "optimise" itself onto a pipelined agent,
and the reason a browser (one pooled h2 connection) is safe when a naive Node client is
not.

### H4 — the app pays two round trips per keypress. **Confirmed. This is the finding.**

`packages/client/src/connection.ts`:

```ts
export async function sendInstructions(rpc, feePayer, instructions) {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();   // ← RTT #1
  ...
  await rpc.sendTransaction(...).send();                                       // ← RTT #2
}
```

`app/src/App.tsx` calls `sendInstructions(er, signer, [movePlayer(...)])` once per
`onMove`, immediately after `recordSend(seq)`. So the metric panel's clock starts, and then
the client makes a blocking `getLatestBlockhash` call to Singapore before it has even
signed anything.

Measured end to end, decide→`sendTransaction` returns, on the same warm connection:

| | p50 | p90 | p95 |
|---|---|---|---|
| cached blockhash (what `scripts/spike/sp_load.ts` does) | **140.1** | 180.2 | 214.5 |
| fetch blockhash, then send (what the app does) | **307.2** | 405.8 | 410.3 |

**+167 ms p50 in run 4, +130 / +143 / +140 ms in runs 1–3.** One whole extra round trip,
serial, on every single keypress.

Independently replicated by `docs/perf/execute.md`, which arrived at this from the other
direction — paired A/B on interleaved sends, cached 132–136 ms vs fresh 264–266 ms. Two
instruments, different sampling, same round trip.

This also resolves the discrepancy the brief flags between sp-load's 124–128 ms
send→returns and the live panel's 295 ms write-to-visible. sp-load caches its blockhash and
refreshes it in the background every 4 s (`sp_load.ts`, *"A blockhash cache, refreshed in
the background"*); it was measuring the 130 ms hop. The app is not. The submit half of the
live 295 ms is ~270–300 ms, not ~140 ms, and the read path is correspondingly **smaller**
than the ~155 ms the brief attributes to it.

---

## 4. The lever, and its bound

Cache the blockhash in `sendInstructions`, refresh it in the background.

**How much room is there?** Measured with the node's own `isBlockhashValid`, once per
interval against a blockhash captured at t=0:

| age | 0 s | 5 s | 10 s | 20 s | 30 s | 45 s | 60 s |
|---|---|---|---|---|---|---|---|
| valid | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |

A separate probe read the window straight off the RPC: `getLatestBlockhash` at slot
565073034 returned `lastValidBlockHeight` 565074234 — **1200 blocks**, and at the ER's
50 ms slot that is ~55–60 s wall time (block height advanced 565073045 → 565074250 over the
60 s of the probe, i.e. ~20 blocks/s, exactly one per slot).

So a 2 s refresh interval runs at a **~28× safety margin**, and sp-load's 4 s interval —
which drove 2,928 accepted `move`s at 242 tx/s without a `BlockhashNotFound` — is already
empirical precedent that this works on this validator.

**The hazard that makes this non-trivial, and it is a real one.** A cached blockhash makes
transaction signatures collide. `sp_load.ts` already documents it:

> Two shots from the same seat in the same direction under the same blockhash compile to
> byte-identical messages, hence identical signatures, and the node silently deduplicates
> the second.

- `move` is **safe**: it carries a monotonic `seq`, so no two moves under one blockhash
  compile identically.
- `shoot` is **not**: its args are `seat` and `dir` only. A player holding fire in one
  direction currently gets a distinct signature per send purely because the blockhash
  changes every ~50 ms. Under a 2 s cache, every shot in that direction inside the window
  collapses into one accepted transaction and the rest are silently dropped. That is a
  gameplay regression, not a latency one, and it would not show up in the latency panel at
  all — `shoot` carries no `seq` and never contributes a sample.

sp-load's own fix is the pattern: a `SetComputeUnitLimit` instruction whose declared limit
varies per send, as a uniqueness nonce. It costs nothing (ER fees are zero, the limit is
never approached) and adds one account key to a 4-key transaction, nowhere near the ~38-key
ceiling.

### Scope

`sendInstructions` lives in `packages/client/src/connection.ts`, which is **in scope**, and
its signature does not have to change — the cache can live per-`rpc` inside the module, so
`app/src/App.tsx` (frozen) is untouched and the fix reaches the hot path for free.

Two things the fix must not break, both of which route through the same function:

1. `worker/src/routes.ts` calls `sendInstructions` on the **base layer** and then
   `confirmSignature`. Base devnet's 150-block window at 400 ms slots is ~60 s, comparable,
   so a shared 2 s cache is safe there too — but the cache must be keyed per endpoint,
   because an ER blockhash sent to base devnet is the exact failure `connectMatch`'s
   docstring exists to prevent.
2. The first send after a cold start still has to fetch one, so the cache needs a
   populated-on-demand path, not a bare "read whatever is there".

The `shoot` nonce is the part that cannot be done from `packages/client` alone without
changing what `App.tsx` passes in — see **todo** in the handoff.

---

## 5. What was checked and found not to matter

- **DNS** — 0.2 ms p50 over 60 lookups. Cached by the OS stub resolver, and it is inside
  the handshake cost anyway. Nothing to win.
- **Local crypto** — build + sign + base64 of a real `move` is 0.3 ms p50 over 224 samples
  (max 9.4 ms, one GC). WebCrypto Ed25519 is not on the critical path in any meaningful
  sense.
- **Request framing and response drain** — 1.2 ms and 0.1 ms p50. Together under 1 % of the
  hop.
- **HTTP/2** — already negotiated, no serial benefit.
- **Pipelining** — actively harmful on h1, and the game never has a burst to pipeline.
- **Connection fan-out** — 8 warm connections finish a burst of 8 in 152 ms p50 vs 652 ms
  pipelined. Correct, and irrelevant: this client sends one transaction per slot.
- **Response body size** — a `sendTransaction` reply is one signature; the drain is 0.1 ms.
- **`getLatestBlockhash` vs `sendTransaction` server think** — 142.4 vs 140.1 p50 on the
  same warm socket. The ER costs the same for a trivial read as for admitting a signed
  transaction, which is another way of saying the hop is all network.

---

## 6. Numbers this spike did not produce

- **The browser's actual connection behaviour.** Everything here is Node. The h2/ALPN facts
  are measured against the same endpoint the browser talks to, and browser h2 pooling is
  well-defined, but no measurement in this document was taken from the live app. The first
  send of a session, and the first send after an idle timeout, are unmeasured and could
  each be a 445 ms outlier.
- **Whether the ER accepts a *cached* blockhash on a real accepted transaction.**
  `isBlockhashValid` is the node's own answer and sp-load drove 2,928 accepted moves off a
  4 s cache, but this spike sends against accounts that are not a live arena
  (`skipPreflight` admits them without touching the accounts, which is the hop being
  measured) and therefore never observed one of its own transactions execute. The lever
  needs one confirming run against a live arena before it ships.
- **The read half.** Untouched here. It is now the smaller of the two, but only because the
  submit half turned out to be bigger than believed — not because the read path improved.
