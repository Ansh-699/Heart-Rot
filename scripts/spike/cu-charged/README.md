# cu-charged — CU instrument for the charged shot (docs/perf/chain-cost-charged.md)

Standalone (`[workspace]` keeps it out of the repo workspace), `heartrot` pointed at the tree
in place. Sends tag 7 from four stands as a 4-byte block to a baseline ELF and as a 5-byte
block (`charged` 0 and 1) to a candidate, 64 shots each, same fixtures, arena seed 1 (both
child PDAs on bump 255). Also prices the three refusals: `NotCharged` (a step five slots
ago), the old 4-byte block against the candidate, the new 5-byte block against the base.

    HEARTROT_TREASURY=$(solana address -k treasury.json) cargo build-sbf
    CARGO_TARGET_DIR=/tmp/cucharged cargo build --release --manifest-path scripts/spike/cu-charged/Cargo.toml
    ARENA_SEED=1 RUST_LOG=off /tmp/cucharged/release/cu-charged <base.so> target/deploy/heartrot.so

Pass the same ELF twice to read absolute numbers off one program (the BASE rows then refuse
the 4-byte block, which is the deploy-order warning turned into a measurement). A base/cand
delta is only meaningful when the two ELFs differ by the charged-shot files alone — the
map and the hitboxes moved in the same round, and a shot's CU follows the ray length.
