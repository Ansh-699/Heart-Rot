/**
 * PERF-CLIENTSIDE — how much of write-to-visible is the browser's own CPU?
 *
 * Write-to-visible is measured in `app/src/net/metrics.ts` as submit -> the notification
 * carrying that `seq` reaching the client. `docs/spikes/sp-load.md` split the network
 * halves (execute ~140 ms after send, ~155 ms unattributed on the read path). This spike
 * fills in the only term nobody has ever timed: the work the client does at each end.
 *
 * READ PATH, per notification:
 *   JSON.parse(envelope) -> fromBase64 -> decodeArena/Boss/Players -> store.setWorld
 *
 * SEND PATH, per keypress, inside `sendInstructions`:
 *   getLatestBlockhash (NETWORK) -> build message -> Ed25519 sign -> base64 wire encode
 *
 * Everything measured runs the production code: the decoders come from
 * `packages/client`, the store from `app/src/state/store.ts`, and the signer is
 * `createSessionSigner` over a real non-extractable WebCrypto Ed25519 key — the same
 * object `App.tsx` hands to `sendInstructions`. `fromBase64` is the one copy, because
 * `subscribe.ts` keeps it module-private; it is copied verbatim and a drift there would
 * only make this spike optimistic, never the app.
 *
 * Payloads are real bytes for the newest arena the leaderboard names, read from whichever
 * chain currently owns it, and — when a match happens to be live — whole notification
 * envelopes captured off the router WebSocket.
 *
 * Run — the two aliases are required: `@heartrot/client` and `react` are linked into
 * `app/node_modules`, not the root, so esbuild resolving from `scripts/` finds neither.
 *
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_clientside.ts --bundle --platform=node --format=esm \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --alias:@heartrot/client=./packages/client/src/index.ts \
 *     --alias:react=./app/node_modules/react \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_clientside.mjs && node /tmp/perf_clientside.mjs
 */

import { appendFileSync } from 'node:fs';

import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressDecoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';

import {
  ROUTER_ENDPOINT,
  createRpc,
  createSessionSigner,
  decodeArena,
  decodeBoss,
  decodeLeaderboard,
  decodePlayers,
  getDelegationStatus,
  leaderboardPda,
  matchPdas,
  movePlayer,
  stringifyWithBigints,
  type Session,
} from '@heartrot/client';

import { createStore } from '../../app/src/state/store';

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const ROUTER_WS = 'wss://devnet-router.magicblock.app/';
/**
 * The ER the app is pinned to. The send-path round trip is timed against this whatever the
 * newest arena's delegation state happens to be: `sendInstructions` fetches its blockhash
 * from the endpoint it is about to send to, and for gameplay that endpoint is always this
 * one. Timing it against base devnet instead would measure a different continent.
 */
const ER_URL = process.env.PC_ER ?? 'https://devnet-as.magicblock.app/';

/** Local CPU iterations per stage. The task's floor is 1,000. */
const ITERS = Number(process.env.PC_ITERS ?? 2_000);
const WARMUP = 300;
/** Network samples for the blockhash round trip. The task's floor is 100. */
const NET_SAMPLES = Number(process.env.PC_NET ?? 120);
/** How long to sit on the router WS hoping a live match writes something. */
const CAPTURE_MS = Number(process.env.PC_CAPTURE_MS ?? 15_000);

const outPath = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/perf_clientside.jsonl' : (process.argv[i + 1] as string);
})();

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), event, ...fields };
  appendFileSync(outPath, `${stringifyWithBigints(line)}\n`);
  console.log(`${line.t} ${event} ${stringifyWithBigints(fields)}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Percentiles over a sample set. Never report one reading. */
function stats(samples: number[], digits = 3): Record<string, number> {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
  const round = (x: number): number => Number(x.toFixed(digits));
  return {
    n: s.length,
    p50: round(at(50)),
    p95: round(at(95)),
    p99: round(at(99)),
    min: round(s[0] ?? 0),
    max: round(s[s.length - 1] ?? 0),
    mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)),
  };
}

/**
 * Time one synchronous unit of work `ITERS` times, individually. Per-call `hrtime`
 * overhead is ~40 ns here and every stage measured is at least a microsecond, so it is
 * reported rather than subtracted — subtracting a number you cannot see is how a
 * microbenchmark starts lying.
 *
 * The result is returned into a sink so V8 cannot eliminate the call it is timing.
 */
let sink: unknown;
function benchSync(name: string, fn: () => unknown): Record<string, number> {
  for (let i = 0; i < WARMUP; i++) sink = fn();
  const samples: number[] = new Array(ITERS) as number[];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    sink = fn();
    samples[i] = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const out = stats(samples);
  log(`bench_${name}`, { unit: 'ms', ...out });
  return out;
}

async function benchAsync(name: string, fn: () => Promise<unknown>): Promise<Record<string, number>> {
  for (let i = 0; i < Math.min(WARMUP, 50); i++) sink = await fn();
  const samples: number[] = [];
  for (let i = 0; i < ITERS; i++) {
    const t0 = process.hrtime.bigint();
    sink = await fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const out = stats(samples);
  log(`bench_${name}`, { unit: 'ms', ...out });
  return out;
}

// ---------------------------------------------------------------------------
// The read path, verbatim from app/src/net/subscribe.ts
// ---------------------------------------------------------------------------

/** Copied byte for byte from `subscribe.ts`; it is module-private there. */
function fromBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The candidate replacement: one native call, no per-byte JS loop. */
const nativeFromBase64 = (
  Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }
).fromBase64;

// ---------------------------------------------------------------------------
// Payload discovery — real bytes for a real arena
// ---------------------------------------------------------------------------

type Payloads = {
  arenaId: bigint;
  addresses: { arena: Address; boss: Address; players: Address };
  /** base64 account data, exactly as it crosses the wire. */
  b64: { arena: string; boss: string; players: string };
  /** Whole `accountNotification` frames, when a live match produced any. */
  captured: { arena?: string; boss?: string; players?: string };
  source: string;
  erFqdn: string | null;
};

function encodedData(account: { readonly data: unknown } | null): string | undefined {
  if (account === null) return undefined;
  const { data } = account;
  if (!Array.isArray(data)) return undefined;
  const [encoded] = data as readonly unknown[];
  return typeof encoded === 'string' ? encoded : undefined;
}

async function discover(): Promise<Payloads> {
  const base = createRpc(BASE_URL);
  const lb = await leaderboardPda(PROGRAM_ID);
  const { value: lbAccount } = await base.getAccountInfo(lb, { encoding: 'base64' }).send();
  const lbData = encodedData(lbAccount);
  if (lbData === undefined) throw new Error('leaderboard account not found on base layer');
  const leaderboard = decodeLeaderboard(fromBase64(lbData));
  const arenaId = leaderboard.lastArenaId;
  log('leaderboard', {
    pda: lb,
    arenaId,
    totalWritten: leaderboard.totalWritten,
    lastIncarnation: leaderboard.lastIncarnation,
  });

  const pdas = await matchPdas(PROGRAM_ID, arenaId);
  const addresses = { arena: pdas.arena, boss: pdas.boss, players: pdas.players };
  log('pdas', addresses);

  // A delegated account only reads correctly from the ER that holds it. Resolve the one
  // this arena is pinned to rather than guessing an fqdn.
  const status = await getDelegationStatus(addresses.arena, ROUTER_ENDPOINT);
  const erFqdn = status.isDelegated && status.fqdn !== undefined ? status.fqdn : null;
  log('delegation', { isDelegated: status.isDelegated, fqdn: erFqdn ?? '(none)' });

  const rpc = erFqdn === null ? base : createRpc(erFqdn);
  const { value } = await rpc
    .getMultipleAccounts([addresses.arena, addresses.boss, addresses.players], {
      encoding: 'base64',
    })
    .send();
  const b64 = {
    arena: encodedData(value[0] ?? null) ?? '',
    boss: encodedData(value[1] ?? null) ?? '',
    players: encodedData(value[2] ?? null) ?? '',
  };
  for (const [kind, data] of Object.entries(b64)) {
    if (data === '') throw new Error(`${kind} account has no data on ${erFqdn ?? BASE_URL}`);
  }
  log('payload_sizes', {
    source: erFqdn ?? BASE_URL,
    arena_b64: b64.arena.length,
    boss_b64: b64.boss.length,
    players_b64: b64.players.length,
    arena_bytes: fromBase64(b64.arena).length,
    boss_bytes: fromBase64(b64.boss).length,
    players_bytes: fromBase64(b64.players).length,
  });

  return {
    arenaId,
    addresses,
    b64,
    captured: await captureFrames(addresses),
    source: erFqdn ?? BASE_URL,
    erFqdn,
  };
}

/**
 * Sit on the router WebSocket — the exact socket `subscribe.ts` uses — and keep the raw
 * text of one `accountNotification` per kind. Only a live match writes, so this is
 * best-effort by construction and the caller falls back to a frame built around the same
 * real base64 payload.
 */
async function captureFrames(addresses: {
  arena: Address;
  boss: Address;
  players: Address;
}): Promise<{ arena?: string; boss?: string; players?: string }> {
  const captured: { arena?: string; boss?: string; players?: string } = {};
  const kinds = ['arena', 'boss', 'players'] as const;
  const subKind = new Map<number, (typeof kinds)[number]>();
  const reqKind = new Map<number, (typeof kinds)[number]>();

  const ws = new WebSocket(ROUTER_WS);
  let frames = 0;
  await new Promise<void>((resolve) => {
    const done = setTimeout(() => {
      ws.close();
      resolve();
    }, CAPTURE_MS);
    ws.onopen = () => {
      kinds.forEach((kind, i) => {
        reqKind.set(i + 1, kind);
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: i + 1,
            method: 'accountSubscribe',
            params: [addresses[kind], { encoding: 'base64' }],
          }),
        );
      });
    };
    ws.onmessage = (event: MessageEvent) => {
      const text = String(event.data);
      const msg = JSON.parse(text) as {
        id?: number;
        result?: unknown;
        method?: string;
        params?: { subscription?: number };
      };
      if (msg.id !== undefined && typeof msg.result === 'number') {
        const kind = reqKind.get(msg.id);
        if (kind !== undefined) subKind.set(msg.result, kind);
        return;
      }
      if (msg.method !== 'accountNotification') return;
      const kind = msg.params?.subscription === undefined ? undefined : subKind.get(msg.params.subscription);
      if (kind === undefined) return;
      frames++;
      captured[kind] = text;
      if (captured.arena !== undefined && captured.boss !== undefined && captured.players !== undefined) {
        clearTimeout(done);
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(done);
      ws.close();
      resolve();
    };
  });
  log('ws_capture', {
    windowMs: CAPTURE_MS,
    frames,
    got: kinds.filter((k) => captured[k] !== undefined).join(',') || '(none — no live match writing)',
  });
  return captured;
}

/**
 * The envelope `subscribe.ts` parses. Used only for a kind the capture window missed; the
 * base64 payload inside is still the real account, which is what the parse cost scales
 * with. The shape is copied from a captured frame when there is one.
 */
function envelopeFor(kind: 'arena' | 'boss' | 'players', p: Payloads): { text: string; real: boolean } {
  const real = p.captured[kind];
  if (real !== undefined) return { text: real, real: true };
  return {
    text: JSON.stringify({
      jsonrpc: '2.0',
      method: 'accountNotification',
      params: {
        result: {
          context: { slot: 123456789 },
          value: {
            lamports: 3000000,
            data: [p.b64[kind], 'base64'],
            owner: 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh',
            executable: false,
            rentEpoch: 18446744073709551615,
            space: fromBase64(p.b64[kind]).length,
          },
        },
        subscription: 1,
      },
    }),
    real: false,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log('start', { iters: ITERS, netSamples: NET_SAMPLES, node: process.version });

  const p = await discover();

  // -------------------------------------------------------------------------
  // READ PATH
  // -------------------------------------------------------------------------
  const env = {
    arena: envelopeFor('arena', p),
    boss: envelopeFor('boss', p),
    players: envelopeFor('players', p),
  };
  log('envelopes', {
    arena: `${env.arena.text.length} B ${env.arena.real ? 'captured' : 'reconstructed'}`,
    boss: `${env.boss.text.length} B ${env.boss.real ? 'captured' : 'reconstructed'}`,
    players: `${env.players.text.length} B ${env.players.real ? 'captured' : 'reconstructed'}`,
  });

  type Frame = { params?: { result?: { value?: { data?: string[] } } } };
  const read: Record<string, Record<string, number>> = {};

  read.json_parse_players = benchSync('json_parse_players', () => JSON.parse(env.players.text));
  read.json_parse_arena = benchSync('json_parse_arena', () => JSON.parse(env.arena.text));
  read.json_parse_boss = benchSync('json_parse_boss', () => JSON.parse(env.boss.text));

  read.base64_players = benchSync('base64_players_atob_loop', () => fromBase64(p.b64.players));
  read.base64_arena = benchSync('base64_arena_atob_loop', () => fromBase64(p.b64.arena));
  read.base64_boss = benchSync('base64_boss_atob_loop', () => fromBase64(p.b64.boss));
  if (nativeFromBase64 !== undefined) {
    read.base64_players_native = benchSync('base64_players_native', () =>
      nativeFromBase64.call(Uint8Array, p.b64.players),
    );
  } else {
    log('base64_native_unavailable', { note: 'Uint8Array.fromBase64 not present in this runtime' });
  }

  const bytes = {
    arena: fromBase64(p.b64.arena),
    boss: fromBase64(p.b64.boss),
    players: fromBase64(p.b64.players),
  };
  read.decode_players = benchSync('decode_players', () => decodePlayers(bytes.players));
  read.decode_arena = benchSync('decode_arena', () => decodeArena(bytes.arena));
  read.decode_boss = benchSync('decode_boss', () => decodeBoss(bytes.boss));

  // The whole hop for one Players notification, end to end, exactly as `handle` ->
  // `deliver` -> `setWorld` runs it.
  const store = createStore();
  let notified = 0;
  store.subscribe(() => {
    notified++;
  });
  read.hop_players = benchSync('hop_players_parse_decode_store', () => {
    const msg = JSON.parse(env.players.text) as Frame;
    const encoded = msg.params?.result?.value?.data?.[0];
    if (encoded === undefined) throw new Error('envelope lost its data');
    const players = decodePlayers(fromBase64(encoded));
    store.setWorld({ players });
    return players;
  });
  read.hop_arena = benchSync('hop_arena_parse_decode_store', () => {
    const msg = JSON.parse(env.arena.text) as Frame;
    const encoded = msg.params?.result?.value?.data?.[0];
    if (encoded === undefined) throw new Error('envelope lost its data');
    const arena = decodeArena(fromBase64(encoded));
    store.setWorld({ arena });
    return arena;
  });
  log('store_notifications', { notified });

  // -------------------------------------------------------------------------
  // SEND PATH
  // -------------------------------------------------------------------------
  const erUrl = p.erFqdn ?? ER_URL;
  const er = createRpc(erUrl);

  // The real signer: a non-extractable WebCrypto Ed25519 key behind `createSessionSigner`,
  // which is what the browser holds. Nothing is funded and nothing is sent.
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const sessionAddress = getAddressDecoder().decode(raw);
  const signer = createSessionSigner({
    address: sessionAddress,
    keyPair,
  } as unknown as Session);
  log('session_signer', { address: sessionAddress, extractable: keyPair.privateKey.extractable });

  /**
   * One RPC method, timed over the real link. `getSlot` is run alongside `getLatestBlockhash`
   * so the answer distinguishes "this method is expensive" from "a POST to Singapore from
   * India costs this much" — the second is physics and the first would be a lever.
   */
  const netBench = async (name: string, call: () => Promise<unknown>): Promise<Record<string, number>> => {
    const samples: number[] = [];
    for (let i = 0; i < NET_SAMPLES; i++) {
      const t0 = process.hrtime.bigint();
      await call();
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      await sleep(20);
    }
    const out = stats(samples, 1);
    log(`bench_${name}`, { unit: 'ms', endpoint: erUrl, ...out });
    return out;
  };

  const blockhashStats = await netBench('getLatestBlockhash_network', () =>
    er.getLatestBlockhash().send(),
  );
  const slotStats = await netBench('getSlot_network', () => er.getSlot().send());

  const { value: latestBlockhash } = await er.getLatestBlockhash().send();
  const ix = movePlayer({
    programId: PROGRAM_ID,
    arena: p.addresses.arena,
    players: p.addresses.players,
    session: sessionAddress,
    seat: 0,
    dir: 2,
    seq: 1,
  });

  const send: Record<string, Record<string, number>> = {};
  send.build = benchSync('send_build_message', () =>
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
      (m) => appendTransactionMessageInstructions([ix], m),
    ),
  );
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  send.sign = await benchAsync('send_sign_webcrypto_ed25519', () =>
    signTransactionMessageWithSigners(message),
  );
  const signed = await signTransactionMessageWithSigners(message);
  send.encode = benchSync('send_encode_wire_base64', () => getBase64EncodedWireTransaction(signed));
  send.signature = benchSync('send_signature_from_tx', () => getSignatureFromTransaction(signed));

  // -------------------------------------------------------------------------
  // VERDICT
  // -------------------------------------------------------------------------
  const readCpu = (read.hop_players?.p50 ?? 0) + (read.hop_arena?.p50 ?? 0);
  const sendCpu =
    (send.build?.p50 ?? 0) + (send.sign?.p50 ?? 0) + (send.encode?.p50 ?? 0) + (send.signature?.p50 ?? 0);
  log('verdict', {
    unit: 'ms',
    read_cpu_per_tick_p50: Number(readCpu.toFixed(3)),
    send_cpu_p50: Number(sendCpu.toFixed(3)),
    blockhash_network_p50: blockhashStats.p50,
    blockhash_network_p95: blockhashStats.p95,
    getSlot_network_p50: slotStats.p50,
    note: 'the blockhash fetch is a full round trip and sendInstructions pays it per keypress',
  });
  log('done', { out: outPath });
}

main().catch((error: unknown) => {
  log('fatal', { error: String(error) });
  process.exitCode = 1;
});
