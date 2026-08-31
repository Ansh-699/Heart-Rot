# HEARTROT

A fully on-chain co-op pixel-art boss raid on Solana **devnet**.

10–20 players drop into one dungeon arena and fight a single boss in real time. The boss is
not a health bar — it is a fused amalgam whose **parts** are its health. Break the thorn
clusters and the incoming volleys thin out; break the heads and the melee pressure drops.
Once the shell falls below 35% the torso vents and the human core underneath becomes
damageable. Kill it and it respawns as a harder *incarnation*. Movement, shots, bullets,
health and boss state all live on-chain. Nobody sees a wallet popup during play.

Full rules: [`docs/architecture/00-game-design-spec.md`](docs/architecture/00-game-design-spec.md).

---

## Architecture in a paragraph

One native **Pinocchio** program, `heartrot`, owns every piece of game state and is deployed
to the devnet base layer. At match start the treasury allocates an `ArenaState` account plus
20 seat-indexed `Player` accounts and **delegates** all of them to a MagicBlock Ephemeral
Rollup (`devnet-as`), where transactions are free and blocks are 50 ms. A **crank** — a row
in the ER validator's own scheduler, signed and paid by the validator — calls `boss_tick`
every 400 ms: it advances the bullet pool, resolves collisions, respawns the dead, and picks
the boss's target. Players sign gameplay with a non-extractable WebCrypto session key held
in IndexedDB, submitting straight to the ER; the browser predicts locally and reconciles
against a sequence number, because real move-to-confirm latency from India is ~136–196 ms,
not the 10 ms the marketing number suggests. When the fight ends, `settle()` cancels the
crank, commits and undelegates all 21 accounts back to base layer, and an idempotent
`write_leaderboard` records the run. The frontend is a Vite + React SPA served as free
static assets from Cloudflare, and a single TypeScript Worker handles four cold-path routes
under `/api/*` — onboarding, match start, settle, treasury health. `run_worker_first`
restricts the Worker to exactly that prefix, so "gameplay never touches the backend" is
enforced by the platform rather than by discipline.

The reasoning, the rejected alternatives and the 17 settled decisions are in
[`docs/architecture/`](docs/architecture/). Read `01-architecture.md` first, then
`03-risks-and-build-order.md`. Per-subsystem research lives in `docs/research/`.

### Four constraints that shape everything

These came out of research and are not negotiable at the code level:

1. **~38 total account keys per ER transaction.** The ER rejects `program_id_index >= 38`
   unconditionally, and program ids sort last, so for a write-heavy transaction that is a
   ceiling on *all* accounts. Hence ~4 fat accounts, not many small ones.
2. **No address lookup tables.** The ER rejects v0 transactions carrying them, with no
   feature flag. There is no escape hatch from constraint 1.
3. **A crank gets 400,000 CU, carries no writable signer, and cannot re-arm itself.**
   Iterations are scheduled for the whole match up front, `task_id` is a wide random `i64`
   (the namespace is validator-global and collisions fail *silently*), and `boss_tick` must
   return `Ok` on every unexpected state — ten consecutive errors kill the match permanently.
4. **ER fees are zero, so fees rate-limit nothing.** Any keypair can flood the ER for free.
   Rate limiting lives in the program as tick counters, and Pinocchio validates nothing
   automatically — every owner, signer, PDA and discriminator check is hand-written.

---

## Layout

```
programs/heartrot/   native Pinocchio program — all game state and logic
packages/client/     hand-written TypeScript SDK (no IDL: Pinocchio emits none)
app/                 Vite + React SPA, built to app/dist
worker/              Cloudflare Worker, 4 routes under /api/*
tools/               px2svg.py and friends — sprite → SVG rig, build-time only
docs/                architecture (read first) and research
assets/sprites/      source pixel art
```

## Build and run

### Prerequisites

Solana CLI with `cargo build-sbf` (verified against solana-cli 4.2.1 / platform-tools 1.54),
Rust via rustup (`rust-toolchain.toml` pins the host toolchain), Node ≥ 20.18 and pnpm 10.

### The on-chain half

```sh
pnpm program:build                  # cargo build-sbf -> target/deploy/heartrot.so
pnpm program:test                   # host-side unit tests
pnpm program:lint                   # clippy, warnings denied
solana program deploy target/deploy/heartrot.so --url devnet
```

Put the resulting program id into `PROGRAM_ID` in `worker/wrangler.jsonc`.

### The web half

```sh
pnpm install
cp .env.example worker/.dev.vars    # then fill it in; wrangler reads .dev.vars, not .env
pnpm cf-types                       # generates worker/worker-configuration.d.ts (Env)
pnpm dev                            # vite on :5173 + wrangler on :8787, /api proxied
```

`pnpm typecheck` runs `tsc` across all three packages.

To ship:

```sh
pnpm ship                           # vite build, then wrangler deploy (assets + Worker)
```

It is called `ship`, not `deploy`, because `pnpm deploy` is a pnpm builtin and would shadow
the script. For the same reason, per-package invocations need an explicit `run`:
`pnpm --filter @heartrot/worker run deploy`.

Production secrets are not in any file — set them with
`pnpm --filter @heartrot/worker exec wrangler secret put <NAME>`. `.env.example` lists every
name.

---

## Status: scaffold only

Honest accounting, as of 2026-09-01:

| | State |
|---|---|
| Workspace, toolchain, package and Cloudflare config | done — this commit |
| `programs/heartrot` source | **not written.** The manifest exists; `src/` does not, so `cargo build` will not resolve until the program lands |
| `packages/client` source | **not written** |
| `app/src`, `worker/src` | **not written** — `pnpm dev` fails until they exist |
| Devnet deployment | none. `PROGRAM_ID` is empty |
| Spikes SP1–SP11 in `03-risks-and-build-order.md` | **none run.** SP1 (Pinocchio + ER hello-world) and SP2 (crank CU ceiling) gate everything downstream |
| Art pipeline | `tools/px2svg.py` and sprites exist; `svg_slice.py` and the hitbox JSON do not |

> **Docs say Anchor; the code is Pinocchio.** `docs/architecture/` was written when the
> decision was "one plain Anchor program" (D1/D2), and its Rust snippets use `#[account]`
> and `#[zero_copy]`. The stack was subsequently changed to native Pinocchio 0.11 +
> `ephemeral-rollups-pinocchio` 0.17. Every *constraint*, account layout, PDA seed, sequence
> and cost figure in those documents still holds verbatim — only the framework syntax around
> them does not. The docs have not been amended.
