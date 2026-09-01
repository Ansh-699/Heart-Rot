//! `boss_tick()` — the game loop, run by the ER's crank scheduler every ~400 ms.
//!
//! This is the only instruction in the program nobody sends. A row in the validator's
//! SQLite table replays a *frozen* account list — `[Arena, Boss, Players, crank_signer]`
//! — against this handler, `iterations` times, and three properties of that arrangement
//! shape every line below:
//!
//! 1. **The crank's own path must never return `Err`.** Ten consecutive failures move
//!    the task to `failed_tasks` and it never ticks again — ~26 s into a six-minute
//!    match, with no RPC to ask whether it is still alive. So every rejection the crank
//!    can actually reach is `return Ok(())`, there is no `?` on anything that can fail,
//!    no `unwrap`, no unchecked index, and no arithmetic that can overflow-panic under
//!    `overflow-checks = true`. A no-op tick still surfaces: `Arena.tick` stops
//!    advancing and the client's 45 s watchdog settles the match. A dead task surfaces
//!    as nothing at all.
//!
//!    The **one** exception is the crank-signer check, which returns
//!    [`HeartrotError::NotCrankSigner`]. That path is unreachable for the crank by
//!    construction: `Arena.crank_authority` is written once by `init_arena` and by
//!    nothing afterwards, and `settle::start_match` freezes into the crank row the
//!    signer PDA derived from that same field — so the value this handler re-derives
//!    against cannot have moved. The only sender who can fail it is someone hand-building
//!    a `boss_tick`, and answering that with `Ok(())` is exactly the H5 complaint: a
//!    forged tick and a real one become indistinguishable to everything watching. A
//!    rejection the crank cannot reach spends none of its ten strikes.
//! 2. **It cannot re-arm itself and cannot draw randomness.** `ScheduleTask` needs a
//!    writable signer and a crank instruction may carry none, which also rules out the
//!    VRF request (its `payer` is a writable signer). Iterations are scheduled for the
//!    whole match up front, and per-tick entropy is derived arithmetically from
//!    `Arena.affix_seed` — see [`mix64`].
//! 3. **The whole transaction gets 400,000 CU.** Not 1.4 M: the crank transaction is
//!    `[noop, ExecuteCrank]` with no `ComputeBudget` instruction, and we do not build
//!    it, so the ceiling is `2 × 200,000` and unraisable. The loops below are therefore
//!    fixed-bound, allocation-free, and broad-phased before any multiply.
//! 4. **It is the arena's only clock, in every phase.** [`heartbeat`] advances
//!    `Arena.tick` before any phase gate, so `tick` is a crank-liveness heartbeat rather
//!    than a fight timer. [`Arena::abandon_roll`] measures the VRF timeout against it, and
//!    a clock that only ran while `FIGHTING` would freeze in `PHASE_ROLLING` — the timeout
//!    would never fire and a VRF outage would wedge the arena there for good.
//!
//! Order of operations is the spec's, with one deliberate swap noted at the respawn
//! pass. Damage *to* the boss is not here — that is `shoot`, a player transaction.
//!
//! Everything is integer. The client re-runs this exact arithmetic locally to render
//! 2.5 Hz of chain state as 60 fps of bullet hell, so a single float — or a single
//! wall-clock read — would put the two simulations on different rails.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::HeartrotError;
use crate::guards::{assert_owned_by, assert_pda, assert_signer, assert_writable};
// The crank identity, imported rather than re-declared. `settle::start_match` derives the
// signer it freezes into the crank row from these two values and this handler re-derives
// the signer it authorizes against from them: they are the write side and the verify side
// of one authorization, and two editable copies let the two drift with nothing failing to
// compile. A drift is invisible in production — the task fails every tick, burns its ten
// retries and is deleted ~26 s into the match while every path here still returns `Ok(())`.
use crate::handlers::settle::{CRANK_PROGRAM_ID, CRANK_SIGNER_SEED};
// The boss's geometry, generated from `assets/sprites/hitboxes.json` by
// `tools/gen_hitboxes.py` alongside the TypeScript the renderer draws with. `shoot.rs`
// raycasts against the boxes these muzzles were cut from in this same frame, so
// importing them is what makes the thorn a bullet leaves and the thorn a player shoots
// off one object.
use crate::hitboxes::{Muzzle, MUZZLES, N_MUZZLES};
use crate::map;
use crate::state::{
    load_mut, Arena, Boss, Players, BULLET_ACTIVE, BULLET_FREE, MAX_BULLETS, MAX_SEATS, NO_TARGET,
    OUTCOME_ENRAGE, OUTCOME_UNDECIDED, OUTCOME_WIN, OUTCOME_WIPE, PHASE_FIGHTING, PHASE_ROLLING,
    SEED_BOSS, SEED_PLAYERS, ZONE_ARENA,
};

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/// 16 units per tile over the 64×64 map, so 0..1024 on both axes, `y` growing
/// downward. The layout contract mandates one shared unit for `PlayerSlot.x`, `Boss.x`
/// and `Bullet.x` without naming it.
///
/// Widened from the generated `crate::map` values rather than restated: `map.rs` is
/// compiled from `assets/map/arena.json` by `tools/gen_map.py` together with the
/// `WALLS` bitboard these two index into, so the grid this file steps bullets across is
/// the grid the map was drawn on by construction. `shoot.rs` and `player.rs` read the
/// same source. (This file used to spell both numbers out with an `assert!` underneath
/// — a copy plus a guard is still a copy; a cast is not.)
const TILE: i32 = map::TILE as i32;
const ARENA_SIZE: i32 = (map::MAP_TILES as i32) * TILE;

/// Seats fan out along the wall their door is set into, so five simultaneous respawns
/// at one door are five visible knights rather than one. 24 units is 1½ tiles, and the
/// widest rank is ±2 — ±48 units, three tiles either side of the `E`.
const ENTRANCE_SPACING: i32 = 24;

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/// Is the tile containing `(x, y)` solid?
///
/// One shift and one mask against the generated bitboard — no loop, no raycast, no
/// account. Off-map is solid, which is what lets this *replace* the arena-bounds test
/// the bullet loop used to do: `wall_at` answers `false` only for `0..ARENA_SIZE` on
/// both axes, so a point that clears it is known to fit back into `i16`.
///
/// Byte-for-byte the same decision as `handlers::player::is_wall` and
/// `packages/client/src/map.ts`'s `isWall`: negatives are wall *before* the divide, so
/// truncation direction can never matter.
///
/// `const` because the respawn assertion below runs it at compile time on all twenty
/// seats. One function, both uses — a second copy of this test is precisely the kind of
/// duplicate that drifts.
#[inline]
const fn wall_at(x: i32, y: i32) -> bool {
    if x < 0 || y < 0 {
        return true;
    }
    let tx = (x / TILE) as usize;
    let ty = (y / TILE) as usize;
    if tx >= map::MAP_TILES || ty >= map::MAP_TILES {
        return true;
    }
    map::WALLS[ty] & (1u64 << tx) != 0
}

// ---------------------------------------------------------------------------
// Balance knobs
// ---------------------------------------------------------------------------

/// Bullet speed, derived from a real-world speed so the tick rate can change under it.
/// 120 units/s is 7.5 tiles a second — 3 tiles per 400 ms, the rate this was balanced at.
/// Originally: 3 tiles per 400 ms. Boss centre to a player
/// at mid-range is ~8 ticks of travel, which is the dodge window the whole design rests
/// on: hitscan for the player, travel time for the boss (spec §3).
///
/// It must fit `Bullet.dx`/`dy`, which are `i8`. Collision is swept (see
/// [`bullet_hits`]), so raising this does *not* let bullets tunnel through players —
/// that coupling is the usual reason a number like this is stuck too low.
const BULLET_UNITS_PER_SEC: i32 = 120;
const BULLET_SPEED: i32 = BULLET_UNITS_PER_SEC * crate::state::TICK_MS as i32 / 1_000;

/// Player collision radius, ~¾ of a tile. Compared as a squared distance against a
/// squared radius; there is no `sqrt` in this program.
const PLAYER_HIT_RADIUS: i32 = 12;

/// Damage per bullet. Against the 100 HP a seat is spawned with this is 13 hits, so a
/// player can eat a glancing volley and live but cannot stand in one.
const BULLET_DAMAGE: u16 = 8;

/// Death lasts 8 ticks ≈ 3.2 s at the crank's target rate (spec §3: "dead for 3
/// seconds"). Counted in ticks, never milliseconds — the crank makes no wall-clock
/// promise and a millisecond timer would run at a different speed on a slower validator.
const RESPAWN_TICKS: u32 = crate::state::ticks_for(3_200);

/// One volley every 8 ticks (spec §2, `volley_interval = 8 ticks`).
const VOLLEY_INTERVAL_TICKS: u8 = crate::state::ticks_for(3_200) as u8;

/// `bullets_per_volley = 3 + alive_players` — difficulty as bullet density, so twenty
/// players make a visibly harder fight rather than a boss with a hidden HP multiplier.
const BASE_VOLLEY_BULLETS: usize = 3;

/// Fan width as a tangent denominator: the outermost bullet of a full 23-shot volley is
/// offset by `11/24`, ≈ 25° off the aim line. Larger denominator, tighter fan.
const SPREAD_DEN: i32 = 24;

/// The vent opens at `sum(parts) < 35 % of sum(parts_max)`, compared as
/// `sum × 100 < sum_max × 35` so no percentage is ever a float. Same numbers as
/// `shoot.rs`, which recomputes this on every landed shot; the tick recomputes it too
/// because parts can also be destroyed between ticks by other players' transactions.
const VENT_THRESHOLD_NUM: u32 = 35;
const VENT_THRESHOLD_DEN: u32 = 100;

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

// Where a volley leaves the boss is [`crate::hitboxes::MUZZLES`] — one entry per thorn,
// each carrying the `Boss.parts` index it fires from and the boss-local point it fires
// at, generated from the same slice of the art `PART_HITBOXES` comes from. This file
// held two hand-written copies of that in turn: first a table of four offsets that had
// drifted into the mace and the claws while the thorns sat silent, then a `const` block
// re-deriving the centres beside its own `THORN_PART_FIRST` guess at which parts were
// thorns. Neither is here any more. Move a thorn in the art, re-run
// `tools/gen_hitboxes.py`, and both the muzzle and the part it is gated on move with it.

const _: () = {
    // `dx`/`dy` are i8. A speed that does not fit truncates silently into a bullet
    // travelling backwards.
    assert!(BULLET_SPEED > 0 && BULLET_SPEED <= i8::MAX as i32);
    // A full volley must be spawnable without the pool being the binding constraint.
    assert!(BASE_VOLLEY_BULLETS + MAX_SEATS <= MAX_BULLETS);
    assert!(PLAYER_HIT_RADIUS > 0);
};

// ---------------------------------------------------------------------------
// Deterministic entropy
// ---------------------------------------------------------------------------

/// SplitMix64's finalizer. The bullet spread's only source of variety.
///
/// Not a hash syscall and not `sol_sha256`: this is ~8 instructions against a 400 K
/// budget, it is `no_std`, and — the reason that matters — the browser reproduces it
/// exactly with `BigInt.asUintN(64, …)`, so the client can draw the *same* volley
/// locally the instant it sees the tick rather than waiting for the account
/// notification. Every operation is `wrapping_*`: `overflow-checks` is on for release
/// builds and an entropy mix that panics would kill the crank.
///
/// This is not a CSPRNG and does not need to be. The affix seed is public the moment
/// the arena is created, there is no token and no economy (spec §1 non-goals), and
/// predicting a co-op PvE boss's spread pattern is called "learning the fight".
#[inline]
fn mix64(seed: u64) -> u64 {
    let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/// Scale `(vx, vy)` to a length of [`BULLET_SPEED`] without a square root.
///
/// Uses alpha-max-plus-beta-min (`max + min/2`), which *over*-estimates the true length
/// by between 0 % and 6.07 %. Over-estimating is the safe direction: the resulting
/// velocity is `BULLET_SPEED × [0.943, 1.0]`, so a bullet never moves further in one
/// tick than the constant says it does, and never rounds both components to zero (the
/// larger one is always ≥ `BULLET_SPEED × 0.94`).
///
/// Returns `None` for a zero vector, which is a bullet with nowhere to go.
#[inline]
fn unit_velocity(vx: i32, vy: i32) -> Option<(i8, i8)> {
    let (ax, ay) = (vx.unsigned_abs(), vy.unsigned_abs());
    let approx_len = ax.max(ay).saturating_add(ax.min(ay) / 2) as i32;
    if approx_len == 0 {
        return None;
    }
    // |vx| ≤ approx_len, so |vx × SPEED / approx_len| ≤ SPEED ≤ 127: both casts fit.
    let dx = vx.saturating_mul(BULLET_SPEED) / approx_len;
    let dy = vy.saturating_mul(BULLET_SPEED) / approx_len;
    Some((dx as i8, dy as i8))
}

/// Swept collision: does the segment the bullet travelled this tick pass within
/// [`PLAYER_HIT_RADIUS`] of `(px, py)`?
///
/// A point-in-circle test at the bullet's *new* position would let a 48-unit step jump
/// clean over a 24-unit-wide player — the classic bullet-hell tunnelling bug, and one
/// that shows up as "I definitely dodged that" rather than as an error. Testing the
/// segment decouples bullet speed from hitbox size entirely.
///
/// Closest-approach distance is compared without dividing: for the segment
/// `w = p − from`, `s = to − from`, the squared distance times `|s|²` is
/// `|w|²·|s|² − (w·s)²` in the interior case, and the endpoint cases are exact. Widened
/// to `i64` because `(w·s)²` leaves `i32` for large `w`; on BPF that is free.
#[inline]
fn bullet_hits(from: (i32, i32), to: (i32, i32), px: i32, py: i32) -> bool {
    let (sx, sy) = ((to.0 - from.0) as i64, (to.1 - from.1) as i64);
    let (wx, wy) = ((px - from.0) as i64, (py - from.1) as i64);

    let len2 = sx * sx + sy * sy;
    let hit2 = (PLAYER_HIT_RADIUS as i64) * (PLAYER_HIT_RADIUS as i64);
    if len2 == 0 {
        // Degenerate: a bullet that did not move. Fall back to the point test rather
        // than dividing by zero or reporting a hit on every player in range.
        return wx * wx + wy * wy <= hit2;
    }

    let dot = wx * sx + wy * sy;
    let scaled = if dot <= 0 {
        // Closest point is the start of the segment.
        (wx * wx + wy * wy) * len2
    } else if dot >= len2 {
        // Closest point is the end of the segment.
        let (ex, ey) = (wx - sx, wy - sy);
        (ex * ex + ey * ey) * len2
    } else {
        // Perpendicular foot lands inside the segment.
        (wx * wx + wy * wy) * len2 - dot * dot
    };

    scaled <= hit2 * len2
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/// One live player, copied out of `Players` once so the 128 × 20 collision loop strides
/// a 24-byte stack array instead of a 96-byte account slot. This is the single biggest
/// CU saving in the handler and the reason the inner loop is affordable at all.
#[derive(Clone, Copy)]
struct Target {
    seat: u8,
    x: i32,
    y: i32,
}

/// The clock, the VRF timeout, and the phase gate — everything one execution does before
/// it is allowed to touch the boss.
///
/// Returns `true` when the caller should run [`step`]. Split from [`process`] rather than
/// inlined there so the unit tests below drive the *same* sequencing the crank does; two
/// copies of "what a tick does before the fight" is how a test comes to pass against an
/// order the chain does not run.
///
/// The clock advances first, unconditionally, and that ordering is load-bearing — see
/// point 4 of the module docs. Saturating, not wrapping: at `u32::MAX` the clock stops and
/// the client's watchdog settles the match, where wrapping would rewind every rate limiter
/// and every respawn deadline at once. (A match is ~900 ticks; this is a guard, not a
/// scenario.)
///
/// `abandon_roll` is total and self-gating: it checks the phase and the deadline itself,
/// so this is one call and no second copy of [`crate::state::ROLL_TIMEOUT_TICKS`].
fn heartbeat(arena: &mut Arena) -> bool {
    arena.tick = arena.tick.saturating_add(1);
    if arena.phase == PHASE_ROLLING {
        // Before the timeout this writes nothing and the arena stays in `ROLLING` waiting
        // for the oracle; after it, the roll is abandoned back to `SETTLING` with **no
        // seed**, which is what makes `begin_next_incarnation` refuse rather than run an
        // incarnation whose ruleset nobody can prove was rolled.
        arena.abandon_roll();
        return false;
    }
    arena.phase == PHASE_FIGHTING
}

/// The whole game loop, as pure state transition — no accounts, no CPI, no clock.
///
/// Split out from [`process`] so it can be run against plain structs in a unit test.
/// Nothing in here can panic or return an error: it is the body of an instruction that
/// is not allowed to fail. `arena.tick` is already this tick's value — [`heartbeat`]
/// advanced it — and nothing here writes it.
fn step(arena: &mut Arena, boss: &mut Boss, players: &mut Players) {
    let tick = arena.tick;

    // ---- 1. respawns, and the live-target list ---------------------------
    //
    // Deliberate deviation from the spec's ordering, which respawns *after* collision:
    // doing it here means one pass over the 1,924-byte `Players` account instead of
    // two. The only behavioural difference is that a player who respawns on tick T is
    // exposed to tick T's bullets — and they respawn at the entrance, roughly half the
    // arena from the boss, so in practice there are none to be exposed to.
    let mut live = [Target { seat: 0, x: 0, y: 0 }; MAX_SEATS];
    let mut live_n = 0usize;
    // Seats standing in the arena at all, alive or dead. An unclaimed seat is
    // all-zero, so `zone` alone separates "nobody has entered yet" from "everybody
    // died" without needing to look at `session_pubkey` or the occupancy bitmask.
    let mut arena_occupants = 0u32;
    // Seats that are down *with a deadline still to come*. The wipe check below is
    // "everybody is dead and nobody is coming back", not "everybody is dead right now":
    // a solo raider stamps their own respawn on the tick they die, and counting that as
    // a wipe made `RESPAWN_TICKS` unreachable below two occupants — one player alone died
    // once and the match ended. A seat at 0 HP with `respawn_at_tick == 0` is *not*
    // pending; that is the "not scheduled" value, and it is what still makes a real wipe
    // fire. Enrage remains the bound on a fight that would otherwise respawn forever.
    let mut pending_respawns = 0u32;

    for seat in 0..MAX_SEATS {
        let slot = &mut players.slots[seat];
        if slot.zone != ZONE_ARENA {
            continue;
        }
        arena_occupants += 1;

        if slot.hp == 0 {
            // `respawn_at_tick == 0` means "not scheduled" — a seat that entered the
            // arena at 0 HP through some path we did not anticipate stays down rather
            // than resurrecting on tick 1.
            if slot.respawn_at_tick != 0 && tick >= slot.respawn_at_tick {
                slot.hp = slot.hp_max;
                let (x, y) = entrance_for(seat);
                slot.x = x;
                slot.y = y;
                slot.respawn_at_tick = 0;
            } else {
                if slot.respawn_at_tick != 0 {
                    pending_respawns += 1;
                }
                continue;
            }
        }

        live[live_n] = Target {
            seat: seat as u8,
            x: slot.x as i32,
            y: slot.y as i32,
        };
        live_n += 1;
    }

    // ---- 2. advance bullets, and collide ---------------------------------
    for index in 0..MAX_BULLETS {
        let bullet = &mut arena.bullets[index];
        if bullet.active != BULLET_ACTIVE {
            continue;
        }

        let from = (bullet.x as i32, bullet.y as i32);
        let to = (from.0 + bullet.dx as i32, from.1 + bullet.dy as i32);

        // Walls. i16 + i8 cannot overflow in i32, so `to` is a valid probe already;
        // `wall_at` folds the old arena-bounds test into the same lookup because
        // off-map is solid, and clearing it is what proves the narrowing casts below.
        //
        // This is what makes the dungeon tactical instead of decorative: a volley fired
        // down a 2-tile corridor dies on the corridor wall, so holding a corridor is a
        // real position and standing in an open hall is not.
        //
        // Two point samples, not one: a bullet covers BULLET_SPEED = 48 units per tick
        // and the map's thinnest solid feature is a 2×2 pillar, 32 units through, so an
        // endpoint-only test would let a volley pass clean through the pillar a player
        // is hiding behind. Samples 24 units apart cannot skip a 32-unit obstacle. Same
        // tunnelling argument `bullet_hits` makes for players, same symptom if it is
        // skipped — cover that does not cover.
        //
        // ponytail: two lookups, not a DDA walk of the swept segment. A solid feature
        // thinner than 24 units would still be jumped; `assets/map/arena.json` contains
        // none and would have to grow one before it could matter. Upgrade path if it
        // does: step the segment tile by tile, at ~3 lookups per bullet instead of 2.
        //
        // The wall samples *clip* the swept segment, they do not cancel it. Freeing the
        // bullet here and skipping the player test — which is what this used to do — made
        // a player standing against a wall partially immune: every shot aimed at them
        // ended inside the wall behind them and was deleted before anything asked whether
        // it had crossed them on the way. `end` is how far the bullet actually got, and
        // the hit test below runs on `from → end` whether or not the step was stopped.
        let mid = ((from.0 + to.0) / 2, (from.1 + to.1) / 2);
        let (blocked, end) = if wall_at(mid.0, mid.1) {
            // Stopped in the first half: it never reached the midpoint, so it swept
            // nothing. Clipping to `from` rather than `mid` is what keeps a bullet from
            // reaching through the wall it died on.
            (true, from)
        } else if wall_at(to.0, to.1) {
            (true, mid)
        } else {
            (false, to)
        };

        // Broad phase: the swept segment's bounding box, inflated by the hit radius.
        // Four compares per player reject almost everything before any multiply, which
        // is what keeps 128 × 20 pair tests inside the budget.
        let lo_x = from.0.min(end.0) - PLAYER_HIT_RADIUS;
        let hi_x = from.0.max(end.0) + PLAYER_HIT_RADIUS;
        let lo_y = from.1.min(end.1) - PLAYER_HIT_RADIUS;
        let hi_y = from.1.max(end.1) + PLAYER_HIT_RADIUS;

        let mut i = 0usize;
        while i < live_n {
            let target = live[i];
            if target.x < lo_x
                || target.x > hi_x
                || target.y < lo_y
                || target.y > hi_y
                || !bullet_hits(from, end, target.x, target.y)
            {
                i += 1;
                continue;
            }

            bullet.active = BULLET_FREE;

            let slot = &mut players.slots[target.seat as usize];
            slot.hp = slot.hp.saturating_sub(BULLET_DAMAGE);
            if slot.hp == 0 {
                // Dead. `respawn_at_tick` is the only death *state* there is — aliveness
                // is derived from `hp`, so there is no flag to fall out of sync — and
                // `deaths` is the only death *record*. Both are written on this one line
                // for that reason: a death counted anywhere else is a second definition of
                // "died", and the two would diverge the first time a player is killed by a
                // path that forgets one of them. Saturating; a raid that dies 65,535 times
                // has stopped caring about the count.
                //
                // It is also the only trace a wipe-heavy raid leaves: `survived` is one bit
                // sampled at settle time, so without this a player who died nineteen times
                // and respawned is indistinguishable from one who never took a hit.
                slot.respawn_at_tick = tick.saturating_add(RESPAWN_TICKS);
                slot.deaths = slot.deaths.saturating_add(1);
                // `tick >= 1` (heartbeat ran), so the deadline just stamped is non-zero
                // and this seat is coming back. Counted here as well as in the respawn
                // pass because a seat that dies *this* tick was alive when that pass ran.
                pending_respawns += 1;
                // Swap-remove from the live list: this seat can absorb no more bullets
                // this tick, and shrinking the list shortens every remaining bullet's
                // inner loop.
                live_n -= 1;
                live[i] = live[live_n];
            }
            // One bullet, one hit — it is spent either way, so stop scanning.
            break;
        }

        // Spent on a player, or stopped by the wall it was clipped against. Either way
        // it does not move; `to` is only narrowed to `i16` on the path where `wall_at`
        // cleared it, which is what proves the casts.
        if bullet.active != BULLET_ACTIVE {
            continue;
        }
        if blocked {
            bullet.active = BULLET_FREE;
            continue;
        }
        bullet.x = to.0 as i16;
        bullet.y = to.1 as i16;
    }

    // ---- 3. alive count ---------------------------------------------------
    //
    // Recomputed from the slots rather than decremented as players die. `shoot` and
    // `enter_gate` also touch this number; deriving it every tick means a bug in either
    // of them self-heals within 400 ms instead of permanently mis-sizing every volley.
    // `live_n <= MAX_SEATS = 20`, so the cast cannot truncate.
    arena.alive_count = live_n as u8;

    // ---- 4. aggro ---------------------------------------------------------
    //
    // Nearest alive player, which is the whole targeting rule (spec §3) and is what
    // makes stepping forward pull fire off the group. No grouping feature, no threat
    // table — tanking is emergent from this one loop.
    let (boss_x, boss_y) = (boss.x as i32, boss.y as i32);
    let mut best_seat = NO_TARGET;
    let mut best_dist2 = i64::MAX;
    let mut target_xy = (0i32, 0i32);
    for target in live.iter().take(live_n) {
        let (dx, dy) = ((target.x - boss_x) as i64, (target.y - boss_y) as i64);
        let dist2 = dx * dx + dy * dy;
        if dist2 < best_dist2 {
            best_dist2 = dist2;
            best_seat = target.seat;
            target_xy = (target.x, target.y);
        }
    }
    boss.target_seat = best_seat;

    // ---- 5. the volley ----------------------------------------------------
    if boss.attack_timer > 0 {
        boss.attack_timer -= 1;
    } else {
        boss.attack_timer = VOLLEY_INTERVAL_TICKS;
        if best_seat != NO_TARGET {
            spawn_volley(arena, boss, target_xy, tick, live_n);
        }
    }

    // ---- 6. the vent ------------------------------------------------------
    //
    // Derived state, cached for the client. Recomputed from the parts every tick and
    // never set independently: the boss is a shell, and `sum(parts)` *is* its health.
    // 9 × 65,535 × 100 ≈ 59 M, so u32 is ample; saturating anyway.
    let shell: u32 = boss.parts.iter().map(|&hp| hp as u32).sum();
    let shell_max: u32 = boss.parts_max.iter().map(|&hp| hp as u32).sum();
    boss.vent_open = u8::from(
        shell.saturating_mul(VENT_THRESHOLD_DEN) < shell_max.saturating_mul(VENT_THRESHOLD_NUM),
    );

    // ---- 7. end of match --------------------------------------------------
    //
    // The three ways a fight ends, as three *distinct* outcomes rather than one shared
    // phase. A raid that killed the core and a raid that was wiped used to land in the
    // same `PHASE_SETTLING` with nothing on chain telling them apart, which meant winning
    // was not recorded anywhere and there was no win condition in the program at all.
    //
    // Win: the core is dead. `shoot` ends the fight too, on the killing blow, so the
    // killer sees it instantly; re-deriving it here costs one compare and covers the case
    // where the last point of core HP was removed by a transaction that then failed to
    // land its own write.
    //
    // Wipe: every player who is *in* the arena is dead **and nobody is coming back**.
    // `arena_occupants > 0` is what stops a match that has been armed but not yet entered
    // from settling on tick 1 — there is no grace timer and no extra field, just the
    // distinction between "nobody here" and "nobody left". `pending_respawns == 0` is the
    // other half: a seat with a deadline still to come is not a corpse, and reading it as
    // one is what made a solo raid unplayable — the lone occupant's death and the wipe
    // landed on the same tick, so the respawn this handler had just stamped was never
    // reached. Respawns are resolved in stage 1, above, so by here that count is current.
    //
    // Enrage: the six-minute timeout, kept distinct from a wipe because "you ran out of
    // time" and "you all died" are different end screens and nothing else on chain
    // separates them. `!= 0` because an `enrage_at_tick` that was never written would
    // otherwise end the match on its first tick.
    //
    // Checked in that order, and the order is the tie-break: a raid whose last player dies
    // to the same volley that the core dies on has *won*. Below that, `end_fight` is
    // idempotent and total — it writes phase and outcome together, refuses to overwrite an
    // outcome already recorded, and returns `false` rather than `Err`, which is the only
    // shape a crank can use. So when `shoot` recorded the win 200 ms ago this call changes
    // nothing, and the win does not become an enrage one tick later.
    let outcome = if boss.core_hp == 0 {
        OUTCOME_WIN
    } else if arena_occupants > 0 && live_n == 0 && pending_respawns == 0 {
        OUTCOME_WIPE
    } else if arena.enrage_at_tick != 0 && tick >= arena.enrage_at_tick {
        OUTCOME_ENRAGE
    } else {
        OUTCOME_UNDECIDED
    };
    if outcome != OUTCOME_UNDECIDED {
        arena.end_fight(outcome);
    }
}

/// Which way a door's seats fan: *along* the wall it is set into, never through it.
///
/// The `E` marks sit one tile inside the border ring, so for any door the axis it is
/// near the edge on is the axis the wall runs across — fan along the other one. Derived
/// rather than tabulated, so redrawing `assets/map/arena.json` with a door on a
/// different wall re-orients its fan without anyone remembering to.
#[inline]
const fn fans_along_x(ex: i16, ey: i16) -> bool {
    let (x, y) = (ex as i32, ey as i32);
    let to_x_edge = if x < ARENA_SIZE - x { x } else { ARENA_SIZE - x };
    let to_y_edge = if y < ARENA_SIZE - y { y } else { ARENA_SIZE - y };
    to_y_edge <= to_x_edge
}

/// Where seat `seat` comes back: at one of the map's drawn doors, fanned out along that
/// door's wall so simultaneous respawns do not stack into one sprite. Clamped to the
/// arena because a position outside it would be un-hittable and un-renderable.
///
/// The door is `map::ENTRANCES[seat % 4]` — the four `E` tiles `tools/gen_map.py`
/// compiles out of the drawn grid — so the respawn point *is* the mark on the map
/// rather than a pair of constants that used to sit here describing the arena a second
/// time. Round-robin, so twenty players come back through all four doors instead of
/// funnelling into one, and each door carries `20 / 4 = 5` ranks centred on the `E`.
///
/// `pub(crate)` for `enter_gate`, which has to put a player through the gate at the same
/// place a respawn puts them. Two definitions of "the entrance" is exactly the kind of
/// duplication that drifts and then reads as a teleport bug.
///
/// `const fn` so the assertion below can run it on every seat at compile time.
pub(crate) const fn entrance_for(seat: usize) -> (i16, i16) {
    let doors = map::ENTRANCES.len();
    let (ex, ey) = map::ENTRANCES[seat % doors];
    // Rank within the door, centred so the fan is symmetric about the `E` tile.
    let offset = ((seat / doors) as i32)
        .saturating_sub((MAX_SEATS / doors / 2) as i32)
        .saturating_mul(ENTRANCE_SPACING);
    let (x, y) = if fans_along_x(ex, ey) {
        (clamp_arena((ex as i32).saturating_add(offset)), ey as i32)
    } else {
        (ex as i32, clamp_arena((ey as i32).saturating_add(offset)))
    };
    (x as i16, y as i16)
}

/// `i32::clamp` is not `const`; this is, and it is the only clamp in the file.
#[inline]
const fn clamp_arena(v: i32) -> i32 {
    if v < 0 {
        0
    } else if v > ARENA_SIZE - 1 {
        ARENA_SIZE - 1
    } else {
        v
    }
}

/// Every respawn point stands on floor in the generated map.
///
/// The doors themselves are `E` tiles and floor by construction, but the *fan* is not:
/// a rank three tiles along the wall can still land in a pillar if the map is redrawn
/// with one there. `tools/gen_map.py` proves the same points plus reachability to the
/// heart chamber — but only when someone runs the tool. This fires on every
/// `cargo check`, against the table that actually shipped. A respawn inside a wall is a
/// player who cannot move in any direction for the rest of the match, and there is no
/// runtime signal for it at all: they simply stop.
const _: () = {
    let mut seat = 0;
    while seat < MAX_SEATS {
        let (x, y) = entrance_for(seat);
        assert!(
            !wall_at(x as i32, y as i32),
            "a respawn point lands in a wall in map::WALLS -- redraw assets/map/arena.json \
             (move an `E`, or clear the tiles beside it) and re-run tools/gen_map.py",
        );
        seat += 1;
    }
};

/// Claim up to `3 + alive` free pool slots and fire them at `target` from whichever
/// thorn clusters are still standing.
///
/// Destroying thorn *n* removes one emitter, straight off `boss.parts` — there is no
/// separate emitter list to keep in sync, which is why "shoot the thorns off and the
/// volleys stop" is a property of the data rather than a rule someone has to remember.
/// With every thorn gone the boss fires nothing at all.
fn spawn_volley(arena: &mut Arena, boss: &Boss, target: (i32, i32), tick: u32, alive: usize) {
    let mut muzzles = [(0i32, 0i32); N_MUZZLES];
    let mut muzzle_n = 0usize;
    for &Muzzle { part, x, y } in MUZZLES.iter() {
        // The gate is the muzzle's own `part` index, so the emitter that goes quiet is
        // always the thorn the player just shot off — not a limb an index guess landed on.
        if boss.parts[part] != 0 {
            muzzles[muzzle_n] = (boss.x as i32 + x, boss.y as i32 + y);
            muzzle_n += 1;
        }
    }
    if muzzle_n == 0 {
        return;
    }

    // `3 + alive_players`: difficulty as bullet density. Bounded by the const assert
    // above at 23, well under the 128-slot pool.
    let wanted = BASE_VOLLEY_BULLETS + alive;

    // One entropy draw per tick, expanded per bullet. `affix_seed` is the incarnation's
    // roll (VRF in v1.1, `hashv([arena_key, incarnation])` today); mixing the tick in
    // makes every volley of the fight different while staying a pure function of state
    // the client already has.
    let mut seed_bytes = [0u8; 8];
    seed_bytes.copy_from_slice(&arena.affix_seed[..8]);
    let tick_entropy = mix64(u64::from_le_bytes(seed_bytes) ^ mix64(tick as u64));

    let mut cursor = (arena.bullet_cursor as usize) % MAX_BULLETS;
    let mut spawned = 0usize;

    // Fixed bound: one sweep of the pool, no allocation, and a full pool simply drops
    // the rest of the volley rather than searching forever.
    for _ in 0..MAX_BULLETS {
        if spawned == wanted {
            break;
        }
        let slot_free = arena.bullets[cursor].active != BULLET_ACTIVE;
        let slot_index = cursor;
        cursor = (cursor + 1) % MAX_BULLETS;
        if !slot_free {
            continue;
        }

        let muzzle = muzzles[spawned % muzzle_n];
        let (aim_x, aim_y) = (target.0 - muzzle.0, target.1 - muzzle.1);

        // Symmetric fan around the aim line, plus a −1/0/+1 jitter per bullet so two
        // volleys at the same range are not the same wall of bullets. `k / SPREAD_DEN`
        // is the tangent of the offset angle, applied by rotating the aim vector with
        // its own perpendicular `(−y, x)` — no trigonometry, no lookup table.
        let fan = spawned as i32 - wanted as i32 / 2;
        let jitter = (mix64(tick_entropy ^ spawned as u64) % 3) as i32 - 1;
        let k = fan + jitter;
        let vx = aim_x.saturating_mul(SPREAD_DEN) - aim_y.saturating_mul(k);
        let vy = aim_y.saturating_mul(SPREAD_DEN) + aim_x.saturating_mul(k);

        let Some((dx, dy)) = unit_velocity(vx, vy) else {
            // Target is exactly on the muzzle. Nothing sensible to aim at; skip this
            // bullet rather than spawning one with zero velocity that would sit in the
            // pool until the match ends.
            continue;
        };

        let bullet = &mut arena.bullets[slot_index];
        bullet.x = muzzle.0.clamp(0, ARENA_SIZE - 1) as i16;
        bullet.y = muzzle.1.clamp(0, ARENA_SIZE - 1) as i16;
        bullet.dx = dx;
        bullet.dy = dy;
        bullet.active = BULLET_ACTIVE;
        spawned += 1;
    }

    arena.bullet_cursor = cursor as u8;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/// Accounts, in the order the crank's frozen list was scheduled with:
///
/// | # | Account | |
/// |---|---|---|
/// | 0 | `Arena` | writable — clock, bullet pool, phase |
/// | 1 | `Boss` | writable — timer, aggro, vent |
/// | 2 | `Players` | writable — health, respawns |
/// | 3 | `crank_signer` | read-only signer, `[b"crank-executor", crank_authority]` under `Crank111…` |
///
/// Four metas plus two program ids: six keys against the ER's ~38-key ceiling. That
/// headroom is not spare capacity — the list is frozen at schedule time and replayed
/// every tick, so a layout that breached the ceiling would be rejected on every
/// execution and delete the task ~26 s in.
///
/// No instruction data. Every rejection the crank can reach is `Ok(())` — see the module
/// docs for why an error there is fatal and a no-op is merely visible. The crank-signer
/// check is the single exception and returns [`HeartrotError::NotCrankSigner`]; the same
/// docs argue why the crank cannot reach it.
pub fn process(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [arena_account, boss_account, players_account, crank_signer, ..] = accounts else {
        return Ok(());
    };

    // Account-level checks first, before anything is borrowed — `try_borrow_mut` holds
    // the `AccountView` mutably for the life of the borrow, so the immutable
    // interrogation has to happen up front.
    if assert_signer(crank_signer).is_err() {
        return Err(HeartrotError::NotCrankSigner.into());
    }
    for account in [&*arena_account, &*boss_account, &*players_account] {
        if assert_owned_by(account, program_id).is_err() || assert_writable(account).is_err() {
            return Ok(());
        }
    }

    let arena_key = *arena_account.address();
    let signer_key = *crank_signer.address();

    // `Boss` and `Players` must belong to *this* arena. The frozen crank list makes a
    // mismatch unlikely rather than impossible — nothing stops someone submitting a
    // hand-built `boss_tick` with the right crank signer and the wrong boss — and the
    // consequence would be one match's clock draining another match's boss.
    //
    // Re-derived, not compared against the stored `bump`: several bumps yield a valid
    // off-curve address for the same seeds, so trusting a bump read out of the account
    // being validated proves nothing about the account. `assert_pda` searches for the
    // canonical one, at roughly 1,500 CU a candidate against the 400,000 CU ceiling.
    // It runs here rather than after the casts for the same reason the checks above do:
    // `try_borrow_mut` holds the `AccountView`, so every immutable interrogation has to
    // happen first.
    if assert_pda(boss_account, &[SEED_BOSS, arena_key.as_array()], program_id).is_err()
        || assert_pda(
            players_account,
            &[SEED_PLAYERS, arena_key.as_array()],
            program_id,
        )
        .is_err()
    {
        return Ok(());
    }

    // `load_mut` is the only sanctioned way to reach these structs: it rejects a short
    // account, a misaligned pointer, a wrong discriminator and a stale layout version.
    // The discriminator is the only thing stopping `Boss` being passed where `Players`
    // is expected, and Pinocchio checks none of it for us.
    let Ok(mut arena_data) = arena_account.try_borrow_mut() else {
        return Ok(());
    };
    let Ok(arena) = load_mut::<Arena>(&mut arena_data) else {
        return Ok(());
    };

    // The crank signer is the entire authorization for this instruction, and it is not
    // optional theatre: ER transaction fees are 0 and the ER runs no fee-payer
    // validation, so without this check any keypair could drive the match clock as fast
    // as it could send transactions — instant enrage, instant wipe, for free.
    //
    // Derived rather than stored because the layout has no `crank_signer` field, only
    // the `crank_authority` it comes from. `derive_program_address` costs one sha256
    // plus one curve check per bump attempt (~1.2 attempts expected), a rounding error
    // against 400 K.
    //
    // These two are the file's only `Err`, and they are safe for the reason the module
    // header gives: `crank_authority` is write-once in `init_arena`, `start_match`
    // freezes the signer derived from it into the crank row, and this re-derives from
    // the same field — so the real crank cannot fail here and spends none of its ten
    // strikes. A caller that *does* fail is hand-building a `boss_tick`, and it now gets
    // `Custom(2)` instead of a success indistinguishable from a real tick.
    let Some((expected_signer, _bump)) = Address::derive_program_address::<2>(
        &[CRANK_SIGNER_SEED, arena.crank_authority.as_slice()],
        &CRANK_PROGRAM_ID,
    ) else {
        return Err(HeartrotError::NotCrankSigner.into());
    };
    if signer_key != expected_signer {
        return Err(HeartrotError::NotCrankSigner.into());
    }

    // The clock, the VRF timeout and the phase gate, before any other account is even
    // borrowed: outside `FIGHTING` this handler touches nothing but `Arena`, so `Boss` and
    // `Players` are never mapped on an idle tick. Lobby, settled and rolled are no-ops
    // beyond the clock, and the crank keeps firing harmlessly through them — cancelling
    // the task is the settle path's job, from outside, because a crank cannot cancel
    // itself any more than it can re-arm itself.
    if !heartbeat(arena) {
        return Ok(());
    }

    let Ok(mut boss_data) = boss_account.try_borrow_mut() else {
        return Ok(());
    };
    let Ok(boss) = load_mut::<Boss>(&mut boss_data) else {
        return Ok(());
    };
    let Ok(mut players_data) = players_account.try_borrow_mut() else {
        return Ok(());
    };
    let Ok(players) = load_mut::<Players>(&mut players_data) else {
        return Ok(());
    };

    step(arena, boss, players);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // `N_PARTS` sizes the fixtures' part arrays and `PHASE_SETTLING` / `ROLL_TIMEOUT_TICKS`
    // are what the assertions read; the handler itself names none of the three — it writes
    // phases only through the `Arena` helpers, which is the point.
    use crate::state::{Bullet, N_PARTS, PHASE_SETTLING, ROLL_TIMEOUT_TICKS};
    use bytemuck::Zeroable;

    fn fight() -> (Arena, Boss, Players) {
        let mut arena = Arena::zeroed();
        arena.phase = PHASE_FIGHTING;
        arena.enrage_at_tick = 900;
        arena.affix_seed = [7u8; 32];

        let mut boss = Boss::zeroed();
        boss.x = (ARENA_SIZE / 2) as i16;
        boss.y = (ARENA_SIZE / 2) as i16;
        boss.parts = [100; N_PARTS];
        boss.parts_max = [100; N_PARTS];
        boss.core_hp = 100;
        boss.core_hp_max = 100;
        boss.attack_timer = VOLLEY_INTERVAL_TICKS;

        (arena, boss, Players::zeroed())
    }

    /// One crank execution, minus the accounts — exactly what [`process`] does once the
    /// three structs are in hand. Every test drives this rather than [`step`] directly, so
    /// the clock and the phase gate are exercised in the order the chain runs them; a test
    /// helper that stepped the fight straight would be a second, kinder definition of
    /// "a tick" and would pass against an order the crank does not execute.
    fn tick_once(arena: &mut Arena, boss: &mut Boss, players: &mut Players) {
        if heartbeat(arena) {
            step(arena, boss, players);
        }
    }

    fn seat_in_arena(players: &mut Players, seat: usize, x: i16, y: i16) {
        let slot = &mut players.slots[seat];
        slot.zone = ZONE_ARENA;
        slot.x = x;
        slot.y = y;
        slot.hp = 100;
        slot.hp_max = 100;
        slot.session_pubkey = [1u8; 32];
    }

    /// A bullet moving 48 units a tick past a 24-unit-wide player is the exact case a
    /// naive point-in-circle test misses, and the symptom — "I dodged that" — is
    /// indistinguishable from lag. If the swept test regresses, this is the only thing
    /// that catches it.
    #[test]
    fn fast_bullets_do_not_tunnel_through_players() {
        // Player sits dead centre of the step the bullet takes this tick.
        assert!(bullet_hits((100, 100), (100 + BULLET_SPEED, 100), 100 + BULLET_SPEED / 2, 100));
        // Grazing at exactly the radius still counts; one unit further does not.
        assert!(bullet_hits((100, 100), (148, 100), 124, 100 + PLAYER_HIT_RADIUS));
        assert!(!bullet_hits((100, 100), (148, 100), 124, 100 + PLAYER_HIT_RADIUS + 1));
        // Behind the segment's start is a miss, not a hit on an infinite line.
        assert!(!bullet_hits((100, 100), (148, 100), 40, 100));
    }

    /// Ticks a bullet needs to cover `units`.
    ///
    /// The wall and pillar cases below were written against a 48-unit step and describe
    /// DISTANCES — "across the corridor", "through a 32-unit pillar". Asserting them
    /// after a single `tick_once` quietly encoded the step size into the geometry, so
    /// they broke the moment `TICK_MS` changed under them. Travelling a stated distance
    /// keeps the intent and survives the next rate change.
    const fn ticks_to_travel(units: i32) -> usize {
        ((units + BULLET_SPEED - 1) / BULLET_SPEED) as usize
    }

    /// The distance the bullet-vs-geometry cases are drawn around.
    const PROBE_UNITS: i32 = 48;

    /// The dungeon is only tactical if it stops bullets, and both halves of that have
    /// to hold: a volley fired across a corridor dies on the corridor wall, and a volley
    /// fired *along* the corridor lives. The pillar case is the one an endpoint-only
    /// test would get wrong — a 2×2 pillar is 32 units through and a bullet steps 48.
    #[test]
    fn bullets_stop_at_generated_walls() {
        let fired = |x: i16, y: i16, dx: i8, dy: i8| {
            let (mut arena, mut boss, mut players) = fight();
            // No thorns, so nothing else can spawn into the pool and confuse the count.
            boss.parts = [0; N_PARTS];
            arena.bullets[0] = Bullet { x, y, dx, dy, active: BULLET_ACTIVE, _pad0: 0 };
            for _ in 0..ticks_to_travel(PROBE_UNITS) {
                if arena.bullets[0].active != BULLET_ACTIVE {
                    break;
                }
                tick_once(&mut arena, &mut boss, &mut players);
            }
            arena.bullets[0].active == BULLET_ACTIVE
        };

        // Across the north corridor at tile row 20: x tiles 31–32 are floor, 15–30 and
        // 33–48 are the chamber-wall block. A bullet crossing it must die.
        assert!(!fired(520, 328, -(BULLET_SPEED as i8), 0), "corridor wall stops a volley");
        // Straight down the same corridor, tile rows 20 → 23, all floor. Must live.
        assert!(fired(520, 328, 0, BULLET_SPEED as i8), "a corridor is a firing lane");

        // The 2×2 pillar at tiles (2..3, 2..3) = units 32..63 on both axes. The bullet
        // starts on floor at tile x=1 and lands on floor at tile x=4: only the midpoint
        // sample sees the pillar at all.
        assert!(!fired(16, 40, BULLET_SPEED as i8, 0), "a pillar is not passable");

        // The border ring still frees a bullet, and does it through the same lookup that
        // used to be a separate arena-bounds test.
        assert!(!fired(24, 24, -(BULLET_SPEED as i8), 0), "off-map is solid");
    }

    /// Normalisation must never exceed `BULLET_SPEED` (the client extrapolates with the
    /// same integers, so a longer step desyncs the render) and must never round a real
    /// direction down to a stationary bullet.
    #[test]
    fn velocities_are_bounded_and_never_zero() {
        for vx in [-1000i32, -333, -1, 0, 1, 7, 512, 1023] {
            for vy in [-1000i32, -333, -1, 0, 1, 7, 512, 1023] {
                match unit_velocity(vx, vy) {
                    None => assert!(vx == 0 && vy == 0),
                    Some((dx, dy)) => {
                        let (dx, dy) = (dx as i32, dy as i32);
                        assert!(dx.abs() <= BULLET_SPEED && dy.abs() <= BULLET_SPEED);
                        assert!(dx != 0 || dy != 0, "({vx},{vy}) rounded to a dead bullet");
                    }
                }
            }
        }
    }

    /// The damage → death → respawn cycle, and the wipe rule that has to distinguish
    /// "everybody died" from "nobody has walked through the gate yet".
    #[test]
    fn damage_kills_respawns_and_wipes() {
        let (mut arena, mut boss, mut players) = fight();

        // Nobody in the arena: the boss ticks, but an empty arena is not a wipe.
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.tick, 1);
        assert_eq!(arena.phase, PHASE_FIGHTING);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(boss.target_seat, NO_TARGET);

        // Two players enter. Seat 7 is parked in the far corner, out of reach
        // of anything the boss can fire inside this test's span, and seat 3 is nearer, so
        // it is seat 3 the boss aims at.
        seat_in_arena(&mut players, 3, 400, 512);
        seat_in_arena(&mut players, 7, 100, 900);
        arena.bullets[0] = Bullet {
            x: 400 - BULLET_SPEED as i16,
            y: 512,
            dx: BULLET_SPEED as i8,
            dy: 0,
            active: BULLET_ACTIVE,
            _pad0: 0,
        };
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[3].hp, 100 - BULLET_DAMAGE);
        assert_eq!(arena.bullets[0].active, BULLET_FREE, "a spent bullet is freed");
        assert_eq!(arena.alive_count, 2);
        assert_eq!(boss.target_seat, 3, "nearest alive player is the aggro target");

        // Kill seat 3 outright. One seat down is not a wipe while seat 7 is standing, so
        // the fight carries on and the death is a respawn deadline rather than an ending.
        players.slots[3].hp = BULLET_DAMAGE;
        arena.bullets[1] = Bullet {
            x: 400 - BULLET_SPEED as i16,
            y: 512,
            dx: BULLET_SPEED as i8,
            dy: 0,
            active: BULLET_ACTIVE,
            _pad0: 0,
        };
        let died_on = arena.tick + 1;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[3].hp, 0);
        assert_eq!(players.slots[3].respawn_at_tick, died_on + RESPAWN_TICKS);
        assert_eq!(arena.alive_count, 1);
        assert_eq!(players.slots[3].deaths, 1, "a death is counted where it is stamped");
        assert_eq!(arena.phase, PHASE_FIGHTING, "one seat down is not a wipe");
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);

        // Let the respawn deadline pass: the seat comes back at full health, at its door.
        while arena.tick < died_on + RESPAWN_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
        }
        assert_eq!(players.slots[3].hp, 100);
        assert_eq!(players.slots[3].respawn_at_tick, 0);
        assert_eq!((players.slots[3].x, players.slots[3].y), entrance_for(3));
        assert_eq!(players.slots[3].deaths, 1, "coming back is not a second death");

        // Now everyone in the arena is down with nothing scheduled. That, and only that,
        // is a wipe — and it is a loss, distinguishable from a win forever after. (Set
        // directly: the bullet → damage → death path is what the lines above test, and
        // the wipe rule reads `hp` and `respawn_at_tick`, not how they got there.)
        players.slots[3].hp = 0;
        players.slots[3].respawn_at_tick = 0;
        players.slots[7].hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(arena.phase, PHASE_SETTLING, "every arena occupant dead is a wipe");
        assert_eq!(arena.outcome, OUTCOME_WIPE, "and a wipe is not a win");

        // The crank keeps firing after the fight, and must change nothing but the clock.
        let after = arena.tick;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.tick, after + 1, "the clock is the crank's heartbeat");
        assert_eq!(arena.outcome, OUTCOME_WIPE, "the outcome is written once");
    }

    /// One player alone must be able to play the game. Their death and the "everybody is
    /// dead" test land on the same tick, so reading that as a wipe made `RESPAWN_TICKS`
    /// unreachable below two occupants: a solo raider died once and the match ended, with
    /// the respawn deadline this handler had just stamped never read by anything.
    #[test]
    fn a_solo_raid_respawns_instead_of_wiping() {
        let (mut arena, mut boss, mut players) = fight();
        // No thorns: the only bullet in this test is the one it fires by hand.
        boss.parts = [0; N_PARTS];
        seat_in_arena(&mut players, 0, 400, 512);
        players.slots[0].hp = BULLET_DAMAGE;
        arena.bullets[0] = Bullet {
            x: 400 - BULLET_SPEED as i16,
            y: 512,
            dx: BULLET_SPEED as i8,
            dy: 0,
            active: BULLET_ACTIVE,
            _pad0: 0,
        };
        let died_on = arena.tick + 1;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[0].hp, 0);
        assert_eq!(players.slots[0].respawn_at_tick, died_on + RESPAWN_TICKS);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(arena.phase, PHASE_FIGHTING, "a pending respawn is not a wipe");
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);

        // And the deadline is actually reached, which it never was before.
        while arena.tick < died_on + RESPAWN_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
            assert_eq!(arena.phase, PHASE_FIGHTING, "the lone raider is still coming back");
        }
        assert_eq!(players.slots[0].hp, 100, "one player alone respawns like anyone else");
        assert_eq!(players.slots[0].respawn_at_tick, 0);
        assert_eq!((players.slots[0].x, players.slots[0].y), entrance_for(0));
        assert_eq!(arena.alive_count, 1);

        // A seat that is down with *nothing* scheduled is still a wipe, solo or not.
        players.slots[0].hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.outcome, OUTCOME_WIPE, "nobody coming back is still a loss");

        // And enrage still ends a fight that would otherwise respawn forever.
        let (mut arena, mut boss, mut players) = fight();
        boss.parts = [0; N_PARTS];
        seat_in_arena(&mut players, 0, 400, 512);
        players.slots[0].hp = 0;
        players.slots[0].respawn_at_tick = u32::MAX;
        arena.tick = 899;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.outcome, OUTCOME_ENRAGE, "the clock still ends the match");
    }

    /// A bullet whose step ends inside a wall used to be deleted before anything asked
    /// whether it had crossed a player on the way, which made standing with your back to
    /// a wall partial immunity to fire aimed at you. The wall clips the swept segment; it
    /// does not cancel it — and the clip is what still stops the bullet reaching *through*.
    #[test]
    fn a_bullet_stopped_by_a_wall_still_hits_what_it_crossed() {
        // Map row y=15 (units 240..255): tiles x=10..14 are floor, x=15 begins the heart
        // chamber's wall block. The bullet steps 200 → 248, ending inside tile x=15.
        let shot = |px: i16| {
            let (mut arena, mut boss, mut players) = fight();
            boss.parts = [0; N_PARTS];
            seat_in_arena(&mut players, 0, px, 248);
            arena.bullets[0] = Bullet {
                x: 200,
                y: 248,
                dx: BULLET_SPEED as i8,
                dy: 0,
                active: BULLET_ACTIVE,
                _pad0: 0,
            };
            for _ in 0..ticks_to_travel(PROBE_UNITS) {
                if arena.bullets[0].active != BULLET_ACTIVE {
                    break;
                }
                tick_once(&mut arena, &mut boss, &mut players);
            }
            (players.slots[0].hp, arena.bullets[0].active)
        };

        // On the segment, hard against the wall: hit, and the bullet is spent.
        assert_eq!(
            shot(224),
            (100 - BULLET_DAMAGE, BULLET_FREE),
            "a player against a wall is not immune to fire aimed at them"
        );
        // Behind the wall the bullet died on: still cover, still not a hit.
        assert_eq!(shot(264), (100, BULLET_FREE), "a bullet does not reach through the wall");
    }

    /// Volleys are the difficulty curve (`3 + alive_players`) and the counterplay
    /// (destroy the thorns, the volleys stop). Both live in `spawn_volley`.
    #[test]
    fn volleys_scale_with_players_and_stop_with_the_thorns() {
        let (mut arena, mut boss, mut players) = fight();
        for seat in 0..4 {
            seat_in_arena(&mut players, seat, 300 + 40 * seat as i16, 700);
        }

        // Run until the attack timer fires.
        for _ in 0..=VOLLEY_INTERVAL_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
        }
        let fired = arena.bullets.iter().filter(|b| b.active == BULLET_ACTIVE).count();
        assert_eq!(fired, BASE_VOLLEY_BULLETS + 4, "3 + alive_players");
        assert!(
            arena.bullets.iter().filter(|b| b.active == BULLET_ACTIVE).all(|b| b.dx != 0 || b.dy != 0),
            "every spawned bullet has somewhere to go"
        );

        // Strip all four thorn clusters and the boss has no emitters left.
        for b in arena.bullets.iter_mut() {
            b.active = BULLET_FREE;
        }
        for m in MUZZLES.iter() {
            boss.parts[m.part] = 0;
        }
        for _ in 0..=VOLLEY_INTERVAL_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
        }
        assert!(
            arena.bullets.iter().all(|b| b.active == BULLET_FREE),
            "no thorns, no volleys"
        );
    }

    /// Respawns are read out of the drawn map, not restated beside it. The compile-time
    /// assertion already proves every point is floor; this proves it is floor *at a
    /// door* — every seat sits on one of the four `E` marks, all four doors are used,
    /// and the fan runs along the wall the door is set into rather than into it.
    #[test]
    fn respawns_come_out_of_the_drawn_doors() {
        const DOORS: usize = map::ENTRANCES.len();
        let mut used = [0usize; DOORS];
        let span = (ENTRANCE_SPACING * (MAX_SEATS / DOORS / 2) as i32) as i16;

        for seat in 0..MAX_SEATS {
            let (x, y) = entrance_for(seat);
            let (dx, dy) = map::ENTRANCES[seat % DOORS];
            used[seat % DOORS] += 1;
            if fans_along_x(dx, dy) {
                assert_eq!(y, dy, "seat {seat} fanned through its own wall");
                assert!((x - dx).abs() <= span, "seat {seat} fanned past its door");
            } else {
                assert_eq!(x, dx, "seat {seat} fanned through its own wall");
                assert!((y - dy).abs() <= span, "seat {seat} fanned past its door");
            }
        }
        assert_eq!(used, [MAX_SEATS / DOORS; DOORS], "every door carries seats");
    }

    /// The three ways a match ends, and the one way it must not. Each has to reach the
    /// same `SETTLING` phase carrying a *different* outcome — the whole point of the
    /// second axis is that after this the end screen can still tell them apart.
    #[test]
    fn end_conditions() {
        // Win.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        boss.core_hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.outcome, OUTCOME_WIN, "a dead core is a win");

        // Enrage.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        arena.tick = 899;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.outcome, OUTCOME_ENRAGE, "running out of time is not a wipe");

        // The killing blow that also kills the last player is a win, not a wipe — the
        // check order is the tie-break, and this is the case it decides.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        players.slots[0].hp = 0;
        boss.core_hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.outcome, OUTCOME_WIN, "the raid died winning");

        // `shoot` recording the win first is the true record. The crank's next execution
        // lands on a `SETTLING` arena, so it advances the clock and touches nothing else —
        // it must not re-score the match as the enrage its own timer would now see.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        assert!(arena.end_fight(OUTCOME_WIN), "the killer got there first");
        arena.tick = 899;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.outcome, OUTCOME_WIN, "the first outcome is the true one");
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.tick, 900, "the clock runs in every phase");

        // An arena with `enrage_at_tick` never written must not settle on tick 1.
        let (mut arena, mut boss, mut players) = fight();
        arena.enrage_at_tick = 0;
        seat_in_arena(&mut players, 0, 400, 512);
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_FIGHTING);

        // The vent is derived: strip the shell past 35 % and it opens, on its own.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.vent_open, 0);
        boss.parts = [30; N_PARTS];
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.vent_open, 1);
    }

    /// The VRF timeout — and the reason the clock had to move out of [`step`].
    ///
    /// A roll the oracle never answers has to expire, and the only clock that can expire
    /// it is this crank's. While `step` owned the tick counter the clock stopped the
    /// moment the fight ended, so in `PHASE_ROLLING` the comparison `abandon_roll` makes
    /// was frozen, the timeout never fired, and one VRF outage wedged the arena there for
    /// the life of the account. Nothing else in the program can notice that.
    #[test]
    fn an_unanswered_roll_expires_on_the_cranks_clock() {
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        boss.core_hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.outcome, OUTCOME_WIN);

        arena.begin_roll().expect("a won match may roll");
        let deadline = arena.roll_requested_tick + ROLL_TIMEOUT_TICKS;

        // Up to the deadline the arena stays in `ROLLING`, waiting for the oracle.
        while arena.tick < deadline {
            tick_once(&mut arena, &mut boss, &mut players);
            assert_eq!(arena.phase, PHASE_ROLLING, "abandoned before the deadline");
        }

        // One tick past it, the roll is abandoned — and no seed is invented in its place.
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.next_affix_seed, [0u8; 32], "a fallback seed is not randomness");
        assert_eq!(arena.outcome, OUTCOME_WIN, "the win survives the failed roll");
    }

    /// The same seed and tick must produce the same volley on the chain and in the
    /// browser, or the client's local prediction draws bullets that do not exist.
    #[test]
    fn entropy_is_deterministic() {
        assert_eq!(mix64(0), mix64(0));
        assert_ne!(mix64(1), mix64(2));

        let run = || {
            let (mut arena, mut boss, mut players) = fight();
            seat_in_arena(&mut players, 5, 300, 800);
            for _ in 0..=VOLLEY_INTERVAL_TICKS {
                tick_once(&mut arena, &mut boss, &mut players);
            }
            arena.bullets.map(|b| (b.x, b.y, b.dx, b.dy, b.active))
        };
        assert_eq!(run(), run());
    }
}
