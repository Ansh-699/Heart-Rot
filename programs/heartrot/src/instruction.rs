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
//! 2, 3, 9, 11, 12 and 15 take no `data` parameter at all, so `lib.rs::ZERO_ARG_TAGS`
//! refuses a trailing payload on their behalf before dispatch.
//!
//! Tag 14 is the one tag that is deliberately **not** in `ZERO_ARG_TAGS` despite having a
//! fixed block: it is the VRF oracle's callback, and every rejection on that path has to
//! be `Ok(())` (see the tag 14 section), which a pre-dispatch `Err` would defeat.
//!
//! Tags are **append-only**: never renumber, never reuse a retired one. `8` is frozen
//! hardest — `settle::begin_muster` writes it into the validator's crank row at schedule
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
//! | 3 | `BeginMuster` | `settle::begin_muster` | ER | 0 B | 5 | `Arena.crank_authority` |
//! | 4 | `ClaimSeat` | `player::join` | ER | 67 B | 3 | `Arena.crank_authority` |
//! | 5 | `EnterGate` | `player::enter_gate` | ER | 1 B | 3 | `slots[seat].session_pubkey` |
//! | 6 | `Move` | `player::move_player` | ER | 5 B | 3 | `slots[seat].session_pubkey` |
//! | 7 | `Shoot` | `shoot::process` | ER | 4 B | 4 | `slots[seat].session_pubkey` |
//! | 8 | `BossTick` | `tick::process` | ER | 0 B | 4 | crank signer PDA (read-only) |
//! | 9 | `Settle` | `settle::settle` | ER | 0 B | 6 | `Arena.crank_authority` |
//! | 10 | `WriteLeaderboard` | `settle::write_leaderboard` | base | 0 B | 4 | `init::TREASURY` |
//! | 11 | `Commit` | `delegation::process_commit` | ER | 0 B | 6 exact | `Arena.crank_authority` |
//! | 12 | `CommitAndUndelegate` | `delegation::process_commit_and_undelegate` | ER | 0 B | 6 exact | `Arena.crank_authority` |
//! | 13 | `RequestRoll` | `roll::request_roll` | ER | 1 B | 8 | `slots[seat].session_pubkey` |
//! | 14 | `ConsumeRoll` | `roll::consume_roll` | ER | 34 B | 2 | scoped VRF identity PDA (read-only) |
//! | 15 | `NextIncarnation` | `init::next_incarnation` | base | 0 B | 5 | `init::TREASURY` |
//!
//! Tags 11 and 12 are operator-only and have no client builder. Tag 14 has no client
//! builder either, for a different reason: the VRF program builds it. One further
//! instruction carries no tag of ours at all — see [the pre-tag route](#pre-tag-route) at
//! the bottom.
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
//! # Tag 3 — `BeginMuster`, ER
//!
//! Args: none (`ZERO_ARG_TAGS`). Sent to the **ER**, after tag 2 has confirmed:
//! `Magic11111…` is a runtime builtin, so a base-layer CPI to it cannot resolve.
//!
//! The tag, the ABI and all five accounts are **unchanged** — only the semantics moved.
//! It used to flip straight to `Fighting`; it now opens the muster window.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | must equal `Arena.crank_authority`; becomes the crank task authority, so it is the only key that can ever cancel the task |
//! | 1 | arena | `w` | frozen into the crank row |
//! | 2 | boss | `w` | frozen into the crank row |
//! | 3 | players | `w` | frozen into the crank row; **also read**, for the raider check below |
//! | 4 | magic program | `r` | `Magic11111111111111111111111111111111111111` |
//!
//! This flips `phase` to `Mustering`, stamps `fight_at_tick = tick + MUSTER_TICKS`, and
//! schedules the tag 8 crank in the same instruction, because neither half is useful
//! without the other. The crank itself performs the `Mustering → Fighting` flip at the
//! deadline, so no player, host or Worker has to act and a raid can never fail to start.
//! `LOBBY → FIGHTING` no longer exists as an edge.
//!
//! It refuses with [`crate::error::HeartrotError::NoRaiders`] when no seat is in
//! `ZONE_ARENA` — [`crate::guards::assert_any_raider`] over the `Players` account already
//! at index 3, so the refusal costs no new account and no new signer. Without it a raid
//! can be armed over an empty pit: `spawn_volley` finds no target, nothing ever fires, and
//! the whole enrage window elapses into `OUTCOME_ENRAGE`. The client auto-sends this the
//! first time it sees its own zone flip, so 19 of 20 senders get the existing 409 and the
//! twentieth may legitimately get `NoRaiders` if the gate transaction has not landed yet:
//! it is a retry, not an error to surface.
//!
//! # Tag 4 — `ClaimSeat`, ER
//!
//! Args, 67 bytes exactly (`player::JOIN_DATA_LEN`). **This block grew from 66 bytes and
//! is not backward compatible** — the same property tag 7 already has, and it is
//! deliberate: `class` is *appended*, so no existing offset moves and both 32-byte slices
//! are untouched, and an old client's 66-byte block is refused as a clean
//! `InvalidInstructionData` instead of being read one byte short. The program, the app and
//! the Worker therefore ship together; a partial deploy fails every join rather than
//! seating anybody with a misread byte.
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0]` | 1 | `seat` | u8; the Worker's chosen index, bounds-checked by `slots.get_mut` |
//! | `[1]` | 1 | `skin_id` | u8 |
//! | `[2..34]` | 32 | `session_pubkey` | the browser session key; **must be non-zero** (all-zero is the "unclaimed" sentinel) |
//! | `[34..66]` | 32 | `identity` | Privy identity; **must be non-zero** |
//! | `[66]` | 1 | `class` | u8; 0 knight, 1 archer. **Must be `< state::N_CLASSES`; never clamped** |
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | `seat_occupied` bitmask |
//! | 1 | players | `w` | |
//! | 2 | treasury | `s` | must equal `Arena.crank_authority` |
//!
//! Seats are administered, not self-served: a session key that could claim its own seat
//! would take all twenty for free, since ER fees are zero. If `identity` already holds a
//! seat, that seat is kept whatever `seat` asks for and only the key and the skin rotate —
//! which is what makes the Worker's `/session/init` safe to retry.
//!
//! **`class` is not among the fields a returning identity rotates**, and `skin_id` is. The
//! asymmetry is the point: a skin is a render hint, while a class is the cooldown and the
//! damage `shoot` reads, and `last_shot_tick` survives a rotation — so a re-`join` mid-fight
//! would swap a knight's 800 ms cooldown for an archer's 70 damage and break the
//! DPS-neutrality the two classes are built to. The class a seat carries is therefore fixed
//! for the incarnation, and `/session/init` stays idempotent because the byte it would
//! rewrite is the byte it already wrote.
//!
//! `class` lands in `PlayerSlot.class_aim` bit 7 and nowhere else. The low seven bits of
//! that byte are live aim state owned by `shoot::fire`; a fresh claim writes the whole byte
//! because the slot is zeroed first, and any *later* writer must preserve the aim (that is
//! what `PlayerSlot::set_class` is for). Nothing changes shape — `class_aim` is the old
//! `_pad0`, so `size_of::<PlayerSlot>()` stays 96 and `LAYOUT_VERSION` stays 1.
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
//! Args, 4 bytes exactly (`shoot::parse_shot`). **This block grew from 3 bytes and is not
//! backward compatible**, the same property it already had at 2 → 3: an old client sending
//! the 3-byte block gets a clean length refusal (`InvalidInstructionData`) rather than a
//! missing byte read as "uncharged", so the program and the app must ship together.
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0]` | 1 | `seat` | u8 |
//! | `[1]` | 1 | `dx` | **i8**, signed — free aim, raw and unnormalised |
//! | `[2]` | 1 | `dy` | **i8**, signed |
//! | `[3]` | 1 | `charged` | u8; 0 or 1. **Must be `<= 1`; never masked** |
//!
//! `dir` is gone. Eight-way aim made a top-centre boss unhittable: replaying `raycast`
//! over 110 pit stands, 8-way reaches a target from 68.2% of them and **never** reaches
//! the core, against 110/110 and 9 of 10 targets for the `i8` pair. The pair is normalised
//! **on chain** by `tick::unit_velocity`, so no table, no extra byte and no client-supplied
//! magnitude is trusted: `(127, 127)` and `(1, 1)` are the same shot.
//!
//! `charged = 1` asks for `state::charged_damage` (2.5×) and is **granted by the chain, not
//! by the byte**: the seat's last accepted step must be at least `state::CHARGE_SLOTS` (20)
//! ER slots old, measured as `Clock::get()?.slot − slots[seat].last_move_tick` — slot
//! against slot, never against `Arena.tick`, which is a crank tick on another clock. A
//! shorter hold is refused with [`crate::error::HeartrotError::NotCharged`] (`Custom(20)`)
//! **before the cooldown is spent**, so the client resends the shot uncharged and loses a
//! round trip, not the shot. Nothing is stored for the hold; a step cancels it by moving
//! the stamp. The result is published in `PlayerSlot.facing` bit 3
//! (`state::CHARGED_SHOT_BIT`), which the next step or uncharged shot clears.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | `tick` and `raid_size` are read; `phase` is written on the killing blow |
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
//! No client ever builds this. `begin_muster` freezes the four metas and the single data
//! byte into the validator's crank row and the row is replayed every `state::TICK_MS`
//! (100 ms — the row was written when that was 400); a crank may
//! carry no writable signer and cannot re-arm itself, so the shape is immutable for the
//! life of the match. Every rejection inside the handler is `Ok(())`, never `Err`: ten
//! consecutive failures delete the task permanently, seconds into the match at a 100 ms
//! period rather than the ~26 s that number was measured at when the tick was 400 ms.
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
//! # Tag 13 — `RequestRoll`, ER
//!
//! Args, 1 byte exactly: `seat` u8 at `[0]`.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | arena | `w` | `phase` must be `Settling` **and** `outcome` must be `Win`; stamps `roll_requested_tick` |
//! | 1 | players | `r` | read only to resolve `slots[seat].session_pubkey` |
//! | 2 | payer / session key | `w s` | must equal `slots[seat].session_pubkey`. **Writable**: the VRF program's first account is a writable signer and a CPI cannot escalate a read-only account to writable |
//! | 3 | program identity | `r` | PDA `["identity"]` under **this** program; we `invoke_signed` it, so it is not a signer on the incoming transaction |
//! | 4 | oracle queue | `w` | must equal `vrf::consts::DEFAULT_EPHEMERAL_QUEUE` — `5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc`. In-ER only; the base-layer `DEFAULT_QUEUE` charges 500,000 lamports a request |
//! | 5 | system program | `r` | |
//! | 6 | slot hashes | `r` | `SysvarS1otHashes111111111111111111111111111` |
//! | 7 | vrf program | `r` | `Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz` |
//!
//! **A player asks, never the crank.** The VRF request needs a writable signer and tag 8
//! may carry none — that is a hard property of cranks, not an oversight — so the killing
//! blow's client sends tag 13 straight after its shoot lands, on the popup-free session
//! key it already holds. The in-ER queue is fee-exempt, so a zero-lamport session key pays
//! for it, and a failure is visible to the player instead of buried in a crank log.
//!
//! Any claimed seat may send it, not only the killer: one rule, and if the killer's browser
//! closed between the two transactions the other nineteen can still ask. It needs no rate
//! limiter — `Settling → Rolling` is a one-shot edge, so a second request is refused as an
//! illegal transition, not as a quota breach.
//!
//! Not folded into tag 7: `Shoot` is the hottest instruction in the program and four extra
//! VRF accounts on every shot would spend CU and key budget on all of them to serve one.
//! Splitting them is also what makes `Settling` a real persisting state — "core dead,
//! nobody has asked yet" — which is the state tag 8's timeout needs in order to finish the
//! loop when nobody ever does ask.
//!
//! # Tag 14 — `ConsumeRoll`, ER, VRF callback only
//!
//! Args, 34 bytes exactly:
//!
//! | Offset | Width | Field | |
//! |---|---|---|---|
//! | `[0..32]` | 32 | `randomness` | the fulfilled VRF output, written verbatim into `Arena.next_affix_seed` |
//! | `[32..34]` | 2 | `for_incarnation` | u16 LE, echoed from `callback_args`; a roll that lands after the arena has already advanced is discarded rather than applied to the wrong boss |
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | scoped vrf identity | `r s` | must equal `vrf::pda::scoped_vrf_identity(program_id)` = PDA `["identity", <this program>]` under the **VRF** program. **This check is the entire security of the instruction**: without it any caller writes the next boss's ruleset. The global `VRF_PROGRAM_IDENTITY` is deprecated and shared with every consumer on the network — asserting that one leaves the callback spoofable |
//! | 1 | arena | `w` | `phase` must be `Rolling`; receives `next_affix_seed` |
//!
//! **Nobody builds this instruction but the VRF program.** Tag 13's CPI freezes the
//! discriminator (`[14]`, one byte, cap 8), the two account metas above (cap 25) and the
//! `callback_args` (`incarnation.to_le_bytes()`, cap 512) into the request, and the oracle
//! replays exactly that shape on fulfilment. The oracle prepends its discriminator and
//! appends the randomness, which is why the callback needs no pre-tag route: our chosen
//! discriminator **is** one byte and **is** the tag, so it lands in the ordinary dispatch.
//! Never widen it past one byte, and never renumber it — 14 is as frozen as 8.
//!
//! `Boss` is deliberately not an account here. The boss is rescaled by tag 15 on the base
//! layer, so the frozen callback list stays two entries and never has to name `Players`,
//! which could not fit the 25-account cap anyway.
//!
//! Every rejection on this path is `Ok(())`, never `Err` — a wrong length, a stale
//! `for_incarnation`, a failed identity check, a wrong phase, all of them. An `Err` reverts
//! the oracle's `ProvideRandomness` transaction, which it then retries for the request's
//! full 240-slot TTL. This is the same discipline tag 8 is held to, for the same reason.
//!
//! # Tag 15 — `NextIncarnation`, base layer
//!
//! Args: none (`ZERO_ARG_TAGS`). Sent on the **base layer**, after tag 10 has filed the
//! finished match: it rewrites all three accounts, which the ER holds while they are
//! delegated.
//!
//! | # | Account | Flags | |
//! |---|---|---|---|
//! | 0 | payer | `w s` | must equal `init::TREASURY` — it re-arms the boss and reopens the match, the same authority `init_arena` needs |
//! | 1 | arena | `w` | undelegated and ours again; `phase` must be `Settled` and `next_affix_seed` must be non-zero |
//! | 2 | boss | `w` | PDA `["boss", arena]` |
//! | 3 | players | `w` | PDA `["players", arena]` |
//! | 4 | leaderboard | `r` | PDA `["leaderboard"]`; must show `last_arena_id == Arena.arena_id && last_incarnation == Arena.incarnation` |
//!
//! Incarnation N+1 reuses the same three accounts, reset in place: fresh ones would cost
//! 0.0245 SOL of rent per incarnation and orphan the old, the `Arena` PDA is
//! `["arena", arena_id]` so reuse keeps one address per raid chain, and `Leaderboard`'s
//! idempotency key is already `(arena_id, incarnation)`.
//!
//! The read-only `Leaderboard` at index 4 is an **ordering interlock, not a data source**.
//! `write_leaderboard` is gated on `phase == Settled` and this instruction flips `phase` to
//! `Lobby` and zeroes every `damage_dealt`, so a tag 15 that beat tag 10 would erase the
//! whole match record with nothing left able to notice. Requiring the leaderboard to
//! already name this exact `(arena_id, incarnation)` makes that ordering structural.
//!
//! Both extra conditions — the `Settled` phase and the non-zero seed — refuse with
//! `HeartrotError::WrongPhase`. That is one condition ("this instruction is not legal from
//! this state"), and the reason is readable straight off the account the caller already
//! passed: `outcome` says the raid lost, or an all-zero `next_affix_seed` says the oracle
//! never answered. A second error code would carry no information the caller does not hold.
//!
//! There is no `roll_verified` flag anywhere. All-zero `next_affix_seed` is the sentinel
//! *and* the verification: the only writer of those bytes is tag 14, which the scoped VRF
//! identity signs, so "non-zero" already means "a proof was verified on chain".
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
//! - `class` (tag 4) is checked `< state::N_CLASSES` and **rejected, never clamped**.
//!   `player::parse_join`'s `class >= N_CLASSES` refusal satisfies this, the way
//!   `slots.get_mut` satisfies the seat bound, and it is what lets `claim_seat` write
//!   `class * CLASS_MASK` with no bounds check and no panic path in the BPF — a class of 2
//!   would otherwise overflow the byte and alias onto the knight. Clamping is the failure
//!   mode worth naming, more than the overflow: it turns client/program version skew — the
//!   one thing an appended wire byte makes likely — into a player who silently gets a class
//!   they did not pick and a damage number that does not match their own UI, with nothing
//!   anywhere reporting a fault. The refusal is `InvalidInstructionData`, the same code
//!   the length check uses, and deliberately not a `HeartrotError`: see `error.rs`'s
//!   "Why the class byte gets no code". It is not a `guards.rs` check either — that
//!   module owns what a `&mut [u8]` cannot see (owner, signer, PDA, session key), and a
//!   byte's own range is not that.
//! - `dx`/`dy` (tag 7) are attacker-chosen and carry **no** bound worth checking: the pair
//!   is normalised on chain to a fixed step length, so magnitude cannot be inflated, and
//!   every direction is legal. `(0, 0)` is the one rejection — it is not a direction — and
//!   the ray is bounded by `MAX_RAY_STEPS`, not by the caller. `facing` is stamped by
//!   quantizing the pair with `player::octant`, which itself rejects `(0, 0)`, so nothing
//!   indexes the eight-way table with a value off the wire.
//! - `charged` (tag 7) is checked `<= 1` and **rejected, never masked**, by
//!   `shoot::parse_shot` — a 2 is version skew and has to be loud. The byte is a request,
//!   not a grant: whether the shot *is* charged is decided by the chain from
//!   `last_move_tick` and the ER slot, so an attacker who sets it gains nothing a player
//!   standing still for a second does not already have.
//! - `dx`/`dy` (tag 6) are attacker-chosen and only their **signs** are read:
//!   `player::octant` quantizes them to one of eight octants and the displacement itself
//!   comes off `MOVE_STEP`, so `(127, 127)` moves exactly as far as `(1, 1)`. `(0, 0)` is
//!   not a direction and is rejected. The destination is then clamped to the map and
//!   re-checked against the wall bitboard.
//! - Nothing here rate-limits. ER fees are zero and the ER runs no fee-payer validation,
//!   so the per-seat tick counters written by the handlers (`last_move_tick`,
//!   `last_shot_tick`) are the only rate limit that exists anywhere.
//!
//! # Neither `Move` nor `Shoot` carries a facing
//!
//! Both send a displacement, never a direction: `PlayerSlot.facing` is derived from
//! `(dx, dy)` by `player::octant` on both paths and is on the wire on neither. That is one
//! derivation used twice, so the two cannot disagree — which is the whole reason tag 7
//! stopped sending `dir`. Keep the octant numbering (0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W,
//! 7 NW, y down) as `PlayerSlot.facing` documents it, and note that `facing` is a
//! horizontal flip in the renderer: the knight art has one pose, so a flip cannot express
//! NE against SE. Hitscan can, and does — `facing` is cosmetic, the `(dx, dy)` pair is what
//! decides the hit.
//!
//! The octant is the low three bits only. Bit 3 of the same byte is the charged-shot flag
//! (`state::CHARGED_SHOT_BIT`), written by tag 7 and cleared by tag 6's bare-octant write,
//! so a client decodes `facing & 7` and `facing >> 3 & 1` as two fields.
