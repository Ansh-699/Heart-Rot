# HEARTROT — Wire ABI Contract

**Date:** 2026-09-01
**Status:** Frozen for v1. Tags are append-only.
**Authority:** `programs/heartrot/src/handlers/*.rs`. The doc table in
`programs/heartrot/src/instruction.rs` is the single in-repo description of that truth,
and this file is its mirror. `packages/client/src/instructions.ts`, `worker/src/routes.ts`
and the app conform to it. **When TypeScript and Rust disagree, TypeScript is what
changes.**

---

## 0. Why this file exists

The wire format had three descriptions — the handlers, an `Instruction::parse` state
machine in `instruction.rs` that nothing ever called, and the TS encoder — and no compiler
could hold any two of them to agreement. That is how tag 6 (`Move`) came to be parsed as
5 bytes on-chain and encoded as 3 in the client, and tag 4 (`ClaimSeat`) as 66 against 65,
with `cargo check` clean throughout.

`Instruction::parse` **has been deleted**. `lib.rs` splits the leading tag byte and each
handler length-checks and slices its own argument block; that is now the only parser in
the program. `instruction.rs` holds no code at all — it is the description, and this file
is the same table for readers outside the crate.

Do not reintroduce a second parser. If a helper is ever wanted, it must be the one
`lib.rs` actually calls, not a parallel definition.

---

## 1. Encoding

One leading tag byte, then a fixed-length little-endian argument block sliced by offset.
No borsh, no serde: every block has a compile-time-known length, so parsing is a length
check and a few `from_le_bytes` calls.

Every handler that takes a `data` parameter length-checks **exactly**. One byte short *or*
one byte long is `InvalidInstructionData`. Short is an attacker probing for an index
panic; long is client/program version skew, or bytes parked where the next version of the
program might read them.

Tags **2, 3, 9, 11, 12** take no `data` parameter, so `lib.rs::ZERO_ARG_TAGS` rejects a
trailing payload on their behalf before dispatch. Tags **8** and **10** also take no
arguments but are deliberately *not* in that list — see their sections.

Tags are **append-only**: never renumber, never reuse a retired one. `8` is frozen hardest
— `settle::begin_muster` writes it into the validator's crank row at schedule time and the
row is replayed for the life of the match. Its canonical definition is
`handlers::settle::IX_BOSS_TICK`.

### Notation

`w` writable · `r` read-only · `s` signer. A row's flags are what the client must set on
the account meta. "must equal X" is a comparison the handler performs and rejects on.

PDA seeds are listed **without the bump**: every `assert_pda` re-derives the canonical bump
itself, so a stored bump is never a seed and passing one derives a different address
entirely.

Handlers destructure with `[a, b, c, ..]`, so trailing accounts past the listed ones are
ignored — **except** tags 2, 11, 12 and the undelegation callback, whose patterns are
exact-length and reject any extra.

### Ceilings that constrain every account list

- **~38 total account keys per ER transaction** (the ER rejects `program_id_index >= 38`
  and Solana sorts program ids last). **No address lookup tables anywhere**, gameplay
  included.
- Accounts past index 39 are dropped silently by the entrypoint (`lib.rs::MAX_ACCOUNTS`).
- Crank ceiling **400,000 CU**; a crank cannot re-arm itself and may carry **no writable
  signer**.
- ER fees are **zero** and the ER runs no fee-payer validation, so nothing economic rate-
  limits anything. Rate limiting is the in-program per-seat tick counters.

---

## 2. The table

| Tag | Instruction | Handler | Layer | Args | Accounts | Must sign |
|---|---|---|---|---|---|---|
| 0 | `InitLeaderboard` | `init::init_leaderboard` | base | 0 B | 3 | payer (anyone) |
| 1 | `InitArena` | `init::init_arena` | base | 74 B | 5 | `init::TREASURY` |
| 2 | `Delegate` | `delegation::process_delegate` | base | 0 B | 16 exact | `Arena.crank_authority` |
| 3 | `BeginMuster` | `settle::begin_muster` | ER | 0 B | 5 | `Arena.crank_authority` |
| 4 | `ClaimSeat` | `player::join` | ER | 66 B | 3 | `Arena.crank_authority` |
| 5 | `EnterGate` | `player::enter_gate` | ER | 1 B | 3 | `slots[seat].session_pubkey` |
| 6 | `Move` | `player::move_player` | ER | 5 B | 3 | `slots[seat].session_pubkey` |
| 7 | `Shoot` | `shoot::process` | ER | 3 B | 4 | `slots[seat].session_pubkey` |
| 8 | `BossTick` | `tick::process` | ER | 0 B | 4 | crank signer PDA (read-only) |
| 9 | `Settle` | `settle::settle` | ER | 0 B | 6 | `Arena.crank_authority` |
| 10 | `WriteLeaderboard` | `settle::write_leaderboard` | base | 0 B | 4 | `init::TREASURY` |
| 11 | `Commit` | `delegation::process_commit` | ER | 0 B | 6 exact | `Arena.crank_authority` |
| 12 | `CommitAndUndelegate` | `delegation::process_commit_and_undelegate` | ER | 0 B | 6 exact | `Arena.crank_authority` |

Tags 11 and 12 are operator-only and have no client builder. One further instruction
carries no tag of ours at all — see §4.

---

## 3. Per-tag detail

### Tag 0 — `InitLeaderboard` · base layer

Args: **none**. A non-empty block is rejected by the handler.

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `w s` | any key; deliberately permissionless — it donates rent and can change nothing else |
| 1 | leaderboard | `w` | PDA `["leaderboard"]` under this program, must not already exist |
| 2 | system program | `r` | |

---

### Tag 1 — `InitArena` · base layer

Args, **74 bytes exactly**:

| Offset | Width | Field | |
|---|---|---|---|
| `[0..8]` | 8 | `arena_id` | u64 LE, **must be non-zero** — `(0, 0)` is the leaderboard's idempotency sentinel |
| `[8..10]` | 2 | `incarnation` | u16 LE, scales boss part HP |
| `[10..42]` | 32 | `validator_identity` | the one ER validator all three accounts delegate to |
| `[42..74]` | 32 | `crank_authority` | **must be non-zero**; the key that may delegate, start, join-for, settle and cancel this match |

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `w s` | **must equal `init::TREASURY`** (the `HEARTROT_TREASURY` build-time constant) |
| 1 | arena | `w` | PDA `["arena", arena_id u64 LE]`, must not exist |
| 2 | boss | `w` | PDA `["boss", arena]`, must not exist |
| 3 | players | `w` | PDA `["players", arena]`, must not exist |
| 4 | system program | `r` | |

All three match accounts are created by this one instruction: they are delegated together
and the crank's frozen list names all three, so an arena without a boss is not a partial
match, it is a wedged one.

---

### Tag 2 — `Delegate` · base layer

Args: **none** (`ZERO_ARG_TAGS`).

**Exactly 16 accounts** — the handler's slice pattern has no `..`, so a seventeenth is
`NotEnoughAccountKeys`.

- `buffer` = PDA `["buffer", <account>]` under **this program**
- `record` = PDA `["delegation", <account>]` under the **delegation program**
- `metadata` = PDA `["delegation-metadata", <account>]` under the **delegation program**

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `w s` | must equal `Arena.crank_authority`, **and must be the transaction fee payer** — the delegation program debits it for three record + metadata rents |
| 1 | owner program | `r` | this program's id |
| 2 | delegation program | `r` | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| 3 | system program | `r` | |
| 4 | arena | `w` | `phase` must be `Lobby` |
| 5 | arena buffer | `w` | |
| 6 | arena delegation record | `w` | |
| 7 | arena delegation metadata | `w` | |
| 8 | boss | `w` | |
| 9 | boss buffer | `w` | |
| 10 | boss delegation record | `w` | |
| 11 | boss delegation metadata | `w` | |
| 12 | players | `w` | |
| 13 | players buffer | `w` | |
| 14 | players delegation record | `w` | |
| 15 | players delegation metadata | `w` | |

The client must also **raise the compute budget**: three delegations are ~12 CPIs and up
to 1,924 bytes copied per account, which does not fit the default 200,000 CU.

---

### Tag 3 — `BeginMuster` · ER

Args: **none** (`ZERO_ARG_TAGS`). Sent to the **ER**, after tag 2 has confirmed —
`Magic11111…` is a runtime builtin, so a base-layer CPI to it cannot resolve.

**Renamed from `StartMatch`; the bytes are unchanged.** Same tag, same zero args, same five
accounts in the same order, so this is not a wire change — but the *semantics* moved, and
an old client that sends it now lands in `Mustering` rather than `Fighting`.

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `w s` | must equal `Arena.crank_authority`; becomes the crank task authority, so it is the only key that can ever cancel the task |
| 1 | arena | `w` | frozen into the crank row |
| 2 | boss | `w` | frozen into the crank row |
| 3 | players | `w` | frozen into the crank row, **and read**: `guards::assert_any_raider` |
| 4 | magic program | `r` | `Magic11111111111111111111111111111111111111` |

Flips `phase` to `Mustering`, stamps `Arena.fight_at_tick = tick + MUSTER_TICKS`, **and**
schedules the tag 8 crank in one instruction. The crank is also what *ends* the muster —
`Arena::begin_fight` performs `MUSTERING → FIGHTING` at the deadline — so no second request
is owed by any player, host or Worker, and a raid can never fail to start. A `Lobby` arena
with a live crank ticks to no effect; a `Mustering` arena with no crank never reaches the
fight.

**Refuses with `HeartrotError::NoRaiders` (Custom 19) when no seat is in `ZONE_ARENA`.**
Every client through the gate fires this and all but one lose the race: nineteen get the
phase refusal, and a twentieth may legitimately get `NoRaiders` if its own `enter_gate` has
not landed yet. Both are the design. The Worker maps it to `no_raiders` / 409 and the
browser store swallows it alongside `already_started`.

`task_id` is **validator-global** — a collision fails silently.

---

### Tag 4 — `ClaimSeat` · ER

Args, **66 bytes exactly** (`player::JOIN_DATA_LEN`):

| Offset | Width | Field | |
|---|---|---|---|
| `[0]` | 1 | `seat` | u8; the Worker's chosen index, bounds-checked by `slots.get_mut` |
| `[1]` | 1 | `skin_id` | u8 |
| `[2..34]` | 32 | `session_pubkey` | the browser session key; **must be non-zero** (all-zero is the "unclaimed" sentinel) |
| `[34..66]` | 32 | `identity` | Privy identity; **must be non-zero** |

| # | Account | Flags | |
|---|---|---|---|
| 0 | arena | `w` | `seat_occupied` bitmask |
| 1 | players | `w` | |
| 2 | treasury | `s` | must equal `Arena.crank_authority` |

Seats are administered, not self-served: a session key that could claim its own seat would
take all twenty for free, since ER fees are zero. If `identity` already holds a seat, that
seat is kept **whatever `seat` asks for** and only the key and skin rotate — which is what
makes `/session/init` safe to retry.

---

### Tag 5 — `EnterGate` · ER

Args, **1 byte exactly**: `seat` u8 at `[0]`.

| # | Account | Flags | |
|---|---|---|---|
| 0 | arena | `w` | `alive_count` |
| 1 | players | `w` | |
| 2 | session key | `s` | must equal `slots[seat].session_pubkey` |

---

### Tag 6 — `Move` · ER

Args, **5 bytes exactly**:

| Offset | Width | Field | |
|---|---|---|---|
| `[0]` | 1 | `seat` | u8 |
| `[1..3]` | 2 | `seq` | u16 LE, echoed into `slots[seat].last_move_seq` for client reconciliation |
| `[3]` | 1 | `dx` | **i8**, signed |
| `[4]` | 1 | `dy` | **i8**, signed |

| # | Account | Flags | |
|---|---|---|---|
| 0 | arena | `r` | **read-only** — a move must not rewrite the 1,160-byte account the whole lobby is subscribed to |
| 1 | players | `w` | |
| 2 | session key | `s` | must equal `slots[seat].session_pubkey` |

**The seat comes off the wire and is not resolved from the signing key.** The handler
bounds-checks it with `slots.get_mut` and then asserts
`signer == slots[seat].session_pubkey`, which is the entire perimeter and is cheaper than
scanning twenty slots. Do not move seat resolution into the program.

---

### Tag 7 — `Shoot` · ER

Args, **3 bytes exactly** (was 2, `[seat, dir]`, before free aim):

| Offset | Width | Field | |
|---|---|---|---|
| `[0]` | 1 | `seat` | u8 |
| `[1]` | 1 | `dx` | **i8**, signed |
| `[2]` | 1 | `dy` | **i8**, signed |

**Free aim, and it is not a nicety.** Replayed over 110 pit stands with the boss at top
centre: eight-way aim leaves 33.6% of stands able to hit anything at all and **can never
reach the core** — the raid is unwinnable with no error anywhere. The `(dx, dy)` pair
measures 0.2354° of worst-case direction error over 200,000 angles. The pair is normalised
**on chain** by `tick.rs::unit_velocity`; `(0, 0)` is rejected, and `facing` is stamped from
`player::octant(dx, dy)` so remote sprites still turn.

An old client sending 2 bytes gets a clean length refusal, so **program and app ship
together**.

| # | Account | Flags | |
|---|---|---|---|
| 0 | arena | `w` | `tick` is read; `phase` is written on the killing blow |
| 1 | boss | `w` | parts, vent, core |
| 2 | players | `w` | the acting seat only |
| 3 | session key | `s` | must equal `slots[seat].session_pubkey` |

---

### Tag 8 — `BossTick` · ER

Args: **none**. The handler takes no `data` parameter, and `8` is deliberately **absent
from `ZERO_ARG_TAGS`**: nothing may stand between the crank and the one handler that must
never return `Err`, so a trailing payload is ignored rather than rejected.

| # | Account | Flags | |
|---|---|---|---|
| 0 | arena | `w` | clock, bullet pool, phase |
| 1 | boss | `w` | timer, aggro, vent |
| 2 | players | `w` | health, respawns |
| 3 | crank signer | `r s` | **read-only signer**, PDA `["crank-executor", Arena.crank_authority]` under `Crank11111111111111111111111111111111111111` |

**No client ever builds this.** `begin_muster` freezes the four metas and the single data
byte `[8]` into the validator's crank row and the row is replayed every `TICK_MS` (100 ms).
It is armed for `TICK_ITERATIONS = (MUSTER_TICKS + ENRAGE_TICKS) * 5 / 4` iterations, which
must cover the muster **and** the fight: the crank cannot be topped up. A crank
may carry no writable signer and cannot re-arm itself, so the shape is immutable for the
life of the match — four metas plus two program ids, six keys against the ~38 ceiling.

Every rejection inside the handler is `Ok(())`, never `Err`: ten consecutive failures
delete the task permanently, ~26 s in. Crank args are **i64**, not u64.

---

### Tag 9 — `Settle` · ER

Args: **none** (`ZERO_ARG_TAGS`).

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `r s` | must equal `Arena.crank_authority`. **Read-only on purpose** — the ER rejects writable non-delegated accounts, so the treasury signs read-only and a throwaway keypair pays the (zero) fee |
| 1 | arena | `w` | committed; also stands in as the crank cancel's `task_context` |
| 2 | boss | `w` | committed |
| 3 | players | `w` | committed |
| 4 | magic context | `w` | `MagicContext1111111111111111111111111111111` |
| 5 | magic program | `r` | `Magic11111111111111111111111111111111111111` |

Sets `phase = Settled`, cancels the tag 8 crank, then commits and undelegates all three.
Rejects a `Lobby` arena — it was never delegated with players in it and has nothing to
record. A cancel from the wrong authority is a **silent no-op** in the scheduler; the
`crank_authority` check is the only thing that turns it into a visible failure.

---

### Tag 10 — `WriteLeaderboard` · base layer

**Args: none.** The handler takes no `data` parameter: it reads the authoritative
`(arena_id, incarnation)` pair off the `Arena` account, because a pair supplied on the wire
would let a retry file the match under a different key and duplicate twenty rows.

`10` is absent from `ZERO_ARG_TAGS`, so a trailing block is **silently ignored** rather
than rejected. The canonical client encoding is nevertheless the bare tag byte and nothing
else. **Do not send the legacy 10-byte block.**

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `w s` | must equal `init::TREASURY` **and** `Arena.crank_authority` |
| 1 | leaderboard | `w` | PDA `["leaderboard"]`, never delegated |
| 2 | arena | `r` | undelegated and owned by us again by now; `phase` must be `Settled` |
| 3 | players | `r` | PDA `["players", arena]` |

Idempotent by the `(arena_id, incarnation)` guard on `Leaderboard`, because
`GetCommitmentSignature` throws on every failure path — a throw means "unknown, retry",
never "failed" — so this instruction can legitimately run twice for one match.

---

### Tags 11 and 12 — `Commit`, `CommitAndUndelegate` · ER · operator-only

Args: **none** (`ZERO_ARG_TAGS`). **Exactly 6 accounts**, no `..` in either pattern.

> The order is **not** tag 9's. The two magic accounts come second and third here.

| # | Account | Flags | |
|---|---|---|---|
| 0 | payer | `s` | must equal `Arena.crank_authority` — ER fees are zero, so this check *is* the rate limit on the ten-commit quota |
| 1 | magic context | `w` | `MagicContext1111111111111111111111111111111` |
| 2 | magic program | `r` | `Magic11111111111111111111111111111111111111` |
| 3 | arena | `w` | tag 12 sets `phase = Settled` and rejects a second run |
| 4 | boss | `w` | |
| 5 | players | `w` | |

Tag 11 is a mid-match snapshot and **spends the commit quota** — ten per account before
`0xA0000000` locks them out until re-delegation, and settle needs one of them.

Tag 12 requires the tag 8 crank to be **cancelled first**, or it keeps firing into accounts
that no longer live on the ER, burning its ten-retry ladder against
`InvalidWritableAccount`.

---

## 4. Pre-tag route — the undelegation callback

One instruction carries no tag of ours and **must never be given one**. The delegation
program CPIs back into us once per undelegated account (three times per match) with its own
8-byte discriminator, so `lib.rs` routes on the full discriminator **before** the tag
split. Otherwise its leading byte, `196`, reads as an unknown tag and the three match
accounts can never leave the ER. Matching all eight bytes rather than `196` alone is what
keeps a truncated payload from reaching the handler.

- **Discriminator:** `[196, 28, 41, 206, 48, 37, 51, 167]`
  (`ephemeral_rollups_pinocchio::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`)
- **Data:** those 8 bytes, then a borsh `Vec<Vec<u8>>` of the account's PDA seeds without
  the bump. Not our encoding — the delegation program's.
- **Accounts, exactly 4**, fixed by the delegation program:
  `[delegated_account (w), buffer (r s), payer (w s), system_program (r)]`
- **Handler:** `delegation::process_undelegation`, base layer.

There is deliberately **no authority check**. Authentication is structural and lives inside
the SDK's `undelegate`: `buffer` must be a signer owned by the delegation program at the
canonical `["undelegate-buffer", account]` PDA, which only the delegation program can
produce, and the seeds must re-derive `delegated_account` under our program id or the
`CreateAccount` CPI fails.

Do not "fix" this into the tag range.

---

## 5. Bounds the handlers owe this table

There is no boundary layer above the handlers, so each of these is the handler's own
responsibility and none may be skipped:

- **`seat`** is checked `< state::MAX_SEATS` (20) before it indexes `Players.slots`. A
  fallible `slots.get_mut(seat)` satisfies this; a bare `slots[seat]` does not.
- **`dx`/`dy`** (tag 7) are attacker-chosen and free. They are normalised on chain, so
  magnitude carries no advantage; `(0, 0)` is rejected as not a direction. The ray is
  bounded by `MAX_RAY_STEPS = map::MAP_TILES`, so a miss costs a bounded walk and still
  spends the cooldown — refunding a miss would hand an attacker an unlimited-rate
  instruction.
- **`dx`/`dy`** (tag 6) are attacker-chosen and only their **signs** are read.
  `player::octant` quantizes them to one of eight octants and the displacement itself comes
  off `MOVE_STEP`, so `(127, 127)` moves exactly as far as `(1, 1)`. `(0, 0)` is not a
  direction and is rejected. The destination is then clamped to the map and re-checked
  against the wall bitboard. They are a *request* for a displacement, never the
  displacement itself.
- **Nothing here rate-limits.** ER fees are zero and the ER runs no fee-payer validation,
  so the per-seat tick counters written by the handlers (`last_move_tick`,
  `last_shot_tick`) are the only rate limit that exists anywhere.

## 6. `Move` carries no facing

Tag 6 sends a displacement, not a direction, so `PlayerSlot.facing` is derived from the
sign of `(dx, dy)` — it is not on the wire. Tag 7 now sends a displacement too and stamps
`facing` through the **same** `player::octant`, which is why there is one quantiser and not
two. Keep both derivations agreeing on the octant numbering
(0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW, **y down**) or a player's sprite faces one way
and their shots leave in another.
