/**
 * A raider's public name: eight base58 characters of the identity digest, never the whole
 * hash. The Worker's leaderboard rows carry it and the app lights its own rows by it, so
 * both derive it here from the same bytes the same way and cannot drift.
 */
import { getBase58Decoder } from '@solana/kit';

const base58 = getBase58Decoder();

/** `first four…last four` of the identity's base58 form. */
export function raiderTag(identity: Uint8Array): string {
  const s = base58.decode(identity);
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
