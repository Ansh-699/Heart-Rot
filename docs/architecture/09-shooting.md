# HEARTROT — Shooting, for a boss fixed at top centre

**Date:** 2026-09-02
**Status:** Specification. Nothing here is implemented yet.
**Reads:** `programs/heartrot/src/handlers/shoot.rs` (589 lines),
`programs/heartrot/src/handlers/tick.rs` (1,365 lines),
`programs/heartrot/src/state.rs`, `programs/heartrot/src/hitboxes.rs`,
`programs/heartrot/src/map.rs`, `packages/client/src/instructions.ts`,
`app/src/input/controls.ts`, `app/src/render/Arena.tsx`.
**Changes:** `05-wire-abi.md` tag 7 row (2 B → 3 B). Nothing in `04-layout-contract.md`:
this specification adds **zero account bytes**.
**Every number below that is not quoted from a source file was produced by a script in
§8.** Nothing here was measured on chain; §8 says exactly what that means.

---

## 0. How shooting works today

Read this section before the rest. Three of the four premises in the brief that
commissioned this document are wrong about the shipped code, and the design only makes
sense once the real machine is on the table.

### 0.1 Player fire is hitscan. There is no player bullet.

`handlers/shoot.rs` allocates no projectile. `fire()` calls `raycast()`, which walks the
ray to completion **inside the same transaction**, applies the damage, and returns. The
bullet pool is **boss ordnance only**. The module docstring states the asymmetry as a
design property, not an accident:

> the player's own fire must feel instant, so it resolves at send time and the visible
> tracer is client-side animation only; incoming fire must be dodgeable, so the boss gets
> travel time and a pooled bullet array advanced by the crank.

That asymmetry is what makes a 127 ms p50 write-to-visible playable, and **this
specification keeps it**. See §2.4 — it is also the answer to "players below shooting
bullets up at it".

### 0.2 The shot, end to end

| Stage | Where | What happens |
|---|---|---|
| Aim | `app/src/input/controls.ts` `aimDirection()` | `atan2` of pointer−player, then `dirFromVector` quantises to **one of 8** and throws the rest away |
| Gate | same, `shotAllowed(tick, lastShotTick)` | client-side mirror of the chain cooldown |
| Wire | `packages/client/src/instructions.ts` `shoot()` | `[tag 7, seat u8, dir u8]`, 3 bytes total; `dir8()` rejects ≥ 8 |
| Accounts | same | `Arena` W, `Boss` W, `Players` W, session key RO-signer |
| Guards | `shoot::process` | `dir >= 8` reject · `assert_signer` · owner + writable on all three · `assert_pda` on `Boss` and `Players` from the arena key · `phase == PHASE_FIGHTING` · `slots.get_mut(seat)` · `assert_session_authority` |
| Rules | `shoot::fire` | `hp != 0` else `PlayerDead` · `zone == ZONE_ARENA` else `WrongZone` · `arena.tick > last_shot_tick + SHOT_COOLDOWN_TICKS` else `RateLimited` |
| Effect | same | `last_shot_tick = tick` · `facing = dir` · `raycast` · damage · `recompute_vent` · `damage_dealt +=` credited damage |

### 0.3 What a shot costs

- **Cooldown.** `SHOT_COOLDOWN_TICKS = ticks_for(800) - 1 = 7`, compared strictly
  (`tick <= last + 7` rejects), so the next accepted shot is at `last + 8` = **800 ms**.
  Counted in `Arena.tick`, never wall clock. **Spent by the attempt, not by the hit** — a
  miss burns it, and that is deliberate: ER transaction fees are zero and run no fee-payer
  validation, so `last_shot_tick` is the entire rate limiter (D16).
- **Lamports.** Zero. ER.
- **Account bytes.** Zero. Nothing is allocated.
- **Contention.** `Arena`, `Boss` and `Players` are all write-locked. `Arena` is written
  only on the killing blow (`arena.end_fight`); the lock is held for the cooldown read.

### 0.4 Collision resolution — player ray vs. boss parts

`raycast(from_x, from_y, dir, boss)` in `shoot.rs`:

1. `(step_x, step_y) = FACING_STEP[dir & 7]` — one of eight unit octants.
2. Up to `MAX_RAY_STEPS = 20` iterations. Each advances **one whole tile** (`TILE = 16`)
   along the octant, so the reach is **320 units of a 1024-unit map**.
3. `is_wall(x, y)` first: off-map and negative are solid. Same generated `map::WALLS`
   bitboard `handlers::player::is_wall` uses, so cover blocks a shot exactly where it
   blocks a step.
4. Then, in table order, the nine `PART_HITBOXES` rects, boss-local, **skipping parts at
   0 HP**. A destroyed limb is transparent — that is how stripping the shell opens a lane,
   with no separate "exposed" flag.
5. Then the core: `dx² + dy² <= CORE_RADIUS_SQ (400)`, centre boss-local `(25, −18)`.
6. First hit wins. No hit in 20 steps returns `None`.

Damage: `SHOT_DAMAGE = 40`, credited as `min(part_hp, 40)` so a finishing shot on a 1 HP
part scores 1, not 40. `recompute_vent` re-derives `vent_open` from
`sum(parts) * 100 < sum(parts_max) * 35` on the same line that changed a part. A core hit
with the vent sealed deals **0** and still spends the cooldown. A core hit that reaches 0
calls `arena.end_fight(OUTCOME_WIN)`; `tick::step` re-derives the same win from
`boss.core_hp == 0`, so the on-chain record does not depend on that write landing.

### 0.5 Collision resolution — boss bullets vs. players

`tick::step` stage 2, once per crank tick:

- Copy live seats into a 20-entry stack array of `Target { seat, x, y }` — 24 bytes per
  entry instead of striding the 96-byte account slots. The file names this the single
  biggest CU saving in the handler.
- Per active bullet: two wall samples (midpoint, then endpoint) clip the swept segment;
  then a bounding-box broad phase inflated by `PLAYER_HIT_RADIUS = 12` (four `i32`
  compares per seat); then `bullet_hits`, an exact segment-to-point closest-approach test
  in `i64` with no division and no `sqrt`.
- One bullet, one hit. A killed seat is swap-removed from the live array, shortening every
  remaining bullet's inner loop within the same tick.

### 0.6 The pool

`Bullet` is 8 bytes: `x: i16`, `y: i16`, `dx: i8`, `dy: i8`, `active: u8`, `_pad0: u8`.
`MAX_BULLETS = 128`, 1,024 bytes at `Arena` offset 136. `spawn_volley` claims slots from
`arena.bullet_cursor`, sweeps the pool **once**, and drops the rest of the volley if it
finds no free slot. `bullets_per_volley = BASE_VOLLEY_BULLETS (3) + alive_count`, capped
at 23 by `MAX_SEATS`, guarded by a const assert. Emitters are the four `MUZZLES`, each
gated on its own thorn's `parts[]` entry: shoot the thorns off and the volleys stop.

### 0.7 Three stale facts found while reading

None of these are behavioural bugs; all three are numbers stored twice, which is this
project's most repeated defect class, and an implementer working from the comments will be
misled.

1. `tick.rs` line ~410 says "a bullet covers `BULLET_SPEED` = **48** units per tick". The
   real value is **12** (`120 units/s × TICK_MS 100 / 1000`). 48 was the 400 ms number.
   The tunnelling argument the comment makes is still sound — it is just three times
   safer than it claims.
2. `tick.rs` says "One volley every **8 ticks**". `VOLLEY_INTERVAL_TICKS = ticks_for(3200)`
   is **32** ticks. Same 3.2 s wall time; the tick count moved when `TICK_MS` did.
   `01-architecture.md` row 18 carries the same stale "every 400 ms / every 8 ticks".
3. `state.rs`'s `TICK_MS` docstring claims the direction quantisation at 12 units/tick is
   "~2.4 degrees". Measured, the shipped `unit_velocity` truncation gives **5.07°** (§4).
   2.95° is what *rounding* would give. The docstring describes a normaliser that was
   never written.

Separately, the brief that commissioned this document states `map::BOSS_SPAWN = (512, 320)`,
tile (32, 20). The shipped value is **`(512, 512)`, tile (32, 32)** — `map.rs` documents
(512, 320) as a corridor spawn that put the shell inside solid rock and was fixed.

---

## 1. What the top-centre composition breaks

Boss above, players in a pit below. Two things fail, and both fail silently — no error, no
log, just shots that score nothing.

### 1.1 Eight-way aim cannot hit the core. At any range.

A 45° quantisation step can only select a target whose angular size exceeds 45°. Measured
from a shooter directly below the boss, against the real `hitboxes.rs` geometry (shell AABB
227 × 232 units, core diameter 40 units, narrowest part `thorn2` 20 units):

| range | shell subtends | core subtends | narrowest part | 8-way step | 16-way | i8-pair aim (§2) |
|---|---|---|---|---|---|---|
| 200 u | 59.1° | 11.4° | 5.7° | 45° | 22.5° | 0.24° |
| 320 u | 39.1° | 7.2° | 3.6° | 45° | 22.5° | 0.24° |
| 480 u | 26.6° | 4.8° | 2.4° | 45° | 22.5° | 0.24° |
| 640 u | 20.1° | 3.6° | 1.8° | 45° | 22.5° | 0.24° |
| 800 u | 16.1° | 2.9° | 1.4° | 45° | 22.5° | 0.24° |

Simulated directly, replaying `raycast` verbatim over 110 pit stands × every aim direction
(walls ignored, so the number isolates aim resolution from map geometry; geometry assumed
in §8.3):

| aim | reach | stands that can hit **anything** | distinct targets ever reachable |
|---|---|---|---|
| 8-way | 320 u (shipped) | 37/110 — **33.6 %** | 5/10, **core never** |
| 8-way | 1024 u | 75/110 — 68.2 % | 5/10, **core never** |
| 16-way | 1024 u | 109/110 — 99.1 % | 7/10, core reachable |
| 64-way | 1024 u | 110/110 — 100 % | 9/10 + core |
| i8-pair | 1024 u | 110/110 — 100 % | 9/10 + core |

**Read the second row.** Extending the range does not fix 8-way aim: two thirds of the
targets, the core included, are never on a 45° ray from anywhere in the pit. Ship the
top-centre boss on 8-way aim and the raid is unwinnable, with no error anywhere.

### 1.2 The 320-unit reach does not cross the pit.

`MAX_RAY_STEPS = 20` × `TILE = 16` = 320 units. With the boss shell occupying the top of
the map and a pit deep enough to hold twenty spread-out players, the worst-case
stand-to-core range is **865 units** (§8.3). At 320 units, 66 % of pit stands cannot reach
the boss at all — the first row of the table above.

### 1.3 What does *not* break

- The pool. §3: it holds, with 1.9× headroom, unchanged.
- Collision cost. §5: unchanged, and bounded by the same 128 × 20 the crank was designed
  around.
- The boss model. Parts-as-health, vent derived from `sum(parts)`, muzzles gated on their
  own thorn — all of it maps onto a creature seen from below better than it mapped onto one
  seen from four corridors. Keep it exactly.
- Sub-unit velocity. §4: not needed, and there is a free fix for the real error.

---

## 2. The aim model

### 2.1 Decision

**Free aim, sent as a raw `(dx: i8, dy: i8)` vector, normalised on chain.** Not 360°-by-table,
not aim-up-with-spread, not auto-target.

The wire changes from `[tag, seat, dir]` (3 B) to `[tag, seat, dx, dy]` (4 B). Nothing else
about the instruction changes. **Zero account bytes.**

### 2.2 Why not the alternatives

**Auto-target the nearest part** — rejected. The kill chain is *strip the shell, open the
vent, hit the core*; `raycast` implements it by making a 0 HP part transparent. Auto-target
deletes the chain: the fight becomes a DPS check, part selection stops existing, and the
`vent_open` threshold becomes decorative. It also fails at twenty shooters specifically —
twenty auto-aimed guns strip nine parts in seconds with no coordination, and cooperative
target-calling, the only reason twenty players are better than one, has nothing left to
call.

**Aim up with spread** — rejected for the same reason plus one more: it makes every seat's
shot identical, so position in the pit stops mattering, and the pit is the whole
composition.

**A 256-entry brados angle table** (`dir: u8` reinterpreted as 1/256 turn, `AIM_UNIT[256]`
of Q12 unit vectors generated by a `tools/gen_aim.py` with a TypeScript mirror) — rejected,
though it would work. It costs 1,024 bytes of `.so`, a fifth generator, a fifth generated
file, and a fifth TS mirror that must not drift, to deliver **1.406°**. The i8 pair delivers
**0.235°** with no table and no generator (§8.2). Six times the precision for less code is
not a trade-off.

**Keeping 8-way** — rejected by §1.1. It is not a feel regression, it is an unwinnable
fight.

### 2.3 Why an i8 pair is the lazy answer

It reuses three things that already exist:

- `movePlayer` already sends `(dx: i8, dy: i8)` on the wire and lets the chain interpret
  it. `shoot` becomes the *same shape* as the other hot instruction instead of a second
  convention.
- `controls.ts::aimDirection()` already computes a continuous pointer-relative aim vector
  and then destroys the precision in `dirFromVector`. The client change is to scale that
  vector instead of quantising it.
- `tick.rs::unit_velocity` already normalises an arbitrary integer vector to a fixed length
  with alpha-max-plus-beta-min — no `sqrt`, no float, no table. The ray needs the identical
  operation at a different scale.

Measured over 200,000 aim angles, browser scaling to fill `i8` and chain normalisation to a
Q12 step (§8.2):

- max direction error **0.2354°**
- lateral miss at the 865-unit worst-case range: **3.55 units = 0.22 tiles** — a fifth of a
  player radius
- step length lands in **0.894 … 1.000 × TILE**

### 2.4 "Players below shooting bullets up at it"

Satisfied by the **renderer**, not the chain. `shoot.rs`'s own docstring already names the
client-side tracer as the intended visual, and `app/src/render/` does not draw one today —
`sprites.ts` gives players a facing nub and nothing else. The work is:

- The chain returns the hit. The client already knows the ray: same integers, same
  normaliser, same `PART_HITBOXES` mirror.
- Draw a projectile that flies the player-to-hit segment over ~120 ms, then a hit flash on
  the part. Pure client animation, owned by the existing rAF loop, never by React.
- Remote seats: `PlayerSlot.facing` is written by `shoot` (§2.5) and already replicates.
  Draw a remote tracer from that seat toward the boss. It lives 120 ms; nobody can measure
  its angle.

Making player fire an on-chain projectile instead is specified and costed in §3.3, and
recommended against.

### 2.5 The changes, exactly

**`programs/heartrot/src/handlers/shoot.rs`**

- Instruction data becomes `&[seat, dx, dy, charged]`. **Delete** the `dir >= FACING_STEP.len()`
  rejection — every `i8` pair except `(0, 0)` is a legal aim, and `(0, 0)` is rejected by
  the octant helper below, which already returns `Err(InvalidInstructionData)` for it.
- **Delete** `FACING_STEP`. Nothing else reads it.
- `fire(arena, boss, slot, dx, dy)`.
- `slot.facing = octant(dx, dy)?` — the sprite's eight-way body direction, unchanged in
  meaning. See the `octant` note below.
- `raycast(from_x, from_y, dx, dy, boss)`:

  ```
  const Q: i32 = 4096;                       // Q12 fixed point
  let (ax, ay) = (dx.abs() as i32, dy.abs() as i32);
  let approx_len = ax.max(ay) + ax.min(ay) / 2;   // alpha-max-plus-beta-min
  if approx_len == 0 { return None; }             // unreachable: octant rejected it
  let ux = dx as i32 * Q / approx_len;             // Q12 unit vector
  let uy = dy as i32 * Q / approx_len;
  let (mut fx, mut fy) = ((from_x as i32) * Q, (from_y as i32) * Q);
  for _ in 0..MAX_RAY_STEPS {
      fx += ux * TILE as i32;
      fy += uy * TILE as i32;
      let (x, y) = (fx / Q, fy / Q);
      ... existing wall / parts / core body, unchanged ...
  }
  ```

  Overflow: `|fx|` peaks near `1024 × 4096 + 64 × 4096 × 16 ≈ 8.4 M`, four hundred times
  inside `i32`. Use `/ Q`, not `>> 12`: an arithmetic shift right floors, and `is_wall`
  wants the same truncation-toward-zero the rest of the file uses. (`is_wall` rejects
  `x < 0` before dividing, so the two agree, but a division makes that independent of
  reading that guard.)

- `MAX_RAY_STEPS: i32 = map::MAP_TILES as i32` (**64**, was 20). Derived from the map, not
  a hand-tuned literal — a shot must be able to cross the arena it is fired in.
  Reach is `MAX_RAY_STEPS × TILE × [0.894, 1.0]` = **916 … 1024 units**, against an 865-unit
  worst-case pit range. Comment the margin, and the rule for changing it:
  `MAX_RAY_STEPS >= ceil(worst_range / 14.3)`. The off-map branch of `is_wall` remains the
  early-out — the mean ray executes 32 of the 64 steps (§8.4).
- Add the shell-AABB gate before the nine-rect scan (§5.1). Without it, 64 steps × 9 rects
  is 576 rect tests per shot instead of 117 worst case.

**`programs/heartrot/src/handlers/player.rs`**

`octant` is currently `fn octant(dx: i8, dy: i8) -> Result<u8, ProgramError>` and switches
on `(dx.signum(), dy.signum())`. That is correct for `move`, whose input is a unit vector,
and **wrong for a fine aim vector**: `(30, −120)` is 14° from north and signum calls it
north-east, so the knight sprite would face diagonally while shooting nearly straight up.

Replace the body with nearest-of-eight, integer only. `tan(22.5°) = 0.41421`; `5/12 =
0.41667` is 0.6 % wide and needs no table:

```
let (ax, ay) = (dx.abs() as i32, dy.abs() as i32);
if ax == 0 && ay == 0 { return Err(ProgramError::InvalidInstructionData); }
if ax * 12 < ay * 5 { return Ok(if dy < 0 { 0 } else { 4 }); }   // within 22.5° of vertical
if ay * 12 < ax * 5 { return Ok(if dx > 0 { 2 } else { 6 }); }   // within 22.5° of horizontal
Ok(if dx > 0 { if dy < 0 { 1 } else { 3 } } else if dy < 0 { 7 } else { 5 })
```

Make it `pub(crate)` so `shoot` calls it instead of carrying a second copy.

This is a **strict generalisation**, not a behaviour change for `move`: verified in §8.5 to
agree with the signum table on all eight unit vectors, to reject `(0, 0)`, and to disagree
with the true nearest octant on 0 of 3,600 sampled aim angles. `player.rs`'s existing octant
test must keep passing unmodified — that is the check.

**No `aim` field is added to `PlayerSlot`.** `_pad0` at offset 3 is free and it stays free.
A remote knight's body direction is what the renderer draws, `facing` already carries it,
and a remote tracer lives 120 ms. Adding a byte to store an angle nothing can perceive is
one more fact to keep in sync for no visible gain.

**`packages/client/src/instructions.ts`** — `alloc(IX_SHOOT, 3)`, `data[1] = seatIndex(seat)`,
`view.setInt8(2, dx)`, `view.setInt8(3, dy)`, both validated as `i8` and rejected when both
are zero. `dir8` stays; `movePlayer` still uses it. Accounts unchanged.

**`app/src/input/controls.ts`** — `aimDirection()` returns the pointer vector scaled so the
larger component is ±127, instead of `dirFromVector`'s octant index. Keyboard fire (no
pointer) sends the unit vector of the current `facing`, i.e. `octantStep(facing)` scaled —
so the keyboard is exactly as accurate as it is today and no worse. `dirFromVector` stays;
movement still uses it. The `controls self-check` at the bottom of the file gets one added
assertion: a known pointer offset produces a known `(dx, dy)`.

**`app/src/App.tsx`** — pass `{ dx, dy }` instead of `dir` at the one `shoot(...)` call site.

**`docs/architecture/05-wire-abi.md`** — tag 7 row `2 B` → `3 B`, and the §"Tag 7 — Shoot"
body.

### 2.6 One thing that is now easy and should be taken

`connection.ts` carries a `ponytail:` note that `shoot` is `[tag, seat, dir]` with no nonce,
so a player holding fire in one direction produces byte-identical transactions that collide
on signature; two repeats inside one 50 ms ER slot can still be silently dropped. At twenty
shooters that is twenty players hitting it. **A free-aim `(dx, dy)` from a pointer is
already almost never identical twice**, which reduces the collision rate but does not close
it — a keyboard shooter still sends the same pair every time. Closing it properly is one
`u16` nonce, exactly as `move` has, and this is the edit that is already opening the file.
Out of scope for this spec; note it so the implementer does not have to rediscover it.

### 2.7 Shot tiers — tap, charged, super (shipped 2026-09-03)

The wire's fourth byte is a **tier**: 0 tap, 1 charged (2.5×, `CHARGE_SLOTS` = 20 ER
slots of stillness), 2 super (5×, `SUPER_SLOTS` = 50). A hold the chain does not see is
`NotCharged` (20) *before* the cooldown is spent, and the client resends one tier down. All
of it is stateless — the hold is `Clock.slot − last_move_tick`, never `Arena.tick`.

**Tier 2 pierces.** `shoot.rs::walk_ray` is one loop with a stop rule: `raycast` (tiers 0
and 1) stops at the first live part box or the core; `raycast_beam` never stops and returns
a 9-bit part mask plus whether the core circle was crossed. `fire` lands the damage from
that one shape for every tier — each masked part once, then `recompute_vent`, then the
core if crossed **and the vent is open now** — so a beam that strips the last of the
shell kills through the vent it opened, in one transaction. `damage_dealt` credits what was
removed. The verdict rides `facing` bit 3 (charged) or bit 4 (super), never both.

Client mirrors: `instructions.ts::shoot({ tier })`, `aim.ts::raycastBeam` (same integer
steps as `raycastShot`, one shared walk) returning `{ end, hits, core }` for the renderer.
Cost: a super is the same 64-step walk without the early return — bounded by the same
`SHELL_AABB` gate — plus one `Clock` read, the 129 CU the charged shot already pays.

---

## 3. The pool at twenty shooters

### 3.1 It holds. Do not grow it.

Because player fire is hitscan (§0.1), twenty shooters put **zero** bullets in the pool.
The only producer is `spawn_volley`.

Steady state, from the shipped constants — `BULLET_SPEED = 12` units/tick,
`VOLLEY_INTERVAL_TICKS = 32`, `bullets_per_volley = 3 + alive ≤ 23`:

```
lifetime_ticks   = ceil(max_travel / 12)
volleys_in_flight = ceil(lifetime_ticks / 32)
peak_occupancy   = volleys_in_flight × 23
```

| max travel before a wall | lifetime | volleys in flight | peak | verdict |
|---|---|---|---|---|
| 700 u — boss to pit floor | 59 ticks | 2 | **46** / 128 | 2.78× headroom |
| 1100 u — boss to a far corner | 92 ticks | 3 | **69** / 128 | 1.86× headroom |
| 1448 u — full map diagonal, walls removed | 121 ticks | 4 | **92** / 128 | 1.39× headroom |

The middle row is the honest worst case for a top-centre boss in a walled pit; the bottom
row is the absolute ceiling with every wall deleted. **128 holds in all three.** No pool
change, no per-source quota, no lifetime cap. Zero account bytes.

The existing const assert — `BASE_VOLLEY_BULLETS + MAX_SEATS <= MAX_BULLETS` — only proves
one volley fits, not that overlapping volleys do. **Add the real bound** beside it, so the
argument above is enforced rather than remembered:

```
// Overlapping volleys, not one volley. A bullet lives at most
// ARENA_SIZE / BULLET_SPEED ticks (nothing outlives crossing the map), and a new
// volley lands every VOLLEY_INTERVAL_TICKS, so this many can be in the air at once.
const MAX_VOLLEYS_IN_FLIGHT: usize =
    (ARENA_SIZE as usize / BULLET_SPEED as usize).div_ceil(VOLLEY_INTERVAL_TICKS as usize) + 1;
const _: () = assert!(
    MAX_VOLLEYS_IN_FLIGHT * (BASE_VOLLEY_BULLETS + MAX_SEATS) <= MAX_BULLETS,
    "overlapping volleys can exhaust the pool -- raise MAX_BULLETS or VOLLEY_INTERVAL_TICKS",
);
```

`1024/12 = 85`, `ceil(85/32) + 1 = 4`, `4 × 23 = 92 <= 128`. It passes today and it fires
the moment someone shortens the volley interval or lengthens the map — which is exactly the
change that would silently start dropping volleys.

### 3.2 What a full pool actually costs

Nothing catastrophic, and this is worth stating because it bounds the risk. `spawn_volley`
sweeps the pool once and drops the remainder of the volley. The failure mode is "the boss
fired fewer bullets than it meant to for one tick", which is invisible and self-corrects on
the next volley. There is no error, no stuck state, and no way for it to compound.

### 3.3 If player fire were made an on-chain projectile anyway

Costed, because the brief asks for bullets going up and someone will propose it.

Player shot rate at twenty seats on an 800 ms cooldown is `20/8 = 2.5` shots per tick.
Flight time over the 700-unit pit, plus the 46 boss bullets already in the air:

| player bullet speed | flight | player bullets in flight | + boss | total / 128 |
|---|---|---|---|---|
| 12 u/tick (boss speed) | 59 ticks | 147.5 | 46 | **193.5 — overflows** |
| 40 u/tick | 18 ticks | 45.0 | 46 | 91 — holds |
| 60 u/tick | 12 ticks | 30.0 | 46 | 76 — holds |

So it is only survivable if player bullets are 3–5× faster than boss bullets — which is a
reasonable design (their fire is fast, yours is dodgeable) and fits `i8` (`60 ≤ 127`).

The full cost if it is ever taken:

- **`Bullet.owner_seat`: 0 bytes.** Claim `_pad0` at offset 7, exactly as `Arena.outcome`
  claimed `Arena._pad0`. `NO_TARGET` (0xFF) means boss ordnance. Every bullet already on
  chain reads 0 there, which would decode as "seat 0" — so this **must** ship with a
  `LAYOUT_VERSION` bump, or an in-flight match reattributes the boss's own bullets to
  seat 0. Needed for damage credit (`damage_dealt`) and to stop player bullets damaging
  players.
- **Two collision passes per tick**, not one: boss bullets vs. 20 players (exists), player
  bullets vs. 9 parts + core. The second is `n_player_bullets × 10` box tests — at 45
  bullets, 450 tests, comparable to the 920 the existing pass already runs.
- **Split pools if 128 is tight.** `MAX_BULLETS 128 → 192` costs `64 × 8 = 512` bytes on
  `Arena` (1,200 → 1,712) plus a `LAYOUT_VERSION` bump and a `04-layout-contract.md` edit.
- **The real cost is not bytes.** It moves player fire from 0 ms perceived latency to
  `127 ms + flight time`. That trade is what the whole asymmetry in `shoot.rs` exists to
  avoid. **Recommend against.**

---

## 4. Sub-unit velocity

### 4.1 This redesign does not need it.

`state.rs` states the constraint: `TICK_MS` cannot drop below 100 without sub-unit velocity,
because integer `i8` `dx`/`dy` at a smaller per-tick step quantises direction more coarsely.
Nothing in this specification changes `TICK_MS`. The player ray does not use `Bullet` at all.
So the layout stays as it is.

But the docstring's *number* is wrong, and the top-centre layout is exactly the case that
exposes it: boss volleys now travel the full depth of the pit instead of across a chamber,
and a fixed angular error costs proportionally more at longer range.

Measured over 36,000 aim angles through the shipped `unit_velocity` (§8.1):

| speed | truncate (shipped) | round (one line) | miss at 320 u, trunc → round | miss at 800 u, trunc → round |
|---|---|---|---|---|
| 12 u/tick — `TICK_MS = 100`, today | **5.07°** | 2.95° | 28.4 u → 16.5 u | 71.0 u (4.4 tiles) → 41.2 u (2.6 tiles) |
| 6 u/tick — `TICK_MS = 50` | 10.46° | 5.92° | 59.1 u → 33.2 u | 147.7 u (9.2 tiles) → 82.9 u |
| 48 u/tick — `TICK_MS = 400`, old | 1.25° | 0.75° | 7.0 u → 4.2 u | 17.4 u → 10.5 u |

The docstring's "~2.4 degrees" is the *rounded* figure; `unit_velocity` truncates.

**Is 5.07° a defect?** No — and this is the reason not to change the layout. The volley is a
deliberate fan: `SPREAD_DEN = 24` puts the outermost bullet of a 23-shot volley at
`atan(11/24) = 24.6°` off the aim line, and there is a per-bullet ±1 jitter on top. A 5.07°
worst-case quantisation is **21 % of the design's own aiming imprecision**. It is inside the
spread, not outside it, and the design never claimed a boss volley aims tightly.

### 4.2 Take the free half of the fix

Round instead of truncate in `unit_velocity`. Integer only, no layout change, no bytes,
halves the error to 2.95°:

```
// round-half-away-from-zero, integer only
let n = vx.saturating_mul(BULLET_SPEED);
let dx = (2 * n + if n >= 0 { approx_len } else { -approx_len }) / (2 * approx_len);
```

`velocities_are_bounded_and_never_zero` in `tick.rs` already asserts
`|dx| <= BULLET_SPEED`; rounding can reach `BULLET_SPEED` exactly but not exceed it,
because `approx_len >= max(|vx|, |vy|)`. That test is the check — it must keep passing
unmodified. Then correct the `TICK_MS` docstring to the measured numbers.

### 4.3 The upgrade path, if `TICK_MS` ever drops to 50

Do **not** widen `dx`/`dy` to `i16` (that grows `Bullet` to 10 bytes and `Arena` by 256).
Reinterpret the existing fields as **Q3 fixed point — 1/8 unit — with no layout change at
all** (§8.1):

- position `i16` in Q3 spans ±4,096 units; the arena needs 1,024. **4× headroom.**
- velocity `i8` in Q3 spans ±15.875 units/tick; today's 12 fits.
- direction error with rounding: **0.30°** at 12 u/tick, **0.60°** at 6 u/tick — better than
  the current 400 ms build ever was.

The cost is **zero bytes and a meaning change**, which is worse than a size change because
nothing detects it: a `Bullet` in Q3 is byte-identical to one in whole units, and an old
account would decode as bullets 8× too far out. It therefore requires, non-negotiably:

1. a `LAYOUT_VERSION` bump (currently 1) — this is the only thing that catches it;
2. `packages/client/src/layout.ts` and `app/src/render/Arena.tsx`'s extrapolator shifted in
   the same commit — the renderer draws `x + dx*f` and would place every bullet 8× out;
3. `04-layout-contract.md` updated, because "same size, different meaning" is precisely the
   kind of change that document exists to catch.

**Do not do this speculatively.** It is written down so that if the crank ever drops to the
50 ms ER slot, nobody reaches for `i16` first.

---

## 5. Collision cost

### 5.1 The player ray — 64 steps, not 20

Extending `MAX_RAY_STEPS` from 20 to 64 triples the loop bound. Without a guard it also
triples the nine-rect scan, which is the expensive part. The guard is one axis-aligned box
test against the union of `PART_HITBOXES`:

```
// The shell's own bounding box, folded out of the generated table at compile time, so it
// cannot describe a different creature than the rects it summarises. 227 x 232 units.
const SHELL_AABB: Rect = /* const fn fold over PART_HITBOXES, widened by CORE_RADIUS */;
```

Emit it from `tools/gen_hitboxes.py` in the same pass as `PART_HITBOXES`, or fold it in a
`const fn` in `hitboxes.rs`. Either way it is **derived, never typed** — a hand-written
bounding box for a generated table is the exact defect `hitboxes.rs`'s own header warns
about.

Measured over 107,520 rays (420 pit stands × 256 aim directions, §8.4):

| | mean | worst |
|---|---|---|
| ray steps executed | 32.1 | 64 |
| nine-rect scans (only inside the AABB) | 0.32 | 13 |
| **work per shot** | 32 wall lookups + 32 AABB compares + 3 rect tests | 64 + 64 + 117 rect + 13 core |

A wall lookup is one shift and one mask against a `const` table — no account read, no
syscall. An AABB compare is four `i32` compares. The worst-case shot is roughly **260
integer operations** of ray work inside a **200,000 CU** budget (one non-builtin
instruction), against a program whose entire linked text is 11,942 SBPF instructions
(§8.6). The ray is not where a `shoot` transaction's budget goes; the three account
deserialisations and five guards are.

**Without** the AABB gate the same worst case is 576 rect tests instead of 117. Still
affordable, but there is no reason to spend it.

**Known ceiling, accepted.** The ray samples one point per tile, so a ray that clips a
part's corner can pass through it. Measured at **2.09 %** of rays that geometrically cross
a part (§8.4). All are grazes — the generator already refuses to emit a box under one tile
on either axis, so no ray can skip a box it crosses squarely. Mark it and move on:

```
// ponytail: one sample per TILE, so a corner graze can pass through a part -- measured
// 2.09% of rays that geometrically cross one (docs/architecture/09-shooting.md §8.4).
// All grazes; a square crossing cannot be skipped because gen_hitboxes.py refuses a box
// under TILE on either axis. Upgrade path if grazes ever matter: step TILE/2 while the
// sample is inside SHELL_AABB, which costs ~21 extra samples on the shots that hit.
```

### 5.2 The boss volley — unchanged, and already bounded

128 bullets × 20 players × 10 ticks/s is the number the crank was designed around, and
`03-risks-and-build-order.md` R5 already names it. Nothing in this specification changes it.
At the §3.1 steady state:

| | count | cost each |
|---|---|---|
| active bullets | 46 | — |
| wall samples | 92 | shift + mask |
| broad-phase AABB compares | 920 | four `i32` compares |
| exact `bullet_hits` calls | a handful | `i64` dot products, no division |
| **absolute worst if the pool were full** | 2,560 pair tests | — |

Three structural properties keep this cheap and **must not be regressed**:

1. Live seats are copied into a 24-byte stack array once per tick. Do not re-read
   `players.slots` inside the bullet loop.
2. The broad phase rejects before any multiply. Do not call `bullet_hits` first.
3. A killed seat is swap-removed mid-tick, shrinking every subsequent bullet's inner loop.

One thing gets *worse* with a pit and is worth knowing: today's four-corridor map spreads
players out, so the bounding-box broad phase rejects almost everything. Twenty players
clustered in one pit reject less. The bound is unchanged — 2,560 pair tests is the ceiling
either way — but the *typical* case moves toward it. If a measured tick ever approaches
400,000 CU, R5's stated fix (bitboard the active-bullet mask, then 64 bullets) applies
before anything in this document does.

### 5.3 What actually limits twenty simultaneous shooters

Not CU, and not the pool. **`Players` is one write-locked account.**

- twenty seats moving at one move per 50 ms ER slot: **400 tx/s**, all write-locking `Players`
- twenty seats shooting on an 800 ms cooldown: **25 tx/s**, same lock

Shooting is **6 %** of the write pressure on that account. Nothing in this specification
moves that needle, and the fix, when it is needed, is the one `state.rs` already names in a
`ponytail:` comment — shard `Players` into two ten-seat accounts, still four crank metas,
still far under the 38-key ER ceiling. That belongs to the movement work, not here.

One cheap option exists and is **not** recommended: `shoot` could take `Arena` as
`READONLY`. It only reads `tick`; the sole write is `end_fight` on the killing blow, and
`tick::step` already re-derives that win from `boss.core_hp == 0` within one crank period.
That would drop one write lock — but `Boss` and `Players` are still write-locked by every
shot, so nothing is unblocked, and the killer would wait up to 100 ms to see the win. Not
worth it.

---

## 6. Acceptance

An implementation of this specification is done when all of the following hold.

**Rust — `cargo test -p heartrot`, the *unit* result line (59 today, more after this).**

1. `raycast` from a pit stand directly below the boss, aimed straight up, reaches the shell
   at a range greater than 320 units. This is the test that fails today.
2. `raycast` reaches `Hit::Core` from a pit stand once the intervening parts are zeroed.
   With 8-way aim this is unreachable from any stand (§1.1); it is the regression test for
   the whole change.
3. `octant` still returns 0..7 for the eight unit vectors and `Err` for `(0, 0)` — the
   existing `player.rs` test, unmodified.
4. `octant((30, -120)) == 0`, not 1. The nearest-of-eight property.
5. `velocities_are_bounded_and_never_zero` still passes after the rounding change in
   `unit_velocity` — unmodified.
6. The `MAX_VOLLEYS_IN_FLIGHT` const assert compiles.
7. `shell_then_vent_then_core_is_a_recorded_win`, `a_sealed_vent_absorbs_a_core_hit`,
   `the_cooldown_is_ticks_and_a_miss_spends_it` and `the_dead_and_the_unentered_cannot_fire`
   all still pass, rewritten only where they name a `dir` — the kill chain, the vent gate
   and the rate limiter are unchanged by this specification and must be proven unchanged.

**TypeScript.**

8. `(cd app && npx tsc --noEmit)`, `(cd packages/client && npx tsc --noEmit)`,
   `(cd worker && npx tsc --noEmit)` all exit 0.
9. `controls.ts`'s self-check gains one assertion tying a known pointer offset to a known
   `(dx, dy)`, and still throws on regression.

**On chain — the measurement this document could not make (§8.6).**

10. Read `consumed X of 400000 compute units` from a crank transaction log during a
    twenty-seat fight, and `consumed X of 200000` from a `shoot`. These are open question
    **Q2 / SP2** in `03-risks-and-build-order.md`, still unanswered, and they are the only
    way to close R5. Record both here.

---

## 7. What is deliberately not changing

- The hitscan/travel-time asymmetry (§0.1). It is the design's answer to a 127 ms round
  trip.
- The cooldown, its 800 ms, its tick clock, and the fact that a miss spends it.
- `SHOT_DAMAGE`, the vent threshold, `recompute_vent`, the parts-are-health model.
- `Bullet`'s layout, `MAX_BULLETS`, `bullets_per_volley`, `SPREAD_DEN`,
  `VOLLEY_INTERVAL_TICKS`, `TICK_MS`.
- `PlayerSlot`'s layout. `_pad0` stays free.
- Every account's size. `04-layout-contract.md` is untouched.
- `map::WALLS` as the single wall table for both movement and shooting.

---

## 8. How every number here was obtained

Scripts live in this session's scratchpad, not the repo — they are derivations, not
tooling, and nothing in the build depends on them. Each replicates the Rust integer
semantics exactly, including truncation toward zero (Rust `i32 /` truncates; Python `//`
floors, so every division goes through an explicit `tdiv`). Constants are transcribed from
the source files named in §0 and re-derived rather than restated: `BULLET_SPEED` is computed
from `BULLET_UNITS_PER_SEC` and `TICK_MS`, `SHOT_COOLDOWN_TICKS` from `ticks_for(800)`, and
so on — which is how the three stale comments in §0.7 surfaced.

| § | Script | Produces |
|---|---|---|
| 8.1 | `measure.py` | `unit_velocity` angular error, truncate vs. round, at three tick rates over 36,000 angles; Q3 fixed-point headroom |
| 8.2 | `measure5.py` | i8-pair aim error over 200,000 angles, end to end through browser scaling and chain normalisation; nearest-of-eight equivalence |
| 8.3 | `measure2.py`, `measure3.py` | part angular sizes; pool occupancy; part reachability by aim resolution, replaying `raycast` verbatim |
| 8.4 | `measure4.py` | ray step and rect-scan counts over 107,520 rays; graze loss |
| 8.5 | `measure5.py` | nearest-of-eight vs. `player.rs::octant` on all 8 unit vectors and 3,600 aim angles |

**8.3 assumes a geometry that does not exist yet.** The map task owns the real numbers. The
assumption used throughout: boss at `(512, 176)` — tile (32, 11), shell spanning y 48..280 —
with a pit from y 304 to 944 and x 176 to 848. Every conclusion is
monotone in pit depth: a deeper pit makes 8-way aim worse and needs more ray steps, a
shallower one needs fewer. The two thresholds to re-check against the real map are
`MAX_RAY_STEPS >= ceil(worst_stand_to_core_range / 14.3)` (§2.5) and the
`MAX_VOLLEYS_IN_FLIGHT` assert (§3.1). Nothing else moves.

**8.6 — what was not measured, and why.** No compute-unit number here was measured on chain
or in a VM. The attempt is recorded because the negative result is the useful part:

- The program builds for SBF —
  `HEARTROT_TREASURY=… cargo-build-sbf --offline` produces a 110,864-byte
  `target/deploy/heartrot.so`. Disassembled with the platform-tools LLVM
  (`~/.cache/solana/v1.54/platform-tools/llvm/bin/llvm-objdump`, since the system one has
  no SBF target), the linked object is **11,942 SBPF instructions** in a single stripped
  `.text` blob. The stripping survives `-C strip=none`, so no per-function attribution is
  possible from the artifact.
- The pre-link `libheartrot.rlib` keeps symbols, but `lto = "fat"` leaves the bodies as
  bitcode: `handlers::tick::step` disassembles to 97 instructions and
  `handlers::shoot::fire` to 7, which are thunks, not the real loops.
- No `litesvm`, `mollusk-svm` or `solana-program-test` is vendored, and adding one means
  editing `Cargo.toml` — product code this task may not touch.

So every cost figure in §5 is an **operation count**, stated as such, bounded by a total
program text of 11,942 instructions. The real number comes from the crank log and is
acceptance item 10.
