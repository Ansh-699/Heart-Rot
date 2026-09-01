# SP-DEATH — death, respawn and wipe, on real devnet

Run: 2026-09-01, real devnet, real `devnet-as` ER. Script: `scripts/spike/sp_death.ts`.
Raw evidence: `sp-death-run-a.jsonl`, `-a2`, `-w1`, `-w2`, `-b` beside this file. Every
number below came out of an RPC response.

**Verdict: PASS with findings.** The losing half of the loop is real and it is on chain. A
player standing still is shot to death by the boss's own volley, respawns at the entrance
the map draws, exactly `RESPAWN_TICKS` after the tick it died on, and can neither move nor
shoot in between. A raid whose last live seat dies reaches `OUTCOME_WIPE` — a different byte
from `OUTCOME_WIN`. The six-minute deadline reaches `OUTCOME_ENRAGE`, a third byte. All of it
settles, and the outcome survives the commit back to the base layer.

**M4's losing half is discharged.** M1 is not: the outcome exists on `Arena` and is thrown
away at the one place it needed to last.

| # | Claim | Result |
|---|---|---|
| 1 | Boss bullets reach and kill a standing player | **YES** — first HP loss 17 ticks after entering, on the seat the boss declared as its target |
| 2 | A dead player respawns after the deadline, at a generated entrance | **YES** — `respawn_at_tick == death_tick + 8` every time, 6 deaths out of 6; return position exactly `entrance_for(seat)` |
| 2b | A dead player can neither move nor shoot | **YES** — both rejected `Custom(8)` `PlayerDead` |
| 3 | A raid whose seats all die reaches the wipe phase, distinct from a win | **YES** — `phase 2 / outcome 2` on the death tick, and `outcome 2` still reads on base after settlement |
| 4 | The enrage deadline produces its own outcome | **YES** — `outcome 3`, not 2 |
| 5 | A wiped arena settles, and the leaderboard records the loss | **SETTLES YES, RECORDS NO** — F1 |
| — | *(not asked)* two matches crank concurrently on one ER | **YES** — the aside under match B |

**F1** is the hole in M1 and the finding that matters. **F2** is three volley emitters buried
in rock, measured on chain, and it is what made the fight look broken for the first match.
**F7** is a leaderboard retry hazard caught live. F3–F6 are smaller, and F6 is a hypothesis
this spike raised and then refuted with its own data.

---

## The program moved under this spike, and that is load-bearing

The deployed program was verified byte-for-byte against the working tree before the first
run, not assumed:

```sh
solana program dump JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 /tmp/onchain.so -u devnet
head -c $(stat -c%s target/deploy/heartrot.so) /tmp/onchain.so | sha256sum
```

**It was then redeployed by a concurrent run (`sp-combat`) between this spike's first and
second matches.** That was found rather than announced: reading `Boss.x/y` back off each
settled account shows exactly where the split falls.

| build | sha256 (first 111,072 B) | `BOSS_SPAWN` | matches |
|---|---|---|---|
| X | `9d2e7c46…d355693a` | (512, 320) — tile (32, 20), inside the 2-tile north corridor | **A** `1788261694` |
| Y | `1ec66512…92a25a9c` | (512, 512) — the drawn `B` tile, centre of the heart chamber | **W1** `1788261985` · **W2** `1788262241` · **B** `1788262243` · **A2** `1788262840` |

`Boss.x/y` read back off the settled accounts: `512 320`, then `512 512` three times, then
`512 512` for A2. Build Y carries `sp-combat`'s fix for the boss-spawn defect that spike
documents; the two runs overlap there and it found it first. Build Y was still the deployed
build when A2 finished — re-checked.

**Consequence, stated up front:** every geometry-dependent number from match A describes a
boss that no longer exists, so match A was re-run in full as **A2** against build Y. Where
the two disagree, A2 is the number that counts, and A is kept because the disagreement is
itself the finding. Nothing about death, respawn, the outcome bytes, settlement or the
leaderboard differs between the builds.

---

## How it was run

```sh
cd /home/anshtyagi/Documents/pixel-artgame
./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/sp_death.ts --bundle --platform=node --format=esm \
  --alias:@heartrot/client=$PWD/packages/client/src/index.ts \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=/tmp/spd.mjs

node /tmp/spd.mjs --phase a --out /tmp/spd-a.jsonl                      # 3 seats: death, respawn, dead-probe
SPD_SEATS=0 SPD_STILL_MS=45000  node /tmp/spd.mjs --phase a --out /tmp/spd-w1.jsonl
SPD_SEATS=0 SPD_STILL_MS=1      node /tmp/spd.mjs --phase a --out /tmp/spd-w2.jsonl   # the WIPE
node /tmp/spd.mjs --phase b --out /tmp/spd-b.jsonl                      # empty arena: the ENRAGE
node /tmp/spd.mjs --settle-only <arenaId>                               # recover a crashed run
```

Every instruction is built by `packages/client` — `initArena`, `delegate`, `startMatch`,
`claimSeat`, `movePlayer`, `enterGate`, `shoot`, `settle`, `initLeaderboard`,
`writeLeaderboard`, plus `connectMatch`, `matchPdas`, `leaderboardPda`, `decodeArena`,
`decodeBoss`, `decodePlayers`, `decodeLeaderboard`, and the generated `isWall` /
`MAP_ENTRANCES` / `MUZZLES`. The only hand-encoded instructions are `SetComputeUnitLimit` and
System `Transfer`, neither of which the client claims to build. The client survived all of
it; nothing in it decoded wrong.

Three seats rather than one for the death runs, because of a rule of the program: a solo
occupant's first death **is** the wipe — `live_n` reaches 0 while `arena_occupants` is still
1 — so no respawn is observable in a one-player raid. That same rule is what makes the
one-seat run the deterministic way to drive a wipe, which is why `SPD_SEATS` exists.

**Where the boss stands is read off `Boss.x/y` on every poll, never from a constant in the
script.** The first version did hardcode it, and the mid-run redeploy then sent W1 to a spot
it believed was 3 tiles from the boss and which was 18. The harness reproduced, in miniature,
the exact fact-stored-twice failure it was sent to measure.

---

## A2 — three seats stand still at the north door (build Y, the shipping one)

`arena_id 1788262840`, arena `HsABaLztMpF3LwUFzhWZ5QTcvvLtWAd9mNk7N3xHaArB`.

| step | signature |
|---|---|
| init_arena (base) | `2hKWERAQsWYtbFCubY17G9CN4Ld17WfnR5MS3MapKrCpXwP7EYR12uTYmVcqwFtzv7TR9v4PXQHaNzUA8BDrpPA5` |
| delegate (base) | `3nKAFAChuBQkGDD4GKmF3dag4pck42HFWST9zNSumoVVunEkg5Mjc48jYfhGxTrAJPH9JpcnNLb9U36AwA7cssm2` |
| start_match (ER) | `5Xdb81NdBokYt7dGZjbdsc9XQcdw3ktWKydmcYZLDxwmaCFd4GhviFrDDdRxCzrFD7hGkkvZ67KbQfxirRkFji2x` |
| enter_gate ×3 (ER) | `4dujq4ivPKjEDsXvjJJ6GYZmz9YhCc98RDxAVHVHadp21eC9j2xvrpWdzh8kf6RLvmjtFzHREQ4cdB2QHZSXaYzR` |
| settle (ER) | `3dsfTwn8TeQhv5vi3zYcj9SK4mK8H3T3DGgUPfSBW2XzC1Ua1jfekTa8evDtq6TbYjGBPaMm3k5TZEjt8ZyEHoDB` |
| write_leaderboard (base) | `4XeQdnTJAeSVCYVieScrZuURVQ3njZmsHyCCysi4fn7z4fEyiPnFxvZQZzxZmCyP8a7LjN2NUbgEPu566N9foqXm` |

Seats 0, 4 and 8 all resolve to `ENTRANCES[0]` (`seat % 4`), so `enter_gate` put them at
`(464, 16)`, `(488, 16)` and `(512, 16)` — exactly the `entrance_for()` the script recomputes
from the generated `MAP_ENTRANCES`. Boss at `(512, 512)`, 496 units away down the north
corridor. Nobody moved again.

### Standing still at the entrance

```
tick  86   all three at hp 100, alive_count 3, boss target_seat 8
tick 103   seat 8 hp 92     first blood: 17 ticks / 6.7 s after entering — ON THE TARGET
tick 312   seat 8 hp 12     seats 0 and 4 still at hp 100 after 226 ticks
```

**Time to first blood standing still: 17 ticks (6.7 s).** The boss put seat 8 from 100 to 12
in 226 ticks (90 s) at the drawn entrance, 31 tiles away, without ever quite finishing it —
one bullet of a six-bullet volley connecting roughly every 20 ticks. The two bystanders on
the same row, 24 and 48 units to the left, took nothing.

That is the shape the design asks for: the boss aims at the nearest player and that player is
the one who suffers. It is also the opposite of what build X did (see match A), and the
difference is the whole of F2.

### Point blank, and three deaths

`SPD_STILL_MS` had elapsed with nobody dead, so the cluster walked down the corridor to
`(496, 464)` / `(504, 464)` — 48 units from the boss — and stood still there.

```
tick 391   seat 0 hp 0   respawn_at_tick 397   alive_count 2
tick 400   seat 4 hp 0   respawn_at_tick 406   alive_count 1
tick 400   seat 8 hp 0   respawn_at_tick 408   alive_count 1
```

No wipe, and that is correct rather than a miss: seat 0 respawned on tick 397, three ticks
before 4 and 8 died, so `live_n` was never 0. The wipe rule needs every occupant down on one
tick, which is why the deterministic wipe is a one-seat arena (W2).

### Respawn: configured 8 ticks, observed 8 ticks

| run | `respawn_at_tick` | first seen alive | return position | `entrance_for(seat)` |
|---|---|---|---|---|
| A seat 4 | 303 | 304 | (488, 16) | (488, 16) |
| A seat 4 | 483 | 485 | (488, 16) | (488, 16) |
| A seat 4 | 681 | 683 | (488, 16) | (488, 16) |
| A2 seat 0 | 397 | 397 | (464, 16) | (464, 16) |
| A2 seat 4 | 406 | 407 | (488, 16) | (488, 16) |
| A2 seat 8 | 408 | 410 | (512, 16) | (512, 16) |

`respawn_at_tick` is stamped on the tick the seat actually dies, so the invariant to check is
`respawn_at_tick == death_tick + RESPAWN_TICKS`, and it held in all six. **The `observed −
stamped` gaps in the log are polling artefacts and nothing else**: the sampler runs at 1.2 s
against a 400 ms tick, so it can see the corpse up to two ticks late and the respawn up to
two ticks late. In run A it happened to land exactly on the death tick three times and printed
a clean 8; in A2 it landed two ticks late twice and printed 6. The stamped deadline is the
program's number and the program was right every time.

Every return landed on `entrance_for(seat)` to the unit — the map's drawn door, not a second
copy of it.

### A dead player is inert

Sent from the dead seat's own session key, one tick after it hit 0 HP:

```
move  → {"InstructionError":["0",{"Custom":"8"}]}
shoot → {"InstructionError":["0",{"Custom":"8"}]}
```

`Custom(8)` is `HeartrotError::PlayerDead`. Both handlers reject before their rate limiter, so
a corpse cannot even burn its per-tick budget.

---

## A — the same experiment against build X, for contrast

`arena_id 1788261694`, arena `6wdYDHjx4uowNmayLVfBg3Zop6tqEwyCofbPJXYu2Pg7`.

| step | signature |
|---|---|
| init_arena (base) | `3caW9qDTnaQMPkjhw12mtDqRpAu7SRRZusp9w9gT7yPGKNnJnWTAh7wsGtVKTw3dmWGbAcXPegrxhuTrn6F1Pb2T` |
| delegate (base) | `5esP3qYMz3AjZj6U8mrDD6pHMx9podpwKxQ9Z9C3Bo7EfbhN1xQSWo8Nd8PPug2zEUnkjjhyRg83FtH96E5aBe5F` |
| start_match (ER) | `37KUha3y5FHizGkNKwwiUdgQDbZfjkZ6aWQZRAuC4J7XW8JdGjmJ6F72MK2JfRYjjDomxmw1QngSdkk2tBFiuuwC` |
| claim_seat 0,4,8 (ER) | `22Xw5PTnPxJGGG8nEB9odArowzfxooSTKpkCTpHmnNzewU1xGwE116VJsgXAnknxahBmHSaVBsMp8GXxX7cWremC` |
| settle (ER) | `2hUXpuYxiSeCwmmWQHnvsg95TZS5KvcwEoFpJJbdA7vpqyHh8e78i6XqvV1BYuRc9BHLCk6G4FQYfE2vepq13rRg` |
| write_leaderboard (base) | `TpYMd9YZYHntFyeAv6LH7NtEAQQS1BVRAgCJqST3Yz2Koyeskgg9TKvb8nJRE79UgzK9pkZ9YhVumA1sKN6oWHt` |

Identical setup and identical standing positions, boss at (512, 320).

```
tick  85   all three at hp 100, alive_count 3, boss target_seat 8
tick 109   seat 4 hp 92    first blood, 24 ticks after entry — on seat 4, a BYSTANDER
tick 295   seat 4 hp 0     210 ticks / 84.0 s after entry
tick 475   seat 4 hp 0     second death
tick 673   seat 4 hp 0     third death
tick 673   seat 8 hp 100   the seat the boss aimed at all match, 588 ticks, never touched
```

**Time to death standing still on build X: 210 ticks ≈ 84 s** — and on the wrong player.
The boss's declared target was never hit once in 588 ticks while the seat 24 units to its
left died three times, and `bulletsInWalls` — active pool entries standing on a solid tile —
peaked at exactly **4** of every 6-bullet volley.

Against A2's *first blood on the target in 17 ticks, and zero bullets in walls*, that pair is
the measurement of the boss-spawn fix, and the reason F2 is written the way it is.

---

## W — the wipe

### W1 — a match that measured the harness, not the program

`arena_id 1788261985`, arena `5dL6qPxHGkhJq3ZDNxztVja578ARjYHnRxtmR7rxKj3f`.
init `hTqQGEmkf7f3bHV2u83PocyY1oEBTePRgbMY4ZWEYbrig6jtsHURYpfEyU1RWHtXswnoNAdhjwsQqyyP4nq99DB` ·
settle `3hxYh3MautffNSPqQbGxBbEYSZFc8xdYKpJrEfk9Kqay17WRbeyujMehzgxajiUcwpRa1qFFkgLTrrhE41HPqmVS`.

One occupant, seat 0, `Boss.target_seat = 0` all match. It stood at
`entrance_for(0) = (464, 16)` for 114 ticks, then at `(464, 224)` for 359 more. Zero damage in
501 ticks, settled from `FIGHTING` with `OUTCOME_UNDECIDED`.

At the time that read as a defect. It is not. This was the first match on build Y and the
script still held a hardcoded `BOSS_SPAWN = (512, 320)`, so `(464, 224)` — which the script
called "6 tiles from the boss" — is 288 units from the real boss at (512, 512): 18 tiles,
out of the corridor and behind its mouth. **The harness was measuring its own stale copy of
the boss position.** The match is kept in the record because that is the lesson this whole
project is organised around, and because it is why the script now reads `Boss.x/y` off the
chain.

### W2 — the wipe

`arena_id 1788262241`, arena `DHuQoYTNHTKERif8dCHSAtu3i8aPTy4u2aCzBA83f7sE`.

| step | signature |
|---|---|
| init_arena (base) | `2vqPnexGNR9YLfmv1pZ6iDd4F2NaVHVEQ8Wx2onw4Ue4skLGjXvGi5TaoxoMnnqyRhyQZFDQjGg3aie3taznjwfQ` |
| delegate (base) | `5aGPELQgVNRLv8jmmhdWpvPYAThLhnaCUAoeu3BLPYsedo7hZU5Ft18jLrCjLCU3U87n8LwvQHBokvHgXJLFSkcZ` |
| start_match (ER) | `38zWdtQrf6sGwhVQu5e6XDb3tCLZx45BSCdYsvBJ5eSqevKRkmnJZHZW9h1BWLJNsPQ73njJYUczxCBDyyPpvSM7` |
| settle (ER) | `46kvhh3wcMPjScpYZ8dZXWhNjyus3P1t6doFhkRTJUMftg6ScuUSxmm3kbhnydc7U1DgR6DfgKdekNTZgC4kiJLY` |
| write_leaderboard (base) | `4CaSgB915oPdPwkkXP1cC7fokoU6BQfcmo1Fb2MiPCSRghVY4jnQjHevcviS2HmCWAUe4DKpWDSCG6BiBnzNkrPy` |

One seat, walked to `(496, 272)` — 240 units up the north corridor from the boss, with the
corridor as a clear firing lane. It started losing HP 66 ticks later and died 326 ticks after
entering.

```
tick 411   seat 0 hp 0, deaths 1, respawn_at_tick 419, alive_count 0
tick 411   phase 2 (SETTLING)   outcome 2 (WIPE)
tick 415   on base, after settle: phase 3 (SETTLED)   outcome 2 (WIPE)   owner = the program
```

**`OUTCOME_WIPE` on chain, on the tick the last live seat died, and it is not
`OUTCOME_WIN`.** The outcome byte survived the commit and the undelegation — it still reads 2
on the base-layer account. That is the whole argument for `outcome` being a field on `Arena`
rather than a phase, and it holds.

The dead-seat probe at this moment returned `Custom(6)` `WrongPhase` rather than `Custom(8)`
`PlayerDead` — correctly, and worth recording: the wipe had already moved the arena to
`SETTLING` on the same tick, and `assert_playable(arena.phase)` is checked before the seat's
HP. **A wiped arena is closed to every player action, not only to dead ones.**

The leaderboard row for the wipe reads `survived: false, damageDealt: 0, incarnation: 1` —
and nothing else. See F1.

### W3 — a solo raid can never respawn

Both one-seat matches make the rule visible. `arena_occupants > 0 && live_n == 0` is
evaluated on the same tick the death is written, and a lone occupant satisfies both halves the
instant it dies. `respawn_at_tick` was stamped (419 = 411 + 8) and the crank never reached it,
because `heartbeat` returns `false` outside `PHASE_FIGHTING`. Design spec §3 promises "dead
for 3 seconds → respawn"; for a solo player the program ends the match instead. F3.

---

## B — the enrage deadline

`arena_id 1788262243`, arena `AEYVxhMcri8hr7bBcBTFUmw47J3igUim7ZYP57iA6VE7`.

| step | signature |
|---|---|
| init_arena (base) | `5qDnt9aXoM8YB21uEWitE4FckKaLkLHbLz6GTbpZSUmx6vn9ZUdLiw1q1c7V6My5QVKiWvPnqpJvX7VRkkHdJgLW` |
| delegate (base) | `4MADcCxSh31HHAiTzEGgUWrqDNVNvvimo1ZL42KVWet59LkXUYBerWyhXdNyMVbANWoqj3Z7vqw3oiy2gug1n3Ht` |
| start_match (ER) | `NQZ75waMcjbDTajytHHF9RPGrRwxUe6hzXtTS6cEcueoPCHkEqmmmeKV8NU6RWDoTvJEbrjcWxX97m73SBMMfHm` |
| settle (ER) | `3MKUvhodt5UkrSi55WtGSXHZFboQ6N9zSHCwaqxahSPyw6H56B1HxgAf9SLPNmW2ZAa9BK13XSAzh1UdHbUPpws2` |

An arena nobody enters, so `arena_occupants == 0` makes the wipe branch structurally
unreachable and `enrage_at_tick` is the only ending left. That is what makes the outcome byte
a clean read of the enrage path alone.

```
tick   1 .. 887   phase 1 (FIGHTING)  outcome 0  alive_count 0  0 bullets   30 samples
tick 913          phase 2 (SETTLING)  outcome 3 (ENRAGE)
```

`init_arena` writes `enrage_at_tick = 900`; the first sample past it read `OUTCOME_ENRAGE`.
**It is 3, not 2 — the enrage and the wipe are different bytes**, which is the entire point of
the pair. The arena ticked for six unattended minutes with an empty pool and no target and
then ended itself with no transaction from anybody. `settle` from `SETTLING` was accepted and
left `outcome` alone, exactly as `PHASE_EDGES` says.

### An aside worth recording

This arena and the W2 arena ran **concurrently** on `devnet-as` — two independent crank tasks,
11:30:46 to 11:33:44. Neither missed a tick and neither `task_id` collided with the other. Two
matches on one ER is not something a previous spike had shown.

---

## Bullets and walls

Across all five matches, sampled every 1.2 s: **`bulletsOffMap` was 0 at every sample.** No
active bullet was ever outside `0..=1023` on either axis. Volleys stay inside the dungeon.

`bulletsInWalls` — active bullets standing on a tile the client's generated bitboard calls
solid — was **0 at every sample on build Y**, and peaked at **4 per 6-bullet volley on build
X**. Those four were not bullets that flew into rock; they were bullets *spawned* in rock, at
the three muzzles buried by the old boss position. `tick::step` clears them on the following
tick because its wall test samples the step's midpoint and endpoint. The wall collision itself
works; F2 is about where the volley starts, not where it stops.

---

## Findings

### F1 — the leaderboard cannot tell a loss from a win (open; M1 is only half done)

`Arena.outcome` works and survives settlement — proved above. **It never reaches the durable
record.** `LeaderboardEntry` is
`{ arena_id, identity, damage_dealt, incarnation, survived, _pad0 }`, and
`settle::append_results` computes `survived: u8::from(slot.hp != 0)` and nothing else.

The ring, read off base (`3jG6jGcvrhaS6J9r2e8xPB1DEHVvTxr4fRHiHn592Rcg`), after the first four
matches:

```
totalWritten 7  next 7  last_arena_id 1788262243  last_incarnation 1
0  arena 1788261694    inc 1  dmg    0  survived true    <- A,  three deaths on seat 4
1  arena 1788261694    inc 1  dmg    0  survived true
2  arena 1788261694    inc 1  dmg    0  survived true
3  arena 1788261985    inc 1  dmg    0  survived true    <- W1, operator-cut
4  arena 1788262241    inc 1  dmg    0  survived false   <- W2, the WIPE
5  arena 1788262121955 inc 0  dmg 5740  survived true    <- another run's match
6  arena 1788262121955 inc 0  dmg 6280  survived true
```

A2 then added three more rows, all `survived: true` — for a match with **three deaths in it**.

Ten rows. Eight say `survived: true`. **Nothing in the ring says which of them was a win.** An
`OUTCOME_ENRAGE` with survivors and an `OUTCOME_WIN` produce byte-identical rows: everyone
alive, everyone `survived: true`. "You ran out of time" and "you killed the core" are the same
record.

`Arena.outcome` is not a fallback for this, because `begin_next_incarnation` sets it back to
`OUTCOME_UNDECIDED` — one `next_incarnation` and the only copy of the result is gone.
`PlayerSlot.deaths` has the same shape of problem: it was maintained correctly on chain (it
read 3 for seat 4 in match A) and is discarded at settle time, so a raid that died nineteen
times and one that was never touched write the same row.

**Fix, and it costs nothing.** `LeaderboardEntry._pad0` is a free byte at offset 47,
immediately after `survived`. Rename it `outcome` and write `arena_state.outcome` into it in
`append_results`, which already holds the `Arena`. No field moves, the struct stays 48 bytes,
the account stays 6,176, and every row already on chain reads 0 — `OUTCOME_UNDECIDED`, the
honest reading for a row written before the field existed. The client side is one line in
`LEADERBOARD_ENTRY.offsets` and one in `decodeLeaderboard`. **Nothing in `app/` changes:**
`app/src` never touches the leaderboard at all and `worker/src/routes.ts` reads only
`lastArenaId`. `LeaderboardEntry` gains a field; it loses none.

### F2 — three of the four volley emitters were inside solid rock (fixed on build Y; the hole that let it happen is not)

Measured with the client's own generated `isWall` and `MUZZLES`, at build X's
`BOSS_SPAWN = (512, 320)`:

```
muzzle part=3 (506,231) tile(31,14) inWall=false
muzzle part=4 (601,254) tile(37,15) inWall=TRUE
muzzle part=5 (492,294) tile(30,18) inWall=TRUE
muzzle part=6 (612,320) tile(38,20) inWall=TRUE
```

and at build Y's `(512, 512)`: tiles (31,26), (37,27), (30,30), (38,32), **all floor**.

The behavioural difference, same script, same seats, same standing positions:

| | build X (A) | build Y (A2) |
|---|---|---|
| first blood | tick +24, on seat 4 — a bystander | tick +17, on seat 8 — **the declared target** |
| the target seat | 588 ticks, never touched | 100 → 12 in 226 ticks |
| bullets standing in walls | 4 per volley | 0, every sample |

`sp-combat` found and fixed the root cause: the boss spawn was the map's `B` tile stated three
times and twice wrongly. The residual defect belongs to this spike: **`spawn_volley` never
wall-tests a muzzle.** Its only gate is `boss.parts[part] != 0`, so the next boss move, art
re-slice or second map silently re-creates it. One condition, inside a loop that already
exists, closes it permanently:

```rust
if boss.parts[part] != 0 && !wall_at(boss.x as i32 + x, boss.y as i32 + y) {
```

### F3 — a solo raid ends instead of respawning

Not a code bug — it is exactly what `arena_occupants > 0 && live_n == 0` says — but it
contradicts design spec §3 in the case a new player is most likely to meet: alone in a test
arena. `RESPAWN_TICKS` is unreachable below two occupants, and the stamped `respawn_at_tick` is
never read because `heartbeat` stops the fight first. Either the spec's "dead for 3 seconds →
respawn" is a raid-only promise and should say so, or the wipe rule needs a one-tick grace.
Worth a decision rather than a surprise in a demo.

### F4 — the ER renders `Custom` as a string, the base layer as a number

```
{"InstructionError":["0",{"Custom":"8"}]}
```

Both the instruction index and the error code come back as JSON **strings** from the ER's
`getSignatureStatuses`, where devnet returns numbers. A client recognising its own error codes
with `err.InstructionError[1].Custom === 8` matches nothing on the chain the game actually runs
on. This spike's first version had exactly that bug and logged `moveRejected: false` while
holding the correct error in its hand. Nothing in `packages/client` decodes instruction errors
yet, so this is a trap laid for whoever adds it rather than a live defect.

### F5 — `confirmSignature` is still unusable on the ER (M6, third spike running)

Two independent reasons, both hit again here: it insists on `confirmed`/`finalized`, which the
ER may never report, and it `JSON.stringify`s a status object kit fills with bigints, so it
throws `TypeError: Do not know how to serialize a BigInt` instead of surfacing the on-chain
error. SP1 hit it, SP2 hit it, this one hit it. Every spike now carries its own copy of a status
poller — the fact-stored-thrice shape this project keeps re-buying. The fix belongs in
`connection.ts`: a `replacer` that stringifies bigints, and an ER-aware accepted commitment.

### F6 — the bullet's wall test pre-empts its player test (source-level; NOT what was measured)

`tick::step` §2:

```rust
let mid = ((from.0 + to.0) / 2, (from.1 + to.1) / 2);
if wall_at(mid.0, mid.1) || wall_at(to.0, to.1) {
    bullet.active = BULLET_FREE;
    continue;                       // the player sweep below never runs
}
```

The player test is a swept test over `from → to`. The wall test runs first and `continue`s, so
a bullet whose step *ends* in a wall is deleted without being compared against the players it
crossed on the way. A player standing within one 48-unit step of a wall is therefore immune to
any bullet whose step would carry it into that wall — and `entrance_for` puts every respawn one
tile from the border ring.

**This was this spike's leading hypothesis for match A's "the target is never hit", and A2
refuted it**: on build Y the same seat, at the same wall-adjacent tile, is hit first and
hardest. So the ordering is a real hazard in the code and it is *not* the cause of anything
measured here. Recorded at that weight and no higher.

The cheapest thing that would settle it, and which should exist regardless: a `tick.rs` unit
test that puts a player one step in front of a wall, a bullet one step behind the player, ticks
once and asserts the player took `BULLET_DAMAGE`. The existing `damage_kills_respawns_and_wipes`
hand-places its bullets in open floor, so it passes either way.

### F7 — `write_leaderboard` burns the idempotency key even when it writes no rows

Rows 5 and 6 of the ring dump above belong to another spike's match running concurrently against
the same program: the `Leaderboard` is a program-wide singleton and every match on devnet shares
it. That part is by design. This part is not:

**Match B's arena had no claimed seats, so `append_results` appended nothing — and still stamped
`last_arena_id = 1788262243, last_incarnation = 1` over the other match's key.** A legitimate
retry of *that* match's `write_leaderboard` — which the settle route is designed to do, because
`GetCommitmentSignature` throws on every failure path and a throw means *unknown*, never
*failed* — would now find a different key and append its two rows a second time. The guard exists
precisely to stop that.

The `ponytail:` note on `Leaderboard.last_arena_id` already concedes the out-of-order case ("that
cannot happen while one Worker settles one match at a time"). Two matches settling in any
interleaved order is enough, and a devnet carrying more than one run at a time is the normal
condition, not the exotic one. The zero-row case makes it strictly worse: an arena that recorded
nothing at all still spends the key.

Smallest fix that holds: count the appended rows and return `false` without touching
`last_arena_id` / `last_incarnation` when the count is zero. One counter, and it closes the
"recorded nothing, claimed the key" case outright. The general out-of-order case still needs the
ring scan the existing note already names as its upgrade path.

---

## Housekeeping

All five arenas were settled and undelegated; no crank was left armed and no arena was stranded.
`sp_death.ts --settle-only <arenaId>` is the recovery path if a future run aborts between
`delegate` and `settle`.

Treasury: 0.718 SOL before, 0.343 SOL after five matches — ~0.075 SOL per match, most of it
delegation escrow returned on undelegation.
