# 13 — the archer, and arrows you can see

## 0. The decision, in one line

**Player fire stays hitscan. Arrows are drawn by the client from one byte the chain already
has room for.** Option (c). The chain's per-tick cost, its account bytes, its notification
count and its write-lock set are all **unchanged**; the only on-chain change in this whole
feature is that `PlayerSlot._pad0` (offset 3, free on every account already on devnet) stops
being padding and starts carrying `class_aim` — a class bit and a 7-bit aim snapshot.

This is not the timid answer. (a) and (b) were measured, and they turned out to be
*affordable* — the CU headroom holds and the 128-slot pool holds. They are rejected on three
other grounds, each of which is a number below, and the first of them is the user's own hard
constraint.

---

## 1. What was measured, and with what

Two throwaway instruments, both reusing the shipped crate so the geometry is the shipped
geometry and not a model of it. Neither touched product code.

| instrument | what it is | what it answers |
|---|---|---|
| `arrow-cu` | `mollusk-svm` 0.15.1 over the tree's real ELF (`/home/anshtyagi/Documents/pixel-artgame/target/deploy/heartrot.so`, 115,440 B, built 2026-09-02 05:38), cloned from `scripts/spike/cu/` | marginal CU of one live projectile per `boss_tick`, swept 0→128 |
| `flight` / `aimbyte` | plain binaries linking `heartrot::map` and `heartrot::hitboxes` | how far an arrow actually flies on this map, and how wrong a one-byte aim is |

Both live in the scratchpad (`…/scratchpad/arrowcu/`), not in the repo — they are
`scripts/spike/cu/` with a different `main`, and that harness is already documented as
throwaway.

### 1.1 The dominant cost, measured directly

`boss_tick` CU with the live-bullet count **pinned** at N before every tick, 120 chained
ticks per row, canonical-bump arena (`ARENA_SEED=1`), boss at `BOSS_SPAWN`, raiders on the
pit floor. Bullets re-stamped each tick so the population is stationary.

| seats | N pinned | p50 CU | max CU | % of 399,700 |
|---|---|---|---|---|
| 20 | 0 | 4,560 | 4,848 | 1.2 % |
| 20 | 8 | 10,277 | 10,565 | 2.6 % |
| 20 | 23 *(the measured boss peak)* | 20,982 | 21,270 | 5.3 % |
| 20 | 32 | 27,478 | 27,766 | 6.9 % |
| 20 | 64 | 50,470 | 50,758 | 12.7 % |
| 20 | 128 *(pool full)* | 96,491 | 96,779 | 24.2 % |

Dead linear. Every 8-bullet increment costs 709–722 CU, from N=0 to N=128, with no knee.

> **718 CU per live projectile per tick at 20 seats** (arrow-direction bullets),
> **754 CU** for boss-direction bullets, **547 / 554 CU** at one seat.
> Per additional live player, per bullet: **9.0–10.5 CU** — that is the 4-compare broad
> phase in `tick.rs`, and it is why the loop is affordable at all.

Within-case spread on an identical 120-tick run is 77 CU (1 seat) to 288 CU (20 seats).
**That is this instrument's resolution**, and it is the number to hold any "is this change
free?" claim against.

### 1.2 How far an arrow would actually fly

Every floor tile of the pit (`PIT_TOP`..`PIT_BOT`, 214 stands after excluding tiles inside
`SHELL_AABB`), aimed at the core through the program's own `raycast`, one step = `TILE` = 16
units:

```
SHELL_AABB local x-342..339 y-384..312  (681 x 696 units)
pit floor stands: 214; aimed-at-core rays that reach the shell: 214 (100.0%)
AIMED  steps-to-end:  min 1  p50  6  p95 11  max 13   ->   96 / 176 / 208 units
MISS (90 deg off):    min 1  p50 11  p95 30  max 33   ->  176 / 480 / 528 units
```

Two things fall out of this that were not obvious:

- **Range is not a usable class axis on this map.** `MAX_RAY_STEPS` is 64 and the worst pit
  stand reaches the shell in 13. Every stand reaches it, from everywhere, 100 %. Do not add
  a per-class range; it would be a knob wired to nothing.
- The old published "worst stand-to-core range is 865 units" (`11-immortals-spec.md` §4.1) is
  not the pit. Measured from the pit floor against the current `SHELL_AABB`, the shell is
  96–208 units away. The 865 figure still bounds `MAX_RAY_STEPS`; it does not bound flight.

---

## 2. Why not (a) — real projectiles sharing the bullet pool

**Steady state.** `SHOT_COOLDOWN_TICKS = ticks_for(800) − 1 = 7`, and the guard is
`tick <= last_shot_tick + 7`, so a seat fires once per 8 ticks. Twenty seats = **2.5 arrows
per tick**. At the only speed that fits `Bullet.dx: i8` and the existing pool
(`BULLET_SPEED` = 42 units/tick), lifetime = flight ÷ 42:

| everyone… | flight | lifetime | live arrows = 2.5 × lifetime | added CU/tick @ 754 |
|---|---|---|---|---|
| lands the p50 aimed shot | 96 u | 2.3 ticks | **5.7** | 4,300 |
| lands the worst aimed shot | 208 u | 5.0 ticks | **12.4** | 9,300 |
| misses, p95 | 480 u | 11.4 ticks | **28.6** | 21,600 |
| misses, worst | 528 u | 12.6 ticks | **31.4** | 23,700 |

**The pool holds.** Measured boss peak is 23 in flight; 23 + 31.4 = **54.4 of 128**. There is
no starvation and no dropped volley. My own prior worry about pool exhaustion is **not
supported by the measurement** — record that as a negative result.

**The CU holds too.** Worst `boss_tick` today is 24,884 (canonical bump) / 32,384
(251/254 bump). Add the worst arrow load: **48,534 / 56,034 CU = 12.1 % / 14.0 %** of
399,700. Seven times headroom. Not a blocker.

So the cost argument does **not** kill (a). These three do:

**(a).1 — It makes the player's own shot land between 229 ms and 1.26 s later than it does
today.** Hitscan resolves damage inside the send: measured write-to-visible is 122 ms p50.
A projectile at 42 u/tick adds the flight time in the table above on top of that — the
damage number appears **351 ms to 1.38 s** after the key instead of 122 ms. The user's hard
constraint is the ER speed they can feel, and this is a direct, quantified, self-inflicted
regression on exactly that. `09-shooting.md` §3 already made this decision deliberately:
player fire instant, boss fire dodgeable. Nothing in the brief asks to reverse it.

**(a).2 — It turns `shoot` into a genuine writer of `Arena`.** Claiming a pool slot writes
`arena.bullets` and `arena.bullet_cursor`. Today `fire()` takes `&mut Arena` and only ever
*reads* `arena.tick`, which is why `docs/review/chain-cost.md` records a free three-line fix
(load instead of load_mut, drop `Arena` from the `assert_writable` loop, flip the meta to
READONLY). Twenty seats are measured **faster** than one — 122 ms p50 vs 133 ms — precisely
because `move` takes `Arena` read-only and concurrent movers never serialise. A write lock
excludes readers. (a) puts 25 exclusive `Arena` write locks per second in contention with
369 accepted `move`/s that hold a read lock on the same account, **and permanently forecloses
the fix that would remove the last one.** The magnitude of that regression is not measured —
it needs a live devnet run — and under a hard "do not degrade ER speed" constraint an
unquantified regression to the exact mechanism that produced the number the user likes is not
a trade worth taking for a picture.

**(a).3 — It couples player fire to boss ordnance for no reason.** A full pool *drops* the
spawn, silently. At 54/128 that never fires today, but it means a future balance change to
`bullets_per_volley`, to `BULLET_SPEED`, or to the cooldown now has to be reasoned about
across two independent systems that share one array.

---

## 3. Why not (b) — real projectiles in their own pool

Everything in §2 except (a).3 still applies — (b) is (a) with a second array, so it still
adds flight time and still makes `shoot` an `Arena` writer. On top of that it costs bytes.

**Pool size, derived rather than picked.** A seat fires every `SHOT_COOLDOWN_TICKS + 1` = 8
ticks and an arrow lives at most 12.6 ticks (§1.2), so at most `ceil(12.6 / 8) = 2` arrows
per seat are ever in flight:

```
MAX_ARROWS = MAX_SEATS * ceil(ARROW_MAX_LIFETIME_TICKS / (SHOT_COOLDOWN_TICKS + 1)) = 40
```

40 slots × 8 B = **320 B**, appended past `next_affix_seed`. `Arena` goes 1,200 → 1,520 B
(+26.7 %).

**What 320 bytes on `Arena` actually costs:**

- `Arena` is **delegated**. Growing it is undelegate → realloc → redelegate, plus
  `LAYOUT_VERSION` 1 → 2, plus every decoder in `packages/client`, `app/` and `worker/`.
  Zero of the redesign's other work needed any of that: `docs/review/chain-cost.md` records
  "rent delta for the entire redesign: 0 lamports", and `outcome`, `fight_at_tick` and
  `deaths` were all claimed out of existing padding for exactly this reason.
- **Feed.** `docs/review/twenty-seats.md` measures 1,798.3 KB/s per subscriber at 20 seats
  and reproduces it to 0.3 % with `(accepted moves/s) × 4,742 B` at 369 accepted moves/s —
  4,742 B being base64(`Arena` 1,200 + `Players` 1,924) plus envelope. So `Arena` rides
  every accepted move. +320 B raw is +427 B base64 per pair: **+157 KB/s from `move` alone**,
  plus ~8.5 KB/s from the 10 Hz crank and ~21 KB/s from `shoot`, **≈ +187 KB/s, +10.4 % of
  the measured per-client feed** — for a field that has nothing to do with movement, on the
  stream that carries the movement the user says feels fast.

---

## 4. Why (c) is the answer

The damage is **already correct and already published**. `shoot` raycasts, `boss.parts[i]` or
`boss.core_hp` drops, `slot.damage_dealt` rises, `slot.last_shot_tick` stamps. Every one of
those is on chain, agreed by twenty clients, and arrives in the same notification triple.
There is nothing left for a projectile entity to decide. The arrow is a **picture of a
decision that has already been made**, and the chain should not pay for pictures — the same
rule that made the hand slam free (`tick.rs`: derived from `(affix_seed, tick)`, zero bytes,
zero notifications).

**On-chain delta of the entire feature:**

| | before | after |
|---|---|---|
| `size_of::<PlayerSlot>()` | 96 | 96 |
| `size_of::<Players>()` / `<Arena>()` | 1,924 / 1,200 | 1,924 / 1,200 |
| `LAYOUT_VERSION` | 1 | 1 |
| rent | — | **0 lamports delta** |
| accounts named by `shoot` | arena W, boss W, players W, authority S | unchanged |
| notifications per shot | 3 | 3 |
| new write locks | — | none |
| `boss_tick` CU | 24,884 worst | unchanged (nothing added to the tick) |
| `shoot` CU | 3,452 guards → 16,699 worst | + one read-modify-write and one 2-entry table index |

The `shoot` delta is roughly a dozen BPF instructions. **It was not measured**, because
measuring it means building it, and this task specifies rather than builds. The honest bound
is that it is an order of magnitude below the instrument's own 77–288 CU resolution (§1.1),
and it rides an instruction that already costs 3,452–16,699 CU.

---

## 5. The byte: `PlayerSlot._pad0` → `class_aim`

```
offset 3, u8, one byte, no field moves, no account grows

  bit  7    class     0 = CLASS_KNIGHT, 1 = CLASS_ARCHER
  bits 6..4 aim sector 0..7, 45 degrees each
  bits 3..0 aim ratio  0..15, tangent-parameterised across the sector
```

`0` — what every seat on devnet carries today, and what `PlayerSlot::zeroed()` produces —
decodes as **knight, aim sector 0 ratio 0 = due east**. That is not a bug and must not be
"fixed" to north: the aim field is only ever read when `last_shot_tick != 0`, and a seat that
has never fired carries `last_shot_tick == 0`. `arena.tick` cannot be 0 when a shot lands
(`shoot` requires `PHASE_FIGHTING`, and `begin_muster` puts `MUSTER_TICKS` = 200 ticks on the
clock before `FIGHTING` is reachable), so `last_shot_tick != 0` is a sound "has fired" test
with no extra flag.

**`facing` (offset 1) is not redundant with the aim sector.** `facing` is a live value —
`move` rewrites it every 50 ms. The aim sector is a **snapshot of one shot** and is written
only by `fire()`. They agree at the instant of the shot by construction and diverge
immediately afterwards, which is correct: one says where the body is looking now, the other
says where a shot that has already been taken went. If the sector were read from `facing`,
every arrow would snap direction mid-flight the moment its shooter took a step.

Add to `state.rs`'s const block:

```rust
assert!(offset_of!(PlayerSlot, class_aim) == 3);
```

and to `packages/client/src/layout.ts`'s `PLAYER_SLOT.offsets`: `class_aim: 3`.

### 5.1 Encoding — chain side, in `fire()`

Runs immediately after the existing `octant(dx, dy)?` call, on the same `(dx, dy)` the wire
carried. `(0, 0)` is already rejected by `octant`, so `m > 0` here.

```rust
/// Pack this shot's aim into the low 7 bits, preserving the class bit.
///
/// Sector is the 45-degree octant by sign and dominance; the ratio is
/// min/max, which is tangent-linear across the sector and therefore exactly
/// invertible by the client with no trig on either side.
const AIM_RATIO_BITS: u8 = 4;
const AIM_T_MAX: i32 = (1 << AIM_RATIO_BITS) - 1;   // 15
const CLASS_MASK: u8 = 0b1000_0000;

fn aim_bits(dx: i8, dy: i8) -> u8 {
    let (x, y) = (dx as i32, dy as i32);
    let (ax, ay) = (x.abs(), y.abs());
    let (m, n) = (ax.max(ay), ax.min(ay));
    let t = (n * AIM_T_MAX + m / 2) / m;            // 0..=15, round to nearest
    let sector = ((x < 0) as u8) << 2 | ((y < 0) as u8) << 1 | (ay > ax) as u8;
    (sector << AIM_RATIO_BITS) | t as u8
}

// in fire(), on the line that already writes slot.facing:
slot.class_aim = (slot.class_aim & CLASS_MASK) | aim_bits(dx, dy);
```

The `& CLASS_MASK` is load-bearing: drop it and a player silently changes class on their
first shot. It is the one hazard this byte introduces and the one thing a test must pin.

### 5.2 Decoding — client side, `packages/client`

```ts
/** Sector + ratio -> an integer vector on the same ray. Magnitude is meaningless. */
export function aimVector(classAim: number): { dx: number; dy: number } {
  const sector = (classAim >> 4) & 7;
  const t = classAim & 15;
  let dx = sector & 1 ? t : 15;
  let dy = sector & 1 ? 15 : t;
  if (sector & 2) dy = -dy;
  if (sector & 4) dx = -dx;
  return { dx, dy };
}

export const classOf = (classAim: number): number => classAim >>> 7;
```

### 5.3 How wrong is it — measured, over every legal aim and every pit stand

Swept all 65,535 legal wire aims (`dx`,`dy` ∈ −128..127 minus `(0,0)`), and both a
core-aimed and a 90°-off ray from each of the 214 pit floor stands, through the program's
own `raycast`:

| ratio bits | class bits | worst angle | aimed endpoint offset p50/p95/max (units) | miss endpoint offset p50/p95/max | rays hitting a different part |
|---|---|---|---|---|---|
| 5 | 0 | 0.92° | 1 / 13 / 27 | 2 / 21 / 80 | 1.40 % |
| **4** | **1** | **1.90°** | **2 / 13 / 28** | **5 / 32 / 60** | **0.93 %** |
| 3 | 2 | 4.05° | 4 / 14 / 24 | 9 / 62 / 132 | 2.80 % |

**The first class bit is nearly free on the shot a player actually watches**: the aimed p95
endpoint offset is 13 units either way — under one `TILE`, and under the 12-unit
`PLAYER_HIT_RADIUS`. The second class bit is not free (miss p95 goes 32 → 62 units, four
tiles), so **two classes, one bit**. Upgrade path if a third class is ever wanted: take the
second bit and accept the row above, or move the class onto `skin_id` (§7.1).

Two more properties, both verified rather than assumed:

- **`octant(reconstructed) != octant(original)` on 1,120 of 65,535 aims (1.71 %)**, all of
  them within 1.9° of a sector boundary. Harmless *because the client never derives `facing`
  from the aim byte* — `facing` is its own field. Do not "simplify" that away.
- **8 of the 128 aim codes do not re-encode to themselves.** Every one is a `t = 0` or
  `t = 15` axis/diagonal alias, and all eight were checked to decode to the *same ray* as the
  code they re-encode to (`0x1f`→`0x0f` both give `(15,15)`; `0x20`→`0x00` both give
  `(15,0)`; and six more). The decoder is total over all 256 byte values and the encoder
  emits one member of each pair. No special case is needed anywhere.

---

## 6. What the client draws

### 6.1 The spawn trigger already exists

`app/src/render/Knight.tsx:292` already folds the exact edge this needs:

```ts
if (slot.lastShotTick > st.lastShotTick) { st.lastShotTick = slot.lastShotTick; st.shots++; }
```

That is a **value diff against the last snapshot consumed**, which is why it is already
correct against the two things this feed does: the Magic Router delivers every notification
twice (a duplicate carries the same `last_shot_tick` and folds to nothing) and 68.4 % of
`Players` notifications carry no change (same). Spawn the arrow on that same edge. No payload
cache, no dedupe bookkeeping, nothing new to get wrong.

Two shots by one seat cannot be coalesced into one notification: the cooldown is 800 ms
(knight) or 1,400 ms (archer) against a ~20 Hz `Players` stream — 16 to 28 stream slots
apart.

### 6.2 Arrow state, all of it from published bytes

| what | from |
|---|---|
| that a shot happened, and when | `slot.last_shot_tick` (rising edge) |
| origin | `slot.x`, `slot.y` **in that same payload** — `fire()` does not move the player, so these are the ray origin the chain used |
| direction | `aimVector(slot.class_aim)` |
| which arrow art, speed, arc | `classOf(slot.class_aim)` |
| endpoint | client raycast, §6.3 |

Every client decodes the same bytes with the same decoder, so **every client draws the
identical arrow**. That is the brief's requirement and it is satisfied by construction, not
by convergence.

### 6.3 The endpoint

`packages/client` already imports the generated `WALLS`/`isWall` (`map.ts`) and
`PART_HITBOXES`/`CORE_*` (`hitboxes.ts`) — the same tables `shoot.rs` raycasts, from the same
`tools/gen_map.py` and `tools/gen_hitboxes.py` pass. So the endpoint is a ~20-line mirror of
`shoot.rs::raycast` over tables that are already there: same Q12 accumulation, same one
sample per `TILE`, same `SHELL_AABB` gate, same "a part at 0 HP is transparent" rule, same
`PART_HITBOXES` order.

This is a third copy of an algorithm, and this project's worst repeated defect is one fact
stored twice — so state the mitigation rather than pretend it away. It is the same shape
`packages/client/src/layout.ts` already carries for `player.rs`'s movement rule, with the
same remedy: a header comment naming `programs/heartrot/src/handlers/shoot.rs::raycast` as
the authority, and a self-check that asserts **behaviour, not coordinates** (exactly what
`shoot.rs`'s own tests do, and for the same reason — the map and the hitboxes are generator
output and a test naming a tile stops testing the ray):

1. a shot from the pit centre straight up terminates inside `SHELL_AABB`;
2. a shot into a wall found by searching `WALLS` terminates on that wall tile;
3. a part at 0 HP is transparent — the same aim terminates further along.

Blast radius of the one input the client cannot have exactly: `boss.parts` may have changed
between the shot and the notification, so an arrow can visually pass through a limb that died
in the last 100 ms. Cosmetic, sub-100 ms, self-correcting on the next payload.

### 6.4 The local seat

The local seat draws its arrow at key-press time from the `(dx, dy)` it is about to send —
it has the exact vector, better than the 1.9° reconstruction — and **ignores the confirmation
for its own seat when spawning arrows**. Remote seats spawn only from the byte. That is the
existing one-writer rule (`predictor.self` for the local node transform, interpolation for
every remote one) applied to arrows, and it keeps the local player's arrow at zero latency.

### 6.5 Speed, arc, and the frame budget

Client-only numbers. Unlike `MOVE_MS = 50`, these *are* taste knobs; say so where they live.

| class | arrow | speed | flight at the p95 pit range (176 u) | arc |
|---|---|---|---|---|
| knight | short bolt | 1,600 u/s | 110 ms | straight |
| archer | long shaft | 1,100 u/s | 160 ms | sag ⊥ to the ray, amplitude range/10, `sin(πt)`, zero at both ends |

The arc is a render offset only. It must return to zero at the endpoint, or the arrow will
appear to strike somewhere the chain did not.

Ordering note, stated because it is the one visible artefact: the damage flash and the arrow
spawn arrive on the same notification triple, so a *remote* arrow is still in flight when its
own damage flash fires — by ≤160 ms, with nineteen other arrows landing constantly. The local
player never sees it, because §6.4 spawns their arrow 122 ms before the confirmation lands.

**Count.** Arrows on screen ≤ 20 and typically 3–9 (20 seats × flight ÷ cooldown: knight
20 × 0.11/0.8 = 2.8; archer missing long, 20 × 0.48/1.4 = 6.9). `app/src/render/Arena.tsx`
already caps drawn projectiles at 32 and ranks them by `bulletRisk`; the live run saw 13–15
bullets in flight at 20 seats, so **arrows share that one cap, boss bullets ranked first** —
a boss bullet can kill you, an arrow cannot. The cap stays 32. Measured frame budget at 20
knights with full art under 6× CPU throttle is p50 9.38 / p95 14.92 ms; ≤20 extra stretched
quads is within it but is not free, and the shared cap is what keeps it bounded.

---

## 7. The class table

Two classes. `0` is the existing default, which is what every live account carries.

```rust
pub const CLASS_KNIGHT: u8 = 0;
pub const CLASS_ARCHER: u8 = 1;
pub const N_CLASSES: u8 = 2;

/// (damage per landed shot, cooldown ticks) indexed by class.
///
/// Both rows are 50 damage per second. The archer is not stronger, it is *slower and
/// heavier* -- which is also the only version of the archer that cannot regress the
/// notification budget (see below).
///
/// Every duration goes through `ticks_for`. The guard is
/// `tick <= last_shot_tick + cooldown`, so the stored value is one less than the period.
const CLASS_TABLE: [(u16, u32); N_CLASSES as usize] = [
    (40, crate::state::ticks_for(800) - 1),    // knight: shipped numbers, unchanged
    (70, crate::state::ticks_for(1_400) - 1),  // archer
];
```

| | damage | cooldown | period | DPS | shots/s at 20 seats |
|---|---|---|---|---|---|
| knight | 40 | 7 ticks | 800 ms | 50 | 25.0 |
| archer | 70 | 13 ticks | 1,400 ms | 50 | 14.3 |

**Why slower and not faster.** `docs/review/twenty-seats.md` §6 models `shoot` under load at
+75 notifications/s and +128 KB/s for twenty knights on cooldown, and calls it the largest
unmeasured load in the client's budget. A 500 ms archer would be 40 shots/s → +120 notif/s
and +205 KB/s (+15.6 % frames on the measured 766/s). A 1,400 ms archer is 14.3 shots/s →
**+43 notif/s and +73 KB/s, less than a knight**. Same DPS, no rebalancing of the boss, and
the notification budget can only improve. It is also the better-looking arrow: a heavy shaft
you can watch cross the pit.

**What does not differ, and why:**

- **Range.** Measured: every pit stand reaches the shell in ≤13 of the 64 available ray steps
  (§1.2). A per-class range would be a knob wired to nothing.
- **Projectile speed and arc** are client-only (§6.5). They are not on chain because nothing
  on chain travels.
- **Everything else in `fire()`** — the vent rule, the part-vs-core rule, `damage_dealt`
  crediting only what was removed, the cooldown being spent by the *attempt* — is unchanged.
  Only the two table lookups move.

The whole on-chain diff to `fire()`:

```rust
let (damage, cooldown) = CLASS_TABLE[(slot.class_aim >> 7) as usize];
```

`>> 7` on a `u8` is 0 or 1 and `N_CLASSES` is 2, so the index is total — no bounds check, no
`get()`, no unreachable arm.

### 7.1 The alternative that was considered and not taken

Deriving the class from `skin_id` (offset 2, already on the wire, already chosen in
`app/src/screens/CharacterSelect.tsx`, already bounded by the Worker's `SKIN_COUNT = 3`)
costs **zero** new bytes and makes class and sprite structurally unable to disagree. It was
rejected because it welds class to colour: three knight skins and one archer means an archer
can only ever be one colour, and adding a second archer colour costs a fourth and fifth
sprite. The `class_aim` bit keeps class orthogonal to skin at a measured cost of 1.9° instead
of 0.92° of aim resolution, which §5.3 shows is invisible at pit ranges. If that trade ever
looks wrong, `skin_id` is still there and the migration is one function.

---

## 8. Choosing a class, and where it lives on the wire

Seats are administered, not self-served: only the treasury-signed Worker can send tag 4, and
it is the thing holding the Privy identity map. The class therefore travels the same road
`skin_id` already travels.

```
CharacterSelect (browser)                 store.classId, beside store.skinId
  -> POST /api/session/init  { skinId, classId }
  -> worker/src/routes.ts    reject classId >= CLASS_COUNT, exactly as it rejects skin
  -> packages/client join()  data[67] = classId
  -> player.rs join          data[66] -> claim_seat -> slot.class_aim = class << 7
```

**Wire change, precisely one byte, appended:**

```
JOIN_DATA_LEN: 66 -> 67
  data[0]      seat            u8      unchanged
  data[1]      skin_id         u8      unchanged
  data[2..34]  session_pubkey  32 B    unchanged
  data[34..66] identity        32 B    unchanged
  data[66]     class           u8      NEW
```

Appending is what keeps the diff to one line in each of the four places: no existing offset
moves and the two 32-byte slices are untouched. `player.rs:511`'s
`if data.len() != JOIN_DATA_LEN` turns an old client into a clean length refusal rather than
a misread — the same property the 3→4-byte `shoot` change already relies on.

**Validate, do not clamp.** `if class >= N_CLASSES { return Err(InvalidInstructionData) }`.
An unknown class silently becoming a knight is a client bug that presents as a balance
complaint. Validate at both ends: the Worker is the trust boundary that already range-checks
`skin_id`, and the program is the one that cannot be bypassed.

`claim_seat` writes `class_aim: class << 7` and nothing else — the aim bits start at 0 and
are never read until the seat's first shot (§5).

---

## 9. Checks an implementer must leave behind

Non-trivial branches, one runnable check each. Rust ones go in `shoot.rs`'s existing
`mod tests`, TS in the `ok()` self-check blocks that `instructions.ts` and `Knight.tsx`
already carry.

1. **The class bit survives a shot.** Fire an archer twenty times; `class_aim >> 7` is still
   1 every time. This is the `& CLASS_MASK` hazard and it is the single most important test
   in the feature.
2. **Round-trip agreement, as a property, not a table.** For every legal `(dx, dy)`,
   `aimVector(aim_bits(dx, dy))` is within 1.91° of `(dx, dy)`. Assert the same property on
   both sides; do **not** ship a 128-entry expected table into TS, because that is the fact
   stored twice this whole document is trying to avoid.
3. **The decoder is total.** All 256 byte values decode to a non-zero vector.
4. **The class table is DPS-neutral and derived.** `40 * ticks_for(1_400) == 70 * ticks_for(800)`
   — 40 × 14 = 560 = 70 × 8. And, beside `state.rs`'s existing duration asserts,
   `ticks_for(1_400) * TICK_MS == 1_400`, so the archer's cooldown survives a change to
   `TICK_MS` the way every other duration in this program does.
5. **The client raycast agrees with the chain's** — the three behavioural assertions of §6.3.
6. **Duplicate notifications spawn one arrow.** `Knight.tsx`'s self-check already asserts
   "a repeated `last_shot_tick` recoils once" (line 599); extend the same fixture to arrows.

---

## 10. Negative results and things not measured

Stated plainly, because a brief that gets only the confirming half of a measurement has been
misled.

- **On-chain arrows are affordable, and I expected them not to be.** The 128-slot pool holds
  (54 of 128 at the worst arrow load), and `boss_tick` peaks at 48,534 CU — 12.1 % of
  399,700. Neither the pool nor the CU ceiling is the reason to say no. The reasons are
  flight latency (§2, (a).1), the `Arena` write lock (§2, (a).2), and, for (b), 320 bytes on
  a delegated account and +187 KB/s of feed (§3).
- **The write-lock regression is not quantified.** The *mechanism* is measured — 20 seats
  faster than 1, because `move` takes `Arena` read-only — but how much a 25/s exclusive write
  lock costs the 122 ms p50 would need a live devnet run and was not done. Under a hard "do
  not degrade the ER speed" constraint that unknown is itself the argument.
- **The `shoot` CU delta of this feature was not measured**, because measuring it means
  building it. Bounded above by the instrument's 77–288 CU resolution (§1.1).
- **The spacebar bug is not the shot cooldown, and this feature does not fix it.** Root cause
  A as briefed says `tick <= last_shot_tick + 7` refuses every shot at `tick == 0`. That is
  true, and it is also unreachable: `shoot` returns `WrongPhase` in `LOBBY` and `MUSTERING`
  before the cooldown is ever consulted, and by the time `PHASE_FIGHTING` is entered
  `begin_muster` has already put `MUSTER_TICKS` = 200 ticks on the clock, so the first shot of
  every fight passes `200 > 0 + 7` immediately. **The waiting-area spacebar is blocked by the
  phase gate, not by the cooldown.** Whatever fix lands for it, it lands on
  `shoot.rs`'s `arena.phase != PHASE_FIGHTING` check, and it lands on the same line the class
  table changes — the two must land in one commit or they will fight.
- The 214-stand sweep uses tile centres, and the "miss" case is a 90°-off ray, which is a
  choice of miss and not a distribution of real player misses. Real aim is somewhere between
  the two rows, closer to the aimed one.
- The `arrow-cu` sweep pins the bullet population artificially. It measures the *marginal
  cost of a live projectile*, which is what §2 needs; it does not reproduce a natural fight
  (the existing `scripts/spike/cu/` harness does that, and its 24,884 figure is the one used
  as the baseline here).
- Every CU number here is Agave-via-mollusk, not the ER. `docs/review/chain-cost.md`'s
  calibration puts that at ±10 % on absolutes and much tighter on deltas, and this document
  reasons almost entirely in deltas.

---

## 11. Implementation order

1. `state.rs` — `_pad0` → `class_aim`, the offset assert, the class constants.
2. `shoot.rs` — `aim_bits`, the `& CLASS_MASK` write, `CLASS_TABLE`, tests 1–4.
3. `player.rs` — `JOIN_DATA_LEN` 66 → 67, `data[66]`, the `>= N_CLASSES` refusal,
   `claim_seat(.., class)`.
4. `packages/client` — `layout.ts` offset + `classAim` decode, `aimVector`, `classOf`,
   `join()` byte 67, `arrowEndpoint` + its three behavioural checks.
5. `worker/src/routes.ts` — `CLASS_COUNT`, the range check, `classId` through to `join()`.
6. `app/` — `CharacterSelect` class picker, `store.classId`, the arrow layer in `Arena.tsx`
   under the shared 32-projectile cap, `Knight.tsx` arrow spawn on the existing
   `lastShotTick` edge.

Steps 1–3 are one commit (the program and its wire), 4–6 are one commit (the app and its
mirror). Shipping them apart gets a clean `InvalidInstructionData` on join, which is the
loud failure the length check exists to produce.
