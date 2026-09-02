# TWENTY-SEATS — the redesign re-measured, and one block nobody had run

**Movement does not get worse when the raid fills up. It gets very slightly better.
Write-to-visible is 133 ms p50 with one seat and 122 ms p50 with twenty, and the twenty-seat
p95 is 132 ms in the lobby and 147 ms in a live fight, against 148 ms at one seat. Fourteen thousand samples per row, palindromed,
on the app's real 50 ms cadence.**

**Running that sweep inside a real fight — twenty raiders through the gate, in
`ZONE_ARENA`, being shot at by a live boss for two hundred seconds — changes nothing.
122 ms p50 either way, 1,798 KB/s in the lobby against 1,806 KB/s in the fight.** That is
the block `many-seats.md` named in its own "what would invalidate it" and could not run.

**The redesign neither helped nor hurt, and it could not have: it adds zero bytes to any
account, so the feed is the same feed.** Measured on the wire — the `Arena` payload is
1,600 base64 characters (1,200 bytes) and `Players` is 2,568 (1,924 bytes), which are
exactly the sizes `state.rs`'s `size_of` assertions pin for the rebuilt program.

**The one thing that would have helped is not implemented.** `app/src/net/subscribe.ts`
has no payload dedupe: every one of the 768 notifications/s at twenty seats still reaches
`store.setWorld`. Measured here, dropping byte-identical payloads removes **390 of 768
frames/s — 50.8 %** of store updates, and the fight does not shrink that win.

Scripts: `scripts/spike/perf_20seats.ts`. Raw: `docs/perf/twenty-lobby.jsonl`,
`docs/perf/twenty-fight.jsonl`.

---

## 0. What was actually measured, and against which program

This has to come first, because one number in it decides how much of the rest transfers.

**The program answering these transactions is the one deployed at
`JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, and it is not this tree's build.**
`solana program dump` gives `e573b942…`; `cargo-build-sbf` on this tree gives `6408129d…`.
Deploying the rebuilt program — to a fresh id, so the live site would not have been touched
— was refused by this session's permission policy. It was not attempted any other way.

Two things follow, and they point in opposite directions, so both are stated:

**What still transfers, and why.** The `move` path is byte-identical between the deployed
build and this tree's:

| | deployed (measured on the wire) | this tree (`state.rs` const-assert) |
|---|---|---|
| `Arena` | 1,600 b64 = **1,200 B** | `size_of::<Arena>() == 1200` |
| `Players` | 2,568 b64 = **1,924 B** | `size_of::<Players>() == 1924` |
| `Boss` | 356 B wire | `size_of::<Boss>() == 50` |

`fight_at_tick` was claimed out of `_pad2`, so nothing grew. `move`'s instruction data is
5 bytes in both, and its account list is `[arena RO, players W, session signer]` in both.
The only change the redesign makes to the handler is the `PIT_TOP..=PIT_BOT` clamp — two
integer comparisons, on `ZONE_ARENA` seats only. **A latency and notification measurement
of the deployed `move` is a measurement of the new one.** Both frame sizes above were
predicted by `many-seats.md`'s wire model and reproduced to the byte.

**What does not transfer.** Anything that depends on the *new* fight: `BULLET_UNITS_PER_SEC`
420, the hand slam, `MUSTERING`, the redrawn map. §5 costs those from the measured feed
rather than claiming them measured.

**The tree does not currently compile.** `cargo test -p heartrot` fails with
`cannot find function 'begin_muster' in module 'handlers::settle'` — `lib.rs:169` has been
renamed and `settle.rs` has not. Checked at the start of this work and again at the end;
still red both times. The `.so` used to read the deployed map out (§1) was built from a
scratchpad copy with that one call renamed back, and that copy was never deployed and never
answered a transaction. **No number in this document comes from that binary.**

### The map problem, and how it was solved

`perf_seats.ts` picks each seat's walkable axis with `isWall` from `@heartrot/client`. The
client's map was redrawn by the immortals work; the deployed program's was not. Planning a
walk against the wrong map is silent: every send here is `skipPreflight: true`, so a
`BlockedByWall` refusal looks exactly like an accepted move from the sender's side, and the
seat just stops contributing samples.

So the map was read **out of the deployed binary**: scan `onchain.so` for 64 consecutive
little-endian `u64` whose first and last words are all ones and whose every row has both
border bits set. Exactly one region matches, and it decodes to a symmetric temple with the
gate at tiles 30..33 on both axes — which is what `player.rs`'s pre-redesign `GATE_*`
literals say. It is pasted into the harness as `DEPLOYED_GRID` and the walk is BFS over it,
re-planned from the authoritative roster every iteration so a refused step costs one
iteration rather than the walk.

---

## 1. The table

One arena, one websocket, one instrument, one process per run. Seat count is the only
variable. 20 s blocks, 6 s of silence between them, palindromic order
(1, 5, 10, 20, 20, 10, 5, 1) so any drift in the evening cancels at the mean of each pair.
Every row is the mean of its pair. `PS_SEND_MS = 50` — the cadence
`app/src/input/controls.ts` really sends at.

### Lobby — the match is `FIGHTING`, all twenty seats stand in `ZONE_LOBBY`

Identical in shape to `many-seats.md`'s run 3. `docs/perf/twenty-lobby.jsonl`.

| seats | samples | **p50** | p90 | p95 | p99 | accepted | **feed KB/s** | notifications/s | decode ms/s |
|---|---|---|---|---|---|---|---|---|---|
| 0 (crank only) | — | — | — | — | — | — | **51.0** | 30.0 | 0.50 |
| 1 | 741 | **133** | 144 | 148 | 176 | 92.8 % | **139.3** | 67.2 | 1.06 |
| 5 | 3,577 | **123** | 130 | 134 | 280 | 89.7 % | **477.9** | 209.8 | 2.67 |
| 10 | 7,346 | **123** | 130 | 134 | 278 | 92.2 % | **922.5** | 397.0 | 4.46 |
| 20 | 14,703 | **122** | 129 | 132 | 194 | 93.2 % | **1,798.3** | 765.8 | 8.06 |

### Fight — twenty raiders in `ZONE_ARENA`, boss ticking, for the whole sweep

`docs/perf/twenty-fight.jsonl`. Every seat walked to the gate, sent `enter_gate`, and was
inside the pit before `start_match`; `alive` read 19–20 at every block boundary.

| seats sending | samples | **p50** | p90 | p95 | p99 | accepted | **feed KB/s** | notifications/s | decode ms/s |
|---|---|---|---|---|---|---|---|---|---|
| 0 (crank only) | — | — | — | — | — | — | **51.0** | 30.0 | 0.49 |
| 1 | 746 | **135** | 145 | 148 | 274 | 93.5 % | **139.3** | 67.2 | 1.00 |
| 5 | 3,754 | **123** | 132 | 154 | 267 | 94.0 % | **495.5** | 217.2 | 2.76 |
| 10 | 7,585 | **123** | 137 | 150 | 170 | 95.2 % | **951.1** | 409.1 | 3.88 |
| 20 | 14,761 | **122** | 135 | 147 | 482 | 94.2 % | **1,805.7** | 769.0 | 6.66 |

Read the p50 column down in either table. It falls by 11 ms from one seat to twenty and
then flattens. Seat 0's own numbers — the same seat, the same session key, at four
different loads, minutes apart in both directions — track the aggregate to within 1.5 ms
everywhere, so this is not an averaging artefact.

**The one-seat row is the slowest, again.** `many-seats.md` saw it (135 vs 132) and read it
as a single sender sampling the 50 ms ER slot boundary unluckily more often. Two more runs
agree and the effect is larger and cleaner here (133–135 vs 122, with the palindrome halves
inside 1 ms). It is a real property of the slot clock, not noise: one sender at a fixed
period beats against the slot, twenty senders at random phases cover it.

**Nothing degrades except the feed.** 139 KB/s at one seat, 1,800 KB/s at twenty —
14.5 Mbit/s sustained to every browser, and 768 account notifications/s.

---

## 2. Did the redesign help, hurt, or do nothing?

**Nothing, and that is the correct answer, not a disappointing one.**

Against `many-seats.md` run 3, same cadence, same instrument, same route:

| | run 3 (before) | this run (lobby) | this run (fight) |
|---|---|---|---|
| p50, 1 seat | 135 ms | 133 ms | 135 ms |
| p50, 20 seats | 132 ms | **122 ms** | **122 ms** |
| p95, 20 seats | 171–374 ms | **132 ms** | 147 ms |
| feed, 20 seats | 1,635.7 KB/s | 1,798.3 | 1,805.7 |
| notifications/s, 20 seats | 713.9 | 765.8 | 769.0 |
| acceptance, 20 seats | 82–91 % | 93.2 % | 94.2 % |

The 10 ms and the tightened tail are **not** the redesign. They are the same effect as the
larger feed: acceptance rose from 82–91 % to 93–94 %, so 369 moves/s landed here against
342 in run 3, and the feed rose in exact proportion — `many-seats.md`'s model
`(accepted moves/s) × 4,742 wire bytes` predicts **1,801 KB/s** against 1,805.7 measured.
Higher acceptance and lower latency together are one fact: a less contended evening on the
same path. Nothing in the redesign touches the move handler's cost, and its account sizes
are provably unchanged (§0), so it **cannot** have moved these numbers in either direction.

Risk 10 in `11-immortals-spec.md` — "the client throws away roughly one move in eight to
the same-slot rate limiter" — is softer than it was recorded: one in fifteen on this
evening, and the refusals are free (`many-seats.md` question 2 measured that notification
rate tracks accepted, never sent).

---

## 3. The fight costs nothing, and that is a finding about the fight

Twenty raiders inside the pit for 200 s, boss volleying the whole time, produced **five
deaths across twenty seats** and a feed 0.4 % larger than twenty seats standing in the
lobby.

That is the deployed build behaving exactly as `11-immortals-spec.md` §5.1 says it does:
players move 320 u/s and bullets travel 120 u/s, so **a player walking in a straight line
cannot be hit by an aimed volley.** The harness's seats oscillate between two tiles
forever, which is the most hittable pattern a moving player can have, and they still
survived a full enrage window nearly untouched. `BULLET_UNITS_PER_SEC: 120 → 420` is
justified by this measurement, not just by the argument.

**And raising it does not cost the feed anything.** The crank names `Players` in every
`boss_tick`, so it emits its 10 `Players` notifications/s whether or not a bullet connects;
damage, death and respawn are all written inside a tick that was already going to notify.
The blast radius of 420 u/s on this document's numbers is bounded by **10 of 768 frames/s
— 1.3 %** — and it points *down*, because a dead player cannot send a move.

The same argument covers the rest of the redesign's fight: the hand slam stores nothing and
derives from published state (zero notifications), and `MUSTERING` is a phase in which
`shoot` is refused and `move` behaves identically.

### What is still unmeasured, and it is not small

**Nobody has ever measured `shoot` under load — not here, not in `many-seats.md`.** The
builder names `arena` W, `boss` W and `players` W, so **one shot emits three
notifications**, and `SHOT_COOLDOWN_TICKS = ticks_for(800) − 1` allows one shot per seat per
800 ms. Twenty seats firing on cooldown is 25 shots/s → **+75 notifications/s and
+128 KB/s** on top of everything above: +9.8 % frames, +7.1 % bytes. Modest, and worth
knowing rather than assuming. Free aim makes players fire *more*, not less.

---

## 4. What the unimplemented dedupe would buy, measured

`many-seats.md` recommendation 1 — drop byte-identical frames in `subscribe.ts` before they
reach the store — **is not implemented.** `app/src/net/subscribe.ts`'s `deliver()` decodes
and forwards every notification; there is no per-kind payload cache anywhere in the file.

Duplicate share, measured per account on the live feed (payload compared base64-to-base64,
per kind, against that kind's previous payload):

| block | `Arena` duplicates | `Players` duplicates | dropped frames/s | share of all frames |
|---|---|---|---|---|
| crank only | 0 % | 97.5–100 % | 9.8 | 32.5 % |
| 1 seat | 65.1 % | 34.5 % | 28.3 | 42.2 % |
| 5 seats | 90.3 % | 11.1 % | 105.0 | 48.3 % |
| 10 seats | 95.0 % | 6.8 % | 202.5 | 49.5 % |
| **20 seats** | **97.4 %** | **5.4 %** | **390.1** | **50.8 %** |

`Boss` never repeats a payload — 0 % duplicates in every block of both runs, which is what
a countdown like `attack_timer` moving on every crank tick looks like — so none of its
10 frames/s are droppable. The lobby and fight columns agree to within 0.4 % at
every seat count; the fight figures are shown.

At twenty seats that is **768 → 378 store updates/s**, which is `many-seats.md`'s predicted
halving, confirmed on a live feed rather than modelled. It also saves the decode of every
dropped frame if the comparison is done before the decoder runs: 369 `Arena` decodes/s at a
measured 2.85 µs p50 is 1.05 ms/s, about a seventh of the 6.7–8.1 ms/s the client spends
decoding at twenty seats. It saves **zero bandwidth** — the bytes have already arrived.

**The fight does not change the case, in either direction.** `many-seats.md` expected
fight-time duplicates to be *higher* than lobby, citing `choppy-feed.md`'s 68.4 % of
fight-time `Players` notifications carrying no position change. Measured: `Players`
duplicates are **5.3 % in the fight and 5.3 % in the lobby**. The two figures are not in
conflict — "no position change for the seat you are looking at" is a far weaker test than
"byte-identical whole account", and at twenty senders almost every `Players` frame carries
*somebody's* new `last_move_seq`. The dedupe's win is and always was the `Arena` frames,
and those are 97.4 % redundant in both.

The three constraints `many-seats.md` states for the implementation still hold and are
still the whole risk: compare the base64 string per kind before decoding; **reset the cache
on every socket `open`**, because the snapshot-on-open must never be suppressed by a
payload cached from before a disconnect; and let a suppressed frame still count as
liveness.

**Honest limit, unchanged:** what those 390 avoided React renders/s are worth is still a
traced mechanism with a measured rate and no measured cost. Every number in this document
is Node.

---

## 5. The `Players` layout split, re-costed against today's feed

Not implemented — correctly. Re-costed at this run's **369 accepted moves/s** and 10 crank
ticks/s, with `many-seats.md`'s wire model `4·ceil(bytes/3) + 287`, which reproduces the
measured total to 0.3 % (1,801.0 modelled against 1,805.7 measured):

| option | total feed | vs today | notifications/s | what it costs |
|---|---|---|---|---|
| **today** | **1,801 KB/s** | — | 769 | — |
| **A.** drop `Arena` from `move`'s accounts | **1,105** | **−38.7 %** | 400 | `assert_playable` on `move`; the arena↔players PDA binding |
| **B.** hot/cold split, `session_pubkey` hot | **1,487** | −17.4 % | 769 | layout bump, 5th account, redeploy, split decoder |
| **D.** one account per seat | **962** | **−46.6 %** | 769 | 22 delegated accounts, 22 crank metas, key-index lottery |

Nothing has changed in the verdict and one thing is worth restating with the new numbers:
**B and D do not reduce the notification count at all**, because the ER emits one
notification per named account per landed transaction. Only A does, and the free dedupe in
§4 removes more store updates (390/s) than A does (369/s) with no program change and no
guard to give up. **If the symptom is render churn, ship the dedupe; the split is the wrong
lever and A is a guard decision, not a performance one.**

---

## 6. Method

- **Harness:** `scripts/spike/perf_20seats.ts`, a copy of `perf_seats.ts` with two changes
  and nothing else: the map comes from `DEPLOYED_GRID` rather than `@heartrot/client`, and
  `PS_MODE=fight` walks every seat through the gate before arming the match. Product code
  was not modified.

  ```
  ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
    scripts/spike/perf_20seats.ts --bundle --platform=node --format=esm \
    --alias:@heartrot/client=./packages/client/src/index.ts \
    --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
    --outfile=/tmp/perf20.mjs
  PS_MODE=fight PS_SEND_MS=50 PS_BLOCK_MS=20000 PS_GAP_MS=6000 PS_QUIET_MS=20000 \
    PS_SWEEP=1,5,10,20,20,10,5,1 PS_SKIP_SPAM=1 node /tmp/perf20.mjs --out out.jsonl
  ```

  `--settle-only <arenaId>` cancels a crank an aborted run left armed. Both arenas here
  were settled; no task from this work is still ticking.
- **The decoders are the shipped ones**, bundled out of `packages/client` at this tree's
  state, and warmed with 20,000 iterations before the sweep. So the decode column *is* a
  new-build measurement even though the program is not.
- **Write-to-visible** is the quantity `app/src/net/metrics.ts` puts on the panel, by the
  same rule: exact `seq` only, strictly increasing per seat, stamped when the send was
  decided. A seq that never surfaces is counted as unaccepted, never imputed.
- **Sends are fire-and-forget** on independent per-seat timers. 28,513 + 28,439 sends,
  **zero transport failures**.
- **Both runs are back to back**, lobby then fight, 21:29–21:38 UTC. The lobby↔fight
  comparison therefore carries no palindrome protection of its own; each run's internal
  palindrome halves agree to within 1 ms on p50 and 1 % on bytes/s, which is the error bar
  either comparison inherits.
- **What would invalidate it:** all of it is Node, on one home ISP in India, against
  `devnet-as` in Singapore, against a program that is one commit behind this tree, with no
  `shoot` traffic. §0 bounds the first gap; §3 bounds the last.

## 7. Cost and side effects

Three arenas (one smoke, two reported) at ~0.026 SOL each: treasury went 1.235 → 1.158 SOL.
It started at 0.235 and was topped up with **1 devnet SOL transferred from
`~/.config/solana/id.json`** (`236jV5W3…`), which is the only state change this work made
outside its own arenas. Arena ids 1788298084, 1788298157, 1788298412 — all settled.

No git command was run at any point.
