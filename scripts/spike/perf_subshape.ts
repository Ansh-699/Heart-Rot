/**
 * PERF-SUBSHAPE — what the client subscribes to, and whether the SHAPE of that
 * subscription costs anything.
 *
 * `docs/perf/notify.md` already settled *where* to subscribe (the pinned ER, not the
 * router) and that three accounts cost the same as one. This spike asks the remaining
 * shape questions, all of which are about the PAYLOAD and the SUBSCRIPTION COUNT rather
 * than the endpoint:
 *
 *   B64    accountSubscribe [arena, boss, players], `encoding: base64`.
 *          The shape that ships today, minus the router. The baseline every delta is
 *          taken against.
 *   ZSTD   the same three accounts, `encoding: base64+zstd`. `magicblock-aperture`'s
 *          `account_subscribe.rs` parses a full `RpcAccountInfoConfig` and hands the
 *          encoding to `encode_ui_account`, so the ER should compress server-side. Does
 *          a ~10x smaller frame arrive any sooner, and what does the client pay to
 *          inflate it?
 *   SLICE  the same three accounts, `encoding: base64` plus a `dataSlice` that keeps
 *          only the bytes this client would need: `arena[0..32]`, the whole 50-byte
 *          `boss`, and the single 96-byte `PlayerSlot` for our seat out of the 1,924-byte
 *          `Players`. That is the extreme of "receive only what changed" that the ER can
 *          express — a 20x cut on the largest account. If latency does not move, payload
 *          size is not on the critical path and every encoding and layout lever behind it
 *          is dead.
 *   FAN    21 subscriptions on ONE socket (players x19, arena, boss). The validator spawns
 *          a task and runs `encoder.encode` PER SUBSCRIPTION, so this is 19 encodes and 19
 *          frames per `Players` write on one connection. `notify.md` compared 1 account
 *          against 3; this asks whether the count matters at all once it is large.
 *
 * All four are direct to the pinned ER's own websocket, each on its own socket, watching
 * the SAME writes, so the submit half is byte-identical across channels and every
 * comparison is paired.
 *
 * The clock is the existing one: a `move` carries a u16 `seq`, the program echoes it into
 * `PlayerSlot.last_move_seq`, and a channel's write-to-visible for send N is the first
 * arrival on that channel carrying seq N. `sendAt` is stamped after signing, immediately
 * before the POST.
 *
 * Every frame's raw byte length is recorded and attributed to its account, which is the
 * other half of the question: what the feed actually costs in bytes and frames per second
 * with the 100 ms crank running.
 *
 * Reuses an EXISTING delegated arena rather than creating one. A fresh match costs ~0.026
 * SOL of unreclaimable ER-clonable rent and the treasury is down to 0.035; every
 * instruction this spike sends goes to the ER, where fees are zero.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_subshape.ts --bundle --platform=node --format=esm \
 *     --alias:@heartrot/client=/abs/path/packages/client/src/index.ts \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_subshape.mjs
 *   PS_ARENA_ID=1788266873 PS_SEAT=5 node /tmp/perf_subshape.mjs --out /tmp/perf_subshape.jsonl
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';

import {
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
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  PLAYER_SLOT,
  PLAYERS,
  assertErIdentity,
  claimSeat,
  createRpc,
  decodeArena,
  decodePlayers,
  getRoutes,
  isWall,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
  startMatch,
  stringifyWithBigints,
  type HeartrotRpc,
} from '@heartrot/client';

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
/** `player::MOVE_STEP` — one 16-unit tile per cardinal step. */
const STEP = 16;
/** `map::MAP_MAX_XY`, restated so a step off the lattice is caught before it is sent. */
const MAP_MAX_XY = 63 * 16 + 15;

const ARENA_ID = BigInt(process.env.PS_ARENA_ID ?? '0');
/** The measured seat. Its `last_move_seq` is the clock; the other movers are load. */
const SEAT = Number(process.env.PS_SEAT ?? 5);
const SAMPLES = Number(process.env.PS_SAMPLES ?? 400);
/** Two ER slots. One slot is the on-chain move limit; 100 ms keeps refusals near zero. */
const SEND_EVERY_MS = Number(process.env.PS_SEND_MS ?? 100);
/** Extra `Players` subscriptions on the FAN socket, on top of arena+boss+players. */
const FAN_EXTRA = Number(process.env.PS_FAN ?? 18);
/**
 * Seats driven at the same cadence as `SEAT`, purely to put the `Players` account under a
 * realistic write rate. One seat is a floor; the panel's 295 ms comes from a full raid.
 */
const EXTRA_SEATS = (process.env.PS_EXTRA_SEATS ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);
const CHANS = (process.env.PS_CHANS ?? 'B64,ZSTD,SLICE,FAN').split(',').map((s) => s.trim());

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/perf_subshape.jsonl' : (process.argv[i + 1] as string);
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

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

type AccountKind = 'arena' | 'boss' | 'players';

interface Channel {
  readonly name: string;
  /** seq -> wall clock of this channel's first frame carrying it. */
  readonly arrivals: Map<number, number>;
  /** Per account: frame count, total raw websocket bytes, and payload byte lengths. */
  readonly bytes: Record<AccountKind, { frames: number; wire: number; payload: number[] }>;
  /** Microseconds spent inflating zstd, when the channel is compressed. */
  readonly inflateUs: number[];
  errors: number;
  firstFrameAt: number;
  lastFrameAt: number;
}

function makeChannel(name: string): Channel {
  return {
    name,
    arrivals: new Map(),
    bytes: {
      arena: { frames: 0, wire: 0, payload: [] },
      boss: { frames: 0, wire: 0, payload: [] },
      players: { frames: 0, wire: 0, payload: [] },
    },
    inflateUs: [],
    errors: 0,
    firstFrameAt: 0,
    lastFrameAt: 0,
  };
}

interface SubSpec {
  readonly account: Address;
  readonly kind: AccountKind;
  readonly config: Record<string, unknown>;
}

/**
 * One websocket, N `accountSubscribe`s, feeding `chan`. Decoding is deliberately per
 * channel: a `dataSlice`d `Players` frame is 96 bytes with `last_move_seq` at offset 12
 * of the slice, and a `base64+zstd` frame has to be inflated first.
 */
function openSubscription(cfg: {
  chan: Channel;
  wsUrl: string;
  subs: readonly SubSpec[];
  /** Offset of this channel's `last_move_seq` within a decoded `Players` payload. */
  seqOffset: number;
  zstd: boolean;
  /**
   * `last_move_seq` as it stands on chain before the run. A reused seat carries the
   * previous run's counter, and without this the first frame would set the high-water
   * mark past every seq this run is about to send and the channel would record nothing.
   */
  initialSeq: number;
  onReady: () => void;
}): { close(): void } {
  const ws = new WebSocket(cfg.wsUrl);
  const requestKind = new Map<number, AccountKind>();
  const subKind = new Map<number, AccountKind>();
  let acked = 0;
  let lastSeq = cfg.initialSeq;

  ws.onopen = () => {
    cfg.subs.forEach((spec, i) => {
      requestKind.set(i + 1, spec.kind);
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: i + 1,
          method: 'accountSubscribe',
          params: [spec.account, spec.config],
        }),
      );
    });
  };

  ws.onmessage = (event: MessageEvent) => {
    const at = now();
    const raw = String(event.data);
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { subscription?: number; result?: { value?: { data?: string[] } } };
    };
    if (msg.error !== undefined) {
      cfg.chan.errors += 1;
      log('sub_error', { chan: cfg.chan.name, code: msg.error.code, message: msg.error.message });
      return;
    }
    if (msg.id !== undefined && typeof msg.result === 'number') {
      const kind = requestKind.get(msg.id);
      if (kind !== undefined) subKind.set(msg.result, kind);
      acked += 1;
      if (acked === cfg.subs.length) cfg.onReady();
      return;
    }
    if (msg.method !== 'accountNotification') return;
    const sub = msg.params?.subscription;
    const encoded = msg.params?.result?.value?.data?.[0];
    if (sub === undefined || encoded === undefined) return;
    const kind = subKind.get(sub);
    if (kind === undefined) return;

    if (cfg.chan.firstFrameAt === 0) cfg.chan.firstFrameAt = at;
    cfg.chan.lastFrameAt = at;
    const acct = cfg.chan.bytes[kind];
    acct.frames += 1;
    acct.wire += raw.length;
    acct.payload.push(encoded.length);
    if (kind !== 'players') return;

    let data = Buffer.from(encoded, 'base64');
    if (cfg.zstd) {
      const t0 = process.hrtime.bigint();
      data = zstdDecompressSync(data);
      cfg.chan.inflateUs.push(Number(process.hrtime.bigint() - t0) / 1000);
    }
    if (data.length < cfg.seqOffset + 2) return;
    const seq = data.readUInt16LE(cfg.seqOffset);
    // Strictly increasing: a stale frame must not register as a fresh observation.
    if (seq <= lastSeq) return;
    lastSeq = seq;
    if (!cfg.chan.arrivals.has(seq)) cfg.chan.arrivals.set(seq, at);
  };

  ws.onerror = () => {
    cfg.chan.errors += 1;
  };

  return {
    close() {
      ws.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (ARENA_ID === 0n) throw new Error('set PS_ARENA_ID to an already-delegated arena');

  const treasury = await createKeyPairSignerFromBytes(
    Uint8Array.from(
      JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
    ),
  );
  const { arena, boss, players } = await matchPdas(PROGRAM_ID, ARENA_ID);
  const route = (await getRoutes()).find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('no route for devnet-as');
  const er = createRpc(route.fqdn);
  await assertErIdentity(er, DEVNET_AS_IDENTITY);
  const erWs = route.fqdn.replace(/^https/, 'wss').replace(/^http:/, 'ws:');
  log('start', {
    arenaId: ARENA_ID.toString(),
    arena,
    boss,
    players,
    erFqdn: route.fqdn,
    erWs,
    seat: SEAT,
    samples: SAMPLES,
    sendEveryMs: SEND_EVERY_MS,
  });

  const readArena = async () => {
    const { value } = await er.getAccountInfo(arena, { encoding: 'base64' }).send();
    if (value === null) throw new Error('arena missing on the ER');
    return decodeArena(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
  };
  const readPlayers = async () => {
    const { value } = await er.getAccountInfo(players, { encoding: 'base64' }).send();
    if (value === null) throw new Error('players missing on the ER');
    return decodePlayers(Uint8Array.from(Buffer.from(value.data[0], 'base64')));
  };

  const before = await readArena();
  log('arena_state', { phase: before.phase, tick: before.tick, seatOccupied: before.seatOccupied });

  const seats = [SEAT, ...EXTRA_SEATS];
  const keys = new Map<number, { keyPair: CryptoKeyPair; session: Address }>();
  for (const seat of seats) {
    const keyPair = await generateKeyPair();
    const session = await getAddressFromPublicKey(keyPair.publicKey);
    const claimSig = await sendInstructions(er, treasury, [
      claimSeat({
        programId: PROGRAM_ID,
        arena,
        players,
        treasury: treasury.address,
        seat,
        skinId: 0,
        sessionPubkey: session,
        identity: Uint8Array.from(randomBytes(32)),
      }),
    ]);
    keys.set(seat, { keyPair, session });
    log('claim_seat', { signature: claimSig, seat, session });
  }
  await sleep(1_500);

  // The crank, so the three-account subscriptions carry a real match's traffic rather
  // than one account being written by one seat. An empty arena is not a wipe.
  if (before.phase === 0) {
    const startSig = await sendInstructions(er, treasury, [
      startMatch({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
    ]);
    log('start_match', { signature: startSig });
    await sleep(2_000);
  }
  const armed = await readArena();
  log('crank_armed', { phase: armed.phase, tick: armed.tick });

  const snapshot = await readPlayers();
  const cardinals: readonly { dir: number; dx: number; dy: number }[] = [
    { dir: 0, dx: 0, dy: -STEP },
    { dir: 2, dx: STEP, dy: 0 },
    { dir: 4, dx: 0, dy: STEP },
    { dir: 6, dx: -STEP, dy: 0 },
  ];
  const seatSeq0 = snapshot.slots[SEAT]?.lastMoveSeq ?? 0;
  const axes = new Map<number, readonly [number, number]>();
  for (const seat of seats) {
    const spawn = snapshot.slots[seat];
    if (spawn === undefined) throw new Error(`seat ${seat} missing after claim`);
    const walkable = cardinals.find((c) => {
      const nx = spawn.x + c.dx;
      const ny = spawn.y + c.dy;
      return nx >= 0 && ny >= 0 && nx <= MAP_MAX_XY && ny <= MAP_MAX_XY && !isWall(nx, ny);
    });
    if (walkable === undefined) throw new Error(`seat ${seat} is walled in at ${spawn.x},${spawn.y}`);
    axes.set(seat, [walkable.dir, (walkable.dir + 4) % 8]);
    log('axis', { seat, x: spawn.x, y: spawn.y, hp: spawn.hp, dirs: axes.get(seat) });
  }

  // ---- channels ----------------------------------------------------------
  const SLOT_OFF = PLAYERS.offsets.slots + SEAT * PLAYER_SLOT.size;
  const SEQ_IN_SLOT = PLAYER_SLOT.offsets.last_move_seq;
  const three = (config: Record<string, unknown>): SubSpec[] => [
    { account: arena, kind: 'arena', config },
    { account: boss, kind: 'boss', config },
    { account: players, kind: 'players', config },
  ];
  const sliceSubs: SubSpec[] = [
    { account: arena, kind: 'arena', config: { encoding: 'base64', dataSlice: { offset: 0, length: 32 } } },
    { account: boss, kind: 'boss', config: { encoding: 'base64', dataSlice: { offset: 0, length: 50 } } },
    {
      account: players,
      kind: 'players',
      config: { encoding: 'base64', dataSlice: { offset: SLOT_OFF, length: PLAYER_SLOT.size } },
    },
  ];
  const fanSubs: SubSpec[] = [
    ...three({ encoding: 'base64' }),
    ...Array.from({ length: FAN_EXTRA }, () => ({
      account: players,
      kind: 'players' as const,
      config: { encoding: 'base64' },
    })),
  ];

  /**
   * `B64B` is the control: byte-for-byte the same subscription as `B64` on a second
   * socket. Whatever it costs against `B64` is the noise floor of "two sockets watching
   * one write" — the ER serves them in some order — and no treatment delta is real
   * unless it clears that.
   */
  const specs: Record<string, { label: string; subs: SubSpec[]; seqOffset: number; zstd: boolean }> =
    {
      B64: {
        label: 'B64 base64, 3 accounts',
        subs: three({ encoding: 'base64' }),
        seqOffset: SLOT_OFF + SEQ_IN_SLOT,
        zstd: false,
      },
      B64B: {
        label: 'B64B identical control, 3 accounts',
        subs: three({ encoding: 'base64' }),
        seqOffset: SLOT_OFF + SEQ_IN_SLOT,
        zstd: false,
      },
      ZSTD: {
        label: 'ZSTD base64+zstd, 3 accounts',
        subs: three({ encoding: 'base64+zstd' }),
        seqOffset: SLOT_OFF + SEQ_IN_SLOT,
        zstd: true,
      },
      SLICE: {
        label: 'SLICE base64 + dataSlice, 3 accounts',
        subs: sliceSubs,
        seqOffset: SEQ_IN_SLOT,
        zstd: false,
      },
      FAN: {
        label: `FAN base64, ${3 + FAN_EXTRA} subscriptions`,
        subs: fanSubs,
        seqOffset: SLOT_OFF + SEQ_IN_SLOT,
        zstd: false,
      },
    };

  const chans: Record<string, Channel> = {};
  let ready = 0;
  const allReady = new Promise<void>((resolve) => {
    const bump = () => {
      ready += 1;
      if (ready === CHANS.length) resolve();
    };
    for (const name of CHANS) {
      const spec = specs[name];
      if (spec === undefined) throw new Error(`unknown channel ${name}`);
      chans[name] = makeChannel(spec.label);
      openSubscription({
        chan: chans[name] as Channel,
        wsUrl: erWs,
        subs: spec.subs,
        seqOffset: spec.seqOffset,
        zstd: spec.zstd,
        initialSeq: seatSeq0,
        onReady: bump,
      });
    }
  });
  await Promise.race([allReady, sleep(20_000)]);
  if (ready < CHANS.length) {
    throw new Error(`only ${ready}/${CHANS.length} channels acknowledged every subscription`);
  }
  log('subscribed', { ready, chans: CHANS });

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

  const sendAt = new Map<number, number>();
  const postMs: number[] = [];
  let failures = 0;
  const startedAt = now();

  const sendOne = async (seat: number, seq: number, timed: boolean): Promise<void> => {
    const key = keys.get(seat);
    const dirs = axes.get(seat);
    if (key === undefined || dirs === undefined) return;
    const dir = dirs[seq % 2] as number;
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(treasury.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            movePlayer({
              programId: PROGRAM_ID,
              arena,
              players,
              session: key.session,
              seat,
              dir,
              seq,
            }),
          ],
          m,
        ),
    );
    const signed = await signTransaction(
      [treasury.keyPair, key.keyPair],
      compileTransaction(message),
    );
    const wire = getBase64EncodedWireTransaction(signed);
    void getSignatureFromTransaction(signed);
    const t1 = now();
    if (timed) sendAt.set(seq, t1);
    try {
      await er
        .sendTransaction(wire as Parameters<HeartrotRpc['sendTransaction']>[0], {
          encoding: 'base64',
          skipPreflight: true,
        })
        .send();
      if (timed) postMs.push(now() - t1);
    } catch (error: unknown) {
      failures += 1;
      if (failures <= 3) log('send_failed', { seat, seq, error: String(error).slice(0, 160) });
    }
  };

  // Every seat runs its own paced loop. The measured seat is the only one whose sends are
  // timed; the rest exist to make `Players` a hot account.
  const loops = seats.map((seat) =>
    (async () => {
      for (let i = 0; i < SAMPLES; i += 1) {
        const t0 = now();
        await sendOne(seat, i + 1, seat === SEAT);
        const elapsed = now() - t0;
        if (elapsed < SEND_EVERY_MS) await sleep(SEND_EVERY_MS - elapsed);
        if (seat === SEAT && (i + 1) % 100 === 0) {
          log('progress', {
            seq: i + 1,
            acked: Object.fromEntries(CHANS.map((n) => [n, (chans[n] as Channel).arrivals.size])),
          });
        }
      }
    })(),
  );
  await Promise.all(loops);

  await sleep(3_000);
  const endedAt = now();
  stopped = true;
  await blockhashLoop;
  log('drained', { failures, postMs: stats(postMs), wallMs: endedAt - startedAt });

  // ---- results -----------------------------------------------------------
  const names = CHANS;
  const latency: Record<string, number[]> = {};
  for (const name of names) {
    const chan = chans[name] as Channel;
    const values: number[] = [];
    for (const [seq, at] of chan.arrivals) {
      const sent = sendAt.get(seq);
      if (sent !== undefined) values.push(at - sent);
    }
    latency[name] = values;
    const seconds = Math.max(1, (endedAt - startedAt) / 1000);
    const perAccount: Record<string, unknown> = {};
    let frames = 0;
    let wire = 0;
    for (const kind of ['arena', 'boss', 'players'] as const) {
      const a = chan.bytes[kind];
      frames += a.frames;
      wire += a.wire;
      perAccount[kind] = {
        frames: a.frames,
        framesPerSec: Math.round((a.frames / seconds) * 100) / 100,
        wireBytes: a.wire,
        payloadB64Bytes: stats(a.payload),
      };
    }
    log('channel', {
      chan: name,
      label: chan.name,
      errors: chan.errors,
      acked: chan.arrivals.size,
      latencyMs: stats(values),
      frames,
      framesPerSec: Math.round((frames / seconds) * 100) / 100,
      wireBytes: wire,
      wireBytesPerSec: Math.round(wire / seconds),
      perAccount,
      inflateUs: chan.inflateUs.length === 0 ? null : stats(chan.inflateUs),
    });
  }

  const baseline = chans.B64;
  if (baseline === undefined) throw new Error('B64 must be one of PS_CHANS');
  for (const name of names.filter((n) => n !== 'B64')) {
    const deltas: number[] = [];
    let wins = 0;
    for (const [seq, at] of (chans[name] as Channel).arrivals) {
      const base = baseline.arrivals.get(seq);
      if (base === undefined) continue;
      deltas.push(at - base);
      if (at < base) wins += 1;
    }
    log('paired', {
      pair: `${name} - B64`,
      deltaMs: stats(deltas),
      firstPct: deltas.length === 0 ? null : Math.round((wins / deltas.length) * 1000) / 10,
    });
  }

  log('raw', {
    latency,
    sendAt: [...sendAt],
    arrivals: Object.fromEntries(names.map((n) => [n, [...(chans[n] as Channel).arrivals]])),
  });

  if (process.argv.includes('--settle')) {
    const sig = await sendInstructions(er, treasury, [
      settle({ programId: PROGRAM_ID, payer: treasury.address, arena, boss, players }),
    ]);
    log('settle', { signature: sig });
  }
  process.exit(0);
}

void main().catch((error: unknown) => {
  log('fatal', { error: String(error).slice(0, 400) });
  process.exit(1);
});
