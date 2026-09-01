/**
 * HEARTROT instruction builders — the hand-written half of a Pinocchio program's client.
 *
 * Pinocchio emits no IDL, so nothing here is generated and nothing is checked for us.
 * Two things must match the handlers in `programs/heartrot/src/handlers/` exactly:
 * `lib.rs` splits the tag byte itself and hands the remaining slice straight to the
 * handler, which length-checks and parses its own arguments. `instruction.rs` carries no
 * code at all any more — it is the doc mirror of that ABI (`docs/architecture/05-wire-abi.md`
 * is the same table), and where a comment here and a handler's slice pattern disagree,
 * the handler wins and this file changes.
 *
 *   1. **The wire ABI** — a leading tag byte, then little-endian args at fixed offsets.
 *      Each handler rejects a wrong length, so a packing error surfaces as
 *      `InvalidInstructionData` rather than as corrupted state.
 *   2. **The account order** — and this one is *not* checked for us. A handler reads
 *      `accounts[2]` positionally; hand it the wrong account and the guards run against
 *      the wrong data. Every meta below carries its index in a comment, and the indices
 *      mirror the handler's own reads.
 *
 * `boss_tick` (tag 8) has no builder: it is never sent by a client. Its account list is
 * frozen into the validator's crank row by `start_match`'s scheduling CPI and replayed
 * from there forever.
 *
 * No builder produces an address lookup table entry, and none may ever be compiled into
 * one (D18): the ER rejects v0 transactions carrying ALTs outright, with no feature flag.
 */

import {
  AccountRole,
  getAddressEncoder,
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
} from '@solana/kit';

import { MAX_SEATS } from './layout';
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  delegationBufferPda,
  delegationMetadataPda,
  delegationRecordPda,
} from './pda';

// Instruction tags. Frozen: `IX_BOSS_TICK = 8` is written into the crank row at schedule
// time and replayed for the life of the match, so tag numbers can never be reordered.
const IX_INIT_LEADERBOARD = 0;
const IX_INIT_ARENA = 1;
const IX_DELEGATE = 2;
const IX_START_MATCH = 3;
const IX_CLAIM_SEAT = 4;
const IX_ENTER_GATE = 5;
const IX_MOVE = 6;
const IX_SHOOT = 7;
const IX_SETTLE = 9;
const IX_WRITE_LEADERBOARD = 10;

const addresses = getAddressEncoder();

/**
 * What every builder returns. Kit's bare `Instruction` leaves `accounts` and `data`
 * optional, which pushes a `!` into every consumer; every instruction here has both.
 */
export type HeartrotInstruction = Instruction &
  InstructionWithAccounts<readonly AccountMeta[]> &
  InstructionWithData<Uint8Array>;

// ---------------------------------------------------------------------------
// Argument validation
//
// These are a trust boundary: the browser feeds `seat`, `dir` and `seq` straight from
// input handling, and a DataView setter silently truncates rather than throwing. A
// truncated seat index addresses somebody else's slot.
// ---------------------------------------------------------------------------

function req(ok: boolean, message: string): void {
  if (!ok) throw new Error(`heartrot: ${message}`);
}

function u8(value: number, what: string): number {
  req(Number.isInteger(value) && value >= 0 && value <= 0xff, `${what} not a u8: ${value}`);
  return value;
}

function u16(value: number, what: string): number {
  req(Number.isInteger(value) && value >= 0 && value <= 0xffff, `${what} not a u16: ${value}`);
  return value;
}

function u64(value: bigint, what: string): bigint {
  req(value >= 0n && value <= 0xffff_ffff_ffff_ffffn, `${what} not a u64: ${value}`);
  return value;
}

function seatIndex(value: number): number {
  u8(value, 'seat');
  req(value < MAX_SEATS, `seat ${value} out of range (max ${MAX_SEATS - 1})`);
  return value;
}

/**
 * Eight-way facing, 0..7 — the same encoding as `PlayerSlot.facing`, and the index into
 * the program's `MOVE_STEP`/`FACING_STEP` tables. Out of range is rejected on chain, but
 * rejecting it here turns a lost round-trip into a thrown error at the call site.
 */
function dir8(value: number, what: string): number {
  req(Number.isInteger(value) && value >= 0 && value < 8, `${what} must be 0..7, got ${value}`);
  return value;
}

/**
 * The unit vector for an eight-way direction, y growing DOWN — a mirror of the handler's
 * `octant`, which reads only `(signum(dx), signum(dy))`. Magnitude is deliberately 1: the
 * chain picks the distance out of its own `MOVE_STEP` table, so sending anything larger
 * would move the player exactly as far while implying a control we do not have.
 *
 * A `switch` rather than a lookup table because `noUncheckedIndexedAccess` would make an
 * indexed read `undefined`-able, and the honest narrowing for that is this.
 */
function octantStep(dir: number): readonly [number, number] {
  switch (dir8(dir, 'dir')) {
    case 0:
      return [0, -1]; // N
    case 1:
      return [1, -1]; // NE
    case 2:
      return [1, 0]; // E
    case 3:
      return [1, 1]; // SE
    case 4:
      return [0, 1]; // S
    case 5:
      return [-1, 1]; // SW
    case 6:
      return [-1, 0]; // W
    default:
      return [-1, -1]; // 7 NW — `dir8` has already rejected everything outside 0..7
  }
}

function raw32(value: Uint8Array, what: string): Uint8Array {
  req(value.length === 32, `${what} must be 32 bytes, got ${value.length}`);
  return value;
}

/** Tag byte plus `argLen` bytes of args, with a view for the little-endian writes. */
function alloc(tag: number, argLen: number): { data: Uint8Array; view: DataView } {
  const data = new Uint8Array(1 + argLen);
  data[0] = tag;
  return { data, view: new DataView(data.buffer) };
}

// ---------------------------------------------------------------------------
// Base-layer instructions
// ---------------------------------------------------------------------------

/**
 * Tag 0 — allocate the singleton `Leaderboard`. Base layer, once per deployment.
 * 6,176 bytes fits one `CreateAccount`, so there is no realloc path to call afterwards.
 */
export function initLeaderboard(p: {
  programId: Address;
  payer: Address;
  leaderboard: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_INIT_LEADERBOARD, 0);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER }, // 0 payer
      { address: p.leaderboard, role: AccountRole.WRITABLE }, // 1 leaderboard
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY }, // 2 system_program
    ],
    data,
  };
}

/**
 * Tag 1 — allocate and stamp `Arena`, `Boss` and `Players` for one match. Base layer.
 *
 * Args (74 B): arena_id u64 @0 · incarnation u16 @8 · validator_identity 32 B @10 ·
 * crank_authority 32 B @42.
 *
 * `validator_identity` pins the match to one ER for its whole life. A client that
 * resolves its own ER instead of reading this field can land on the wrong validator and
 * see a frozen boss with no error anywhere — see `connection.ts`.
 */
export function initArena(p: {
  programId: Address;
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
  arenaId: bigint;
  incarnation: number;
  validatorIdentity: Address;
  crankAuthority: Address;
}): HeartrotInstruction {
  const { data, view } = alloc(IX_INIT_ARENA, 74);
  view.setBigUint64(1, u64(p.arenaId, 'arenaId'), true);
  view.setUint16(9, u16(p.incarnation, 'incarnation'), true);
  data.set(addresses.encode(p.validatorIdentity), 11);
  data.set(addresses.encode(p.crankAuthority), 43);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER }, // 0 payer
      { address: p.arena, role: AccountRole.WRITABLE }, // 1 arena
      { address: p.boss, role: AccountRole.WRITABLE }, // 2 boss
      { address: p.players, role: AccountRole.WRITABLE }, // 3 players
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY }, // 4 system_program
    ],
    data,
  };
}

/**
 * Tag 2 — hand `Arena`, `Boss` and `Players` to the ER. Base layer, 16 accounts, no args.
 *
 * Async because it derives nine delegation PDAs. Passing them in would be nine more
 * parameters for the caller to get wrong in exactly the way that silently produces a
 * real-looking address delegation then rejects.
 *
 * **The payer must also be the transaction fee payer**, and must equal
 * `Arena.crank_authority`. Delegation debits it for three accounts' rent per delegated
 * account, so its meta is a *writable* signer. A treasury paying fees while a different
 * key is passed here fails.
 *
 * The handler's account pattern is exact-length: 16 accounts, no trailing extras. Raise
 * the compute budget on the transaction — ~12 CPIs copying up to 1,924 B per account do
 * not fit the default 200,000 CU.
 */
export async function delegate(p: {
  programId: Address;
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
}): Promise<HeartrotInstruction> {
  const { data } = alloc(IX_DELEGATE, 0);

  // Per delegated account: [buffer (ours), record, metadata]. Order matters — the handler
  // reads them as four-account groups after the four fixed leading accounts.
  const group = async (account: Address): Promise<AccountMeta[]> => {
    const [buffer, record, metadata] = await Promise.all([
      delegationBufferPda(account, p.programId),
      delegationRecordPda(account),
      delegationMetadataPda(account),
    ]);
    return [
      { address: account, role: AccountRole.WRITABLE },
      { address: buffer, role: AccountRole.WRITABLE },
      { address: record, role: AccountRole.WRITABLE },
      { address: metadata, role: AccountRole.WRITABLE },
    ];
  };

  const [arenaGroup, bossGroup, playersGroup] = await Promise.all([
    group(p.arena),
    group(p.boss),
    group(p.players),
  ]);

  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER }, // 0 payer — and the fee payer
      { address: p.programId, role: AccountRole.READONLY }, // 1 owner_program
      { address: DELEGATION_PROGRAM_ID, role: AccountRole.READONLY }, // 2 delegation_program
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY }, // 3 system_program
      ...arenaGroup, //  4 arena · 5 buffer · 6 record · 7 metadata
      ...bossGroup, //  8 boss · 9 buffer · 10 record · 11 metadata
      ...playersGroup, // 12 players · 13 buffer · 14 record · 15 metadata
    ],
    data,
  };
}

/**
 * Tag 10 — copy the finished match's per-seat damage into the leaderboard ring.
 * Base layer, after the ER commit has confirmed.
 *
 * **Args: none.** `write_leaderboard(program_id, accounts)` takes no `data` parameter at
 * all — it reads `(arena_id, incarnation)` off the `Arena` account, which is also where
 * the idempotency key comes from: the handler no-ops when that pair already equals
 * `last_arena_id`/`last_incarnation`, and that is what makes the settle route safe to
 * retry after `GetCommitmentSignature` throws. Tag 10 is absent from `ZERO_ARG_TAGS`, so
 * a trailing block would be silently ignored rather than rejected — which is exactly why
 * it must not be sent: it would never surface as an error.
 *
 * The payer must be both `init::TREASURY` and `Arena.crank_authority`, and it is the
 * base-layer fee payer, hence the writable signer.
 */
export function writeLeaderboard(p: {
  programId: Address;
  payer: Address;
  leaderboard: Address;
  arena: Address;
  players: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_WRITE_LEADERBOARD, 0);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER }, // 0 payer
      { address: p.leaderboard, role: AccountRole.WRITABLE }, // 1 leaderboard
      { address: p.arena, role: AccountRole.READONLY }, // 2 arena
      { address: p.players, role: AccountRole.READONLY }, // 3 players
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// ER instructions
// ---------------------------------------------------------------------------

/**
 * Tag 3 — flip the arena to Fighting and schedule the 400 ms `boss_tick` crank. ER.
 *
 * The scheduling CPI freezes `[arena, boss, players, crank_signer]` into the validator's
 * task row for the whole match, and schedules every iteration up front: a crank carries
 * no writable signer, so it can never re-arm itself.
 */
export function startMatch(p: {
  programId: Address;
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_START_MATCH, 0);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER }, // 0 payer — becomes the task authority
      { address: p.arena, role: AccountRole.WRITABLE }, // 1 arena
      { address: p.boss, role: AccountRole.WRITABLE }, // 2 boss
      { address: p.players, role: AccountRole.WRITABLE }, // 3 players
      { address: MAGIC_PROGRAM_ID, role: AccountRole.READONLY }, // 4 magic_program
    ],
    data,
  };
}

/**
 * Tag 4 — write a seat's session key and identity. ER, treasury-signed, cold path.
 *
 * Args (66 B, `player::JOIN_DATA_LEN`): seat u8 @0 · skin_id u8 @1 · session_pubkey 32 B
 * @2 · identity 32 B @34.
 *
 * **The caller picks the seat.** The Worker holds the Privy identity map and the
 * `seat_occupied` read that decided the arena had room, so honouring its choice is what
 * makes the seat it reported to the browser the seat the browser actually gets.
 *
 * The one exception is a returning player: if `identity` already holds a slot, the
 * handler keeps that slot whatever `seat` asks for and rotates only the key and skin.
 * That is the intended path, not an edge case — a player with cleared browser storage
 * gets their seat back under a new key, and `/session/init` is safe to retry. Privy
 * identity is the durable record; the session key is not. Read the seat back off the
 * roster after the write confirms rather than assuming the requested index won.
 */
export function claimSeat(p: {
  programId: Address;
  arena: Address;
  players: Address;
  treasury: Address;
  seat: number;
  skinId: number;
  sessionPubkey: Address;
  /** `sha256(privy DID)` — raw bytes, not a key. */
  identity: Uint8Array;
}): HeartrotInstruction {
  const { data } = alloc(IX_CLAIM_SEAT, 66);
  data[1] = seatIndex(p.seat);
  data[2] = u8(p.skinId, 'skinId');
  data.set(addresses.encode(p.sessionPubkey), 3);
  data.set(raw32(p.identity, 'identity'), 35);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.arena, role: AccountRole.WRITABLE }, // 0 arena — seat_occupied bitmask
      { address: p.players, role: AccountRole.WRITABLE }, // 1 players
      { address: p.treasury, role: AccountRole.READONLY_SIGNER }, // 2 treasury
    ],
    data,
  };
}

/**
 * Tag 5 — step through the gate tile from the lobby into the arena. ER, session-signed.
 * Args (1 B): seat u8 @0. Writes `Arena` because it moves `alive_count`.
 *
 * The seat byte is what the handler indexes with — it is not advisory. `slots.get_mut`
 * bounds-checks it and then the signer must equal that slot's `session_pubkey`, which is
 * the whole perimeter: a wrong seat cannot gate someone else's slot, it just fails.
 */
export function enterGate(p: {
  programId: Address;
  arena: Address;
  players: Address;
  session: Address;
  seat: number;
}): HeartrotInstruction {
  const { data } = alloc(IX_ENTER_GATE, 1);
  data[1] = seatIndex(p.seat);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.arena, role: AccountRole.WRITABLE }, // 0 arena
      { address: p.players, role: AccountRole.WRITABLE }, // 1 players
      { address: p.session, role: AccountRole.READONLY_SIGNER }, // 2 session key
    ],
    data,
  };
}

/**
 * Tag 6 — one step. ER, session-signed, the hot path.
 *
 * Args (5 B): seat u8 @0 · seq u16 @1 · dx i8 @3 · dy i8 @4.
 *
 * **The seat comes off the wire.** `move_player` bounds-checks it with `slots.get_mut`
 * and then requires the signer to be that slot's `session_pubkey`, so a forged index
 * cannot drive anyone else's player; scanning twenty slots for the signing key instead
 * would cost more and prove nothing extra.
 *
 * **`dx`/`dy` carry a direction, not a distance.** Only their *signs* are read: the
 * handler's `octant` quantizes `(signum(dx), signum(dy))` to one of eight octants and
 * takes the displacement from its own `MOVE_STEP` table, so `(127, 127)` steps exactly
 * as far as `(1, 1)` and `(0, 0)` is rejected. Callers here have a direction, so this
 * builder takes `dir` 0..7 and emits the matching unit vector — the bytes on the wire
 * are still `dx`/`dy`.
 *
 * `seq` is echoed back into `PlayerSlot.last_move_seq` and is what lets the client
 * reconcile prediction; without it an arriving position is ambiguous as to which input
 * produced it, and the symptom is rubber-banding for everyone.
 *
 * `Arena` is read-only here — the handler only needs `tick` for the one-move-per-tick
 * rate limit, and keeping it read-only lets concurrent movers avoid serialising on it.
 * The rate limit is the *entire* backstop: ER fees are zero, so nothing debits a spammer.
 *
 * Named `movePlayer` rather than `move` to match the Rust module, where `move` is a
 * keyword.
 */
export function movePlayer(p: {
  programId: Address;
  arena: Address;
  players: Address;
  session: Address;
  seat: number;
  /** Eight-way step direction, 0..7. Same encoding as `PlayerSlot.facing`. */
  dir: number;
  seq: number;
}): HeartrotInstruction {
  const { data, view } = alloc(IX_MOVE, 5);
  const [dx, dy] = octantStep(p.dir);
  data[1] = seatIndex(p.seat);
  view.setUint16(2, u16(p.seq, 'seq'), true);
  view.setInt8(4, dx);
  view.setInt8(5, dy);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.arena, role: AccountRole.READONLY }, // 0 arena — tick only
      { address: p.players, role: AccountRole.WRITABLE }, // 1 players
      { address: p.session, role: AccountRole.READONLY_SIGNER }, // 2 session key
    ],
    data,
  };
}

/**
 * Tag 7 — hitscan raycast along `dir`. ER, session-signed, the other hot path.
 * Args (2 B): seat u8 @0 · dir u8 @1, eight-way, 0..7.
 *
 * Writes `Boss` because the ray damages parts, and `Arena` for the shot-cooldown clock.
 */
export function shoot(p: {
  programId: Address;
  arena: Address;
  boss: Address;
  players: Address;
  session: Address;
  seat: number;
  /** Eight-way facing, 0..7. Same encoding as `PlayerSlot.facing`. */
  dir: number;
}): HeartrotInstruction {
  const { data } = alloc(IX_SHOOT, 2);
  data[1] = seatIndex(p.seat);
  data[2] = dir8(p.dir, 'dir');
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.arena, role: AccountRole.WRITABLE }, // 0 arena
      { address: p.boss, role: AccountRole.WRITABLE }, // 1 boss
      { address: p.players, role: AccountRole.WRITABLE }, // 2 players
      { address: p.session, role: AccountRole.READONLY_SIGNER }, // 3 session key
    ],
    data,
  };
}

/**
 * Tag 9 — end the match: set `phase = Settled`, cancel the crank, then
 * `commit_and_undelegate` all three accounts back to the base layer. ER, treasury-signed.
 *
 * Cancelling has to happen before the accounts leave the ER or the crank fires into
 * undelegated accounts; there is no separate CancelTask tag because the handler does it.
 */
export function settle(p: {
  programId: Address;
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_SETTLE, 0);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.READONLY_SIGNER }, // 0 payer
      { address: p.arena, role: AccountRole.WRITABLE }, // 1 arena
      { address: p.boss, role: AccountRole.WRITABLE }, // 2 boss
      { address: p.players, role: AccountRole.WRITABLE }, // 3 players
      { address: MAGIC_CONTEXT_ID, role: AccountRole.WRITABLE }, // 4 magic_context
      { address: MAGIC_PROGRAM_ID, role: AccountRole.READONLY }, // 5 magic_program
    ],
    data,
  };
}
