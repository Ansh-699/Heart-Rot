/**
 * SP-COMBAT — the full combat loop (M4), against real devnet.
 *
 * Nobody had ever fired a shot on chain. Every claim about the fight — that a part can be
 * destroyed, that destroying enough of the shell opens the vent, that the core is
 * invulnerable until it does, that a dead core is a recorded WIN distinct from a wipe —
 * was inference from source. This runs it.
 *
 *   init_arena -> rent top-up -> delegate -> claim 2 seats (zero-lamport session keys)
 *   -> walk to the gate -> enter_gate -> pre-position inside the arena (lobby move clock)
 *   -> start_match -> FIGHT -> vent -> core -> WIN -> request_roll -> settle
 *   -> write_leaderboard (twice) -> next_incarnation -> incarnation 2
 *
 * Everything the program is reached through comes from `packages/client`. The two things
 * built locally are a ComputeBudget instruction (no builder exists and none should) and a
 * signer-attaching adapter, both lifted from `sp1_roundtrip.ts`.
 *
 * The firing positions are NOT hardcoded. `station()` below re-implements
 * `shoot.rs::raycast` over the client's own generated `PART_HITBOXES`, `CORE` and wall
 * grid, and searches the map for stations — so the script asks the same geometry the chain
 * answers with, and a lane that does not exist fails here rather than as 300 wasted shots.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp_combat.ts --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/sp_combat.mjs
 *   node /tmp/sp_combat.mjs
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

import {
  AccountRole,
  address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressDecoder,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

import {
  ARENA,
  BOSS,
  BOSS_SPAWN,
  CORE,
  DEVNET_AS_IDENTITY,
  MAP_TILE,
  MAP_TILES,
  MUZZLES,
  N_PARTS,
  OUTCOME_UNDECIDED,
  OUTCOME_WIN,
  PART_HITBOXES,
  PHASE_FIGHTING,
  PHASE_LOBBY,
  PHASE_ROLLED,
  PHASE_ROLLING,
  PHASE_SETTLED,
  PHASE_SETTLING,
  PLAYERS,
  ROUTER_ENDPOINT,
  SYSTEM_PROGRAM_ID,
  ZONE_ARENA,
  claimSeat,
  confirmSignature,
  createRpc,
  decodeArena,
  decodeBoss,
  decodeLeaderboard,
  decodePlayers,
  delegate,
  enterGate,
  getRoutes,
  initArena,
  initLeaderboard,
  isWall,
  leaderboardPda,
  matchPdas,
  movePlayer,
  nextIncarnation,
  requestRoll,
  rollSeed,
  sendInstructions,
  settle,
  shoot,
  startMatch,
  stringifyWithBigints,
  writeLeaderboard,
  type BossAccount,
  type HeartrotRpc,
} from '../../packages/client/src/index';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROGRAM_ID = address('JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5');
const BASE_RPC = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = address('ComputeBudget111111111111111111111111111111');
const TREASURY_KEY = `${homedir()}/.config/heartrot/treasury.json`;

/**
 * Four seats, all even so `player::lobby_spawn` lands them on the 16-unit lattice
 * `walkTo` steps along. Two is what M4 asks for and two is what runs 1 and 2 used; both
 * ran out of clock. `shoot` accepts one shot per seat per two ticks, so two seats is one
 * shot per tick against 343 landed shots needed and a 900-tick enrage — no slack at all
 * for the walk back from a respawn. Four seats is the same claim (every one of them is a
 * freshly generated zero-lamport session key) with the fire rate the fight actually needs.
 */
const SEATS = [0, 2, 4, 6] as const;

/** `shoot.rs::SHOT_DAMAGE`. Not imported — the program does not export balance numbers. */
const SHOT_DAMAGE = 40;
/** `init.rs::BOSS_PARTS_BASE`, incarnation 0. Only used to predict the run, never asserted. */
const PARTS_BASE = [4_000, 2_500, 2_500, 1_000, 1_000, 1_000, 1_000, 2_500, 2_500];

const decodeAddress = getAddressDecoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => Number(process.hrtime.bigint() / 1_000_000n);

const surprises: string[] = [];
const bugs: string[] = [];
function say(...p: unknown[]): void {
  console.log(...p);
}
function surprise(s: string): void {
  surprises.push(s);
  say('  !! ' + s);
}

// ---------------------------------------------------------------------------
// Transaction plumbing (from sp1)
// ---------------------------------------------------------------------------

function withSigners(ix: Instruction, signers: readonly TransactionSigner[]): Instruction {
  const by = new Map(signers.map((s) => [s.address as string, s]));
  return {
    ...ix,
    accounts: (ix.accounts ?? []).map((a) => {
      const s = by.get(a.address as string);
      const isSigner =
        a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER;
      return s !== undefined && isSigner ? { ...a, signer: s } : a;
    }),
  } as Instruction;
}

function computeBudget(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

function systemTransfer(from: TransactionSigner, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const v = new DataView(data.buffer);
  v.setUint32(0, 2, true);
  v.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from.address, role: AccountRole.WRITABLE_SIGNER, signer: from },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  } as Instruction;
}

async function send(
  rpc: HeartrotRpc,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
  step: string,
  timeoutMs = 30_000,
): Promise<string> {
  const t0 = now();
  const sig = await sendInstructions(rpc, feePayer, ixs);
  await confirmSignature(rpc, sig, { timeoutMs, pollMs: 200 });
  say(`  ${step}: ${now() - t0}ms ${sig}`);
  return sig;
}

/** Fire and forget: the fight sends hundreds of these and confirming each one halves the rate. */
async function fire(
  rpc: HeartrotRpc,
  feePayer: TransactionSigner,
  ixs: readonly Instruction[],
): Promise<void> {
  await sendInstructions(rpc, feePayer, ixs);
}

async function readAccount(rpc: HeartrotRpc, a: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  return value === null ? null : new Uint8Array(Buffer.from(value.data[0], 'base64'));
}

async function ownerOf(rpc: HeartrotRpc, a: Address): Promise<string | null> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  return value === null ? null : (value.owner as string);
}

async function lamportsOf(rpc: HeartrotRpc, a: Address): Promise<bigint> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64' }).send();
  return value === null ? 0n : BigInt(value.lamports);
}

// ---------------------------------------------------------------------------
// Geometry — the client's generated tables, walked the way `shoot.rs` walks them
// ---------------------------------------------------------------------------

const TILE = MAP_TILE;
const MAX_RAY_STEPS = 20; // shoot.rs::MAX_RAY_STEPS
/** `shoot.rs::FACING_STEP` / `player.rs::MOVE_STEP` octants: 0 N, 2 E, 4 S, 6 W, y down. */
const STEP: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];
/** Cardinal moves only: they keep a player on the 16-unit lattice their spawn started on. */
const CARDINALS = [0, 2, 4, 6] as const;

type Hit = { kind: 'part'; part: number } | { kind: 'core' } | null;

/** `shoot.rs::raycast`, byte for byte, over the generated boxes the chain uses. */
function raycast(fx: number, fy: number, dir: number, bx: number, by: number, parts: readonly number[]): Hit {
  const [sx, sy] = STEP[dir & 7]!;
  let x = fx;
  let y = fy;
  for (let i = 0; i < MAX_RAY_STEPS; i++) {
    x += sx * TILE;
    y += sy * TILE;
    if (isWall(x, y)) return null;
    const lx = x - bx;
    const ly = y - by;
    for (let p = 0; p < PART_HITBOXES.length; p++) {
      const r = PART_HITBOXES[p]!;
      if (parts[p]! !== 0 && lx >= r.x && lx < r.x + r.w && ly >= r.y && ly < r.y + r.h) {
        return { kind: 'part', part: p };
      }
    }
    const dx = lx - CORE.x;
    const dy = ly - CORE.y;
    if (dx * dx + dy * dy <= CORE.radiusSq) return { kind: 'core' };
  }
  return null;
}

/**
 * Total shell HP a station can strip without moving: the first box the ray meets, then
 * the box behind it once that one detaches, and so on until the lane runs into the core
 * or into open air. This is what makes one walk worth 6,000 damage instead of 1,000.
 *
 * A lane through a **thorn** is worth far more than the thorn's 1,000 HP, and that is the
 * design's own counterplay rather than a scoring hack: `tick::spawn_volley` gates every
 * emitter on `boss.parts[muzzle.part]`, so the four `MUZZLES` are the only reason bullets
 * exist at all. Run 1 of this spike ranked lanes by raw HP, left every thorn standing, and
 * paid for it — nine deaths, and a respawn is a walk of 30+ ticks back to the lane, at
 * 400 ms a step. Run 2 shoots the thorns off first (`THORN_PREMIUM`) and the fight becomes
 * the firing range §2 of the design spec promises.
 */
const THORN_PREMIUM = 4_000;

function laneValue(x: number, y: number, dir: number, bx: number, by: number, parts: readonly number[]): number {
  const virtual = parts.slice();
  const thornsAlive = MUZZLES.some((m) => parts[m.part]! > 0);
  let total = 0;
  for (;;) {
    const hit = raycast(x, y, dir, bx, by, virtual);
    if (hit === null || hit.kind === 'core') return total;
    total += virtual[hit.part]!;
    if (thornsAlive && MUZZLES.some((m) => m.part === hit.part)) total += THORN_PREMIUM;
    virtual[hit.part] = 0;
  }
}

/** BFS over the 16-unit lattice with cardinal steps only — `player.rs::move_player`'s walls. */
function pathTo(from: readonly [number, number], to: readonly [number, number]): number[] | null {
  if (from[0] === to[0] && from[1] === to[1]) return [];
  const key = (x: number, y: number) => `${x},${y}`;
  const prev = new Map<string, { x: number; y: number; dir: number }>();
  const seen = new Set<string>([key(from[0], from[1])]);
  let frontier: [number, number][] = [[from[0], from[1]]];
  const limit = MAP_TILES * MAP_TILES;
  for (let depth = 0; depth < limit && frontier.length > 0; depth++) {
    const next: [number, number][] = [];
    for (const [x, y] of frontier) {
      for (const dir of CARDINALS) {
        const [sx, sy] = STEP[dir]!;
        const nx = x + sx * TILE;
        const ny = y + sy * TILE;
        if (nx < 0 || ny < 0 || nx > MAP_TILES * TILE - 1 || ny > MAP_TILES * TILE - 1) continue;
        if (isWall(nx, ny)) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.add(k);
        prev.set(k, { x, y, dir });
        if (nx === to[0] && ny === to[1]) {
          const out: number[] = [];
          let cx = nx;
          let cy = ny;
          for (;;) {
            const p = prev.get(key(cx, cy));
            if (p === undefined) break;
            out.push(p.dir);
            cx = p.x;
            cy = p.y;
          }
          return out.reverse();
        }
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return null;
}

type Station = {
  pos: [number, number];
  /** Direction whose lane strips shell, and how much it is worth. */
  partDir: number | null;
  partValue: number;
  /** Direction whose first hit is the core, if this station has one. */
  coreDir: number | null;
  steps: number;
};

/**
 * Search the whole floor for the best place to stand, given who is standing where now.
 *
 * `wantCore` prefers a station that can also see the core, so the "core is sealed" proof
 * and the killing blow happen from one position and the run pays for one walk instead of
 * three.
 */
function station(
  from: readonly [number, number],
  bx: number,
  by: number,
  parts: readonly number[],
  wantCore: boolean,
  avoid?: readonly [number, number],
): Station | null {
  let best: Station | null = null;
  let bestScore = -Infinity;
  for (let ty = 1; ty < MAP_TILES - 1; ty++) {
    for (let tx = 1; tx < MAP_TILES - 1; tx++) {
      const x = tx * TILE + (from[0] % TILE);
      const y = ty * TILE + (from[1] % TILE);
      if (isWall(x, y)) continue;
      let partDir: number | null = null;
      let partValue = 0;
      let coreDir: number | null = null;
      for (let d = 0; d < 8; d++) {
        const hit = raycast(x, y, d, bx, by, parts);
        if (hit === null) continue;
        if (hit.kind === 'core') {
          coreDir ??= d;
          continue;
        }
        const v = laneValue(x, y, d, bx, by, parts);
        if (v > partValue) {
          partValue = v;
          partDir = d;
        }
      }
      if (partDir === null && coreDir === null) continue;
      if (wantCore && coreDir === null) continue;
      // Two seats on one tile die to one volley, and a wipe is a loss. Give a taken tile
      // a wide berth rather than forbidding it outright — a lane nobody else can reach is
      // still better than no lane.
      const shared = avoid !== undefined && Math.abs(x - avoid[0]) + Math.abs(y - avoid[1]) < 4 * TILE;
      // Range is worth more than damage. `tick::spawn_volley` fans a volley by rotating
      // the aim vector by `k / SPREAD_DEN` — an *angle* — so at 300 units the outer
      // bullets of a five-shot volley miss a 24-unit-wide player by a wide margin, and
      // the ones that do not are eaten by the corridor walls `wall_at` frees them on.
      // Runs 1 and 2 both stood inside the chamber at ~60 units and were shot down eleven
      // times between them; every death is a 30-tick walk back at one step per tick, and
      // that walk is what lost run 1, not the boss's damage.
      const range = Math.min(Math.abs(x - bx), 320) + Math.min(Math.abs(y - by), 320);
      const raw =
        partValue + (coreDir !== null ? TILE : 0) - (shared ? 2_000 : 0) + 12 * range;
      // Every step of the walk is a tick under fire. 40 a step, so a 40-step trek has to
      // be worth 1,600 before it is worth taking.
      if (raw < bestScore) continue;
      const path = pathTo(from, [x, y]);
      if (path === null) continue;
      const score = raw - 40 * path.length;
      if (score <= bestScore) continue;
      bestScore = score;
      best = { pos: [x, y], partDir, partValue, coreDir, steps: path.length };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

type Live = {
  tick: number;
  phase: number;
  outcome: number;
  aliveCount: number;
  boss: BossAccount;
  pos: Map<number, [number, number]>;
  hp: Map<number, number>;
  zone: Map<number, number>;
  lastShot: Map<number, number>;
  deaths: Map<number, number>;
  damage: Map<number, number>;
};

async function readLive(
  er: HeartrotRpc,
  arena: Address,
  boss: Address,
  players: Address,
): Promise<Live> {
  const [a, b, p] = await Promise.all([
    readAccount(er, arena),
    readAccount(er, boss),
    readAccount(er, players),
  ]);
  const av = decodeArena(a!);
  const bv = decodeBoss(b!);
  const pv = decodePlayers(p!);
  const live: Live = {
    tick: av.tick,
    phase: av.phase,
    outcome: av.outcome,
    aliveCount: av.aliveCount,
    boss: bv,
    pos: new Map(),
    hp: new Map(),
    zone: new Map(),
    lastShot: new Map(),
    deaths: new Map(),
    damage: new Map(),
  };
  for (const seat of SEATS) {
    const s = pv.slots[seat]!;
    live.pos.set(seat, [s.x, s.y]);
    live.hp.set(seat, s.hp);
    live.zone.set(seat, s.zone);
    live.lastShot.set(seat, s.lastShotTick);
    live.deaths.set(seat, s.deaths);
    live.damage.set(seat, s.damageDealt);
  }
  return live;
}

const shell = (b: BossAccount): number => b.parts.reduce((a, v) => a + v, 0);
const shellMax = (b: BossAccount): number => b.partsMax.reduce((a, v) => a + v, 0);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    new Uint8Array(JSON.parse(readFileSync(TREASURY_KEY, 'utf8')) as number[]),
  );
  const sessions = new Map<number, TransactionSigner>();
  for (const seat of SEATS) sessions.set(seat, await generateKeyPairSigner());
  const arenaId = BigInt(process.env.SPC_ARENA_ID ?? Date.now());

  const base = createRpc(BASE_RPC);
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const leaderboard = await leaderboardPda(PROGRAM_ID);

  say(`program   ${PROGRAM_ID}`);
  say(`treasury  ${treasury.address}`);
  say(`arena_id  ${arenaId}`);
  for (const seat of SEATS) say(`seat ${seat} session ${sessions.get(seat)!.address} (zero SOL)`);
  say(`arena ${arena}\nboss ${boss}\nplayers ${players}`);

  // -- 0. the geometry this run depends on, before a lamport is spent ---------
  say('\n[0] preflight: is the fight even reachable from the map?');
  const [bx, by] = BOSS_SPAWN;
  say(`  map::BOSS_SPAWN = (${bx}, ${by}) = tile (${bx / TILE}, ${by / TILE})`);
  {
    const full = PARTS_BASE.slice();
    const total = full.reduce((a, v) => a + v, 0);
    const strip = station([512, 512], bx, by, full, false);
    const core = station([512, 512], bx, by, full, true);
    say(`  best shell lane: ${strip === null ? 'NONE' : `score ${strip.partValue} from (${strip.pos})`}`);
    say(`  core station with a full shell: ${core === null ? 'NONE' : `(${core.pos}) dir ${core.coreDir}`}`);
    if (core === null) surprise('no station can see the core — the kill condition is unreachable');
    say(`  shell ${total}, vent opens once ${Math.ceil((total * 65) / 100)} is removed`);
    say(`  predicted shots: ${Math.ceil((total * 65) / 100 / SHOT_DAMAGE)} shell + ${2_000 / SHOT_DAMAGE} core`);
    // The walk, from where `player::lobby_spawn` and `tick::entrance_for` actually put
    // these seats. A gate the lobby cannot reach is a match that can never start, and it
    // costs nothing to find that out before `init_arena` spends rent.
    for (const seat of SEATS) {
      const lobby: [number, number] = [28 * TILE + (seat - 10) * 24, 52 * TILE];
      const toGate = pathTo(lobby, [30 * TILE, 30 * TILE]);
      say(`  seat ${seat}: lobby_spawn (${lobby}) -> gate in ${toGate === null ? 'NO PATH' : `${toGate.length} steps`}`);
      if (toGate === null) surprise(`seat ${seat} cannot walk from its lobby spawn to the gate`);
    }
  }
  if (process.env.SPC_DRY === '1') {
    say('\nSPC_DRY=1: preflight only, nothing sent.');
    return;
  }

  // -- 1. base layer ---------------------------------------------------------
  say('\n[1] base layer init');
  if ((await readAccount(base, leaderboard)) === null) {
    await send(
      base,
      treasury,
      [initLeaderboard({ programId: PROGRAM_ID, payer: treasury.address, leaderboard })],
      'init_leaderboard',
    );
  } else say('  leaderboard exists');

  await send(
    base,
    treasury,
    [
      initArena({
        programId: PROGRAM_ID,
        payer: treasury.address,
        arena,
        boss,
        players,
        arenaId,
        incarnation: 0,
        validatorIdentity: DEVNET_AS_IDENTITY,
        crankAuthority: treasury.address,
      }),
    ],
    'init_arena',
  );

  {
    const b = decodeBoss((await readAccount(base, boss))!);
    say(`  boss spawned at (${b.x}, ${b.y}) core_hp=${b.coreHp} shell=${shell(b)}`);
    if (b.x !== bx || b.y !== by) {
      bugs.push(`init_arena spawned the boss at (${b.x},${b.y}), not map::BOSS_SPAWN (${bx},${by})`);
      surprise(`boss spawned at (${b.x},${b.y}), the map says (${bx},${by})`);
    }
  }

  const topUps: Instruction[] = [];
  for (const [acct, want] of [
    [arena, ARENA.rentExemptLamports],
    [boss, BOSS.rentExemptLamports],
    [players, PLAYERS.rentExemptLamports],
  ] as const) {
    const deficit = want - (await lamportsOf(base, acct));
    if (deficit > 0n) topUps.push(systemTransfer(treasury, acct, deficit));
  }
  if (topUps.length > 0) await send(base, treasury, topUps, 'rent_topup');

  const delegateIx = await delegate({
    programId: PROGRAM_ID,
    payer: treasury.address,
    arena,
    boss,
    players,
  });
  await send(base, treasury, [computeBudget(1_400_000), delegateIx], 'delegate');

  // -- 2. the ER -------------------------------------------------------------
  say('\n[2] resolve the ER');
  const routes = await getRoutes(ROUTER_ENDPOINT);
  const route = routes.find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('devnet-as absent from getRoutes');
  const er = createRpc(route.fqdn);
  say(`  ${route.identity} -> ${route.fqdn}`);

  // -- 3. seats --------------------------------------------------------------
  say('\n[3] claim seats');
  for (const seat of SEATS) {
    const identity = new Uint8Array(createHash('sha256').update(`sp-combat-${seat}`).digest());
    const ix = withSigners(
      claimSeat({
        programId: PROGRAM_ID,
        arena,
        players,
        treasury: treasury.address,
        seat,
        skinId: 1,
        sessionPubkey: sessions.get(seat)!.address,
        identity,
      }),
      [treasury],
    );
    for (let attempt = 1; ; attempt++) {
      try {
        await send(er, sessions.get(seat)!, [ix], `claim_seat ${seat}`, 20_000);
        break;
      } catch (e) {
        if (attempt >= 40) throw e;
        await sleep(500);
      }
    }
  }

  // -- 4. walk to the gate, enter, pre-position ------------------------------
  //
  // All of this happens in PHASE_LOBBY on purpose. `player::move_clock` rate-limits on
  // the ER's 50 ms slot clock while the arena is in the lobby and on `Arena.tick` (400 ms)
  // once it is fighting, so every step taken before `start_match` is eight times cheaper
  // than the same step taken after it — and the enrage timer has not started.
  say('\n[4] walk to the gate and pre-position (lobby clock)');

  const seq = new Map<number, number>(SEATS.map((s) => [s, 0]));

  /**
   * Walk `seat` to `target`, one accepted step at a time.
   *
   * Re-plans from the position actually observed on chain after every step rather than
   * following a path laid out in advance. That is not defensive coding, it is the only
   * shape that works here: a fire-and-forget `move` gives no acknowledgement, so a resend
   * of a step that had in fact landed applies a *second* step — and in the lobby, where
   * `player::move_clock` limits on the 50 ms slot clock rather than on `Arena.tick`, the
   * resend almost always lands. Chasing a pre-computed waypoint the seat has already
   * walked past is how the third attempt at this spike wandered four seats around the
   * dungeon until it was killed. Re-planning costs one BFS over 4,096 tiles per step and
   * is correct against a double-applied move, a rejected one, and a death mid-walk.
   */
  async function walkTo(seat: number, target: readonly [number, number]): Promise<boolean> {
    const session = sessions.get(seat)!;
    const budget = 4 * MAP_TILES;
    for (let step = 0; step < budget; step++) {
      const p = decodePlayers((await readAccount(er, players))!).slots[seat]!;
      if (p.x === target[0] && p.y === target[1]) return true;
      // Killed mid-walk: `boss_tick` has teleported this seat to its door, so the plan is
      // stale. The caller decides whether the station is still worth walking to.
      if (p.hp === 0) return false;
      const path = pathTo([p.x, p.y], target);
      if (path === null || path.length === 0) {
        surprise(`seat ${seat}: no walkable path from (${p.x},${p.y}) to (${target})`);
        return false;
      }
      const dir = path[0]!;
      const n = (seq.get(seat)! + 1) & 0xffff;
      seq.set(seat, n);
      await fire(er, session, [
        movePlayer({ programId: PROGRAM_ID, arena, players, session: session.address, seat, dir, seq: n }),
      ]);
      // Wait for *any* change, not for a predicted destination: one accepted move is one
      // accepted move whatever it did to the coordinates.
      const deadline = now() + 1_200;
      for (;;) {
        const q = decodePlayers((await readAccount(er, players))!).slots[seat]!;
        if (q.x !== p.x || q.y !== p.y || q.hp === 0) break;
        if (now() > deadline) break;
        await sleep(40);
      }
    }
    surprise(`seat ${seat}: could not reach (${target}) in ${budget} steps`);
    return false;
  }

  // The gate block is `player.rs`'s tiles 30..33 on both axes; its top-left corner is on
  // every even seat's lattice.
  const GATE: [number, number] = [30 * TILE, 30 * TILE];
  for (const seat of SEATS) {
    await walkTo(seat, GATE);
    await send(
      er,
      sessions.get(seat)!,
      [
        enterGate({
          programId: PROGRAM_ID,
          arena,
          players,
          session: sessions.get(seat)!.address,
          seat,
        }),
      ],
      `enter_gate ${seat}`,
    );
  }

  {
    const live = await readLive(er, arena, boss, players);
    for (const seat of SEATS) {
      say(`  seat ${seat}: zone=${live.zone.get(seat)} pos=(${live.pos.get(seat)}) hp=${live.hp.get(seat)}`);
      if (live.zone.get(seat) !== ZONE_ARENA) surprise(`seat ${seat} is not in the arena after enter_gate`);
    }
    say(`  alive_count=${live.aliveCount}`);
  }

  // Seat SEATS[0] takes the station that can see the core: it runs the "sealed vent"
  // proof and lands the killing blow from the same tile. Seat SEATS[1] takes the richest
  // shell lane on the map.
  const stations = new Map<number, Station>();
  {
    const live = await readLive(er, arena, boss, players);
    const parts = live.boss.parts.slice();
    // Seat SEATS[0] gets the station that can also see the core, so the sealed-vent proof
    // and the killing blow are the same tile. Everyone else takes the best shell lane that
    // is not on top of a seat already placed — two seats on one tile die to one volley.
    for (const [index, seat] of SEATS.entries()) {
      const taken = index === 0 ? undefined : stations.get(SEATS[index - 1])!.pos;
      const found = station(live.pos.get(seat)!, live.boss.x, live.boss.y, parts, index === 0, taken);
      if (found === null) throw new Error(`no firing station for seat ${seat} — see step [0]`);
      stations.set(seat, found);
    }
    for (const seat of SEATS) {
      const s = stations.get(seat)!;
      say(
        `  seat ${seat} -> (${s.pos}) ${s.steps} steps, shell lane dir ${s.partDir} worth ${s.partValue}` +
          `, core dir ${s.coreDir ?? 'none'}`,
      );
    }
  }
  for (const seat of SEATS) await walkTo(seat, stations.get(seat)!.pos);

  // -- 5. the fight ----------------------------------------------------------
  say('\n[5] start_match');
  await send(
    er,
    treasury,
    [startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players })],
    'start_match',
  );
  const tFightStart = now();

  const shots = new Map<number, number>(SEATS.map((s) => [s, 0]));
  const marks: Record<string, number> = {};
  let live = await readLive(er, arena, boss, players);
  const tick0 = live.tick;

  /** One accepted shot per seat per two ticks (`shoot.rs::SHOT_COOLDOWN_TICKS`). */
  async function shootOnce(seat: number, dir: number): Promise<void> {
    const session = sessions.get(seat)!;
    await fire(er, session, [
      shoot({ programId: PROGRAM_ID, arena, boss, players, session: session.address, seat, dir }),
    ]);
    shots.set(seat, shots.get(seat)! + 1);
  }

  // 5a. the core is sealed. Same tile, same direction as the killing blow later.
  say('\n[5a] core with the vent SEALED');
  const coreSeat = SEATS[0];
  const coreDir = stations.get(coreSeat)!.coreDir!;
  {
    const before = live.boss.coreHp;
    const hitFromHere = raycast(
      live.pos.get(coreSeat)![0],
      live.pos.get(coreSeat)![1],
      coreDir,
      live.boss.x,
      live.boss.y,
      live.boss.parts,
    );
    say(`  seat ${coreSeat} at (${live.pos.get(coreSeat)}) dir ${coreDir}: ray hits ${JSON.stringify(hitFromHere)}`);
    say(`  vent_open=${live.boss.ventOpen} core_hp=${before}`);
    let accepted = 0;
    for (let i = 0; i < 6 && accepted < 3; i++) {
      const l = await readLive(er, arena, boss, players);
      if (l.tick >= l.lastShot.get(coreSeat)! + 2) {
        await shootOnce(coreSeat, coreDir);
        accepted++;
      }
      await sleep(450);
    }
    const after = await readLive(er, arena, boss, players);
    say(`  after ${accepted} shots at the core: core_hp=${after.boss.coreHp} last_shot_tick=${after.lastShot.get(coreSeat)}`);
    if (after.boss.coreHp !== before) {
      bugs.push(`core took ${before - after.boss.coreHp} damage with vent_open=${after.boss.ventOpen}`);
      surprise('the core was damageable with the vent SEALED');
    } else say('  core is invulnerable while the vent is sealed — as designed');
    if (after.lastShot.get(coreSeat) === 0) surprise('a sealed-vent core shot did not spend the cooldown');
  }

  // 5b. strip the shell.
  say('\n[5b] stripping the shell');
  const destroyed = new Set<number>();
  let ventTick = -1;
  let winTick = -1;
  let lastLog = 0;
  const nextSend = new Map<number, number>(SEATS.map((s) => [s, 0]));
  const deadline = now() + 12 * 60_000;

  for (;;) {
    live = await readLive(er, arena, boss, players);

    for (let p = 0; p < N_PARTS; p++) {
      if (live.boss.parts[p] === 0 && !destroyed.has(p)) {
        destroyed.add(p);
        const total = [...shots.values()].reduce((a, v) => a + v, 0);
        say(
          `  ** part ${p} DESTROYED at tick ${live.tick} (${total} shots sent, shell ${shell(live.boss)}/${shellMax(live.boss)})`,
        );
      }
    }
    if (ventTick < 0 && live.boss.ventOpen === 1) {
      ventTick = live.tick;
      const total = [...shots.values()].reduce((a, v) => a + v, 0);
      say(`  ** VENT OPEN at tick ${live.tick}: shell ${shell(live.boss)}/${shellMax(live.boss)}, ${total} shots sent`);
      marks.ventTick = live.tick - tick0;
      marks.ventMs = now() - tFightStart;
    }
    if (live.boss.coreHp === 0 && winTick < 0) {
      winTick = live.tick;
      marks.winTick = live.tick - tick0;
      marks.winMs = now() - tFightStart;
      say(`  ** CORE DEAD at tick ${live.tick}: phase=${live.phase} outcome=${live.outcome}`);
      break;
    }
    if (live.phase !== PHASE_FIGHTING) {
      say(`  fight ended in phase ${live.phase} outcome ${live.outcome} at tick ${live.tick}`);
      break;
    }
    if (now() > deadline) {
      surprise('the fight did not finish inside 12 minutes');
      break;
    }

    if (now() - lastLog > 15_000) {
      lastLog = now();
      say(
        `  t=${live.tick} shell=${shell(live.boss)} core=${live.boss.coreHp} vent=${live.boss.ventOpen} ` +
          `parts=[${live.boss.parts.join(',')}] alive=${live.aliveCount} ` +
          `shots=${[...shots.values()].join('/')} deaths=${[...live.deaths.values()].join('/')}`,
      );
    }

    // Both seats act in the same pass. Serial `await`s here would halve the fire rate:
    // one send is a blockhash fetch plus a submit, and the cooldown is 800 ms per seat.
    const volley: Promise<void>[] = [];
    for (const seat of SEATS) {
      if (live.hp.get(seat) === 0) continue; // dead: boss_tick owns the respawn
      const at = live.pos.get(seat)!;
      const wantCore = live.boss.ventOpen === 1;

      const s = stations.get(seat);
      if (s === undefined) {
        const found = station(at, live.boss.x, live.boss.y, live.boss.parts, false);
        if (found === null) {
          surprise(`seat ${seat}: no shell station reachable from (${at})`);
          continue;
        }
        stations.set(seat, found);
        continue;
      }

      // Knocked off station by a respawn: take ONE step back toward the station already
      // chosen, and let the rest of the raid keep firing.
      //
      // Both halves of that are lessons paid for. Re-*choosing* a station from the door
      // livelocked run 2 — the best lane was 41 steps away, the seat died on step 30,
      // respawned at the door and chose the same 41-step lane again, forever. And walking
      // it with the blocking `walkTo` stalled every other seat for the whole journey: run 4
      // spent ticks 221–299 on two shots because one dead seat owned the loop. A raid is
      // four independent players, so the harness has to be four independent players too.
      if (at[0] !== s.pos[0] || at[1] !== s.pos[1]) {
        const back = pathTo(at, s.pos);
        if (back === null || back.length === 0) {
          stations.delete(seat);
          continue;
        }
        const n = (seq.get(seat)! + 1) & 0xffff;
        seq.set(seat, n);
        volley.push(
          fire(er, sessions.get(seat)!, [
            movePlayer({
              programId: PROGRAM_ID,
              arena,
              players,
              session: sessions.get(seat)!.address,
              seat,
              dir: back[0]!,
              seq: n,
            }),
          ]).catch(() => undefined),
        );
        continue;
      }
      let dir = wantCore ? null : s.partDir;
      if (wantCore && s.coreDir !== null) {
        dir = s.coreDir;
      } else if (dir !== null) {
        const hit = raycast(at[0], at[1], dir, live.boss.x, live.boss.y, live.boss.parts);
        if (hit === null || hit.kind === 'core') dir = null;
      }

      if (dir === null) {
        const other = SEATS.find((s) => s !== seat);
        const avoid = other === undefined ? undefined : stations.get(other)?.pos;
        // A seat whose lattice has no line to the core keeps stripping shell rather than
        // standing still: `enter_gate` teleports to `tick::entrance_for(seat)`, which fans
        // ±24 units along the door, so half the seats stand on an 8-mod-16 lattice the
        // core circle is not centred on.
        const fresh =
          station(at, live.boss.x, live.boss.y, live.boss.parts, wantCore, avoid) ??
          (wantCore ? station(at, live.boss.x, live.boss.y, live.boss.parts, false, avoid) : null);
        if (fresh === null) {
          surprise(`seat ${seat}: no ${wantCore ? 'core' : 'shell'} station reachable from (${at})`);
          continue;
        }
        stations.set(seat, fresh);
        say(
          `  seat ${seat} re-stations to (${fresh.pos}) ${fresh.steps} steps, ` +
            `${wantCore ? `core dir ${fresh.coreDir}` : `shell dir ${fresh.partDir} score ${fresh.partValue}`}`,
        );
        await walkTo(seat, fresh.pos);
        continue;
      }

      if (live.tick >= live.lastShot.get(seat)! + 2 && now() >= nextSend.get(seat)!) {
        nextSend.set(seat, now() + 500);
        volley.push(shootOnce(seat, dir).catch(() => undefined));
      }
    }
    await Promise.all(volley);
    await sleep(80);
  }

  // -- 6. the win ------------------------------------------------------------
  say('\n[6] outcome');
  live = await readLive(er, arena, boss, players);
  say(`  phase=${live.phase} outcome=${live.outcome} tick=${live.tick} core_hp=${live.boss.coreHp}`);
  const won = live.phase === PHASE_SETTLING && live.outcome === OUTCOME_WIN;
  if (!won) {
    surprise(`the raid did not record a WIN: phase=${live.phase} outcome=${live.outcome}`);
  } else say('  WIN recorded on chain, distinct from a wipe');
  for (const seat of SEATS) {
    say(
      `  seat ${seat}: damage_dealt=${live.damage.get(seat)} shots_sent=${shots.get(seat)} ` +
        `deaths=${live.deaths.get(seat)} hp=${live.hp.get(seat)}`,
    );
    if (live.damage.get(seat) === 0) surprise(`seat ${seat} accumulated no damage`);
  }
  const dealt = [...live.damage.values()].reduce((a, v) => a + v, 0);
  const removed = shellMax(live.boss) - shell(live.boss) + (live.boss.coreHpMax - live.boss.coreHp);
  say(`  per-seat damage sums to ${dealt}; boss lost ${removed} hp`);
  if (dealt !== removed) surprise(`damage bookkeeping disagrees: seats ${dealt} vs boss ${removed}`);

  // -- 7. VRF roll -----------------------------------------------------------
  say('\n[7] request_roll (tag 13) — the next incarnation ruleset');
  let rolled = false;
  if (won) {
    try {
      const rollIx = withSigners(
        await requestRoll({
          programId: PROGRAM_ID,
          arena,
          players,
          session: sessions.get(SEATS[0])!.address,
          seat: SEATS[0],
        }),
        [sessions.get(SEATS[0])!],
      );
      await send(er, sessions.get(SEATS[0])!, [computeBudget(400_000), rollIx], 'request_roll', 30_000);
      const t0 = now();
      for (;;) {
        const a = decodeArena((await readAccount(er, arena))!);
        if (a.phase === PHASE_ROLLED) {
          rolled = true;
          say(`  ROLLED after ${now() - t0}ms, next_affix_seed=${Buffer.from(rollSeed(a)!).toString('hex')}`);
          break;
        }
        if (a.phase !== PHASE_ROLLING) {
          surprise(`roll abandoned: phase=${a.phase} after ${now() - t0}ms (crank timeout)`);
          break;
        }
        if (now() - t0 > 60_000) {
          surprise('request_roll never fulfilled in 60s');
          break;
        }
        await sleep(500);
      }
    } catch (e) {
      surprise(`request_roll failed: ${String(e).slice(0, 300)}`);
    }
  }

  // -- 8. settle -------------------------------------------------------------
  say('\n[8] settle');
  const throwaway = await generateKeyPairSigner();
  const settleIx = withSigners(
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
    [treasury],
  );
  for (let attempt = 1; ; attempt++) {
    try {
      await send(er, throwaway, [computeBudget(400_000), settleIx], 'settle', 40_000);
      break;
    } catch (e) {
      const a = decodeArena((await readAccount(er, arena))!);
      if (a.phase === PHASE_ROLLING && attempt < 40) {
        await sleep(2_000);
        continue;
      }
      surprise(`settle failed in phase ${a.phase}: ${String(e).slice(0, 300)}`);
      break;
    }
  }

  say('  waiting for the accounts to land back on base...');
  const tSettle = now();
  for (;;) {
    const owners = await Promise.all([ownerOf(base, arena), ownerOf(base, boss), ownerOf(base, players)]);
    if (owners.every((o) => o === PROGRAM_ID)) {
      say(`  back on base after ${now() - tSettle}ms`);
      break;
    }
    if (now() - tSettle > 120_000) {
      surprise(`undelegate did not complete in 120s: ${owners.join(', ')}`);
      break;
    }
    await sleep(1_500);
  }

  {
    const a = decodeArena((await readAccount(base, arena))!);
    say(`  base arena: phase=${a.phase} outcome=${a.outcome} incarnation=${a.incarnation} tick=${a.tick}`);
    if (a.phase !== PHASE_SETTLED) surprise(`base phase is ${a.phase}, expected SETTLED`);
    if (won && a.outcome !== OUTCOME_WIN) {
      bugs.push('the WIN did not survive the commit to the base layer');
      surprise(`base outcome is ${a.outcome}, the ER recorded ${OUTCOME_WIN}`);
    }
  }

  // -- 9. leaderboard, twice -------------------------------------------------
  say('\n[9] write_leaderboard, and again (idempotency)');
  const lbIx = writeLeaderboard({
    programId: PROGRAM_ID,
    payer: treasury.address,
    leaderboard,
    arena,
    players,
  });
  await send(base, treasury, [lbIx], 'write_leaderboard');
  const afterFirst = decodeLeaderboard((await readAccount(base, leaderboard))!);
  say(`  total_written=${afterFirst.totalWritten} next=${afterFirst.next} last=(${afterFirst.lastArenaId},${afterFirst.lastIncarnation})`);
  await send(base, treasury, [lbIx], 'write_leaderboard (retry)');
  const afterSecond = decodeLeaderboard((await readAccount(base, leaderboard))!);
  say(`  total_written=${afterSecond.totalWritten} next=${afterSecond.next}`);
  if (afterSecond.totalWritten !== afterFirst.totalWritten || afterSecond.next !== afterFirst.next) {
    bugs.push('write_leaderboard double-counted a retried settle');
    surprise('settling twice double-counted the leaderboard');
  } else say('  the retry was a no-op — idempotent');

  const mine = afterFirst.entries.filter((e) => e.arenaId === arenaId);
  say(`  rows for this arena: ${mine.length}`);
  for (const row of mine) {
    say(`    incarnation=${row.incarnation} damage=${row.damageDealt} survived=${row.survived}`);
  }
  if (mine.length !== SEATS.length) surprise(`expected ${SEATS.length} leaderboard rows, found ${mine.length}`);

  // -- 10. incarnation 2 -----------------------------------------------------
  say('\n[10] next_incarnation (tag 15)');
  const before = decodeArena((await readAccount(base, arena))!);
  const beforeBoss = decodeBoss((await readAccount(base, boss))!);
  try {
    await send(
      base,
      treasury,
      [
        nextIncarnation({
          programId: PROGRAM_ID,
          payer: treasury.address,
          arena,
          boss,
          players,
          leaderboard,
        }),
      ],
      'next_incarnation',
    );
    const a = decodeArena((await readAccount(base, arena))!);
    const b = decodeBoss((await readAccount(base, boss))!);
    say(`  incarnation ${before.incarnation} -> ${a.incarnation}, phase=${a.phase} outcome=${a.outcome}`);
    say(`  shell ${shell(beforeBoss)}/${shellMax(beforeBoss)} -> ${shell(b)}/${shellMax(b)}  core ${b.coreHp}`);
    say(`  affix_seed ${Buffer.from(before.affixSeed).toString('hex').slice(0, 16)}...`);
    say(`          -> ${Buffer.from(a.affixSeed).toString('hex').slice(0, 16)}...`);
    if (a.phase !== PHASE_LOBBY) surprise(`phase after next_incarnation is ${a.phase}`);
    if (a.incarnation !== before.incarnation + 1) surprise('the incarnation counter did not advance');
    if (Buffer.compare(Buffer.from(a.affixSeed), Buffer.from(before.affixSeed)) === 0) {
      surprise('incarnation 2 carries the SAME affix seed — every incarnation is identical');
    }
    if (shellMax(b) <= shellMax(beforeBoss)) {
      surprise(`incarnation 2 is not harder: shell max ${shellMax(beforeBoss)} -> ${shellMax(b)}`);
    }
    marks.incarnation = a.incarnation;
  } catch (e) {
    if (!rolled) {
      say(`  refused, as designed with no verified seed: ${String(e).slice(0, 200)}`);
    } else {
      surprise(`next_incarnation failed after a verified roll: ${String(e).slice(0, 300)}`);
    }
  }

  // -- summary ---------------------------------------------------------------
  say('\n=== SUMMARY ===');
  say(`arena_id ${arenaId}`);
  say(`shots sent: ${SEATS.map((s) => `seat ${s}=${shots.get(s)}`).join(', ')}`);
  say(`parts destroyed: ${[...destroyed].sort((a, b) => a - b).join(',')}`);
  say(`marks: ${stringifyWithBigints(marks)}`);
  say(`wall clock, start_match -> core dead: ${marks.winMs ?? 'n/a'}ms`);
  say(bugs.length === 0 ? 'no bugs' : `BUGS:\n  - ${bugs.join('\n  - ')}`);
  say(surprises.length === 0 ? 'no surprises' : `SURPRISES:\n  - ${surprises.join('\n  - ')}`);
}

await main();
