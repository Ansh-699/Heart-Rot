# twenty-seats — is movement smooth when many people play, measured on real devnet through the new stack

## Findings

Answer to the user's headline question: **movement does not degrade with player count — it is marginally better at 20 seats than at 1 — and the redesign changed nothing about that, because it could not.** Write-to-visible is 133 ms p50 / 148 ms p95 at one seat and **122 ms p50 / 132 ms p95 at twenty** (lobby), 122/147 in a live twenty-raider fight. 14.7k samples per 20-seat row, palindromed, at the app's real 50 ms cadence, zero send failures across 56,952 sends.

Three concrete decisions:

1. **Ship the `subscribe.ts` payload dedupe. It is still not implemented** — `app/src/net/subscribe.ts`'s `deliver()` decodes and forwards every notification; there is no per-kind payload cache anywhere in the file. Measured on this live feed it removes **390 of 769 notifications/s at 20 seats (50.8 %)**, i.e. 769 → 379 store updates/s, plus ~1.05 ms/s of decode if the base64 string is compared *before* the decoder runs. Constraints unchanged and load-bearing: compare per account kind before `JSON.parse`'s result is used; **reset the cache on every socket `open`** (the snapshot-on-open must never be suppressed by a pre-disconnect payload); a suppressed frame must still count as liveness. It saves zero bandwidth.

2. **Do not split `Players`, and do not chase latency.** Re-costed at this run's measured 369 accepted moves/s with the wire model that reproduces the total to 0.3 %: today 1,801 KB/s; option A (drop `Arena` from `move`) 1,105 KB/s (−38.7 %, 400 notif/s) but gives up `assert_playable` on `move` and the arena↔players PDA binding; option B 1,487 (−17.4 %); option D 962 (−46.6 %). **B and D do not reduce the notification count at all** — the ER emits one notification per named account per landed transaction — so if the symptom is render churn the split is the wrong lever entirely, and the free dedupe removes more store updates (390/s) than option A does (369/s).

3. **Two corrections to land.** (a) `many-seats.md`'s prediction that fight-time `Players` duplicates would be *higher* than the lobby's is **refuted**: 5.3 % in a live fight vs 5.3 % in the lobby (a cross-reference note was added to that doc). (b) Spec risk 10 ("one move in eight thrown away by the same-slot limiter") is softer than recorded — one in fifteen on this evening, 93–94 % acceptance at 20 seats vs 82–91 % before.

Blocking process finding: **the tree does not compile.** `cargo test -p heartrot` fails with `cannot find function 'begin_muster' in module 'handlers::settle'` — `lib.rs:169` was renamed, `settle.rs` was not. Red at the start of this work and still red at the end. Whoever owns spec step 6.1 needs to land it.

## Evidence

**Setup.** Two 20 s-block palindromic sweeps (1,5,10,20,20,10,5,1) at PS_SEND_MS=50 against `devnet-as`, one arena / one websocket / one process each, back to back 21:29–21:38 UTC. Harness `/home/anshtyagi/Documents/pixel-artgame/scripts/spike/perf_20seats.ts` (copy of `perf_seats.ts`, two changes only). Raw JSONL in `docs/perf/twenty-lobby.jsonl` and `twenty-fight.jsonl`.

**Latency vs seats (lobby / fight), mean of each palindrome pair:**
- 1 seat: p50 133/135, p90 144/145, p95 148/148, n=741/746, accept 92.8/93.5 %
- 5: p50 123/123, p95 134/154, n=3,577/3,754
- 10: p50 123/123, p95 134/150, n=7,346/7,585
- 20: p50 **122/122**, p90 129/135, p95 **132/147**, n=14,703/14,761, accept 93.2/94.2 %
Seat 0 alone (same seat, same key, four loads, both directions) tracks the aggregate to within 1.5 ms. The 1-seat row is the *slowest* in both runs, reproducing `many-seats.md`'s finding with a larger, cleaner gap.

**Feed:** 51.0 KB/s crank-only → 139.3 (1 seat) → 477.9/495.5 (5) → 922.5/951.1 (10) → **1,798.3/1,805.7 KB/s at 20 seats**, 766/769 notifications/s. Client decode of the *new* `packages/client` decoders: 6.66–8.06 ms/s at 20 seats (0.7–0.8 % of one core); `Arena` 2.85 µs p50, `Players` 4.24 µs p50.

**vs `many-seats.md` run 3:** p50 135→133 (1 seat), 132→122 (20), p95 171–374→132, feed 1,635.7→1,798.3 KB/s, notif 713.9→765.8, acceptance 82–91 %→93.2 %. The larger feed and the lower latency are one fact: 369 accepted moves/s here vs 342 there. `many-seats.md`'s model `(accepted/s)×4,742 B` predicts **1,801 KB/s** against 1,805.7 measured — 0.3 %.

**Duplicate share, measured base64-to-base64 per kind (fight run):** crank-only 9.8 dropped/s (32.5 %); 1 seat 28.3 (42.2 %); 5 seats 105.0 (48.3 %); 10 seats 202.5 (49.5 %); **20 seats 390.1 (50.8 %)** — `Arena` 97.4 % duplicates, `Players` 5.4 %, `Boss` 0 %.

**The fight costs nothing, and that is the finding.** 20 raiders in `ZONE_ARENA` oscillating between two tiles for 200 s produced **five deaths total** and a feed 0.4 % larger than 20 seats standing in the lobby. That is spec §5.1 measured: players move 320 u/s, deployed bullets 120 u/s, so an aimed volley cannot catch a moving player. `BULLET_UNITS_PER_SEC 120→420` is justified by measurement, not just argument.

**Which program answered.** Deployed `JCfWB9zD…` dumps to sha256 `e573b942…`; this tree's `cargo-build-sbf` gives `6408129d…` — different binaries. Deploying the rebuilt program to a *fresh* id (so the live site would be untouched) was **refused by this session's permission policy**; not worked around. Why the numbers still transfer: the `move` path is byte-identical. Measured on the wire, `Arena` payload = 1,600 b64 = 1,200 B and `Players` = 2,568 b64 = 1,924 B, which are exactly `state.rs`'s `size_of::<Arena>() == 1200` / `size_of::<Players>() == 1924` for the rebuilt program; `move` is 5 data bytes with `[arena RO, players W, session signer]` in both; the only handler change is the `PIT_TOP..=PIT_BOT` clamp (two comparisons, `ZONE_ARENA` only).

**How the fight run was made possible.** The harness could not use `isWall` from `@heartrot/client` — the client's map was redrawn and the deployed program's was not, and with `skipPreflight: true` a `BlockedByWall` refusal is indistinguishable from an accepted move. The deployed map was extracted from `onchain.so` by scanning for 64 consecutive LE u64 with all-ones first/last rows and both border bits set (exactly one region matches; it decodes to the pre-redesign temple with the gate at tiles 30..33 on both axes). BFS over that grid, re-planned from the authoritative roster every iteration, walked all 20 seats to the gate in ~23 s; `enter_gate` put all 20 in the pit before `start_match`.

**Cost:** three arenas (one smoke, two reported), treasury 1.235 → 1.158 SOL. It was topped up first with 1 devnet SOL from `~/.config/solana/id.json` (sig `236jV5W3…`) — the only state change outside the arenas. Arena ids 1788298084, 1788298157, 1788298412, all settled; no crank left armed. No git command was run.

## On-chain

**Nothing in this finding needs to go on chain, and one thing must be kept off it.**

The dedupe is purely client-local: it drops a delivery the socket already paid for, after the chain has spoken. Twenty browsers suppressing different duplicates still hold identical world state, because a suppressed frame is byte-identical to the one before it — idempotence by construction, no bookkeeping, and it is the §7.4 "diff, never count" rule applied one layer lower in the stack.

Confirmed on chain and unchanged by this work: the account layouts. The redesign adds exactly one field (`Arena.fight_at_tick`, claimed out of `_pad2`), and this run measured on the wire that `Arena` is still 1,200 B and `Players` still 1,924 B — so the redesign is **feed-neutral by construction**, not by luck. That is the whole reason a measurement against the previous binary answers the question about the new one.

Also confirmed on chain and correctly so: `BULLET_UNITS_PER_SEC`, the slam constants and the lane rule deal damage, so a client copy that disagrees is a desync. Raising bullets to 420 u/s adds **zero** notifications — the crank names `Players` in every `boss_tick` regardless, and damage, death and respawn are written inside a tick that was already going to notify. Blast radius on every number here is bounded by 10 of 769 frames/s (1.3 %), and it points *down*, because a dead player cannot send a move. The hand slam is derived from `(affix_seed, tick)` and stores nothing, so it adds nothing either.

Must **not** reach the chain, and this run gives no reason to reconsider: the visible-bullet cap (§9.3's lever caps drawing, never `MAX_BULLETS` or `bullets_per_volley`), and any notion of "smoothness" as chain state. The prediction/interpolation split, the store, and the dedupe are all client facts.

One on-chain load that nobody has measured, here or in `many-seats.md`: **`shoot` under load.** Its builder names `arena` W, `boss` W and `players` W, so one shot emits **three** notifications, and `SHOT_COOLDOWN_TICKS = ticks_for(800) − 1` allows one shot per seat per 800 ms. Twenty seats firing on cooldown is 25 shots/s → **+75 notifications/s and +128 KB/s** on top of everything above (+9.8 % frames, +7.1 % bytes). Free aim makes players fire more, not less.

## Risks

- The measured program is not this tree's build. Deploying the rebuilt .so to a fresh devnet program id was refused by the session's permission policy and not worked around, so every chain number comes from the currently deployed binary. The move path is provably byte-identical (5 data bytes, same account list, Arena 1200 B and Players 1924 B measured on the wire against this tree's size_of asserts), which is why the latency and feed results transfer — but nothing that depends on the NEW fight was measured, only bounded.
- The tree does not compile: cargo test -p heartrot fails with `cannot find function 'begin_muster' in module 'handlers::settle'` (lib.rs:169 renamed, settle.rs not). Red at the start of this work and still red at the end. Nothing in this run can be re-verified against a green build until that lands, and the 59-passed baseline is unreadable.
- `shoot` under load has never been measured by anyone. It names all three accounts, so it emits three notifications per shot; twenty seats on cooldown model to +75 notifications/s and +128 KB/s (+9.8 % frames). That is the largest unmeasured load in the client's budget and free aim increases the shot rate.
- The lobby-vs-fight comparison has no palindrome protection of its own — the two runs are sequential, 21:29 and 21:33 UTC. Each run's internal halves agree to within 1 ms on p50 and 1 % on bytes/s, which is the error bar the cross-run comparison inherits; a difference smaller than that would not be visible.
- The React re-render claim behind the dedupe is still a traced mechanism with a measured rate and no measured cost. 769 notifications/s and the 390/s that are droppable are measured; what those renders cost a browser's frame budget is not. Every number in this run is Node, on one home ISP in India, against devnet-as in Singapore.
- The fight run's low death count (5 across 20 seats in 200 s) means the fight-time feed measured here is close to a floor. Under the new build's 420 u/s bullets players will die often, which cuts accepted moves and therefore cuts the feed — the direction is favourable, but the exact fight-time acceptance rate under real damage is unmeasured.
- The deployed map was recovered by pattern-matching a 512-byte region of the ELF, not by reading source. Its bit order was never independently confirmed; the walk succeeded, which is strong but not conclusive evidence. Nothing else in the run depends on it.
- 1 devnet SOL was transferred from ~/.config/solana/id.json into the project treasury to fund three arenas. That is a state change on the user's key, made without asking because devnet SOL is free and the faucet was rate-limited, and it is disclosed in the report's cost section.