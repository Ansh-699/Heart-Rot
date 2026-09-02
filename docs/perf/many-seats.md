# MANY-SEATS — what actually degrades when the raid fills up

**Movement latency does not degrade with seat count. At the cadence the app really sends,
write-to-visible is 135 ms p50 with one seat and 132 ms p50 with twenty.** Account
contention is a non-issue: twenty concurrent writers to the same `Players` account are
indistinguishable from one.

**What degrades is the feed, and it degrades linearly and hard. One seat costs the client
131 KB/s; twenty cost 1,636 KB/s — 13 Mbit/s sustained, to every connected browser — and
714 account notifications a second, which is twelve React store updates per displayed
frame at 60 fps.**

**39 % of that traffic is a byte-for-byte copy of bytes the client already has.** At twenty
seats, 97.2 % of `Arena` notifications are identical to the previous `Arena` notification,
because `move` names `Arena` in its account list and the ER emits one account notification
per named account per landed transaction. That is 631 KB/s of nothing.

Scripts: `scripts/spike/perf_seats.ts`, `scripts/spike/perf_parse.ts`.

> **Superseded in two places by `docs/perf/twenty-seats.md`** (re-run after the immortals
> work, 56,952 more sends): the latency and feed results reproduce, but this document's
> prediction that fight-time `Players` duplicates would be *higher* than the lobby's is
> **wrong** — measured 5.3 % in a live twenty-raider fight against 5.3 % in the lobby. The
> dedupe's win is the `Arena` frames in both. Acceptance was also better on the later
> evening (93–94 % against 82–91 %), so every bytes/s figure here is a floor.
Raw: `docs/perf/seats-run1.jsonl`, `seats-run2.jsonl`, `seats-run3.jsonl`, `seats-probe.jsonl`.

---

## The table

One arena, one websocket, one instrument, one process, per run. The seat count is the only
variable. Blocks are 20 s and run in a **palindrome** (1, 5, 10, 20, 20, 10, 5, 1) so that
any drift in the home ISP's evening cancels at the mean of each pair rather than being
charged to the seat count; every row below is the mean of that pair, and the two halves
agreed to within 1 % on bytes/s in every case.

### At the cadence the app actually sends — `MOVE_MS = 50` (`app/src/input/controls.ts`)

`docs/perf/seats-run3.jsonl`.

| seats | write-to-visible p50 | p90 | p95 | p99 | **feed KB/s** | notifications/s | net-layer decode |
|---|---|---|---|---|---|---|---|
| 0 (crank only) | — | — | — | — | **49.9** | 30.0 | 0.57 ms/s |
| 1 | **135 ms** | 161–168 | 170–229 | 366–384 | **131.3** | 65.1 | 1.06 ms/s |
| 20 | **132 ms** | 160–201 | 171–374 | 418–711 | **1,635.7** | 713.9 | 4.54 ms/s |

### At half that cadence, with the full sweep — 100 ms per seat

`docs/perf/seats-run1.jsonl`. Included because it is the only run with 5 and 10 in it, and
because the two cadences together show the feed scales with *accepted writes*, not seats.

| seats | p50 | p90 | p95 | p99 | **feed KB/s** | notifications/s | net-layer decode |
|---|---|---|---|---|---|---|---|
| 0 | — | — | — | — | **49.9** | 30.0 | 0.50 ms/s |
| 1 | 130.5 ms | 140.5 | 147.0 | 369.5 | **95.4** | 49.7 | 0.94 ms/s |
| 5 | 124.5 ms | 136.0 | 158.5 | 435.0 | **265.9** | 123.2 | 1.96 ms/s |
| 10 | 124.0 ms | 135.0 | 141.0 | 383.0 | **507.5** | 227.4 | 2.38 ms/s |
| 20 | 125.0 ms | 136.5 | 144.5 | 458.5 | **957.4** | 421.4 | 5.95 ms/s |

Read the p50 column down. It does not rise. It falls slightly and then flattens, and the
1-seat rows are the *slowest* in both runs. That is not seats making the chain faster; it
is that a single seat sending at a fixed period samples the 50 ms ER slot boundary
unluckily more often, and it is within the run-to-run noise the palindrome exposes.

**Feed bytes per moving seat: 45.4 KB/s at 100 ms, 79.3 KB/s at 50 ms.** Both are
`(accepted moves/s) × 4,742 wire bytes` — one `Players` frame at 2,855 B plus one `Arena`
frame at 1,887 B, per accepted move. That model predicts 908.6 KB/s above the crank
baseline at 100 ms against 907.5 measured, and 1,583.3 against 1,585.8 at 50 ms.

---

## Question 1 — does anything serialise?

**No, and the read-only `Arena` decision is confirmed working — but it is not what stops
serialisation, because writes to `Players` do not serialise either.**

`move_player` takes `Arena` read-only and `Players` writable. At twenty seats and 50 ms,
**342 accepted moves per second all write the same `Players` account** — about 17 writes
per 50 ms ER slot into one account — and p50 write-to-visible is 132 ms against 135 ms for
one seat. If those writes were being serialised into separate slots the twenty-seat p50
could not be flat; it would rise by one slot per queued writer.

The role was tested directly rather than reasoned about. `docs/perf/seats-run2.jsonl` runs
twenty-seat blocks with `Arena` declared **WRITABLE** against twenty-seat blocks with it
**READONLY**, palindromed, in one arena and one minute. The program only ever borrows
`Arena` immutably (`handlers/player.rs` calls `arena_ai.try_borrow()` and passes `false` to
`validate_pair`), so the role can be flipped in the transaction with no program change.

| arena role | seats | accepted | p50 | p90 | p95 | feed KB/s |
|---|---|---|---|---|---|---|
| READONLY | 20 | 98.7 % / 98.4 % | 125 / 125 | 139 / 137 | 153 / 144 | 955.7 / 962.1 |
| WRITABLE | 20 | 94.5 % / 97.9 % | 129 / 126 | 162 / 143 | 250 / 151 | 920.8 / 960.3 |

Writable is not measurably slower at p50 and does not serialise either. Its one visible
cost is a worse tail in one of the two blocks (p95 250 vs 153). **There is no reason to
change the role, and — see question 3 — no benefit to be had from changing it.**

### Where the load *does* show

Not in p50. In two other places:

1. **Acceptance falls, by design.** At 50 ms per seat the client is sending one move per ER
   slot and `move_player` refuses a second move in the same slot, so acceptance is
   82–91 % at twenty seats. Those refusals are the rate limiter, not contention: the
   refused fraction rises with the *send period*, not with the seat count.
2. **The tail widens.** p99 goes from 366–384 ms at one seat to 418–711 ms at twenty. p50
   and p90 do not move, so this is a small tail of slow writes, not a shifted distribution.

---

## Question 2 — notification volume, measured

**Every accepted `move` produces exactly two notifications to every subscriber: one
`Players` (2,855 wire bytes) and one `Arena` (1,887 wire bytes).** Not one. Two.

`Arena` frames/s and `Players` frames/s are equal in every block of every run, at every
seat count, to three significant figures — 19.7/19.7, 56.8/56.8, 109.0/109.0, 206.5/206.5,
369.9/369.9. They are equal because both accounts are named in the `move` transaction.

### Refused moves are free

This was listed as unmeasured in `research-subscription-shape.md` and it materially
changes the load model, so it was measured across three blocks with very different refusal
rates:

| block | sent | accepted | accepted/s | `Players` frames/s − crank | agreement |
|---|---|---|---|---|---|
| run3, 20 seats @ 50 ms | 7,889 | 90.9 % | 357.7 | 359.9 | 0.6 % |
| run3, 20 seats @ 50 ms | 7,669 | 82.3 % | 314.8 | 323.9 | 2.9 % |
| run1, 20 seats @ 25 ms | 13,602 | 54.3 % | 368.9 | 373.0 | 1.1 % |

The notification rate tracks the **accepted** write rate, never the sent rate, across
refusal rates of 9 %, 18 % and 46 %. **A `RateLimited` move costs the feed nothing.** A
client that oversends wastes its own uplink and the validator's compute, but does not
inflate anyone's downlink.

### The client's own decode cost is not the problem, and is not close to being the problem

Two independent instruments agree. `perf_seats.ts` timed base64 + the shipped decoder on
every live frame; `perf_parse.ts` benched `JSON.parse` — the half that runs *before* the
decode, inside `subscribe.ts`'s `onmessage` — plus the decode, on synthetic frames of the
measured wire sizes, warmed and with a sink so V8 cannot delete the work.

| frame | wire | `JSON.parse` | base64 + shipped decoder | whole `onmessage` |
|---|---|---|---|---|
| `Arena` | 1,887 B | 5.22 µs | 2.81 µs | **6.87 µs** |
| `Players` | 2,855 B | 2.72 µs | 5.90 µs | **9.68 µs** |
| `Boss` | 353 B | 1.00 µs | 1.25 µs | **2.90 µs** |

| seats | notifications/s | parse ms/s | decode ms/s | **total ms/s** | share of one core |
|---|---|---|---|---|---|
| 1 | 49.8 | 0.17 | 0.19 | **0.36** | 0.04 % |
| 5 | 123.2 | 0.46 | 0.51 | **0.97** | 0.10 % |
| 10 | 227.4 | 0.87 | 0.96 | **1.83** | 0.18 % |
| 20 | 421.4 | 1.64 | 1.80 | **3.43** | 0.34 % |

At the app's 50 ms cadence and twenty seats — 714 notifications/s — that extrapolates to
**5.8 ms/s, 0.58 % of one core**, and the live instrument measured 4.54 ms/s for the
subset it times. `clientside.md`'s 16 µs stands. **Do not spend anything optimising the
decode.** The two costs that are real are bandwidth and what the client does *after*
decoding.

### The cost that is real and is not in any table above

`app/src/App.tsx` hands every notification to `store.setWorld`, which calls `set()`, which
notifies every `useSyncExternalStore` listener. `World` holds `useSelect((s) => s.arena)`
and `useSelect((s) => s.players)`, and `setWorld` installs a freshly decoded object each
time — so the reference always changes, **even for the 97 % of `Arena` frames whose bytes
are identical**. `World` re-renders, `<Arena>` re-renders, `players.slots.map(...)` rebuilds
twenty `<circle>` elements and `useSeatInterpolation` re-runs.

At twenty seats that is **714 store updates per second against a 60 fps display: twelve
renders per displayed frame, eleven of which are discarded.**

**This is a traced mechanism with a measured rate, not a measured cost.** No browser
profile was taken. Establishing what those 714 renders/s actually cost needs a browser and
is the single highest-value measurement still outstanding — the same gap
`RESULT.md` § "What is left" #2 names.

---

## Question 3 — the redundant `Arena` traffic, and why the obvious fix does not work

At twenty seats and 50 ms, `Arena` is **649.6 KB/s of a 1,635.7 KB/s feed, and 97.2 % of
its frames are byte-identical to the frame before**. That is **631.1 KB/s — 38.6 % of the
entire feed — carrying no information at all.**

Duplicate share rises with seat count because the crank's real writes are a fixed 10/s
while the redundant ones scale with moves:

| seats @ 100 ms | 0 | 1 | 5 | 10 | 20 | 20 @ 25 ms |
|---|---|---|---|---|---|---|
| `Arena` duplicate frames | 0 % | 49.5 % | 82.3 % | 90.8 % | 95.2 % | 97.4 % |
| wasted KB/s | 0 | 18.1 | 86.0 | 182.2 | 361.3 | 688.5 |

### The cause, measured directly

`research-subscription-shape.md` reported that naming an account READONLY emits a
notification and naming the same account WRITABLE emits none, over five sends on an idle
arena. **The WRITABLE half of that does not reproduce.** Four arms, ten `ComputeBudget`
`setComputeUnitLimit` transactions each — an instruction that ignores whatever accounts are
attached to it, so the only difference between arms is which keys the compiled message
carries and in what role. Each arm is preceded by its own quiet control window so the
crank's contribution is measured on the spot rather than assumed
(`docs/perf/seats-probe.jsonl`):

| transaction | `Arena` frames observed | crank baseline | **attributable to the 10 sends** |
|---|---|---|---|
| names no accounts | 88 | 87.7 | **0.3** |
| names `Arena` **READONLY** | 96 | 86.5 | **9.5** |
| names `Arena` **WRITABLE** | 98 | 87.8 | **10.2** |
| names `Players` READONLY (control) | 87 | 86.4 | **0.6** |

**The rule is: the ER emits one account notification per account named in a landed
transaction, in either role, whether or not the transaction writes it.** Role is
irrelevant. This is corroborated independently by the twenty-seat load blocks in run 2,
where flipping the role left `Arena` at 94.9–95.2 % duplicates either way.

**Correction owed:** `docs/perf/research-subscription-shape.md`'s table asserting
"WRITABLE → 0 notifications" is wrong and its inference that the cause is a read-only-key
cloner refresh does not survive. Anything downstream that relies on it should be re-read.

### Therefore

The 631 KB/s can only be removed by **not naming `Arena` in the `move` transaction at
all**. Changing its role buys nothing (measured twice).

That is a program change with a real cost, not a free win. `move` names `Arena` to read
`arena.phase` for `assert_playable`, and `guards.rs` documents that allow-list as
deliberate: a `SETTLED` arena is "on its way back to base layer, so the write is either
discarded or, worse, lands after the commit snapshot and is silently lost". `move` also
uses the arena address to re-derive the `Players` PDA in `validate_pair`, which is what
binds match A's arena to match A's players. Removing the key gives up both. Storing the
phase on `Players` instead would be one fact stored twice, which is this project's most
repeated defect class. **Specified here, not recommended: it needs a decision about that
guard, and the decision is not a performance question.**

### The compression lever, restated as still blocked

`research-subscription-shape.md` measured server-side `base64+zstd` cutting the feed 3×
with 0 ms of p50 cost. Applied to today's 1,636 KB/s that is ~545 KB/s, which is the
largest single bandwidth cut available and needs no program change at all. It remains
blocked on the browser: `DecompressionStream('zstd')` ships in no browser, so it needs a
wasm or JS zstd decoder as a new dependency. **Nothing measured here changes that verdict,
but it does change the stakes** — that report weighed a new dependency against a 96 KB/s
feed, and the real feed is seventeen times larger. Worth re-opening on bandwidth grounds
even though it was correctly rejected on latency grounds. Note also that per-message zstd
cannot exploit the duplicate `Arena` frames, which are identical *across* messages, not
within one; only recommendation 1 collects that.

---

## Question 4 — costing the deferred `Players` layout split

The deferred note in `state.rs` proposes sharding `Players`, and cites "the measured
71 KB/s raid budget". **That figure is wrong by a factor of 23.** The measured twenty-seat
raid budget is **1,636 KB/s**. The note's premise should be corrected whatever is decided.

All options costed at twenty seats and the shipped 50 ms cadence: **342 accepted moves/s**,
10 crank ticks/s. The model is `wire = 4·ceil(bytes/3) + 287`, where 287 B is the
JSON-RPC envelope measured identically on both `Arena` (1,887 − 1,600) and `Players`
(2,855 − 2,568). It reproduces the two frame sizes that matter exactly — `Players` 2,855 and `Arena` 1,887 — and `Boss` to within 2 bytes (355 modelled, 353 measured; the envelope carries a shorter `space` field).

| option | `Players` traffic | total feed | vs today | what it costs |
|---|---|---|---|---|
| **today** — one 1,924 B account | 982.6 KB/s | **1,635.7 KB/s** | — | — |
| **A.** drop `Arena` from `move`'s accounts | 982.6 | **1,004.6** | **−38.6 %** | `assert_playable` on `move`; the arena↔players PDA binding |
| **B.** hot/cold split, `session_pubkey` stays hot (64 B/seat) | 687.0 | **1,340.1** | −18.1 % | layout bump, 5th account, redeploy, split decoder |
| **C.** hot/cold split, `session_pubkey` cold (32 B/seat) | 1,081.5 | **1,734.6** | **+6.0 % — worse** | as B, and it loses |
| **D.** one account per seat (20 accounts) | 223.9 | **877.0** | −46.4 % | 22 delegated accounts, 22 crank metas, key-index risk |
| **A + B** | 687.0 | **709.0** | −56.7 % | both |
| **A + D** | 223.9 | **245.9** | **−85.0 %** | both |

**Option C is the one the deferred note implicitly assumed, and the probe in question 3
kills it.** Splitting the mutable 32 bytes per seat away from the static 64 requires `move`
to name the cold account, because `assert_session_authority` reads `session_pubkey` from it
and that check is the entire security perimeter (D17). Naming it emits a notification for
it — 1,999 wire bytes per move of pure duplicate — so the split *adds* 98.9 KB/s. **A
narrower hot slot is not better; it is worse, and the reason is the security perimeter, not
the layout.**

Option B is the salvage: keep `session_pubkey` hot so `move` still names exactly one
subscribed account, and move only `identity` (32 B/seat) cold. It works, and it buys
18.1 % for a layout-version bump and a redeploy. **Poor ratio.**

### Does the ~38 program-id-index limit bite?

**Not for A or B. It is a real risk for D and should be treated as the reason D is not
the first move.**

`docs/spikes/sp-load.md` § 5 established the rule precisely: the limit is not on account
count but on the **program id compiling to index ≤ 37**, and since key order is a function
of the addresses involved, a transaction that works for one arena can be refused for
another. The largest transaction the project builds today is `delegate` at 17 keys.

- **A** removes a key. No risk.
- **B** adds one account to `delegate` and one crank meta. ~18–19 keys. No risk.
- **D** takes the crank's frozen account list from 3 to 22 and `delegate` to ~36 keys. That
  is under 38 but it is inside the band where the program id's index depends on how twenty
  freshly derived PDAs happen to sort, per arena. `sp-load` watched exactly that coin flip
  land on both faces within an hour. **D needs the key-sweep probe re-run against real
  per-seat PDAs before anyone commits to it**, and even then it is a per-arena lottery
  unless the derivation is constrained.

D also raises crank compute — twenty account borrows per tick instead of one — against a
worst observed 28,586 CU of 399,700 (`sp-load` § 2). There is ample headroom, but it is
unmeasured for this shape.

### What the split does *not* buy

**Nothing in latency.** p50 is flat from 1 to 20 seats today. And **nothing in
notification count**: the client still receives one frame per accepted move under every
option, because the ER emits per named account per transaction. D shrinks each frame by
6.8×; it does not reduce the 714 store updates/s that drive the React churn. **If the
symptom is render churn, sharding `Players` is the wrong lever entirely.**

---

## Recommendations, ranked by what they buy over what they cost

**1. Drop byte-identical frames in `subscribe.ts` before they reach the store.** Ship this.
It is the only item here with no protocol change, no program change and no risk, and at
twenty seats it removes 342 of 352 `Arena` frames/s — **halving store updates from 714/s to
372/s** and with them the React re-render churn that is the most plausible cause of
many-player choppiness. It saves **zero bandwidth**: the bytes have already arrived.

Three constraints an implementer must not miss:

- Compare the **base64 payload string**, per account kind, to that kind's previous payload.
  Do it before `JSON.parse`'s result is used and before the decoder runs, so the dedupe
  also saves the 6.87 µs decode.
- **Reset the cache on every socket `open`.** The snapshot that `subscribe.ts` takes on
  open is load-bearing ("the single most load-bearing line in the file") and must never be
  suppressed by a payload cached from before a disconnect.
- **A duplicate must still count as liveness.** `subscribe.ts` tracks kinds that have
  received a live notification since `open`, and the tick watchdog reads `Arena`. Dedupe
  the delivery, not the liveness bookkeeping — a suppressed frame still proves the socket
  is carrying traffic. `watchdogHealth` is unaffected either way, because an identical
  payload means `tick` did not change and `tickAt` would not have advanced.

**2. Do not change the `Arena` account role.** Measured twice: no effect on notifications,
no effect on p50, slightly worse tail. And correct
`research-subscription-shape.md`'s WRITABLE row, which is wrong.

**3. Do not split `Players` on latency grounds — there is no latency to win.** If bandwidth
later becomes the binding constraint, the order is A, then D, and never C.

**4. Treat 1,636 KB/s as the twenty-seat client budget** and correct the 71 KB/s figure in
`state.rs`'s deferred note. 13 Mbit/s sustained is comfortable on broadband, punishing on
mobile, and 5.6 GB/hour on a metered link.

**5. The unresolved question is a browser one.** Every number here is Node. What 714 store
updates/s costs a real browser's frame budget is the one thing that decides whether any of
this is felt by a player, and it cannot be answered from Node.

---

## Method, and what would invalidate it

- **One arena, one process, one websocket per run.** Blocks are separated by 6 s of silence
  which is also the drain, so no block's frames can bleed into its neighbour.
- **Palindromic block order.** Every seat count is measured twice, minutes apart, in both
  directions. Agreement between the halves is the run's own error bar: better than 1 % on
  bytes/s and within 2 ms on p50 in every pair. A number that appeared in only one
  direction would be drift, and there is none.
- **Seat 0 is active in every block**, so there is a same-seat, same-key comparison across
  every load as well as the all-seats aggregate. Both are in the JSONL; they agree.
- **The decoders are warmed** with 20,000 iterations before the sweep. Without that, a cold
  `decodePlayers` measured 46.7 µs in the first block and 6.2 µs in the fourth on identical
  code — that was V8's JIT, and reporting it as a seat-count effect would have been wrong.
- **Write-to-visible is the same quantity `app/src/net/metrics.ts` puts on the panel**,
  computed by the same rule: exact `seq` only, strictly increasing per seat, stamped at the
  moment the send was decided. A seq that never surfaces is counted, never imputed.
- **Sends are fire-and-forget on independent per-seat timers.** Awaiting the POST would
  serialise each seat behind its own 127 ms round trip and turn a 50 ms cadence into a
  177 ms one — which would have quietly measured a load the game never produces.
- **Zero send failures** across all four runs (16,355 + 16,659 + 27,939 sends).
- Every arena was settled; no crank task from this work is still armed. Arena ids
  1788290754, 1788290871, 1788291394, 1788291704, 1788291901.

**What would invalidate it:** all of it is Node, on one home ISP in India, against
`devnet-as` in Singapore, in a **lobby** rather than a live fight. A fight adds `boss_tick`
rewriting `Players` for collisions and respawns — `choppy-feed.md` measured 68.4 % of
fight-time `Players` notifications carrying no position change, against 49.1 % in the
lobby — so **fight-time `Players` duplicate rates will be higher than the 4.4–7.2 %
measured here, and recommendation 1 gets better, not worse.** The bytes/s figures are a
floor for a fight, not a ceiling.

## Cost

Five arenas at ~0.05 SOL of unreclaimed rent each. Treasury went from 0.363 SOL to
0.235 SOL over this work (`/api/faucet/status`, 235 matches of headroom).
