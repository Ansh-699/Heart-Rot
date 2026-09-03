# HEARTROT — Boss Attack Patterns for the Pit

**Date:** 2026-09-02
**Status:** Specification. Not implemented. Nothing in `programs/` was changed to write it.
**Implements against:** `programs/heartrot/src/handlers/tick.rs` (the game loop),
`state.rs` (`Bullet`, `Arena`, `Boss`), `handlers/shoot.rs` (why position matters),
`handlers/player.rs` (how fast a player is), `map.rs` (where anything stands).
**Supersedes:** nothing. It **adds** §2–§8 to what `06-game-loop.md` already fixes and
leaves `04-layout-contract.md`'s byte offsets untouched — deliberately, see §3.

---

## 0. The one-paragraph version

The boss today fires one aimed shotgun volley every 3.3 s at whichever live player is
nearest, and that is the entire fight. In a pit where the boss is fixed at top centre and
every player is below it, that attack is free to ignore: a player moves at 320 units/s and
a boss bullet moves at 120 units/s, so **movement already beats every projectile in the
game by 2.67×**, and moving costs a player nothing because `move` and `shoot` are separately
rate-limited transactions. This document adds one thing — a **telegraphed floor hazard** —
and gets slams, sweeps, rains and safe zones out of it, at a cost of **zero new bytes in
any account** and an estimated **+2 % of the crank's compute budget**. It rides four
reserved slots of the bullet pool that already exists, already ticks, and is already
subscribed to by every client at 60 fps.

---

## 1. What the boss does today

Read out of `handlers/tick.rs` at commit `ce9b743`, line numbers as they stand.

### 1.1 The whole attack

| | |
|---|---|
| Attacks | **One.** An aimed spread volley. There is no second attack, no melee, no phase change. |
| Clock | `Boss.attack_timer`, a `u8` counted down one per tick (`tick.rs:539`). |
| Interval | `VOLLEY_INTERVAL_TICKS = ticks_for(3_200) = 32` (`tick.rs:155`) |
| **Real period** | **33 ticks = 3.3 s**, not 32 — see §1.5. |
| Targeting | Nearest live player by squared distance, recomputed every tick (`tick.rs:520–534`). No threat table. `Boss.target_seat` is the cached answer. |
| Bullet count | `1 + alive_count`, one more while furious (`BASE_VOLLEY_BULLETS = 1`, `FURY_EXTRA_BULLETS = 1`; was `3 + alive_count` until 2026-09-03), so 2 at one player and 21 at twenty. Const-asserted to fit the 128-slot pool at the furious interval, §1.2.1. |
| Emitters | `hitboxes::MUZZLES`, four thorn centres, gated on `boss.parts[m.part] != 0`. Every thorn destroyed ⇒ the boss fires **nothing** (`tick.rs:685–693`). |
| Spread | Symmetric fan; `k/SPREAD_DEN` with `SPREAD_DEN = 24` is the tangent of the offset; ±1 jitter per bullet from `mix64`. Outermost bullet of a 23-shot volley sits ≈25° off the aim line. |
| Entropy | `mix64(affix_seed[0..8] ^ mix64(tick))` — one draw per tick, expanded per bullet. Pure function of state the client already holds, which is why the client can draw the volley locally the instant it sees the tick. |
| Bullet damage | `state::bullet_damage(raid_size)`: 2 solo → 8 at twenty, linear, read off `arena.raid_size` once per tick; the slam is `slam_damage(raid_size)`, 15 → 45. (Was the flat `BULLET_DAMAGE = 8` / `SLAM_DAMAGE = 45` until 2026-09-03 — those are now the full-raid endpoints.) Against `PLAYER_HP_MAX = 150`. |
| Bullet speed | `BULLET_UNITS_PER_SEC = 120` ⇒ `BULLET_SPEED = 12` units/tick at `TICK_MS = 100`. |
| Collision | Swept segment vs. a 12-unit player radius, `i64` closest-approach, no sqrt, no tunnelling. |
| Death | 0 HP ⇒ `respawn_at_tick = tick + RESPAWN_TICKS` where `RESPAWN_TICKS = ticks_for(3_200) = 32` ticks. Respawn is at `entrance_for(seat)` — `map::ENTRANCES[seat % 4]`, fanned ±48 units along its wall. Respawns are **unlimited**. |

### 1.2 Enrage

`ENRAGE_AT_TICK = ticks_for(360_000) = 3_600 ticks = 360 s`, written once by `init_arena`
(`init.rs:190`, `init.rs:521`). It is a **timeout, not an escalation**: nothing about the
boss changes as it approaches. At `tick >= enrage_at_tick` with a live core,
`step` calls `end_fight(OUTCOME_ENRAGE)` (`tick.rs:592`) and the match is over.

### 1.2.1 Fury (added 2026-09-03)

The HP-based escalation, distinct from the timeout above and named differently on purpose.
`Boss::is_furious(raid_size)` is true when `Boss::fight_hp` — the shell a raid of that
size still has to strip plus the core, `(left, max)` — reads `left × 100 ≤ max × FURY_PCT`
with `FURY_PCT = 20` (`state.rs`; mirrored as `isFurious` / `fightHp` in `layout.ts`). It is
**derived on every read and stored nowhere**: `Boss` has no padding left, and a cached flag
would be the HP stored twice.

`tick.rs` stage 7 reads it on the tick `attack_timer` runs out. Furious, the reload is
`FURY_VOLLEY_INTERVAL_TICKS = VOLLEY_INTERVAL_TICKS / 2` (16 ticks, 1.6 s) and the volley
carries `FURY_EXTRA_BULLETS = 1` more. It is never clamped into a running countdown — the
client draws the telegraph off `attack_timer`, and a timer that jumped mid-wind-up would snap
the drawing — so the first furious reload is the one set by the volley that fires after the
line is crossed. The bullet-pool const-assert is written against the furious interval: a
37-tick flight over 16-tick reloads is three volleys of `1 + 20 + 1` = 66 slots of 128.

### 1.3 The incarnation system

`scale_for_incarnation(base, inc) = base × (100 + 15 × inc) / 100`, saturating at
`u16::MAX` (`init.rs:400`). Applied to `BOSS_PARTS_BASE` only. The crown (4,000 base)
saturates at incarnation 41 — the ceiling the brief names, and it is real. **`BOSS_CORE_HP`
is not incarnation-scaled at all**: `reset_for_incarnation` is called with the literal
`BOSS_CORE_HP = 2_000` at both `init.rs:570` and `init.rs:731`. That is not a bug to fix
here; §6 uses the headroom it leaves.

### 1.4 The shell model

`sum(parts)` **is** the boss's health. `vent_open` is recomputed every tick as
`sum(parts) × 100 < sum(parts_max) × 35` (`tick.rs:551–556`) and independently on every
landed shot in `shoot.rs`. `core_hp` decrements only while the vent is open. Nine parts,
18,000 shell HP at incarnation 0, so the vent opens after **11,700** damage.

### 1.5 Three things in the code that are not what their comments say

Each was read, not assumed. None is fatal; all three would mislead an implementer working
from the comments.

1. **The volley period is 33 ticks, not 32.** `attack_timer` fires on the tick it reads 0,
   then is set to 32 and decremented on each of the next 32 ticks — so the gap between two
   volleys is `VOLLEY_INTERVAL_TICKS + 1`. `tick.rs:157`'s "One volley every 8 ticks" is
   two revisions stale (it predates `TICK_MS` moving 400 → 100).
2. **`TICK_ITERATIONS` headroom is 1.25×, not 5×.** `settle.rs:98` says "A match is bounded
   by `enrage_at_tick` (900 ticks = 6 minutes), so this is 5× headroom" against
   `TICK_ITERATIONS = 4_500`. At `TICK_MS = 100` the bound is **3,600** ticks, so 4,500
   iterations is 900 ticks (90 s) of margin. Still sufficient; the stated ratio is not.
3. **The brief's `BOSS_SPAWN` is the historical bug, not the current value.**
   `map::BOSS_SPAWN` is `(512, 512)`, tile (32, 32). `(512, 320)` is the value `init.rs`
   used to hardcode while the drawn map put the heart elsewhere — `map.rs:160–170`
   documents that defect at length. Any pit work must move the `B` in
   `assets/map/arena.json` and re-run `tools/gen_map.py`; it must not touch `map.rs`.

### 1.6 Measured compute, for the budget in §8

From `docs/spikes/sp-load.md` §2 and `docs/spikes/sp2.md` §§2–3, read off the crank's own
`consumed X of Y` log lines. The ceiling is **399,700**, not 400,000 — the noop instruction
in the crank transaction takes the other 300.

| window | n | p50 | p95 | max |
|---|---|---|---|---|
| empty arena | 1,886 | 6,857 | 6,857 | 6,857 (min = median = max) |
| 20 seats, quiet | 103 | 12,941 | 23,390 | 23,705 |
| 20 seats, aggressive input | 165 | 19,136 | 26,702 | **28,586** |

**Worst tick ever observed: 28,586 of 399,700 — 7.2 %, 14× headroom.** Roughly 4,500 of the
6,857 floor is three PDA re-derivations before any state is touched.

---

## 2. Why the pit needs a new attack, stated as arithmetic

### 2.1 The player is faster than the bullet, and dodging is free

| quantity | value | source |
|---|---|---|
| player step | 16 units (11 diagonal) | `player.rs:109–111`, `MOVE_STEP` |
| accepted moves | one per ER slot = one per 50 ms | `player.rs:231`, `move_clock` returns `Clock::slot` |
| client send rate | one per 50 ms | `app/src/input/controls.ts:65`, `MOVE_MS = 50` |
| **player speed** | **320 units/s cardinal, 220 diagonal** | 16 × 1000/50 |
| **bullet speed** | **120 units/s** | `BULLET_UNITS_PER_SEC` |
| ratio | **2.67×** | |

A player who is moving cannot be hit by a projectile chasing them. A player is hit only by
running into a bullet. And moving is free: `move` and `shoot` are separate transactions
with separate rate limits (one move per 50 ms slot, one shot per 8 ticks), so **strafing
costs zero damage output**.

### 2.2 …but *position* is the whole of a player's damage output

`shoot.rs::raycast` walks one tile per step, at most `MAX_RAY_STEPS = 20` (320 units), in
one of eight octants (`FACING_STEP`), and dies on the first wall. So a player deals damage
only from a position that is (a) within 20 tiles of a boss hitbox, (b) aligned on one of
eight rays, and (c) unobstructed. The boss's own hitboxes span x ∈ [−114, +113] boss-local
— **227 units, 14.2 tiles wide** — so from below, a north-facing ray connects from a
14-tile-wide column, and the two diagonals widen that to a wedge.

**That is the lever.** An attack aimed at a *player* is dodged for free. An attack aimed at
the *floor a player must stand on to shoot* costs them damage output. Every attack in §4
targets ground, never a moving body.

### 2.3 A 20-player raid is not a harder fight today, it is a 20× shorter one

`SHOT_DAMAGE = 40`, one accepted shot per `ticks_for(800) = 8` ticks = 0.8 s ⇒ **50 dmg/s
per player**, all shots landing. Shell 18,000 ⇒ 11,700 to open the vent, plus a 2,000 core.

| players | raid dmg/s | to vent | core | **total TTK** | vs. 360 s enrage |
|---|---|---|---|---|---|
| 1 | 50 | 234 s | 40 s | **274 s** | 76 % of the window |
| 2 | 100 | 117 s | 20 s | **137 s** | |
| 5 | 250 | 46.8 s | 8 s | **54.8 s** | |
| 10 | 500 | 23.4 s | 4 s | **27.4 s** | |
| 20 | 1,000 | 11.7 s | 2 s | **13.7 s** | 4 % of the window |

*(computed by `scratchpad/boss_numbers.py`, arithmetic reproduced in §6.4)*

`bullets_per_volley = 3 + alive_count` scales the boss's output by **5.75×** between one
player and twenty. The raid's output scales by **20×**. The founding requirement — more
players means a harder fight — is currently inverted, and no volley-density number can fix
a 3.5× gap. §6 closes it with two changes, one of which is an attack parameter and one of
which is four lines in the tick.

### 2.4 What the pit composition changes, and what it does not

Moving the boss to top centre is geometry. It does **not** require touching:

- **`spawn_volley`.** Muzzles are boss-local; a boss above the pit fires downward into it
  by construction.
- **Aggro.** "Nearest live player" from a boss at the top of the pit is *the player highest
  in the pit* — a front line emerges from the existing loop with no threat table.
- **`bullet_hits`, `wall_at`, the pool, `unit_velocity`.** All position-agnostic.

It **does** require, and these are cross-slice dependencies this document does not own:

- `assets/map/arena.json` redrawn with the `B` at top centre and the pit floor below it,
  then `tools/gen_map.py` re-run. Never hand-edit `map.rs`.
- The four `E` entrances must land **inside the pit**, or `entrance_for` respawns players
  outside the arena the fight happens in. `tick.rs`'s compile-time assertion catches an
  entrance in a *wall*; it cannot catch an entrance in the wrong *room*.

---

## 3. The hazard record — zero new bytes

### 3.1 The decision

A telegraph needs "something lands at position P in T ticks" in account bytes that all 20
clients read. The obvious implementation is a new `hazards: [Hazard; 4]` array on `Boss` or
`Arena`. **Do not do that.** It changes an account's length, which means every account
already on chain fails `load_mut`'s length check, and it costs a second subscription's worth
of decode work in the client.

`Bullet` is already an 8-byte record, already pooled at 128 slots, already swept by a
fixed-bound loop every tick, already in `Arena` — the account the crank rewrites every tick
anyway — and already decoded by the client at 60 fps. `Bullet.active` is a `u8` of which
exactly two values are used. **A hazard is a pool slot with a different `active` value.**

Consequences, all of them good:

- `Arena` stays 1,200 bytes. No offset moves. `04-layout-contract.md` is unchanged.
- Hazards arrive in the same account notification as the bullets they must be drawn beside,
  so they can never be one frame out of step with them.
- `Arena` changes on every tick regardless (bullets move), so hazards are never hidden
  behind the measured **68.4 %** of notifications that carry no change.
- The hazard pass is inside a loop that already runs. Marginal cost is the branch (§8).

### 3.2 The bytes

`Bullet` is unchanged as a layout. Only the *meaning* of its fields under a hazard
`active` value is new, and only one field is renamed:

| offset | field | as a bullet | **as a hazard** |
|---|---|---|---|
| 0 | `x: i16` | position | **centre x**, arena units |
| 2 | `y: i16` | position | **centre y**, arena units |
| 4 | `dx: i8` | velocity x | **`fuse` — ticks remaining until it lands.** Decremented one per tick. Resolves on the tick it reaches 0. |
| 5 | `dy: i8` | velocity y | **`radius8` — radius ÷ 8 arena units.** Range 0–1,016 units, granularity 8 (half a tile). |
| 6 | `active: u8` | `0` free, `1` bullet | `2` SLAM, `3` CRUSH, `4` SANCTUARY, `5` RAIN |
| 7 | `_pad0: u8` | padding | **`arg` — shard count (RAIN only), 0 otherwise.** |

The only edit to `state.rs` is renaming `Bullet._pad0` to `Bullet::arg` and documenting the
overload. That is a comment change and a field rename; **`size_of::<Bullet>()` stays 8, and
every `offset_of!` assertion in `state.rs:265–272` still passes unmodified.**

New constants, all in `tick.rs` beside the balance knobs:

```rust
/// `Bullet.active` values above `BULLET_ACTIVE`. A slot holding any of these is a
/// telegraphed floor hazard, not a projectile.
pub const HAZARD_SLAM:      u8 = 2;
pub const HAZARD_CRUSH:     u8 = 3;
pub const HAZARD_SANCTUARY: u8 = 4;
pub const HAZARD_RAIN:      u8 = 5;

/// Pool slots `N_BULLET_SLOTS..MAX_BULLETS` are reserved for hazards and are never
/// claimed by `spawn_volley`. Fixed indices, so casting needs no cursor and no scan,
/// and a full bullet pool can never starve a telegraph.
pub const MAX_HAZARDS: usize = 4;
pub const N_BULLET_SLOTS: usize = MAX_BULLETS - MAX_HAZARDS; // 124
```

`spawn_volley`'s sweep bound and cursor modulus change from `MAX_BULLETS` to
`N_BULLET_SLOTS`; `bullet_cursor` wraps at 124. 124 slots against a 23-bullet maximum volley
is still 5.4× headroom, and `sp-load` measured only **13–15 bullets in flight** at twenty
seats. The existing const-assert `BASE_VOLLEY_BULLETS + MAX_SEATS <= MAX_BULLETS` becomes
`<= N_BULLET_SLOTS` and still holds (23 ≤ 124).

### 3.3 Why `fuse` is a countdown and not an absolute landing tick

The brief asks for *"landing at tick T at position P"*. A countdown is strictly better here,
for two reasons that are both measured properties of this system:

1. **The Magic Router delivers every notification twice.** A client that reads `fuse` off
   the account is idempotent under duplicate delivery by construction: it never decrements
   anything locally, it renders whatever the newest bytes say. An absolute `land_tick`
   would be equally idempotent — but it would need the client to also hold a trustworthy
   current tick to compute the remaining window, and `Arena.tick` and the hazard would then
   be two facts that can disagree across a dropped notification.
2. **The client can still recover T when it wants it.** `land_tick = arena.tick + fuse`,
   both read from the same 1,200 bytes in the same notification, so they cannot be skewed.
   §4.4 needs exactly this for RAIN, and it is exact.

`fuse` is `i8`, so the telegraph is bounded at 127 ticks (12.7 s). `TELEGRAPH_TICKS = 15`
is const-asserted to fit.

---

## 4. The four attacks

All four are one record, one cast site, one resolve site. Three share a single
inside/outside distance test; the fourth expands to shards through a pure function.

### 4.0 The constant that governs all of them

```rust
/// How long a hazard is telegraphed before it lands.
///
/// 1,500 ms, and the number is derived, not chosen for feel. Write-to-visible on this
/// deployment is p50 127 / p95 160 ms, and the worst latency this project has ever
/// measured on any path is 1,126 ms (`docs/spikes/sp-load.md` §1, send → own logs, the
/// aggressive window). A telegraph shorter than that worst case can land on a client
/// before that client has drawn it, which is an untelegraphed hit — the one failure this
/// whole mechanic exists to prevent. 1,500 ms leaves 374 ms of margin against the worst
/// observation and 9.4× against p95.
const TELEGRAPH_TICKS: u32 = crate::state::ticks_for(1_500); // 15 ticks

/// A hazard is cast every 25 ticks (2.5 s). Deliberately coprime-ish with the 33-tick
/// volley beat: the two cadences realign only every 825 ticks (82.5 s), so a fight is
/// never a repeating two-bar loop, and this costs no randomness and no state.
const HAZARD_PERIOD_TICKS: u32 = crate::state::ticks_for(2_500); // 25 ticks

/// Damage per hazard, against PLAYER_HP_MAX = 100. Four times a bullet's 8: standing in
/// a marked circle is a mistake you can make three times.
const HAZARD_DAMAGE: u16 = 34;

const _: () = {
    assert!(TELEGRAPH_TICKS > 0 && TELEGRAPH_TICKS <= i8::MAX as u32);
    assert!(TELEGRAPH_TICKS < HAZARD_PERIOD_TICKS); // one cast resolves before the next
    assert!(MAX_HAZARDS + BASE_VOLLEY_BULLETS + MAX_SEATS <= MAX_BULLETS);
};
```

**Escape budget.** 15 ticks × 320 units/s = **480 units = 30 tiles** of cardinal travel, 330
units diagonal. Every radius below is far inside that: a player who reacts at all escapes
every single hazard. That is intentional. These attacks are not there to be undodgeable;
they are there to make the player *choose* between the floor they can shoot from and the
floor that is safe.

### 4.1 SLAM — a hand comes down on you

*IMAGE B's clawed hands leave the rim and strike into the pit.*

| | |
|---|---|
| `active` | `HAZARD_SLAM = 2` |
| centre | the position of a live seat, **sampled at cast time and stored** |
| `radius8` | 12 ⇒ **96 units, 6 tiles** |
| count per cast | `min(MAX_HAZARDS, 1 + alive_count / 5)` → 1 at n=1, 2 at n=5, 3 at n=10, 4 at n=20 |
| resolve | every live player with `d² ≤ r²` of the centre takes `HAZARD_DAMAGE` |
| seat choice | `live[(entropy as usize + i) % live_n]` for `i` in `0..count` — walks the `live[]` array `step` already built, so it costs one modulo per slam and never re-scans `Players` |

The centre is **stored, not derived**, and it must be: it depends on a player position at
one instant, and a client's view of a *remote* seat is interpolated and up to 160 ms stale.
Deriving it client-side would put 20 clients on 20 different circles. Storing four `i16`
pairs costs nothing (§3.1).

Note the honest limit: per-player marking probability is `count/n` — 1.0 at one player,
0.20 at twenty. **SLAM does not scale with headcount and is not meant to.** It is the
attack that makes a *solo* fight readable and gives every player a personal beat. §4.4 is
the scaler.

### 4.2 CRUSH — both hands slam where the raid is standing

| | |
|---|---|
| `active` | `HAZARD_CRUSH = 3` |
| centre | the **integer centroid of the live players**: `(Σx / live_n, Σy / live_n)` |
| `radius8` | 28 ⇒ **224 units, 14 tiles** |
| count per cast | 1 |
| resolve | every live player with `d² ≤ r²` takes `HAZARD_DAMAGE` |

224 units is chosen to equal the boss's own 227-unit hitbox width — the hands are as wide as
the creature they belong to, so the art and the mechanic are the same number.

The centroid needs no map constant and no `PIT_CENTRE`: it lands where the raid actually is,
which in this fight is the firing column under the boss, because that is the only place
`raycast` connects from. It is computed in the same pass that already walks `live[]` for
aggro — one `i32` accumulator per axis, `20 × 1023 = 20,460`, nowhere near overflow, one
integer divide.

**This is the attack that gives movement a price.** The firing column is 14.2 tiles wide;
CRUSH is 14 tiles wide and centred on wherever the raid clumped inside it. Leaving costs
you your ray; staying costs 34 HP.

### 4.3 SANCTUARY — the only safe ground

| | |
|---|---|
| `active` | `HAZARD_SANCTUARY = 4` |
| centre | centroid **+ a derived offset**, ‖offset‖ ≤ 256 units, rejected if it lands in a wall |
| `radius8` | 16 ⇒ **128 units, 8 tiles** |
| count per cast | 1 |
| resolve | every live player with `d² > r²` — **outside** — takes `HAZARD_DAMAGE` |

The one inverted test in the whole system, and it is a single flipped comparison sharing the
same helper.

Offset derivation, at cast time only, on chain, with the result stored:

```
h        = mix64(seed8 ^ mix64(tick))          // the draw spawn_volley already makes
ox       = (h        % 513) as i32 - 256       // -256 ..= 256
oy       = ((h >> 32) % 513) as i32 - 256
```

Rejection: if `wall_at(cx + ox, cy + oy)`, re-draw with `h = mix64(h)` up to **4 attempts**;
if all four land in wall, **skip the cast entirely**. Fixed bound, four bitboard lookups
worst case, no loop that can run long. Skipping is safe by §4.6.

**Why it matters that the circle does not grow with headcount.** Twenty players converging
on an 8-tile circle is the co-op moment the reference image is about, and while they are in
it, none of them is in the firing column. It is also the exact counterweight to §4.4: RAIN
punishes a clumped raid, SANCTUARY punishes a spread one. A raid cannot sit still in either
formation.

*Known ceiling, stated rather than hidden:* players do not collide with each other —
`move_player` tests `is_wall` and nothing else — so twenty players can stand on one tile and
SANCTUARY is no harder for twenty than for one. Making it scale would need player-player
collision, which is an O(n) test in the hot move path and would break client prediction.
Not worth it. SANCTUARY is variety and formation pressure, not a difficulty knob.

### 4.4 RAIN — the ceiling comes apart, and the difficulty scaler

| | |
|---|---|
| `active` | `HAZARD_RAIN = 5` |
| centre | the centroid (same value CRUSH uses — computed once, used by both) |
| `radius8` | half-extent of the live players' bounding box **+ 80 units**, ÷ 8, clamped to `i8::MAX` |
| `arg` | shard count = `4 + alive_count`, 5 at n=1 up to **24** at n=20 |
| shard radius | `RAIN_SHARD_RADIUS = 32` units (2 tiles), a constant, not stored |
| resolve | expand to `arg` shards; a player inside **any** shard takes `HAZARD_DAMAGE` **once** |

Shard centres are **derived on both sides, identically**, from bytes both sides already hold:

```
land_tick = arena.tick + fuse           // client: same notification, cannot be skewed
half      = radius8 * 8                 // units
span      = 2*half + 1
for i in 0..arg:
    h  = mix64(seed8 ^ (land_tick as u64) ^ (i as u64))
    sx = x + ( (h        % span) as i32 - half )
    sy = y + ( ((h>>32)  % span) as i32 - half )
```

No rejection sampling. A shard that lands in a wall simply hits nobody — no player can stand
in a wall — and the client draws it shattering against rock, which is what it should look
like. That removes the only place where chain and client would have had to agree on a loop
with a data-dependent trip count.

**This is where headcount becomes difficulty**, and the box makes it self-balancing:

| players | shards | raid clumped (half-box 160 u) | raid spread (half-box 320 u) |
|---|---|---|---|
| 1 | 5 | 14.8 % of the box unsafe | 3.9 % |
| 5 | 9 | 25.0 % | 6.9 % |
| 10 | 14 | 36.0 % | 10.5 % |
| 20 | 24 | **53.5 %** | 17.2 % |

*(effective coverage = `1 − (1 − πr²/box)^shards`, computed in
`scratchpad/boss_numbers.py`; it accounts for shard overlap, the raw sum does not.)*

A clumped twenty-player raid loses half the floor it is standing on, every 2.5 s, with 1.5 s
of warning. A raid that spreads out to dodge it loses SANCTUARY instead. Neither number was
tuned to feel a certain way; both fall out of `4 + alive_count` and a 2-tile shard.

### 4.5 Which one fires

At `tick % HAZARD_PERIOD_TICKS == 0`, in `step`, after `alive_count` is written and after
`live[]` exists:

```
kind = match (mix64(seed8 ^ mix64(tick)) >> 62) & 3 {
    0 => SLAM, 1 => CRUSH, 2 => SANCTUARY, _ => RAIN
}
```

Two bits of the entropy draw the volley already makes. No beat counter, no new field.

A derived-from-`tick` cadence rather than a second countdown timer is deliberate: `tick`
advances in **every** phase (`heartbeat` runs before the phase gate, `tick.rs:315`) but
`step` runs only while `FIGHTING`, so a modulo on `tick` is correct during a fight and
inert outside one, with nothing to reset and nothing to drift.

### 4.6 The safety property that makes all of this cheap

**A hazard that cannot be created simply does not happen.** No slot free, all four wall
rejections failed, `live_n == 0` — every one of those paths returns without writing, and the
consequence is one skipped attack. There is no code path anywhere in §4 that produces damage
without a record that was visible for `TELEGRAPH_TICKS` first. State that as an invariant
and the whole feature is failure-safe inside a handler that is not allowed to return `Err`.

---

## 5. Where it goes in the tick

`step()` gains two stages. Both must sit exactly where they are written here.

| stage | what | changed? |
|---|---|---|
| 1 | respawns; build `live[]`, `arena_occupants`, `pending_respawns` | unchanged |
| 2 | advance and collide bullets (`active == BULLET_ACTIVE` only) | unchanged |
| **2b** | **hazards: `fuse -= 1`; at 0, resolve damage and free the slot** | **new** |
| 3 | `arena.alive_count = live_n` | unchanged |
| 4 | aggro; **and, in the same pass, the centroid and bounding box** | one accumulator added |
| 5 | volley on `attack_timer` | unchanged |
| **5b** | **cast on `tick % HAZARD_PERIOD_TICKS == 0`** | **new** |
| 6 | recompute `vent_open` from the parts | unchanged |
| 7 | win / wipe / enrage | unchanged |

Three ordering constraints, each of which is a real bug if violated:

1. **2b before 3.** A player killed by a hazard must be swap-removed from `live[]` and
   counted into `pending_respawns` before `alive_count` is written — exactly the bookkeeping
   the bullet loop does at `tick.rs:467–487`. Resolve hazards with the *same* three lines
   (`respawn_at_tick`, `deaths`, swap-remove) or a hazard death becomes a death that the
   wipe check cannot see, and a solo raid hangs at 0 HP forever.
2. **2b before 5b.** Slots freed this tick are reusable this tick.
3. **5b after 3 and 4.** The cast reads `alive_count` (shard and slam counts) and the
   centroid (CRUSH, SANCTUARY, RAIN), both of which are this tick's values.

Stage 2b lives **inside** the existing `for index in 0..MAX_BULLETS` loop as a branch on
`active`, not as a second loop: the loop already strides the array, the branch is already
there (`if bullet.active != BULLET_ACTIVE { continue; }` becomes a three-way match), and the
hazard arm runs at most 4 times out of 128 iterations.

Nothing in stage 2b or 5b can panic, index unchecked, allocate, or overflow under
`overflow-checks = true` — the crank's ten-strike rule (`tick.rs:8–25`) is unchanged and
absolute. Every add is `saturating_*`; `live_n` bounds every index; `radius8 as i32 * 8`
cannot exceed 1,016; `span` is `≥ 1` by construction so no modulo by zero.

---

## 6. Difficulty scaling with player count

Two knobs, and they are deliberately different in kind.

### 6.1 Knob one: hazard density (an attack parameter, this document owns it)

Everything that scales scales as **count, never as damage per instance**. A solo player and
a twenty-player raid take the same 34 HP for the same mistake; what changes is how much of
the floor is a mistake at once.

| scales with `alive_count` | from | to |
|---|---|---|
| `bullets_per_volley = 3 + alive` (existing) | 4 | 23 |
| RAIN shards = `4 + alive` | 5 | 24 |
| SLAM count = `1 + alive/5`, capped at 4 | 1 | 4 |

Damage-per-instance constants — `BULLET_DAMAGE`, `HAZARD_DAMAGE`, every radius — are fixed
for all headcounts and all incarnations.

### 6.2 Knob two: the boss must actually get tougher (four lines in the tick)

§2.3's table is the problem: 20× the raid DPS against a fixed HP pool. Hazard density
cannot answer a 3.5× gap, and it should not try — a hazard field tuned to threaten twenty
players would delete a solo raider.

**Do not scale `parts`.** They are `u16` and `scale_for_incarnation` already saturates the
crown at incarnation 41; multiplying them by a raid factor too would collapse that ceiling
to incarnation ~2 at twenty players, and widening `parts` to `u32` is a layout change this
document has otherwise avoided entirely.

**Scale `core_hp` instead.** It is the one health field with real headroom: `u16`, base
2,000, and — per §1.3 — **not incarnation-scaled at all**, so 32× of `u16` sits unused.

```rust
/// Extra core HP per raider past the first. The boss's shell is the same fight at every
/// headcount; its heart is not.
const CORE_HP_PER_RAIDER: u16 = 3_000;

const _: () = {
    // The top-up can never overflow the field it is written to.
    assert!(BOSS_CORE_HP as u32 + (MAX_SEATS as u32 - 1) * CORE_HP_PER_RAIDER as u32
            <= u16::MAX as u32);          // 2,000 + 19×3,000 = 59,000 ≤ 65,535
};
```

In stage 4 of the tick, after `arena_occupants` is known:

```
required = BOSS_CORE_HP + CORE_HP_PER_RAIDER * (arena_occupants.max(1) - 1)
if boss.core_hp_max < required:
    boss.core_hp     += required - boss.core_hp_max     // saturating
    boss.core_hp_max  = required
```

Four lines, and every property they need falls out of them:

- **No snapshot, no new field.** `core_hp_max` *is* the record of the largest raid seen.
- **Late entry works.** `join` and `enter_gate` accept `PHASE_FIGHTING` (`player.rs:342`);
  late arrivals are the design's matchmaker. Someone walking in on tick 900 raises the
  requirement and the core grows to match, on the next tick.
- **Monotonic, so it cannot be gamed.** It only ever raises. A raid cannot shrink the boss
  by having people die or by leaving, because the comparison is one-sided.
- **Orthogonal to incarnations.** It writes `core_hp`; incarnation scaling writes `parts`.
  They cannot interact, and `reset_for_incarnation` re-derives the base for each new boss.
- **`vent_open` is untouched.** The threshold is a ratio over `parts`, and `parts` do not
  move, so the shell phase is the identical fight at every headcount.

### 6.3 The curve this produces

Using §2.3's DPS model with `CORE_HP_PER_RAIDER = 3_000`:

| players | raid dmg/s | core HP | **total TTK** | vs. 360 s enrage |
|---|---|---|---|---|
| 1 | 50 | 2,000 | **274 s** | 76 % |
| 2 | 100 | 5,000 | **167 s** | 46 % |
| 5 | 250 | 14,000 | **103 s** | 29 % |
| 10 | 500 | 29,000 | **81 s** | 23 % |
| 20 | 1,000 | 59,000 | **71 s** | 20 % |

The 20× spread becomes **3.9×**. A twenty-player raid is a 71-second fight in which slightly
over half the floor is a hazard on every 2.5-second beat, against a 13.7-second fight today
with a fixed volley. A solo raid is unchanged in every respect — 274 s, the same boss, the
same one slam per beat — which is the property that keeps this from being a stealth nerf to
the case that is already the hardest.

Neither the shell nor the enrage window is touched. This is one constant and one comparison.

### 6.4 How these numbers were produced

`/tmp/.../scratchpad/boss_numbers.py`, run against the constants as they are in the tree:
`ticks_for` reimplemented from `state.rs:146`; `SHOT_DAMAGE = 40` and the 8-tick shot period
from `shoot.rs:94–99`; `BOSS_PARTS_BASE` summed from `init.rs:236`; the 35 % vent threshold
from `tick.rs:169`. **The DPS model assumes every shot lands and nobody ever dies**, so
every TTK above is a *floor*, not a prediction. Real fights are longer. That is the right
direction for a headroom argument and the wrong direction for a feel argument — retuning for
feel needs a real twenty-seat run, which this document did not do (§9).

---

## 7. Enrage, and the incarnation system

### 7.1 Both keep working, unchanged

`ENRAGE_AT_TICK`, `abandon_roll`, `begin_next_incarnation`, `scale_for_incarnation`,
`OUTCOME_ENRAGE` and the 41-incarnation `u16` saturation are all untouched by §§3–6. The
hazard system reads `tick` and `alive_count` and writes pool slots and `core_hp`; it never
touches `parts`, `parts_max`, `affix_seed`, `next_affix_seed`, `incarnation` or `phase`.

Hazards are also deliberately **not** incarnation-scaled. Incarnation difficulty is the
shell (+15 % per incarnation, compounding to the saturation point); headcount difficulty is
hazard density. One axis each, exactly as `phase` and `outcome` are one axis each.

### 7.2 One addition worth making: enrage as an escalation

Today enrage is a wall — nothing changes, then the match ends. Three lines make the last
minute feel like one, derived entirely from state that already exists:

```rust
/// The last minute before the timeout: hazards come twice as fast.
const ENRAGE_WARNING_TICKS: u32 = crate::state::ticks_for(60_000); // 600 ticks

let period = if arena.enrage_at_tick != 0
    && tick + ENRAGE_WARNING_TICKS >= arena.enrage_at_tick
{
    HAZARD_PERIOD_TICKS / 2          // 12 ticks; TELEGRAPH_TICKS = 15 still fits, see below
} else {
    HAZARD_PERIOD_TICKS
};
```

At the halved period the cast interval (12) is shorter than the telegraph (15), so up to two
hazards overlap. `MAX_HAZARDS = 4` covers that: worst case is one 4-slam cast still in flight
when the next cast wants a slot, and the next cast then places what fits and skips the rest
under §4.6. **No new failure mode, because a hazard that cannot be placed is simply an
attack that does not happen.** Const-assert `HAZARD_PERIOD_TICKS / 2 > 0`.

This only ever fires for raids slow enough to approach 360 s — per §6.3, one or two players.
That is the right audience for it: enrage should threaten the raid that is running out of
time, and it is currently the only raid for which enrage is reachable at all.

---

## 8. Compute budget

Estimated, not measured — and the estimate is scaled from the measured numbers in §1.6
rather than guessed.

| pass | pair tests, worst case | note |
|---|---|---|
| bullet loop, today | 128 slots × 20 seats = **2,560** | costs 28,586 CU total at its measured worst |
| hazard resolve, added | one RAIN (24 shards) + 3 discs, × 20 seats = **540** | 21 % of the bullet loop's pair count |
| hazard cast, added | ≤ 4 wall lookups + ≤ 5 `mix64` | a shift and a mask each |
| centroid + bbox, added | one pass over `live[]`, ≤ 20 | folded into the aggro loop that already runs |

A pair test in the hazard resolve is *cheaper* than one in the bullet loop — squared
distance to a fixed point, versus swept-segment closest approach with `i64` widening — so
scaling by pair count is conservative. **Estimated worst tick: 28,586 + ~8,000 ≈ 37,000 of
399,700 = 9.3 %.** Even at 3× that estimate the handler sits under 30 % of budget.

Two things that do *not* change and are worth naming because they are what the budget is
actually spent on: the three PDA re-derivations at the top of `process` (~4,500 CU, 66 % of
the 6,857-CU empty-arena floor) and the eight account keys in the frozen crank list. Hazards
add no account, no key, and no CPI.

**This must be measured, not trusted.** The check is the one `sp2` and `sp-load` already
built: read `consumed X of 399700` off the crank's own logs, filtered on the *arena*
account and not on the program — `sp-load` §6 found 2.25 program log lines per tick from
other arenas ticking on the same validator, and that contamination is permanent for any
arena nobody settled.

---

## 9. The client contract, and the one thing that breaks

### 9.1 What the client must change

1. **`app/src/render/Arena.tsx:383` is a live bug the moment a hazard exists.** It reads
   `b.active === 0 ? null : <bullet rect>`, so **any** non-zero `active` renders as a bullet.
   It must become `b.active !== BULLET_ACTIVE ? null : …` and a hazard layer added beside it.
   This is not optional and it is not cosmetic — without it, a hazard draws as a 4-pixel
   projectile at the centre of the circle it should be warning about.
2. **`packages/client/src/layout.ts:101`** — add `arg: 7` to `BULLET.offsets` and the field
   to the decoded `Bullet` type. The `size: 8` and every other offset stay.
3. Mirror `HAZARD_*`, `MAX_HAZARDS`, `N_BULLET_SLOTS`, `TELEGRAPH_TICKS`,
   `RAIN_SHARD_RADIUS` and `mix64` (already mirrored for the volley) into the client.

### 9.2 What the client renders

Everything a telegraph needs is in the record, so the animation is a pure function of
`(x, y, radius8, fuse, active, arg)` plus `arena.tick`:

- `progress = 1 - fuse / TELEGRAPH_TICKS`, in `[0, 1]` — drives the marker filling in, the
  hand descending, the shards falling.
- SLAM / CRUSH: a filled disc at `(x, y)` of radius `radius8 * 8`.
- SANCTUARY: the **inverse** — the world outside the disc darkens; the disc is the only lit
  ground. This is the one that must read instantly and unambiguously, because getting it
  backwards is the difference between running in and running out.
- RAIN: expand `arg` shards by §4.4's derivation. Every client computes the same centres
  from the same bytes; none of them needs a player position to do it.

Two properties that matter given this project's measured network behaviour: hazards ride
`Arena`, which changes every tick, so they are never behind the **68.4 %** of `Players`
notifications that carry no change; and `fuse` is read, never decremented locally, so
**duplicate delivery is idempotent** and a missed notification self-corrects on the next one.

Do not put a CSS transform on a hazard node that the rAF loop also writes. The existing rule
holds: one writer per node's transform, and the frame loop owns the ones it owns.

---

## 10. What was not verified, and what could be wrong

Stated plainly, because a negative result is a real finding and an unmarked assumption is
not.

1. **No CU measurement was taken for this design.** §8 is arithmetic over `sp-load`'s
   measured numbers, not a run. It could be wrong by a factor of two and still fit; it
   should still be measured before anyone calls the budget closed.
2. **No twenty-seat playtest.** §6.3's curve assumes perfect uptime and zero deaths (§6.4).
   The shard-coverage table is geometry, not experience. `CORE_HP_PER_RAIDER`,
   `HAZARD_DAMAGE`, and every radius are first estimates with a stated derivation, which is
   the most a document can honestly offer without a fight to watch.
3. **The pit map does not exist yet.** §2.4 lists what it must satisfy — the `B` at top
   centre, the four `E`s inside the pit floor. Every attack here is written against the
   *centroid of the live players* and `map::WALLS` precisely so that it needs no `PIT_CENTRE`
   constant and cannot drift from whatever grid is drawn. If the art later needs an exact
   ellipse, the correct move is a `PIT_CENTRE` / `PIT_RADIUS` pair emitted by
   `tools/gen_map.py` from the drawn grid — never a constant typed into `tick.rs`.
4. **`Bullet._pad0` was checked against every reader in the tree** (`state.rs`,
   `tick.rs`, `shoot.rs`, `layout.ts`, `Arena.tsx`). It is read by nothing and written only
   as a literal `0` in three test fixtures — `tick.rs:979`, `tick.rs:1048`, `tick.rs:1065`
   — which the rename to `arg` must follow. If a real reader is added between now and
   implementation, §3.2 is void.
5. **Player-player collision does not exist** and §4.3 is weaker for it. Documented in
   place rather than designed around.
6. **`shoot.rs` is untouched by all of this**, which means the hitscan/travel-time asymmetry
   in §2.1 is unchanged: the player still has a 320-unit ray that lands instantly. Hazards
   make position cost something; they do not make aiming cost anything. If the fight still
   feels weightless after this, that asymmetry is the next thing to look at, and it is a
   bigger change than this document.

---

## Appendix — every new constant in one place

| constant | value | derived from |
|---|---|---|
| `HAZARD_SLAM` / `_CRUSH` / `_SANCTUARY` / `_RAIN` | 2 / 3 / 4 / 5 | `Bullet.active` values above `BULLET_ACTIVE` |
| `MAX_HAZARDS` | 4 | one multi-slam cast, plus overlap under §7.2 |
| `N_BULLET_SLOTS` | `MAX_BULLETS - MAX_HAZARDS` = 124 | 5.4× the 23-bullet maximum volley |
| `TELEGRAPH_TICKS` | `ticks_for(1_500)` = 15 | worst measured latency 1,126 ms + 374 ms margin |
| `HAZARD_PERIOD_TICKS` | `ticks_for(2_500)` = 25 | realigns with the 33-tick volley beat only every 82.5 s |
| `ENRAGE_WARNING_TICKS` | `ticks_for(60_000)` = 600 | the last minute |
| `HAZARD_DAMAGE` | 34 | 4× `BULLET_DAMAGE`; three mistakes kill |
| `SLAM_RADIUS8` | 12 (96 u, 6 tiles) | 20 % of the 480-unit escape budget |
| `CRUSH_RADIUS8` | 28 (224 u, 14 tiles) | the boss's own 227-unit hitbox width |
| `SANCTUARY_RADIUS8` | 16 (128 u, 8 tiles) | 20 knights, one circle |
| `SANCTUARY_OFFSET_MAX` | 256 u | half the escape budget, so the far edge of a spread raid can just reach it |
| `RAIN_SHARD_RADIUS` | 32 u (2 tiles) | 53.5 % coverage at 24 shards in a clumped raid |
| `RAIN_BOX_INFLATE` | 80 u (5 tiles) | the raid's own bounding box, widened |
| `CORE_HP_PER_RAIDER` | 3,000 | 2,000 + 19×3,000 = 59,000 ≤ `u16::MAX` |

Every duration goes through `state::ticks_for()`. No tick count is written as a literal.
