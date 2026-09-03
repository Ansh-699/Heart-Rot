// Stub for the Worker probes: no Privy. `PROBE_IDENTITY_HEX` impersonates a seated
// identity read off a roster, so a route's post-claim path can be replayed as that seat.
export class Unauthorized extends Error {}
export async function verifyPrivyToken(token: string): Promise<string> { return `did:privy:${token}`; }
export async function identityFromDid(did: string): Promise<Uint8Array> {
  const forced = process.env.PROBE_IDENTITY_HEX;
  if (forced) return Uint8Array.from(Buffer.from(forced, 'hex'));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(did)));
}
export async function identityFromGuest(proof: { pubkey: string }): Promise<Uint8Array> {
  const forced = process.env.PROBE_IDENTITY_HEX;
  if (forced) return Uint8Array.from(Buffer.from(forced, 'hex'));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`guest:${proof.pubkey}`)));
}
