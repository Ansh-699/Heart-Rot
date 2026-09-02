# chain-cost — CU, rent and crank budget for the immortals redesign

Date: 2026-09-02. Instrument: `scripts/spike/cu/` (mollusk-svm 0.15.1, Agave
solana-program-runtime 4.2.2), raw output in `docs/perf/chain-cost-run.txt`.

**Headline: `boss_tick` is not a shipping blocker. It got cheaper.** Worst tick observed
at 20 players on the redesigned program is **24,884 CU of 399,700 — 6.2 %, 16.1×
headroom**, against **26,033** for the program on devnet today. Every percentile moved
down, and p50 nearly halved (10,200 vs 19,459). The reason is `BULLET_UNITS_PER_SEC`
120 → 420: bullets clear the arena in about a third of the ticks, so the swept-collision
loop — the tick's dominant cost — walks far fewer live bullets per tick. The slam and the
`core_hp` top-up are noise beside that.

Two things *did* get more expensive, neither of them fatal, and one thing that has nothing
to do with the redesign costs more than either. All three are in §5.

---

## 0. What was measured, and against what

Two ELFs, same SVM, same accounts, same geometry:

| ELF | bytes | provenance |
|---|---|---|
| REDESIGN | 114,016 | `cargo build-sbf` on the working tree |
| DEPLOYED | 112,480 | `solana program dump -u devnet JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5` |

The dumped ELF is confirmed pre-redesign by behaviour, not by assumption: it accepts the
3-byte `shoot` payload `[tag, seat, dir]` that free aim replaced, and its first volley
spawns bullets at `|dx|+|dy| = 13–15` (`BULLET_SPEED` 12) against the tree's 49–50
(`BULLET_SPEED` 42).

### The tree does not build — measured with a 3-line shim

`cargo check --workspace` and `cargo build-sbf` both **fail** on the tree as it stands:

```
error[E0425]: cannot find function `begin_muster` in module `handlers::settle`
   --> programs/heartrot/src/lib.rs:169:32
```

`lib.rs` dispatches tag 3 to `settle::begin_muster`; `settle.rs:141` still exports
`start_match`. The phase-machine slice (spec §6.1) has not landed. Everything below was
measured on a scratchpad **copy** of `programs/` carrying one added alias
(`begin_muster` → `start_match`) so the crate compiles. No product code was modified. Tag 3
is not measured here and its cost is unknown; nothing else in this document depends on it.
`cargo test -p heartrot` cannot run for the same reason, so the "59 passed" baseline was
not re-established this session.

### Calibration against the real chain

The harness reproduces `docs/spikes/sp-load.md`'s devnet numbers for the same ELF, which
is why the redesign numbers can be trusted:

| instruction | devnet, 20 seats (sp-load §2) | this harness, DEPLOYED ELF | gap |
|---|---|---|---|
| `shoot` rejected (guards only) | 3,425 | **3,433** | +0.2 % |
| `move` accepted p50 | 1,933 | **2,049** | +6.0 % |
| `move` rejected | 1,896–1,901 | 2,055 | +8 % |
| `boss_tick` max | 28,586 | **26,033** | −8.9 % |
| `boss_tick` quiet floor | 6,818–6,884 | 7,212 | +5.8 % |

Read the redesign/deployed **deltas** as sound and the absolutes as ±10 %.

---

## 1. `boss_tick` — the crank, and the question that was asked

1,200 consecutive ticks per case, state chained tick to tick. Two variants: *natural* (a
slam or volley death takes a seat out until the chain respawns it) and *pinned* (all 20
revived every tick, `alive_count` held at 20, enrage pushed out — the CU ceiling, not a
plausible fight).

| program | seats | variant | min | p50 | p95 | **max** | max % of 399,700 |
|---|---|---|---|---|---|---|---|
| DEPLOYED | 1 | natural | 6,058 | 7,707 | 8,267 | 8,314 | 2.1 % |
| REDESIGN | 1 | natural | 6,086 | 6,812 | 8,328 | **8,508** | 2.1 % |
| DEPLOYED | 20 | natural | 7,212 | 21,471 | 25,399 | 25,642 | 6.4 % |
| REDESIGN | 20 | natural | 7,056 | 11,868 | 23,276 | **24,732** | 6.2 % |
| DEPLOYED | 20 | pinned | 7,242 | 19,459 | 24,810 | 26,033 | 6.5 % |
| REDESIGN | 20 | pinned | 7,232 | 10,200 | 23,776 | **24,884** | **6.2 %** |

**16.1× headroom at the worst tick.** Not a blocker, and there is no version of this
scenario that gets close: a tick would have to be 16× the worst one measured over 4,800
chained ticks.

Peak live bullets: 23 (redesign) vs 24–25 (deployed), both against `MAX_BULLETS = 128`.
At 420 u/s a volley clears the pit in 3–14 ticks against a 32-tick volley period, so
**overlapping volleys are now unreachable at any pit stand** — the 1.86× pool headroom the
spec claims is really more like 5×.

### Cost per second, which is where the redesign actually spends

`state::TICK_MS` went 400 → 100, so the crank fires 4× as often:

| | ticks/s | p50 CU/tick | **CU/s** | max CU/tick | ceiling CU/s |
|---|---|---|---|---|---|
| DEPLOYED (400 ms) | 2.5 | 19,459 | 48,648 | 26,033 | 65,083 |
| REDESIGN (100 ms) | 10 | 10,200 | **102,000** | 24,884 | 248,840 |

The tick got 48 % cheaper and the crank got 2.1× more expensive per second. That is a
validator-load statement, not a per-transaction-ceiling one; nothing in the measured data
says it is a problem, and no ER-side per-account throughput number exists to check it
against.

### `TICK_ITERATIONS` is 4,500 and its comment is wrong by 4×

`settle.rs:102`:

```rust
/// Ticks the crank is armed for. A match is bounded by `enrage_at_tick` (900 ticks =
/// 6 minutes), so this is 5× headroom.
const TICK_ITERATIONS: i64 = 4_500;
```

`ENRAGE_TICKS` is `ticks_for(360_000)` = **3,600**, not 900, and `MUSTER_TICKS` adds 200.
A match needs 3,800 ticks, so 4,500 is **1.18× headroom, not 5×**. The spec mandates the
derived `(MUSTER_TICKS + ENRAGE_TICKS) * 5 / 4 = 4_750`; the tree still carries the
literal. A crank **cannot be topped up** (`ScheduleTask` needs a writable signer and a
scheduled instruction carries none), so a match that runs to enrage and then spends more
than 700 ticks (70 s) settling goes inert with no error anywhere. Fix it in the same commit
as the muster; it is one line and it is not currently derived from anything.

Whole-match crank budget at 3,800 ticks, 20 seats: **38.8M CU at p50, 94.6M at the
ceiling.** Solana's per-block limit is 100M and the per-writable-account block cap is 12M;
at 400 ms slots the crank contributes ~4 ticks ≈ 100k CU per slot against Arena, 120×
under that cap. Not binding. (Whether the ER inherits either cap is still unverified —
same open question `research-program-cu.md` left.)

---

## 2. `move` — unchanged

| program | seats | p50 | max | rejected |
|---|---|---|---|---|
| DEPLOYED | 1 | 2,049 | 2,051 | 2,058 |
| REDESIGN | 1 | 2,052 | 2,053 | — |
| DEPLOYED | 20 | 2,049 | 2,051 | 2,055 |
| REDESIGN | 20 | 2,049 | 2,053 | 2,059 |

Flat in seat count, flat across the redesign: **+0.2 %**. The `PIT_TOP..=PIT_BOT` clamp is
two comparisons and the nearest-of-eight `octant` replaced `signum` at parity. A rejected
move still costs ~2,055, so the rate limiter remains the only thing standing between the
program and a free-transaction spammer — unchanged, and still the right place to look if
that ever matters.

---

## 3. `shoot` — the one instruction the redesign made materially more expensive

Same stand and the same aim vector for both programs, so this is a controlled comparison of
the raycast and nothing else. Canonical-bump arena.

| shot | DEPLOYED | REDESIGN | delta |
|---|---|---|---|
| guards only (rate-limited, no ray) | 3,433 | 3,452 | +0.6 % |
| point blank (40 u), hits | 4,232 | 7,872 | **+86 %** |
| 120 u, hits | 4,977 | 10,192 | **+105 %** |
| 200 u, hits | 5,722 | 12,527 | **+119 %** |
| **full miss, ray runs its whole budget** | 5,041 | **16,699** | **+231 %** |

`MAX_RAY_STEPS` went 20 → `map::MAP_TILES` (64) and the nine-rect scan grew with `SCALE=3`.
The worst shot in the game is **16,699 CU = 4.2 % of 399,700**, and 8.4 % of the default
200,000 CU per-transaction limit a client gets without a compute-budget instruction. Twelve×
headroom on the tighter of the two. Not a blocker.

The `SHELL_AABB` gate is doing its job and the numbers show it: a full 64-step miss costs
only 4,172 CU more than a 200 u hit that terminates in ~14 steps. Without the gate those 64
steps would each run nine rectangle tests.

Cost per shot is a clean linear function of ray length — 11.7 CU per unit of travel on the
redesign against 3.7 on the deployed program. Should §9.3's lever ever be pulled the other
way (`gen_hitboxes.py --scale 2`), this is the line that moves.

---

## 4. Rent — zero change, because the layout did not grow

`Arena.fight_at_tick` is claimed out of `_pad2` at offset 1164. `size_of::<Arena>()` is
still 1200 and the const-assert block in `state.rs:366-386` still compiles, so:

| account | bytes | rent-exempt minimum |
|---|---|---|
| `Arena` | 1,200 | 9,242,880 lamports |
| `Boss` | 50 | 1,238,880 |
| `Players` | 1,924 | 14,281,920 |
| **per arena** | **3,174** | **24,763,680 (0.0248 SOL)** |

**Rent delta for the whole redesign: 0 lamports.** No account grew, `LAYOUT_VERSION` stays
1, and there is no migration. (`PlayerSlot` is 96 bytes inside `Players`; a hypothetical
per-seat account would be 1,559,040 lamports each — 31.2M for twenty, +26 % over the
single-account design. Another reason §12.12's split stays cut.)

---

## 5. Three findings that are not about the redesign's new code

### 5.1 The arena PDA's bump is worth up to 7,500 CU per instruction

> **Superseded for `shoot` and `boss_tick` — see `docs/perf/chain-cost-archer.md` §5.**
> Both now verify their child PDAs with the account's own stored bump (one `sol_sha256`)
> and are flat at 7,572 / 22,192 CU on a 251/254 arena. `move` (+1,500) and `join`
> (+1,500) still pay the search. The "unlucky arena worst tick of ~32,000" below is stale.

`assert_pda` re-derives with `find_program_address`, which walks bumps down from 255 at
about 1,500 CU per rejected candidate. `shoot` does this twice (`boss`, `players`) and
`boss_tick` does it twice. Measured, identical scenario, two different arena keys:

| arena | boss bump | players bump | shoot guards | `boss_tick` 20 seats max |
|---|---|---|---|---|
| `4uQeVoH3NPX9vLdodsUJjXTNFnQptkqWRitPSaBspzr` | 255 | 255 | 3,452 | 24,884 |
| `11115C9XtokEDfJ8c2QonE7FDe7wevvZQztFGCA2LW` | 251 | 254 | **10,952** | **32,384** |

**+7,500 CU on every shot and every crank tick, decided by which `arena_id` the Worker
rolled.** Exactly 1,500 CU per skipped candidate, matching `tick.rs`'s own comment. This is
the largest single CU lever found this session and it needs no program change: grind
`arena_id` at creation until both child PDAs land on bump 255. About 65k candidate ids on
average, milliseconds in the Worker. It also means every CU number published for this
program — including sp-load's — is implicitly a number about one arena's bump luck.

Worst plausible tick therefore is not 24,884 but ~32,000 on an unlucky arena. Still 12.3×
headroom; still not a blocker.

### 5.2 `docs/spikes/sp-load.md`'s ABI table is wrong about `shoot`

It records `shoot` as `arena(r), boss(w), players(w)`. Both ELFs — the deployed one
included — **refuse** a `shoot` whose Arena meta is read-only (`Err(Immutable)`, 160–167 CU,
before any handler logic). `instructions.ts:610` already marks it `WRITABLE`. So this is not
a redesign regression; the table is stale.

It is still worth a look, though: `fire()` takes `&mut Arena` and only ever **reads**
`arena.tick`. Nothing in `shoot` writes the arena. Twenty shooters at one shot per 800 ms
plus a 10 Hz crank all take a write lock on the same 1,200-byte account for no write —
precisely the serialisation `move` was deliberately designed to avoid, and the thing
sp-load §1 measured as load-bearing. Changing `load_mut` to `load`, dropping Arena from the
`assert_writable` loop and flipping the meta to `READONLY` is a three-line change with a
measurable concurrency upside and no CU cost either way. Out of scope here; recorded so it
is not rediscovered.

### 5.3 The whole tick is bullets

Every number in §1 is dominated by the swept-collision loop over live bullets × arena
players. The redesign's win comes entirely from shortening bullet lifetime, and the quiet
floor (7,056–7,242 at 20 seats with no bullets in flight) is unchanged between the two
programs. If a future slice wants CU back, that loop is the only place worth looking, and
capping *drawn* bullets buys nothing on chain.

---

## 6. What this does not cover

- **Tag 3 `begin_muster` is unmeasured** — it does not exist in the tree yet (§0).
- **`settle`, `roll`, delegation and the base-layer instructions** were not measured. Only
  the three the brief named plus the crank.
- **The ER's own CU accounting is assumed equal to Agave's.** The calibration in §0 is the
  evidence for that and it is good to ~6 %, but it is an inference from four rows.
- **No live 20-seat devnet crank log was read this session.** R5 (a crank tick over budget
  deletes the task permanently) remains open in the sense that nothing here proves the ER
  meters the same way; what it does show is that the redesign moves the tick *away* from
  the ceiling, not towards it.
