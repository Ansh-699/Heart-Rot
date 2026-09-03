/**
 * Reap stranded arenas: commit their state back to the base layer and undelegate them.
 *
 * WHY THIS EXISTS. An arena whose players all walked away is never settled by anyone. The
 * only production caller of `settle` (tag 9) requires a live seated player
 * (`worker/src/routes.ts` `matchSettle`), and the browser store is the only thing that
 * calls it — so a closed tab leaves the arena in `SETTLING`, still delegated, holding its
 * rent and one of the twelve slots `openArena` will walk before it gives up. Twelve of
 * those in a row is a game nobody can join, which is exactly what happened on devnet.
 *
 * `commitAndUndelegate` (tag 12) is the way home: treasury-gated, accepts
 * `Fighting`/`Settling`/`Rolled`/`Settled` -> `Settled`, undelegates from `Lobby` without
 * touching the phase, and is idempotent (`Settled -> Settled` is a legal edge) so a retry
 * after a lost confirmation is safe. It is refused only from `Rolling`, where a VRF
 * callback may still be in flight.
 *
 * It runs ON the ER, because that is where the delegated accounts live.
 *
 *   ESB=node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild
 *   "$ESB" scripts/ops/reap.ts --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/reap.mjs && node /tmp/reap.mjs [--apply] [count]
 *
 * Dry run by default. `--apply` sends. Reads the treasury key from
 * ~/.config/heartrot/treasury.json, which must be `Arena.crank_authority`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  matchPdas,
  leaderboardPda,
  decodeLeaderboard,
  decodeArena,
  commitAndUndelegate,
  sendInstructions,
  createRpc,
  getDelegationStatus,
} from '../../packages/client/src/index';
import { createSolanaRpc, createKeyPairSignerFromBytes } from '@solana/kit';

const BASE = 'https://rpc.magicblock.app/devnet';
const ROUTER = 'https://devnet-router.magicblock.app/';
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as never;

const APPLY = process.argv.includes('--apply');
const COUNT = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 16);

/** `Rolling` is the one phase tag 12 refuses — a VRF callback may still be in flight. */
const PHASE_LOBBY = 0;
const PHASE_ROLLING = 4;
const PHASE_NAMES = ['LOBBY', 'FIGHTING', 'SETTLING', 'SETTLED', 'ROLLING', 'ROLLED', 'MUSTERING'];

const base = createSolanaRpc(BASE);

async function acct(url: string, a: unknown): Promise<Uint8Array | null> {
  const rpc = url === BASE ? base : createSolanaRpc(url);
  const r = await rpc.getAccountInfo(a as never, { encoding: 'base64' }).send();
  return r.value ? Uint8Array.from(Buffer.from((r.value.data as string[])[0], 'base64')) : null;
}

const treasury = await createKeyPairSignerFromBytes(
  Uint8Array.from(
    JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[],
  ),
);

const lbd = await acct(BASE, await leaderboardPda(PROGRAM));
const head = lbd ? decodeLeaderboard(lbd).lastArenaId : 1n;
console.log(`treasury ${treasury.address}\nhead ${head}\nmode ${APPLY ? 'APPLY' : 'dry run'}\n`);

let reaped = 0;
let skipped = 0;

for (let step = 0; step < COUNT; step++) {
  const arenaId = head + BigInt(step);
  const pdas = await matchPdas(PROGRAM, arenaId);
  const status = await getDelegationStatus(pdas.arena, ROUTER);
  if (!status.isDelegated) {
    // Not delegated: either absent, or already committed home. Nothing to reap.
    const onBase = await acct(BASE, pdas.arena);
    const phase = onBase ? decodeArena(onBase).phase : null;
    console.log(`${arenaId}  not delegated  ${phase === null ? 'ABSENT' : PHASE_NAMES[phase]}`);
    continue;
  }

  const data = await acct(status.fqdn as string, pdas.arena);
  if (!data) {
    console.log(`${arenaId}  delegated but not cloned — skipping`);
    skipped++;
    continue;
  }
  const state = decodeArena(data);
  const name = PHASE_NAMES[state.phase] ?? String(state.phase);

  if (state.phase === PHASE_ROLLING) {
    console.log(`${arenaId}  ${name} — tag 12 is refused here, leaving it`);
    skipped++;
    continue;
  }

  // A delegated LOBBY is a WARM ROOM, not a stranded one — it is exactly what a joining
  // player is handed. Undelegating it does not destroy it (tag 12 leaves the phase alone
  // from `Lobby`) but it does un-warm it, so the next player pays the cold start this
  // whole change exists to remove. Caught the hard way: an earlier run reaped one.
  if (state.phase === PHASE_LOBBY) {
    console.log(`${arenaId}  LOBBY — warm and joinable, leaving it`);
    skipped++;
    continue;
  }

  if (!APPLY) {
    console.log(`${arenaId}  ${name} outcome=${state.outcome}  would reap`);
    reaped++;
    continue;
  }

  const ix = commitAndUndelegate({ programId: PROGRAM, payer: treasury.address, ...pdas });
  try {
    const sig = await sendInstructions(createRpc(status.fqdn as string) as never, treasury as never, [ix]);
    console.log(`${arenaId}  ${name} -> reaped  ${sig}`);
    reaped++;
  } catch (error) {
    console.log(`${arenaId}  ${name} -> FAILED  ${(error as Error).message.slice(0, 160)}`);
    skipped++;
  }
}

console.log(`\n${APPLY ? 'reaped' : 'would reap'} ${reaped}, skipped ${skipped}`);
