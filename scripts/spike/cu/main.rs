//! HEARTROT chain-cost harness. Throwaway. Measures CU for tag 6 (move), tag 7 (shoot)
//! and tag 8 (boss_tick) against two ELFs: the redesigned working tree and the program
//! currently deployed on devnet (pre-redesign), in one Agave SVM.

use bytemuck::{bytes_of, Zeroable};
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

use heartrot::state::{
    Arena, Boss, PlayerSlot, Players, DISC_ARENA, DISC_BOSS, DISC_PLAYERS, LAYOUT_VERSION,
    MAX_SEATS, N_PARTS, NO_TARGET, PHASE_FIGHTING, ZONE_ARENA,
};

const PROGRAM_ID: &str = "JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5";
const CRANK_PROGRAM_ID: [u8; 32] = [
    3, 9, 115, 187, 171, 86, 176, 95, 66, 206, 3, 79, 119, 118, 67, 48, 79, 137, 61, 97, 116, 104,
    235, 217, 161, 243, 44, 64, 0, 0, 0, 0,
];
const PARTS_BASE: [u16; N_PARTS] = [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500];

struct World {
    program: Pubkey,
    arena: Pubkey,
    boss: Pubkey,
    players: Pubkey,
    crank_signer: Pubkey,
    sessions: Vec<Pubkey>,
    accounts: Vec<(Pubkey, Account)>, // [arena, boss, players, crank_signer, sessions..]
}

fn owned(program: &Pubkey, data: Vec<u8>) -> Account {
    Account {
        lamports: 10_000_000,
        data,
        owner: *program,
        executable: false,
        rent_epoch: 0,
    }
}

/// `n` seats claimed, in the arena, alive, spread across a row of pit floor.
fn build(n: usize, boss_xy: (i16, i16), pit_y: i16) -> World {
    let program = PROGRAM_ID.parse::<Pubkey>().unwrap();
    // The arena key is searched, not picked: `assert_pda` re-derives with
    // `find_program_address`, so a non-canonical-255 bump costs ~1,500 CU per skipped
    // candidate and would show up as a property of the arena rather than of the code.
    // ARENA_SEED is chosen so both child PDAs land on bump 255 — one sha256 each.
    let seed = std::env::var("ARENA_SEED").ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(0);
    let mut probe = [7u8; 32];
    probe[..4].copy_from_slice(&seed.to_le_bytes());
    let arena = Pubkey::new_from_array(probe);
    let (boss_pda, boss_bump) = Pubkey::find_program_address(&[b"boss", arena.as_ref()], &program);
    let (players_pda, players_bump) =
        Pubkey::find_program_address(&[b"players", arena.as_ref()], &program);

    let crank_authority = Pubkey::new_from_array([9u8; 32]);
    let (crank_signer, _) = Pubkey::find_program_address(
        &[b"crank-executor", crank_authority.as_ref()],
        &Pubkey::new_from_array(CRANK_PROGRAM_ID),
    );

    let mut a = Arena::zeroed();
    a.discriminator = DISC_ARENA;
    a.version = LAYOUT_VERSION;
    a.bump = 255;
    a.phase = PHASE_FIGHTING;
    a.alive_count = n as u8;
    a.arena_id = 1_788_263_134;
    a.tick = 1;
    a.enrage_at_tick = 3_600;
    a.seat_occupied = if n == 32 { u32::MAX } else { (1u32 << n) - 1 };
    a.crank_authority = crank_authority.to_bytes();
    a.affix_seed = [0x5a; 32];

    let mut b = Boss::zeroed();
    b.discriminator = DISC_BOSS;
    b.version = LAYOUT_VERSION;
    b.bump = boss_bump;
    b.x = boss_xy.0;
    b.y = boss_xy.1;
    b.core_hp = 2_000;
    b.core_hp_max = 2_000;
    b.parts = PARTS_BASE;
    b.parts_max = PARTS_BASE;
    b.target_seat = NO_TARGET;

    let mut p = Players::zeroed();
    p.discriminator = DISC_PLAYERS;
    p.version = LAYOUT_VERSION;
    p.bump = players_bump;

    let mut sessions = Vec::new();
    for i in 0..MAX_SEATS {
        let key = Pubkey::new_from_array([(0x40 + i) as u8; 32]);
        sessions.push(key);
        if i >= n {
            continue;
        }
        let s = &mut p.slots[i];
        s.zone = ZONE_ARENA;
        s.facing = 0;
        s.hp = 100;
        s.hp_max = 100;
        // A row of the pit floor, 32 units apart: inside PIT_TOP..PIT_BOT on the new map
        // and open floor near the map centre on the old one.
        s.x = 240 + (i as i16) * 28;
        s.y = pit_y + ((i % 3) as i16) * 16;
        s.session_pubkey = key.to_bytes();
        s.identity = [(0x80 + i) as u8; 32];
    }

    let mut accounts = vec![
        (arena, owned(&program, bytes_of(&a).to_vec())),
        (boss_pda, owned(&program, bytes_of(&b).to_vec())),
        (players_pda, owned(&program, bytes_of(&p).to_vec())),
        (
            crank_signer,
            Account {
                lamports: 1,
                data: vec![],
                owner: solana_pubkey::Pubkey::default(),
                executable: false,
                rent_epoch: 0,
            },
        ),
    ];
    for key in &sessions {
        accounts.push((
            *key,
            Account {
                lamports: 1,
                data: vec![],
                owner: solana_pubkey::Pubkey::default(),
                executable: false,
                rent_epoch: 0,
            },
        ));
    }

    World {
        program,
        arena,
        boss: boss_pda,
        players: players_pda,
        crank_signer,
        sessions,
        accounts,
    }
}

fn pick<'a>(w: &'a World, keys: &[Pubkey]) -> Vec<(Pubkey, Account)> {
    keys.iter()
        .map(|k| {
            w.accounts
                .iter()
                .find(|(a, _)| a == k)
                .cloned()
                .expect("account")
        })
        .collect()
}

fn merge(w: &mut World, updated: &[(Pubkey, Account)]) {
    for (k, acc) in updated {
        if let Some(slot) = w.accounts.iter_mut().find(|(a, _)| a == k) {
            slot.1 = acc.clone();
        }
    }
}

fn stats(mut v: Vec<u64>) -> (u64, u64, u64, u64, usize) {
    v.sort_unstable();
    let n = v.len();
    if n == 0 {
        return (0, 0, 0, 0, 0);
    }
    (
        v[0],
        v[n / 2],
        v[(n * 95 / 100).min(n - 1)],
        v[n - 1],
        n,
    )
}

fn row(label: &str, v: Vec<u64>) {
    let (min, p50, p95, max, n) = stats(v);
    println!(
        "| {label} | {n} | {min} | {p50} | {p95} | {max} | {:.1}% |",
        max as f64 * 100.0 / 399_700.0
    );
}

fn mollusk_for(elf: &[u8], program: &Pubkey) -> Mollusk {
    let mut m = Mollusk::default();
    m.add_program_with_loader_and_elf(
        program,
        &mollusk_svm::program::loader_keys::LOADER_V3,
        elf,
    );
    m
}

fn run(tag: &str, elf_path: &str, boss_xy: (i16, i16), pit_y: i16, shoot_len: usize) {
    let elf = std::fs::read(elf_path).expect("elf");
    println!("\n### {tag}  ({elf_path}, {} bytes)\n", elf.len());
    println!("| case | n | min | p50 | p95 | max | max % of 399,700 |");
    println!("|---|---|---|---|---|---|---|");

    for &seats in &[1usize, 20usize] {
        // ---- move (tag 6) -------------------------------------------------
        let mut w = build(seats, boss_xy, pit_y);
        let mut m = mollusk_for(&elf, &w.program);
        let mut mv = Vec::new();
        let mut mv_rejected = Vec::new();
        let mut slot_no = 10u64;
        for i in 0..200usize {
            let seat = (i % seats) as u8;
            m.warp_to_slot(slot_no);
            slot_no += 1;
            let dirs: [(i8, i8); 4] = [(0, -1), (1, 0), (0, 1), (-1, 0)];
            let (dx, dy) = dirs[i % 4];
            let ix = Instruction::new_with_bytes(
                w.program,
                &[6, seat, (i as u16) as u8, ((i as u16) >> 8) as u8, dx as u8, dy as u8],
                vec![
                    AccountMeta::new_readonly(w.arena, false),
                    AccountMeta::new(w.players, false),
                    AccountMeta::new_readonly(w.sessions[seat as usize], true),
                ],
            );
            let accs = pick(&w, &[w.arena, w.players, w.sessions[seat as usize]]);
            let r = m.process_instruction(&ix, &accs);
            if r.raw_result.is_ok() {
                mv.push(r.compute_units_consumed);
                merge(&mut w, &r.resulting_accounts);
            } else {
                mv_rejected.push(r.compute_units_consumed);
            }
        }
        row(&format!("move accepted, {seats} seats"), mv);
        if !mv_rejected.is_empty() {
            row(&format!("move REJECTED, {seats} seats"), mv_rejected);
        }

        // ---- shoot (tag 7) ------------------------------------------------
        // Two controlled geometries, so the two programs are compared on the same
        // physical shot rather than on whatever their own map happened to allow:
        //   NEAR HIT  — stand 120 units below the boss centre, aim straight up.
        //   FULL MISS — aim straight down, away from the shell: the ray walks its
        //               whole MAX_RAY_STEPS budget. This is the worst case.
        for (name, stand, aim) in [
            ("shoot point blank", (boss_xy.0, boss_xy.1 + 40), (0i8, -127i8)),
            ("shoot 120u hit", (boss_xy.0, boss_xy.1 + 120), (0i8, -127i8)),
            ("shoot 200u hit", (boss_xy.0, boss_xy.1 + 200), (0i8, -127i8)),
            ("shoot full miss", (boss_xy.0, boss_xy.1 + 120), (0i8, 127i8)),
        ] {
            let mut w = build(seats, boss_xy, pit_y);
            let m = mollusk_for(&elf, &w.program);
            {
                let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.players).unwrap();
                let pl: &mut Players = bytemuck::from_bytes_mut(&mut acc.data[..1924]);
                pl.slots[0].x = stand.0;
                pl.slots[0].y = stand.1;
            }
            let mut cu = Vec::new();
            let mut hits = 0usize;
            let mut first_err = None;
            for _ in 0..64usize {
                {
                    let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.arena).unwrap();
                    let arena: &mut Arena = bytemuck::from_bytes_mut(&mut acc.data[..1200]);
                    arena.tick += 16;
                }
                let mut data = vec![7u8, 0u8];
                if shoot_len == 3 {
                    data.push(if aim.1 < 0 { 0 } else { 4 });
                } else {
                    data.push(aim.0 as u8);
                    data.push(aim.1 as u8);
                }
                let ix = Instruction::new_with_bytes(
                    w.program,
                    &data,
                    vec![
                        AccountMeta::new(w.arena, false),
                        AccountMeta::new(w.boss, false),
                        AccountMeta::new(w.players, false),
                        AccountMeta::new_readonly(w.sessions[0], true),
                    ],
                );
                let accs = pick(&w, &[w.arena, w.boss, w.players, w.sessions[0]]);
                let r = m.process_instruction(&ix, &accs);
                if r.raw_result.is_err() {
                    if first_err.is_none() {
                        first_err = Some(format!("{:?}", r.raw_result));
                    }
                    continue;
                }
                cu.push(r.compute_units_consumed);
                let before = {
                    let (_, acc) = w.accounts.iter().find(|(a, _)| *a == w.boss).unwrap();
                    let b: &Boss = bytemuck::from_bytes(&acc.data[..50]);
                    b.parts.iter().map(|p| *p as u32).sum::<u32>()
                };
                merge(&mut w, &r.resulting_accounts);
                let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.boss).unwrap();
                let b: &mut Boss = bytemuck::from_bytes_mut(&mut acc.data[..50]);
                if b.parts.iter().map(|p| *p as u32).sum::<u32>() < before {
                    hits += 1;
                }
                b.parts = PARTS_BASE;
            }
            row(&format!("{name}, {seats} seats"), cu);
            println!(
                "| _{name}: {hits} of 64 damaged the shell{}_ | | | | | | |",
                first_err.map(|e| format!(", err {e}")).unwrap_or_default()
            );
        }

        // ---- probe: does shoot accept Arena as READ-ONLY? -------------------
        if seats == 1 {
            let mut w = build(seats, boss_xy, pit_y);
            let m = mollusk_for(&elf, &w.program);
            {
                let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.players).unwrap();
                let pl: &mut Players = bytemuck::from_bytes_mut(&mut acc.data[..1924]);
                pl.slots[0].x = boss_xy.0;
                pl.slots[0].y = boss_xy.1 + 120;
            }
            {
                let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == w.arena).unwrap();
                let arena: &mut Arena = bytemuck::from_bytes_mut(&mut acc.data[..1200]);
                arena.tick += 16;
            }
            let mut data = vec![7u8, 0u8];
            if shoot_len == 3 { data.push(0u8); } else { data.push(0u8); data.push(0x81u8); }
            let ix = Instruction::new_with_bytes(
                w.program,
                &data,
                vec![
                    AccountMeta::new_readonly(w.arena, false),
                    AccountMeta::new(w.boss, false),
                    AccountMeta::new(w.players, false),
                    AccountMeta::new_readonly(w.sessions[0], true),
                ],
            );
            let accs = pick(&w, &[w.arena, w.boss, w.players, w.sessions[0]]);
            let r = m.process_instruction(&ix, &accs);
            println!("| _PROBE shoot with Arena READ-ONLY: {:?}, {} CU_ | | | | | | |",
                r.raw_result, r.compute_units_consumed);
        }

        // ---- shoot, rejected by the rate limiter: the guard path only -------
        {
            let w = build(seats, boss_xy, pit_y);
            let m = mollusk_for(&elf, &w.program);
            let mut data = vec![7u8, 0u8, 0u8];
            if shoot_len == 4 { data.push(0xFFu8); }  // dy = -1
            let ix = Instruction::new_with_bytes(
                w.program,
                &data,
                vec![
                    AccountMeta::new(w.arena, false),
                    AccountMeta::new(w.boss, false),
                    AccountMeta::new(w.players, false),
                    AccountMeta::new_readonly(w.sessions[0], true),
                ],
            );
            let accs = pick(&w, &[w.arena, w.boss, w.players, w.sessions[0]]);
            let r = m.process_instruction(&ix, &accs);
            println!(
                "| shoot REJECTED (rate limit), {seats} seats | 1 | {} | {} | {} | {} | {:.1}% |",
                r.compute_units_consumed, r.compute_units_consumed,
                r.compute_units_consumed, r.compute_units_consumed,
                r.compute_units_consumed as f64 * 100.0 / 399_700.0);
            println!("| _rejection: {:?}_ | | | | | | |", r.raw_result);
        }

        // ---- boss_tick (tag 8) --------------------------------------------
        for pinned in [false, true] {
        let mut w = build(seats, boss_xy, pit_y);
        let m = mollusk_for(&elf, &w.program);
        let mut tk = Vec::new();
        let mut peak_bullets = 0usize;
        let mut err = None;
        for _ in 0..1200usize {
            let ix = Instruction::new_with_bytes(
                w.program,
                &[8],
                vec![
                    AccountMeta::new(w.arena, false),
                    AccountMeta::new(w.boss, false),
                    AccountMeta::new(w.players, false),
                    AccountMeta::new_readonly(w.crank_signer, true),
                ],
            );
            let accs = pick(&w, &[w.arena, w.boss, w.players, w.crank_signer]);
            let r = m.process_instruction(&ix, &accs);
            if r.raw_result.is_err() {
                err = Some(format!("{:?}", r.raw_result));
                break;
            }
            tk.push(r.compute_units_consumed);
            merge(&mut w, &r.resulting_accounts);
            let (_, acc) = w.accounts.iter().find(|(a, _)| *a == w.arena).unwrap();
            let arena: &Arena = bytemuck::from_bytes(&acc.data[..1200]);
            let live = arena.bullets.iter().filter(|b| b.active == 1).count();
            if live > 0 && peak_bullets == 0 {
                let b = arena.bullets.iter().find(|b| b.active == 1).unwrap();
                println!("| _PROBE first volley bullet velocity: dx={} dy={} (|dx|+|dy|={}) at arena.tick={}, phase={}_ | | | | | | |",
                    b.dx, b.dy, (b.dx as i32).abs() + (b.dy as i32).abs(), arena.tick, arena.phase);
            }
            peak_bullets = peak_bullets.max(live);
            // Keep the fight running: top the shell back up so `step` never short-circuits
            // on a win, and keep raiders alive so the volley stays at full width.
            let (_, bacc) = w.accounts.iter_mut().find(|(a, _)| *a == w.boss).unwrap();
            let b: &mut Boss = bytemuck::from_bytes_mut(&mut bacc.data[..50]);
            b.parts = PARTS_BASE;
            let (_, pacc) = w.accounts.iter_mut().find(|(a, _)| *a == w.players).unwrap();
            let pl: &mut Players = bytemuck::from_bytes_mut(&mut pacc.data[..1924]);
            for i in 0..seats {
                if pinned {
                    pl.slots[i].hp = 100;
                    pl.slots[i].respawn_at_tick = 0;
                } else if pl.slots[i].hp == 0 && pl.slots[i].respawn_at_tick == 0 {
                    pl.slots[i].hp = 100;
                }
            }
            if pinned {
                let (_, aacc) = w.accounts.iter_mut().find(|(a, _)| *a == w.arena).unwrap();
                let ar: &mut Arena = bytemuck::from_bytes_mut(&mut aacc.data[..1200]);
                ar.alive_count = seats as u8;
                ar.enrage_at_tick = ar.tick + 3_600;
            }
        }
        let label = if pinned { "boss_tick PINNED 20 alive" } else { "boss_tick natural" };
        row(&format!("{label}, {seats} seats"), tk);
        println!(
            "| _{label} {seats} seats: peak live bullets {peak_bullets}{}_ | | | | | | |",
            err.map(|e| format!(", aborted: {e}")).unwrap_or_default()
        );
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let base = &args[1];
    if args.len() > 2 && args[2] == "search" {
        let program = PROGRAM_ID.parse::<Pubkey>().unwrap();
        for seed in 0u32..2_000_000 {
            let mut probe = [7u8; 32];
            probe[..4].copy_from_slice(&seed.to_le_bytes());
            let k = Pubkey::new_from_array(probe);
            let (_, bb) = Pubkey::find_program_address(&[b"boss", k.as_ref()], &program);
            if bb != 255 { continue; }
            let (_, pb) = Pubkey::find_program_address(&[b"players", k.as_ref()], &program);
            if pb == 255 { println!("ARENA_SEED={seed} boss_bump=255 players_bump=255"); return; }
        }
        println!("no seed found");
        return;
    }
    println!("# raw harness output");
    {
        let w = build(1, (512, 400), 500);
        let program = w.program;
        let (_, bb) = Pubkey::find_program_address(&[b"boss", w.arena.as_ref()], &program);
        let (_, pb) = Pubkey::find_program_address(&[b"players", w.arena.as_ref()], &program);
        println!("arena {} boss_bump {bb} players_bump {pb}", w.arena);
    }
    // Redesigned tree: boss at map::BOSS_SPAWN (512, 400), raiders in the pit.
    run(
        "REDESIGN (working tree)",
        &format!("{base}/tree/target/deploy/heartrot.so"),
        (512, 400),
        500,
        4,
    );
    // Deployed devnet program: pre-redesign, boss at the old (512, 512) map centre.
    run(
        "DEPLOYED (devnet, pre-redesign)",
        &format!("{base}/heartrot_deployed.so"),
        (512, 512),
        620,
        3,
    );

    // Rent — layout is unchanged, so this is a statement of fact, not a delta.
    let rent = mollusk_svm::Mollusk::default().sysvars.rent;
    for (name, size) in [
        ("Arena", core::mem::size_of::<Arena>()),
        ("Boss", core::mem::size_of::<Boss>()),
        ("Players", core::mem::size_of::<Players>()),
        ("PlayerSlot (in Players)", core::mem::size_of::<PlayerSlot>()),
    ] {
        println!(
            "RENT {name}: {size} bytes, exempt minimum {} lamports",
            rent.minimum_balance(size)
        );
    }
}
