# SP2 — the crank compute ceiling, and whether the game loop survives it

Run: 2026-09-01, real devnet, real `devnet-as` ER (`magicblock-core 0.14.11`, git
`cec4cf5`). Script: `scripts/spike/sp2_crank.ts`. Every number below was read out of an
RPC response or a transaction log line; nothing here is simulated, estimated from source,
or carried over from research — except the one paragraph explicitly labelled
*extrapolation*.

**Verdict: PASS.**

- **Y = 400,000 CU.** Confirmed exactly. The crank transaction carries no `ComputeBudget`
  instruction and gets `2 × 200,000`, precisely as research derived from Agave's
  builtin-costs table. `boss_tick` is invoked at CPI depth 2 and sees `of 399,700` — the
  outer `Magic111…` noop and `Crank111…` spend 300 CU before it starts.
- **X = 6,857 CU on an empty arena, 26,300 CU at the observed worst tick with all 20
  seats in the arena and the boss firing.** That worst tick is **6.6 %** of the ceiling.
- The crank ran unattended for five minutes and `Arena.tick` advanced **monotonically**:
  756 ticks in 302.36 s, **0 regressions, 0 stalls**, 400.0 ms per tick.
- `settle` cancelled the task; the ticks stopped in the same second.

**X is nowhere near the ~300,000 line that would have forced a decision. Nothing needs to
be bitboarded and the bullet pool does not need to shrink to 64.** Section 4 of the spike
brief is answered "no action" — see *The 128-bullet question* below for how far the
headroom really goes.

---

## How it was run

```sh
cd /home/anshtyagi/Documents/pixel-artgame
node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/sp2_crank.ts --bundle --platform=node --format=esm \
  --alias:@heartrot/client=$PWD/packages/client/src/index.ts \
  --outfile=/tmp/sp2.mjs

node /tmp/sp2.mjs --self-test                       # offline: can 20 seats walk to the gate?
SP2_EMPTY_MS=300000 SP2_SEATS=0 node /tmp/sp2.mjs --out /tmp/sp2-empty.jsonl
SP2_EMPTY_MS=15000 SP2_LOADED_MS=150000 node /tmp/sp2.mjs --out /tmp/sp2-loaded.jsonl
node /tmp/sp2.mjs --settle-only <arenaId>           # disarm a crank an aborted run left running
```

There is no TS runner in this workspace (no `tsx`, no `ts-node`) and
`node --experimental-strip-types` cannot resolve the client's extensionless relative
imports, so the script is bundled with the esbuild that Vite already pulled in. Every
instruction is built by `packages/client` — `initArena`, `delegate`, `startMatch`,
`claimSeat`, `movePlayer`, `enterGate`, `settle`, plus `connectMatch`, `sendInstructions`
and `confirmSignature`. The only hand-encoded instructions are `SetComputeUnitLimit` and
System `Transfer`, neither of which the client claims to build.

Raw evidence: `docs/spikes/sp2-run-empty.jsonl`, `docs/spikes/sp2-run-loaded.jsonl`.

### Why two matches instead of one

`init_arena` writes `enrage_at_tick = 900`, and `tick::step` flips the arena to
`PHASE_SETTLING` there — after which the crank still fires but `Arena.tick` stops moving.
Five minutes of unattended watching is 750 ticks. Claiming twenty seats and walking them
from the lobby spawn to the gate block takes another ~215. The two do not fit inside one
900-tick match, and a first attempt that tried it would have measured a frozen arena and
called it a loaded one. So: one match for the monotonicity question, a second for the
compute question.

Getting seats into the arena is not a formality. `enter_gate` requires the seat to be
physically standing on tiles 30..33, `move_player` accepts one step per tick per seat, and
the step is rejected against the generated wall bitboard. The script BFSes each seat from
its lobby spawn to the gate over cardinal 16-unit steps using the client's own `isWall`,
re-reads `Players` between rounds so a dropped transaction costs one round rather than
stranding a seat, and batches seven session signers per transaction (eight signatures
still inside 1,232 bytes, eleven account keys against the ~38 ceiling). Twenty seats
walked in 37 rounds, ~50 s.

---

## 1. The ceiling, and the shape of a crank transaction

One real crank transaction, in full
(`4cWAdfWqi9fVuBSECdxsNeSABQRDZHU8kfqbNRjj9g3pAAYXQkxxPEXqLrQqmW15si6QUYr1eyDint1CNceEU51J`):

```
Program Magic11111111111111111111111111111111111111 invoke [1]
Program Magic11111111111111111111111111111111111111 success
Program Crank11111111111111111111111111111111111111 invoke [1]
Program JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 invoke [2]
Program JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 consumed 6857 of 399700 compute units
Program JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 success
Executed crank with 1 instructions
Program Crank11111111111111111111111111111111111111 success
```

`meta.computeUnitsConsumed` for the whole transaction: **7,157**. `399,700 + 300 =
400,000`. Both halves of the research claim hold: the transaction is `[noop,
ExecuteCrank]` with no `ComputeBudget` instruction, and both programs classify
`NotBuiltin` at 200,000 each.

Account keys, eight of them, exactly the frozen list `start_match` scheduled plus the two
program ids and the validator identity as fee payer:

| # | key | |
|---|---|---|
| 0 | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` | the validator itself, fee payer |
| 1 | `3VNQk5tYhQTdcT9Buhx6mFPZ4DcMKiQdXhFNLYKio2iY` | Arena |
| 2 | `6Jxf6WujNZF2uujBvmcrLatAJWog52g7kCqXFk2At4C9` | Boss |
| 3 | `EXE6n1Se94xUFs6infjzjyk3hHp2EPoYxaJ7uZGcj2Pg` | Players |
| 4 | `Crank11111111111111111111111111111111111111` | |
| 5 | `Magic11111111111111111111111111111111111111` | |
| 6 | `By97hDMDcECacWR1QyrMcWtqj7UP5ygKcvByB4PEH5Gj` | crank signer PDA |
| 7 | `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5` | heartrot |

Eight keys against ~38. The estimate in `tick.rs`'s header ("four metas plus two program
ids, six keys") undercounts by two — it omits the fee payer and our own program id — but
the conclusion it draws is untouched.

## 2. X on an empty arena: 6,857 CU, and it does not vary

Over the five-minute unattended match, `logsSubscribe` captured 1,886 `consumed` lines
from our program. Every single crank tick on an empty arena read **6,857**: min = median =
max, across both matches, across hundreds of samples. This is a fixed-bound,
allocation-free handler and it measures like one.

Most of that 6,857 is not the game. `process` re-derives three PDAs before it touches any
state — `assert_pda` for Boss, `assert_pda` for Players, and `derive_program_address` for
the crank signer — at roughly 1,500 CU each. The whole of `step` on an empty arena (128
bullet slots swept, 20 seats scanned, aggro, the vent sums, the end-of-match tests) is the
small remainder.

## 3. X with twenty seats in the arena

Second match, all 20 seats claimed, walked and gated. `aliveCount` held at 20 for the
whole loaded phase and 13–15 bullets were in flight at each 10-second sample. 68 crank
transactions pulled off the arena account and parsed for the literal log line:

| | CU |
|---|---|
| min | 11,336 |
| p50 | 18,146 |
| p90 | 24,928 |
| **max** | **26,300** |
| of | 399,700 |

The numbers cycle on an 8-tick period — `VOLLEY_INTERVAL_TICKS` — climbing as the pool
fills and dropping when the volley's bullets die on walls: `11,382 → 12,243 → 14,001 →
16,912 → 18,107 → 18,993 → 21,010 → 25,961 →` back to `11,382`.

**Worst observed tick: 26,300 CU, 6.6 % of the 400,000 ceiling.**

### The 128-bullet question

The pool never saturated. A volley is `3 + alive` = 23 bullets and the map kills them
fast, so the arena sat at 13–15 active bullets rather than 128. The saturated case is
therefore an **extrapolation**, and it is stated as one:

The fixed cost is 6,857. Across the 8-tick cycle the marginal cost of the bullets one
volley adds is `26,300 − 11,336 = 14,964` CU for at most 23 additional bullets — 650 CU
per active bullet, and that figure already includes each bullet's inner loop against 20
live targets, which is the term the design was worried about. A fully saturated 128-slot
pool with 20 seats alive therefore lands near `6,857 + 128 × 650 ≈ 90,000` CU, and an
upper bound taken against the whole `26,300 − 6,857` span over 23 bullets gives
`≈ 115,000`. **23–29 % of the ceiling in a state the fight cannot actually reach.**

No arithmetic change is warranted. The active-bullet mask does not need a bitboard, and
`MAX_BULLETS` does not need to drop to 64. If a future affix ever does saturate the pool,
this measurement says the first 4× of headroom is already paid for.

## 4. Monotonicity: five minutes, unattended

| | empty match | loaded match |
|---|---|---|
| arena | `3VNQk5tYhQTdcT9Buhx6mFPZ4DcMKiQdXhFNLYKio2iY` | `DJgRnWLRo3ePyz8cEufWhuFSKwhr4H1cA4cXYd2pfvcR` |
| first → last tick | 2 → 758 | 192 → 582 |
| elapsed | 302,360 ms | 156,367 ms |
| samples (10 s apart) | 30 | 16 |
| **tick regressions** | **0** | **0** |
| **stalled samples** | **0** | **0** |
| ms per tick | 400.0 | 401.0 |

Every 10-second sample showed a delta of 26 or 27 ticks. The crank did not stop, did not
skip, and did not drift: `TICK_INTERVAL_MS = 400` is delivered as written, and the
scheduler's "re-queue at `last_execution + interval`" does not accumulate error at this
rate. The failure mode research warned about — a task that silently dies mid-match and
leaves nothing to look at — did not occur in 1,146 observed ticks across two matches.

## 5. Cancelling the task

`settle` on the loaded match (`22quryd6N8CME8VeRdJDt8u8m9xugFrvJJR1FD2GYTDPY5YvsAtx2bDAarPRdYf8452JaLA8pUNvWs7hq9SKftd3`),
31,723 CU of 200,000, seven keys:

```
Program Magic11111111111111111111111111111111111111 invoke [2]
Successfully added cancel request for task 7774112790138286429
Program Magic11111111111111111111111111111111111111 success
Program Magic11111111111111111111111111111111111111 invoke [2]
ScheduleCommit: Marking account DJgRnWLRo3e… as undelegating
ScheduleCommit: Marking account 5V6yqZFd9Kn… as undelegating
ScheduleCommit: Marking account 3ugghLGgNWx… as undelegating
Scheduled commit with ID: 1214213
```

The last crank tick landed in the second before the cancel and there was not another one.
Three post-settle reads of the arena on the **base** layer, 10 s apart, all returned
`tick = 586`, `phase = 3` (Settled), `owner = JCfWB9zD…` — cancelled, committed,
undelegated, and the clock frozen. The same shape was confirmed on a second match
(`44fT4cPEbYegc8E8…`, 28,723 CU). Cancel-then-commit inside one instruction works exactly
as `settle`'s doc comment argues it must.

## 6. Everything else this run measured

| instruction | layer | CU consumed | of | keys |
|---|---|---|---|---|
| `init_arena` | base | 10,901 / 13,901 | 399,850 | 7 |
| `delegate` | base | 73,041 / 89,541 | 1,399,850 | 17 |
| system `Transfer` ×3 (ER rent top-up) | base | 450 (tx total) | 200,000 | 5 |
| `start_match` | ER | 11,886 | 200,000 | 6 |
| `boss_tick`, empty | ER (crank) | 6,857 | 399,700 | 8 |
| `boss_tick`, 20 seats | ER (crank) | 11,336 – 26,300 | 399,700 | 8 |
| `settle` | ER | 28,723 / 31,723 | 200,000 | 7 |

Two figures where two matches were measured, and the spread is real: both `init_arena` and
`delegate` spend most of their budget in `find_program_address`, whose bump search takes a
different number of attempts for each match's addresses. Anything that budgets these
instructions must budget for the unlucky arena_id, not the observed one.

`delegate` fits the default 200,000 CU with room to spare at both samples. The client's doc
comment on `delegate` — "raise the compute budget on the transaction — ~12 CPIs copying up
to 1,924 B per account do not fit the default 200,000 CU" — is **wrong**: the worst
measured cost is 89,541. The spike raised the budget anyway, so this is a reading of the
log line, not an inference from a transaction that happened to pass.

---

## Contradictions and surprises

**1. The deployed program was stale, and nothing said so.** Before running anything,
`solana program dump` returned 92,000 bytes against a fresh, up-to-date `cargo build-sbf`
of 92,832. Same generated `WALLS` table in both, different code elsewhere. Measuring a CU
ceiling against a binary that is not the source in the tree is worthless, so the program
was rebuilt and redeployed
(`Fj8wr6fzrhvXb46VtYLitR4LnvqoTk4SZTm3bVfPGPBaEsqjvcdU87oZqYMjSqv6e2As2j5h2y3DjfiWNxh7FRC`)
and the dump re-verified byte-for-byte identical to `target/deploy/heartrot.so` before the
first measurement. Every number in this document is against that deployment. **A
`solana program dump` and `cmp` belongs at the top of every future devnet spike** — the
deploy is 18 minutes older than the build it is supposed to be, and there is no on-chain
signal for that at all.

**2. The ER rent blocker, hit independently.** The first two attempts died with `ER clone
timeout` and then, once a transaction was actually sent,
`Cloner error: … InsufficientFundsForRent`. Devnet's rent schedule is ~9 % cheaper than
Solana's default, `create_pda_account` funds from the devnet `Rent` sysvar, and the ER
computes rent with the default — so every account this program creates on devnet is
unclonable by the ER by construction. `docs/spikes/sp9-sp10.md` reached the identical
conclusion from a different spike in the same hour, with the same arithmetic
(`(128 + space) × 6960`); this run reproduces it and adds nothing to it except a second
independent confirmation. The script tops the three accounts up by 2,205,786 lamports
before `delegate` and every ER transaction then worked on the first try.

**3. `connectMatch` is not broken — the rent bug framed it.** The first read of the
evidence was that the ER clones lazily, on first transaction, and that `connectMatch`'s
phase 2 could therefore never complete. That is **wrong**, and the fallback path in the
script has a comment saying so. Once the accounts were funded to the ER's satisfaction,
`connectMatch` succeeded in ~1.4 s including both phases, on the first attempt, with no
transaction sent. Phase 2 is a correct and useful check; it was reporting a real failure
in the only language it has.

**4. kit's error text for an ER rejection is actively misleading.** The ER returns its
cloner failure as JSON-RPC code `-32003`, whose canonical Solana meaning is
`TransactionSignatureVerificationFailure`. `@solana/kit` renders the code and discards the
server's message, so `sendInstructions` throws **"Transaction signature verification
failure"** for a transaction whose signature is provably valid — verified locally against
the treasury's public key with `crypto.subtle.verify` before it was sent. Anyone debugging
an ER send through kit must re-issue the same base64 through a raw `fetch` to see what the
validator actually said. Roughly forty minutes of this spike went into that one sentence.

**5. The ER does serve `SlotHashes`.** `schedule_entropy()` has no fallback: a missing or
empty sysvar aborts `start_match`. `start_match` succeeded on the first attempt on
`devnet-as` and logged `Scheduled task request with ID: 7774112790138286429` — a wide,
positive `i64` with no visible structure, which is only reachable if `fetch_into` returned
a non-zero recent block hash. **This closes the half of L4 that mattered:** on this
validator the task id does not degrade to something precomputable. The other half — what
happens on a validator without the sysvar — remains untested, and by construction is now
a hard `UnsupportedSysvar` failure rather than a silent weakening.

**6. No `task_id` collision, and two concurrent matches under one authority coexisted.**
Three matches were armed on `devnet-as` during this run, two of them overlapping in time
and all three sharing one `crank_authority` and therefore one crank signer PDA. All three
ticked independently and each was cancelled by id. One run is not evidence about a
validator-global namespace, but it is evidence that the per-authority path is not itself a
collision.

**7. `logsSubscribe` works on the ER, but it is not per-match.** `{mentions: [programId]}`
is accepted and delivers every log line including the `consumed X of Y` ones — but it
returns *every* arena's cranks plus every player transaction, so its aggregates are
meaningless when more than one match is live. The trustworthy per-match path is
`getSignaturesForAddress(arena)` + `getTransaction`, both of which the ER supports.
Filtering on `of == 399700` is what separates a crank tick from a client transaction; the
first summary this spike produced reported a `max` of 28,723 that turned out to be a
`settle`, not a tick.

**8. `Arena.rentExemptLamports` in `layout.ts` is a stored copy of a cluster fact, and it
is wrong for devnet.** `layout.ts` carries 8,964,480 / 1,238,880 / 14,281,920; devnet's
`getMinimumBalanceForRentExemption` answers 8,156,904 / 1,127,274 / 12,995,316. Nothing
reads those constants today, which is the only reason it has not caused a bug. It is the
governing lesson in miniature: a fact that belongs to the cluster, written down in the
repo.

**9. `tools/gen_map.py --self-test` is red, and was already red when this spike started.**
Not caused by anything here — nothing outside `scripts/spike/` and `docs/spikes/` was
touched — but the run brief asserts it is green, so it is recorded:

```
gen_map: MAP REJECTED: cannot evaluate `const TILE = map::TILE as i32`
from programs/heartrot/src/handlers/tick.rs: invalid syntax
```

`tick.rs` line 80 now reads `const TILE: i32 = map::TILE as i32;` (mtime 14:00:09, three
minutes before this session opened). `gen_map.py` scrapes that constant out of the Rust
and `eval`s the expression as **Python**, where `map::TILE as i32` is a syntax error. The
change is the right change — deriving `TILE` from the generated map instead of restating
it is exactly the governing lesson — and the tool simply has not been taught to read a
cast. Everything else is green: `cargo check` 0, `cargo build-sbf` 0, `tsc` 0 in all three
TS workspaces, `vite build` 0.

**10. Tags 11 and 12 have no client builder.** `lib.rs` dispatches `11 => process_commit`
and `12 => process_commit_and_undelegate`; `packages/client/src/instructions.ts` builds
0–7, 9 and 10 and nothing else. This is not academic — see the debris below.

---

## Debris left on devnet

| arenaId | arena | state | why |
|---|---|---|---|
| 1788252294 | `GxA2aTNVVQ6E62PfcMQ4xKquQwYRpgubUiELGkwYcJ23` | delegated, `Lobby`, never started | run 1, died on the rent blocker |
| 1788252426 | `AeCoZhwbnW9Rfo1mtyWGKHUHTqKnT84vuke41n1QP3hD` | delegated, `Lobby`, never started | run 2, same |
| 1788253064 | `3VNQk5tYhQTdcT9Buhx6mFPZ4DcMKiQdXhFNLYKio2iY` | settled, undelegated | the empty match, cleaned up |
| 1788253192 | `2FHjtNVouts3xvY6m5Ncv7bvK6xBVcDRiJN1RS4AfZmX` | settled, undelegated | aborted loaded run, cleaned up |
| 1788253246 | `DJgRnWLRo3ePyz8cEufWhuFSKwhr4H1cA4cXYd2pfvcR` | settled, undelegated | the loaded match, cleaned up |

Every crank this spike armed was cancelled. The two `Lobby` arenas never armed one.

They are, however, **unrecoverable through any instruction the client can build**:
`settle` rejects `PHASE_LOBBY` outright, so an arena that was delegated and then never
started has no path back to the base layer except tag 12, for which there is no builder.
About 0.06 SOL is stranded. That is small; the shape of it is not — a match that is
delegated and then abandoned before `start_match` is a state the Worker can reach on any
crash between the two transactions, and today nothing can free it.

Treasury after the run: 0.7432 SOL (from 1.0), across five matches' rent, the ER rent
top-ups, and ~500 transactions.

---

## What SP2 changes

- The 400,000 CU ceiling is no longer a reading of Agave source. It is a log line.
- The crank budget is a **non-issue**: worst measured tick is 6.6 % of it, and the
  unreachable saturated case extrapolates to under 30 %.
- `Arena.tick` advances monotonically at the target rate under a real, unattended,
  five-minute crank, and the settle path stops it on demand.
- The rent shortfall in `init_arena` is a **hard blocker for the product**, not just for
  spikes: without it no match can ever start on devnet. The fix is
  `max(Rent::minimum_balance(space), (128 + space) * 6960)` in `create_pda_account`, and
  it wants a test that does not depend on which cluster is answering.
