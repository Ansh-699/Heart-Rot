# SP-LOAD — latency, compute and acceptance under twenty concurrent players

**Verdict: PASS.** Program `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, validator
`devnet-as`, ER `https://devnet-as.magicblock.app/`. Script
`scripts/spike/sp_load.ts`, driven entirely through `packages/client`.

Four runs on real devnet. Runs 1–3 each found a defect in the *instrument* and were
re-run; run 4 is the measurement. Every number below comes from run 4 unless the row says
otherwise.

| run | arena_id | arena | what it settled |
|---|---|---|---|
| 1 | 1788261687 | `9EL3pUDxxV8oGcYXnk6vEDLdYnShGiRq8qTPVUr2FzKv` | driver walked seats into walls; own sends misattributed to the crank |
| 2 | 1788262041 | `G5maLUNNq9gB1xxFBzMEtTs2KE7syKmgjgkHDYr8G5pF` | steering and signature ordering fixed; key probe contradicted run 1 |
| 3 | 1788262478 | `6sb9o3vVrS431G2nfvVYmnWZRJDcmLLGL59X43aDEg17` | monotonic seq, crank dedupe; crank stream still 2.25× the tick rate |
| 4 | 1788263134 | `GKt2zbWXJX3zFT89XxqbkmL5fvCzeByiEQvVxoFNNEcc` | **the measurement.** log filter scoped to the arena; 1.01 samples/tick |
| key sweep | — | none needed | the ~38-key ceiling, exactly |

Every arena was settled — `settle` on run 4 is
`5vRsXjum3iTQFqCTpkfyGLmfAXkMcQii6pFH7uF4WnGbUgeciwS9fB5RUsmrYhGiBFzvWgUiCnMZ1KG6D6qkJ1Bm`
at tick 546 — so no crank task from this spike is still armed.

## What was actually driven

20 seats claimed, walked from the lobby spawn to the gate (~39 s), `enter_gate`d, then
steered to a ring of six firing stations 120 units from the boss and driven
**concurrently** — one independent timer per seat per instruction kind, fire-and-forget,
never one-at-a-time.

- **PACED** — move every 400 ms, shoot every 800 ms. Exactly the in-program limiter's own
  cadence.
- **AGGRESSIVE** — move and shoot every 150 ms, i.e. 242 transactions/second sustained
  against one ER from one laptop.

The fight ran. Two parts destroyed (`wolf_l` 2875→0, `thorn0` 1150→0), a third at 30/1150,
three seats killed and respawned 6, 6 and 2 times, top seat at 3,755 damage dealt. The
vent did not open (shell at 12,835 of 20,700 — 62 % — at the end) and the core was never damaged, so
`OUTCOME_WIN` remains unobserved.

---

## 1. Write-to-visible, twenty players against one account

Same instrument as SP1: send, then poll `Players` until `last_move_seq` echoes the
sequence just sent. Three read loops instead of one, sampling every **126 ms p50**
(min 110, p95 161, max 461) — the instrument's own granularity, and the floor under every
number in this table.

| | SP1 baseline (1 player, serial) | PACED (20 players) | AGGRESSIVE (20 players) |
|---|---|---|---|
| p50 | 405 ms | **200 ms** | **192 ms** |
| p90 | — | 258 ms | 246 ms |
| p95 | 495 ms | 306 ms | 265 ms |
| p99 | — | 534 ms | 460 ms |
| max | 652 ms | 871 ms | 561 ms |
| n | 25 | 2,835 | 2,928 |

**It does not degrade. It improves.** Twenty concurrent writers to the same `Players`
account are *faster* at p50 than one serial writer was, and p95 is 40 % better.

Two reasons, and only the second is real:

1. SP1 polled with one loop and a fixed `sleep(10)` between reads; this polls with three
   loops and no sleep, so the visibility sample lands sooner. Part of the gap is
   instrument, not chain.
2. `move` takes `Arena` **read-only** — only `Players` is writable — so twenty movers do
   not serialise behind each other on the arena account. That decision (`instructions.ts`:
   *"keeping it read-only lets concurrent movers avoid serialising on it"*) is load-bearing
   and this measures it working.

Only the `exact` column is quoted: a sample counts only when the poller observed the exact
sequence number sent. The looser `all` variant resolves a row whenever it sees a *later*
sequence, which can only overstate.

**Two cheaper instruments**, both of which cover rejections as well as accepted writes:

| instrument | PACED move | AGGRESSIVE move | AGGRESSIVE shoot |
|---|---|---|---|
| send → `sendTransaction` returns | p50 128 / p95 237 / max 1,126 | p50 124 / p95 147 / max 471 | p50 124 / p95 145 / max 462 |
| send → the tx's own logs arrive | p50 133 / p95 251 / max 1,126 | p50 141 / p95 175 / max 508 | p50 143 / p95 174 / max 497 |

The validator executes a write ~140 ms after it is sent. Everything above that — the
200 ms to *see* it — is the read path, not the write path. **A client that reads state
back to confirm its own input has doubled its latency for nothing;** prediction plus the
`last_move_seq` echo for reconciliation is the whole design and this is the number that
justifies it.

---

## 2. Compute

### The crank, loaded

`consumed X of Y` read off the crank's own transaction logs. Ceiling is **399,700** as
reported by the validator, not 400,000 — the noop instruction in the crank transaction
takes the other 300.

| window | n | min | p50 | p90 | p95 | max | headroom |
|---|---|---|---|---|---|---|---|
| quiet (20 seats in arena, no input) | 103 | 6,884 | 12,941 | 23,305 | 23,390 | 23,705 | 94.1 % |
| PACED | 167 | 6,818 | 18,042 | 26,519 | 26,704 | **28,240** | **92.9 %** |
| AGGRESSIVE | 165 | 6,827 | 19,136 | 26,583 | 26,702 | **28,586** | **92.9 %** |

**Worst observed tick: 28,586 CU of 399,700 — 7.2 % of budget, 14× headroom.** SP2's
26,300 peak stands and rises slightly now that deaths, respawns and the outcome check run
inside `step`.

Sample counts are the check that this is really the crank: 165 samples over 66 s is
2.5/s, exactly the 400 ms `TICK_INTERVAL_MS`.

### The two hot player instructions

| instruction | accepted p50 | p95 | max | note |
|---|---|---|---|---|
| `move` | 1,933 | 1,936 | 1,936 | flat — the wall test and the seat write are the whole cost |
| `shoot` (PACED) | 3,551 | 5,358 | 6,714 | varies with how far the ray travels before it hits |
| `shoot` (AGGRESSIVE) | 3,551 | 4,752 | 6,147 | |

A rejected `move` costs 1,896–1,901 CU and a rejected `shoot` 3,425 — the guards are
reached before the work, so a spammer pays almost the same compute as a legitimate caller
and **zero lamports**. That is the whole argument for the tick counters.

---

## 3. Acceptance — is the rate limiter tuned for a person?

`getSignatureStatuses` on every signature sent, bucketed by error code. `Custom(7)` is
`RateLimited`, `Custom(8)` is `PlayerDead`, `Custom(14)` is `BlockedByWall`.

| phase | instruction | cadence | limiter | sent | accepted | `7` rate-limited | `8` dead | `14` wall |
|---|---|---|---|---|---|---|---|---|
| PACED | `move` | 400 ms | 400 ms | 3,000 | **95.4 %** | 81 (2.7 %) | 54 | 3 |
| PACED | `shoot` | 800 ms | 800 ms | 1,500 | **95.4 %** | 42 (2.8 %) | 27 | — |
| AGGRESSIVE | `move` | 150 ms | 400 ms | 7,993 | **36.8 %** | 4,900 (61 %) | 148 | 0 |
| AGGRESSIVE | `shoot` | 150 ms | 800 ms | 7,993 | **18.5 %** | 6,367 (80 %) | 151 | 0 |

The limiter behaves exactly as arithmetic predicts and not one point worse:

- move at 150 ms against a 400 ms limiter → theory 37.5 %, **measured 36.8 %**
- shoot at 150 ms against an 800 ms limiter → theory 18.75 %, **measured 18.5 %**

**Verdict on tuning: correct, and the client must not send at input rate.** A client
pacing itself at the tick clock gets through 95 % of the time, and the 2.7 % that do not
are ticks that drifted, not throttling. A client that sends on every input throws away
63 % of its moves and 81 % of its shots — the player would feel that as dropped input
even though the limiter is doing precisely its job. **The client owns the cadence**:
one move per 400 ms and one shot per 800 ms, clocked off `Arena.tick`, not off the
keyboard. Nothing on chain needs changing.

Sustained rate the game actually accepts, at 20 seats: **42.9 moves/s + 21.4 shots/s =
64 accepted writes per second** (PACED; AGGRESSIVE reached 44.5 + 22.3 = 66.8), on top of 2.5 crank ticks/s. Per seat that is 2.14 moves
and 1.07 shots a second, which is the design's cap and not a limit the ER imposed.

Nothing was dropped and nothing was silently deduplicated: `attempts` equalled ledger
`rows` in every window (4,500 and 15,986), and `noStatus` and `sendFailed` were 0 across
all 20,486 transactions of run 4.

---

## 4. The client's map predicts the chain's wall rejections

Every `move` sent was aimed at a destination `packages/client/src/map.ts` `isWall` called
floor. The chain disagreed **3 times in 3,000** (PACED) and **0 times in 7,993**
(AGGRESSIVE).

Those three are consistent with position staleness — the steering reads a position up to
126 ms old and a seat can have moved 16 units since — not with a divergence between the
generated Rust `WALLS` and the generated TS `MAP_GRID`. The single-source generation
holds.

This is also worth stating as a client requirement: **the client can and should predict
`BlockedByWall` locally.** Run 1 did not, and 73 % of its moves came back `Custom(14)`.

---

## 5. The ~38-key ceiling — settled, and it is not what anyone thought

SP1 built a 40-key transaction, saw it accepted, and could not read the result. This spike
saw **both** answers within an hour:

- run 1: 41 keys, **accepted**, reached `finalized`, failed with the program's own
  `Custom(14)` — it executed.
- run 3: 41 keys, **accepted**, `finalized`, `err: null` — it succeeded.
- run 2 and run 4: 41 keys, **rejected** —
  `transaction verification error: unsupported program id index 39; max supported is 37`.

Identical code. The only difference was the 36 randomly generated padding addresses, which
is the clue. `scripts/spike/sp_load.ts --key-sweep` controls for it: pad with addresses
that sort *after* the program id (keeping its index low) versus *before* it (pushing it to
the end), and read the program id's index out of the compiled message.

| padding | total keys | program id index | ER answer |
|---|---|---|---|
| sorts after | 34 → **44** | 1 | **accepted, every one** |
| sorts before | 34 | 33 | accepted |
| sorts before | 38 | 37 | accepted |
| sorts before | **39** | **38** | rejected: `unsupported program id index 38; max supported is 37` |
| sorts before | 40 → 44 | 39 → 43 | rejected, index quoted each time |

**The limit is not on the number of account keys. It is that every program id must compile
to index ≤ 37.** A 44-key transaction is fine if its program sorts early; a 39-key one is
refused if it sorts late. Since key order is a function of the addresses involved, a
transaction that works today can be refused tomorrow for a different arena PDA.

Corrections this forces:

- SP1's *"the ~38-key limit did not fire"* is right about what it saw and wrong about the
  conclusion. `03-risks-and-build-order.md`'s "provably fatal at every tick" is also wrong
  as stated: the failure is at *submission*, not at execution, and it is conditional.
- **The rule for the client is unchanged and now has a reason: keep every transaction at
  or under 38 account keys.** Above that, acceptance depends on address sort order, which
  is not something a client may rely on. The 4-fat-account design has ample margin — the
  largest transaction this spike built was 17 keys (`delegate`).

---

## 6. Defects found

**In the spike, all four fixed before the measurement run** — each one would have produced
a plausible, wrong number, which is the point of writing them down:

1. **Own transactions counted as crank ticks.** The row was registered in the ledger
   *after* `sendTransaction` returned, but the ER's log notification arrives at p50 141 ms
   against a POST that returns at p50 124 ms — so the log often arrived first, found no
   row, and was filed as somebody else's transaction. Run 1 reported a crank p50 of
   3,551 CU that was mostly `move` and `shoot`. Fix: sign, register, *then* post.
2. **`logsSubscribe` scoped to the program, not the arena.** A silent 60 s control window
   measured 150 ticks of this arena against **338** program `consumed` lines — 2.25 per
   tick, with nothing being sent. The surplus is other arenas of the same program ticking
   on the same validator, and the timestamps say what they were: the `sp-death` spike was
   running its own arenas concurrently (`docs/spikes/sp-death-run-b.jsonl` closes at
   11:37 UTC, `-a2` at 11:45, straddling this control window at 11:41). Scoping the
   subscription to the arena account brought it to **1.01 samples per tick**.

   Two consequences, and the second outlives this session. Any per-arena measurement on
   this validator has to filter on the arena, never the program. And a crank task runs its
   full 4,500 iterations unless `settle` cancels it — roughly half an hour of writes — so
   the same contamination arrives permanently from any arena nobody settled, which is what
   M5's stranded arenas are. That is a cost, not just untidiness.
3. **The move sequence restarted at 1 in the second phase** while the chain still held the
   first phase's last sequence, so the poller resolved fresh rows instantly and produced
   4 ms "write-to-visible" samples. Whatever measures a monotonic echo has to be monotonic.
4. **The driver walked seats into walls** and read 73 % `Custom(14)` as if it were an
   acceptance result.

**Confirmed working, not defects:** `confirmSignature`'s BigInt fix (M6) is what made the
key probe readable at all — the answer arrived as `err: 14` and
`unsupported program id index 39` where SP1 got `TypeError: Do not know how to serialize a
BigInt`. `createRpc`'s server-message rescue carried the verification sentence verbatim.
The ER rent top-up never fired: `init_arena` now funds for the ER's own rate.

**No program defect surfaced.** No transaction was lost, no signature was duplicated, no
error code was misrouted in 27,972 transactions.

---

## 7. The budget this sets for the client

| | number |
|---|---|
| plan prediction against | 140 ms to execute, 200 ms to read back |
| worst case to design for | 561 ms p99·max at 20 players |
| moves the client may send | 1 per 400 ms per player, clocked off `Arena.tick` |
| shots the client may send | 1 per 800 ms per player |
| expected acceptance at that cadence | 95 % |
| account keys per transaction | ≤ 38, hard |
| crank headroom at 20 loaded seats | 28,586 of 399,700 — 7.2 % used |

## 8. Open

- **`OUTCOME_WIN` has never happened on chain.** The shell was at 62 % after 126 s of
  20-seat fire; the vent needs 35 %. A win run needs either a longer window or seats that
  focus one part.
- **How many arenas of this program are still ticking on `devnet-as` is unknown.** The
  control window proves at least one other was live, and that one was a concurrent spike
  that settled itself. Whether any *abandoned* task is still running was not measured;
  enumerating the program's arenas and `commit_and_undelegate`ing the stranded ones would
  settle it, and M5 now has a cost attached rather than only an inconvenience.
- The 3-in-3,000 `BlockedByWall` residue is attributed to position staleness. Proving that
  needs a run that records the position the chain saw, which this one does not.

## Raw data

`docs/spikes/sp-load-run4.jsonl` (the measurement), `sp-load-run1.jsonl` (the run whose
numbers are wrong, kept because §6 cites it), `sp-load-keysweep.jsonl` (§5).

## Reproducing

```
./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/sp_load.ts --bundle --platform=node --format=esm \
  --alias:@heartrot/client=./packages/client/src/index.ts \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=/tmp/sp_load.mjs

# the measurement run
SPL_QUIET_MS=40000 SPL_PACED_MS=60000 SPL_AGGRESSIVE_MS=60000 \
  node /tmp/sp_load.mjs --out /tmp/sp_load.jsonl

# the key ceiling, no arena needed
node /tmp/sp_load.mjs --key-sweep --out /tmp/sp_keysweep.jsonl

# an aborted run leaves the crank armed for 4,500 iterations — always
node /tmp/sp_load.mjs --settle-only <arenaId>
```
