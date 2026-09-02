# chain-cost-archer — CU per instruction, archer slice vs the ELF live on devnet

Date: 2026-09-02. Instrument: `scripts/spike/cu-archer/` (mollusk-svm 0.15.1, Agave
solana-program-runtime 4.2.2). Raw output: `docs/perf/chain-cost-archer-run.txt`.

**Headline: the shipping gate passes with room to spare, and it passes by not moving.**
`boss_tick` is **byte-identical** between the two programs at every percentile, at 1 seat
and at 20, natural and pinned — worst tick 22,192 CU of 399,700 (**5.55 %, 18.0×
headroom**). It stays byte-identical with **20 seats firing continuously for 1,200
consecutive ticks**, and peak live bullets stays at 23 of `MAX_BULLETS` 128 in every
scenario. No player projectile enters the swept-collision loop, because none is allocated.

The entire on-chain cost of the archer slice is **+51 CU on an accepted `shoot`, +15 CU on
a refused one, and +48 CU on an accepted `join`**. `move` and `boss_tick` are +0.

---

## 0. What was measured, against what

| ELF | bytes | provenance | sha256 |
|---|---|---|---|
| TREE | 116,360 | `HEARTROT_TREASURY=FbDoanj… cargo build-sbf` on the working tree | `548e004f…` |
| DEVNET | 122,720 (115,425 before the account's trailing zero padding) | `solana program dump -u devnet JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, taken this session | `4e89e764…` |

The dumped ELF is confirmed **pre-archer by behaviour, not by assumption**: it accepts the
66-byte `join` arg block and refuses the 67-byte one (`InvalidInstructionData`, 124 CU),
while the tree does exactly the opposite (refuses 66 at 126 CU, accepts 67). It also
ignores `PlayerSlot` byte 3 — with the archer bit set on all twenty seats it still fires
3,000 shots per 1,200 ticks, the knight cadence, where the tree fires 1,700. That row is
§4's deploy-order warning turned into a measurement.

Both programs are driven with fixtures poured from the **tree's** structs. That is only
sound while the layout has not moved, so the run asserts it before measuring anything:

```
LAYOUT PlayerSlot 96 B, Players 1924 B, Arena 1200 B, Boss 50 B, LAYOUT_VERSION 1
```

`PlayerSlot` is **still 96 bytes**, `Players` still 1,924, `Arena` still 1,200,
`LAYOUT_VERSION` still 1. Rent-exempt minimums are unchanged (Arena 9,242,880 / Boss
1,238,880 / Players 14,281,920 lamports). **Rent delta for the whole slice: 0 lamports.**
`class_aim` is the old `_pad0` at offset 3 and nothing grew around it.

`cargo test -p heartrot` unit line: **104 passed** (the spec's gate is ≥97). The doc-test
line reads 0 passed / 1 ignored and is not the line.

Arena key: `4uQeVoH3NPX9vLdodsUJjXTNFnQptkqWRitPSaBspzr` (`ARENA_SEED=1`), both child PDAs
on bump 255. §5 covers the unlucky-bump arena, and the answer has changed since
`chain-cost.md`.

### Two build facts worth writing down

- `cargo build-sbf` **fails without `HEARTROT_TREASURY`** (`init.rs:134` const-asserts it),
  where `cargo check --workspace` passes — the assert is behind `cfg(target_os = "solana")`.
  The build command is `HEARTROT_TREASURY=FbDoanjAUonn5wM4KbRNS3jigHe6zDa4ThoEUKPnS7ka cargo build-sbf`.
- The build first failed with `rustc-LLVM ERROR: IO failure on output stream: No space left
  on device` — `/` was at 100 %. 1.6 GB was reclaimed from `~/.cache/solana/v1.52`, an
  unused platform-tools download (no `1.52` toolchain is registered with rustup; the active
  SBF toolchain is `1.89.0-sbpf-solana-v1.54`). It re-downloads on demand.

---

## 1. `boss_tick` — the shipping gate

1,200 consecutive ticks per case, state chained tick to tick. *Natural* lets a slam or a
volley take a seat out until the chain respawns it; *pinned* revives all twenty every tick
and pushes enrage out — the CU ceiling, not a plausible fight.

| seats | variant | min | p50 | p95 | **max** | max % of 399,700 | TREE vs DEVNET |
|---|---|---|---|---|---|---|---|
| 1 | natural | 3,414 | 4,139 | 5,655 | 5,836 | 1.46 % | **identical** |
| 1 | pinned | 3,450 | 4,544 | 5,739 | 5,839 | 1.46 % | **identical** |
| 20 | natural | 4,384 | 9,191 | 20,583 | 22,038 | 5.51 % | **identical** |
| 20 | pinned | 4,560 | 7,525 | 21,081 | **22,192** | **5.55 %** | **identical** |

Identical at every column, both seat counts, both variants. Peak live bullets 4 at one
seat, **23** at twenty, against `MAX_BULLETS = 128`.

**Whole-match budget.** `TICK_ITERATIONS` is now derived —
`(MUSTER_TICKS + ENRAGE_TICKS) * 5 / 4` = 4,750 against a 3,800-tick match, with a
const-assert that it outlives muster + enrage + the roll timeout. (The `4_500` literal and
its wrong comment that `chain-cost.md` §1 flagged are gone.) At 10 ticks/s: **75,250 CU/s
at p50, 221,920 CU/s at the ceiling**; over 3,800 ticks, **28.6 M CU at p50, 84.3 M at the
ceiling**. Solana's per-block limit is 100 M and the per-writable-account block cap 12 M;
at 400 ms slots the crank contributes ≈4 ticks ≈ 89 k CU per slot against `Arena`, 135×
under that cap.

### 1.1 The fight mix — 20 seats firing continuously, interleaved with the crank

1,200 ticks; after each tick all twenty seats pull the trigger, aimed at the boss. This is
the only scenario that could show a player projectile reaching the tick.

| | tick min | tick p50 | tick p95 | tick max | peak live bullets | shots accepted |
|---|---|---|---|---|---|---|
| crank alone, 20 pinned | 4,560 | 7,525 | 21,081 | 22,192 | 23 | — |
| **TREE, 20 knights firing** | 4,560 | 7,525 | 21,081 | 22,192 | **23** | 3,000 (25/s) |
| **TREE, 20 archers firing** | 4,560 | 7,525 | 21,081 | 22,192 | **23** | 1,700 (14.2/s) |
| DEVNET, 20 archers firing | 4,560 | 7,525 | 21,081 | 22,192 | 23 | 3,000 — byte ignored |

**Delta: zero, at every percentile, to the CU.** Every one of the 3,000 knight shots and
1,700 archer shots damaged the shell, so these are landed hitscan shots, not refusals
walking a guard path.

The shot counts are the class table falling out of the byte: 20 × (1,200/8) = 3,000 for the
knight's `ticks_for(800) − 1 = 7`, and 20 × ⌊1,200/14⌋ = 1,700 for the archer's
`ticks_for(1400) − 1 = 13`. **A full archer raid is 43 % fewer `Boss`-writing
transactions per second than a full knight raid** — the archer is cheaper on the ER, not
more expensive.

### 1.2 What an on-chain arrow would have cost, measured on this build

`N` live bullets re-pinned active before every tick, 120 ticks per row, 20 seats.
Identical on both ELFs.

| live bullets | 0 | 8 | 23 | 32 | 64 | 128 |
|---|---|---|---|---|---|---|
| p50 CU | 4,560 | 10,290 | 21,095 | 27,540 | 52,089 | 105,782 |
| max % of ceiling | 4.25 % | 5.69 % | 8.41 % | 10.05 % | 16.30 % | 29.73 % |

Slope **716–720 CU per live projectile per tick** up to 32, rising to 767 (32→64) and 839
(64→128) as the pool scan lengthens. This reproduces the spec's 718 on the shipping ELF.

So the counterfactual, labelled as arithmetic on measured slopes: the spec's ~31
concurrent arrows would put the worst tick at **22,192 + 31 × 718 ≈ 44,450 CU (11.1 % of
the ceiling)**, and a saturated 128-slot pool at 105,782 (26.5 %). **CU was never the
reason to refuse on-chain arrows** — flight latency was (§11 of the spec). This measurement
does not reopen that decision; it bounds what was declined.

---

## 2. `shoot` — the whole on-chain cost of the slice, and it is +51 CU

Same stand, same aim vector, one bit of `class_aim` different. Every row is 64 samples with
min = p50 = p95 = max: this instrument is deterministic, so a 51 CU difference is signal,
not noise.

| shot | TREE knight | TREE archer | DEVNET | delta |
|---|---|---|---|---|
| point blank, 40 u | 5,252 | **5,252** | 5,201 | **+51** |
| 120 u, hits | 7,572 | **7,572** | 7,521 | **+51** |
| 200 u, hits | 9,907 | **9,907** | 9,856 | **+51** |
| full miss, 64-step ray (worst shot in the game) | 14,080 | **14,080** | 14,028 | **+52** |
| refused by the rate limiter (guards only) | 796 | 796 | 781 | **+15** |
| typical in-fight shot (fight mix p50) | 1,963 | 1,963 | 1,911 | +52 |

**The two classes cost exactly the same CU.** They differ only in `CLASS_DAMAGE` and
`CLASS_COOLDOWN`, both const-table indexes on a `u8 >> 7` (total, so no bounds check).
The +51 is flat across every ray length, which is what a per-call constant looks like:
`class_of`, two table indexes, and `class_aim = (class_aim & CLASS_MASK) | encode_aim(dx, dy)`.
Seat count does not move any of it (1 seat and 20 seats are identical to the CU).

The worst shot is **14,080 CU = 3.52 % of 399,700** and **7.04 % of the default 200,000 CU
a client gets without a compute-budget instruction** — 14.2× headroom on the tighter of
the two.

The harness asserts after every one of its 1,024 accepted shots that `class_aim >> 7`
still reads the class it started with. `& CLASS_MASK` holds: the spec's single silent
failure did not happen.

---

## 3. `move` — untouched

| | 1 seat | 20 seats | rejected, 20 seats |
|---|---|---|---|
| TREE | 2,069 p50 / 2,070 max | 2,065 p50 / 2,071 max | 2,051–2,077 |
| DEVNET | 2,069 / 2,070 | 2,065 / 2,071 | 2,051–2,077 |

Identical, and flat in seat count. **+0 CU.** The class byte is not on `move`'s path.

---

## 4. `join` — the 66 → 67 byte ABI, priced

| case | TREE | DEVNET |
|---|---|---|
| 66-byte args | `InvalidInstructionData`, **126 CU** | `Ok`, **2,266 CU** |
| 67-byte args, class knight | `Ok`, **2,314 CU** | `InvalidInstructionData`, 124 CU |
| 67-byte args, class archer | `Ok`, **2,314 CU** | `InvalidInstructionData`, 124 CU |
| 67-byte args, all 20 seats taken | `SeatTaken` (Custom(3)), 2,198 CU | 2,179 CU on 66-byte args |

**Accepted-path delta: +48 CU** (2,314 vs 2,266), for the extra byte's length check, the
`class >= N_CLASSES` compare and the `set_class` write. Choosing the archer costs the same
as choosing the knight.

**The version skew is loud in both directions, which is what §5.4 of the spec asked for.**
An old client against the new program is refused at 126 CU before any account is touched;
a new client against the old program is refused at 124 CU. Neither misreads a byte. But the
third case is silent and is the one to watch: **the old program with a new client that
somehow gets a seat plays the archer as a knight** — DEVNET fired 3,000 archer shots per
1,200 ticks against the tree's 1,700, at the knight's 40 damage, while the browser would be
drawing an archer. That is exactly why `JOIN_DATA_LEN` moved, and why program + app + worker
are one indivisible deploy.

`class >= N_CLASSES` is refused, never clamped — covered by the unit tests
(`player.rs` asserts `N_CLASSES` and `N_CLASSES + 1` are both rejected), so it is not
re-measured here.

---

## 5. Correction: the arena bump lottery no longer taxes `shoot` or `boss_tick`

`docs/perf/chain-cost.md` §5.1 says a non-canonical child bump costs "+7,500 CU on every
shot and every crank tick". **That is no longer true on either current build.** Re-measured
on the same unlucky arena that document used (`11115C9XtokEDfJ8c2QonE7FDe7wevvZQztFGCA2LW`,
boss bump 251, players bump 254):

| instruction | bump 255/255 | bump 251/254 | delta |
|---|---|---|---|
| `shoot`, 120 u hit | 7,572 | **7,572** | **0** |
| `shoot`, refused | 796 | **796** | **0** |
| `boss_tick`, 20 seats pinned max | 22,192 | **22,192** | **0** |
| `move`, accepted p50 | 2,069 | **3,569** | **+1,500** |
| `join`, accepted | 2,314 | **3,814** | **+1,500** |

`shoot` and `tick` now verify their child PDAs with the account's own stored bump — one
`sol_sha256` instead of `find_program_address`'s search (`guards.rs:186`). `move` and
`join` still go through `player.rs::validate_pair`, which calls the searching `assert_pda`,
so they still pay ~1,500 CU per skipped candidate. Identical on both ELFs, so this predates
the archer slice.

**It is still worth grinding `arena_id` at creation** — `move` is the highest-rate
instruction in the game and +1,500 CU on it is +73 % — but it is a `move`/`join` argument
now, not a crank-safety one, and the worst tick is 22,192 regardless of which key the Worker
rolled. The "unlucky arena worst tick of ~32,000" in `chain-cost.md` is stale.

---

## 6. What this does not cover

- **`settle`, `roll`, delegation, `enter_gate`, `begin_muster` and the base-layer
  instructions** were not measured. Only the four the brief named plus the crank.
- **The ER's own CU accounting is assumed equal to Agave's.** `chain-cost.md` §0's
  calibration against devnet (four rows, good to ~6 %) is the evidence, and it is an
  inference. The *deltas* here are between two ELFs in one SVM and do not depend on it.
- **`shoot` write-to-visible has never been measured** at any seat count (spec §6.5). This
  document is CU only; it says nothing about latency.
- **Nothing here re-runs `er_guard`.** The chain half of the slice is +51 CU on `shoot`,
  four orders of magnitude under a millisecond of wall clock; the frame budget (spec §10.4)
  is the thing that can still degrade the ER, and it is off chain.
