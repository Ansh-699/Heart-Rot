/**
 * SP-OUTCOME — the four closing defects (F1, F7, F3, F6), on real devnet.
 *
 * Each phase proves exactly one thing and writes its evidence to the jsonl:
 *
 *   --phase solo      F3 + F6 + the losing half of F1.
 *                     ONE seat. It walks to a tile chosen so the wall is directly
 *                     BEHIND it along the boss's fire line, stands there, dies,
 *                     RESPAWNS, walks back, and the match runs on to ENRAGE at tick
 *                     900 instead of ending on that first death. Every tick of the
 *                     bullet pool is sampled, so each HP drop is attributed to the
 *                     specific bullets that caused it — and a bullet whose step ENDS
 *                     inside a wall while crossing the player is the exact bullet the
 *                     old loop freed before the hit test. Then settle +
 *                     write_leaderboard: one row, outcome = OUTCOME_ENRAGE.
 *
 *   --phase seatless  F7. An arena nobody ever enters, settled straight out of
 *                     PHASE_FIGHTING (the operator recovery edge) and written to the
 *                     leaderboard. It appends ZERO rows, so it must NOT claim the
 *                     ring's (last_arena_id, last_incarnation) key. Checked by
 *                     re-reading the key, and by retrying `--prev`'s write: that
 *                     match's key has to still be standing, which is what keeps its
 *                     retry a no-op instead of a second copy of its rows.
 *
 *   --phase read      F1's verdict. Dumps the raw 48 bytes of a WIN row and a
 *                     non-WIN row side by side. If they differ only in `arena_id`
 *                     the fix did not land and this reports FAIL.
 *
 *   --settle-only <arenaId>   recovery for a stranded arena (tag 9).
 *
 * The WIN half of F1 is not re-implemented here: `sp_combat.ts` already kills the
 * boss and writes its rows, and duplicating its raycast/station search would be a
 * second copy of the fight geometry. Run it between `solo` and `seatless`.
 *
 * Everything the chain is reached through comes from `packages/client`, so a wrong
 * hand-written encoder fails here. No address lookup tables.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/sp_outcome.ts --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/spo.mjs && node /tmp/spo.mjs --phase solo --out /tmp/spo-solo.jsonl
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
  type Signature,
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  LEADERBOARD,
  LEADERBOARD_CAP,
  LEADERBOARD_ENTRY,
  MAP_ENTRANCES,
  MAP_MAX_XY,
  MAX_SEATS,
  OUTCOME_ENRAGE,
  OUTCOME_UNDECIDED,
  OUTCOME_WIN,
  OUTCOME_WIPE,
  PHASE_FIGHTING,
  PHASE_SETTLED,
  ZONE_ARENA,
  assertErIdentity,
  claimSeat,
  confirmSignature,
  createRpc,
  decodeArena,
  decodeBoss,
  decodeLeaderboard,
  decodePlayers,
  delegate,
  enterGate,
  getDelegationStatus,
  getRoutes,
  initArena,
  initLeaderboard,
  isWall,
  leaderboardPda,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
  startMatch,
  writeLeaderboard,
  type Bullet,
  type HeartrotRpc,
  type MatchConnections,
  type PlayerSlot,
} from '../../packages/client/src/index';

// ---------------------------------------------------------------------------
// Constants read off the program, never invented
// ---------------------------------------------------------------------------

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;

/** `player::GATE_MIN_*` / `GATE_MAX_*` — tiles 30..=33 on both axes, in arena units. */
const GATE_MIN = 30 * 16;
const GATE_MAX = 34 * 16 - 1;
/** `player::LOBBY_ENTRANCE` and `LOBBY_SPACING`, used only to log where a seat starts. */
const LOBBY_SPACING = 24;
const STEP = 16;
/** `tick::ENTRANCE_SPACING`. */
const ENTRANCE_SPACING = 24;
/** `tick::RESPAWN_TICKS` — the delay this spike measures the observed respawn against. */
const RESPAWN_TICKS = 8;
/** `tick::BULLET_SPEED`, `tick::PLAYER_HIT_RADIUS`, `tick::BULLET_DAMAGE`. */
const BULLET_SPEED = 48;
const PLAYER_HIT_RADIUS = 12;
const BULLET_DAMAGE = 8;
/** `init::ENRAGE_AT_TICK`. Absolute, so the match ends 900 ticks after `init_arena`. */
const ENRAGE_AT_TICK = 900;
/** `layout.ts::BULLET_ACTIVE` is not exported; `Bullet.active` is 1 when live. */
const BULLET_ACTIVE = 1;

/** The single seat. F3 is about a raid of one, so this is the whole roster. */
const SEAT = 0;

const FIGHT_MS = Number(process.env.SPO_FIGHT_MS ?? 540_000);
/** Fast enough to see every 400 ms tick; the F6 attribution needs consecutive ticks. */
const POLL_MS = Number(process.env.SPO_POLL_MS ?? 280);

const CARDINALS: readonly { dir: number; dx: number; dy: number }[] = [
  { dir: 0, dx: 0, dy: -STEP },
  { dir: 2, dx: STEP, dy: 0 },
  { dir: 4, dx: 0, dy: STEP },
  { dir: 6, dx: -STEP, dy: 0 },
];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};

const outPath = arg('--out') ?? '/tmp/sp_outcome.jsonl';

const jsonSafe = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${JSON.stringify(line, jsonSafe)}\n`);
  console.log(`${line.t} ${event} ${JSON.stringify(fields, jsonSafe)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const loadKeypairBytes = (path: string): Uint8Array =>
  Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);

const OUTCOME_NAME = ['UNDECIDED', 'WIN', 'WIPE', 'ENRAGE'];

// ---------------------------------------------------------------------------
// Geometry the program owns, restated only where the client does not export it
// ---------------------------------------------------------------------------

const clamp = (v: number): number => Math.min(Math.max(v, 0), MAP_MAX_XY);

/** `tick::fans_along_x`. */
const fansAlongX = (ex: number, ey: number): boolean =>
  Math.min(ey, 1024 - ey) <= Math.min(ex, 1024 - ex);

/** `tick::entrance_for` — where `enter_gate` lands a seat and where a respawn returns it. */
function entranceFor(seat: number): [number, number] {
  const doors = MAP_ENTRANCES.length;
  const [ex, ey] = MAP_ENTRANCES[seat % doors] as readonly [number, number];
  const offset =
    (Math.floor(seat / doors) - Math.floor(MAX_SEATS / doors / 2)) * ENTRANCE_SPACING;
  return fansAlongX(ex, ey) ? [clamp(ex + offset), ey] : [ex, clamp(ey + offset)];
}

const onGate = (x: number, y: number): boolean =>
  x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;

/**
 * `tick::bullet_hits` — squared point-to-segment distance against `PLAYER_HIT_RADIUS`,
 * in integers, restated so the spike can *decide* which bullet dealt a hit rather than
 * assume it. Same three cases, same degenerate fallback for a clipped-to-zero sweep.
 */
function bulletHits(
  from: readonly [number, number],
  to: readonly [number, number],
  px: number,
  py: number,
): boolean {
  const sx = to[0] - from[0];
  const sy = to[1] - from[1];
  const wx = px - from[0];
  const wy = py - from[1];
  const len2 = sx * sx + sy * sy;
  const hit2 = PLAYER_HIT_RADIUS * PLAYER_HIT_RADIUS;
  if (len2 === 0) return wx * wx + wy * wy <= hit2;
  const dot = wx * sx + wy * sy;
  let scaled: number;
  if (dot <= 0) scaled = (wx * wx + wy * wy) * len2;
  else if (dot >= len2) scaled = ((wx - sx) * (wx - sx) + (wy - sy) * (wy - sy)) * len2;
  else scaled = (wx * wx + wy * wy) * len2 - dot * dot;
  return scaled <= hit2 * len2;
}

type Sweep = {
  from: [number, number];
  to: [number, number];
  mid: [number, number];
  end: [number, number];
  /** The step ran into a wall: this is the bullet the old loop deleted un-tested. */
  clipped: boolean;
};

/**
 * `tick::step`'s wall clip, verbatim: two point samples 24 units apart, the segment
 * narrowed to whichever survived. `clipped` is the whole point of F6 — under the old
 * loop it meant "freed, and never asked whether it crossed a player".
 */
function sweep(b: Bullet): Sweep {
  const from: [number, number] = [b.x, b.y];
  const to: [number, number] = [b.x + b.dx, b.y + b.dy];
  const mid: [number, number] = [
    Math.trunc((from[0] + to[0]) / 2),
    Math.trunc((from[1] + to[1]) / 2),
  ];
  if (isWall(mid[0], mid[1])) return { from, to, mid, end: from, clipped: true };
  if (isWall(to[0], to[1])) return { from, to, mid, end: mid, clipped: true };
  return { from, to, mid, end: to, clipped: false };
}

/** BFS over the same 16-unit cardinal steps `player::move_player` accepts. */
function pathTo(
  x: number,
  y: number,
  isGoal: (px: number, py: number) => boolean,
): number[] | null {
  const key = (px: number, py: number): string => `${px},${py}`;
  const seen = new Map<string, { from: string; dir: number } | null>();
  seen.set(key(x, y), null);
  let frontier: [number, number][] = [[x, y]];
  for (let depth = 0; depth < 200 && frontier.length > 0; depth += 1) {
    const next: [number, number][] = [];
    for (const [cx, cy] of frontier) {
      for (const { dir, dx, dy } of CARDINALS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx > MAP_MAX_XY || ny > MAP_MAX_XY || isWall(nx, ny)) continue;
        const k = key(nx, ny);
        if (seen.has(k)) continue;
        seen.set(k, { from: key(cx, cy), dir });
        if (isGoal(nx, ny)) {
          const path: number[] = [];
          let cursor = k;
          for (;;) {
            const step = seen.get(cursor);
            if (step == null) break;
            path.push(step.dir);
            cursor = step.from;
          }
          return path.reverse();
        }
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * The F6 station: a tile whose BACK is a solid block, in the boss's line of fire.
 *
 * A bullet covers `BULLET_SPEED` units per tick, so a wall closer than that behind the
 * player is a wall the bullet's step lands *inside* — which is precisely the bullet
 * `tick::step` used to free before the swept player test.
 *
 * "Behind" is the whole 24-unit-wide hit corridor, not a single ray, and it is measured
 * on the dominant axis with the other coordinate held exact. The first version of this
 * sampled one ray at `Math.round(x + ux*t)` and the sub-unit drift walked it into the
 * *neighbouring tile column*: it reported a solid wall for a station whose own column
 * was an open corridor, and the run at that station recorded six clean hits and no
 * clipped ones. Every sample of `PLAYER_HIT_RADIUS` either side, from one eighth of a
 * step to a full step past the player, must be solid — that is what makes the bullet
 * that reaches the player also the bullet that dies in the wall.
 *
 * Reachability is not assumed either — a station the BFS cannot walk to is not a
 * station, and the line back to the boss is sampled so the volley can actually arrive.
 */
type Station = { pos: [number, number]; axis: [number, number]; range: number; steps: number };

/**
 * All of them, nearest first, because one is not enough.
 *
 * A bullet's step length is fixed (`unit_velocity` quantises it into two `i8`s) and the
 * muzzle-to-player distance is fixed while both stand still, so where a step *ends*
 * relative to the player is not a coin flip — it is `distance mod step`, the same value
 * every volley. At the nearest station that value came out just short of the player on
 * every landed bullet, so the hit was on an unclipped segment and F6's case never arose.
 * Stepping one tile along the wall changes both the distance and the aim, and with it the
 * phase. The watch below walks this list until a bullet that dies in the wall lands a hit.
 */
function wallStations(
  fromX: number,
  fromY: number,
  bx: number,
  by: number,
): Station[] {
  const clearLine = (x: number, y: number): boolean => {
    const dist = Math.hypot(x - bx, y - by);
    for (let t = 8; t < dist; t += 8) {
      if (isWall(bx + ((x - bx) * t) / dist, by + ((y - by) * t) / dist)) return false;
    }
    return true;
  };

  const found: Station[] = [];
  for (let x = 0; x <= MAP_MAX_XY; x += STEP) {
    for (let y = 0; y <= MAP_MAX_XY; y += STEP) {
      if (isWall(x, y)) continue;
      const range = Math.hypot(x - bx, y - by);
      // Far enough that a bullet is travelling when it arrives, close enough that the
      // fan is still tight and the walk back from a respawn is affordable.
      if (range < 96 || range > 320) continue;
      const ax = x - bx;
      const ay = y - by;
      const axis: [number, number] =
        Math.abs(ax) >= Math.abs(ay) ? [Math.sign(ax), 0] : [0, Math.sign(ay)];
      const perp: [number, number] = [-axis[1], axis[0]];
      let solid = true;
      for (let t = 8; t <= BULLET_SPEED && solid; t += 8) {
        for (const o of [-PLAYER_HIT_RADIUS, -4, 4, PLAYER_HIT_RADIUS]) {
          if (!isWall(x + axis[0] * t + perp[0] * o, y + axis[1] * t + perp[1] * o)) {
            solid = false;
            break;
          }
        }
      }
      if (!solid) continue;
      if (!clearLine(x, y)) continue;
      const path = pathTo(fromX, fromY, (px, py) => px === x && py === y);
      if (path === null) continue;
      found.push({ pos: [x, y], axis, range: Math.round(range), steps: path.length });
    }
  }
  return found.sort((a, b) => a.steps - b.steps);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function transfer(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: '11111111111111111111111111111111' as Address,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/** `max(Rent::get(), (128 + space) * 6960)` — below this the ER silently refuses the clone. */
const ER_LAMPORTS_PER_BYTE = 6_960n;

async function topUpForEr(
  base: HeartrotRpc,
  treasurySigner: Parameters<typeof sendInstructions>[1],
  accounts: readonly Address[],
): Promise<void> {
  const transfers: Instruction[] = [];
  for (const account of accounts) {
    const { value } = await base.getAccountInfo(account, { encoding: 'base64' }).send();
    if (value === null) throw new Error(`${account} does not exist on the base layer`);
    const space = BigInt(Buffer.from(value.data[0], 'base64').length);
    const needed = (128n + space) * ER_LAMPORTS_PER_BYTE;
    const have = BigInt(value.lamports);
    if (have < needed) transfers.push(transfer(treasurySigner.address, account, needed - have));
  }
  if (transfers.length === 0) return;
  const sig = await sendInstructions(base, treasurySigner, transfers);
  await confirmSignature(base, sig, { timeoutMs: 60_000 });
  log('er_rent_topup', { signature: sig, count: transfers.length });
}

function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

/** The client emits plain address metas, so session keys are signed in by hand. */
async function sendSigned(
  rpc: HeartrotRpc,
  feePayer: Address,
  keyPairs: readonly CryptoKeyPair[],
  instructions: readonly Instruction[],
): Promise<Signature> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransaction([...keyPairs], compileTransaction(message));
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      skipPreflight: true,
    })
    .send();
  return getSignatureFromTransaction(signed);
}

/**
 * Wait for a signature and RETURN its error. `confirmSignature` cannot be used on the ER:
 * it demands `confirmed`/`finalized` and throws on any status carrying a BigInt (M6).
 */
async function erStatus(
  rpc: HeartrotRpc,
  signature: Signature,
  what: string,
  timeoutMs = 25_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status != null) {
      log('er_status', { what, signature, err: status.err, status: status.confirmationStatus });
      return status.err;
    }
    if (Date.now() >= deadline) {
      log('er_status_missing', { what, signature });
      return undefined;
    }
    await sleep(300);
  }
}

async function erOk(
  rpc: HeartrotRpc,
  signature: Signature,
  what: string,
  timeoutMs = 25_000,
): Promise<void> {
  const err = await erStatus(rpc, signature, what, timeoutMs);
  if (err != null) throw new Error(`${what} failed: ${JSON.stringify(err, jsonSafe)}`);
  if (err === undefined) throw new Error(`${what} never appeared`);
}

// ---------------------------------------------------------------------------
// Reading the world
// ---------------------------------------------------------------------------

type Snapshot = {
  tick: number;
  phase: number;
  outcome: number;
  aliveCount: number;
  bullets: Bullet[];
  bossX: number;
  bossY: number;
  targetSeat: number;
  slot: PlayerSlot;
};

async function snapshot(
  rpc: HeartrotRpc,
  arena: Address,
  boss: Address,
  players: Address,
): Promise<Snapshot> {
  const { value } = await rpc
    .getMultipleAccounts([arena, boss, players], { encoding: 'base64' })
    .send();
  const bytes = value.map((v) => {
    if (v === null) throw new Error('an account vanished from the ER');
    return Uint8Array.from(Buffer.from(v.data[0], 'base64'));
  });
  const a = decodeArena(bytes[0] as Uint8Array);
  const b = decodeBoss(bytes[1] as Uint8Array);
  const p = decodePlayers(bytes[2] as Uint8Array);
  return {
    tick: a.tick,
    phase: a.phase,
    outcome: a.outcome,
    aliveCount: a.aliveCount,
    bullets: a.bullets.filter((bl) => bl.active === BULLET_ACTIVE),
    bossX: b.x,
    bossY: b.y,
    targetSeat: b.targetSeat,
    slot: p.slots[SEAT] as PlayerSlot,
  };
}

// ---------------------------------------------------------------------------
// Match setup
// ---------------------------------------------------------------------------

type Treasury = Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;

const treasurySigner = (): Promise<Treasury> =>
  createKeyPairSignerFromBytes(loadKeypairBytes(`${homedir()}/.config/heartrot/treasury.json`));

async function erConnection(): Promise<HeartrotRpc> {
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  await assertErIdentity(er, DEVNET_AS_IDENTITY);
  return er;
}

async function openMatch(
  base: HeartrotRpc,
  treasury: Treasury,
  arenaId: bigint,
): Promise<{ match: MatchConnections; arena: Address; boss: Address; players: Address }> {
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  log('match_pdas', { arenaId: arenaId.toString(), arena, boss, players });

  const initSig = await sendInstructions(base, treasury, [
    setComputeUnitLimit(400_000),
    initArena({
      programId: PROGRAM_ID,
      payer: treasury.address,
      arena,
      boss,
      players,
      arenaId,
      incarnation: 1,
      validatorIdentity: DEVNET_AS_IDENTITY,
      crankAuthority: treasury.address,
    }),
  ]);
  await confirmSignature(base, initSig, { timeoutMs: 60_000 });
  log('init_arena', { signature: initSig });

  await topUpForEr(base, treasury, [arena, boss, players]);

  const delegateSig = await sendInstructions(base, treasury, [
    setComputeUnitLimit(1_400_000),
    await delegate({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await confirmSignature(base, delegateSig, { timeoutMs: 60_000 });
  log('delegate', { signature: delegateSig });

  // The ER clones a delegated account when a transaction first references it, not when
  // it is delegated (SP2), so `connectMatch`'s phase 2 cannot succeed here; the two
  // checks that actually prevent a wrong-ER send are kept and `start_match` proves the
  // clone.
  const er = await erConnection();
  for (;;) {
    const statuses = await Promise.all([arena, boss, players].map((a) => getDelegationStatus(a)));
    if (statuses.every((s) => s.delegationRecord?.authority === DEVNET_AS_IDENTITY)) break;
    await sleep(500);
  }
  const match: MatchConnections = { base, er, erFqdn: '', validatorIdentity: DEVNET_AS_IDENTITY };
  log('delegated', { arenaId: arenaId.toString() });

  const startSig = await sendInstructions(match.er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await erOk(match.er, startSig, 'start_match');
  const armed = await snapshot(match.er, arena, boss, players);
  log('start_match', {
    signature: startSig,
    tick: armed.tick,
    phase: armed.phase,
    bossXy: [armed.bossX, armed.bossY],
  });
  if (armed.phase !== PHASE_FIGHTING) {
    throw new Error(`start_match did not reach PHASE_FIGHTING: phase=${armed.phase}`);
  }
  return { match, arena, boss, players };
}

type Session = { keyPair: CryptoKeyPair; address: Address; identity: Uint8Array };

/** Claim the one seat, walk it to the gate, `enter_gate`. */
async function seatSolo(
  match: MatchConnections,
  treasury: Treasury,
  arena: Address,
  players: Address,
): Promise<Session> {
  const keyPair = await generateKeyPair();
  const session: Session = {
    keyPair,
    address: await getAddressFromPublicKey(keyPair.publicKey),
    identity: crypto.getRandomValues(new Uint8Array(32)),
  };

  const claimSig = await sendInstructions(match.er, treasury, [
    claimSeat({
      programId: PROGRAM_ID,
      arena,
      players,
      treasury: treasury.address,
      seat: SEAT,
      skinId: 0,
      sessionPubkey: session.address,
      identity: session.identity,
    }),
  ]);
  await erOk(match.er, claimSig, `claim_seat ${SEAT}`);
  log('seat_claimed', {
    seat: SEAT,
    session: session.address,
    lobbySpacing: LOBBY_SPACING,
    entrance: entranceFor(SEAT),
  });

  await walk(match, treasury, arena, players, session, onGate, 'to_gate');

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slot = await readSlot(match.er, players);
    if (slot.zone === ZONE_ARENA) break;
    const sig = await sendSigned(
      match.er,
      treasury.address,
      [treasury.keyPair, session.keyPair],
      [enterGate({ programId: PROGRAM_ID, arena, players, session: session.address, seat: SEAT })],
    );
    await erStatus(match.er, sig, 'enter_gate');
    await sleep(800);
  }
  return session;
}

async function readSlot(rpc: HeartrotRpc, players: Address): Promise<PlayerSlot> {
  const { value } = await rpc.getAccountInfo(players, { encoding: 'base64' }).send();
  if (value === null) throw new Error('players vanished');
  return decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64'))).slots[
    SEAT
  ] as PlayerSlot;
}

/** One step per tick toward `isGoal`, re-reading between rounds. Stops if the seat dies. */
async function walk(
  match: MatchConnections,
  treasury: Treasury,
  arena: Address,
  players: Address,
  session: Session,
  isGoal: (x: number, y: number) => boolean,
  what: string,
): Promise<boolean> {
  for (let round = 0; round < 120; round += 1) {
    const slot = await readSlot(match.er, players);
    if (slot.hp === 0) {
      log('walk_died', { what, round, at: [slot.x, slot.y] });
      return false;
    }
    if (isGoal(slot.x, slot.y)) {
      log('walk_done', { what, round, at: [slot.x, slot.y] });
      return true;
    }
    const path = pathTo(slot.x, slot.y, isGoal);
    if (path === null || path.length === 0) {
      log('walk_unreachable', { what, at: [slot.x, slot.y] });
      return false;
    }
    try {
      await sendSigned(
        match.er,
        treasury.address,
        [treasury.keyPair, session.keyPair],
        [
          movePlayer({
            programId: PROGRAM_ID,
            arena,
            players,
            session: session.address,
            seat: SEAT,
            dir: path[0] as number,
            seq: (round % 60_000) + 1,
          }),
        ],
      );
    } catch (error) {
      log('walk_send_failed', { what, round, error: String(error) });
    }
    await sleep(430);
  }
  log('walk_gave_up', { what });
  return false;
}

// ---------------------------------------------------------------------------
// Phase SOLO — F3 (respawn), F6 (the wall-clipped bullet), F1's losing row
// ---------------------------------------------------------------------------

/** One HP drop, attributed to the bullets that were in flight the tick before. */
type Attribution = {
  tick: number;
  hpBefore: number;
  hpAfter: number;
  lost: number;
  at: [number, number];
  hits: { bullet: Sweep; clipped: boolean }[];
  clippedHits: number;
  cleanHits: number;
};

async function phaseSolo(): Promise<void> {
  const treasury = await treasurySigner();
  const base = createRpc(BASE_URL);
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { match, arena, boss, players } = await openMatch(base, treasury, arenaId);
  const session = await seatSolo(match, treasury, arena, players);

  const entered = await snapshot(match.er, arena, boss, players);
  log('seat_entered', {
    tick: entered.tick,
    aliveCount: entered.aliveCount,
    targetSeat: entered.targetSeat,
    at: [entered.slot.x, entered.slot.y],
    expectedEntrance: entranceFor(SEAT),
    zone: entered.slot.zone,
  });
  if (entered.slot.zone !== ZONE_ARENA) throw new Error('the seat never entered the arena');

  const stations = wallStations(entered.slot.x, entered.slot.y, entered.bossX, entered.bossY);
  const station = stations[0];
  if (station === undefined) throw new Error('no wall-backed station is reachable');
  log('wall_stations', {
    count: stations.length,
    first: station,
    all: stations.map((s) => s.pos),
    bossXy: [entered.bossX, entered.bossY],
    note:
      `every sample +-${PLAYER_HIT_RADIUS} across the hit corridor, 8..${BULLET_SPEED} units ` +
      'along `axis` past the player, is solid: a bullet that reaches this tile dies in it',
  });
  const atStation = (x: number, y: number): boolean =>
    x === station.pos[0] && y === station.pos[1];
  await walk(match, treasury, arena, players, session, atStation, 'to_station');

  // ---- the watch --------------------------------------------------------
  const deaths: { tick: number; respawnAt: number; deaths: number }[] = [];
  const respawns: { deathTick: number; seenTick: number; delayTicks: number; at: [number, number]; atEntrance: boolean; hp: number }[] = [];
  const attributions: Attribution[] = [];
  const phaseWhileDead: number[] = [];
  let prev = await snapshot(match.er, arena, boss, players);
  let final = prev;
  let walkingBack = false;
  let movesAfterRespawn = 0;
  const deadline = Date.now() + FIGHT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let s: Snapshot;
    try {
      s = await snapshot(match.er, arena, boss, players);
    } catch (error) {
      log('poll_failed', { error: String(error) });
      continue;
    }
    final = s;
    if (s.tick === prev.tick) continue;

    // ---- F6: which bullets dealt this tick's damage? --------------------
    //
    // The snapshot at tick T holds the pool *after* tick T stepped it, so the bullets
    // that can hit during tick T+1 are exactly the ones standing here now. Consecutive
    // ticks only: a skipped tick means the bullets that did the damage were never seen.
    if (s.tick === prev.tick + 1 && s.slot.hp < prev.slot.hp && prev.slot.hp !== 0) {
      const px = prev.slot.x;
      const py = prev.slot.y;
      const hits = prev.bullets
        .map((b) => sweep(b))
        .filter((sw) => bulletHits(sw.from, sw.end, px, py))
        .map((sw) => ({ bullet: sw, clipped: sw.clipped }));
      const record: Attribution = {
        tick: s.tick,
        hpBefore: prev.slot.hp,
        hpAfter: s.slot.hp,
        lost: prev.slot.hp - s.slot.hp,
        at: [px, py],
        hits,
        clippedHits: hits.filter((h) => h.clipped).length,
        cleanHits: hits.filter((h) => !h.clipped).length,
      };
      attributions.push(record);
      log('damage_attributed', {
        tick: record.tick,
        lost: record.lost,
        expectedBullets: record.lost / BULLET_DAMAGE,
        at: record.at,
        clippedHits: record.clippedHits,
        cleanHits: record.cleanHits,
        // Each entry is the exact arithmetic `tick::step` ran: from, the unclipped
        // endpoint, the midpoint sample, and where the sweep was actually cut.
        bullets: hits.map((h) => ({
          from: h.bullet.from,
          to: h.bullet.to,
          mid: h.bullet.mid,
          end: h.bullet.end,
          toIsWall: isWall(h.bullet.to[0], h.bullet.to[1]),
          midIsWall: isWall(h.bullet.mid[0], h.bullet.mid[1]),
          clipped: h.clipped,
        })),
      });
    }

    // ---- F3: death, and the respawn that used to be unreachable ---------
    if (s.slot.hp === 0 && prev.slot.hp !== 0) {
      deaths.push({ tick: s.tick, respawnAt: s.slot.respawnAtTick, deaths: s.slot.deaths });
      log('death', {
        tick: s.tick,
        respawnAtTick: s.slot.respawnAtTick,
        deltaTicks: s.slot.respawnAtTick - s.tick,
        configuredRespawnTicks: RESPAWN_TICKS,
        deaths: s.slot.deaths,
        arenaPhase: s.phase,
        arenaOutcome: s.outcome,
        aliveCount: s.aliveCount,
        note: 'the only occupant is down; before F3 this tick was OUTCOME_WIPE',
      });
    }
    if (s.slot.hp === 0) phaseWhileDead.push(s.phase);
    if (s.slot.hp !== 0 && prev.slot.hp === 0) {
      const last = deaths[deaths.length - 1];
      const [ex, ey] = entranceFor(SEAT);
      respawns.push({
        deathTick: last?.tick ?? -1,
        seenTick: s.tick,
        delayTicks: last === undefined ? -1 : s.tick - last.tick,
        at: [s.slot.x, s.slot.y],
        atEntrance: s.slot.x === ex && s.slot.y === ey,
        hp: s.slot.hp,
      });
      log('respawn', {
        deathTick: last?.tick ?? -1,
        seenTick: s.tick,
        observedDelayTicks: last === undefined ? null : s.tick - last.tick,
        configuredRespawnTicks: RESPAWN_TICKS,
        hp: s.slot.hp,
        at: [s.slot.x, s.slot.y],
        expectedEntrance: [ex, ey],
        atEntrance: s.slot.x === ex && s.slot.y === ey,
        arenaPhase: s.phase,
        arenaOutcome: s.outcome,
      });
      walkingBack = true;
    }

    if (s.phase !== PHASE_FIGHTING) {
      log('fight_over', {
        tick: s.tick,
        phase: s.phase,
        outcome: s.outcome,
        outcomeName: OUTCOME_NAME[s.outcome] ?? '?',
        enrageAtTick: ENRAGE_AT_TICK,
      });
      break;
    }

    if (s.tick % 25 === 0) {
      log('watch', {
        tick: s.tick,
        hp: s.slot.hp,
        at: [s.slot.x, s.slot.y],
        bullets: s.bullets.length,
        aliveCount: s.aliveCount,
        targetSeat: s.targetSeat,
        deaths: s.slot.deaths,
      });
    }

    // The seat keeps playing: walk back to the wall station and stand there again.
    // A respawned player who cannot move is a respawn that did not really happen.
    if (walkingBack && s.slot.hp !== 0) {
      walkingBack = false;
      const before = await readSlot(match.er, players);
      const ok = await walk(match, treasury, arena, players, session, atStation, 'back_to_station');
      const after = await readSlot(match.er, players);
      movesAfterRespawn += 1;
      log('played_on_after_respawn', {
        reachedStation: ok,
        movedFrom: [before.x, before.y],
        movedTo: [after.x, after.y],
        moveAccepted: before.x !== after.x || before.y !== after.y,
        lastMoveSeq: after.lastMoveSeq,
      });
      prev = await snapshot(match.er, arena, boss, players);
      continue;
    }

    prev = s;
  }

  const clippedTotal = attributions.reduce((a, r) => a + r.clippedHits, 0);
  const cleanTotal = attributions.reduce((a, r) => a + r.cleanHits, 0);
  log('solo_summary', {
    arenaId: arenaId.toString(),
    arena,
    station: station.pos,
    // F3
    deaths,
    respawns,
    respawnCount: respawns.length,
    f3_solo_respawned: respawns.length > 0,
    f3_arena_stayed_fighting_while_dead: phaseWhileDead.every((p) => p === PHASE_FIGHTING),
    f3_phases_seen_while_dead: [...new Set(phaseWhileDead)],
    f3_moves_accepted_after_respawn: movesAfterRespawn,
    // F6
    damageTicks: attributions.length,
    f6_clipped_hits: clippedTotal,
    f6_clean_hits: cleanTotal,
    f6_wall_clipped_bullet_dealt_damage: clippedTotal > 0,
    // F1 / F3's other half
    finalTick: final.tick,
    finalPhase: final.phase,
    finalOutcome: final.outcome,
    finalOutcomeName: OUTCOME_NAME[final.outcome] ?? '?',
    isEnrage: final.outcome === OUTCOME_ENRAGE,
    isWipe: final.outcome === OUTCOME_WIPE,
    isUndecided: final.outcome === OUTCOME_UNDECIDED,
  });

  await endMatch(base, match.er, treasury, arena, boss, players, arenaId);
}

// ---------------------------------------------------------------------------
// Settlement and the leaderboard
// ---------------------------------------------------------------------------

async function commitHome(
  base: HeartrotRpc,
  er: HeartrotRpc,
  treasury: Treasury,
  arena: Address,
  boss: Address,
  players: Address,
): Promise<ReturnType<typeof decodeArena> | null> {
  const settleSig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await erOk(er, settleSig, 'settle', 45_000);
  log('settle', { signature: settleSig, arena });

  for (let i = 0; i < 18; i += 1) {
    await sleep(6_000);
    const { value } = await base.getAccountInfo(arena, { encoding: 'base64' }).send();
    if (value === null || value.owner !== PROGRAM_ID) continue;
    const onBase = decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
    log('post_settle', { tick: onBase.tick, phase: onBase.phase, outcome: onBase.outcome });
    if (onBase.phase === PHASE_SETTLED) return onBase;
  }
  log('settle_never_landed', { arena });
  return null;
}

type Board = ReturnType<typeof decodeLeaderboard> & { raw: Uint8Array };

async function readBoard(base: HeartrotRpc, leaderboard: Address): Promise<Board> {
  const { value } = await base.getAccountInfo(leaderboard, { encoding: 'base64' }).send();
  if (value === null) throw new Error('leaderboard does not exist');
  const raw = Uint8Array.from(Buffer.from(value.data[0], 'base64'));
  return { ...decodeLeaderboard(raw), raw };
}

const boardKey = (b: Board) => ({
  totalWritten: b.totalWritten,
  next: b.next,
  lastArenaId: b.lastArenaId.toString(),
  lastIncarnation: b.lastIncarnation,
});

async function ensureLeaderboard(base: HeartrotRpc, treasury: Treasury): Promise<Address> {
  const leaderboard = await leaderboardPda(PROGRAM_ID);
  const { value } = await base.getAccountInfo(leaderboard, { encoding: 'base64' }).send();
  if (value === null) {
    const sig = await sendInstructions(base, treasury, [
      setComputeUnitLimit(400_000),
      initLeaderboard({ programId: PROGRAM_ID, payer: treasury.address, leaderboard }),
    ]);
    await confirmSignature(base, sig, { timeoutMs: 60_000 });
    log('init_leaderboard', { signature: sig, leaderboard });
  }
  return leaderboard;
}

async function writeRows(
  base: HeartrotRpc,
  treasury: Treasury,
  leaderboard: Address,
  arena: Address,
  players: Address,
  what: string,
): Promise<{ signature: Signature; before: Board; after: Board }> {
  const before = await readBoard(base, leaderboard);
  const signature = await sendInstructions(base, treasury, [
    writeLeaderboard({ programId: PROGRAM_ID, payer: treasury.address, leaderboard, arena, players }),
  ]);
  await confirmSignature(base, signature, { timeoutMs: 60_000 });
  const after = await readBoard(base, leaderboard);
  log('write_leaderboard', {
    what,
    signature,
    before: boardKey(before),
    after: boardKey(after),
    rowsAppended: after.totalWritten - before.totalWritten,
  });
  return { signature, before, after };
}

/** The 48 raw bytes of one ring slot, which is what "distinguishable" has to be argued in. */
function rowBytes(board: Board, index: number): string {
  const start = LEADERBOARD.offsets.entries + index * LEADERBOARD_ENTRY.size;
  return Buffer.from(board.raw.subarray(start, start + LEADERBOARD_ENTRY.size)).toString('hex');
}

function rowsFor(board: Board, arenaId: bigint): { index: number; hex: string; row: Board['entries'][number] }[] {
  const out: { index: number; hex: string; row: Board['entries'][number] }[] = [];
  for (let i = 0; i < LEADERBOARD_CAP; i += 1) {
    const row = board.entries[i]!;
    if (row.arenaId !== arenaId) continue;
    out.push({ index: i, hex: rowBytes(board, i), row });
  }
  return out;
}

async function endMatch(
  base: HeartrotRpc,
  er: HeartrotRpc,
  treasury: Treasury,
  arena: Address,
  boss: Address,
  players: Address,
  arenaId: bigint,
): Promise<void> {
  const onBase = await commitHome(base, er, treasury, arena, boss, players);
  if (onBase === null) return;
  // A match cut short by the operator (`FIGHTING -> SETTLED`) keeps `OUTCOME_UNDECIDED`,
  // and a result nobody reached is not a result to record. Also keeps the ring's
  // idempotency key where F7 needs it.
  if (onBase.outcome === OUTCOME_UNDECIDED) {
    log('write_skipped', { arenaId: arenaId.toString(), reason: 'outcome is UNDECIDED' });
    return;
  }
  const leaderboard = await ensureLeaderboard(base, treasury);
  const { after } = await writeRows(base, treasury, leaderboard, arena, players, 'first write');
  const mine = rowsFor(after, arenaId);
  log('rows', {
    arenaId: arenaId.toString(),
    baseOutcome: onBase.outcome,
    baseOutcomeName: OUTCOME_NAME[onBase.outcome] ?? '?',
    rows: mine.map((m) => ({
      index: m.index,
      hex: m.hex,
      damageDealt: m.row.damageDealt,
      survived: m.row.survived,
      outcome: m.row.outcome,
      outcomeName: OUTCOME_NAME[m.row.outcome] ?? '?',
      incarnation: m.row.incarnation,
    })),
  });
}

// ---------------------------------------------------------------------------
// Phase SEATLESS — F7
// ---------------------------------------------------------------------------

async function phaseSeatless(): Promise<void> {
  const treasury = await treasurySigner();
  const base = createRpc(BASE_URL);
  const leaderboard = await ensureLeaderboard(base, treasury);
  const prevId = arg('--prev');
  if (prevId === undefined) throw new Error('--prev <arenaId of a real, already-written match>');
  const prev = await matchPdas(PROGRAM_ID, BigInt(prevId));

  const start = await readBoard(base, leaderboard);
  const prevRows = rowsFor(start, BigInt(prevId));
  log('f7_start', {
    board: boardKey(start),
    prevArenaId: prevId,
    prevRowsOnBoard: prevRows.length,
    keyIsPrev: start.lastArenaId === BigInt(prevId),
  });
  if (start.lastArenaId !== BigInt(prevId)) {
    log('f7_precondition_failed', {
      reason: 'the ring key is not the --prev match, so a stolen key would not be visible',
      lastArenaId: start.lastArenaId.toString(),
    });
  }

  // A seatless arena: init, delegate, start_match, and NOBODY claims a seat. Settled
  // straight out of PHASE_FIGHTING — the operator recovery edge — because waiting 900
  // ticks for an enrage would change nothing about what it appends, which is nothing.
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { match, arena, boss, players } = await openMatch(base, treasury, arenaId);
  const armed = await snapshot(match.er, arena, boss, players);
  log('seatless_armed', {
    arenaId: arenaId.toString(),
    tick: armed.tick,
    aliveCount: armed.aliveCount,
    targetSeat: armed.targetSeat,
  });

  const onBase = await commitHome(base, match.er, treasury, arena, boss, players);
  if (onBase === null) throw new Error('the seatless arena never came home');
  log('seatless_settled', { phase: onBase.phase, outcome: onBase.outcome, tick: onBase.tick });

  const seatless = await writeRows(base, treasury, leaderboard, arena, players, 'seatless');
  const afterSeatless = seatless.after;

  // The retry of the real match. Its key has to have survived the seatless write, which
  // is what keeps this a no-op instead of a second copy of its rows.
  const retry = await writeRows(
    base,
    treasury,
    leaderboard,
    prev.arena,
    prev.players,
    `retry of ${prevId}`,
  );

  const end = retry.after;
  log('f7_summary', {
    seatlessArenaId: arenaId.toString(),
    seatlessWriteSig: seatless.signature,
    retryWriteSig: retry.signature,
    boardAtStart: boardKey(start),
    boardAfterSeatless: boardKey(afterSeatless),
    boardAfterRetry: boardKey(end),
    f7_seatless_appended_zero_rows: afterSeatless.totalWritten === start.totalWritten,
    f7_seatless_did_not_claim_key:
      afterSeatless.lastArenaId === start.lastArenaId &&
      afterSeatless.lastIncarnation === start.lastIncarnation,
    f7_prev_retry_was_a_noop: end.totalWritten === afterSeatless.totalWritten,
    f7_prev_rows_still_present: rowsFor(end, BigInt(prevId)).length,
    f7_prev_rows_not_duplicated: rowsFor(end, BigInt(prevId)).length === prevRows.length,
  });
}

// ---------------------------------------------------------------------------
// Phase READ — F1's verdict
// ---------------------------------------------------------------------------

async function phaseRead(): Promise<void> {
  const base = createRpc(BASE_URL);
  const leaderboard = await leaderboardPda(PROGRAM_ID);
  const board = await readBoard(base, leaderboard);

  const populated: { index: number; hex: string; row: Board['entries'][number] }[] = [];
  for (let i = 0; i < LEADERBOARD_CAP; i += 1) {
    const row = board.entries[i]!;
    if (row.arenaId === 0n && row.damageDealt === 0 && row.incarnation === 0) continue;
    populated.push({ index: i, hex: rowBytes(board, i), row });
  }

  log('board', { leaderboard, ...boardKey(board), populatedRows: populated.length });
  for (const p of populated) {
    log('row', {
      index: p.index,
      hex: p.hex,
      arenaId: p.row.arenaId.toString(),
      incarnation: p.row.incarnation,
      damageDealt: p.row.damageDealt,
      survived: p.row.survived,
      outcome: p.row.outcome,
      outcomeName: OUTCOME_NAME[p.row.outcome] ?? '?',
    });
  }

  // The F1 claim in the only form that means anything: two rows whose *outcome* bytes
  // disagree, quoted whole. A win and a loss that differ only in `arena_id` is the
  // defect, not the fix.
  const wins = populated.filter((p) => p.row.outcome === OUTCOME_WIN);
  const losses = populated.filter(
    (p) => p.row.outcome === OUTCOME_WIPE || p.row.outcome === OUTCOME_ENRAGE,
  );
  const winSurvivors = wins.filter((p) => p.row.survived);
  const lossSurvivors = losses.filter((p) => p.row.survived);

  log('f1_summary', {
    winRows: wins.length,
    lossRows: losses.length,
    undecidedRows: populated.filter((p) => p.row.outcome === OUTCOME_UNDECIDED).length,
    winRow: wins[0] === undefined ? null : { index: wins[0].index, hex: wins[0].hex },
    lossRow: losses[0] === undefined ? null : { index: losses[0].index, hex: losses[0].hex },
    // The hard case: a survivor row from a WIN and a survivor row from a LOSS. Those
    // two are the pair that used to be byte-identical past the arena id.
    winSurvivorRow:
      winSurvivors[0] === undefined ? null : { index: winSurvivors[0].index, hex: winSurvivors[0].hex },
    lossSurvivorRow:
      lossSurvivors[0] === undefined
        ? null
        : { index: lossSurvivors[0].index, hex: lossSurvivors[0].hex },
    f1_win_and_loss_both_recorded: wins.length > 0 && losses.length > 0,
    f1_outcome_byte_differs:
      wins[0] !== undefined && losses[0] !== undefined && wins[0].row.outcome !== losses[0].row.outcome,
    f1_survivor_rows_distinguishable:
      winSurvivors[0] !== undefined &&
      lossSurvivors[0] !== undefined &&
      winSurvivors[0].hex.slice(16) !== lossSurvivors[0].hex.slice(16),
  });
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await treasurySigner();
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const er = await erConnection();
  const before = await snapshot(er, arena, boss, players);
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  await erOk(er, sig, 'settle', 45_000);
  log('settle_only', {
    arenaId: arenaId.toString(),
    arena,
    signature: sig,
    beforeTick: before.tick,
    beforePhase: before.phase,
    beforeOutcome: before.outcome,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const settleIndex = process.argv.indexOf('--settle-only');
  if (settleIndex !== -1) {
    await settleOnly(BigInt(process.argv[settleIndex + 1] as string));
    return;
  }
  const phase = arg('--phase') ?? 'read';
  log('start', { phase, programId: PROGRAM_ID });
  if (phase === 'solo') await phaseSolo();
  else if (phase === 'seatless') await phaseSeatless();
  else await phaseRead();
  log('done', { phase });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    // kit renders RPC code -32003 as "Transaction signature verification failure"
    // whatever the server said, and the ER uses -32003 for cloner failures.
    log('fatal', {
      error: String(error),
      context: (error as { context?: unknown }).context ?? null,
      stack: (error as Error)?.stack,
    });
    process.exit(1);
  },
);
