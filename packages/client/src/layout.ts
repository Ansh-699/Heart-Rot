/**
 * HEARTROT account decoding — the TypeScript half of the byte layout.
 *
 * The offsets below are the same table as `programs/heartrot/src/state.rs` and
 * `docs/architecture/04-layout-contract.md`. Keys are the Rust field names verbatim,
 * so a consistency check can diff the three mechanically rather than by eye. If you
 * change one, change all three; a silent disagreement here decodes a live match as
 * garbage with no error anywhere.
 *
 * Everything is little-endian, matching Solana. There are no floats on the wire and
 * none are introduced here: bullets are integer position plus integer per-tick
 * velocity precisely so the renderer can extrapolate them exactly between 2.5 Hz
 * ticks with zero prediction error.
 *
 * 32-byte fields come back as `Uint8Array`. Converting to base58 is the caller's
 * business (`getAddressDecoder().decode(bytes)` from `@solana/kit`) — this module
 * stays dependency-free so the Worker can import it too. The one local import is
 * `map.ts`, which is generated and imports nothing.
 */

import { GATES, MAP_MAX_XY, MAP_TILE, MAP_TILES, PIT_BOT, PIT_TOP, SECRET_ROOM } from './map';

// ---------------------------------------------------------------------------
// Capacities, discriminators, sentinels — mirrors of the Rust constants
// ---------------------------------------------------------------------------

export const MAX_SEATS = 20;
export const MAX_BULLETS = 128;
export const N_PARTS = 9;
export const LEADERBOARD_CAP = 128;

export const DISC_UNINITIALIZED = 0;
export const DISC_ARENA = 1;
export const DISC_BOSS = 2;
export const DISC_PLAYERS = 3;
export const DISC_LEADERBOARD = 4;

export const LAYOUT_VERSION = 1;

/**
 * `Arena.phase` — where the match is. **Not** how the fight ended: that is
 * `Arena.outcome`, a separate byte, because a phase cannot carry the result past
 * `PHASE_SETTLED` and the end screen still has to say what happened.
 *
 * Values 0..3 are frozen. 4 and 5 are appended, so a `switch` in the app that only knows
 * the first four keeps compiling — but it will fall through to its default for the ~10 s
 * of a VRF roll. The renderable beat for those two is "the heart reforms", per the design.
 *
 * The legal transitions live in `programs/heartrot/src/state.rs` (`PHASE_EDGES`) and in
 * `docs/architecture/06-game-loop.md` §3. Nothing on the client enforces them; this is
 * here so a UI can say *why* an action is unavailable rather than sending it and losing.
 */
export const PHASE_LOBBY = 0;
export const PHASE_FIGHTING = 1;
/** The fight is over and `outcome` says how; nothing is committed yet. */
export const PHASE_SETTLING = 2;
export const PHASE_SETTLED = 3;
/** A VRF request for the next incarnation's seed is in flight. */
export const PHASE_ROLLING = 4;
/** The seed landed; the match is ready to settle. */
export const PHASE_ROLLED = 5;
/**
 * The gate has been walked and a fixed muster window is counting down to
 * {@link ArenaAccount.fightAtTick}. Appended after {@link PHASE_ROLLED}, so 0..=5 keep
 * their meaning and a `switch` written before it existed still compiles — it will fall
 * through to its default for the 20 s of a muster, which is exactly the beat that wants
 * the countdown UI, so check for it.
 *
 * `shoot` refuses in this phase (it tests `== PHASE_FIGHTING`); join, move and
 * `enter_gate` are all legal.
 */
export const PHASE_MUSTERING = 6;

/**
 * `Arena.outcome` — how the fight ended, written once and surviving settlement.
 * `OUTCOME_UNDECIDED` on every arena that has not finished, including every account
 * created before this field existed (it was zero padding).
 */
export const OUTCOME_UNDECIDED = 0;
/** Core HP reached 0. The only outcome that rolls a next incarnation. */
export const OUTCOME_WIN = 1;
/** Every seat standing in the arena was dead at the same tick. */
export const OUTCOME_WIPE = 2;
/** `enrage_at_tick` passed with the core alive. Scored as a loss, shown differently. */
export const OUTCOME_ENRAGE = 3;

/**
 * The crank's cadence, in milliseconds — `state::TICK_MS`. Every duration below is a
 * number of *ticks*, and this is the only place a tick becomes a wall-clock number.
 *
 * A UI that hard-codes a period instead of reading this is how `Hud.tsx` ended up
 * showing a 4x-long enrage clock when the crank went 400 ms -> 100 ms.
 */
export const TICK_MS = 100;

/**
 * Ticks that cover `ms`, rounding up, never zero — `state::ticks_for`. Durations are
 * written as milliseconds and converted here for the same reason the Rust does it: they
 * then stay correct when {@link TICK_MS} moves.
 */
export function ticksFor(ms: number): number {
  return Math.max(1, Math.ceil(ms / TICK_MS));
}

/**
 * Crank ticks a roll may stay in `PHASE_ROLLING` before `boss_tick` abandons it. Mirrors
 * the Rust constant of the same name; a countdown UI must use this and not its own
 * guess, or it declares the oracle dead while the chain is still waiting for it.
 *
 * Derived, never typed: the literal `25` this used to be was the 400 ms-era value and
 * declared the oracle dead 75 ticks early on a 100 ms chain.
 */
export const ROLL_TIMEOUT_TICKS = ticksFor(10_000);

/**
 * How long `PHASE_MUSTERING` lasts — `state::MUSTER_TICKS`. The countdown a client draws
 * is `(arena.fightAtTick - arena.tick) * TICK_MS`; this constant is what a *lobby* uses
 * to size the bar before the first knight is through the gate.
 */
export const MUSTER_TICKS = ticksFor(20_000);

/**
 * Fight length before the boss enrages — `state::ENRAGE_TICKS`. `Arena.enrageAtTick` is
 * stamped from it at the MUSTERING -> FIGHTING flip, **not** at arena creation, so it
 * reads 0 for the whole lobby and the whole muster. A client that renders an enrage
 * clock from a zero shows a fight timer for a fight that has not begun.
 */
export const ENRAGE_TICKS = ticksFor(360_000);

export const ZONE_LOBBY = 0;
export const ZONE_ARENA = 1;
/** The chamber behind the lobby's west door, `map.ts`'s `SECRET_ROOM`: `use_door` is its only writer, both ways. */
export const ZONE_SECRET = 2;

/**
 * May a seat in `zone` step from `y` to `ny`? The mirror of `handlers::player::may_move_to`,
 * and the rule client-side prediction must apply on the destination or every step at a box
 * edge is a snap-back that reads as lag.
 *
 * **Both zones are boxed and the two boxes tile the map at the gate seam.** A raider is
 * held in `PIT_TOP..=PIT_BOT`; a lobby seat is held in `PIT_BOT + 1 ..= MAP_MAX_XY`,
 * everything below the rim. The lobby half is not bounded by walls — rows 1..23 are
 * deliberately open floor so the chain's raycast survives the trip to the boss — so
 * without the lobby box a lobby seat walks up the pit and stands inside the creature's
 * crown, invisible to every mechanic and drawn by every client.
 *
 * The second clause is the un-stranding rule and is why this is not a bare range test. A
 * seat already outside its box — written by yesterday's program, which had no lobby box —
 * would have all eight steps refused, including the one pointing home, because a sideways
 * step keeps the same illegal `y`. Strictly-decreasing overshoot terminates inside the box
 * and cannot be ridden the other way.
 *
 * It lives here rather than beside `PIT_TOP` because `map.ts` is generated by
 * `tools/gen_map.py` and hand-editing generated output is how a fact ends up stored twice.
 * This file already owns {@link ZONE_ARENA} and already imports the generated bounds.
 */
export function mayMoveTo(zone: number, y: number, ny: number): boolean {
  const inArena = zone === ZONE_ARENA;
  const secret = zone === ZONE_SECRET;
  // The chamber's own rows (`player::zone_box`); its columns are `standable`'s question.
  const top = secret ? SECRET_ROOM.minY : inArena ? PIT_TOP : PIT_BOT + 1;
  const bot = secret ? SECRET_ROOM.maxY : inArena ? PIT_BOT : MAP_MAX_XY;
  const over = (v: number): number => Math.max(top - v, v - bot, 0);
  // Mirrors `handlers::player::may_move_to`. A stranded seat is governed by WALLS ALONE
  // until it re-enters its box: the earlier strictly-decreasing rule froze 4,620 stale
  // lobby positions outright, because the chain refuses on `is_wall(nx,ny) || !mayMoveTo`
  // and at those positions every overshoot-decreasing step is a wall.
  return over(y) > 0 || over(ny) === 0;
}

// ---------------------------------------------------------------------------
// Classes — the mirror of `state.rs`'s class block
//
// The whole class feature is one byte, `PlayerSlot.class_aim`, reinterpreted out of what
// was `_pad0`. Nothing here is new wire: every seat already on chain reads 0 in it, which
// is the knight it already was, which is why there is no migration.
// ---------------------------------------------------------------------------

/** Bit 7 of `class_aim`. One bit is the budget: the other seven are the aim. */
export const CLASS_MASK = 0b1000_0000;
/** Must stay 0 — it is what every live seat's byte already says. */
export const CLASS_KNIGHT = 0;
/** Faster and lighter: 400 ms and 20 a hit (was 1,400 ms and 70). The knight is the slow, heavy row. */
export const CLASS_ARCHER = 1;
export const N_CLASSES = 2;

/** Milliseconds between accepted shots, per class. Ticks below are derived, never typed. */
export const CLASS_PERIOD_MS: readonly number[] = [800, 400];

/**
 * Damage per landed shot, per class — DPS-neutral with {@link CLASS_PERIOD_MS} by
 * construction (`40 x 4 == 20 x 8`), so the boss's HP curve does not move with the class
 * a raid picks. The equality is asserted in {@link layoutSelfCheck}.
 */
export const CLASS_DAMAGE: readonly number[] = [40, 20];

/**
 * Shot cooldown in ticks, per class. The chain compares
 * `arena.tick > last_shot_tick + cooldown`, so this is one *less* than the period in ticks.
 *
 * This is the **only** copy the client may read. `Hud.tsx` hard-coding a 1 here is how the
 * SHOT READY pill went green 600 ms before the client's own gate would send.
 */
export const CLASS_COOLDOWN_TICKS: readonly number[] = CLASS_PERIOD_MS.map(
  (ms) => ticksFor(ms) - 1,
);

/** `class_aim >> 7` — total, so the tables above are always indexable. */
export function classOf(slot: Pick<PlayerSlot, 'classAim'>): number {
  return slot.classAim >> 7;
}

export function shotDamage(slot: Pick<PlayerSlot, 'classAim'>): number {
  return CLASS_DAMAGE[classOf(slot)]!;
}

export function cooldownTicks(slot: Pick<PlayerSlot, 'classAim'>): number {
  return CLASS_COOLDOWN_TICKS[classOf(slot)]!;
}

// ---------------------------------------------------------------------------
// The charged shot — `state.rs`'s charge block
//
// Stateless on chain: no charge timer is stored. A shot sent with `charged` is granted
// 2.5x only if the seat's last accepted step is at least `CHARGE_MS` old, measured by the
// chain as ER slots — `Clock.slot - lastMoveTick`, both slots. `Arena.tick` is a crank
// tick on another clock and must never enter that subtraction (the MOVE pill was green
// for a whole fight the last time somebody compared the two). A shorter hold is refused
// with `HeartrotError.NotCharged` (20) *before* the cooldown is spent: resend uncharged.
// ---------------------------------------------------------------------------

/** `state::CHARGE_MS` — the hold. Add any send-latency margin in the client, never here. */
export const CHARGE_MS = 1_000;

/** `state::CHARGED_NUM / CHARGED_DEN` — a charged shot deals 2.5x, on the same cooldown. */
export const CHARGED_NUM = 5;
export const CHARGED_DEN = 2;

/** `state::charged_damage(class)` — exact on both rows; the chain const-asserts it divides. */
export function chargedDamage(cls: number): number {
  return (CLASS_DAMAGE[cls]! * CHARGED_NUM) / CHARGED_DEN;
}

/**
 * `state::CHARGED_SHOT_BIT` — bit 3 of `PlayerSlot.facing` says the seat's last shot was
 * charged. Bits 0..2 are the octant. Set by `shoot`, cleared by the next step or uncharged
 * shot, which is exactly the in-flight arrow's lifetime. Decoded into
 * {@link PlayerSlot.chargedShot}; nothing should mask the byte at a call site.
 */
export const CHARGED_SHOT_BIT = 3;

// ---------------------------------------------------------------------------
// The super shot — `state.rs`'s super block. A longer hold, the same statelessness.
// ---------------------------------------------------------------------------

/**
 * The three things a `shoot` can be — the `charged` byte on the wire: 0 tap, 1 charged
 * ({@link CHARGE_MS} still), 2 super ({@link SUPER_MS} still, the beam). The chain grants a
 * tier only if the hold accrued and refuses with `NotCharged` (20) otherwise, before the
 * cooldown is spent — so a client resends one tier down and never drops the shot.
 */
export type ShotTier = 0 | 1 | 2;

/**
 * `state::SLOT_MS` — one ER slot, the clock `last_move_tick` is stamped in. A hold is
 * judged in these; `Arena.tick` is a crank tick on another clock and must never be
 * compared with one.
 */
export const SLOT_MS = 50;

/** `state::SUPER_MS` — the hold for tier 2. Margin for send latency belongs in the client. */
export const SUPER_MS = 2_500;

/** `state::SUPER_SLOTS` — the same hold in ER slots, the unit the chain judges it in. */
export const SUPER_SLOTS = SUPER_MS / SLOT_MS;

/**
 * `state::SUPER_NUM / SUPER_DEN` — a super deals 5x, on the same cooldown, and PIERCES:
 * every part on the ray takes it once (`raycastBeam` in `aim.ts` mirrors the walk).
 */
export const SUPER_NUM = 5;
export const SUPER_DEN = 1;

/** `state::super_damage(class)` — 100 archer, 200 knight; the chain const-asserts it divides. */
export function superDamage(cls: number): number {
  return (CLASS_DAMAGE[cls]! * SUPER_NUM) / SUPER_DEN;
}

/**
 * `state::SUPER_SHOT_BIT` — bit 4 of `PlayerSlot.facing` says the seat's last shot was a
 * super. Beside {@link CHARGED_SHOT_BIT}, same lifetime: cleared by the next step or plain
 * shot. Decoded into {@link PlayerSlot.superShot}; nothing should mask the byte at a call site.
 */
export const SUPER_SHOT_BIT = 4;

// ---------------------------------------------------------------------------
// Difficulty tiers — `state.rs`'s tier block, keyed by `Arena.difficulty`
// ---------------------------------------------------------------------------

/**
 * `state::N_TIERS`, `TIER_EASY..=TIER_HARD` — the three gates in the lobby's top wall, left
 * to right, and the index of every table below. `Arena.difficulty` is the gate the raid's
 * first raider stood in ({@link GATES} has the same order, out of the same grid); every
 * account that predates the byte reads 0, EASY, the tuning it was already fighting.
 */
export const N_TIERS = 3;
export const TIER_EASY = 0;
export const TIER_MEDIUM = 1;
export const TIER_HARD = 2;

/** What the HUD prints for a tier, and the colour it prints it in — the doorway's own light. */
export const TIER_NAMES: readonly string[] = ['EASY', 'MEDIUM', 'HARD'];
export const TIER_COLORS: readonly string[] = ['#7ee787', '#ffb648', '#ff5a4a'];

/**
 * `state::tier_n` — `tier` clamped into a table index. Only `enter_gate` writes the byte,
 * from a gate index, so this never fires on a live account; it keeps every read below
 * total, and a byte the chain never writes reads as the hardest row, as it does there.
 */
function tierN(tier: number): number {
  return Math.min(Math.max(tier, 0), N_TIERS - 1);
}

/**
 * `handlers::player::locked_tier` — the tier this raid is already committed to, or `null`
 * while nobody has opened it. Either `raidSize` (the first FIGHTING tick) or `aliveCount`
 * (the first `enter_gate`) non-zero means a gate has been walked this incarnation, and
 * `difficulty` is that gate. The chain refuses any other gate with `WrongGate` (21) from
 * then on, so a client that would send `enter_gate` from another doorway reads this first
 * and does not — that refusal never heals by standing still.
 */
export function lockedTier(arena: Pick<ArenaAccount, 'raidSize' | 'aliveCount' | 'difficulty'>): number | null {
  return arena.raidSize === 0 && arena.aliveCount === 0 ? null : arena.difficulty;
}

// ---------------------------------------------------------------------------
// The vent threshold — `state.rs`'s `vent_pct`
// ---------------------------------------------------------------------------

/**
 * `state::VENT_PCT_SOLO_BY_TIER` / `VENT_PCT_FULL_BY_TIER`: shell remaining, in percent,
 * below which the vent opens, for a raid of one and for a full raid, by tier. Shell HP is
 * flat at every raid size; the *threshold* is the raid-size knob, so an EASY solo strips
 * 2 % of the shell before the core is reachable and twenty strip 65 %; HARD asks 12 % and
 * 75 %.
 */
export const VENT_PCT_SOLO_BY_TIER: readonly number[] = [98, 94, 88];
export const VENT_PCT_FULL_BY_TIER: readonly number[] = [35, 30, 25];

/**
 * `state::raid_n` — `raidSize` clamped into `1..=MAX_SEATS`, the domain every raid-size
 * curve in this file is drawn over. 0, which every account that predates the field
 * carries, reads as solo. Written once so {@link ventPct}, {@link bulletDamage} and
 * {@link slamDamage} cannot disagree about what an uncounted raid is.
 */
function raidN(raidSize: number): number {
  return Math.min(Math.max(raidSize, 1), MAX_SEATS);
}

/**
 * `state::vent_pct(raid_size, tier)` — the threshold for `arena.raidSize` on
 * `arena.difficulty`, linear between the tier's two endpoints and clamped by {@link raidN}.
 * The chain's comparison is `sum(parts) * 100 < sum(partsMax) * ventPct(raidSize, tier)`,
 * in integers, so a HUD that draws the line must call this rather than type a 35.
 */
export function ventPct(raidSize: number, tier: number): number {
  const t = tierN(tier);
  const solo = VENT_PCT_SOLO_BY_TIER[t]!;
  return solo - Math.floor(((solo - VENT_PCT_FULL_BY_TIER[t]!) * (raidN(raidSize) - 1)) / (MAX_SEATS - 1));
}

/**
 * `state::BOSS_CORE_HP_BY_TIER` / `CORE_HP_PER_RAIDER_BY_TIER` and `core_hp_required` — the
 * core a raid of `raidSize` on `tier` fights: the tier's floor plus its per-raider top-up.
 * The tick raises `coreHpMax` to this and never lowers it; a boss is seeded with the EASY
 * floor in the lobby and grows to its row on the first FIGHTING tick. Per-raider rows are
 * the largest hundreds whose twenty-raider sum fits the `u16` the chain writes.
 */
export const BOSS_CORE_HP_BY_TIER: readonly number[] = [200, 400, 700];
export const CORE_HP_PER_RAIDER_BY_TIER: readonly number[] = [3_000, 3_200, 3_400];

export function coreHpRequired(raidSize: number, tier: number): number {
  const t = tierN(tier);
  return BOSS_CORE_HP_BY_TIER[t]! + CORE_HP_PER_RAIDER_BY_TIER[t]! * (raidN(raidSize) - 1);
}

// ---------------------------------------------------------------------------
// Incoming damage and fury — `state.rs`'s raid-scaled damage and `Boss::fight_hp`
// ---------------------------------------------------------------------------

/**
 * `state::BULLET_DAMAGE_SOLO / FULL`, `SLAM_DAMAGE_SOLO / FULL` — what one boss bullet and
 * one hand slam take off a raider, for a raid of one and for a full raid on EASY. Twenty
 * take the flat 8 / 45 the crank always dealt; solo takes 2 / 15 against a 150 HP bar,
 * ~40 s standing still for a 12 s kill. The chain deals it; a HUD that predicts a hit reads
 * these. `INCOMING_MUL_BY_TIER` multiplies the whole curve: MEDIUM doubles it, HARD triples.
 */
export const BULLET_DAMAGE_SOLO = 2;
export const BULLET_DAMAGE_FULL = 8;
export const SLAM_DAMAGE_SOLO = 15;
export const SLAM_DAMAGE_FULL = 45;
export const INCOMING_MUL_BY_TIER: readonly number[] = [1, 2, 3];

/** `state::FURY_EXTRA_BULLETS_BY_TIER` — bullets a furious volley adds, by tier. */
export const FURY_EXTRA_BULLETS_BY_TIER: readonly number[] = [1, 2, 3];

/** `state::raid_lerp` — linear from `solo` to `full` over `1..=MAX_SEATS`, rounding toward solo, times the tier. */
function raidLerp(solo: number, full: number, raidSize: number, tier: number): number {
  return (solo + Math.floor(((full - solo) * (raidN(raidSize) - 1)) / (MAX_SEATS - 1))) * INCOMING_MUL_BY_TIER[tierN(tier)]!;
}

/** `state::bullet_damage(raid_size, tier)`. */
export function bulletDamage(raidSize: number, tier: number): number {
  return raidLerp(BULLET_DAMAGE_SOLO, BULLET_DAMAGE_FULL, raidSize, tier);
}

/** `state::slam_damage(raid_size, tier)`. The beam deals the same number. */
export function slamDamage(raidSize: number, tier: number): number {
  return raidLerp(SLAM_DAMAGE_SOLO, SLAM_DAMAGE_FULL, raidSize, tier);
}

/**
 * `state::FURY_PCT` — fight HP at or below this percent of its max and the boss is furious:
 * the volley reloads from {@link FURY_VOLLEY_INTERVAL_TICKS} with one extra bullet, and the
 * creature is dressed as ENRAGED. Derived from the shell and the core on every read, never
 * stored. Distinct from `OUTCOME_ENRAGE`, the six-minute timeout that ENDS the fight.
 */
export const FURY_PCT = 20;

/**
 * `Boss::fight_hp(raid_size, tier)` — the fight as one number. Shell above the vent line
 * never has to come off, so it is not fight HP: `threshold = shellMax * ventPct / 100`,
 * `left = max(shell - threshold, 0) + coreHp`, `max = (shellMax - threshold) + coreHpMax`,
 * integers throughout so the HUD's `boss NN%` and the chain's fury edge agree to the point.
 * A solo bar that read `shell 97%` for a fight three hits from won is why this exists.
 */
export function fightHp(
  boss: Pick<BossAccount, 'parts' | 'partsMax' | 'coreHp' | 'coreHpMax'>,
  raidSize: number,
  tier: number,
): { left: number; max: number } {
  const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
  const shellMax = sum(boss.partsMax);
  const threshold = Math.floor((shellMax * ventPct(raidSize, tier)) / 100);
  return {
    left: Math.max(sum(boss.parts) - threshold, 0) + boss.coreHp,
    max: shellMax - threshold + boss.coreHpMax,
  };
}

/**
 * `Boss::is_furious(raid_size, tier)` — `max > 0 && left > 0 && left * 100 <= max * FURY_PCT`.
 * `left > 0` keeps a dead boss out, `max > 0` keeps a zeroed account out, and exactly 20 %
 * is furious.
 */
export function isFurious(
  boss: Pick<BossAccount, 'parts' | 'partsMax' | 'coreHp' | 'coreHpMax'>,
  raidSize: number,
  tier: number,
): boolean {
  const { left, max } = fightHp(boss, raidSize, tier);
  return max > 0 && left > 0 && left * 100 <= max * FURY_PCT;
}

/**
 * `init.rs::scale_for_incarnation` — part HP at incarnation `n` is `base × (100 + 15 × n)
 * / 100`: LINEAR in `n` on the incarnation-0 shell, not compounding, so the cumulative
 * number is the honest one and incarnation 3 is `+45%`. The program's `u16` saturation
 * (incarnation 41 and up) is a ceiling, not a rule a display could show.
 */
export const SHELL_PCT_PER_INCARNATION = 15;

/**
 * The direction a seat last fired, as a vector whose **major axis is 1** — the exact
 * inverse of `PlayerSlot::set_aim`, and the thing a drawn arrow points along.
 *
 * Not normalised: the caller wants a direction, and the one division it would cost buys
 * nothing a `hypot` at the draw site does not already have to do. Signs come from the
 * sector bits, so a component the encoder quantised to 0 has no sign — that is the
 * encoding, not a bug here.
 *
 * **Only meaningful once `lastShotTick !== 0`.** Before the first shot the byte is 0,
 * which decodes to due +x, and a client must fall back to {@link PlayerSlot.facing}
 * instead (`FACING_UNIT` lives with the sprites, so that fallback is the renderer's).
 * `(x, y)`, `classAim` and `lastShotTick` are between them enough to reconstruct any
 * seat's arrow from account bytes alone — there is no event stream and no projectile on
 * chain.
 */
export function decodeAim(classAim: number): readonly [number, number] {
  const ratio = (classAim & 0x0f) / 15;
  const sector = (classAim >> 4) & 0x07;
  const [x, y] = (sector & 1) !== 0 ? [ratio, 1] : [1, ratio];
  return [(sector & 4) !== 0 ? -x : x, (sector & 2) !== 0 ? -y : y];
}

/** `Boss.target_seat` when nobody is alive in the arena. */
export const NO_TARGET = 0xff;

export const BULLET_FREE = 0;
export const BULLET_ACTIVE = 1;

/** PDA seed prefixes. `arena` also takes `arena_id` as a little-endian u64. */
export const SEED_ARENA = 'arena';
export const SEED_BOSS = 'boss';
export const SEED_PLAYERS = 'players';
export const SEED_LEADERBOARD = 'leaderboard';

// ---------------------------------------------------------------------------
// Offset tables
// ---------------------------------------------------------------------------

export const BULLET = {
  size: 8,
  offsets: { x: 0, y: 2, dx: 4, dy: 5, active: 6 },
} as const;

export const ARENA = {
  discriminator: DISC_ARENA,
  size: 1200,
  rentExemptLamports: 9_242_880n,
  offsets: {
    discriminator: 0,
    version: 1,
    bump: 2,
    phase: 3,
    alive_count: 4,
    bullet_cursor: 5,
    outcome: 6,
    // Was `_pad0`, the same move `outcome` made: no field moved, the account did not grow,
    // `LAYOUT_VERSION` stays 1, and every live account reads 0 here — the solo threshold.
    raid_size: 7,
    arena_id: 8,
    crank_task_id: 16,
    tick: 24,
    enrage_at_tick: 28,
    seat_occupied: 32,
    incarnation: 36,
    // Was the first byte of `_pad1`, the last free byte in the layout: no field moved, the
    // account did not grow, `LAYOUT_VERSION` stays 1, and every live account reads 0 here —
    // `TIER_EASY`, the tuning it was already fighting.
    difficulty: 38,
    crank_authority: 40,
    validator_identity: 72,
    affix_seed: 104,
    bullets: 136,
    // Appended after the bullet pool. Everything above keeps its offset, so a client
    // built against the 1,160-byte layout decodes a 1,200-byte account correctly and
    // simply does not see these two.
    roll_requested_tick: 1160,
    // Claimed out of `_pad2` — no field moved, the account did not grow, and
    // `LAYOUT_VERSION` stays 1. Every account already on chain carries zero here, which
    // is exactly what "no muster scheduled" means, so there is no migration.
    fight_at_tick: 1164,
    next_affix_seed: 1168,
  },
} as const;

export const BOSS = {
  discriminator: DISC_BOSS,
  size: 50,
  rentExemptLamports: 1_238_880n,
  offsets: {
    discriminator: 0,
    version: 1,
    bump: 2,
    vent_open: 3,
    attack_timer: 4,
    target_seat: 5,
    x: 6,
    y: 8,
    core_hp: 10,
    core_hp_max: 12,
    parts: 14,
    parts_max: 32,
  },
} as const;

export const PLAYER_SLOT = {
  size: 96,
  offsets: {
    zone: 0,
    facing: 1,
    skin_id: 2,
    // Was `_pad0`. No field moved and the slot is still 96 bytes; see `classAim`.
    class_aim: 3,
    x: 4,
    y: 6,
    hp: 8,
    hp_max: 10,
    last_move_seq: 12,
    deaths: 14,
    respawn_at_tick: 16,
    last_shot_tick: 20,
    last_move_tick: 24,
    damage_dealt: 28,
    session_pubkey: 32,
    identity: 64,
  },
} as const;

export const PLAYERS = {
  discriminator: DISC_PLAYERS,
  size: 1924,
  rentExemptLamports: 14_281_920n,
  offsets: { discriminator: 0, version: 1, bump: 2, slots: 4 },
} as const;

export const LEADERBOARD_ENTRY = {
  size: 48,
  offsets: {
    arena_id: 0,
    identity: 8,
    damage_dealt: 40,
    incarnation: 44,
    survived: 46,
    outcome: 47,
  },
} as const;

export const LEADERBOARD = {
  discriminator: DISC_LEADERBOARD,
  size: 6176,
  rentExemptLamports: 43_875_840n,
  offsets: {
    discriminator: 0,
    version: 1,
    bump: 2,
    total_written: 8,
    next: 12,
    last_arena_id: 16,
    last_incarnation: 24,
    entries: 32,
  },
} as const;

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

export type Bullet = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** `BULLET_FREE` | `BULLET_ACTIVE`. Free slots still occupy their index. */
  active: number;
};

export type ArenaAccount = {
  bump: number;
  /** `PHASE_*`. */
  phase: number;
  /** `OUTCOME_*`. Undecided until the fight ends, then fixed for the incarnation. */
  outcome: number;
  aliveCount: number;
  bulletCursor: number;
  /**
   * High-water mark of seats that have stood in the arena this incarnation — the raid
   * size both difficulty knobs read: {@link ventPct} and the core top-up. Written only by
   * `boss_tick`, monotone, zeroed with the incarnation.
   */
  raidSize: number;
  /**
   * `TIER_EASY..=TIER_HARD` — the gate the raid's first raider stood in, written by
   * `enter_gate` once per incarnation and read by every balance curve beside `raidSize`.
   * Zeroed with the incarnation. See {@link lockedTier} for whether it binds yet.
   */
  difficulty: number;
  arenaId: bigint;
  crankTaskId: bigint;
  /** The authoritative clock. Also the crank-liveness heartbeat. */
  tick: number;
  enrageAtTick: number;
  /** Bitmask, low `MAX_SEATS` bits. */
  seatOccupied: number;
  incarnation: number;
  crankAuthority: Uint8Array;
  /** Which ER this match lives on. Never resolve your own; use this one. */
  validatorIdentity: Uint8Array;
  /** The seed this incarnation is being fought under. Affixes derive from it. */
  affixSeed: Uint8Array;
  /** All `MAX_BULLETS` slots, index-stable so a renderer can reuse DOM nodes. */
  bullets: Bullet[];
  /** `tick` at which `PHASE_ROLLING` was entered. Meaningful only in that phase. */
  rollRequestedTick: number;
  /**
   * The tick `PHASE_MUSTERING` flips to `PHASE_FIGHTING`. Zero in every other phase.
   * This is what makes twenty browsers agree on when the fight starts without talking to
   * each other: the countdown is `(fightAtTick - tick) * TICK_MS`, and the crank — not a
   * player, a host or the Worker — performs the flip.
   */
  fightAtTick: number;
  /**
   * The VRF seed for the next incarnation, or all-zero for "none" — see `rollSeed`,
   * which is the check the UI should use rather than testing the bytes itself.
   */
  nextAffixSeed: Uint8Array;
};

/**
 * `handlers::shoot::VENT_OPEN`. The core is damageable on this value and on NO other — the
 * program's own comparison is `boss.vent_open != VENT_OPEN => 0`, an equality against this
 * byte rather than a truthiness test, so `!== 0` is a different rule that happens to agree
 * while the crank only ever writes 0 or 1.
 *
 * Exported because it had four spellings: the constant in `shoot.rs`, a private mirror in
 * `Shot.tsx`, and a bare `ventOpen === 1` in `Hud` and `Boss`. One fact stored four times is
 * this repo's signature defect, and every copy of it fails silently.
 *
 * {@link slamLane} is NOT one of them and must not be converted: it mirrors
 * `tick.rs::slam_lane`, whose own test is `vent_open != 0`. Two chain functions, two rules,
 * agreeing only because the crank never writes a byte outside 0..=1.
 */
export const VENT_OPEN = 1;

export type BossAccount = {
  bump: number;
  /** Sealed, or {@link VENT_OPEN}. The core is only damageable while open. */
  ventOpen: number;
  attackTimer: number;
  /** Seat index, or `NO_TARGET`. */
  targetSeat: number;
  x: number;
  y: number;
  coreHp: number;
  coreHpMax: number;
  /** Index-aligned with the hitbox JSON from `tools/svg_slice.py`. */
  parts: number[];
  partsMax: number[];
};

export type PlayerSlot = {
  /** Seat number. Equal to the slot's index; there is no seat field on the wire. */
  seat: number;
  /** All-zero `sessionPubkey` means the seat was never claimed. */
  occupied: boolean;
  zone: number;
  /** The octant 0..7 (0 N ... 7 NW, y down) — the low three bits of the byte, already masked. */
  facing: number;
  /** Bit 3 of the same byte: the last shot was charged. Cleared by the next step. */
  chargedShot: boolean;
  /** Bit 4 of the same byte: the last shot was a super (the beam). Same lifetime. */
  superShot: boolean;
  skinId: number;
  /**
   * Class and last aim, packed — bit 7 class, bits 6..4 aim sector, bits 3..0 aim ratio.
   * Read it through {@link classOf}, {@link shotDamage}, {@link cooldownTicks} and
   * {@link decodeAim} rather than masking it at the call site; 0 is a knight who has not
   * fired, which is every seat that predates the byte.
   */
  classAim: number;
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  /** Echo of the client's input sequence number. Prediction reconciles on this. */
  lastMoveSeq: number;
  /** Times this seat hit 0 HP during the current incarnation. */
  deaths: number;
  respawnAtTick: number;
  lastShotTick: number;
  lastMoveTick: number;
  damageDealt: number;
  sessionPubkey: Uint8Array;
  /** `sha256(privy DID)`. */
  identity: Uint8Array;
};

export type PlayersAccount = {
  bump: number;
  slots: PlayerSlot[];
};

export type LeaderboardEntry = {
  arenaId: bigint;
  identity: Uint8Array;
  damageDealt: number;
  incarnation: number;
  survived: boolean;
  /**
   * `OUTCOME_*` — how the *match* ended, not this seat. Without it a win and an
   * enrage-with-survivors are the same row. `OUTCOME_UNDECIDED` on every row written
   * before the field existed: it was padding, so those bytes are zero.
   */
  outcome: number;
};

export type LeaderboardAccount = {
  bump: number;
  totalWritten: number;
  /** Ring write cursor: `entries[next]` is the oldest row and the next to be overwritten. */
  next: number;
  lastArenaId: bigint;
  lastIncarnation: number;
  entries: LeaderboardEntry[];
};

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/**
 * Validate the header the same way the program does before trusting any offset.
 * Reading the wrong account type as the right one is exactly the failure the
 * discriminator exists to stop, and on the client it presents as a frozen or
 * nonsensical world rather than an error.
 */
function open(data: Uint8Array, name: string, disc: number, size: number): DataView {
  if (data.length < size) {
    throw new Error(`${name}: got ${data.length} bytes, need ${size}`);
  }
  if (data[0] !== disc) {
    throw new Error(`${name}: discriminator ${String(data[0])}, expected ${disc}`);
  }
  if (data[1] !== LAYOUT_VERSION) {
    throw new Error(`${name}: layout version ${String(data[1])}, expected ${LAYOUT_VERSION}`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function bytes(data: Uint8Array, offset: number, length: number): Uint8Array {
  return data.slice(offset, offset + length);
}

function isZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}

export function decodeArena(data: Uint8Array): ArenaAccount {
  const o = ARENA.offsets;
  const v = open(data, 'Arena', ARENA.discriminator, ARENA.size);

  const bullets: Bullet[] = [];
  for (let i = 0; i < MAX_BULLETS; i++) {
    const b = o.bullets + i * BULLET.size;
    bullets.push({
      x: v.getInt16(b + BULLET.offsets.x, true),
      y: v.getInt16(b + BULLET.offsets.y, true),
      dx: v.getInt8(b + BULLET.offsets.dx),
      dy: v.getInt8(b + BULLET.offsets.dy),
      active: v.getUint8(b + BULLET.offsets.active),
    });
  }

  return {
    bump: v.getUint8(o.bump),
    phase: v.getUint8(o.phase),
    outcome: v.getUint8(o.outcome),
    aliveCount: v.getUint8(o.alive_count),
    bulletCursor: v.getUint8(o.bullet_cursor),
    raidSize: v.getUint8(o.raid_size),
    difficulty: v.getUint8(o.difficulty),
    arenaId: v.getBigUint64(o.arena_id, true),
    crankTaskId: v.getBigInt64(o.crank_task_id, true),
    tick: v.getUint32(o.tick, true),
    enrageAtTick: v.getUint32(o.enrage_at_tick, true),
    seatOccupied: v.getUint32(o.seat_occupied, true),
    incarnation: v.getUint16(o.incarnation, true),
    crankAuthority: bytes(data, o.crank_authority, 32),
    validatorIdentity: bytes(data, o.validator_identity, 32),
    affixSeed: bytes(data, o.affix_seed, 32),
    bullets,
    rollRequestedTick: v.getUint32(o.roll_requested_tick, true),
    fightAtTick: v.getUint32(o.fight_at_tick, true),
    nextAffixSeed: bytes(data, o.next_affix_seed, 32),
  };
}

export function decodeBoss(data: Uint8Array): BossAccount {
  const o = BOSS.offsets;
  const v = open(data, 'Boss', BOSS.discriminator, BOSS.size);

  const parts: number[] = [];
  const partsMax: number[] = [];
  for (let i = 0; i < N_PARTS; i++) {
    parts.push(v.getUint16(o.parts + i * 2, true));
    partsMax.push(v.getUint16(o.parts_max + i * 2, true));
  }

  return {
    bump: v.getUint8(o.bump),
    ventOpen: v.getUint8(o.vent_open),
    attackTimer: v.getUint8(o.attack_timer),
    targetSeat: v.getUint8(o.target_seat),
    x: v.getInt16(o.x, true),
    y: v.getInt16(o.y, true),
    coreHp: v.getUint16(o.core_hp, true),
    coreHpMax: v.getUint16(o.core_hp_max, true),
    parts,
    partsMax,
  };
}

export function decodePlayers(data: Uint8Array): PlayersAccount {
  const o = PLAYERS.offsets;
  const p = PLAYER_SLOT.offsets;
  const v = open(data, 'Players', PLAYERS.discriminator, PLAYERS.size);

  const slots: PlayerSlot[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    const s = o.slots + seat * PLAYER_SLOT.size;
    const sessionPubkey = bytes(data, s + p.session_pubkey, 32);
    const facingByte = v.getUint8(s + p.facing);
    slots.push({
      seat,
      occupied: !isZero(sessionPubkey),
      zone: v.getUint8(s + p.zone),
      facing: facingByte & 7,
      chargedShot: ((facingByte >> CHARGED_SHOT_BIT) & 1) === 1,
      superShot: ((facingByte >> SUPER_SHOT_BIT) & 1) === 1,
      skinId: v.getUint8(s + p.skin_id),
      classAim: v.getUint8(s + p.class_aim),
      x: v.getInt16(s + p.x, true),
      y: v.getInt16(s + p.y, true),
      hp: v.getUint16(s + p.hp, true),
      hpMax: v.getUint16(s + p.hp_max, true),
      lastMoveSeq: v.getUint16(s + p.last_move_seq, true),
      deaths: v.getUint16(s + p.deaths, true),
      respawnAtTick: v.getUint32(s + p.respawn_at_tick, true),
      lastShotTick: v.getUint32(s + p.last_shot_tick, true),
      lastMoveTick: v.getUint32(s + p.last_move_tick, true),
      damageDealt: v.getUint32(s + p.damage_dealt, true),
      sessionPubkey,
      identity: bytes(data, s + p.identity, 32),
    });
  }

  return { bump: v.getUint8(o.bump), slots };
}

export function decodeLeaderboard(data: Uint8Array): LeaderboardAccount {
  const o = LEADERBOARD.offsets;
  const e = LEADERBOARD_ENTRY.offsets;
  const v = open(data, 'Leaderboard', LEADERBOARD.discriminator, LEADERBOARD.size);

  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < LEADERBOARD_CAP; i++) {
    const b = o.entries + i * LEADERBOARD_ENTRY.size;
    entries.push({
      arenaId: v.getBigUint64(b + e.arena_id, true),
      identity: bytes(data, b + e.identity, 32),
      damageDealt: v.getUint32(b + e.damage_dealt, true),
      incarnation: v.getUint16(b + e.incarnation, true),
      survived: v.getUint8(b + e.survived) === 1,
      outcome: v.getUint8(b + e.outcome),
    });
  }

  return {
    bump: v.getUint8(o.bump),
    totalWritten: v.getUint32(o.total_written, true),
    next: v.getUint32(o.next, true),
    lastArenaId: v.getBigUint64(o.last_arena_id, true),
    lastIncarnation: v.getUint16(o.last_incarnation, true),
    entries,
  };
}

/**
 * Seats a match may still hand out.
 *
 * Bit `n` of `Arena.seat_occupied` is seat `n`, low bit first. That bit order is a
 * layout fact, and the Worker's seat allocator and the client's lobby roster must
 * not each rediscover it.
 */
/**
 * The next incarnation's VRF seed, or `null` when the oracle never answered.
 *
 * All-zero is the "no seed" sentinel and it is also the *verification*: the only writer
 * of these bytes is the tag-14 callback, which the scoped VRF identity signs. So a
 * non-null return means a proof was verified on chain, and the UI needs no second flag —
 * which is exactly why it should call this rather than testing the bytes itself, in two
 * components, one of which will eventually test `!== undefined`.
 */
export function rollSeed(arena: ArenaAccount): Uint8Array | null {
  return isZero(arena.nextAffixSeed) ? null : arena.nextAffixSeed;
}

/**
 * The tick at which `boss_tick` gives up on a pending roll.
 *
 * `arena.tick` past this and the crank abandons the roll on its next execution, dropping
 * the arena back to `PHASE_SETTLING` with no seed. A countdown must derive its deadline
 * from here rather than adding `ROLL_TIMEOUT_TICKS` itself: the program's comparison is
 * strictly-greater, so a UI that used `>=` would announce the oracle dead one tick early,
 * every time.
 */
export function rollDeadlineTick(arena: ArenaAccount): number {
  return arena.rollRequestedTick + ROLL_TIMEOUT_TICKS;
}

export function freeSeats(seatOccupied: number): number[] {
  const free: number[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    if ((seatOccupied & (1 << seat)) === 0) free.push(seat);
  }
  return free;
}

// ---------------------------------------------------------------------------
// Derived boss behaviour
//
// Not a layout, but the same contract: `Boss` has no padding left, so the hand slam
// stores nothing and every client recomputes it from published state. That makes this a
// mirror of `handlers::tick.rs` exactly as strictly as the offset tables above are a
// mirror of `state.rs` — a client whose copy disagrees draws the wind-up over one column
// and the hand lands on another, with no error anywhere.
// ---------------------------------------------------------------------------

/** Arena-space units per side. `map::MAP_TILES * map::TILE`. */
const ARENA_SIZE = MAP_TILES * MAP_TILE;

/**
 * The boss's volley period — `tick.rs::VOLLEY_INTERVAL_TICKS`.
 *
 * The real gap is 33 ticks, not 32: the timer fires on the tick it reads 0 and then
 * reloads. Mirrored here so a client animation whose length must match the fight's own
 * cadence derives it instead of typing a millisecond count that stops matching the volley
 * the first time anyone tunes balance.
 */
export const VOLLEY_INTERVAL_TICKS = ticksFor(3_200);

/** The same period as a duration, which is the form a renderer wants. */
export const VOLLEY_INTERVAL_MS = VOLLEY_INTERVAL_TICKS * TICK_MS;

/**
 * `state::FURY_VOLLEY_INTERVAL_TICKS` — the volley period while {@link isFurious}: half the
 * normal one, 1.6 s. A telegraph that keeps drawing the 3.2 s wind-up through fury is
 * announcing every other volley.
 */
export const FURY_VOLLEY_INTERVAL_TICKS = Math.floor(VOLLEY_INTERVAL_TICKS / 2);

/** Vertical strips the arena is cut into; a slam claims exactly one. */
export const SLAM_LANES = 8;

/** Lane `L` covers world x in `[L * SLAM_LANE_W, L * SLAM_LANE_W + SLAM_LANE_W)`. */
export const SLAM_LANE_W = ARENA_SIZE / SLAM_LANES;

/** One slam every 6 s, resolving on the tick where `tick % SLAM_PERIOD_TICKS === 0`. */
export const SLAM_PERIOD_TICKS = ticksFor(6_000);

/**
 * How long the wind-up is visible before the hand lands. 1.5 s against the worst latency
 * this project has ever measured (1,126 ms) and 480 units of escape at walking speed, so
 * the slam is always dodgeable — which is only true if the client actually draws it.
 */
export const SLAM_TELEGRAPH_TICKS = ticksFor(1_500);

/** `Boss.parts` indices of the two hands. A destroyed hand does not slam. */
export const PART_MACE = 7;
export const PART_CLAWS = 8;

/** With the vent exposed the torso lunges over it, whichever hands are left. */
export const SLAM_VENT_LANE = 4;

const MACE_LANE_FIRST = 1;
const MACE_LANE_COUNT = 3n;
const CLAWS_LANE_FIRST = 5;
const CLAWS_LANE_COUNT = 2n;

const U64 = (1n << 64n) - 1n;

/** SplitMix64, wrapping — `handlers::tick::mix64`, bit for bit. */
function mix64(seed: bigint): bigint {
  let z = (seed + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return z ^ (z >> 31n);
}

/** `u64::from_le_bytes(affix_seed[..8])`. */
function le64(bytes: Uint8Array): bigint {
  let out = 0n;
  for (let i = 7; i >= 0; i--) out = (out << 8n) | BigInt(bytes[i] ?? 0);
  return out & U64;
}

/**
 * The lane a slam lands in **on this exact tick**, or `null` if none does — the mirror of
 * `handlers::tick::slam_lane`.
 *
 * `tick` is the tick the hand *lands* on, not the tick you are rendering. A wind-up tick
 * satisfies `tick % SLAM_PERIOD_TICKS >= SLAM_PERIOD_TICKS - SLAM_TELEGRAPH_TICKS` and
 * divides to the *previous* cycle, so asking this function about it always answers
 * `null`. Use {@link slamTelegraph}, which asks about the next beat; that off-by-one-cycle
 * is the documented trap.
 */
export function slamLane(affixSeed: Uint8Array, tick: number, boss: BossAccount): number | null {
  if (tick % SLAM_PERIOD_TICKS !== 0) return null;
  // `!== 0` and NOT `=== VENT_OPEN`, deliberately: this line mirrors `tick.rs:470`, which is
  // `boss.vent_open != 0`, while {@link VENT_OPEN} is `shoot.rs`'s equality and belongs to
  // the damage rule. The two agree for every byte the crank writes (`u8::from(bool)`), so
  // swapping them is invisible today — which is exactly why it would be a mirror that no
  // longer says what the function it mirrors says.
  if (boss.ventOpen !== 0) return SLAM_VENT_LANE;

  const r = mix64(le64(affixSeed) ^ mix64(BigInt(Math.floor(tick / SLAM_PERIOD_TICKS))));
  const [limb, lane] =
    (r & 1n) === 0n
      ? [PART_MACE, MACE_LANE_FIRST + Number((r >> 1n) % MACE_LANE_COUNT)]
      : [PART_CLAWS, CLAWS_LANE_FIRST + Number((r >> 1n) % CLAWS_LANE_COUNT)];
  return boss.parts[limb] === 0 ? null : lane;
}

/**
 * The slam currently being wound up, or `null` outside the telegraph window.
 *
 * `ticksToImpact` is what a SEEKED animation seeks with:
 * `currentTime = (SLAM_TELEGRAPH_TICKS - ticksToImpact) * TICK_MS`. The lane it names is
 * derived from the *landing* tick, so the wind-up and the hand agree by construction.
 *
 * One honest limit: `ventOpen` is read as of now, and the chain reads it at the landing
 * tick. A vent that opens inside the last 1.5 s moves the lane under a drawn wind-up. It
 * cannot be fixed from published state, and it is one cycle.
 */
export function slamTelegraph(
  arena: ArenaAccount,
  boss: BossAccount,
): { lane: number; atTick: number; ticksToImpact: number } | null {
  if (arena.phase !== PHASE_FIGHTING) return null;
  if (arena.tick % SLAM_PERIOD_TICKS < SLAM_PERIOD_TICKS - SLAM_TELEGRAPH_TICKS) return null;
  const atTick = (Math.floor(arena.tick / SLAM_PERIOD_TICKS) + 1) * SLAM_PERIOD_TICKS;
  const lane = slamLane(arena.affixSeed, atTick, boss);
  return lane === null ? null : { lane, atTick, ticksToImpact: atTick - arena.tick };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * Encode a struct, decode it, and assert the two agree.
 *
 * The decoders here are the whole trust boundary with the program: an offset wrong by one
 * byte is not an error, it is a match that renders plausibly and wrongly. Rust proves its
 * side with `offset_of!` assertions in `state.rs`; this is the same proof on this side,
 * and it is why every field below is written at `X.offsets.<rust field name>` and read
 * back through the real decoder rather than compared to a second copy of the numbers.
 *
 * Runnable, no framework — bundled first because this package is written for a bundler
 * and Node cannot resolve its extensionless imports:
 *
 *   ./app/node_modules/.bin/esbuild packages/client/src/layout.ts --bundle --format=esm \
 *     --outfile=/tmp/layout.mjs && node -e \
 *     "import('/tmp/layout.mjs').then(m => { m.layoutSelfCheck(); console.log('OK') })"
 */
export function layoutSelfCheck(): void {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`layout self-check: ${what}`);
  };

  const blank = (size: number, disc: number): { data: Uint8Array; v: DataView } => {
    const data = new Uint8Array(size);
    data[0] = disc;
    data[1] = LAYOUT_VERSION;
    data[2] = 7; // bump
    return { data, v: new DataView(data.buffer) };
  };

  // Arena — `fight_at_tick` is the one field added this slice, claimed out of `_pad2`.
  // The neighbours are written to distinct values on purpose: an offset that slid by four
  // would read `roll_requested_tick` or the first word of `next_affix_seed` and both are
  // plausible tick numbers.
  {
    const { data, v } = blank(ARENA.size, DISC_ARENA);
    const o = ARENA.offsets;
    v.setUint8(o.phase, PHASE_MUSTERING);
    v.setUint8(o.outcome, OUTCOME_WIPE);
    v.setUint8(o.raid_size, 13);
    v.setUint32(o.tick, 1_234, true);
    v.setUint32(o.enrage_at_tick, 0, true); // zero for the whole muster, by design
    v.setUint16(o.incarnation, 0x0102, true);
    v.setUint8(o.difficulty, TIER_HARD);
    data[o.crank_authority] = 0xcc;
    v.setUint32(o.roll_requested_tick, 111, true);
    v.setUint32(o.fight_at_tick, 1_434, true);
    data[o.next_affix_seed] = 0xab;
    const a = decodeArena(data);
    ok(a.phase === PHASE_MUSTERING, 'phase 6 decodes as MUSTERING');
    // `raid_size` is the reinterpreted `_pad0` at offset 7, between `outcome` and the low
    // byte of `arena_id`; both neighbours are plausible small numbers, so both are pinned.
    ok(a.raidSize === 13, 'raidSize reads offset 7');
    ok(a.outcome === OUTCOME_WIPE, 'raidSize did not eat outcome');
    ok(a.arenaId === 0n, 'nor the low byte of arena_id');
    // `difficulty` is the first byte of what was `_pad1` at offset 38, between the high
    // byte of `incarnation` and the first byte of `crank_authority` — a decoder one byte
    // off reads 0x01 or 0xcc, both of them plausible tiers to a clamp, so both are pinned.
    ok(a.difficulty === TIER_HARD, 'difficulty reads offset 38');
    ok(a.incarnation === 0x0102, 'difficulty did not eat the high byte of incarnation');
    ok(a.crankAuthority[0] === 0xcc, 'nor the first byte of crank_authority');
    ok(lockedTier(a) === TIER_HARD, 'a counted raid is locked to its tier');
    ok(lockedTier({ raidSize: 0, aliveCount: 1, difficulty: TIER_MEDIUM }) === TIER_MEDIUM, 'so is one with a raider through');
    ok(lockedTier({ raidSize: 0, aliveCount: 0, difficulty: TIER_HARD }) === null, 'an unopened raid is nobody\'s yet');
    for (let tier = 0; tier < N_TIERS; tier++) {
      const solo = VENT_PCT_SOLO_BY_TIER[tier]!;
      const full = VENT_PCT_FULL_BY_TIER[tier]!;
      ok(
        ventPct(a.raidSize, tier) === solo - Math.floor(((solo - full) * 12) / (MAX_SEATS - 1)),
        `tier ${tier}: the threshold follows the raid`,
      );
      ok(ventPct(0, tier) === solo && ventPct(1, tier) === solo, `tier ${tier}: an uncounted raid is a solo raid`);
      ok(ventPct(MAX_SEATS, tier) === full && ventPct(255, tier) === full, `tier ${tier}: a full raid, and anything past it`);
      // The bound is the slope rounded up, as the Rust test derives it: the endpoints have
      // moved three times and the literal `2` this was permitted a 30-point curve, not a 63.
      const slopeCeil = Math.ceil((solo - full) / (MAX_SEATS - 1));
      for (let n = 1; n < MAX_SEATS; n++) {
        ok(ventPct(n, tier) >= ventPct(n + 1, tier) && ventPct(n, tier) - ventPct(n + 1, tier) <= slopeCeil, `tier ${tier}: ventPct is linear at ${n}`);
      }
      // Incoming damage: the third raid-size knob, the same clamp, monotone between, and
      // the tier's multiple of EASY at every raid size.
      const mul = INCOMING_MUL_BY_TIER[tier]!;
      ok(bulletDamage(0, tier) === 2 * mul && bulletDamage(1, tier) === 2 * mul && slamDamage(0, tier) === 15 * mul, `tier ${tier}: solo takes 2 / 15 times ${mul}`);
      ok(bulletDamage(MAX_SEATS, tier) === 8 * mul && slamDamage(MAX_SEATS, tier) === 45 * mul, `tier ${tier}: twenty take 8 / 45 times ${mul}`);
      ok(bulletDamage(255, tier) === 8 * mul && slamDamage(255, tier) === 45 * mul, `tier ${tier}: and anything past twenty`);
      for (let n = 1; n < MAX_SEATS; n++) {
        ok(bulletDamage(n, tier) <= bulletDamage(n + 1, tier) && slamDamage(n, tier) <= slamDamage(n + 1, tier), `tier ${tier}: damage rises at ${n}`);
      }
      // The core: EASY's 200 + 3,000 per raider is the chain's `core_hp_required`, pinned at
      // both ends; every row's twenty-raider sum fits the `u16` the tick writes it to.
      ok(coreHpRequired(MAX_SEATS, tier) <= 0xffff, `tier ${tier}: twenty raiders' core fits a u16`);
      // Every table is strictly harder than the row below, at every raid size — the whole
      // reason the gates exist, and a tie is a gate that changes nothing.
      if (tier > 0) {
        for (let n = 1; n <= MAX_SEATS; n++) {
          ok(ventPct(n, tier) < ventPct(n, tier - 1), `tier ${tier} asks more shell than ${tier - 1} at ${n}`);
          ok(bulletDamage(n, tier) > bulletDamage(n, tier - 1) && slamDamage(n, tier) > slamDamage(n, tier - 1), `tier ${tier} hits harder than ${tier - 1} at ${n}`);
          ok(coreHpRequired(n, tier) > coreHpRequired(n, tier - 1), `tier ${tier} owes more core than ${tier - 1} at ${n}`);
        }
        ok(FURY_EXTRA_BULLETS_BY_TIER[tier]! > FURY_EXTRA_BULLETS_BY_TIER[tier - 1]!, `tier ${tier} adds more fury bullets`);
      }
    }
    ok(coreHpRequired(0, TIER_EASY) === 200 && coreHpRequired(MAX_SEATS, TIER_EASY) === 57_200, "EASY's core is the chain's 200 + 3,000 per raider");
    ok(ventPct(1, N_TIERS) === ventPct(1, TIER_HARD) && ventPct(1, 255) === ventPct(1, TIER_HARD), 'a byte the chain never writes reads as HARD');
    ok(TIER_NAMES.length === N_TIERS && TIER_COLORS.length === N_TIERS && GATES.length === N_TIERS, 'one name, one colour and one gate per tier');
    ok(a.fightAtTick === 1_434, 'fightAtTick reads offset 1164');
    ok(a.rollRequestedTick === 111, 'fightAtTick did not eat rollRequestedTick');
    ok(a.nextAffixSeed[0] === 0xab, 'fightAtTick did not eat the seed');
    ok((a.fightAtTick - a.tick) * TICK_MS === 20_000, 'a full muster is 20 s of countdown');
    ok(a.enrageAtTick === 0, 'no enrage clock exists during a muster');
    ok(MUSTER_TICKS === 200 && ENRAGE_TICKS === 3_600 && ROLL_TIMEOUT_TICKS === 100, 'ticksFor');
  }

  // Boss — the layout is untouched, but the *meaning* of `parts[i]` was renumbered, and
  // the slam reads indices 7 and 8 by name. A permuted table is silent everywhere else.
  {
    const { data, v } = blank(BOSS.size, DISC_BOSS);
    const o = BOSS.offsets;
    v.setUint8(o.vent_open, 0);
    v.setUint16(o.core_hp, 2_000, true);
    for (let i = 0; i < N_PARTS; i++) {
      v.setUint16(o.parts + i * 2, 100 + i, true);
      v.setUint16(o.parts_max + i * 2, 900 + i, true);
    }
    const b = decodeBoss(data);
    ok(b.parts.length === N_PARTS && b.partsMax.length === N_PARTS, 'nine parts, nine maxima');
    ok(b.parts[PART_MACE] === 107 && b.parts[PART_CLAWS] === 108, 'mace 7 / claws 8');
    ok(b.partsMax[N_PARTS - 1] === 900 + N_PARTS - 1, 'parts_max does not overrun the account');
    ok(b.coreHp === 2_000, 'core hp');

    // Fury, on the solo boss the chain's `fury_tests` use: 18,000 shell, 200 core, vent
    // line at 17,640, so fight HP is 560 and the 20 % line is 112.
    const solo = { parts: Array<number>(N_PARTS).fill(2_000), partsMax: Array<number>(N_PARTS).fill(2_000), coreHp: 200, coreHpMax: 200 };
    const E = TIER_EASY;
    const fh = fightHp(solo, 1, E);
    ok(fh.left === 560 && fh.max === 560, 'fight HP is the strippable shell plus the core');
    ok(fightHp(solo, MAX_SEATS, E).max === 11_900, 'twenty owe 65 % of the shell');
    ok(fightHp(solo, 0, E).left === fightHp(solo, 1, E).left, 'an uncounted raid is a solo raid');
    // The tier moves the line under the same parts: HARD solo owes 12 % of the shell, the
    // chain's `fury_tests` number.
    ok(fightHp(solo, 1, TIER_HARD).max === 2_360, 'a HARD solo owes 12 % of the shell');
    const stripped = { ...solo, parts: Array<number>(N_PARTS).fill(0) };
    ok(fightHp(stripped, 1, E).left === 200, 'below the line only the core is left');
    ok(!isFurious({ ...stripped, coreHp: 118 }, 1, E), '21 % is not furious');
    ok(!isFurious({ ...stripped, coreHp: 113 }, 1, E), 'one point over the line is not furious');
    ok(isFurious({ ...stripped, coreHp: 112 }, 1, E), '20 % is furious');
    ok(!isFurious({ ...stripped, coreHp: 0 }, 1, E), 'a dead boss is not furious');
    ok(!isFurious(solo, 1, E), 'a full shell is nowhere near');
    const empty = { parts: Array<number>(N_PARTS).fill(0), partsMax: Array<number>(N_PARTS).fill(0), coreHp: 0, coreHpMax: 0 };
    ok(fightHp(empty, 0, E).max === 0 && !isFurious(empty, 255, E), 'an empty boss is safe and calm');
    ok(FURY_VOLLEY_INTERVAL_TICKS === 16 && FURY_VOLLEY_INTERVAL_TICKS * 2 === VOLLEY_INTERVAL_TICKS, 'fury halves the volley');
    // The slam, against the chain's algorithm. `mix64` is SplitMix64 and its output for
    // state 0 is a published vector, so this pins the mixer rather than restating it.
    ok(mix64(0n) === 0xe220a8397b1dcdafn, 'mix64 is SplitMix64');
    const seed = new Uint8Array(32).fill(9);
    ok(slamLane(seed, 1, b) === null, 'no slam lands off the beat');
    const lane = slamLane(seed, SLAM_PERIOD_TICKS * 3, b);
    ok(lane !== null, 'a beat with both hands alive lands somewhere');
    ok(lane === 4 || (lane! >= 1 && lane! <= 3) || (lane! >= 5 && lane! <= 6), 'lane is a hand lane');
    ok(SLAM_LANE_W * SLAM_LANES === MAP_TILES * MAP_TILE, 'the lanes tile the arena exactly');

    // A destroyed hand is silent, and an open vent overrides both hands.
    const dead: BossAccount = { ...b, parts: b.parts.map(() => 0) };
    ok(slamLane(seed, SLAM_PERIOD_TICKS * 3, dead) === null, 'a destroyed hand does not slam');
    ok(slamLane(seed, SLAM_PERIOD_TICKS * 3, { ...dead, ventOpen: 1 }) === SLAM_VENT_LANE,
      'an open vent lunges over the centre lane regardless');

    // The trap: a wind-up tick divides to the previous cycle, so the telegraph must ask
    // about the next beat. If this ever passes with `slamLane(seed, tick, b)` the client
    // is drawing the wind-up over the wrong column.
    const windUp = SLAM_PERIOD_TICKS * 3 - SLAM_TELEGRAPH_TICKS;
    const arena = { ...decodeArena(blank(ARENA.size, DISC_ARENA).data), tick: windUp,
      phase: PHASE_FIGHTING, affixSeed: seed };
    const tel = slamTelegraph(arena, b);
    ok(slamLane(seed, windUp, b) === null, 'the wind-up tick itself lands nothing');
    ok(tel !== null && tel.lane === lane, 'the telegraph announces the slam that lands');
    ok(tel !== null && tel.ticksToImpact === SLAM_TELEGRAPH_TICKS, 'the wind-up is 1.5 s long');
    ok(slamTelegraph({ ...arena, tick: windUp - 1 }, b) === null, 'nothing is drawn before it');

  }

  // PlayerSlot — `class_aim` is the one field added this slice, and it is the reinterpreted
  // `_pad0` at offset 3, so a decoder that missed it reads `skin_id` or the low byte of `x`
  // and both are plausible-looking numbers. The 96-byte stride is checked anyway: it is
  // what makes every seat past 0 correct or garbage.
  {
    const { data, v } = blank(PLAYERS.size, DISC_PLAYERS);
    const s = PLAYERS.offsets.slots + 19 * PLAYER_SLOT.size;
    v.setUint8(s + PLAYER_SLOT.offsets.zone, ZONE_ARENA);
    v.setUint8(s + PLAYER_SLOT.offsets.facing, 3 | (1 << CHARGED_SHOT_BIT)); // SE, charged
    const s1 = PLAYERS.offsets.slots + 1 * PLAYER_SLOT.size;
    v.setUint8(s1 + PLAYER_SLOT.offsets.facing, 6 | (1 << SUPER_SHOT_BIT)); // W, super
    v.setUint8(s + PLAYER_SLOT.offsets.skin_id, 2);
    v.setUint8(s + PLAYER_SLOT.offsets.class_aim, CLASS_MASK | 0x38); // archer, aiming (1, -2)
    v.setInt16(s + PLAYER_SLOT.offsets.x, 512, true);
    v.setInt16(s + PLAYER_SLOT.offsets.y, 500, true);
    v.setUint32(s + PLAYER_SLOT.offsets.respawn_at_tick, 77, true);
    data[s + PLAYER_SLOT.offsets.session_pubkey] = 1;
    const p = decodePlayers(data);
    const last = p.slots[MAX_SEATS - 1]!;
    ok(p.slots.length === MAX_SEATS, 'twenty seats');
    ok(last.occupied && last.zone === ZONE_ARENA && last.skinId === 2, 'seat 19 lands on stride');
    ok(last.x === 512 && last.y === 500 && last.respawnAtTick === 77, 'seat 19 fields');
    // One byte, two fields: the octant is the low three bits and the flag is bit 3. A
    // renderer that indexed an eight-entry table with the raw byte would read past it on
    // every charged shot.
    ok(last.facing === 3 && last.chargedShot, 'facing is the octant, chargedShot is bit 3');
    ok(!last.superShot, 'a charged shot is not a super');
    ok(p.slots[1]!.facing === 6 && p.slots[1]!.superShot && !p.slots[1]!.chargedShot, 'superShot is bit 4, alone');
    ok(p.slots[0]!.facing === 0 && !p.slots[0]!.chargedShot && !p.slots[0]!.superShot, 'a zeroed seat faces north, plain');
    ok(!p.slots[18]!.occupied, 'the stride did not smear into seat 18');
    ok(PLAYERS.offsets.slots + MAX_SEATS * PLAYER_SLOT.size <= PLAYERS.size, 'slots fit');

    // The class byte, read back off the wire rather than out of a second copy of itself.
    ok(last.classAim === (CLASS_MASK | 0x38), 'class_aim reads offset 3, not skin_id or x');
    ok(last.skinId === 2, 'and class_aim did not eat skin_id');
    ok(last.x === 512, 'nor the low byte of x');
    ok(classOf(last) === CLASS_ARCHER, 'bit 7 is the class');
    ok(shotDamage(last) === 20 && cooldownTicks(last) === ticksFor(400) - 1, "the archer's numbers");
    const zeroed = p.slots[0]!;
    ok(zeroed.classAim === 0 && classOf(zeroed) === CLASS_KNIGHT, 'a zeroed seat is the knight');
    ok(shotDamage(zeroed) === 40 && cooldownTicks(zeroed) === ticksFor(800) - 1,
      'and fires exactly as it does on devnet today');
  }

  // `decodeAim` — the inverse of `PlayerSlot::set_aim`, and the direction every drawn arrow
  // points along. Pinned against codes computed by hand from the encoder's own arithmetic
  // (`sector = neg_x << 2 | neg_y << 1 | steep`, `ratio = round(min * 15 / max)`) rather
  // than against a fourth copy of the encoder: an encoder here would agree with itself.
  {
    const cases: readonly [number, readonly [number, number], string][] = [
      [0x00, [1, 0], 'a zeroed byte aims due +x — which is why the fallback is `facing`'],
      [0x0f, [1, 1], '(+x, +y) at 45 degrees'],
      [0x10, [0, 1], 'due +y is steep with a zero minor axis'],
      [0x30, [0, -1], 'due -y'],
      [0x40, [-1, 0], 'due -x'],
      [0x6f, [-1, -1], '(-x, -y) at 45 degrees'],
      [0x38, [8 / 15, -1], 'steep, y negative, minor axis quantised to 8/15'],
      [0x48, [-1, 8 / 15], 'shallow, x negative — the same ratio on the other axis'],
    ];
    for (const [code, want, what] of cases) {
      const got = decodeAim(code);
      ok(got[0] === want[0] && got[1] === want[1], `decodeAim(0x${code.toString(16)}): ${what}`);
      // Bit 7 is the class and must not reach the aim. Dropping the mask in either
      // direction is the feature's one silent failure.
      const armed = decodeAim(code | CLASS_MASK);
      ok(armed[0] === got[0] && armed[1] === got[1], 'the class bit is not part of the aim');
    }
    for (let code = 0; code < 256; code++) {
      const [x, y] = decodeAim(code);
      ok(Math.max(Math.abs(x), Math.abs(y)) === 1, `code ${code}: the major axis is exactly 1`);
      ok(Math.min(Math.abs(x), Math.abs(y)) <= 1, `code ${code}: the minor axis is a ratio`);
    }
  }

  // The class table. `controls.ts` and `Hud.tsx` derive their cooldowns from here and may
  // never retype one — a HUD that says READY 600 ms before the gate will send is the second
  // half of "the space bar doesn't work".
  {
    ok(CLASS_KNIGHT === 0, 'class 0 is the knight every live seat already is');
    ok(CLASS_PERIOD_MS.length === N_CLASSES && CLASS_DAMAGE.length === N_CLASSES, 'one row per class');
    ok(CLASS_COOLDOWN_TICKS.length === N_CLASSES, 'and one cooldown per class');
    for (let c = 0; c < N_CLASSES; c++) {
      ok((CLASS_COOLDOWN_TICKS[c]! + 1) * TICK_MS === CLASS_PERIOD_MS[c]!,
        `class ${c}: the cooldown is the period, in ticks, minus one`);
    }
    ok(CLASS_DAMAGE[0]! * (CLASS_COOLDOWN_TICKS[1]! + 1) === CLASS_DAMAGE[1]! * (CLASS_COOLDOWN_TICKS[0]! + 1),
      'the two classes are DPS-neutral, so the boss needs no rescaling');
    ok(CLASS_COOLDOWN_TICKS[0] === 7 && CLASS_COOLDOWN_TICKS[1] === 3, 'ticksFor(800) - 1, ticksFor(400) - 1');
    // The charged multiplier, exact on both rows — the number `showDamage` styles on.
    ok(chargedDamage(CLASS_ARCHER) === 50 && chargedDamage(CLASS_KNIGHT) === 100, '2.5x, both rows');
    for (let c = 0; c < N_CLASSES; c++) {
      ok(Number.isInteger(chargedDamage(c)) && chargedDamage(c) * CHARGED_DEN === CLASS_DAMAGE[c]! * CHARGED_NUM,
        `class ${c}: charged damage divides exactly, as the chain asserts`);
    }
    ok(CHARGE_MS % SLOT_MS === 0 && CHARGE_MS / SLOT_MS === 20, 'the hold is a whole number of ER slots (20)');
    // The super: 5x on both rows, exact, above the charged shot, and a longer hold in slots.
    ok(superDamage(CLASS_ARCHER) === 100 && superDamage(CLASS_KNIGHT) === 200, '5x, both rows');
    for (let c = 0; c < N_CLASSES; c++) {
      ok(superDamage(c) * SUPER_DEN === CLASS_DAMAGE[c]! * SUPER_NUM && superDamage(c) > chargedDamage(c),
        `class ${c}: super damage divides exactly and beats charged`);
    }
    ok(SUPER_MS % SLOT_MS === 0 && SUPER_SLOTS === 50 && SUPER_SLOTS > CHARGE_MS / SLOT_MS, 'the super hold is 50 slots, past the charge');
    // `>` rather than `!==`: both are literal types, and tsc rejects an inequality it can
    // already decide (TS2367). Above the charged bit and inside the byte is the same fact.
    ok(SUPER_SHOT_BIT > CHARGED_SHOT_BIT && SUPER_SHOT_BIT < 8, 'the super bit is its own, off the octant');
  }

  // `mayMoveTo` — the movement rule, not a layout offset, and checked here because it is
  // the one client mirror of `player.rs` a decoder test cannot reach: a disagreement is
  // not a garbled field, it is a legal-looking step the chain refuses, which this project
  // has twice misdiagnosed as lag. Lives beside the decoders because `map.ts` imports
  // nothing and this file already imports `map.ts`.
  {
    const ARENA_ = ZONE_ARENA;
    const LOBBY_ = ZONE_LOBBY;
    // Inside its own box, both zones, including the one-unit seam at the gate.
    ok(mayMoveTo(ARENA_, PIT_TOP, PIT_TOP + 16), 'a raider moves inside the pit');
    ok(mayMoveTo(LOBBY_, PIT_BOT + 1, PIT_BOT + 17), 'a lobby seat moves below the rim');
    ok(!mayMoveTo(ARENA_, PIT_TOP, PIT_TOP - 16), 'a raider cannot walk north out of the pit');
    ok(!mayMoveTo(LOBBY_, PIT_BOT + 1, PIT_BOT), 'a lobby seat cannot walk north over the rim');
    // The seam tiles: the two boxes touch and neither leaves a gap to be stranded in.
    ok(mayMoveTo(ARENA_, PIT_BOT, PIT_BOT), 'PIT_BOT is inside the raider box');
    ok(mayMoveTo(LOBBY_, PIT_BOT + 1, PIT_BOT + 1), 'PIT_BOT + 1 is inside the lobby box');
    // Every gate is inside the lobby box, so a seat standing on one to be flipped is a
    // seat the box lets move; the flip itself lands at an entrance inside the pit's.
    ok(GATES.every((g) => g.minY > PIT_BOT && mayMoveTo(LOBBY_, g.minY, g.maxY)), 'every gate is inside the lobby box, so the flip strands nobody');
    // The un-stranding clause: a seat written outside its box by an older program walks
    // home rather than freezing, and cannot ride the escape the other way.
    ok(mayMoveTo(LOBBY_, 16, 32), 'an out-of-box seat may step back toward its box');
    ok(mayMoveTo(LOBBY_, 16, 5), 'a stranded seat is refused nothing by the box');
    ok(!mayMoveTo(LOBBY_, PIT_BOT + 17, 16), 'but once home it can never step back out');
    // Sideways too, which keeps the same illegal `y`. This assertion used to read `!` and
    // was the last survivor of the strictly-decreasing-overshoot rule `may_move_to` replaced
    // — the one that froze 4,620 stale lobby seats. `mayMoveTo` and `player.rs` have both
    // said "walls alone until you are home" since; only this line still said otherwise, and
    // it contradicted the assertion directly above it.
    ok(mayMoveTo(LOBBY_, 16, 16), 'a stranded seat may step sideways as well');
    let y = 16;
    for (let n = 0; n < 64 && y <= PIT_BOT; n += 1) {
      const ny = y + 16;
      ok(mayMoveTo(LOBBY_, y, ny), 'the walk home never refuses a southward step');
      y = ny;
    }
    ok(y > PIT_BOT, 'the walk home terminates inside the box');
  }
}
