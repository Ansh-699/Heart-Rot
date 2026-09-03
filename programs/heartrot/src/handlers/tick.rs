//! `boss_tick()` — the game loop, run by the ER's crank scheduler every
//! [`crate::state::TICK_MS`] (100 ms).
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
//! 10 Hz of chain state as 60 fps of bullet hell, so a single float — or a single
//! wall-clock read — would put the two simulations on different rails.

use pinocchio::{AccountView, Address, ProgramResult};

use crate::error::HeartrotError;
use crate::guards::{assert_owned_by, assert_pda_at_bump, assert_signer, assert_writable};
// The crank identity, imported rather than re-declared. `settle::start_match` derives the
// signer it freezes into the crank row from these two values and this handler re-derives
// the signer it authorizes against from them: they are the write side and the verify side
// of one authorization, and two editable copies let the two drift with nothing failing to
// compile. A drift is invisible in production — the task fails every tick, burns its ten
// retries and is deleted ~26 s into the match while every path here still returns `Ok(())`.
use crate::handlers::settle::{CRANK_PROGRAM_ID, CRANK_SIGNER_SEED};
// The vent rule, imported rather than re-derived: `shoot` recomputes it on every landed
// shot and this handler on every tick, and a second copy of the threshold here is the
// shell threshold stored twice — which it was, as a literal 35 beside `shoot.rs`'s, until
// the threshold became a function of the raid.
use crate::handlers::shoot::recompute_vent;
// The boss's geometry, generated from `assets/sprites/hitboxes.json` by
// `tools/gen_hitboxes.py` alongside the TypeScript the renderer draws with. `shoot.rs`
// raycasts against the boxes these muzzles were cut from in this same frame, so
// importing them is what makes the thorn a bullet leaves and the thorn a player shoots
// off one object.
use crate::hitboxes::{Muzzle, MUZZLES, N_MUZZLES};
use crate::map;
use crate::state::{
    bullet_damage, load_mut, slam_damage, Arena, Boss, Players, BOSS_CORE_HP, BULLET_ACTIVE,
    BULLET_FREE, CORE_HP_PER_RAIDER, FURY_VOLLEY_INTERVAL_TICKS, MAX_BULLETS, MAX_SEATS, NO_TARGET,
    OUTCOME_ENRAGE, OUTCOME_UNDECIDED, OUTCOME_WIN, OUTCOME_WIPE, PHASE_FIGHTING, PHASE_MUSTERING,
    PHASE_ROLLING, SEED_BOSS, SEED_PLAYERS, VOLLEY_INTERVAL_TICKS, ZONE_ARENA,
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
/// 420 units/s is 26 tiles a second, 42 units per 100 ms tick.
///
/// It must be **faster than a player**, and that is the whole reason for the number.
/// `MOVE_STEP` is one 16-unit tile per 50 ms ER slot = 320 u/s, so at the 120 u/s this
/// used to carry a raider running in a straight line could never be caught by a volley
/// aimed at where they were — movement cost nothing and the bullet hell was decorative.
/// 420 is a 1.31 ratio to the player, and muzzle-to-pit flight of 0.42–0.68 s, which is
/// the dodge window the design rests on: hitscan for the player, travel time for the
/// boss (spec §5.1).
///
/// It must fit `Bullet.dx`/`dy`, which are `i8`; 42 is comfortably inside 127. Collision
/// is swept (see [`bullet_hits`]), so raising this does *not* let bullets tunnel through
/// players — that coupling is the usual reason a number like this is stuck too low.
///
/// Renderer note, recorded here because the number causes it: a 4-unit dot stepping ~7
/// units per displayed frame strobes. The client must draw a velocity-stretched trail or
/// 420 looks *worse* than 120 while being correct. The hit is right either way.
const BULLET_UNITS_PER_SEC: i32 = 420;
const BULLET_SPEED: i32 = BULLET_UNITS_PER_SEC * crate::state::TICK_MS as i32 / 1_000;

/// Player collision radius, ~¾ of a tile. Compared as a squared distance against a
/// squared radius; there is no `sqrt` in this program.
const PLAYER_HIT_RADIUS: i32 = 12;

// Damage per bullet and per slam are `state::bullet_damage` / `state::slam_damage`, read
// off `arena.raid_size` once per tick beside the vent threshold they were tuned against.
// The flat 8 / 45 that used to sit here are those curves' full-raid endpoints: twenty
// raiders take exactly the hits they always took, one takes a quarter and a third.

/// Death lasts 3.2 s — 32 ticks at [`crate::state::TICK_MS`]. Counted in ticks, never
/// milliseconds: the crank makes no wall-clock promise and a millisecond timer would run
/// at a different speed on a slower validator.
const RESPAWN_TICKS: u32 = crate::state::ticks_for(3_200);

/// `bullets_per_volley = 1 + alive_players` (one more while furious, below) — difficulty
/// as bullet density, so twenty players make a visibly harder fight rather than a boss
/// with a hidden HP multiplier.
///
/// 1, down from 3. The base is what a solo raider eats regardless of anything else, and
/// at 3 the solo volley was four bullets every 3.2 s against a fight that takes 12 s to
/// win — with the flat 8 per bullet and 45 per slam that was a 5.7 s death standing
/// still. Solo now sees two bullets (three furious); twenty see 21 (22).
const BASE_VOLLEY_BULLETS: usize = 1;

/// One more bullet per volley while [`Boss::is_furious`]. Named so the pool assert below
/// and [`spawn_volley`] count the same bullet.
const FURY_EXTRA_BULLETS: usize = 1;

/// Fan width as a tangent denominator: the outermost bullet of a full 23-shot volley is
/// offset by `11/24`, ≈ 25° off the aim line. Larger denominator, tighter fan.
const SPREAD_DEN: i32 = 24;

// ---------------------------------------------------------------------------
// The hand slam
// ---------------------------------------------------------------------------

// The pit needs pressure that is not a projectile, and `Boss` has **literally no padding
// left** — offsets 0,1,2,3,4,5,6,8,10,12,14,32 in 50 bytes — so this mechanic stores
// nothing at all. Chain and client both compute it as a pure function of `(affix_seed,
// tick, vent_open, parts)`, every one of which is already published, which is the same
// trick the bullet spread plays and the reason the whole attack adds **zero** bytes and
// zero notification traffic to a `Players` stream that is already 68.4 % no-op and
// delivered twice by the Magic Router.
//
// The core loop it closes: the column you must stand in to damage a limb is the column
// that limb slams.

/// The arena is divided into [`SLAM_LANES`] vertical strips; a slam claims exactly one.
/// Eight strips over a 64-tile map is 8 tiles each, which is wide enough to be a place
/// rather than a line and narrow enough that stepping out of it is a decision.
const SLAM_LANES: i32 = 8;
const SLAM_LANE_W: i32 = ARENA_SIZE / SLAM_LANES;

/// One slam every 6 s. Resolves on the tick where `tick % SLAM_PERIOD_TICKS == 0`, so
/// the beat needs no counter and no field: `heartbeat` advances `tick` in every phase,
/// but [`step`] runs only while `FIGHTING`, so this is live during a fight and inert
/// outside one.
const SLAM_PERIOD_TICKS: u32 = crate::state::ticks_for(6_000);

/// How long the wind-up is visible before it lands.
///
/// **Nothing on chain reads this**, and that is correct: the telegraph is a picture, and
/// §7.5 forbids an animation clock in the account. It lives here because the *number* is
/// a game rule the client mirrors — the window is
/// `tick % SLAM_PERIOD_TICKS >= SLAM_PERIOD_TICKS - SLAM_TELEGRAPH_TICKS` — and a rule
/// mirrored from a hand-typed literal in a keyframe stops matching the attack the first
/// time anyone tunes it.
///
/// The one trap, because it is invisible: those telegraph ticks fall in cycle
/// `tick / SLAM_PERIOD_TICKS`, but the slam they announce resolves in the *next* one. A
/// client winding up must ask [`slam_lane`] about the next beat —
/// `(tick / SLAM_PERIOD_TICKS + 1) * SLAM_PERIOD_TICKS` — never about `tick`. Mixing its
/// own cycle index draws the wind-up over one column and lands the hand on another, and
/// nothing anywhere reports it. `the_telegraph_announces_the_slam_that_lands` is the
/// executable copy of that recipe.
///
/// 1.5 s is not a feel number: the worst latency ever measured on any path in this
/// project is 1,126 ms, and 1.5 s × 320 u/s of player speed is 480 units — 3.75 lane
/// widths of escape — so the slam is dodgeable even from the far side of a bad
/// connection.
pub const SLAM_TELEGRAPH_TICKS: u32 = crate::state::ticks_for(1_500);

/// `Boss.parts` indices of the two hands (spec §2's table). The mace slams the lanes
/// under its own x span and the claws slam theirs; destroy a hand and it stops, on the
/// same `parts[i] != 0` gate [`spawn_volley`] uses for a thorn's muzzle.
const PART_MACE: usize = 7;
const PART_CLAWS: usize = 8;

/// Lanes the mace can claim, and the claws.
const MACE_LANE_FIRST: i32 = 1;
const MACE_LANE_COUNT: u64 = 3;
const CLAWS_LANE_FIRST: i32 = 5;
const CLAWS_LANE_COUNT: u64 = 2;

/// With the vent exposed the torso lunges over it, whichever hands are left. Lane 4 is
/// the centre column — the same column the stripped shell forces the raid to crowd into,
/// which is what makes the climax dive-out / dive-back-in rather than a damage race.
const SLAM_VENT_LANE: i32 = 4;

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
    assert!(PLAYER_HIT_RADIUS > 0);

    // The pool must hold every volley that can be *in flight at once*, not one volley.
    // The assert this replaced proved `3 + MAX_SEATS <= MAX_BULLETS` — true, and beside
    // the point: bullets live for several ticks, so at a short enough interval or a slow
    // enough bullet two or three volleys overlap and the pool starts silently dropping
    // the tail of every one of them. That failure has no error and no log; it looks like
    // the boss firing fewer bullets than the client predicted.
    //
    // Longest possible flight is corner to corner. Alpha-max-plus-beta-min bounds that
    // diagonal by `ARENA_SIZE * 3 / 2` without a sqrt in a const context, and bounding
    // it *high* is the safe direction here.
    //
    // The interval that matters is the FURIOUS one: half the calm reload, so more volleys
    // overlap, and each carries one more bullet. A 37-tick flight over 16-tick reloads is
    // three volleys of 22 — 66 slots against 128 (the calm fight is two of 21).
    let travel = ARENA_SIZE * 3 / 2;
    let lifetime = (travel + BULLET_SPEED - 1) / BULLET_SPEED;
    let interval = FURY_VOLLEY_INTERVAL_TICKS as i32;
    let volleys_in_flight = (lifetime + interval - 1) / interval;
    assert!(
        volleys_in_flight * (BASE_VOLLEY_BULLETS + MAX_SEATS + FURY_EXTRA_BULLETS) as i32
            <= MAX_BULLETS as i32
    );

    // The lanes tile the arena exactly: no player x is outside every lane, and no two
    // lanes claim the same column.
    assert!(SLAM_LANE_W * SLAM_LANES == ARENA_SIZE);
    assert!(SLAM_TELEGRAPH_TICKS > 0 && SLAM_TELEGRAPH_TICKS < SLAM_PERIOD_TICKS);
    // Every lane a slam can name is a real lane.
    assert!(SLAM_VENT_LANE >= 0 && SLAM_VENT_LANE < SLAM_LANES);
    assert!(MACE_LANE_FIRST >= 0 && MACE_LANE_FIRST + MACE_LANE_COUNT as i32 <= SLAM_LANES);
    assert!(CLAWS_LANE_FIRST >= 0 && CLAWS_LANE_FIRST + CLAWS_LANE_COUNT as i32 <= SLAM_LANES);
    assert!(PART_MACE < crate::state::N_PARTS && PART_CLAWS < crate::state::N_PARTS);
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
    if arena.phase == PHASE_MUSTERING {
        // The same shape as the `ROLLING` branch above, for the same reason:
        // `begin_fight` is total and self-gating — it checks the phase and the deadline
        // itself — so there is no second copy of `MUSTER_TICKS` here, and no second
        // definition of when the fight starts.
        //
        // This is the answer to "what stops a raid never starting": the crank ends the
        // muster whether or not anybody else came, so no player, no host and no Worker
        // has to act. `fight_at_tick` is what makes twenty browsers agree on the moment
        // without talking to each other.
        //
        // `return false` on the flip tick too, deliberately. `begin_fight` stamps
        // `enrage_at_tick = tick + ENRAGE_TICKS` on the tick it flips, so running `step`
        // in the same execution would spend the fight's first tick before its clock had
        // meaning. The first FIGHTING tick is the next execution.
        arena.begin_fight();
        return false;
    }
    arena.phase == PHASE_FIGHTING
}

/// Which lane the hands slam on `tick`, or `None` when nothing lands this cycle.
///
/// Pure, and every input is already published: this is the whole telegraph. Twenty
/// clients read the same `affix_seed`, the same `tick`, the same `vent_open` and the same
/// `parts`, run these fifteen lines, and agree on where the hand lands — with no field on
/// `Boss`, which has none to give, and no notification.
///
/// **The cycle index is the trap.** A slam resolving at tick `T = k · SLAM_PERIOD_TICKS`
/// draws its lane from cycle `k`, but the ticks that *telegraph* it are
/// `T − SLAM_TELEGRAPH_TICKS .. T − 1`, which divide to cycle `k − 1`. A client winding
/// up must round *up* to the next beat and ask about that tick. See
/// [`SLAM_TELEGRAPH_TICKS`].
///
/// A destroyed hand does not slam — the same `parts[i] != 0` gate [`spawn_volley`] puts
/// on a thorn's muzzle, so "shoot the arm off and it stops hitting you" is a property of
/// the data rather than a rule someone maintains. With the vent open the torso lunges
/// regardless, which is why that branch is checked first and consults no limb.
fn slam_lane(affix_seed: &[u8; 32], tick: u32, boss: &Boss) -> Option<i32> {
    if tick % SLAM_PERIOD_TICKS != 0 {
        return None;
    }
    if boss.vent_open != 0 {
        return Some(SLAM_VENT_LANE);
    }

    let mut seed_bytes = [0u8; 8];
    seed_bytes.copy_from_slice(&affix_seed[..8]);
    let r = mix64(u64::from_le_bytes(seed_bytes) ^ mix64((tick / SLAM_PERIOD_TICKS) as u64));

    // One bit picks the hand, the rest picks its lane — so the two choices cannot
    // correlate into a hand that only ever slams one column.
    let (limb, lane) = if r & 1 == 0 {
        (
            PART_MACE,
            MACE_LANE_FIRST + ((r >> 1) % MACE_LANE_COUNT) as i32,
        )
    } else {
        (
            PART_CLAWS,
            CLAWS_LANE_FIRST + ((r >> 1) % CLAWS_LANE_COUNT) as i32,
        )
    };
    if boss.parts[limb] == 0 {
        return None;
    }
    Some(lane)
}

/// Land `damage` on the live target at `live[i]`, and do the one and only death
/// bookkeeping this program has.
///
/// Four things happen to a seat that dies and all four have to happen together:
/// `respawn_at_tick` is the only death *state* (aliveness is derived from `hp`, so there
/// is no flag to fall out of sync), `deaths` is the only death *record* and the only
/// trace a wipe-heavy raid leaves once `survived` has been sampled, `pending_respawns`
/// is what stops the wipe check reading a scheduled comeback as a corpse, and the
/// swap-remove is what stops anything else in this tick hitting a body.
///
/// It is a function because there are now two damage sources. A slam that stamped three
/// of the four would be a death the win/wipe check cannot see: the raid keeps
/// `alive_count` it does not have, or settles as a wipe with a player still coming back.
///
/// Returns `true` when the seat died — which is also when `live[i]` now holds a
/// *different* seat and the caller must not advance `i`.
#[inline]
fn damage_seat(
    players: &mut Players,
    live: &mut [Target; MAX_SEATS],
    live_n: &mut usize,
    pending_respawns: &mut u32,
    i: usize,
    tick: u32,
    damage: u16,
) -> bool {
    // `get_mut`, not `[]`, on the one indexed read left in the handler. `live` is filled
    // only from `0..MAX_SEATS` so this cannot miss today, but the module's contract is
    // that a tick never panics, and a panic here does not merely drop one hit: it burns
    // one of the crank's ten strikes, and ten of them delete the task permanently.
    // Returning `false` reads as "the seat did not die", which is the safe answer — the
    // caller advances `i` and the live list is left exactly as it was.
    let Some(slot) = players.slots.get_mut(live[i].seat as usize) else {
        return false;
    };
    slot.hp = slot.hp.saturating_sub(damage);
    if slot.hp != 0 {
        return false;
    }
    // Saturating: a raid that has died 65,535 times has stopped caring about the count.
    slot.respawn_at_tick = tick.saturating_add(RESPAWN_TICKS);
    slot.deaths = slot.deaths.saturating_add(1);
    // `tick >= 1` (heartbeat ran), so the deadline just stamped is non-zero and this seat
    // is coming back. Counted here as well as in the respawn pass because a seat that
    // dies *this* tick was alive when that pass ran.
    *pending_respawns += 1;
    *live_n -= 1;
    live[i] = live[*live_n];
    true
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
    let mut live = [Target {
        seat: 0,
        x: 0,
        y: 0,
    }; MAX_SEATS];
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

    // ---- 1b. size the boss to the raid -----------------------------------
    //
    // `raid_size` is the high-water mark of seats that have stood in the arena this
    // incarnation. It never falls when a raider leaves or dies, so nothing about it can be
    // gamed, it tolerates late entry, and it is the one number both raid-size knobs read:
    // the vent threshold (`state::vent_pct`, through `recompute_vent` in stage 3 and in
    // `shoot`) and the core top-up below. This is its only writer;
    // `Arena::begin_next_incarnation` zeroes it.
    //
    // Difficulty scales on those two and on nothing else. Measured time-to-kill with a
    // fixed core ran 307 s solo against 15 s at twenty players — a 20× spread against a
    // volley that scales 5.75× — which inverts the one requirement the whole design was
    // built on. Topping the core up per raider compressed that to 3.9×; the solo fight
    // was still 274 s of shell-stripping against a flat 35 % vent, which is what moving
    // the threshold with the raid fixes (`state::ttk_s`: 12 s solo, 69 s at twenty after
    // the 2026-09-03 solo retune; 166 s / 71 s before it).
    //
    // **Not `parts`.** `u16` saturation already caps the crown at incarnation 41 and a
    // raid multiplier on the shell would collapse that to incarnation ~2 at twenty
    // players. `vent_open` is a ratio over `parts`; the *threshold* moves, the shell
    // does not.
    if arena_occupants > arena.raid_size as u32 {
        // `arena_occupants <= MAX_SEATS` by construction (one pass over the seats), so the
        // narrowing cast cannot truncate; `min` keeps that a property of this line rather
        // than of the loop above it.
        arena.raid_size = arena_occupants.min(MAX_SEATS as u32) as u8;
    }
    // `core_hp_max` *is* its own high-water record, so the top-up needs no snapshot: it is
    // monotone, and orthogonal to incarnation scaling, which writes `parts`.
    let required = BOSS_CORE_HP.saturating_add(
        CORE_HP_PER_RAIDER.saturating_mul(arena.raid_size.max(1) as u16 - 1),
    );
    // `core_hp != 0` is not decoration. Without it a raid that has just killed the core
    // and gained a raider in the same 100 ms would have it topped back up *before* the
    // win check below reads `core_hp == 0` — the boss resurrected by its own difficulty
    // curve, with no error and no log. The top-up sizes a live core; it never revives a
    // dead one.
    if boss.core_hp != 0 && boss.core_hp_max < required {
        let top_up = required - boss.core_hp_max;
        boss.core_hp_max = required;
        boss.core_hp = boss.core_hp.saturating_add(top_up);
    }
    // Incoming damage is the third raid-size knob, read off the same high-water mark as
    // the vent threshold and the core, once per tick: `state.rs` owns both curves and
    // their endpoints. Solo takes 2 / 15, twenty take the 8 / 45 the crank always dealt.
    let per_bullet = bullet_damage(arena.raid_size);
    let per_slam = slam_damage(arena.raid_size);

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
        // Two point samples, not one: a bullet covers BULLET_SPEED = 42 units per tick
        // and the map's thinnest solid feature is 2 tiles, 32 units through, so an
        // endpoint-only test would let a volley pass clean through the wall a player is
        // hiding behind. Samples 21 units apart cannot skip a 32-unit obstacle. Same
        // tunnelling argument `bullet_hits` makes for players, same symptom if it is
        // skipped — cover that does not cover.
        //
        // ponytail: two lookups, not a DDA walk of the swept segment. A solid feature
        // thinner than 21 units — one tile — would still be jumped; `assets/map/arena.json`
        // contains none and would have to grow one before it could matter. Upgrade path
        // if it does: step the segment tile by tile, at ~3 lookups per bullet instead of
        // 2. `bullets_stop_at_generated_walls` searches the map for the case rather than
        // naming a tile, so it keeps testing this after the arena is redrawn.
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

            // Damage and, if it kills, the whole death record — stamped in one place so
            // the slam below cannot grow a second, subtly different definition of "died".
            // The swap-remove inside also shortens every remaining bullet's inner loop.
            damage_seat(
                players,
                &mut live,
                &mut live_n,
                &mut pending_respawns,
                i,
                tick,
                per_bullet,
            );
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

    // ---- 3. the vent ------------------------------------------------------
    //
    // Derived state, cached for the client. Recomputed from the parts every tick and
    // never set independently: the boss is a shell, and `sum(parts)` *is* its health.
    // `shoot` runs the same function on every landed shot; the tick runs it too because
    // the threshold moves with `raid_size`, which only stage 1b above can raise.
    //
    // Computed here, ahead of the slam, rather than after the volley where it used to
    // sit: the slam's vent branch reads it, and a slam resolving against last tick's
    // `vent_open` would lunge over a chest that closed 100 ms ago. Nothing between the
    // bullet loop and here touches `parts` — only `shoot` does, in its own transaction —
    // so moving it changes no value, only when it is available.
    recompute_vent(boss, arena.raid_size);

    // ---- 4. the hand slam -------------------------------------------------
    //
    // Positional pressure that is not a projectile, and it costs the accounts nothing:
    // see [`slam_lane`]. Resolved after the bullets so a player who was already killed
    // this tick is not killed twice, and before the alive count so the wipe check below
    // sees a slam death exactly as it sees a bullet death.
    if let Some(lane) = slam_lane(&arena.affix_seed, tick, boss) {
        let lo = lane * SLAM_LANE_W;
        let hi = lo + SLAM_LANE_W;
        let mut i = 0usize;
        while i < live_n {
            // A death swap-removes into `live[i]`, so `i` only advances on a survivor —
            // otherwise the seat swapped into this slot never gets tested.
            if live[i].x >= lo
                && live[i].x < hi
                && damage_seat(
                    players,
                    &mut live,
                    &mut live_n,
                    &mut pending_respawns,
                    i,
                    tick,
                    per_slam,
                )
            {
                continue;
            }
            i += 1;
        }
    }

    // ---- 5. alive count ---------------------------------------------------
    //
    // Recomputed from the slots rather than decremented as players die. `shoot` and
    // `enter_gate` also touch this number; deriving it every tick means a bug in either
    // of them self-heals within one 100 ms tick instead of permanently mis-sizing every
    // volley.
    // `live_n <= MAX_SEATS = 20`, so the cast cannot truncate.
    arena.alive_count = live_n as u8;

    // ---- 6. aggro ---------------------------------------------------------
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

    // ---- 7. the volley ----------------------------------------------------
    //
    // Fury: the last `FURY_PCT` of the fight (`Boss::is_furious`, derived from the shell
    // and the core on every read — nothing is stored, `Boss` has no padding for it)
    // reloads at half the interval and adds a bullet. Read on the tick the timer runs
    // out, never clamped into a running countdown: the client draws the telegraph off
    // `attack_timer`, and a timer that jumped from 30 to 16 on the tick the shell crossed
    // the line would snap a wind-up mid-draw. So the volley that fires after the line is
    // crossed already carries the extra bullet, and the reload it sets is the first
    // furious one.
    if boss.attack_timer > 0 {
        boss.attack_timer -= 1;
    } else {
        let furious = boss.is_furious(arena.raid_size);
        boss.attack_timer = if furious {
            FURY_VOLLEY_INTERVAL_TICKS
        } else {
            VOLLEY_INTERVAL_TICKS
        };
        if best_seat != NO_TARGET {
            spawn_volley(arena, boss, target_xy, tick, live_n, furious);
        }
    }

    // ---- 8. end of match --------------------------------------------------
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
    let to_x_edge = if x < ARENA_SIZE - x {
        x
    } else {
        ARENA_SIZE - x
    };
    let to_y_edge = if y < ARENA_SIZE - y {
        y
    } else {
        ARENA_SIZE - y
    };
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

/// How many bullets a volley carries: `1 + alive_players`, but never fewer than the
/// thorns that are still standing, plus one while furious.
///
/// The floor is the fix for "monster shows 3 cannons and shoots only 2". Every live thorn
/// telegraphs — the client draws a line from each one to the target, off `MUZZLES` and
/// `parts`, exactly as this function reads them — and the bullets are dealt round-robin
/// across those thorns, so a raid of one at `1 + 1 = 2` bullets left one telegraphed
/// cannon silent every volley. A cannon that aims and does not fire is a lie the player
/// notices. The fury bullet rides ON TOP of the floor so that "one more while furious"
/// stays true in the solo fight the floor exists for.
///
/// `const`, so the bullet-pool assert above can name the same ceiling this does.
const fn volley_size(alive: usize, furious: bool, live_muzzles: usize) -> usize {
    let base = BASE_VOLLEY_BULLETS + alive;
    let floored = if base < live_muzzles { live_muzzles } else { base };
    floored + if furious { FURY_EXTRA_BULLETS } else { 0 }
}

/// Claim up to `1 + alive` free pool slots — one more while `furious` — and fire them at
/// `target` from whichever thorn clusters are still standing.
///
/// Destroying thorn *n* removes one emitter, straight off `boss.parts` — there is no
/// separate emitter list to keep in sync, which is why "shoot the thorns off and the
/// volleys stop" is a property of the data rather than a rule someone has to remember.
/// With every thorn gone the boss fires nothing at all.
fn spawn_volley(
    arena: &mut Arena,
    boss: &Boss,
    target: (i32, i32),
    tick: u32,
    alive: usize,
    furious: bool,
) {
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

    let wanted = volley_size(alive, furious, muzzle_n);

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
    // Copied out before anything is borrowed: `try_borrow_mut` locks the whole
    // `AccountView`, and the derivation below needs the address while the data is held.
    let boss_key = *boss_account.address();
    let players_key = *players_account.address();

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

    // `Boss` and `Players` must belong to *this* arena. The frozen crank list makes a
    // mismatch unlikely rather than impossible — nothing stops someone submitting a
    // hand-built `boss_tick` with the right crank signer and the wrong boss — and the
    // consequence would be one match's clock draining another match's boss.
    //
    // The bump comes off the loaded struct rather than out of a `find_program_address`
    // search, which is the same trade `shoot.rs:504` already made and for the same reason:
    // the search costs ~1,500 CU per rejected candidate and the number of candidates is
    // `arena_id` luck, so a searching guard prices a hot path on a dice roll. This handler
    // runs 10x a second for a 3,800-tick match, which is where that spread actually lives
    // (`docs/review/chain-cost.md`). It is not the weaker check: `assert_owned_by` above
    // proves this program wrote the bump byte, `load_mut` proves it is the bump field of
    // the layout being read, and the derivation proves that bump reproduces this exact
    // address. An account at a non-canonical bump cannot reach here, because nothing in
    // this program ever creates one.
    //
    // It runs after the loads, not before them, because the bump is inside the account.
    // The only tick that gets this far is a FIGHTING one — `heartbeat` returned false and
    // took the early exit otherwise — and nothing is mutated between here and `step`, so
    // a mismatched pair still damages no boss. What it now also does is advance
    // `arena.tick` first; that is not a new capability, because a caller who can produce
    // the crank signature can spin the same clock with the *correct* accounts.
    //
    // `is_err()` absorbed into `Ok(())` like every other rejection in this file: a crank
    // that returns `Err` ten times is deleted.
    if assert_pda_at_bump(
        &boss_key,
        &[SEED_BOSS, arena_key.as_ref()],
        program_id,
        boss.bump,
    )
    .is_err()
        || assert_pda_at_bump(
            &players_key,
            &[SEED_PLAYERS, arena_key.as_ref()],
            program_id,
            players.bump,
        )
        .is_err()
    {
        return Ok(());
    }

    step(arena, boss, players);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // `N_PARTS` sizes the fixtures' part arrays and `PHASE_SETTLING` / `ROLL_TIMEOUT_TICKS`
    // are what the assertions read; the handler itself names none of the three — it writes
    // phases only through the `Arena` helpers, which is the point.
    use crate::state::{
        Bullet, BULLET_DAMAGE_FULL, BULLET_DAMAGE_SOLO, ENRAGE_TICKS, MUSTER_TICKS, N_PARTS,
        PHASE_SETTLING, ROLL_TIMEOUT_TICKS, SLAM_DAMAGE_FULL, SLAM_DAMAGE_SOLO, ZONE_LOBBY,
    };
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

    /// A bullet moving 42 units a tick past a 24-unit-wide player is the exact case a
    /// naive point-in-circle test misses, and the symptom — "I dodged that" — is
    /// indistinguishable from lag. If the swept test regresses, this is the only thing
    /// that catches it.
    #[test]
    fn fast_bullets_do_not_tunnel_through_players() {
        // Player sits dead centre of the step the bullet takes this tick.
        assert!(bullet_hits(
            (100, 100),
            (100 + BULLET_SPEED, 100),
            100 + BULLET_SPEED / 2,
            100
        ));
        // Grazing at exactly the radius still counts; one unit further does not.
        assert!(bullet_hits(
            (100, 100),
            (148, 100),
            124,
            100 + PLAYER_HIT_RADIUS
        ));
        assert!(!bullet_hits(
            (100, 100),
            (148, 100),
            124,
            100 + PLAYER_HIT_RADIUS + 1
        ));
        // Behind the segment's start is a miss, not a hit on an infinite line.
        assert!(!bullet_hits((100, 100), (148, 100), 40, 100));
    }

    /// Search the *generated* map for one tick's step that starts on floor and whose
    /// midpoint and endpoint match `want(mid_solid, end_solid)`.
    ///
    /// These cases used to name tiles — "the north corridor at row 20", "the 2×2 pillar
    /// at (2..3, 2..3)" — which made them assertions about a drawing rather than about
    /// the wall test, and every one of them died the first time `assets/map/arena.json`
    /// was redrawn. Searching for the shape keeps the intent across any arena that still
    /// has walls in it, and `expect` below fails loudly if one ever does not.
    ///
    /// The step set comes from [`unit_velocity`], not from a hand-written multiple of
    /// `BULLET_SPEED`. The previous version searched only `±BULLET_SPEED` on one axis,
    /// which is a *second* model of what a bullet step is — and a wrong one, because the
    /// octagonal normalisation makes the 45° step `(28, 28)` and not `(42, 42)`. That
    /// mattered the moment the pillars came out: the open arena has no axis-aligned
    /// one-step-thick cover left, so `mid && !end` had no witness on any of the four
    /// directions and the search reported the *map* had no cover when what it really had
    /// was a search too narrow to see the gate throat's diagonal shoulder. Asking the
    /// production function for the directions keeps the two in step by construction.
    fn find_step(want: fn(bool, bool) -> bool) -> Option<(i16, i16, i8, i8)> {
        // A magnitude, not a unit: `unit_velocity` divides by an integer octagonal length,
        // so `(1, 1)` degenerates to `(42, 42)` while any realistic aim vector — these are
        // differences between world positions, hundreds of units apart — gives `(28, 28)`.
        const AIM: i32 = 1000;
        for ty in 0..map::MAP_TILES as i32 {
            for tx in 0..map::MAP_TILES as i32 {
                let (x, y) = (tx * TILE + TILE / 2, ty * TILE + TILE / 2);
                if wall_at(x, y) {
                    continue;
                }
                for (ux, uy) in [
                    (1i32, 0i32),
                    (-1, 0),
                    (0, 1),
                    (0, -1),
                    (1, 1),
                    (1, -1),
                    (-1, 1),
                    (-1, -1),
                ] {
                    let (dx, dy) =
                        unit_velocity(ux * AIM, uy * AIM).expect("a direction is not stationary");
                    let (ex, ey) = (x + dx as i32, y + dy as i32);
                    if want(wall_at((x + ex) / 2, (y + ey) / 2), wall_at(ex, ey)) {
                        return Some((x as i16, y as i16, dx, dy));
                    }
                }
            }
        }
        None
    }

    /// A one-tick shot that starts and ends on open floor, and the point it ends on.
    /// Taken out of the generated map so the damage cases below travel with a redrawn
    /// arena instead of breaking on it.
    fn open_shot() -> (Bullet, i16, i16) {
        let (x, y, dx, dy) = find_step(|mid, end| !mid && !end).expect("the map has open floor");
        (
            Bullet {
                x,
                y,
                dx,
                dy,
                active: BULLET_ACTIVE,
                _pad0: 0,
            },
            x + dx as i16,
            y + dy as i16,
        )
    }

    /// The dungeon is only tactical if it stops bullets, and all three halves of that
    /// have to hold: a shot into a wall dies, a shot down open floor lives, and a shot
    /// that is solid only at its *midpoint* dies too. The last is the one an
    /// endpoint-only test gets wrong — a bullet steps 42 units and the map's thinnest
    /// solid feature is 2 tiles, 32 units through.
    ///
    /// The third case's witness moved when the lobby's pillars were deleted. Those 2×2
    /// pillars were the only cover an axis-aligned step could clear in one tick; what is
    /// left is the 2-tile side perimeter and the 5-row divider, both of which a straight
    /// step ends *inside*. The case still occurs — a diagonal shot clipping the shoulder
    /// of the gate throat crosses the jamb and lands back on floor, 8 such steps on this
    /// map — which is why `find_step` searches the real velocity set. It is a fact about
    /// the sampler, not about the pillars, and deleting the assertion when the pillars
    /// went would have left the two-sample design with nothing holding it in place.
    #[test]
    fn bullets_stop_at_generated_walls() {
        let fired = |(x, y, dx, dy): (i16, i16, i8, i8)| {
            let (mut arena, mut boss, mut players) = fight();
            // No thorns, so nothing else can spawn into the pool and confuse the count.
            boss.parts = [0; N_PARTS];
            arena.bullets[0] = Bullet {
                x,
                y,
                dx,
                dy,
                active: BULLET_ACTIVE,
                _pad0: 0,
            };
            tick_once(&mut arena, &mut boss, &mut players);
            arena.bullets[0].active == BULLET_ACTIVE
        };

        assert!(
            !fired(find_step(|_, end| end).expect("the map has a wall")),
            "a wall stops a volley"
        );
        assert!(
            fired(find_step(|mid, end| !mid && !end).expect("the map has open floor")),
            "open floor is a firing lane"
        );
        assert!(
            !fired(find_step(|mid, end| mid && !end).expect("the map has cover one step thick")),
            "cover a bullet steps over is still cover"
        );
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
        // No thorns and no hands: the only bullets in this test are the ones it fires by
        // hand, so nothing the boss does can move the health it is asserting on.
        boss.parts = [0; N_PARTS];
        let (shot, px, py) = open_shot();
        // 300 units clear of the shot, which the swept test only widens by the 12-unit
        // hit radius. In range 0..1023 either way, whichever half of the map the shot
        // came out of.
        let far_y = if py < (ARENA_SIZE / 2) as i16 {
            py + 300
        } else {
            py - 300
        };

        // Nobody in the arena: the boss ticks, but an empty arena is not a wipe.
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.tick, 1);
        assert_eq!(arena.phase, PHASE_FIGHTING);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(boss.target_seat, NO_TARGET);

        // Two players enter, seat 3 standing where the shot lands.
        seat_in_arena(&mut players, 3, px, py);
        seat_in_arena(&mut players, 7, px, far_y);
        arena.bullets[0] = shot;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[3].hp, 100 - bullet_damage(arena.raid_size));
        assert_eq!(players.slots[7].hp, 100, "one bullet, one hit");
        assert_eq!(
            arena.bullets[0].active, BULLET_FREE,
            "a spent bullet is freed"
        );
        assert_eq!(arena.alive_count, 2);

        // Kill seat 3 outright. One seat down is not a wipe while seat 7 is standing, so
        // the fight carries on and the death is a respawn deadline rather than an ending.
        players.slots[3].hp = bullet_damage(arena.raid_size);
        arena.bullets[1] = shot;
        let died_on = arena.tick + 1;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[3].hp, 0);
        assert_eq!(players.slots[3].respawn_at_tick, died_on + RESPAWN_TICKS);
        assert_eq!(arena.alive_count, 1);
        assert_eq!(
            players.slots[3].deaths, 1,
            "a death is counted where it is stamped"
        );
        assert_eq!(arena.phase, PHASE_FIGHTING, "one seat down is not a wipe");
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);

        // Let the respawn deadline pass: the seat comes back at full health, at its door.
        while arena.tick < died_on + RESPAWN_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
        }
        assert_eq!(players.slots[3].hp, 100);
        assert_eq!(players.slots[3].respawn_at_tick, 0);
        assert_eq!((players.slots[3].x, players.slots[3].y), entrance_for(3));
        assert_eq!(
            players.slots[3].deaths, 1,
            "coming back is not a second death"
        );

        // Now everyone in the arena is down with nothing scheduled. That, and only that,
        // is a wipe — and it is a loss, distinguishable from a win forever after. (Set
        // directly: the bullet → damage → death path is what the lines above test, and
        // the wipe rule reads `hp` and `respawn_at_tick`, not how they got there.)
        players.slots[3].hp = 0;
        players.slots[3].respawn_at_tick = 0;
        players.slots[7].hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(
            arena.phase, PHASE_SETTLING,
            "every arena occupant dead is a wipe"
        );
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
        let (shot, px, py) = open_shot();
        seat_in_arena(&mut players, 0, px, py);
        players.slots[0].hp = bullet_damage(1);
        arena.bullets[0] = shot;
        let died_on = arena.tick + 1;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(players.slots[0].hp, 0);
        assert_eq!(players.slots[0].respawn_at_tick, died_on + RESPAWN_TICKS);
        assert_eq!(arena.alive_count, 0);
        assert_eq!(
            arena.phase, PHASE_FIGHTING,
            "a pending respawn is not a wipe"
        );
        assert_eq!(arena.outcome, OUTCOME_UNDECIDED);

        // And the deadline is actually reached, which it never was before.
        while arena.tick < died_on + RESPAWN_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
            assert_eq!(
                arena.phase, PHASE_FIGHTING,
                "the lone raider is still coming back"
            );
        }
        assert_eq!(
            players.slots[0].hp, 100,
            "one player alone respawns like anyone else"
        );
        assert_eq!(players.slots[0].respawn_at_tick, 0);
        assert_eq!((players.slots[0].x, players.slots[0].y), entrance_for(0));
        assert_eq!(arena.alive_count, 1);

        // A seat that is down with *nothing* scheduled is still a wipe, solo or not.
        players.slots[0].hp = 0;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(
            arena.outcome, OUTCOME_WIPE,
            "nobody coming back is still a loss"
        );

        // And enrage still ends a fight that would otherwise respawn forever.
        let (mut arena, mut boss, mut players) = fight();
        boss.parts = [0; N_PARTS];
        seat_in_arena(&mut players, 0, 400, 512);
        players.slots[0].hp = 0;
        players.slots[0].respawn_at_tick = u32::MAX;
        arena.tick = 899;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(
            arena.outcome, OUTCOME_ENRAGE,
            "the clock still ends the match"
        );
    }

    /// A bullet whose step ends inside a wall used to be deleted before anything asked
    /// whether it had crossed a player on the way, which made standing with your back to
    /// a wall partial immunity to fire aimed at you. The wall clips the swept segment; it
    /// does not cancel it — and the clip is what still stops the bullet reaching *through*.
    #[test]
    fn a_bullet_stopped_by_a_wall_still_hits_what_it_crossed() {
        // A step that starts on floor, is still floor at its midpoint, and ends inside a
        // wall — found in the generated map rather than named. The bullet is deleted this
        // tick either way; the question is whether it swept anything on the way in.
        let (bx, by, dx, dy) =
            find_step(|mid, end| !mid && end).expect("the map has a wall a bullet can reach");
        let step = |t: i32| {
            (
                (bx as i32 + dx as i32 * t / 2) as i16,
                (by as i32 + dy as i32 * t / 2) as i16,
            )
        };

        let shot = |(px, py): (i16, i16)| {
            let (mut arena, mut boss, mut players) = fight();
            boss.parts = [0; N_PARTS];
            seat_in_arena(&mut players, 0, px, py);
            arena.bullets[0] = Bullet {
                x: bx,
                y: by,
                dx,
                dy,
                active: BULLET_ACTIVE,
                _pad0: 0,
            };
            tick_once(&mut arena, &mut boss, &mut players);
            (players.slots[0].hp, arena.bullets[0].active)
        };

        // Halfway along the step, on the floor side of the wall: hit, and the bullet is
        // spent. This is the case that used to be missed — the bullet was deleted for
        // ending in a wall before anything asked what it had crossed, which made standing
        // with your back to a wall partial immunity to fire aimed at you.
        assert_eq!(
            shot(step(1)),
            (100 - bullet_damage(1), BULLET_FREE),
            "a player against a wall is not immune to fire aimed at them"
        );
        // A full step past the start, inside the wall the bullet died on: still cover.
        // The wall clips the swept segment; it does not cancel it.
        assert_eq!(
            shot(step(2)),
            (100, BULLET_FREE),
            "a bullet does not reach through the wall"
        );
    }

    /// Aggro is the whole targeting rule and there is no threat table: stepping forward
    /// pulls fire off the group, and that is the only tanking the game has.
    #[test]
    fn the_boss_aims_at_the_nearest_live_player() {
        let (mut arena, mut boss, mut players) = fight();
        boss.parts = [0; N_PARTS];
        let (bx, by) = (boss.x, boss.y);
        seat_in_arena(&mut players, 3, bx + 64, by);
        seat_in_arena(&mut players, 7, bx + 256, by);
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.target_seat, 3);

        // Seat 3 dies; aggro falls through to the one still standing rather than sticking
        // to a corpse.
        players.slots[3].hp = 0;
        players.slots[3].respawn_at_tick = u32::MAX;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.target_seat, 7);
    }

    /// Volleys are the difficulty curve (`1 + alive_players`) and the counterplay
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
        let fired = arena
            .bullets
            .iter()
            .filter(|b| b.active == BULLET_ACTIVE)
            .count();
        assert_eq!(fired, BASE_VOLLEY_BULLETS + 4, "1 + alive_players");
        assert!(
            arena
                .bullets
                .iter()
                .filter(|b| b.active == BULLET_ACTIVE)
                .all(|b| b.dx != 0 || b.dy != 0),
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

    /// The opening volley gets the same wind-up every later volley gets.
    ///
    /// This builds the boss the way the chain does — [`Boss::reset_for_incarnation`] —
    /// instead of taking [`fight`]'s hand-set `attack_timer`. That hand-set line is
    /// exactly why the suite could not see `docs/review/chain.md` finding 4: with
    /// `attack_timer = 0` the first FIGHTING tick published `target_seat` for the first
    /// time *and* spawned an aimed volley in the same write, so the telegraph the client
    /// draws off `attack_timer` had no frames to run in.
    /// "monster shows 3 cannons and shoots only 2": every thorn that telegraphs must fire.
    #[test]
    fn every_live_thorn_fires_even_for_a_raid_of_one() {
        assert_eq!(volley_size(1, false, N_MUZZLES), N_MUZZLES, "solo is floored at the thorns");
        assert_eq!(volley_size(1, false, 2), 2, "two thorns left, two bullets");
        assert_eq!(volley_size(1, false, 1), BASE_VOLLEY_BULLETS + 1, "one thorn: the base wins");
        assert_eq!(volley_size(19, false, N_MUZZLES), BASE_VOLLEY_BULLETS + 19, "a raid is never floored");
        assert_eq!(volley_size(1, true, 0), BASE_VOLLEY_BULLETS + 1 + FURY_EXTRA_BULLETS);
        // The bound the pool assert names is the biggest volley this can answer.
        assert!(
            volley_size(MAX_SEATS, true, N_MUZZLES)
                <= BASE_VOLLEY_BULLETS + MAX_SEATS + FURY_EXTRA_BULLETS
        );
    }

    #[test]
    fn the_first_volley_of_a_fight_has_a_wind_up() {
        let (mut arena, mut boss, mut players) = fight();
        boss.reset_for_incarnation([100; N_PARTS], 100, boss.x, boss.y);
        seat_in_arena(&mut players, 0, 400, 700);

        // The whole wind-up, from the first FIGHTING tick. Nothing may be in the air.
        for t in 0..VOLLEY_INTERVAL_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
            assert!(
                arena.bullets.iter().all(|b| b.active == BULLET_FREE),
                "tick {t} of the wind-up already fired"
            );
        }
        // A target was published during it, so the client had something to aim the
        // telegraph at while the timer ran down.
        assert_eq!(boss.target_seat, 0);

        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(
            arena
                .bullets
                .iter()
                .filter(|b| b.active == BULLET_ACTIVE)
                .count(),
            volley_size(1, false, N_MUZZLES),
            "the volley lands on the tick the wind-up ends"
        );
    }

    /// The last fifth of the fight (`Boss::is_furious`) reloads at half the interval and
    /// fires one more bullet; one point above the line is a calm volley and a calm
    /// reload. Derived on the tick the timer runs out — nothing is stored, so there is
    /// nothing to reset when the line is crossed.
    #[test]
    fn a_furious_boss_reloads_at_half_and_fires_one_more() {
        let in_flight = |arena: &Arena| {
            arena
                .bullets
                .iter()
                .filter(|b| b.active == BULLET_ACTIVE)
                .count()
        };
        // Shell at the solo threshold exactly (98 of 100 per part, 882 of 900), so fight HP
        // is 18 strippable shell + the core. The core sits at the solo floor already, or
        // stage 1b would top it up under the test: max = 18 + 200 = 218, and a fifth of
        // that is 43.6 — 43 left is furious, 44 is not.
        let first_volley = |core_hp: u16| {
            let (mut arena, mut boss, mut players) = fight();
            boss.parts = [98; N_PARTS];
            boss.core_hp_max = BOSS_CORE_HP;
            boss.core_hp = core_hp;
            // Fire on the first tick; the reload that fire sets is what the test reads.
            boss.attack_timer = 0;
            seat_in_arena(&mut players, 0, 400, 700);
            tick_once(&mut arena, &mut boss, &mut players);
            (arena, boss, players)
        };

        let (arena, boss, _) = first_volley(44);
        assert!(
            !boss.is_furious(arena.raid_size),
            "one point above the line is calm"
        );
        assert_eq!(in_flight(&arena), volley_size(1, false, N_MUZZLES), "a calm volley");
        assert_eq!(
            boss.attack_timer, VOLLEY_INTERVAL_TICKS,
            "and a calm reload"
        );

        let (mut arena, mut boss, mut players) = first_volley(43);
        assert!(boss.is_furious(arena.raid_size), "on the line is furious");
        assert_eq!(
            in_flight(&arena),
            volley_size(1, true, N_MUZZLES),
            "one more bullet"
        );
        assert_eq!(
            volley_size(1, true, N_MUZZLES),
            volley_size(1, false, N_MUZZLES) + FURY_EXTRA_BULLETS,
            "the fury bullet rides on top of the thorn floor"
        );
        assert_eq!(
            boss.attack_timer, FURY_VOLLEY_INTERVAL_TICKS,
            "reloaded at half"
        );

        // The half reload is a real wind-up, not a faster countdown of the old one:
        // nothing new in the air until it runs out, then the next furious volley lands.
        for b in arena.bullets.iter_mut() {
            b.active = BULLET_FREE;
        }
        for t in 0..FURY_VOLLEY_INTERVAL_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
            assert_eq!(
                in_flight(&arena),
                0,
                "tick {t} of the furious wind-up already fired"
            );
        }
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(
            in_flight(&arena),
            volley_size(1, true, N_MUZZLES),
            "the volley lands on the tick the half wind-up ends"
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
        assert_eq!(
            arena.outcome, OUTCOME_ENRAGE,
            "running out of time is not a wipe"
        );

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
        assert_eq!(
            arena.outcome, OUTCOME_WIN,
            "the first outcome is the true one"
        );
        assert_eq!(arena.phase, PHASE_SETTLING);
        assert_eq!(arena.tick, 900, "the clock runs in every phase");

        // An arena with `enrage_at_tick` never written must not settle on tick 1.
        let (mut arena, mut boss, mut players) = fight();
        arena.enrage_at_tick = 0;
        seat_in_arena(&mut players, 0, 400, 512);
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.phase, PHASE_FIGHTING);

        // The vent is derived: strip the shell past the raid's threshold (65 % standing
        // for this one raider) and it opens, on its own.
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
        assert_eq!(
            arena.next_affix_seed, [0u8; 32],
            "a fallback seed is not randomness"
        );
        assert_eq!(
            arena.outcome, OUTCOME_WIN,
            "the win survives the failed roll"
        );
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

    /// A boss with both hands but no thorns: it slams and it does not shoot, so a test
    /// can assert on health without a volley moving it.
    ///
    /// The thorns leave `parts_max` as well as `parts`, so the shell reads 100 % and the
    /// vent stays sealed at every raid size. Stripped from `parts` alone they read as 44 %
    /// damage, which the raid-sized threshold opens for any raid under eight — and an open
    /// vent moves the slam to the vent lane, which is not what a test about hands asks.
    fn hands_only() -> (Arena, Boss, Players) {
        let (arena, mut boss, players) = fight();
        for m in MUZZLES.iter() {
            boss.parts[m.part] = 0;
            boss.parts_max[m.part] = 0;
        }
        (arena, boss, players)
    }

    /// The slam's beat, its lane bounds, and the counterplay — shoot the arm off and it
    /// stops hitting you, which is a property of `parts` rather than a rule anyone
    /// maintains.
    #[test]
    fn the_hand_slam_keeps_its_beat_and_its_own_lanes() {
        let (arena, mut boss, _) = hands_only();
        let seed = arena.affix_seed;
        let in_mace =
            |lane: i32| (MACE_LANE_FIRST..MACE_LANE_FIRST + MACE_LANE_COUNT as i32).contains(&lane);
        let in_claws = |lane: i32| {
            (CLAWS_LANE_FIRST..CLAWS_LANE_FIRST + CLAWS_LANE_COUNT as i32).contains(&lane)
        };

        // Nothing lands off the beat, ever.
        for tick in 1..SLAM_PERIOD_TICKS {
            assert_eq!(
                slam_lane(&seed, tick, &boss),
                None,
                "tick {tick} is not a beat"
            );
        }

        // Every beat of a full-length fight lands, always inside one hand's own lanes,
        // and over that many draws both hands must come up — one bit picks between them,
        // so a hand that never appears means the bit is not doing its job.
        let beats = ENRAGE_TICKS / SLAM_PERIOD_TICKS;
        let (mut mace, mut claws) = (0u32, 0u32);
        for beat in 1..=beats {
            let lane = slam_lane(&seed, beat * SLAM_PERIOD_TICKS, &boss).expect("both hands stand");
            assert!(
                in_mace(lane) || in_claws(lane),
                "beat {beat} slammed lane {lane}"
            );
            if in_mace(lane) {
                mace += 1;
            } else {
                claws += 1;
            }
        }
        assert!(
            mace > 0 && claws > 0,
            "one bit picks the hand; both must come up"
        );

        // Shoot the mace off: its beats go quiet and the claws keep theirs.
        boss.parts[PART_MACE] = 0;
        let mut silenced = 0u32;
        for beat in 1..=beats {
            match slam_lane(&seed, beat * SLAM_PERIOD_TICKS, &boss) {
                None => silenced += 1,
                Some(lane) => assert!(in_claws(lane), "a dead mace slammed lane {lane}"),
            }
        }
        assert_eq!(silenced, mace, "exactly the mace's beats went quiet");

        // Both hands gone and the boss cannot reach the pit at all.
        boss.parts[PART_CLAWS] = 0;
        for beat in 1..=beats {
            assert_eq!(slam_lane(&seed, beat * SLAM_PERIOD_TICKS, &boss), None);
        }

        // Except with the vent exposed: the torso lunges over it whichever limbs
        // survive, always down the centre column the stripped shell forces the raid into.
        boss.vent_open = 1;
        for beat in 1..=beats {
            assert_eq!(
                slam_lane(&seed, beat * SLAM_PERIOD_TICKS, &boss),
                Some(SLAM_VENT_LANE)
            );
        }
    }

    /// The telegraph is the whole point of a derived attack: twenty clients wind up from
    /// published bytes and must all draw the column the hand actually lands on.
    ///
    /// This is also the executable copy of the cycle-index recipe. A wind-up tick divides
    /// to the *previous* cycle, so a client must round up to the next beat. Asking
    /// `slam_lane` about the wind-up tick itself returns `None` — silently, which is
    /// exactly how this would ship wrong.
    #[test]
    fn the_telegraph_announces_the_slam_that_lands() {
        let (arena, boss, _) = hands_only();
        let seed = arena.affix_seed;

        for beat in 1..=8u32 {
            let lands_at = beat * SLAM_PERIOD_TICKS;
            let landed = slam_lane(&seed, lands_at, &boss);
            for t in lands_at - SLAM_TELEGRAPH_TICKS..lands_at {
                // The window predicate the client gates its animation on, and the beat,
                // must describe the same ticks.
                assert!(t % SLAM_PERIOD_TICKS >= SLAM_PERIOD_TICKS - SLAM_TELEGRAPH_TICKS);
                assert_eq!(
                    slam_lane(&seed, t, &boss),
                    None,
                    "a wind-up tick lands nothing"
                );
                let next_beat = (t / SLAM_PERIOD_TICKS + 1) * SLAM_PERIOD_TICKS;
                assert_eq!(next_beat, lands_at);
                assert_eq!(
                    slam_lane(&seed, next_beat, &boss),
                    landed,
                    "the wind-up at tick {t} must draw the lane that lands"
                );
            }
        }
    }

    /// A slam death has to be indistinguishable from a bullet death to everything
    /// downstream, or the raid keeps an `alive_count` it does not have — or settles as a
    /// wipe with a player still coming back.
    #[test]
    fn a_slam_death_is_recorded_exactly_like_a_bullet_death() {
        let (mut arena, mut boss, mut players) = hands_only();
        let lane = slam_lane(&arena.affix_seed, SLAM_PERIOD_TICKS, &boss).expect("a hand stands");
        let hit_x = (lane * SLAM_LANE_W + SLAM_LANE_W / 2) as i16;
        // Four lanes over: inside the arena by construction, outside the slam by
        // construction.
        let safe_x =
            (((lane + SLAM_LANES / 2) % SLAM_LANES) * SLAM_LANE_W + SLAM_LANE_W / 2) as i16;

        seat_in_arena(&mut players, 2, hit_x, 512);
        seat_in_arena(&mut players, 5, hit_x, 512);
        seat_in_arena(&mut players, 9, safe_x, 512);
        // Three seats stand in the pit, so the slam is sized to a raid of three.
        let per_slam = slam_damage(3);
        players.slots[5].hp = per_slam;

        while arena.tick < SLAM_PERIOD_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
        }

        assert_eq!(
            players.slots[2].hp,
            100 - per_slam,
            "the hand lands on its lane"
        );
        assert_eq!(players.slots[9].hp, 100, "and on no other");
        assert_eq!(players.slots[5].hp, 0);
        assert_eq!(
            players.slots[5].respawn_at_tick,
            SLAM_PERIOD_TICKS + RESPAWN_TICKS,
            "a slam death is a respawn deadline, like any other"
        );
        assert_eq!(players.slots[5].deaths, 1, "and it is counted");
        assert_eq!(arena.alive_count, 2, "and the corpse left the live list");
        assert_eq!(
            arena.phase, PHASE_FIGHTING,
            "a scheduled comeback is not a wipe"
        );

        // Two slams do not quite kill a full-health raider; that is the whole point of
        // the number. It is a mechanic check, not a damage check.
        while arena.tick < 2 * SLAM_PERIOD_TICKS {
            tick_once(&mut arena, &mut boss, &mut players);
        }
        assert!(
            players.slots[2].hp > 0,
            "two slams must not be a kill on their own"
        );
    }

    /// Incoming damage is the third raid-size knob: one raider takes the solo endpoint
    /// from a bullet and from a slam, twenty take the flat numbers the crank always dealt.
    /// Driven through the tick so the knob is read off the high-water mark the tick keeps,
    /// not off a raid size a test handed in.
    #[test]
    fn incoming_damage_is_sized_to_the_raid() {
        let bullet_hit = |occupants: usize| {
            let (mut arena, mut boss, mut players) = fight();
            boss.parts = [0; N_PARTS];
            let (shot, px, py) = open_shot();
            let far_y = if py < (ARENA_SIZE / 2) as i16 {
                py + 300
            } else {
                py - 300
            };
            seat_in_arena(&mut players, 0, px, py);
            for seat in 1..occupants {
                seat_in_arena(&mut players, seat, px, far_y);
            }
            arena.bullets[0] = shot;
            tick_once(&mut arena, &mut boss, &mut players);
            100 - players.slots[0].hp
        };
        assert_eq!(bullet_hit(1), BULLET_DAMAGE_SOLO, "solo takes the solo bullet");
        assert_eq!(bullet_hit(MAX_SEATS), BULLET_DAMAGE_FULL, "twenty take the full one");

        let slam_hit = |occupants: usize| {
            let (mut arena, mut boss, mut players) = hands_only();
            let lane =
                slam_lane(&arena.affix_seed, SLAM_PERIOD_TICKS, &boss).expect("a hand stands");
            let hit_x = (lane * SLAM_LANE_W + SLAM_LANE_W / 2) as i16;
            for seat in 0..occupants {
                seat_in_arena(&mut players, seat, hit_x, 512);
            }
            while arena.tick < SLAM_PERIOD_TICKS {
                tick_once(&mut arena, &mut boss, &mut players);
            }
            100 - players.slots[0].hp
        };
        assert_eq!(slam_hit(1), SLAM_DAMAGE_SOLO, "solo takes the solo slam");
        assert_eq!(slam_hit(MAX_SEATS), SLAM_DAMAGE_FULL, "twenty take the full one");
    }

    /// More players must mean a harder fight, and one player must still be able to win
    /// one. The knob is `core_hp` and it is monotone, so it cannot be gamed by dying,
    /// leaving, or waiting for the twentieth raider to walk back out.
    #[test]
    fn the_core_is_sized_to_the_raid() {
        let core_after = |occupants: usize| {
            let (mut arena, mut boss, mut players) = hands_only();
            for seat in 0..occupants {
                seat_in_arena(&mut players, seat, 400, 512);
            }
            tick_once(&mut arena, &mut boss, &mut players);
            (boss.core_hp, boss.core_hp_max)
        };

        let solo = BOSS_CORE_HP;
        let full = BOSS_CORE_HP + CORE_HP_PER_RAIDER * (MAX_SEATS as u16 - 1);
        assert_eq!(
            core_after(0),
            (solo, solo),
            "an empty arena still fights the floor"
        );
        assert_eq!(core_after(1), (solo, solo), "solo stays winnable");
        assert_eq!(core_after(MAX_SEATS), (full, full));
        assert!(
            full > solo,
            "twenty raiders must be a longer fight than one"
        );

        // Monotone: the high-water record does not fall when the raid does.
        let (mut arena, mut boss, mut players) = hands_only();
        for seat in 0..MAX_SEATS {
            seat_in_arena(&mut players, seat, 400, 512);
        }
        tick_once(&mut arena, &mut boss, &mut players);
        for seat in 1..MAX_SEATS {
            players.slots[seat].zone = ZONE_LOBBY;
        }
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(boss.core_hp_max, full, "leaving does not shrink the boss");

        // And it never revives a core the raid has already killed.
        let (mut arena, mut boss, mut players) = hands_only();
        boss.core_hp = 0;
        seat_in_arena(&mut players, 0, 400, 512);
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(
            boss.core_hp, 0,
            "the difficulty curve does not resurrect the boss"
        );
        assert_eq!(arena.outcome, OUTCOME_WIN);
    }

    /// The raid size both knobs read is a high-water mark: it counts the biggest raid
    /// that has stood in the pit, never the one standing there now, and the vent threshold
    /// follows it. Solo opens the vent with 60 % of the shell left; twenty do not.
    #[test]
    fn the_raid_size_is_a_high_water_mark_and_the_vent_reads_it() {
        // `fight()`, not `hands_only()`: the vent half below needs a `parts_max` the shell
        // is measured against, and nothing fires inside the three ticks the first half runs.
        let (mut arena, mut boss, mut players) = fight();
        assert_eq!(arena.raid_size, 0, "nothing counted before the first tick");
        for seat in 0..3 {
            seat_in_arena(&mut players, seat, 400, 512);
        }
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.raid_size, 3);
        assert_eq!(boss.core_hp_max, BOSS_CORE_HP + 2 * CORE_HP_PER_RAIDER);

        // Two leave: the mark holds, and so does the core.
        players.slots[1].zone = ZONE_LOBBY;
        players.slots[2].zone = ZONE_LOBBY;
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.raid_size, 3, "leaving does not shrink the raid");
        assert_eq!(boss.core_hp_max, BOSS_CORE_HP + 2 * CORE_HP_PER_RAIDER);

        // Seven arrive: it grows, and only ever grows.
        for seat in 0..7 {
            seat_in_arena(&mut players, seat, 400, 512);
        }
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.raid_size, 7);
        assert_eq!(boss.core_hp_max, BOSS_CORE_HP + 6 * CORE_HP_PER_RAIDER);

        // The vent reads the mark. 60 % of the shell standing: open for a raid of one
        // (threshold 65 %), sealed for a raid of twenty (35 %), from the same parts.
        let vent_after = |occupants: usize| {
            let (mut arena, mut boss, mut players) = fight();
            for seat in 0..occupants {
                seat_in_arena(&mut players, seat, 400, 512);
            }
            boss.parts = [60; N_PARTS];
            tick_once(&mut arena, &mut boss, &mut players);
            (arena.raid_size as usize, boss.vent_open)
        };
        assert_eq!(vent_after(1), (1, 1), "solo opens the vent at 60 %");
        assert_eq!(vent_after(MAX_SEATS), (MAX_SEATS, 0), "twenty do not");
    }

    /// The muster: the first knight through the gate opens a fixed-length window and the
    /// chain's own crank closes it, so a raid can never fail to start and twenty browsers
    /// agree on the moment without talking to each other.
    #[test]
    fn a_muster_flips_to_fighting_on_its_own_deadline() {
        let (mut arena, mut boss, mut players) = hands_only();
        arena.phase = PHASE_MUSTERING;
        // `enrage_at_tick` is match state now, not creation state: it reads 0 for the
        // whole muster, and is stamped at the flip. Otherwise the muster would silently
        // shorten every fight by its own length.
        arena.enrage_at_tick = 0;
        let flip = MUSTER_TICKS;
        arena.fight_at_tick = flip;
        seat_in_arena(&mut players, 0, 400, 512);

        while arena.tick < flip - 1 {
            tick_once(&mut arena, &mut boss, &mut players);
            assert_eq!(arena.phase, PHASE_MUSTERING, "the window is fixed length");
            assert_eq!(arena.alive_count, 0, "no step runs during a muster");
            assert_eq!(arena.enrage_at_tick, 0, "the fight clock has not started");
        }

        // The deadline tick: the crank performs the flip, and `step` does not run on it.
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.tick, flip);
        assert_eq!(arena.phase, PHASE_FIGHTING);
        assert_eq!(arena.fight_at_tick, 0, "no muster is scheduled any more");
        assert_eq!(
            arena.enrage_at_tick,
            flip + ENRAGE_TICKS,
            "a full fight, not one shortened by its own muster"
        );
        assert_eq!(arena.alive_count, 0, "the flip tick is not a fight tick");

        // The next execution is the fight's first tick.
        tick_once(&mut arena, &mut boss, &mut players);
        assert_eq!(arena.alive_count, 1);
        assert_eq!(boss.target_seat, 0);
    }
}
