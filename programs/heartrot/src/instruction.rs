//! **The wire ABI. This module contains no code, deliberately — it is the description,
//! and there is exactly one of it.**
//!
//! It used to contain an `Instruction` enum and an `Instruction::parse` state machine.
//! Nothing ever called them: `lib.rs` splits the tag byte itself and hands the remaining
//! slice to a handler, and each handler parses its own argument block. `parse` was
//! therefore a *third* description of the wire format — after the handlers and after
//! `packages/client/src/instructions.ts` — that the compiler could never hold to
//! agreement with either. That is not a hypothetical: it is the mechanism by which tag 6
//! (`Move`) came to be parsed as 5 bytes in `handlers/player.rs` and encoded as 3 in the
//! client, and tag 4 (`ClaimSeat`) as 66 against 65, with `cargo check` clean throughout.
//! A parser that is never reached cannot fail a test that matters. It is gone; do not
//! reintroduce it.
//!
//! So the parsing lives exactly once, in the handler that consumes the arguments, and
//! the description lives exactly once, here. A doc table cannot silently disagree with
//! itself, and when it disagrees with a handler the diff is one table row.
//!
//! **Authority: the handler is truth.** Every byte offset, every length and every
//! account position below was read off the handler's own slice pattern and length
//! constant, not off a comment. `packages/client/src/instructions.ts`, the Worker and
//! `docs/architecture/05-wire-abi.md` conform to this file; this file conforms to
//! `handlers/*.rs`. When they disagree, the client is what changes.
//!
//! # Encoding
//!
//! One leading tag byte, then a fixed-length little-endian argument block sliced by
//! offset. There is no borsh and no serde: every block below has a compile-time-known
//! length, so parsing is a length check and a few `from_le_bytes` calls. Every handler
//! that takes a `data` parameter length-checks **exactly** — a block one byte short *or
//! one byte long* is rejected with `InvalidInstructionData`. Short is an attacker probing
//! for an index panic; long is either client/program version skew or bytes parked where
//! the next version of this program might read them. Neither is accepted quietly. Tags
//! 2, 3, 9, 11 and 12 take no `data` parameter at all, so `lib.rs::ZERO_ARG_TAGS` refuses
//! a trailing payload on their behalf before dispatch.
//!
//! Tags are **append-only**: never renumber, never reuse a retired one. `8` is frozen
//! hardest — `settle::start_match` writes it into the validator's crank row at schedule
//! time and the row is replayed for the life of the match, so it can never move. Its
//! canonical definition is `handlers::settle::IX_BOSS_TICK`, not this table.
//!
//! # Signer / writable notation
//!
//! `w` writable, `r` read-only, `s` signer. A row's flags are what the client must set on
//! the account meta. "must equal X" is a comparison the handler performs and rejects on.
//! PDA seeds are listed without the bump: every `assert_pda` re-derives the canonical
//! bump itself, so a stored bump is never a seed and passing one derives a different
//! address entirely.
//!
//! Handlers destructure with `[a, b, c, ..]`, so **trailing accounts past the listed ones
//! are ignored** — except tags 2, 11, 12 and the undelegation callback, whose patterns
//! are exact-length and reject any extra. Accounts past index 39 are dropped by the
//! entrypoint (`lib.rs::MAX_ACCOUNTS`), and the ER refuses any transaction above ~38
//! total keys, with no address lookup tables anywhere to escape it.
//!
//! # The table
//!
//! | Tag | Instruction | Handler | Layer | Args | Accounts | Must sign |
//! |---|---|---|---|---|---|---|
//! | 0 | `InitLeaderboard` | `init::init_leaderboard` | base | 0 B | 3 | payer (anyone) |
//! | 1 | `InitArena` | `init::init_arena` | base | 74 B | 5 | `init::TREASURY` |
//! | 2 | `Delegate` | `delegation::process_delegate` | base | 0 B | 16 exact | `Arena.crank_authority` |
//! | 3 | `StartMatch` | `settle::start_match` | ER | 0 B | 5 | `Arena.crank_authority` |
//! | 4 | `ClaimSeat` | `player::join` | ER | 66 B | 3 | `Arena.crank_authority` |
//! | 5 | `EnterGate` | `player::enter_gate` | ER | 1 B | 3 | `slots[seat].session_pubkey` |
//! | 6 | `Move` | `player::move_player` | ER | 5 B | 3 | `slots[seat].session_pubkey` |
//! | 7 | `Shoot` | `shoot::process` | ER | 2 B | 4 | `slots[seat].session_pubkey` |
//! | 8 | `BossTick` | `tick::process` | ER | 0 B | 4 | crank signer PDA (read-only) |
//! | 9 | `Settle` | `settle::settle` | ER | 0 B | 6 | `Arena.crank_authority` |
//! | 10 | `WriteLeaderboard` | `settle::write_leaderboard` | base | 0 B | 4 | `init::TREASURY` |
//! | 11 | `Commit` | `delegation::process_commit` | ER | 0 B | 6 exact | `Arena.crank_authority` |
//! | 12 | `CommitAndUndelegate` | `delegation::process_commit_and_undelegate` | ER | 0 B | 6 exact | `Arena.crank_authority` |
//!
//! Tags 11 and 12 are operator-only and have no client builder. One further instruction
//! carries no tag of ours at all — see [the pre-tag route](#pre-tag-route) at the bottom.
//!
//! # Tag 0 — `InitLeaderboard`, base layer
//!
//! Args: none. A non-empty block is rejected by the handler.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | any key; deliberately permissionless — it donates rent and can change nothing else |
//! | 1 | leaderboard | `w` | PDA `["leaderboard"]` under this program, must not already exist |
//! | 2 | system program | `r` | |
//!
//! # Tag 1 — `InitArena`, base layer
//!
//! Args, 74 bytes exactly:
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0..8]` | 8 | `arena_id` | u64 LE, **must be non-zero** — `(0, 0)` is the leaderboard's idempotency sentinel |
//! | `[8..10]` | 2 | `incarnation` | u16 LE, scales boss part HP |
//! | `[10..42]` | 32 | `validator_identity` | the one ER validator all three accounts delegate to |
//! | `[42..74]` | 32 | `crank_authority` | **must be non-zero**; the key that may delegate, start, join-for, settle and cancel this match |
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | **must equal `init::TREASURY`** (the `HEARTROT_TREASURY` build-time constant) |
//! | 1 | arena | `w` | PDA `["arena", arena_id u64 LE]`, must not exist |
//! | 2 | boss | `w` | PDA `["boss", arena]`, must not exist |
//! | 3 | players | `w` | PDA `["players", arena]`, must not exist |
//! | 4 | system program | `r` | |
//!
//! All three match accounts are created by this one instruction: they are delegated
//! together and the crank's frozen list names all three, so an arena without a boss is
//! not a partial match, it is a wedged one.
//!
//! # Tag 2 — `Delegate`, base layer
//!
//! Args: none (`lib.rs::ZERO_ARG_TAGS` rejects a trailing payload).
//!
//! **Exactly 16 accounts** — the handler's slice pattern has no `..`, so a seventeenth is
//! `NotEnoughAccountKeys`. `buffer` is `["buffer", <account>]` under **this** program;
//! `record` is `["delegation", <account>]` and `metadata` is
//! `["delegation-metadata", <account>]`, both under the delegation program.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | must equal `Arena.crank_authority`, **and must be the transaction fee payer** — the delegation program debits it for three record + metadata rents |
//! | 1 | owner program | `r` | this program's id |
//! | 2 | delegation program | `r` | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
//! | 3 | system program | `r` | |
//! | 4 | arena | `w` | phase must be `Lobby` |
//! | 5 | arena buffer | `w` | |
//! | 6 | arena delegation record | `w` | |
//! | 7 | arena delegation metadata | `w` | |
//! | 8 | boss | `w` | |
//! | 9 | boss buffer | `w` | |
//! | 10 | boss delegation record | `w` | |
//! | 11 | boss delegation metadata | `w` | |
//! | 12 | players | `w` | |
//! | 13 | players buffer | `w` | |
//! | 14 | players delegation record | `w` | |
//! | 15 | players delegation metadata | `w` | |
//!
//! The client must also raise the compute budget: three delegations are ~12 CPIs and up
//! to 1,924 bytes copied per account, which does not fit the default 200,000 CU.
//!
//! # Tag 3 — `StartMatch`, ER
//!
//! Args: none (`ZERO_ARG_TAGS`). Sent to the **ER**, after tag 2 has confirmed:
//! `Magic11111…` is a runtime builtin, so a base-layer CPI to it cannot resolve.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | must equal `Arena.crank_authority`; becomes the crank task authority, so it is the only key that can ever cancel the task |
//! | 1 | arena | `w` | frozen into the crank row |
//! | 2 | boss | `w` | frozen into the crank row |
//! | 3 | players | `w` | frozen into the crank row |
//! | 4 | magic program | `r` | `Magic11111111111111111111111111111111111111` |
//!
//! This flips `phase` to `Fighting` and schedules the tag 8 crank in the same
//! instruction, because neither half is useful without the other.
//!
//! # Tag 4 — `ClaimSeat`, ER
//!
//! Args, 66 bytes exactly (`player::JOIN_DATA_LEN`):
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0]` | 1 | `seat` | u8; the Worker's chosen index, bounds-checked by `slots.get_mut` |
//! | `[1]` | 1 | `skin_id` | u8 |
//! | `[2..34]` | 32 | `session_pubkey` | the browser session key; **must be non-zero** (all-zero is the "unclaimed" sentinel) |
//! | `[34..66]` | 32 | `identity` | Privy identity; **must be non-zero** |
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | `seat_occupied` bitmask |
//! | 1 | players | `w` | |
//! | 2 | treasury | `s` | must equal `Arena.crank_authority` |
//!
//! Seats are administered, not self-served: a session key that could claim its own seat
//! would take all twenty for free, since ER fees are zero. If `identity` already holds a
//! seat, that seat is kept whatever `seat` asks for and only the key and skin rotate —
//! which is what makes the Worker's `/session/init` safe to retry.
//!
//! # Tag 5 — `EnterGate`, ER
//!
//! Args, 1 byte exactly: `seat` u8 at `[0]`.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | `alive_count` |
//! | 1 | players | `w` | |
//! | 2 | session key | `s` | must equal `slots[seat].session_pubkey` |
//!
//! # Tag 6 — `Move`, ER
//!
//! Args, 5 bytes exactly:
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0]` | 1 | `seat` | u8 |
//! | `[1..3]` | 2 | `seq` | u16 LE, echoed back into `slots[seat].last_move_seq` for client reconciliation |
//! | `[3]` | 1 | `dx` | **i8**, signed |
//! | `[4]` | 1 | `dy` | **i8**, signed |
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `r` | **read-only** — a move must not rewrite the 1,160-byte account the whole lobby is subscribed to |
//! | 1 | players | `w` | |
//! | 2 | session key | `s` | must equal `slots[seat].session_pubkey` |
//!
//! The seat index comes off the wire and is not resolved from the signing key: the
//! handler bounds-checks it with `slots.get_mut` and then asserts
//! `signer == slots[seat].session_pubkey`, which is the entire perimeter and is cheaper
//! than scanning twenty slots. Do not move seat resolution into the program.
//!
//! # Tag 7 — `Shoot`, ER
//!
//! Args, 2 bytes exactly:
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0]` | 1 | `seat` | u8 |
//! | `[1]` | 1 | `dir` | u8, **must be `< 8`** — the eight-way facing octant |
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | `tick` is read; `phase` is written on the killing blow |
//! | 1 | boss | `w` | parts, vent, core |
//! | 2 | players | `w` | the acting seat only |
//! | 3 | session key | `s` | must equal `slots[seat].session_pubkey` |
//!
//! # Tag 8 — `BossTick`, ER
//!
//! Args: none. The handler takes no `data` parameter, and `8` is deliberately **absent
//! from `ZERO_ARG_TAGS`**: nothing may stand between the crank and the one handler that
//! must never return `Err`, so a trailing payload is ignored rather than rejected.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | clock, bullet pool, phase |
//! | 1 | boss | `w` | timer, aggro, vent |
//! | 2 | players | `w` | health, respawns |
//! | 3 | crank signer | `r s` | **read-only signer**, PDA `["crank-executor", Arena.crank_authority]` under `Crank11111111111111111111111111111111111111` |
//!
//! No client ever builds this. `start_match` freezes the four metas and the single data
//! byte into the validator's crank row and the row is replayed every 400 ms; a crank may
//! carry no writable signer and cannot re-arm itself, so the shape is immutable for the
//! life of the match. Every rejection inside the handler is `Ok(())`, never `Err`: ten
//! consecutive failures delete the task permanently, ~26 s in.
//!
//! # Tag 9 — `Settle`, ER
//!
//! Args: none (`ZERO_ARG_TAGS`).
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `r s` | must equal `Arena.crank_authority`. **Read-only on purpose**: the ER rejects writable non-delegated accounts, so the treasury signs read-only and a throwaway keypair pays the (zero) fee |
//! | 1 | arena | `w` | committed; also stands in as the crank cancel's `task_context` |
//! | 2 | boss | `w` | committed |
//! | 3 | players | `w` | committed |
//! | 4 | magic context | `w` | `MagicContext1111111111111111111111111111111` |
//! | 5 | magic program | `r` | `Magic11111111111111111111111111111111111111` |
//!
//! Sets `phase = Settled`, cancels the tag 8 crank, then commits and undelegates all
//! three. Rejects a `Lobby` arena — it was never delegated with players in it and has
//! nothing to record.
//!
//! # Tag 10 — `WriteLeaderboard`, base layer
//!
//! **Args: none.** The handler takes no `data` parameter: it reads the authoritative
//! `(arena_id, incarnation)` pair off the `Arena` account, because a pair supplied on the
//! wire would let a retry file the match under a different key and duplicate twenty rows.
//! `10` is absent from `ZERO_ARG_TAGS`, so a trailing block is silently ignored rather
//! than rejected — the canonical client encoding is nevertheless the bare tag byte and
//! nothing else. Do not send the legacy 10-byte block.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | must equal `init::TREASURY` **and** `Arena.crank_authority` |
//! | 1 | leaderboard | `w` | PDA `["leaderboard"]`, never delegated |
//! | 2 | arena | `r` | undelegated and owned by us again by now; `phase` must be `Settled` |
//! | 3 | players | `r` | PDA `["players", arena]` |
//!
//! Idempotent by the `(arena_id, incarnation)` guard on `Leaderboard`, because
//! `GetCommitmentSignature` throws on every failure path and the settle route is retried
//! by design.
//!
//! # Tags 11 and 12 — `Commit`, `CommitAndUndelegate`, ER, operator-only
//!
//! Args: none (`ZERO_ARG_TAGS`). **Exactly 6 accounts**, no `..` in either pattern.
//! Note the order is **not** tag 9's — the two magic accounts come second and third.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `s` | must equal `Arena.crank_authority` — ER fees are zero, so this check *is* the rate limit on the ten-commit quota |
//! | 1 | magic context | `w` | `MagicContext1111111111111111111111111111111` |
//! | 2 | magic program | `r` | `Magic11111111111111111111111111111111111111` |
//! | 3 | arena | `w` | tag 12 sets `phase = Settled` and rejects a second run |
//! | 4 | boss | `w` | |
//! | 5 | players | `w` | |
//!
//! Tag 11 is a mid-match snapshot and **spends the commit quota** — ten per account
//! before `0xA0000000` locks them out until re-delegation, and settle needs one. Tag 12
//! requires the tag 8 crank to be cancelled first, or it keeps firing into accounts that
//! no longer live on the ER.
//!
//! # Pre-tag route
//!
//! One instruction carries no tag of ours and **must never be given one**. The delegation
//! program CPIs back into us once per undelegated account (three times per match) with
//! its own 8-byte discriminator, so `lib.rs` routes on the full discriminator *before*
//! the tag split — otherwise its leading byte, `196`, reads as an unknown tag and the
//! three match accounts can never leave the ER. Routing on all eight bytes rather than on
//! `196` alone is what keeps a truncated payload from reaching the handler.
//!
//! - Discriminator: `[196, 28, 41, 206, 48, 37, 51, 167]`
//!   (`ephemeral_rollups_pinocchio::consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`)
//! - Data: those 8 bytes, then a borsh `Vec<Vec<u8>>` of the account's PDA seeds without
//!   the bump. Not our encoding — the delegation program's.
//! - Accounts, **exactly 4**, fixed by the delegation program:
//!   `[delegated_account (w), buffer (r s), payer (w s), system_program (r)]`.
//! - Handler: `delegation::process_undelegation`, base layer.
//!
//! There is deliberately no authority check. Authentication is structural and lives
//! inside the SDK's `undelegate`: `buffer` must be a signer owned by the delegation
//! program at the canonical `["undelegate-buffer", account]` PDA, which only the
//! delegation program can produce, and the seeds must re-derive `delegated_account` under
//! our program id or the `CreateAccount` CPI fails.
//!
//! # Bounds the handlers owe this table
//!
//! There is no boundary layer above the handlers, so each of these is the handler's own
//! responsibility and none may be skipped:
//!
//! - `seat` is checked `< state::MAX_SEATS` before it indexes `Players.slots`. A fallible
//!   `slots.get_mut(seat)` satisfies this; a bare `slots[seat]` does not.
//! - `dir` (tag 7) is checked against the length of the facing table before it indexes
//!   one — eight-way, matching `PlayerSlot.facing`.
//! - `dx`/`dy` (tag 6) are attacker-chosen and only their **signs** are read:
//!   `player::octant` quantizes them to one of eight octants and the displacement itself
//!   comes off `MOVE_STEP`, so `(127, 127)` moves exactly as far as `(1, 1)`. `(0, 0)` is
//!   not a direction and is rejected. The destination is then clamped to the map and
//!   re-checked against the wall bitboard.
//! - Nothing here rate-limits. ER fees are zero and the ER runs no fee-payer validation,
//!   so the per-seat tick counters written by the handlers (`last_move_tick`,
//!   `last_shot_tick`) are the only rate limit that exists anywhere.
//!
//! # `Move` carries no facing
//!
//! Tag 6 sends a displacement, not a direction, so `PlayerSlot.facing` is derived from
//! the sign of `(dx, dy)` — it is not on the wire. Tag 7 sends `dir` directly and
//! overwrites `facing` with it. Keep the two derivations agreeing on the octant numbering
//! (0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW, y down) or a player's sprite faces one way
//! and their shots leave in another.
