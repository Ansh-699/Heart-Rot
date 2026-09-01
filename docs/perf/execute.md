# PERF-EXECUTE — the execute hop is 0 ms; the blockhash fetch is 130 ms

**Headline.** Measured per transaction on one clock: the time from `sendTransaction`
returning to that transaction's own log notification arriving is **p50 0 ms, p90 1 ms,
p95 2 ms**, over 780 samples across three runs. Execution is not a hop. There is nothing
in it to optimise.

The thing that *is* in the write path, and is worth **130 ms at p50**, is the
`getLatestBlockhash` round trip that `sendInstructions` performs before every single
keypress. Paired A/B on interleaved sends: **cached blockhash p50 132–136 ms**, **fresh
blockhash per move p50 264–266 ms**.

SP-LOAD's inference that the log notification arrives *before* the POST returns (141 ms vs
124 ms), and that the two are therefore independent paths, is **refuted**. It compared two
marginal distributions from different transactions. Paired per transaction they are the
same instant: the POST response and the notification ride the same return flight from
Singapore.

Script: `scripts/spike/perf_execute.ts`. Raw: `docs/perf/execute-a.jsonl`,
`execute-b.jsonl`, `execute-c.jsonl`.

---

## Method

Four timestamps per `move`, all `process.hrtime.bigint()` in one process, so every
comparison below is a paired difference and not two runs an hour apart:

| Stamp | What it is |
|---|---|
| `tCall` | where the app's `recordSend(seq)` fires — before anything, blockhash fetch included |
| `tPost0` | the POST is handed to the socket; the message is already built and signed |
| `tPost1` | `sendTransaction` returns the signature |
| `tLog` | the transaction's own `logsSubscribe` notification arrives (first delivery only) |
| `tAcct` | the `accountSubscribe` update on `Players` carrying this move's `seq` arrives |

Four subscriptions, **each on its own socket, all direct to `wss://devnet-as.magicblock.app/`**
— never the router. Separate sockets because a 2.5 KB account frame and a log frame parsed
on one connection would shove each other's arrival timestamp around, which is exactly the
quantity being measured. `slotSubscribe` runs alongside and timestamps every slot boundary
locally.

Two arms, **interleaved sample by sample** so they share the same network weather:

- **cached** — one blockhash held, refreshed in line every 10 s. The POST is the whole
  client-side cost.
- **fresh** — `getLatestBlockhash` awaited on every move, then sign, then POST. Exactly
  what `sendInstructions` does today, and therefore exactly what the shipped app does.

260 moves per run at a 120 ms pace (two ER slots, so the program's per-slot limiter never
fires — 1 `RateLimited` across 780 sends). No rent was spent: the script attaches to an
arena already delegated to `devnet-as` and in LOBBY, claims one free seat and moves.
`move` takes `Arena` read-only and needs no live match.

Three runs on 2026-09-01, arena `1788266873`
(`ET6pm41H35AE366TmtAosQZmHRXUQXU3EdrdoT3WBXNp`), players
`EVsTMtBM6enQEFfzhFqoFtfBrmRT9Wwy9uGkdeeesZta`, validator
`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`, player in India. A fourth, earlier pilot
run (cached arm only, 260 samples) agreed — `tPost1 -> tLog` p50 −1 ms, send→visible p50
130 ms — but its raw file was truncated by the next run and is not quoted below.

---

## 1. The execute hop

`tPost1 -> tLog`, milliseconds. Negative means the notification arrived before the POST
returned.

| run | n | min | p50 | p90 | p95 | max | mean | rows where it arrived first |
|---|---|---|---|---|---|---|---|---|
| a | 260 | −5 | **0** | 1 | 1 | 794 | 6.1 | 43/260 |
| b | 260 | −12 | **0** | 0 | 0 | 9 | −0.5 | 97/260 |
| c | 260 | −3 | **0** | 1 | 2 | 10 | 0.1 | 72/260 |

Run a's 794 ms max is one outlier; its p95 is 1 ms.

The sign flips run to run around a median of zero, which is the whole finding: the ER
finishes executing the transaction and emits its notification *in the same flush* that
carries the POST's HTTP response. Which of the two the client's event loop reads first is
a coin toss. There is no interval here to shorten.

`tLog -> tAcct` is the same story — p50 0 ms, p95 1 ms in all three runs — so the account
update carrying `last_move_seq` is not queued behind the log either.

**Execution takes 0 ms of observable wall time. The entire `send → visible` interval is
network flight.**

## 2. What the interval actually is

| measurement | run a | run b | run c |
|---|---|---|---|
| `getSlot` HTTP round trip, same keep-alive connection (n=120) | p50 134 | p50 133 | p50 135 |
| POST duration `tPost0 -> tPost1` (n=260) | p50 132 | p50 133 | p50 130 |
| `tPost0 -> tAcct` — send to visible (n=260) | p50 132 | p50 133 | p50 130 |

Three numbers that are the same number. Send-to-visible on a direct ER connection is one
HTTP round trip to Singapore and nothing else: ~65 ms out, ~0 ms execute, ~65 ms back.

This also disposes of the 196 ms ICMP-equivalent RTT quoted in SP-LOAD. The measured
application-level round trip on the connection this client actually sends over is **133 ms
p50**, and the POST already sits on that floor. There is no submit-side slack.

## 3. Slot cadence, and the quantisation that costs nothing

`slotSubscribe`, consecutive-slot gaps only (n=259–260 per run):

| run | min | p50 | p90 | p95 | max | mean |
|---|---|---|---|---|---|---|
| a | 45 | **50** | 52 | 53 | 57 | 50.0 |
| b | 38 | **50** | 53 | 54 | 64 | 50.0 |
| c | 6 | **50** | 52 | 54 | 95 | 50.0 |

The ER's advertised 50 ms block time is real and tight as observed from India. Run c's
6 ms / 95 ms pair is one delivery jitter event, not a stalled slot.

Now the part that matters. For each transaction, the log notification carries the slot the
transaction landed in; `slotSubscribe` says when *that slot's* notification arrived
locally. The difference `tLog − t(slot notification)`:

| run | min | p50 | p90 | p95 | max |
|---|---|---|---|---|---|
| a | −136 | **−20** | −1 | 0 | 3 |
| b | −85 | **−24** | −2 | 0 | 0 |
| c | −54 | **−24** | −1 | 0 | 1 |

**The write's notification arrives ~22 ms before the slot notification for its own slot.**
The ER does not hold a write until the slot closes; it pushes on execution and the slot
notification trails. So at one write per account per slot — which is what a single player
at a 50 ms send cadence produces — the documented
one-notification-per-account-per-50 ms-slot coalescing costs **0 ms**. It is a cap on
notification *rate*, not a delay added to any individual write.

None of the 780 sends waited on a slot boundary.

## 4. The 130 ms that is actually there

`tCall -> tAcct` — write-to-visible under the app's own definition, arm for arm:

| run | cached p50 | cached p90 | cached p95 | fresh p50 | fresh p90 | fresh p95 | **Δ p50** |
|---|---|---|---|---|---|---|---|
| a | 136 | 146 | 167 | 266 | 279 | 372 | **130** |
| b | 135 | 146 | 150 | 265 | 284 | 294 | **130** |
| c | 132 | 152 | 185 | 264 | 279 | 303 | **132** |

n = 130 per arm per run; 780 samples total, every one acknowledged (260/260 account acks
in all three runs).

The POST duration is identical in both arms (p50 130–134 vs 131–134). The arms differ by
exactly one extra HTTP round trip, and the difference equals the measured round trip.
`app/src/App.tsx:405` calls `recordSend(seq)` and then `send(...)`, and `send`
(`App.tsx:338`) calls `sendInstructions`, whose first line is
`await rpc.getLatestBlockhash().send()` (`packages/client/src/connection.ts:454`). Every
keypress pays a full India→Singapore round trip before its transaction is even signed.

**Arithmetic check against the shipped app.** Fresh-blockhash on a direct ER connection is
265 ms. `perf_notify.ts` prices the router websocket the app subscribes over at 32–40 ms
p50. 265 + 35 = 300 ms against the app's reported p50 of 295 ms. The budget closes with
nothing unexplained, which is the strongest evidence that these two are the whole gap.

## 5. Two facts that bound the fix

**Blockhash lifetime on the ER is ~60 s.** One blockhash held and sent with every 2 s until
refused:

| run | last accepted age | first rejected age | rejection |
|---|---|---|---|
| b | 58,021 ms | 60,155 ms | `-32003 … Blockhash not found` |
| c | 59,725 ms | 61,845 ms | `-32003 … Blockhash not found` |

(Acceptance here is the POST being accepted, not a confirmed landing.) A 5 s refresh has
12× margin; the 10 s TTL the cached arm ran on produced zero blockhash failures in 390
sends.

**A cached blockhash makes byte-identical transactions collide.** Same signed transaction
sent twice under one blockhash:

```
first send:  accepted
second send: transaction verification error: This transaction has already been processed (-32003)
```

`move` is safe — it carries a u16 `seq` that changes every send. **`shoot` is not**: its
instruction data is three bytes, `[tag, seat, dir]` (`instructions.ts:549`), with no
nonce. Two shots in the same direction from the same seat under one held blockhash are the
same transaction, and the second is refused. Today's fresh-blockhash-per-send is what
accidentally makes each shot unique, and the app's error handler swallows a `-32003` with
no custom code (`App.tsx`: `if (decoded.code === 14 || decoded.code === undefined) return`),
so the shot would vanish silently. Any blockhash cache must handle this — the smallest fix
is for the cache to refresh when the wire bytes it is about to send match the previous
send from the same entry.

---

## Verdict

| hop | cost | do something? |
|---|---|---|
| execute (`tPost1 -> tLog`) | **0 ms** p50, 2 ms p95 | **No.** There is no interval. |
| notify (`tLog -> tAcct`) | **0 ms** p50, 1 ms p95 | No. |
| slot-boundary wait | **0 ms** — the notification precedes its own slot notification by 22 ms | No. |
| POST itself | 130 ms p50, equal to the measured 133 ms application RTT | No. Physics. |
| **`getLatestBlockhash` before every send** | **130 ms p50** | **Yes.** One cache in `connection.ts`, ~60 s of headroom, one collision case to guard. |
