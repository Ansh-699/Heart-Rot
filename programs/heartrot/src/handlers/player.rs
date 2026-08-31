//! Player-facing handlers: `join`, `move_player`, `enter_gate`.
//!
//! These three are everything a browser session key is allowed to do outside of
//! `shoot`. They run **on the ER**, where transaction fees are zero and the forked
//! SVM performs no fee-payer validation at all — nothing debits a spammer, so the
//! only rate limit that exists anywhere is the tick counters written here (D16/R12).
//!
//! Two rules that the rest of this file is shaped around:
//!
//! - **Authority is the whole perimeter.** Every handler asserts
//!   `authority.is_signer && authority == slots[seat].session_pubkey`. There is no
//!   framework check underneath it; one omission is an arena-wide compromise (D17).
//! - **Seats are handed out by the Worker, not claimed by players.** `join` is the
//!   `claim_seat` of `01-architecture.md` §2.3 and is signed by
//!   `arena.crank_authority` (the treasury). If a session key could claim its own
//!   seat, one keypair would take all 20 for free in a single free-of-charge burst
//!   and the raid would never start. The Sybil gate is Privy identity in the Worker;
//!   this handler enforces that the Worker is the one asking.
//!
//! Coordinates are integers in arena-space units, y down, origin top-left, shared
//! verbatim with `Bullet` and `Boss`. `TILE` units make one map tile. Nothing here
//! is ever a float: the client extrapolates the same integers between ticks, and a
//! float on either side of the boundary reintroduces drift.

use pinocchio::{
    error::ProgramError,
    sysvars::{clock::Clock, Sysvar},
    AccountView, Address, ProgramResult,
};

use crate::guards::{
    assert_owned_by, assert_pda, assert_session_authority, assert_signer, assert_writable,
};
use crate::state::{
    self, Arena, Players, MAX_SEATS, PHASE_FIGHTING, PHASE_LOBBY, SEED_PLAYERS, ZONE_ARENA,
    ZONE_LOBBY,
};

// ---------------------------------------------------------------------------
// Map geometry
// ---------------------------------------------------------------------------

/// Arena-space units per map tile. Positions are sub-tile so bullets (i8 velocity)
/// have somewhere to move between ticks; tile indices are `pos / TILE`.
pub const TILE: i16 = 16;

/// The map is 64×64 tiles per zone (`00-game-design-spec.md` §6), which is exactly
/// one `u64` of wall bits per row.
pub const MAP_TILES: usize = 64;

/// Highest legal coordinate. Everything written to `x`/`y` is clamped into
/// `0..=MAP_MAX_XY`, which is also what makes the tile index below in-range.
pub const MAP_MAX_XY: i16 = (MAP_TILES as i16) * TILE - 1;

/// Wall bitboard: bit *x* of row *y* set means tile (x, y) is solid.
///
/// ponytail: this is a bare border ring — the real layout comes from the tilemap
/// build step, the same way `tools/svg_slice.py` emits the boss hitboxes the chain
/// raycasts against. The *collision code* is the real thing; only the data is a
/// placeholder. Upgrade path: emit `walls.rs` (or a `[u64; 64]` per zone) from the
/// tilemap alongside the static background layer, and index it by `zone` here.
const WALLS: [u64; MAP_TILES] = border_walls();

const fn border_walls() -> [u64; MAP_TILES] {
    let mut rows = [0u64; MAP_TILES];
    let edges = 1u64 | (1u64 << (MAP_TILES - 1));
    rows[0] = u64::MAX;
    rows[MAP_TILES - 1] = u64::MAX;
    let mut y = 1;
    while y < MAP_TILES - 1 {
        rows[y] = edges;
        y += 1;
    }
    rows
}

/// The gate tile block, in lobby space. Standing inside it is what `enter_gate`
/// requires — the lobby *is* the matchmaker, so the gate has to be a place you walk
/// to and not an API call you make from across the map.
const GATE_MIN_X: i16 = 30 * TILE;
const GATE_MAX_X: i16 = 34 * TILE - 1;
const GATE_MIN_Y: i16 = 30 * TILE;
const GATE_MAX_Y: i16 = 34 * TILE - 1;

/// The lobby entrance and the sideways pitch seats fan out along, so twenty players
/// never stack on one pixel and the client can render a join without waiting for the
/// next crank tick to separate them.
///
/// The *arena* entrance is deliberately not here: `tick::entrance_for` owns it, because
/// that is where `boss_tick` returns a dead player, and walking through the gate has to
/// land in the same place a respawn does.
const LOBBY_ENTRANCE: (i16, i16) = (28 * TILE, 52 * TILE);
const LOBBY_SPACING: i16 = 24;

/// Starting health. Balance number, not a layout number — `hp_max` is per-slot state
/// so an incarnation could scale it later without touching this file.
pub const PLAYER_HP_MAX: u16 = 100;

/// Eight-way step, indexed by `facing`: 0 N, 1 NE, 2 E, 3 SE, 4 S, 5 SW, 6 W, 7 NW,
/// with y increasing downward. The diagonal component is `round(TILE / √2)` so a
/// diagonal move covers the same ground as a straight one — computed here as a
/// constant because the program may never touch a float.
const STEP: i16 = TILE;
const STEP_DIAG: i16 = 11;
const MOVE_STEP: [(i16, i16); 8] = [
    (0, -STEP),
    (STEP_DIAG, -STEP_DIAG),
    (STEP, 0),
    (STEP_DIAG, STEP_DIAG),
    (0, STEP),
    (-STEP_DIAG, STEP_DIAG),
    (-STEP, 0),
    (-STEP_DIAG, -STEP_DIAG),
];

/// `PlayerSlot.session_pubkey` sentinel for "seat never claimed".
const UNCLAIMED: [u8; 32] = [0u8; 32];

const JOIN_DATA_LEN: usize = 1 + 32 + 32;
const MOVE_DATA_LEN: usize = 1 + 2;

// ---------------------------------------------------------------------------
// Pure geometry helpers
// ---------------------------------------------------------------------------

/// Where seat *n* appears when it joins the lobby: fanned out sideways from the
/// entrance, the same shape `tick::entrance_for` uses on the arena side.
pub fn lobby_spawn(seat: u8) -> (i16, i16) {
    let offset = (seat as i16)
        .saturating_sub(MAX_SEATS as i16 / 2)
        .saturating_mul(LOBBY_SPACING);
    (
        LOBBY_ENTRANCE.0.saturating_add(offset).clamp(0, MAP_MAX_XY),
        LOBBY_ENTRANCE.1.clamp(0, MAP_MAX_XY),
    )
}

/// Is the tile containing this point solid? Anything off the map counts as wall, so
/// a caller that skips the clamp fails closed rather than indexing out of range.
fn is_wall(x: i16, y: i16) -> bool {
    if x < 0 || y < 0 {
        return true;
    }
    let tx = (x / TILE) as usize;
    let ty = (y / TILE) as usize;
    if tx >= MAP_TILES {
        return true;
    }
    match WALLS.get(ty) {
        Some(row) => row & (1u64 << tx) != 0,
        None => true,
    }
}

fn on_gate(x: i16, y: i16) -> bool {
    (GATE_MIN_X..=GATE_MAX_X).contains(&x) && (GATE_MIN_Y..=GATE_MAX_Y).contains(&y)
}

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/// The clock the `move` rate limiter stamps into `last_move_tick`.
///
/// `arena.tick` is the contract's source (D16) and is correct during a fight. It is
/// *not* correct in the lobby: `boss_tick` returns before incrementing unless
/// `phase == PHASE_FIGHTING`, so a tick-only limiter would grant each player exactly
/// one lobby move ever and then freeze them short of the gate — no match could ever
/// start. The ER's 50 ms slot is the only other monotonic counter available on this
/// side of the boundary, so the lobby uses that.
///
/// The comparison against the stamp is `!=`, not `>`. Swapping sources at the phase
/// flip leaves a stamp from the other clock in the field (a slot number dwarfs a
/// tick), and `>` would then freeze every player for the entire match. Neither clock
/// can be rewound by a caller, so `!=` is exactly as tight: one accepted move per
/// tick while fighting, one per 50 ms slot in the lobby.
///
/// ponytail: `slot as u32` truncates, so one move is dropped every ~2^32 slots
/// (~6.8 years of ER uptime). Widening `last_move_tick` is a layout change; it is
/// not worth one.
fn move_clock(arena: &Arena) -> Result<u32, ProgramError> {
    if arena.phase == PHASE_FIGHTING {
        Ok(arena.tick)
    } else {
        Ok(Clock::get()?.slot as u32)
    }
}

/// Accounts must be validated before any state is touched, and every guard below
/// takes `&AccountView` — which means all of them have to run *before* the `RefMut`
/// borrows, not interleaved with them.
///
/// `players` is bound to `arena` by re-deriving its PDA from the arena address, which
/// is what stops a caller pairing match A's arena with match B's players. `arena`
/// itself is checked by owner + discriminator only: nothing but this program can
/// mint an account it owns, so re-deriving `[b"arena", arena_id]` would buy nothing
/// for ~1.5K CU.
///
/// Returns the arena address, since the `RefMut` on `arena` makes it unreachable
/// afterwards.
fn validate_pair(
    program_id: &Address,
    arena_ai: &AccountView,
    players_ai: &AccountView,
    authority_ai: &AccountView,
    arena_writable: bool,
) -> Result<Address, ProgramError> {
    assert_signer(authority_ai)?;
    assert_writable(players_ai)?;
    if arena_writable {
        assert_writable(arena_ai)?;
    }
    // Inside the ER a delegated account keeps its original owner; on base layer it
    // would be the delegation program. These three handlers only ever run on the ER.
    assert_owned_by(arena_ai, program_id)?;
    assert_owned_by(players_ai, program_id)?;

    let arena_key = *arena_ai.address();
    // `assert_pda` searches for the canonical bump itself (guards.rs) — the stored bump
    // is never a seed. Passing it as one derives a different address entirely, which
    // rejects every legitimate call.
    assert_pda(players_ai, &[SEED_PLAYERS, arena_key.as_ref()], program_id)?;
    Ok(arena_key)
}

/// Which seat this signer holds. Scanning 20 fixed-size slots is cheaper than
/// trusting a client-supplied seat index and then having to prove it, and it keeps
/// the instruction data to what the client actually knows.
///
/// The unclaimed sentinel is the all-zero address, which no signer can hold, so an
/// empty seat can never match.
fn seat_of(players: &Players, authority: &Address) -> Result<usize, ProgramError> {
    let key = authority.as_ref();
    for (seat, slot) in players.slots.iter().enumerate() {
        if slot.session_pubkey.as_slice() == key {
            return Ok(seat);
        }
    }
    Err(ProgramError::InvalidArgument)
}

/// A match that is settling or settled accepts no player input at all — the accounts
/// are on their way back to base layer and any write is either lost or, worse, lands
/// after the commit snapshot.
fn assert_playable(phase: u8) -> Result<(), ProgramError> {
    if phase == PHASE_LOBBY || phase == PHASE_FIGHTING {
        Ok(())
    } else {
        Err(ProgramError::InvalidAccountData)
    }
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

/// `join(skin_id, session_pubkey, identity)` — accounts
/// `[arena (w), players (w), treasury (signer)]`.
///
/// Claims a free seat for a browser session key, or rotates the key on the seat this
/// identity already holds. Rejects a full arena and rejects a session key that is
/// already seated elsewhere.
pub fn join(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [arena_ai, players_ai, treasury_ai, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() != JOIN_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let skin_id = data[0];
    let mut session_pubkey = [0u8; 32];
    session_pubkey.copy_from_slice(&data[1..33]);
    let mut identity = [0u8; 32];
    identity.copy_from_slice(&data[33..65]);
    // The all-zero session key is the "unclaimed" sentinel and the all-zero identity
    // is what an unwritten slot carries; accepting either would let two joins collide
    // onto one seat and would make the leaderboard key meaningless.
    if session_pubkey == UNCLAIMED || identity == [0u8; 32] {
        return Err(ProgramError::InvalidInstructionData);
    }

    validate_pair(program_id, arena_ai, players_ai, treasury_ai, true)?;
    let treasury_key = *treasury_ai.address();

    let mut arena_data = arena_ai.try_borrow_mut()?;
    let arena = state::load_mut::<Arena>(&mut arena_data)?;
    assert_playable(arena.phase)?;
    // Seats are administered, not self-served — see the module header.
    if treasury_key.as_ref() != arena.crank_authority.as_slice() {
        return Err(ProgramError::IncorrectAuthority);
    }

    let mut players_data = players_ai.try_borrow_mut()?;
    let players = state::load_mut::<Players>(&mut players_data)?;

    let mut free: Option<usize> = None;
    let mut returning: Option<usize> = None;
    for (i, slot) in players.slots.iter().enumerate() {
        if slot.session_pubkey == UNCLAIMED {
            if free.is_none() {
                free = Some(i);
            }
            continue;
        }
        // Privy identity is the durable record; the session key is not. A player who
        // cleared their browser storage comes back to this seat with a new key.
        if slot.identity == identity {
            returning = Some(i);
            continue;
        }
        if slot.session_pubkey == session_pubkey {
            return Err(ProgramError::AccountAlreadyInitialized);
        }
    }

    if let Some(seat) = returning {
        let slot = players
            .slots
            .get_mut(seat)
            .ok_or(ProgramError::InvalidArgument)?;
        // Key rotation only. Position, HP, zone, damage and both rate-limit stamps
        // belong to the match in progress: someone who lost their browser storage
        // walks back into the fight where they left it, not to the lobby with a
        // cleared score. Writing the same key twice is therefore a no-op, which is
        // what makes `/session/init` safe to retry.
        slot.session_pubkey = session_pubkey;
        slot.skin_id = skin_id;
        return Ok(());
    }

    // ponytail: "arena full" and "seat index out of range" both surface as
    // `InvalidArgument` because this program has no shared error enum yet. The Worker
    // distinguishes full from everything else by reading `seat_occupied` before it
    // sends, so nothing depends on the code today.
    let seat = free.ok_or(ProgramError::InvalidArgument)?;
    let slot = players
        .slots
        .get_mut(seat)
        .ok_or(ProgramError::InvalidArgument)?;
    let (x, y) = lobby_spawn(seat as u8);
    slot.zone = ZONE_LOBBY;
    slot.facing = 0;
    slot.skin_id = skin_id;
    slot.x = x;
    slot.y = y;
    slot.hp = PLAYER_HP_MAX;
    slot.hp_max = PLAYER_HP_MAX;
    slot.last_move_seq = 0;
    slot.respawn_at_tick = 0;
    // Zero is a legal stamp under the `!=` rule in `move_clock`: it can only equal
    // the current clock in the one slot/tick where both are 0, which costs at most
    // one dropped input at genesis.
    slot.last_shot_tick = 0;
    slot.last_move_tick = 0;
    slot.damage_dealt = 0;
    slot.session_pubkey = session_pubkey;
    slot.identity = identity;

    // The bitmask is the Worker's cheap read of occupancy; `session_pubkey` above is
    // the authority. They are written together so they cannot drift.
    arena.seat_occupied |= 1u32 << seat;
    Ok(())
}

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

/// `move(direction, seq)` — accounts `[arena (r), players (w), session key (signer)]`.
///
/// `move` is a Rust keyword, hence the name.
pub fn move_player(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let [arena_ai, players_ai, authority_ai, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if data.len() != MOVE_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }
    let dir = data[0];
    let seq = u16::from_le_bytes([data[1], data[2]]);
    let (dx, dy) = *MOVE_STEP
        .get(dir as usize)
        .ok_or(ProgramError::InvalidInstructionData)?;

    // `arena` stays read-only here: a move must not rewrite the 1,160-byte account
    // the whole lobby is subscribed to.
    validate_pair(program_id, arena_ai, players_ai, authority_ai, false)?;
    let authority_key = *authority_ai.address();

    let now = {
        let arena_data = arena_ai.try_borrow()?;
        let arena = state::load::<Arena>(&arena_data)?;
        assert_playable(arena.phase)?;
        move_clock(arena)?
    };

    let mut players_data = players_ai.try_borrow_mut()?;
    let players = state::load_mut::<Players>(&mut players_data)?;
    let seat = seat_of(players, &authority_key)?;
    let slot = players
        .slots
        .get_mut(seat)
        .ok_or(ProgramError::InvalidArgument)?;
    // `seat_of` already matched this key, but the perimeter is one line and the guard
    // is the thing that is audited. Both stay.
    assert_session_authority(slot, authority_ai)?;

    // A dead player is `boss_tick`'s to move: it owns `respawn_at_tick` and the
    // return to the entrance.
    if slot.hp == 0 {
        return Err(ProgramError::InvalidArgument);
    }

    // The rate limit. ER fees are zero, so this counter is the only thing standing
    // between one keypair and an unbounded flood (D16/R12).
    if slot.last_move_tick == now {
        return Err(ProgramError::InvalidArgument);
    }

    let nx = slot.x.saturating_add(dx).clamp(0, MAP_MAX_XY);
    let ny = slot.y.saturating_add(dy).clamp(0, MAP_MAX_XY);
    if is_wall(nx, ny) {
        return Err(ProgramError::InvalidArgument);
    }

    slot.x = nx;
    slot.y = ny;
    slot.facing = dir;
    // Echo the client's sequence number back. Without it an arriving position is
    // ambiguous as to which input produced it and prediction cannot be reconciled;
    // the symptom is rubber-banding for every player (D14).
    slot.last_move_seq = seq;
    slot.last_move_tick = now;
    Ok(())
}

// ---------------------------------------------------------------------------
// enter_gate
// ---------------------------------------------------------------------------

/// `enter_gate()` — accounts `[arena (w), players (w), session key (signer)]`.
///
/// Flips the seat from lobby to arena and teleports it to the arena entrance. Takes
/// no instruction data; the parameter exists so every handler dispatches the same
/// way.
pub fn enter_gate(
    program_id: &Address,
    accounts: &mut [AccountView],
    _data: &[u8],
) -> ProgramResult {
    let [arena_ai, players_ai, authority_ai, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    validate_pair(program_id, arena_ai, players_ai, authority_ai, true)?;
    let authority_key = *authority_ai.address();

    let mut arena_data = arena_ai.try_borrow_mut()?;
    let arena = state::load_mut::<Arena>(&mut arena_data)?;
    assert_playable(arena.phase)?;

    let mut players_data = players_ai.try_borrow_mut()?;
    let players = state::load_mut::<Players>(&mut players_data)?;
    let seat = seat_of(players, &authority_key)?;
    let slot = players
        .slots
        .get_mut(seat)
        .ok_or(ProgramError::InvalidArgument)?;
    assert_session_authority(slot, authority_ai)?;

    // One direction only. Coming back out is `phase == Settled`, not an instruction —
    // and rejecting the repeat is what keeps `alive_count` from being incremented
    // twice by one player, which would inflate `bullets_per_volley` for everyone.
    if slot.zone != ZONE_LOBBY {
        return Err(ProgramError::InvalidArgument);
    }
    if !on_gate(slot.x, slot.y) {
        return Err(ProgramError::InvalidArgument);
    }
    // Aliveness is derived as `hp != 0 && zone == ZONE_ARENA`, so a seat with a zero
    // `hp_max` would count toward `alive_count` while never being alive. `join`
    // always sets it; this is the assertion that says so.
    if slot.hp_max == 0 {
        return Err(ProgramError::InvalidAccountData);
    }

    // `boss_tick` owns the arena entrance; a second definition here would read as a
    // teleport bug the first time anyone died.
    let (x, y) = crate::handlers::tick::entrance_for(seat);
    slot.zone = ZONE_ARENA;
    slot.x = x;
    slot.y = y;
    slot.facing = 0;
    slot.hp = slot.hp_max;
    slot.respawn_at_tick = 0;

    // Cap rather than wrap: `alive_count` drives `bullets_per_volley = 3 + alive_count`,
    // and a wrapped count would fill the pool on the next volley.
    arena.alive_count = arena.alive_count.saturating_add(1).min(MAX_SEATS as u8);
    Ok(())
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn geometry_holds() {
        // Every spawn is inside the map, off the wall ring, and unique per seat. The
        // arena side is `tick`'s point, checked here because the wall map lives here: a
        // gate that lands a player in a wall leaves them unable to move at all.
        let mut seen = [(0i16, 0i16); MAX_SEATS];
        for seat in 0..MAX_SEATS as u8 {
            for (x, y) in [
                lobby_spawn(seat),
                crate::handlers::tick::entrance_for(seat as usize),
            ] {
                assert!((0..=MAP_MAX_XY).contains(&x) && (0..=MAP_MAX_XY).contains(&y));
                assert!(!is_wall(x, y), "seat {seat} spawns in a wall");
            }
            let p = lobby_spawn(seat);
            assert!(!seen[..seat as usize].contains(&p), "seat {seat} stacks");
            seen[seat as usize] = p;
        }

        // The wall ring is closed and the interior is open.
        assert!(is_wall(0, 0) && is_wall(MAP_MAX_XY, MAP_MAX_XY));
        assert!(is_wall(500, MAP_MAX_XY) && is_wall(0, 500));
        assert!(!is_wall(TILE, TILE));
        // Off-map fails closed rather than indexing out of range.
        assert!(is_wall(-1, 0) && is_wall(0, -1) && is_wall(MAP_MAX_XY + 1, 0));

        // Walking into the ring is clamped in bounds and then rejected as wall, and
        // the clamp itself never overflows at the i16 extremes.
        for (dx, dy) in MOVE_STEP {
            let nx = i16::MAX.saturating_add(dx).clamp(0, MAP_MAX_XY);
            let ny = i16::MIN.saturating_add(dy).clamp(0, MAP_MAX_XY);
            assert!((0..=MAP_MAX_XY).contains(&nx) && (0..=MAP_MAX_XY).contains(&ny));
        }
        assert!(is_wall(
            TILE.saturating_add(MOVE_STEP[6].0).clamp(0, MAP_MAX_XY),
            TILE
        ));

        // Diagonals cover the same ground as straights, within one unit.
        for (dx, dy) in MOVE_STEP {
            let d2 = (dx as i32) * (dx as i32) + (dy as i32) * (dy as i32);
            let straight = (STEP as i32) * (STEP as i32);
            assert!((d2 - straight).abs() <= 2 * STEP as i32);
        }

        // The gate is reachable: it is inside the map and not a wall.
        assert!(on_gate(GATE_MIN_X, GATE_MIN_Y) && on_gate(GATE_MAX_X, GATE_MAX_Y));
        assert!(!on_gate(GATE_MIN_X - 1, GATE_MIN_Y) && !on_gate(GATE_MAX_X + 1, GATE_MAX_Y));
        assert!(!is_wall(GATE_MIN_X, GATE_MIN_Y) && !is_wall(GATE_MAX_X, GATE_MAX_Y));
    }
}
