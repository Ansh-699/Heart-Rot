# chain-cost — CU, rent and crank budget for the immortals redesign

## Findings

SHIP IT — boss_tick is not a CU blocker; it got cheaper. Worst tick at 20 players on the redesigned program is 24,884 CU of 399,700 (6.2%, 16.1x headroom) against 26,033 for the program on devnet today, and p50 nearly halved (10,200 vs 19,459). Cause: BULLET_UNITS_PER_SEC 120 -> 420 cuts bullet lifetime ~3.5x, and the swept-collision loop over live bullets is the tick's dominant cost; the slam and the core_hp top-up are noise beside that. Do three things anyway, none of them large:

1. FIX TICK_ITERATIONS BEFORE ANY DEVNET RUN. settle.rs:102 still reads `const TICK_ITERATIONS: i64 = 4_500;` with a comment claiming "enrage_at_tick (900 ticks = 6 minutes), so this is 5x headroom". ENRAGE_TICKS is 3,600 and MUSTER_TICKS adds 200, so a match needs 3,800 ticks and 4,500 is 1.18x headroom, not 5x. The crank cannot be topped up. Land the spec's derived (MUSTER_TICKS + ENRAGE_TICKS) * 5 / 4 = 4,750 in the same commit as the muster. This is the only measured-adjacent shipping risk found.

2. GRIND arena_id FOR BUMP 255 IN THE WORKER AT CREATION. Largest CU lever found, zero program change. assert_pda re-derives with find_program_address at ~1,500 CU per rejected candidate, twice in shoot and twice in boss_tick. Measured, identical scenario: arena with both child bumps 255 -> shoot guards 3,452, boss_tick 20-seat max 24,884. Arena with bumps 251/254 -> shoot guards 10,952, boss_tick max 32,384. +7,500 CU per shot and per crank tick decided purely by which arena_id was rolled. ~65k candidate ids on average, milliseconds in the Worker.

3. ACCEPT shoot's cost. It is the one instruction the redesign made materially more expensive (MAX_RAY_STEPS 20 -> 64, nine-rect scan at SCALE=3): worst shot 16,699 CU = 4.2% of 399,700 and 8.4% of the default 200,000 CU per-transaction limit. Twelve-times headroom on the tighter of the two. The SHELL_AABB gate is provably working — a full 64-step miss costs only 4,172 CU more than a 200 u hit that terminates in ~14 steps.

Rent: zero delta. fight_at_tick came out of _pad2, size_of::<Arena>() is still 1200, nothing grew.

BLOCKING ON SOMETHING ELSE: the tree does not build. `cargo check --workspace` and `cargo build-sbf` both fail with `error[E0425]: cannot find function begin_muster in module handlers::settle` (lib.rs:169 dispatches tag 3 to settle::begin_muster; settle.rs:141 still exports start_match). The phase-machine slice has not landed. Everything above was measured on a scratchpad COPY of programs/ carrying one added 3-line alias so the crate compiles; no product code was touched. Tag 3's cost is therefore unmeasured, and `cargo test -p heartrot` could not run, so the "59 passed" baseline was not re-established this session.

## Evidence

INSTRUMENT: scripts/spike/cu/ — mollusk-svm 0.15.1 over Agave solana-program-runtime 4.2.2, two ELFs in one SVM with identical accounts and identical geometry. REDESIGN = cargo build-sbf on the tree (114,016 B). DEPLOYED = `solana program dump -u devnet JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5` (112,480 B). The dumped ELF is confirmed pre-redesign by behaviour, not assumption: it accepts the 3-byte shoot payload [tag, seat, dir] that free aim replaced, and its first volley spawns bullets at |dx|+|dy| = 13-15 (BULLET_SPEED 12) against the tree's 49-50 (BULLET_SPEED 42). Raw output: docs/perf/chain-cost-run.txt (both arena keys, 181 lines).

CALIBRATION vs docs/spikes/sp-load.md on the same ELF, 20 seats — this is why the deltas can be trusted:
  shoot rejected (guards only): devnet 3,425 / harness 3,433 (+0.2%)
  move accepted p50:            devnet 1,933 / harness 2,049 (+6.0%)
  move rejected:                devnet 1,896-1,901 / harness 2,055 (+8%)
  boss_tick max:                devnet 28,586 / harness 26,033 (-8.9%)
  boss_tick quiet floor:        devnet 6,818-6,884 / harness 7,212 (+5.8%)
Deltas sound, absolutes +/-10%.

BOSS_TICK — 1,200 chained ticks per case, state fed forward tick to tick. "natural" lets slam/volley deaths take seats out; "pinned" revives all 20 every tick and holds alive_count at 20 (the ceiling, not a plausible fight). min / p50 / p95 / max:
  DEPLOYED  1 seat  natural   6,058 /  7,707 /  8,267 /  8,314   (2.1%)
  REDESIGN  1 seat  natural   6,086 /  6,812 /  8,328 /  8,508   (2.1%)
  DEPLOYED 20 seats natural   7,212 / 21,471 / 25,399 / 25,642   (6.4%)
  REDESIGN 20 seats natural   7,056 / 11,868 / 23,276 / 24,732   (6.2%)
  DEPLOYED 20 seats pinned    7,242 / 19,459 / 24,810 / 26,033   (6.5%)
  REDESIGN 20 seats pinned    7,232 / 10,200 / 23,776 / 24,884   (6.2%)  <- the ceiling
Peak live bullets 23 (redesign) vs 24-25 (deployed) against MAX_BULLETS = 128. At 420 u/s a volley clears the pit in 3-14 ticks against a 32-tick volley period, so overlapping volleys are unreachable from any pit stand — the spec's claimed 1.86x pool headroom is really ~5x.

CU PER SECOND (TICK_MS 400 -> 100, so the crank fires 4x as often):
  DEPLOYED 2.5 ticks/s x 19,459 p50 =  48,648 CU/s;  ceiling  65,083 CU/s
  REDESIGN  10 ticks/s x 10,200 p50 = 102,000 CU/s;  ceiling 248,840 CU/s
Whole-match crank budget at 3,800 ticks, 20 seats: 38.8M CU p50, 94.6M at the ceiling. Per 400 ms slot the crank contributes ~4 ticks ~= 100k CU against Arena, 120x under the 12M per-writable-account block cap. Whether the ER inherits that cap is still unverified.

MOVE — flat in seat count and flat across the redesign, +0.2%:
  DEPLOYED  1 seat p50 2,049 max 2,051; rejected 2,058
  REDESIGN  1 seat p50 2,052 max 2,053
  DEPLOYED 20 seats p50 2,049 max 2,051; rejected 2,055
  REDESIGN 20 seats p50 2,049 max 2,053; rejected 2,059
The PIT_TOP..=PIT_BOT clamp is two comparisons; nearest-of-eight octant replaced signum at parity.

SHOOT — same stand, same aim vector, both programs, canonical-bump arena:
  guards only (rate-limited)     3,433 -> 3,452   (+0.6%)
  point blank (40 u), hits       4,232 -> 7,872   (+86%)
  120 u, hits                    4,977 -> 10,192  (+105%)
  200 u, hits                    5,722 -> 12,527  (+119%)
  full miss, whole ray budget    5,041 -> 16,699  (+231%)  <- worst shot in the game
Linear in ray length: 11.7 CU per unit travelled on the redesign vs 3.7 on the deployed program.

PDA BUMP LEVER — identical scenario, two arena keys:
  4uQeVoH3NPX9vLdodsUJjXTNFnQptkqWRitPSaBspzr (255/255): shoot guards 3,452, boss_tick 20-seat max 24,884
  11115C9XtokEDfJ8c2QonE7FDe7wevvZQztFGCA2LW (251/254): shoot guards 10,952, boss_tick 20-seat max 32,384
Exactly 1,500 CU per skipped candidate, matching tick.rs's own comment. Worst plausible tick is therefore ~32,400, not 24,884 — still 12.3x headroom.

RENT (rent sysvar, mollusk defaults; layout unchanged so this is a statement of fact, not a delta):
  Arena   1,200 B ->  9,242,880 lamports
  Boss       50 B ->  1,238,880
  Players 1,924 B -> 14,281,920
  per arena 3,174 B -> 24,763,680 lamports = 0.0248 SOL
  PlayerSlot 96 B -> 1,559,040 each; twenty per-seat accounts would be 31.2M, +26% — another reason spec §12.12's split stays cut.
Rent delta for the entire redesign: 0 lamports.

CORRECTION TO A PRIOR DOC: docs/spikes/sp-load.md records shoot as arena(r), boss(w), players(w). Both ELFs — the deployed one included — refuse a shoot whose Arena meta is read-only (Err(Immutable), 160-167 CU, before any handler logic), and instructions.ts:610 already marks it WRITABLE. Not a redesign regression; the table is stale. Worth noting separately that fire() takes &mut Arena and only ever reads arena.tick — nothing in shoot writes the arena — so twenty shooters plus a 10 Hz crank take a write lock on the same 1,200-byte account for no write, which is exactly the serialisation move was designed to avoid. Three-line fix (load instead of load_mut, drop Arena from the assert_writable loop, flip the meta to READONLY), zero CU either way, out of scope here.

## On-chain

Everything measured here is on chain by definition — CU is what the validator charges for executing the program, and rent is what the accounts cost to exist. The split that matters for this task is which of the redesign's costs are forced by the on-chain boundary and which are choices:

FORCED, AND MEASURED AS CHEAP:
- boss_tick's new work (slam lane test, core_hp top-up, MUSTERING branch) decides damage and outcome, so twenty clients must agree; it has to be on chain. Measured cost: net negative. The tick is 4.4% cheaper at the ceiling and 48% cheaper at p50 than the shipped one.
- The slam storing nothing and deriving from mix64(affix_seed ^ mix64(tick / SLAM_PERIOD_TICKS)) is what keeps it free: zero account bytes, zero notification traffic, and the arithmetic is invisible in the tick budget.
- Free aim's (dx, dy) i8 pair, its on-chain normalisation, MAX_RAY_STEPS = MAP_TILES and the SHELL_AABB gate. The client cannot be trusted to report a hit, so the 64-step walk is genuinely on chain. This is the redesign's only real CU cost: +86% to +231% on shoot, topping out at 16,699 CU. It is affordable and it is the price of a boss that fills the top of the screen.

FORCED, AND THE THING THAT NEEDS FIXING:
- TICK_ITERATIONS is on-chain crank state, frozen into the task row at schedule time and un-toppable-up. It is the one number here that can kill a match, and it is currently a stale literal (4,500) with a comment wrong by 4x. Must be derived, per spec.

NOT ON CHAIN, AND CORRECTLY SO — none of these cost a CU:
- Every animation, telegraph and camera state. The volley telegraph and the slam telegraph are pure functions of already-published state (attack_timer, target_seat, affix_seed, tick, parts), so the client redraws them at zero chain cost. Confirmed by measurement: the tick's cost is entirely the bullet loop, and the quiet floor (7,056-7,242 at 20 seats with no bullets in flight) is identical between the two programs.
- The visible-bullet cap, if §9.3's lever is ever pulled. MAX_BULLETS = 128 and bullets_per_volley = 3 + alive_count are chain facts; capping drawing buys exactly nothing on chain, and the measured peak of 23 in flight means the pool was never the constraint anyway.

THE ACCOUNT BUDGET HELD: exactly one field was added anywhere (Arena.fight_at_tick out of _pad2 at offset 1164), size_of::<Arena>() is still 1200, LAYOUT_VERSION stays 1, and the rent delta is zero lamports. The redesign spends CU, not bytes — and it spends less of it per tick than what is deployed.

ONE FREE ON-CHAIN LEVER NOBODY HAS PULLED: the arena PDA's bump. assert_pda re-derives canonically, at ~1,500 CU per rejected candidate, four times across shoot and boss_tick. Grinding arena_id at creation for bump 255 on both children is worth up to 7,500 CU per shot and per tick and needs no program change at all — it is a Worker-side loop over candidate ids.

## Risks

- THE TREE DOES NOT BUILD. `cargo check --workspace` and `cargo build-sbf` both fail: lib.rs:169 dispatches tag 3 to settle::begin_muster, settle.rs:141 still exports start_match. Every number in this report was measured on a scratchpad COPY of programs/ carrying a 3-line alias shim so the crate compiles. No product code was modified, but tag 3's CU cost is unmeasured and `cargo test -p heartrot` could not run, so the 59-passed baseline is unverified this session.
- TICK_ITERATIONS = 4,500 is still a literal in settle.rs:102 with a comment claiming 900 enrage ticks and 5x headroom. Real need is MUSTER_TICKS 200 + ENRAGE_TICKS 3,600 = 3,800 ticks, so actual headroom is 1.18x. A crank cannot be topped up (ScheduleTask needs a writable signer; a scheduled instruction carries none), so a match that reaches enrage and then spends over 700 ticks (70 s) settling goes inert with no error anywhere. Spec mandates the derived 4,750. Land it with the muster.
- The ER's CU accounting is ASSUMED equal to Agave's. The calibration in the report is good to ~6% across four rows (shoot-rejected to 0.2%), but it is an inference from four rows, and no live 20-seat devnet crank log was read this session. R5 — a crank tick over budget deletes the scheduled task permanently and kills the match — is not closed by this work; what it does show is that the redesign moves the tick away from the ceiling rather than towards it.
- Every published CU number for this program, including sp-load's, is implicitly a number about one arena's PDA bump luck. Measured spread: +7,500 CU on shoot and on boss_tick between an arena whose children land on bump 255 and one at 251/254. Nobody controls arena_id for this today, so a devnet demo can silently draw an arena that runs 30% hotter per tick than the numbers in any doc.
- The crank now costs 2.1x more CU per second than the shipped one (102,000 vs 48,648 at 20-seat p50) — not because the tick got dearer but because TICK_MS went 400 -> 100 and it fires 4x as often. Nothing measured says this is a problem, and no ER-side per-account throughput figure exists to check it against. It is a validator-load statement with no instrument behind it.
- The boss_tick numbers assume the pit stands the harness used. Bullet lifetime — which dominates the tick — is a function of how far raiders stand from the muzzles. A raid that hugs PIT_BOT lengthens every bullet's flight and pushes the tick back toward the deployed program's numbers. The measured ceiling (pinned 20 alive, 1,200 chained ticks) brackets it, but the geometry was chosen, not swept.
- shoot's worst case (16,699 CU) is 8.4% of the DEFAULT 200,000 CU per-transaction limit, not of 399,700. Twelve-times headroom, but it is the tighter of the two ceilings and the one that moves if MAX_RAY_STEPS, SCALE, or the rect count ever grows again. A second SCALE bump would be the thing to re-measure.
- docs/spikes/sp-load.md's ABI table records shoot as taking Arena read-only. Measured false on both ELFs (Err(Immutable) before any handler logic). Anyone reasoning about write-lock contention from that table is reasoning from a wrong fact — including any future decision about splitting Players.