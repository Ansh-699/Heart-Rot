# SP-COMBAT — the full combat loop (M4)

**Date:** 2026-09-01
**Script:** `scripts/spike/sp_combat.ts`
**Program:** `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5` (devnet), ER `devnet-as` /
`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`
**Verdict:** PASS. The full loop ran on chain — part destroyed, vent opened, core sealed
then killed, **WIN** recorded distinct from a wipe, leaderboard written idempotently, VRF
rolled, incarnation 2 spawned harder with a different seed. It also **could not have been
won by anyone before this spike**, for a reason nothing in the repo could have caught: the
boss was spawned inside a wall.

Before this run nobody had, on chain, destroyed a boss part, opened the vent, damaged the
core, been killed by the boss, respawned, wiped, or recorded a result. Every claim about
combat in this repo was inference from source. This is what the chain actually did.

---

## 0. The headline: the boss was standing in a wall

`init.rs` spawned the boss at **(512, 320)** — tile (32, 20). That tile is inside the
**two-tile-wide north corridor**, not the heart chamber. The drawn map puts the boss's
`B` heart tile at **(512, 512)** — tile (32, 32) — and the chamber it sits in is exactly
sixteen tiles across, which is exactly what the 230×270-unit boss sprite needs.

The same fact was written down **three** times and two of them were wrong:

| Where | What it said | |
|---|---|---|
| `assets/map/arena.json` | `B` at tile (32, 32) | the source |
| `handlers/init.rs` | `BOSS_SPAWN_X/Y = (512, 320)` | **wrong**, and the only one the chain read |
| `tools/gen_map.py` | asserted the heart equals `(ARENA_SIZE/2, ARENA_SIZE/2)`, attributed to "the boss spawn `tick.rs::start_match` writes" | **wrong twice**: `start_match` writes no such thing, and the check passed while never looking at `init.rs` |
| `shoot.rs` tests | `const BOSS_XY = 32 * 16` (512, 512) | right about the map, wrong about the program |
| `player.rs` tests | `assert!(!is_wall(32*TILE, 32*TILE), "boss spawns in a wall")` | same |

Fifty-four unit tests passed against a boss at (512, 512) while the program put one at
(512, 320). Nothing compares the two, and the fight had never been run, so nothing noticed.

**Measured consequence.** The script's preflight re-implements `shoot.rs::raycast` over the
client's generated `PART_HITBOXES`, `CORE` and wall grid and searches the whole map for a
lane. Sweeping every floor tile × every sub-tile offset × all eight directions:

| boss at | shell strippable | core-reachable lanes (tile-aligned) | best single lane |
|---|---|---|---|
| **(512, 320)** — what shipped | 17,000 / 18,000 | **0** | — |
| **(512, 512)** — the `B` tile | 18,000 / 18,000 | 219 | 11,000 hp |

With the shipped spawn there is **no tile-aligned standing position in the arena from which
a hitscan ray reaches the core**. Only sub-tile positions on a 5-mod-16 lattice reach it,
and a player can only land on those through diagonal moves — nothing in the client or the
Worker aims for them. `shoot.rs` returns `Some(Hit::Core)` or nothing; if the ray never
reaches the core, `core_hp` never reaches 0, `end_fight(OUTCOME_WIN)` is never called and
**the win condition is unreachable**. Six of the nine part hitboxes were buried in the
corridor's rock, where the ray dies on the wall test before it ever reaches a box.

### The fix, at the root rather than the copy

Not "change 320 to 512" — that is correcting the copy, which is the failure this project
keeps re-buying. The `B` tile is the source, and `tools/gen_map.py` already parses it:

- `gen_map.py` now emits `map::BOSS_SPAWN` (Rust) and `BOSS_SPAWN` (TypeScript) from the
  heart tile, in the same top-left-corner world-unit convention as `ENTRANCES`, plus a
  `const _` assertion in `map.rs` that the boss does not stand in a wall.
- `init.rs`'s `BOSS_SPAWN_X`/`BOSS_SPAWN_Y` are **deleted**; `init_arena` and
  `next_incarnation` read `map::BOSS_SPAWN`.
- `gen_map.py`'s heart-vs-centre assertion is gone: it compared the map to a constant it
  invented, attributed to code that does not exist.
- `shoot.rs`'s test constant is now `crate::map::BOSS_SPAWN` too, so the third copy is gone.

54 unit tests still pass; `gen_map.py --self-test` still rejects all nine broken maps; the
client and `app/` both still typecheck. **`app/` was not touched** — it renders from
`boss.x`/`boss.y` off the account, so it needs no change at all.

Redeployed: `3wnaWM2PRWom8rHjc5RZUWP3kSBayTB7QochtKUdkMcVcxK3pv5N45FfRNCuotuGHyUNjVCbq4HfEsUUv7ckDpgX`

On chain after the fix: `init_arena` → `boss spawned at (512, 512) core_hp=2000 shell=18000`.

---

## 1. How the spike fights

Nothing about the firing positions is hardcoded. `station()` walks every floor tile on the
seat's own 16-unit lattice, casts all eight directions with `shoot.rs`'s exact algorithm
against the *live* `Boss.parts` read off chain, and scores each lane by how much shell it
can strip without moving — the first box, then the box behind it once that one detaches.
`pathTo()` is a BFS over the same generated wall table `move_player` rejects steps against.

Two consequences worth keeping:

- **Every step of the setup happens in `PHASE_LOBBY`.** `player::move_clock` rate-limits on
  the ER's 50 ms slot clock in the lobby and on `Arena.tick` (400 ms) once fighting, so
  walking 39 steps to the gate and another 37 into the chamber costs seconds before
  `start_match` and would cost 76 ticks of the 900-tick enrage budget after it. `enter_gate`
  accepts `PHASE_LOBBY`, so a seat can be placed on its firing tile before the clock starts.
- **The shot cadence is the rate limiter, not the RPC.** `shoot` accepts one shot per seat
  per two ticks. Two seats is one shot per tick, 343 landed shots to clear the fight, and a
  900-tick enrage window — there is very little slack, and run 1 spent all of it.

---

## 2. Run 1 — arena `1788262121955` — ENRAGE

Two seats (0 and 2), two freshly generated **zero-lamport** session keys, both of which
played the whole match on both chains without ever holding a lamport.

| | |
|---|---|
| `init_arena` | `2M2JYVbSxqZFyLbo2qt52Mdu3fXVYDL6NLAxuzfeME4Q15E9uZcd7YGZQqPy6m7isigP7DE2GYHnZFUmJzHtAung` |
| `delegate` | `4nGVcogPFTQpLeVrSveHsnxuqCBDEECjXVrNMKqJ78rKTes9F49UuQef5oG1pC76Xgs8WNiUSGHh4Q94N3ezGDBH` |
| `start_match` | `4VfA7GVoEEbcceTS3v2ASNiWqWnNea5TZw7K1pj62fFpxM6Dhu9U1PvFJEWhkr4cCkycg7VoafJprwwBQphH8uZT` |
| `settle` | `eXfPBhFkfmyeZG2MK53YcSaqptAtNrgWFdYpXWcbwG2ifC264y2MLqsdegsXzSDejGQej5nDPFzaThH7gb1ZT6y` |
| `write_leaderboard` | `2Sd9n624Deag8uywyD1tDpPhUsKk91jfCjco7LfTHHCcowqbF7KEGF9KbRYseymT1no7hqpUna6Q8bYD7ra7DQy3` |
| `write_leaderboard` retry | `5XtTS2BawxuuQv9UTd5xyz5veKjxiomgMWepACTRkqLGMHAqmZ6YN5XdiEat4HEnWfZMdGytboiDd4bY79eRBHoe` |

**No rent top-up was needed.** `init.rs::er_clonable_rent` funds every PDA to the ER
cloner's schedule at creation; SP1's separate top-up step is now dead weight for arenas
created by the current program.

### What the fight did

```
tick   3   3 shots at the core, vent SEALED  -> core_hp 2000, unchanged
tick  78   part 3 (thorn0) DESTROYED         -> shell 16800/18000, 33 shots sent
tick 305   part 0 (crown)  DESTROYED         -> shell 12800/18000, 133 shots sent
tick 388   part 1 (wolf_l) DESTROYED         -> shell 10260/18000, 197 shots sent
tick 417   part 5 (thorn2) DESTROYED         -> shell  9300/18000, 221 shots sent
tick 607   VENT OPEN                         -> shell  6260/18000, 297 shots sent
tick 685   core 2000 -> 1800 with vent open
tick 900+  ENRAGE                            -> phase SETTLING, outcome 3
```

- **A part reaches 0 and stays destroyed.** Four did. `raycast` skips a zeroed box, so the
  lane behind it opens with no second flag — every later "part destroyed" line is the ray
  having already walked through the previous corpse.
- **The vent is derived, and it crossed on chain.** Open at 6,260 of 18,000 = 34.78 %,
  against a 35 % threshold. One landed shot earlier it was 6,300 = 35.00 % and sealed.
- **Core before the vent: 3 accepted shots, 0 damage, cooldown spent.** `last_shot_tick`
  advanced to 8 and `core_hp` stayed at 2,000. The shot is consumed by the attempt, which
  is what `shoot.rs` says and what stops a spammer.
- **Core after the vent: 280 damage from the same tile in the same direction.** 2,000 →
  1,720. Same station, same `dir`, opposite outcome — that ordering is the whole boss
  design and it now has an on-chain witness.
- **Damage bookkeeping is exact.** Seat 0 5,740 + seat 2 6,280 = **12,020**, and the boss
  lost **12,020** across nine parts and the core. Not one point double-counted or lost.
- **Death and respawn work, repeatedly.** 7 deaths on seat 0, 4 on seat 2, every one
  followed by a respawn at that seat's door at full HP.
- **`OUTCOME_ENRAGE` (3) is recorded and survives settlement.** Written on the ER, still 3
  after `commit_and_undelegate` landed all three accounts back on base (3,525 ms).
- **`write_leaderboard` is idempotent.** `total_written` 7 → 7 and `next` 7 → 7 across two
  identical writes. Two rows for this arena, damage 5,740 and 6,280, `survived` on both.
- **`next_incarnation` refused, correctly.** `Custom(6)` `WrongPhase` — the raid did not
  win, so no roll was requested, so `next_affix_seed` is all-zero and there is no edge out
  of `SETTLED`. The progression stops loudly rather than inventing a seed.

### Why it enraged, and the number that matters

The raid lost the fight to **walking**, not to the boss:

| | landed shots / tick |
|---|---|
| ticks 10–195, seats dying and re-walking | **0.30** |
| ticks 195–309, both seats standing still | **0.74** |

Two deaths in the first 200 ticks cost ~100 ticks of walking, because a respawn puts a seat
at its door 30+ tiles from its lane and `move` is one accepted step per tick during a fight.
223 sent shots produced ~219 landed hits, so the client cadence was not the problem —
**time on station was.** Total: 306 shots, 12,020 damage, enrage at 900 with the core at
1,720.

The fight is winnable at 0.74 landed shots/tick (343 shots ≈ 460 ticks). It is not winnable
at 0.30. That is a balance finding, not a bug: **the counterplay the design already
specifies is the fix.** `tick::spawn_volley` gates every emitter on
`boss.parts[muzzle.part]`, so the four thorns are the only reason bullets exist. Run 1
ranked lanes by raw HP, left thorns 4 and 6 standing for the whole match, and was shot at
for 900 ticks. Run 2 prices a thorn at `THORN_PREMIUM` above its 1,000 HP.

---

## 3. Runs 2–4 — three ways a harness loses a fight it can win

None of these three found a program defect. All three found something about the *fight*,
and each one is a number the design had never been able to produce.

**Run 2** (`1788262604076`, killed at tick ~310) priced a thorn lane at `+100_000` to force
the volleys quiet, and **livelocked**: the best lane was 41 steps from seat 2's door, the
seat died on step 30, respawned at the door, re-chose the *same* 41-step lane, and repeated.
720 damage in 126 ticks. Lesson: a station chosen from a respawn point has to be priced
against the walk, and a seat that dies should walk back to the station it already had rather
than re-derive a new one. Recovered from `Fighting` with tag 9 —
`21ywHAYkQziZzeppNELfQGLFxievcEfr9r3ZTthDXjQZmxCqisfrKtQu84PNVVv1hbeuniTfPX87UZRzKawK2bm4`.

**Run 3** (`1788262905585`, killed during setup) exposed a hazard in the harness that is
worth writing down because a real client has it too: **a fire-and-forget `move` gives no
acknowledgement**, so a resend of a step that had in fact landed applies a *second* step. In
`PHASE_LOBBY`, where `move_clock` limits on the ER's 50 ms slot rather than on `Arena.tick`,
the resend almost always lands, and a walker chasing a pre-computed waypoint it has already
walked past never converges. `walkTo` now re-plans from the position observed on chain after
every step. Recovered with **tag 12** —
`PGymqb5bxG8jv5h1cgkwEokaBAAjYBN7cJRhL5uK4evaYhygydR3rZ1BzfWZT5VH9meTosAn19WaYDDMBGBgKDo` —
which is the M5 builder added this run; without it this would have been a third stranded
arena on devnet.

**Run 4** (`1788263085350`, killed at tick ~300) doubled the raid to four seats and still
crawled: **ticks 221–299 produced two shots**, because one dead seat owned the loop while it
walked 30 tiles home and the other three sat idle behind its `await`. Recovered with tag 9,
`4VqhH2kJcHDQvcTTqGXcQ2A4y868tagBTw7Ea8VPyL3EseMEP49TsvT6GxqHxNQdXbAZnBb4snvjRLXoC8ZjcG2`.
A raid is N independent players and the harness has to be N independent players: the walk
back is now one step per loop pass, interleaved with everyone else's fire.

---

## 4. Run 5 — arena `1788263444384` — **WIN**, and incarnation 2

Four seats, four freshly generated **zero-lamport** session keys. None of them ever held a
lamport on either chain; between them they sent 351 gameplay transactions and one VRF
request. **start_match → core dead: 153,956 ms (2 min 34 s), 386 ticks of a 900-tick
window.**

| step | signature |
|---|---|
| `start_match` | `uApJiiRQfa5fQcHoc5e4RAC9eRSQ9omsrMRyHnEchMg4XttP8mqnU9HFRrTha3rhsEMvdpVz8hUHRPNmbYQ83dq` |
| `request_roll` (tag 13) | `2FuLMQ7jPgpGHWt3o6c7qeAyEXRKFmethnjGCGK3R4PvokXJDnr768Hh6KMtk2B36NyjxDFJKgJZA6v6JTMvjgYf` |
| `settle` (tag 9) | `nNZ8767EXzcgPE6qK8TYsMtuAAPjWyKXFcgrMfyH1deya9ozgm76teoPxhg6LW3ob392T7Cf1nb9iSezoFoLWsF` |
| `write_leaderboard` | `3zUk7xmYMChJUrGtQFvN9b1qZk21VRYBaur7nbw9cQbFHwipLLWV1exwBRTuNDtCZBbCYLHjA7Uf6h79X9UFVUPZ` |
| `write_leaderboard` retry | `4QPATMNfXWGaxsrak6hiAjdfwxuFvnFAfXgztFUfEjCZZUExVXj3y8hPBzqnQpdKiZK2Rk4yZEBt3V1cH3DVMCWF` |
| `next_incarnation` (tag 15) | `62iyVdktZKAJ3C9F85DkpHiv2aacREhgtf7LACBLh8zFA8NGhtmTu4UdHHxe2DLxURwi5WwKZJ1BLYN8uWuR5Wzj` |

```
tick   9   3 shots at the core, vent SEALED   -> core_hp 2000, unchanged, cooldown spent
tick  98   part 2 (beast_r) DESTROYED         -> shell 13820/18000, 109 shots sent
tick 134   part 4 (thorn1)  DESTROYED         -> shell 12380/18000, 145 shots sent
tick 184   part 1 (wolf_l)  DESTROYED         -> shell  9880/18000, 209 shots sent
tick 252   part 3 (thorn0)  DESTROYED         -> shell  8000/18000, 256 shots sent
tick 288   VENT OPEN                          -> shell  6200/18000, 301 shots sent
tick 355   core 2000 -> 960, same tiles, dir unchanged
tick 386   CORE DEAD                          -> phase SETTLING, outcome 1 (WIN)
```

### The six things M4 asked for

1. **A part is destroyed and a shot at it no longer registers.** Four parts hit 0. The
   proof that a destroyed part stops absorbing is structural and visible in the trace: after
   part 2 died at tick 98, the *same* seat on the *same* tile in the *same* direction began
   removing HP from part 4 and then part 1 behind it. `raycast` skips a zeroed box, so a
   destroyed limb detaches and the lane behind it opens with no second flag anywhere.
2. **The vent opened.** `vent_open` flipped 0 → 1 at tick 288, at shell 6,200 of 18,000 =
   **34.44 %** against the 35 % threshold; at 6,920 (38.4 %) one status line earlier it was
   still sealed. Derived every tick from the parts, never set independently.
3. **The core is invulnerable before the vent and damageable after — from one tile.**
   Seat 0 stood at (496, 560) firing `dir 1`, a lane whose first hit is `Hit::Core` with a
   *fully intact shell* (no part box covers the core's approach from below). Three accepted
   shots at tick 9: `core_hp` 2,000 → 2,000, `last_shot_tick` 9 — the attempt spent the
   cooldown and dealt nothing. After tick 288, the identical geometry took the core from
   2,000 to 0. That ordering is the whole boss design and it now has an on-chain witness.
4. **The raid reached WIN, distinct from a wipe.** `phase = SETTLING`, `outcome = 1`
   (`OUTCOME_WIN`) at tick 386 — and outcome **1** here against outcome **3**
   (`OUTCOME_ENRAGE`) in run 1, from the same code path, is the M1 claim demonstrated rather
   than asserted. It survived `commit_and_undelegate`: the base-layer arena reads
   `phase=3 outcome=1` after the accounts landed home in 3,580 ms.
5. **Per-seat damage accumulated, the leaderboard landed, and settling twice is a no-op.**
   1,160 + 3,720 + 5,060 + 3,860 = **13,800**, and the boss lost exactly **13,800** across
   nine parts and the core — not one point double-counted or lost, across 351 shots and 8
   deaths. Four rows written, `survived` false for the seat that was dead at settle time and
   true for the other three. The retried write left `total_written` at 14 and `next` at 14.
6. **Incarnation 2 exists, is harder, and rolls a different ruleset.**
   `request_roll` was accepted on the ER from a **zero-lamport session key** signing
   *writable* (it is the VRF request's payer) and fulfilled in **136 ms** — well inside the
   in-ER queue's documented ~100 ms and nowhere near `ROLL_TIMEOUT_TICKS`. Then:

   | | incarnation 0 | incarnation 1 |
   |---|---|---|
   | `phase` | SETTLED | LOBBY |
   | shell max | 18,000 | **20,700** (× 1.15, exactly `scale_for_incarnation`) |
   | core | 0 | 2,000 |
   | `affix_seed` | `045db6017f91518f…` | **`40d6859d998a0380…`** |
   | `next_affix_seed` | `40d6859d998a0380…` | zeroed |

   The new `affix_seed` is the VRF seed the oracle proved, moved across by
   `begin_next_incarnation` — so incarnation 2's ruleset is not a hash of
   `(program_id, arena, incarnation)` and is not the same fight again. That is M2 and M3
   closing on chain in one transaction.

### Rate, for whoever tunes this next

| | landed shots / tick |
|---|---|
| run 1, 2 seats, seats dying and re-walking with a blocking walk | 0.30 |
| run 1, 2 seats, both standing still | 0.74 |
| **run 5, 4 seats, non-blocking walk-back** | **1.10** |

343 landed shots is the floor for a clear at incarnation 0 (293 shell + 50 core). At 0.30 a
raid cannot finish inside the 900-tick enrage window; at 1.10 it finishes in 386 ticks with
57 % of the clock unused. **Nothing in the program changed between those numbers** — the
difference is entirely how much of the fight the players spend walking back from a door.

---

## 5. Findings

**B1 — the boss spawned inside a wall, and the win condition was unreachable.** §0. Fixed
at the source: `map::BOSS_SPAWN` is generated from the drawn `B` tile, `init.rs`'s literals
are deleted, and `map.rs` now fails to compile if the heart tile is a wall. This is the only
defect here that made the game unwinnable, and no amount of unit testing could have found
it — 54 tests passed against a boss at (512, 512) while the program spawned one at
(512, 320), because nothing compared the two and nobody had ever fought it.

**B2 — `gen_map.py` was validating against a fact it invented.** Its heart-tile check named
"the boss spawn `tick.rs::start_match` writes (ARENA_SIZE/2, ARENA_SIZE/2)". `start_match`
writes no position at all; the spawn was in `init.rs` and disagreed. A generator that
asserts against a constant it made up is worse than no assertion — it reads as coverage.
Removed; the tool now emits the value instead of checking a guess at it.

**O1a — a zero-lamport session key can sign the VRF request writable on the ER.**
`requestRoll`'s `session` meta is `WRITABLE_SIGNER` because the program forwards it as the
`RequestRandomness` payer, and the ER is documented as rejecting writable accounts it does
not hold delegated. It accepted it: `request_roll` confirmed in 410 ms and the oracle
fulfilled in **136 ms**. The design's claim that the killing blow's own browser can ask for
the roll, popup-free and unfunded, holds on devnet.

**O1 — SP1's rent top-up step is dead for arenas the current program creates.**
`init::er_clonable_rent` already funds each PDA to the ER cloner's schedule, so the deficit
computed at step [1] was zero for all three accounts on every run here. The Worker should
not carry a top-up path for accounts `init_arena` created.

**O2 — a respawn costs ~35 ticks, and that is the real difficulty knob.** `move` is one
accepted step per `Arena.tick` while fighting, and `tick::entrance_for` puts a dead player
back at a door 30-plus tiles from anywhere worth standing. At `shoot`'s one-per-two-ticks
cadence a death costs more shooting time than the 100 HP it took to inflict. Run 1 lost the
match to this and not to the boss. Nothing is wrong with either number in isolation; the
interaction is a balance decision that had never been observable before this run.

**O3 — `PHASE_LOBBY` is a free staging area, and the Worker should use it.**
`enter_gate` accepts `PHASE_LOBBY`, and `player::move_clock` runs off the ER's 50 ms slot
clock in that phase instead of the 400 ms tick. A raid can therefore be walked from the gate
onto its opening positions *before* `start_match`, at eight times the speed and at no cost
to the 900-tick enrage budget. Every run here did its whole setup that way.

**O4 — `settle` from `PHASE_FIGHTING` is the only recovery for an abandoned match, and it
works.** Runs 2 and 3 were killed mid-fight and brought home with tag 9 and tag 12
respectively, straight out of `Fighting`. Signatures in §3. Without the tag 11/12 builders
added this run, run 3's arena would have been a third stranded arena on devnet.

### For the frontend (do not apply here — `app/` is frozen)

**Nothing.** `app/src/render/Rig.tsx` already draws the boss from `boss.x`/`boss.y` read off
the account and `BOSS_ANCHOR_*`, so the spawn move needs no change there. The new
`BOSS_SPAWN` export in `packages/client/src/map.ts` is additive and collides with nothing;
`app/` typechecks clean and untouched against it.
