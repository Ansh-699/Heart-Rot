//! The instruction wire format: one leading discriminator byte, then a fixed-size,
//! little-endian argument block sliced by offset.
//!
//! There is no borsh and no serde here, deliberately. Every argument block in this
//! program has a compile-time-known length, so parsing is a length check and a handful
//! of `from_le_bytes` calls — and a hand-rolled parser is the only kind that can be
//! *exact* about length. It is: an argument block that is one byte short **or one byte
//! long** is rejected. A short slice is an attacker probing for an index panic; a long
//! one is either a client/program version skew or someone hiding a payload where the
//! next version of this program might read it. Neither is something to accept quietly.
//!
//! The parser also enforces the one bound it can see from here — `seat < MAX_SEATS` —
//! before any account is touched. Handlers must still bounds-check before indexing
//! `Players.slots`; this is the outer layer, not a substitute for the inner one.
//!
//! ## Wire ABI
//!
//! | Tag | Instruction | Layer | Args (bytes after the tag) |
//! |---|---|---|---|
//! | 0 | `InitLeaderboard` | base | — |
//! | 1 | `InitArena` | base | `arena_id` u64 `[0..8]`, `incarnation` u16 `[8..10]`, `validator_identity` `[10..42]`, `crank_authority` `[42..74]` |
//! | 2 | `Delegate` | base | — |
//! | 3 | `StartMatch` | ER | — |
//! | 4 | `ClaimSeat` | ER | `seat` u8 `[0]`, `skin_id` u8 `[1]`, `session_pubkey` `[2..34]`, `identity` `[34..66]` |
//! | 5 | `EnterGate` | ER | `seat` u8 `[0]` |
//! | 6 | `Move` | ER | `seat` u8 `[0]`, `seq` u16 `[1..3]`, `dx` i8 `[3]`, `dy` i8 `[4]` |
//! | 7 | `Shoot` | ER | `seat` u8 `[0]`, `dir` u8 `[1]` |
//! | 8 | `BossTick` | ER | — |
//! | 9 | `Settle` | ER | — |
//! | 10 | `WriteLeaderboard` | base | `arena_id` u64 `[0..8]`, `incarnation` u16 `[8..10]` |
//!
//! These numbers are the ABI shared with `packages/client/src/` and the Worker. They are
//! append-only: never renumber, never reuse a retired tag.

use crate::{error::HeartrotError, state::MAX_SEATS};
use pinocchio::error::ProgramError;

/// Eight-way facing, matching `PlayerSlot.facing`. `dir` outside this range would index
/// a direction table out of bounds in `shoot`, so it is rejected at the boundary.
const FACINGS: u8 = 8;

/// A parsed instruction. The 32-byte fields borrow from `instruction_data` rather than
/// copying: the input buffer outlives the handler call, and this is a program where
/// 64 bytes of pointless memcpy is worth not doing.
pub enum Instruction<'a> {
    InitLeaderboard,
    InitArena {
        arena_id: u64,
        incarnation: u16,
        validator_identity: &'a [u8; 32],
        crank_authority: &'a [u8; 32],
    },
    Delegate,
    StartMatch,
    ClaimSeat {
        seat: u8,
        skin_id: u8,
        session_pubkey: &'a [u8; 32],
        identity: &'a [u8; 32],
    },
    EnterGate {
        seat: u8,
    },
    Move {
        seat: u8,
        seq: u16,
        dx: i8,
        dy: i8,
    },
    Shoot {
        seat: u8,
        dir: u8,
    },
    BossTick,
    Settle,
    WriteLeaderboard {
        arena_id: u64,
        incarnation: u16,
    },
}

impl<'a> Instruction<'a> {
    /// Split the discriminator off `instruction_data` and parse the rest.
    ///
    /// Empty data is rejected here rather than defaulting to instruction 0 — an empty
    /// slice is not a request to initialize the leaderboard.
    pub fn parse(data: &'a [u8]) -> Result<Self, ProgramError> {
        let (&tag, args) = data
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;

        match tag {
            0 => {
                exact(args, 0)?;
                Ok(Instruction::InitLeaderboard)
            }
            1 => {
                exact(args, 74)?;
                Ok(Instruction::InitArena {
                    arena_id: u64::from_le_bytes(*take::<8>(args, 0)?),
                    incarnation: u16::from_le_bytes(*take::<2>(args, 8)?),
                    validator_identity: take::<32>(args, 10)?,
                    crank_authority: take::<32>(args, 42)?,
                })
            }
            2 => {
                exact(args, 0)?;
                Ok(Instruction::Delegate)
            }
            3 => {
                exact(args, 0)?;
                Ok(Instruction::StartMatch)
            }
            4 => {
                exact(args, 66)?;
                Ok(Instruction::ClaimSeat {
                    seat: seat(args[0])?,
                    skin_id: args[1],
                    session_pubkey: take::<32>(args, 2)?,
                    identity: take::<32>(args, 34)?,
                })
            }
            5 => {
                exact(args, 1)?;
                Ok(Instruction::EnterGate {
                    seat: seat(args[0])?,
                })
            }
            6 => {
                exact(args, 5)?;
                Ok(Instruction::Move {
                    seat: seat(args[0])?,
                    seq: u16::from_le_bytes(*take::<2>(args, 1)?),
                    // A move delta is signed and single-digit; the handler clamps it
                    // against the per-tick speed cap, which is a game rule this parser
                    // has no business knowing.
                    dx: args[3] as i8,
                    dy: args[4] as i8,
                })
            }
            7 => {
                exact(args, 2)?;
                let dir = args[1];
                if dir >= FACINGS {
                    return Err(ProgramError::InvalidInstructionData);
                }
                Ok(Instruction::Shoot {
                    seat: seat(args[0])?,
                    dir,
                })
            }
            8 => {
                exact(args, 0)?;
                Ok(Instruction::BossTick)
            }
            9 => {
                exact(args, 0)?;
                Ok(Instruction::Settle)
            }
            10 => {
                exact(args, 10)?;
                Ok(Instruction::WriteLeaderboard {
                    arena_id: u64::from_le_bytes(*take::<8>(args, 0)?),
                    incarnation: u16::from_le_bytes(*take::<2>(args, 8)?),
                })
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// Exact-length gate. Every direct `args[i]` in this file sits behind one of these, so
/// none of them can panic.
#[inline(always)]
fn exact(args: &[u8], len: usize) -> Result<(), ProgramError> {
    if args.len() == len {
        Ok(())
    } else {
        Err(ProgramError::InvalidInstructionData)
    }
}

/// Borrow a fixed-size array out of the argument block without copying or panicking.
#[inline(always)]
fn take<const N: usize>(args: &[u8], at: usize) -> Result<&[u8; N], ProgramError> {
    args.get(at..at.saturating_add(N))
        .and_then(|s| s.try_into().ok())
        .ok_or(ProgramError::InvalidInstructionData)
}

/// Seats are index-addressed into a fixed 20-slot array; an out-of-range index must die
/// at the boundary, not inside a handler's indexing expression.
#[inline(always)]
fn seat(raw: u8) -> Result<u8, ProgramError> {
    if (raw as usize) < MAX_SEATS {
        Ok(raw)
    } else {
        Err(HeartrotError::SeatOutOfRange.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The parser is the program's trust boundary, so the check that matters is that
    /// every malformed shape is *rejected*, not that a well-formed one decodes.
    #[test]
    fn parse_rejects_and_accepts() {
        // Empty data is not instruction 0.
        assert!(Instruction::parse(&[]).is_err());
        // Unknown discriminator.
        assert!(Instruction::parse(&[11]).is_err());
        // Zero-arg instruction with a trailing byte.
        assert!(Instruction::parse(&[8, 0]).is_err());
        // Move, one byte short and one byte long.
        assert!(Instruction::parse(&[6, 0, 0, 0, 0]).is_err());
        assert!(Instruction::parse(&[6, 0, 0, 0, 0, 0, 0]).is_err());
        // Seat out of range, and facing out of range.
        assert!(Instruction::parse(&[5, MAX_SEATS as u8]).is_err());
        assert!(Instruction::parse(&[7, 0, FACINGS]).is_err());

        // A well-formed Move: seat 3, seq 0x0102, dx -1, dy +2.
        match Instruction::parse(&[6, 3, 0x02, 0x01, 0xFF, 0x02]).unwrap() {
            Instruction::Move { seat, seq, dx, dy } => {
                assert_eq!((seat, seq, dx, dy), (3, 0x0102, -1, 2));
            }
            _ => panic!("wrong variant"),
        }

        // A well-formed InitArena: the two 32-byte fields must land at 10 and 42.
        let mut data = [0u8; 75];
        data[0] = 1;
        data[1..9].copy_from_slice(&7u64.to_le_bytes());
        data[9..11].copy_from_slice(&2u16.to_le_bytes());
        data[11] = 0xAA; // first byte of validator_identity
        data[43] = 0xBB; // first byte of crank_authority
        match Instruction::parse(&data).unwrap() {
            Instruction::InitArena {
                arena_id,
                incarnation,
                validator_identity,
                crank_authority,
            } => {
                assert_eq!((arena_id, incarnation), (7, 2));
                assert_eq!(validator_identity[0], 0xAA);
                assert_eq!(crank_authority[0], 0xBB);
            }
            _ => panic!("wrong variant"),
        }
    }
}
