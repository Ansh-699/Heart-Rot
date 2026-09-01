/**
 * Why can nobody join? Prints what `openArena` sees, id by id.
 *
 * Run it whenever the Worker answers `no_open_arena`. It reads each candidate the way the
 * Worker does — router first, then the ER when the account is delegated — because reading
 * the BASE layer for a delegated arena is actively misleading: `delegate` zeroes the base
 * copy, so a live match reads back as `phase 0`, which decodes as LOBBY and looks joinable.
 * That is how a stranded `SETTLING` arena on the ER hid behind a base-layer read of 0.
 *
 *   ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
 *     scripts/probe/arena.ts --bundle --platform=node --format=esm \
 *     --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
 *     --outfile=/tmp/probe.mjs && node /tmp/probe.mjs
 */
import { matchPdas, leaderboardPda, decodeLeaderboard, decodeArena } from '../../packages/client/src/index';
import { createSolanaRpc } from '@solana/kit';

const BASE = 'https://rpc.magicblock.app/devnet';
const ROUTER = 'https://devnet-router.magicblock.app/';
const PROGRAM = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as any;

async function acct(url: string, a: any) {
  const r = await createSolanaRpc(url).getAccountInfo(a, { encoding: 'base64' }).send();
  return r.value ? Uint8Array.from(Buffer.from((r.value.data as any)[0], 'base64')) : null;
}
async function deleg(a: string) {
  const r = await fetch(ROUTER, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [a] }) });
  return (await r.json() as any).result;
}

const lbd = await acct(BASE, await leaderboardPda(PROGRAM));
const head = lbd ? decodeLeaderboard(lbd).lastArenaId : 1n;
console.log('lastArenaId', head.toString(), '\n');
for (let i = 0; i < 6; i++) {
  const id = head + BigInt(i);
  const p = await matchPdas(PROGRAM, id);
  const d = await deleg(p.arena);
  let via = 'base', data = await acct(BASE, p.arena);
  if (d?.isDelegated && d?.fqdn) { via = 'ER'; data = await acct(d.fqdn, p.arena); }
  const phase = data ? decodeArena(data).phase : null;
  console.log(`step ${i}  ${id}  delegated=${!!d?.isDelegated}  read=${via}  phase=${phase ?? 'ABSENT'}`);
}
