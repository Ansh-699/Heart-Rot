# Geography and routing — is Singapore the right ER for a player in India?

Measured 2026-09-01 from the player's own machine (Ghaziabad, India). Scripts
`scripts/spike/perf_geo.mjs` (HTTP + TCP) and `scripts/spike/perf_geo_ws.mjs` (websocket).
Raw: `docs/perf/geo-a.json`, `geo-b.json`, `geo-c.json`, `geo-ws-a.json`.

## Headline

Singapore is the right *region*. HEARTROT is on the wrong *box*.

There are two ER validators in Singapore and they are 33 ms apart from India, because they
sit on two different networks. The game is pinned to the slower one.

| endpoint | country | AS / provider | TCP RTT p50 | getSlot RTT p50 |
|---|---|---|---|---|
| `devnet-tee.magicblock.app` | SGP | AS396982 **Google Cloud** (34.87.52.79) | **85.6 / 86.8 / 87.8** | **96.2 / 94.7 / 99.5** |
| `devnet-as.magicblock.app` *(ships today)* | SGP | AS396356 Latitude.sh (67.213.122.145) | 119.9 / 120.3 / 122.3 | 129.0 / 126.2 / 128.4 |
| `devnet-router.magicblock.app` | anycast | Cloudflare (104.20.16.25) | 182.4 / 183.1 / 185.4 | 304.5 / 296.3 / 299.7 |
| `devnet-eu.magicblock.app` | DEU | Latitude.sh, Frankfurt | 223.2 / 221.2 / 235.4 | 250.4 / 238.1 / 238.1 |
| `devnet-us.magicblock.app` | USA | Latitude.sh, New York | 498.8 / 490.8 / 490.4 † | 250.2 / 248.8 / 245.6 |

Three runs of 40 rounds, round-robin across every region within each round so a link wobble
hits all of them equally. † bare TCP connects to `devnet-us` are partly dropped/retransmitted
(min 225.8, so the honest figure for that host is its 250 ms application RTT).

**Paired, per round, `devnet-as` minus `devnet-tee`:**

| run | n | p50 | p90 | min | tee faster |
|---|---|---|---|---|---|
| a | 40 | +32.4 ms | +43.6 | +13.7 | **40 / 40** |
| b | 40 | +29.8 ms | +36.1 | +19.3 | **40 / 40** |
| c | 40 | +29.5 ms | +37.9 | +14.2 | **40 / 40** |

120 paired samples, zero exceptions. Bare-TCP paired delta is +34.6 / +33.5 / +34.4 ms, i.e.
the whole gap is transport, not server work: `getSlot − TCP` across the three runs is
9.1 / 5.9 / 6.1 ms on `devnet-as` and 10.6 / 7.9 / 11.7 ms on `devnet-tee` — the same order,
single-digit-to-low-teens, so the two nodes think at comparable speed and one of them is
simply 33 ms closer to India over Google's network than the other is over Latitude.sh's.

## Every MagicBlock devnet region

From the router's own `getRoutes` (primary source, not docs):

| identity | fqdn | country | blockTimeMs | baseFee |
|---|---|---|---|---|
| `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` | https://devnet-as.magicblock.app/ | SGP | 50 | 0 |
| `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo` | https://devnet-tee.magicblock.app/ | SGP | 50 | 0 |
| `MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e` | https://devnet-eu.magicblock.app/ | DEU | 50 | 0 |
| `MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd` | https://devnet-us.magicblock.app/ | USA | 50 | 0 |

That is the complete list. There is no India, no Mumbai, no Middle East ER on devnet or
mainnet. `https://status.magicblock.app/api/services` agrees (it names the TEE box
`devnet-tee-as.magicblock.app`, which resolves to the same 34.87.52.79). `getIdentity` on
each endpoint returned exactly the identity the router advertises — all four verified, so
none of these is a proxy in front of something else.

All four run the **same binary**: `magicblock-core 0.14.13`, `solana-core 4.0.0`,
`git-commit 8174cec`, `feature-set 3718597879`. The TEE node is not a different product
surface; it is the same validator inside an Intel TDX enclave.

## Websocket / slot cadence, per region

30 s of `slotSubscribe` on all five sockets at once (`geo-ws-a.json`), consecutive slots only:

| endpoint | WS open | subscribe ack | notifications | gap p50 | p95 | max |
|---|---|---|---|---|---|---|
| `devnet-tee` | **310 ms** | 405 ms | 632 | 50.0 | **54.0** | **68.4** |
| `devnet-as` | 422 ms | 542 ms | 630 | 50.0 | 55.6 | 81.0 |
| `devnet-eu` | 2019 ms | 2237 ms | 595 | 50.0 | 55.4 | 66.5 |
| `devnet-us` | 1143 ms | 1432 ms | 612 | 50.0 | 56.0 | 78.4 |
| `router` | 942 ms | 1238 ms | **0** | — | — | — |

The TEE box delivers the same 50 ms grid with a slightly *tighter* tail, and its handshake is
110 ms cheaper (a WS upgrade is ~3.5 RTT; 3.5 × 86 = 301 vs 3.5 × 120 = 420, which is what
the numbers say). Movement is gated on the ER slot, so a region with a worse grid would be
disqualified whatever its RTT — this one is not.

Incidental: the router emits no slot notifications at all.

## Can an arena be delegated to a chosen validator, and what does it cost?

Yes, and it costs **one environment variable**. The plumbing already exists end to end:

- `Arena.validator_identity` (`programs/heartrot/src/state.rs:327`) is written at init from
  instruction bytes `[10..42]` (`handlers/init.rs:461-462, 530`).
- `delegate` reads it back off the account and passes it straight through:
  `DelegateConfig { validator: Some(validator), .. }` (`handlers/delegation.rs:147, 195`).
  All three accounts go to that one validator by construction.
- The worker takes it from config, not from a constant:
  `validatorIdentity: address(env.VALIDATOR_IDENTITY)` (`worker/src/routes.ts:157`), set in
  `worker/wrangler.jsonc:69`.
- `connectMatch` resolves the endpoint *from the identity* via `getRoutes`
  (`packages/client/src/connection.ts:388-391`), and the resolved fqdn is what the worker
  hands the client as `erEndpoint` (`worker/src/routes.ts:548`). Nothing downstream is
  hardcoded. `ER_ENDPOINT` in `wrangler.jsonc` is dead config — `worker/src/index.ts:64`
  says nothing reads it, and grep agrees.

So the switch is: set `VALIDATOR_IDENTITY` to `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
and redeploy the worker. **No program change, no client change, no frozen file.**

What it does *not* do is move existing arenas. `validator_identity` is stamped at `init_arena`
and delegation reads it from the account, so every arena already on devnet-as stays there for
its whole life. The new value takes effect on the next arena the worker inits — which costs
what any new arena costs (rent for the three PDAs, 9,242,880 + 1,238,880 + 14,281,920 =
24,763,680 lamports ≈ 0.0248 SOL) and nothing extra for being in a different region. Base fee
on all four ERs is 0.

Evidence the TEE ER will actually serve this program, short of delegating to it:

- The HEARTROT program is **already cloned and executable on `devnet-tee`**:
  `getAccountInfo(JCfWB9…kzc5)` returns `executable: true`, `owner LoaderV411…`, `space
  112528` — byte-identical size and lamports to the copy on `devnet-as`.
- It is carrying real load, not idling: `getRecentPerformanceSamples` shows 8,405 / 8,431 /
  8,602 transactions per 60 s window (≈140 tx/s) against `devnet-as`'s 12,800 / 12,234 /
  12,229. Something is delegating to it and using it right now.
- MagicBlock's docs list it as a **public validator** alongside as/eu/us and state that the
  same integration patterns apply, with no special flow.
- Uptime over the 10 days the status API reports: `devnet-tee` zero incident-minutes on every
  service; `devnet-as` had 10 (ER) and 28 (pricing oracle) on 2026-08-31.

**What was NOT measured, and it matters.** No arena was actually delegated to the TEE
validator in this run. Two things are therefore unproven for *this* program: (1) that the TEE
node's account cloner accepts our three PDAs, and (2) that the **crank fires** there — if
`boss_tick` never gets scheduled, the boss never ticks and the game is dead, and no amount of
RTT saves that. The reason it was not run is cost: the treasury
(`FbDoanjAUonn5wM4KbRNS3jigHe6zDa4ThoEUKPnS7ka`) holds **35,182,257 lamports (0.0352 SOL)**,
the test arena costs 0.0248 SOL of it, there is no close/reclaim instruction in the program
(`programs/heartrot/src/handlers/` has no close handler), and `requestAirdrop` on
`api.devnet.solana.com` returned 429 "reached your airdrop limit today". Running it would
leave 0.010 SOL — not enough for the live app to init its next arena.

The verification is now one command. `scripts/spike/sp1_roundtrip.ts` was parameterised
(`SP1_VALIDATOR`, default unchanged at devnet-as) and does exactly the right things in order:
init → delegate → ER write → 25 write-to-visible samples → `start_match` → **10 s of crank
tick observation** → commit + undelegate.

```
SP1_VALIDATOR=MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo \
  node ./node_modules/.pnpm/node_modules/.bin/esbuild scripts/spike/sp1_roundtrip.ts \
    --bundle --platform=node --format=esm --outfile=/tmp/sp1.mjs && node /tmp/sp1.mjs
```

Fund the treasury with ~0.05 SOL from https://faucet.solana.com first.

## What the 33 ms is worth end to end

Prior work in this repo established that on a direct ER subscription, write-to-visible is
**one application round trip** — `docs/perf/execute.md`: send→visible p50 132/133/130 against
a `getSlot` RTT of 134/133/135 on the same connection, with the execute hop measuring 0 ms.
The region lever therefore scales by however many round trips a keypress still pays:

| configuration | ER round trips per keypress | expected p50 write-to-visible |
|---|---|---|
| today: fresh blockhash per send, router WS | 2 × devnet-as + router proxy | ~295 ms (the panel's number) |
| today, but on devnet-tee | 2 × devnet-tee + router proxy | ~235 ms (**−60 ms**) |
| blockhash cached + direct ER WS, devnet-as | 1 × devnet-as | ~128 ms |
| blockhash cached + direct ER WS, **devnet-tee** | 1 × devnet-tee | **~97 ms (−31 ms)** |

The saving is ~30 ms per remaining round trip, measured. It composes with the blockhash cache
and the direct-ER-websocket levers rather than overlapping them: those remove round trips,
this one makes each surviving round trip cheaper. Nothing here touches the router's own hop —
that is Cloudflare anycast and is removed by the direct-ER-WS lever, not by this one.

## Mainnet, for later

Same four regions, and the same finding is *sharper* there. TCP RTT p50, n=20 each:

| endpoint | IP | RTT p50 |
|---|---|---|
| `mainnet-tee.magicblock.app` | 35.198.244.170 (Google Cloud, SGP) | **87.4 ms** |
| `as.magicblock.app` | 177.54.154.123 | 215.9 ms |
| `eu.magicblock.app` | — | 225.9 ms |
| `us.magicblock.app` | — | 506.1 ms (min 224.5) |

Mainnet-as is 216 ms from India — nearly *twice* devnet-as. If HEARTROT ever ships to mainnet
from India, the TEE box is not a 30 ms improvement there, it is a 128 ms one.

## Closed questions

- **Is there a closer region than Singapore?** No. Four devnet regions exist, two are in
  Singapore, the others are Frankfurt and New York at 238–250 ms application RTT. There is no
  Indian ER on devnet or mainnet. The question of *region* is closed; the question of *which
  Singapore host* was the live one.
- **Is the 196 ms India→devnet-as ICMP figure in `docs/spikes/sp-load.md` right?** No, and
  this is the third instrument to say so. Bare TCP handshake to devnet-as is 120 ms p50
  (min 110), application `getSlot` is 128 ms p50, over 120 samples across three runs.
- **Does the router help?** Not on latency. Its own `getSlot` costs 300 ms p50 — more than
  double a direct ER call — and it emits no slot notifications. It is a routing-metadata
  service, which is what `packages/client/src/connection.ts` already says it is.

## Sources

- MagicBlock status API — https://status.magicblock.app/api/services (region and server list,
  10-day uptime)
- Magic Router `getRoutes` — `https://devnet-router.magicblock.app/` (authoritative identity ↔
  fqdn ↔ countryCode ↔ blockTimeMs ↔ baseFee table)
- MagicBlock docs, ER quickstart — https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart
  (devnet/mainnet endpoint tables, TEE listed as a public validator, "add the specific ER
  validator in your delegation instruction")
- `getVersion` / `getIdentity` / `getRecentPerformanceSamples` / `getAccountInfo` on all four
  devnet ERs, run live
- ipinfo.io for AS and city of each endpoint IP
- In-repo: `programs/heartrot/src/handlers/delegation.rs`, `handlers/init.rs`,
  `packages/client/src/connection.ts`, `worker/src/routes.ts`, `worker/wrangler.jsonc`,
  `docs/perf/execute.md`, `docs/perf/notify.md`, `docs/perf/submit.md`
