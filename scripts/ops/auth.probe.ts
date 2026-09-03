export class Unauthorized extends Error {}
export async function verifyPrivyToken(token: string): Promise<string> { return `did:privy:${token}`; }
export async function identityFromDid(did: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(did)));
}
