//! Base-layer account creation: the CPIs that stand a match up before anything is
//! delegated to the ER.
//!
//! Two instructions, both base layer, both paid by the treasury: [`init_arena`] once per
//! match (`Arena` + `Boss` + `Players`, tag 1) and [`init_leaderboard`] once per
//! deployment (tag 0). Neither is on the 400 ms path, so they spend compute freely on a
//! full PDA search rather than trusting a caller-supplied bump.
//!
//! Four rules the rest of this file is built on:
//!
//! 1. **One instruction creates all three match accounts.** They are delegated together,
//!    the crank's frozen account list names all three, and `delegate` reads `Boss.bump`
//!    and `Players.bump` — so a match with an `Arena` and no `Boss` is not a partial
//!    match, it is a wedged one. Doing it in one transaction removes the state in which
//!    that is possible, and it is what the frozen wire ABI (tag 1, 74 argument bytes,
//!    accounts `[payer, arena, boss, players, system]`) already describes.
//! 2. **Arena creation is permissioned.** [`TREASURY`] is the only key that may open a
//!    match. It has to be: `arena_id` is `Leaderboard.last_arena_id + 1`, which is public
//!    and fully deterministic, so a permissionless `init_arena` lets anyone create the
//!    next arena with themselves as `crank_authority` for the price of its rent. Nothing
//!    can then delegate or start it, its phase stays `PHASE_LOBBY` forever, and the
//!    Worker keeps handing every new player that same dead id. One cheap transaction,
//!    matchmaking permanently dead, repeatable for every id after it.
//! 3. **A guessable PDA is never created with plain `CreateAccount`.** All four of these
//!    addresses are derivable by anyone, and `CreateAccount` fails outright on an account
//!    that already holds lamports — so 1 lamport sent ahead of us would block the address
//!    forever. `create_account_with_minimum_balance_signed` transfers only the rent
//!    shortfall and then allocates and assigns, which is prefund-safe on every cluster
//!    and needs no guess about a System feature gate.
//! 4. **Balance is a constant, not an argument.** The 74-byte tag-1 block is
//!    `arena_id ‖ incarnation ‖ validator_identity ‖ crank_authority` and has nowhere to
//!    carry boss HP. Incarnation scaling is applied here, on chain, because it is a rule
//!    rather than a tuning knob.

use pinocchio::{
    address::address_eq,
    cpi::{Seed, Signer},
    error::ProgramError,
    AccountView, Address, ProgramResult,
};
use pinocchio_system::create_account_with_minimum_balance_signed;

use crate::guards::{assert_owned_by, assert_pda, assert_signer, assert_writable};
use crate::state::{
    init, AccountLayout, Arena, Boss, Leaderboard, Players, NO_TARGET, N_PARTS, PHASE_LOBBY,
    SEED_ARENA, SEED_BOSS, SEED_LEADERBOARD, SEED_PLAYERS,
};

/// The only key allowed to open a match.
///
/// **Fill this in with the treasury's address before the first deploy**, the same way
/// `PROGRAM_ID` is filled into `worker/wrangler.jsonc` after it. The placeholder below is
/// the all-zero address, which no keypair can sign for, so an unfilled build refuses every
/// `init_arena` rather than shipping the squatting hole described in rule 2 — a program
/// that opens no arenas is recoverable in one redeploy, one that opens them for an
/// attacker is not.
///
/// Unlike the program id (which the runtime hands every handler, and which this crate
/// therefore never hardcodes), the treasury is not knowable from inside a transaction and
/// is chosen before deploy, so a constant is the only place it can live.
///
/// ponytail: one baked-in key rather than an admin field, because the frozen layout
/// contract has no spare bytes on `Leaderboard` and adding some is a `LAYOUT_VERSION` bump
/// across three files. Upgrade path if the treasury ever has to rotate without a redeploy:
/// an `admin: [u8; 32]` on `Leaderboard`, stamped by `init_leaderboard`.
pub const TREASURY: Address = Address::new_from_array([0u8; 32]);

/// Six minutes at the 400 ms crank interval — the enrage timeout from the game design.
///
/// Hardcoded rather than passed in: it is a rule of the fight, and the one place it could
/// legitimately vary (a validator ticking slower than 400 ms) is not something the caller
/// knows either. `tick` is the only clock; wall-clock never enters this program.
pub const ENRAGE_AT_TICK: u32 = 900;

/// `arena_id` u64 `[0..8]` ‖ `incarnation` u16 `[8..10]` ‖ `validator_identity`
/// `[10..42]` ‖ `crank_authority` `[42..74]`. Frozen; `packages/client/src/instructions.ts`
/// writes exactly these offsets.
const INIT_ARENA_DATA_LEN: usize = 8 + 2 + 32 + 32;

/// Extra seed prefixes used only as hash domains (see [`derive_hash`]).
const DOMAIN_CRANK: &[u8] = b"crank";
const DOMAIN_AFFIX: &[u8] = b"affix";

/// Derivation seeds plus the bump. No PDA in this program uses more than two seeds.
const MAX_SIGNER_SEEDS: usize = 3;

// ---------------------------------------------------------------------------
// Boss balance
// ---------------------------------------------------------------------------

/// Boss spawn position, in arena units — 16 per tile over the 64×64 map, so 0..1023 on
/// both axes with `y` growing downward, the same units as `PlayerSlot.x` and `Bullet.x`.
///
/// Twenty tiles down the centre line. The sprite reaches 112 units above its origin and
/// 128 below (`shoot.rs`'s hitbox table), so the whole boss is inside the arena, and it is
/// well clear of the bottom-centre entrance players respawn at.
const BOSS_SPAWN_X: i16 = 512;
const BOSS_SPAWN_Y: i16 = 320;

/// Kill condition, only damageable once the vent opens. "Low tier" in the design spec: 50
/// landed shots at `shoot.rs`'s `SHOT_DAMAGE` of 40.
const BOSS_CORE_HP: u16 = 2_000;

/// Base HP per part before incarnation scaling, index-aligned with `Boss.parts` and with
/// `shoot.rs`'s `PART_HITBOXES`. Tiers are the design spec's: crown high, heads and arms
/// medium, thorns low.
///
/// 18,000 shell HP in total, so the vent opens (`sum(parts) < 35%` of max) after 11,700
/// damage — 293 landed shots, about two and a half minutes for a raid of eight at
/// `shoot.rs`'s one-accepted-shot-per-two-ticks cooldown, inside the 900-tick enrage
/// window.
///
/// ponytail: hardcoded because the frozen 74-byte tag-1 argument block has nowhere to
/// carry them, so retuning the fight is a redeploy rather than a Worker change. That is
/// the right trade while `SHOT_DAMAGE` is also a constant — the two numbers are only
/// meaningful against each other and move together or not at all. Upgrade path: widen tag
/// 1 in `instruction.rs`, `instructions.ts` and the ABI table in one commit, and pass them.
const BOSS_PARTS_BASE: [u16; N_PARTS] = [
    4_000, // 0 crown   — high
    2_500, // 1 wolf_l  — medium
    2_500, // 2 beast_r — medium
    1_000, // 3 thorn0  — low
    1_000, // 4 thorn1  — low
    1_000, // 5 thorn2  — low
    1_000, // 6 thorn3  — low
    2_500, // 7 mace    — medium
    2_500, // 8 claws   — medium
];

// A zero-HP part or core is not a weak boss, it is a broken one: the vent test is
// `sum(parts) × 100 < sum(parts_max) × 35`, so an all-zero shell never opens, and a zero
// core is a boss that was born dead. Now that these are constants, the check that used to
// run on every spawn is a compile error instead.
const _: () = {
    assert!(BOSS_CORE_HP != 0);
    let mut index = 0;
    while index < N_PARTS {
        assert!(BOSS_PARTS_BASE[index] != 0);
        index += 1;
    }
};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/// Derive `seeds` against this program, prove `account` is exactly that address, and
/// create it rent-exempt and program-owned, signed by the derivation.
///
/// Deriving here rather than accepting a bump from the caller is deliberate: the bump is
/// needed anyway to sign the CPI, so the derivation *is* the validation and there is
/// nothing left for a lying caller to exploit. It costs ~1,500 CU against a 200,000 CU
/// base-layer budget, once per match.
///
/// Creation goes through `create_account_with_minimum_balance_signed`, which transfers
/// only the rent *shortfall* and then allocates and assigns. Plain `CreateAccount` aborts
/// on an account that already holds lamports, and every address this function creates is
/// one an attacker can derive before we do — `[b"leaderboard"]` is a fixed seed, and the
/// per-match seeds hang off an `arena_id` the Worker reads off chain and cannot re-roll.
/// One lamport would otherwise block a match, or the leaderboard, permanently.
fn create_pda_account<const N: usize>(
    program_id: &Address,
    payer: &AccountView,
    account: &mut AccountView,
    system_program: &AccountView,
    seeds: &[&[u8]; N],
    space: usize,
) -> Result<u8, ProgramError> {
    const {
        // `signer_seeds` below is `seeds` plus one bump, in a fixed-size array.
        assert!(N < MAX_SIGNER_SEEDS);
    }

    // The System program is never read by this handler — the CPI addresses it by id — but
    // the runtime requires it to be present in the transaction, and checking it here turns
    // a mis-wired client into a named error instead of a CPI failure two frames down.
    if !address_eq(system_program.address(), &pinocchio_system::ID) {
        return Err(ProgramError::IncorrectProgramId);
    }
    assert_signer(payer)?;
    assert_writable(payer)?;
    assert_writable(account)?;

    // Prefund-safe creation tolerates lamports, not data. An account that already carries
    // bytes is either one of ours mid-match or someone else's entirely; both have to be
    // refused before the allocate, and refused by name rather than as a System CPI error
    // three frames down.
    if account.data_len() != 0 {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    assert_owned_by(account, &pinocchio_system::ID)?;

    let bump = assert_pda(account, seeds, program_id)?;

    // `Seed` is not `Copy`, so the array is written out rather than repeated; the tail
    // entries are overwritten below and only `..N + 1` is ever handed to the runtime.
    let bump_seed = [bump];
    let mut signer_seeds = [
        Seed::from(&bump_seed[..]),
        Seed::from(&bump_seed[..]),
        Seed::from(&bump_seed[..]),
    ];
    for (slot, seed) in signer_seeds.iter_mut().zip(seeds.iter()) {
        *slot = Seed::from(*seed);
    }
    signer_seeds[N] = Seed::from(&bump_seed[..]);
    let signer = Signer::from(&signer_seeds[..N + 1]);

    create_account_with_minimum_balance_signed(
        account,
        space,
        program_id,
        payer,
        // No rent sysvar account: the frozen account list carries none, so the rent rate
        // comes from the `Rent::get()` syscall instead.
        None,
        &[signer],
    )?;

    Ok(bump)
}

/// A 32-byte hash over its three inputs, domain-separated by `domain`.
///
/// `Address::derive_address` is PDA derivation used as a hash function, and that is not a
/// trick: SHA-256 is not reachable through pinocchio 0.11's public API (`solana-address`
/// keeps its hasher private, and the `sol_sha256` syscall exists only on the BPF target,
/// which would put a `cfg` fork in the middle of a security-relevant derivation).
/// `derive_address` is one hash over the seeds, the program id and the PDA marker, and it
/// is compiled on both targets — unlike `find_program_address`, which needs either the BPF
/// target or `solana-address/curve25519` and so cannot appear in code `cargo test` builds.
///
/// The layout contract writes these derivations as `hashv([...])`; this is that hash with
/// a different, equally deterministic, mixing function. The client reproduces it with a
/// stock `getProgramDerivedAddress` over the same seeds.
fn derive_hash(program_id: &Address, domain: &[u8], key: &[u8; 32], tail: &[u8]) -> [u8; 32] {
    Address::derive_address(&[domain, &key[..], tail], None, program_id).to_bytes()
}

/// Boss part HP scales `× (1 + incarnation × 0.15)`, in integers — no float ever reaches
/// this program, because floats are not deterministic across validators.
///
/// ponytail: saturates at `u16::MAX` (incarnation ≈ 41 for the 4,000 HP crown). Past that,
/// incarnations stop getting harder along this axis. The design's real difficulty knob is
/// bullet density (`3 + alive_count` per volley), so the ceiling is cosmetic; if it ever
/// matters, widen `parts`/`parts_max` to u32 in the layout contract.
fn scale_for_incarnation(base: u16, incarnation: u16) -> u16 {
    // Widest intermediate is 65,535 × (100 + 15 × 65,535) ≈ 6.4e10 — comfortably u64.
    let multiplier = 100u64.saturating_add(15u64.saturating_mul(incarnation as u64));
    let scaled = (base as u64).saturating_mul(multiplier) / 100;
    if scaled > u16::MAX as u64 {
        u16::MAX
    } else {
        scaled as u16
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// Tag 1 — create and seed `Arena`, `Boss` and `Players` for one match.
///
/// Accounts:
///   0. `[WRITE, SIGNER]` payer — must be [`TREASURY`].
///   1. `[WRITE]`         arena — PDA `[b"arena", arena_id]`, must not exist.
///   2. `[WRITE]`         boss — PDA `[b"boss", arena_key]`, must not exist.
///   3. `[WRITE]`         players — PDA `[b"players", arena_key]`, must not exist.
///   4. `[]`              system program.
///
/// Data: `arena_id` u64 ‖ `incarnation` u16 ‖ `validator_identity` `[u8; 32]` ‖
/// `crank_authority` `[u8; 32]`. Exact length: one byte short is an attacker probing for
/// an index panic, one byte long is version skew, and neither is worth accepting quietly.
pub fn init_arena(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let [payer, arena, boss, players, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if data.len() != INIT_ARENA_DATA_LEN {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Before anything is created or paid for. `assert_signer` comes first, because an
    // account that merely *carries* the treasury's address is an attacker naming it.
    assert_signer(payer)?;
    if !address_eq(payer.address(), &TREASURY) {
        return Err(ProgramError::IncorrectAuthority);
    }

    let mut arena_id_bytes = [0u8; 8];
    arena_id_bytes.copy_from_slice(&data[0..8]);
    let arena_id = u64::from_le_bytes(arena_id_bytes);
    let mut incarnation_bytes = [0u8; 2];
    incarnation_bytes.copy_from_slice(&data[8..10]);
    let incarnation = u16::from_le_bytes(incarnation_bytes);
    let mut validator_identity = [0u8; 32];
    validator_identity.copy_from_slice(&data[10..42]);
    let mut crank_authority = [0u8; 32];
    crank_authority.copy_from_slice(&data[42..74]);

    // `arena_id == 0` is reserved. `Leaderboard` starts life with
    // `last_arena_id == 0 && last_incarnation == 0`, and that pair is its "already written"
    // idempotency sentinel — a real match numbered 0 at incarnation 0 would be silently
    // dropped from the leaderboard on settle.
    if arena_id == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }

    // An all-zero `crank_authority` is the same wedge as a squatted arena, self-inflicted:
    // `delegate`, `join` and `settle` all compare a signer against this field, and no
    // keypair signs for the zero address. The match would exist and never be able to start.
    if crank_authority == [0u8; 32] {
        return Err(ProgramError::InvalidInstructionData);
    }

    let arena_bump = create_pda_account(
        program_id,
        payer,
        arena,
        system_program,
        &[SEED_ARENA, &arena_id.to_le_bytes()[..]],
        Arena::LEN,
    )?;

    // Only trustworthy *after* the derivation above proved this account is the canonical
    // `Arena` for `arena_id`. `Boss` and `Players` are seeded from it, so a wrong key here
    // would place a whole match at addresses nothing else in the system can find.
    let arena_key = arena.address().to_bytes();

    let boss_bump = create_pda_account(
        program_id,
        payer,
        boss,
        system_program,
        &[SEED_BOSS, &arena_key[..]],
        Boss::LEN,
    )?;
    let players_bump = create_pda_account(
        program_id,
        payer,
        players,
        system_program,
        &[SEED_PLAYERS, &arena_key[..]],
        Players::LEN,
    )?;

    {
        let mut account_data = arena.try_borrow_mut()?;
        let state = init::<Arena>(&mut account_data, arena_bump)?;

        // A freshly created account is zeroed, so every field absent from this block is
        // deliberately 0: `alive_count`, `bullet_cursor`, `tick`, `seat_occupied`, both
        // `_pad` fields, and all 128 bullet slots (`active == BULLET_FREE`).
        state.phase = PHASE_LOBBY;
        state.arena_id = arena_id;
        state.enrage_at_tick = ENRAGE_AT_TICK;
        state.incarnation = incarnation;
        // The crank signer PDA derives from this key, so it is what `boss_tick` authorizes
        // against. It is taken from the argument block rather than from the payer because
        // the ABI carries it and because the treasury that *pays* for a match and the key
        // that *schedules* its crank do not have to stay the same key; the Worker passes
        // its own address for both today. Only `TREASURY` reached this line, so a caller
        // cannot point a match at an authority nobody agreed to.
        state.crank_authority = crank_authority;
        state.validator_identity = validator_identity;

        // Validator-global namespace: a colliding `task_id` fails *silently*, after the
        // scheduling CPI has already returned Ok, recorded only to a validator-local table
        // we cannot read. Deriving it here rather than accepting it as an argument is what
        // makes "wide and random" structural instead of a promise the caller keeps. Sign
        // bit cleared and floored at 1, because the crank arguments are i64 and 0 is not a
        // usable id.
        let task_hash = derive_hash(
            program_id,
            DOMAIN_CRANK,
            &arena_key,
            &arena_id.to_le_bytes()[..],
        );
        let mut task_head = [0u8; 8];
        task_head.copy_from_slice(&task_hash[..8]);
        state.crank_task_id = (i64::from_le_bytes(task_head) & i64::MAX).max(1);

        // v1 affixes are deterministic. A VRF callback overwrites this field in v1.1 and
        // nothing else about the design changes; there is no token and no economy, so
        // there is nothing to gain by predicting a co-op boss's affixes.
        state.affix_seed = derive_hash(
            program_id,
            DOMAIN_AFFIX,
            &arena_key,
            &incarnation.to_le_bytes()[..],
        );
    }

    {
        let mut account_data = boss.try_borrow_mut()?;
        let state = init::<Boss>(&mut account_data, boss_bump)?;

        state.x = BOSS_SPAWN_X;
        state.y = BOSS_SPAWN_Y;
        state.core_hp = BOSS_CORE_HP;
        state.core_hp_max = BOSS_CORE_HP;

        let mut parts = [0u16; N_PARTS];
        for (slot, base) in parts.iter_mut().zip(BOSS_PARTS_BASE) {
            *slot = scale_for_incarnation(base, incarnation);
        }
        state.parts = parts;
        state.parts_max = parts;

        // No alive player exists yet — every seat is unclaimed and in the lobby.
        // `NO_TARGET` is outside `0..MAX_SEATS` so a bounds check catches it instead of
        // the boss silently opening fire on seat 0.
        state.target_seat = NO_TARGET;
        // `vent_open` and `attack_timer` stay 0: a full shell is sealed, and the first
        // attack beat is the crank's to schedule. `vent_open` is recomputed from `parts`
        // every tick, never set independently.
    }

    // Stamping the header is the whole job for `Players`. An empty seat *is* the zeroed
    // slot: `session_pubkey == [0; 32]` is the unclaimed sentinel, `zone == ZONE_LOBBY`,
    // `hp == 0`. Writing 1,920 bytes of zeroes over a buffer the runtime already zeroed
    // would be pure cost, and any field needing a non-zero default would be a layout bug.
    //
    // All 20 seats exist from here on, which is structural rather than tidy: a crank can
    // never see an account it was not handed at schedule time, so lazy join is impossible,
    // and packing all 20 into one account is what keeps `boss_tick`'s frozen list at four
    // metas against the ER's ~38-key ceiling.
    let mut account_data = players.try_borrow_mut()?;
    init::<Players>(&mut account_data, players_bump)?;

    Ok(())
}

/// Tag 0 — create the singleton `Leaderboard`. Base layer, never delegated, once per
/// deployment.
///
/// Accounts:
///   0. `[WRITE, SIGNER]` payer.
///   1. `[WRITE]`         leaderboard — PDA `[b"leaderboard"]`, must not exist.
///   2. `[]`              system program.
///
/// Data: empty.
pub fn init_leaderboard(
    program_id: &Address,
    accounts: &mut [AccountView],
    data: &[u8],
) -> ProgramResult {
    let [payer, leaderboard, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    // Deliberately permissionless, unlike `init_arena`. There is nothing here to squat:
    // the account is a fixed-seed singleton whose zeroed contents are the only correct
    // starting state, creation is prefund-safe so it cannot be blocked by a stray lamport,
    // and a stranger who calls this has donated 0.044 SOL of rent and changed nothing
    // else. The 6,176 bytes fit one allocation, well under the 10,240-byte per-instruction
    // limit, so there is no realloc path to get wrong.
    let bump = create_pda_account(
        program_id,
        payer,
        leaderboard,
        system_program,
        &[SEED_LEADERBOARD],
        Leaderboard::LEN,
    )?;

    let mut account_data = leaderboard.try_borrow_mut()?;
    // `next == 0`, `total_written == 0`, and a ring of 128 zeroed entries. The idempotency
    // key starts at `(arena_id 0, incarnation 0)`, which is why `init_arena` refuses
    // `arena_id == 0`.
    init::<Leaderboard>(&mut account_data, bump)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Incarnation scaling is the only arithmetic in this file that can be wrong in a way
    /// the type system will not catch, and it is multiplied across nine parts on every
    /// spawn. Everything else here is account plumbing that needs a validator to exercise.
    #[test]
    fn part_hp_scales_with_incarnation() {
        // Incarnation 0 is the base fight, unscaled.
        assert_eq!(scale_for_incarnation(1_000, 0), 1_000);
        // × (1 + 4 × 0.15) = × 1.60
        assert_eq!(scale_for_incarnation(1_000, 4), 1_600);
        // Integer division truncates rather than rounding up — a part is never harder than
        // the formula says.
        assert_eq!(scale_for_incarnation(1, 1), 1);
        assert_eq!(scale_for_incarnation(10, 1), 11);
        // Saturates instead of wrapping; a wrapped part HP would be an exploit, not a bug.
        assert_eq!(scale_for_incarnation(u16::MAX, 1), u16::MAX);
        assert_eq!(scale_for_incarnation(u16::MAX, u16::MAX), u16::MAX);
        // A zero base cannot occur — the `const` block above rejects it at compile time —
        // but scaling must not invent HP either.
        assert_eq!(scale_for_incarnation(0, 9), 0);
    }

    /// The vent is the fight's only path to the core and it opens on a comparison
    /// (`sum(parts) × 100 < sum(parts_max) × 35`) against numbers this file chooses. A
    /// shell that saturates is a boss whose difficulty silently stops tracking the
    /// incarnation; one that overflows `shoot.rs`'s u32 sum is worse.
    #[test]
    fn scaled_shell_stays_in_range() {
        // Incarnation 10 is × 2.5 — beyond anything one 128-entry leaderboard ring reaches.
        for incarnation in [0u16, 1, 10] {
            let mut total = 0u32;
            for base in BOSS_PARTS_BASE {
                let scaled = scale_for_incarnation(base, incarnation);
                assert!(scaled != u16::MAX);
                assert!(scaled >= base);
                total += scaled as u32;
            }
            // `shoot.rs` sums the nine parts into a u32 and multiplies by 100.
            assert!(total < u32::MAX / 100);
        }
    }
}
