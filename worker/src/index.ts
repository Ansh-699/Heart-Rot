/**
 * HEARTROT's backend: four cold-path match routes, two public reads, and nothing else.
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
import type { RouteContext } from './routes';
import {
  BadRequest,
  faucetStatus,
  json,
  leaderboard,
  matchLeave,
  matchSettle,
  matchStart,
  sessionInit,
  TryAgain,
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

  /** Not optional: `REQUIRED` below refuses every request without it. */
  RATE_LIMIT: RateLimitBinding;
}

/** Requests are small JSON documents. Anything larger is not one of ours. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Every binding a request needs before any route may run, in one list.
 *
 * `BASE_RPC_TOKEN` is absent because it is genuinely optional, and `ER_ENDPOINT`
 * because nothing reads it — the ER's address comes from the router's `fqdn`, not from
 * config, so requiring it would assert a dependency that does not exist.
 *
 * Without this gate an unset secret is not inert. `PROGRAM_ID: ''` reaches
 * `@solana/kit`'s `address()`, which throws, and the catch-all below turns that into an
 * opaque `internal_error` on every single request; an unset `PRIVY_APP_ID` builds the
 * JWKS URL `…/apps//jwks.json` and answers `unauthorized` to every correctly signed-in
 * player. Both name the deployment, and both report something else. Checking here — at
 * the one place every route passes through — is also why no route below re-checks: a
 * second site would be the same fact stored twice, and would drift.
 */
const REQUIRED: readonly (keyof Env)[] = [
  'PROGRAM_ID',
  'ROUTER_ENDPOINT',
  'VALIDATOR_IDENTITY',
  'PRIVY_APP_ID',
  'TREASURY_SECRET_KEY',
  'BASE_RPC_URL',
  // ER transaction fees are zero and the ER performs no fee-payer validation, so the
  // network provides no economic backstop anywhere in this system. Inside the program
  // that is handled with per-player tick counters; out here it is the limiter. Every
  // route spends real SOL, so running them unmetered because a binding is missing is
  // worse than being down: it is required, not optional hardening.
  'RATE_LIMIT',
];

/**
 * `Map`, not an object literal: `pathname` is attacker-controlled, and an object lookup
 * on `__proto__` or `constructor` yields an inherited value that is truthy and not one
 * of ours. A `Map` has no inherited keys to find.
 */
const POST_ROUTES = new Map<
  string,
  (env: Env, body: unknown, ctx: RouteContext) => Promise<Response>
>([
  ['/api/session/init', sessionInit],
  ['/api/match/start', matchStart],
  ['/api/match/settle', matchSettle],
  // Departure. Sent by the Exit button and by `navigator.sendBeacon` on a closing tab,
  // and it is what stops an abandoned raid stranding its arena forever.
  ['/api/match/leave', matchLeave],
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);

    // Fail closed, and say which binding is missing. The names are ops signal, not a
    // secret — they are already in .env.example — and the alternative is an operator
    // reading a 500 that names nothing. Values are never read here, only presence.
    const missing = REQUIRED.filter((name) => !env[name]);
    if (missing.length > 0) return json({ error: 'misconfigured', missing }, 503);

    // The binding is per-Cloudflare-location, not global, so an abuser reaching many
    // colos multiplies their allowance — it is a brake, not a wall, and the treasury
    // tier check in each route is what actually bounds the spend. Keyed per route so
    // one client polling a slow settle cannot spend another route's budget.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.RATE_LIMIT.limit({ key: `${ip}:${pathname}` });
    if (!success) return json({ error: 'rate_limited' }, 429);

    try {
      if (request.method === 'GET' && pathname === '/api/faucet/status') {
        return await faucetStatus(env);
      }
      if (request.method === 'GET' && pathname === '/api/leaderboard') {
        return await leaderboard(env, new URL(request.url).searchParams.has('all'));
      }

      // Resolved before the body is touched, so a typo'd URL answers `not_found`
      // rather than being told its body is not JSON.
      const route = request.method === 'POST' ? POST_ROUTES.get(pathname) : undefined;
      if (!route) return json({ error: 'not_found' }, 404);

      return await route(env, await readJson(request), ctx);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      if (error instanceof Unauthorized) return json({ error: 'unauthorized' }, 401);

      // A malformed address, a Privy outage, a devnet transaction that failed on chain
      // and a delegation timeout all land here. The message goes to the log, never to
      // the caller: these strings carry RPC URLs, account addresses and provider errors.
      //
      // The `ref` is the exception: an opaque token that appears in BOTH the log line and
      // the response body, so a player can read one off their screen and an operator can
      // find the stack that produced it. Three of these 500s have now been diagnosed by
      // guessing, twice wrongly, because a body of `{"error":"internal_error"}` carries
      // nothing to search on. It leaks nothing — it is random and means nothing on its own.
      const ref = crypto.randomUUID().slice(0, 8);
      // Same ref, same log, different verdict. `TryAgain` is the routes' own word for
      // "the infrastructure before the seat claim failed and nothing is half-done": a
      // 503 whose copy says retry, because retrying is the fix. Logged through `cause`
      // — the wrapper's stack points at `preClaim`, the cause's at what actually broke.
      if (error instanceof TryAgain) {
        console.error(`[${ref}] ${pathname} try_again`, error.cause);
        return json({ error: 'try_again', ref }, 503);
      }
      console.error(`[${ref}] ${pathname}`, error);
      return json({ error: 'internal_error', ref }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new BadRequest('body too large');

  // Chunked requests declare no length, so the guard above is not enough on its own —
  // and the cap is in *bytes*, so it has to be measured on the bytes. `String.length`
  // counts UTF-16 code units, which lets a body of multibyte characters through at
  // roughly three times the limit.
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) throw new BadRequest('body too large');
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest('body is not JSON');
  }
}
