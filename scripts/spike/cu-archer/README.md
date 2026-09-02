# cu-archer — throwaway CU instrument for the archer slice (docs/perf/chain-cost-archer.md)

Standalone (`[workspace]` in its own Cargo.toml keeps it out of the repo workspace) but,
unlike `../cu/`, it points `heartrot` at the tree in place — the tree compiles for the host
now, so no scratchpad copy is needed. It measures tags 4 (`join`), 6 (`move`), 7 (`shoot`,
per class) and 8 (`boss_tick`), plus two things `../cu/` does not:

  * a **fight mix** — 1,200 ticks with 20 seats firing at their class cadence after every
    tick, which is the only scenario that can show a player projectile entering the tick's
    swept-collision loop;
  * a **bullet slope** — `boss_tick` with N live bullets pinned active, N in
    {0, 8, 23, 32, 64, 128}, which prices what an on-chain arrow would have cost.

Run it against any number of `<label> <elf>` pairs. The target dir goes outside the repo
so a 7 MB debug binary is not left in `target/`:

    HEARTROT_TREASURY=$(solana address -k treasury.json) cargo build-sbf
    solana program dump -u devnet JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 /tmp/devnet.so
    CARGO_TARGET_DIR=/tmp/cuarch cargo build --release --manifest-path scripts/spike/cu-archer/Cargo.toml
    ARENA_SEED=1 RUST_LOG=off /tmp/cuarch/release/cu-archer \
        "TREE" target/deploy/heartrot.so "DEVNET" /tmp/devnet.so

Do **not** trim the trailing zero padding off a `solana program dump` — mollusk rejects the
trimmed file with `ValueOutOfBounds`. Feed it the dump as written.

`ARENA_SEED` selects the arena key, and it still matters for `move` and `join`: those two
re-derive their child PDA with `find_program_address`, at ~1,500 CU per skipped candidate.
Seed 1 lands both children on bump 255; seed 0 is the 251/254 arena `chain-cost.md` used.
`shoot` and `boss_tick` are bump-insensitive now (chain-cost-archer.md §5).
