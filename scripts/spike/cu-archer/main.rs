//! HEARTROT archer-slice CU harness. Throwaway; see `docs/perf/chain-cost-archer.md`.
//!
//! Descends from `scripts/spike/cu/main.rs` (same mollusk-svm 0.15.1 instrument, same
//! account fixtures, same ARENA_SEED bump argument) and adds the three things the archer
//! slice needs answered:
//!
//!   * `shoot` measured **per class** — the class rides bit 7 of `PlayerSlot::class_aim`,
//!     so the two rows are the same instruction on the same geometry with one bit flipped.
//!   * `join` (tag 4), whose arg block grew 66 -> 67 bytes.
//!   * a **fight mix**: 20 seats firing at their class cadence *interleaved* with the
//!     crank, which is the only scenario that can show a player projectile entering
//!     `boss_tick`'s swept-collision loop. Peak live bullets is reported for the mix and
//!     for the crank alone; if arrows were allocated the two would differ.
//!
//! Both ELFs are driven with fixtures built from the *tree's* structs. That is only legal
//! because the layout did not move (`LAYOUT_VERSION` 1, `PlayerSlot` 96 B on both); the
//! run asserts the sizes before it measures anything.

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
const CEILING: f64 = 399_700.0;

struct World {
    program: Pubkey,
    arena: Pubkey,
    boss: Pubkey,
    players: Pubkey,
    treasury: Pubkey,
    crank_signer: Pubkey,
    sessions: Vec<Pubkey>,
    accounts: Vec<(Pubkey, Account)>,
}

fn owned(program: &Pubkey, data: Vec<u8>) -> Account {
    Account { lamports: 10_000_000, data, owner: *program, executable: false, rent_epoch: 0 }
}

fn signer_account() -> Account {
    Account {
        lamports: 1,
        data: vec![],
        owner: Pubkey::default(),
        executable: false,
        rent_epoch: 0,
    }
}

/// `n` seats claimed, in the arena, alive, spread across a row of pit floor.
fn build(n: usize, boss_xy: (i16, i16), pit_y: i16) -> World {
    let program = PROGRAM_ID.parse::<Pubkey>().unwrap();
    let seed = std::env::var("ARENA_SEED").ok().and_then(|v| v.parse::<u32>().ok()).unwrap_or(1);
    let mut probe = [7u8; 32];
    probe[..4].copy_from_slice(&seed.to_le_bytes());
    let arena = Pubkey::new_from_array(probe);
    let (boss_pda, boss_bump) = Pubkey::find_program_address(&[b"boss", arena.as_ref()], &program);
    let (players_pda, players_bump) =
        Pubkey::find_program_address(&[b"players", arena.as_ref()], &program);

    // The treasury is also the arena's crank authority: `join` requires the signer to be
    // `arena.crank_authority`, and `boss_tick` requires the crank-executor PDA derived
    // from that same key.
    let treasury = Pubkey::new_from_array([9u8; 32]);
    let (crank_signer, _) = Pubkey::find_program_address(
        &[b"crank-executor", treasury.as_ref()],
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
    a.seat_occupied = if n >= 32 { u32::MAX } else { (1u32 << n) - 1 };
    a.crank_authority = treasury.to_bytes();
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
        s.x = 240 + (i as i16) * 28;
        s.y = pit_y + ((i % 3) as i16) * 16;
        s.session_pubkey = key.to_bytes();
        s.identity = [(0x80 + i) as u8; 32];
    }

    let mut accounts = vec![
        (arena, owned(&program, bytes_of(&a).to_vec())),
        (boss_pda, owned(&program, bytes_of(&b).to_vec())),
        (players_pda, owned(&program, bytes_of(&p).to_vec())),
        (treasury, signer_account()),
        (crank_signer, signer_account()),
    ];
    for key in &sessions {
        accounts.push((*key, signer_account()));
    }

    World {
        program,
        arena,
        boss: boss_pda,
        players: players_pda,
        treasury,
        crank_signer,
        sessions,
        accounts,
    }
}

fn pick(w: &World, keys: &[Pubkey]) -> Vec<(Pubkey, Account)> {
    keys.iter()
        .map(|k| w.accounts.iter().find(|(a, _)| a == k).cloned().expect("account"))
        .collect()
}

fn merge(w: &mut World, updated: &[(Pubkey, Account)]) {
    for (k, acc) in updated {
        if let Some(slot) = w.accounts.iter_mut().find(|(a, _)| a == k) {
            slot.1 = acc.clone();
        }
    }
}

fn arena_of(w: &mut World) -> &mut Arena {
    let key = w.arena;
    let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == key).unwrap();
    bytemuck::from_bytes_mut(&mut acc.data[..1200])
}

fn players_of(w: &mut World) -> &mut Players {
    let key = w.players;
    let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == key).unwrap();
    bytemuck::from_bytes_mut(&mut acc.data[..1924])
}

fn boss_of(w: &mut World) -> &mut Boss {
    let key = w.boss;
    let (_, acc) = w.accounts.iter_mut().find(|(a, _)| *a == key).unwrap();
    bytemuck::from_bytes_mut(&mut acc.data[..50])
}

fn stats(mut v: Vec<u64>) -> (u64, u64, u64, u64, usize) {
    v.sort_unstable();
    let n = v.len();
    if n == 0 {
        return (0, 0, 0, 0, 0);
    }
    (v[0], v[n / 2], v[(n * 95 / 100).min(n - 1)], v[n - 1], n)
}

fn row(label: &str, v: Vec<u64>) {
    let (min, p50, p95, max, n) = stats(v);
    println!("| {label} | {n} | {min} | {p50} | {p95} | {max} | {:.2}% |", max as f64 * 100.0 / CEILING);
}

fn one(label: &str, cu: u64, note: &str) {
    println!("| {label} | 1 | {cu} | {cu} | {cu} | {cu} | {:.2}% |", cu as f64 * 100.0 / CEILING);
    if !note.is_empty() {
        println!("| _{note}_ | | | | | | |");
    }
}

fn mollusk_for(elf: &[u8], program: &Pubkey) -> Mollusk {
    let mut m = Mollusk::default();
    m.add_program_with_loader_and_elf(program, &mollusk_svm::program::loader_keys::LOADER_V3, elf);
    m
}

fn shoot_ix(w: &World, seat: u8, dx: i8, dy: i8) -> Instruction {
    Instruction::new_with_bytes(
        w.program,
        &[7u8, seat, dx as u8, dy as u8],
        vec![
            AccountMeta::new(w.arena, false),
            AccountMeta::new(w.boss, false),
            AccountMeta::new(w.players, false),
            AccountMeta::new_readonly(w.sessions[seat as usize], true),
        ],
    )
}

fn tick_ix(w: &World) -> Instruction {
    Instruction::new_with_bytes(
        w.program,
        &[8u8],
        vec![
            AccountMeta::new(w.arena, false),
            AccountMeta::new(w.boss, false),
            AccountMeta::new(w.players, false),
            AccountMeta::new_readonly(w.crank_signer, true),
        ],
    )
}

/// `join` arg block. `len` selects the pre-archer (66) or post-archer (67) ABI so both
/// ELFs can be probed with each and answer for themselves which one they speak.
fn join_ix(w: &World, seat: u8, class: u8, tag_id: u8, len: usize) -> Instruction {
    let mut data = vec![4u8];
    data.push(seat);
    data.push(0u8); // skin_id
    data.extend_from_slice(&[0xC0 | tag_id; 32]); // session pubkey, never UNCLAIMED
    data.extend_from_slice(&[0xE0 | tag_id; 32]); // identity, never zero
    if len == 67 {
        data.push(class);
    }
    Instruction::new_with_bytes(
        w.program,
        &data,
        vec![
            AccountMeta::new(w.arena, false),
            AccountMeta::new(w.players, false),
            AccountMeta::new_readonly(w.treasury, true),
        ],
    )
}

fn run(tag: &str, elf_path: &str) {
    let elf = std::fs::read(elf_path).expect("elf");
    println!("\n## {tag}  ({elf_path}, {} bytes)\n", elf.len());
    println!("| case | n | min | p50 | p95 | max | max % of 399,700 |");
    println!("|---|---|---|---|---|---|---|");

    let boss_xy = (512i16, 400i16);
    let pit_y = 500i16;

    for &seats in &[1usize, 20usize] {
        // ---- move (tag 6) --------------------------------------------------
        let mut w = build(seats, boss_xy, pit_y);
        let mut m = mollusk_for(&elf, &w.program);
        let (mut mv, mut mv_rej) = (Vec::new(), Vec::new());
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
                mv_rej.push(r.compute_units_consumed);
            }
        }
        row(&format!("move accepted, {seats} seats"), mv);
        if !mv_rej.is_empty() {
            row(&format!("move REJECTED, {seats} seats"), mv_rej);
        }

        // ---- shoot (tag 7), per class --------------------------------------
        // Same stand, same aim, one bit of `class_aim` different. On the deployed ELF
        // that byte is `_pad0` and is not read, so its two rows must come out equal —
        // which is itself the evidence that the class byte is what moved the cost.
        for class in [0u8, 1u8] {
            for (name, stand, aim) in [
                ("point blank 40u", (boss_xy.0, boss_xy.1 + 40), (0i8, -127i8)),
                ("120u hit", (boss_xy.0, boss_xy.1 + 120), (0i8, -127i8)),
                ("200u hit", (boss_xy.0, boss_xy.1 + 200), (0i8, -127i8)),
                ("full miss (64-step ray)", (boss_xy.0, boss_xy.1 + 120), (0i8, 127i8)),
            ] {
                let mut w = build(seats, boss_xy, pit_y);
                let m = mollusk_for(&elf, &w.program);
                {
                    let pl = players_of(&mut w);
                    pl.slots[0].x = stand.0;
                    pl.slots[0].y = stand.1;
                    pl.slots[0].class_aim = class << 7;
                }
                let mut cu = Vec::new();
                let mut hits = 0usize;
                let mut first_err = None;
                for _ in 0..64usize {
                    arena_of(&mut w).tick += 16;
                    let ix = shoot_ix(&w, 0, aim.0, aim.1);
                    let accs = pick(&w, &[w.arena, w.boss, w.players, w.sessions[0]]);
                    let r = m.process_instruction(&ix, &accs);
                    if r.raw_result.is_err() {
                        if first_err.is_none() {
                            first_err = Some(format!("{:?}", r.raw_result));
                        }
                        continue;
                    }
                    cu.push(r.compute_units_consumed);
                    let before: u32 = boss_of(&mut w).parts.iter().map(|p| *p as u32).sum();
                    merge(&mut w, &r.resulting_accounts);
                    let b = boss_of(&mut w);
                    if b.parts.iter().map(|p| *p as u32).sum::<u32>() < before {
                        hits += 1;
                    }
                    b.parts = PARTS_BASE;
                    // The class bit must survive every shot: `fire` rewrites this byte.
                    let seen = players_of(&mut w).slots[0].class_aim >> 7;
                    assert_eq!(seen, class, "class bit clobbered by fire()");
                }
                let cls = if class == 0 { "knight" } else { "archer" };
                row(&format!("shoot {cls} {name}, {seats} seats"), cu);
                if let Some(e) = first_err {
                    println!("| _{cls} {name}: {hits}/64 damaged the shell, first err {e}_ | | | | | | |");
                } else {
                    println!("| _{cls} {name}: {hits}/64 damaged the shell_ | | | | | | |");
                }
            }
        }

        // ---- shoot refused by the rate limiter: the guard path only ---------
        {
            let w = build(seats, boss_xy, pit_y);
            let m = mollusk_for(&elf, &w.program);
            let ix = shoot_ix(&w, 0, 0, -1);
            let accs = pick(&w, &[w.arena, w.boss, w.players, w.sessions[0]]);
            let r = m.process_instruction(&ix, &accs);
            one(
                &format!("shoot REFUSED (rate limit), {seats} seats"),
                r.compute_units_consumed,
                &format!("refusal: {:?}", r.raw_result),
            );
        }

        // ---- join (tag 4) ---------------------------------------------------
        // Seat `seats` is the first free one, so the identity scan walks `seats` claimed
        // slots — the cost that grows with the roster.
        for len in [66usize, 67usize] {
            for class in [0u8, 1u8] {
                if len == 66 && class == 1 {
                    continue;
                }
                let w = build(seats, boss_xy, pit_y);
                let m = mollusk_for(&elf, &w.program);
                let ix = join_ix(&w, seats as u8, class, 1, len);
                let accs = pick(&w, &[w.arena, w.players, w.treasury]);
                let r = m.process_instruction(&ix, &accs);
                let cls = if len == 66 { "-" } else if class == 0 { "knight" } else { "archer" };
                one(
                    &format!("join {len}-byte args, class {cls}, {seats} seats occupied"),
                    r.compute_units_consumed,
                    &format!("{:?}", r.raw_result),
                );
            }
        }

        // ---- boss_tick (tag 8), crank alone ---------------------------------
        for pinned in [false, true] {
            let mut w = build(seats, boss_xy, pit_y);
            let m = mollusk_for(&elf, &w.program);
            let mut tk = Vec::new();
            let mut peak = 0usize;
            let mut err = None;
            for _ in 0..1200usize {
                let ix = tick_ix(&w);
                let accs = pick(&w, &[w.arena, w.boss, w.players, w.crank_signer]);
                let r = m.process_instruction(&ix, &accs);
                if r.raw_result.is_err() {
                    err = Some(format!("{:?}", r.raw_result));
                    break;
                }
                tk.push(r.compute_units_consumed);
                merge(&mut w, &r.resulting_accounts);
                peak = peak.max(arena_of(&mut w).bullets.iter().filter(|b| b.active == 1).count());
                boss_of(&mut w).parts = PARTS_BASE;
                let pl = players_of(&mut w);
                for i in 0..seats {
                    if pinned {
                        pl.slots[i].hp = 100;
                        pl.slots[i].respawn_at_tick = 0;
                    } else if pl.slots[i].hp == 0 && pl.slots[i].respawn_at_tick == 0 {
                        pl.slots[i].hp = 100;
                    }
                }
                if pinned {
                    let ar = arena_of(&mut w);
                    ar.alive_count = seats as u8;
                    ar.enrage_at_tick = ar.tick + 3_600;
                }
            }
            let label = if pinned { "boss_tick PINNED all alive" } else { "boss_tick natural" };
            row(&format!("{label}, {seats} seats"), tk);
            println!(
                "| _{label} {seats} seats: peak live bullets {peak}{}_ | | | | | | |",
                err.map(|e| format!(", aborted: {e}")).unwrap_or_default()
            );
        }
    }

    // ---- the fight mix: 20 seats firing continuously, interleaved with the crank ----
    // This is the shipping gate. If a player shot allocated a projectile it would land in
    // `arena.bullets` and walk the tick's swept-collision loop; peak live bullets and the
    // tick's CU would both move against the crank-alone rows above.
    for class in [0u8, 1u8] {
        let mut w = build(20, boss_xy, pit_y);
        let m = mollusk_for(&elf, &w.program);
        {
            let pl = players_of(&mut w);
            for i in 0..MAX_SEATS {
                pl.slots[i].class_aim = class << 7;
            }
        }
        let mut tk = Vec::new();
        let mut sh_ok = Vec::new();
        let mut sh_refused = Vec::new();
        let mut peak = 0usize;
        let mut accepted = 0usize;
        let mut landed = 0usize;
        for _ in 0..1200usize {
            // crank first, then everybody pulls the trigger
            let ix = tick_ix(&w);
            let accs = pick(&w, &[w.arena, w.boss, w.players, w.crank_signer]);
            let r = m.process_instruction(&ix, &accs);
            if r.raw_result.is_err() {
                println!("| _fight mix aborted at tick: {:?}_ | | | | | | |", r.raw_result);
                break;
            }
            tk.push(r.compute_units_consumed);
            merge(&mut w, &r.resulting_accounts);
            peak = peak.max(arena_of(&mut w).bullets.iter().filter(|b| b.active == 1).count());
            boss_of(&mut w).parts = PARTS_BASE;
            {
                let pl = players_of(&mut w);
                for i in 0..20 {
                    pl.slots[i].hp = 100;
                    pl.slots[i].respawn_at_tick = 0;
                }
            }
            {
                let ar = arena_of(&mut w);
                ar.alive_count = 20;
                ar.enrage_at_tick = ar.tick + 3_600;
            }
            for seat in 0..20u8 {
                // aim at the boss from wherever the tick left this seat standing
                let (sx, sy) = {
                    let pl = players_of(&mut w);
                    (pl.slots[seat as usize].x, pl.slots[seat as usize].y)
                };
                // Scale the vector into i8 rather than clamping each component: clamping
                // rotates the aim (a 20-degree shot becomes a 38-degree one) and the ray
                // then dies on a wall instead of reaching the shell.
                let (vx, vy) = ((boss_xy.0 - sx) as i32, (boss_xy.1 - sy) as i32);
                let scale = vx.abs().max(vy.abs()).max(1);
                let (dx, dy) = ((vx * 127 / scale) as i8, (vy * 127 / scale) as i8);
                let (dx, dy) = if dx == 0 && dy == 0 { (0, -1) } else { (dx, dy) };
                let ix = shoot_ix(&w, seat, dx, dy);
                let accs = pick(&w, &[w.arena, w.boss, w.players, w.sessions[seat as usize]]);
                let r = m.process_instruction(&ix, &accs);
                if r.raw_result.is_ok() {
                    sh_ok.push(r.compute_units_consumed);
                    accepted += 1;
                    let before: u32 = boss_of(&mut w).parts.iter().map(|p| *p as u32).sum();
                    merge(&mut w, &r.resulting_accounts);
                    let b = boss_of(&mut w);
                    if b.parts.iter().map(|p| *p as u32).sum::<u32>() < before {
                        landed += 1;
                    }
                    b.parts = PARTS_BASE;
                    let b = boss_of(&mut w);
                    b.core_hp = 2_000;
                    b.vent_open = 0;
                } else {
                    sh_refused.push(r.compute_units_consumed);
                }
                peak = peak.max(arena_of(&mut w).bullets.iter().filter(|b| b.active == 1).count());
            }
        }
        let cls = if class == 0 { "knight" } else { "archer" };
        row(&format!("FIGHT MIX boss_tick, 20 {cls}s firing"), tk);
        row(&format!("FIGHT MIX shoot accepted, 20 {cls}s"), sh_ok);
        row(&format!("FIGHT MIX shoot refused (cooldown), 20 {cls}s"), sh_refused);
        println!(
            "| _fight mix, 20 {cls}s: {accepted} shots accepted over 1200 ticks, {landed} damaged the shell, peak live bullets {peak}_ | | | | | | |"
        );
    }
}

/// The counterfactual the archer decision rests on: what a *live projectile* costs the
/// tick, on this build. `N` bullets are re-pinned active before every tick, so the swept
/// collision loop walks exactly `N` of them against 20 players. The slope is what an
/// on-chain arrow would have cost per tick per arrow.
fn bullet_slope(tag: &str, elf_path: &str) {
    let elf = std::fs::read(elf_path).expect("elf");
    println!("\n### {tag} — boss_tick vs pinned live bullets, 20 seats\n");
    println!("| live bullets pinned | n | min | p50 | p95 | max | max % of 399,700 |");
    println!("|---|---|---|---|---|---|---|");
    let mut prev: Option<(usize, u64)> = None;
    for n in [0usize, 8, 23, 32, 64, 128] {
        let mut w = build(20, (512, 400), 500);
        let m = mollusk_for(&elf, &w.program);
        let mut tk = Vec::new();
        for _ in 0..120usize {
            {
                let ar = arena_of(&mut w);
                for i in 0..128usize {
                    let b = &mut ar.bullets[i];
                    if i < n {
                        b.x = 260 + (i as i16 % 20) * 24;
                        b.y = 420 + (i as i16 / 20) * 24;
                        b.dx = 0;
                        b.dy = 42;
                        b.active = 1;
                    } else {
                        b.active = 0;
                    }
                }
            }
            let ix = tick_ix(&w);
            let accs = pick(&w, &[w.arena, w.boss, w.players, w.crank_signer]);
            let r = m.process_instruction(&ix, &accs);
            if r.raw_result.is_err() {
                println!("| _aborted at N={n}: {:?}_ | | | | | | |", r.raw_result);
                break;
            }
            tk.push(r.compute_units_consumed);
            merge(&mut w, &r.resulting_accounts);
            boss_of(&mut w).parts = PARTS_BASE;
            let pl = players_of(&mut w);
            for i in 0..20 {
                pl.slots[i].hp = 100;
                pl.slots[i].respawn_at_tick = 0;
            }
            let ar = arena_of(&mut w);
            ar.alive_count = 20;
            ar.enrage_at_tick = ar.tick + 3_600;
        }
        let (_, p50, _, _, _) = stats(tk.clone());
        row(&format!("{n} pinned"), tk);
        if let Some((pn, pp50)) = prev {
            if n > pn {
                println!(
                    "| _slope {pn} -> {n}: {:.1} CU per live bullet per tick (p50)_ | | | | | | |",
                    (p50 as f64 - pp50 as f64) / (n - pn) as f64
                );
            }
        }
        prev = Some((n, p50));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    println!("# cu-archer raw output");

    // Layout first: every fixture below is the tree's structs poured into both ELFs, and
    // that is only sound while the layout has not moved.
    println!(
        "\nLAYOUT PlayerSlot {} B, Players {} B, Arena {} B, Boss {} B, LAYOUT_VERSION {}",
        core::mem::size_of::<PlayerSlot>(),
        core::mem::size_of::<Players>(),
        core::mem::size_of::<Arena>(),
        core::mem::size_of::<Boss>(),
        LAYOUT_VERSION
    );
    assert_eq!(core::mem::size_of::<PlayerSlot>(), 96);
    assert_eq!(core::mem::size_of::<Players>(), 1924);
    assert_eq!(core::mem::size_of::<Arena>(), 1200);

    {
        let w = build(1, (512, 400), 500);
        let (_, bb) = Pubkey::find_program_address(&[b"boss", w.arena.as_ref()], &w.program);
        let (_, pb) = Pubkey::find_program_address(&[b"players", w.arena.as_ref()], &w.program);
        println!("ARENA {} boss_bump {bb} players_bump {pb}", w.arena);
    }

    for pair in args[1..].chunks(2) {
        if pair.len() == 2 {
            run(&pair[0], &pair[1]);
            bullet_slope(&pair[0], &pair[1]);
        }
    }

    let rent = Mollusk::default().sysvars.rent;
    for (name, size) in [
        ("Arena", core::mem::size_of::<Arena>()),
        ("Boss", core::mem::size_of::<Boss>()),
        ("Players", core::mem::size_of::<Players>()),
    ] {
        println!("RENT {name}: {size} bytes, exempt minimum {} lamports", rent.minimum_balance(size));
    }
}
