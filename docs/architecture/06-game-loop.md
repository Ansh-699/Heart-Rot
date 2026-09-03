# HEARTROT — The Game Loop

**Date:** 2026-09-01
**Status:** Contract. Every handler, the Worker and the client code against this.
**Implemented by:** `programs/heartrot/src/state.rs` (the machine and the layout) and
`packages/client/src/layout.ts` (its mirror). Supersedes nothing in
`04-layout-contract.md` except the `Arena` and `PlayerSlot` rows, which grow — see §7.

---

## 0. What was missing, and the shape of the fix

Before this document the program had four phases — `LOBBY`, `FIGHTING`, `SETTLING`,
`SETTLED` — and no way to say that a raid **won**. A raid that killed the core and a raid
that was wiped landed in the identical state, so there was no win condition anywhere in the
program, no path to a second incarnation, and `affix_seed` was a deterministic hash of
`(program_id, arena, incarnation)` — meaning every incarnation of the boss was, byte for
byte, the same fight.

Three facts drive the whole design below:

1. **A phase cannot carry the outcome.** "Did the raid win?" has to stay answerable after
   settlement — the end screen asks it, the leaderboard asks it, and the decision to roll a
   next incarnation asks it. Encoding it in `phase` needs a `SettledWon` / `SettledWiped`
   pair and then a third value for every phase after. So `phase` says *where the match is*
   and a new `outcome` byte says *how the fight ended*. One axis each.
2. **A crank may carry no writable signer, so the crank cannot request VRF.** The
   validator rejects any scheduled instruction with a signer other than the read-only
   `crank_signer` PDA; the VRF request needs `payer` as a writable signer. The request
   therefore originates from a *player* transaction — the raid asks for its own next boss.
3. **A VRF callback that returns `Err` is a retry loop, not a dropped roll.** The VRF
   program invokes the callback with `?` inside its own `ProvideRandomness` transaction, so
   an error reverts that transaction *including the queue removal* and the oracle retries
   until the 240-slot TTL expires. Every consume path here is total by construction.

---

## 1. The loop, end to end

```
                       ┌──────────────────────────────────────────────┐
                       │                                              │
                       ▼                                              │
   ┌───────┐  tag 3  ┌──────────┐                                     │
   │ LOBBY │────────▶│ FIGHTING │                                     │
   └───────┘ start   └──────────┘                                     │
       ▲              │   │   │                                       │
       │              │   │   └──── tag 9 settle ──────┐  dead-crank  │
       │              │   │                            │  recovery    │
       │   core_hp=0  │   │  everyone dead / enrage     │              │
       │   tag 7 or 8 │   │  tag 8                      │              │
       │              ▼   ▼                             │              │
       │          ┌───────────┐                         │              │
       │          │ SETTLING  │  outcome is now fixed   │              │
       │          └───────────┘                         │              │
       │            │       ▲                           │              │
       │  outcome   │       │ tag 8, after              │              │
       │  == WIN    │       │ ROLL_TIMEOUT_TICKS        │              │
       │  tag 13    ▼       │ (no seed written)         │              │
       │          ┌───────────┐                         │              │
       │          │  ROLLING  │  VRF request in flight  │              │
       │          └───────────┘                         │              │
       │                │                              │              │
       │        tag 14  │ callback, scoped identity     │              │
       │                ▼                              │              │
       │          ┌───────────┐                         │              │
       │          │  ROLLED   │  next_affix_seed set    │              │
       │          └───────────┘                         │              │
       │                │                              │              │
       │        tag 9   │ settle: cancel crank,        │              │
       │                │ commit + undelegate ◀────────┘              │
       │                ▼                                             │
       │          ┌───────────┐   tag 10  write_leaderboard (base)    │
       │          │  SETTLED  │───────────────────────────────────────┘
       │          └───────────┘   then tag 15 next_incarnation
       │                                (needs a seed, or it refuses)
       └────────────────────────────────────────────────────────────────
```

The base-layer tail after `SETTLED` is: `write_leaderboard` (tag 10) → `next_incarnation`
(tag 15) → `delegate` (tag 2) → `start_match` (tag 3), and the arena is fighting again as
incarnation N+1 in the same three accounts.

---

## 2. Two axes, not one

| | Field | Offset | Values | Written by |
|---|---|---|---|---|
| Where the match is | `Arena.phase` | 3 | `PHASE_*`, 0–5 | every transition below |
| How the fight ended | `Arena.outcome` | 6 | `OUTCOME_*`, 0–3 | `Arena::end_fight`, once |

```
PHASE_LOBBY     = 0     OUTCOME_UNDECIDED = 0   the fight is not over
PHASE_FIGHTING  = 1     OUTCOME_WIN       = 1   core HP reached 0
PHASE_SETTLING  = 2     OUTCOME_WIPE      = 2   every arena occupant dead at one tick
PHASE_SETTLED   = 3     OUTCOME_ENRAGE    = 3   enrage_at_tick passed, core alive
PHASE_ROLLING   = 4
PHASE_ROLLED    = 5
```

Phase values 0–3 are **frozen** — accounts are live on devnet and both `packages/client`
and `app/` switch on them. 4 and 5 are appended, so a `switch` that only knows the first
four keeps compiling and falls to its default for the ~10 s of a roll. That default should
render the design's "the heart reforms" beat, not an error.

`outcome` was claimed out of `Arena._pad0`. No field moved, the account did not grow at that
offset, and every arena already on chain reads 0 there — which decodes as
`OUTCOME_UNDECIDED`, the correct reading for a match that has not ended. `OUTCOME_ENRAGE`
is kept separate from `OUTCOME_WIPE` even though both score as a loss: "you ran out of time"
and "you all died" are different sentences on the end screen and nothing else on chain can
tell them apart afterwards.

---

## 3. Every legal transition

The canonical table is `PHASE_EDGES` in `state.rs`, walked over the full 6×6 product by
`state::tests::only_declared_transitions_are_legal`. **An illegal transition is rejected
with `HeartrotError::WrongPhase` (`Custom(6)`), never ignored.**

| # | From | To | Trigger | Handler / tag | Layer |
|---|---|---|---|---|---|
| 1 | `LOBBY` | `FIGHTING` | operator starts the match | `settle::start_match`, tag 3 | ER |
| 2 | `FIGHTING` | `SETTLING` | killing blow lands on the core | `shoot::process`, tag 7 | ER |
| 3 | `FIGHTING` | `SETTLING` | core dead / wipe / enrage observed | `tick::process`, tag 8 | ER |
| 4 | `FIGHTING` | `SETTLED` | dead-crank recovery | `settle::settle`, tag 9 | ER |
| 5 | `SETTLING` | `ROLLING` | a seated player asks for the next boss | `roll::request_roll`, tag 13 | ER |
| 6 | `SETTLING` | `SETTLED` | normal settlement | `settle::settle`, tag 9 · `delegation::process_commit_and_undelegate`, tag 12 | ER |
| 7 | `ROLLING` | `ROLLED` | VRF fulfilment | `roll::consume_roll`, tag 14 | ER |
| 8 | `ROLLING` | `SETTLING` | no callback within `ROLL_TIMEOUT_TICKS` | `tick::process`, tag 8 | ER |
| 9 | `ROLLED` | `SETTLED` | settlement after the roll | `settle::settle`, tag 9 | ER |
| 10 | `SETTLED` | `SETTLED` | retried settle; undelegation callback | tag 9 · tag 12 · the delegation program's callback | ER / base |
| 11 | `SETTLED` | `LOBBY` | respawn the boss as incarnation N+1 | `init::next_incarnation`, tag 15 | base |

Two edges carry a condition the table cannot express, because **the state is the triple
`(phase, outcome, next_affix_seed)`**:

- **#5** additionally requires `outcome == OUTCOME_WIN`. A wipe earns no roll.
- **#11** additionally requires a non-zero `next_affix_seed`. No seed, no next incarnation.

Both refuse with the same `WrongPhase`. That is not misrouting: "this instruction is not
legal from this state" is one condition, and the *reason* is readable straight off the
account the caller already passed — `outcome` says the raid wiped, an all-zero
`next_affix_seed` says the oracle never answered. A second error code would carry no
information the caller does not hold. (If a dedicated code is wanted later, §9 names it.)

### The absences that carry weight

| Missing edge | Why |
|---|---|
| `ROLLING → SETTLED` | Committing and undelegating while a callback is in flight lands that callback on an account the ER no longer holds. It fails, and the oracle retries it for the request's whole 240-slot TTL. An operator who needs to settle a stuck roll waits `ROLL_TIMEOUT_TICKS` for the crank to abandon it first. |
| `LOBBY → LOBBY` | This is the incarnation counter's mutex. See §4. |
| `LOBBY → SETTLED` | An arena that was never fought has nothing to record — the rule `settle` already enforces today. |
| `FIGHTING → FIGHTING` | A second `start_match` would schedule a second crank against the same accounts, doubling the tick rate, and would mint a second `task_id` over the first — stranding the original task where `settle` can no longer cancel it. |

### The four methods, and why phase is never assigned directly

Every phase write goes through one of these. Assigning `arena.phase = X` in a handler is how
five separately-owned files come to disagree about what a phase permits.

```rust
Arena::try_set_phase(&mut self, to: u8) -> Result<(), ProgramError>
Arena::end_fight(&mut self, outcome: u8) -> bool          // total
Arena::begin_roll(&mut self) -> Result<(), ProgramError>
Arena::accept_roll(&mut self, seed: &[u8; 32], for_incarnation: u16) -> bool   // total
Arena::abandon_roll(&mut self) -> bool                    // total
Arena::begin_next_incarnation(&mut self) -> Result<u16, ProgramError>
```

The three `bool` returns are total on purpose. `end_fight` and `abandon_roll` are called
from `boss_tick`, which may never return `Err` — ten consecutive failures move the task to
`failed_tasks` ~26 s into the match and it never ticks again. `accept_roll` is called from
the VRF callback, where an `Err` is a two-minute oracle retry loop.

`end_fight` is also **idempotent**, and that matters: `shoot` and `boss_tick` can both
observe the end of the fight inside the same 400 ms window, and the *first* one is the true
one. A killing blow recorded by the killer must not become an enrage recorded by the crank
one tick later, so the second caller writes nothing and gets `false`.

---

## 4. The incarnation model

### Same accounts, in place

Incarnation N+1 reuses **the same `Arena`, `Boss` and `Players` accounts**, reset in place
by tag 15 on the base layer. It does not create new ones.

- No new rent. Fresh accounts would cost 0.0245 SOL of rent *per incarnation* and orphan the
  old ones, since nothing closes them.
- The `Arena` PDA is `[b"arena", arena_id]`, so reuse keeps one address per raid chain and
  the Worker keeps handing out the id it already knows.
- The `Leaderboard`'s idempotency key is already `(arena_id, incarnation)` and its own test
  already asserts *"a different incarnation of the same arena is a different match"*. The
  ring was designed for exactly this and needs no change.
- The seed for the next fight is already sitting in the account. No cross-account read, no
  extra meta on tag 1, no `Option`-shaped account.

### What carries over, what resets

| | Field |
|---|---|
| **Carries over** | `Arena`: `arena_id`, `bump`, `crank_authority`, `validator_identity`, `enrage_at_tick`, `crank_task_id` (overwritten by `start_match` anyway). And the whole `Leaderboard` — a base-layer account tag 15 never touches, holding one row per player per incarnation keyed on the durable `identity`. **That is the entire carry-over model.** |
| **Resets** | `Arena`: `phase → LOBBY`, `outcome → UNDECIDED`, `tick → 0`, `alive_count`, `bullet_cursor`, `seat_occupied`, all 128 bullets, `roll_requested_tick`. `Boss`: `parts` and `parts_max` rescaled for the new incarnation, `core_hp`/`core_hp_max` restored, `vent_open`, `attack_timer`, `target_seat → NO_TARGET`, position. `Players`: **every seat zeroed**. |

Seats do not carry over. A seat is a session key plus a live position and both are stale by
the time a raid respawns — the browser that held the key may be closed — while
`/session/init` is already idempotent per `identity`, so a returning player is re-seated for
free by the path that seats everyone else. Carrying them would mean `Arena.seat_occupied`
and `PlayerSlot.session_pubkey` disagreeing the moment one player does not come back, with
no instruction able to notice.

The reset lives in three methods next to the structs, so "which fields reset" is one fact:

```rust
Arena::begin_next_incarnation(&mut self) -> Result<u16, ProgramError>
Boss::reset_for_incarnation(&mut self, parts: [u16; N_PARTS], core_hp: u16, x: i16, y: i16)
Players::reset_for_incarnation(&mut self)
```

`Boss::reset_for_incarnation` takes already-scaled numbers rather than computing them:
`handlers::init` owns `BOSS_PARTS_BASE` and `scale_for_incarnation`, and a second scaling
site would be the balance table stored twice — a boss that is one difficulty curve when a
match is created and another when it respawns. `state.rs` owns *which fields reset*;
`init.rs` owns *what the numbers are*. Part HP keeps scaling `× (1 + incarnation × 0.15)`,
in integers, saturating at `u16::MAX` around incarnation 41.

### Where the counter lives, and why two matches cannot race it

`Arena.incarnation` (u16, offset 36) is the only counter. It is **per-arena, not global** —
resolving the open item in the design spec §12. There is no global counter to contend on,
and a global one would be a single account every settlement in the system writes.

Advancing it happens only inside `begin_next_incarnation`, which runs only from `SETTLED`
and leaves `LOBBY` in the same instruction. `LOBBY → LOBBY` is not a legal edge, so a second
concurrent `next_incarnation` is rejected with `WrongPhase` rather than advancing twice.
Solana serialises writes to one account, so that is a real mutex and not a hope.

Ordering against the leaderboard is the other race, and it destroys data rather than merely
duplicating it: `write_leaderboard` is gated on `phase == PHASE_SETTLED`, and tag 15 flips
the phase to `LOBBY` *and zeroes every `damage_dealt`*. A `next_incarnation` that beat the
leaderboard write would lose the whole match's record. So **tag 15 takes the `Leaderboard`
as a read-only account and requires `last_arena_id == arena.arena_id &&
last_incarnation == arena.incarnation`** — the match must already be recorded. That makes
the ordering structural instead of a rule the Worker has to remember.

Incarnation overflow is `saturating_add`, not checked. At `u16::MAX` progression stops
advancing, which is harmless: boss part HP already saturates around incarnation 41, so the
fight stopped getting harder tens of thousands of incarnations earlier. An error there would
name a failure mode no raid can reach.

---

## 5. VRF

### The flow

```
core_hp reaches 0
  │  tag 7 shoot, or tag 8 boss_tick
  ▼
SETTLING, outcome = OUTCOME_WIN
  │  tag 13 request_roll — a seated player's session key signs
  │  CPI RequestRandomness → DEFAULT_EPHEMERAL_QUEUE  (0 lamports, in-ER queue is fee-exempt)
  │  roll_requested_tick = tick
  ▼
ROLLING
  │  ┌─ tag 14 consume_roll: the oracle proved the VRF on chain and CPI'd us,
  │  │  signed by scoped_vrf_identity(heartrot). next_affix_seed = randomness.
  │  ▼
  │ ROLLED ──▶ tag 9 settle ──▶ SETTLED ──▶ tag 10 ──▶ tag 15 next_incarnation
  │
  └─ no callback within ROLL_TIMEOUT_TICKS (25 ticks ≈ 10 s)
     tag 8 boss_tick abandons it: back to SETTLING, NO SEED WRITTEN
     ──▶ tag 9 settle ──▶ SETTLED ──▶ tag 10 ──▶ tag 15 REFUSES
```

### Why the request comes from a player

A crank instruction may carry no signer but the read-only `crank_signer` PDA, and the VRF
request needs `payer` as a **writable** signer; a CPI cannot escalate a read-only account to
writable. So the crank structurally cannot ask. The killing blow's client sends tag 13
immediately after its `shoot` lands — it already holds a signing key that produces no wallet
popup, the in-ER queue is fee-exempt so a zero-lamport session key can pay, and a failure is
visible to the player who can retry rather than buried in a crank nobody can observe.

The request is **not** folded into `shoot` itself. Tag 7 is the hottest instruction in the
program and adding four VRF accounts to every shot spends CU and key budget on every shot
in the raid to serve one. Splitting them also means `PHASE_SETTLING` is a real, persisting
state — "the core is dead and nobody has asked for the roll yet" — which is what lets the
crank's timeout complete the loop when the killer's browser closes between the two
transactions.

Any claimed seat may send tag 13, not only the killer. One rule ("a seated player asks for
the roll"), and if the killer vanishes any of the other nineteen can. Spam is impossible
without a rate limiter: `SETTLING → ROLLING` is a one-shot edge, so the second request is a
rejected transition.

### The fallback is a refusal, not a degradation

When the callback never lands, `abandon_roll` writes **no seed**. The obvious alternative —
hash the SlotHashes sysvar and carry on — is rejected: a validator-influenceable seed is not
verifiable randomness, and an incarnation whose ruleset was quietly chosen by whoever
produced a block is exactly the property the VRF exists to deny, while being
indistinguishable on chain from one that was rolled honestly.

So the match settles normally and the *progression* stops, loudly:
`begin_next_incarnation` refuses. A human decides whether to re-run the roll or open a fresh
chain from incarnation 0. **A VRF outage costs the respawn loop, never the raid.**

There is no `roll_verified` flag. All-zero `next_affix_seed` is the sentinel *and* the
verification: the only writer of those bytes is `accept_roll`, reachable only from the tag-14
callback, which the scoped VRF identity signs. "Non-zero" therefore *means* "a proof was
verified on chain", and there is no second flag to fall out of agreement with it.

### `boss_tick` must advance `tick` on every execution

`abandon_roll` compares `arena.tick` against `roll_requested_tick + ROLL_TIMEOUT_TICKS`, and
`tick` is the only clock this program has. Today `boss_tick` advances it inside `step()`,
behind the `phase != PHASE_FIGHTING` early return — so in `ROLLING` the clock is frozen, the
timeout never fires, and a VRF outage wedges the arena there for good. **`tick` must be
incremented right after `Arena` is loaded and before the phase gate**, and `step()` must
stop incrementing it. `tick` then means "crank executions", which is also what makes it a
crank-liveness heartbeat during settlement — it currently is not one. See §8.

### Wiring facts, all read from `ephemeral-rollups-pinocchio` 0.17.0

| | |
|---|---|
| Request CPI | `vrf::instruction::RequestRandomnessCpi` (struct literal — the doc comment's `new()` lags the struct, which has seven fields including `vrf_program`) |
| Queue | `vrf::consts::DEFAULT_EPHEMERAL_QUEUE` = `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`. **In-ER only.** The base-layer `DEFAULT_QUEUE` costs 500,000 lamports and takes 1–5 s |
| Requester identity | `vrf::pda::program_identity_pda(heartrot)` = PDA `["identity"]` under **our** program; we `invoke_signed` it |
| Callback identity | `vrf::pda::scoped_vrf_identity(heartrot)` = PDA `["identity", heartrot]` under the **VRF** program. Tag 14 must assert this exact address is a signer. The global `VRF_PROGRAM_IDENTITY` is deprecated and shared with every consumer on the network — using it leaves the callback spoofable, and a spoofable callback means any player picks the next boss |
| Callback discriminator | `[14]`, one byte. The cap is 8 |
| Callback args | `incarnation.to_le_bytes()`, 2 bytes, so a late roll for a stale incarnation is detectable. Cap 512 |
| Callback accounts | 2: `[scoped identity (r s), arena (w)]`. Cap 25. **`Boss` is deliberately not one** — the boss is rescaled by tag 15 on the base layer, so the frozen callback list stays two entries and never touches `Players`, which could not fit anyway |
| Fulfilment timing | never same-slot (enforced on chain); ~100 ms typical in-ER, request TTL 240 slots |

---

## 6. Affixes are derived, never stored

`Arena.affix_seed` is the *only* storage for an incarnation's ruleset. Affix values are a
pure function of those bytes, computed identically in Rust and in TypeScript. A stored affix
table would be the seed twice over, and the second copy is the one that drifts.

To keep two implementations from inventing two byte layouts, the seed's ranges are reserved
here and nowhere else:

| Bytes | Consumer | Rule |
|---|---|---|
| `[0..8]` | per-tick entropy: the volley, the hand slam, the 50 % beam | `seed64 = u64::from_le_bytes(seed[0..8])`, read once by `tick.rs::seed64` (`le64` in `layout.ts`). Volley: `mix64(seed64 ^ mix64(tick))` in `spawn_volley`. Slam: `mix64(seed64 ^ mix64(tick / SLAM_PERIOD_TICKS))` in `slam_lane`. Beam: `mix64(seed64 ^ mix64(tick / BEAM_PERIOD_TICKS ^ 0xBEA1))` in `beam_at` — the constant keeps the beam's draw off the slam's where their cycle indices coincide. All three reproducible in the browser with `BigInt.asUintN(64, …)`; the slam and the beam are mirrored in `layout.ts` and the beam is pinned to one vector on both sides |
| `[8..12]` | affix roll A | u32 LE |
| `[12..16]` | affix roll B | u32 LE |
| `[16..20]` | affix roll C | u32 LE |
| `[20..32]` | reserved | unused; a fourth affix takes `[20..24]` |

Separate ranges rather than repeated calls on one seed: the SDK's `rnd` helpers all read
fixed, overlapping offsets (`random_u8` is `bytes[30]`, `random_u32` is `bytes[28..32]`,
`random_bool` is `bytes[31]`), so successive calls are correlated values and not independent
draws. Disjoint ranges are free and cannot be got wrong.

Which affixes those three rolls select is a balance decision and belongs with the file that
owns the balance constants (`handlers/init.rs`), not here. What is fixed here is that they
come from these bytes, that both languages read the same bytes, and that nothing about an
affix is ever written to an account.

---

## 7. New and repurposed fields

### `Arena` — grows 1,160 → 1,200 bytes

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `outcome` | u8 | **6** | 1 | `OUTCOME_*`. Was `_pad0[0]`. Write-once per incarnation |
| `_pad0` | u8 | 7 | 1 | was `_pad0[1]`; still spare |
| `roll_requested_tick` | u32 | **1160** | 4 | `tick` at which `PHASE_ROLLING` was entered. Ticks, never a slot or a wall-clock — `tick` is the only clock the ER agrees on and the only one `boss_tick` can read |
| `_pad2` | [u8; 4] | 1164 | 4 | explicit; keeps the seed 8-aligned and the struct a multiple of 8 |
| `next_affix_seed` | [u8; 32] | **1168** | 32 | the next incarnation's VRF seed. All-zero = none, and that sentinel *is* the verification |

Everything at offsets 0–1159 keeps its offset, including the whole bullet pool. So a client
built against the 1,160-byte layout decodes a 1,200-byte account correctly and simply does
not see the new fields.

**Rent changes.** ER-clonable rent is `(128 + space) × 6,960`:

| | 1,160 B | 1,200 B |
|---|---|---|
| `ARENA.rentExemptLamports` | 8,964,480 | **9,242,880** |

**`LAYOUT_VERSION` stays 1**, deliberately. It is a single global constant in byte 1 of all
four account types, so bumping it would also invalidate the `Leaderboard` — a base-layer
singleton holding every row of history, costing 43,875,840 lamports to re-create and losing
all of it. And it would buy nothing: an `Arena` of the old shape is 1,160 bytes, so `load`
rejects it on length with `AccountDataTooSmall` before any version check runs. The length is
already an unambiguous signal; the version byte would only be a second one.

### `PlayerSlot` — unchanged at 96 bytes

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `deaths` | u16 | **14** | 2 | times this seat hit 0 HP this incarnation. Was `_pad1` |

No field moved and the account did not grow, so `Players` stays 1,924 bytes and its rent is
unchanged. Every seat already on chain reads 0, which is true of a match nobody has died in.

Incremented on exactly the line that stamps `respawn_at_tick`, so there is one death event
and one place it is counted. Saturating. It is the only record that a wipe-heavy raid
happened: `survived` on the leaderboard row is a single bit sampled at settle time, and a
player who died nineteen times and respawned before the end is indistinguishable from one
who never took a hit.

### `Boss` — unchanged

No boss attack-phase field. The design's enrage is a *match-end rule*, not a boss behaviour
— `enrage_at_tick` passing ends the fight, it does not change how the boss acts — so there
is nothing for a phase byte to hold, and `Boss` is fully packed at 50 bytes with no padding
to claim.

### Client mirror

`packages/client/src/layout.ts` carries all of the above plus two helpers, so the client does
not re-derive rules:

```ts
rollSeed(arena: ArenaAccount): Uint8Array | null   // null when the oracle never answered
rollDeadlineTick(arena: ArenaAccount): number      // rollRequestedTick + ROLL_TIMEOUT_TICKS
```

`rollDeadlineTick` exists because the program's comparison is strictly-greater; a countdown
that wrote `>=` itself would announce the oracle dead one tick early, every time.

---

## 8. What each handler owes this contract

Nothing below is implemented by `state.rs`. These are the changes the machine assumes.

| File | Change |
|---|---|
| `handlers/tick.rs` | Advance `arena.tick` **before** the `phase != PHASE_FIGHTING` gate, and remove the increment from `step()`. Call `arena.abandon_roll()` in the same pre-gate region. Replace `arena.phase = PHASE_SETTLING` with `arena.end_fight(OUTCOME_WIN / OUTCOME_WIPE / OUTCOME_ENRAGE)` — the three conditions it already computes as `core_dead`, `wiped`, `enraged`, in that precedence. Increment `slot.deaths` on the line that stamps `respawn_at_tick`. |
| `handlers/shoot.rs` | Replace `arena.phase = PHASE_SETTLING` on the killing blow with `arena.end_fight(OUTCOME_WIN)`. |
| `handlers/settle.rs` | `settle` must use `arena.try_set_phase(PHASE_SETTLED)` instead of assigning, which turns its current "reject only `LOBBY`" into "reject `LOBBY` **and `ROLLING`**" — the commit-during-fulfilment hazard. |
| `handlers/init.rs` | New tag 15 `next_incarnation`, base layer. Also: `init_arena` still seeds incarnation 0 deterministically; only later incarnations require a VRF seed. |
| `handlers/roll.rs` (new) | Tags 13 and 14. |
| `handlers/delegation.rs` | `process_commit_and_undelegate` and the undelegation callback should route through `try_set_phase`; both of their transitions are legal edges already. |
| `instruction.rs`, `lib.rs` | Tags 13, 14, 15 in the ABI table and the dispatch. Tag 14 must **not** be in `ZERO_ARG_TAGS`. |
| `packages/client/src/instructions.ts` | Builders for 13 and 15. Tag 14 is built by the VRF program, never by us. |
| `docs/architecture/04-layout-contract.md` | The `Arena` and `PlayerSlot` tables, the size, and the rent line. |
| `docs/architecture/05-wire-abi.md` | Tags 13, 14, 15. |

### The three new instructions

**Tag 13 — `RequestRoll`, ER.** Args: 1 byte, `seat: u8`.

| # | Account | Flags | |
|---|---|---|---|
| 0 | arena | `w` | phase must be `SETTLING`, `outcome` must be `OUTCOME_WIN` |
| 1 | players | `r` | |
| 2 | payer / session key | `w s` | must equal `slots[seat].session_pubkey`; writable because the VRF request requires a writable signer |
| 3 | program identity | `r` | PDA `["identity"]` under **this** program; we `invoke_signed` it |
| 4 | oracle queue | `w` | must equal `DEFAULT_EPHEMERAL_QUEUE` |
| 5 | system program | `r` | |
| 6 | slot hashes | `r` | `SysvarS1otHashes111111111111111111111111111` |
| 7 | vrf program | `r` | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |

**Tag 14 — `ConsumeRoll`, ER, VRF callback only.** Data after the tag byte: **exactly 34
bytes** — `randomness [0..32]`, `for_incarnation` u16 LE `[32..34]`. The account list is
frozen at request time.

| # | Account | Flags | |
|---|---|---|---|
| 0 | scoped vrf identity | `r s` | must equal `scoped_vrf_identity(program_id)`. **This check is the whole security of the instruction** — without it any caller picks the next boss |
| 1 | arena | `w` | |

Every rejection is `Ok(())`, never `Err` — including a wrong length, a stale incarnation and
a failed identity check. An `Err` reverts the oracle's `ProvideRandomness` transaction and
it retries for the request's whole TTL.

**Tag 15 — `NextIncarnation`, base layer.** Args: none.

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `w s` | must equal `init::TREASURY` — it re-arms the boss and reopens the match, the same authority `init_arena` needs |
| 1 | arena | `w` | undelegated, phase `SETTLED`, `next_affix_seed` non-zero |
| 2 | boss | `w` | PDA `["boss", arena]` |
| 3 | players | `w` | PDA `["players", arena]` |
| 4 | leaderboard | `r` | PDA `["leaderboard"]`; must show `last_arena_id == arena.arena_id && last_incarnation == arena.incarnation` |

New error codes are **not** required — see §3. If they are wanted later, `error.rs` has
retired 16 and `HIGHEST_ISSUED` is 16, so the next free numbers are 17 and up:
`RollUnavailable` for the missing-seed refusal and `NoWin` for a wipe asking to roll. Both
are pure diagnostics; the rules are already enforced.

---

## 9. What is still open

- **Which affixes rolls A, B and C select**, and their curated value ranges. The byte
  ranges are frozen in §6; the semantics are a balance decision.
- **Observed in-ER fulfilment latency on devnet.** `ROLL_TIMEOUT_TICKS = 25` is set against
  a documented "~100 ms" that is marketing copy, not a measurement. The only guarantee read
  from source is "strictly later slot". Measure before launch; the constant is one line in
  `state.rs` and one in `layout.ts`.
- **`layout.ts` is still hand-maintained.** Every defect in this project so far has been one
  fact stored twice, and the Rust and TypeScript offset tables are the last big instance.
  The fix is to generate `layout.ts` from `state.rs`, the way `map.ts` and `hitboxes.ts` are
  generated. Both halves were written by one author in one pass this time, which is a
  mitigation and not a fix.
