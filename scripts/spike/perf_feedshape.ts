/**
 * PERF-FEEDSHAPE — what the account feed actually *delivers* in a LOBBY versus in a
 * FIGHT, on one real devnet match, with one seat moving at the client's own cadence.
 *
 * The bug this exists for: "works great but when the boss activates movement becomes
 * choppy". Every previous spike here measured LATENCY (write-to-visible p50 127 ms) and
 * found nothing wrong. This one measures SHAPE — how many notifications arrive, how far
 * apart, and above all **how many of them carry a position change for the seat being
 * rendered**.
 *
 * That last number is the whole point. `render/Arena.tsx` draws every seat, the local one
 * included, through `useSeatInterpolation`, which lerps between the last two
 * `PlayersAccount` notifications over a 100 ms window re-anchored on *every* notification.
 * A notification whose local seat did not move makes the lerp run P→P — a static window —
 * and the next real move then lands as a step. If most fight-time `Players` notifications
 * carry no position change, that machine is being fed a stream that is mostly stalls with
 * occasional jumps, which is exactly what "choppy" describes. If most of them DO carry a
 * position change, this hypothesis is dead and the cause is elsewhere.
 *
 * Method, deliberately one seat and nothing else:
 *   1. `init_arena` + ER rent top-up + `delegate` on the base layer. A fresh arena, because
 *      every existing one is `PHASE_SETTLED` and the lobby half of the comparison needs a
 *      match that has not started yet.
 *   2. Claim one seat.
 *   3. Subscribe EXACTLY as `app/src/net/subscribe.ts` does: one socket to the Magic
 *      Router, `accountSubscribe` on `[arena, boss, players]`, `encoding: 'base64'`, no
 *      commitment. Same endpoint, same three accounts, same encoding — a different socket
 *      shape would measure a feed the game never sees.
 *   4. LOBBY window: walk toward the gate, one `move` every 50 ms — `input/controls.ts`
 *      `MOVE_MS`, and the chain's own floor, since `move_clock` limits to one accepted
 *      move per 50 ms ER slot in every phase.
 *   5. `enter_gate`, `start_match`, then the FIGHT window: the same 50 ms cadence, now
 *      with `boss_tick` running every 100 ms and bullets in the air.
 *
 * Every notification is classified against the PREVIOUS notification of the same account,
 * which is the same pair `useSeatInterpolation` lerps between — `previous` there is
 * literally the last `PlayersAccount` it was handed.
 *
 * Sends are fire-and-forget on a paced loop, never awaited: awaiting the POST would make
 * the real cadence the 130 ms round trip rather than the client's 50 ms, and the cadence
 * mismatch is one of the things under test.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_feedshape.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=packages/client/src/index.ts \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_feedshape.mjs
 *   FF_LOBBY_MS=60000 FF_FIGHT_MS=60000 node /tmp/perf_feedshape.mjs --out /tmp/feedshape.jsonl
 *
 * `--settle-only <arenaId>` cancels the crank task an aborted run left armed. An
 * abandoned task ticks for its full iteration count, so every abort needs it.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  PHASE_FIGHTING,
  ZONE_ARENA,
  assertErIdentity,
  claimSeat,
  confirmSignature,
  connectMatch,
  createRpc,
  decodeArena,
  decodePlayers,
  delegate,
  enterGate,
  getRoutes,
  initArena,
  isWall,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
  startMatch,
  stringifyWithBigints,
  type ArenaAccount,
  type HeartrotRpc,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;
/** `subscribe.ts` `ROUTER_WS_ENDPOINT` — the socket the game actually opens. */
const ROUTER_WS = 'wss://devnet-router.magicblock.app/';
/** See `sp2_crank.ts`: the ER's rent rate is 6,960/byte, devnet's is 6,333. */
const ER_LAMPORTS_PER_BYTE = 6_960n;

/** `player::MOVE_STEP` — one 16-unit tile per cardinal step. */
const STEP = 16;
/** `player::GATE_MIN_*`/`GATE_MAX_*` — tiles 30..=33 on both axes, in arena units. */
const GATE_MIN = 30 * 16;
const GATE_MAX = 34 * 16 - 1;
const MAP_MAX_XY = 63 * 16 + 15;
const CARDINALS: readonly { dir: number; dx: number; dy: number }[] = [
  { dir: 0, dx: 0, dy: -STEP },
  { dir: 2, dx: STEP, dy: 0 },
  { dir: 4, dx: 0, dy: STEP },
  { dir: 6, dx: -STEP, dy: 0 },
];

const SEAT = Number(process.env.FF_SEAT ?? 0);
const LOBBY_MS = Number(process.env.FF_LOBBY_MS ?? 60_000);
const FIGHT_MS = Number(process.env.FF_FIGHT_MS ?? 60_000);
/** `input/controls.ts` `MOVE_MS`, which is also the chain's one-move-per-ER-slot floor. */
const SEND_MS = Number(process.env.FF_SEND_MS ?? 50);
const WS_URL = process.env.FF_WS ?? ROUTER_WS;
/** In-flight cap. The pacer never awaits a POST, so a stalled ER must not queue forever. */
const MAX_INFLIGHT = 8;

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/perf_feedshape.jsonl' : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${stringifyWithBigints(line)}\n`);
  console.log(`${line.t} ${event} ${stringifyWithBigints(fields)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const now = (): number => Date.now();

function pct(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] as number;
}

function stats(values: readonly number[]): Record<string, number | null> {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    p90: pct(sorted, 90),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1] ?? null,
    mean: sorted.length === 0 ? null : Math.round((sum / sorted.length) * 10) / 10,
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// Base-layer plumbing (transfer / compute budget / rent top-up, from sp_load.ts)
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

function setComputeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

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

// ---------------------------------------------------------------------------
// Walking (BFS to the gate, from sp_load.ts — the only route into ZONE_ARENA)
// ---------------------------------------------------------------------------

const onGate = (x: number, y: number): boolean =>
  x >= GATE_MIN && x <= GATE_MAX && y >= GATE_MIN && y <= GATE_MAX;

function pathToGate(x: number, y: number): number[] | null {
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
        if (onGate(nx, ny)) {
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

const clampXY = (v: number): number => Math.min(Math.max(v, 0), MAP_MAX_XY);

/** Is one cardinal step from `(x, y)` open under the client's own generated wall table? */
function stepOpen(x: number, y: number, dir: number): boolean {
  const c = CARDINALS.find((k) => k.dir === dir);
  if (c === undefined) return false;
  return !isWall(clampXY(x + c.dx), clampXY(y + c.dy));
}

// ---------------------------------------------------------------------------
// The feed recorder
// ---------------------------------------------------------------------------

type AccountKind = 'arena' | 'boss' | 'players';

interface Event {
  readonly kind: AccountKind;
  readonly at: number;
  /** Base64 payload length — a proxy for the frame the client has to parse. */
  readonly bytes: number;
  /** True when this frame's payload is byte-identical to the previous one. */
  readonly identical: boolean;
  /** `players` only: what changed for the measured seat against the previous frame. */
  readonly seat?: {
    readonly x: number;
    readonly y: number;
    readonly moved: boolean;
    readonly dist: number;
    readonly seqChanged: boolean;
    readonly lastMoveSeq: number;
    readonly hp: number;
    readonly hpChanged: boolean;
    readonly zone: number;
    readonly anySeatMoved: boolean;
  };
  /** `arena` only. */
  readonly arena?: { readonly tick: number; readonly tickChanged: boolean; readonly phase: number };
}

const events: Event[] = [];
let latestPlayers: PlayersAccount | null = null;
let latestArena: ArenaAccount | null = null;

function record(kind: AccountKind, encoded: string, at: number, prevEncoded: string | undefined): void {
  const identical = prevEncoded === encoded;
  const bytes = encoded.length;
  const raw = Uint8Array.from(Buffer.from(encoded, 'base64'));
  if (kind === 'players') {
    const players = decodePlayers(raw);
    const to = players.slots[SEAT] as PlayerSlot;
    const from = latestPlayers?.slots[SEAT];
    const dist = from === undefined ? 0 : Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    const anySeatMoved =
      latestPlayers === null
        ? true
        : players.slots.some((s, i) => {
            const p = latestPlayers?.slots[i];
            return p !== undefined && s.occupied && (s.x !== p.x || s.y !== p.y);
          });
    events.push({
      kind,
      at,
      bytes,
      identical,
      seat: {
        x: to.x,
        y: to.y,
        moved: from !== undefined && (to.x !== from.x || to.y !== from.y),
        dist,
        seqChanged: from !== undefined && to.lastMoveSeq !== from.lastMoveSeq,
        lastMoveSeq: to.lastMoveSeq,
        hp: to.hp,
        hpChanged: from !== undefined && to.hp !== from.hp,
        zone: to.zone,
        anySeatMoved,
      },
    });
    latestPlayers = players;
    return;
  }
  if (kind === 'arena') {
    const arena = decodeArena(raw);
    events.push({
      kind,
      at,
      bytes,
      identical,
      arena: {
        tick: arena.tick,
        tickChanged: latestArena !== null && arena.tick !== latestArena.tick,
        phase: arena.phase,
      },
    });
    latestArena = arena;
    return;
  }
  events.push({ kind, at, bytes, identical });
}

/** One socket, three `accountSubscribe`s, byte-for-byte the shape `subscribe.ts` opens. */
function openFeed(cfg: {
  wsUrl: string;
  accounts: Record<AccountKind, Address>;
  onReady: () => void;
}): { close(): void; errors: number } {
  const ws = new WebSocket(cfg.wsUrl);
  const requestKind = new Map<number, AccountKind>();
  const subKind = new Map<number, AccountKind>();
  const lastEncoded = new Map<AccountKind, string>();
  const state = { errors: 0 };
  let acked = 0;

  ws.onopen = () => {
    (['arena', 'boss', 'players'] as const).forEach((kind, i) => {
      requestKind.set(i + 1, kind);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'accountSubscribe',
          params: [cfg.accounts[kind], { encoding: 'base64' }],
        }),
      );
    });
  };

  ws.onmessage = (event: MessageEvent) => {
    const at = now();
    const msg = JSON.parse(String(event.data)) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { data?: string[] } } };
    };
    if (msg.error !== undefined) {
      state.errors += 1;
      log('sub_error', { code: msg.error.code, message: msg.error.message });
      return;
    }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const kind = requestKind.get(msg.id);
      if (kind !== undefined) subKind.set(msg.result, kind);
      acked += 1;
      if (acked === 3) cfg.onReady();
      return;
    }
    if (msg.method !== 'accountNotification') return;
    const sub = msg.params?.subscription;
    const encoded = msg.params?.result?.value?.data?.[0];
    if (sub === undefined || encoded === undefined) return;
    const kind = subKind.get(sub);
    if (kind === undefined) return;
    record(kind, encoded, at, lastEncoded.get(kind));
    lastEncoded.set(kind, encoded);
  };

  ws.onerror = () => {
    state.errors += 1;
  };

  return {
    close() {
      ws.close();
    },
    get errors() {
      return state.errors;
    },
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function gaps(times: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < times.length; i += 1) out.push((times[i] as number) - (times[i - 1] as number));
  return out;
}

/**
 * `useSeatInterpolation`, replayed at 60 fps over the frames this run actually received.
 *
 * Byte-for-byte the same rule as `net/predict.ts`: every `Players` notification shifts
 * `previous <- next`, re-anchors `at`, and the seat is drawn at
 * `lerp(previous, next, clamp((now - at) / 100))`, snapping instead of lerping when the
 * pair looks like a teleport. Restated here rather than imported because the point is to
 * show what THAT rule does to THIS feed; a divergence would be the bug.
 *
 * `stallPct` is the fraction of rendered frames that did not move at all, and `jump` is
 * how far the sprite travels in one frame. A smooth 16-unit step spread over a 100 ms
 * window is 0.96 units/frame; anything much larger is a pop the eye reads as chop.
 */
function replayRender(from: number, to: number): Record<string, unknown> {
  const SNAP = 4 * STEP;
  const FRAME_MS = 1000 / 60;
  const feed = events.filter((e) => e.kind === 'players' && e.seat !== undefined && e.at <= to);
  if (feed.length === 0) return { frames: 0 };

  let cursor = 0;
  let prev: Event | null = null;
  let next = feed[0] as Event;
  let at = next.at;
  let lastX: number | null = null;
  let lastY: number | null = null;
  const jumps: number[] = [];
  let stalled = 0;
  let frames = 0;
  const stallRuns: number[] = [];
  let run = 0;

  for (let t = from; t <= to; t += FRAME_MS) {
    while (cursor + 1 < feed.length && (feed[cursor + 1] as Event).at <= t) {
      cursor += 1;
      prev = next;
      next = feed[cursor] as Event;
      at = next.at;
    }
    const a = next.seat as NonNullable<Event['seat']>;
    const b = prev?.seat;
    const alpha = Math.min(Math.max((t - at) / 100, 0), 1);
    const snap =
      b === undefined ||
      b.zone !== a.zone ||
      Math.abs(a.x - b.x) > SNAP ||
      Math.abs(a.y - b.y) > SNAP;
    const x = snap ? a.x : b.x + (a.x - b.x) * alpha;
    const y = snap ? a.y : b.y + (a.y - b.y) * alpha;
    if (t < from) continue;
    frames += 1;
    if (lastX !== null && lastY !== null) {
      const d = Math.hypot(x - lastX, y - lastY);
      jumps.push(d);
      if (d < 1e-9) {
        stalled += 1;
        run += 1;
      } else if (run > 0) {
        stallRuns.push(run * FRAME_MS);
        run = 0;
      }
    }
    lastX = x;
    lastY = y;
  }
  if (run > 0) stallRuns.push(run * FRAME_MS);

  return {
    frames,
    stallPct: frames === 0 ? null : round1((stalled / frames) * 100),
    stallRunMs: stats(stallRuns),
    jumpUnitsPerFrame: stats(jumps.map((j) => Math.round(j * 100) / 100)),
    framesJumpingOverOneTile: jumps.filter((j) => j > STEP).length,
    framesJumpingOverAQuarterTile: jumps.filter((j) => j > STEP / 4).length,
  };
}

function summarise(phase: string, from: number, to: number): Record<string, unknown> {
  const seconds = (to - from) / 1000;
  const inWindow = events.filter((e) => e.at >= from && e.at <= to);
  const perKind: Record<string, unknown> = {};
  for (const kind of ['arena', 'boss', 'players'] as const) {
    const list = inWindow.filter((e) => e.kind === kind);
    perKind[kind] = {
      count: list.length,
      perSecond: round1(list.length / seconds),
      identical: list.filter((e) => e.identical).length,
      interArrivalMs: stats(gaps(list.map((e) => e.at))),
      payloadB64Bytes: stats(list.map((e) => e.bytes)),
    };
  }

  const players = inWindow.filter((e) => e.kind === 'players' && e.seat !== undefined);
  const moved = players.filter((e) => e.seat?.moved === true);
  // A byte-identical frame a millisecond behind its twin is a second delivery of ONE
  // write; a byte-identical frame a crank period behind is a write that changed nothing.
  // They are the same nuisance to the renderer and different bugs to fix, so they are
  // counted apart.
  const twins = players.filter(
    (e, i) => i > 0 && e.identical && e.at - (players[i - 1] as Event).at <= 10,
  );
  const seqOnly = players.filter((e) => e.seat?.seqChanged === true && e.seat?.moved !== true);
  const arena = inWindow.filter((e) => e.kind === 'arena' && e.arena !== undefined);

  return {
    phase,
    windowSeconds: round1(seconds),
    perKind,
    players: {
      total: players.length,
      // THE KEY NUMBER: a frame whose local seat did not move makes the renderer's lerp
      // run P -> P for a whole window.
      noPositionChange: players.length - moved.length,
      noPositionChangePct: players.length === 0 ? null : round1(((players.length - moved.length) / players.length) * 100),
      positionChanged: moved.length,
      identicalPayload: players.filter((e) => e.identical).length,
      identicalWithin10ms: twins.length,
      identicalLater: players.filter((e) => e.identical).length - twins.length,
      seqChangedButStill: seqOnly.length,
      seqChanged: players.filter((e) => e.seat?.seqChanged === true).length,
      hpChanged: players.filter((e) => e.seat?.hpChanged === true).length,
      anySeatMoved: players.filter((e) => e.seat?.anySeatMoved === true).length,
      stepDistance: stats(moved.map((e) => e.seat?.dist ?? 0)),
      // How far apart REAL motion actually is. This is the interval the eye sees as one
      // step, whatever the notification rate says.
      gapBetweenMovesMs: stats(gaps(moved.map((e) => e.at))),
      gapBetweenAllMs: stats(gaps(players.map((e) => e.at))),
    },
    arena: {
      total: arena.length,
      tickChanged: arena.filter((e) => e.arena?.tickChanged === true).length,
      tickGapMs: stats(gaps(arena.filter((e) => e.arena?.tickChanged === true).map((e) => e.at))),
    },
    render: replayRender(from, to),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function settleOnly(arenaId: bigint): Promise<void> {
  const treasury = await createKeyPairSignerFromBytes(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
    ),
  );
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  const sig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  log('settle', { arenaId: arenaId.toString(), signature: sig });
}

async function main(): Promise<void> {
  const settleIndex = process.argv.indexOf('--settle-only');
  if (settleIndex !== -1) {
    await settleOnly(BigInt(process.argv[settleIndex + 1] as string));
    return;
  }

  const treasury = await createKeyPairSignerFromBytes(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
    ),
  );
  const arenaId = BigInt(Math.floor(Date.now() / 1000));
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, arenaId);
  log('start', {
    arenaId: arenaId.toString(),
    arena,
    boss,
    players,
    seat: SEAT,
    wsUrl: WS_URL,
    lobbyMs: LOBBY_MS,
    fightMs: FIGHT_MS,
    sendMs: SEND_MS,
  });

  const base = createRpc(BASE_URL);
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

  const match = await connectMatch({
    baseUrl: BASE_URL,
    accounts: [arena, boss, players],
    validatorIdentity: DEVNET_AS_IDENTITY,
    ownerProgram: PROGRAM_ID,
    timeoutMs: 60_000,
  });
  const er = match.er;
  await assertErIdentity(er, DEVNET_AS_IDENTITY);
  log('connected', { erFqdn: match.erFqdn });

  const keyPair = await generateKeyPair();
  const session = await getAddressFromPublicKey(keyPair.publicKey);
  const claimSig = await sendInstructions(er, treasury, [
    claimSeat({
      programId: PROGRAM_ID,
      arena,
      players,
      treasury: treasury.address,
      seat: SEAT,
      skinId: 0,
      sessionPubkey: session,
      identity: Uint8Array.from(randomBytes(32)),
    }),
  ]);
  log('claim_seat', { signature: claimSig, seat: SEAT, session });

  // ---- the feed ----------------------------------------------------------
  let ready = false;
  const feed = openFeed({
    wsUrl: WS_URL,
    accounts: { arena, boss, players },
    onReady: () => {
      ready = true;
    },
  });
  for (let i = 0; i < 40 && !ready; i += 1) await sleep(250);
  if (!ready) throw new Error('the feed never acknowledged all three subscriptions');
  log('subscribed', { wsUrl: WS_URL });

  // A snapshot, exactly as `subscribe.ts` takes one on open: without it the recorder has
  // no `previous` to diff the first notification against.
  const snap = await er.getMultipleAccounts([arena, boss, players], { encoding: 'base64' }).send();
  const snapPlayers = snap.value[2];
  if (snapPlayers == null) throw new Error('players missing on the ER');
  latestPlayers = decodePlayers(Uint8Array.from(Buffer.from(snapPlayers.data[0], 'base64')));
  const spawn = latestPlayers.slots[SEAT] as PlayerSlot;
  log('spawn', { x: spawn.x, y: spawn.y, zone: spawn.zone, hp: spawn.hp });

  // ---- the send loop -----------------------------------------------------
  let stopped = false;
  let blockhash = (await er.getLatestBlockhash().send()).value;
  const blockhashLoop = (async () => {
    while (!stopped) {
      await sleep(4_000);
      try {
        blockhash = (await er.getLatestBlockhash().send()).value;
      } catch {
        /* the cached one is good for ~60 s; a miss is not fatal */
      }
    }
  })();

  let seq = 0;
  let sent = 0;
  let failed = 0;
  let inflight = 0;
  let bounce = 0;

  /** Where the chain last said we are. One update stale, which a relative move tolerates. */
  const here = (): PlayerSlot => (latestPlayers?.slots[SEAT] ?? spawn) as PlayerSlot;

  /**
   * Walk to the gate while off it, patrol in straight runs while on it.
   *
   * The runs are long on purpose. A one-tile back-and-forth aliases: two accepted moves
   * between one pair of notifications return the seat to where it started, and the frame
   * would be scored "no position change" when the player really did move. A 12-tile leg
   * makes that possible only at a turnaround, once per leg.
   */
  const RUN_TILES = 12;
  let runDir: number | null = null;
  let runLeft = 0;

  function nextDir(): number | null {
    const slot = here();
    if (!onGate(slot.x, slot.y)) {
      const path = pathToGate(slot.x, slot.y);
      return path === null || path.length === 0 ? null : (path[0] as number);
    }
    if (runDir === null || runLeft <= 0 || !stepOpen(slot.x, slot.y, runDir)) {
      const back = runDir === null ? null : (runDir + 4) % 8;
      const options = CARDINALS.map((c) => c.dir).filter((d) => stepOpen(slot.x, slot.y, d));
      if (options.length === 0) return null;
      runDir = back !== null && options.includes(back) ? back : (options[bounce % options.length] as number);
      runLeft = RUN_TILES;
      bounce += 1;
    }
    runLeft -= 1;
    return runDir;
  }

  /**
   * Treasury pays, the session key authorises. The client's builders emit plain address
   * metas, so kit's signer discovery cannot find the session key on its own and
   * `sendInstructions` would post a transaction missing that signature.
   */
  const sendSigned = async (ixs: readonly Instruction[]): Promise<void> => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(treasury.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const signed = await signTransaction([treasury.keyPair, keyPair], compileTransaction(message));
    const wire = getBase64EncodedWireTransaction(signed);
    inflight += 1;
    try {
      await er
        .sendTransaction(wire as Parameters<HeartrotRpc['sendTransaction']>[0], {
          encoding: 'base64',
          skipPreflight: true,
        })
        .send();
    } catch (error: unknown) {
      failed += 1;
      if (failed <= 3) log('send_failed', { seq, error: String(error).slice(0, 160) });
    } finally {
      inflight -= 1;
    }
  };

  const sendOne = async (dir: number): Promise<void> => {
    seq = (seq + 1) & 0xffff;
    sent += 1;
    await sendSigned([
      movePlayer({ programId: PROGRAM_ID, arena, players, session, seat: SEAT, dir, seq }),
    ]);
  };

  /** The client's pacer: fire on a fixed period, never wait for the round trip. */
  const pace = async (untilMs: number): Promise<void> => {
    const until = now() + untilMs;
    while (now() < until) {
      const t0 = now();
      const dir = nextDir();
      if (dir !== null && inflight < MAX_INFLIGHT) void sendOne(dir);
      const elapsed = now() - t0;
      if (elapsed < SEND_MS) await sleep(SEND_MS - elapsed);
    }
  };

  // ---- LOBBY -------------------------------------------------------------
  const lobbyFrom = now();
  await pace(LOBBY_MS);
  const lobbyTo = now();
  const afterLobby = here();
  log('lobby_done', { sent, failed, x: afterLobby.x, y: afterLobby.y, seq });

  // ---- into the arena ----------------------------------------------------
  for (let attempt = 0; attempt < 10 && here().zone !== ZONE_ARENA; attempt += 1) {
    const slot = here();
    if (!onGate(slot.x, slot.y)) {
      const dir = nextDir();
      if (dir !== null) await sendOne(dir);
      await sleep(400);
      continue;
    }
    try {
      await sendSigned([enterGate({ programId: PROGRAM_ID, arena, players, session, seat: SEAT })]);
      log('enter_gate', { attempt, x: slot.x, y: slot.y });
    } catch (error: unknown) {
      log('enter_gate_failed', { attempt, error: String(error).slice(0, 200) });
    }
    await sleep(700);
  }

  const startSig = await sendInstructions(er, treasury, [
    startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  log('start_match', { signature: startSig });
  for (let i = 0; i < 40 && latestArena?.phase !== PHASE_FIGHTING; i += 1) await sleep(250);
  if (latestArena?.phase !== PHASE_FIGHTING) throw new Error('the match never reached PHASE_FIGHTING');
  // One crank period of settling, so the fight window contains no start-up transient.
  await sleep(1_000);

  // ---- FIGHT -------------------------------------------------------------
  const fightFrom = now();
  await pace(FIGHT_MS);
  const fightTo = now();
  stopped = true;
  await blockhashLoop;
  const afterFight = here();
  log('fight_done', {
    sent,
    failed,
    x: afterFight.x,
    y: afterFight.y,
    hp: afterFight.hp,
    zone: afterFight.zone,
    seq,
    tick: latestArena?.tick,
  });

  log('summary_lobby', summarise('lobby', lobbyFrom, lobbyTo));
  log('summary_fight', summarise('fight', fightFrom, fightTo));
  log('raw_events', { events });

  feed.close();
  const settleSig = await sendInstructions(er, treasury, [
    settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
  ]);
  log('settle', { arenaId: arenaId.toString(), signature: settleSig });
  process.exit(0);
}

void main().catch((error: unknown) => {
  log('fatal', { error: String(error).slice(0, 400) });
  process.exit(1);
});
