# RESULT — write-to-visible, proven end to end on devnet

**Write-to-visible p50 fell from 295 ms to 127 ms and p95 from 525 ms to 160 ms.**
Measured on real devnet, on the path the app actually runs, over three runs of ≥300
acknowledged samples per arm.

**All of the gain is one change: `sendInstructions` no longer fetches a blockhash on the
critical path.** The other change this run was meant to prove — subscribing to the pinned
ER's websocket instead of the router's — **measured zero**, three times, and the reason it
still ships is a browser-only address-family effect Node cannot see. That is stated in
full below rather than folded into the headline.

The remaining 127 ms is one round trip to Singapore. There is no read hop left to remove.

| | p50 | p95 | p99 |
|---|---|---|---|
| **BEFORE** — live browser telemetry panel, as briefed | **295 ms** | **525 ms** | not recorded |
| **BEFORE** — old code path re-measured today, from Node | 249 ms | 305 ms | 421 ms |
| **AFTER** — shipped code path, same run, same minute | **127 ms** | **160 ms** | 354 ms |

Run of record is `docs/perf/appath-run3.jsonl` (it is the one carrying every raw sample);
runs 1 and 2 are replication and are quoted wherever stability is the point.

---

## Deploys

Both halves were deployed and both were verified, not assumed.

**Program** `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`

```
solana program deploy target/deploy/heartrot.so \
  --program-id target/deploy/heartrot-keypair.json -k ~/.config/solana/id.json -u devnet
Signature: 3px4qELQ3BQsqmmxRPHxtfqJe5iWfUMXMZjpyBVoqa6CFfTdGfmXqRjSos7EL8MCxTiZe6QDbhfgbdZiN1baLyV6
```

Verified by dumping the on-chain bytes back and diffing them against the build, because a
previous run measured a CU ceiling against a stale binary and nothing said so:

```
sha256(target/deploy/heartrot.so)  324902d8…  112,104 B
solana program dump …              e573b942…  112,480 B
prefix-equal: True    tail all zero: True
```

The on-chain account is the local artifact plus 376 bytes of zero padding, which is what
the loader writes. The measurements below ran against this binary.

**Site** `https://heartrot.ansht.workers.dev` — `wrangler deploy`, version
`38412227-f591-444e-81ec-7bc364c097e5`. Verified by fetching the deployed `index.html` and
confirming it names `assets/index-DxqMiSin.js`, the same hashed bundle the local
`vite build` produced, and by a live `GET /api/faucet/status` → `200` in 0.55 s.

## Build and tests

| check | exit |
|---|---|
| `cargo check --workspace` | 0 |
| `cargo test -p heartrot` | 0 — **59 passed**, 0 failed |
| `cargo build-sbf` (with `HEARTROT_TREASURY`) | 0 |
| `cd app && npx tsc --noEmit` | 0 |
| `cd worker && npx tsc --noEmit` | 0 |
| `cd packages/client && npx tsc --noEmit` | 0 |
| `cd app && vite build` | 0 |

**`app/` is untouched by this phase.** No git command was run, so the evidence is mtimes
against the wall clock of this phase, whose first action was at **22:25:32 IST**:

```
19:33  app/src/render/Arena.tsx, app/src/render/sprites.ts   frozen — 3 h before
20:12  app/src/styles.css                                    frozen — 2 h before
20:59  app/src/App.tsx                                       frozen — 1.5 h before
22:15  app/src/net/subscribe.ts        in scope (netcode), and not by this phase
22:21  app/src/net/metrics.ts          in scope (netcode), and not by this phase
22:22  app/src/input/controls.ts       in scope (netcode), and not by this phase
```

Every frozen path predates this phase by 1.5–3 hours; the three files written later are all
under `app/src/net` and `app/src/input`, which are explicitly in scope, and all three were
written before this phase began — by the earlier phase whose work these numbers measure.
This phase added exactly two files, both under `scripts/spike/`, plus four evidence files
under `docs/perf/`. `app/dist` is build output.

---

## Method

Script: `scripts/spike/perf_appath.ts`. Raw: `docs/perf/appath-run1.jsonl`,
`appath-run2.jsonl`, `appath-run3.jsonl`.

The measured quantity is exactly the one `app/src/net/metrics.ts` puts on the panel, by
the same rule: a `move` carries a u16 `seq`, the program echoes it into
`PlayerSlot.last_move_seq`, and write-to-visible for send *N* is

    (arrival of the account update carrying seq N) − (the moment the send was decided)

The send clock is stamped precisely where `App.tsx` calls `recordSend(seq)` — **before**
the send path is entered — so everything the send path does, including the `BEFORE` arm's
blockhash round trip, is inside the number, as it is on the panel. Only the **exact** seq
counts, again as `metrics.ts` does it: `last_move_seq` is a high-water mark, and charging a
superseded send with a later write's round trip would report a round trip nobody made.

**The code under test is the production code, not a re-implementation.** The script drives
`sendInstructions` from `packages/client` and `subscribeMatch` from `app/src/net/subscribe.ts`
directly. A wrong encoder or a broken feed fails in the spike, not in front of a player.

### Both arms run in the same run

The 295/525 in the brief were measured on a different evening of the same home ISP.
Quoting a new number against them and calling the difference the improvement charges the
network's mood to the code. So both arms are driven against the same match, the same seat
and the same minute, alternating in blocks of 25 sends:

| arm | send | feed |
|---|---|---|
| `BEFORE` | fresh `getLatestBlockhash` per send, then build/sign/post | router websocket |
| `AFTER` | `sendInstructions` — cached blockhash | pinned ER websocket |

Both feeds are the **same** `subscribeMatch`, one of them handed
`wsUrl: ROUTER_WS_ENDPOINT` to pin it back to the router. The only difference between the
two feeds is the one line this run is defending.

Both feeds observe every write, so the 2×2 falls out for free and the two levers can be
attributed separately instead of as one lump.

The seat sits in the lobby. `move_clock` returns the ER slot in every phase, so a lobby
seat may move once per 50 ms slot exactly as a fighting seat may. `start_match` is still
sent, so the crank rewrites `Arena` and `Boss` every 100 ms and both three-account
subscriptions carry realistic traffic. An empty arena is explicitly not a wipe
(`tick.rs::damage_kills_respawns_and_wipes`), so the match holds `Fighting` throughout —
run 3 finished at tick 1,708.

Pacing is 250 ms decide-to-decide. The `BEFORE` arm spends a round trip on its blockhash
before it sends, so 250 ms keeps consecutive writes at least two ER slots apart in both
arms; `move_player` refuses a second move in the same slot and a refusal is not a round
trip. Zero send failures in all three runs.

One caveat governs every number below: this is **one seat, driven from Node**, not twenty
seats in a browser. See "What is left".

---

## The measurement

Milliseconds. Runs 1 / 2 / 3.

| arm | n | p50 | p90 | p95 | p99 | mean |
|---|---|---|---|---|---|---|
| **BEFORE** fresh blockhash + router ws | 293 / 308 / 324 | **243 / 254 / 249** | 259 / 321 / 273 | **271 / 392 / 305** | 385 / 610 / 421 | 247 / 276 / 256 |
| **AFTER** cached blockhash + ER ws | 293 / 308 / 322 | **126 / 125 / 127** | 136 / 141 / 142 | **140 / 236 / 160** | 361 / 568 / 354 | 131 / 143 / 135 |

Improvement, measured within each run against its own control: **−48 % / −51 % / −49 % at
p50**. Against the briefed panel figures, **295 → 127 ms (−57 %) at p50 and 525 → 160 ms
(−70 %) at p95**.

### Which lever did it — the 2×2

The same runs, split by how the write was sent and where it was observed.

| | observed on **router** ws | observed on **ER** ws |
|---|---|---|
| **fresh blockhash** send | 243 / 254 / 249 ← *BEFORE* | 243 / 254 / 254 |
| **cached blockhash** send | 123 / 125 / 124 | 126 / 125 / 127 ← *AFTER* |

Read across a row: the websocket costs nothing, twice. Read down a column: the blockhash
costs ~125 ms, twice. **The blockhash cache is the entire result.** The number it removes
is one HTTP round trip to Singapore, which `docs/perf/submit.md` measured directly at
124 ms p50 and `docs/perf/clientside.md` measured again at 122–129 ms.

### The read path is at zero

`AFTER` write-to-visible against the same run's `sendTransaction` POST returning:

| run | POST returns, p50 | write-to-visible, p50 |
|---|---|---|
| 1 | 124 ms | 126 ms |
| 2 | 126 ms | 125 ms |
| 3 | 128 ms | 127 ms |

**The state comes back in the time it takes the submit to come back.** The account
notification is already in flight when the POST's own response is. This reproduces
`docs/perf/notify.md`'s `executed → visible = 0 ms` by a second, independent route, and it
means there is no notification hop left to optimise: any further improvement has to come
out of the round trip itself.

For scale, a bare TCP handshake to `devnet-as.magicblock.app:443` from this house measured
**132.7 ms p50** over 40 samples today (`docs/perf/family-run1.jsonl`). Write-to-visible is
127 ms. **The app is inside one network round trip of the wire.**

---

## The negative result: the ER-websocket lever measured zero

`docs/perf/notify.md` measured the router 32–40 ms behind the pinned ER at p50, losing
97–98 % of individual writes, and that finding is why `subscribe.ts` resolves the ER's own
websocket. **It did not reproduce.** Paired per seq — the same write observed on both
sockets, so the submit half cancels exactly:

| run | n paired | router − ER, p50 | p95 | ER arrived first |
|---|---|---|---|---|
| 1 | 586 | **−3 ms** | +13 | 27 % |
| 2 | 616 | **−1 ms** | +30 | 19 % |
| 3 | 646 | **−5 ms** | +46 | 13 % |

From Node the router is a few milliseconds **ahead** at the median and wins most
individual writes. Its tail is worse (p95 +13 to +46 ms, p99 up to +190), which is the only
surviving trace of the earlier finding.

### Why, and why the change still ships

`app/src/net/subscribe.ts` already names the cause, and it reproduces exactly. Bare TCP
connect, 40 samples per family per host, no TLS and no HTTP so there is no server work in
the number (`scripts/spike/perf_family.ts`):

| host | resolver's own order | IPv4 connect p50 | IPv6 connect p50 |
|---|---|---|---|
| `devnet-router.magicblock.app` | **AAAA first** (`2606:4700:…`) | **29.6 ms** | **190.1 ms** |
| `devnet-as.magicblock.app` | AAAA first (`64:ff9b::…`, DNS64-synthesised) | 132.7 ms | 138.9 ms |

The router is behind Cloudflare, whose IPv6 anycast is **160 ms further from this ISP**
than its IPv4 edge. The ER is identical on both families because its AAAA is a
DNS64-synthesised address taking the same path as its A.

Node opens sockets with Happy Eyeballs (`autoSelectFamily`, default true since Node 20), so
**Node silently takes the router's fast family**. A browser follows the OS resolver's
AAAA-first answer and takes the slow one. So:

- From Node, the router and the ER are the same speed. Measured, three times, above.
- In a browser, the router's path carries ~160 ms more RTT than its IPv4 path, and the ER
  is unaffected either way. **Inferred, not measured** — no browser number was taken this
  run, and the inference from a TCP-connect RTT to a websocket frame's delivery is exactly
  the step that is not proven here.

That is the honest state of it: the websocket change is **worth nothing that Node can
measure** and is defended on a browser mechanism that has been measured only at the
transport layer. It ships because it cannot cost anything — the ER is family-neutral — and
because the snapshot half of `subscribe.ts` was already pinned to the same ER, so the
change makes the two halves agree instead of describing different worlds.

---

## What worked

1. **Caching the ER blockhash — the whole result.** `sendInstructions` used to open with
   `await rpc.getLatestBlockhash().send()`, so every keypress was two serial round trips to
   Singapore. Stale-while-revalidate, 2 s TTL, keyed by the `rpc` handle in a `WeakMap` so
   an ER blockhash can never be served to a base-layer send. **−125 ms p50, measured within
   run, three times.**
2. **Measuring both arms in one run.** The old path re-measured today is 249 ms p50, not
   the briefed 295 ms. Had the after-number been quoted against 295 alone, ~46 ms of
   ordinary evening-to-evening network difference would have been reported as engineering.

## What did not work

1. **Subscribing to the pinned ER's websocket instead of the router's: zero.** Three runs,
   1,848 paired writes, p50 −1 to −5 ms in the router's favour. `notify.md`'s +32–40 ms did
   not reproduce. Kept, on a browser-only argument that is measured only at the transport
   layer.
2. **Everything the earlier spikes already killed, confirmed dead and not re-litigated
   here:** subscribing to one account instead of three (0 ms), the ER's per-slot
   notification coalescing (charged before execution, 0 ms after), polling instead of
   subscribing (36 ms *worse*), HTTP/1.1 pipelining (4.7× worse), and the client's own
   decode path (16 µs — 0.005 % of the old p50).

## What is left

1. **The floor is physics and the app is sitting on it.** 127 ms write-to-visible against a
   132.7 ms bare TCP handshake to Singapore. The only remaining lever is geographic — the
   player is in India and the ER is `devnet-as` in Singapore — and that is a deployment
   decision, not a code change.
2. **No browser number was taken after the change.** Every figure here is Node, one seat.
   The panel's own p50/p95 under a real 20-seat raid have not been re-read since, and the
   websocket claim in particular can only be settled there. This is the single highest-value
   thing left to do and it needs a browser, not another Node script.
3. **The tail is unexplained.** p99 sits at 354–568 ms in the `AFTER` arm while p95 is
   140–236 ms, and run 2's p95 was 236 ms against run 3's 160 ms on identical code. The
   histograms show a handful of 500–700 ms samples per run. Whether that is the ISP, the
   ER, or a GC pause in the spike itself is not established.
4. **2–4 % of seqs never surface on their own** (14 / 24 / 14 of 600–660 sends). Those are
   writes the chain coalesced or refused — `move_player` rejects a second move in the same
   50 ms slot — not notifications withheld. Consistent with `notify.md`'s 2–3 % at a faster
   cadence. Not a latency problem, but it is why n is 293–324 rather than 300–330.
5. **`app/src/net/subscribe.ts`'s docstring is now half-stale.** It cites the router as
   "+26.8 ms p50 … ER first on 96 % of 2,361 paired writes". Today's three runs say the
   opposite from Node. The *reason* it gives — the address family — is confirmed and is the
   part worth keeping. Left unedited only because `app/` is frozen for this run.

---

## Cost

Each `perf_appath` run permanently costs ~0.05 SOL in base-layer rent plus ER-clonable rent
on three PDAs that are never reclaimed. The treasury was topped up from the deploy keypair
by 0.6 SOL before this run and stands at **0.540 SOL** (`/api/faucet/status`, 539 matches of
headroom).
