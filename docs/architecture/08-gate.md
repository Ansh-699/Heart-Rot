# HEARTROT — The Gate, the Muster, and the Spawn

**Date:** 2026-09-02
**Status:** Specification. Nothing here is implemented yet.
**Implements against:** `programs/heartrot/src/state.rs`, `handlers/player.rs`,
`handlers/settle.rs`, `handlers/tick.rs`, `handlers/init.rs`,
`packages/client/src/layout.ts`, `worker/src/routes.ts`, `app/src/App.tsx`,
`app/src/screens/Lobby.tsx`, `app/src/ui/Hud.tsx`, `app/src/net/subscribe.ts`.
**Extends:** `06-game-loop.md` §1 and §3 — the phase table there gains one value and
three edges. Everything else in that document stands.

---

## 0. How to read the numbers in this document

Every figure below was read out of the tree at commit `ce9b743` or computed from constants
in it. Where a number came from a command, the command is given. Where a number contradicts
an existing comment in the source, that is called out in §9 rather than quietly corrected.

Baseline, run before anything in this document was written:

```
$ cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"
running 59 tests
test result: ok. 59 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
running 1 test
test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out
```

59 unit tests. The second pair of lines is the doc-test summary and is not the number that
matters.

---

## 1. What actually happens today

This section is the audit the task asked for. Every claim is a file and a line.

### 1.1 There is no matchmaking rule of any kind

**How a fight starts, end to end:**

1. `POST /api/session/init` → the Worker picks a free seat from `Arena.seat_occupied` and
   signs tag 4 `join` with the treasury key (`handlers/player.rs:360`). Seats are
   administered, never self-claimed.
2. The player spawns in `ZONE_LOBBY` at `lobby_spawn(seat)` and walks with tag 6 `move`.
3. `app/src/App.tsx:458 useGateEntry` polls the player's **authoritative** slot every
   500 ms (`GATE_RETRY_MS`) and, whenever `zone == ZONE_LOBBY && onGate(x, y)`, sends tag 5
   `enter_gate`.
4. `enter_gate` (`handlers/player.rs:555`) flips that one seat `ZONE_LOBBY → ZONE_ARENA`,
   teleports it to `tick::entrance_for(seat)`, refills HP, and does
   `arena.alive_count = alive_count.saturating_add(1).min(MAX_SEATS)`. One-way: a second
   call is refused with `WrongZone`, and that refusal is both the rate limit and the
   `alive_count` bound.
5. `screenOf` (`app/src/state/store.ts:406`) reads *your own seat's* `zone`, so the moment
   your gate transaction lands you are moved from the Lobby screen to the Arena screen —
   alone, if you are the only one there.
6. On the Arena screen with `phase == LOBBY`, `Hud.tsx:196 Muster` renders a **"Wake it
   up" button**, enabled whenever `arena.aliveCount > 0`.
7. That button calls `store.startMatch()` → `POST /api/match/start` →
   `worker/src/routes.ts:574 matchStart` → tag 3 `start_match` on the ER.
8. `start_match` (`handlers/settle.rs:140`) asserts `payer == arena.crank_authority`, mints
   the crank task id, performs `LOBBY → FIGHTING`, and schedules `TICK_ITERATIONS` boss
   ticks in one `ScheduleCrankCpi`. The fight is live.

**So, answering the three questions directly:**

- **Is there a minimum player count?** No. Not on chain, and not in the Worker.
  `matchStart` verifies a Privy token, checks the treasury tier, resolves the open arena,
  checks `phase == PHASE_LOBBY`, and sends. It never reads `Players` and never looks at
  `alive_count`. The *only* thing resembling a minimum is
  `disabled={busy || throughGate === 0}` on the button in `Hud.tsx:212` — a client-side
  disabled attribute, which is not a rule.
- **Is there a countdown?** No. The transition is instantaneous on the button press.
- **Is there a host?** No. Any Privy-authenticated user can arm any open arena, including
  one they hold no seat in. Compare `matchSettle`, which explicitly documents "the caller
  must hold a seat in the match they are asking to end" — `matchStart` has no equivalent.

**Consequences that ship today:**

- One player can arm a 20-seat raid two seconds after logging in.
- A raid can be armed with **nobody through the gate** (`alive_count == 0` is only blocked
  by a disabled button). `boss_tick` then runs with `arena_occupants == 0`, so
  `best_seat == NO_TARGET`, no volley is ever spawned, and the arena sits inert until
  `enrage_at_tick` at tick 3,600 — six minutes of an empty room, then `OUTCOME_ENRAGE`.
- Nothing ever starts a raid on its own. If nobody presses the button, the arena stays in
  `LOBBY` forever with accounts delegated to the ER.

### 1.2 The lobby copy is false

`app/src/screens/Lobby.tsx:59` tells the player: *"Head for the gate in the middle of the
map — enough of you standing on it starts the raid, and that is the whole of
matchmaking."* There is no "enough of you". Standing on the gate moves **you** to the
arena; a separate button, on a different screen, starts the raid. The screen's own module
header repeats the claim ("standing on the gate tile sends `enter_gate` … no ready-check").
This document makes that copy true rather than deleting it.

### 1.3 The gate and the boss occupy the same tiles

- `handlers/player.rs:86-89`: `GATE_MIN_X = 30*TILE = 480`, `GATE_MAX_X = 34*TILE-1 = 543`
  — tiles 30..=33 on both axes.
- `map.rs:142`: `BOSS_SPAWN = (512, 512)` — tile (32, 32).

Tile (32, 32) is **inside** the gate block. `app/src/render/Arena.tsx` never branches on
`phase` (`grep -n "phase\|PHASE" app/src/render/Arena.tsx` returns exactly one hit, a
comment on line 305), so the boss is drawn in the lobby, standing on the matchmaking tile,
with the dashed gate rect underneath it. Walking "onto the gate" is walking into the boss.

Note also that the task brief's claim — `BOSS_SPAWN = (512, 320)`, tile (32, 20) — is
**stale**. That was the old value; `map.rs:130-141` documents it as a fixed defect (the
boss stood inside the north corridor's rock and `shoot`'s ray died on the wall). The
current value is the map centre.

### 1.4 The lobby has no clock

`heartbeat` (`handlers/tick.rs:314`) advances `arena.tick` — but the crank that calls it
is not scheduled until `start_match`. Before that instruction there is **no ticking
anything** against the arena. `move_clock` (`handlers/player.rs:231`) documents this
directly and is why player movement is gated on `Clock::get()?.slot` rather than
`arena.tick`: a tick-denominated limiter would grant each player exactly one lobby move
ever.

This is the single hardest constraint on everything below. **A countdown in the lobby has
no clock to count on.** Section 3 resolves it by arming the crank one phase earlier.

### 1.5 `OUTCOME_WIPE` is unreachable, confirmed

`handlers/tick.rs:590`:

```rust
} else if arena_occupants > 0 && live_n == 0 && pending_respawns == 0 {
    OUTCOME_WIPE
```

`pending_respawns` counts seats at 0 HP whose `respawn_at_tick != 0`. Every death goes
through exactly one line — `tick.rs:477` — which stamps
`respawn_at_tick = tick + RESPAWN_TICKS` and increments `pending_respawns` on the spot
(`tick.rs:482`). Stage 1 only clears `respawn_at_tick` at the same moment it restores
`hp = hp_max` (`tick.rs:370-376`). So `hp == 0 && respawn_at_tick == 0` is not reachable
by any code path: whenever `live_n == 0`, every one of those seats is pending.

The unit test that "covers" the wipe hand-writes the impossible state:
`players.slots[3].respawn_at_tick = 0;` at `tick.rs:1090`. That is a test of the wipe
*rule*, not of any reachable state.

§7 says what to do about it.

---

## 2. The flow this document specifies

Six beats. Only beats 3, 4 and 5 need anything new on chain.

| # | Beat | Player sees | Chain state |
|---|---|---|---|
| 1 | **Arrive** | You spawn among the pillars, other knights already walking | `zone = ZONE_LOBBY`, `phase = LOBBY` |
| 2 | **Walk** | WASD, one tile per accepted move, prediction-smooth | tag 6 `move`, slot-gated |
| 3 | **Interact** | One of three gates lights under your feet — EASY, MEDIUM or HARD, each under its painted sign | tag 5 `enter_gate`, `zone → ZONE_ARENA`; the first raider's gate writes `Arena.difficulty` (§3.10) |
| 4 | **Wait** | You stand in the pit. Knights drop in beside you. A counter falls | `phase = MUSTERING`, `fight_at_tick` set |
| 5 | **Spawn** | The cavern dims; the thing lowers itself over the rim | still `MUSTERING`; the descent is a function of `fight_at_tick - tick` |
| 6 | **Fight** | It lands. Weapons free | `phase = FIGHTING`, `enrage_at_tick` stamped |

The rule that governs beats 4→6, in one sentence:

> **The first knight through the gate opens a fixed-length muster window; the chain's own
> crank ends it.**

That single sentence answers both hazards the task named.

- *What stops one player starting a 20-player raid alone?* They cannot start anything. They
  open a window and then wait it out in public, with the countdown visible to everyone in
  the lobby and the gate still open. A solo raid is possible — it must be; the solo-respawn
  fix at `tick.rs:352` exists precisely to keep it playable — but it is never *instant*, so
  it is never a way to deny the arena to the nineteen people walking toward the gate.
- *What stops a raid never starting because nobody commits?* Nothing has to commit. There
  is no ready-check, no vote and no host to go absent. The crank flips the phase at
  `fight_at_tick` whether or not anyone else arrived.

### Rejected alternatives, and why

- **A quorum ("start when 4 are through the gate")** — needs a second rule for what happens
  when the fourth never arrives, which is a deadline anyway. The deadline alone is
  sufficient, so the quorum is a second mechanism buying nothing. If playtesting shows a
  20-second window wastes a full lobby's time, the upgrade is one clamp inside the same
  handler — see §3.6.
- **A host / ready-check** — a host can disconnect, and then the raid needs a host-transfer
  rule. `enter_gate` already records commitment permanently (`zone` is one-way and no
  instruction reverses it), so there is nothing a ready flag would add.
- **A lobby countdown driven by the ER slot clock** — the program can read
  `Clock::get()?.slot` in any phase and already does. But a slot is a *monotonic stamp*,
  which is all `move_clock` needs; using it to measure a *duration* makes the length of the
  countdown depend on the validator's slot rate, so the same window is 20 s on a healthy ER
  and something else on a loaded one. Rejected: durations in this program come from
  `ticks_for()`.

---

## 3. On chain

### 3.1 One new phase

```rust
// state.rs, appended after PHASE_ROLLED
/// The gate is open, the crank is running, and the fight begins at `fight_at_tick`.
pub const PHASE_MUSTERING: u8 = 6;
```

Appended, so values 0..=5 keep their meaning and a client one release behind falls through
to its default for the length of the muster rather than mis-reading a fight. Mirror it in
`packages/client/src/layout.ts` beside `PHASE_ROLLED`.

**Why a phase byte and not a derived state.** `(phase == LOBBY && fight_at_tick != 0)`
would work and costs no new value, but four separate readers key off the phase byte —
`assert_playable`, `heartbeat`'s early return, `PHASE_EDGES`, and the client's watchdog —
and each would have to learn the compound rule. The phase byte has 250 unused values.

### 3.2 Three new edges

Added to `PHASE_EDGES` (`state.rs:432`):

| From | To | Performed by |
|---|---|---|
| `LOBBY` | `MUSTERING` | tag 3 `begin_muster` (was `start_match`) |
| `MUSTERING` | `FIGHTING` | tag 8 `boss_tick`, at `fight_at_tick` |
| `MUSTERING` | `SETTLED` | tag 9 `settle` — dead-crank recovery |

`LOBBY → FIGHTING` is **removed**. It is the edge that lets a raid start with no window and
no occupants, and leaving it in place leaves the old path alive alongside the new one.

The third edge is not optional. A crank that dies during the muster wedges the arena in
`MUSTERING` with all three accounts delegated and no instruction able to move them —
exactly the hole `FIGHTING → SETTLED` already exists to plug (`state.rs:434`, "dead-crank
recovery, must stay legal").

That edge has one consequence: `write_leaderboard` can now be reached for a match that
never fought, whose `outcome` is `OUTCOME_UNDECIDED`. It has **no outcome guard today** —
`handlers/settle.rs:479` checks only `phase == PHASE_SETTLED`. Add:

```rust
if arena_state.outcome == OUTCOME_UNDECIDED {
    return Err(HeartrotError::MatchNotRecorded.into());
}
```

An abandoned muster records nothing; the Worker opens the next `arena_id`, which is what it
already does for stranded arenas (`worker/src/routes.ts:287`).

### 3.3 One new field, and it is the last one that fits

```rust
// state.rs, Arena — replaces `_pad2: [u8; 4]` at offset 1164
/// Tick at which `boss_tick` flips `MUSTERING → FIGHTING`.
///
/// Zero means "no muster pending", which is the correct reading for every arena already
/// on chain and for every phase but `MUSTERING`. Cleared by the flip itself.
pub fight_at_tick: u32,
```

Claimed out of `_pad2`, the same move `outcome` made out of `_pad0` (`state.rs:296`) and
`deaths` made out of `PlayerSlot::_pad1`. Offset 1164 is 4-aligned, nothing moves, the
account does not grow, `size_of::<Arena>() == 1200` still holds, and the existing
`offset_of!` const-assert block gains one line.

**This is the last free `u32` in `Arena`.** After it the only spare bytes are `_pad0` (one
byte at offset 7) and `_pad1` (two bytes at offset 38). A second new field would have to be
appended past `next_affix_seed`, which grows a **delegated** account — a materially harder
change. Anything that wants a second word of muster state should be derived instead. This
is the main reason §2 rejects a stored ready-mask.

Mirror in `packages/client/src/layout.ts`, in the `ARENA.offsets` block after
`next_affix_seed: 1168`, and in `decodeArena`.

### 3.4 Constants

```rust
// state.rs, beside ROLL_TIMEOUT_TICKS
/// Twenty seconds between the first knight through the gate and the boss landing.
pub const MUSTER_TICKS: u32 = ticks_for(20_000);   // = 200 at TICK_MS = 100

/// Six minutes of fighting, stamped at the flip rather than at creation.
pub const ENRAGE_TICKS: u32 = ticks_for(360_000);  // = 3_600
```

`ENRAGE_TICKS` is `handlers::init::ENRAGE_AT_TICK` moved to `state.rs` and renamed, because
its writer moves from `init_arena` to `boss_tick` and both `tick.rs` and the test module
need it. Delete the `init.rs` constant; do not leave a second copy.

Mirror `MUSTER_TICKS` in `layout.ts` beside `ROLL_TIMEOUT_TICKS` — the client needs it only
to size a progress bar, but a client that guesses 20 s while the chain runs 25 s draws a bar
that finishes early every single time. **Check `ROLL_TIMEOUT_TICKS` while you are in that
file: it currently reads `25` in TypeScript and `100` in Rust. See §9.1.**

### 3.5 `enrage_at_tick` becomes match state

Today `enrage_at_tick` is an absolute 3,600 written once by `init_arena` (`init.rs:521`) and
deliberately carried across incarnations (`state.rs:569`, "a rule of the fight, not match
state"). That works only because `tick` is 0 at fight start — which stops being true the
moment the crank ticks during the muster. Left alone, a 200-tick muster silently shortens
every fight by twenty seconds.

Three changes, all in one commit:

1. Delete `state.enrage_at_tick = ENRAGE_AT_TICK;` from `init_arena`. A fresh account reads
   0 there, and `tick.rs:592` already refuses to enrage on `enrage_at_tick == 0` — the
   guard exists and is tested (`tick.rs:1300`).
2. Stamp it on the flip (§3.7).
3. In `Arena::begin_next_incarnation` (`state.rs:583`), add `self.enrage_at_tick = 0;` and
   move it out of the "what carries over" list in that doc comment into "what resets".

### 3.6 Tag 3, renamed `begin_muster`

Same tag, same wire ABI (zero argument bytes), same five accounts
`[payer, arena, boss, players, magic_program]`, same scheduling CPI. Three changes inside:

```rust
// after the existing crank_authority check, before try_set_phase:

// Someone has to be standing in the pit. Counted from `Players` rather than read off
// `alive_count` for the same reason stage 3 of the tick recounts it: `enter_gate` is the
// only writer of that field before the crank exists, so a bug there would otherwise arm
// an empty raid that ticks for six minutes at nothing.
let raiders = {
    let players_data = players.try_borrow()?;
    let roster = load::<Players>(&players_data)?;
    roster.slots.iter().filter(|s| s.zone == ZONE_ARENA).count()
};
if raiders == 0 {
    return Err(HeartrotError::NoRaiders.into());
}

state.try_set_phase(PHASE_MUSTERING)?;          // was PHASE_FIGHTING
state.fight_at_tick = state.tick.saturating_add(MUSTER_TICKS);
state.crank_task_id = task_id;
```

`state.tick` is 0 here — in `LOBBY` nothing has ticked, and `begin_next_incarnation` zeroes
it — so `fight_at_tick` is `MUSTER_TICKS` in practice. Written as an addition anyway: the
handler must not depend on a fact enforced two files away.

`HeartrotError::NoRaiders = 19` (`HIGHEST_ISSUED` in `error.rs:234` currently reads 18);
mirror it in `packages/client/src/errors.ts`.

`LOBBY → MUSTERING` being the only edge in is what keeps the ScheduleTask CPI single-shot,
exactly as `LOBBY → FIGHTING` did: a second `begin_muster` is rejected before it can
schedule a second crank against the same accounts.

> `ponytail:` fixed window, no early start. If a full lobby waiting out 20 s reads as dead
> time, the upgrade is one clamp in `boss_tick`'s `MUSTERING` branch —
> `if raiders >= QUORUM { fight_at_tick = min(fight_at_tick, tick + LOCK_TICKS) }` —
> monotone-decreasing so it cannot be pumped, and `LOCK_TICKS` must stay long enough for
> the descent animation (§6.5). Do not add it before playtesting says the wait is wrong.

### 3.7 `boss_tick` runs during the muster

`heartbeat` (`tick.rs:314`) currently answers one question — "should `step` run?". It gains
one branch, in the same shape as the `PHASE_ROLLING` branch already there:

```rust
fn heartbeat(arena: &mut Arena) -> bool {
    arena.tick = arena.tick.saturating_add(1);
    if arena.phase == PHASE_ROLLING {
        arena.abandon_roll();
        return false;
    }
    if arena.phase == PHASE_MUSTERING {
        arena.begin_fight();
        return false;
    }
    arena.phase == PHASE_FIGHTING
}
```

```rust
// state.rs, beside abandon_roll — total and self-gating, because a crank that returns
// Err ten times is deleted.
pub fn begin_fight(&mut self) -> bool {
    if self.phase != PHASE_MUSTERING || self.fight_at_tick == 0 {
        return false;
    }
    if self.tick < self.fight_at_tick {
        return false;
    }
    self.phase = PHASE_FIGHTING;
    self.enrage_at_tick = self.tick.saturating_add(ENRAGE_TICKS);
    self.fight_at_tick = 0;
    true
}
```

Two properties an implementer must not "improve":

- **`return false` on the flip tick.** `step` does not run in the same execution that flips
  the phase; the fight's first simulation tick is 100 ms later. This mirrors
  `abandon_roll`, keeps the boss's first volley strictly after the phase every client is
  rendering off, and costs one tick.
- **Nothing else runs during `MUSTERING`.** No bullets advance, no aggro is computed, no
  damage lands, `alive_count` is not recomputed. The only writes are `tick` and, once,
  the flip. That matters for the notification budget: during the muster the arena account
  changes by four bytes per tick.

### 3.8 The three player handlers

`assert_playable` (`handlers/player.rs:342`) is an allow-list, deliberately
(`player.rs:319-326`, written after `PHASE_ROLLING`/`PHASE_ROLLED` were appended). Add one
value:

```rust
if phase == PHASE_LOBBY || phase == PHASE_MUSTERING || phase == PHASE_FIGHTING {
```

This is one line and it governs all three of `join`, `move_player` and `enter_gate`, which
is exactly right:

- **`move` during the muster** — yes. A frozen pit for twenty seconds is not a waiting
  room, it is a hang.
- **`enter_gate` during the muster** — yes, and this is the point of the window. It is also
  already legal during `FIGHTING` (late entry is the matchmaker, `player.rs:338`), so the
  muster changes nothing structural, only makes the window a designed one.
- **`join` during the muster** — yes, for the same reason it is legal during `FIGHTING`.

`shoot` needs **no change**: `handlers/shoot.rs:349` tests `phase != PHASE_FIGHTING` and
rejects. Weapons stay down until the thing lands, for free.

`move_clock` needs no change: it returns `Clock::get()?.slot` in every phase already.

### 3.9 Crank iterations

`TICK_ITERATIONS` (`handlers/settle.rs:102`) is the literal `4_500`. The muster now spends
ticks before the fight, so the budget must cover both. Derive it:

```rust
/// Muster plus the full enrage window, with 25% slack for a crank running behind its
/// interval. Derived, because the two windows it has to cover are constants two files
/// away and a literal here goes stale the moment either moves — as it already has once.
const TICK_ITERATIONS: i64 = ((MUSTER_TICKS + ENRAGE_TICKS) as i64) * 5 / 4;  // = 4_750
```

**Read §9.2 before touching this line**: the comment above it is wrong today, and the slack
it claims does not exist.

---

### 3.10 Three gates, one tier (added 2026-09-04)

The lobby's top wall carries three doorways, drawn as three separate `G` blocks on the
gate rows of `assets/map/arena.json` (`tools/gen_rooms.py` measures them off the painting's
three signs; `tools/gen_map.py` emits them as `map::GATES: [Gate; 3]` and `map.ts`'s
`GATES`, left to right = tier 0 EASY, 1 MEDIUM, 2 HARD, and refuses any other count — the
count is read back from `state::N_TIERS`, which sizes every balance table). `map::gate_at(x,
y) -> Option<u8>` replaces `on_gate`; there are no `GATE_MIN_X`..`GATE_MAX_Y` constants any
more, on either side.

**The gate is a portal, not a corridor.** `enter_gate` writes `tick::entrance_for(seat)`,
so a block owes the pit no adjacency. The generator's old "the gate sits immediately below
the pit and its columns run onto the dais" rule is gone with a comment; what it proves
instead is that each block is a solid rectangle of floor inside the lobby box, reachable
from every lobby spawn without leaving it, that the three share no column, that the heart
stands on none of them, and — cross-checked against `rooms.gen.ts`'s `LOBBY_GATES` — that
the blocks the browser draws its marks over are the blocks the chain admits through.

**The raid's tier is the first raider's gate.** `Arena.difficulty` (byte 38, claimed out of
`_pad1`; `04-layout-contract.md`) is written by `enter_gate` from `gate_at` only while
`raid_size == 0 && alive_count == 0` (`player::locked_tier`) — nobody has walked a gate this
incarnation — and cleared by `begin_next_incarnation`, the only road back to `LOBBY`.
Every later raider must take the same gate: another block is refused
**`WrongGate` (21)**, a code of its own because, unlike `NotOnGate`, no poll heals it.
The client mirrors the lock as `layout.ts`'s `lockedTier(arena)`: `App.tsx`'s
`useGateEntry` reads it before sending and, on the wrong block, posts *"This raid is
MEDIUM. Walk to the MEDIUM gate."* to the error bar instead — nothing is sent, so a player
standing there does not push a refusal twice a second. Everything the tier tunes is in
`10-boss.md` §1.7: the vent line, the core floor and top-up, incoming damage ×1/×2/×3 and
the fury bullets, all indexed by the same byte beside `raid_size`.

On screen: three `.gate-mark[data-tier]` markers in the doorways' own colours
(`WaitingRoom.tsx`), three under-foot lights and the muster clock over the raid's gate
(`Arena.tsx`), the passage lifting the portcullis the seat actually walked — read off its
last lobby position, because the `Players` notification that flips `zone` can land before
the `Arena` one that carries the tier (`Passage.tsx`) — and the boss bar's tag reading
the tier name in the tier colour while fighting, ENRAGED still overriding (`Hud.tsx`).

## 4. What the Worker does

`POST /api/match/start` keeps its path and its shape. Two changes:

1. It now arms a *muster*, not a fight. The response's `phase: 'fighting'` becomes
   `phase: 'mustering'`, and it should return `fightAtTick` alongside `enrageAtTick` —
   which is now 0 at this point, because §3.5 moves that stamp to the flip. Returning a
   stale 3,600 there would have every client draw an enrage bar for a fight that has not
   begun.
2. `already_started` (409) now covers `MUSTERING` as well as `FIGHTING`: the check becomes
   `phase !== PHASE_LOBBY`, which is what it already is (`routes.ts:596`). No change.

**No seat check.** `matchSettle` requires the caller to hold a seat because settling ends
nineteen other people's raid. Arming a muster ends nothing: it starts a public countdown on
an arena that already has someone standing in it (the chain enforces `raiders >= 1`), and
the phase edge makes the second caller a no-op. Adding a seat check here would mean
decoding the 1,924-byte `Players` account on a route that does not otherwise need it.

**Who calls it.** The "Wake it up" button is deleted (§6.4). Instead the client fires the
request automatically the first time it observes its own seat at `zone == ZONE_ARENA` with
`arena.phase == PHASE_LOBBY`. Twenty clients will do that within one notification of each
other; nineteen get 409, which is the intended outcome and already the documented behaviour
of the existing debounce (`Hud.tsx:193`, `store.ts:320` — `startMatch` is guarded by a
module-level `starting` flag).

No Durable Object, no cron, no lobby service. The chain is the queue; the browsers are the
things that poke it.

---

## 5. The client, beat by beat

Every visual below is a pure function of `(arena.phase, arena.tick, arena.fight_at_tick,
Players)`. Nothing is stored to make it work, and two clients that agree on those four
things draw the same frame.

### 5.1 The gate glows under your feet — from prediction, not from chain

The glow must key off `predictor.self`, the same predicted position `Arena.tsx:190` chases
in the rAF loop. **Not** off the authoritative slot. Write-to-visible is p50 127 ms / p95
160 ms; a glow driven by the chain's copy of your position lights up a sixth of a second
after your feet arrive, and reads as input lag on the single interaction the whole lobby is
built around.

The `enter_gate` *send* stays exactly where it is — `useGateEntry` polling the
authoritative slot every 500 ms (`App.tsx:458`). That split is deliberate and is already
documented in the source: the version that fired inside `onMove` stranded players
permanently. **The glow is cosmetic and predicted; the transaction is authoritative and
polled. Do not merge them.**

Implementation constraint: the glow node is owned by the frame loop, which sets one
property on it (`opacity`, or a CSS custom property feeding a filter). React must not own
that node's style, and nothing may put a `transform` on it — the project's standing rule is
one writer per node, and the frame loop already owns `transform` on the self node.

### 5.2 The prompt

Rendered when `onGate(predicted) && mySeat.zone === ZONE_LOBBY`. It disappears on the
authoritative flip, not on the predicted one — that ~127 ms is honest feedback that the
chain took the input, and the alternative (hiding it optimistically) shows nothing at all
if the transaction is dropped and the 500 ms poll has to retry.

Text: **"Hold here. The gate is reading you."** — and it can say that truthfully now,
because the poll re-sends while you stand still.

### 5.3 Waiting: who else is in

`Lobby.tsx` already computes both counts from `Players` (`seated`, `onGate`) and already
renders the twenty-row roster. The state it needs exists; what changes is the copy, which
becomes true (§1.2):

> *"Walk onto the gate. The first knight through opens the raid — everyone who reaches
> the gate before it closes fights in it."*

Both screens need this, not just the lobby. Under `screenOf` you leave the Lobby screen the
instant your own `zone` flips, so the person who opened the muster watches the countdown
from the Arena screen while everyone still walking watches it from the Lobby screen. The
countdown component belongs to neither — put it in `Hud`, which both render.

### 5.4 The countdown, and how not to render it

```ts
const remainingTicks = Math.max(0, arena.fightAtTick - arena.tick);
const remainingMs = remainingTicks * TICK_MS;
```

Three rules:

1. **Never run a local `setInterval` countdown.** It drifts against a crank whose interval
   is a floor and not a guarantee (`settle.rs:93` — "ticks drift under load rather than
   catching up"). The chain's tick is the clock; the display is a projection of it.
2. **Sub-second smoothness comes from `tickAlpha`** (`app/src/net/predict.ts:268`), which
   already exists and already interpolates between tick notifications. A sweeping ring or
   bar reads `remainingTicks - tickAlpha(...)`.
3. **Select integers, render seconds.** 68.4% of `Players` notifications during a fight
   carry no position change and the Magic Router delivers every notification twice. A
   countdown component that subscribes to the whole arena object re-renders ~20×/s for a
   number that changes once a second. Select `fightAtTick` and `tick` (two integers) and
   floor to seconds; the text node then changes 20 times over the whole window.

During the muster the arena account is changing four bytes per tick (§3.7), so this is the
cheapest phase in the game to be in. Do not spend that budget on React.

### 5.5 The cavern darkens and the thing descends

Driven by `remainingMs`, **not** by the phase notification. This is the one place the
127 ms round trip is visible as a design constraint: an animation started when
`phase → FIGHTING` arrives begins after the fight has already begun. Driven by the
deadline, it *ends* exactly when the fight starts, on every client, without them
coordinating.

```
descent progress = clamp01(1 - remainingMs / DESCENT_MS)     // DESCENT_MS ≈ 3_000
```

- `DESCENT_MS` is a client constant. It is not on chain and must not be: the chain owns
  *when the fight starts*, and a client that renders no animation at all is still correct
  and still fights the same fight on the same tick.
- A player who joins mid-descent starts partway through. Correct. Nothing waits for an
  animation to finish.
- The environment darkening is a single opacity on a wrapper node, transitioned in CSS. The
  332 KB `temple.svg` background is rasterised once and never re-rendered — dim it with an
  overlay or a `filter` on the containing group, never by re-rendering paths. (Measured
  ceiling for reference: 7,589 rects animating `transform` ran at 143 fps, so the budget is
  there — but only for nodes React is not touching.)
- The boss descends by `transform` on the boss group. That group is the frame loop's, and
  the frame loop's alone.

### 5.6 The landing

`phase → FIGHTING` is the authoritative moment. Everything that must be exact — the first
volley, weapons going live, the enrage bar appearing — hangs off it. Everything cosmetic
has already finished by then.

### 5.7 The watchdog

`watchdogHealth` (`app/src/net/subscribe.ts:172`) returns `null` for any phase but
`FIGHTING`, which is correct today because the lobby genuinely has no ticks. It stops being
correct the moment the crank runs during `MUSTERING`: a crank that dies mid-muster leaves an
arena nobody is watching, in a phase nobody can leave.

```ts
if (phase !== PHASE_FIGHTING && phase !== PHASE_MUSTERING) return null;
```

The `fightingAt` anchor (`subscribe.ts:206`, `:229`) can then be **deleted**. It exists
solely because `start_match` flipped the phase without touching `tick`, leaving `tickAt` as
old as the whole lobby wait — the regression its self-check case 3 guards
(`subscribe.ts:436`). Under this design `tick` is already advancing when `FIGHTING` is
entered, so the tick anchor is at most one tick old at the flip and the second anchor has
nothing left to fix. Delete the variable, the write, the `Math.max`, and rewrite that
self-check case as *"a muster that stalls is reported dead"*.

---

## 6. Deletions

Work this design removes, listed so it actually gets removed:

1. **`Hud.tsx:196 Muster`** — the whole component. The gate is the interaction; a button
   that does the same thing from a panel is the second way to do it, and it is the one that
   let a raid start with nobody in the pit.
2. **`subscribe.ts` `fightingAt`** — §5.7.
3. **`init.rs ENRAGE_AT_TICK`** — moved to `state.rs` as `ENRAGE_TICKS`, one copy.
4. **`PHASE_EDGES`' `(LOBBY, FIGHTING)`** — §3.2.
5. **`Arena::_pad2`** — becomes `fight_at_tick`.

---

## 7. `OUTCOME_WIPE`

**Should this redesign make it reachable again? Yes — but the mechanism belongs to the
fight slice, not this one.**

The gate flow's contribution is that a wipe becomes *meaningful*. Today
`arena_occupants > 0` exists in the wipe condition purely to stop a raid armed with nobody
in it from settling on tick 1 (`tick.rs:571`) — a state only reachable because
`start_match` never checked. After §3.6, `begin_muster` requires `raiders >= 1` and `zone`
is one-way, so `arena_occupants >= 1` holds for the entire life of every fight, by
construction. **Keep the guard anyway** — it costs one compare and it fails closed — but
note in the source that it is now belt-and-braces rather than the load-bearing thing it is
today.

That leaves the real blocker, which is that respawns are unbounded (§1.5). The minimal fix,
in one line and zero new bytes:

```rust
// tick.rs:477, the single death site
if slot.deaths < LIVES_PER_RAID {
    slot.respawn_at_tick = tick.saturating_add(RESPAWN_TICKS);
    pending_respawns += 1;
}
slot.deaths = slot.deaths.saturating_add(1);
```

`deaths` already exists (`PlayerSlot`, offset 14, claimed out of `_pad1`) and is already
incremented on exactly this line. A seat out of lives simply never gets a deadline, so
`hp == 0 && respawn_at_tick == 0` becomes reachable, and `live_n == 0 &&
pending_respawns == 0` becomes a real wipe. The wipe *rule* at `tick.rs:590` does not
change at all — it was always right, it just had no way to fire.

`LIVES_PER_RAID = 3`, beside `RESPAWN_TICKS`, and it is a balance knob rather than a
structural constant: at `RESPAWN_TICKS = 32` (3.2 s) a solo raider has roughly ten seconds
of sustained failure before the raid is over, and twenty knights have sixty deaths between
them inside a 3,600-tick window.

Two interactions worth stating explicitly:

- **A late joiner arrives with `deaths == 0`**, so `enter_gate` during `FIGHTING` is
  reinforcement — three fresh lives walking into a raid that has spent its own. That is a
  feature and should be surfaced in the UI, not patched out.
- **`begin_next_incarnation` already zeroes every seat** through
  `Players::reset_for_incarnation`, so lives reset with everything else. Nothing to add.

Do not ship §7 in the same commit as §3. The gate flow is testable on its own, and the two
have exactly one line of contact (the `arena_occupants` comment).

---

## 8. Geometry this design depends on

The 33 Immortals composition — boss fixed at top centre, pit below, everyone shooting up —
is a different slice. This one only asserts what the gate flow needs from it:

1. **No gate block may contain the boss.** It did once (§1.3). The check lives in the
   const-assert block in `map.rs` next to the two that prove `ENTRANCES` and `BOSS_SPAWN`
   stand on floor — `assert!(gate_at(bx, by).is_none())` over the generated `GATES` — which
   is only possible because the gate blocks live in `map.rs` (compiled from the drawn map
   by `tools/gen_map.py`) rather than as hand literals in `handlers/player.rs`. That is the
   right home for them anyway: they are a fact about the map, the same argument `map.rs`
   makes for `BOSS_SPAWN`. Nothing in `app/` restates a gate; `GATES` and `gateAt` come out
   of `map.ts`.

2. **Every `ENTRANCES` mark must land in the pit, below the boss.** `entrance_for(seat)` is
   where `enter_gate` puts you and where every respawn returns you, so the "twenty tiny
   figures scattered in the pit, all facing up" composition is decided entirely by those
   four `E` marks and the fan direction `fans_along_x` derives from them (`tick.rs:617`).
   No code changes — redraw `assets/map/arena.json` and re-run `tools/gen_map.py`.

3. **Every gate must be reachable on foot from all twenty `lobby_spawn(seat)` positions,
   without leaving the lobby box.** `tools/gen_map.py` proves it, gate tile by gate tile,
   from one flood over the lobby rows. A lobby spawn walled off from a gate is a tier
   nobody can pick, and it would present as one specific player being permanently stuck.

---

## 9. Defects found while writing this

Not caused by this design. Fix them in their own commits.

### 9.1 `ROLL_TIMEOUT_TICKS` disagrees between Rust and TypeScript

```
programs/heartrot/src/state.rs:156   pub const ROLL_TIMEOUT_TICKS: u32 = ticks_for(10_000);   // = 100
packages/client/src/layout.ts:78     export const ROLL_TIMEOUT_TICKS = 25;
```

`ticks_for(10_000)` at `TICK_MS = 100` is 100. The TypeScript literal is the 400 ms-era
value and was not rescaled. `rollDeadlineTick` (`layout.ts:508`) is therefore 75 ticks
early, and `worker/src/routes.ts:697` computes its 202 `retryAfterMs` from it — the settle
loop is told to come back 7.5 s before the chain could possibly have abandoned the roll.
One fact stored twice, which this project names as its most repeated defect. The fix is to
derive it: export `TICK_MS` from `layout.ts` and compute, or generate the mirror.

### 9.2 The crank's iteration budget claims slack it does not have

`handlers/settle.rs:98-100`:

> *"Ticks the crank is armed for. A match is bounded by `enrage_at_tick` (900 ticks =
> 6 minutes), so this is 5× headroom."*

At `TICK_MS = 100`, `ENRAGE_AT_TICK = ticks_for(360_000) = 3_600`, not 900.
`TICK_ITERATIONS = 4_500` is therefore **1.25×**, not 5× — 4,500 ticks is 450 s against a
360 s enrage window, leaving 90 seconds of slack for a crank running behind its interval,
not 30 minutes. The value is survivable; the comment is off by a factor of four and would
lead the next person to spend that slack. §3.9 derives it instead.

### 9.3 Stale prose

- `handlers/init.rs:185` — *"Six minutes at the 400 ms crank interval"*. The value is right
  (it derives through `ticks_for`); the sentence describes the old interval.
- `app/src/ui/Hud.tsx:229` and `:348` — `useSelect((s) => s.match?.tickMs ?? 400)`, twice.
  A 400 ms fallback
  for a 100 ms chain. Only reached before `/api/match/*` answers, but it makes the enrage
  clock read 4× long for that window.
- `app/src/screens/Lobby.tsx:6,11,59` — the "enough of you standing on it starts the raid"
  claim, false today (§1.2), true after §3.

### 9.4 The task brief's `BOSS_SPAWN`

The brief states `map::BOSS_SPAWN = (512, 320)`, tile (32, 20). The tree says `(512, 512)`,
tile (32, 32) (`map.rs:142`). `(512, 320)` was the defect that shipped the boss inside the
north corridor's rock; `map.rs:130-141` documents its removal. Anything planned against the
old value — particularly the "the boss is already at the top, this is just geometry"
reading — needs re-checking: the boss is at the **centre** today, and moving it to top
centre is a real move of both the `B` mark and the pit around it.

---

## 10. Checks to leave behind

One runnable check per piece of non-trivial logic, in the style already in the tree. No
frameworks.

**Rust** (`state.rs` test module, joining the existing 59):

1. `a_muster_cannot_start_before_its_deadline` — build an `Arena` in `MUSTERING` with
   `fight_at_tick = 200`; assert `begin_fight()` is `false` and the phase is unchanged for
   `tick` in `{0, 1, 199}`, `true` at 200 and at 201, and that after the flip
   `enrage_at_tick == tick + ENRAGE_TICKS` and `fight_at_tick == 0`.
2. `begin_fight_is_total_and_idempotent` — call it from all seven phase values including
   `MUSTERING` twice in a row; assert it returns `false` and writes nothing in every case
   but the one legal flip. This is the `abandon_roll` property, and `boss_tick` depends on
   it the same way.
3. Extend `only_a_live_match_accepts_player_input` (`player.rs:674`) with
   `PHASE_MUSTERING` in the accepted set and bump its exhaustive tail past 6. The test is
   already written to walk every value and past the end; it will fail loudly if the new
   phase is added to the constant and not to the allow-list, which is exactly the wiring
   bug worth catching.
4. Extend the `PHASE_EDGES` 6×6 walk (`state.rs:1005`) to 7×7. It should catch
   `LOBBY → FIGHTING` still being present.
5. `an_empty_pit_cannot_open_a_muster` — the `raiders == 0` refusal, against a `Players`
   with every seat in `ZONE_LOBBY`.

**TypeScript** (the `import.meta.env.DEV` self-check blocks already used in
`subscribe.ts` and `predict.ts`):

6. `subscribe.ts` — replace the `fightingAt` cases with: a stalled `MUSTERING` reports
   `dead`; a ticking `MUSTERING` reports `live`; `LOBBY` still reports `null`.
7. `layout.ts` — assert `MUSTER_TICKS * TICK_MS === 20_000` and
   `ROLL_TIMEOUT_TICKS * TICK_MS === 10_000`, which is §9.1's regression written down.

**Build gates**, unchanged and all six must pass:

```
(cd app && npx tsc --noEmit)
(cd app && VITE_PRIVY_APP_ID=cmtip434r039r0cl4wkja0963 npx vite build)
(cd packages/client && npx tsc --noEmit)
(cd worker && npx tsc --noEmit)
cargo check --workspace
cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"
```

---

## 11. Risks

1. **The muster spends crank iterations that used to belong to the fight.** §3.9 derives
   the budget, but the crank cannot be topped up — `ScheduleTask` needs a writable signer
   and a scheduled instruction may carry none (`routes.ts:598`). Getting `TICK_ITERATIONS`
   wrong is a raid that goes inert mid-fight and can only be recovered through the settle
   route. Verify the arithmetic against the constants, not against the old literal.
2. **`enrage_at_tick` changes meaning** from a creation-time constant to a flip-time stamp
   (§3.5). Any reader that assumes it is non-zero before the fight now reads 0. Grep it:
   `worker/src/routes.ts:619` returns it in the start response, and `Hud.tsx:228,238,271`
   renders the enrage clock from it.
3. **A 20-second window may be the wrong number.** It is the one figure here with no
   derivation behind it — it is a guess at how long a knight will stand still. It is a
   single `ticks_for()` call, mirrored in one place, so it is cheap to move; the quorum
   clamp in §3.6 is the escape hatch if it turns out fixed-length is wrong in principle.
4. **Deleting `LOBBY → FIGHTING` is not backward compatible with a deployed client.** An
   app build that still renders the "Wake it up" button will send tag 3 and get
   `MUSTERING`, which its `switch` does not know — it falls through to a default for
   twenty seconds and then the fight starts normally. Degraded, not broken, but ship the
   program and the app together.
5. **`MUSTERING → SETTLED` records nothing**, so an abandoned muster burns an `arena_id`.
   The Worker already skips stranded arenas, but this makes the case reachable on purpose
   rather than by accident. Watch the rate; if arenas start burning, the crank is dying
   during the muster and that is the real problem.
