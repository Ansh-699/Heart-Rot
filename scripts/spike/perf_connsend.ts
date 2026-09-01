/**
 * PERF-CONNSEND — before/after on the change actually shipped in
 * `packages/client/src/connection.ts`: the blockhash cache inside `sendInstructions`.
 *
 * Both arms go through the REAL `sendInstructions`/`createRpc` from packages/client, on
 * ONE warm keep-alive connection, interleaved sample by sample so drift and congestion hit
 * both equally:
 *
 *   BEFORE — the pre-change code path, replicated locally: getLatestBlockhash, then build,
 *            sign and send. Two serial round trips.
 *   AFTER  — `sendInstructions` as it now ships, served from the per-rpc cache.
 *
 * Timed interval is exactly what the app's `recordSend` fences: "client decides to send"
 * -> "sendTransaction returns".
 *
 * The accounts are synthetic. Under `skipPreflight` the node sigverifies and admits
 * without touching them, which is the whole of the hop being measured, and the wire size
 * is identical to a live `move` — the same method perf_submit.ts used.
 *
 * Run:
 *   ./node_modules/.pnpm/node_modules/.bin/esbuild scripts/spike/perf_connsend.ts \
 *     --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/perf_connsend.mjs && node /tmp/perf_connsend.mjs
 */

import {
  address,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';

import { createRpc, sendInstructions, type HeartrotRpc } from '../../packages/client/src/connection';
import { movePlayer, shoot } from '../../packages/client/src/instructions';

const ER_URL = 'https://devnet-as.magicblock.app/';
const PROGRAM = address('JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5');

const N = Number(process.env['PC_N'] ?? 200);
const PACE_MS = Number(process.env['PC_PACE'] ?? 100);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function stats(raw: readonly number[]): string {
  const v = [...raw].sort((a, b) => a - b);
  const at = (q: number): number => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? NaN;
  const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '—');
  return `n=${v.length} min=${f(v[0] ?? NaN)} p50=${f(at(0.5))} p90=${f(at(0.9))} p95=${f(at(0.95))} max=${f(v[v.length - 1] ?? NaN)}`;
}

async function main(): Promise<void> {
  const rpcAfter = createRpc(ER_URL);
  const rpcBefore = createRpc(ER_URL);
  const signer = await generateKeyPairSigner();
  const arena: Address = (await generateKeyPairSigner()).address;
  const players: Address = (await generateKeyPairSigner()).address;

  const move = (seq: number) =>
    movePlayer({ programId: PROGRAM, arena, players, session: signer.address, seat: 0, dir: seq % 8, seq: seq % 65_536 });

  /** The pre-change `sendInstructions`, verbatim. */
  const sendFresh = async (rpc: HeartrotRpc, seq: number): Promise<void> => {
    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
    const signed = await signTransactionMessageWithSigners(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(signer, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
        (m) => appendTransactionMessageInstructions([move(seq)], m),
      ),
    );
    await rpc
      .sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: 'base64', skipPreflight: true })
      .send();
  };

  // Warm both sockets and seed the cache, so neither arm is charged a handshake.
  await sendFresh(rpcBefore, 0);
  await sendInstructions(rpcAfter, signer, [move(0)]);

  const before: number[] = [];
  const after: number[] = [];
  let beforeErr = 0;
  let afterErr = 0;

  for (let i = 1; i <= N; i += 1) {
    for (const arm of ['before', 'after'] as const) {
      const t0 = performance.now();
      try {
        if (arm === 'before') await sendFresh(rpcBefore, i);
        else await sendInstructions(rpcAfter, signer, [move(i)]);
        (arm === 'before' ? before : after).push(performance.now() - t0);
      } catch {
        if (arm === 'before') beforeErr += 1;
        else afterErr += 1;
      }
      await sleep(PACE_MS / 2);
    }
  }

  console.log(`BEFORE (fetch-then-send) ${stats(before)} errors=${beforeErr}`);
  console.log(`AFTER  (cached blockhash) ${stats(after)} errors=${afterErr}`);
  const med = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? NaN;
  console.log(`delta p50 = ${(med(after) - med(before)).toFixed(1)} ms`);

  // --- dedupe check: repeat the SAME `shoot` under a held blockhash. Pre-change this was
  // unique by accident (fresh hash per send); post-change `sendInstructions` must notice
  // the collision and re-sign rather than let the node refuse the repeat.
  const boss: Address = (await generateKeyPairSigner()).address;
  const fire = shoot({ programId: PROGRAM, arena, boss, players, session: signer.address, seat: 0, dir: 2 });
  const sigs: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    sigs.push(await sendInstructions(rpcAfter, signer, [fire]));
    await sleep(60);
  }
  const unique = new Set(sigs).size;
  console.log(`shoot dedupe: ${unique}/${sigs.length} distinct signatures (must be ${sigs.length})`);
  if (unique !== sigs.length) throw new Error('shoot repeats collapsed to one signature');
}

void main();
