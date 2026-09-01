# HEARTROT — Account Layout Contract

**Date:** 2026-09-01
**Status:** Frozen for v1. Every other file in this build codes against these numbers.
**Implemented by:** `programs/heartrot/src/state.rs` (Rust) and
`packages/client/src/layout.ts` (TypeScript). Both were written from this table; all
three must be changed together.

---

## 0. What this fixes, and what it supersedes

Four accounts: **Arena**, **Boss**, **Players**, **Leaderboard**. This is decision
**D3** in `03-risks-and-build-order.md`, restated in R15 and in that document's build
order ("`Arena` account (state + a bullet stub), `Boss` account (position, parts,
core), `Players[20]` packed").

> **Doc conflict, resolved.** `01-architecture.md` §2.1 still shows the earlier
> two-type layout — `Arena` with `Boss` embedded, plus **20 separate `Player`
> accounts** — and §3 / §8 count 21 delegated accounts. D3 supersedes it: `Boss` is
> its own account and all 20 seats are packed into one `Players` account, so a match
> delegates **3** accounts, not 21. Every "21 accounts" in `01-architecture.md` and
> `02-diagrams.md` should read "3". Nothing else in those documents changes — the
> fields are the same fields.

Why the packing is mandatory rather than merely cheaper:

- The ER rejects any transaction whose `program_id_index >= 38`, unconditionally, and
  Solana's message compiler sorts program ids last — so for a write-heavy transaction
  that is a **~38 total account key ceiling**.
- Address lookup tables are rejected outright by the same validator path (D18), so
  there is no escape hatch. Packing is the only lever.
- A crank's account list is frozen at schedule time and replayed forever. A layout
  that breaches the ceiling is rejected **every tick**, burns the 10-retry ladder, and
  deletes the task permanently ~26 s into the match.

`boss_tick`'s frozen list is now `[Arena, Boss, Players, crank_signer]` — four metas
plus two program ids. Six keys against a 38-key ceiling.

### Cost, per match

| Line | Lamports | SOL |
|---|---|---|
| Rent, Arena + Boss + Players | 24,485,280 | 0.02449 (**recoverable** on close) |
| Undelegation session charge, 3 × 300,000 | 900,000 | 0.0009 |
| Leaderboard rent (one-time, base layer, never delegated) | 43,875,840 | 0.04388 |

Down from ~0.0416 SOL of rent and 0.0063 SOL of session charge under the 21-account
layout. Rent-exemption throughout is `(128 + data_len) × 6,960` lamports
(`ACCOUNT_STORAGE_OVERHEAD` 128 bytes; 3,480 lamports/byte-year × 2 years).

---

## 1. Rules that hold for every account

1. **`#[repr(C)]`, `bytemuck::Pod` + `Zeroable`, zero-copy.** Nothing is serialized.
   The crank rewrites `Arena` every 400 ms; a borsh round trip of a 1 KB bullet pool
   at 2.5 Hz is the exact cost that killed the ECS design.
2. **No implicit padding.** Every gap is an explicit `_pad` field. `bytemuck`'s `Pod`
   derive refuses to compile otherwise, and an implicit gap decodes as garbage on the
   client with no error anywhere.
3. **Byte 0 = discriminator, byte 1 = version, byte 2 = bump**, in all four types.
   Pinocchio validates nothing: the discriminator is the *only* thing stopping `Boss`
   being passed where `Players` is expected. It is a security control.
4. **Little-endian** throughout, matching Solana.
5. **No `bool`, no `Option`, no `Vec`, no payload enums, no `f32`/`f64`.** Floats are
   non-deterministic across validators; the rest are not `Pod`. Optionality is a
   documented sentinel (§7).
6. **All arithmetic on these fields is checked** (`checked_*` / `saturating_*`). An
   overflow in a health or position field is an exploit, not a panic.
7. **Alignment.** The runtime places account data at an 8-byte-aligned address (the
   account region is 8-aligned and the header before `data` is exactly 88 bytes), which
   satisfies every alignment below. `bytemuck::from_bytes` *panics* on misalignment, so
   `state.rs` uses `try_from_bytes` everywhere regardless.

### Discriminators

| Value | Type | Constant (Rust / TS) |
|---|---|---|
| 0 | *uninitialized* — a freshly allocated, all-zero account | `DISC_UNINITIALIZED` |
| 1 | `Arena` | `DISC_ARENA` |
| 2 | `Boss` | `DISC_BOSS` |
| 3 | `Players` | `DISC_PLAYERS` |
| 4 | `Leaderboard` | `DISC_LEADERBOARD` |

`LAYOUT_VERSION = 1` in byte 1. Reserving 0 for "uninitialized" is what makes a
zeroed account fail every read without a separate `is_initialized` flag, and what
makes `init` non-repeatable: it demands discriminator 0, so a second `init` on a live
account is rejected instead of resetting a match in progress.

### PDA derivations

| Account | Seeds | Program | Delegated to the ER? |
|---|---|---|---|
| `Arena` | `[b"arena", arena_id.to_le_bytes()]` | `heartrot` | yes, for the match |
| `Boss` | `[b"boss", arena_key]` | `heartrot` | yes, for the match |
| `Players` | `[b"players", arena_key]` | `heartrot` | yes, for the match |
| `Leaderboard` | `[b"leaderboard"]` | `heartrot` | **never** |
| Crank signer | `[b"crank-executor", arena.crank_authority]` | `Crank1111…1111` | n/a |
| Delegation record | `[b"delegation", account]` | `DELeGG…SaeSh` | n/a |

`Boss` and `Players` seeds are derived from the **Arena address**, not from
`arena_id`, so one hash of a known key gives both. `arena_id` is only ever a seed of
`Arena` itself.

---

## 2. `Arena` — 1,160 bytes

Match clock, crank wiring, bullet pool. Written by `boss_tick` (every 400 ms) and by
`shoot`. `tick` is also the client's crank-liveness heartbeat — there is no RPC to ask
whether a task is alive, so a stalled `tick` is the only signal that exists.

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `discriminator` | u8 | 0 | 1 | `DISC_ARENA` = 1 |
| `version` | u8 | 1 | 1 | `LAYOUT_VERSION` = 1 |
| `bump` | u8 | 2 | 1 | PDA bump for this account |
| `phase` | u8 | 3 | 1 | 0 Lobby · 1 Fighting · 2 Settling · 3 Settled |
| `alive_count` | u8 | 4 | 1 | players alive in `ZONE_ARENA`; drives `bullets_per_volley = 3 + alive_count` |
| `bullet_cursor` | u8 | 5 | 1 | next pool slot `boss_tick` probes when claiming a free bullet |
| `_pad0` | [u8; 2] | 6 | 2 | align `arena_id` to 8 |
| `arena_id` | u64 | 8 | 8 | match identity; also the `Arena` PDA seed |
| `crank_task_id` | **i64** | 16 | 8 | validator-**global** task id. i64, not u64 — the published docs are wrong |
| `tick` | u32 | 24 | 4 | authoritative clock, +1 per crank execution |
| `enrage_at_tick` | u32 | 28 | 4 | 6-minute timeout in ticks (900 at 400 ms) |
| `seat_occupied` | u32 | 32 | 4 | bitmask, bit *n* = seat *n*, low bit first; high 12 bits always 0 |
| `incarnation` | u16 | 36 | 2 | boss incarnation; scales `parts_max` |
| `_pad1` | [u8; 2] | 38 | 2 | align `crank_authority` |
| `crank_authority` | [u8; 32] | 40 | 32 | treasury the crank signer PDA derives from |
| `validator_identity` | [u8; 32] | 72 | 32 | which ER this match lives on |
| `affix_seed` | [u8; 32] | 104 | 32 | `hashv([arena_key, incarnation])` in v1; VRF fills it in v1.1 |
| `bullets` | [Bullet; 128] | 136 | 1,024 | boss projectile pool, 8 bytes per slot |

**Total 1,160 bytes.** Align 8. Rent-exempt **8,964,480 lamports** (≈ 0.00896 SOL).

### `Bullet` — 8 bytes, align 2

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `x` | i16 | 0 | 2 | arena-space position |
| `y` | i16 | 2 | 2 | |
| `dx` | i8 | 4 | 1 | per-tick velocity |
| `dy` | i8 | 5 | 1 | |
| `active` | u8 | 6 | 1 | 0 free · 1 active. u8 not bool — bool is not `Pod` |
| `_pad0` | u8 | 7 | 1 | |

Slot *i* is at `136 + i × 8`.

**Invariants**

- `phase ∈ {0,1,2,3}`. `boss_tick` returns `Ok(())` immediately unless `phase == 1`.
- `alive_count ≤ 20`, and equals the number of slots with `hp != 0 && zone == 1`.
- `bullet_cursor < 128`.
- `seat_occupied >> 20 == 0`. Bit *n* set ⟺ `Players.slots[n].session_pubkey != [0; 32]`.
- `crank_task_id > 0`, wide and random: it is a validator-global namespace and a
  collision fails **silently after the scheduling CPI returns Ok**. Derive as
  `(i64::from_le_bytes(hashv([b"crank", arena_key, arena_id])[0..8]) & i64::MAX).max(1)`.
- `tick` is monotonic and never reset within a delegation session; the client's
  watchdog compares deltas against 3 s (soft) and 45 s (hard).
- Position/velocity are integers on both sides of the boundary. The client extrapolates
  bullets **exactly** — same integers, same fixed step, zero prediction error — which is
  what renders a 2.5 Hz stream as 60 fps bullet hell. Any float breaks it.
- Never derive timing from wall-clock. `tick` is the only clock; 400 ms is a target,
  not a contract.

---

## 3. `Boss` — 50 bytes

The boss is a shell, not a health bar: `parts` *is* its health, and `core_hp` is only
damageable once the shell is stripped past the vent threshold. Its own account because
`shoot` writes parts on every player shot while the crank writes bullets on every tick;
splitting them keeps a hitscan transaction from carrying the 1 KB pool it never touches.

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `discriminator` | u8 | 0 | 1 | `DISC_BOSS` = 2 |
| `version` | u8 | 1 | 1 | `LAYOUT_VERSION` = 1 |
| `bump` | u8 | 2 | 1 | PDA bump |
| `vent_open` | u8 | 3 | 1 | 0 sealed · 1 open. Derived state, cached for the client |
| `attack_timer` | u8 | 4 | 1 | ticks to the next attack beat |
| `target_seat` | u8 | 5 | 1 | nearest alive arena player, or `0xFF` = none |
| `x` | i16 | 6 | 2 | arena-space position |
| `y` | i16 | 8 | 2 | |
| `core_hp` | u16 | 10 | 2 | kill condition; only decrements while `vent_open == 1` |
| `core_hp_max` | u16 | 12 | 2 | |
| `parts` | [u16; 9] | 14 | 18 | current HP per destructible part |
| `parts_max` | [u16; 9] | 32 | 18 | scaled `× (1 + incarnation × 0.15)` at spawn, in integers |

**Total 50 bytes.** Align 2. Rent-exempt **1,238,880 lamports** (≈ 0.00124 SOL).

Part indices, fixed and index-aligned with the hitbox JSON `tools/svg_slice.py` emits —
one build step produces both the `<g>` the browser animates and the rectangle this
program raycasts against, so the DOM and the chain cannot drift:

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| crown | wolf_l | beast_r | thorn0 | thorn1 | thorn2 | thorn3 | mace | claws |

**Invariants**

- `parts[i] ≤ parts_max[i]` for all *i*; `core_hp ≤ core_hp_max`.
- `vent_open == 1` ⟺ `sum(parts) × 100 < sum(parts_max) × 35`. Recomputed every tick
  from the parts; never set independently. (Integer comparison — no percentage float.)
- `core_hp` may only decrease while `vent_open == 1`.
- `target_seat` is `NO_TARGET` (0xFF) or `< 20`. 0xFF is outside the seat range so a
  bounds check catches it rather than silently aiming at seat 0.
- Destroying thorn *n* removes one volley emitter; this is game state readable straight
  off `parts`, with no separate emitter list.

---

## 4. `Players` — 1,924 bytes

All 20 seats in one account. Seats are index-addressed and must all exist before
`boss_tick` is scheduled: a crank can never see an account it was not handed at
schedule time, so lazy join is structurally impossible.

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `discriminator` | u8 | 0 | 1 | `DISC_PLAYERS` = 3 |
| `version` | u8 | 1 | 1 | `LAYOUT_VERSION` = 1 |
| `bump` | u8 | 2 | 1 | PDA bump |
| `_pad0` | u8 | 3 | 1 | align `slots` to 4 |
| `slots` | [PlayerSlot; 20] | 4 | 1,920 | seat *n* is at `4 + n × 96` |

**Total 1,924 bytes.** Align 4. Rent-exempt **14,281,920 lamports** (≈ 0.01428 SOL).

### `PlayerSlot` — 96 bytes, align 4

The slot **index is the seat number**; there is no `seat` field to disagree with it.

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `zone` | u8 | 0 | 1 | 0 lobby · 1 arena. The gate tile flips it |
| `facing` | u8 | 1 | 1 | 0..7, eight-way. Hitscan raycasts along it |
| `skin_id` | u8 | 2 | 1 | chosen at character select |
| `_pad0` | u8 | 3 | 1 | align `x` |
| `x` | i16 | 4 | 2 | position, same units as `Bullet` and `Boss` |
| `y` | i16 | 6 | 2 | |
| `hp` | u16 | 8 | 2 | 0 = dead |
| `hp_max` | u16 | 10 | 2 | |
| `last_move_seq` | u16 | 12 | 2 | echo of the client's input sequence number |
| `_pad1` | [u8; 2] | 14 | 2 | align `respawn_at_tick` |
| `respawn_at_tick` | u32 | 16 | 4 | tick at which `boss_tick` returns this player to the entrance |
| `last_shot_tick` | u32 | 20 | 4 | rate limit for `shoot` |
| `last_move_tick` | u32 | 24 | 4 | rate limit for `move`, one accepted move per tick |
| `damage_dealt` | u32 | 28 | 4 | cumulative, for the leaderboard |
| `session_pubkey` | [u8; 32] | 32 | 32 | browser WebCrypto Ed25519 key. All-zero = seat unclaimed |
| `identity` | [u8; 32] | 64 | 32 | `sha256(privy DID)`, durable leaderboard key |

**Invariants**

- **Authority.** Every player-facing instruction asserts
  `authority.is_signer && authority == slots[seat].session_pubkey`. That is the entire
  security perimeter, not one layer of it. One omitted check is a full compromise.
- **Rate limiting.** ER transaction fees are 0 and the ER runs no fee-payer validation
  at all, so nothing debits a spammer and the network offers no economic backstop.
  `last_shot_tick` and `last_move_tick` **are** the rate limiter. Reject
  `move` unless `arena.tick > last_move_tick`, and `shoot` unless
  `arena.tick > last_shot_tick + SHOT_COOLDOWN_TICKS`.
- Aliveness is **derived** (`hp != 0 && zone == ZONE_ARENA`), never stored. There is no
  second flag to fall out of sync with the number.
- Occupancy is **derived** from `session_pubkey != [0; 32]`, and must agree with bit
  *seat* of `Arena.seat_occupied`. The bitmask exists so the Worker can allocate a seat
  from one u32 without decoding 1,924 bytes; `session_pubkey` is the authority.
- `hp ≤ hp_max`. `facing < 8`. `zone ∈ {0,1}`.
- `last_move_seq` is written by `move` from the client's `seq` and read back by the
  client to reconcile prediction. Without it an arriving position is ambiguous as to
  which input produced it and the symptom is rubber-banding for every player.
- `claim_seat` overwrites `session_pubkey` on an existing `identity`: a returning player
  with cleared browser storage gets their seat back with a new key. Privy identity is
  the durable record; the session key is not.

> **Known ceiling (`ponytail:` in `state.rs`).** One account is also one notification
> stream. The ER emits at most one notification per account per 50 ms slot, so all 20
> players share a ~20 Hz update budget rather than getting 20 Hz each, and every move
> rewrites 1,924 bytes to every subscriber. Fine against the measured ~71 KB/s raid
> budget and invisible under client prediction. If 20 concurrent movers ever starve the
> stream, shard into two ten-seat accounts (still 4 crank metas) before considering one
> account per seat.

---

## 5. `Leaderboard` — 6,176 bytes

Base layer, **never delegated**, written by the Worker after the ER commit confirms.
Reads go browser → RPC directly; there is no route.

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `discriminator` | u8 | 0 | 1 | `DISC_LEADERBOARD` = 4 |
| `version` | u8 | 1 | 1 | `LAYOUT_VERSION` = 1 |
| `bump` | u8 | 2 | 1 | PDA bump |
| `_pad0` | [u8; 5] | 3 | 5 | align `total_written` to 8 |
| `total_written` | u32 | 8 | 4 | entries ever written, saturating. UI only |
| `next` | u32 | 12 | 4 | ring write cursor, `< 128` |
| `last_arena_id` | u64 | 16 | 8 | idempotency key of the most recent write |
| `last_incarnation` | u16 | 24 | 2 | idempotency key, second half |
| `_pad1` | [u8; 6] | 26 | 6 | align `entries` to 8 |
| `entries` | [LeaderboardEntry; 128] | 32 | 6,144 | ring; entry *i* at `32 + i × 48` |

**Total 6,176 bytes.** Align 8. Rent-exempt **43,875,840 lamports** (≈ 0.04388 SOL),
paid once. The whole account fits in a single `CreateAccount` and stays under the
10,240-byte per-instruction data-increase limit, so it never needs a realloc path.

### `LeaderboardEntry` — 48 bytes, align 8

| Field | Type | Offset | Size | Meaning |
|---|---|---|---|---|
| `arena_id` | u64 | 0 | 8 | which match |
| `identity` | [u8; 32] | 8 | 32 | `sha256(privy DID)`, copied from `PlayerSlot.identity` |
| `damage_dealt` | u32 | 40 | 4 | copied at settle |
| `incarnation` | u16 | 44 | 2 | which boss incarnation |
| `survived` | u8 | 46 | 1 | 0 or 1 — this *seat* was alive at settle |
| `outcome` | u8 | 47 | 1 | `OUTCOME_*` — how the *match* ended, copied from `Arena.outcome` |

**Invariants**

- `next < 128`; `entries[next]` is the oldest row and the next to be overwritten.
- `write_leaderboard(arena_id, incarnation)` is a **no-op** when
  `(arena_id, incarnation) == (last_arena_id, last_incarnation)`. This is required, not
  a nicety: `GetCommitmentSignature` throws on every failure path, a throw means
  *unknown, retry*, and the settle route is retried by design. Without idempotency a
  retry duplicates twenty rows.
- `outcome` spends what was `_pad0`, so the entry is still 48 bytes and the live
  devnet account keeps its size, its rent and its version byte. Rows written before the
  field existed have a zero there, which reads as `OUTCOME_UNDECIDED` — correct, since
  no outcome was recorded for them. `survived` and `outcome` answer different questions
  and neither implies the other: an `OUTCOME_ENRAGE` row can have `survived == 1`.
- The entry ordering is ring order, not chronological. Decoders return it raw plus
  `next` and `total_written`; ordering is the caller's business.

> **Known ceilings (`ponytail:` in `state.rs`).** (1) The ring holds 128 entries ≈ 6
> full raids; the oldest is overwritten with no archive. Upgrade path: one account per
> incarnation, seeds `[b"lb", incarnation.to_le_bytes()]`. (2) The idempotency key
> guards the *retry* case only — the same pair written twice in a row is a no-op, but an
> out-of-order replay of an older pair would duplicate. That cannot happen while one
> Worker settles one match at a time. Upgrade path: scan the ring for the pair.

---

## 6. Sentinels and reserved values

Optionality is never an `Option`. Every one of these is load-bearing:

| Field | Sentinel | Means |
|---|---|---|
| byte 0 of any account | `0` | uninitialized (all-zero account). Fails every read |
| `PlayerSlot.session_pubkey` | `[0; 32]` | seat never claimed |
| `Boss.target_seat` | `0xFF` | no alive player in the arena |
| `Bullet.active` | `0` | pool slot free (its `x`/`y`/`dx`/`dy` are stale, not zeroed) |
| `PlayerSlot.hp` | `0` | dead; `respawn_at_tick` says when it ends |
| `Arena.seat_occupied` bit *n* | `0` | seat *n* free |

---

## 7. Reading and writing, in code

### Rust — `programs/heartrot/src/state.rs`

```rust
pub trait AccountLayout: Pod {
    const DISCRIMINATOR: u8;
    const LEN: usize = size_of::<Self>();
}

pub fn load<T: AccountLayout>(data: &[u8]) -> Result<&T, ProgramError>;
pub fn load_mut<T: AccountLayout>(data: &mut [u8]) -> Result<&mut T, ProgramError>;
pub fn init<T: AccountLayout>(data: &mut [u8], bump: u8) -> Result<&mut T, ProgramError>;
```

`load` / `load_mut` reject a short account, a misaligned pointer, a wrong
discriminator and a wrong layout version, and are the **only** sanctioned way to reach
these structs. Do not hand-roll a cast in a handler: a forgotten discriminator check is
a type-confusion hole, and this is exactly the class of thing Pinocchio does not do for
you. `init` demands discriminator 0, stamps discriminator + version + bump, and returns
the struct; a second `init` on a live account is rejected.

Owner checks, signer checks and PDA re-derivation are **not** done here — they are the
handler's job, per account, every time.

`Arena`, `Boss`, `Players` and `Leaderboard` implement `AccountLayout`; `Bullet`,
`PlayerSlot` and `LeaderboardEntry` are nested `Pod` structs with no discriminator of
their own.

Every struct carries a `const _: () = { assert!(size_of::<T>() == N); … }` block
asserting its size, its alignment, and the offset of every field. Those asserts are the
Rust half of this table — if you change a field, the build tells you which numbers here
went stale.

### TypeScript — `packages/client/src/layout.ts`

```ts
export const ARENA:  { discriminator; size; rentExemptLamports; offsets: {...} };
export const BOSS:   { … }
export const PLAYERS: { … }        // plus PLAYER_SLOT, BULLET, LEADERBOARD_ENTRY
export const LEADERBOARD: { … }

export function decodeArena(data: Uint8Array): ArenaAccount;
export function decodeBoss(data: Uint8Array): BossAccount;
export function decodePlayers(data: Uint8Array): PlayersAccount;
export function decodeLeaderboard(data: Uint8Array): LeaderboardAccount;
export function freeSeats(seatOccupied: number): number[];
```

The `offsets` objects use the **Rust field names verbatim**, so a consistency check can
diff them against the `offset_of!` asserts in `state.rs` mechanically. The decoders
read those same constants — there is no second copy of a number inside a decoder body.

Each decoder validates length, discriminator and version before touching an offset, and
throws on mismatch. 32-byte fields come back as `Uint8Array`; converting to base58 is
the caller's business (`getAddressDecoder().decode(bytes)`), which keeps this module
dependency-free so the Worker can import it too. u64/i64 come back as `bigint`.

**Subscription note:** pass `encoding: 'base64'` explicitly on `accountSubscribe` — the
ER's default is base58 — and take an explicit `getMultipleAccounts` snapshot on every
WebSocket `open`, because subscribing delivers nothing until the next write.

---

## 8. Changing any of this

1. Edit this table.
2. Edit `state.rs`. The `const _` assert blocks will fail the build until the offsets
   agree.
3. Edit `layout.ts` offsets to match.
4. Bump `LAYOUT_VERSION` if any offset, size or field meaning changed. Accounts already
   on chain then fail the version check loudly instead of decoding as garbage — and
   since these accounts are recreated per match, the practical migration is "settle the
   in-flight match, then deploy".
