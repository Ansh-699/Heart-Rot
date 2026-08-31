/**
 * HEARTROT account decoding — the TypeScript half of the byte layout.
 *
 * The offsets below are the same table as `programs/heartrot/src/state.rs` and
 * `docs/architecture/04-layout-contract.md`. Keys are the Rust field names verbatim,
 * so a consistency check can diff the three mechanically rather than by eye. If you
 * change one, change all three; a silent disagreement here decodes a live match as
 * garbage with no error anywhere.
 *
 * Everything is little-endian, matching Solana. There are no floats on the wire and
 * none are introduced here: bullets are integer position plus integer per-tick
 * velocity precisely so the renderer can extrapolate them exactly between 2.5 Hz
 * ticks with zero prediction error.
 *
 * 32-byte fields come back as `Uint8Array`. Converting to base58 is the caller's
 * business (`getAddressDecoder().decode(bytes)` from `@solana/kit`) — this module
 * stays dependency-free so the Worker can import it too.
 */

// ---------------------------------------------------------------------------
// Capacities, discriminators, sentinels — mirrors of the Rust constants
// ---------------------------------------------------------------------------

export const MAX_SEATS = 20;
export const MAX_BULLETS = 128;
export const N_PARTS = 9;
export const LEADERBOARD_CAP = 128;

export const DISC_UNINITIALIZED = 0;
export const DISC_ARENA = 1;
export const DISC_BOSS = 2;
export const DISC_PLAYERS = 3;
export const DISC_LEADERBOARD = 4;

export const LAYOUT_VERSION = 1;

export const PHASE_LOBBY = 0;
export const PHASE_FIGHTING = 1;
export const PHASE_SETTLING = 2;
export const PHASE_SETTLED = 3;

export const ZONE_LOBBY = 0;
export const ZONE_ARENA = 1;

/** `Boss.target_seat` when nobody is alive in the arena. */
export const NO_TARGET = 0xff;

export const BULLET_FREE = 0;
export const BULLET_ACTIVE = 1;

/** PDA seed prefixes. `arena` also takes `arena_id` as a little-endian u64. */
export const SEED_ARENA = 'arena';
export const SEED_BOSS = 'boss';
export const SEED_PLAYERS = 'players';
export const SEED_LEADERBOARD = 'leaderboard';

// ---------------------------------------------------------------------------
// Offset tables
// ---------------------------------------------------------------------------

export const BULLET = {
  size: 8,
  offsets: { x: 0, y: 2, dx: 4, dy: 5, active: 6 },
} as const;

export const ARENA = {
  discriminator: DISC_ARENA,
  size: 1160,
  rentExemptLamports: 8_964_480n,
  offsets: {
    discriminator: 0,
    version: 1,
    bump: 2,
    phase: 3,
    alive_count: 4,
    bullet_cursor: 5,
    arena_id: 8,
    crank_task_id: 16,
    tick: 24,
    enrage_at_tick: 28,
    seat_occupied: 32,
    incarnation: 36,
    crank_authority: 40,
    validator_identity: 72,
    affix_seed: 104,
    bullets: 136,
  },
} as const;

export const BOSS = {
  discriminator: DISC_BOSS,
  size: 50,
  rentExemptLamports: 1_238_880n,
  offsets: {
    discriminator: 0,
    version: 1,
    bump: 2,
    vent_open: 3,
    attack_timer: 4,
    target_seat: 5,
    x: 6,
    y: 8,
    core_hp: 10,
    core_hp_max: 12,
    parts: 14,
    parts_max: 32,
  },
} as const;

export const PLAYER_SLOT = {
  size: 96,
  offsets: {
    zone: 0,
    facing: 1,
    skin_id: 2,
    x: 4,
    y: 6,
    hp: 8,
    hp_max: 10,
    last_move_seq: 12,
    respawn_at_tick: 16,
    last_shot_tick: 20,
    last_move_tick: 24,
    damage_dealt: 28,
    session_pubkey: 32,
    identity: 64,
  },
} as const;

export const PLAYERS = {
  discriminator: DISC_PLAYERS,
  size: 1924,
  rentExemptLamports: 14_281_920n,
  offsets: { discriminator: 0, version: 1, bump: 2, slots: 4 },
} as const;

export const LEADERBOARD_ENTRY = {
  size: 48,
  offsets: {
    arena_id: 0,
    identity: 8,
    damage_dealt: 40,
    incarnation: 44,
    survived: 46,
  },
} as const;

export const LEADERBOARD = {
  discriminator: DISC_LEADERBOARD,
  size: 6176,
  rentExemptLamports: 43_875_840n,
  offsets: {
    discriminator: 0,
    version: 1,
    bump: 2,
    total_written: 8,
    next: 12,
    last_arena_id: 16,
    last_incarnation: 24,
    entries: 32,
  },
} as const;

// ---------------------------------------------------------------------------
// Decoded shapes
// ---------------------------------------------------------------------------

export type Bullet = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  /** `BULLET_FREE` | `BULLET_ACTIVE`. Free slots still occupy their index. */
  active: number;
};

export type ArenaAccount = {
  bump: number;
  /** `PHASE_*`. */
  phase: number;
  aliveCount: number;
  bulletCursor: number;
  arenaId: bigint;
  crankTaskId: bigint;
  /** The authoritative clock. Also the crank-liveness heartbeat. */
  tick: number;
  enrageAtTick: number;
  /** Bitmask, low `MAX_SEATS` bits. */
  seatOccupied: number;
  incarnation: number;
  crankAuthority: Uint8Array;
  /** Which ER this match lives on. Never resolve your own; use this one. */
  validatorIdentity: Uint8Array;
  affixSeed: Uint8Array;
  /** All `MAX_BULLETS` slots, index-stable so a renderer can reuse DOM nodes. */
  bullets: Bullet[];
};

export type BossAccount = {
  bump: number;
  /** 0 sealed, 1 open. The core is only damageable while open. */
  ventOpen: number;
  attackTimer: number;
  /** Seat index, or `NO_TARGET`. */
  targetSeat: number;
  x: number;
  y: number;
  coreHp: number;
  coreHpMax: number;
  /** Index-aligned with the hitbox JSON from `tools/svg_slice.py`. */
  parts: number[];
  partsMax: number[];
};

export type PlayerSlot = {
  /** Seat number. Equal to the slot's index; there is no seat field on the wire. */
  seat: number;
  /** All-zero `sessionPubkey` means the seat was never claimed. */
  occupied: boolean;
  zone: number;
  facing: number;
  skinId: number;
  x: number;
  y: number;
  hp: number;
  hpMax: number;
  /** Echo of the client's input sequence number. Prediction reconciles on this. */
  lastMoveSeq: number;
  respawnAtTick: number;
  lastShotTick: number;
  lastMoveTick: number;
  damageDealt: number;
  sessionPubkey: Uint8Array;
  /** `sha256(privy DID)`. */
  identity: Uint8Array;
};

export type PlayersAccount = {
  bump: number;
  slots: PlayerSlot[];
};

export type LeaderboardEntry = {
  arenaId: bigint;
  identity: Uint8Array;
  damageDealt: number;
  incarnation: number;
  survived: boolean;
};

export type LeaderboardAccount = {
  bump: number;
  totalWritten: number;
  /** Ring write cursor: `entries[next]` is the oldest row and the next to be overwritten. */
  next: number;
  lastArenaId: bigint;
  lastIncarnation: number;
  entries: LeaderboardEntry[];
};

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

/**
 * Validate the header the same way the program does before trusting any offset.
 * Reading the wrong account type as the right one is exactly the failure the
 * discriminator exists to stop, and on the client it presents as a frozen or
 * nonsensical world rather than an error.
 */
function open(data: Uint8Array, name: string, disc: number, size: number): DataView {
  if (data.length < size) {
    throw new Error(`${name}: got ${data.length} bytes, need ${size}`);
  }
  if (data[0] !== disc) {
    throw new Error(`${name}: discriminator ${String(data[0])}, expected ${disc}`);
  }
  if (data[1] !== LAYOUT_VERSION) {
    throw new Error(`${name}: layout version ${String(data[1])}, expected ${LAYOUT_VERSION}`);
  }
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function bytes(data: Uint8Array, offset: number, length: number): Uint8Array {
  return data.slice(offset, offset + length);
}

function isZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}

export function decodeArena(data: Uint8Array): ArenaAccount {
  const o = ARENA.offsets;
  const v = open(data, 'Arena', ARENA.discriminator, ARENA.size);

  const bullets: Bullet[] = [];
  for (let i = 0; i < MAX_BULLETS; i++) {
    const b = o.bullets + i * BULLET.size;
    bullets.push({
      x: v.getInt16(b + BULLET.offsets.x, true),
      y: v.getInt16(b + BULLET.offsets.y, true),
      dx: v.getInt8(b + BULLET.offsets.dx),
      dy: v.getInt8(b + BULLET.offsets.dy),
      active: v.getUint8(b + BULLET.offsets.active),
    });
  }

  return {
    bump: v.getUint8(o.bump),
    phase: v.getUint8(o.phase),
    aliveCount: v.getUint8(o.alive_count),
    bulletCursor: v.getUint8(o.bullet_cursor),
    arenaId: v.getBigUint64(o.arena_id, true),
    crankTaskId: v.getBigInt64(o.crank_task_id, true),
    tick: v.getUint32(o.tick, true),
    enrageAtTick: v.getUint32(o.enrage_at_tick, true),
    seatOccupied: v.getUint32(o.seat_occupied, true),
    incarnation: v.getUint16(o.incarnation, true),
    crankAuthority: bytes(data, o.crank_authority, 32),
    validatorIdentity: bytes(data, o.validator_identity, 32),
    affixSeed: bytes(data, o.affix_seed, 32),
    bullets,
  };
}

export function decodeBoss(data: Uint8Array): BossAccount {
  const o = BOSS.offsets;
  const v = open(data, 'Boss', BOSS.discriminator, BOSS.size);

  const parts: number[] = [];
  const partsMax: number[] = [];
  for (let i = 0; i < N_PARTS; i++) {
    parts.push(v.getUint16(o.parts + i * 2, true));
    partsMax.push(v.getUint16(o.parts_max + i * 2, true));
  }

  return {
    bump: v.getUint8(o.bump),
    ventOpen: v.getUint8(o.vent_open),
    attackTimer: v.getUint8(o.attack_timer),
    targetSeat: v.getUint8(o.target_seat),
    x: v.getInt16(o.x, true),
    y: v.getInt16(o.y, true),
    coreHp: v.getUint16(o.core_hp, true),
    coreHpMax: v.getUint16(o.core_hp_max, true),
    parts,
    partsMax,
  };
}

export function decodePlayers(data: Uint8Array): PlayersAccount {
  const o = PLAYERS.offsets;
  const p = PLAYER_SLOT.offsets;
  const v = open(data, 'Players', PLAYERS.discriminator, PLAYERS.size);

  const slots: PlayerSlot[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    const s = o.slots + seat * PLAYER_SLOT.size;
    const sessionPubkey = bytes(data, s + p.session_pubkey, 32);
    slots.push({
      seat,
      occupied: !isZero(sessionPubkey),
      zone: v.getUint8(s + p.zone),
      facing: v.getUint8(s + p.facing),
      skinId: v.getUint8(s + p.skin_id),
      x: v.getInt16(s + p.x, true),
      y: v.getInt16(s + p.y, true),
      hp: v.getUint16(s + p.hp, true),
      hpMax: v.getUint16(s + p.hp_max, true),
      lastMoveSeq: v.getUint16(s + p.last_move_seq, true),
      respawnAtTick: v.getUint32(s + p.respawn_at_tick, true),
      lastShotTick: v.getUint32(s + p.last_shot_tick, true),
      lastMoveTick: v.getUint32(s + p.last_move_tick, true),
      damageDealt: v.getUint32(s + p.damage_dealt, true),
      sessionPubkey,
      identity: bytes(data, s + p.identity, 32),
    });
  }

  return { bump: v.getUint8(o.bump), slots };
}

export function decodeLeaderboard(data: Uint8Array): LeaderboardAccount {
  const o = LEADERBOARD.offsets;
  const e = LEADERBOARD_ENTRY.offsets;
  const v = open(data, 'Leaderboard', LEADERBOARD.discriminator, LEADERBOARD.size);

  const entries: LeaderboardEntry[] = [];
  for (let i = 0; i < LEADERBOARD_CAP; i++) {
    const b = o.entries + i * LEADERBOARD_ENTRY.size;
    entries.push({
      arenaId: v.getBigUint64(b + e.arena_id, true),
      identity: bytes(data, b + e.identity, 32),
      damageDealt: v.getUint32(b + e.damage_dealt, true),
      incarnation: v.getUint16(b + e.incarnation, true),
      survived: v.getUint8(b + e.survived) === 1,
    });
  }

  return {
    bump: v.getUint8(o.bump),
    totalWritten: v.getUint32(o.total_written, true),
    next: v.getUint32(o.next, true),
    lastArenaId: v.getBigUint64(o.last_arena_id, true),
    lastIncarnation: v.getUint16(o.last_incarnation, true),
    entries,
  };
}

/**
 * Seats a match may still hand out.
 *
 * Bit `n` of `Arena.seat_occupied` is seat `n`, low bit first. That bit order is a
 * layout fact, and the Worker's seat allocator and the client's lobby roster must
 * not each rediscover it.
 */
export function freeSeats(seatOccupied: number): number[] {
  const free: number[] = [];
  for (let seat = 0; seat < MAX_SEATS; seat++) {
    if ((seatOccupied & (1 << seat)) === 0) free.push(seat);
  }
  return free;
}
