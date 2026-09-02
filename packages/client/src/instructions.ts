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
 * Three of the program's routes have no builder here, and none of them is an omission —
 * each names a signer no client holds, so a builder would only ever produce a transaction
 * that cannot be signed:
 *
 *   - **Tag 8 `BossTick`** — signed by the crank signer PDA. Its account list is frozen
 *     into the validator's crank row by `start_match`'s scheduling CPI and replayed from
 *     there forever.
 *   - **Tag 14 `ConsumeRoll`** — signed by the scoped VRF identity PDA under the *VRF*
 *     program. The oracle builds it, from the discriminator, metas and `callback_args`
 *     that tag 13's CPI froze into the request.
 *   - **The undelegation callback** — no tag of ours at all, routed on the delegation
 *     program's own 8-byte discriminator, signed by the undelegate buffer PDA.
 *
 * Everything the program dispatches that a keypair *can* sign has a builder below,
 * including the operator-only tags 11 and 12: without those, an arena that was delegated
 * and never started can never be brought home again.
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

import { MAX_SEATS, N_CLASSES } from './layout';
import {
  DELEGATION_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  SLOT_HASHES_SYSVAR_ID,
  SYSTEM_PROGRAM_ID,
  VRF_ORACLE_QUEUE_ID,
  VRF_PROGRAM_ID,
  delegationBufferPda,
  delegationMetadataPda,
  delegationRecordPda,
  programIdentityPda,
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
const IX_COMMIT = 11;
const IX_COMMIT_AND_UNDELEGATE = 12;
const IX_REQUEST_ROLL = 13;
const IX_NEXT_INCARNATION = 15;

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
// These are a trust boundary: the browser feeds `seat`, the aim pair and `seq` straight from
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

/**
 * A signed byte. The aim pair comes straight off a pointer delta, which can be any
 * magnitude at all, and `setInt8` truncates rather than throwing — a delta of 260 would
 * silently become 4 and fire at a completely different angle. Callers scale first.
 */
function i8(value: number, what: string): number {
  req(Number.isInteger(value) && value >= -128 && value <= 127, `${what} not an i8: ${value}`);
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

/**
 * Tag 15 — reset the same three accounts in place for incarnation N+1. Base layer, after
 * tag 10 has filed the finished match. **Args: none** (`ZERO_ARG_TAGS` rejects a trailing
 * payload).
 *
 * No new accounts are created: incarnation N+1 reuses this `Arena`/`Boss`/`Players`, which
 * is what keeps one address per raid chain and keeps `Leaderboard`'s `(arena_id,
 * incarnation)` key meaningful. The boss is rescaled and every seat is zeroed, so a
 * returning player is re-seated by an ordinary tag 4.
 *
 * `leaderboard` is **read-only, and an ordering interlock rather than a data source**:
 * this instruction leaves `Settled` and zeroes every `damage_dealt`, so a tag 15 that beat
 * tag 10 would erase the match record with nothing left able to notice. The handler
 * requires the leaderboard to already name this exact `(arena_id, incarnation)` and
 * otherwise returns `Custom(17)` `MatchNotRecorded`.
 *
 * Refused with `Custom(6)` `WrongPhase` when `phase` is not `Settled` **or**
 * `next_affix_seed` is all-zero. Those are one condition — "not legal from this state" —
 * and which one it was is readable off the `Arena` the caller already has: `rollSeed()`
 * returning `null` says the oracle never answered, so the raid chain stops here and a
 * human re-rolls or opens a fresh arena.
 */
export function nextIncarnation(p: {
  programId: Address;
  /** Must equal `init::TREASURY`, and is the base-layer fee payer. */
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
  leaderboard: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_NEXT_INCARNATION, 0);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.payer, role: AccountRole.WRITABLE_SIGNER }, // 0 payer — must be init::TREASURY
      { address: p.arena, role: AccountRole.WRITABLE }, // 1 arena
      { address: p.boss, role: AccountRole.WRITABLE }, // 2 boss
      { address: p.players, role: AccountRole.WRITABLE }, // 3 players
      { address: p.leaderboard, role: AccountRole.READONLY }, // 4 leaderboard — ordering interlock
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// ER instructions
// ---------------------------------------------------------------------------

/**
 * Tag 3 — open the muster window and schedule the `boss_tick` crank. ER.
 *
 * It no longer starts the fight. `LOBBY -> FIGHTING` was deleted: this stamps
 * `Arena.fight_at_tick = tick + MUSTER_TICKS` and moves the arena to `PHASE_MUSTERING`,
 * and the **crank** performs the flip to `PHASE_FIGHTING` at that tick. That is the whole
 * answer to "what if nobody presses start": no player, host or Worker has to act, and a
 * raid can never fail to begin.
 *
 * Refuses with `NoRaiders` (custom 19) when no seat is in `ZONE_ARENA`. Treat that on the
 * start route exactly like the existing 409 — retry, do not surface — because it means
 * the caller raced ahead of its own `enter_gate` landing.
 *
 * The scheduling CPI freezes `[arena, boss, players, crank_signer]` into the validator's
 * task row for the whole match, and schedules every iteration up front: a crank carries
 * no writable signer, so it can never re-arm itself. `TICK_ITERATIONS` on chain now covers
 * the muster as well as the fight, which is why it could not stay a literal.
 */
export function beginMuster(p: {
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
 * The name tag 3 had while it still meant "start the fight". Kept only so
 * `worker/src/routes.ts` keeps building across the ship; delete it once that route calls
 * {@link beginMuster}. Same instruction, same bytes — there is no second implementation.
 */
export const startMatch = beginMuster;

/**
 * Tag 4 — write a seat's session key and identity. ER, treasury-signed, cold path.
 *
 * Args (67 B, `player::JOIN_DATA_LEN`): seat u8 @0 · skin_id u8 @1 · session_pubkey 32 B
 * @2 · identity 32 B @34 · class u8 @66.
 *
 * `class` is **appended**, not packed in beside `skin_id`, so no existing offset moves and
 * both 32-byte slices are untouched. The handler length-checks, so an app built against the
 * 66-byte block gets a clean `InvalidInstructionData` rather than a misread byte — which is
 * also why the program, this package and the Worker ship together.
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
 *
 * A returning identity keeps the **class** its seat already holds, where `skin_id` is
 * rotated: a skin is a render hint, a class is the damage and cooldown `shoot` reads, and
 * rotating it mid-match would let a player fire the archer's 70 and take the next shot on
 * the knight's 800 ms. Render the class off the roster slot, not off what was sent.
 */
export function claimSeat(p: {
  programId: Address;
  arena: Address;
  players: Address;
  treasury: Address;
  seat: number;
  skinId: number;
  /**
   * `CLASS_KNIGHT` (0) or `CLASS_ARCHER` (1). Required, and refused rather than clamped on
   * both sides of the wire: a clamp turns a version skew into a silently wrong weapon,
   * which from the outside is indistinguishable from a balance bug.
   */
  class: number;
  sessionPubkey: Address;
  /** `sha256(privy DID)` — raw bytes, not a key. */
  identity: Uint8Array;
}): HeartrotInstruction {
  req(
    Number.isInteger(p.class) && p.class >= 0 && p.class < N_CLASSES,
    `class must be 0..${N_CLASSES - 1}, got ${p.class}`,
  );
  const { data } = alloc(IX_CLAIM_SEAT, 67);
  data[1] = seatIndex(p.seat);
  data[2] = u8(p.skinId, 'skinId');
  data.set(addresses.encode(p.sessionPubkey), 3);
  data.set(raw32(p.identity, 'identity'), 35);
  data[67] = p.class;
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
 * Tag 7 — hitscan raycast along the aim vector. ER, session-signed, the other hot path.
 * Args (3 B): seat u8 @0 · dx i8 @1 · dy i8 @2.
 *
 * **Free aim, not eight-way** — and this is a correctness property, not polish. With the
 * boss fixed at top centre a 45° quantisation can only select a target whose angular size
 * exceeds 45°: measured over 110 pit stands, 8-way aim reaches 5 of 10 parts and *never*
 * the core, from anywhere, at any range, so the raid is unwinnable with no error anywhere
 * (`11-immortals-spec.md` §4.1). The pair is the raw pointer delta; the chain normalises
 * it with the same routine it uses on boss ordnance and derives `facing` from it, so a
 * caller must **not** pre-quantize to an octant.
 *
 * Magnitude is ignored — `(3, -12)` and `(30, -120)` are the same shot — but it is not
 * *free*: it is the aim resolution, so pass the pointer delta rather than rounding it to
 * `±1`, which would throw away every angle that is not a multiple of 45°.
 *
 * `(0, 0)` is refused on chain and refused here. Two bytes rather than a `u16` angle
 * because it costs the same, needs no table on either side, and measures 0.2354° of
 * worst-case direction error.
 *
 * Writes `Boss` because the ray damages parts, and `Arena` for the shot-cooldown clock.
 *
 * The wire is unchanged by the archer: the same `(dx, dy)` is what the handler quantises
 * into `PlayerSlot.class_aim`'s low seven bits, so every client can redraw this shot's
 * arrow from account bytes alone. Damage and cooldown come off the seat's class byte, not
 * off anything sent here.
 */
export function shoot(p: {
  programId: Address;
  arena: Address;
  boss: Address;
  players: Address;
  session: Address;
  seat: number;
  /** Aim vector, y growing DOWN. Signs and ratio are read; magnitude is not. */
  dx: number;
  dy: number;
}): HeartrotInstruction {
  req(p.dx !== 0 || p.dy !== 0, 'aim (0, 0) has no direction');
  const { data, view } = alloc(IX_SHOOT, 3);
  data[1] = seatIndex(p.seat);
  view.setInt8(2, i8(p.dx, 'dx'));
  view.setInt8(3, i8(p.dy, 'dy'));
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

/**
 * Tags 11 and 12 share one account list, byte for byte: **exactly 6**, and the order is
 * deliberately *not* tag 9's — the two magic accounts come second and third, before the
 * match accounts. Both handlers destructure with no `..`, so a seventh account is
 * `NotEnoughAccountKeys`, and a swapped pair would hand `magic_context` to the arena slot.
 *
 * `payer` is a **read-only** signer. The ER rejects a writable account it does not hold
 * delegated with `InvalidWritableAccount`, and the crank authority is a base-layer key, so
 * it signs read-only and a throwaway keypair is the transaction's fee payer. ER fees are
 * zero, so that keypair needs no funding — an unfunded session key has already played a
 * whole match on devnet.
 */
function commitAccounts(p: {
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
}): readonly AccountMeta[] {
  return [
    { address: p.payer, role: AccountRole.READONLY_SIGNER }, // 0 payer — must be Arena.crank_authority
    { address: MAGIC_CONTEXT_ID, role: AccountRole.WRITABLE }, // 1 magic_context
    { address: MAGIC_PROGRAM_ID, role: AccountRole.READONLY }, // 2 magic_program
    { address: p.arena, role: AccountRole.WRITABLE }, // 3 arena
    { address: p.boss, role: AccountRole.WRITABLE }, // 4 boss
    { address: p.players, role: AccountRole.WRITABLE }, // 5 players
  ];
}

/**
 * Tag 11 — commit the three accounts' current ER state to the base layer without
 * undelegating. ER, no args, operator-only.
 *
 * **It writes no phase**, in any phase: this is a snapshot, and the match keeps running on
 * the ER afterwards. It does **spend the commit quota** — ten commits per account before
 * the delegation program locks them out until re-delegation — and `settle` needs one of
 * those ten, so do not put this on a timer.
 *
 * Refused from `PHASE_ROLLING` with `Custom(6)` `WrongPhase`: committing an arena whose VRF
 * request is still in flight would land the callback on an account the ER no longer holds,
 * and the oracle would then retry the failure for the request's whole 240-slot TTL. Wait
 * `ROLL_TIMEOUT_TICKS` for `boss_tick` to abandon the roll, then send it.
 */
export function commit(p: {
  programId: Address;
  /** Must equal `Arena.crank_authority`. Signs read-only; a throwaway key pays the fee. */
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_COMMIT, 0);
  return { programAddress: p.programId, accounts: commitAccounts(p), data };
}

/**
 * Tag 12 — commit and hand the three accounts back to the base layer. ER, no args,
 * operator-only. **This is the stranded-arena recovery path.**
 *
 * From `PHASE_LOBBY` it undelegates and leaves the phase at `Lobby`: an arena that was
 * delegated (tag 2) and never started (tag 3) has no crank to cancel and so can never reach
 * `settle`, which is exactly how two arenas were stranded on devnet. This brings them home,
 * and tag 2 can delegate them again afterwards.
 *
 * From `Fighting`/`Settling`/`Rolled`/`Settled` it sets `PHASE_SETTLED`, and a repeat send
 * is **accepted rather than refused** — `Settled → Settled` is a legal edge, so a retry
 * after a lost confirmation is safe. From `PHASE_ROLLING` it is refused with `Custom(6)`
 * `WrongPhase`, for the same in-flight-callback reason as tag 11.
 *
 * Cancel the tag 8 crank first if the match was ever started, or it keeps firing every
 * `TICK_MS` into accounts that no longer live on the ER. `settle` (tag 9) does both in one
 * instruction and is the normal end of a match; this tag is for the arenas that cannot
 * reach it.
 */
export function commitAndUndelegate(p: {
  programId: Address;
  /** Must equal `Arena.crank_authority`. Signs read-only; a throwaway key pays the fee. */
  payer: Address;
  arena: Address;
  boss: Address;
  players: Address;
}): HeartrotInstruction {
  const { data } = alloc(IX_COMMIT_AND_UNDELEGATE, 0);
  return { programAddress: p.programId, accounts: commitAccounts(p), data };
}

/**
 * Tag 13 — ask the VRF oracle for the next incarnation's ruleset. ER, session-signed.
 * Args (1 B): seat u8 @0.
 *
 * Legal only from `PHASE_SETTLING` with `outcome == OUTCOME_WIN`, and `Settling → Rolling`
 * is a one-shot edge — a second request is refused as an illegal transition, which is also
 * why this handler needs no rate limiter of its own.
 *
 * **A player asks, never the crank.** The VRF request's first account is a *writable*
 * signer and a CPI cannot escalate a read-only account to writable, so a crank — which may
 * carry no writable signer at all — structurally cannot make this request. The killing
 * blow's client sends this straight after its `shoot` confirms, on the popup-free session
 * key it already holds; the in-ER queue is fee-exempt, so a zero-lamport key pays for it.
 * Any claimed seat may send it, not only the killer, so a closed browser costs nothing as
 * long as one of the other nineteen asks. If nobody does, `boss_tick` abandons the roll
 * after `ROLL_TIMEOUT_TICKS` and the match settles normally with no seed — the raid is
 * unaffected, only the respawn loop stops.
 *
 * `session` is the one meta here that differs from every other session-signed builder: it
 * is `WRITABLE_SIGNER`, not `READONLY_SIGNER`, because the program forwards it as the VRF
 * request's payer. Async because index 3 is a PDA under our own program.
 *
 * Nobody builds the reply: the CPI freezes the one-byte callback discriminator `[14]`, two
 * account metas and the `callback_args` into the request, and the oracle replays that
 * shape.
 */
export async function requestRoll(p: {
  programId: Address;
  arena: Address;
  players: Address;
  session: Address;
  seat: number;
}): Promise<HeartrotInstruction> {
  const { data } = alloc(IX_REQUEST_ROLL, 1);
  data[1] = seatIndex(p.seat);
  const programIdentity = await programIdentityPda(p.programId);
  return {
    programAddress: p.programId,
    accounts: [
      { address: p.arena, role: AccountRole.WRITABLE }, // 0 arena — phase, outcome, roll_requested_tick
      { address: p.players, role: AccountRole.READONLY }, // 1 players — resolves slots[seat].session_pubkey
      { address: p.session, role: AccountRole.WRITABLE_SIGNER }, // 2 session key — also the VRF request's payer
      { address: programIdentity, role: AccountRole.READONLY }, // 3 program_identity — invoke_signed by us, so not a signer here
      { address: VRF_ORACLE_QUEUE_ID, role: AccountRole.WRITABLE }, // 4 oracle_queue — the in-ER, fee-exempt queue
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY }, // 5 system_program
      { address: SLOT_HASHES_SYSVAR_ID, role: AccountRole.READONLY }, // 6 slot_hashes
      { address: VRF_PROGRAM_ID, role: AccountRole.READONLY }, // 7 vrf_program
    ],
    data,
  };
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

/**
 * Assert the bytes of the two hot-path instructions, which are the two that changed and
 * the two nothing else checks. A handler rejects a wrong *length* loudly, but a signed
 * byte written through the wrong setter is a legal-looking instruction that aims
 * somewhere else — `shoot`'s `dy` is negative for every shot at a boss above you, so
 * `setUint8` here would have sent 250 instead of −6 and every upward shot would have
 * fired down.
 *
 * Runnable the same way as `layoutSelfCheck`:
 *
 *   ./app/node_modules/.bin/esbuild packages/client/src/instructions.ts --bundle \
 *     --format=esm --outfile=/tmp/ix.mjs && node -e \
 *     "import('/tmp/ix.mjs').then(m => { m.instructionsSelfCheck(); console.log('OK') })"
 */
export function instructionsSelfCheck(): void {
  const ok = (cond: boolean, what: string): void => {
    if (!cond) throw new Error(`instructions self-check: ${what}`);
  };
  const threw = (fn: () => unknown): boolean => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  const a = '11111111111111111111111111111111' as Address;
  const common = { programId: a, arena: a, boss: a, players: a, session: a };

  const up = shoot({ ...common, seat: 19, dx: -6, dy: -120 });
  ok(up.data.length === 4, 'shoot is 4 bytes on the wire, tag included');
  ok(up.data[0] === IX_SHOOT && up.data[1] === 19, 'tag then seat');
  const v = new DataView(up.data.buffer, up.data.byteOffset, up.data.byteLength);
  ok(v.getInt8(2) === -6 && v.getInt8(3) === -120, 'the aim pair survives as i8');
  ok(up.accounts.length === 4, 'arena, boss, players, session');

  ok(threw(() => shoot({ ...common, seat: 0, dx: 0, dy: 0 })), '(0, 0) is not a direction');
  ok(threw(() => shoot({ ...common, seat: 0, dx: 260, dy: -1 })), 'an unscaled delta is refused');
  ok(threw(() => shoot({ ...common, seat: 0, dx: 1.5, dy: -1 })), 'a fractional aim is refused');
  ok(threw(() => shoot({ ...common, seat: MAX_SEATS, dx: 1, dy: 0 })), 'seat 20 does not exist');

  // `move` is unchanged and still eight-way: it must NOT have followed `shoot` to free aim,
  // because the chain still quantizes it and the wire still carries a seq.
  const step = movePlayer({ programId: a, arena: a, players: a, session: a, seat: 1, dir: 7, seq: 513 });
  ok(step.data.length === 6, 'move is 6 bytes: tag, seat, seq u16, dx, dy');
  const mv = new DataView(step.data.buffer, step.data.byteOffset, step.data.byteLength);
  ok(mv.getUint16(2, true) === 513, 'seq is little-endian');
  ok(mv.getInt8(4) === -1 && mv.getInt8(5) === -1, 'dir 7 is NW, y growing down');

  // `claimSeat` grew by one byte for the class. The append is the whole safety of it: if
  // either 32-byte slice moved, the handler would read half a session key as an identity
  // and the seat would be claimed by a player nobody can authenticate as.
  {
    const key = 'So11111111111111111111111111111111111111112' as Address;
    const identity = new Uint8Array(32).fill(0xa5);
    const join = claimSeat({
      programId: a, arena: a, players: a, treasury: a,
      seat: 19, skinId: 2, class: 1, sessionPubkey: key, identity,
    });
    ok(join.data.length === 68, 'join is 68 bytes on the wire: tag + JOIN_DATA_LEN 67');
    ok(join.data[0] === IX_CLAIM_SEAT && join.data[1] === 19 && join.data[2] === 2, 'tag, seat, skin');
    ok(join.data[67] === 1, 'class is appended at arg offset 66');
    ok(join.data.slice(35, 67).every((b) => b === 0xa5), 'identity still starts at arg offset 34');
    ok(join.data.slice(3, 35).some((b) => b !== 0), 'and the session key still starts at 2');
    ok(claimSeat({ programId: a, arena: a, players: a, treasury: a, seat: 0, skinId: 0,
      class: 0, sessionPubkey: key, identity }).data[67] === 0, 'the knight is class 0');
    ok(threw(() => claimSeat({ programId: a, arena: a, players: a, treasury: a, seat: 0,
      skinId: 0, class: 2, sessionPubkey: key, identity })), 'an unknown class is refused, never clamped');
    ok(threw(() => claimSeat({ programId: a, arena: a, players: a, treasury: a, seat: 0,
      skinId: 0, class: -1, sessionPubkey: key, identity })), 'and so is a negative one');
  }
}
