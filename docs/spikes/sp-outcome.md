# SP-OUTCOME — F1, F7, F3, F6 proven on real devnet

**Verdict: PASS, all four.** Program `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`,
base `https://api.devnet.solana.com`, ER `devnet-as` via the router, 2026-09-01 12:34–12:55 UTC.

| | claim | result |
|---|---|---|
| **F1** | a WIN row and a loss row are distinguishable in the durable record | **PASS** — outcome byte 0x01 vs 0x03, `survived` identical on both |
| **F7** | a seatless settle does not steal the ring's idempotency key | **PASS** — 0 rows appended, key unmoved, the real match's retry still a no-op |
| **F3** | a solo raid respawns and keeps playing; a real solo loss still fires | **PASS** — 8 deaths / 7 respawns in one solo match, ENRAGE at tick 900 |
| **F6** | a bullet whose step ends in a wall still hits the player it crossed | **PASS** — 14 wall-clipped hits, 6 of them the sole bullet on their tick |

## 0. The deployed program is the fixed program

Checked before a lamport was spent, because everything below is worthless against a stale
binary. `solana program dump` of the live program, versus the tree rebuilt from source:

```
$ solana program dump JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 onchain.so -u devnet
$ HEARTROT_TREASURY=FbDoanjAUonn5wM4KbRNS3jigHe6zDa4ThoEUKPnS7ka \
    cargo build-sbf --manifest-path programs/heartrot/Cargo.toml
$ sha256sum target/deploy/heartrot.so
deb115968ba12af4e7157552b0ac4aa3d5171648203ce9c0000a089d7b2f06f7
```

`onchain.so` is 112,480 bytes, `heartrot.so` is 112,120; `cmp` reports **no differing byte**
before EOF and the trailing 360 bytes of the account are zero padding. A fresh build of the
current tree is byte-identical to what devnet is running. (Without `HEARTROT_TREASURY` the
build fails at `init.rs:134` — a const assert, not a warning.)

## 1. Build and run

```
./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/sp_outcome.ts --bundle --platform=node --format=esm \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=/tmp/spo.mjs

node /tmp/spo.mjs --phase solo     --out docs/spikes/sp-outcome-solo2.jsonl   # F3, F6, the loss row
node /tmp/spc.mjs                                                            # sp_combat.ts — the WIN
node /tmp/spo.mjs --phase seatless --prev <arenaId> --out docs/spikes/sp-outcome-f7.jsonl
node /tmp/spo.mjs --phase read     --out docs/spikes/sp-outcome-read.jsonl   # F1's verdict
node /tmp/spo.mjs --settle-only <arenaId>                                    # recovery, tag 9
```

Every instruction is built by `packages/client`, so a wrong hand-written encoder fails here.
No address lookup tables. The WIN half of F1 is not re-implemented — `sp_combat.ts` already
kills the boss, and a second copy of its raycast/station search is exactly the duplication
this project keeps paying for.

### Runs

| run | arena_id | arena | jsonl |
|---|---|---|---|
| solo #1 | 1788266168 | `HNzRJcd7SBV3Zn5gp2fLKCoJMFTnjewscawtj2gFsCgA` | `sp-outcome-solo.jsonl` |
| F6 probe | 1788266440 | `GsioKfRnt6ciaYmF3kgfz29Fo3Ut8L1wvgoehvmmasu8` | `sp-outcome-f6.jsonl` |
| WIN (`sp_combat`) | 1788266476448 | `Bq8Majy5fdxmncLa5ZJtKVdSYxa2ZFFv6CnjkqprohR4` | — |
| solo #2 | 1788266869 | `8tSqFZJ57sRdERfu5qMZd2y7wQo5LhEUJCAazpwD75YZ` | `sp-outcome-solo2.jsonl` |
| seatless | 1788267270 | `BuMqa7MkwCbVnhLsZxKppQWwt9b24QkLBAGWBNaXdCqs` | `sp-outcome-f7.jsonl` |

All five are home on the base layer, owned by the program, none in `PHASE_FIGHTING`.
Nothing stranded. Treasury spent 0.128 SOL across the five matches (0.333 → 0.204).

---

## F1 — the outcome reaches the durable record

### Before

The ring held 14 rows when this run started. Every one of them:

```
index  5  e381ba5ca0010000 a295…0355 6c160000 0000 01 00   damage 5740  survived 1  outcome 0
index 11  a0afce5ca0010000 13db…26b8 880e0000 0000 01 00   damage 3720  survived 1  outcome 0
```

Byte 47 is `00` on all 14 — that field was padding when they were written, so it reads
`OUTCOME_UNDECIDED`, which is the honest answer and the reason no version bump was needed.
Those two rows come from different matches (arenas 1788262121955 and 1788263444384) and are
separated by nothing but `arena_id`, `identity` and `damage_dealt`. Whether either match was
won is not recoverable from the record — that is the defect, and it is why no claim is made
here about which of the 14 were wins.

### After

`--phase read`, board `3jG6jGcvrhaS6J9r2e8xPB1DEHVvTxr4fRHiHn592Rcg`, 20 rows:

```
WIN     index 15  a0f3fc5ca0010000 a295…0355 28050000 0000 01 01   arena 1788266476448
ENRAGE  index 14  b8c6966a00000000 b6a0…22d3 00000000 0100 01 03   arena 1788266168
```

Full hex, both rows quoted whole:

```
15  a0f3fc5ca0010000a295a7c8ff7bfbc2f869f19560694e406e254dc548e8c6f57d5be831c6ad03552805000000000101
14  b8c6966a00000000b6a0785db90f62035966f99ff39423e407bea1e715dc726e18a510e791c322d30000000001000103
```

Both are **survivor** rows: byte 46 is `01` on both, so `survived` alone still cannot tell
them apart — which is the whole point, and why the fix could not have been "sample `hp`
harder". Byte 47 is `01` (`OUTCOME_WIN`) against `03` (`OUTCOME_ENRAGE`). The permanent
record now says which match was won.

`f1_summary`: `winRows: 4`, `lossRows: 2`, `f1_win_and_loss_both_recorded: true`,
`f1_outcome_byte_differs: true`, `f1_survivor_rows_distinguishable: true`.

The WIN came from `sp_combat.ts` on arena 1788266476448: core dead at tick 455 after 182,256 ms,
`phase=2 outcome=1`, per-seat damage 13,720 against a boss that lost 13,720 hp, VRF rolled in
128 ms, four rows written by
`3PrQFDHo2PkcvnLNzzcdyHES7sWWoMLLBw43QM76suJcF8jtiNv7YbrAgdWPs6uhJDG58TTcZQ2F5v54LFRXZULC`.
The ENRAGE rows came from the two solo matches below.

---

## F7 — a seatless settle does not steal the key

Setup: solo #2 (arena 1788266869) settles and writes one row, taking the ring key.

```
f7_start   board {totalWritten: 20, next: 20, lastArenaId: "1788266869", lastIncarnation: 1}
           keyIsPrev: true, prevRowsOnBoard: 1
```

Arena 1788267270 is then initialised, delegated and started, and **nobody claims a seat**
(`seatless_armed: aliveCount 0, targetSeat 255`). It is settled straight out of
`PHASE_FIGHTING` — the operator recovery edge — landing on base at `phase 3, outcome 0`,
and written to the leaderboard.

| step | signature | totalWritten | last key | rows |
|---|---|---|---|---|
| start | — | 20 | (1788266869, 1) | — |
| `write_leaderboard` seatless | `3KhfbT48kE4fhnXAJDNz81y2i2MaAAW43S1dFMemcBHpwdWxbTLYi1KhFGRCWKqDerjnLwWGctMPBtx2X15N2aR2` | 20 | (1788266869, 1) | **0** |
| retry of 1788266869 | `52NubqasSHs3MskSSerYTXC749Z8ZEFRUzMEe9Sjw2BgdMA2GWBNK93ktgFBNNnScp645mo2TXLMzV3rMVQ7fFQe` | 20 | (1788266869, 1) | **0** |

`f7_seatless_appended_zero_rows: true`, `f7_seatless_did_not_claim_key: true`,
`f7_prev_retry_was_a_noop: true`, `f7_prev_rows_still_present: 1`,
`f7_prev_rows_not_duplicated: true`.

The seatless settle appended nothing and left `(last_arena_id, last_incarnation)` where it
found it. Because the key is still the real match's, that match's retry is recognised as the
duplicate it is and does nothing — the old unconditional stamp would have moved the key to
1788267270, and the same retry would then have appended a second copy of the row.

The intended `--prev` was the WIN match, but `sp_combat.ts` runs `next_incarnation` (tag 15)
at the end, which resets that arena to `PHASE_LOBBY`; `write_leaderboard` requires
`PHASE_SETTLED`, so a retry there is rejected as `MatchNotOver` and proves nothing about the
key. Solo #2 was run to have a real, decided, still-settled match to retry against.

---

## F3 — a solo raid respawns

Solo #2, arena 1788266869, one seat, session key `generateKeyPair()` with zero lamports.
It walks to the gate, enters, walks to a tile next to the boss and stands still for the
whole match.

```
deaths     176 281 391 482 580 687 794 893     (8)
respawns   184 289 399 490 588 694 802         (7, the 8th deadline is past the enrage)
delayTicks   8   8   8   8   8   7   8         RESPAWN_TICKS = 8
respawn at (464, 16) = entrance_for(0), hp back to 100, every time
```

`f3_solo_respawned: true`, `f3_moves_accepted_after_respawn: 7` — each respawn is followed by
a `move` the chain accepted and a walk back to the station, so the seat is genuinely playing
again and not just holding non-zero hp.

The load-bearing line is the first death:

```
death {tick: 176, respawnAtTick: 184, deaths: 1, arenaPhase: 1, arenaOutcome: 0, aliveCount: 0,
       note: "the only occupant is down; before F3 this tick was OUTCOME_WIPE"}
```

`aliveCount 0` with `arena_occupants == 1`, and the arena is still `PHASE_FIGHTING` with
`OUTCOME_UNDECIDED`. That is the exact state the old wipe check read as a wipe. The match ran
on for another 724 ticks.

Solo #1 (arena 1788266168) is the same result independently: one death at tick 483, respawn
at 491, `f3_phases_seen_while_dead: [1]` — the arena was in `PHASE_FIGHTING` on every poll
where the lone occupant was dead.

**And a real solo loss still fires.** Both solo matches ended:

```
fight_over {tick: 900, phase: 2, outcome: 3, outcomeName: "ENRAGE", enrageAtTick: 900}
```

`isEnrage: true`, `isWipe: false`, `isUndecided: false`. `ENRAGE_AT_TICK` is the bound that
stops a respawning solo raid running forever, and it is recorded as an enrage, not as a wipe.
Solo #2 reports `f3_phases_seen_while_dead: [1, 2]` because its eighth death (tick 893) had a
deadline at 901, past the enrage at 900 — the clock ended the match while the seat was down,
which is why that row carries `survived: false`.

`OUTCOME_WIPE` was not produced by either run and is not reachable by standing still any
more: every death stamps a non-zero `respawn_at_tick`, and stage 1 of `tick::step` resolves
those before the wipe test, so `pending_respawns == 0` now requires a seat at 0 hp with no
deadline — a state no path in the program writes. That is a consequence of the fix worth
naming rather than a defect: the losing outcome for a raid that keeps dying is ENRAGE.

---

## F6 — a bullet that dies in a wall still hits what it crossed

The spike samples the whole bullet pool every ~280 ms and keys snapshots by tick. The pool
read at tick *T* is post-step for *T*, so the bullets that can hit during *T+1* are exactly
the ones standing there — which means an hp drop between consecutive ticks can be attributed
to specific bullets. For each, the spike reruns `tick::step`'s clip (`mid`, then `to`) and
`bullet_hits` over the client's own generated wall grid.

Station: the spike searches for a tile where every sample ±`PLAYER_HIT_RADIUS` across the hit
corridor, from 8 to 48 units along the boss's fire line past the player, is solid. On this map
that is **(480, 384)**, 132 units from the boss at (512, 512).

The evidence, from solo #2 tick 257 (and identically at 374, 572, 671, 761, and in the F6
probe at tick 149):

```
damage_attributed {tick: 257, lost: 8, expectedBullets: 1, at: [480,384],
  clippedHits: 1, cleanHits: 0,
  bullets: [{from: [484,398], to: [445,382], mid: [464,390], end: [464,390],
             toIsWall: true, midIsWall: false, clipped: true}]}
```

Read it straight: the player lost exactly 8 hp — `BULLET_DAMAGE`, one bullet — and the **only**
bullet in the pool whose swept segment came within 12 units of them had `wall_at(to) == true`.
Its step ended at (445, 382), inside a wall; `wall_at(mid)` was false, so the sweep was clipped
to (464, 390) and the hit test ran on `from → mid`, which passes 11.5 units from the player.

Under the old loop that bullet hit `if wall_at(mid) || wall_at(to) { free; continue; }` and was
deleted before anything asked whether it had crossed a player. Zero damage. A player with their
back to a wall was immune to it.

Totals:

| run | station | damage ticks | clipped hits | clean hits |
|---|---|---|---|---|
| solo #1 | (496, 288) | 20 | 0 | 20 |
| F6 probe | (480, 384) | 38 | 6 | 37 |
| solo #2 | (480, 384) | 62 | 8 | 57 |

14 wall-clipped hits across the two runs at (480, 384), six of them the sole bullet on their
tick. `f6_wall_clipped_bullet_dealt_damage: true` on both.

### The station picker had the bug this project keeps having

Solo #1 recorded 0 clipped hits in 20 damage ticks, and that was the spike's fault, not the
program's. The first picker sampled one ray at `Math.round(x + ux*t)`; the player stands on a
tile *corner*, so sub-unit drift walked the sample into the neighbouring tile column and it
reported a solid wall for a station whose own column was an open corridor. Every bullet that
reached (496, 288) had open space behind it and none was ever clipped. The fix samples the
full 24-unit hit corridor on the dominant axis with the other coordinate held exact — one
fact (where the wall is, relative to the bullet's path) measured once, instead of a proxy for
it measured on a line the bullet does not travel. Both later runs picked (480, 384) and both
found the same bullet from (484, 398), because the station is deterministic: same map, same
boss spawn, same muzzle, same quantised velocity.

That determinism is also why the effect is not a coin flip. A step ends where
`distance mod step_length` puts it, and at (496, 288) that value landed the endpoint 4 units
*short* of the player on every landed bullet — an unclipped hit, every time. F6's case simply
never arose there.

---

## What this run did not prove

- **`OUTCOME_WIPE` on chain.** Neither solo match could reach it (see F3 above) and neither
  did any four-seat match here. The unit test at `tick.rs` covers it by hand-placing a 0-hp
  seat with `respawn_at_tick == 0`; no on-chain path writes that state today.
- **The old binary's behaviour.** Nothing was A/B'd against a pre-fix deployment. The F6
  claim rests on replaying `tick::step`'s own arithmetic over the bullet the chain reported,
  not on watching the old loop drop it.
- **`survived` on a WIN with corpses.** All four WIN rows came back `survived: true`; a win
  where somebody stays dead through settlement was not produced, so the `survived`/`outcome`
  pair was exercised in three of its four corners.
