# HEARTROT — End-to-End Architecture

**Date:** 2026-09-01
**Status:** Build document. Supersedes the on-chain and backend sections of `00-game-design-spec.md`.
**Target:** Solana devnet + MagicBlock Ephemeral Rollup (`devnet-as`)

Every claim below cites the research doc it came from, e.g. `[bolt-core.md]`. Sections
where research confidence was low are marked **UNVERIFIED** and carry the experiment
that settles them.

---

## 0. Three decisions that changed the spec

Read these before anything else. The game design in `00-game-design-spec.md` §1–4, §6
(art direction), §7 and §10 survives intact. The implementation sections do not.

### 0.1 BOLT is out. One plain Anchor program is in.

MagicBlock BOLT was deprecated by its authors on **2026-05-28** — the README on `main`
reads *"Bolt has been deprecated and is no longer actively maintained. This repository is
kept available for reference only."* Every BOLT page has been deleted from
docs.magicblock.gg. Last code commit 2025-10-19. `bolt-lang` 0.2.5 and 0.2.6 are yanked,
leaving 0.2.4 (2025-07-23), **which does not compile from crates.io** — reproduced three
ways, caused by bare `^0` version requirements dragging anchor-lang 1.x and ER SDK 0.17
in alongside the 0.31/0.2.6 versions BOLT expects. `[bolt-core.md]` `[bolt-delegation.md]`
`[bolt-pinocchio-cpi.md]`

Independently of maintenance, BOLT cannot express this game:

| BOLT constraint | HEARTROT impact | Source |
|---|---|---|
| Systems return component state through Solana return data, `MAX_RETURN_DATA = 1024` | `Bullets[128]` alone serializes to 936 B. `BossTick` as specced (bullets + arena + boss + 20 players) is ~4× over and cannot be tuned to fit | `[bolt-core.md]` `[bolt-pinocchio-cpi.md]` |
| No zero-copy — `#[component]` emits `#[account]`, write path is `set_inner(try_from_slice(..))` | 928 B fully deserialized + reserialized + shipped as return data + reserialized again, every 400 ms | `[bolt-core.md]` |
| ~9,340 CU per component per `apply` on *empty* systems with 32-byte components | ~193K CU of pure framework tax against a 400K crank budget, before any game logic | `[bolt-core.md]` |
| Delegation is per component PDA | **86** delegated accounts, ~18–22 base-layer transactions per match start | `[bolt-delegation.md]` |
| Every component and system is its own program | **16** deploys, 16 program IDs, 16 upgrade authorities | `[bolt-core.md]` |
| `World::default()` is `permissionless: true`; component `update` short-circuits when `authority == World::id()`, which is the TS SDK default | Any signer can write any component through any system until hardened | `[bolt-delegation.md]` |
| `delegate` and `undelegate` are entirely unauthenticated | Anyone can undelegate `ArenaState` mid-raid and stall the fight for 20 players | `[bolt-delegation.md]` |
| Cannot reach ER SDK 0.17's `crank` / Magic Action APIs (pins ER SDK 0.2.6) | Spec §5's crank and settlement paths are unreachable through bolt-lang | `[bolt-core.md]` `[er-magic-actions.md]` |

**Replacement:** one Anchor program, `heartrot`, on `ephemeral-rollups-sdk 0.17.0` (alive,
shipped 2026-08-26). The ECS decomposition survives as struct fields. 21 delegated
accounts instead of 86. One deploy instead of 16. Zero-copy on the hot account. Full
access to the current crank and intent-bundle APIs. `[bolt-delegation.md]`
`[bolt-core.md]` (both docs independently recommend exactly this migration)

Spec §11's "BOLT over Pinocchio" reasoning — *"BOLT supplies the World/Entity/Component
scaffolding, delegation, and ER wiring, and avoids a week of CPI reverse-engineering"* —
assumed BOLT was a maintained shortcut. The frozen-lockfile work, 16 deploys and the
1024-byte redesign now cost more than the week it was avoiding. `[bolt-core.md]`

### 0.2 Pinocchio: zero programs in HEARTROT v1. Final.

The user's question was whether a native Pinocchio program should sit alongside the
on-chain layer with CPI between them. The answer is no, and the reasons survive the death
of BOLT:

1. **There is no ownership boundary left to cross.** With one Anchor program owning every
   account, a second program can only reach that state through a CPI, and Solana's
   ownership rule means it still cannot write anything it does not own. Adding a program
   creates the boundary; it does not remove one. `[pinocchio-core.md]`
2. **The CU math is negative.** One CPI hop costs 946–2,500 CU. The entire
   Pinocchio-over-Anchor framework saving is ~500 CU per instruction (measured: memo
   benchmark Anchor ~649 CU vs Pinocchio ~108 CU; transfer-lamports 459 vs 27). A
   Pinocchio program that CPIs into the Anchor program spends more than it saves.
   `[pinocchio-core.md]` `[bolt-pinocchio-cpi.md]`
3. **There is no compute pressure to relieve.** The ER gives the same 200K/instruction and
   1.4M/transaction budgets as base layer — no extra headroom, and none needed.
   `[bolt-pinocchio-cpi.md]` The crank tick's real ceiling is 400,000 CU
   `[er-cranks.md, VERIFICATION]`, and the tick is integer arithmetic over a 1 KB
   zero-copy struct.
4. **The one genuine carve-out evaporated.** The only defensible split was giving the
   bullet pool its own program-owned account to escape BOLT's 1024-byte return-data
   ceiling `[bolt-pinocchio-cpi.md]`. Dropping BOLT drops the ceiling. The bullet pool is
   now a `#[account(zero_copy)]` field on `Arena`.
5. **It costs a whole second toolchain.** Pinocchio emits no IDL, so its TypeScript client
   is hand-written or Codama-generated; `pinocchio-idl` has 41 total downloads and is not
   usable. Pinocchio validates nothing — no owner check, no signer check, no discriminator
   check, all hand-written. `bytemuck::from_bytes` panics on misalignment at runtime, not
   compile time. Pinocchio and `ephemeral-rollups-pinocchio` are both explicitly
   unaudited. `[pinocchio-core.md]`

**Correction to spec §11 regardless of the verdict.** Its stated reason is factually
wrong and must not be repeated: `ephemeral-rollups-pinocchio 0.17.0` **exists**, published
by MagicBlock Labs on 2026-08-26, with delegate, commit, undelegate, crank/ScheduleTask,
VRF, Magic Actions, ACL and ephemeral SPL — roughly 30 releases dating to 2025-08-27.
The `AccountInfo` incompatibility argument is also stale (Pinocchio 0.11 renamed the type
to `AccountView` and the ER Pinocchio SDK uses it natively), and it was always a
compile-time *linking* constraint, never a CPI-boundary one — across an actual CPI the
runtime re-serializes and each side parses with its own library. `[pinocchio-core.md]`
`[bolt-pinocchio-cpi.md]` `[er-vrf.md]`

**Where Pinocchio should go instead.** The user's Rust interview sprint
(`~/Documents/revise`) and any standalone program where the program *owns* its accounts
and the CU budget is genuinely binding. MagicBlock's own delegation program is written in
Pinocchio `[devnet-faucet.md]`, which is the proof that native programs interoperate with
the ER machinery perfectly well — it just is not a reason to add one here. If HEARTROT
ever profiles a tick over 400K CU, the fix is arithmetic (bitboard the active-bullet mask,
squared-distance integer collision), not a framework swap.

### 0.3 Frontend: Vite + React SPA on Workers static assets. Not Next.js.

Cloudflare now recommends `vinext` over OpenNext for Next.js on Workers, and vinext is
real and works `[nextjs-cloudflare.md, VERIFICATION]`. It is also 1.0.0-beta.8, ~6 months
old, with four open Cloudflare-specific issues and no GA date, and its own README says
*"If you need a mature, well-tested way to run Next.js outside Vercel, OpenNext is the
safer choice."*

The decisive fact is billing and latency shape, not maturity. vinext **server-renders
every page on every request** (README: *"vinext server-renders all pages on each
request"*), and Cloudflare's billing doc says *"Requests to static assets are free and
unlimited. Requests to the Worker script (for example, in the case of SSR content) are
billed according to Workers pricing."* Every load of HEARTROT's static game shell becomes
a billed Worker invocation plus an SSR round-trip before the canvas can mount. The obvious
fix — prerender the shell at build time — is blocked by vinext issue #2911, which crashes
the prerender when any server module imports `cloudflare:workers`, i.e. exactly what the 4
route handlers must do to reach bindings. `[nextjs-cloudflare.md]`

HEARTROT is a client-rendered SVG canvas plus 4 cold-path routes. It uses essentially none
of the Next.js API surface that vinext and OpenNext exist to reproduce. The route-handler
bodies are byte-identical either way.

**Decision:** Vite + React SPA served as static assets, plus one plain Worker.

```jsonc
// wrangler.jsonc
{
  "assets": { "directory": "./dist", "not_found_handling": "single-page-application" },
  "main": "./src/worker.ts",
  "run_worker_first": ["/api/*"]
}
```

`run_worker_first: ["/api/*"]` is not a convenience — it **structurally enforces** spec
§9's rule that gameplay never passes through the backend. Nothing but `/api/*` can reach
the Worker at all. `[nextjs-cloudflare.md, VERIFICATION]`

> **Spec amendment required.** `00-game-design-spec.md` §9 reads *"Stack: Next.js deployed
> to Cloudflare Workers via vinext."* Amend to the above. This is the one frontend decision
> only the user can close; if Next.js is a hard constraint, use vinext (not OpenNext) and
> accept the per-load Worker invocation.

---

## 1. System overview

| Component | Runtime | Owns |
|---|---|---|
| `heartrot` program | Solana BPF, deployed to **devnet base layer**, accounts delegated to the ER | All game state. One program, one deploy. |
| Arena + 20 Player accounts | **ER** `devnet-as` while a match runs; base layer otherwise | Boss, bullets, players, tick clock |
| Leaderboard account | **devnet base layer**, never delegated | Per-incarnation results |
| `boss_tick` crank | **ER validator** SQLite scheduler + tokio delay queue, signed and paid by the validator | The 400 ms game loop |
| Game client | **Browser** — Vite + React SPA, static assets on Cloudflare | Rendering, prediction, input, ER submission |
| Session keypair | **Browser** — non-extractable WebCrypto Ed25519 in IndexedDB | Signs every gameplay tx. Zero SOL, ever. |
| Cold-path Worker | **Cloudflare Workers**, TypeScript, `@solana/kit` | 4 routes: onboarding, match start, settle, treasury status |
| Treasury keypair | **Worker secret** (`wrangler secret put`) | Base-layer rent, delegation, commits, leaderboard writes |
| Privy | Third-party, browser SDK + JWKS verified in the Worker | Identity and cross-device recovery only. Never in the hot path. |
| `px2svg.py` + `svg_slice.py` | **Build-time, Python** | Sprite → per-part `<g>` groups + integer hitbox JSON |

Three RPC surfaces, and conflating them is the most common failure mode
`[er-connections.md]`:

| Surface | URL | Used for |
|---|---|---|
| Base layer | dedicated provider RPC (**not** `api.devnet.solana.com`) | init, delegate, undelegate, leaderboard write |
| Magic Router | `https://devnet-router.magicblock.app/` | `getRoutes`, `getDelegationStatus`, `getBlockhashForAccounts`, and the **client's WebSocket** |
| ER validator | `https://devnet-as.magicblock.app/` | every gameplay transaction |

> **Trap:** plain `getLatestBlockhash` on the router returns an **ER** blockhash (verified
> live: height 563,474,661). Using the router as a drop-in `Connection` for a base-layer
> delegate or funding transaction signs against the wrong chain and fails.
> `[er-connections.md]`

> **Trap:** `api.devnet.solana.com` returned HTTP 403 `{"code":403,"message":"Your IP or
> provider is blocked from this endpoint"}` to a Worker while the identical POST from a
> host shell returned 200. Budget for a paid RPC provider. `[workers-ts-solana.md]`

---

## 2. The on-chain layer

One program. Rust, Anchor 1.1.2, `ephemeral-rollups-sdk 0.17.0` with features
`["anchor", "crank"]`.

### 2.1 Accounts

Two account types, both PDAs of `heartrot`, both `zero_copy` (the crank mutates `Arena`
every 400 ms; borsh round-tripping 1 KB at 2.5 Hz is the exact cost that made BOLT
untenable).

```rust
// programs/heartrot/src/state.rs
use anchor_lang::prelude::*;

pub const MAX_SEATS:   usize = 20;
pub const MAX_BULLETS: usize = 128;
pub const N_PARTS:     usize = 9; // crown, wolf_l, beast_r, thorn0..3, mace, claws

#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct Bullet {
    pub x:      i16,
    pub y:      i16,
    pub dx:     i8,
    pub dy:     i8,
    pub active: u8,   // u8 not bool: Pod requires it
    pub _pad:   u8,
}                     // 8 bytes, naturally aligned

#[zero_copy]
#[derive(Default)]
#[repr(C)]
pub struct Boss {
    pub x:            i16,
    pub y:            i16,
    pub parts:        [u16; N_PARTS],   // current HP per destructible part
    pub parts_max:    [u16; N_PARTS],   // scaled by incarnation at spawn
    pub core_hp:      u16,
    pub core_hp_max:  u16,
    pub vent_open:    u8,
    pub attack_timer: u8,
    pub target_seat:  u8,
    pub _pad:         u8,
}                                        // 48 bytes

#[account(zero_copy)]
#[repr(C)]
// Field order is WIDEST-FIRST and it is load-bearing, not style. `#[zero_copy]` derives
// `bytemuck::Pod`, whose derive REFUSES to compile on a struct with implicit padding.
// The natural declaration order (u8s first, then u32, then u64) inserts 2 bytes before
// `seat_occupied` and 4 before `arena_id`, and fails to build. Every explicit `_pad`
// field below is mandatory.
#[account(zero_copy)]
#[repr(C)]
pub struct Arena {
    pub arena_id:           u64,    //   0..8
    pub crank_task_id:      i64,    //   8..16
    pub tick:               u32,    //  16..20
    pub enrage_at_tick:     u32,    //  20..24
    pub seat_occupied:      u32,    //  24..28  bitmask, 20 low bits
    pub incarnation:        u16,    //  28..30
    pub bump:               u8,     //  30
    pub phase:              u8,     //  31      0 Lobby 1 Fighting 2 Settling 3 Settled
    pub alive_count:        u8,     //  32
    pub _pad0:              [u8; 7],//  33..40
    pub crank_authority:    Pubkey, //  40..72  treasury; crank_signer_pda derives from it
    pub validator_identity: Pubkey, //  72..104 which ER these accounts live on
    pub affix_seed:         [u8; 32],// 104..136
    pub boss:               Boss,   // 136..184
    pub bullets:            [Bullet; MAX_BULLETS], // 184..1208
}
// 8 (disc) + 1,208 = 1,216 bytes. align 8, 1,208 % 8 == 0, zero implicit padding.
// rent-exempt = (128 + 1216) * 6960 = 9,354,240 lamports ≈ 0.00935 SOL

#[account(zero_copy)]
#[repr(C)]
pub struct Player {
    pub bump:            u8,
    pub seat:            u8,
    pub zone:            u8,   // 0 lobby, 1 arena
    pub facing:          u8,   // 0..7
    pub skin_id:         u8,
    pub _pad0:           [u8; 3],
    pub x:               i16,
    pub y:               i16,
    pub hp:              u16,
    pub hp_max:          u16,
    pub respawn_at_tick: u32,
    pub last_shot_tick:  u32,
    pub last_move_seq:   u16,  // client prediction reconciliation — see §6.3
    pub _pad1:           u16,
    pub damage_dealt:    u32,
    pub session_pubkey:  Pubkey,
    pub identity:        [u8; 32], // sha256(privy DID) — durable leaderboard key
}
// 8 (disc) + 96 = 104 bytes. align 4, 96 % 4 == 0, zero implicit padding — same Pod
// constraint as Arena; `_pad0` and `_pad1` are mandatory, not decorative.
// rent-exempt = (128 + 104) * 6960 = 1,614,720 lamports ≈ 0.00161 SOL

#[account]                      // base layer only, never delegated, plain borsh
pub struct Leaderboard {
    pub bump:    u8,
    pub entries: Vec<Entry>,    // capped, see §2.6
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Entry {
    pub identity:      [u8; 32],
    pub incarnation:   u16,
    pub arena_id:      u64,
    pub damage_dealt:  u32,
    pub survived:      bool,
}
```

### 2.2 PDA derivations

| Account | Seeds | Program | Owner |
|---|---|---|---|
| `Arena` | `[b"arena", arena_id.to_le_bytes()]` | `heartrot` | `heartrot` (base) / `heartrot` inside the ER, `DELeGG…` on base while delegated |
| `Player` | `[b"player", arena.key(), &[seat]]` | `heartrot` | same |
| `Leaderboard` | `[b"leaderboard"]` | `heartrot` | `heartrot`, always base layer |
| Crank signer | `[b"crank-executor", crank_authority]` | `Crank11111111111111111111111111111111111111` | — |
| Delegation record | `[b"delegation", account]` | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` | validator identity at data bytes `8..40` |

**Seat-indexed players are load-bearing, not stylistic.** A crank's account list is
serialized into the validator's SQLite row at schedule time and replayed verbatim forever
— *"a crank can never see an account it was not given at schedule time"* `[er-cranks.md]`.
All 20 `Player` PDAs must therefore exist and be nameable before `boss_tick` is scheduled.
Deriving them from a seat index makes that list deterministic and computable by the Worker,
the crank scheduler and every client without coordination. Players claim a seat; seats are
never created on demand.

**Delegated-account ownership differs by layer** — the delegation program on base layer,
the original owner inside the ER. Any ownership assertion must account for which side it
runs on. `[bolt-pinocchio-cpi.md]` — **UNVERIFIED**, flagged low-confidence there; Anchor's
`#[account(seeds=…, bump)]` handles it for us, but do not hand-roll an owner check.

### 2.3 Instructions

Connection column: **B** = base layer, **E** = ER.

| Instruction | Conn | Signer | Writes | Notes |
|---|---|---|---|---|
| `init_arena(arena_id, incarnation, validator_identity, task_id)` | B | treasury | `Arena` | allocates 1,216 B |
| `init_seat(seat)` | B | treasury | `Player` | ×20, batched 10/tx |
| `delegate_arena` / `delegate_seat` | B | treasury (**and fee payer**) | — | see §3 |
| `claim_seat(seat, session_pubkey, identity, skin_id)` | E | treasury | `Player` | Worker-signed, cold path |
| `move(seq, dx, dy)` | E | session key | `Player` | |
| `shoot(dir)` | E | session key | `Player`, `Arena` | hitscan raycast |
| `enter_gate()` | E | session key | `Player`, `Arena` | |
| `boss_tick()` | E | crank signer PDA (read-only) | `Arena`, all 20 `Player` | **must never return `Err`** |
| `settle()` | E | treasury | `Arena`, all 20 `Player` | `commit_and_undelegate` |
| `write_leaderboard(arena_id, incarnation)` | B | treasury | `Leaderboard` | idempotent |

### 2.4 Authority model

This is the **entire** security perimeter, not defence in depth `[session-keys.md]`.

```rust
// every player-facing instruction, no exceptions
require!(ctx.accounts.authority.is_signer, HeartrotError::NotSigner);
require_keys_eq!(
    ctx.accounts.authority.key(),
    player.session_pubkey,
    HeartrotError::WrongSessionKey
);
```

`boss_tick` authorizes differently — against the crank signer PDA, never a player key,
because only that PDA may sign a crank instruction `[er-cranks.md]` `[er-vrf.md]`:

```rust
let (expected, _) = Pubkey::find_program_address(
    &[b"crank-executor", arena.crank_authority.as_ref()],
    &CRANK_PROGRAM_ID,
);
require_keys_eq!(ctx.accounts.crank_signer.key(), expected, HeartrotError::NotCrank);
require!(ctx.accounts.crank_signer.is_signer, HeartrotError::NotSigner);
```

**Zero fees means zero rate limit.** ER transaction fees are 0 lamports and the ER's forked
SVM performs *no fee-payer validation at all* — no balance check, no rent-exempt check, no
`AccountNotFound`. Verified three ways, including a live probe where a freshly-random
never-existent pubkey was accepted as fee payer and its transaction reached instruction 0
`[session-keys.md]` `[devnet-faucet.md]`. Nothing debits the payer, so the network provides
no economic backstop against spam. Rate limiting must live in the program:

```rust
require!(arena.tick > player.last_shot_tick + SHOT_COOLDOWN_TICKS, ..);  // Shoot
require!(arena.tick > player.last_move_tick, ..);                        // Move, 1/tick
```

`Combat.last_shot_tick` already existed in the spec for this; `Move` needs the equivalent
and the spec does not have it. **Top operational risk of the whole design and unmitigated
in the frozen spec.** `[session-keys.md]`

### 2.5 Compute budget for `boss_tick`

The crank transaction is `[noop, ExecuteCrank]` with **no ComputeBudget instruction**, and
you do not construct it, so the ceiling is fixed and unraisable. Resolved from source:
`magicblock-processor` calls stock Agave `process_compute_budget_instructions` with no
override; `Magic111…` is absent from Agave's compile-time builtin cost table so both
instructions classify as `NotBuiltin`; default limit = 2 × 200,000 = **400,000 CU**.
`[er-cranks.md, VERIFICATION]` (this refutes that doc's own body text, which had guessed
"a few thousand to 400k")

Budget:

- 21 zero-copy account loads (`AccountLoader::load_mut`, no deserialization) — cheap
- 128 bullet position advances — integer add, trivial
- collision: 128 bullets × alive players **in the arena zone**. Skip lobby players and
  inactive bullet slots before the inner loop; use squared integer distance, no sqrt
- one volley spawn every 8 ticks, `3 + alive_count` slots claimed from the free list

Measure it at build step 3 by reading `consumed X of Y compute units` from the crank
transaction logs. If it ever approaches 400K, bitboard the active-bullet mask and the
per-zone player occupancy before considering any architectural change.

### 2.6 Leaderboard

Base layer, never delegated, written by the Worker after the ER commit confirms. Idempotent
on `(arena_id, incarnation)` — a re-run must be a no-op, because the settle path can be
retried. Cap `entries` at a fixed count with a realloc-free ring, or one account per
incarnation (`[b"lb", incarnation.to_le_bytes()]`) if unbounded growth becomes a problem.
Leaderboard *reads* go browser → RPC directly; no route.

### 2.7 Incarnation affixes: deterministic in v1, VRF in v1.1

MagicBlock VRF works inside an ER and is **free** there (the program fee-exempts
`DEFAULT_EPHEMERAL_QUEUE`; base layer costs 500,000 lamports) `[er-vrf.md]`. It is also a
request/callback oracle with a 240-slot TTL, a hard "never same slot" rule, a 25-account
frozen callback list, and a failure mode where a panicking callback retries for two minutes
and the incarnation never rolls. And a **crank cannot request VRF** — the validator rejects
any scheduled instruction carrying a writable signer, and the VRF request needs `payer` as
a writable signer, so the request must ride on the killing-blow player transaction.
`[er-vrf.md]`

v1 does not need any of that. Affixes derive synchronously:

```rust
arena.affix_seed = hashv(&[arena.key().as_ref(), &incarnation.to_le_bytes()]).to_bytes();
```

There is no token, no NFT and no economy (spec §1 non-goals), so there is nothing to
exploit by predicting a co-op PvE boss's affixes. The `affix_seed: [u8; 32]` field is wired
now; v1.1 fills it from a VRF callback instead and nothing else changes.

> Per-tick VRF for bullet patterns is **structurally impossible** — never same-slot,
> 240-slot TTL, callback/crank contention on the same writable accounts. Bullet patterns
> come from `hashv([affix_seed, tick])`, which is free, synchronous, and lets the client
> render identical patterns locally without waiting on chain state. `[er-vrf.md]`

---

## 3. Delegation lifecycle

21 accounts: 1 `Arena` + 20 `Player`. All must go to **one** validator identity —
`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` (`devnet-as`, Singapore; the official devnet
default and the right region for an India-based dev and playtest audience). The SDK's
`Resolver.resolveForTransaction` returns a bare `undefined` when writable accounts resolve
to two different validators, so a mixed-validator transaction is *unbuildable*, not merely
slow. `[er-connections.md]`

| # | Step | Conn | Signs | Pays |
|---|---|---|---|---|
| 1 | `init_arena` | base | treasury | treasury (~0.00935 SOL rent) |
| 2 | `init_seat × 20`, batched 10/tx | base | treasury | treasury (~0.0323 SOL rent) |
| 3 | `delegate_arena` + `delegate_seat × 20`, batched | base | treasury | treasury (rent for buffer + delegation_record + delegation_metadata per account) |
| 4 | poll router `getDelegationStatus` until all 21 report `isDelegated: true` | router | — | — |
| 5 | `ScheduleCrankCpi` for `boss_tick` | **ER** | treasury (as ScheduleTask payer → becomes task authority) | one-time tx only; the **validator** pays every crank execution |
| 6 | `claim_seat` as players join | ER | treasury | nothing (ER fees are 0) |
| … | gameplay | ER | session keys | nothing |
| 7 | `settle()` → `commit_and_undelegate` on all 21 | ER | treasury | commit #1 per account is free |
| 8 | wait for `GetCommitmentSignature` | ER conn (returns a **base-layer** signature) | — | — |
| 9 | `write_leaderboard` | base | treasury | tx fee |

**The delegate payer must be the transaction fee payer.** The delegate instruction marks
`payer` non-writable (`payer: Signer` with no `mut`); it only works because the transaction
fee payer is always writable at message level. A treasury paying fees while a *different*
key is passed as `payer` fails. `[bolt-delegation.md]`

**Pass `commit_frequency_ms` explicitly.** The Rust SDK default is `u32::MAX` (never
auto-commit); some TS builders default to `0`. Whether `0` means "never" or "as often as
possible" is **UNVERIFIED** and it matters: at 21 accounts, "as often as possible" burns the
10-commit free allowance in seconds and then fails with `0xA0000000`. Set
`DelegateConfig { commit_frequency_ms: u32::MAX, validator: Some(DEVNET_AS) }` and commit
explicitly at settle. `[bolt-delegation.md]` `[er-magic-actions.md]`
*Experiment:* delegate one account with `0` and one with `u32::MAX`, idle 60 s, count
commits via `getSignaturesForAddress` on each delegation record.

**Commit economics.** `COMMIT_LIMIT = 10` per *committed account* (not per session), failing
with `0xA0000000`; a single end-of-match `commit_and_undelegate` is commit #1 for each of
the 21, so the quota is never approached. Undelegation session charge is 300,000 lamports
**per account** (resolved: `process_delegation_cleanup` runs per undelegated account) =
0.0063 SOL per match at 21 accounts. `[er-magic-actions.md]` `[devnet-faucet.md]`

**Race after delegate.** The router can report `isDelegated: true` before the ER has cloned
the account, producing `InvalidWritableAccount` on an immediately-following transaction.
The official example's fix is a blind `setTimeout(3000)`, which is both too slow for a
joining player and not a guarantee. Poll `getDelegationStatus` *and* attempt a cheap ER read
of the account before declaring the match live. `[er-connections.md]`

**Griefing note.** `delegate` and `undelegate` were unauthenticated in BOLT
`[bolt-delegation.md]`; with our own program owning the accounts, `delegate_*` sits behind
Anchor's treasury-signer constraint. The base-layer `process_undelegation` handler is still
callable by anyone as part of the delegation program's protocol, but it only fires after an
ER-side commit, which requires our program's `settle()`. Accept the residual risk on
devnet.

**Match start cost, per match:**

| Line | SOL |
|---|---|
| Arena + 20 seat rent | ~0.0416 (**recoverable** on close) |
| Delegation PDA rent float | returned via `delegation_rent_payer` on undelegate |
| Undelegation session charge, 21 × 300,000 lamports | 0.0063 |
| Base-layer tx fees (~25 tx) | ~0.000125 |
| **Non-recoverable burn** | **~0.007 / match** |

Down from the ~0.03–0.05 SOL/match the 86-account BOLT layout implied `[devnet-faucet.md]`.

**Delegation must span incarnations.** The session charge is per session, not per unit
time, so the boss respawn loop staying inside one delegation session is what makes long
multi-incarnation matches amortize. Re-delegating per incarnation would cost another
0.0063 SOL each time. `[devnet-faucet.md]`

---

## 4. The crank / game loop

### 4.1 What a crank actually is

Not an on-chain timer. A row in a SQLite table inside the ER validator plus a tokio delay
queue; the validator signs and pays every crank transaction with its own authority.
`[er-cranks.md]`

```rust
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};

ScheduleTaskArgs {
    task_id:                  arena.crank_task_id,      // i64, NOT u64
    execution_interval_millis: 400,                     // i64
    iterations:                2_000,                   // i64
}
```

- Fields are **i64**, not u64 — the public docs page and the local `magicblock` skill both
  say u64 and are wrong. `[er-cranks.md]` `[er-magic-actions.md]`
- Minimum interval is 10 ms; 400 ms is 40× the floor, no concern.
- `iterations` has no upper bound but no infinite sentinel (`-1` is rejected). 2,000 × 400 ms
  = 13.3 min, comfortably past the 6-minute enrage timer.
- Use `ephemeral_rollups_sdk::crank::ScheduleCrankCpi`, **not** hand-rolled bincode. The
  wire format is mid-migration from bincode to wincode upstream; the SDK makes that a
  version bump instead of a rewrite. `[er-cranks.md]`
- `task_id` is a validator-**global** namespace. The official example's `taskId: 1` will
  silently collide on shared devnet, and the failure is recorded only to a local
  `failed_scheduling` table *after* the CPI already returned `Ok` — you get no error at all.
  Derive a wide random positive i64 and store it on `Arena`: `[er-cranks.md]`

```rust
let h = hashv(&[b"crank", arena_key.as_ref(), &arena_id.to_le_bytes()]).to_bytes();
let task_id = (i64::from_le_bytes(h[0..8].try_into().unwrap()) & i64::MAX).max(1);
```

### 4.2 Re-arm strategy: three layers, in priority order

A crank **cannot re-arm itself**. `validate_cranks_instructions` rejects any account that
is a signer and is not the crank signer PDA, and any account that is writable and *is* the
crank signer PDA; `ScheduleTask`'s `payer` meta is a writable signer, so both doors are
shut. `[er-cranks.md]` `[er-magic-actions.md]` Re-arming must come from outside.

Failure policy on the deployed validator (`magicblock-core 0.14.11`, git `cec4cf5`): 10
execution retries with exponential backoff (100 ms base, doubling, capped 5 s) ≈ **26.3 s
total**, then the task is moved to `failed_tasks` and **never ticks again**. There is no RPC
to query whether your task is alive. `[er-cranks.md, VERIFICATION]`

> The er-cranks.md body claimed the deployed validator cannot see execution failures and
> silently ticks forever, and that the 10-retry kill is a future change. Its own
> verification pass **refuted both**: `send_transaction` defaults to
> `skip_preflight: false`, the ER routes that to `scheduler.execute().await?`, failures
> propagate, and `test_schedule_error.rs` at the deployed commit asserts a failing task
> lands in `failed_tasks` with its counter never incremented. Build against the retry-and-die
> model.

**Layer 1 — `boss_tick` must be total.** This is the primary defence and it is a coding
rule, not a mechanism. Ten consecutive errors kill the match permanently. `boss_tick`
returns `Ok(())` on every unexpected state:

```rust
pub fn boss_tick(ctx: Context<BossTick>) -> Result<()> {
    let mut arena = ctx.accounts.arena.load_mut()?;
    if arena.phase != Phase::Fighting as u8 {
        return Ok(());                   // settled / lobby: no-op, never Err
    }
    // ... no require!, no unwrap, no panic, no indexing without bounds check,
    //     no checked arithmetic that can overflow-panic. Saturating ops throughout.
    Ok(())
}
```

Write one test per branch that asserts `boss_tick` returns `Ok` on garbage input.

**Layer 2 — client watchdog on `arena.tick`, two thresholds.** The crank writes `Arena`
every 400 ms, giving a free liveness heartbeat over the existing `accountSubscribe` — no new
infrastructure. `[realtime-sync.md]`

| Threshold | Meaning | Action |
|---|---|---|
| **3 s** (≈7 missed ticks) | soft — could be a socket stall, a wrong-ER subscription, or a retry ladder in progress | resnapshot via `getMultipleAccounts`, re-verify delegation, show a "reconnecting" overlay. **Do not settle.** |
| **30 s** | hard — past the ~26.3 s retry ladder, the task is dead | `POST /api/match/settle` |

A single 3 s trigger would settle matches that were about to recover — the two-threshold
split is exactly the correction the crank verification pass called for.
`[er-cranks.md, VERIFICATION]`

**Layer 3 — `/api/match/settle` recovery.** Cancels the old task by `task_id`, then either
reschedules (match still live, `phase == Fighting`, players present) or runs `settle()`.
Re-scheduling the same `task_id` with the same authority is a legitimate replace —
`INSERT OR REPLACE INTO tasks`, old queue entry removed, retry counter reset, requeued at
`Duration::from_millis(0)` so it fires immediately. `[er-cranks.md]`

**Cancel before undelegating.** If the crank is still armed when accounts leave the ER it
fires into undelegated accounts. `CancelTask` must precede `commit_and_undelegate` in the
settle path, and an authority mismatch on `CancelTask` is a **silent no-op**, not an error.
`[er-cranks.md]`

### 4.3 The tick

```
boss_tick():
  if phase != Fighting: return Ok
  tick += 1
  advance every active bullet by (dx, dy); deactivate on wall/out-of-bounds
  for each active bullet × each alive arena-zone player:      # squared int distance
      on hit -> saturating_sub player.hp; deactivate bullet
                if hp == 0 { alive_count -= 1; respawn_at_tick = tick + 3s/400ms }
  respawn any player whose respawn_at_tick <= tick, at the arena entrance
  boss.target_seat = nearest alive arena player          # aggro falls out of this
  if tick % 8 == 0:
      n = 3 + alive_count
      spawn n bullets toward target_seat from surviving thorn emitters
      pattern offsets = hashv([affix_seed, tick])        # free, client-replicable
  shell_hp = sum(boss.parts)
  boss.vent_open = shell_hp < 35% of sum(boss.parts_max)
  if boss.core_hp == 0        -> phase = Settling        # win
  if alive_count == 0         -> phase = Settling        # wipe
  if tick >= enrage_at_tick   -> phase = Settling        # 6-min timeout
```

Damage to parts happens in `shoot`, not here — hitscan is a player transaction. Timing is
driven by `arena.tick`, **never wall-clock**: cranks make no wall-clock guarantee, 400 ms is
a target and not a contract. `[er-magic-actions.md]`

---

## 5. The backend

### 5.1 Language verdict: TypeScript. Not Rust.

Both work. Rust was proven end-to-end: a Worker under workerd loaded a 64-byte ed25519 key
from a secret, derived its pubkey, built a System transfer, signed it, self-verified
in-wasm, and emitted base64 that Node's native ed25519 independently verified as `true`.
The "Rust + Solana + wasm is a nightmare" reputation is stale — `solana-keypair 3.1.2` uses
`ed25519-dalek 2.2.0` and builds clean for wasm32. `[workers-rust.md]`

TypeScript wins on four counts, none of them performance:

1. **`@solana/kit 8.2.0` needs zero polyfills.** workerd implements standard Secure-Curves
   Ed25519 including the exact `importKey('pkcs8')` / `exportKey('jwk')` path kit depends
   on. `generateKeyPair`, `signBytes`, full transaction build/sign/encode, and
   `createSolanaRpcSubscriptions` over WebSocket all succeed in workerd 1.20260828.1 with no
   shim. No compatibility flag gates it. `[workers-ts-solana.md]`
2. **One deployable.** A Rust backend cannot live inside the JavaScript Worker that serves
   the SPA — it is a second Worker, a second config, CORS, and split secrets. This is the
   real trade, and it is a deployment trade. `[workers-rust.md]`
3. **Rust has no RPC client.** `solana-client 3.x` dies on wasm32 with 48 `mio` errors, and
   the purpose-built `wasm_client_solana 0.10.0` fails on `solana-program-runtime` E0512.
   JSON-RPC must be hand-rolled (~15 lines, verified working) — a capability TypeScript gets
   free. `[workers-rust.md]`
4. **The Worker is not in the hot path.** 1–2 ms steady state versus a 298–459 ms devnet RPC
   round trip; network dominates signing by two orders of magnitude. There is nothing to
   optimize. `[workers-rust.md]`

Keep `docs/research/workers-rust.md` as proof on file that Rust works if a CPU-bound
cold-path need ever appears.

**Bundle discipline.** Free-plan Worker limit is 3 MB compressed; the CPU limit is 10 ms per
request. Measured: `@solana/kit` 134.39 KiB (30.51 KiB gzip) vs `@solana/web3.js@1.98.4`
662.50 KiB vs `@coral-xyz/anchor@0.32.1` 1,297.89 KiB vs
`@magicblock-labs/ephemeral-rollups-sdk@0.17.0` 1,670.14 KiB. `[workers-ts-solana.md]`

- Worker: `@solana/kit` only. Generate a **Codama** client from the `heartrot` IDL —
  kit-native, no framework, the shape `@solana-program/system` ships in.
- Browser: Anchor is fine, size does not matter there.
- Never construct an Anchor `Program` per request — it parses the whole IDL every time and
  is a realistic 10 ms overrun. Never cache one in a module-level variable either; that is
  request-scoped state in global scope. `[workers-ts-solana.md]`
- The ER SDK's barrel export pulls `@phala/dcap-qvl` (a TEE quote verifier) in
  unconditionally. Deep-import `lib/pda.js` if it enters the Worker at all.

### 5.2 Auth: ~10 lines, no Privy SDK in the Worker

The Privy access token is a plain ES256 JWT against a **public** JWKS (probed directly: no
auth header needed). `[privy-solana.md]`

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';
const JWKS = createRemoteJWKSet(
  new URL(`https://api.privy.io/v1/apps/${env.PRIVY_APP_ID}/jwks.json`)
);
const { payload } = await jwtVerify(token, JWKS, {
  issuer: 'privy.io', audience: env.PRIVY_APP_ID, algorithms: ['ES256'],
});
const did = payload.sub;              // did:privy:...
```

`@privy-io/server-auth` is effectively abandoned (last stable 2025-09-17). `@privy-io/node
0.34.0` is the current server SDK and lists Workers as supported, but we do not need it —
plain `jose` is smaller and has no untested-on-Workers risk. `[privy-solana.md]`
**UNVERIFIED:** nobody has run `@privy-io/node` on Workers; the JWKS path avoids the
question entirely.

### 5.3 The four routes

Base path `/api`. `run_worker_first: ["/api/*"]` means nothing else reaches the Worker.

---

**`POST /api/session/init`**

```jsonc
// request
{
  "privyToken":     "eyJ…",              // ES256 JWT, verified against JWKS — or, for a guest,
                                         // "guest": { pubkey, ts, signature } (routes.ts::resolveIdentity)
  "sessionPubkey":  "base58",            // browser-generated Ed25519 public key
  "skinId":         0
}
// 200
{
  "seat":              3,
  "arenaId":           "1847…",           // u64 as string
  "arenaPda":          "base58",
  "playerPda":         "base58",
  "programId":         "base58",
  "erEndpoint":        "https://devnet-as.magicblock.app/",
  "routerEndpoint":    "https://devnet-router.magicblock.app/",
  "validatorIdentity": "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
  "seatPdas":          ["base58", …],     // all 20, for the client's subscription set
  "tickMs":            400
}
// 409 { "error": "arena_full" }   503 { "error": "treasury_low", "tier": 4 }
```

Verify the JWT → derive `identity = sha256(did)` → find or create the open arena → allocate
a free seat from `seat_occupied` → send `claim_seat` **to the ER** (treasury signs;
undelegated signer on the ER is fine, ER fees are 0) → return the routing bundle.

`erEndpoint` and `validatorIdentity` in the response are **mandatory, not convenience**. The
ER endpoint is a per-match function of which validator the accounts were delegated to. A
client that resolves its own ER can land on the wrong one and will see a **completely
frozen boss with zero console errors and zero WS notifications** — the wrong ER returns the
correctly-owned account with silently stale data, so the owner-check heuristic cannot detect
it. In a 20-player raid this reads as a game bug, not a config bug, and it is the single
most likely production failure. `[er-connections.md]` `[realtime-sync.md]`

Idempotent on `identity` — a returning user with cleared browser storage gets their existing
seat back with the new `session_pubkey` written over the old one. Privy identity is the
durable record; the session key is not. `[session-keys.md]`

---

**`POST /api/match/start`**

```jsonc
// request  { "privyToken": "eyJ…", "arenaId": "1847…" }   — or { "guest": {…}, "arenaId" } as above
// 200
{
  "arenaId":     "1847…",
  "crankTaskId": "6203…",       // i64 as string
  "phase":       "fighting",
  "enrageAtTick": 900,
  "incarnation":  4
}
// 409 { "error": "already_started" }   503 { "error": "delegation_timeout" }
```

Sequence: `init_arena` (base) → `init_seat × 20` batched (base) → `delegate × 21` batched
(base) → poll router `getDelegationStatus` → `ScheduleCrankCpi` (**ER**). Roughly 25
base-layer transactions across three sequential round-trips. Budget 5–15 s and show it in
the UI; this is not a fast route and pretending otherwise produces a broken-looking loader.
`[bolt-delegation.md]` `[er-cranks.md]`

Idempotent on `arenaId` — if `Arena` exists and `phase == Fighting`, return `already_started`
rather than re-delegating.

---

**`POST /api/match/settle`**

```jsonc
// request  { "arenaId": "1847…", "reason": "win" | "wipe" | "enrage" | "crank_dead" }
// 200
{ "committed": true, "baseSignature": "base58", "leaderboardWritten": true, "nextIncarnation": 5 }
// 202 { "committed": false, "retryAfterMs": 2000 }   // commit status unknown, poll again
```

1. `CancelTask(crank_task_id)` on the ER — **before** anything else.
2. `settle()` on the ER: sets `phase = Settled`, then `commit_and_undelegate` on all 21.
3. Await `GetCommitmentSignature`. Note it takes the **ephemeral** connection despite
   returning a base-layer signature, it is a log-string scraper against two hardcoded
   English prefixes, it only ever reads `signature[0]`, and it **throws rather than
   returning null** on every failure path. A throw must be treated as *unknown, retry* —
   never as *commit failed* — or settlement double-fires. That is what the `202` is for.
   `[er-connections.md]`
4. `write_leaderboard(arena_id, incarnation)` on base layer, idempotent.
5. Increment the incarnation counter for the next match.

**Magic Actions are deliberately not used in v1.** The spec §5 promise — *"a Magic Action
chains the base-layer commit and leaderboard write"* — overstates the guarantee: a failing
`BaseAction` can be **removed** from the transaction strategy and the commit retried without
it, so the commit can land with no leaderboard write. Official docs and MagicBlock's own
skill contradict each other on this exact point. `[er-magic-actions.md]` The idempotent
leaderboard write is therefore required regardless, and once it exists the Magic Action buys
nothing but a delegated fee-payer PDA, a `magic_fee_vault`, the payer's delegation record,
`program_id` in the commit context, a lamports top-up path via `lamportsDelegatedTransferIx`,
an undocumented `as_signer` workaround for a verified upstream is_signer bug, and an
`IllegalOwner` trap if the payer ever lands in the committee set. Two transactions, no
bundle. Add the Magic Action in v2 if the extra round trip ever matters.

> **UNVERIFIED:** whether an *undelegated* treasury can be the intent-bundle payer for
> `commit_and_undelegate`. `try_get_fee_vault` returns `Some` only when
> `payer.delegated() && !payer.confined()`, so the vault is correctly omitted for an
> undelegated payer — but the ER also rejects writable non-delegated accounts with
> `InvalidWritableAccount`. Spike this at build step 6. Fallback: a delegated settlement
> PDA topped up via `lamportsDelegatedTransferIx` (discriminator 20, seeds
> `["lamports", payer, destination, salt]`, 32-byte fresh salt, submitted to **base**
> layer). `[er-magic-actions.md]`

---

**`GET /api/faucet/status`**

```jsonc
// 200
{
  "treasuryLamports":   4820000000,
  "estimatedMatches":   688,          // treasuryLamports / ~7,000,000 burn per match
  "tier":               1,            // 1 healthy · 4 degraded, block /session/init
  "airdropRemaining":   1,            // from the RPC's own rate-limit headers, free to read
  "airdropResetSeconds": 0
}
```

Repurposed. It is a **treasury health gauge**, never a player-funding endpoint — because
players need no funding (§7). Reading rate-limit headers is free: a `getHealth` call returns
full airdrop quota state without consuming budget. `[devnet-faucet.md]`

### 5.4 Secrets and limits

| Concern | Handling | Source |
|---|---|---|
| Treasury key | `wrangler secret put`, base58. `createKeyPairSignerFromPrivateKeyBytes(bytes, /*extractable*/ false)` — the CryptoKey then physically cannot be exported; kit itself throws `SOLANA_ERROR__SUBTLE_CRYPTO__CANNOT_EXPORT_NON_EXTRACTABLE_KEY` | `[workers-ts-solana.md]` |
| Base-layer RPC | dedicated provider, API key in a Worker secret. **Not** `api.devnet.solana.com` — 403 to Worker egress | `[workers-ts-solana.md]` |
| Per-IP abuse | Cloudflare Rate Limiting binding (requires wrangler ≥ 4.36.0). **Per-Cloudflare-location, not global** — an abuser multiplies their allowance by the number of colos they can reach | `[nextjs-cloudflare.md]` |
| Global treasury cap | KV counter, daily outflow cap. The rate-limit binding alone is not a real cap | `[nextjs-cloudflare.md]` |
| Double-seat | KV key per `identity`, plus `seat_occupied` on-chain as the authority | — |
| `compatibility_date` | ≥ `2026-08-04` → `nodejs_compat` and `nodejs_compat_v2` are on by default; omit the flags | `[workers-ts-solana.md]` |

---

## 6. The client

Vite + React SPA. Rendering is the one place a measured research doc contradicts the frozen
spec, so start there.

### 6.1 The rig: pure-SVG paths, not `<image>` rasters

Spec §6 rule 2 rejects pure-SVG pixel art on performance grounds: *"20 players × 8 parts ×
40 = 6,400 animated nodes. It crawls."* That conflates two counts. **The animated node count
is the number of `<g>` groups, not the number of rects** — rects inside a group are never
animated individually and are rasterised once. Measured on the real `boss.svg`, on
**software GL** (`--enable-unsafe-swiftshader`, i.e. pessimistic):

| Scene | fps | median | p99 |
|---|---|---|---|
| 7,589 rects in 8 groups animating `transform` | **143.3** | 6.9 ms | — |
| same DOM animating `fill-opacity` | 74.8 | 13.9 ms | 27.7 ms p95 |
| static baseline | 142.3 | — | — |
| full scene, 201 animated nodes (13 boss parts + 20 knights × 3 + 128 bullets) | 96.8 | — | 41.6 ms |
| same + `will-change: transform` on all 201 | **140.0** | — | 13.9 ms |
| 73 nodes (no bullets) | 141.5 | — | 13.8 ms |

`[svg-rendering.md]`

The path rig is viable. **The spec's performance objection is refuted; its separate
art-fidelity objection (*"does not match the reference art anyway"*) is an art call and is
not settled here** — flag for the user.

Why it composites: Blink's `DirectReasonsForSVGChildPaintProperties` grants SVG children
`kActiveTransformAnimation`, and `ObjectTypeSupportsCompositedTransformAnimation` explicitly
admits `<g>`. The group gets its own `cc::Layer`, rasterises once, and each frame is a
matrix update — path complexity is paid at raster time, not per frame. `[svg-rendering.md]`

**The rules that keep it composited.** Every one of these silently drops the rig to the main
thread with no error:

| Rule | Why |
|---|---|
| Animate the `transform` **shorthand** only | `translate:` / `rotate:` / `scale:` as individual properties are **not** composited on SVG (`crbug.com/1278452`). This is the modern idiomatic style everywhere except inside SVG — an easy silent regression. |
| No SMIL anywhere | one `<animate>` on an element takes that element's *CSS* animations off the compositor too |
| No `vector-effect` | `TransformAffectsVectorEffect()` disqualifies |
| No `<use x= y=>`, no nested `<svg>`/`<symbol>` viewport | `IsSVGTransformableContainer() && HasAdditionalTransform()` disqualifies |
| Only `transform`, `opacity`, `filter`, `backdrop-filter` earn a compositing reason | `fill`, `d`, `x`, `y`, `width` are repaints |
| `will-change: transform` on the 128 bullets — and **only** there | recovers 44 fps at 201 layers; also pins raster scale, so never put it on a part that scales |
| Leave `transform-box` at its `view-box` default; emit absolute origins in viewBox units | SVG 2: a container's bbox includes descendant transforms, so `fill-box` + percentage origin makes the pivot drift every frame once an animated `<g>` wraps animated children. Invisible in a flat rig; appears the moment a knockback wrapper is added. |
| `shape-rendering: crispEdges` on `<svg>` (inherited) | keeps paths crisp and fixes hairline seams between abutting fills, which `px2svg`'s one-path-per-colour output is prone to |
| `image-rendering: pixelated` is a **no-op** on SVG shapes | `px2svg.to_svg()` emits it on the root; drop it or comment it, a reviewer will assume it is what keeps the sprite crisp |
| Size the SVG so `cssScale × devicePixelRatio` is an integer | otherwise `crispEdges` snaps to the device grid and sprite pixels alternate 4/5 device px. **UNVERIFIED** — spec-derived arithmetic, the visual confirmation run crashed |
| `steps(n, end)` easing is free | `StepsTimingFunction` runs on the compositor |
| Keep `@media (prefers-reduced-motion:reduce){*{animation:none !important}}` | also sidesteps `ShouldForceReduceMotion`, which otherwise sets `kAcceleratedAnimationsDisabled` globally and degrades to a main-thread rig rather than no rig |

> **Highest-severity rendering risk, unaddressed in the spec: browser zoom.**
> `EffectiveZoom() != 1` disqualifies SVG transform animations from the compositor
> **outright**. A player at 110 % zoom silently gets a main-thread rig. No CSS workaround,
> invisible in local testing at 100 %. The only escape is animating an HTML `<div>` wrapper
> per part instead of a `<g>`. `[svg-rendering.md]`

> All rendering numbers are Chromium on software GL. Firefox and WebKit compositing rules
> were not examined; `EffectiveZoom` and the independent-transform-property restriction are
> Chromium implementation details, not spec. Re-measure on hardware GL and a mid-range phone
> before freezing the bullet decision. The `will-change` recommendation could invert on a
> memory-constrained device. **UNVERIFIED on non-Chromium.** `[svg-rendering.md]`

**Canvas overlay for bullets: rejected, measured.** A 1280×720 canvas with **0** rects ran
at 58.1 fps; with 128 rects, 58.2 fps; at 640×360, 58.3 fps. The JS draw is 0.0 ms median.
The entire penalty is the existence of a per-frame-updating canvas, independent of size and
draw count. Bullets stay SVG nodes with `will-change`. `[svg-rendering.md]`

**Build-time slicer.** `tools/svg_slice.py` regroups `px2svg` output by region instead of by
colour using a flat-colour part-mask PNG, reusing `px2svg.merge_rects`. Verified on the real
`boss.svg`: 13 → 60 `<path>` nodes across 6 groups, 7,589 → 7,654 rects (+0.9 %, runs split
at part boundaries), round-trip diff **0 differing pixels out of 62,100**. It works because
all 7,589 subpaths match exactly `M{x} {y}h{w}v{h}h-{w}z` — 7,589/7,589, zero exceptions —
which makes the slicer exact rather than heuristic. Wire size is free: 118,187 B raw /
22,768 B brotli monolith vs 120,644 / **22,761** sliced. Ship the sliced file, never the
monolith. Working script is verbatim in `docs/research/svg-rendering.md`; copy it to
`tools/svg_slice.py`. `[svg-rendering.md]`

**The slicer also emits `<part>.hitboxes.json`** — integer x/y/w/h plus painted-pixel count
per part. This is what makes spec §6's *"the rig and the hitbox list are the same
structure"* literally true across the browser/chain boundary: one build step produces both
the `<g>` groups the browser animates and the integer rectangles `shoot`'s raycast tests
against, so `Boss.parts` bounds and DOM ids cannot drift. The painted-pixel count is a free
art-derived input for part HP tiers — a bigger part being tankier falls out of the sprite
instead of a magic-number table.

> **Never** derive hitboxes with `getBBox()` in the browser: it forces layout on the main
> thread, returns floats, and would disagree with the chain by sub-pixel amounts. Compute at
> build time from integer rects and ship the numbers. `[svg-rendering.md]`

The boss SVG must be **inline** in the document, not `<img src=…>` — an `<img>` gives no
`<g>` handles, no CSS animation and no hit targets. 22.8 KB brotli inline is fine.
`temple.svg` (332 KB raw) belongs in the static background layer as a pre-rendered raster.

### 6.2 State subscription

Subscribe to **21 accounts** — `Arena` + 20 `Player` — over the **router** WebSocket.

Router versus direct-ER, raced on the same delegated account for 25 s across 488 matched
slots: delta p50 **−4 ms**, p90 0 ms, max 20 ms; setup 595 ms direct vs 665 ms router. The
router adds effectively nothing and transparently proxies to the correct ER, which survives
re-delegation and removes fqdn resolution from the client. `[realtime-sync.md]`
`[er-connections.md]`

> This contradicts `er-connections.md` §10's "~840 ms extra on first-notification latency"
> for the router. It does not reproduce. Both docs recommend the router anyway, so no
> decision changes, but the 840 ms figure must not enter any latency budget.
> `[realtime-sync.md]`

Mechanics, all empirical — **zero of MagicBlock's 215 doc pages mention `Subscribe`**
`[realtime-sync.md]`:

- The router WS supports **only** `accountSubscribe` and `signatureSubscribe`.
  `programSubscribe`, `logsSubscribe` and `slotSubscribe` all return `-32601`. A client
  assuming pubsub parity with an ER silently gets nothing.
- **Pass `encoding: 'base64'` explicitly.** The ER's default is base58.
- **Commitment is ignored** on the ER — `processed`, `confirmed` and `finalized` returned the
  *same subscription id*. One validator, no consensus. Code that is correct on base layer is
  silently meaningless here.
- The ER emits **at most one notification per account per 50 ms slot** (measured: 398
  notifications across 397 distinct slots). Per-account bandwidth is hard-capped at ~20/s
  regardless of write rate.
- **Subscribing does not deliver current state.** Notifications fire only on the next write;
  a delegated but idle account produced 0 notifications in 20 s. An explicit
  `getMultipleAccounts` snapshot on every WebSocket `open` is **mandatory**, not an
  optimization — otherwise a player standing still sees a stale world forever after a
  reconnect.
- Measured reconnect outage: **1,681 ms** (close at 8,015 ms → reopen 9,425 ms → first
  notification 9,662 ms) = 4 missed crank ticks. In a bullet-hell fight the player is
  probably dead and will visibly teleport.
- web3.js reconnect is a **fixed 1,000 ms interval, no backoff, no jitter**. 20 clients
  dropped by one ER blip retry in lockstep. Its `_updateSubscriptions` also retries a
  *failed* subscribe with zero delay and recurses immediately (upstream comment: *"TODO:
  Maybe add an errored state or a retry limit?"*) — a hot CPU loop against a sick ER. Own
  the socket lifecycle; do not let `Connection` manage it.
- web3.js closes the socket 500 ms after the last unsubscribe. **Keep one subscription alive
  across the lobby↔arena transition** or every match start costs a full 1.7 s reconnect.

Bandwidth is a non-issue and does not deserve engineering time: ~71 KB/s (~570 kbit/s) at a
full 20-player raid with 10 Hz movement; ~132 KB/s worst case if every `Player` saturates the
20/s coalescing cap. The JSON-RPC envelope (~289 B) dominates each 441 B notification, so
`dataSlice` and `jsonParsed` are near-useless (313 B and 441 B respectively). Skip
subscribing to anything static. `[realtime-sync.md]`

**Decode.** `Arena` is `zero_copy`, so decode it with a hand-rolled `DataView` reader, not
Anchor's `BorshAccountsCoder` — measured 0.2 µs (typed arrays) / 1.0 µs (128 objects) vs
14.8 µs for Anchor on a HEARTROT-shaped 904-byte bullet pool. At 2.5 decodes/s the
difference is 37 µs/s and does not matter, so use whichever is clearer; the zero-copy
`#[repr(C)]` layout makes the `DataView` version trivial. `[realtime-sync.md]`

### 6.3 Prediction and the latency budget

> **Spec correction.** §9's *"10 ms ER latency"* conflates block time with round-trip
> latency. ER block time is 50 ms; **real move-to-confirm is network RTT + one block =
> 136–196 ms measured from India** (devnet-as 196 ms median / 136 ms min; devnet-us 283 ms;
> devnet-eu 368 ms; base devnet 100 ms). The spec's conclusion — never proxy gameplay
> through the Worker — is correct and *reinforced*, but "10 ms" must not be used as a latency
> budget anywhere, and build-step 2's gate *"done when it feels instant"* **cannot be met by
> the ER alone**. Client prediction moves into step 2. `[realtime-sync.md]`

Three object classes, three treatments:

| Class | Treatment |
|---|---|
| **Own player** | Predict immediately on input, reconcile on the authoritative update. Requires `last_move_seq`. |
| **Other players** | Interpolate ~1 update behind. **Never extrapolate** — they stop, you overshoot, you snap back. |
| **Bullets** | Extrapolate **exactly**. `Bullet` stores integer `{x,y,dx,dy}` and the crank advances by a fixed integer step, so the client can reproduce every intermediate position with **zero prediction error** — which is what makes a 2.5 Hz update rate render as smooth 60 fps bullet-hell. Only if the client keeps the step in **integers** and does not drift into floating point. |

`Player.last_move_seq: u16` is a **change to the frozen spec** (§5's `Position{x,y,zone,facing}`
has no sequence number). Without it an arriving position is ambiguous as to which input it
reflects and prediction cannot be reconciled; the symptom is rubber-banding. It is 2 bytes,
under 1 % of a notification, and vastly cheaper to add now than to retrofit.
`[realtime-sync.md]` It is consistent with `last_shot_tick`, which already plays the same
role for hitscan.

**`arena.tick` is the authoritative clock.** Record `(tick, Date.now())` on each
notification and estimate the fractional tick between them. Do **not** free-run a local
counter — it drifts from the crank, and the crank decides whether a bullet hit you.

### 6.4 Input and submission

1. Input → predict locally, increment `seq`, render immediately.
2. Build the transaction with `feePayer = sessionPubkey`, sign with `crypto.subtle.sign`,
   attach via `tx.addSignature(pubkey, sig)` (present at `@solana/web3.js@1.98.4`
   index.d.ts:1705 and :1773), send to the **ER** with `skipPreflight: true`.
3. `skipPreflight: true` is required for ER transactions; the kit SDK already defaults it
   true, the opposite of stock web3.js. `[er-connections.md]`
4. On the authoritative `Player` notification, if `last_move_seq >= seq` for a
   still-pending input, discard the prediction and snap; otherwise replay unacked inputs
   from the authoritative position.

**Do not use the router's `ConnectionMagicRouter.sendTransaction`.** It calls
`transaction.sign(...)` rather than `partialSign(...)`, wiping existing signatures, and its
else-branch does **not** route `VersionedTransaction` at all — it falls through to plain
web3.js `super.sendTransaction`, so the blockhash logic silently stops applying exactly when
you move to v0 transactions with lookup tables. Send to the concrete ER endpoint from
`/session/init`. `[er-connections.md]`

**Never call `getSlot` against the router** — `-32601`. That breaks kit's
`sendAndConfirmTransactionFactory` and web3.js `confirmTransaction`/`sendAndConfirmTransaction`
silently. Confirm by polling `getSignatureStatuses` against the concrete ER.
`[workers-ts-solana.md]`

The subscription callback may write `transform` and `opacity`, or set a class that starts a
CSS animation. It must **never** write `d`, `fill`, `x`, `y` or `width` — those are repaints,
and they land at exactly the worst moment, since a tick arriving is also when a bullet volley
spawns. `[svg-rendering.md]`

---

## 7. Onboarding and funding

### 7.1 The funding ladder is deleted

Spec §8 is built on a false premise. It states funding is *"~0.005 SOL per player, because
the backend pays every base-layer cost and the session wallet only ever pays ER fees."* **ER
fees are zero and the ER performs no fee-payer balance check whatsoever.** Verified three
independent ways: the validator's `getFeeForMessage` handler returns a hardcoded `0_u64`;
`validate_transaction_fee_payer` has been *deleted* from the vendored SVM in
`magicblock-engine 0.3.3`; and a live probe returned fee 0 for a freshly-random pubkey that
has never existed on chain, whose transaction then **executed** (reaching instruction 0 and
failing on the transfer amount, not on fees). `[session-keys.md]` `[devnet-faucet.md]`

The session wallet needs **zero SOL on the ER and zero on base layer**, provided it never
signs a base-layer transaction — which spec §9 already guarantees, since the backend signs
all setup.

**Deleted:** the four-tier funding ladder, the browser-side airdrop and its per-IP reasoning,
the treasury floor for *player* funding, onboarding card 2, and `/faucet/status` as a player
endpoint.

Which is fortunate, because every tier was near-useless for the stated target user
`[devnet-faucet.md]`:

- Public devnet RPC allows **1 airdrop per IP per 24 h** (`x-ratelimit-airdrop-limit: 1`,
  `retry-after: 86400`), keyed on **IP, not recipient** — three fresh addresses from one IP
  took the counter 1 → 0 → −1 → −2.
- A **failed** airdrop still burns the quota. A `-32603` dry-faucet response decremented
  remaining from 1 to 0 while delivering nothing. No retry can recover it. A player can be
  locked out for 24 h having received zero SOL, with no distinguishable error.
- `faucet.solana.com` requires GitHub OAuth **and** Cloudflare Turnstile — unscriptable. And
  its `github` tier is **byte-identical** to `default` (2 requests / 8 h / 5 SOL max), so
  connecting GitHub buys nothing. It rate-limits on the tuple `(recipient, githubUserId,
  sanitizedIp)` — rotating wallets does not help.
- Every provider faucet requires a mainnet SOL balance or a paid plan (Chainstack 0.8 SOL
  mainnet, QuickNode a minimal mainnet balance, Helius a paid plan) — which a
  never-used-a-wallet user cannot have, by definition.
- CGNAT collapses a whole lobby to one IP. **A 10–20 player raid on shared venue wifi or one
  mobile carrier gets ONE airdrop total between them** — the tier fails exactly in the
  scenario the game is designed for, and will not surface until demo day if testing happens
  on one office network.

The **treasury** still needs SOL, for base-layer rent, delegation and commits. That is what
`/api/faucet/status` now measures.

### 7.2 The flow

```
Card 1   Privy sign-in (email/social, no seed phrase)  OR  "I have a wallet"
              ↓  (both paths converge — see below)
         browser: crypto.subtle.generateKey({name:'Ed25519'}, false, ['sign','verify'])
                  store the CryptoKeyPair in IndexedDB. Non-extractable.
              ↓
Card 2   Loader — POST /api/session/init
         Worker: verify JWT → allocate seat → claim_seat on the ER
              ↓
         Character select → lobby
```

**Two cards, not three.** Card 2 in the spec was "fund the session wallet"; there is nothing
to fund.

**Non-extractable WebCrypto Ed25519, not `localStorage`.** Same effort, and it removes
one-shot key exfiltration: `localStorage` means one XSS or one malicious extension
permanently exfiltrates the key, usable from anywhere forever. A non-extractable `CryptoKey`
is structured-cloneable so it persists in IndexedDB, and downgrades the attack to *"the
attacker must stay resident in the page"*. Available everywhere: Firefox 129 (Aug 2024),
Safari 17, Chrome 137 (May 2026). `[session-keys.md]`

**Key loss is recoverable, deliberately.** IndexedDB is evictable, per-origin and
per-browser. Privy identity is the durable record and `/session/init` is idempotent on
`identity`, so a cleared-storage user re-registers a new session pubkey onto their existing
seat. Without that they are locked out of their own delegated entity. `[session-keys.md]`

**Privy is identity only, and that is a hard constraint, not a preference.** Spec §7 presents
the browser session keypair as a UX choice; the evidence makes it a requirement. There is no
Privy configuration viable at a 400 ms tick: the legacy embedded-wallet backend signs in a
cross-origin **iframe** round trip, the TEE backend is an internet **RTT to api.privy.io**,
and signatures are metered at **$0.01 each above 50K/month** — 20 players at gameplay rates
burns the free 50K in under an hour. `[privy-solana.md]`

Even the popup-free path has a first-signature cost the docs do not advertise: the legacy
headless path runs `initializeWalletProxy(15_000)` and `recoverEmbeddedWallet()` before
signing, so the **first** signature of a session has a **15-second ceiling**, and with
user-controlled recovery it *throws with no modal fallback* rather than prompting.
`[privy-solana.md, VERIFICATION]` HEARTROT never puts a Privy signature on a user-visible
path, so this is avoided entirely.

Privy configuration that matters:

| Setting | Value | Why |
|---|---|---|
| `chain` | **must** pass `'solana:devnet'` explicitly | Both client hooks default to `'solana:mainnet'`, and signing succeeds regardless of chain, so the bug surfaces only at broadcast time. `[privy-solana.md]` |
| `embeddedWallets.mode` | `legacy-embedded-wallets-only` | Sufficient for identity-only use and saves a network hop. TEE mode's session signers / `sponsor:true` / key export throw at *call* time, not config time. `[privy-solana.md]` |
| `solana.rpcs` | omit; do **not** register `defaultSolanaRpcsPlugin` | There is no automatic hosted-RPC fallback — the plugin is opt-in. Not registering it also means Privy's shared RPC never enters any code path. `[privy-solana.md, VERIFICATION]` |
| wallet-connect | `toSolanaWalletConnectors()` | Privy already exposes Phantom/Backpack/WalletConnect through the same Wallet Standard `useWallets()` array. **Spec §7's "two paths" is one code path**, and `@solana/wallet-adapter-*` can be dropped. `[privy-solana.md]` |

**Session key rotation.** Optional and cheap: one free ER write bounds a stolen key to one
match. Not in v1. `[session-keys.md]`

---

## 8. One complete match, end to end

Cold visitor to leaderboard.

| # | Actor | Action | Conn | Signer | Pays |
|---|---|---|---|---|---|
| 1 | Browser | Loads the SPA. HTML/JS/inline SVG served as **static assets — free, unmetered, no Worker invocation** | CF edge | — | — |
| 2 | Browser | Privy sign-in (email/social). Returns a DID and an ES256 access token | Privy | — | — |
| 3 | Browser | `crypto.subtle.generateKey({name:'Ed25519'}, false, …)` → non-extractable CryptoKeyPair → IndexedDB. **No SOL is ever sent to this key** | local | — | — |
| 4 | Browser | `POST /api/session/init { privyToken, sessionPubkey, skinId }` — a guest sends `guest: { pubkey, ts, signature }` (the session key's signature over `heartrot-guest:<pubkey>:<ts>`) instead of `privyToken` | Worker | — | — |
| 5 | Worker | `jwtVerify` against the public Privy JWKS; `identity = sha256(did)` | — | — | — |
| 6 | Worker | Finds the open arena, allocates a free seat from `seat_occupied` | base RPC | — | — |
| 7 | Worker | `claim_seat(seat, session_pubkey, identity, skin_id)` | **ER** | treasury (read-only signer) | nothing — ER fees are 0 |
| 8 | Worker | Returns seat, all 21 PDAs, `erEndpoint`, `validatorIdentity`, `tickMs` | — | — | — |
| 9 | Browser | Opens one **router** WebSocket; `accountSubscribe` on all 21 with `encoding:'base64'`; **`getMultipleAccounts` snapshot on `open`** | router | — | — |
| 10 | Browser | Character select → lobby. Player walks around; `move` transactions go browser → ER directly | ER | session key | nothing |
| 11 | Browser | Enough players stand on the gate. First client to see the threshold calls `POST /api/match/start` | Worker | — | — |
| 12 | Worker | `init_arena` (1,216 B) | base | treasury | ~0.00935 SOL rent |
| 13 | Worker | `init_seat × 20`, batched 10/tx | base | treasury | ~0.0323 SOL rent |
| 14 | Worker | `delegate × 21`, batched. **Treasury must be the tx fee payer** | base | treasury | delegation PDA rent (refunded) |
| 15 | Worker | Polls router `getDelegationStatus` until all 21 are `isDelegated`, then does one cheap ER read to defeat the clone race | router + ER | — | — |
| 16 | Worker | `ScheduleCrankCpi { task_id, 400, 2000 }` for `boss_tick`. Treasury signs → becomes the task authority | **ER** | treasury | one tx; the **validator** pays every execution |
| 17 | Worker | Returns `{ crankTaskId, phase:"fighting", enrageAtTick, incarnation }` | — | — | — |
| 18 | Crank | `boss_tick` every 400 ms: advance 128 bullets, collide, respawn, retarget, volley every 8 ticks at `3 + alive_count`, recompute `vent_open`, check win/wipe/enrage. **Never returns `Err`.** ≤ 400,000 CU | ER | crank signer PDA (read-only) | validator |
| 19 | Browser | Renders from `accountSubscribe`. Own player predicted, others interpolated 1 behind, bullets extrapolated exactly in integers. `arena.tick` is the clock | — | — | — |
| 20 | Browser | `shoot(dir)` → hitscan raycast against the build-time part hitboxes; `Boss.parts` decrement; the `<g>` for a dead part plays its detach animation then `hidden` | ER | session key | nothing |
| 21 | Chain | `shell_hp < 35 %` → `vent_open = 1`. Core becomes damageable | ER | — | — |
| 22 | Chain | `core_hp == 0` → `phase = Settling`. (Or `alive_count == 0`, or `tick >= enrage_at_tick`) | ER | — | — |
| 23 | Browser | Sees `phase == Settling` on the next notification → `POST /api/match/settle { arenaId, reason }` | Worker | — | — |
| 24 | Worker | `CancelTask(crank_task_id)` — **before** anything else | ER | treasury | — |
| 25 | Worker | `settle()` → `phase = Settled`, `commit_and_undelegate` on all 21. Commit #1 each, free | ER | treasury | 21 × 300,000 lamports session charge = 0.0063 SOL |
| 26 | Worker | `GetCommitmentSignature`. **A throw means *unknown, retry* — return `202`, never `500`** | ER conn → base sig | — | — |
| 27 | Worker | `write_leaderboard(arena_id, incarnation)`, idempotent on that pair | base | treasury | tx fee |
| 28 | Worker | Increments the incarnation counter; next `init_arena` scales `parts_max × (1 + incarnation × 0.15)` and re-derives `affix_seed` | base | treasury | — |
| 29 | Browser | Returns to the lobby. **Keeps the WebSocket open** across the transition (closing it costs a 1.7 s reconnect on the next match) | — | — | — |
| 30 | Browser | Leaderboard read goes browser → RPC directly. No route | base RPC | — | — |

**Failure branch (crank dies).** At step 18, if `arena.tick` stops advancing: at **3 s** the
client resnapshots, re-verifies delegation and shows a reconnecting overlay; at **30 s** —
past the ~26.3 s retry ladder — it calls `/api/match/settle { reason: "crank_dead" }`, which
cancels the task and either reschedules (still `Fighting` with players present) or settles.

---

## 9. Pinned dependencies

Pin exact versions. Several of these have breaking changes inside the last six weeks.

### On-chain (Rust)

| Crate | Version | Notes |
|---|---|---|
| `anchor-lang` | `=1.1.2` | stable, 2026-06-26. ER examples use 1.0.2; `2.0.0-rc.1` exists (2026-08-12) — do **not** adopt. `[bolt-delegation.md]` |
| `ephemeral-rollups-sdk` | `=0.17.0` | 2026-08-26, features `["anchor", "crank"]`. `anchor` targets anchor-lang ^1.0; `anchor-compat` targets 0.32.1. `[er-cranks.md]` |
| `solana-program` | via anchor-lang | do not pin separately |
| Rust toolchain | `1.89.0`+ | — |
| **not used** | `bolt-lang`, `bolt-cli`, `@magicblock-labs/bolt-sdk` | deprecated; 0.2.4 does not compile. §0.1 |
| **not used** | `pinocchio`, `ephemeral-rollups-pinocchio` | §0.2 |
| **not used** | `ephemeral-vrf-sdk` | v1.1. When added: `=0.17.0` — **0.3.0, 0.3.1 and 0.4.0 are YANKED**. `[er-vrf.md]` |

### Worker (TypeScript)

| Package | Version | Notes |
|---|---|---|
| `@solana/kit` | `8.2.0` | 2026-08-29. 134.39 KiB / 30.51 KiB gzip. **Pin exactly** — v7.0.0 and v8.0.0 both shipped breaking changes in the last six weeks. `[workers-ts-solana.md]` |
| `jose` | `^6.1.0` | Privy JWT verification. That is the whole auth dependency. `[privy-solana.md]` |
| `wrangler` | `4.127.1` | 2026-08-28. Rate Limiting binding needs ≥ 4.36.0 |
| `compatibility_date` | `2026-08-04` or later | `nodejs_compat` + `v2` on by default; omit the flags |
| Codama-generated `heartrot` client | from IDL | kit-native, no framework, no Anchor in the Worker |
| **not used** | `@coral-xyz/anchor` in the Worker | 1,297.89 KiB, and `Wallet` is `undefined` there — no exports map, esbuild picks the `browser` field, `dist/browser/index.js` omits `NodeWallet`. Any cjs-only export has the same problem. `[workers-ts-solana.md]` |
| **not used** | `@privy-io/server-auth` | abandoned, last stable 2025-09-17 |
| **not used** | `@magicblock-labs/ephemeral-rollups-sdk` in the Worker | barrel export drags `@phala/dcap-qvl` in; deep-import if needed at all |

### Client (TypeScript)

| Package | Version | Notes |
|---|---|---|
| `vite` | `8.2.2` | 2026-08-20 |
| `react` / `react-dom` | `19.2.6` | — |
| `@privy-io/react-auth` | `3.39.0` | 2026-08-31. Solana peers (`@solana/kit`, `@solana-program/*`) are `optional: true` — installing it alone pulls in no Solana stack. `[privy-solana.md, VERIFICATION]` |
| `@solana/web3.js` | `1.98.4` | 2025-07-31. Needed for `tx.addSignature` with the WebCrypto session key. `3.0.0-rc.2` is a thin layer over kit — do **not** adopt |
| `@coral-xyz/anchor` | `0.32.1` | 2025-10-10. TS client stays on 0.32.x even against an Anchor 1.x on-chain program. `[er-connections.md]` |
| `@magicblock-labs/ephemeral-rollups-sdk` | `0.17.0` | 2026-08-26 (npm). Depends on `@solana/web3.js ^1.98.0` |
| **not used** | `@solana/wallet-adapter-*` | Privy already returns external wallets through Wallet Standard |
| **not used** | `@solana/webcrypto-ed25519-polyfill` | swaps native BoringSSL Ed25519 for `@noble/ed25519` JS. Actively harmful |
| **not used** | Next.js / vinext / OpenNext | §0.3 |

### Build tooling (Python)

| Tool | Deps |
|---|---|
| `tools/px2svg.py` | numpy, Pillow (existing) |
| `tools/svg_slice.py` | numpy, Pillow. Copy verbatim from `docs/research/svg-rendering.md` |

### Network constants

| Name | Value |
|---|---|
| Magic Router | `https://devnet-router.magicblock.app/` |
| ER (devnet-as, Singapore) | `https://devnet-as.magicblock.app/` |
| Validator identity (devnet-as) | `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |
| Delegation Program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic Program | `Magic11111111111111111111111111111111111111` |
| Magic Context | `MagicContext1111111111111111111111111111111` |
| Crank Program | `Crank11111111111111111111111111111111111111` |
| Devnet ER version | `magicblock-core 0.14.11` / `solana-core 4.0.0` / git `cec4cf5` |
| ER slot time | 50 ms (`blockTimeMs: 50`, all four regions) |
| ER transaction fee | **0 lamports**, no fee-payer validation |
| Crank CU ceiling | **400,000** |
| `COMMIT_LIMIT` | 10 per committed account; error `0xA0000000` |
| Undelegation session charge | 300,000 lamports **per account** |

> **Do not use the local `magicblock` skill's dependency block verbatim.** It pins ER SDK
> 0.14.3 (actual 0.17.0), `ephemeral-vrf-sdk` 0.3.0 (**yanked**), Anchor 1.0.2, and
> `magicblock-magic-program-api` 0.10.1 (actual 0.14.10); it declares crank args as `u64`
> (actual `i64`); its entire hand-rolled bincode + sha2 crank recipe is superseded by
> `ScheduleCrankCpi`; its callback pattern uses the deprecated global `VRF_PROGRAM_IDENTITY`;
> and its `WS_ROUTER_ENDPOINT=wss://…` value throws *"Endpoint URL must start with http: or
> https:"* when fed to the SDK Resolver. The local `pinocchio-development` skill documents
> pinocchio 0.10 and will not compile against 0.11.x. `[er-cranks.md]` `[er-vrf.md]`
> `[er-connections.md]` `[pinocchio-core.md]`

---

## 10. Build order

Revised from spec §10. Steps 0–2 change because BOLT is gone; steps 3–7 gain measurement
gates.

| # | Step | Done when |
|---|---|---|
| **0a** | `anchor init heartrot`, `Arena` + `Player` zero-copy accounts, `init_arena` + `init_seat`, deploy to devnet | `anchor test` allocates an arena and 20 seats |
| **0b** | `shoot` hitscan against hardcoded hitboxes, base layer only | a part loses HP on-chain |
| **1** | `svg_slice.py` → sliced boss rig + hitbox JSON; static map; one animated knight | it moves and reads as the refs, and the hitbox JSON matches `Boss.parts` indices |
| **2** | Delegation, session keypair, `move` + `shoot` on the ER, **client prediction** | move-to-confirm feels instant at a measured 136–196 ms RTT. **Measure real write-to-notify latency here** — the single most important number for tuning prediction, and it needs our own writable account, so it cannot happen earlier `[realtime-sync.md]` |
| **3** | Crank `boss_tick` + bullet pool | the boss fights back, and the crank log shows `consumed X of 400000 compute units` with X well under budget |
| **4** | Privy + `/session/init` + 2-card onboarding | a non-crypto friend can play. **Much smaller than the spec's step 4 — the funding tiers are gone** |
| **5** | Lobby, gate, character select, `/match/start` | it is a game |
| **6** | Vent, core, respawn, `/match/settle`, leaderboard, incarnation scaling, **the two-threshold watchdog** | it is a loop, and killing the crank recovers |
| **7** | Final art, tileset, boss parts, knight skins, UI | polish |

Spec §10's note that step 4 is where projects of this shape die still holds, but step 4 is
now roughly half its former size.

---

## 11. Open questions, ranked

Ordered by what they block. Each is testable.

| # | Question | Blocks | How to settle |
|---|---|---|---|
| 1 | Real write-to-notify latency on our own account | prediction tuning, step 2's "feels instant" gate | Build step 2. Write, timestamp, wait for the notification. `[realtime-sync.md]` |
| 2 | Actual `boss_tick` CU against the 400,000 ceiling | tick design, whether bitboarding is needed | Build step 3. Read `consumed X of Y` from the crank tx logs. `[er-cranks.md]` |
| 3 | Can an undelegated treasury be the intent-bundle payer for `commit_and_undelegate`? | `/match/settle` shape | Build step 6. Fallback: delegated settlement PDA + `lamportsDelegatedTransferIx`. `[er-magic-actions.md]` |
| 4 | Does `commit_frequency_ms = 0` mean "never" or "as often as possible"? | delegation config; a wrong answer hits the `0xA0000000` cliff | Delegate two accounts with `0` and `u32::MAX`, idle 60 s, count commits on each delegation record. We pass `u32::MAX` explicitly, so this is defence not dependency. `[bolt-delegation.md]` |
| 5 | Does a deployed Worker get the same 403 from `api.devnet.solana.com` as `wrangler dev`? | whether a paid RPC is mandatory or merely wise | One `wrangler deploy` of a two-line worker. We budget for a paid RPC regardless. `[workers-ts-solana.md]` |
| 6 | Rendering on hardware GL and a mid-range phone | the bullet `will-change` decision, which could invert on constrained GPU memory | Re-run the §6.1 measurements on target hardware. `[svg-rendering.md]` |
| 7 | Fractional-devicePixelRatio pixel alternation at dpr 1.25/1.5 | sprite crispness | Screenshot diff. The claim is spec-derived arithmetic; the confirmation run crashed. **UNVERIFIED.** `[svg-rendering.md]` |
| 8 | Firefox/WebKit SVG compositing rules | cross-browser rig performance | Not examined at all. `EffectiveZoom` and the independent-transform-property restriction are Chromium implementation details, not spec. **UNVERIFIED.** `[svg-rendering.md]` |
| 9 | Per-IP / per-key rate limits on the devnet router | whether 20 concurrent players polling is safe; the router is a single point of failure for a whole match | Nothing documented, probe volume was low. Load-test at 20 clients before a public demo. `[er-connections.md]` |
| 10 | Does the ER cap delegated accounts per transaction? | the 21-account settle transaction | Undocumented. Nearest real ceilings are `MAX_TX_ACCOUNT_LOCKS` (64) and a 38-entry pubkey table; 23 accounts is under both. Low risk. `[er-cranks.md, VERIFICATION]` |
| 11 | Delegated-account owner inside the ER vs base layer | any hand-rolled owner assertion | Do not hand-roll one; Anchor's seeds+bump constraint covers us. **UNVERIFIED.** `[bolt-pinocchio-cpi.md]` |
| 12 | Does Codama generate cleanly from an Anchor 1.x IDL? | keeping Anchor out of the Worker | Try it at step 5. Fallback: `BorshCoder` directly, or hand-write four instruction encoders. `[workers-ts-solana.md]` |

Still open from spec §12 and unchanged: number of knight skins, arena tile dimensions,
whether the incarnation counter is global or per-lobby, and the VRF affix table (now
deferred to v1.1 along with VRF itself, §2.7).

---

## 12. Spec amendments required

Changes to `00-game-design-spec.md` that this document makes. Each needs a one-line edit.

| Spec § | Current | Amend to | Source |
|---|---|---|---|
| §5 | "On-chain: MagicBlock BOLT" and the World/Entity/Component tree | one Anchor program, `Arena` + 20 seat-indexed `Player` accounts | §0.1 |
| §5 | `Position { x, y, zone, facing }` | add `last_move_seq: u16` | §6.3 |
| §5 | "A Magic Action chains the base-layer commit and leaderboard write" | ER commit + separate idempotent base-layer leaderboard write | §5.3 |
| §5 | "iterations covering a full match length" implies length is the risk | length is trivial; **execution failure** is the risk. Add the two-threshold watchdog | §4.2 |
| §6 | "each body part is an `<image>` holding a small pixel-art raster" | pure-SVG `<g>` path rig. The performance objection is refuted; **the art-fidelity objection is still open and is the user's call** | §6.1 |
| §7 | three cards, card 2 = "fund the session wallet" | two cards; nothing to fund | §7.1 |
| §7 | "secret held in `localStorage`" | non-extractable WebCrypto Ed25519 in IndexedDB | §7.2 |
| §7 | "Privy embedded wallet **OR** wallet-connect" as two paths | one code path — Privy exposes external wallets through the same Wallet Standard hook | §7.2 |
| §8 | entire funding-tier section, "~0.005 SOL per player" | deleted. ER fees are 0 and there is no fee-payer validation | §7.1 |
| §9 | `GET /faucet/status` = player funding tier signal | treasury health gauge | §5.3 |
| §9 | "10 ms ER latency" | 50 ms block time; 136–196 ms real move-to-confirm from India. Conclusion unchanged, number wrong | §6.3 |
| §9 | "Next.js deployed to Cloudflare Workers via vinext" | Vite + React SPA on Workers static assets + one Worker, `run_worker_first: ["/api/*"]` | §0.3 |
| §11 | "`pinocchio-ephemeral-rollups` does not exist"; `AccountInfo` incompatibility | factually wrong — `ephemeral-rollups-pinocchio 0.17.0` exists. The Pinocchio rejection **stands** on CU and ownership grounds instead | §0.2 |
| §5 | authority model presented as one layer among several | it is the **entire** perimeter. Add a per-tick `Move` rate limit — zero ER fees means zero economic backstop | §2.4 |
