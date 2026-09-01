// @generated from programs/heartrot/src/error.rs by `python3 tools/gen_errors.py` -- DO NOT EDIT.
//
// Hand-editing this file re-creates the defect it exists to close: the numbers below
// are wire ABI and a Pinocchio program ships no IDL, so a hand-kept table drifts the
// first time a variant is appended and then mislabels every failure a deployed
// browser tab reports. Edit `heartrot_errors!` in error.rs and re-run the command
// above.
/**
 * `HeartrotError` -- the program's `ProgramError::Custom(n)` codes, by number.
 *
 * Only the game-rule codes live here. Conditions the Solana runtime already names
 * ({@link https://docs.rs/solana-program/latest/solana_program/program_error/enum.ProgramError.html | `MissingRequiredSignature`, `InvalidSeeds`, ...})
 * are not duplicated, so a `Custom` code absent from this table came from another
 * program in the transaction, not from a rule of ours.
 *
 * Read it through {@link decodeTransactionError} rather than indexing it directly.
 */

/** One row: the variant's Rust name and the first sentence of its doc comment. */
export interface HeartrotErrorInfo {
  readonly name: string;
  readonly message: string;
}

/**
 * Live codes only. Retired numbers are absent by construction -- they are not in the
 * macro -- so a lookup miss is the honest answer for one, and {@link HEARTROT_ERROR_HIGHEST}
 * is what separates "retired" from "newer program than this client".
 */
export const HEARTROT_ERRORS: Readonly<Record<number, HeartrotErrorInfo>> = {
  1: { name: "WrongSessionKey", message: "authority signed, but it is not the session key recorded on that seat." },
  2: { name: "NotCrankSigner", message: "The boss_tick signer is not [b\"crank-executor\", arena.crank_authority] under the crank program." },
  3: { name: "SeatOutOfRange", message: "Seat index is >= MAX_SEATS." },
  4: { name: "SeatOccupied", message: "join on a seat whose session_pubkey is already non-zero and whose identity differs \u2014 a returning player with the same identity is allowed to overwrite their own key." },
  5: { name: "SeatUnclaimed", message: "A player instruction named a seat whose session_pubkey is still all-zero." },
  6: { name: "WrongPhase", message: "The arena is not in the phase this instruction requires." },
  7: { name: "RateLimited", message: "The seat's last_move_tick / last_shot_tick cooldown has not elapsed." },
  8: { name: "PlayerDead", message: "The seat's hp is 0." },
  9: { name: "WrongZone", message: "The seat is in the wrong zone for this instruction \u2014 shooting from the lobby, or walking through the gate while already in the arena." },
  10: { name: "MatchNotOver", message: "The arena has not reached PHASE_SETTLED, so it has no result to record." },
  11: { name: "NotTreasury", message: "The signer is not the compiled-in crate::handlers::init::TREASURY." },
  12: { name: "NotArenaAuthority", message: "The signer is not the crank_authority recorded on this Arena." },
  13: { name: "SessionKeyInUse", message: "join was handed a session_pubkey that is already recorded on a different seat." },
  14: { name: "BlockedByWall", message: "move_player's destination tile is solid in crate::map::WALLS." },
  15: { name: "NotOnGate", message: "enter_gate from a seat whose (x, y) is not on a gate tile." },
  17: { name: "MatchNotRecorded", message: "next_incarnation on an arena whose result has not reached the Leaderboard yet \u2014 last_arena_id / last_incarnation do not name this match." },
  18: { name: "NotVrfIdentity", message: "A VRF callback whose signer is not vrf::pda::scoped_vrf_identity(heartrot)." },
};

/**
 * Highest code the program has ever issued, live or retired. A `Custom` code above
 * this one cannot be a `HeartrotError` at all: the deployed program is newer than
 * this client, or the failure came from a different program.
 */
export const HEARTROT_ERROR_HIGHEST = 18;
