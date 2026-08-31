/**
 * Privy identity, verified as a plain JWT. No Privy SDK.
 *
 * The Privy access token is an ES256 JWT signed by a key published at a **public**
 * JWKS endpoint — no API key, no auth header, no server SDK. `@privy-io/server-auth`
 * is effectively abandoned and `@privy-io/node` has never been run under workerd, so
 * both are risk with no payoff: `jose` does the whole job and is the smaller bundle.
 *
 * Privy is identity only. It never signs a Solana transaction for HEARTROT — its
 * fastest signing path is a cross-origin iframe round trip and signatures are metered
 * at $0.01 above 50K/month, neither of which survives a 400 ms tick.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * One key set per app id, cached for the lifetime of the isolate.
 *
 * This is a cache of *public* signing keys, not request-scoped state: caching it is
 * the whole point of `createRemoteJWKSet`, which otherwise refetches Privy's JWKS on
 * every single `/session/init`. Nothing user-specific is ever stored here.
 */
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * A token that is absent, expired, or not ours. Distinct from a 500 because the client
 * has a repair for it — refresh the Privy session and retry — and none for the other.
 */
export class Unauthorized extends Error {}

/**
 * Verify a Privy access token and return the DID it was issued for.
 *
 * Throws on anything that is not a currently-valid token for *this* app — `jose`
 * checks signature, `exp`, `nbf`, and the two claims below. Algorithm is pinned so a
 * token presenting `alg: none`, or an HMAC signed with a public key, is rejected
 * before any key lookup happens.
 */
export async function verifyPrivyToken(token: string, appId: string): Promise<string> {
  let keys = keySets.get(appId);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://api.privy.io/v1/apps/${appId}/jwks.json`));
    keySets.set(appId, keys);
  }

  let did: unknown;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: 'privy.io',
      audience: appId,
      algorithms: ['ES256'],
    });
    did = payload.sub;
  } catch (error) {
    // Signature, expiry, issuer and audience failures all arrive here and all mean the
    // same thing to the caller. The reason goes to the log; the response does not name
    // which check failed.
    console.error('privy token rejected', error);
    throw new Unauthorized('invalid privy token');
  }

  if (typeof did !== 'string' || !did.startsWith('did:privy:')) {
    throw new Unauthorized('privy token carries no DID subject');
  }
  return did;
}

/**
 * `sha256(did)` — the 32-byte durable player identity written into `PlayerSlot.identity`
 * and copied to the leaderboard at settle.
 *
 * Hashing rather than storing the DID keeps a Privy user id off chain while staying a
 * stable key across devices, cleared browser storage and rotated session keypairs.
 * `/session/init` is idempotent on exactly this value.
 */
export async function identityFromDid(did: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(did));
  return new Uint8Array(digest);
}
