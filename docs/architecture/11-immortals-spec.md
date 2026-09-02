# 11 — HEARTROT immortals: the one specification

Status: **authoritative**. Where this file disagrees with `docs/art/*.md`,
`docs/architecture/07..10-*.md` or `docs/perf/*.md`, this file wins. Those documents keep
their measurements — every number here is traceable to one of them — but their
*recommendations* were made in parallel and contradict each other on geometry, part
indices, aim model, phase names and how much art to rasterise. This file makes the choices.

Ten agents produced this input. Six of their proposals are **cut** (§12). Cutting is the
point: the run has a 16.7 ms frame budget, a 399,700 CU tick budget, and an account-size
budget with exactly one free `u32` left in `Arena`. A spec that spends all three is not a
plan.

**Read §0 first.** Three facts every input document got wrong at least once.

---

## 0. Corrections to the brief and to the input documents

| Claim seen in the brief or in an input doc | Truth, verified this session |
|---|---|
| `map::BOSS_SPAWN = (512, 320)`, tile (32,20) | It is `(512, 512)`, tile (32,32) — `map.rs:142`. `(512,320)` is a *fixed defect* the file documents at length (boss inside rock, ray died on a corridor wall). Four documents repeated the stale value. |
| Player fire is a bullet | It is **hitscan**. `shoot.rs` allocates no projectile; `raycast` walks and lands damage in the same transaction. `MAX_BULLETS = 128` is boss ordnance only. |
| `BULLET_SPEED` is 48 units/tick; volleys every 8 ticks | 12 units/tick and 32 ticks. Both comments predate `TICK_MS` 400 → 100. |
| `TICK_ITERATIONS = 4500` is "5× headroom" (`settle.rs:98`) | 1.25×. `ENRAGE_AT_TICK` is 3,600 ticks, not 900. Wrong by 4×. |
| `layout.ts:78` roll timeout `25` | `state.rs:156` is `ticks_for(10_000)` = **100**. The TS mirror is the 400 ms-era literal and is 75 ticks early. Fix in the same commit (§10.9). |
| `state.rs` deferred note: "the measured 71 KB/s raid budget" | 1,636 KB/s at 20 seats. Wrong by 23×. |
| `research-subscription-shape.md`: naming an account WRITABLE emits 0 notifications | Refuted. The ER emits one notification per account **named** in a landed transaction, in either role. Probe: 10 sends/arm with control windows, corroborated by two 20-seat load blocks. |

Baseline confirmed before any change: `cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"` → `running 59 tests` / `59 passed`. (The second pair is the doc-test line reading 0; it is not the one.)

---

## 1. The geometry

One coordinate system. **Arena units.** 64 × 64 tiles, `TILE = 16`, world 1024 × 1024,
origin top-left, +y down. Unchanged from today. Every number below is emitted by
`tools/gen_map.py` from `assets/map/arena.json` or by `tools/gen_hitboxes.py` from
`assets/sprites/hitboxes.json`. **Nothing in this section is typed into a `.rs` or `.ts`
file by hand.** They are printed here so a reviewer can check the generator's output, not
so an implementer can copy them.

### 1.1 The map, by tile row

```
 y=0          border wall
 y=1..23      OPEN FLOOR — "boss air"                      world y   16..383
 y=24..35     PIT FLOOR   `P`  (12 rows)                   world y  384..575
 y=36..37     rim wall, open only at x=30..33 — the DOORWAY, also `P`
 y=38..39     gate tiles  `G`                              world y  608..639
 y=40..62     lobby (temple approach)
 y=63         border wall
```

- `B` at tile **(32, 25)** → `map::BOSS_SPAWN = (512, 400)`.
- `P` bounding rows 24..37 → `map::PIT_TOP = 384`, `map::PIT_BOT = 607`.
- `G` tiles x 30..33, y 38..39 → `map::GATE_MIN_X = 480`, `GATE_MAX_X = 543`,
  `GATE_MIN_Y = 608`, `GATE_MAX_Y = 639`.
- Four `E` at tiles (10,32) (22,32) (42,32) (54,32) →
  `map::ENTRANCES = [(160,512),(352,512),(672,512),(864,512)]`. All four inside the pit.
- `LOBBY_ENTRANCE` stays tile (28,52) = world (448, 832).
- Pit corner shaping: rows 33/34/35 walled 2/4/7 tiles in from each side, so the pit
  reads as an ellipse rather than a box. **718 walkable pit tiles.**

**Boss air (rows 1..23) must be FLOOR, not wall.** `shoot.rs::raycast` tests `is_wall`
*before* the part rectangles. One wall tile between a player and the boss kills every shot
in that column. The pit ceiling is therefore a movement rule, not a wall — see §1.3.

Validated: `tools/gen_map.py::validate` was imported and run against this exact grid with
these exact constants. **PASS** — border closed, four entrances, one heart, all floor
4-connected to the heart, all 40 spawn points (20 lobby + 20 arena) on floor and reachable,
all gate tiles floor.

### 1.2 The boss footprint

`SCALE = 3`, a **parameter of `tools/gen_hitboxes.py`**, never a constant in Rust or TS.
The sprite canvas is 230 × 270; at S=3 it is 690 × 810 with anchor
`ANCHOR_X = -345`, `ANCHOR_Y = -405`, so its top-left lands at world **(167, −5)**.

Destructible span **x 170..850 = 681 units = 66.5% of the frame width**. That is the
"fills the top centre" of the reference. S=2 gives 44% and does not read as filling. S=3 is
also what closes the boss:knight height ratio at 810 : 42 ≈ 19:1, inside the reference's
1:12–1:18 band.

World extents at S=3, anchor (512, 400):

| part | world x | world y |
|---|---|---|
| crown | 533..733 | 16..192 |
| wolf_l | 371..520 | 142..300 |
| beast_r | 683..820 | 151..306 |
| thorn0 | 464..526 | 79..186 |
| thorn1 | 707..850 | 106..300 |
| thorn2 | 422..481 | 289..357 |
| thorn3 | 776..847 | 376..426 |
| mace | 170..502 | 301..711 |
| claws | 677..832 | 286..615 |
| **core (vent)** | centre **(587, 346)** | radius **60** |

The mace and claws overlap the pit floor in y. That *is* the reference's "huge clawed
hands gripping the rim". Draw the boss **behind** players; draw the rim **in front of
everything**.

Nothing visible is clipped: the topmost painted pixel lands at world y = 16.

**S=3 is the single reversible decision in this spec.** If §9 says the frame budget breaks,
re-run `gen_hitboxes.py --scale 2` and every hitbox, muzzle, anchor and core radius moves
in one pass. That is the entire reason SCALE is a generator argument.

### 1.3 `PIT_TOP` / `PIT_BOT`: the arena box

`handlers::player::move_player` rejects a step whose destination y is outside
`PIT_TOP ..= PIT_BOT` **when `slot.zone == ZONE_ARENA`**. Two comparisons, no new account,
no wall.

- `PIT_TOP` stops a raider walking up into the boss's head. It cannot be a wall: a wall
  there kills every ray in that column.
- `PIT_BOT` stops a raider retreating down the gate corridor. This is not tidiness:
  `spawn_volley` aims at the *nearest live player*, so one camper at the corridor mouth
  makes the boss waste every volley on a target the rim wall shields.
- The doorway (rows 36..37 at x 30..33) is marked `P`, so it is inside the box — otherwise
  a player who flips zone on the gate tiles is instantly boxed out of every legal move and
  deadlocks. The residual camping spot is that 4 × 2 doorway, which sits inside slam lanes
  3 and 4 and in every muzzle's line of fire. Accepted, and stated.

Test to leave behind: for every pit column, a `ZONE_ARENA` player at `PIT_TOP` cannot step
north **and the tile north of them is floor** — proving the clamp, not a wall, is what
holds them.

### 1.4 The camera — a `<g>` transform, never a `viewBox` write

The `<svg>` carries `viewBox="0 0 1024 1024"` for the life of the page. A single
`<g id="camera">` wraps the whole scene and carries `transform: scale(k) translate(-cx,-cy)`.

| state | k | translate | shows |
|---|---|---|---|
| LOBBY / MUSTERING | 2 | (−256, −512) | world x 256..768, y 512..1024 — the pit lip, the doorway, the gate, the temple approach |
| FIGHTING and later | 1 | (0, 0) | the whole world: boss at top, pit in the middle |

Both scales are integers, so both ends of the transition are pixel-exact.

**Animating the `viewBox` attribute is forbidden.** Measured: 9.6 ms/frame p95 14.2, a 5.3×
regression, against ~1.7 ms for the identical scene animating a transform. The camera pan
is a WAAPI animation on `#camera`'s transform and nothing else.

The camera is what the user asked for as "THEN boss spawn": the boss stands at (512,400)
from `init` onward, and the reveal is the pan that happens while the player walks the
doorway. **Zero chain machinery buys the entire reveal.**

### 1.5 Sharpness

`usePixelFit` computes `raw = min(box) * dpr / VIEW` and floors to an integer when `raw ≥ 1`.
At a 1024-unit span on a 900 css / dpr-1 container, `raw = 0.88` — sub-pixel, and *which*
rows drop changes as a sprite translates, which under the inherited
`shape-rendering: crispEdges` is outline flicker on art that is 19% dark keyline.

Fix, one conditional attribute: **`shape-rendering: crispEdges` when the fit scale is ≥ 1,
`geometricPrecision` below it.** That converts shimmer into softness, which is the better
failure. No camera redesign, no viewBox shrink. (Cut: the "visible span ≤ min(box)·dpr/2"
requirement `docs/art/knights.md` handed to the arena task.)

---

## 2. The part table

One ordered list. `Boss.parts[i]`, `hitboxes::PART_HITBOXES[i]`, `BOSS_PARTS_BASE[i]` and
the renderer's part group `i` all mean the same limb, by construction — `PART_HITBOXES` is
declared `[Rect; crate::state::N_PARTS]` so a disagreement stops compiling.

**Indices are renumbered.** `shoot.rs::raycast` is first-live-match over `PART_HITBOXES` in
index order, and today's order (crown, wolf_l, beast_r, thorns…) makes `beast_r`'s box win
over `thorn1`'s where they overlap — costing thorn1 **65.2% of its box and 57% of its own
drawn art**. `tools/svg_slice.py` already claims *pixels* in small-and-specific-first order;
only the `index:` numbers disagreed. Renumbering makes the two orders one order.

| idx | name | sprite box (x,y,w,h) | hp base | muzzle (boss-local, S=3) | role |
|---|---|---|---|---|---|
| 0 | thorn0 | 99, 28, 21, 36 | 1,000 | (−18, −273) | emitter |
| 1 | thorn1 | 180, 37, 48, 65 | 1,000 | (270, −216) | emitter |
| 2 | thorn2 | 85, 98, 20, 23 | 1,000 | (−63, −75) | emitter |
| 3 | thorn3 | 203, 127, 24, 17 | 1,000 | (288, 0) | emitter |
| 4 | crown | 122, 7, 67, 59 | 4,000 | — | far target |
| 5 | wolf_l | 68, 49, 50, 53 | 2,500 | — | inner shell |
| 6 | beast_r | 172, 52, 46, 52 | 2,500 | — | inner shell |
| 7 | mace | 1, 102, 111, 137 | 2,500 | — | hand |
| 8 | claws | 170, 97, 52, 110 | 2,500 | — | hand |

Not in `parts`, `index: null`, never raycast: `ground`, `legs`, `torso`, `core`.

- **The vent is `core`**, sprite (120,95,40,45), the inscribed circle → boss-local
  `CORE_X=75, CORE_Y=−54, CORE_RADIUS_SQ=3600` at S=3, i.e. world **(587, 346) r=60** — the
  reference's bright chest orb, high and centre. It needs no new geometry. There is no
  glowing orb in the source art; the glow is **drawn**, at
  `<circle cx={CORE.x} cy={CORE.y} r={Math.sqrt(CORE.radiusSq)}>` with all three values
  imported from `@heartrot/client`. A literal there re-creates this project's signature
  defect in the exact place `gen_hitboxes.py` exists to prevent it.
- **`core_hp` is not a part.** `sum(parts)` is the shell's health; `vent_open` is recomputed
  every tick as `sum(parts)·100 < sum(parts_max)·35`; `core_hp` decrements only while
  `vent_open == 1`. Unchanged, and it maps onto the anatomy for free.
- **HP weightings follow the names, not the positions.** `BOSS_PARTS_BASE` is reordered in
  the same commit. Sum stays **18,000**; the vent opens after 11,700 damage. The
  raid-size knob is `core_hp`, not `parts` — see §5.4.
- **Muzzles move to drawn pixels.** `to_muzzles()` uses the hitbox centre today and 3 of 4
  land on transparent pixels (thorn0, thorn1, thorn3), thorn1's additionally shadowed.
  `svg_slice.py` gains a `muzzle: [x,y]` field per thorn — the drawn pixel nearest that
  part's mask centroid — and `to_muzzles()` reads it. Keep the existing "muzzle inside its
  own Rect" assert. **This is an on-chain change** (`tick.rs` spawns from `MUZZLES`), and
  the Rust and TS outputs must ship together or predicted and actual volleys diverge by
  2–6 units and the fight looks like packet loss.

Boxes stay AABB. Fill ratios are poor (thorn1 7.7%, thorn0 12.7%, mace 19.7%) and no
rectangle describes a diagonal spike. Per-column spans are **cut** — see §12.1.

---

## 3. The state contract

**Two changes. Zero bytes added to any account. `LAYOUT_VERSION` stays 1. No migration.**

### 3.1 `Arena`

```rust
// was: pub _pad2: [u8; 4],   offset 1164
/// Tick at which MUSTERING flips to FIGHTING. Claimed out of `_pad2`, the same move
/// `outcome` made out of `_pad0`: no field moves, the account does not grow.
///
/// ZERO means "no muster scheduled" — which is exactly what it means on every account
/// already on chain, in every phase but MUSTERING. No migration is required.
pub fight_at_tick: u32,          // offset 1164
```

`size_of::<Arena>()` stays **1200**. Every `offset_of!` assertion in `state.rs:366-386`
still passes unchanged. **This is the last free `u32` in `Arena`** — `_pad0` (1 B @ 7) and
`_pad1` (2 B @ 38) remain, and anything wider must append past `next_affix_seed`, which
grows a delegated account. Spend it here and nowhere else.

### 3.2 New constants, no bytes

```rust
pub const PHASE_MUSTERING: u8 = 6;                    // state.rs
pub const MUSTER_TICKS: u32 = ticks_for(20_000);      // 200 ticks = 20 s
pub const ENRAGE_TICKS: u32 = ticks_for(360_000);     // 3600 — MOVED from init.rs
pub const BOSS_CORE_HP: u16 = 2_000;                  // MOVED from init.rs (tick.rs needs it)
pub const CORE_HP_PER_RAIDER: u16 = 3_000;
```

`TICK_ITERATIONS` is **derived**, never carried forward as a literal:
`(MUSTER_TICKS + ENRAGE_TICKS) * 5 / 4 = 4750`. The muster spends crank iterations that
used to belong to the fight, and the crank **cannot be topped up** — `ScheduleTask` needs a
writable signer and a scheduled instruction carries none. Getting this wrong is a raid that
goes inert mid-fight.

Const-assert: `BOSS_CORE_HP + CORE_HP_PER_RAIDER * 19 = 59,000 ≤ u16::MAX`.

### 3.3 Unchanged, and deliberately so

| account | size | why nothing was added |
|---|---|---|
| `Boss` | 50 B, offsets 0,1,2,3,4,5,6,8,10,12,14,32 | **Literally no padding left.** Any new field grows a delegated account. The slam (§5.3) and every telegraph (§7) are derived precisely because of this. |
| `PlayerSlot` | 96 B, `_pad0` @ 3 free | No `aim` byte. A 120 ms tracer's exact angle is unmeasurable; `facing` already replicates. |
| `Bullet` | 8 B, `_pad0` @ 7 free | Hazards cut (§12.2). `_pad0` stays free — it is the upgrade path, not this slice. |
| `Players` | — | Not split. Measured: zero latency to win (§9.4). |

### 3.4 Wire ABI

`shoot` instruction data goes `[tag, dir:u8]` → `[tag, dx:i8, dy:i8]`, 3 B → 4 B (§4.1).
That is an *instruction* change, not an account layout change, so `LAYOUT_VERSION` is
untouched. An old client sending 3 bytes gets a clean length refusal. **The program and the
app must ship together.** Update `docs/architecture/05-wire-abi.md` in the same commit.

---

## 4. Movement and shooting

### 4.1 Free aim — the measurement that forces it

`shoot.rs::raycast` was replayed verbatim over 110 pit stands × every aim direction, walls
ignored so the number isolates aim resolution:

| aim model | reach | stands that can hit anything | targets ever reachable |
|---|---|---|---|
| 8-way (shipped) | 320 u | 37/110 (33.6%) | 5/10, **core never** |
| 8-way | 1024 u | 75/110 (68.2%) | 5/10, **core never** |
| 16-way | 1024 u | 109/110 | 7/10 |
| i8 pair | 1024 u | **110/110** | **9/10 + core** |

Ship a top-centre boss on 8-way aim and **the raid is unwinnable with no error anywhere.**
Angular sizes from 800 u below: shell 16.1°, core 2.9°, thorn2 1.4°. The 8-way step is 45°.

**Decision: free aim.** `(dx: i8, dy: i8)` raw from the client, normalised on chain with the
alpha-max-plus-beta-min routine `tick.rs::unit_velocity` already carries. Zero account
bytes, no table, no fifth generator. Measured over 200,000 angles end to end: max direction
error **0.2354°**, lateral miss at the worst-case 865 u range 3.55 units = 0.22 tiles, step
length 0.894–1.000 × TILE.

- `MAX_RAY_STEPS`: **20 → `map::MAP_TILES` (64)**, derived from the map. Non-negotiable at
  S=3: the crown's top is at world y=16 and the pit floor at 575, so 559 units of range are
  needed and 20 steps reach 320.
- Add a compile-time **shell-AABB gate** folded from the generated `PART_HITBOXES` before
  the nine-rect scan. Measured over 107,520 rays: 32.1 steps mean / 64 worst, 0.32 nine-rect
  scans mean / 13 worst, worst shot ≈ 260 integer ops. Without the gate the worst case is
  576 rect tests instead of 117.
- `unit_velocity`: **round instead of truncate.** Angular error 5.07° → 2.95°, zero bytes.
  (`state.rs`'s docstring already claims "~2.4 degrees" and describes a rounding normaliser
  that was never written.)
- `player.rs::octant`: replace the `signum` body with integer nearest-of-eight
  (`5/12 ≈ tan 22.5°`). Verified: identical on all 8 unit vectors, rejects (0,0), 0/3600
  disagreements with the true nearest octant. **Its existing test must pass UNMODIFIED** —
  if a reviewer lets that test be edited, the guarantee is gone. `shoot` uses it to stamp
  `facing` from `(dx,dy)` so remote sprites face the shot.
- `facing` stays a `u8` 0..7 and stays a **horizontal flip only** in the renderer. The
  knight art has one pose; a flip cannot express NE vs SE and hitscan can.
- A miss still spends the cooldown. Refunding on a miss hands an attacker an
  unlimited-rate instruction.

### 4.2 Movement

Unchanged: `MOVE_STEP` = one 16-unit tile, one accepted move per 50 ms ER slot = 320 u/s
cardinal. The rate limiter *is* `last_move_tick`; ER fees are zero, so a wall-clock cooldown
would pay out to the lowest ping.

**Movement is also the coarse aiming mechanic.** Crossing the 681-unit boss takes 2.1 s.
Free aim picks the limb; walking picks the lane.

### 4.3 Pool

`MAX_BULLETS = 128` **holds unchanged**, 1.86× headroom at 1,100 u travel. Add the const
assert that actually proves it — the shipped one only proves one volley fits, not
overlapping ones: `lifetime = ceil(travel / BULLET_SPEED)`,
`volleys_in_flight = ceil(lifetime / VOLLEY_INTERVAL_TICKS)`, `peak = that × 23 ≤ 128`.

---

## 5. The boss

### 5.1 Volley — kept, one number changed

Aimed at the nearest live player from every live muzzle, `3 + alive_count` bullets,
`VOLLEY_INTERVAL_TICKS = ticks_for(3_200) = 32` (the real period is 33 ticks: it fires on
the tick it reads 0, then reloads). A destroyed thorn silences its emitter — already true,
and now readable, because the thorns are the four cheapest parts and the player can see
which gun they killed.

**`BULLET_UNITS_PER_SEC: 120 → 420.`** Players move 320 u/s and bullets 120 u/s, so today a
player running in a straight line **can never be hit by an aimed volley** — movement
currently costs nothing. 420 u/s = 42 units/tick, inside the `i8` ceiling of 127, ratio to
player 1.31, muzzle-to-pit flight 0.42–0.68 s. Swept collision already decouples speed from
tunnelling, so nothing else moves.

Legibility constraint this creates: a 4-unit dot jumping ~7 units per frame strobes. The
renderer must draw a **velocity-stretched trail**, or 420 will look worse than 120 despite
being correct. The hit is right either way.

### 5.2 What is *not* added

No named multi-phase rotations (they need a phase byte on `Boss` and `Boss` has no padding
left). No downed-player orbs and no revive instruction. No stack-damage-share — the vent
column produces the stack as behaviour, with no feature (§5.5). No AoE-carry.

### 5.3 Hand slam — one mechanic, zero bytes

The pit needs positional pressure that is not a projectile. Exactly one attack is added and
it stores **nothing**: both the chain and every client compute it as a pure function of
`(affix_seed, tick)`, the same pattern the bullet spread already uses.

```rust
const SLAM_PERIOD_TICKS: u32    = crate::state::ticks_for(6_000);  // 60
const SLAM_TELEGRAPH_TICKS: u32 = crate::state::ticks_for(1_500);  // 15
const SLAM_DAMAGE: u16          = 45;
const SLAM_LANE_W: i32          = 128;                             // 8 tiles, x ∈ [128L, 128L+128)
```

- Resolve when `tick % SLAM_PERIOD_TICKS == 0`.
  Telegraph while `tick % SLAM_PERIOD_TICKS >= SLAM_PERIOD_TICKS - SLAM_TELEGRAPH_TICKS`.
  No beat counter, no new field. `heartbeat` advances `tick` in every phase but `step` runs
  only while FIGHTING, so this is correct during a fight and inert outside one.
- `r = mix64(le_u64(&affix_seed[..8]) ^ mix64((tick / SLAM_PERIOD_TICKS) as u64))`
- `vent_open == 0`:
  `limb = if r & 1 == 0 { 7 mace } else { 8 claws }`; if `boss.parts[limb] == 0`, **no slam
  this cycle** (the same gate `spawn_volley` already uses on muzzles);
  `lane = mace ? 1 + (r>>1) % 3 : 5 + (r>>1) % 2` — lanes 1..3 sit under the mace's
  x 170..502, lanes 5..6 under the claws' x 677..832.
- `vent_open == 1`: `lane = 4` (x 512..640) unconditionally — the torso lunges over the
  exposed vent, whichever limbs survive.
- On resolve, every `ZONE_ARENA` player with `hp != 0` whose x is in the lane takes
  `SLAM_DAMAGE`, **stamping `respawn_at_tick` / incrementing `deaths` / decrementing
  `alive_count` on the same lines the bullet death already uses.** Reuse that bookkeeping or
  a slam death is invisible to the win/wipe check.

Why 1,500 ms: the worst latency this project has ever measured on any path is 1,126 ms.
1.5 s × 320 u/s = 480 units = 3.75 lane widths of escape, so the slam is always dodgeable.
`45 × 2 = 90 < 100 hp_max`, so two slams do not quite kill but a slam plus a volley does.
It is a mechanic check, not a damage check.

**This is the core loop: the column you must stand in to damage a limb is the column that
limb slams.** And because it is derived, it adds **zero** notification traffic on top of a
`Players` stream that is already 68.4% no-op and delivered twice.

### 5.4 Difficulty scales on `core_hp`, never on `parts`

Measured TTK today (`SHOT_DAMAGE=40`, one shot per `ticks_for(800)` = 8 ticks = 50 dmg/s
per player, shell 18,000, vent at 11,700, core 2,000) against a 360 s enrage window:

| players | 1 | 4 | 8 | 20 |
|---|---|---|---|---|
| TTK today | 307 s | 77 s | 38 s | **15 s** |

A 20× spread, against a volley that scales 5.75×. The founding requirement is inverted.

**Four lines in the tick stage that already counts `arena_occupants`:**

```rust
let required = BOSS_CORE_HP
    .saturating_add(CORE_HP_PER_RAIDER.saturating_mul(arena_occupants.max(1) - 1));
if boss.core_hp_max < required {
    let d = required - boss.core_hp_max;
    boss.core_hp_max += d;
    boss.core_hp += d;
}
```

| players | 1 | 2 | 5 | 10 | 20 |
|---|---|---|---|---|---|
| TTK with top-up | 274 s | 167 s | 103 s | 81 s | **71 s** |

The 20× spread becomes 3.9× and **solo stays winnable**, which matters because a devnet
demo is usually one or two people. `core_hp_max` *is* the high-water record, so there is no
snapshot and no new field; it is monotone so it cannot be gamed by dying or leaving; it
tolerates late entry; and it is orthogonal to incarnation scaling, which writes `parts`.
`vent_open` is untouched because its threshold is a ratio over `parts`.

**Do not scale `parts` by raid size.** `u16` saturation already caps the crown at
incarnation 41; a raid multiplier collapses that to incarnation ~2 at twenty players. The
flat ×4 shell scale is **cut** (§12.3).

### 5.5 How the fight reads

Simulated over all 718 pit tiles, full shell:

- **The hands shadow everything.** mace claims 42% of pit-direction pairs, claws 22%,
  core 9%, everything else ≤ 3%.
- Kill the mace → claws 22%, core 13%, thorn2/wolf_l 9% each. Kill both hands → the inner
  shell opens: core 16%, beast_r / wolf_l / thorn2 9%, thorn3 7%.
- The crown, highest HP, is reachable from 1–2% of pairs while the hands stand, and once
  they fall only from the front half of the pit. **The head is the far target you advance
  for**, and dying costs you that position: respawn drops you at an `E` mark in the back
  rows. That is 33 Immortals' "come back weaker" with no revive instruction.
- Shell stripped: **426/718 pit tiles have no target at all** and the only live one is a
  120-unit column. Twenty players must crowd x 527..647 to finish it — the stack mechanic,
  emergent from geometry, with no stack feature. And §5.3's vent branch slams exactly that
  column every 6 s, so the climax is dive-out / dive-back-in.
- While sealed, a ray reaching the core returns `Hit::Core` and `fire()` refuses it. "Shoot
  the limbs, not the chest" is an on-chain fact, not advice.

---

## 6. The phase machine

```
                begin_muster (tag 3)          boss_tick @ fight_at_tick
       LOBBY ──────────────────────► MUSTERING ────────────────────────► FIGHTING
         ▲                               │                                 │
         │                               │ boss_tick, dead-crank recovery   │
         │                               ▼                                 ▼
         └──────────────────────────  SETTLED ◄──────────────────  SETTLING ⇄ ROLLING ─► ROLLED ─► SETTLED
```

`PHASE_MUSTERING = 6`, appended after `PHASE_ROLLED` so 0..=5 keep their meaning. The
`PHASES` array in the exhaustive edge test grows to 7, and its 7×7 product must still
report exactly `PHASE_EDGES.len()` legal pairs.

| from | to | trigger |
|---|---|---|
| LOBBY | MUSTERING | tag 3 `begin_muster` |
| MUSTERING | FIGHTING | tag 8 `boss_tick`, at `fight_at_tick` |
| MUSTERING | SETTLED | tag 8, dead-crank recovery |
| FIGHTING | SETTLING | tag 8 / `settle` |
| FIGHTING | SETTLED | tag 8 |
| SETTLING | ROLLING | VRF request |
| SETTLING | SETTLED | — |
| ROLLING | ROLLED | VRF callback |
| ROLLING | SETTLING | `ROLL_TIMEOUT_TICKS` |
| ROLLED | SETTLED | — |
| SETTLED | SETTLED | idempotent |
| SETTLED | LOBBY | `begin_next_incarnation` |

**`LOBBY → FIGHTING` is removed.**

### 6.1 The rule, in one sentence

*The first knight through the gate opens a fixed-length muster window; the chain's own crank
ends it.*

1. **Tag 3 keeps its ABI**, renamed `begin_muster`. It refuses if no seat is in
   `ZONE_ARENA` (`HeartrotError::NoRaiders = 19`), sets
   `fight_at_tick = tick + MUSTER_TICKS`, and schedules the crank exactly as today.
   Today `matchStart` reads no `Players` account at all, so **a raid can currently be armed
   with nobody through the gate**: `best_seat == NO_TARGET`, no volley ever spawns, six
   minutes of an empty room, `OUTCOME_ENRAGE`. This refusal makes that unrepresentable.
2. **`heartbeat` gains a `MUSTERING` branch** shaped like the existing `PHASE_ROLLING` one,
   calling a new total `Arena::begin_fight()` which flips at the deadline and stamps
   `enrage_at_tick = tick + ENRAGE_TICKS`. `step` does **not** run on the flip tick.
3. `assert_playable` gains `PHASE_MUSTERING` — one line, covering join / move / enter_gate.
   `shoot` needs no change: it tests `== PHASE_FIGHTING`, so weapons stay down through the
   muster for free.
4. `enrage_at_tick` becomes **match state, not creation state**: `init` stops writing it
   (the `!= 0` guard in `tick.rs` already handles 0) and `begin_next_incarnation` zeroes it.
   Otherwise the muster silently shortens every fight by its own length.
5. `write_leaderboard` gains an `outcome == OUTCOME_UNDECIDED → refuse` guard, now
   reachable via `MUSTERING → SETTLED`.
6. **The four `GATE_*` constants move out of `player.rs` into generated `map.rs`.** Today
   they are hand literals that `gen_map.py` parses back out of the Rust — one fact stored
   twice, and the reason the gate block currently *contains* `BOSS_SPAWN`. Generating them
   lets a const-assert prove `BOSS_SPAWN ∉ gate` on every `cargo check`, and **deletes** the
   read-back parsing from the tool.

### 6.2 Why no quorum, no host, no ready-check

A quorum needs a deadline anyway, for when the Nth player never arrives — so the deadline
alone is sufficient and the quorum buys nothing. A host can disconnect. `enter_gate` already
records commitment permanently. A solo player cannot start instantly: they must wait out a
public window with the gate open. And a raid **can never fail to start**, because the crank
ends the window whether or not anyone came.

`MUSTER_TICKS = 200` is the one number here with no derivation behind it — it is a guess at
how long a player will stand still. It is a single `ticks_for()` call in one place. If
fixed-length turns out wrong in principle, the escape hatch is a monotone-decreasing clamp
inside the same handler (`fight_at_tick = min(fight_at_tick, tick + LOCK_TICKS)`), which
cannot be pumped.

### 6.3 Client

- **Delete the "Wake it up" button** (`Hud.tsx:196`). The gate *is* the interaction. The
  client auto-POSTs `/api/match/start` the first time it sees its own zone flip with phase
  LOBBY; 19 of 20 get the existing 409.
- Gate glow keys off `predictor.self`, **not** the chain — 127 ms would read as input lag on
  the one interaction the lobby is built around. The `enter_gate` **transaction** stays on
  the existing 500 ms authoritative poll. These two must not be merged: the version that
  fired `enter_gate` from the input callback stranded players permanently.
- Countdown = `(fight_at_tick - tick) * TICK_MS`, smoothed with the existing `tickAlpha`,
  selecting two integers and flooring to seconds.
- The camera pan and the darkening are driven by the **deadline**, never by the phase
  notification, so they end when the fight starts on every client.
- Delete `subscribe.ts`'s `fightingAt` anchor (obsolete once `tick` advances before
  FIGHTING) and extend the watchdog to cover MUSTERING.
- `Hud.tsx:229` and `:348` both default `tickMs ?? 400` on a 100 ms chain. Fix.
- `Lobby.tsx:6,11,59` tells players "enough of you standing on it starts the raid" — false
  today, true after this. Leave the copy, land the behaviour.

---

## 7. The animation contract

### 7.1 Three classes, not two

Beyond *derived* and *cosmetic* there is a third that carries most of this scene:

**SEEKED.** Every wind-up, telegraph and countdown here is a chain field counting
monotonically to a deadline — `attack_timer`, `respawn_at_tick`, `fight_at_tick`,
`tick` vs `enrage_at_tick`, `tick % SLAM_PERIOD_TICKS`. Build **one** CSS/WAAPI animation at
its true duration and set `animation.currentTime` from the chain value on each notification.
It runs composited at 60 fps between notifications, self-corrects on each one, and needs no
rAF callback.

This leaves the rAF loop in `Arena.tsx` owning exactly what it owns today — bullet
extrapolation and the local-seat chase — and **nothing may be added to it.**

### 7.2 The prediction/interpolation split is untouchable

The local player renders from **prediction** (`predictor.self`, chased at one tile per move
period in the rAF loop); every remote seat renders from **interpolation**. That split is
what fixed the fight-time stutter, measured 200 → 52 static frames. Do not regress it.

### 7.3 One writer per node — mechanical, not a discipline

Measured: a node carrying inline `translate(100px,0)` **plus** a WAAPI `translateY`
animation renders at x = 8.0 — the inline write is **silently discarded**, while
`el.style.transform` still reads back `translate(100px, 0px)`. Two nested nodes, one writer
each: x = 108.0, both compose.

Every animated object is therefore a nested stack of single-purpose nodes:

| object | node stack, outermost first | writer |
|---|---|---|
| camera | `#camera` | WAAPI pan only |
| boss | `#boss-pos` (translate to `Boss.x/y`) → `#boss-breathe` → `#boss-shell` → 13 part `<g>` | React attr / CSS keyframes / React per snapshot / WAAPI one-shots |
| seat | seat `<g>` (position) → child `<use>` (flip, bob, recoil) | rAF or `useSeatInterpolation` / the animation driver |
| bullet | `<rect>` | rAF only |

SVG `transform-box` defaults to `view-box` with origin `0px 0px`. Measured: a `<g>` rotated
90° with defaults lands at x = −30 (off-canvas); with
`transform-box: fill-box; transform-origin: center` it lands at x = 165. Every part-local
rotate or scale needs those two properties or it flings the limb across the arena.

**SMIL is forbidden.** It is catastrophic by default, its timeline cannot be seeked
per-element (which kills the SEEKED class), and authoring it means hand-editing generated
asset files.

### 7.4 The duplicate-proof trigger: diff, never count

68.4% of `Players` notifications during a fight carry no position change, and the Magic
Router delivers every notification **twice**.

**Rule: every trigger is a value diff against the last consumed payload.** A duplicate
payload is byte-identical, so it diffs to nothing — idempotence by construction, with no
bookkeeping. Nothing anywhere counts notifications.

| motion | trigger | class |
|---|---|---|
| walk frame | `(Σ|Δx|+|Δy|) / MAP_TILE & 3` — one frame per tile stepped | derived |
| facing flip | `slot.facing` | derived |
| shoot recoil | `last_shot_tick` **increases** (works for remote seats, which a local "I sent a tx" signal cannot) | event |
| hit flash | `hp` **decreases** | event |
| death fall | `deaths` **increments** (the event; `hp == 0` is the state) | event |
| respawn countdown | `respawn_at_tick - arena.tick` | seeked |
| part destruction | `parts[i]` reaches 0 | event |
| damage flinch | `parts[i]` **decreases** | event |
| vent open | `vent_open` | fact (a boolean state, not a duration) |
| volley telegraph | `attack_timer`, `target_seat`, `affix_seed`, `tick`, `parts` — `spawn_volley` is a pure function of published state, so the client draws the **exact** incoming bullet lines | derived |
| slam telegraph | `tick % SLAM_PERIOD_TICKS` + the §5.3 mix | derived |
| enrage | `arena.tick >= enrage_at_tick`, never a wall-clock 6 minutes | seeked |
| muster countdown | `fight_at_tick - tick` | seeked |
| death sequence | one `animate()` sized to `VOLLEY_INTERVAL_TICKS × TICK_MS` (SETTLING has no bounded on-chain duration) | cosmetic, chain-derived length |

Two constraints:

1. A **`synced` gate** suppresses exactly one payload after health returns to `live`,
   because a reconnect leaves `prev` up to 1,681 ms stale. Five lines. That is the only
   bookkeeping this contract needs — the latch registry is **cut** (§12.6).
2. **SEEKED animations dedupe on value change, never on arrival.** Re-seeking on a duplicate
   that lands 20 ms later rewinds the wind-up by 20 ms, twice a second.

One-shots play via `Element.animate()` so they auto-promote, self-clean, and stack instead
of fighting over one `style.transform`. The **resting** appearance stays a React attribute,
so a reload with no animation is still correct.

### 7.5 What must never go on chain

Written as prohibitions, because each is a byte someone will try to add:

- No animation clock, phase, frame index or is-playing flag. Twenty players do not need to
  agree which frame of a breathing loop they are on, and it would make everyone wait 127 ms
  to breathe.
- No `is_moving` / `is_walking`. Derivable from a position delta the client already holds on
  both the predicted and interpolated paths, and a chain flag arrives one round trip after
  the movement it describes.
- No screen-shake, hit-stop or camera field. Per client, per accessibility setting.
- No damage-event log. `parts[i]` decreasing already says a hit landed.
- No `DESCENT_MS` or any animation duration.
- No animation-complete acknowledgement. Nothing waits for a picture to finish.

Where an animation's length must match a game duration it derives from the mirrored chain
constant. A hand-typed `3200` in a keyframe stops matching the volley the first time anyone
tunes balance.

### 7.6 Reduced motion

One JS resolver (`usePrefersReducedMotion`, exported); CSS gates itself in CSS beside the
rules it cancels. Cancel **by not starting**, never `animation-duration: 0.01ms`.

Off unconditionally: screen shake (the only genuinely vestibular effect), camera drift,
parallax, breathing, gait, pulses, particles. The camera **pan** becomes a cut.
Destruction / hit / vent keep a ≤150 ms opacity or colour transition, no translate, scale or
rotate. **Telegraphs are kept and must be**, rendered as a filling shape rather than an
approaching object.

Governing rule: **no information may exist only in motion.**

---

## 8. The art

### 8.1 Temple — inline, unmodified, graded in CSS

`temple.svg` is 16 `<path>` elements holding 22,195 rect subpaths: one path per colour,
100.0% coverage, 0 overlap, 0 transparency. A paletted bitmap in vector clothing.

**Inline it as-is.** Two independent harnesses measured that rasterising it buys nothing:
0.30 ms (inside the 0.3 ms between-session drift, so it must not be used to justify work)
in one, a 5–8% gap that swapped ordering between runs in the other. And the all-raster
variant *builds* in 127.2 ms against 46.3 ms inline.

Mount it in `useMemo(..., [])`, in its own `<g>` under `#camera`, with **no state-derived
props**. React must never touch it per frame or per notification.

Grade it with **one CSS `filter` plus a five-stop gradient overlay** on that static
promoted layer. Measured free: `filter: brightness()` on the background is 1.6 ms against
1.7 ms static, and the whole gradient stack is inside the noise.

The palette runs L 18.2 → 113.8 with **no highlight** — the reference's rim light and cyan
orb must be *added*, not extracted. Only 4 of 16 entries carry sat > 15 (the dead tree,
6.4%); the other 12 are neutrals that shift cleanly. The hard output constraint, solved from
a WCAG sweep rather than chosen: **keep the lit pit inside L 28–75**, which is what
`#3d4a5a` as the ramp ceiling produces and what keeps ally contrast above 4:1.

`tools/gen_temple.py` and the PNG are **cut** (§12.4). Legibility of dead players is covered
by the knight art's own 19%-of-pixels dark keyline, not by the background grade.

**Do not hide the walls the chain raycasts.** The temple replaces the floor fill, not
`MAP_GRID`. A legal-looking move the chain rejects reads as lag — this project's signature
misdiagnosis.

### 8.2 Knights — half resolution, three skins, zero chain change

- Exactly 3 knights in the sheet, exactly `SKIN_COUNT = 3` in the worker, and
  `skin_id` (u8, `PlayerSlot` offset 2) already exists end to end: chain, wire, decode,
  worker validation, `CharacterSelect`. **Cost to add: zero.** Map left-to-right:
  0 Cobalt (blue crest, kite shield), 1 Nocturne (black mantle, sword), 2 Argent (silver,
  round shield). Rename the Cobalt/Ember/Moss table — Ember and Moss describe colours the
  art does not have.
- **`SKINS[skinId] ?? SKINS[0]` is mandatory.** `player.rs` stores `data[1]` verbatim; only
  the worker range-checks it, and a session key can sign `join` directly against the ER. An
  unclamped lookup throws inside the render of all twenty seats, not just the bad one.
- **Half resolution**, on a shared 33 × 42 odd-width canvas anchored at (−16, −21). At 1:1
  the drawn body is 2.11× the 24-unit chain hit diameter; at half it is 1.06×. The source is
  provably native 1× (56% of horizontal runs are 1 px; 24.7% of best-aligned 2×2 blocks are
  non-uniform), so this is a deliberate lossy trade, verified by eye at 8×. The fallback,
  full-res, would need `PLAYER_HIT_RADIUS` 12 → ~25 in `tick.rs` and would rebalance every
  bullet in the game.
- 5 pre-baked pose `<g>`s per skin in `<defs>`, drawn as `<use>`: rest, contactL, contactR,
  fallen (lossless 90° transpose), sil. The walk pass-frame is `rest` + `translate(0,-1)`,
  not a symbol. ~65 KB of defs total. `<use>` is **neutral to raster cost** and wins on DOM
  elements (744 → 329), which is parse and memory.
- **Crop the caption strip by ROW RANGE (130..139), not by colour.** `#ffffff`/`#fdffff` are
  also 185 px of specular highlight inside the knights, and inlining the sheet whole paints
  a cream rectangle over the arena. This is the single most likely way to misread this spec.
- Walk cadence: one frame per tile stepped, so it retimes itself if movement speed is ever
  tuned, and a standing knight freezes by construction. **Reset** (not add) the accumulator
  when `|dx|+|dy| > SELF_SNAP` so a respawn teleport does not spin the legs. Diagonal
  Manhattan is 1.375× fast; divide the diagonal contribution by 1.414 if it reads wrong.
  That is the only fudge factor in this document.
- Crowd: sort seats ascending by authoritative `slot.y`, **in React render at notification
  rate, not per frame**. Find the local player with a chevron at local y = −30 — it must
  work when fully occluded — plus a ground ring at y = +20. Do **not** draw the local knight
  out of y-order. HP bar only when `hp < hp_max`.

### 8.3 Boss rig

`assets/sprites/parts/boss.svg` is the file the renderer loads — it is the only one with 13
named `<g id="part-*">` groups. `boss.svg`, `temple.svg` and `knights.svg` are one path per
colour and are **not riggable**.

- `ground` (9,844 px of `#2c3436`, rows 216–269, fully opaque) draws a solid dark rectangle
  across the arena if rendered. **Crop to rows 0..215** or give it `display: none`.
- Insert the **pit-rim occluder** between z=8 (legs) and z=9 (mace). Every part it hides
  (`ground`, `legs`) has `index: null`, so no hitbox moves and the whole top-centre
  composition costs zero on-chain change beyond `BOSS_SPAWN`. If the rim is opaque, give the
  occluded groups `display: none` — the browser still rasterises geometry it then covers.
- Move the bullet layer **beneath** the boss group so muzzle-flash bullets are hidden by the
  silhouette for their first frames.
- Eyes: two near-white 2×2 blocks at sprite (137,81) and (144,81), 7 px apart, symmetric
  about x ≈ 141.5. Drawn as glow circles at those coordinates converted through
  `BOSS_ANCHOR_*`. This is an inference from 8 pixels; cheap to verify on first render,
  cheap to move.

---

## 9. The performance verdict

**This section overrules ambition from §8.** `docs/perf/render-scale.md` is authoritative on
frame time: real headed Chrome 151 on a real GPU and compositor, real vsync, 400 kept frames
× 5 reps, **a fresh browser per case**, screenshot-verified before any number was trusted.

### 9.1 The headroom

At 20 knights, full art, 128 bullets, **6× CPU throttle**: 6.40 ms p50 / **7.60 ms p95**
against a 16.7 ms budget = **2.2× headroom**. 33 knights fits too (8.10 ms p95).

Attribution at that point (σ ≤ 0.11):

| scene | ms |
|---|---|
| today's renderer, no art, 128 bullets | 4.00 |
| full art + 128 bullets | 6.40 |
| full art + **0** bullets | 3.20 |

**All the new art costs +2.40 ms. The 128 bullets that already ship cost +3.20 ms.**

### 9.2 The hard prohibitions

1. **Never animate the `viewBox` attribute** — 9.6 ms/frame, p95 14.2, 5.3× (§1.4).
2. **Never rebuild the background by `innerHTML`** — 11.2 ms, and it **crashed the renderer
   process 3/3 times** at 300 frames. It only completed at 120.
3. The background is built once in `useMemo([])` and is never touched by React or the frame
   loop.
4. **Every node the frame loop or an animation writes must be composited.** Holding
   compositing constant, the spread between SMIL, CSS and rAF is under 2×; the spread
   *within* a technique between promoted and unpromoted is 30–85×. This is the whole game.
   The boss rig at S=3 covers ~95% of the frame area, so its 13 part groups must be promoted
   or nothing else in this document matters.
5. `Arena.tsx:326`, the seat `<g>`, **has no `will-change: transform`** while the bullet
   rects at `:398` do. Add it. Two harnesses disagree on the payoff — headed/GPU measured
   7.10 vs 7.20 ms (no effect), headless/software raster measured 36×–85× — so it is one
   free line that helps exactly the weak devices neither of us tested, and it is recorded
   here as measuring like a no-op on a real GPU so nobody chases it again.

### 9.3 The one lever, if p95 crosses ~12 ms

**Cap VISIBLE bullets 128 → 32.** Worth 2.40 ms — more than rasterising every asset in the
game combined (all-raster: 1.30 ms, and +81 ms of build). CSS containment measured
**0.00 ms**; do not bother.

**Cap drawing, never simulation.** `MAX_BULLETS = 128` is chain state and
`bullets_per_volley = 3 + alive_count` is chain logic; capping either on the client makes it
disagree with the crank about what is on the board.

Second lever, if that is not enough: `gen_hitboxes.py --scale 2` (§1.2).

### 9.4 The answer to "can movement be smoother when multiple people play?"

**The chain is flat, and there is nothing there to win.** Four controlled devnet runs,
seat counts in a palindrome so ISP drift cancels, 60,953 sends, zero failures:
write-to-visible p50 **135 ms at 1 seat and 132 ms at 20** at the app's real 50 ms cadence.
The 1-seat rows are the *slowest* in both runs. 342 accepted moves/s all writing the same
`Players` account do not serialise.

What degrades is the **feed**: 1,636 KB/s and **714 account notifications/s** at 20 seats,
which is 12 React store updates per displayed 60 fps frame.

**Ship this, and only this:** drop byte-identical frames in `app/src/net/subscribe.ts`
before they reach the store. At 20 seats it removes 342 of 352 Arena frames/s and halves
store updates from 714/s to 372/s. Three constraints:

- (a) compare the **base64 payload string**, per account kind, against that kind's previous
  payload, **before the decoder runs**, so the dedupe also saves the 6.87 µs decode;
- (b) **reset the cache on every socket `open`.** The snapshot-on-open is the most
  load-bearing line in that file and must never be suppressed by a payload cached from
  before a disconnect;
- (c) a duplicate must still count as **liveness** — dedupe the delivery, not the "kinds
  that have received a live notification since open" bookkeeping.

It saves zero bandwidth; the bytes have already arrived. It buys CPU and render churn. It
gets *better* in a fight, where the duplicate rate is higher than the 4.4–7.2% measured in
the lobby.

Honest limit: the React re-render cost is a **traced mechanism with a measured rate, not a
measured cost**. 714 notifications/s is measured; what those renders cost the frame budget
is not. The dedupe is safe to ship anyway because it cannot cost anything, but its benefit
is inferred.

**Do not** change the Arena account role (measured twice: no effect on notifications, no
effect on p50, slightly worse tail). **Do not** split `Players` (§12.12).

---

## 10. Implementation order

Each step leaves the tree green. Verify with the documented build block and read the
**first** `test result` line.

1. `tools/svg_slice.py`: renumber `index:` so thorns are 0..3 and crown/wolf_l/beast_r/mace/
   claws are 4..8; add `muzzle: [x,y]` per thorn. Re-run.
2. `tools/gen_hitboxes.py`: add `--scale` (default 3) so `PART_HITBOXES`, `CORE_*`,
   `MUZZLES` and `ANCHOR_*` scale in one pass; read `muzzle:` in `to_muzzles()`; add the
   assert that every `P` row of `assets/map/arena.json` can reach at least one part within
   `MAX_RAY_STEPS`. Re-run; `--check` must exit 0. **Never hand-edit `hitboxes.rs`/`.ts`.**
3. `init.rs`: reorder `BOSS_PARTS_BASE` to follow the names in §2. Move `BOSS_CORE_HP` and
   `ENRAGE_AT_TICK` to `state.rs`.
4. `assets/map/arena.json`: redraw per §1.1; add `P` and `G` to the legend.
   `tools/gen_map.py`: emit `PIT_TOP`, `PIT_BOT`, `GATE_MIN_X/MAX_X/MIN_Y/MAX_Y` (Rust and
   TS in one pass); **delete** the `player.rs` read-back; add the const-assert
   `BOSS_SPAWN ∉ gate`. Re-run.
5. `player.rs`: delete the four `GATE_*` literals and import from `map`; add the
   `PIT_TOP..=PIT_BOT` clamp for `ZONE_ARENA`; replace `octant`'s body with nearest-of-eight
   (its existing test unmodified).
6. `state.rs`: `PHASE_MUSTERING`, `fight_at_tick` from `_pad2`, the `PHASES` array,
   `PHASE_EDGES`, `MUSTER_TICKS`, `CORE_HP_PER_RAIDER`, `begin_fight()`.
7. `tick.rs`: the `MUSTERING` branch in `heartbeat`; `BULLET_UNITS_PER_SEC` 420; the slam
   (§5.3, reusing the bullet loop's death bookkeeping); the `core_hp` top-up (§5.4). Fix the
   three stale comments (`BULLET_SPEED 48`, "every 8 ticks", `TICK_ITERATIONS` headroom).
8. `shoot.rs`: free aim, `MAX_RAY_STEPS = map::MAP_TILES`, the shell-AABB gate,
   round-not-truncate, the overlapping-volley pool assert.
9. `packages/client`: `instructions.ts` shoot 3 B → 4 B; `layout.ts:78` roll timeout
   `25` → derived from the mirrored `ticks_for(10_000)`; regenerate `map.ts` / `hitboxes.ts`.
   Update `docs/architecture/05-wire-abi.md`.
10. Client render: `subscribe.ts` dedupe (§9.4); `sprites.ts` replaced by the generated
    knight defs + the boss rig + the inline temple; `Arena.tsx` camera `<g>`,
    `will-change` on seats, the §7 node stacks, the `shape-rendering` switch.
    `tools/gen_knights.py` → `app/src/render/knights.gen.ts`, reusing `svg_slice.parse` /
    `rasterize` and `px2svg.merge_rects` / `mode_downsample`, with a hand-authored
    bbox + leg-band table the tool **verifies** (assert the declared bboxes equal the
    components found at run time; assert every band row splits into exactly two runs).
11. `worker/src/routes.ts`: `matchStart` → `begin_muster` semantics; `Hud.tsx` delete the
    "Wake it up" button and the two `?? 400` defaults.

Steps 1–3 and 4–5 are each one commit; do not mix a generator re-run with a hand edit in the
same commit or the diff stops being reviewable.

---

## 11. Checks to leave behind

1. `gen_map.py::validate` PASS on the new grid (already run — §1.1).
2. `gen_hitboxes.py --check` exit 0 after the scale and muzzle changes.
3. Const-assert: `BOSS_SPAWN` on floor **and** outside the gate box.
4. Const-assert: `BOSS_CORE_HP + CORE_HP_PER_RAIDER * 19 ≤ u16::MAX`.
5. Const-assert: `peak_bullets_in_flight ≤ MAX_BULLETS` across overlapping volleys.
6. Unit test: for every pit column, a `ZONE_ARENA` player at `PIT_TOP` cannot step north and
   the tile north of them is **floor**.
7. Unit test: `MUSTERING → FIGHTING` fires exactly at `fight_at_tick`, `step` does not run
   on the flip tick, and `enrage_at_tick` is stamped there.
8. Unit test: `begin_muster` refuses with `NoRaiders` when no seat is `ZONE_ARENA`.
9. Unit test: a slam death stamps `respawn_at_tick`, increments `deaths` and decrements
   `alive_count`, exactly as a bullet death does.
10. `player.rs`'s existing `octant` test, **unmodified**, still passes.
11. First `test result` line reads at least `59 passed`.

---

## 12. What was cut, and why

Fifteen proposals from the input documents are not in this spec.

**12.1 Per-column hitbox spans.** 436 occupied columns = 1,744 bytes of `i16` pairs in the
`.so` against 144 for the AABB table, the program's first **variable-length** generated
array (so the "index-aligned with `N_PARTS` or it stops compiling" guard no longer covers
it), needing a new per-part `(x0, len)` index and a partition const-assert, for a CU claim
that was argued and never measured. It fixes a real number — 43% of AABB part hits are
off-silhouette at S=3 — but the failure mode is *generosity*: a shot near a horn hits the
horn. The bad failure mode, a shot at drawn art registering as the wrong limb, is fixed for
free by the §2 renumbering. **Revisit if** playtesting reports shots at drawn art missing.

**12.2 The four-hazard system** (SLAM / CRUSH / SANCTUARY / RAIN in four reserved bullet
slots, `MAX_BULLETS` → `N_BULLET_SLOTS = 124`, `Bullet._pad0` → `arg`, and the
`b.active !== BULLET_ACTIVE` client guard it forces). It is well designed and it is four
mechanics where one closes the loop. §5.3's lane slam stores **nothing**, derives from state
already published, adds zero notification traffic, and produces the same "the column you
must stand in is the column that slams" pressure. `Bullet._pad0` stays free as the upgrade
path; the client guard becomes necessary the day it is spent, and not before.

**12.3 Flat ×4 boss shell HP** (`[16000,10000,…]`, sum 72,000, core 8,000). It makes solo
and duo raids unwinnable by design, and a devnet demo is usually one or two people — the
first thing a visitor would experience is a loss. The `core_hp` top-up (§5.4) compresses the
20× TTK spread to 3.9× while leaving the solo fight untouched, in four lines and zero bytes.

**12.4 `tools/gen_temple.py`, the 21 KB PNG, the `.scene` wrapper div and the `usePixelFit`
retarget.** Two independent harnesses measured that rasterising the temple buys nothing on
frame time, and the raster path *builds* 2.7× slower. The remaining justification was the
palette grade — which a CSS `filter` plus a gradient overlay delivers for a measured 0.0 ms
on a static promoted layer. This cut removes a whole generator, a binary asset, and a
rewrite of a hook that already carries a known DPR-change gap. **Revisit if** the filter
cannot separate the 4 wood entries from the 12 neutral stone ones.

**12.5 16-way, 64-way and 256-entry brados aim tables.** 1,024 B of `.so` plus a fifth
generator plus a fifth TS mirror to buy 1.406°, where the `i8` pair measures 0.235° for one
wire byte and reuses a normaliser the program already has.

**12.6 The `useLatch` registry** (a bounded ~218-string set keyed on `incarnation`). Every
trigger in this scene is a value diff against the previous payload (§7.4), and a duplicate
payload is byte-identical, so idempotence is free. The only real need was the reconnect
window, which is a five-line `synced` gate.

**12.7 The three-direction arena aim restriction.** Superseded by free aim, which the
reachability measurement makes mandatory (§4.1).

**12.8 Q3 sub-unit bullet velocity.** Zero bytes, and that is exactly what makes it
dangerous: a `Bullet` in Q3 is byte-identical to one in whole units, so it **must** bump
`LAYOUT_VERSION` and ship `layout.ts` and the extrapolator in the same commit or every
bullet draws 8× out. It is written down here only so nobody reaches for `i16` first. Taking
the free half (round instead of truncate, 5.07° → 2.95°) covers the need today.

**12.9 Quorum, host key, ready-check, ready-mask.** A quorum needs a deadline anyway, so the
deadline alone is sufficient (§6.2). And `Arena` has exactly one free `u32`.

**12.10 Downed players as revivable orbs; multi-phase attack rotations; stack-damage-share;
AoE-carry.** Orbs need a new instruction plus a proximity scan, and respawning at the back
of the pit already costs position. Rotations need a phase byte on `Boss`, which has no
padding left. The vent column already produces the stack as behaviour (§5.5).

**12.11 Growing `MAX_BULLETS`, per-seat quotas, bullet lifetime caps.** 128 holds with 1.86×
headroom, and the live instrument saw only 13–15 bullets in flight at 20 seats.

**12.12 Changing the Arena account role; splitting `Players`; per-seat accounts.** Measured
twice: no effect on notifications, no effect on p50, slightly worse tail. The split buys
zero latency, does not reduce the notification *count* that drives render churn, and its
narrow variant is **+6.0% — worse** — because `move` must read `session_pubkey` to
authenticate, so naming a cold account emits a second duplicate notification. If bandwidth
ever becomes binding the order is A (drop Arena from `move`'s account list, −38.6%) then D
(per-seat accounts, −46.4%), and never C. Option A is a **guard decision, not a performance
decision**: `move` names Arena to read `arena.phase` for `assert_playable`, and the arena
address is what re-derives the `Players` PDA in `validate_pair`. Putting phase on `Players`
would be one fact stored twice.

**12.13 The "Wake it up" button** (`Hud.tsx:196`). The gate is the interaction (§6.3).

**12.14 Bounded lives / making `OUTCOME_WIPE` reachable.** It is one line at the single
death site (`tick.rs:477`: only stamp `respawn_at_tick` when `slot.deaths < LIVES_PER_RAID`)
and zero new bytes, and it is confirmed unreachable today — the covering test hand-writes an
impossible state. **It must not ship in the same commit as the gate flow.** Separate slice.

**12.15 `SCALE = 2`.** Kept as the named fallback lever, not shipped (§1.2, §9.3).

---

## 13. Open risks

1. **The S=3 raster area is unmeasured.** `render-scale`'s 2.2× headroom was measured with
   `boss.svg` at 1:1. At S=3 the boss covers ~95% of the frame. The mitigation is structural
   — the 13 part groups are static geometry inside promoted layers that only animate
   transform, which measured 0.11–0.25 ms promoted against 5.4–9.0 unpromoted — but nobody
   has run it. **Measure this first, before building §8.3.** The lever is
   `--scale 2`.
2. **No CU number exists for any of this**, or for the shipped program. Measured today:
   empty arena 6,857 flat; 20 seats aggressive p50 19,136 / max 28,586 of **399,700** (the
   ceiling is 399,700, not 400,000). The slam adds a bounded per-player x-range test and the
   top-up four arithmetic lines, so the estimate is comfortable — but R5 (a crank tick over
   budget deletes the task permanently and kills the match) is still open. Read
   `consumed X of 399700` from a crank log during a 20-seat fight, **filtered on the arena
   account, never on the program** — 2.25 log lines per tick leak from other unsettled
   arenas on the same validator.
3. **Renumbering part indices permutes `Boss.parts[i]` for any live mid-fight arena.** Safe
   because `reset_for_incarnation` fills every slot from one uniform array, but land it
   between incarnations or reset the arena.
4. **Moving the muzzles changes bullet spawn points on chain and in the client's predicted
   volley.** Both files come out of one generator pass; ship them together.
5. **`PIT_TOP`/`PIT_BOT` is a second kind of barrier alongside the wall bitboard, and the
   two can disagree.** A bug in the clamp puts players inside the boss's head, in open
   floor, with no error anywhere. Check 11.6 is the guard.
6. **Deleting `LOBBY → FIGHTING` is not backward compatible with a deployed app build.** An
   old client sends tag 3, gets MUSTERING, and falls through its phase switch for 20 s.
   Degraded rather than broken, but program and app must ship together.
7. **`enrage_at_tick` changes meaning** from a creation-time constant to a flip-time stamp,
   so it reads 0 for the whole muster. Three readers assume otherwise:
   `worker/routes.ts:619`, `Hud.tsx:228/238/271`.
8. **`MUSTERING → SETTLED` records nothing and burns an arena id.** The worker already skips
   stranded arenas. If arenas start burning, the crank is dying during the muster and *that*
   is the problem to chase.
9. **`connection.ts`'s shoot-signature collision is reduced but not closed** by free aim: a
   pointer shooter sends a near-unique pair every time, but a keyboard shooter repeats, and
   two identical sends inside one 50 ms ER slot can still be silently dropped. The proper fix
   is a `u16` nonce like `move` has. Out of scope; flagged so it is not rediscovered.
10. **The 82–91% acceptance rate at 20 seats and 50 ms** means the shipped client throws away
    roughly one move in eight to the same-slot rate limiter. That is the limiter working, but
    the app is sending faster than the chain accepts and paying uplink for it. Worth a
    separate look at whether `controls.ts` should clock off the ER slot.
11. **Every browser number came from one Fedora/X11 box at dPR 1.0.** Firefox, WebKit, mobile
    GPUs and dPR 2 were not measured. A dPR-2 display quadruples rasterised area and is the
    most likely way the 2.2× headroom degrades.
