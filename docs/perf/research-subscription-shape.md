# PERF-SUBSCRIPTION-SHAPE — the shape is already right; only the tail is left

**Headline.** Nothing about *what* the client subscribes to costs it any p50 latency. Three
accounts, twenty-one subscriptions, a 3.4 KB frame or a 0.2 KB frame all deliver the same
write at the same millisecond: every paired p50 delta measured **0 or −1 ms** over 397
paired samples. The ER *does* support both server-side zstd and `dataSlice` on
`accountSubscribe` — that was an open question and it is now answered from the validator's
own source and from the wire — and using either cuts the feed from **96 KB/s to 32 KB/s**
(zstd) or **18 KB/s** (`dataSlice`). What that buys is a **tail**, not a median:
p90 151 → 131 ms, p95 158 → 133 ms, in one run, with a caveat below that it is not
independently controlled.

Set against the numbers already banked — the router costs 32–40 ms
(`notify.md`), the per-send blockhash fetch costs 130 ms (`execute.md`) — subscription
shape is the smallest lever in the read path, and its p50 component is zero.

Scripts: `scripts/spike/perf_subshape.ts`. Raw: `docs/perf/subshape-run1.jsonl`.

---

## What is actually on the wire

Measured, not estimated: every websocket frame's byte length attributed to its account,
one seat sending `move` at 100 ms with the 100 ms crank running, 43.06 s, direct to
`wss://devnet-as.magicblock.app/`.

| account | raw bytes | base64 payload | frames/s | notes |
|---|---|---|---|---|
| `Arena` | 1,200 | **1,600** | 20.02 | crank 10/s **+ one per `move`** — see below |
| `Players` | 1,924 | **2,568** | 20.00 | crank 10/s + one per `move` |
| `Boss` | 50 | **68** | 10.71 | crank only |
| **total** | | | **50.7** | **96.4 KB/s** on the wire |

The brief's estimate was "up to 30 notifications a second carrying ~3 KB". The real figure
for **one** moving seat is **51 frames/s and 96 KB/s**, and both scale with the number of
moving players.

### Half the `Arena` traffic is a redundant copy of unchanged bytes

`Arena` took 862 frames while `Boss` — which only the crank writes — took 461. The
difference, 401, is exactly the 400 `move` transactions sent. `Players` shows the same
structure: 861 = 461 + 400. So **each `move` produces an `Arena` notification**, even
though `movePlayer` declares `Arena` `AccountRole.READONLY` (`instructions.ts`) and the
handler's own comment says "`arena` stays read-only here: a move must not rewrite the
1,160-byte account the whole lobby is subscribed to" (`handlers/player.rs`).

Confirmed directly rather than left as arithmetic. Three arms of five transactions each,
on a settled arena nobody else was writing, one `accountSubscribe` on `Arena`
(`idle baseline: 0 frames in 4 s`):

| transaction | `Arena` notifications for 5 sends |
|---|---|
| a `ComputeBudget` ix naming `Arena` **READONLY** | **5** |
| the same naming it **WRITABLE** | 0 |
| a bare `ComputeBudget` ix not naming it at all | 0 |

Naming an account read-only in an ER transaction emits an account notification for it
carrying **unchanged data**. The mechanism is not established here — the shape of it
(read-only key triggers, writable key does not) points at `magicblock-chainlink`'s
just-in-time account cloner refreshing accounts a transaction reads, not at the write
path — and the writable arm returning zero is not explained. The *effect* is measured
twice, independently.

This is a **bandwidth** finding, not a latency one. It costs 0 ms at one seat. It is the
reason the feed scales with the number of moving players rather than with the crank.

---

## Does subscription count affect per-notification latency? No.

`notify.md` already showed 1 account vs 3 is worth 0 ms. This run pushes it much harder:
`FAN` opened **21 subscriptions on one socket** (`Players` ×19, plus `Arena` and `Boss`),
so the validator ran 19 separate `encoder.encode` calls and pushed 19 copies of every
`Players` write down one connection.

| `FAN` − `B64`, paired per seq (n=398) | p50 | p90 | p95 | max |
|---|---|---|---|---|
| ms | **0** | 1 | 2 | 277 |

Nineteen redundant encodes and frames per write cost **0 ms at p50 and 2 ms at p95**. The
subscription count is not a variable. Do not spend anything on trimming it.

(`FAN`'s full distribution — p50 127, p90 151, p95 159, mean 130.8 — is indistinguishable
from `B64`'s 127 / 151 / 158 / 130.6, which is the useful part: it is the same *payload*
on a second socket.)

---

## Does the ER support a delta or compressed encoding?

**Compressed: yes. Delta: no, and nothing in the protocol offers one.**

Primary source — `magicblock-aperture/src/requests/websocket/account_subscribe.rs`
(magicblock-labs/magicblock-validator, the crate this ER runs; the node reports
`magicblock-core 0.14.13`, `solana-core 4.0.0`, `git-commit 8174cec`):

```rust
let config = request.optional::<RpcAccountInfoConfig>(1)?.unwrap_or_default();
let encoding = config.encoding.unwrap_or(UiAccountEncoding::Base58);
let encoder = AccountEncoder { encoding, data_slice: config.data_slice };
```

`accountSubscribe` takes the **full** `RpcAccountInfoConfig`, so `encoding` *and*
`dataSlice` both apply, and `encoder.rs` hands them straight to
`solana_account_decoder::encode_ui_account`. There is no delta, diff, or
changed-fields-only encoding anywhere in that path: `encode_ui_account` serialises the
whole (optionally sliced) account every time.

Confirmed on the wire — all six configs accepted with a subscription id, none rejected:
`base64`, `base64+zstd`, `base64`+`dataSlice`, `base64+zstd`+`dataSlice`, `jsonParsed`,
`base58`.

Note also from that source: the encoder runs **per subscription** in its own task, so
compression is charged to the validator once per subscriber, not once per write.

### Websocket transport compression: not available

Neither endpoint negotiates `permessage-deflate`. A raw upgrade offering
`permessage-deflate; client_max_window_bits` gets `101` from both with **no
`sec-websocket-extensions` header in the response** — the ER (nginx) and the router
(Cloudflare) each decline it. There is no transport-level lever; compression has to be
asked for in the RPC config.

---

## The measurement: four shapes, same writes, same socket family

Four channels, each on its own socket, all direct to the pinned ER, all watching the same
`Players` writes, so the submit half cancels exactly. 400 `move` sends at 100 ms, seat 5,
arena `1788266873`, crank running.

| channel | n | p50 | p90 | p95 | mean | max | feed |
|---|---|---|---|---|---|---|---|
| `B64` base64, 3 accounts (ships today) | 397 | **127** | 151 | 158 | 130.6 | 260 | 96.4 KB/s |
| `ZSTD` base64+zstd, 3 accounts | 397 | **123** | 131 | 133 | 124.7 | 260 | 32.4 KB/s |
| `SLICE` base64 + `dataSlice`, 3 accounts | 397 | **123** | 132 | 135 | 125.1 | 265 | 18.3 KB/s |
| `FAN` base64, 21 subscriptions | 397 | **127** | 151 | 159 | 130.8 | 265 | 96.2 KB/s |

`sendTransaction`'s own POST returned at p50 122 / p90 131 / p95 134 ms on the same run, so
`ZSTD` and `SLICE` are sitting on the round-trip floor and `B64` is ~4 ms above it at p50
and ~20 ms above it at p90.

Paired per seq against `B64`:

| pair | n | p50 Δ | p90 Δ | p95 Δ | mean Δ | arrived first |
|---|---|---|---|---|---|---|
| `ZSTD` − `B64` | 398 | **−1 ms** | 0 | 0 | −5.4 | 58.8% |
| `SLICE` − `B64` | 398 | **0 ms** | 0 | 1 | −5.0 | 46.0% |
| `FAN` − `B64` | 398 | **0 ms** | 1 | 2 | +0.9 | 13.1% |

### Payload sizes achieved

| account | `B64` | `ZSTD` | ratio | `SLICE` | what the slice kept |
|---|---|---|---|---|---|
| `Arena` | 1,600 | 208 | **7.7×** | 44 | `[0..32]` — header only |
| `Players` | 2,568 | 676 | **3.8×** | 128 | one 96-byte `PlayerSlot` |
| `Boss` | 68 | 60 | 1.1× | 68 | all 50 bytes |

Client cost of zstd, measured in Node with `zlib.zstdDecompressSync` over 859 real
`Players` frames: **p50 44 µs, p90 66 µs, p95 76 µs** (max 9.4 ms on the very first call —
one-off warm-up). At 20 frames/s that is 0.9 ms of CPU per second. For scale,
`clientside.md` measured the whole existing decode hop at 11–14 µs, so zstd would be
**~4× the client's entire current read-path CPU** — still nothing against a 127 ms budget.

### What I do **not** claim

The p90/p95 gap between the two large-payload channels (`B64` 151/158, `FAN` 151/159) and
the two small-payload ones (`ZSTD` 131/133, `SLICE` 132/135) is consistent across two
channels each and is the only signal in this run, but:

- **One run.** No replication.
- **No identical-shape control.** The planned `B64B` channel — a byte-for-byte copy of
  `B64` on a second socket, which would give the noise floor for "two sockets watching one
  write" — never ran: the reused arena's crank hit its iteration limit and settled the
  match mid-setup, and a fresh match costs ~0.026 SOL of unreclaimable ER rent against a
  treasury holding 0.035 SOL. `FAN` is the closest thing to that control and it lands on
  top of `B64`, which is suggestive but is not the same experiment.
- **A bandwidth confound.** Four sockets on one Indian home link pulled ~250 KB/s during
  this run, roughly 2.5× what one client pulls in production. If any of that gap is local
  contention, it is an artefact and the real gap is smaller.

So: the p50 result (**zero**) is solid. The tail result (~20 ms at p90, ~25 ms at p95) is
one unreplicated observation and should be treated as an upper bound.

---

## Would fewer subscriptions plus polling be faster?

No, and this is settled rather than re-opened. `notify.md` measured polling at **36–38 ms
worse at p50** and 91 ms worse at p90 than a direct subscription, at four times the request
volume, with a per-loop round trip of 123 ms — the same round trip everything else pays.
Subscribing to fewer accounts is separately worth 0 ms (that report's `E3` vs `E1`, and
`FAN` above at 21 subscriptions). There is no combination of the two that wins.

---

## Levers, ranked

1. **`encoding: 'base64+zstd'` in `subscribeMatch`'s `accountSubscribe` params**
   (`app/src/net/subscribe.ts`, the `params: [addresses[kind], { encoding: 'base64' }]`
   line, plus a decompress in `fromBase64`'s place). **0 ms at p50**, ~20 ms at p90 and
   ~25 ms at p95 on one unreplicated run, and 96 KB/s → 32 KB/s of feed.
   **The blocker is the browser, not the ER**: `DecompressionStream('zstd')` is supported
   by *no* shipping browser (caniuse: 0% global; Chrome not through 151, Safari not through
   27, Firefox implemented but disabled by default) — the widely-supported `zstd` is the
   HTTP `Content-Encoding`, which is a different feature. So this needs a wasm or JS zstd
   decoder as a new dependency, and the 44 µs decode figure above is Node's native
   binding, not that library. A new dependency for 0 ms of p50 does not clear the bar
   unless the tail result replicates and the load projection below turns out to matter.

2. **`dataSlice` — supported, and unusable as the layout stands.** The ER honours it on
   `accountSubscribe` (measured, `Players` 2,568 → 128 bytes). But a slice is a single
   contiguous window and the client needs all twenty seats, while `PlayerSlot` interleaves
   64 static bytes per seat (`session_pubkey` at 32, `identity` at 64) with the 32 mutable
   ones. There is no useful window. Making one means reordering `Players` in the program
   into struct-of-arrays — mutable fields for all twenty seats contiguous at the front
   (20 × 32 = 644 bytes, a 3× cut) with the pubkey arrays behind — plus a matching
   `decodePlayers`, a layout-version bump, and a redeploy. **For 0 ms of p50.** Do not do
   this on latency grounds.

3. **Nothing else.** Subscription count: 0 ms at 21 subscriptions. Coalescing: 0 ms
   (`notify.md`). Polling: negative. Transport compression: not offered. Per-notification
   decode: 11–14 µs (`clientside.md`).

### The load projection, stated as unmeasured

One seat produces 51 frames/s and 96 KB/s. Each additional moving seat adds one `Players`
frame **and** one redundant `Arena` frame per move. Twenty seats at the client's 100 ms
cadence extrapolates to ~410 frames/s and **~1.2 MB/s**, and at the app's actual 50 ms
cadence up to double that, to every connected client. That is the regime where a 3× or 7×
payload cut could stop being cosmetic.

**This was not measured.** The multi-seat run was built (`PS_EXTRA_SEATS` drives extra
seats from one process) and did not get to run for the treasury reason above. Whether
rate-limited (`RateLimited`) moves also emit notifications is likewise unmeasured, and it
changes the projection materially at a 50 ms cadence. Anyone picking this up: claim seats
that have never been claimed (a re-claim of an occupied seat silently leaves the old
session key in place and the new one's moves are all refused — that is how the first
attempt was lost), and seed the arrival filter from the seat's on-chain `last_move_seq`.

---

## Sources

- `magicblock-labs/magicblock-validator`, `magicblock-aperture/src/requests/websocket/account_subscribe.rs` and `magicblock-aperture/src/encoder.rs` — read via the GitHub contents API. The `RpcAccountInfoConfig` parse and the per-subscription `AccountEncoder`.
- `getVersion` on `https://devnet-as.magicblock.app/` → `magicblock-core 0.14.13`, `solana-core 4.0.0`, `git-commit 8174cec`, `feature-set 3718597879`.
- <https://caniuse.com/mdn-api_decompressionstream_decompressionstream_zstd> — `DecompressionStream("zstd")`, 0% global support.
- <https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream> — the constructor's format strings.
- `docs/perf/notify.md` — router vs ER, 1 account vs 3, polling, coalescing.
- `docs/perf/execute.md`, `docs/perf/submit.md`, `docs/perf/clientside.md` — the surrounding budget.
- This run: `scripts/spike/perf_subshape.ts`, `docs/perf/subshape-run1.jsonl`.
