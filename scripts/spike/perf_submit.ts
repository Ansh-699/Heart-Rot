/**
 * PERF-SUBMIT — decompose the submit hop: "client decides to send" -> "sendTransaction returns".
 *
 * The read half has been measured before (sp-load). This measures the write half and
 * splits it into DNS / TCP / TLS / request-write / server-think / response-read, then
 * tests the levers that could move it:
 *
 *   H1  a fresh TCP+TLS handshake is being paid per send  (keep-alive vs cold)
 *   H2  HTTP/2 beats HTTP/1.1 on this endpoint            (undici allowH2)
 *   H3  pipelining helps                                  (undici pipelining)
 *   H4  the app pays TWO serial round trips per keypress, because `sendInstructions`
 *       fetches a blockhash before every single send      (app path vs cached blockhash)
 *
 * Everything is POSTed as the exact JSON-RPC body `@solana/kit` puts on the wire, and the
 * transactions are built and signed through `packages/client` so a wrong encoder fails
 * here rather than in front of a player.
 *
 * Run:
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/spike/perf_submit.ts --bundle --platform=node --format=esm \
 *     --define:import.meta.env='{"DEV":false}' \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_submit.mjs && node /tmp/perf_submit.mjs
 */

import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { lookup } from 'node:dns';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { writeFileSync, mkdirSync } from 'node:fs';
import { connect as h2Connect, constants as H2, type ClientHttp2Session } from 'node:http2';
import { Agent, Client, request as undiciRequest, type Dispatcher } from 'undici';

import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';

import { movePlayer } from '../../packages/client/src/instructions';

const ER_URL = 'https://devnet-as.magicblock.app/';
const ER_HOST = 'devnet-as.magicblock.app';
const PROGRAM = address('JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5');

/** Samples per phase. The brief asks for >=200. */
const N = Number(process.env['PERF_N'] ?? 220);
/** Pace, ms. The client sends one move per 50 ms ER slot; 100 ms is gentler than the app. */
const PACE_MS = Number(process.env['PERF_PACE'] ?? 100);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

interface Stats {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function stats(raw: readonly number[]): Stats {
  const v = [...raw].sort((a, b) => a - b);
  const at = (q: number): number => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? NaN;
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: v.length,
    min: v[0] ?? NaN,
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: v[v.length - 1] ?? NaN,
    mean: v.length === 0 ? NaN : sum / v.length,
  };
}

const r1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '—');

function row(label: string, s: Stats): string {
  return `| ${label} | ${s.n} | ${r1(s.min)} | ${r1(s.p50)} | ${r1(s.p90)} | ${r1(s.p95)} | ${r1(s.p99)} | ${r1(s.max)} | ${r1(s.mean)} |`;
}

const results: Record<string, Stats> = {};
const raw: Record<string, number[]> = {};
const notes: string[] = [];

function record(label: string, samples: number[]): Stats {
  const s = stats(samples);
  results[label] = s;
  raw[label] = samples;
  console.log(row(label, s));
  return s;
}

// ---------------------------------------------------------------------------
// phase 0 — DNS, TCP, TLS, ALPN, measured directly
// ---------------------------------------------------------------------------

function timeDns(): Promise<number> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    // `verbatim` + no cache flag: Node has no userland DNS cache, so every one of these
    // is a real resolver query unless the OS stub resolver caches it — which is exactly
    // what the app sees too.
    lookup(ER_HOST, { family: 4 }, (err) => {
      if (err) reject(err);
      else resolve(performance.now() - t0);
    });
  });
}

interface Handshake {
  tcpMs: number;
  tlsMs: number;
  alpn: string | null;
  ip: string;
}

function timeHandshake(): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const socket = createConnection({ host: ER_HOST, port: 443 });
    socket.once('error', reject);
    socket.once('connect', () => {
      const tcpMs = performance.now() - t0;
      const ip = socket.remoteAddress ?? '?';
      const t1 = performance.now();
      const tls = tlsConnect({
        socket,
        servername: ER_HOST,
        ALPNProtocols: ['h2', 'http/1.1'],
      });
      tls.once('error', reject);
      tls.once('secureConnect', () => {
        const tlsMs = performance.now() - t1;
        const alpn = tls.alpnProtocol === false ? null : (tls.alpnProtocol ?? null);
        tls.destroy();
        resolve({ tcpMs, tlsMs, alpn, ip });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// undici request timing, decomposed via diagnostics_channel
// ---------------------------------------------------------------------------

interface Marks {
  create: number;
  headersSent?: number;
  responseHeaders?: number;
  newSocket: boolean;
}

const marks = new WeakMap<object, Marks>();
let sawNewSocketSinceLastRequest = false;

function installChannels(): () => void {
  const onCreate = (evt: unknown): void => {
    const req = (evt as { request: object }).request;
    marks.set(req, { create: performance.now(), newSocket: sawNewSocketSinceLastRequest });
    sawNewSocketSinceLastRequest = false;
  };
  const onSend = (evt: unknown): void => {
    const req = (evt as { request: object }).request;
    const m = marks.get(req);
    if (m !== undefined) m.headersSent = performance.now();
  };
  const onHeaders = (evt: unknown): void => {
    const req = (evt as { request: object }).request;
    const m = marks.get(req);
    if (m !== undefined) m.responseHeaders = performance.now();
  };
  const onConnected = (): void => {
    sawNewSocketSinceLastRequest = true;
  };
  subscribe('undici:request:create', onCreate);
  subscribe('undici:client:sendHeaders', onSend);
  subscribe('undici:request:headers', onHeaders);
  subscribe('undici:client:connected', onConnected);
  return () => {
    unsubscribe('undici:request:create', onCreate);
    unsubscribe('undici:client:sendHeaders', onSend);
    unsubscribe('undici:request:headers', onHeaders);
    unsubscribe('undici:client:connected', onConnected);
  };
}

interface Timed {
  totalMs: number;
  /** decide -> request headers on the wire. Connection setup lands in here. */
  preWriteMs: number | null;
  /** headers written -> first response byte. Network RTT + server think. */
  inFlightMs: number | null;
  /** response headers -> body fully read. */
  drainMs: number | null;
  newSocket: boolean;
  body: string;
  status: number;
}

async function post(dispatcher: Dispatcher, body: string): Promise<Timed> {
  const t0 = performance.now();
  let captured: object | undefined;
  const onCreate = (evt: unknown): void => {
    captured = (evt as { request: object }).request;
  };
  subscribe('undici:request:create', onCreate);
  let res;
  try {
    res = await undiciRequest(ER_URL, {
      dispatcher,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } finally {
    unsubscribe('undici:request:create', onCreate);
  }
  const tHeaders = performance.now();
  const text = await res.body.text();
  const t1 = performance.now();
  const m = captured === undefined ? undefined : marks.get(captured);
  return {
    totalMs: t1 - t0,
    preWriteMs: m?.headersSent === undefined ? null : m.headersSent - t0,
    inFlightMs:
      m?.headersSent === undefined || m.responseHeaders === undefined
        ? null
        : m.responseHeaders - m.headersSent,
    drainMs: m?.responseHeaders === undefined ? null : t1 - m.responseHeaders,
    newSocket: m?.newSocket ?? false,
    body: text,
    status: res.statusCode,
  };
}

// ---------------------------------------------------------------------------
// real transactions, built through packages/client
// ---------------------------------------------------------------------------

const rpcBody = (method: string, params: unknown[], id: number): string =>
  JSON.stringify({ jsonrpc: '2.0', id, method, params });

async function fetchBlockhash(dispatcher: Dispatcher): Promise<{
  blockhash: string;
  lastValidBlockHeight: bigint;
  ms: number;
}> {
  const t = await post(dispatcher, rpcBody('getLatestBlockhash', [{ commitment: 'processed' }], 1));
  const parsed = JSON.parse(t.body) as {
    result?: { value: { blockhash: string; lastValidBlockHeight: number } };
  };
  if (parsed.result === undefined) throw new Error(`getLatestBlockhash: ${t.body.slice(0, 200)}`);
  return {
    blockhash: parsed.result.value.blockhash,
    lastValidBlockHeight: BigInt(parsed.result.value.lastValidBlockHeight),
    ms: t.totalMs,
  };
}

type Signer = Awaited<ReturnType<typeof generateKeyPairSigner>>;

interface Scene {
  signer: Signer;
  arena: Address;
  players: Address;
}

/**
 * Build + sign one real `move`. The accounts are not a live arena — under `skipPreflight`
 * the node sigverifies and admits the transaction without touching them, which is the hop
 * being measured. Wire size is identical to a live move.
 */
async function signMove(
  scene: Scene,
  blockhash: string,
  lastValidBlockHeight: bigint,
  seq: number,
): Promise<string> {
  const ix = movePlayer({
    programId: PROGRAM,
    arena: scene.arena,
    players: scene.players,
    session: scene.signer.address,
    seat: 0,
    dir: seq % 8,
    seq: seq % 65_536,
  });
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(scene.signer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash as Parameters<typeof setTransactionMessageLifetimeUsingBlockhash>[0]['blockhash'], lastValidBlockHeight },
        m,
      ),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  return getBase64EncodedWireTransaction(signed);
}

const sendBody = (wire: string, id: number): string =>
  rpcBody('sendTransaction', [wire, { encoding: 'base64', skipPreflight: true }], id);

// ---------------------------------------------------------------------------
// native HTTP/2 — what a browser actually speaks to this origin
// ---------------------------------------------------------------------------

/**
 * `undici`'s `allowH2` client serialises concurrent requests on one session, which reads
 * as a server-side queue and is not one: the ER advertises `maxConcurrentStreams: 256`
 * and answers eight concurrent streams in one RTT. Browsers use one HTTP/2 connection per
 * origin with real multiplexing, so the browser-faithful measurement has to be taken with
 * `node:http2` rather than through undici.
 */
function h2Post(session: ClientHttp2Session, body: string): Promise<{ totalMs: number; body: string }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const req = session.request({
      [H2.HTTP2_HEADER_METHOD]: 'POST',
      [H2.HTTP2_HEADER_PATH]: '/',
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    });
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      text += chunk;
    });
    req.on('end', () => {
      resolve({ totalMs: performance.now() - t0, body: text });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------

/** Run `n` paced sends on `dispatcher`, returning every decomposed timing. */
async function phaseSend(
  label: string,
  dispatcher: Dispatcher,
  scene: Scene,
  n: number,
  opts?: { freshBlockhashPerSend?: boolean },
): Promise<{ total: number[]; pre: number[]; flight: number[]; drain: number[]; newSockets: number; errors: Map<string, number> }> {
  const total: number[] = [];
  const pre: number[] = [];
  const flight: number[] = [];
  const drain: number[] = [];
  const errors = new Map<string, number>();
  let newSockets = 0;
  let bh = await fetchBlockhash(dispatcher);
  let bhAt = Date.now();

  for (let i = 0; i < n; i += 1) {
    const started = performance.now();
    if (opts?.freshBlockhashPerSend === true) {
      // The app's real path: `sendInstructions` fetches a blockhash before every send.
      bh = await fetchBlockhash(dispatcher);
    } else if (Date.now() - bhAt > 20_000) {
      bh = await fetchBlockhash(dispatcher);
      bhAt = Date.now();
    }
    const wire = await signMove(scene, bh.blockhash, bh.lastValidBlockHeight, i);
    const t = await post(dispatcher, sendBody(wire, i + 2));
    // For the app-path phase the interesting number is the whole decide->returned span.
    const span = opts?.freshBlockhashPerSend === true ? performance.now() - started : t.totalMs;
    total.push(span);
    if (t.preWriteMs !== null) pre.push(t.preWriteMs);
    if (t.inFlightMs !== null) flight.push(t.inFlightMs);
    if (t.drainMs !== null) drain.push(t.drainMs);
    if (t.newSocket) newSockets += 1;
    const parsed = JSON.parse(t.body) as { error?: { message: string } };
    if (parsed.error !== undefined) {
      const key = parsed.error.message.slice(0, 90);
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
    const slack = PACE_MS - (performance.now() - started);
    if (slack > 0) await sleep(slack);
  }

  record(`${label} · total`, total);
  if (pre.length > 0) record(`${label} · decide→bytes written`, pre);
  if (flight.length > 0) record(`${label} · written→first resp byte`, flight);
  if (drain.length > 0) record(`${label} · resp headers→body read`, drain);
  console.log(
    `  ${label}: new sockets ${newSockets}/${n}` +
      (errors.size === 0 ? ', no rpc errors' : `, rpc errors ${[...errors].map(([k, c]) => `${c}× ${k}`).join(' | ')}`),
  );
  return { total, pre, flight, drain, newSockets, errors };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const restore = installChannels();
  console.log(`| phase | n | min | p50 | p90 | p95 | p99 | max | mean |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);

  // ---- phase 0: connection setup, measured on its own -----------------------
  const dnsSamples: number[] = [];
  for (let i = 0; i < Math.min(60, N); i += 1) dnsSamples.push(await timeDns());
  record('dns lookup', dnsSamples);

  const tcp: number[] = [];
  const tls: number[] = [];
  let alpn: string | null = null;
  let ip = '?';
  for (let i = 0; i < Math.min(40, N); i += 1) {
    const h = await timeHandshake();
    tcp.push(h.tcpMs);
    tls.push(h.tlsMs);
    alpn = h.alpn;
    ip = h.ip;
    await sleep(30);
  }
  record('tcp connect (cold)', tcp);
  record('tls handshake (cold)', tls);
  notes.push(`ALPN negotiated: ${alpn ?? 'none'} · ER resolves to ${ip}`);
  console.log(`  ${notes[notes.length - 1] ?? ''}`);

  // ---- local work: sign + encode -------------------------------------------
  const scene: Scene = {
    signer: await generateKeyPairSigner(),
    arena: (await generateKeyPairSigner()).address,
    players: (await generateKeyPairSigner()).address,
  };
  const keepAlive = new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 1 });
  const bh0 = await fetchBlockhash(keepAlive);
  const signSamples: number[] = [];
  for (let i = 0; i < Math.max(N, 20); i += 1) {
    const t = performance.now();
    await signMove(scene, bh0.blockhash, bh0.lastValidBlockHeight, i);
    signSamples.push(performance.now() - t);
  }
  record('local sign+encode', signSamples);

  // ---- phase 1: warm keep-alive, HTTP/1.1 ----------------------------------
  const p1 = await phaseSend('h1 keep-alive send', keepAlive, scene, N);

  // ---- phase 5 (baseline): a trivial read on the same warm socket -----------
  const readSamples: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const t = performance.now();
    await post(keepAlive, rpcBody('getLatestBlockhash', [{ commitment: 'processed' }], i));
    readSamples.push(performance.now() - t);
    await sleep(Math.max(0, PACE_MS - (performance.now() - t)));
  }
  record('h1 keep-alive getLatestBlockhash', readSamples);

  // ---- phase 2: cold connection per send -----------------------------------
  const coldTotal: number[] = [];
  const coldPre: number[] = [];
  const coldFlight: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const started = performance.now();
    const cold = new Client(ER_URL, { keepAliveTimeout: 1, pipelining: 1 });
    try {
      const wire = await signMove(scene, bh0.blockhash, bh0.lastValidBlockHeight, i);
      const t = await post(cold, sendBody(wire, i));
      coldTotal.push(t.totalMs);
      if (t.preWriteMs !== null) coldPre.push(t.preWriteMs);
      if (t.inFlightMs !== null) coldFlight.push(t.inFlightMs);
    } finally {
      await cold.close();
    }
    const slack = PACE_MS - (performance.now() - started);
    if (slack > 0) await sleep(slack);
  }
  record('cold-connection send · total', coldTotal);
  record('cold-connection send · decide→bytes written', coldPre);
  record('cold-connection send · written→first resp byte', coldFlight);

  // ---- phase 3: HTTP/2, native, one warm session ----------------------------
  const h2session = h2Connect(ER_URL);
  await new Promise<void>((resolve, reject) => {
    h2session.once('remoteSettings', (rs) => {
      notes.push(`ER h2 SETTINGS: maxConcurrentStreams=${String(rs.maxConcurrentStreams)} initialWindowSize=${String(rs.initialWindowSize)}`);
      resolve();
    });
    h2session.once('error', reject);
  });
  {
    const bh = await fetchBlockhash(keepAlive);
    const serial: number[] = [];
    for (let i = 0; i < N; i += 1) {
      const started = performance.now();
      const wire = await signMove(scene, bh.blockhash, bh.lastValidBlockHeight, i);
      const t = await h2Post(h2session, sendBody(wire, i));
      serial.push(t.totalMs);
      const slack = PACE_MS - (performance.now() - started);
      if (slack > 0) await sleep(slack);
    }
    record('h2 native, one session, serial', serial);
  }

  // ---- phase 4: pipelining --------------------------------------------------
  const pipeAgent = new Agent({ pipelining: 8, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000, connections: 1 });
  const pipeSamples: number[] = [];
  {
    const bh = await fetchBlockhash(pipeAgent);
    const BURST = 8;
    for (let i = 0; i < N; i += BURST) {
      const started = performance.now();
      const wires = await Promise.all(
        Array.from({ length: BURST }, (_v, k) => signMove(scene, bh.blockhash, bh.lastValidBlockHeight, i + k)),
      );
      const ts = await Promise.all(wires.map((w, k) => post(pipeAgent, sendBody(w, i + k))));
      for (const t of ts) pipeSamples.push(t.totalMs);
      const slack = PACE_MS * BURST - (performance.now() - started);
      if (slack > 0) await sleep(slack);
    }
  }
  record('h1 pipelining=8 (burst of 8)', pipeSamples);

  // ---- phase 4b: HTTP/2 multiplexed burst, native ---------------------------
  // The fair concurrency test. HTTP/1.1 pipelining is head-of-line blocked by
  // construction; h2 puts the same eight sends on independent streams of one session,
  // which is exactly what a browser does with a burst of moves and shots.
  {
    const h2Burst: number[] = [];
    const bh = await fetchBlockhash(keepAlive);
    const BURST = 8;
    for (let i = 0; i < N; i += BURST) {
      const started = performance.now();
      const wires = await Promise.all(
        Array.from({ length: BURST }, (_v, k) => signMove(scene, bh.blockhash, bh.lastValidBlockHeight, i + k)),
      );
      const ts = await Promise.all(wires.map((w, k) => h2Post(h2session, sendBody(w, i + k))));
      for (const t of ts) h2Burst.push(t.totalMs);
      const slack = PACE_MS * BURST - (performance.now() - started);
      if (slack > 0) await sleep(slack);
    }
    record('h2 native multiplexed (burst of 8)', h2Burst);
  }

  // ---- phase 4c: eight SEPARATE warm connections, burst of 8 ----------------
  // The control for 4a/4b. If concurrency is serialised on one connection but not
  // across eight, the queue is the connection; if both ramp identically, the ER
  // serialises `sendTransaction` per client and no amount of sockets helps.
  const fanAgent = new Agent({ connections: 8, pipelining: 1, keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 });
  const fanSamples: number[] = [];
  {
    const bh = await fetchBlockhash(fanAgent);
    const BURST = 8;
    // Warm all eight sockets before measuring, so no handshake lands in a sample.
    await Promise.all(
      Array.from({ length: BURST }, (_v, k) => post(fanAgent, rpcBody('getIdentity', [], k))),
    );
    for (let i = 0; i < N; i += BURST) {
      const started = performance.now();
      const wires = await Promise.all(
        Array.from({ length: BURST }, (_v, k) => signMove(scene, bh.blockhash, bh.lastValidBlockHeight, i + k)),
      );
      const ts = await Promise.all(wires.map((w, k) => post(fanAgent, sendBody(w, i + k))));
      for (const t of ts) fanSamples.push(t.totalMs);
      const slack = PACE_MS * BURST - (performance.now() - started);
      if (slack > 0) await sleep(slack);
    }
  }
  record('h1 8 connections (burst of 8)', fanSamples);
  await fanAgent.close();

  // ---- phase 6: the app's real path — blockhash then send -------------------
  await phaseSend('APP PATH: blockhash+send', keepAlive, scene, N, { freshBlockhashPerSend: true });

  // ---- phase 7: how long is a cached ER blockhash usable? -------------------
  // The bound on the one lever this spike actually finds. A blockhash cache is only
  // safe if the cached value outlives the refresh interval by a wide margin, and an ER
  // runs 50 ms slots, so its 1200-block window burns eight times faster than base
  // devnet's. `isBlockhashValid` is the node's own answer, not an inference.
  {
    const first = await fetchBlockhash(keepAlive);
    const t0 = Date.now();
    let lastValidAge = 0;
    let firstInvalidAge: number | null = null;
    for (const ageS of [0, 5, 10, 20, 30, 45, 60, 90]) {
      while (Date.now() - t0 < ageS * 1000) await sleep(250);
      const t = await post(keepAlive, rpcBody('isBlockhashValid', [first.blockhash, { commitment: 'processed' }], 1));
      const ok = (JSON.parse(t.body) as { result?: { value: boolean } }).result?.value === true;
      console.log(`  blockhash age ${ageS}s: valid=${String(ok)}`);
      if (ok) lastValidAge = ageS;
      else {
        firstInvalidAge = ageS;
        break;
      }
    }
    notes.push(
      `cached ER blockhash: still valid at ${lastValidAge}s, ` +
        (firstInvalidAge === null ? 'never observed expiring within 90s' : `expired by ${firstInvalidAge}s`),
    );
    console.log(`  ${notes[notes.length - 1] ?? ''}`);
  }

  restore();
  await keepAlive.close();
  h2session.close();
  await pipeAgent.close();

  mkdirSync('/home/anshtyagi/Documents/pixel-artgame/docs/perf', { recursive: true });
  writeFileSync(
    '/home/anshtyagi/Documents/pixel-artgame/docs/perf/submit-raw.json',
    JSON.stringify({ at: new Date().toISOString(), alpn, ip, notes, results, raw }, null, 1),
  );

  console.log('\n--- summary table ---');
  console.log(`| phase | n | min | p50 | p90 | p95 | p99 | max | mean |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const [k, v] of Object.entries(results)) console.log(row(k, v));
  for (const n of notes) console.log(`note: ${n}`);
  console.log(`warm-phase new sockets: ${p1.newSockets}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
