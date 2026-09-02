//! CU delta for the charged shot (A5 chain). Tag 7 on the baseline ELF (4-byte block)
//! against the candidate (5-byte block, charged 0 and charged 1), same fixtures, same
//! arena key (`ARENA_SEED=1`: both child PDAs on bump 255, one sha256 each). The two ELFs
//! are built from the same snapshot of the tree and differ only in A5's six files.
//!
//!     ARENA_SEED=1 cargo run --release -q -- <base.so> <cand.so>

use bytemuck::{bytes_of, Zeroable};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use heartrot::hitboxes::PART_HITBOXES;
use heartrot::map::BOSS_SPAWN;
use heartrot::state::{
    Arena, Boss, Players, DISC_ARENA, DISC_BOSS, DISC_PLAYERS, LAYOUT_VERSION, MAX_SEATS, N_PARTS,
    NO_TARGET, PHASE_FIGHTING, ZONE_ARENA,
};

const PROGRAM_ID: &str = "JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5";
const PARTS_BASE: [u16; N_PARTS] = [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500];
/// The slot the shots execute in. Any value >= CHARGE_SLOTS (20) above `last_move_tick`.
const SHOT_SLOT: u64 = 10_000;
const SHOTS: usize = 64;

struct World {
    program: Pubkey,
    arena: Pubkey,
    boss: Pubkey,
    players: Pubkey,
    session: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn owned(program: &Pubkey, data: Vec<u8>) -> Account {
    Account { lamports: 10_000_000, data, owner: *program, executable: false, rent_epoch: 0 }
}

fn build(stand: (i16, i16), last_move_tick: u32) -> World {
    let program = PROGRAM_ID.parse::<Pubkey>().unwrap();
    let seed = std::env::var("ARENA_SEED").ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    let mut probe = [7u8; 32];
    probe[..4].copy_from_slice(&seed.to_le_bytes());
    let arena = Pubkey::new_from_array(probe);
    let (boss_pda, boss_bump) = Pubkey::find_program_address(&[b"boss", arena.as_ref()], &program);
    let (players_pda, players_bump) =
        Pubkey::find_program_address(&[b"players", arena.as_ref()], &program);
    assert_eq!((boss_bump, players_bump), (255, 255), "pick ARENA_SEED so both bumps are 255");

    let mut a = Arena::zeroed();
    a.discriminator = DISC_ARENA;
    a.version = LAYOUT_VERSION;
    a.bump = 255;
    a.phase = PHASE_FIGHTING;
    a.alive_count = 1;
    a.arena_id = 1_788_263_134;
    a.tick = 1;
    a.enrage_at_tick = 3_600;
    a.seat_occupied = 1;
    a.crank_authority = [9u8; 32];
    a.affix_seed = [0x5a; 32];

    let mut b = Boss::zeroed();
    b.discriminator = DISC_BOSS;
    b.version = LAYOUT_VERSION;
    b.bump = boss_bump;
    b.x = BOSS_SPAWN.0;
    b.y = BOSS_SPAWN.1;
    b.core_hp = 2_000;
    b.core_hp_max = 2_000;
    b.parts = PARTS_BASE;
    b.parts_max = PARTS_BASE;
    b.target_seat = NO_TARGET;

    let mut p = Players::zeroed();
    p.discriminator = DISC_PLAYERS;
    p.version = LAYOUT_VERSION;
    p.bump = players_bump;
    let session = Pubkey::new_from_array([0x40u8; 32]);
    let s = &mut p.slots[0];
    s.zone = ZONE_ARENA;
    s.hp = 100;
    s.hp_max = 100;
    s.x = stand.0;
    s.y = stand.1;
    s.last_move_tick = last_move_tick;
    s.session_pubkey = session.to_bytes();
    s.identity = [0x80u8; 32];
    assert!(MAX_SEATS >= 1);

    let accounts = vec![
        (arena, owned(&program, bytes_of(&a).to_vec())),
        (boss_pda, owned(&program, bytes_of(&b).to_vec())),
        (players_pda, owned(&program, bytes_of(&p).to_vec())),
        (session, Account { lamports: 1, data: vec![], owner: Pubkey::default(), executable: false, rent_epoch: 0 }),
    ];
    World { program, arena, boss: boss_pda, players: players_pda, session, accounts }
}

fn stats(mut v: Vec<u64>) -> (u64, u64, u64, u64, usize) {
    v.sort_unstable();
    let n = v.len();
    if n == 0 {
        return (0, 0, 0, 0, 0);
    }
    (v[0], v[n / 2], v[(n * 95 / 100).min(n - 1)], v[n - 1], n)
}

fn mollusk_for(elf: &[u8], program: &Pubkey) -> Mollusk {
    let mut m = Mollusk::default();
    m.add_program_with_loader_and_elf(program, &mollusk_svm::program::loader_keys::LOADER_V3, elf);
    m.warp_to_slot(SHOT_SLOT);
    m
}

/// `SHOTS` shots from `stand` along `aim`, `tail` appended after `[tag, seat, dx, dy]`.
/// Returns (accepted CUs, refused CUs, first refusal, shots that damaged the shell).
fn shoot_case(
    elf: &[u8],
    stand: (i16, i16),
    aim: (i8, i8),
    tail: &[u8],
    last_move_tick: u32,
) -> (Vec<u64>, Vec<u64>, Option<String>, usize) {
    let mut w = build(stand, last_move_tick);
    let m = mollusk_for(elf, &w.program);
    let mut ok = Vec::new();
    let mut refused = Vec::new();
    let mut first_err = None;
    let mut hits = 0usize;
    for _ in 0..SHOTS {
        {
            let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.arena).unwrap();
            let arena: &mut Arena = bytemuck::from_bytes_mut(&mut acc.data[..1200]);
            arena.tick += 16;
        }
        let mut data = vec![7u8, 0u8, aim.0 as u8, aim.1 as u8];
        data.extend_from_slice(tail);
        let ix = Instruction::new_with_bytes(
            w.program,
            &data,
            vec![
                AccountMeta::new(w.arena, false),
                AccountMeta::new(w.boss, false),
                AccountMeta::new(w.players, false),
                AccountMeta::new_readonly(w.session, true),
            ],
        );
        let r = m.process_instruction(&ix, &w.accounts);
        if r.raw_result.is_err() {
            refused.push(r.compute_units_consumed);
            if first_err.is_none() {
                first_err = Some(format!("{:?}", r.raw_result));
            }
            continue;
        }
        ok.push(r.compute_units_consumed);
        for (k, acc) in &r.resulting_accounts {
            if let Some(slot) = w.accounts.iter_mut().find(|(a, _)| a == k) {
                slot.1 = acc.clone();
            }
        }
        let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.boss).unwrap();
        let b: &mut Boss = bytemuck::from_bytes_mut(&mut acc.data[..50]);
        if b.parts.iter().map(|p| *p as u32).sum::<u32>() < PARTS_BASE.iter().map(|p| *p as u32).sum::<u32>() {
            hits += 1;
        }
        b.parts = PARTS_BASE;
    }
    (ok, refused, first_err, hits)
}

fn row(label: &str, v: Vec<u64>) {
    let (min, p50, p95, max, n) = stats(v);
    println!("| {label} | {n} | {min} | {p50} | {p95} | {max} |");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let base = std::fs::read(&args[1]).expect("base elf");
    let cand = std::fs::read(&args[2]).expect("cand elf");
    println!("base {} bytes, cand {} bytes, boss at {:?}, shots execute in slot {SHOT_SLOT}\n", base.len(), cand.len(), BOSS_SPAWN);
    println!("| case | n | min | p50 | p95 | max |");
    println!("|---|---|---|---|---|---|");

    let (bx, by) = BOSS_SPAWN;
    // Aim at the centre of a live part from each stand, scaled so the longer axis fills
    // the i8: a straight-up shot from under the boss crosses the SEALED core first on the
    // painted rig, and a sealed-vent absorb scores nothing (0/64 hits, no shell damage).
    let aim_at = |stand: (i16, i16), part: usize| -> (i8, i8) {
        let r = &PART_HITBOXES[part];
        let (tx, ty) = (bx as i32 + r.x + r.w / 2, by as i32 + r.y + r.h / 2);
        let (dx, dy) = ((tx - stand.0 as i32) as f64, (ty - stand.1 as i32) as f64);
        let k = 127.0 / dx.abs().max(dy.abs());
        ((dx * k).round() as i8, (dy * k).round() as i8)
    };
    const CLAWS: usize = 8;
    let stands = [(bx + 100, by + 30), (bx + 150, by + 120), (bx + 200, by + 250)];
    let cases: [(&str, (i16, i16), (i8, i8)); 4] = [
        ("point blank", stands[0], aim_at(stands[0], CLAWS)),
        ("120u hit", stands[1], aim_at(stands[1], CLAWS)),
        ("200u hit", stands[2], aim_at(stands[2], CLAWS)),
        ("full miss", stands[1], (0, 127)),
    ];
    let mut deltas: Vec<(String, i64, i64)> = Vec::new();
    for (name, stand, aim) in cases {
        // Base: 4-byte block. Candidate: 5-byte block, charged 0 then 1. Every seat here
        // has `last_move_tick = 0`, so the hold (10,000 slots) is satisfied.
        println!("| _{name}: stand {stand:?} aim {aim:?}_ | | | | | |");
        let (b_ok, b_ref, b_err, b_hits) = shoot_case(&base, stand, aim, &[], 0);
        let (c0_ok, c0_ref, c0_err, c0_hits) = shoot_case(&cand, stand, aim, &[0], 0);
        let (c1_ok, c1_ref, c1_err, c1_hits) = shoot_case(&cand, stand, aim, &[1], 0);
        let b_p50 = stats(b_ok.clone()).1 as i64;
        let c0_p50 = stats(c0_ok.clone()).1 as i64;
        let c1_p50 = stats(c1_ok.clone()).1 as i64;
        row(&format!("BASE {name} ({b_hits}/{SHOTS} hit)"), b_ok);
        row(&format!("CAND {name} charged=0 ({c0_hits}/{SHOTS} hit)"), c0_ok);
        row(&format!("CAND {name} charged=1 ({c1_hits}/{SHOTS} hit)"), c1_ok);
        for (tag, r, e) in [("BASE", b_ref, b_err), ("CAND c0", c0_ref, c0_err), ("CAND c1", c1_ref, c1_err)] {
            if !r.is_empty() {
                row(&format!("  {tag} {name} REFUSED {}", e.unwrap_or_default()), r);
            }
        }
        deltas.push((name.to_string(), c0_p50 - b_p50, c1_p50 - b_p50));
    }

    // The refusal path: charged=1 with a step five slots ago. Pays the Clock read and
    // spends nothing on the seat.
    let (ok, refused, err, _) = shoot_case(&cand, stands[1], aim_at(stands[1], CLAWS), &[1], SHOT_SLOT as u32 - 5);
    row(&format!("CAND NotCharged refusal (accepted {}): {}", ok.len(), err.unwrap_or_default()), refused);
    // A 4-byte block against the candidate, and a 5-byte one against base: both length refusals.
    let (_, r, e, _) = shoot_case(&cand, stands[1], aim_at(stands[1], CLAWS), &[], 0);
    row(&format!("CAND old 4-byte block: {}", e.unwrap_or_default()), r);
    let (_, r, e, _) = shoot_case(&base, stands[1], aim_at(stands[1], CLAWS), &[0], 0);
    row(&format!("BASE new 5-byte block: {}", e.unwrap_or_default()), r);

    println!("\n| case | p50 delta charged=0 | p50 delta charged=1 |");
    println!("|---|---|---|");
    for (name, d0, d1) in deltas {
        println!("| {name} | {d0:+} | {d1:+} |");
    }
}
