/**
 * Pre-warm the next arena: create it and delegate it, so a joining player only ever has to
 * claim a seat.
 *
 * WHY THIS EXISTS. `sessionInit` used to do this inline, on the player's click: walk the
 * scan, `init_arena`, `delegate`, then `connectMatch` — which polls up to 600 times across
 * two 30 s phases waiting for three delegation records and three ER clones. All of it
 * uncaught, all of it inside one request, and any of it can blow the subrequest budget or
 * time out. The player sees "the server hit an error it did not expect".
 *
 * Arena lifecycle does not belong on a player's request. The Worker does this in
 * `ctx.waitUntil` after a join; this script is the same steps by hand, for a cold start or
 * an operator unblock.
 *
 *   ESB=node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild
 *   "$ESB" scripts/ops/warm.ts --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/warm.mjs && node /tmp/warm.mjs
 *
 * Idempotent: if the first joinable arena is already a delegated LOBBY, it does nothing.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  matchPdas,
  leaderboardPda,
  decodeLeaderboard,
  decodeArena,
  initArena,
  delegate,
  sendInstructions,
  createRpc,
  getDelegationStatus,
} from '../../packages/client/src/index';
import { createSolanaRpc, createKeyPairSignerFromBytes, address } from '@solana/kit';

const BASE = 'https://rpc.magicblock.app/devnet';
const ROUTER = 'https://devnet-router.magicblock.app/';
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as never;
const VALIDATOR = address('MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57');
const PHASE_LOBBY = 0;

const base = createSolanaRpc(BASE);
async function acct(a: unknown): Promise<Uint8Array | null> {
  const r = await base.getAccountInfo(a as never, { encoding: 'base64' }).send();
  return r.value ? Uint8Array.from(Buffer.from((r.value.data as string[])[0], 'base64')) : null;
}

const treasury = await createKeyPairSignerFromBytes(
  Uint8Array.from(
    JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
  ),
);
const lbd = await acct(await leaderboardPda(PROGRAM));
const head = lbd ? decodeLeaderboard(lbd).lastArenaId : 1n;

// Walk to the first id that is absent, or already a LOBBY we can just hand out.
let target: bigint | null = null;
let pdas: Awaited<ReturnType<typeof matchPdas>> | null = null;
for (let step = 0; step < 40; step++) {
  const id = head + BigInt(step);
  const p = await matchPdas(PROGRAM, id);
  const data = await acct(p.arena);
  if (!data) {
    target = id;
    pdas = p;
    break;
  }
  if (decodeArena(data).phase === PHASE_LOBBY) {
    const st = await getDelegationStatus(p.arena, ROUTER);
    if (st.isDelegated) {
      console.log(`${id} is already a warm LOBBY — nothing to do`);
      process.exit(0);
    }
    target = id;
    pdas = p;
    break;
  }
}
if (!target || !pdas) throw new Error('no absent or lobby id within 40 steps of the head');

if ((await acct(pdas.arena)) === null) {
  const ix = initArena({
    programId: PROGRAM,
    payer: treasury.address,
    ...pdas,
    arenaId: target,
    incarnation: 1,
    validatorIdentity: VALIDATOR,
    crankAuthority: treasury.address,
  });
  const sig = await sendInstructions(createRpc(BASE) as never, treasury as never, [ix]);
  console.log(`created ${target}  ${sig}`);
} else {
  console.log(`${target} already exists on base`);
}

const status = await getDelegationStatus(pdas.arena, ROUTER);
if (status.isDelegated) {
  console.log(`${target} already delegated`);
} else {
  const ix = await delegate({ programId: PROGRAM, payer: treasury.address, ...pdas });
  const sig = await sendInstructions(createRpc(BASE) as never, treasury as never, [ix]);
  console.log(`delegated ${target}  ${sig}`);
}
console.log(`warm: ${target}`);
