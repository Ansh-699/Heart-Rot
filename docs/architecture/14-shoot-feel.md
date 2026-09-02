# 14 — Shoot feel

Specification for making a shot legible. Written against commit `6fc72d5`, program
`JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`.

This is a specification, not a change. Nothing in the shipped tree was modified to
produce it. Every number below says how it was obtained; anything not measured is
labelled as arithmetic or as an open question.

The bug report is three sentences: *"the space bar doesnt work"*, *"fix the person
shooting mechanics i cannot see anything"*, *"introduce arrows archer as well"*. They
are three symptoms of two causes, and one of the two is a live constant bug nobody has
found yet.

---

## 1. What is actually true

The brief handed to this task named one root cause for the dead spacebar:

> `shoot.rs:374` refuses when `arena.tick <= slot.last_shot_tick + SHOT_COOLDOWN_TICKS`.
> In the waiting area `arena.tick` is 0 and the crank is not running, so `0 <= 0 + 7` is
> always true and every shot is refused.

**That is not what happens, and the correction matters, because it changes the fix.**
Verified by reading the shipped source:

### 1.1 In the waiting area no transaction is ever built

`app/src/input/controls.ts:310`:

```ts
if ((pointerDown || fireKeyDown) && phase === PHASE_FIGHTING) {
```

The client gates fire on `PHASE_FIGHTING` before the cooldown is even consulted. The
waiting area is `PHASE_LOBBY` (`store.ts` defaults to it; `App.tsx:394` reads
`arena?.phase ?? PHASE_LOBBY`). So in the waiting area the spacebar builds nothing,
signs nothing and sends nothing. There is no refused transaction, because there is no
transaction.

### 1.2 If one were sent, the refusal would be `WrongPhase`, not `RateLimited`

`handlers/shoot.rs:521-523` runs *before* `fire`:

```rust
if arena.phase != PHASE_FIGHTING {
    return Err(HeartrotError::WrongPhase.into());   // Custom(6)
}
```

`fire` — and with it the cooldown compare at line 374 — is only reached at line 534.
The cooldown never runs outside a fight. `RateLimited` is `Custom(7)`; `WrongPhase` is
`Custom(6)`; attributing the dead key to the cooldown would have sent an implementer to
fix a guard that is not on the path.

### 1.3 The cooldown is not broken at the start of a fight either

Traced end to end:

| step | `arena.tick` | source |
|---|---|---|
| incarnation begins | `0` | `state.rs:742`, `begin_next_incarnation` zeroes it, and zeroes every `PlayerSlot` (`state.rs:968`), so `last_shot_tick = 0` |
| LOBBY | frozen at `0` | no crank — the task is scheduled by `begin_muster` (`settle.rs:212-228`), not before |
| MUSTERING | `1 … 200` | `heartbeat` (`tick.rs:419`) advances the clock **unconditionally**, before the phase gate |
| first FIGHTING tick | `≈ 201` | `MUSTER_TICKS = ticks_for(20_000) = 200` |

First shot of a fight: `201 > 0 + 7` → accepted. There is no first-shot hole. The chain
arithmetic is correct as shipped.

### 1.4 The live bug is in the HUD, and it is the second half of the report

`app/src/ui/Hud.tsx:96`:

```ts
const SHOT_COOLDOWN_TICKS = 1;
```

The chain's value is `ticks_for(800) - 1 = 7` at `TICK_MS = 100`
(`shoot.rs:138`, `state.rs:145`). `controls.ts:129` derives it correctly as
`800 / TICK_MS - 1 = 7`. The HUD carries a hardcoded `1` — the 400 ms-era value, where
`ticks_for(800)` was `2`.

Consequence, in a live fight:

- `Hud.tsx:348` computes `shotReady = tick > lastShotTick + 1`.
- The **SHOT READY** pill turns green 6 ticks — **600 ms** — before the chain, and
  before `controls.ts`'s own (correct) gate, will do anything.
- The player reads READY, presses space, and the pump refuses to send. Nothing happens,
  no error, no tracer, no sound. **Six out of every eight ticks of a held trigger, the
  HUD says the weapon is ready and the weapon is not.**

The constant's own comment predicted this and dismissed it:

> `ponytail: third copy of this constant (chain, input/controls.ts, here). […] a wrong
> copy only mislabels a pill, which is why this is the cheap place to keep it.`

The pill is the only thing on screen that claims to know whether the trigger works. A
wrong copy does not "only mislabel a pill" — it is the entire user-visible model of the
weapon. This is the project's named recurring defect, ONE FACT STORED TWICE, on its
third copy and second drift (`controls.ts:120-128` documents the first).

### 1.5 There are three dead-trigger windows, not one

| window | phase | zone | duration | what the player sees |
|---|---|---|---|---|
| waiting area | `LOBBY` | `ZONE_LOBBY` | until the raid is called | boss not on screen; pill stuck on **SHOT COOLING** forever (`tick = 0`, `lastShotTick = 0`, so `0 > 1` is false) |
| muster | `MUSTERING` | `ZONE_ARENA` | **20 s** (`MUSTER_TICKS`) | **the boss is on screen, filling the top of the frame, and the trigger is dead** |
| in the fight | `FIGHTING` | `ZONE_ARENA` | 600 ms of every 800 | pill says READY, key does nothing (§1.4) |

The muster window is the worst of the three and no one has named it before. Twenty
seconds standing in front of the creature with a dead key and a HUD that says
**SHOT COOLING** is a stronger "this game is broken" signal than the lobby is.

### 1.6 One gate is mirrored on the chain and not on the client

`controls.ts` mirrors three of the chain's four shot gates: phase (`:310`),
`alive` (`:294`), cooldown (`:311`). It does **not** mirror
`slot.zone != ZONE_ARENA → WrongZone` (`shoot.rs:369`).

Reachable: a player who claimed a seat but never walked through the gate is
`ZONE_LOBBY` while the arena is `FIGHTING`. Their trigger sends a transaction every
800 ms for the rest of the match, every one refused `Custom(9)`, invisibly under
`skipPreflight`. One line, same shape as the `alive` check.

---

## 2. Why nothing is visible — the structural half

`shoot` is **hitscan**. `shoot.rs:290-325` walks the ray and lands the damage inside the
same transaction; `MAX_BULLETS = 128` is boss ordnance and a player shot never allocates
a slot in it. There is no projectile entity, on chain or on screen.

Grepped `app/src/render/*` and `app/src/ui/*`: nothing draws a player tracer, a muzzle
flash, an impact, or a damage number. `Knight.tsx` has five poses —
`rest | contactL | contactR | fallen | sil` — and none of them is a firing pose. The
only firing-adjacent art in the tree is the hit flash on `Knight.tsx:396`, which fires
when *you take* damage.

So "I cannot see anything" is literal and complete. The feature was never built. This is
why "introduce arrows" is the fix rather than a decoration on top of one.

---

## 3. The governing constraint, restated precisely

The user's hard constraint is that the ER speed must not degrade. The number they like
is **write-to-visible p50 122 ms / p95 132 ms at twenty seats**, from 14,703 samples per
row over 56,952 sends.

**That measurement is of `move`, and it does not cover `shoot` at all.** Account roles,
read off `packages/client/src/instructions.ts`:

| instruction | arena | boss | players | line |
|---|---|---|---|---|
| `movePlayer` | **READONLY** | — | WRITABLE | `:563-565` |
| `shoot` | WRITABLE | WRITABLE | WRITABLE | `:612-615` |

That single difference is the whole explanation of the finding the project already has —
*twenty seats are faster than one* — because twenty concurrent movers take `Arena` as a
shared read lock and never serialise on it. Twenty concurrent shooters serialise on
**three** exclusive write locks, two of them shared across the whole raid.

Two consequences that decide §7 and §8:

1. **`shoot` can never be as parallel as `move`.** `Boss` is where the damage lands;
   it must stay writable. Serialisation on `Boss` is intrinsic to the design.
2. **`Arena` is writable for nothing.** `fire` reads `arena.tick` and `arena.phase` and
   writes `Arena` only on the killing blow (`shoot.rs:405`, `arena.end_fight`). The ER
   publishes an `Arena` notification on every shot regardless — `subscribe.ts:279-281`
   documents it: *"`shoot` rewrites `Arena` without advancing `tick`"*. At twenty seats
   that is 25 spurious `Arena` notifications per second, each 1,160 bytes, fanned to
   every subscriber.

Therefore: **every visual in this specification is client-side. The chain change list in
§9 has exactly one entry, it is optional, and it removes work rather than adding it.**

---

## 4. D1 — the waiting-area trigger

**Decision: allow it, resolve it entirely in the browser, send nothing. And label the
absence of damage in plain words. Both, not either.**

The brief framed this as a choice — a practice shot, *or* a message saying you cannot
fire yet. It is not a choice. The dishonesty in the current build is not the silence,
it is the *ambiguity*: a key that does nothing is indistinguishable from a key that is
not bound, from a dropped packet, and from a bug. One practice arrow removes the
ambiguity about the key. One line of copy removes the ambiguity about the damage. Ship
both; each answers a question the other leaves open.

Reference image A (`waiting_area_full_vertical.png`, opened and inspected) is a stone
room with barrels, a chest, candles and scattered bones. There is plenty to shoot at
visually. **None of it exists on chain.** The practice arrow flies, hits the wall or a
prop, sticks, and fades. It changes no account, costs no CU, and takes no lock.

Rejected: relaxing `shoot.rs`'s `PHASE_FIGHTING` guard to permit a lobby shot. It would
spend an `Arena` + `Boss` + `Players` write lock and a full transaction to change
nothing, at up to 25/s across a full lobby — a real cost against the constraint in §3,
paid for a client-side animation. Rung 1 of the ladder: it does not need to exist on
chain.

### 4.1 Rules

| condition | trigger sends | trigger animates | HUD weapon line |
|---|---|---|---|
| `LOBBY` | no | **yes** — practice arrow | `PRACTICE` · *"nothing here takes damage — the raid is past the gate"* |
| `MUSTERING` | no | **yes** — practice arrow | `HOLD` · *"weapons free in `m:ss`"*, counting down `fight_at_tick - tick` |
| `FIGHTING`, cooling | no | no | `COOLING` + ring (§6.4) |
| `FIGHTING`, ready | **yes** | yes | `READY` |
| `hp == 0` | no | no | `DOWN` · *"respawn in `m:ss`"* |
| `FIGHTING`, `zone != ZONE_ARENA` | no | **yes** — practice arrow | `PRACTICE` · *"walk through the gate to join the raid"* |

The muster countdown is free and exact: `fight_at_tick` is on `Arena`, is already
decoded (`layout.ts` `ARENA.offsets.fight_at_tick`), and `heartbeat` advances `tick`
through the whole window (§1.3). Twenty seconds of dead trigger becomes twenty seconds
of a visible countdown to weapons-free, which is a completely different experience of
the same twenty seconds.

The last row is the §1.6 gate. It is a practice shot rather than a hard block because
the player is standing in the lobby watching a fight; a dead key there reads as the
same bug.

---

## 5. D2 — the arrow

One projectile design serves the practice shot, the real shot, and every remote seat's
shot. It is client-side in all three cases.

### 5.1 Geometry — the client raycast

The client can reproduce `shoot.rs::raycast` **exactly**, because every input is already
on the client and every operation is integer:

| chain | client mirror | file |
|---|---|---|
| `map::WALLS` | `isWall(x, y)` | `packages/client/src/map.ts:176` |
| `hitboxes::PART_HITBOXES` | `PART_HITBOXES` | `packages/client/src/hitboxes.ts:51` |
| `hitboxes::CORE_*` | `CORE` | `packages/client/src/hitboxes.ts:67` |
| `SHELL_AABB` | fold the same table the same way | derived, never typed |
| `boss.x/y`, `boss.parts` | `BossAccount` | `layout.ts` |
| `slot.x/y` | `predictor.self` / roster | `predict.ts` |

Both TS files are `@generated` from the same JSON in the same `gen_hitboxes.py` pass
that emits the Rust. Their headers already state the reason: *"Client-side hit
prediction that disagrees with the chain is the bug this file exists to make
impossible."* The mirror is what those files were generated for; it has simply never
been used.

**Measured.** I implemented the mirror in Node against the real `WALLS` table parsed out
of `map.rs` and the real `PART_HITBOXES` values, and swept it
(`scratchpad/ray.js`, 929,280 calls = 726 pit floor tiles × 64 uniform angles × 20 reps):

```
SHELL_AABB { x: -342, y: -384, w: 681, h: 696 }     ← matches the Rust const fold
aim from [512,560] → { kind: 'core', x: 569, y: 396, step: 11 }
calls 929280   mean steps 3.70   ns/call 408
```

- **408 ns per raycast**, V8, on this box. That is 0.0004 ms against a p50 frame of
  9.38 ms. One raycast per frame for the aim reticle costs 0.0024 % of the frame; the
  bound is not close.
- 408 ns is a **pessimistic** upper bound: my `isWall` used a `BigInt` shift because I
  parsed the `u64` rows directly. A `Number`-pair wall lookup, which is what `map.ts`
  already does, is faster.
- Mean 3.70 steps here vs. the 7.56 in `shoot.rs`'s header. Different populations, both
  honest: mine sweeps **pit stands only** over uniform angles (many aims hit an adjacent
  wall immediately); the header sweeps every floor tile aimed at the vent. Neither is
  wrong; do not conflate them.

**Precision.** `|fx|` peaks near 8.4 M (`shoot.rs`'s own overflow note). JavaScript
numbers are exact to 2^53, and `Math.trunc(a / b)` reproduces Rust's truncating integer
division for operands of this magnitude and sign. So the mirror is bit-exact, not
approximate. **Assert this in the dev self-check** — a divergence here is invisible and
would show up as "the arrow stuck in the wrong place sometimes".

### 5.2 Where prediction can be wrong, and what it costs

The mirror is exact given its inputs. Every divergence is therefore *stale input*, and
there are exactly four:

| stale input | how | worst visible effect |
|---|---|---|
| `boss.parts[i]` | another raider destroyed part `i` in the ≤132 ms since the last `Boss` notification | the arrow sticks on a limb that is already gone instead of passing through it |
| `slot.x / slot.y` | the chain raycasts from the **acked** position; `predictor.self` runs up to one 16-unit tile ahead | up to 16 units of origin offset — 1.6° at the 589-unit maximum boss range, enough to flip a graze |
| `boss.vent_open` | stale by one notification | a core hit is drawn as absorbed when it damaged, or the reverse |
| `arena.tick` | the gate mirror | none — see below |

The `arena.tick` row is not a divergence, and the reason is worth recording because it
looks like one. `controls.ts` stamps `lastShotTick = tick` from the **observed** tick,
which lags the chain by ≈1.22 ticks; it then compares a later observed tick against it.
Both the stamp and the compare read the same lagging clock, so the lag cancels
identically and the client's gate opens on the same real tick the chain's does. The
mirror is stale-invariant. **This is why the cooldown ring must be driven off the
observed tick and not off the wall clock** (§6.4).

**The resolution rule, and it is the whole safety argument:**

> **Prediction owns no number.** It places the arrow, the spark and the reticle.
> Every quantity — the damage figure, part HP, core HP, shell percentage,
> `damage_dealt` — comes only from chain state.

Under that rule a wrong prediction costs one spark a few pixels out of place for one
frame, and **no number is ever shown and then retracted**. There is no rollback path to
write, no reconciliation, no corrective animation. The cheapest correct answer is to
make the prediction unable to lie in the first place.

### 5.3 Motion

| quantity | value | derivation |
|---|---|---|
| `ARROW_UNITS_PER_SEC` | **2200** | median stand-to-core range ÷ measured p50 write-to-visible = 280 / 0.122 s = 2295; rounded down to 2200 so the arrow lands just before the truth, never after |
| flight at median boss range | **127 ms** | 280 / 2200 |
| flight at maximum boss range | **268 ms** | 589 / 2200 |
| flight at the worst terminus on the map | **291 ms** | 640 / 2200 |
| stick-and-fade | **400 ms** | see the pool bound below |
| boss bullet, for contrast | 420 u/s | `tick.rs:149`, `BULLET_UNITS_PER_SEC` |

Ranges are measured, not assumed (`scratchpad/range.py`, `scratchpad/ray.js`, over the
726 legal `ZONE_ARENA` pit stands — floor tiles inside `PIT_TOP..=PIT_BOT`):

```
range to core   min 46   p50 280   p90 480   max 589
entrance ranges to core: 458, 288, 186, 323
terminus over all pit stands × 64 angles: p90 173, p99 492, max 640
```

Note for the record: `shoot.rs`'s `WORST_RANGE = 865` is a conservative bound, not the
pit's actual reach. The furthest a legal pit stand is from the core is **589** units.
`MAX_RAY_STEPS` must still cover 865 — a ray can be aimed anywhere, not just at the
core — so the constant is correct and this is a note, not a defect.

**The arrow is 5.24× the boss bullet's speed.** That ratio is doing real work: reference
image B is a dark, cold, low-contrast room whose only bright element is the cyan core.
Incoming fire and outgoing fire must be separable at a glance in that room. They are, by
two independent channels: **speed** (2200 vs 420) and **colour** (§5.5).

At 2200 u/s and 60 Hz the arrow advances ~36.7 units per frame, which strobes if drawn
as a dot. Do not solve this twice — `Arena.tsx:715-735` already solves it for boss
bullets: *"Each is a capsule stretched back along its own velocity"*. Draw the arrow as
a shaft whose length is `max(nominal shaft, distance travelled this frame)`, same trick,
same file.

### 5.4 The pool — one node per seat, and no pool management at all

```
max flight 291 ms + stick-and-fade 400 ms = 691 ms  <  800 ms cooldown
```

A seat cannot fire again before its previous arrow has finished. **Therefore the arrow
pool is exactly `MAX_SEATS` nodes, indexed by seat.** No free list, no ring buffer, no
recycling, no allocation, no cap heuristic, no eviction policy — the seat index *is* the
node index, and it is provably always free.

This is the same ownership shape `Arena.tsx` already uses for bullets: pre-mounted SVG
nodes in a `useRef` map, written by the rAF loop with `style.transform`, React never
touching them. Extend that loop; do not add a second one, and do not put arrows in React
state — 25 shots/s across twenty seats would re-render the tree at 25 Hz.

Put a dev-only assertion on the inequality, because if `ARROW_UNITS_PER_SEC` is lowered
or the cooldown is shortened it stops holding *silently*, and the symptom is a seat's
arrow teleporting mid-flight:

```ts
assert(MAX_FLIGHT_MS + STICK_FADE_MS < SHOT_COOLDOWN_TICKS_MS,
       'one arrow node per seat is no longer sufficient');
```

**Load check.** Little's law at twenty seats: λ = 20 / 0.8 s = 25 arrows/s, W = 0.127 s
median flight → 3.2 arrows in flight on average; hard ceiling 20 in a synchronised
volley. Against the existing `VISIBLE_BULLETS = 32` cap — measured at p50 9.38 ms /
p95 14.92 ms per frame at 20 knights under 6× CPU throttle, with 13–15 bullets actually
live — twenty stretched-line nodes is a comparable and already-budgeted cost. **This is
an arithmetic estimate from the existing measurement, not a new measurement.** Re-take
the throttled frame profile after implementing; that is acceptance item 3 in §11.

### 5.5 Palette

From reference image B, opened and inspected: dark blue-grey stone, muted purple
banners, cyan braziers along the walls and pillars, and a brilliant cyan/teal orb at the
creature's chest as the only bright thing in the room.

The player's arrow must therefore be **warm — amber shaft, near-white hot tip.** A cyan
tracer would vanish into the braziers and into the boss's own ordnance. Warm against
cold is the same separation the reference art already uses for the waiting area's
torchlight against its stone, and it makes incoming fire and outgoing fire
distinguishable by hue alone even when both are on screen.

The reference art already shows shafts embedded in the creature's heads. Arrows that
stick where they hit are on-model, not an invention.

---

## 6. D3 — the feedback set

Six effects. For each: what drives it, when it appears, and what happens when a
prediction is wrong.

### 6.1 Muzzle flash and recoil — predicted, 0 ms

Fires the instant `controls.ts` accepts the trigger, before anything leaves the browser.

- **Recoil**: a WAAPI transform on the existing knight `<g>` — 60 ms out along the
  negated aim vector, 90 ms back. No new art. The five shipped poses contain no firing
  pose and this does not need one.
- **Flash**: a short warm wedge at the knight's edge along the aim vector, 80 ms,
  opacity only.

**When wrong:** it cannot be, *once §1.4 and §1.6 are fixed*. `controls.ts` will then
mirror all four chain gates — phase, alive, zone, cooldown — so an accepted trigger is
one the chain accepts. This is why the constant fix is a prerequisite and not a
side-quest: without it the flash fires on shots the chain never sees, and a muzzle flash
that lies is worse than no muzzle flash.

### 6.2 Arrow in flight — predicted terminus, 0 ms

Launched immediately along the same `(dx, dy)` sent on the wire, toward the terminus
from the §5.1 raycast. Arrives 8–291 ms later depending on range.

**When wrong:** §5.2. The arrow sticks a little off. No number moves.

### 6.3 Impact — split, and the split is the design

This is the one place where getting the ownership wrong produces a lie, so it is
specified per element:

| element | driver | timing | wrong-prediction cost |
|---|---|---|---|
| thunk spark at the terminus | **predicted** | on arrival, 8–291 ms | spark a few pixels out for one frame |
| arrow sticks / drops | **predicted** | on arrival | sticks in a destroyed limb |
| part flash on the boss | **predicted** part index | on arrival | wrong part flashes for 200 ms |
| **damage number** | **chain only** | `slot.damageDealt` delta, p50 ≈122 ms | never wrong — it is not predicted |
| part HP bar / shell % / core HP | **chain only** | already is (`Hud.tsx`) | unchanged |
| "ABSORBED" on a sealed-vent core hit | **predicted** (`Hit::Core` + `vent_open`) | on arrival | shows absorbed on a hit that damaged |

The damage number is the single most important row. It is the only element that asserts
a fact about the world, and it is the only one taken purely from chain state.

**The hit feed needs no new chain state whatsoever.** Everything required is already
decoded in `packages/client/src/layout.ts` and already delivered:

- **that a seat fired** — `slot.lastShotTick` increased (`PLAYER_SLOT.offsets.last_shot_tick = 20`)
- **for how much** — `slot.damageDealt` delta (`offset 28`)
- **in which direction** — `slot.facing` (`offset 1`), stamped by `fire` from the same
  `(dx, dy)` (`shoot.rs:380`)
- **and the previous snapshot to diff against** — `subscribe.ts:123` already passes it:
  `onPlayers(players, previous)`

So `damageDealt` advancing on the same notification that advanced `lastShotTick` is a
landed shot for exactly that much; `lastShotTick` advancing alone is a miss or an
absorbed core hit. Note that `dealt` is capped at the part's remaining HP
(`shoot.rs:389`, *"a finishing shot on a 1 HP part would score a full 40"*), so a
finishing blow legitimately shows less than 40. **Display it as it comes. Do not round
it to `SHOT_DAMAGE`** — that would be the client inventing a number, which is the exact
thing §5.2's rule forbids.

Two delivery properties this must survive, both already known:

- **Every notification is delivered twice by the Magic Router.** Dedupe on the *value*
  of `lastShotTick`, never on arrival. A seat's shot event is keyed
  `(seat, lastShotTick)` and is idempotent by construction.
- **68.4 % of `Players` notifications in a fight carry no position change.** Irrelevant
  here — this diffs `lastShotTick` and `damageDealt`, not position.
- Two shots from one seat cannot collapse into one notification window: the cooldown is
  800 ms and delivery is ≈122 ms.

### 6.4 Cooldown indicator — hybrid, and the hybrid is not optional

Two clocks, and each is used for the one thing it is good at:

- **Fill** — smooth, from a local `performance.now()` started at the accepted send.
  Required because the observed tick arrives in 100 ms jumps at irregular times and
  twice each; a ring stepping in visible chunks reads as broken.
- **Ready flip** — from `shotAllowed(tick, lastShotTick)`, the **same predicate the pump
  uses** (`controls.ts:217`), against the same observed tick. This is why §5.2 records
  that the mirror is stale-invariant: the ring and the gate must open on the same real
  tick, and driving the flip off the wall clock would break that.

**The asymmetry rule, and it is the point of the whole indicator:**

> If the local clock finishes first, hold the ring at 99 % until the predicate says
> ready. **Never show ready before the gate opens.**

Showing ready early is precisely the §1.4 defect. Showing ready a few milliseconds late
costs nothing.

Prerequisite: `Hud.tsx:96` must become the derived value. Best: export the gate
predicate from `@heartrot/client` and have `controls.ts` and `Hud.tsx` both import it —
the `ponytail:` comment at `Hud.tsx:89-95` already names that as the retirement path for
all three copies. Second best: `800 / TICK_MS - 1`, identical to `controls.ts:129`.
**Not** a literal `7`.

### 6.5 Remote seats' arrows — chain only

Every other player's shot draws from the §6.3 feed. Fire the arrow on the notification
that advances their `lastShotTick`, along their replicated `facing`.

**Honest limitation, state it and accept it:** `facing` is an octant, so a remote
arrow's angle is quantised to 45°, while the shooter's own arrow used the exact
`(dx, dy)`. The wire carries the free aim only in the instruction payload, which other
clients never see. Making remote aim exact would mean storing `(dx, dy)` on
`PlayerSlot` — two bytes, and `_pad0` is only one — for a cosmetic angle on someone
else's arrow. Not worth it. Twenty raiders' arrows converging on a boss that occupies
the top third of the screen read correctly at 45° resolution.

### 6.6 Aim reticle — predicted, every frame

The answer to *"what does the player aim at, and how do they know what they will hit?"*
Today: they do not, and cannot. The boss is a 690 × 810-unit creature
(`BOSS_SPRITE_W/H` 230 × 270 × `BOSS_SCALE` 3) made of nine parts plus a core that is
only damageable when the vent is open. Nothing on screen says which of the ten a given
aim will meet.

Run the §5.1 raycast every frame from the drawn player position along the live aim
vector, and **draw the answer, not the ray**:

| terminus | reticle | label |
|---|---|---|
| floor or wall | thin open ring | — |
| a live part | bracket sized to the part | part name + HP, from the same `Hud.tsx:52` table |
| core, vent open | filled ring, hot | `CORE` |
| core, vent sealed | crossed ring, dimmed | `SEALED` |

Plus a thin fading line from the knight to the terminus while aiming.

Cost: **one 408 ns raycast per frame** (§5.1). It is the same function the arrow
terminus calls — one implementation, two consumers.

Keyboard fire keeps aiming along `facing` (`octantAim`, `controls.ts:185`). Do **not**
snap keyboard aim to the core: that is an aimbot, and it would make the pointer strictly
worse than not using it. The reticle is what makes the 45° keyboard floor legible, which
is the honest fix for it.

One coupling to clear, flagged in `App.tsx:402-410`: `aimOrigin` computes
`box.width / ARENA_UNITS`, which is only correct while the camera is at scale 1. Its own
comment says shooting is `FIGHTING`-only so it is correct today, and calls the coupling
undocumented. **Removing the follow camera (the full-screen-fit task) makes it
unconditionally correct and is what unblocks pointer aim for the §4 practice shot.**
These two tasks must land together, or the practice shot in the lobby aims 512 units
from where the pointer is.

---

## 7. D4 — the cooldown

`ticks_for(800) - 1 = 7`, so one accepted shot per 800 ms.

**Recommendation: do not change it in this change. Fix the feedback, then measure, then
decide.** Three reasons, in the order that decides it.

**1. The complaint is not the rate.** The user wrote *"i cannot see anything"*, not
*"I cannot shoot often enough"*. 800 ms with a muzzle flash, an arrow, a thunk, a
damage number and an honest ring is a different weapon from 800 ms with nothing, and it
is not yet known which weapon they are complaining about. Tuning a number to compensate
for missing feedback is how a number ends up wrong in both directions.

**2. There is no measurement of `shoot` under load, and the constraint cannot be
honoured by guessing.** §3: the 122 ms figure is a `move` measurement, and `move` takes
`Arena` read-only where `shoot` takes three write locks. Arithmetic, clearly labelled as
arithmetic:

| cooldown | shots/s at 20 seats | `Boss`-writing tx per 50 ms ER slot |
|---|---|---|
| 800 ms (shipped) | 25 | 1.25 |
| 400 ms | 50 | 2.5 |
| 250 ms | 80 | 4.0 |

`Boss` is a single exclusive write lock shared by the entire raid, so those transactions
execute strictly sequentially. At the shipped cooldown the raid is *already* asking for
more than one serialised `Boss` write per ER slot. This is not proof of a problem — they
still land, just in order — but it is proof that the shipped rate is the wrong place to
start guessing from, and that halving it doubles pressure on the project's only
un-measured hot path.

**3. There is a structural change that would buy real headroom, and it should land
first.** See §9.

**The experiment that settles it**, and it is nearly free because §6.3 builds it: today
`App.tsx:441` calls `recordSend()` with no `seq`, so — per `metrics.ts:99-101` —
`shoot` counts toward throughput and never toward latency. But the §6.3 feed gives shots
an acknowledgement they never had: **the local seat's own `lastShotTick` advancing is
the ack.** Start a clock at the accepted send, stop it when the local seat's
`lastShotTick` changes, and `shoot` gets the same p50/p95 treatment `move` already has.
Run it at twenty seats against the shipped 800 ms to establish the baseline, then at 400.
**Then** decide, with a number.

Until that number exists, `800` stays.

---

## 8. D5 — the archer

**Recommendation: ship the archer as a fourth skin. Zero program change, zero CU, zero
account bytes, zero risk to §3.**

`skin_id` already does everything required. It is `PlayerSlot` offset 2, written
verbatim by `join` (`player.rs:575`) and **never interpreted on chain** — grepped the
whole program, its only consumers are `Knight.tsx:74/171` (which clamp it) and
`CharacterSelect.tsx`, which already exists as a pick-your-character screen with three
entries. It replicates to every client on the roster feed already.

The delta for an archer:

| change | file | kind |
|---|---|---|
| bow-and-quiver knight in the sheet | `assets/sprites/knights.svg` | art |
| re-run the generator | `tools/gen_knights.py` → `knights.gen.ts` | generated, never hand-edited |
| fourth `SKINS` entry | `app/src/screens/CharacterSelect.tsx:32` | one line |
| fourth `SKIN_COLORS` entry | `CharacterSelect.tsx:30` | one line |
| fourth `SKIN_KEY` entry | `app/src/render/Knight.tsx:164` | one line (a dev self-check at `:610` enforces one key light per skin) |
| `SKIN_COUNT = 3` → `4` | `worker/src/routes.ts:75` | one line — the Worker range-checks the claim at `:534` and would reject skin 3 with `invalid skin` |

Six edits, one of them art, none of them on chain. The projectile is already an arrow
for everyone under §5 — the archer's is a different *nock and fletching*, not a
different system.

### 8.1 If the archer must play differently

It cannot be a skin then, because damage and cooldown are chain rules. The path exists
and is cheap, and it should be written down rather than discovered later:

`PlayerSlot._pad0` at **offset 3** (`state.rs:859`, between `skin_id` at 2 and `x` at 4)
is a free byte. A `class` there costs **zero layout change and zero migration**: every
account live on devnet already carries `0` in it, so `0` must mean the default class.
The `Players` size assertion (1924) and every `offset_of!` assertion in `state.rs:905-925`
are unaffected.

What it would actually cost, honestly:

- **Chain:** one branch in `fire` selecting `(damage, cooldown)` from a two-row table.
  A handful of CU against `shoot`'s 781 CU of guards. Negligible.
- **Wire:** `join` grows from 66 bytes to 67. That is a breaking ABI change — but it is
  the *same* breaking change `shoot` already made going 3 → 4 bytes, and
  `shoot.rs:445-450` records the argument for why it is safe: program and app ship
  together and an old client gets a clean length refusal rather than a
  misinterpretation. Follow that precedent, including `05-wire-abi.md`.
- **Balance:** the real cost. A second weapon means a second time-to-kill curve against
  `core_hp_max`, which `tick.rs:608-636` already scales by raid size.

**Do not build it yet.** Build it when playtesting says one weapon feel is not enough —
that is a question the §7 measurement and the §6 feedback will answer, and answering it
first with a guess is how a balance table gets written before anyone knows what it is
balancing.

If it is built, the natural axis is not damage-per-second (a rabbit hole) but a **drawn
shot**: hold to draw, release to fire, longer cooldown, more damage, and the draw is
visible to every other player through the recoil pose. That is a distinct *feel*, which
is what the user asked for, rather than a distinct number.

---

## 9. The chain change list

**One entry, and it is optional.**

> **Drop `Arena` to `READONLY` in `shoot`.**

`fire` writes `Arena` only through `arena.end_fight(OUTCOME_WIN)` on the killing blow
(`shoot.rs:405`). That call is **already redundant**: `tick.rs:861-872` evaluates

```rust
let outcome = if boss.core_hp == 0 { OUTCOME_WIN } else if … };
if outcome != OUTCOME_UNDECIDED { arena.end_fight(outcome); }
```

unconditionally on every `FIGHTING` tick, and `end_fight` is idempotent — `shoot.rs:398-404`
says so in as many words, and `tick.rs:856-860` says so from the other side:
*"when `shoot` recorded the win 200 ms ago this call changes nothing"*. It is also
already covered by a passing test (`tick.rs:1625-1628`, *"a dead core is a win"*).

What removing it costs: the win is recorded on the next crank tick instead of in the
killing transaction. **≤100 ms of latency on the victory screen, once per match.**

What it buys:

1. `shoot` stops taking an exclusive lock on the account the whole raid subscribes to.
   `Boss` and `Players` remain writable, so shots still serialise — but on two locks
   instead of three, and no longer against the crank's `Arena` write.
2. **25 spurious 1,160-byte `Arena` notifications per second stop being fanned to twenty
   subscribers** at a full raid (`subscribe.ts:279-281`). That is bandwidth and decode
   work removed from every client on the critical path, which is the §3 constraint
   pointing the same way for once.

Both effects are *expected*, from reading the account roles and the ER's publish
behaviour. **Neither is measured.** Whether the ER publishes on the write lock or on
actual mutation should be confirmed on devnet before the second claim is repeated. If it
publishes only on mutation, benefit 2 evaporates and benefit 1 stands.

This change is **not required** by anything else in this document. §4–§8 are entirely
client-side. It is listed here because it is the only lever on `shoot` throughput that
does not cost anything, and because §7 should not be re-litigated without it.

### 9.1 Explicitly not changing

- `SHOT_COOLDOWN_TICKS` — §7.
- `SHOT_DAMAGE` — no evidence it is wrong; time-to-kill is `core_hp`'s job
  (`tick.rs:608`).
- `MAX_BULLETS`, the bullet pool, `boss_tick`'s swept-collision loop — **player arrows
  never enter the pool.** Twenty raiders add exactly zero bullets, exactly as
  `shoot.rs`'s header already promises. `boss_tick`'s 24,884 CU of 399,700 at twenty
  players is untouched by everything in this document.
- `MAX_RAY_STEPS`, `WORST_RANGE`, the hitbox tables, `gen_hitboxes.py`,
  `gen_map.py` and all generated output.
- `MOVE_MS`, `MIN_GAP_MS`, the prediction/interpolation split, the blockhash cache.

---

## 10. Client change list

Ordered. The first two are prerequisites for everything after them, because a muzzle
flash on a shot the chain refuses is worse than no muzzle flash.

1. **`app/src/ui/Hud.tsx:96`** — `SHOT_COOLDOWN_TICKS = 1` → the derived value.
   Preferably by exporting the gate predicate from `@heartrot/client` so all three
   copies retire together, as that constant's own `ponytail:` comment proposes. **This
   is the live bug (§1.4) and it is a one-line fix.**
2. **`app/src/input/controls.ts`** — mirror the zone gate (§1.6); allow the trigger to
   animate outside `FIGHTING` without sending (§4), by separating "may animate" from
   "may send" in the `pump` fire branch.
3. **`packages/client/src`** — the raycast mirror (§5.1), beside the generated tables it
   reads, with the bit-exactness self-check. One pure function; two consumers.
4. **`app/src/render/Arena.tsx`** — twenty seat-indexed arrow nodes in the existing rAF
   loop (§5.4), layered **above the boss group and below the knights** so a hit on the
   creature is visible and the player still reads on top. Muzzle flash and recoil on the
   knight group (§6.1). Aim reticle (§6.6).
5. **`app/src/App.tsx` / `app/src/net`** — the shot-event diff on
   `onPlayers(players, previous)` (§6.3), keyed `(seat, lastShotTick)`. Shot latency
   sampling (§7).
6. **`app/src/ui/Hud.tsx`** — the §4.1 weapon-state table, the muster countdown, the
   cooldown ring (§6.4). Also correct the stale copy at `Hud.tsx:379`: *"One move per
   tick, one shot per two"* — it is one shot per **eight** ticks at `TICK_MS = 100`.
   Same 400 ms-era drift as the constant above it.
7. **The archer skin** — §8.

---

## 11. Acceptance

1. In the waiting area, space produces an arrow that flies, sticks and fades, and the
   weapon line reads `PRACTICE` with the reason. Zero transactions are sent — confirm on
   the network tab, not by inspection.
2. During muster the weapon line counts down `fight_at_tick - tick` to zero and flips to
   `READY` on the tick the arena flips to `FIGHTING`.
3. In a fight at twenty seats under 6× CPU throttle, the frame profile is re-taken. It
   must not regress past the shipped p50 9.38 ms / p95 14.92 ms by more than one
   millisecond at p95.
4. The **SHOT READY** pill flips on the same tick `controls.ts` will send, in a
   scripted-tick dev harness. It must never flip early.
5. Every damage number displayed is traceable to a `slot.damageDealt` delta. Grep the
   diff for any client-side arithmetic producing a damage figure; there must be none.
6. A shot is fired within one notification window of a part being destroyed by another
   raider, and the arrow sticks in the wrong place. Confirm **no number is retracted**
   on screen.
7. Shot write-to-visible p50/p95 at twenty seats is measured and recorded — the number
   §7 is waiting on, and the first one this project has ever had for `shoot`.
8. `cargo test -p heartrot` reads `94 passed` on the unit line, or higher with new
   tests. Read it with
   `cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"`; the
   doc-test line reads `0 passed` and is not the one that matters.

---

## 12. What was not measured

Stated so nobody inherits an estimate as a fact.

- **`shoot` write-to-visible latency, at any seat count.** It has never been measured.
  The 122/132 ms figure is `move`. §7 hangs on this and §11.7 is how to get it.
- **The frame cost of twenty arrow nodes.** §5.4's 3.2-in-flight figure is Little's law
  over the existing bullet profile, not a new profile run.
- **Whether the ER publishes an account update on the write lock or on actual
  mutation.** §9's second benefit depends on it; `subscribe.ts:279-281` implies the
  former, but implication is not measurement.
- **CU cost of the `_pad0` class branch (§8.1).** Not built, not measured, correctly
  described as negligible only relative to `shoot`'s 781 CU of guards.
- The 408 ns/raycast and the range distributions **were** measured, in Node on this box,
  by `scratchpad/ray.js` and `scratchpad/range.py`. They are V8 numbers, not browser
  numbers, and every browser figure in this project came from one machine — the jitter
  tail is what is not measured here either.
