# HEARTROT — The Gate Transition

**Date:** 2026-09-02
**Status:** Specification. Nothing here is implemented.
**Reads against:** `programs/heartrot/src/handlers/player.rs` (`enter_gate`),
`programs/heartrot/src/handlers/tick.rs` (`entrance_for`), `programs/heartrot/src/state.rs`
(the phase machine), `app/src/App.tsx`, `app/src/state/store.ts`,
`app/src/screens/Gate.tsx`, `app/src/render/Arena.tsx`, `app/src/render/Spawn.tsx`,
`app/src/net/predict.ts`, `app/src/net/subscribe.ts`, `packages/client/src/map.ts`.
**Governed by:** `07-animation.md` — §3.2 layer stack, §3.3 `transform-box`, §4.4 the
resync gate, §4.6 WAAPI one-shots, §4.7 the rule, §5.2/§5.3 reduced motion, §6.2 what must
never go on chain, §6.3 durations. This document adds no rule to that one; it applies it.
**Extends:** `08-gate.md` §5 (the muster) and `Spawn.tsx`'s existing beat. It does not
replace either.

---

## 0. How the numbers here were produced

Baseline, run before anything below was written:

```
$ cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"
running 94 tests
test result: ok. 94 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.15s
running 1 test
test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

94 unit tests. The second pair of lines is the doc-test summary and is not the number that
matters.

Every geometric figure below is computed from the generated map table
(`packages/client/src/map.ts`) and the two spawn formulas in the program, by the script in
§1.3. Every frame-cost figure is from the harness in §9.2, whose limits §9.3 states
plainly. Figures carried in from earlier work are attributed where they are used and are
not re-derived.

---

## 1. What actually happens today

### 1.1 The world is already two rooms, and the map says so

`MAP_GRID` in `packages/client/src/map.ts` is 64×64 tiles at `MAP_TILE = 16` units. Read
by row:

| rows | tiles | world y | what it is |
|---|---|---|---|
| 0–23 | `.` | 0–383 | dead space above the arena. No player may stand here. |
| 24–35 | `P` | 384–575 | the boss arena floor, tapering: row 33 is 58 tiles wide, row 34 is 54, row 35 is 48 |
| 25 | `B` at col 32 | 400 | `BOSS_SPAWN = (512, 400)` |
| 32 | four `E` marks at cols 10, 22, 42, 54 | 512 | `MAP_ENTRANCES` |
| 36–37 | `P`, cols 30–33 only | 576–607 | the throat: a 4-tile-wide neck |
| 38–39 | `G`, cols 30–33 | 608–639 | the gate block. `GATE_MIN_X` 480, `GATE_MAX_X` 543, `GATE_MIN_Y` 608, `GATE_MAX_Y` 639 |
| 40–62 | `.` with pillar pairs | 640–1007 | the waiting room |

`Scene.tsx:176` already names the same split: *"the pit y 384..607, the gate y 608..639,
the temple approach y 640..1007."*

**The shipped geometry already matches the two reference images.** In
`waiting_area_full_vertical.png` the portcullis is at top centre of the room; in the map
the gate block is at x 480–543 on a 1024-wide world, whose centre is 512 — dead centre —
at the room's north edge. In `actual_boss_arena.png` the steps descend at bottom centre and
the boss sits top centre; in the map the throat is at x 480–543 at the arena's south edge
and the boss is at (512, 400), the arena's top centre. Walking north out of room A arrives
at the bottom of room B. Nothing about the passage needs the map to change.

### 1.2 `screenOf` already switches rooms, on the right fact

```ts
// app/src/state/store.ts:447
export function screenOf(state: State): Screen {
  if (!state.authenticated) return 'onboarding';
  if (!state.match) return 'select';
  return mySeatSlot(state)?.zone === ZONE_ARENA ? 'arena' : 'lobby';
}
```

One chain fact, one router, no local flag. `Gate.tsx`'s module header already forbids
adding a screen between the two: *"a fifth screen wedged in between would have to be
entered and left on a chain fact that already moves you, i.e. it would be a second router
disagreeing with the first."* This specification does not add one.

The renderer survives the switch. `App.tsx:153` mounts `<div id="stage">` in its own child
slot whenever `screen` is `'lobby'` or `'arena'`, and `<World host={…} link={link} />` at
line 159 is a **sibling of the screen switch**, portalling into that node. The comment at
line 130 states the intent: *"`hasStage` is a separate child slot, so lobby↔arena never
changes its position."* So `render/Arena`, its rAF loop, its predictor and its
subscription do not unmount when you pass the gate. **An animation living inside the
renderer spans both rooms without any special case.** This is the single fact that makes
the whole beat cheap.

### 1.3 The passage is a teleport, and it is a big one

This is the headline finding and it is not cosmetic.

`enter_gate` does not walk you through the gate. It moves you:

```rust
// programs/heartrot/src/handlers/player.rs, enter_gate
let (x, y) = crate::handlers::tick::entrance_for(seat);
slot.zone = ZONE_ARENA;
slot.x = x;
slot.y = y;
```

`entrance_for` puts seat `s` at `MAP_ENTRANCES[s % 4]`, fanned along the axis nearer a
wall. All four `E` marks sit at y 512, whose distance to the nearer y edge is 512 — the
maximum possible — so `fans_along_x` is false for all four and every seat fans **along y**
by `(s/4 - 2) * ENTRANCE_SPACING`, `ENTRANCE_SPACING = 24`.

Computed with `python3` from `MAP_ENTRANCES`, `MAX_SEATS = 20`, `ENTRANCE_SPACING = 24` and
the gate block's centre (511, 623):

| seat | lands at | distance from the gate |
|---|---|---|
| 0 | (160, 464) | 385.3 units — 24.1 tiles |
| 3 | (864, 464) | **387.2 units — 24.2 tiles (the worst)** |
| 9 | (352, 512) | 193.9 units — 12.1 tiles |
| 17 | (352, 560) | **171.0 units — 10.7 tiles (the best)** |

Every seat, without exception, is thrown between **10.7 and 24.2 tiles** — up to 37.8% of
the map's width, sideways — in zero frames. Entrance y ranges 464–560; the gate is at
y 608–639.

Both renderers already treat this as the teleport it is, and both snap:

- `sprites.ts:50`: `SELF_SNAP = 4 * MAP_TILE` = 64 units. `Arena.tsx:219`'s `chase` snaps
  when `d > SELF_SNAP`. The **shortest** gate jump is 171 units, 2.7× the threshold, so the
  local knight snaps every time.
- `predict.ts:391`: `teleported()` returns true on `from.zone !== to.zone` outright, so
  every remote seat snaps too.

**So the passage today is a hard cut with nothing over it.** You stand on a portcullis at
the bottom centre of the room and one frame later you are at a side door two-thirds of the
way across the map. At `MOVE_MS = 50` per tile that jump is 1,209 ms of walking, delivered
in 0 ms.

That is what the animation is for. It is not decoration over a working transition; it is
the only thing that can make an existing 24-tile teleport legible.

### 1.4 What is already built and must be extended, not replaced

`app/src/render/Spawn.tsx` is a finished, correct one-shot on the
`PHASE_MUSTERING → PHASE_FIGHTING` edge: the cavern dims, the boss's eyes and core ignite,
the pit rim catches the glow, 1,200 ms, `pointer-events: none`, skippable, off under
reduced motion. Its trigger is the pattern this document reuses verbatim:

```ts
export function spawnFires(prev: number | null, next: number): boolean {
  return prev !== null && prev !== next && next === PHASE_FIGHTING;
}
```

### 1.5 One latent defect in that trigger, which this work should fix in passing

`Spawn.tsx` has no resync gate. `07-animation.md` §4.4 requires one and gives the measured
reason: a reconnect is **1,681 ms**, four crank ticks, and `prev` is stale across it. The
component does not unmount on a reconnect (§1.2), so `prev` survives the outage. A player
who drops during `PHASE_MUSTERING` and returns during `PHASE_FIGHTING` gets the opening
cinematic replayed over a fight already in progress.

The passage beat has the identical exposure and a worse consequence — it holds the local
knight (§5). §4 fixes both with one store field. This is the root-cause fix: one gate, in
the one place both readers get it from.

---

## 2. Two beats, two chain edges

The brief asks for one animation; the chain offers two distinct facts and they happen at
different times, to different audiences. Conflating them produces a cinematic that fires
twenty times or one that fires at the wrong moment.

| | **Beat P — the passage** | **Beat S — the waking** |
|---|---|---|
| chain edge | `mySeatSlot.zone`: `ZONE_LOBBY → ZONE_ARENA` | `Arena.phase`: `PHASE_MUSTERING → PHASE_FIGHTING` |
| written by | `enter_gate` (tag 5), `player.rs` | `Arena::begin_fight`, called from `boss_tick` at `fight_at_tick` |
| audience | per seat, at that seat's own moment | all twenty, on the same tick |
| spread | up to `MUSTER_TICKS × TICK_MS` = 20,000 ms | simultaneous |
| what it shows | portcullis up, room A swallowed, room B revealed cold, boss seen top centre for the first time | the boss ignites — eyes, core, rim |
| owner | **new: `app/src/render/Passage.tsx`** | **existing: `app/src/render/Spawn.tsx`** |

The user's request maps across both, and the split follows the images rather than a
preference. Room A is warm torchlight; room B is cold teal. **The light changing from warm
to cold is a change of room, so it belongs to Beat P.** The boss being *revealed* is also
Beat P — it is when you first see room B. The boss *waking* is Beat S, and `Spawn.tsx`
already draws exactly that.

They can overlap. A knight who reaches the gate on the last tick of the muster fires both
within ~100 ms. §3.4 gives the layer order that resolves it.

### 2.1 "Driven by the chain so twenty clients see it together"

Beat S is literally simultaneous: one `Arena` write, one `fight_at_tick`, twenty clients.

Beat P is per seat, and that is correct rather than a compromise. When seat 7 passes the
gate, **all twenty clients consume the same `Players` payload**: seat 7 renders it in first
person, the nineteen others render seat 7 leaving room A or arriving in room B. One chain
write, one moment, twenty consistent views. Nothing here is triggered by a click, a timer,
a local prediction or a Worker round trip.

Two things follow, and both save work:

- **Remote seats need no code at all.** `predict.ts:391` already snaps a seat on
  `from.zone !== to.zone`. From room A, seat 7 vanishes at the gate — they left the room.
  From room B, seat 7 appears at a door — they walked in. Both are correct with zero
  additions. Only the *local* view spans both rooms, so only the local view has a problem.
- **The one thing worth adding for observers** is that room A should acknowledge a
  departure rather than blinking a knight out of existence. §3.5 spends one WAAPI one-shot
  on a node the beat already owns, and touches no seat node.

---

## 3. Beat P, choreographed

### 3.1 The two forms, and why there are exactly two

`enter_gate` calls `assert_playable`, which admits **exactly three phases**:

```rust
// programs/heartrot/src/handlers/player.rs:488
fn assert_playable(phase: u8) -> Result<(), ProgramError> {
    if phase == PHASE_LOBBY || phase == PHASE_MUSTERING || phase == PHASE_FIGHTING {
```

So a player can walk the gate while the boss is firing, and a 1,100 ms occlusion at that
moment is a bug by the brief's own standard: *a cinematic that eats the first second of a
fight is a bug.*

That enumeration makes the beat's two forms exhaustive rather than a default plus a
special case — `LOBBY` and `MUSTERING` take the long form, `FIGHTING` takes the short one,
and there is no fourth phase in which the beat can open:

```ts
/** The muster: nothing is shooting and the bullet pool is empty. Take the time. */
const PASSAGE_MS = 1100;
const COVER_MS = 460;

/** Entering a fight already in progress. Cover the snap and get out of the way. */
const PASSAGE_LIVE_MS = 320;
const COVER_LIVE_MS = 140;
```

Where these numbers come from — `07-animation.md` §6.3 permits cosmetic durations to be
client constants ("a 2.6 s breath, a 180 ms recoil") and forbids them on chain, so these
are constants, not `ticks_for` derivations. They are not arbitrary:

- **`PASSAGE_MS = 1100`** is within 10% of the 1,209 ms the chase would take to walk the
  worst teleport (§1.3: 387.2 units at `MAP_TILE` per `MOVE_MS`). The beat lasts about as
  long as the walk it stands in for.
- **`COVER_MS = 460`** is 9.2 tiles of walking, against a throat that is 4 tiles deep
  (rows 36–39). Generous, not stingy.
- **`COVER_LIVE_MS = 140`** is one write-to-visible round trip (measured p50 122 ms,
  p95 132 ms, carried in from the perf work). A mid-fight entrant is blind for no longer
  than the network already blinds them.
- **`PASSAGE_LIVE_MS = 320`** is 10% of one volley period
  (`VOLLEY_INTERVAL_TICKS` = 32 ticks × `TICK_MS` 100 = 3,200 ms). The real constraint is
  the ceiling: the beat must end far enough inside one volley period that a player cannot
  lose a telegraph inside it. 320 ms is the choice; 3,200 ms is the ceiling it respects.

Selection rule, read once when the beat opens and never re-read:

```ts
const live = phaseAtOpen === PHASE_FIGHTING;
```

Not `phase` from a later render. A muster that ends *during* a passage must not shorten a
beat already running — a beat that changes length mid-flight is a hitch, and `.finished`
would resolve against a duration nothing agrees on.

### 3.2 The long form, sub-beat by sub-beat

Times are offsets into `PASSAGE_MS`.

**0–180 ms — the portcullis lifts.** `#gate-portcullis` (room A's iron grid over the gate
block, owned by the scene) translates up by its own height, 32 units — `GATE_MAX_Y -
GATE_MIN_Y + 1` from the generated table, never a literal. `ease-out`. Simultaneously the
red BOSS FIGHT sign above the arch goes from its resting dim to full and the two braziers
flanking it flare — `opacity` only. This is the last moment room A is the room.

*`transform-box` (§3.3 of `07-animation.md`): a pure translate is unaffected and needs
neither `transform-box` nor `transform-origin`. The portcullis lift is a pure translate.
The core bloom below is not, and carries both.*

**0–230 ms — the mouth darkens.** A full-viewport `<rect>` filled with a static
`<radialGradient>` centred on the gate block's centre — `((GATE_MIN_X + GATE_MAX_X + 1) /
2, (GATE_MIN_Y + GATE_MAX_Y + 1) / 2)` = (512, 624) — opaque `VEIL` at the centre falling
to transparent at the room's edge. `opacity` 0 → 1, `ease-in`. The dark blooms out of the
arch; it does not fade in flat.

**115–460 ms — the swallow completes.** A second full-viewport `<rect>`, flat `VEIL`,
`opacity` 0 → 1, `ease-in`. By 460 ms the screen is opaque.

**460 ms — the cut.** Three things happen on one callback (§6):
1. the renderer's active room flips A → B,
2. `holdSelf` clears,
3. the reveal starts.

**460–840 ms — room B comes up.** The flat veil `opacity` 1 → 0, `ease-out`.

**460–780 ms — the light opens from the steps.** A third full-viewport `<rect>` with its
own radial gradient, this one centred on the throat mouth at room B's south edge —
`(512, PIT_BOT)` = (512, 607) — `opacity` 1 → 0. The arena resolves outward from the place
you walked in.

**460–1100 ms — warm to cold.** A `<rect>` covering the arena floor, filled with the
teal sampled from the reference (`#183a44`, the orb halo in `actual_boss_arena.png` at
(543, 290)), `opacity` 0.5 → 0, `linear`. The first sight of room B is bluer than its
resting state and settles into it, so the temperature change reads as a settle rather than
a switch.

**560–1100 ms — the boss is seen.** One `<circle>` at `CORE_WORLD` — already computed in
`Scene.tsx:258` as `{ x: BOSS_SPAWN[0] + CORE.x, y: BOSS_SPAWN[1] + CORE.y }`, never
retyped — radius `CORE_R * 3` where `CORE_R = Math.round(Math.sqrt(CORE.radiusSq))`, the
same derivation `Spawn.tsx` already uses. `transform: scale(0.4) → scale(1.15)`,
`opacity` 0 → 0.35 → 0. Carries `transform-box: fill-box; transform-origin: center`
(§3.3 — without it the scale origin is the view-box corner and the bloom lands somewhere
the boss is not).

**The boss does not move and nothing in this beat moves it.** The bloom is a transient
light drawn over the boss rig, exactly as `Spawn.tsx`'s flare is. `Boss.x`/`Boss.y` are
written by `init` and by nothing else; the creature stands at (512, 400) — top centre —
from `init` onward.

### 3.3 The short form

Sub-beats 2 and 3 only, at `COVER_LIVE_MS` and `PASSAGE_LIVE_MS - COVER_LIVE_MS`. No
portcullis lift — during a fight the camera is not on the arch and lifting it costs a node
nobody is looking at. No teal settle: room B is already the room the player was watching
from the other side. No core bloom: the boss is mid-volley and a decorative flare on it is
indistinguishable from a telegraph, which is a safety problem, not a taste one.

### 3.4 Node ownership and layer order

Per `07-animation.md` §3.2, one writer per node, named:

```
<g id="passage">          nothing. A static container.        ← React, once
  <rect class="veil-mouth-a">  opacity  ← Passage.tsx WAAPI. ONLY.
  <rect class="veil-flat">     opacity  ← Passage.tsx WAAPI. ONLY.
  <rect class="veil-mouth-b">  opacity  ← Passage.tsx WAAPI. ONLY.
  <rect class="wash-cold">     opacity  ← Passage.tsx WAAPI. ONLY.
  <circle class="core-bloom">  opacity + transform  ← Passage.tsx WAAPI. ONLY.
                               + transform-box: fill-box; transform-origin: center
```

`#gate-portcullis`, `#gate-sign` and the two brazier nodes are room A's, drawn by the
scene. `Passage.tsx` plays a WAAPI one-shot on them and never sets an attribute or an
inline style on them — §3.1's two-writer failure is silent and this is where it would
happen. If the scene ever animates the portcullis itself (an idle sway), that is a second
writer and the lift must move into a dedicated child node.

`<Passage>` mounts as the **last** child of the scene root, after `<Spawn>`. When both
fire — a knight passing the gate on the muster's final tick — the passage veil is over the
waking flare, which is correct: you are in the tunnel, you do not see it yet.

### 3.5 What the nineteen others see

Room A, on **any** seat's `zone` flip — not only your own — plays one 260 ms one-shot on
the arch: the portcullis lifts and drops, the sign pulses. `opacity` and one translate, on
nodes `Passage.tsx` already owns from §3.4, and no seat node is touched.

Without it a knight blinks out of existence at the gate and nineteen people watch it
happen up to twenty times during a muster. With it, room A has a reason to look alive
during the twenty seconds the game spends there. It is the same diff, the same trigger
predicate applied to every seat instead of one, and it costs two keyframe lists.

---

## 4. Firing exactly once

### 4.1 The predicate

Same shape as `spawnFires`, and exported for the same reason — every way it fails is
silent:

```ts
/** Does this payload open the passage? */
export function passageFires(prev: number | null, next: number): boolean {
  return prev !== null && prev !== next && next === ZONE_ARENA;
}
```

Three properties, each load-bearing:

- **`prev !== next` handles duplicate delivery.** The Magic Router delivers every
  notification twice and 68.4% of `Players` frames in a fight carry no position change. A
  duplicate diffs to nothing. This is `07-animation.md` §4.4's general property — *a diff
  against the last consumed payload is inherently idempotent under duplicate delivery* —
  and it needs no latch, no counter and no bookkeeping.
- **`prev !== null` handles the mid-fight join.** A client whose first-ever payload shows
  `ZONE_ARENA` joined a raid in progress and must not replay its opening.
- **`next === ZONE_ARENA` handles the reverse.** `ARENA → LOBBY` happens: `enter_gate` is
  one-way and `gate_refusal` refuses the reverse call, but `begin_next_incarnation` resets
  every slot to `ZONE_LOBBY` for the next match. That is a return to the waiting room, not
  a passage, and it is silent.

### 4.2 The resync gate, which `passageFires` alone does not give you

`prev` survives a reconnect, because §1.2 established that the renderer does not unmount.
Measured outage: 1,681 ms. Drop in room A, return in room B and the beat fires — holding
your knight (§5) over a fight you are already losing.

`07-animation.md` §4.4 prescribes a `synced` ref set false whenever `health` leaves
`'live'`. The signal exists: `subscribe.ts` calls `setHealth('connecting')` in both
`connect()` and `ws.onclose`, and `App.tsx:619` already receives it in `onHealth`.

**Do not read `state.status` for this.** `store.ts:415` forces `status` to `'live'` on
every account update unless it is in `HELD`, so the payload you need to suppress is the
same payload that repairs the status. The gate would race the thing it gates.

The fix, one integer:

```ts
// state/store.ts — State
/** Bumped whenever the world feed drops. Consumers reset their diff baselines on a change. */
feedEpoch: number;

// App.tsx, inside the existing onHealth callback
onHealth: (health) => {
  if (health !== 'live') store.bumpFeedEpoch();
  …existing lines unchanged…
},
```

and in the consumer:

```ts
const prev = useRef<number | null>(null);
const epoch = useRef(feedEpoch);
useEffect(() => {
  if (epoch.current !== feedEpoch) {   // the feed dropped: this payload is not a diff
    epoch.current = feedEpoch;
    prev.current = zone;
    return;
  }
  const was = prev.current;
  prev.current = zone;
  if (!reduced && passageFires(was, zone)) open(zone);
}, [zone, feedEpoch, reduced]);
```

Setting `prev.current = zone` rather than `null` re-arms on the *next* payload rather than
suppressing two. Suppressing exactly one payload after recovery is §4.4's requirement.

**`Spawn.tsx` takes the same three lines against `phase`.** One store field, both readers,
one concept. That is the §1.5 defect closed at its root rather than at one caller.

StrictMode is covered with no special case: a dev remount resets both refs, so the first
payload after it is suppressed by `prev === null`.

---

## 5. The hold — how a 24-tile teleport gets covered

### 5.1 The problem the ordering creates

The payload that flips `zone` is the same payload that carries the new `x`/`y`. Start the
beat on that payload and the knight has already snapped 171–387 units before frame 1 of the
veil draws at `opacity: 0`. **The animation would be laid over a snap it arrived too late
to hide.**

Two ways out, and one of them is wrong.

**Rejected — start the beat early on local prediction.** The frame loop already computes
`onGate(at.x, at.y)` every frame for the under-foot light, and `useGateEntry` knows it has
a send in flight, so the beat could open before the chain answers. The lead time is the
round trip (p50 122 ms) plus up to `GATE_RETRY_MS` = 500 ms of poll latency before the send
even leaves — 122 to 632 ms, wildly variable, sometimes effectively zero. Worse, it makes a
cinematic fire on a local guess: `enter_gate` is sent with `skipPreflight` and a refused
send returns a signature, so the portcullis would rise, the room would go black, and
nothing would have happened. It also contradicts the brief's own requirement that the chain
drives the beat.

**Adopted — hold the drawn position under the cover.** The rAF loop already owns
`drawn.current` and is already the only writer of the local seat's node. Give it one
boolean:

```ts
// inside the existing frame(), replacing the local-seat block's chase
const el = selfNode.current;
if (el !== null && predictor !== undefined) {
  if (hold.current) {
    // The passage veil is over the knight and the authoritative position is a doorway
    // 171-387 units away (docs/architecture/15-gate-transition.md §1.3). Drawing it now
    // is exactly the snap the veil exists to hide. Hold the last drawn transform; the
    // null below makes the next unheld frame PLACE rather than chase.
    drawn.current = null;
  } else {
    …the existing chase, unchanged…
  }
}
```

`drawn.current = null` is the idiom `selfRef` already uses — *"A new node starts where the
prediction is; chasing from wherever the last one stopped would drag the knight in from the
old seat's position."* On release, `at === null` seeds from `predictor.self` and the knight
is **placed** at the door, not walked to it.

This adds no writer. The loop is still the only thing that touches that node; it skips a
frame's worth of work while the screen is black. It requires no prediction, no timer, no
chain change, and it cannot lie, because it is downstream of the same payload that fired
the beat.

### 5.2 Input is never held

The hold freezes one node's *drawn* position for ≤460 ms. It does not touch:

- `attachControls` — `controls.ts:374` binds `keydown`/`keyup`/`blur` to `window`, and
  every node in §3.4 carries `pointer-events: none`, so pointer aim still reaches
  `cfg.surface`. The beat never calls `preventDefault` or `stopPropagation`.
- `predictor.push` — inputs during the cover step the prediction from the *new* arena
  position. Holding W through the passage means you emerge already walking. That is
  correct and must not be suppressed.
- `sendInstructions` — nothing in any send path awaits the beat.
- `screenOf` — the React screen, the HUD and the roster swap on the payload exactly as
  today. Only the *picture* lags: 460 ms in the long form, 140 ms in the short one. The
  alternative, delaying `screenOf`, would put a cinematic inside the router, which
  `Gate.tsx`'s header forbids in terms. The panel telling you you are in before the picture
  shows it is the correct trade.

### 5.3 The hold must be impossible to leak

A hold that never clears is a knight frozen for the rest of the match, and it is the one
genuinely dangerous failure mode of this design. Three independent releases:

1. `cover.finished` clears it (§6) — the normal path.
2. The effect cleanup clears it **unconditionally**, so an unmount, a re-render that tears
   the beat down, an incarnation reset or a `settle` mid-passage all release it.
3. A wall-clock ceiling in the frame loop, which already has `performance.now()`:

```ts
// ponytail: a 1 s ceiling, not a state machine. WAAPI pauses on a hidden document, so a
// player who tabs out mid-passage could otherwise hold past the tab's return. Raise it
// only if COVER_MS ever exceeds it.
const HOLD_CEILING_MS = 1000;
if (hold.current && now - heldSince.current > HOLD_CEILING_MS) hold.current = false;
```

`HOLD_CEILING_MS` is 2.2× the longest legitimate cover (460 ms), so it never fires on a
healthy path and always fires on a broken one.

---

## 6. The cut, and how it stays glued to the veil

The beat has one discrete instant — the swap — and it must land exactly when the screen is
opaque. Early and the room changes in plain sight; late and the player stares at black.

Chain it to the cover animation's own completion, not to a timer:

```ts
const cover = veilFlat.animate(
  [{ opacity: 0 }, { opacity: 1 }],
  { duration: live ? COVER_LIVE_MS : COVER_MS, easing: 'ease-in', fill: 'forwards' },
);
live_.push(cover);

cover.finished
  .then(() => {
    setRoom(ZONE_ARENA);      // the renderer's active room. See §7.
    hold.current = false;
    live_.push(...reveal());  // the second half; pushes so a later skip finishes it too
  })
  .catch(() => {});           // rejects on cancel; that is the beat being called off
```

A `setTimeout` would drift from the animation under a throttled tab, because timers and
WAAPI are throttled by different mechanisms. `cover.finished` cannot drift from the veil
because it *is* the veil. `.catch(() => {})` is required: `.finished` rejects on `cancel()`,
which is not an error — it is the cleanup path, and §5.3's rule 2 has already released the
hold by then.

**Skip.** `Spawn.tsx`'s model exactly, because its end state is "gone" and so is this one —
finishing early *is* skipping:

```ts
const skip = () => { for (const a of live_) a.finish(); };
addEventListener('pointerdown', skip, { passive: true });
addEventListener('keydown', skip, { passive: true });
```

Skipping during the cover finishes `cover`, which resolves `.finished`, which performs the
swap and starts the reveal — whose animations `reveal()` pushes into the same `live_` array.
A second `skip` finishes those. `finish()` on an already-finished animation is a no-op, so
the double-fire is harmless and needs no guard. There is exactly one way out and no second
path to get wrong.

**The player who skips still lands correctly**, because the swap and the hold release are
on `cover.finished` rather than on wall-clock time.

---

## 7. What the renderer must expose, and it is one value

This is the entire coupling between this beat and the two-room scene work. Stated as a
contract so it cannot be misread:

> **The renderer's active room is not `mySeatSlot.zone`. It is a `room` value that
> `Passage.tsx` owns.** It follows `zone` immediately whenever no beat is playing, and at
> `cover.finished` when one is.

Two consequences the scene work must honour:

- **Remote seats are filtered on `slot.zone === room`.** A seat that flips while you are
  mid-passage is drawn in whichever room you are currently showing, which is correct: you
  cannot see room B yet.
- **The local seat is drawn in `room`, never in `slot.zone`.** During the hold your own
  slot says `ZONE_ARENA` while the picture is still room A. Filtering the local seat on
  `slot.zone` would remove your own knight from the screen for 460 ms, which is the exact
  defect class the current code already carries a comment about (`Arena.tsx:802`: filtering
  to `ZONE_ARENA` *"drew an empty room for the whole of the lobby, which is the one phase
  where you have to be able to see yourself to play"*).

Nothing else in the renderer needs to know the beat exists.

`ARENA → LOBBY` (the incarnation reset, §4.1) sets `room` directly with no beat.

---

## 8. What this needs on chain: nothing, and 0 CU

### 8.1 Every fact the beat reads already exists

| the beat needs | field | offset | account | exists |
|---|---|---|---|---|
| that this seat passed the gate | `PlayerSlot.zone` | 0 | Players | yes |
| where it landed | `PlayerSlot.x`, `.y` | 4, 6 | Players | yes |
| long form or short | `Arena.phase` | 3 | Arena | yes |
| that the muster is running | `Arena.fight_at_tick` | 1164 | Arena | yes |
| the boss's position for the bloom | `Boss.x`, `.y` (and `map::BOSS_SPAWN`) | — | Boss | yes |

`07-animation.md` §6.1's table already carries the decisive row: *"lobby / arena state, gate
crossing | `PlayerSlot.zone` | Players | yes."*

Note in particular that the beat does **not** need `entrance_for` mirrored into TypeScript.
The payload that flips `zone` carries the landing coordinates. Mirroring the formula would
be a second copy of a fact already on the wire, which is this project's named recurring
defect.

**Instruction count unchanged, instruction bodies unchanged: the on-chain cost of this
feature is 0 CU and 0 bytes.** `boss_tick`'s measured worst case at 20 players — 24,884 CU
of a 399,700 ceiling — is untouched, as is `shoot`'s 781 CU of guards. Write-to-visible
stays at the measured p50 122 ms / p95 132 ms at twenty seats, because no transaction, no
account and no account size changes. The hard constraint on ER speed is satisfied trivially
rather than carefully.

### 8.2 Why adding a field would be expensive as well as wrong

The tempting field is something like `PlayerSlot.gate_entered_at_tick: u32`, so all twenty
clients could agree on the animation's start moment.

- **There is no free byte.** `PlayerSlot`'s compile-time offset assertions
  (`state.rs:909–923`) show `zone` 0, `facing` 1, `skin_id` 2, then `x` at 4. The single
  spare byte is `_pad0` at offset 3, and the archer/class work already claims it. Anything
  else grows `PlayerSlot`, which grows `Players` by twenty times that, which is a realloc
  on an account that is live and delegated on devnet.
- **It would be one fact stored twice.** The `zone` flip already says the passage happened
  and the same payload says where you landed. A second field can disagree with the first.
- **`07-animation.md` §6.2 already prohibits it by name**: *"No animation clock, phase,
  frame index or 'is playing' flag"*, and *"No `DESCENT_MS` or any other animation
  duration."* Its closing line settles it: *"the chain owns facts that must be identical
  for twenty players. Everything about how a fact is presented is client-local, and a
  client rendering none of it must still be playing the same game."*

A client that renders none of this beat still passes the gate, on the same tick, into the
same fight. That is the test, and this design passes it.

---

## 9. Cost

### 9.1 What the beat adds to a frame

Five nodes, for at most 1,100 ms: three full-viewport `<rect>`s, one arena-floor `<rect>`,
one `<circle>`. Four animate `opacity` only; the circle animates `opacity` and `transform`.
Both are compositor properties, which is why the design uses two gradient-filled rects
fading rather than the more obvious growing `clip-path`.

### 9.2 The measurement

An **isolated** harness — not the shipped `Arena` — at 1024×1024, 6× CPU throttle via CDP,
headless Chromium (Playwright 1.62.1), 3 s per run, frame cost measured rAF-entry to a
`MessageChannel` task so the number includes style, layout and paint commit. The scene is
240 static shapes plus 52 transform-animated nodes (20 nine-rect figures + 32 dots),
approximating twenty knights and a full bullet pool. Fresh browser per run; six runs per
mode, interleaved forwards and backwards.

Harness: `/tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad/gt/{page.html,run.mjs}`.
Reproduce with `node run.mjs /home/anshtyagi/.npm/_npx/705bc6b22212b352/node_modules`.

| mode | p50 (median of 6) | p95 | worst frame |
|---|---|---|---|
| no overlay | 4.8 ms | 9.0 ms | **10.9 ms** |
| the design above — 4 opacity + 1 transform | 6.0 ms | 10.2 ms | **16.0 ms** |
| rejected — one rect, animated `clip-path` | 5.4 ms | 9.0 ms | **21.5 ms** |

### 9.3 What that does and does not say — read this before quoting the table

**The p50 and p95 columns do not separate the two designs, and I am reporting that as a
negative result rather than dressing it up.** The session drifts monotonically: the *same*
mode's p50 ranged 5.3 → 2.3 ms across its six launches as the box warmed, and that spread
is larger than any gap between modes. A second, earlier session reproduced the same drift.
Anyone re-running this should expect the same and should not read a p50 win into it.

**The worst-frame column does survive the drift, in both sessions.** `clip-path` produced
the worst frame in every session — 21.5 ms and 20.9 ms — roughly twice the no-overlay
baseline and a dropped frame at 60 Hz. That is consistent with `07-animation.md` §2.2's
existing finding on this box that `opacity` and `transform` are composited and other
properties are not, and it is the reason `clip-path` is rejected. The justification is the
tail and the compositor property, **not** a p50 win this harness cannot demonstrate.

**Not measured, and it matters:** the marginal cost inside the shipped `Arena`, against the
recorded 20-knight baseline of p50 9.38 ms / p95 14.92 ms at 6× throttle. Naively adding
this harness's +1.2 / +1.2 ms delta gives ~10.6 / ~16.1 ms, which would put p95 over the
16.7 ms frame at 60 Hz. That composition is probably pessimistic — the long form only ever
runs during `PHASE_MUSTERING`, when the boss has not activated and the bullet pool is
empty, so the beat's peak lands on the cheapest frame in the game, whereas the 14.92 ms
baseline was measured with 32 bullets live. **But I did not measure that, and it should not
be asserted until someone does.** The measurement to run is the existing harness with a
case that mounts `<Passage>`:

```
cd scripts/spike/framebudget && CASES=cases_passage.json OUT=results_passage.json \
  PW_HOME=… node drive.mjs
```

Note its own warning: fresh browser per case, or every case after the first heavy one pins
to ~55 fps — a compositor artefact, not a result.

The short form is the case that would actually be at risk, since it is the only one that
can coexist with a volley, and it draws two nodes rather than five.

---

## 10. `prefers-reduced-motion`

`07-animation.md` §5.2's table already legislates two rows that bracket this beat:

- *phase transition wipes → **instant***
- *descent on spawn → **reduced to a fade, not a fall** — "going straight to 'boss present'
  with no transition reads as a bug"*

Applying §5.3 — *no information may exist only in motion* — the information in Beat P is
"you are now in the arena", and it survives without any of the motion: the room changes,
the HUD changes, the roster changes. So the motion goes and the transition does not.

**The reduced form is a 150 ms opacity cross-fade of the flat veil, and nothing else.** No
portcullis lift, no gradient bloom, no teal settle, no core bloom, no `transform` anywhere.
150 ms is the ceiling §5.2 sets for the effects it keeps under reduced motion ("a ≤150 ms
`opacity`/`fill` cross-fade", "kept, as opacity only, ≤150 ms, no movement").

The hold still applies, for the first 75 ms. **A hold is not motion** — it is the absence
of a snap — and without it the reduced-motion player is the only one who sees the 24-tile
teleport bare.

Cancelled by not starting, never by `animation-duration: 0.01ms` (§5.1). `reduced` is read
from `usePrefersReducedMotion` in `Arena.tsx` and passed in as a prop, exactly as
`Spawn.tsx`, `Knight.tsx` and `useSeatInterpolation` already take it — §5.1 requires one
resolver and this adds none.

`prev` is still tracked under reduced motion (`Spawn.tsx`'s existing rule), so turning the
setting off mid-session does not make the next duplicate payload look like a fresh
transition.

---

## 11. Checks to leave behind

Dev-only, in the style of the self-checks already at the foot of `Spawn.tsx`, `Gate.tsx`,
`Arena.tsx` and `predict.ts`. Each fails loudly; each corresponding bug is otherwise
silent.

1. **The trigger.** `passageFires(ZONE_LOBBY, ZONE_ARENA)` fires;
   `passageFires(ZONE_ARENA, ZONE_ARENA)` does not (the duplicate);
   `passageFires(null, ZONE_ARENA)` does not (the mid-fight join);
   `passageFires(ZONE_ARENA, ZONE_LOBBY)` does not (the incarnation reset).
2. **The resync gate, for both readers.** Drive `feedEpoch` up with a `zone` change across
   it and assert zero beats; then a further change on the same epoch and assert one. Run
   the identical test against `Spawn.tsx`'s `phase`. §1.5 is only closed if both are
   covered.
3. **The hold cannot leak.** Unit-test the release: after the effect's cleanup runs,
   `hold.current === false`, unconditionally, including on the path where `cover` was
   cancelled rather than finished.
4. **The teleport is still bigger than the snap threshold.** Assert that the *shortest*
   gate-to-entrance distance exceeds `SELF_SNAP`. It is 171.0 vs 64 today. If a map redraw
   ever brings an entrance within 64 units of the gate, that seat starts *chasing* instead
   of snapping and the hold would freeze a knight mid-walk — a different bug wearing this
   one's clothes.
5. **Only composited properties are animated.** For every node `Passage.tsx` animates,
   assert the animated property set is a subset of `{opacity, transform}`. This is what
   stops someone re-introducing the `clip-path` version §9.2 rejected.
6. **One writer.** In the frame loop's existing dev block, assert that any element the loop
   writes `style.transform` to has `el.getAnimations().length === 0`. This is
   `07-animation.md` §7 check 2 and it is the check that catches §3.4 regressing.
7. **The gate geometry is derived, not typed.** Assert the portcullis lift distance equals
   `GATE_MAX_Y - GATE_MIN_Y + 1` and the veil gradient centre equals the gate block's
   centre, both read from `@heartrot/client`.

---

## 12. What was not verified

Stated plainly, because an unmarked assumption is worse than a negative result.

1. **No integrated frame measurement.** §9.3 says exactly what was and was not measured and
   names the command that would close it. The p50/p95 comparison between the two overlay
   designs is inside this harness's run-to-run drift and must not be quoted as a win.
2. **Nothing was run against the live chain.** The teleport table in §1.3 is computed from
   the generated map and the two spawn formulas, not read off devnet. `npx tsx
   scripts/probe/roster.ts <arenaId>` prints each seat's x/y/zone and would confirm it
   against a real arena; that would be worth doing once, because it is the number the whole
   design is built on.
3. **The two-room scenes do not exist yet.** §7 is written as a contract against work in
   flight rather than against shipped code. `#gate-portcullis`, `#gate-sign` and room B's
   step geometry are node names this document is *requesting*; if the scene work names them
   differently, §3.2 and §3.4 follow it rather than the reverse.
4. **The camera is assumed gone.** `Arena.tsx:505`'s `wide` currently keys the lobby
   framing on `arena.phase`, not on `zone` — so today the framing changes at the muster's
   end rather than at the passage. Nothing in this document depends on the camera existing,
   but if a follow camera survives, its 900 ms `CAMERA_MS` pan would run concurrently with
   this beat and the two would need an ordering that has not been designed.
5. **The reference images were matched by composition, not by colour calibration.** The
   palette values quoted in §3.2 are single-pixel samples read out of the two PNGs with
   PIL — `#183a44` at (543, 290) in `actual_boss_arena.png` for the orb halo, against
   `#f9b739` at (85, 258) in `waiting_area_full_vertical.png` for a torch flame. They fix
   the warm/cold axis the beat travels along and nothing more; they are not a palette, and
   the scene work owns the real one.

   The one composition mismatch worth flagging: the shipped rooms are flatter than the
   references. Room A is 1024 × ~384 units (2.67:1) against the reference's 1.43:1, and the
   arena's raider box is 1024 × 224 (4.57:1) against 1.83:1. Framing is the scene and
   camera work's problem, not this beat's — but a much wider viewport means the veil
   gradients in §3.2 need their radii checked against the real aspect, or the corners of
   room A stay lit while its centre goes black.

*(`assert_playable` was the sixth item here in draft and is now settled: §3.1 quotes the
handler, the three admitted phases are exhaustive, and the two-form selection covers all
of them.)*
