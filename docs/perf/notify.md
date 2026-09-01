# PERF-NOTIFY — the read path is not the problem, the router is

**Headline.** Subscribing directly to the ER's own websocket instead of the router's is
worth **32–40 ms at p50** and **~110 ms at p95**, on the same writes, and the ER wins
**97–98%** of individual writes. Everything else in the read path measured at zero:
subscribing to one account instead of three is worth 0 ms, the ER's
one-notification-per-account-per-slot coalescing adds 0 ms *after* execution, and polling
is 36 ms *worse* than a subscription, not better.

The prior conclusion that ~155 ms of the 295 ms p50 is "notification delivery back to the
client" does not survive this measurement. On a direct ER subscription the account
notification for a transaction arrives in the **same websocket flush as that
transaction's own log notification** — p50 delta 0 ms, p95 0 ms, max 3 ms over 289 paired
samples. There is no notify hop left to optimise once the router is out of the path.

Script: `scripts/spike/perf_notify.ts`. Raw: `docs/perf/notify-run1.jsonl`,
`docs/perf/notify-run2.jsonl`.

---

## Method

Four channels are opened on the **same** `Players` account and observe the **same** writes
simultaneously, so the submit half is byte-identical across channels and every comparison
is paired rather than two runs an hour apart.

| Channel | What it is |
|---|---|
| `R3` | `accountSubscribe` over `wss://devnet-router.magicblock.app/`, three accounts. **What ships today.** |
| `E3` | `accountSubscribe` direct to `wss://devnet-as.magicblock.app/`, three accounts. |
| `E1` | `accountSubscribe` direct to the ER, `Players` **only**. |
| `POLL` | `getAccountInfo(Players)` on the ER in four staggered loops. The no-subscription control. |
| `LOGS` | `logsSubscribe` direct to the ER, keyed by signature. Not a delivery channel — the decomposition instrument. |

The clock is the existing one: a `move` carries a u16 `seq`, the program echoes it into
`PlayerSlot.last_move_seq`, and a channel's write-to-visible for send *N* is the first
arrival on that channel carrying seq *N*. `sendAt` is stamped **after** local signing and
immediately before the `sendTransaction` POST, so ed25519 (p50 1 ms) is outside every
number.

The seat sits in the **lobby**, not the arena. `move_clock` returns the ER slot in every
phase, so a lobby seat may move once per 50 ms slot exactly as a fighting seat may — no
walk to the gate is needed. `start_match` is still sent, so the crank rewrites `Arena` and
`Boss` every 100 ms and `R3`/`E3`'s three-account subscriptions carry realistic traffic
rather than two silent channels. An empty arena is explicitly not a wipe
(`tick.rs::damage_kills_respawns_and_wipes`), so the match holds `Fighting` throughout.

Two independent runs, 300 sends each at 150 ms, 289–294 acknowledged seqs per channel per
run. Zero send failures, zero subscription errors in either run.

`logsSubscribe` is ER-only — the router answers it `-32601` — which is why the
decomposition can only be taken against the ER.

---

## Write-to-visible, by channel

Milliseconds. Run 1 / Run 2.

| Channel | n | p50 | p90 | p95 | mean |
|---|---|---|---|---|---|
| `R3` router, 3 accounts | 293 / 289 | **165 / 154** | 225 / 166 | 280 / 271 | 181.7 / 168.8 |
| `E3` ER direct, 3 accounts | 293 / 289 | **124 / 122** | 149 / 131 | 235 / 134 | 136.0 / 130.9 |
| `E1` ER direct, players only | 293 / 289 | **126 / 122** | 143 / 132 | 234 / 136 | 137.3 / 131.9 |
| `POLL` getAccountInfo | 287 / 285 | **167 / 162** | 231 / 220 | 261 / 235 | 177.8 / 171.7 |

For scale, on the same runs `sendTransaction`'s own POST returned at p50 **124 / 122 ms**.
`E3`'s complete write-to-visible is the same number. The state comes back in the time it
takes the submit to come back.

## Paired deltas — the same seq on two channels, so the submit half cancels exactly

| Pair | n | p50 Δ | p90 Δ | first-named-channel-wins |
|---|---|---|---|---|
| `R3` − `E3` | 294 / 290 | **+40 / +32 ms** | +51 / +37 | 3% / 2% |
| `E3` − `E1` | 294 / 290 | **−1 / 0 ms** | 0 / 0 | 64% / 46% |
| `E3` − `POLL` | 287 / 286 | **−38 / −37 ms** | −1 / −3 | 92% / 96% |
| `R3` − `POLL` | 287 / 286 | +3 / −4 ms | +38 / +29 | 45% / 55% |

The router is behind on 97–98% of individual writes, not on average. Its tail is worse
than its median: p95 write-to-visible 280 / 271 ms against 235 / 134 ms.

Incidentally, the router also delivers roughly **twice as many frames** for the identical
three subscriptions — 4,133 / 4,111 against the ER's 2,091 / 2,088 — so it is not merely
forwarding one-for-one.

## The decomposition — where the read half actually goes

`logsSubscribe` fires when the validator **executes** a transaction. Account-arrival minus
log-arrival, on the same signature, is what the account notification costs *on top of* a
notification the same socket already delivered. Run 2, 300 signatures matched:

| | p50 | p90 | p95 | max |
|---|---|---|---|---|
| send → executed (log notification) | **123 ms** | 133 | 336 | 1019 |
| executed → visible on `E3` | **0 ms** | 0 | 0 | 3 |
| executed → visible on `E1` | **0 ms** | 1 | 2 | 9 |
| executed → visible on `R3` | **31 ms** | 37 | 41 | 535 |
| executed → visible on `POLL` | **36 ms** | 91 | 105 | 130 |

The account update and the log for the same transaction leave the ER in the same flush.
The whole of write-to-visible on a direct ER subscription is submit-and-execute; the
notify hop is **0 ms**, and the 31 ms charged to `R3` in this table is the router,
measured a second and independent way that agrees with the paired delta above.

## Coalescing

At 150 ms sends the inter-notification gap is p50 150 ms on all three subscriptions. The
gaps are visibly aligned to a 50 ms grid — the mean absolute residual against a 50 ms grid
is **4.3 ms (`E3`) / 4.8 ms (`E1`)** against **16.7 ms for `POLL`**, where an unquantised
signal would sit near the 12.5 ms uniform expectation. So the slot grid is real and
notification emission is bound to it.

**It costs nothing that can be recovered.** The quantisation is charged *before* the log
notification — it is inside the 123 ms send→executed figure, not additive on top of it —
which is exactly what `executed → visible = 0 ms` says. And the on-chain limiter already
forbids a seat writing faster than one move per slot (`slot.last_move_tick == now →
RateLimited`), so a single seat can never generate two writes for one slot to coalesce.
Across the two runs, 6 and 10 of 300 seqs never surfaced at all — a 2–3% collision rate at
a 150 ms cadence — and those are moves the chain refused, not notifications the ER
withheld.

**Subscribing to fewer accounts does not help.** `E3` (three accounts) and `E1` (one)
differ by p50 −1 / 0 ms with a p95 of 1 ms, while the crank was writing `Arena` and `Boss`
every 100 ms on those same sockets. The hypothesis is dead.

## Polling

`POLL` is 36–38 ms slower at p50 and far worse at p90 (91 ms behind execution). Its
per-loop round trip was p50 123–124 ms — the same RTT everything else pays — so with four
staggered loops the expected sampling bias is ~15 ms and the measured 36 ms is bias plus
the fact that a request in flight when the write lands cannot report it. Polling buys
nothing and costs four times the request volume. It is a control, not a candidate.

---

## What this implies

1. **Move the subscription off the router and onto the pinned ER.** 32–40 ms of p50 and
   ~110 ms of p95, free, on a seam that already exists. `subscribeMatch` already takes
   `wsUrl` and its own docstring already says to pass `connectMatch`'s resolved `erFqdn`
   with `http` swapped for `ws`; nothing does. The blocker is that the only call site is
   `app/src/App.tsx`, which is frozen for this run — see the note below for the one-line
   change, and for the in-scope alternative that avoids touching it.

2. **Everything else in the read path is already at the floor.** Fewer accounts: 0 ms.
   Coalescing after execution: 0 ms. Polling: negative. Do not spend time here.

3. **The remaining latency is the submit-and-execute half**, at p50 122–124 ms, which is
   one HTTP round trip to Singapore and is where any further work has to go.

### Two things this run contradicts, stated plainly

- `app/src/net/subscribe.ts` says the router "costs a p50 of −4 ms" over 488 matched
  slots. That does not reproduce: 583 paired samples across two runs put the router 32–40
  ms **behind**, losing 97–98% of individual writes, and a second independent instrument
  (`logsSubscribe`) puts it 31 ms behind. The earlier race was raced on slot-aligned crank
  updates, where both channels observe the same slot flush and a fixed proxy delay is
  masked; this one is per-write with an execution timestamp. The docstring's routing and
  safety claims about the router are untouched — only its latency claim.
- The brief's 196 ms median ICMP-equivalent RTT India→devnet-as is larger than the 122 ms
  full HTTP round trip measured here 600 times. One of the two figures is measuring
  something else. Not resolved in this run.

### Not measured

- Under 20-seat load, in a browser, which is where the panel's 295 ms p50 comes from. This
  run is one seat from Node at 150 ms. The router delta is paired and load-independent by
  construction, but the absolute numbers here are a floor, not the player's experience.
- Whether pinning the socket to one ER survives a mid-match re-delegation. It is the
  router's one real advantage and the reason the current default exists.

### Treasury

Each run of this spike permanently costs ~0.026 SOL in ER-clonable rent on three PDAs that
are never reclaimed. Two runs took the treasury from 0.086 to **0.035 SOL**. It needs
topping up before it can create many more matches.
