/**
 * HEARTROT PDA derivations and the fixed program addresses.
 *
 * Every seed here is the byte-for-byte twin of a seed in `programs/heartrot/src/`.
 * Pinocchio re-derives and compares on chain (`assert_pda`), so a mismatch is a hard
 * `InvalidSeeds` rather than a silent wrong-account write — but it is also unrecoverable
 * at that point, so the seeds are stated once, here, and imported everywhere else.
 *
 * The seed *strings* come from `layout.ts` rather than being retyped, so the layout
 * contract stays the single place they are written down.
 */

import { getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';

import { SEED_ARENA, SEED_BOSS, SEED_LEADERBOARD, SEED_PLAYERS } from './layout';

// ---------------------------------------------------------------------------
// Fixed program addresses
// ---------------------------------------------------------------------------

/** Stock Solana system program; pays rent on every `init_*`. */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111' as Address;

/** MagicBlock delegation program. Owns a delegated account on the *base* layer. */
export const DELEGATION_PROGRAM_ID = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh' as Address;

/** Magic program: commit, undelegate and crank scheduling all CPI into it from the ER. */
export const MAGIC_PROGRAM_ID = 'Magic11111111111111111111111111111111111111' as Address;

/** The ER's commit scratch account. Writable on every commit / undelegate. */
export const MAGIC_CONTEXT_ID = 'MagicContext1111111111111111111111111111111' as Address;

/** Owns the crank signer PDA that is the only permitted signer of `boss_tick`. */
export const CRANK_PROGRAM_ID = 'Crank11111111111111111111111111111111111111' as Address;

/** `devnet-as`, Singapore. The one validator every HEARTROT match delegates to (D13). */
export const DEVNET_AS_IDENTITY = 'MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57' as Address;

// Seeds that belong to the delegation program's own protocol rather than to HEARTROT.
// Verbatim from `ephemeral-rollups-pinocchio` `src/consts.rs`.
const SEED_DELEGATION_RECORD = 'delegation';
const SEED_DELEGATION_METADATA = 'delegation-metadata';
const SEED_DELEGATION_BUFFER = 'buffer';

/** Seed prefix of the crank executor PDA, under `CRANK_PROGRAM_ID`. */
const SEED_CRANK_EXECUTOR = 'crank-executor';

const addresses = getAddressEncoder();

// ---------------------------------------------------------------------------
// Little-endian scalar encoding, shared with the instruction encoders
// ---------------------------------------------------------------------------

/**
 * `arena_id` is a u64 in both the `Arena` seed and the `InitArena` / `WriteLeaderboard`
 * argument lists. One encoder so a seed and an argument can never disagree.
 */
export function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

// ---------------------------------------------------------------------------
// HEARTROT PDAs
// ---------------------------------------------------------------------------

/** `[b"arena", arena_id.to_le_bytes()]`. `arena_id` is the only seed that is not a key. */
export async function arenaPda(programId: Address, arenaId: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [SEED_ARENA, u64le(arenaId)],
  });
  return pda;
}

/**
 * `[b"boss", arena_key]`. Seeded from the Arena *address*, not from `arena_id`, so one
 * hash of a known key yields both sibling accounts.
 */
export async function bossPda(programId: Address, arena: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [SEED_BOSS, addresses.encode(arena)],
  });
  return pda;
}

/** `[b"players", arena_key]`. All 20 seats live in this one account. */
export async function playersPda(programId: Address, arena: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [SEED_PLAYERS, addresses.encode(arena)],
  });
  return pda;
}

/** `[b"leaderboard"]`. Singleton, base layer, never delegated. */
export async function leaderboardPda(programId: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [SEED_LEADERBOARD],
  });
  return pda;
}

/** The three per-match accounts in one round of derivation. */
export async function matchPdas(
  programId: Address,
  arenaId: bigint,
): Promise<{ arena: Address; boss: Address; players: Address }> {
  const arena = await arenaPda(programId, arenaId);
  const [boss, players] = await Promise.all([
    bossPda(programId, arena),
    playersPda(programId, arena),
  ]);
  return { arena, boss, players };
}

// ---------------------------------------------------------------------------
// Foreign-program PDAs
// ---------------------------------------------------------------------------

/**
 * `[b"crank-executor", crank_authority]` under the **crank program**, not ours.
 * This is the only key `boss_tick` accepts as its signer, and the client needs it to
 * predict the crank's frozen account list.
 */
export async function crankSignerPda(crankAuthority: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: CRANK_PROGRAM_ID,
    seeds: [SEED_CRANK_EXECUTOR, addresses.encode(crankAuthority)],
  });
  return pda;
}

/**
 * `[b"delegation", account]` under the delegation program. Bytes 8..40 of its data are
 * the validator identity — the router-free way to answer "which ER owns this account?".
 */
export async function delegationRecordPda(account: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: DELEGATION_PROGRAM_ID,
    seeds: [SEED_DELEGATION_RECORD, addresses.encode(account)],
  });
  return pda;
}

/** `[b"delegation-metadata", account]` under the delegation program. */
export async function delegationMetadataPda(account: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: DELEGATION_PROGRAM_ID,
    seeds: [SEED_DELEGATION_METADATA, addresses.encode(account)],
  });
  return pda;
}

/**
 * `[b"buffer", account]` under the **owner** program (ours), not the delegation program.
 * Getting that wrong derives a real-looking address that delegation then rejects.
 */
export async function delegationBufferPda(
  account: Address,
  ownerProgram: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ownerProgram,
    seeds: [SEED_DELEGATION_BUFFER, addresses.encode(account)],
  });
  return pda;
}
