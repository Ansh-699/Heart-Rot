//! Base-layer account creation: the CPIs that stand a match up before anything is
//! delegated to the ER.
//!
//! Three instructions, all base layer: [`init_arena`] once per match (`Arena` + `Boss` +
//! `Players`, tag 1), [`init_leaderboard`] once per deployment (tag 0), and
//! [`next_incarnation`] (tag 15), which creates nothing at all — it re-seeds the three
//! accounts a settled match already owns for incarnation N+1. None is on the 400 ms path,
//! so they spend compute freely on a full PDA search rather than trusting a
//! caller-supplied bump.
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
use pinocchio_system::instructions::CreateAccount;
use pinocchio::sysvars::{rent::Rent, Sysvar};

use crate::error::HeartrotError;
use crate::guards::{assert_owned_by, assert_pda, assert_signer, assert_writable};
use crate::map;
use crate::state::{
    init, load, load_mut, AccountLayout, Arena, Boss, Leaderboard, Players, BOSS_CORE_HP, N_PARTS,
    PHASE_LOBBY, SEED_ARENA, SEED_BOSS, SEED_LEADERBOARD, SEED_PLAYERS,
};

/// Base58 treasury address, supplied at build time.
///
/// **Deployment step.** Export the public half of the Worker's `TREASURY_SECRET_KEY`
/// before building for deploy:
///
/// ```sh
/// HEARTROT_TREASURY=$(solana address -k treasury.json) cargo build-sbf
/// ```
///
/// It is an environment variable rather than a literal edited into this file because the
/// same value has to reach `worker/wrangler.jsonc`'s `PROGRAM_ID` sibling secret and a
/// value that lives in two hand-edited places drifts. Nothing secret is exposed: this is
/// a public key.
///
/// When the variable is unset the fallback below is the all-zero address, which is the
/// System Program and which no keypair can sign for. That value is deliberately kept
/// buildable on the host so `cargo check` and `cargo test` still run without a deploy
/// key, and is rejected at compile time for the BPF target by the `const` assertion below
/// — an unfilled `cargo build-sbf` fails loudly instead of emitting a `.so` in which
/// [`init_arena`] is uncallable and no arena can ever be opened.
const TREASURY_BASE58: &str = match option_env!("HEARTROT_TREASURY") {
    Some(address) => address,
    None => "11111111111111111111111111111111",
};

/// Decoded form of [`TREASURY_BASE58`]. Kept as raw bytes so the compile-time emptiness
/// check below can look at them; `Address` exposes no const accessor.
const TREASURY_BYTES: [u8; 32] = decode_base58_address(TREASURY_BASE58);

/// The only key allowed to open a match.
///
/// It has to be a build-time constant rather than an account field: unlike the program id
/// (which the runtime hands every handler, and which this crate therefore never
/// hardcodes), the treasury is not knowable from inside a transaction and is chosen before
/// deploy. `settle.rs` gates `write_leaderboard` on the same authority and must `use` this
/// symbol rather than declare its own: two separately-editable copies of one key are a
/// half-applied rotation that compiles clean and fails silently at settle time.
///
/// ponytail: one baked-in key rather than an admin field, because the frozen layout
/// contract has no spare bytes on `Leaderboard`, `init_arena`'s frozen 5-account list has
/// no room to pass one, and adding either is a `LAYOUT_VERSION` bump across three files.
/// Upgrade path if the treasury ever has to rotate without a redeploy: an `admin: [u8; 32]`
/// on `Leaderboard`, stamped by `init_leaderboard`.
pub const TREASURY: Address = Address::new_from_array(TREASURY_BYTES);

/// `signer` is [`TREASURY`], or [`HeartrotError::NotTreasury`].
///
/// Named rather than `ProgramError::IncorrectAuthority`: `error.rs` reserves code 11 for
/// exactly this condition, and the builtin is also what six unrelated authority failures
/// return — a caller that used the wrong deploy key could not tell its config fault from a
/// stolen session key. It does **not** check `is_signer`; callers assert that first, so
/// that an account merely *carrying* the treasury's address fails as a missing signature
/// rather than as a wrong key.
fn assert_treasury(signer: &AccountView) -> Result<(), ProgramError> {
    if address_eq(signer.address(), &TREASURY) {
        Ok(())
    } else {
        Err(HeartrotError::NotTreasury.into())
    }
}

/// Refuses a deploy build that never had `HEARTROT_TREASURY` set.
///
/// Only on the BPF target, which is the only build that produces something deployable. A
/// host build keeps the placeholder so `cargo check`, `cargo clippy` and the unit tests
/// below run on a machine that holds no deploy key.
#[cfg(target_os = "solana")]
const _: () = {
    // `[u8; 32] == [0u8; 32]` is not available: `PartialEq` is not const and `[0; 32]` is
    // not a pattern, so the comparison is spelled out.
    const fn is_zero(bytes: &[u8; 32]) -> bool {
        let mut index = 0;
        while index < 32 {
            if bytes[index] != 0 {
                return false;
            }
            index += 1;
        }
        true
    }
    assert!(
        !is_zero(&TREASURY_BYTES),
        "HEARTROT_TREASURY is unset: rebuild with \
         HEARTROT_TREASURY=$(solana address -k treasury.json) cargo build-sbf"
    );
};

/// Base58 (Bitcoin alphabet) decode of a 32-byte address, at compile time.
///
/// Hand-rolled because `pinocchio-pubkey`'s `pubkey!` macro cannot be added to this
/// workspace: its latest release pins `pinocchio ^0.9` and would drag a second,
/// semver-incompatible pinocchio into the tree (same reason `settle.rs` writes
/// `CRANK_PROGRAM_ID` as raw bytes). A malformed character or a value wider than 32 bytes
/// is a `panic!` in const context, which is a compile error, not a runtime one.
const fn decode_base58_address(text: &str) -> [u8; 32] {
    let input = text.as_bytes();
    let mut out = [0u8; 32];
    let mut index = 0;
    while index < input.len() {
        // The alphabet omits 0, O, I and l precisely because they are misread by humans;
        // accepting them silently would decode a typo into a valid-looking address.
        let digit = match input[index] {
            character @ b'1'..=b'9' => character - b'1',
            character @ b'A'..=b'H' => character - b'A' + 9,
            character @ b'J'..=b'N' => character - b'J' + 17,
            character @ b'P'..=b'Z' => character - b'P' + 22,
            character @ b'a'..=b'k' => character - b'a' + 33,
            character @ b'm'..=b'z' => character - b'm' + 44,
            _ => panic!("HEARTROT_TREASURY is not a base58 address"),
        } as u32;

        // out = out × 58 + digit, big-endian, propagating the carry down from the least
        // significant byte. Leading '1's contribute digit 0 and so become leading zero
        // bytes, which is what base58 means by them.
        let mut carry = digit;
        let mut byte = 32;
        while byte > 0 {
            byte -= 1;
            let wide = out[byte] as u32 * 58 + carry;
            out[byte] = wide as u8;
            carry = wide >> 8;
        }
        if carry != 0 {
            panic!("HEARTROT_TREASURY is longer than 32 bytes");
        }
        index += 1;
    }
    out
}


// The enrage timeout lives in `state.rs` as `ENRAGE_TICKS` and is stamped by
// `Arena::begin_fight()` at the MUSTERING → FIGHTING flip, not here. It moved because it
// stopped being creation state: an arena spends its whole muster window with
// `enrage_at_tick == 0`, and `tick.rs`'s `!= 0` guard is what makes that safe. Writing it
// at `init` again would silently shorten every fight by the length of its own muster.

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

// Where the boss stands is `crate::map::BOSS_SPAWN`, compiled out of the `B` heart tile
// in `assets/map/arena.json` by `tools/gen_map.py` alongside the wall bitboard the ray
// dies on. It is not a constant of this file, and it must never become one again: it was
// a `BOSS_SPAWN_X`/`BOSS_SPAWN_Y` pair here reading (512, 320) — tile (32, 20), the
// two-tile north *corridor* — while the drawn map put the heart at (512, 512) and both
// `shoot.rs` and `player.rs` tested against that. Three copies, two of them wrong. The
// boss stood with its shell inside solid rock, `shoot`'s ray died on the corridor wall
// before most of the parts, and the whole fight had never been run on chain, so nothing
// had noticed. Move the `B`, re-run the tool, and the boss moves with it.
//
// It has since moved again — the `B` is now tile (32, 25), the top-centre anchor the pit
// looks up at — and this file needed no edit for that, which is the whole point. The two
// coordinates above are the history, not the current value; ask `map::BOSS_SPAWN`.

// The core's floor HP is `state::BOSS_CORE_HP`, imported above. It moved out of this file
// because `tick.rs` now tops `core_hp_max` up by `CORE_HP_PER_RAIDER` per extra raider, so
// the two numbers are only meaningful against each other and a copy here would be the
// balance table stored twice. This file still owns the *shell*; `state.rs` owns the core.

/// Base HP per part before incarnation scaling, index-aligned with `Boss.parts` and with
/// `hitboxes::PART_HITBOXES`. Tiers are the design spec's: crown high, heads and arms
/// medium, thorns low.
///
/// **Ordered by name, not by position.** The indices are the ones
/// `tools/svg_slice.py` emits — small-and-specific first, so `shoot.rs::raycast`'s
/// first-live-match walk claims a thorn before the larger box it sits inside. Reordering
/// the hitboxes without reordering this array would silently hand every thorn 2,500 HP and
/// the mace 1,000: index-aligned means aligned to the *names*, and nothing in the type
/// system can catch a permutation of nine `u16`s.
///
/// 18,000 shell HP in total, so the vent opens (`sum(parts) < 35%` of max) after 11,700
/// damage — 293 landed shots at `shoot.rs`'s `SHOT_DAMAGE`, inside the enrage window.
///
/// ponytail: hardcoded because the frozen 74-byte tag-1 argument block has nowhere to
/// carry them, so retuning the fight is a redeploy rather than a Worker change. That is
/// the right trade while `SHOT_DAMAGE` is also a constant — the two numbers are only
/// meaningful against each other and move together or not at all. Upgrade path: widen tag
/// 1 in `instruction.rs`, `instructions.ts` and the ABI table in one commit, and pass them.
const BOSS_PARTS_BASE: [u16; N_PARTS] = [
    THORN_HP, // 0 thorn0  — low, emitter
    THORN_HP, // 1 thorn1  — low, emitter
    THORN_HP, // 2 thorn2  — low, emitter
    THORN_HP, // 3 thorn3  — low, emitter
    4_000,    // 4 crown   — high
    2_500,    // 5 wolf_l  — medium
    2_500,    // 6 beast_r — medium
    2_500,    // 7 mace    — medium
    2_500,    // 8 claws   — medium
];

/// The emitter tier. Named rather than written out four times so
/// `part_hp_is_index_aligned_with_the_hitboxes` can state "every muzzle stands in a thorn"
/// as a comparison against `hitboxes::MUZZLES` instead of as a comment.
const THORN_HP: u16 = 1_000;

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

/// Solana's DEFAULT rent rate: `lamports_per_byte_year` 3480, `exemption_threshold` 2.0,
/// over `space` plus the 128-byte account overhead.
const DEFAULT_RENT_PER_BYTE_YEAR: u64 = 3480;
const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

/// Lamports that make an account rent-exempt on *this* cluster **and** clonable by the
/// ephemeral rollup.
///
/// These are not the same number, and assuming they were cost a devnet run. Devnet's rent
/// schedule is about 9% cheaper than Solana's default, `Rent::get()` returns the cluster's
/// rate, and the ER's cloner computes rent with the DEFAULT rate. Funding the cluster
/// minimum therefore creates an account the ER refuses to clone — measured on devnet:
///
/// | account | space | devnet minimum | ER expects | shortfall |
/// |---------|-------|----------------|------------|-----------|
/// | Arena   | 1200  |      8,410,224 |  9,242,880 |   832,656 |
/// | Boss    |   50  |      1,127,274 |  1,238,880 |   111,606 |
/// | Players | 1924  |     12,995,316 | 14,281,920 | 1,286,604 |
///
/// The failure is silent and misdirected: delegation succeeds, `getDelegationStatus`
/// reports `isDelegated: true`, and the ER's `getAccountInfo` returns `null`. The account
/// is simply never pulled in, and the ER says so only when a transaction touches it —
/// as `Cloner error: ... InsufficientFundsForRent`, which reads like an ER bug rather than
/// a funding one. Every account this program created on devnet was unclonable by
/// construction, so no match could ever have started.
///
/// Taking the max of both rates is exempt under whichever is stricter, so this is correct
/// on any cluster including localnet and mainnet, where the two rates coincide.
fn er_clonable_rent(space: usize) -> Result<u64, ProgramError> {
    let cluster = Rent::get()?.try_minimum_balance(space)?;
    let er_default = (ACCOUNT_STORAGE_OVERHEAD + space as u64)
        .checked_mul(DEFAULT_RENT_PER_BYTE_YEAR)
        .and_then(|v| v.checked_mul(2))
        .ok_or(ProgramError::ArithmeticOverflow)?;
    Ok(cluster.max(er_default))
}

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

    CreateAccount {
        from: payer,
        to: account,
        lamports: er_clonable_rent(space)?,
        space: space as u64,
        owner: program_id,
    }
    .invoke_signed(&[signer])?;

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

/// The whole shell, scaled for one incarnation.
///
/// The single site that turns [`BOSS_PARTS_BASE`] into the numbers an account holds.
/// `init_arena` (incarnation N as created) and [`next_incarnation`] (incarnation N+1)
/// both go through it, so a boss cannot be one difficulty curve when a match is opened
/// and another when it respawns — the defect this codebase keeps re-deriving from one
/// fact stored twice.
fn scaled_parts(incarnation: u16) -> [u16; N_PARTS] {
    let mut parts = [0u16; N_PARTS];
    for (slot, base) in parts.iter_mut().zip(BOSS_PARTS_BASE) {
        *slot = scale_for_incarnation(base, incarnation);
    }
    parts
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
/// `crank_authority` must be [`TREASURY`] — [`HeartrotError::NotTreasury`] otherwise — and
/// `arena_id` must be non-zero.
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
    assert_treasury(payer)?;

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

    // `crank_authority` must be the treasury, and rejecting anything else here is the only
    // place the program can say so. `write_leaderboard` requires its payer to be *both*
    // [`TREASURY`] (settle.rs) and `Arena.crank_authority`, while `delegate`, `join` and
    // `settle` require only the latter — so an arena opened with any other authority
    // delegates, musters, fights and settles perfectly normally and then fails
    // `write_leaderboard` with `NotTreasury` forever. Nothing is left to retry: tag 15
    // gates on the leaderboard naming this match, so the arena can never advance an
    // incarnation and a fresh `arena_id` is the only recovery. A one-shot arena is not a
    // state worth being able to reach, and this is one comparison.
    //
    // It subsumes the all-zero check this replaces: the zero address is the System
    // Program, no keypair signs for it, and it is not the treasury either.
    if !address_eq(&Address::new_from_array(crank_authority), &TREASURY) {
        return Err(HeartrotError::NotTreasury.into());
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
        // deliberately 0: `alive_count`, `bullet_cursor`, `tick`, `seat_occupied`, the
        // remaining `_pad` fields, and all 128 bullet slots (`active == BULLET_FREE`).
        //
        // `enrage_at_tick` and `fight_at_tick` are both in that set, and both deliberately.
        // A match is created into `PHASE_LOBBY`, where neither clock has started: the
        // muster deadline is stamped by `begin_muster` and the enrage deadline by
        // `Arena::begin_fight()` at the flip into FIGHTING. Zero means "not scheduled" for
        // both, which is what `tick.rs` already tests for.
        state.phase = PHASE_LOBBY;
        state.arena_id = arena_id;
        state.incarnation = incarnation;
        // The crank signer PDA derives from this key, so it is what `boss_tick` authorizes
        // against. It is still copied out of the argument block rather than from `payer`
        // even though the check above proves the two are equal, because the 74-byte tag-1
        // ABI is frozen and carries the field: reading it from the payer instead would
        // leave a wire argument the program silently ignores, which is worse than a
        // redundant copy. The check is the guarantee; this is the transcription.
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

        // The same call `next_incarnation` makes, deliberately: spawning a boss and
        // respawning one are the same operation, and writing the fields out here as well
        // would be the balance table stored twice. On a freshly allocated account the
        // fields it zeroes (`vent_open`, `attack_timer`) are already zero, and the ones it
        // writes are the only non-zero defaults `Boss` has.
        state.reset_for_incarnation(
            scaled_parts(incarnation),
            BOSS_CORE_HP,
            map::BOSS_SPAWN.0,
            map::BOSS_SPAWN.1,
        );
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

/// Tag 15 — advance a settled match to incarnation N+1, in place. Base layer.
///
/// The respawn loop, and the only thing that makes this a game rather than one fight.
/// It creates nothing: incarnation N+1 reuses the same `Arena`, `Boss` and `Players`.
/// Fresh accounts would cost 0.0245 SOL of rent per incarnation, orphan the old ones, and
/// break the one property the rest of the system is built on — the `Arena` PDA is
/// `[b"arena", arena_id]`, so one raid chain has exactly one address, and `Leaderboard`'s
/// idempotency key is already `(arena_id, incarnation)`.
///
/// Accounts:
///   0. `[SIGNER]` authority — must be [`TREASURY`].
///   1. `[WRITE]`  arena — PDA `[b"arena", arena_id]`, `PHASE_SETTLED`, non-zero
///      `next_affix_seed`.
///   2. `[WRITE]`  boss — PDA `[b"boss", arena_key]`.
///   3. `[WRITE]`  players — PDA `[b"players", arena_key]`.
///   4. `[]`       leaderboard — PDA `[b"leaderboard"]`, read-only.
///
/// Data: none. Tag 15 is in `lib.rs`'s `ZERO_ARG_TAGS`, which rejects a trailing payload
/// before dispatch, so this handler takes no `data` parameter to length-check — the same
/// arrangement as tags 2, 3, 9, 11 and 12.
///
/// No system program: nothing is allocated, so there is no CPI. That is also why the
/// account list is five rather than six.
///
/// **Ordering against the leaderboard is structural, not a convention.**
/// `write_leaderboard` is gated on `phase == PHASE_SETTLED`, and this instruction both
/// leaves that phase and zeroes every `damage_dealt` — so a tag 15 that beat the tag 10
/// write would destroy the whole match record with nothing left to reconstruct it from.
/// The `Leaderboard` is therefore passed read-only and its idempotency key must already
/// name *this* `(arena_id, incarnation)`. It is the same account tag 10 stamps, so the
/// check is a direct read of "has this match been recorded yet".
///
/// **Delegation needs no check of its own.** While the accounts are delegated the
/// delegation program owns them, so `assert_owned_by` rejects this outright — an arena
/// still on the ER cannot be rolled forward from the base layer.
///
/// Refusals: [`HeartrotError::NotTreasury`] for the wrong key,
/// [`HeartrotError::MatchNotRecorded`] for a leaderboard that has not recorded this match,
/// and [`HeartrotError::WrongPhase`] for the arena's own state conditions — a phase that is
/// not `PHASE_SETTLED`, or an all-zero `next_affix_seed` (the oracle never answered).
///
/// The leaderboard gets its own code because it is the only one of the three the caller
/// can *act* on: the arena's phase is exactly right and it is a different account that is
/// stale, so the fix is "send tag 10, then tag 15 again" rather than "wait". On the ER the
/// error code is the entire diagnostic a failed transaction returns, and folding a
/// retryable condition into `WrongPhase` — which every unrecoverable state condition in
/// this program also returns — is what makes an operator wait on something that will never
/// change on its own.
pub fn next_incarnation(program_id: &Address, accounts: &mut [AccountView]) -> ProgramResult {
    let [authority, arena, boss, players, leaderboard, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_treasury(authority)?;

    assert_writable(arena)?;
    assert_writable(boss)?;
    assert_writable(players)?;
    assert_owned_by(arena, program_id)?;
    assert_owned_by(boss, program_id)?;
    assert_owned_by(players, program_id)?;
    assert_owned_by(leaderboard, program_id)?;

    // `arena_id` is read out of the account before anything proves the account is the
    // canonical `Arena` for it, so it stays untrusted until the `assert_pda` below agrees.
    // The borrow is scoped rather than held because `assert_pda` reads `arena.address()`,
    // and pinocchio's `RefMut` locks the whole `AccountView` for its lifetime.
    let (arena_id, incarnation_now) = {
        let arena_data = arena.try_borrow()?;
        let state = load::<Arena>(&arena_data)?;
        (state.arena_id, state.incarnation)
    };
    assert_pda(arena, &[SEED_ARENA, &arena_id.to_le_bytes()[..]], program_id)?;

    // Only trustworthy now. `Boss` and `Players` hang off this key, which is what ties
    // all three to the same match — ownership alone would accept another raid's boss.
    let arena_key = arena.address().to_bytes();
    assert_pda(boss, &[SEED_BOSS, &arena_key[..]], program_id)?;
    assert_pda(players, &[SEED_PLAYERS, &arena_key[..]], program_id)?;
    assert_pda(leaderboard, &[SEED_LEADERBOARD], program_id)?;

    {
        let lb_data = leaderboard.try_borrow()?;
        let board = load::<Leaderboard>(&lb_data)?;
        if board.last_arena_id != arena_id || board.last_incarnation != incarnation_now {
            return Err(HeartrotError::MatchNotRecorded.into());
        }
    }

    // Everything above this line is a read. `begin_next_incarnation` is the mutex as well
    // as the mutation: it runs only from `PHASE_SETTLED` and leaves `PHASE_LOBBY`, and
    // `LOBBY → LOBBY` is not a legal edge, so a second concurrent tag 15 is rejected here
    // rather than advancing the counter twice. Solana serialises writes to one account, so
    // that is a real lock and not a hopeful one.
    let mut arena_data = arena.try_borrow_mut()?;
    let incarnation = load_mut::<Arena>(&mut arena_data)?.begin_next_incarnation()?;

    let mut boss_data = boss.try_borrow_mut()?;
    load_mut::<Boss>(&mut boss_data)?.reset_for_incarnation(
        scaled_parts(incarnation),
        BOSS_CORE_HP,
        map::BOSS_SPAWN.0,
        map::BOSS_SPAWN.1,
    );

    // Seats do not carry over: a seat is a session key plus a live position and both are
    // stale by respawn time. `/session/init` is idempotent per `identity`, so a returning
    // player is re-seated for free by the path that seats everyone else — while carrying
    // seats forward would leave `Arena.seat_occupied` and `session_pubkey` disagreeing the
    // moment one player did not come back, with no instruction able to notice.
    let mut players_data = players.try_borrow_mut()?;
    load_mut::<Players>(&mut players_data)?.reset_for_incarnation();

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

    /// The permutation guard for [`BOSS_PARTS_BASE`].
    ///
    /// `hitboxes::PART_HITBOXES` is generated and this array is hand-written, so
    /// "index-aligned" is a claim the `[Rect; N_PARTS]` declaration only half-checks: it
    /// catches a length change and nothing at all catches a *reorder*. Renumbering the
    /// boxes without mirroring it here hands every thorn 2,500 HP and the mace 1,000, and
    /// the whole fight is rebalanced with no error anywhere.
    ///
    /// `MUZZLES` is the one place the generator states which indices are thorns, so
    /// comparing against it makes the two orders check each other. A test rather than a
    /// `const` assertion deliberately: the two files are reordered by separate generator
    /// runs, and a half-applied reorder should be a red test, not a tree that will not
    /// compile.
    #[test]
    fn part_hp_is_index_aligned_with_the_hitboxes() {
        for muzzle in crate::hitboxes::MUZZLES {
            assert_eq!(
                BOSS_PARTS_BASE[muzzle.part], THORN_HP,
                "muzzle on part {} — BOSS_PARTS_BASE is no longer aligned with PART_HITBOXES",
                muzzle.part,
            );
        }
    }

    /// The base58 decoder is what turns a deploy-time environment variable into the one
    /// key allowed to open a match, so a wrong digit table is an admin gate pointed at an
    /// address nobody holds. The crank id is the vector to check it against: the expected
    /// bytes below are `settle.rs`'s hand-written `CRANK_PROGRAM_ID` literal, so agreement
    /// checks this decoder and that literal against each other.
    #[test]
    fn base58_decodes_known_addresses() {
        assert_eq!(
            decode_base58_address("Crank11111111111111111111111111111111111111"),
            [
                3, 9, 115, 187, 171, 86, 176, 95, 66, 206, 3, 79, 119, 118, 67, 48, 79, 137, 61,
                97, 116, 104, 235, 217, 161, 243, 44, 64, 0, 0, 0, 0
            ],
        );
        // The all-'1' address is the System Program, and it is also the unset-treasury
        // placeholder the BPF-target assertion refuses.
        assert_eq!(decode_base58_address("11111111111111111111111111111111"), [0u8; 32]);
        // A 32-byte value with a high leading byte — the case that overflows if the carry
        // is dropped, and the one a naive base-256 shift gets wrong.
        assert_eq!(
            decode_base58_address("JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5"),
            [
                255, 147, 154, 38, 126, 86, 144, 148, 141, 236, 85, 27, 45, 185, 36, 140, 170, 77,
                128, 218, 98, 36, 25, 126, 142, 180, 99, 172, 145, 121, 206, 14
            ],
        );
    }

    /// A respawned boss must be indistinguishable from a freshly spawned one at the same
    /// incarnation, or the second raid of a chain fights a different fight from the first.
    /// Both paths now call `Boss::reset_for_incarnation` with [`scaled_parts`], so what
    /// this pins is that the reset actually *clears* a fought-through boss rather than
    /// only topping its HP up — a vent left open or a stale `target_seat` would hand
    /// incarnation N+1 a boss that is already broken open and already aiming.
    #[test]
    fn respawned_boss_matches_a_fresh_spawn() {
        use bytemuck::Zeroable;

        let spawn = |incarnation| {
            let mut boss = Boss::zeroed();
            boss.reset_for_incarnation(
                scaled_parts(incarnation),
                BOSS_CORE_HP,
                map::BOSS_SPAWN.0,
                map::BOSS_SPAWN.1,
            );
            boss
        };

        // A boss at the end of a won fight: shell stripped, vent open, core dead, mid-beat
        // and locked onto a seat that no longer exists after `Players` is zeroed.
        let mut fought = spawn(2);
        fought.parts = [0u16; N_PARTS];
        fought.core_hp = 0;
        fought.vent_open = 1;
        fought.attack_timer = 7;
        fought.target_seat = 3;

        fought.reset_for_incarnation(
            scaled_parts(3),
            BOSS_CORE_HP,
            map::BOSS_SPAWN.0,
            map::BOSS_SPAWN.1,
        );
        assert_eq!(bytemuck::bytes_of(&fought), bytemuck::bytes_of(&spawn(3)));

        // And the fight it re-arms is a real one: a sealed, full shell whose max is its
        // current HP, so the vent threshold means 100 % on every incarnation.
        assert_eq!(fought.vent_open, 0);
        assert_eq!(fought.parts, fought.parts_max);
        assert_eq!(fought.core_hp, BOSS_CORE_HP);
        assert!(fought.parts.iter().all(|&hp| hp != 0));
        // Incarnation 3 is × 1.45, so it is strictly harder than the base fight.
        assert!(fought.parts[0] > BOSS_PARTS_BASE[0]);
        assert_eq!(spawn(0).parts, BOSS_PARTS_BASE);
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
