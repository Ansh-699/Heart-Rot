/**
 * HEARTROT's backend: four cold-path routes and nothing else.
 *
 * `run_worker_first: ["/api/*"]` in wrangler.jsonc means this script is the only thing
 * that ever sees an `/api/*` request, and *nothing else* ever reaches this script — the
 * SPA, the sprites and the inline SVG are static assets served free and unmetered. The
 * design rule "gameplay never passes through the backend" is therefore enforced by the
 * platform rather than by discipline: there is no code path from a `move` transaction
 * to the treasury key.
 *
 * Every route below spends treasury SOL or reads a paid RPC, so every route is rate
 * limited by IP before it is dispatched.
 */

import { Unauthorized } from './auth';
import {
  BadRequest,
  faucetStatus,
  json,
  matchSettle,
  matchStart,
  sessionInit,
} from './routes';

/**
 * The Cloudflare Rate Limiting binding. Declared here rather than taken from
 * `worker-configuration.d.ts` so that this file states its own requirements — the
 * generated types describe whatever wrangler.jsonc happens to say today.
 */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  // Public routing constants (wrangler.jsonc `vars`).
  PROGRAM_ID: string;
  ER_ENDPOINT: string;
  ROUTER_ENDPOINT: string;
  VALIDATOR_IDENTITY: string;
  PRIVY_APP_ID: string;

  // Secrets (`wrangler secret put`). The treasury key is base58 and is handed straight
  // to WebCrypto as a non-extractable key; it is never a var, never logged, and never
  // leaves the isolate as bytes.
  TREASURY_SECRET_KEY: string;
  /**
   * A dedicated provider. Not `api.devnet.solana.com`: it answers workerd with HTTP
   * 403 "Your IP or provider is blocked" while answering curl from the same IP in the
   * same minute with 200, so a deployed Worker is more likely to be refused, not less.
   */
  BASE_RPC_URL: string;
  BASE_RPC_TOKEN?: string;

  RATE_LIMIT?: RateLimitBinding;
}

/** Requests are small JSON documents. Anything larger is not one of ours. */
const MAX_BODY_BYTES = 8 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    // ER transaction fees are zero and the ER performs no fee-payer validation, so the
    // network provides no economic backstop anywhere in this system. Inside the
    // program that is handled with per-player tick counters; out here it is this. The
    // binding is per-Cloudflare-location, not global, so an abuser reaching many colos
    // multiplies their allowance — it is a brake, not a wall, and the treasury tier
    // check in each route is what actually bounds the spend.
    if (!env.RATE_LIMIT) {
      // Fail closed. Every route below spends real SOL; running them unmetered because
      // a binding is missing is worse than being down.
      return json({ error: 'rate_limiter_unconfigured' }, 503);
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMIT.limit({ key: `${ip}:${pathname}` });
    if (!success) return json({ error: 'rate_limited' }, 429);

    try {
      if (request.method === 'GET' && pathname === '/api/faucet/status') {
        return await faucetStatus(env);
      }

      if (request.method === 'POST') {
        const body = await readJson(request);
        switch (pathname) {
          case '/api/session/init':
            return await sessionInit(env, body);
          case '/api/match/start':
            return await matchStart(env, body);
          case '/api/match/settle':
            return await matchSettle(env, body);
          default:
            break;
        }
      }

      return json({ error: 'not_found' }, 404);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      if (error instanceof Unauthorized) return json({ error: 'unauthorized' }, 401);

      // A malformed address, a Privy outage, a devnet transaction that failed on chain
      // and a delegation timeout all land here. The message goes to the log, never to
      // the caller: these strings carry RPC URLs, account addresses and provider errors.
      console.error(pathname, error);
      return json({ error: 'internal_error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new BadRequest('body too large');

  const text = await request.text();
  // Chunked requests declare no length, so the guard above is not enough on its own.
  if (text.length > MAX_BODY_BYTES) throw new BadRequest('body too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest('body is not JSON');
  }
}
