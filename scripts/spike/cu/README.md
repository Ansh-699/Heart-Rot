# cu-harness — throwaway CU instrument (docs/perf/chain-cost.md)

Not wired into the workspace and not a member of it (`[workspace]` in its own
Cargo.toml keeps it standalone). It measures compute units for tags 6/7/8 against two
ELFs in one Agave SVM (mollusk-svm 0.15.1):

  * the working tree, built with `cargo build-sbf`
  * the program currently on devnet, from `solana program dump -u devnet <id> deployed.so`

To re-run, copy this directory somewhere outside the repo, point
`heartrot = { path = ... }` at a checkout, and:

    ARENA_SEED=1 RUST_LOG=off cargo run --release -q -- <dir holding tree/ and heartrot_deployed.so>

`ARENA_SEED` selects the arena key. It matters: `assert_pda` re-derives with
`find_program_address`, so an arena whose `boss`/`players` PDAs are not on bump 255 costs
~1,500 CU per skipped candidate on every `shoot` and every `boss_tick`. `ARENA_SEED=1`
is a key where both children land on 255; `cargo run --release -- <dir> search` finds one.
