/**
 * The Worker's OWN `sessionInit` (and `matchLeave` to give the seat back), run in node
 * against the live chain with the Privy check stubbed out. Not a re-implementation: the
 * bundler is pointed at `worker/src/routes.ts` itself with `./auth` swapped for a stub
 * (see `scripts/ops/workerprobe.sh`), so what runs here is what runs on Cloudflare —
 * minus workerd's six-connection cap and its 30 s `waitUntil` budget.
 *
 * Exists because the `try_again` 503 carries only a ref, and the stored Worker logs are
 * behind an API token this machine does not hold (memory: env_cloudflare_logs).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { generateKeyPairSigner } from '@solana/kit';
// Rewritten to the stub-aliased copy by workerprobe.sh; the path below is what esbuild sees.
import { sessionInit, matchLeave } from './routes.probe';

const devVars = Object.fromEntries(
  readFileSync(`${process.env.REPO}/worker/.dev.vars`, 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim().replace(/^"|"$/g, '')]),
);
const treasuryJson = JSON.parse(readFileSync(`${homedir()}/.config/heartrot/treasury.json`, 'utf8')) as number[];
const { getBase58Decoder } = await import('@solana/kit');
const env = {
  ...devVars,
  TREASURY_SECRET_KEY: getBase58Decoder().decode(Uint8Array.from(treasuryJson)),
  PROGRAM_ID: 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5',
  ROUTER_ENDPOINT: 'https://devnet-router.magicblock.app/',
  VALIDATOR_IDENTITY: 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57',
  BASE_RPC_URL: devVars.BASE_RPC_URL ?? 'https://rpc.magicblock.app/devnet',
} as never;

const background: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void background.push(p.catch((e) => console.error('background:', e))) };

const t0 = performance.now();
const at = (): string => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const session = await generateKeyPairSigner();
const privyToken = `probe-${Date.now()}`;

async function call(name: string, fn: () => Promise<Response>): Promise<Record<string, unknown> | null> {
  try {
    const res = await fn();
    const body = (await res.json()) as Record<string, unknown>;
    console.log(`${at()}  ${name} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    return body;
  } catch (error) {
    console.log(`${at()}  ${name} THREW: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) console.log('cause:', cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack}` : cause);
    if (error instanceof Error && error.stack) console.log(error.stack.split('\n').slice(0, 12).join('\n'));
    return null;
  }
}

const init = await call('sessionInit', () =>
  sessionInit(env, { privyToken, sessionPubkey: session.address, skinId: 0, classId: 1 }, ctx),
);
// `scripts/ops/countfetch.mjs` (node --import) counts outbound fetches until this fires.
(globalThis as { __stopCounting?: () => void }).__stopCounting?.();
if (init && typeof init.arenaId === 'string') {
  await call('matchLeave', () => matchLeave(env, { privyToken, arenaId: init.arenaId }, ctx));
}
console.log(`${at()}  waiting on ${background.length} background task(s)`);
await Promise.allSettled(background);
console.log(`${at()}  done`);
