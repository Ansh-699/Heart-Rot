# ER websockets and the subscription surface

Research date: **2026-09-01**. Target: **Solana devnet**, player in India (Ghaziabad).

Everything marked *measured* was run today against live devnet. Everything marked *source*
was read at the **exact commit devnet is running**, `8174cec` / `magicblock-core 0.14.13`,
fetched from `raw.githubusercontent.com` and diffed against the local checkout at
`~/Documents/MB-evalidator/magicblock-validator`. Where the local checkout (workspace
version `0.13.11`) and the deployed commit differ, that is called out.

Scripts: `scripts/spike/erws_endpoints.mjs`, `scripts/spike/erws_race.mjs`.

---

## 0. The headline

**The read path is not the problem, and it never was. There is no queue, no slot boundary
and no batching window anywhere between the SVM and the websocket frame — that is now
established from source, not inferred from timing.** The only thing left in the read half
is transport, and transport turns out to have two levers worth 26–40 ms each:

1. **`devnet-tee` is 32–36 ms closer to India than `devnet-as`**, on the same build, healthy,
   and already in `getRoutes`. Write-to-visible is one round trip, so that is a saving on
   the *whole* number, both halves at once. It costs one worker env var.
2. **The router-versus-ER latency argument was never about the router.** It is entirely
   an IP address-family artefact: the router is behind Cloudflare, and this ISP's route to
   Cloudflare's **IPv6** anycast is 160 ms worse than its route to the **IPv4** one.
   Measured paired, on identical writes: the router is **6 ms faster** than the ER over
   IPv4 and **34 ms slower** over IPv6.

That second result reconciles the two contradictory claims already in this repo —
`app/src/net/subscribe.ts`'s "the router costs a p50 of −4 ms" and `docs/perf/notify.md`'s
"+32–40 ms". Both measurements were correct. They were taken on different address families.

And one claim from this run is **retracted below**: the router does *not* drop notifications.

---

## 1. Does the ER expose its own websocket directly?

**Yes**, on the same host and port as its HTTP RPC, upgraded over HTTP/1.1.
`wss://devnet-as.magicblock.app/`. *Measured.*

| method | ER (`devnet-as`) | Router |
|---|---|---|
| `accountSubscribe` | OK | OK |
| `signatureSubscribe` | OK (`-32602` on a bad signature, i.e. it parsed) | OK |
| `slotSubscribe` | OK | `-32601 Method not found` |
| `logsSubscribe` | OK | `-32601` |
| `programSubscribe` | OK | `-32601` |
| `ping` | OK (`"pong"`) | `-32601` |

The router's method set is `accountSubscribe` + `signatureSubscribe` and nothing else,
which matches `subscribe.ts`'s docstring. Note the docstring's parenthetical is now slightly
off in one direction: over IPv6 an invalid-signature `signatureSubscribe` came back
`-32601` from the router, over IPv4 `OK` — the two Cloudflare edges are not answering
identically, which is itself a reason not to depend on the router for anything subtle.

*Source*: `magicblock-aperture/src/server/websocket/mod.rs` binds a plain `TcpListener` and
serves `hyper::server::conn::http1::Builder ... .with_upgrades()`, then hands the upgraded
stream to `fastwebsockets`. HTTP/1.1 only — the WS listener never negotiates h2.

## 2. Is the router's websocket a proxy or a redirect?

**A proxy, and one that mints its own subscription ids.** *Measured.*

- The ER returns a small sequential id (`7254`, `7255`, `7256`…) — that is
  `SubscriptionsDb::next_subid()`, a process-global `AtomicU64` (`subscriptions.rs`).
  The router returns `170210444684798`. Different id space, so the router is not relaying
  the ER's id and is therefore not a redirect.
- The subscribe ACK is answered **locally**: `accountSubscribe` round trip over the router
  on IPv4 is 124.0 ms p50 (n=20) against 124.4 ms to the ER itself. If the router were
  forwarding the subscribe to the ER and waiting, it could not answer in the same time the
  ER alone costs.
- It **routes per account by delegation record**, exactly as `subscribe.ts` says. Proof:
  subscribed both channels to `SysvarC1ock111…`, which is not delegated. In 20 s the router
  delivered **121** notifications (it had resolved the account to base layer) and the ER
  delivered **0**.
- **Failure mode worth knowing**: when the router cannot resolve an account's ER it still
  returns a subscription id and then delivers nothing, forever. Measured on the pricing
  oracle's feed accounts, which are delegated to the null validator — `getDelegationStatus`
  answers `-32604 account has been delegated to unknown ER node: 1111…`, `accountSubscribe`
  answers with an id, and 25 s produced 0 frames while the ER on the same account produced 506.
  A client that trusts the ACK sees a frozen world with no error. This is the failure the
  app's tick watchdog exists for.

MagicBlock's own docs say nothing about any of this — the Magic Router page mentions a
`wss://` endpoint and never describes its subscription behaviour, and there is no pubsub
page at all. Fetched today; `subscribe.ts`'s "zero of 215 pages mention `Subscribe`" still holds.

## 3. How account notifications are produced and dispatched

*Source, at deployed `8174cec`.* The four files that own this path —
`state/subscriptions.rs`, `server/websocket/connection.rs`, `server/websocket/mod.rs`,
`requests/websocket/account_subscribe.rs` — are **byte-identical** between the local
checkout and the deployed commit. `processor.rs` differs only in startup ordering
(an `EventProcessors` builder that defers the block subscription past ledger replay); its
`run()` loop is unchanged. `executor/processing.rs` differs only on the failed-transaction
branch.

The whole path, end to end:

```
TransactionExecutor::execute                       (processor/executor/processing.rs)
  └─ commit_accounts -> insert_and_notify
       accountsdb.insert_batch(dirty or privileged)
       for (pubkey, account) in accounts:          ← EVERY account of the tx, not just dirty
           accounts_tx.send(AccountWithSlot{slot, LockedAccount, txn})   ← flume MPMC, line 425
  └─ record_transaction (ledger)                   ← AFTER the notification
  └─ tx.send(status)                               ← AFTER the notification

EventProcessor::run                                 (aperture/processor.rs)
  tokio::select! biased { block/slot, account_update, transaction_status }
    account: subscriptions.send_account_update(&state).await

SubscriptionsDb::send_account_update                (aperture/state/subscriptions.rs)
  scc::HashMap<Pubkey, UpdateSubscribers<AccountEncoder>>.read_async -> send()
    per encoder group: encoder.encode(slot, acct, id) -> Bytes
      for tx in txs.values(): let _ = tx.try_send(bytes.clone())    ← mpsc(4096), per connection

ConnectionHandler::run                              (aperture/server/websocket/connection.rs)
  tokio::select! biased { cancel, ws.read_frame, ping, updates_rx.recv }
    updates_rx.recv -> ws.write_frame(Frame::text(bytes))           ← one frame per notification
```

Answers to the questions this was asked:

- **Is there a queue?** Two hops, both unbuffered in practice. A flume MPMC channel from the
  executor to the event processor, and a per-connection `tokio::mpsc` of capacity **4096**
  from the subscription database to the socket writer. Neither adds delay; the second adds
  *loss* if it ever fills, because the send is `let _ = tx.try_send(...)` and a full channel
  drops the notification silently. At one write per 50 ms slot that is unreachable.
- **Is there a slot boundary?** **No.** Nothing in this path consults the slot except as a
  label copied into the payload. The notification is emitted synchronously inside
  `execute()`, before the ledger write and before the transaction status.
- **Is there a batching window?** **No.** One `write_frame` per notification, immediately.
  There is no timer, no flush interval, no accumulation.
- **So the brief's "the ER coalesces account notifications to one per account per 50 ms
  slot" is wrong.** It is not in the source, and it is contradicted by measurement: on one
  oracle feed account the ER delivered 506 frames of which **99 carried a duplicate
  `(slot, payload)` pair** — the same account notified more than once inside one slot.
  The rule is one notification **per account per transaction**, and a slot can hold many.
  This is good news; it means the read path has no quantisation to dodge.
- **Notification volume is per-account-of-the-transaction, not per-modified-account.** The
  dirty filter gates persistence only; the notify loop iterates every loaded account. A
  read-only account in a `move` transaction still fires a notification to its subscribers.
- **Ordering hazard**: `config.event_processors` workers all `recv_async` the *same* channel,
  so with more than one worker two updates to one account can be delivered out of order.
  The default is **1** (`magicblock-config/src/config/aperture.rs:26`). Devnet's setting is
  not observable from outside; nothing measured today showed reordering.
- **`biased` in both selects.** In the event processor, block/slot updates are polled before
  account updates; in the connection handler, an inbound client frame is polled before an
  outbound notification. Microsecond-scale at these rates, but it is why a slot notification
  can never overtake the account notification it shares a flush with.
- **No `set_nodelay(true)` anywhere in the repository.** Nagle is therefore on for the WS
  socket at the origin. It does not appear to bite — write-to-visible equals the measured
  round trip with nothing left over — and it is not ours to change. Recorded so nobody
  hunts for it.

## 4. Is there any subscription option that changes delivery latency?

**No.** Tested every one of them live against the ER.

| option | accepted? | effect |
|---|---|---|
| `commitment: 'processed'` | yes | **Ignored.** `{encoding:'base64'}` and `{encoding:'base64',commitment:'processed'}` returned the *same* subscription id `7254`. Confirmed by source: subscribers are grouped by `AccountEncoder{encoding, data_slice}` and commitment is not in the key. |
| `encoding` (base58 default / base64 / base64+zstd / jsonParsed) | all four | Payload size and server CPU only. The app already sends `base64`. Client-side decode of the whole `Players` frame is 14 µs (`docs/perf/clientside.md`). |
| `dataSlice: {offset,length}` | yes, honoured (distinct id `7255`) | Slices before encoding, so it shrinks both the frame and the server's encode. Saves ~2 KB of a 2.5 KB frame and microseconds of CPU, against a 120 ms round trip. Also unusable here — the client needs the whole roster. |
| fewer accounts per socket | n/a | Already measured at 0 ms in `docs/perf/notify.md` (E3 vs E1). The source now explains why: there is no per-socket batching to contend for. |

The read path is transport and nothing else.

## 5. The two things that actually move the number

### 5.1 Endpoint choice: `devnet-tee` is 32–36 ms closer than `devnet-as`

*Measured*, two independent runs, `scripts/spike/erws_endpoints.mjs`, IPv4-pinned.

| validator | region | TCP connect p50 (n=25×2) | `getSlot` app RTT p50 (n=19×2) |
|---|---|---|---|
| `devnet-tee` `MTEWGuqx…` | SGP | **88.1 / 88.4** | **99.8 / 91.8** |
| `devnet-as` `MAS1Dt9q…` | SGP | 120.7 / 124.1 | 125.6 / 132.5 |
| `devnet-eu` `MEUGGrYP…` | DEU | 249.3 / 228.6 | 245.9 / 244.3 |
| `devnet-us` `MUS3hc9T…` | USA | 272.0 / 262.2 | 289.9 / 254.9 |

Both Singapore boxes, both `magicblock-core 0.14.13 / 8174cec`, both `getHealth: "ok"`, both
`er: true` on `status.magicblock.app/api/services`. `devnet-tee` is simply on a better path
from this ISP. The gap reproduced across two runs an hour apart with min-RTTs of 79.9 and
83.7 ms, so it is a route difference, not a load difference.

Because write-to-visible **is** one round trip (`docs/perf/execute.md`: ~65 ms out, 0 ms
execute, ~65 ms back), that RTT gap is a saving on the whole p50, not on half of it.

**What it costs**: `worker/src/routes.ts:157` reads `env.VALIDATOR_IDENTITY`, and
`programs/heartrot/src/handlers/delegation.rs:194` already sets
`DelegateConfig { validator: Some(validator) }` from `Arena.validator_identity`, which
`init_arena` takes as an argument. One env var. No code change, no frozen file, and
`connectMatch` resolves the fqdn from `getRoutes` by identity so the client follows automatically.

**What is NOT verified**, and it is the reason this is not simply "do it":
- `devnet-tee` is MagicBlock's **TEE / Private Ephemeral Rollup** box. The PER quickstart
  describes an `EphemeralPermission` account created on the ER after delegation. Whether an
  ordinary program may delegate there **without** one is not stated anywhere I could find,
  and I did not spend a delegation to find out.
- Whether the TEE box runs the **task scheduler**. HEARTROT's entire game loop is a crank.
  If cranks are disabled there the match never ticks.
- The status API reports `rpc_router: false` for the TEE row. Prior research
  (`docs/research/er-connections.md`) reads that as "no router process on that box", which is
  harmless, but it has not been confirmed that the central router will forward *transactions*
  to it.

The cheap verification is one throwaway arena: `init_arena` + `delegate` with
`VALIDATOR_IDENTITY=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, then `start_match` and
watch `Arena.tick`. Rent is refunded on undelegate. Until that runs, the end-to-end saving
is arithmetic on a measured RTT, not a measured end-to-end.

### 5.2 The router penalty is an IPv6 route, not a proxy hop

*Measured.* TCP connect p50, 25 samples per address:

| target | address | p50 | min |
|---|---|---|---|
| router IPv4 (Cloudflare) | `104.20.16.25` | **22.3** | 17.7 |
| router IPv4 (Cloudflare) | `172.66.172.116` | **20.5** | 17.7 |
| router IPv6 (Cloudflare) | `2606:4700:90c4:8253:…` | **182.4** | 170.6 |
| ER `devnet-as` IPv4 | `67.213.122.145` | 121.2 | 111.4 |
| ER `devnet-as` IPv6 | `64:ff9b::43d5:7a91` (NAT64) | 118.2 | 108.1 |

The router's Cloudflare IPv4 edge is a local PoP 22 ms away. Its IPv6 anycast address is
182 ms away from this ISP — **160 ms worse for the same service**. The ER is immune because
its AAAA is a DNS64-synthesised `64:ff9b::` address that traverses the same path as its A record.

Then the decisive experiment — both sockets open simultaneously on the **same six** accounts
delegated to `MAS1Dt9…` and written continuously by MagicBlock's pricing oracle, so every
sample is one identical write observed twice and the submit half cancels exactly. Keyed on
`pubkey|slot|payload`, 3 s trimmed off each end. `scripts/spike/erws_race.mjs`:

| resolution order | n | ROUTER − ER p50 | p10 | p90 | ER arrived first |
|---|---|---|---|---|---|
| `ipv4first` | 2325 | **−6.1 ms** | −11.2 | −1.8 | 1% |
| `ipv4first` (repeat) | 2196 | −5.7 ms | −10.3 | −1.5 | 1% |
| `ipv4first` (repeat) | 2196 | −3.5 ms | −8.1 | −0.2 | 2% |
| `verbatim` (IPv6 wins) | 2178 | **+33.5 ms** | +27.0 | +40.1 | 99% |

Over IPv4 the router is consistently a few milliseconds **faster** than the ER — it is
answering from a nearby Cloudflare edge over Cloudflare's backbone, which beats the public
internet path to Singapore by a hair. Over IPv6 it is 34 ms slower, and the sign of the
comparison flips on 99% of individual writes.

**37 ms is the entire spread between the two, and it is the same 32–40 ms
`docs/perf/notify.md` attributed to "router proxy overhead".** That document's paired race
was correct; it was run on Node's default resolution order, which is `verbatim`, and Node's
Happy Eyeballs accepted the IPv6 connection at ~182 ms because that is under its 250 ms
attempt timeout. `subscribe.ts`'s older `−4 ms` claim was equally correct and equally
partial. Neither is a fact about the router.

**What this means for the app is inferred, not measured, and the distinction matters.**
The app is a browser page; it cannot choose an address family. Chrome and Firefox run Happy
Eyeballs v2 with an IPv6 head start on the order of 300 ms, so an IPv6 connection completing
in 182 ms wins and the browser takes the slow edge — the same one Node's `verbatim` mode takes.
On that reasoning the live app is paying the +33.5 ms today and direct-to-ER removes it.
**I did not measure this in a browser.** It would take one `performance.getEntriesByType('resource')`
read, or a `chrome://net-export` capture, on the deployed page. If it turns out the browser
picks IPv4, the direct-ER change is worth **0 to −6 ms** of latency and should be made for the
other reasons below rather than for speed.

The other reasons stand regardless of family, and they are not small:
- The router is the failure mode in §2 — ACK, then silence, forever, with no error.
- The snapshot already uses the pinned ER `rpc`. The feed using a different endpoint is the
  one way the two halves of `subscribe.ts` can describe different worlds.
- Direct-to-ER removes a Cloudflare dependency from the hot path and makes the read path's
  routing a property of the ER's own DNS, which is measurably well-behaved on both families.

**RETRACTED from an earlier pass of this run**: I recorded that the router dropped 5.7–7.6%
of notifications (untrimmed runs showed ER-only 132, router-only 0). With the 3 s edge trim
that removes subscribe- and close-skew, it is **ER-only 1, router-only 2 out of 2326**. The
router loses nothing. The gap was my instrument.

---

## 6. Dead ends, so nobody re-walks them

- **Anything inside the ER's notify path.** No queue, no slot boundary, no batching window —
  established from source at the deployed commit, not inferred. `executed -> visible` is
  0 ms p50 (`docs/perf/notify.md`, 289 paired samples) and the source says why.
- **Per-slot coalescing as a latency cost.** It does not exist. Measured 99 duplicate
  `(slot, payload)` notifications in 506 frames on one account — the ER notifies per
  transaction, and a slot holds many.
- **`commitment` on `accountSubscribe`.** Parsed and discarded; the same subscription id
  comes back with or without it. It is not part of the subscriber grouping key.
- **`encoding` and `dataSlice`.** Both work, both change bytes and server CPU, neither
  changes delivery latency at a 120 ms round trip. The client's whole decode hop is 14 µs.
- **Splitting or narrowing the subscription.** 0 ms, already measured, and the source
  explains it: nothing batches per socket.
- **HTTP/2 for the websocket.** The WS listener is `hyper::server::conn::http1` only. Not
  available, and §H2 of `docs/perf/submit.md` already showed h2 buys nothing serially anyway.
- **`devnet-eu` / `devnet-us`.** 2× and 2.2× the RTT of `devnet-as` from India. Worse in
  every direction.
- **The router as a latency *cost*.** It is not one. On IPv4 it is 6 ms cheaper than the ER.
  The thing to remove is an IPv6 route, and the way to remove it is to stop resolving
  `devnet-router.magicblock.app` at all.

---

## 7. Sources

Primary source, deployed commit:
- `https://raw.githubusercontent.com/magicblock-labs/magicblock-validator/8174cec/magicblock-aperture/src/state/subscriptions.rs`
- `.../8174cec/magicblock-aperture/src/processor.rs`
- `.../8174cec/magicblock-aperture/src/server/websocket/connection.rs`
- `.../8174cec/magicblock-aperture/src/server/websocket/mod.rs`
- `.../8174cec/magicblock-aperture/src/requests/websocket/account_subscribe.rs`
- `.../8174cec/magicblock-processor/src/executor/processing.rs`
- local checkout for the rest: `~/Documents/MB-evalidator/magicblock-validator`
  (`magicblock-aperture/src/encoder.rs`, `magicblock-core/src/link/accounts.rs`,
  `magicblock-config/src/config/aperture.rs`)

Live devnet, 2026-09-01:
- `getVersion` on `devnet-as` and `devnet-tee`: `{"solana-core":"4.0.0","magicblock-core":"0.14.13","git-commit":"8174cec"}`
- `getRoutes` on `https://devnet-router.magicblock.app/`
- `https://status.magicblock.app/api/services`
- `scripts/spike/erws_endpoints.mjs`, `scripts/spike/erws_race.mjs`

Vendor docs (both thin on this subject, quoted only where they say something):
- <https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/magic-router> — names
  `wss://devnet-router.magicblock.app`, describes no subscription behaviour.
- <https://docs.magicblock.gg/pages/private-ephemeral-rollups-pers/how-to-guide/quickstart> —
  TEE devnet identity `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`, `EphemeralPermission`
  created on the ER after delegation.

Prior work in this repo that this run confirms, refines or refutes:
- `docs/perf/notify.md` — its +32–40 ms router penalty is reproduced exactly, and explained.
- `app/src/net/subscribe.ts` — its −4 ms router claim is also reproduced, on IPv4.
- `docs/perf/execute.md`, `docs/perf/clientside.md`, `docs/perf/submit.md`, `docs/research/er-connections.md`, `docs/research/er-cranks.md`.
