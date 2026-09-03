/**
 * Who is asking: Privy identity verified as a plain JWT, or a guest proof verified as an
 * Ed25519 signature. No Privy SDK either way.
 *
 * The Privy access token is an ES256 JWT signed by a key published at a **public**
 * JWKS endpoint — no API key, no auth header, no server SDK. `@privy-io/server-auth`
 * is effectively abandoned and `@privy-io/node` has never been run under workerd, so
 * both are risk with no payoff: `jose` does the whole job and is the smaller bundle.
 *
 * Privy is identity only. It never signs a Solana transaction for HEARTROT — its
 * fastest signing path is a cross-origin iframe round trip and signatures are metered
 * at $0.01 above 50K/month, neither of which survives a 400 ms tick.
 *
 * A guest has no token at all. The landing lets a visitor raid once without a wallet,
 * and the only secret their tab holds is the session key that signs gameplay — so the
 * proof is that key's signature over a timestamped challenge (`guestChallenge`, from
 * `@heartrot/client`, so the browser and this file cannot disagree on the bytes).
 * WebCrypto verifies it here; no library.
 */

import { getBase58Encoder, getBase64Encoder, isAddress } from '@solana/kit';
import { guestChallenge, type GuestProof } from '@heartrot/client';
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
export function identityFromDid(did: string): Promise<Uint8Array> {
  return sha256(did);
}

/**
 * How far a guest proof's `ts` may sit from this Worker's clock, either way. Five minutes
 * covers a phone whose clock is a little off and the retry loop `join` runs while an arena
 * warms (20 × 3 s), and it is the whole lifetime of a captured proof.
 */
const GUEST_MAX_SKEW_MS = 5 * 60_000;

/**
 * `sha256("guest:" + pubkey)` for a proof that verifies, or `Unauthorized`.
 *
 * The identity is the pubkey's, not the DID's, so it is stable for as long as the browser
 * keeps the key (IndexedDB) and disjoint from every Privy identity by the prefix: no wallet
 * sign-in can ever collide with a guest, and a guest who later signs in is a new player —
 * which is the deal the landing offers, one raid and then a name.
 *
 * The shape is the caller's to check (`routes.ts::resolveIdentity`); this only decides.
 * The skew test is written as `!(… <= …)` so a `NaN` timestamp fails it rather than
 * slipping past a `>`.
 */
export async function identityFromGuest({ pubkey, ts, signature }: GuestProof): Promise<Uint8Array> {
  if (!isAddress(pubkey) || !(Math.abs(Date.now() - ts) <= GUEST_MAX_SKEW_MS)) {
    throw new Unauthorized('guest proof is malformed or stale');
  }
  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      getBase58Encoder().encode(pubkey) as Uint8Array,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    valid = await crypto.subtle.verify(
      'Ed25519',
      key,
      getBase64Encoder().encode(signature) as Uint8Array,
      new TextEncoder().encode(guestChallenge(pubkey, ts)),
    );
  } catch (error) {
    // A non-base64 signature or a pubkey off the curve throws inside WebCrypto; both are
    // "not a proof", and the reason goes to the log rather than the response.
    console.error('guest proof rejected', error);
  }
  if (!valid) throw new Unauthorized('invalid guest proof');
  return sha256(`guest:${pubkey}`);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}
