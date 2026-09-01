# Prior art: how anyone else makes an on-chain realtime game feel instant

Research + live measurement, 2026-09-01. Player in India (Ghaziabad), match pinned to
`devnet-as.magicblock.app` (`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`).

Everything under "Measured here" was run in this session against live devnet. Scripts are
throwaway probes; the exact commands are reproduced inline so any number can be re-run.

---

## 0. What the prior spikes already settled, so this does not re-litigate it

`docs/perf/execute.md` established that write-to-visible on a **direct** ER subscription is
one HTTP round trip and nothing else: ~65 ms out, **0 ms execute**, ~65 ms back, with the
account notification riding the same return flight as the POST's own response. The read
half is empty. The submit half is the network.

That has a hard consequence for this research: **there is no netcode technique that removes
a round trip you are actually waiting on.** Prediction hides it, and prediction is already
here. So the search splits cleanly in two:

1. **Make the round trip shorter** — geography and peering. This is where the industry's
   own answer lives, and it is where the only large unclaimed number in this codebase is.
2. **Widen what prediction covers** — the round trips the panel cannot see because they
   belong to actions that carry no `seq`.

Everything else in the literature is either already implemented here or does not transfer.

---

## 1. What the industry actually does: colocation, not cleverness

MagicBlock's own published position is unambiguous and it is not a netcode trick.

- MagicBlock markets Ephemeral Rollups at "10–50 ms latency", and qualifies it: end-to-end
  under 50 ms **"when applications co-locate with regional validator nodes"**
  ([magicblock.xyz/blog/a-guide-to-ephemeral-rollups](https://www.magicblock.xyz/blog/a-guide-to-ephemeral-rollups)).
- Supersize — the flagship real-time PvP ER game, 250K matches in July 2026 — reports
  **"~30 ms end-to-end"**, and attributes it to **co-location**, not to a client technique:
  "Co-location further reducing networking latency to approximately 30 ms end-to-end"
  ([magicblock.xyz/blog/supersize](https://www.magicblock.xyz/blog/supersize/)).
- The same source quotes the Supersize dev on their send cadence: *"We're sending
  transactions every 30 milliseconds. They're landing every 50 milliseconds."* HEARTROT
  already sends at 50 ms = one slot, which is the on-chain rate limiter's floor. That half
  is done.
- ERs are described as spun up "on-demand, **close to the user**"
  ([solanacompass.com/projects/magicblock](https://solanacompass.com/projects/magicblock)).

There is no published Supersize netcode postmortem, no rollback scheme, no exotic read
path. The 30 ms number is 30 ms because the player and the validator are in the same metro.
**HEARTROT is 5,000 km from its validator.** That is the finding.

---

## 2. Measured here: the four public ER regions, from India, paired

`getSlot` POST over one warm keep-alive socket per endpoint, requests **interleaved sample
by sample** so a transient network wobble hits every arm equally. n=80 per arm, `node:https`
with `keepAlive: true, maxSockets: 1`, 5 warm-up requests per arm discarded.

| Region | identity | p50 | p90 | p95 | min |
|---|---|---:|---:|---:|---:|
| `devnet-as` (ships today) | `MAS1Dt9…zk57` | **129.8** | 139.1 | 143.7 | 123.0 |
| `devnet-tee` | `MTEWGuqx…3xzo` | **95.8** | 101.8 | 106.3 | 84.6 |
| `devnet-eu` | `MEUGGrYP…MS8e` | 185.8 | 287.9 | 666.0 | 169.6 |
| `devnet-us` | `MUS3hc9T…HNd` | 251.4 | 260.5 | 267.2 | 241.0 |

**Paired per-sample delta AS − TEE: p50 +34.2 ms, p90 +44.1 ms. TEE was faster on 98% of
the 80 pairs.**

Same measurement on the **notification socket** — a `slotSubscribe`/`slotUnsubscribe`
request-response round trip over the live websocket, n=60 per arm, interleaved:

| Socket | p50 | p90 | min |
|---|---:|---:|---:|
| `wss://devnet-as.magicblock.app/` | 120.2 | 137.9 | 113.2 |
| `wss://devnet-tee.magicblock.app/` | **95.0** | 100.4 | 83.1 |
| `wss://devnet-router.magicblock.app/` | **286.0** | 294.5 | 274.5 |

**Paired AS − TEE on the websocket: p50 +26.6 ms, TEE faster on 98% of pairs.**
**Paired ROUTER − AS: p50 +164.4 ms.**

Bare TCP connect (SYN/SYN-ACK, no server work), n=12 each, for a transport-only cross-check:

```
devnet-as.magicblock.app        67.213.122.145   p50 115.9  min 107.7
devnet-tee.magicblock.app       34.87.52.79      p50  89.4  min  78.4
devnet-eu.magicblock.app        160.202.131.253  p50 186.3  min 160.1
devnet-us.magicblock.app        109.94.98.35     p50 240.4  min 233.4
devnet-router.magicblock.app    (Cloudflare)     p50 184.1  min 174.2
api.devnet.solana.com           74.63.203.93     p50  90.8  min  82.2
```

### Why TEE is faster, and it is not distance

Both are in Singapore. The difference is transit, and that is the part a doc would never
have told me:

```
67.213.122.145  Singapore SG  AS396356  Latitude.sh   <- devnet-as
34.87.52.79     Singapore SG  AS396982  Google LLC    <- devnet-tee
```

`devnet-as` is on Latitude.sh bare metal; `devnet-tee` is on Google Cloud
`asia-southeast1`. Google's peering into India is ~30 ms better than Latitude.sh's from this
connection. Cross-check: AWS `ap-southeast-1` (Singapore) measures 88.8 p50 / 82.3 min from
here — within noise of the TEE box, and ~40 ms better than `devnet-as`. So the ~34 ms is a
real, repeatable network-provider gap, not the ER doing less work.

### The TEE validator is a first-class routing target, verified live

This is the part that makes the lever cheap. `getRoutes` on the live router:

```json
{ "identity": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
  "fqdn": "https://devnet-tee.magicblock.app/",
  "baseFee": 0, "blockTimeMs": 50, "countryCode": "SGP" }
```

Identical `baseFee`, identical `blockTimeMs`, same build as `devnet-as`
(`magicblock-core 0.14.13`, `solana-core 4.0.0`, `git-commit 8174cec` on both). Measured
slot cadence 49.8 ms (TEE) vs 50.5 ms (AS) over a 2 s window — the same 50 ms grid.

`connectMatch` resolves its endpoint out of exactly this `getRoutes` table by identity
(`packages/client/src/connection.ts:389`). Repointing the match therefore needs **no routing
code at all** — only the identity constant it is pinned to.

---

## 3. The netcode literature, and what is left of it here

The canonical references, checked against what `app/src/net/predict.ts` already does.

| Technique | Source | Status here |
|---|---|---|
| Authoritative server | Gambetta pt.1 | The ER *is* it. Not optional. |
| Client-side prediction + reconciliation | Gambetta pt.2 | **Done.** `createPredictor`, replay on `lastMoveSeq`, u16 wrap-safe acks, 1 s TTL for silently-refused inputs. |
| Entity interpolation | Gambetta pt.3; Valve `cl_interp` | **Done.** `useSeatInterpolation`, one update behind, alpha clamped, respawn snap. |
| Lag compensation (server rewind) | Gambetta pt.4; Valve | **Does not transfer.** See §5. |
| Rollback / GGPO | fighting-game lineage | **Does not transfer.** See §5. |
| Input delay buffer | fighting-game lineage | Anti-goal — it *adds* latency to hide jitter. |

Valve's numbers are worth quoting because they calibrate what "instant" costs elsewhere:
Source's default `cl_interp 0.1` deliberately renders **100 ms in the past**, on a LAN, and
that is considered fine. HEARTROT's remote-seat interpolation is one crank tick = 100 ms —
exactly Valve's default. There is nothing to win there.
([Source Multiplayer Networking, Valve Developer Community](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking))

The load-bearing observation: **every technique in the list that hides latency, this
codebase already runs — for movement.** The panel measures movement. So the panel is
measuring the one action whose latency is already hidden, and reporting the round trip that
prediction exists to make invisible.

---

## 4. The gap the panel cannot see: `shoot` is not predicted

`app/src/net/metrics.ts` says it outright: *"`shoot` carries no sequence number, so it
counts toward throughput but never toward latency."* And `predict.ts` predicts `self` only —
position and facing. Nothing spawns a bullet locally.

So the actual player-felt sequence on a trigger pull is:

```
click -> [one full round trip, 130 ms direct / ~265 ms with today's per-send blockhash]
      -> Arena write lands, bullet appears at rest
      -> [up to one 100 ms crank tick] -> bullet starts moving
```

That is 130–365 ms of completely unhidden latency on the game's other verb, invisible to
every number in the telemetry panel. Meanwhile the movement number the panel *does* show is
already hidden by prediction. **This is the largest remaining piece of felt latency in the
game, and it is the one nobody has measured.**

Applying prediction to firing is standard practice everywhere in the literature (Valve
predicts weapon fire and effects client-side for exactly this reason) and it transfers
cleanly, because bullet motion is deterministic integer state the client already mirrors —
`bulletAt` in `predict.ts` is the chain's integer velocity times a fractional tick, and the
comment there already argues that nothing accumulates.

The reconciliation key is the only missing piece, and it is free. `Bullet` is:

```rust
pub struct Bullet { pub x: i16, pub y: i16, pub dx: i8, pub dy: i8,
                    pub active: u8, pub _pad0: u8 }   // size asserted == 8
```

**`_pad0` at offset 7 is an unused byte inside a size-8 struct.** Writing the owner's seat
index (0..19) there costs zero account bytes, zero realloc, zero layout migration, and gives
the client the "is this bullet mine?" test it needs to retire a provisional bullet against
the real one. `_pad0` is not decoded on the client today (`packages/client/src/layout.ts:214`).

That same shot tag independently solves the duplicate-signature hazard the blockhash cache
introduces — `shoot` is `[tag, seat, dir]` with no nonce, so two identical shots under one
cached blockhash are byte-identical and the second is refused `-32003`. One program change,
two problems.

---

## 5. What does not transfer, and why — be honest about these

**Rollback netcode (GGPO).** Rollback requires every participant to hold every input and
re-simulate deterministically when a late input arrives. Two things break it here. First,
the authority is a chain and a chain cannot be rolled back — the ER's state is the state.
Second, rollback's speed comes from peers exchanging *inputs* directly, and the ER ships you
other players' *results*, not their inputs, on the same round trip as everything else. The
half of rollback that does apply — re-simulate forward from the last confirmed state when an
authoritative update arrives — is exactly `Predictor.reconcile`, which is already written.
**No gain. Do not build this.**

**Lag compensation / server rewind.** Gambetta pt.4 and Valve both require the server to
keep a timestamped history of world states and rewind to the shooter's view
(`command execution time = current server time − packet latency − client interpolation`).
On-chain that means storing N past snapshots of `Boss` and `Players` in account data and
having `shoot` index into them. Cost: account bytes, compute, and pressure on the ~38 key
cap; the arena account is already 1200 B and `Players` 1924 B. Benefit: **fairness, not felt
latency** — it makes shots register that the shooter believed were hits. HEARTROT's boss is
one large stationary-ish target hit by a hitbox test, not a 1-pixel headshot at range.
**The cost/benefit is upside down. Skip it.**

**Shrinking the interpolation buffer.** Remote seats render 100 ms behind. Cutting that
requires extrapolating remote players, which `predict.ts` deliberately refuses ("extrapolating
another player overshoots the moment they stop, and every stop then ends in a snap-back").
Valve ships 100 ms as the default on LAN. Worth at most ~50 ms of staleness on players you
are not aiming at, at the cost of visible rubber-banding on everyone. **Bad trade.**

**Transaction submission over the notification websocket.** Would put send and receive on
one socket. Tested live — refused on both validators:

```
wss://devnet-as   sendTransaction  -> {"error":{"code":-32601,"message":"Method not found"}}
wss://devnet-tee  sendTransaction  -> {"error":"Method not supported: sendTransaction"}
```

(Also true for `getLatestBlockhash` and `getSlot`.) **Measured dead end.**

**A faster slot time.** The validator is Dockerised (`magicblocklabs/validator`) and exposes
`VALIDATOR_MILLIS_PER_SLOT`, so a self-hosted ER could run 10 ms slots instead of 50. But
`execute.md` already measured slot-boundary wait at **p50 −20 ms** — the write's notification
arrives *before* its own slot notification, and none of 780 sends waited on a boundary. A
single seat writing once per slot never touches the coalescing rule. **Faster slots buy
zero for one player.**

**EU and US regions.** Measured: 186 ms and 251 ms p50 from India, i.e. 56 ms and 122 ms
*worse* than today. Only relevant if the player base moves.

**A Cloudflare-edge side channel for remote inputs.** Cloudflare's edge measures 42.0 p50 /
29.4 min from here versus 96–130 ms to any ER, so a Durable Object relaying other players'
inputs would deliver them ~50–90 ms ahead of the chain, enough to predict remote seats
instead of interpolating them. It is a legitimate technique (fast unreliable hint channel,
slow authoritative channel). But: it buys nothing for the local player, who is already
predicted; it helps only remote-seat staleness, which the panel does not measure; and it
introduces a second thing to reconcile against. **Right technique, wrong game, at least
until the boss fight is crowded.** Marked *inferred*, not recommended now.

---

## 6. Levers, ranked by expected milliseconds

Excludes the two levers earlier spikes already own (blockhash cache, −130 ms; direct ER
websocket, −32 to −40 ms). Those still rank above everything below.

### L1 — Re-pin the match to the TEE validator (`MTEWGuqx…3xzo`). **−34 ms p50. Measured.**

Paired interleaved A/B, n=80 HTTP round trips per arm: AS 129.8 vs TEE 95.8 p50, delta
+34.2 p50 / +44.1 p90, TEE faster on 98% of pairs. Independently on the notification socket,
n=60 per arm: 120.2 vs 95.0, delta +26.6 p50, 98% of pairs. Both validators run the same
build at the same 50 ms block time with `baseFee: 0`, and `getRoutes` lists TEE as an
ordinary routing target.

Files: `packages/client/src/pda.ts:37` (`DEVNET_AS_IDENTITY`) and the worker's
`VALIDATOR_IDENTITY` env (`worker/src/routes.ts:157`), which flows into `init_arena`'s
`validator_identity` argument (`packages/client/src/instructions.ts:221`). `connectMatch`
resolves the fqdn from `getRoutes` by identity, so **nothing in `app/` changes** and no
frozen file is touched.

*Confidence:* **measured** for the round-trip delta; **inferred** for the end-to-end
transfer, on `execute.md`'s finding that write-to-visible equals the POST round trip. I did
not measure end-to-end on TEE because no HEARTROT arena is delegated there — that A/B needs
one match delegated to `MTEW…` and is the single thing worth doing before committing.

*Risk:* the TEE lane is a **Private Ephemeral Rollup running inside Intel TDX**, i.e. a
privacy product, not the general gaming lane. Capacity policy, rate limits and long-term
availability for an unrelated game are unknown and undocumented. TDX memory encryption costs
execution time, though observed execution is already 0 ms of wall clock so there is headroom.
Pinning is also permanent for a match's life, so a bad TEE day strands a match; the existing
tick watchdog (3 s resnapshot / 45 s settle) is the only backstop. **Do not ship this without
one live delegated-arena A/B.**

### L2 — Predict `shoot` locally. **0 ms on the panel; ~130–365 ms of felt latency. Inferred.**

The genuine "next technique", and the honest answer to the question the task asks. Today a
trigger pull has *zero* latency hiding: one round trip to see the bullet exist, plus up to
one 100 ms crank tick before it moves. Movement gets prediction; firing gets nothing.

Change: tag `Bullet._pad0` (offset 7, free byte inside a size-8 struct, layout unchanged)
with the owner seat in `programs/heartrot/src/handlers/shoot.rs`; decode it in
`packages/client/src/layout.ts`; spawn a provisional bullet in `app/src/net/predict.ts` on
send and retire it against the first arriving chain bullet carrying my seat. The same tag
gives `shoot` the uniqueness the blockhash cache needs.

*Confidence:* **measured** that the pad byte is free and that `shoot` carries no seq;
**inferred** for the size of the perceived win, because shoot latency has never been
instrumented (metrics.ts excludes it by construction). Instrument it first — the tag makes
that possible too.

*Risk:* a mispredicted bullet is a visible ghost. Cooldown is enforced on the tick clock
(`arena.tick > last_shot_tick + SHOT_COOLDOWN_TICKS`), which the client can mirror but can
race, so a refused shot must expire on a TTL exactly as `PENDING_TTL_MS` retires a refused
move. This changes what the game shows before the chain agrees, which is a different class
of risk from every other lever here.

### L3 — Self-host an ER colocated in India. **−77 ms vs today, −43 vs TEE. Documented + measured, but expensive.**

The literal Supersize answer. AWS `ap-south-1` (Mumbai) measures **52.2 ms p50 / 42.8 min**
TCP RTT from here, against 129.8 for `devnet-as` and 95.8 for TEE. The validator is public,
Dockerised (`magicblocklabs/validator`) and configurable (`VALIDATOR_MILLIS_PER_SLOT`).
Write-to-visible would land near 55–60 ms — inside MagicBlock's own "sub-50 ms when
co-located" claim, and the same order as Supersize's 30 ms.

*Confidence:* **measured** for the Mumbai round trip; **documented** for the validator being
self-hostable; **not verified** that the devnet delegation program will accept an arbitrary
self-hosted identity, that the router will route to it, or that settlement to base devnet
works from one. Those three unknowns are the whole risk and I did not test them.

*Risk:* days-to-weeks of ops for a devnet demo, a machine to fund and keep alive, and a
single point of failure with no MagicBlock SLA behind it. **Right answer for a product;
almost certainly the wrong answer for this run.** Named because it is what the industry
actually did, and because it sets the real floor: ~50 ms, not ~130.

### L4 — Fold the router's setup cost into the direct-ER lever. **−164 ms, once, at join.**

The existing direct-ER-websocket lever is scored at −32 to −40 ms on *pushed* notifications.
Measured here: a *request* over the router websocket costs **286.0 ms p50 vs 120.2 ms
direct — +164.4 ms**. A pushed frame pays one proxy hop; a subscribe pays a full extra proxy
round trip. That is a one-time cost at subscription setup, so it moves time-to-first-frame on
joining a match, not steady-state latency. No separate work — it comes free with the direct-ER
change already scoped in `app/src/net/subscribe.ts:163`.

*Confidence:* **measured**, n=60 interleaved per arm.

---

## Sources

- [MagicBlock — Unlocking Real-Time Onchain: A Guide to Ephemeral Rollups](https://www.magicblock.xyz/blog/a-guide-to-ephemeral-rollups)
- [MagicBlock — Supersize: a next-gen real-time PvP game on Solana](https://www.magicblock.xyz/blog/supersize/)
- [MagicBlock — The Ephemeral Rollup Effect](https://www.magicblock.xyz/blog/the-ephemeral-rollup-effect)
- [MagicBlock Documentation — Quickstart (endpoints, regional validator identities)](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart)
- [MagicBlock Documentation — Delegation, Commitment & Undelegation](https://docs.magicblock.gg/pages/ephemeral-rollups-ers/introduction/ephemeral-rollup)
- [magicblock-labs/magicblock-validator (self-hostable ephemeral validator, `VALIDATOR_MILLIS_PER_SLOT`)](https://github.com/magicblock-labs/magicblock-validator/)
- [magicblock-labs/ephemeral-rollups-sdk](https://github.com/magicblock-labs/ephemeral-rollups-sdk)
- [Solana Compass — MagicBlock project review (Supersize 250K matches, PERs on Intel TDX)](https://solanacompass.com/projects/magicblock)
- [Gabriel Gambetta — Fast-Paced Multiplayer, part 1: Client-Server Game Architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html)
- [Gabriel Gambetta — Fast-Paced Multiplayer, part 4: Lag Compensation](https://www.gabrielgambetta.com/lag-compensation.html)
- [Valve Developer Community — Source Multiplayer Networking](https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking)
- Live measurement, 2026-09-01, from India: `getRoutes` / `getIdentity` / `getVersion` on
  `https://devnet-router.magicblock.app/`; interleaved paired `getSlot` HTTP round trips
  (n=80/arm) and `slotSubscribe` websocket round trips (n=60/arm) against all four devnet ER
  endpoints; TCP connect RTT (n=12/host); ipinfo.io geolocation of `67.213.122.145` and
  `34.87.52.79`; AWS regional endpoint RTT for `ap-south-1` / `ap-southeast-1`.
- In-repo: `docs/perf/execute.md`, `docs/perf/notify.md`, `docs/perf/submit.md`,
  `docs/perf/clientside.md`, `programs/heartrot/src/state.rs:253`,
  `programs/heartrot/src/handlers/shoot.rs`, `app/src/net/predict.ts`,
  `app/src/net/metrics.ts`, `packages/client/src/connection.ts`, `packages/client/src/pda.ts`.
