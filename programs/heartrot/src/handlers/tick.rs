//! `boss_tick()` — the game loop, run by the ER's crank scheduler every ~400 ms.
//!
//! This is the only instruction in the program nobody sends. A row in the validator's
//! SQLite table replays a *frozen* account list — `[Arena, Boss, Players, crank_signer]`
//! — against this handler, `iterations` times, and three properties of that arrangement
//! shape every line below:
//!
//! 1. **It must never return `Err`.** Ten consecutive failures move the task to
//!    `failed_tasks` and it never ticks again — ~26 s into a six-minute match, with no
//!    RPC to ask whether it is still alive. So every rejection here is `return Ok(())`,
//!    there is no `?` on anything that can fail, no `unwrap`, no unchecked index, and no
//!    arithmetic that can overflow-panic under `overflow-checks = true`. A no-op tick
//!    still surfaces: `Arena.tick` stops advancing and the client's 45 s watchdog
//!    settles the match. A dead task surfaces as nothing at all.
//! 2. **It cannot re-arm itself and cannot draw randomness.** `ScheduleTask` needs a
//!    writable signer and a crank instruction may carry none, which also rules out the
//!    VRF request (its `payer` is a writable signer). Iterations are scheduled for the
//!    whole match up front, and per-tick entropy is derived arithmetically from
//!    `Arena.affix_seed` — see [`mix64`].
//! 3. **The whole transaction gets 400,000 CU.** Not 1.4 M: the crank transaction is
//!    `[noop, ExecuteCrank]` with no `ComputeBudget` instruction, and we do not build
//!    it, so the ceiling is `2 × 200,000` and unraisable. The loops below are therefore
//!    fixed-bound, allocation-free, and broad-phased before any multiply.
//!
//! Order of operations is the spec's, with one deliberate swap noted at the respawn
//! pass. Damage *to* the boss is not here — that is `shoot`, a player transaction.
//!
//! Everything is integer. The client re-runs this exact arithmetic locally to render
//! 2.5 Hz of chain state as 60 fps of bullet hell, so a single float — or a single
//! wall-clock read — would put the two simulations on different rails.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::guards::{assert_owned_by, assert_pda, assert_signer, assert_writable};
// The crank identity, imported rather than re-declared. `settle::start_match` derives the
// signer it freezes into the crank row from these two values and this handler re-derives
// the signer it authorizes against from them: they are the write side and the verify side
// of one authorization, and two editable copies let the two drift with nothing failing to
// compile. A drift is invisible in production — the task fails every tick, burns its ten
// retries and is deleted ~26 s into the match while every path here still returns `Ok(())`.
use crate::handlers::settle::{CRANK_PROGRAM_ID, CRANK_SIGNER_SEED};
use crate::state::{
    load_mut, Arena, Boss, Players, BULLET_ACTIVE, BULLET_FREE, MAX_BULLETS, MAX_SEATS, NO_TARGET,
    N_PARTS, PHASE_FIGHTING, PHASE_SETTLING, SEED_BOSS, SEED_PLAYERS, ZONE_ARENA,
};

// ---------------------------------------------------------------------------
// Arena space
// ---------------------------------------------------------------------------

/// 16 units per tile over the 64×64 map, so 0..1024 on both axes, `y` growing
/// downward. Identical to the constants in `shoot.rs`; the layout contract mandates one
/// shared unit for `PlayerSlot.x`, `Boss.x` and `Bullet.x` without naming it.
///
/// ponytail: duplicated rather than shared because no `constants.rs` exists yet and
/// `shoot.rs`'s copy is private to that module. Upgrade path: one `arena.rs` holding
/// `TILE`, `ARENA_SIZE`, the facing table and `PART_HITBOXES`, imported by both. The
/// numbers must not drift in the meantime — a bullet pool that wraps at a different
/// boundary than the raycast walks is a desync no test in either module would see.
const TILE: i32 = 16;
const ARENA_SIZE: i32 = 64 * TILE;

/// Where a respawning player is put back. Bottom-centre of the arena, on the entrance
/// side, so a wipe-and-respawn does not drop anyone on top of the boss.
const ENTRANCE_X: i32 = ARENA_SIZE / 2;
const ENTRANCE_Y: i32 = ARENA_SIZE - 6 * TILE;

/// Seats fan out sideways from the entrance so twenty simultaneous respawns are twenty
/// visible knights rather than one. `(seat − 10) × 24` spans 272..728, well inside the
/// arena, so the clamp below is a belt not a brace.
const ENTRANCE_SPACING: i32 = 24;

// ---------------------------------------------------------------------------
// Balance knobs
// ---------------------------------------------------------------------------

/// Bullet speed in arena units per tick — 3 tiles per 400 ms. Boss centre to a player
/// at mid-range is ~8 ticks of travel, which is the dodge window the whole design rests
/// on: hitscan for the player, travel time for the boss (spec §3).
///
/// It must fit `Bullet.dx`/`dy`, which are `i8`. Collision is swept (see
/// [`bullet_hits`]), so raising this does *not* let bullets tunnel through players —
/// that coupling is the usual reason a number like this is stuck too low.
const BULLET_SPEED: i32 = 48;

/// Player collision radius, ~¾ of a tile. Compared as a squared distance against a
/// squared radius; there is no `sqrt` in this program.
const PLAYER_HIT_RADIUS: i32 = 12;

/// Damage per bullet. Against the 100 HP a seat is spawned with this is 13 hits, so a
/// player can eat a glancing volley and live but cannot stand in one.
const BULLET_DAMAGE: u16 = 8;

/// Death lasts 8 ticks ≈ 3.2 s at the crank's target rate (spec §3: "dead for 3
/// seconds"). Counted in ticks, never milliseconds — the crank makes no wall-clock
/// promise and a millisecond timer would run at a different speed on a slower validator.
const RESPAWN_TICKS: u32 = 8;

/// One volley every 8 ticks (spec §2, `volley_interval = 8 ticks`).
const VOLLEY_INTERVAL_TICKS: u8 = 8;

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

/// `Boss.parts` indices of the four thorn clusters, index-aligned with the hitbox table
/// in `shoot.rs` (crown, wolf_l, beast_r, thorn0..3, mace, claws).
const THORN_PART_FIRST: usize = 3;
const N_THORN_EMITTERS: usize = 4;

/// Muzzle offsets from `Boss.x`/`Boss.y`, in arena units — the centres of
/// `PART_HITBOXES[3..7]` in `shoot.rs`. Bullets leave the thorn the player can see and
/// shoot off, which is what makes "strip the thorns and the volleys stop" readable
/// counterplay rather than a hidden rule.
const THORN_MUZZLE: [(i32, i32); N_THORN_EMITTERS] = [
    (-72, 0),  // thorn0
    (72, 0),   // thorn1
    (-72, 64), // thorn2
    (72, 64),  // thorn3
];

const _: () = {
    // `dx`/`dy` are i8. A speed that does not fit truncates silently into a bullet
    // travelling backwards.
    assert!(BULLET_SPEED > 0 && BULLET_SPEED <= i8::MAX as i32);
    // A full volley must be spawnable without the pool being the binding constraint.
    assert!(BASE_VOLLEY_BULLETS + MAX_SEATS <= MAX_BULLETS);
    assert!(THORN_PART_FIRST + N_THORN_EMITTERS <= N_PARTS);
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

/// The whole game loop, as pure state transition — no accounts, no CPI, no clock.
///
/// Split out from [`process`] so it can be run against plain structs in a unit test.
/// Nothing in here can panic or return an error: it is the body of an instruction that
/// is not allowed to fail.
fn step(arena: &mut Arena, boss: &mut Boss, players: &mut Players) {
    // ---- 1. the clock -----------------------------------------------------
    //
    // Saturating, not wrapping: at u32::MAX the clock stops and the watchdog settles
    // the match. Wrapping would rewind every rate limiter and every respawn timer at
    // once. (A match is ~900 ticks; this is a guard, not a scenario.)
    arena.tick = arena.tick.saturating_add(1);
    let tick = arena.tick;

    // ---- 2. respawns, and the live-target list ---------------------------
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

    // ---- 3. advance bullets, and collide ---------------------------------
    for index in 0..MAX_BULLETS {
        let bullet = &mut arena.bullets[index];
        if bullet.active != BULLET_ACTIVE {
            continue;
        }

        let from = (bullet.x as i32, bullet.y as i32);
        let to = (from.0 + bullet.dx as i32, from.1 + bullet.dy as i32);

        // Walls. i16 + i8 cannot overflow in i32, so the bounds test is the only
        // check needed before narrowing back.
        if to.0 < 0 || to.0 >= ARENA_SIZE || to.1 < 0 || to.1 >= ARENA_SIZE {
            bullet.active = BULLET_FREE;
            continue;
        }
        bullet.x = to.0 as i16;
        bullet.y = to.1 as i16;

        // Broad phase: the swept segment's bounding box, inflated by the hit radius.
        // Four compares per player reject almost everything before any multiply, which
        // is what keeps 128 × 20 pair tests inside the budget.
        let lo_x = from.0.min(to.0) - PLAYER_HIT_RADIUS;
        let hi_x = from.0.max(to.0) + PLAYER_HIT_RADIUS;
        let lo_y = from.1.min(to.1) - PLAYER_HIT_RADIUS;
        let hi_y = from.1.max(to.1) + PLAYER_HIT_RADIUS;

        let mut i = 0usize;
        while i < live_n {
            let target = live[i];
            if target.x < lo_x
                || target.x > hi_x
                || target.y < lo_y
                || target.y > hi_y
                || !bullet_hits(from, to, target.x, target.y)
            {
                i += 1;
                continue;
            }

            bullet.active = BULLET_FREE;

            let slot = &mut players.slots[target.seat as usize];
            slot.hp = slot.hp.saturating_sub(BULLET_DAMAGE);
            if slot.hp == 0 {
                // Dead. `respawn_at_tick` is the only death state there is — aliveness
                // is derived from `hp`, so there is no flag to fall out of sync.
                slot.respawn_at_tick = tick.saturating_add(RESPAWN_TICKS);
                // Swap-remove from the live list: this seat can absorb no more bullets
                // this tick, and shrinking the list shortens every remaining bullet's
                // inner loop.
                live_n -= 1;
                live[i] = live[live_n];
            }
            // One bullet, one hit — it is spent either way, so stop scanning.
            break;
        }
    }

    // ---- 4. alive count ---------------------------------------------------
    //
    // Recomputed from the slots rather than decremented as players die. `shoot` and
    // `enter_gate` also touch this number; deriving it every tick means a bug in either
    // of them self-heals within 400 ms instead of permanently mis-sizing every volley.
    // `live_n <= MAX_SEATS = 20`, so the cast cannot truncate.
    arena.alive_count = live_n as u8;

    // ---- 5. aggro ---------------------------------------------------------
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

    // ---- 6. the volley ----------------------------------------------------
    if boss.attack_timer > 0 {
        boss.attack_timer -= 1;
    } else {
        boss.attack_timer = VOLLEY_INTERVAL_TICKS;
        if best_seat != NO_TARGET {
            spawn_volley(arena, boss, target_xy, tick, live_n);
        }
    }

    // ---- 7. the vent ------------------------------------------------------
    //
    // Derived state, cached for the client. Recomputed from the parts every tick and
    // never set independently: the boss is a shell, and `sum(parts)` *is* its health.
    // 9 × 65,535 × 100 ≈ 59 M, so u32 is ample; saturating anyway.
    let shell: u32 = boss.parts.iter().map(|&hp| hp as u32).sum();
    let shell_max: u32 = boss.parts_max.iter().map(|&hp| hp as u32).sum();
    boss.vent_open = u8::from(
        shell.saturating_mul(VENT_THRESHOLD_DEN) < shell_max.saturating_mul(VENT_THRESHOLD_NUM),
    );

    // ---- 8. end of match --------------------------------------------------
    //
    // Win: the core is dead. `shoot` sets this too, on the killing blow, so the killer
    // sees it instantly; re-deriving it here costs one compare and covers the case
    // where the last point of core HP was removed by a transaction that then failed to
    // land its phase write.
    //
    // Wipe: every player who is *in* the arena is dead. `arena_occupants > 0` is what
    // stops a match that has been armed but not yet entered from settling on tick 1 —
    // there is no grace timer and no extra field, just the distinction between "nobody
    // here" and "nobody left".
    //
    // Enrage: the six-minute timeout. `!= 0` because an `enrage_at_tick` that was never
    // written would otherwise settle the match on its first tick.
    let core_dead = boss.core_hp == 0;
    let wiped = arena_occupants > 0 && live_n == 0;
    let enraged = arena.enrage_at_tick != 0 && tick >= arena.enrage_at_tick;
    if core_dead || wiped || enraged {
        arena.phase = PHASE_SETTLING;
    }
}

/// Where seat `seat` comes back, fanned out sideways from the entrance so twenty
/// simultaneous respawns do not stack into one sprite. Clamped to the arena because a
/// position outside it would be un-hittable and un-renderable.
///
/// `pub(crate)` for `enter_gate`, which has to put a player through the gate at the same
/// place a respawn puts them. Two definitions of "the entrance" is exactly the kind of
/// duplication that drifts and then reads as a teleport bug.
pub(crate) fn entrance_for(seat: usize) -> (i16, i16) {
    let offset = (seat as i32 - MAX_SEATS as i32 / 2) * ENTRANCE_SPACING;
    let x = (ENTRANCE_X + offset).clamp(0, ARENA_SIZE - 1);
    let y = ENTRANCE_Y.clamp(0, ARENA_SIZE - 1);
    (x as i16, y as i16)
}

/// Claim up to `3 + alive` free pool slots and fire them at `target` from whichever
/// thorn clusters are still standing.
///
/// Destroying thorn *n* removes one emitter, straight off `boss.parts` — there is no
/// separate emitter list to keep in sync, which is why "shoot the thorns off and the
/// volleys stop" is a property of the data rather than a rule someone has to remember.
/// With every thorn gone the boss fires nothing at all.
fn spawn_volley(arena: &mut Arena, boss: &Boss, target: (i32, i32), tick: u32, alive: usize) {
    let mut muzzles = [(0i32, 0i32); N_THORN_EMITTERS];
    let mut muzzle_n = 0usize;
    for (i, offset) in THORN_MUZZLE.iter().enumerate() {
        if boss.parts[THORN_PART_FIRST + i] != 0 {
            muzzles[muzzle_n] = (boss.x as i32 + offset.0, boss.y as i32 + offset.1);
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
/// No instruction data. Every rejection below is `Ok(())`, never `Err`: see the module
/// docs for why an error here is fatal and a no-op is merely visible.
pub fn process(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [arena_account, boss_account, players_account, crank_signer, ..] = accounts else {
        return Ok(());
    };

    // Account-level checks first, before anything is borrowed — `try_borrow_mut` holds
    // the `AccountView` mutably for the life of the borrow, so the immutable
    // interrogation has to happen up front.
    if assert_signer(crank_signer).is_err() {
        return Ok(());
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
    let Some((expected_signer, _bump)) = Address::derive_program_address::<2>(
        &[CRANK_SIGNER_SEED, arena.crank_authority.as_slice()],
        &CRANK_PROGRAM_ID,
    ) else {
        return Ok(());
    };
    if signer_key != expected_signer {
        return Ok(());
    }

    // Phase gate before any other account is even borrowed. Lobby, settling and settled
    // are all no-ops, and the crank keeps firing harmlessly through them — cancelling
    // the task is the settle path's job, from outside, because a crank cannot cancel
    // itself any more than it can re-arm itself.
    if arena.phase != PHASE_FIGHTING {
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
    use crate::state::Bullet;
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
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.tick, 1);
        assert_eq!(arena.phase, PHASE_FIGHTING);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(boss.target_seat, NO_TARGET);

        // One player enters and takes a bullet aimed straight at them.
        seat_in_arena(&mut players, 3, 400, 512);
        arena.bullets[0] = Bullet {
            x: 400 - BULLET_SPEED as i16,
            y: 512,
            dx: BULLET_SPEED as i8,
            dy: 0,
            active: BULLET_ACTIVE,
            _pad0: 0,
        };
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[3].hp, 100 - BULLET_DAMAGE);
        assert_eq!(arena.bullets[0].active, BULLET_FREE, "a spent bullet is freed");
        assert_eq!(arena.alive_count, 1);
        assert_eq!(boss.target_seat, 3, "nearest alive player is the aggro target");

        // Kill them outright; the same tick must read as a wipe, because everyone who
        // is in the arena is now dead.
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
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[3].hp, 0);
        assert_eq!(players.slots[3].respawn_at_tick, died_on + RESPAWN_TICKS);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(arena.phase, PHASE_SETTLING, "all arena players dead is a wipe");

        // Rewind the phase and let the respawn timer expire: the seat comes back at
        // full health, at the entrance.
        arena.phase = PHASE_FIGHTING;
        while arena.tick < died_on + RESPAWN_TICKS {
            step(&mut arena, &mut boss, &mut players);
        }
        assert_eq!(players.slots[3].hp, 100);
        assert_eq!(players.slots[3].respawn_at_tick, 0);
        assert_eq!((players.slots[3].x, players.slots[3].y), entrance_for(3));
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
            step(&mut arena, &mut boss, &mut players);
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
        for i in 0..N_THORN_EMITTERS {
            boss.parts[THORN_PART_FIRST + i] = 0;
        }
        for _ in 0..=VOLLEY_INTERVAL_TICKS {
            step(&mut arena, &mut boss, &mut players);
        }
        assert!(
            arena.bullets.iter().all(|b| b.active == BULLET_FREE),
            "no thorns, no volleys"
        );
    }

    /// The three ways a match ends, and the one way it must not.
    #[test]
    fn end_conditions() {
        // Win.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        boss.core_hp = 0;
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);

        // Enrage.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        arena.tick = 899;
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);

        // An arena with `enrage_at_tick` never written must not settle on tick 1.
        let (mut arena, mut boss, mut players) = fight();
        arena.enrage_at_tick = 0;
        seat_in_arena(&mut players, 0, 400, 512);
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_FIGHTING);

        // The vent is derived: strip the shell past 35 % and it opens, on its own.
        let (mut arena, mut boss, mut players) = fight();
        seat_in_arena(&mut players, 0, 400, 512);
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.vent_open, 0);
        boss.parts = [30; N_PARTS];
        step(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.vent_open, 1);
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
                step(&mut arena, &mut boss, &mut players);
            }
            arena.bullets.map(|b| (b.x, b.y, b.dx, b.dy, b.active))
        };
        assert_eq!(run(), run());
    }
}
