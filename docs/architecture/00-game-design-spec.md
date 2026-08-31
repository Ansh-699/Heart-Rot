# HEARTROT — Design Spec

**Date:** 2026-08-31
**Status:** Approved design, pre-implementation
**Target:** Solana devnet

---

## 1. What it is

A fully on-chain co-op boss raid. 10–20 players enter a dungeon arena together and
fight one boss in real time. Player shots and boss projectiles, movement, health,
and boss state all live on-chain in a MagicBlock Ephemeral Rollup. When the boss
dies it respawns as a new *incarnation* — harder, and mechanically varied via VRF.

The onboarding target is a person who has never used a crypto wallet. After a
three-card tutorial they are in a character-select screen and then in the game.
They never see a wallet popup during play.

### Non-goals for v1

- No token, no NFT, no economy. Devnet only.
- No PvP.
- No classes, skill trees, or loot.
- No mobile layout.
- No spectator mode.

---

## 2. The core mechanic: the boss is a shell, not a health bar

The boss is a fused amalgam of bodies. Its **parts** are its health.

| Part | HP tier | Breaking it removes |
|---|---|---|
| Ram skull crown | high | overhead slam |
| Wolf head (left) | medium | left lunge |
| Beast head (right) | medium | right lunge |
| Thorn clusters ×4 | low each | one ranged volley emitter each |
| Mace arm | medium | melee sweep |
| Claw arms | medium | grab |
| **Void (torso)** | — | **Vent.** Sealed while shell HP is above threshold |
| **Core (human face)** | low | **Kill condition.** Only damageable while the vent is open |

Consequences that fall out of this with no extra systems:

- **Target priority is a real decision.** Thorns first cuts incoming damage; heads
  first cuts melee pressure. There is no single correct order, only tradeoffs.
- **Coordination has a reason to exist.** Focusing one part is strictly better than
  spreading damage, so the raid self-organizes without any grouping feature.
- **The art is the UI.** A destroyed part stops animating and visibly detaches. The
  player reads fight progress off the boss, not off a bar.

`shell_hp = sum(all part HP)`. Vent opens when `shell_hp < 35% of max`. Core is
invulnerable while the vent is sealed.

### Scaling with player count

The requirement is that more players make the fight harder in a way players can
*see*, not a hidden HP multiplier that keeps time-to-kill constant.

```
bullets_per_volley = 3 + alive_players     // 4 at solo, 23 at full raid
volley_interval    = 8 ticks               // constant
```

Difficulty is expressed as **bullet density**. At 20 players the screen fills.
The counterplay is drawn into the sprite: shoot the thorn clusters off and the
volleys stop.

Boss part HP also scales `× (1 + incarnation × 0.15)` so later incarnations take
longer to strip.

---

## 3. Combat model

Asymmetric on purpose, and neither side ever allocates an account.

**Player attacks — hitscan.** No projectile state exists. The system raycasts from
the player along `facing`, finds the first part hitbox intersected, applies damage.
One transaction, zero entities. The visible bullet is client-side animation only.

**Boss attacks — fixed pool.** One `Bullets` component holds a fixed array of 128
`{x: i16, y: i16, dx: i8, dy: i8, active: bool}`. The crank advances all active
bullets each tick and tests collision against player positions. Travel time makes
them dodgeable; a fixed array means no allocation.

Rationale: players want their own fire to feel instant, and incoming fire to be
readable and dodgeable. Hitscan gives the first, travel time gives the second.

**Targeting:** nearest alive player. Free to compute, and it produces aggro/tanking
as an emergent behaviour — stepping close pulls fire off the group.

**Player death:** HP reaches 0 → dead for 3 seconds → respawn at the arena entrance.
Not permadeath: the product goal is that a non-crypto player has fun in their first
four minutes, and watching a timer for three of them fails that.

---

## 4. Zones

```
        LOBBY (bright, outdoor)              ARENA (dark stone)
   ┌──────────────────────────┐          ┌──────────────────────┐
   │   players walk, idle,    │          │       BOSS           │
   │   see each other         │  ═════▶  │                      │
   │      ╔════════╗          │   gate   │   ◆ ◆ ◆  players     │
   │      ║  GATE  ║ ◀── walk │          │   bullets, hitscan   │
   │      ╚════════╝  onto it │          │                      │
   └──────────────────────────┘          └──────────────────────┘
                                   win / wipe → lobby, incarnation + 1
```

One `zone: u8` field on the Position component. Walking onto the gate tile flips it
and teleports the player to an arena spawn point.

**The lobby is the matchmaker.** No queue service, no matchmaking backend. Enough
players standing on the gate starts a match. That is the entire feature.

**Match end:**
- **Win** — core HP reaches 0.
- **Wipe** — all players dead simultaneously, or the 6-minute enrage timer expires.

Either way: commit + undelegate, write the leaderboard, return everyone to the
lobby, increment the global incarnation counter.

---

## 5. On-chain: MagicBlock BOLT

BOLT (Anchor-based ECS) over an Ephemeral Rollup. Pinocchio was evaluated and
rejected — see §11.

```
World
├─ Entity: Arena
│   ├─ ArenaState  { phase, tick, incarnation, alive_count, enrage_at }
│   └─ Bullets     { [128] × {x, y, dx, dy, active} }      ← crank-advanced
├─ Entity: Boss
│   ├─ Position    { x, y }
│   ├─ Parts       { crown, wolf_l, beast_r, thorns[4], mace, claws }
│   ├─ Core        { vent_open, core_hp }
│   └─ BossState   { phase, attack_timer, target_idx }
└─ Entity: Player × 20
    ├─ Position    { x, y, zone, facing }
    ├─ Health      { current, max, respawn_at }
    ├─ PlayerMeta  { session_pubkey, skin_id, damage_dealt }
    └─ Combat      { last_shot_tick }
```

**Systems:** `Move` · `Shoot` (hitscan) · `EnterGate` · `BossTick` (crank) ·
`Damage` · `Respawn` · `Settle`

**Authority model.** The platform holds delegation authority — it performs setup,
delegation, and teardown, and pays all base-layer costs. The player's session
pubkey is stored on `PlayerMeta`, and every player-facing system asserts
`signer == player.session_pubkey`. The backend administers; the player acts.

**Crank.** `BossTick` is scheduled on the ER at a 400 ms interval via
`MagicBlockInstruction::ScheduleTask`, with `iterations` covering a full match
length. It advances bullets, runs boss attack logic, checks vent/core state, and
evaluates win/wipe. The game therefore runs with no server process.

**Settlement.** A Magic Action chains the base-layer commit and leaderboard write
to the ER commit when `BossTick` detects a win. No settlement daemon.

---

## 6. Rendering: 3/4 view, SVG rig, raster parts

**View angle.** Movement is on a floor plane; sprites are drawn front-facing. This
is 3/4 view — the same convention as the knight reference. A true top-down camera
would hide the boss's face, horns, and chest vent, which are the reasons the sprite
works.

**Structure.**

```
Static background layer   →  rendered once, never touched
Entity layer (SVG)        →  ~60 player nodes + ~10 boss parts + ≤128 bullets
                             animated via CSS transform (GPU composited)
```

**Two rules that keep this fast, both learned from failure modes:**

1. **Tiles are not SVG rects.** A 64×64 map is 4,096 nodes that never change.
   Render the map once into a static layer and never re-render it.
2. **Pixel art is not SVG paths.** A 32px arm is ~40 rects after run-merging;
   20 players × 8 parts × 40 = 6,400 animated nodes. It crawls and it does not
   match the reference art anyway.

**Instead:** each body part is an `<image>` holding a small pixel-art raster,
wrapped in a `<g>` that CSS transforms animate. Pixel fidelity from the raster,
independent limb motion from the SVG rig, small DOM.

**Player rig: three parts, not eight.** Body, weapon arm, legs. Run is a leg bob,
shoot is an arm rotation with recoil. ~60 nodes for 20 players, reads at roughly
90% of a full rig. Split out more parts only if three looks stiff.

**Boss rig: one `<g>` per destructible part.** Each group is simultaneously an
animation target and a hit region — the rig and the hitbox list are the same
structure. A destroyed part gets a detach animation and then `hidden`.

**Art direction.**

| Surface | Direction |
|---|---|
| Lobby | warm greens and tans, outdoor, safe |
| Arena | cold purple-grey stone, torch orange, diamond-carved brick |
| Player sprites | chibi knights, heavy armour silhouette, ~32px |
| Boss | pale flesh `#e8c4ce` / `#d9a8b8`, mauve `#a06a80`, maroon `#5a2f45`, olive thorn `#b5b56a` / `#8a8a4a` |
| Ground | slate `#3a4449` |

---

## 7. Onboarding

Three tutorial cards, then character select, then play. No wallet popup for a
Privy user after sign-in.

```
Card 1   Privy embedded wallet (email/social, no seed phrase)
         or "I have a wallet" → wallet-connect
              ↓
Card 2   Fund the session wallet  (see §8)
              ↓
Card 3   Loader — backend creates the player Entity, initializes
         components, delegates them to the ER, pays all rent
              ↓
         Character select → lobby
```

The session wallet is a `Keypair` generated in the browser, secret held in
`localStorage`. It signs every gameplay transaction locally. Privy provides
identity, cross-device persistence, and recovery; the session key provides
popup-free signing.

---

## 8. Funding tiers

Funding is ~0.005 SOL per player, because the backend pays every base-layer cost
and the session wallet only ever pays ER fees. A 20 SOL treasury covers ~4,000
players.

Treasury SOL is therefore abundant; **user patience is the scarce resource**, so
the most reliable path runs first.

```
      ┌─ connected external wallet with devnet SOL?
      │     └─ YES → "Fund your session? 0.02 SOL" — one popup, instant, reliable
      │            (larger than the treasury tier because it costs us nothing
      │             and gives that player more headroom)
user ─┤
      └─ Privy / embedded, or the wallet is empty
            1. treasury transfer         ~1s, no popup            ← default
            2. browser airdrop           if the treasury is dry
            3. ask connected wallet      if one exists
            4. "grab devnet SOL" screen  faucet.solana.com
```

**Tier 2 must be called from the browser, never from the Worker.** A Worker shares
Cloudflare's egress IPs across all users, so devnet's per-IP limit is hit once and
then every user fails permanently. From the browser each user brings their own IP
and their own budget. Public devnet RPC sends permissive CORS, so this works.

**Robustness requirements:**

- Verify funding by polling `getBalance` until it changes, with a deadline. Never
  trust the `requestAirdrop` response — it returns signatures that never confirm.
- Every tier gets a ~4s timeout and none may block the tutorial. If the user
  finishes reading first, admit them to character select and finish funding behind
  the screen.
- The funding amount is a server-side constant. Never accept an amount from the
  client.

---

## 9. Backend

Four cold-path routes. Nothing else needs a server.

| Route | Does |
|---|---|
| `POST /session/init` | verify Privy token → fund session wallet → create + delegate player entity |
| `POST /match/start` | spawn arena, delegate components, schedule the crank |
| `POST /match/settle` | fallback settle path if the Magic Action does not fire |
| `GET /faucet/status` | treasury balance, so the UI knows when to degrade to tier 4 |

Leaderboard reads go from the browser straight to RPC. No route needed.

**What must never touch the backend:**

```
HOT   browser ── session key ──▶ ER          move, shoot, enter_gate
      browser ◀─ accountSubscribe ─ ER        state
COLD  browser ── fetch ─────────▶ Worker      onboard, fund, spawn, settle
```

A single Cloudflare round-trip in the movement path turns 10 ms into 100 ms+ and
discards the entire reason for using an Ephemeral Rollup. The backend signs setup
transactions only. It never signs a game action.

**Stack:** Next.js deployed to Cloudflare Workers via **vinext** (Cloudflare's
current recommended Next.js path; OpenNext is now the migration path). Route
handlers are TypeScript and live in the same app — a separate Rust Worker for four
cold endpoints would add a second deployment, second config, CORS, and split
secrets for no gain.

TypeScript for the backend rather than Rust because these four routes are
transaction signing with no performance requirement, BOLT/Anchor emits a
TypeScript client the frontend and backend share, and Workers has full `node:crypto`
with Ed25519. Rust stays where it is load-bearing: the BOLT program.

**No daemon, no cron, no Durable Objects in v1.** The crank runs the game; Magic
Actions settle it; arena spawn is player-triggered through `/match/start`.
Everything is request-scoped.

**Secrets and limits:**

| Concern | Handling |
|---|---|
| Treasury key | `wrangler secret put`. Never a var, never `NEXT_PUBLIC_` |
| Per-IP abuse | Cloudflare Rate Limiting binding |
| Double-funding | KV key per Privy user id. Eventually consistent; a rare double-fund at 0.005 SOL is acceptable |
| Blast radius | Hard daily outflow cap; below a treasury floor, `/session/init` degrades to tier 4 rather than draining to zero |

---

## 10. Build order

| # | Step | Done when |
|---|---|---|
| 0 | BOLT world + Boss entity + Parts, one hardcoded player | a part loses HP on-chain |
| 1 | SVG rig + static map + one animated knight, placeholder art | it moves and it reads as the refs |
| 2 | Move + hitscan shoot on the ER | it feels instant |
| 3 | Crank `BossTick` + bullet pool | the boss fights back |
| 4 | Session wallet + funding tiers + 3-card onboarding | a non-crypto friend can play |
| 5 | Lobby, gate, character select | it is a game |
| 6 | Vent, core, respawn, incarnation scaling | it is a loop |
| 7 | Final art: tileset, boss parts, knight skins, UI | polish |

Step 4 is where projects of this shape usually die, so it is deliberately early
rather than saved for last.

---

## 11. Decisions and rejected alternatives

**BOLT over Pinocchio.** Pinocchio was chosen while the boss was a cellular
automaton — 4,096 cells of bitboard math per tick, where CU efficiency mattered.
That design was replaced by an HP/parts boss with pooled projectiles, which is
trivial compute, and the justification went with it. BOLT supplies the World /
Entity / Component scaffolding, delegation, and ER wiring, and its ECS shape
matches the design directly. `ephemeral-rollups-sdk` supports native Rust call
sites but uses `solana_program::AccountInfo`, which is incompatible with
Pinocchio's own `AccountInfo`; a Pinocchio integration means hand-rolling the
delegate, commit, undelegate, and `ScheduleTask` CPIs. That is a worthwhile
standalone project (`pinocchio-ephemeral-rollups` does not exist) but it is not a
prerequisite for this one, and making it one puts a week of CPI reverse-engineering
ahead of the first playable frame.

**Hitscan for players, pooled projectiles for the boss.** An entity per bullet
means account creation at bullet-hell rates. Rejected.

**Bullet density over HP multipliers for scaling.** Scaling HP with player count
keeps time-to-kill constant, so "harder" is invisible. Rejected.

**Timed respawn over permadeath.** Permadeath makes the threat land, but leaves a
player who dies at 0:20 watching for the rest of the match, which contradicts the
product goal.

**Raster parts in an SVG rig over pure-SVG pixel art.** Node count; see §6.

**Treasury-first over airdrop-first funding.** Airdrop-first optimises the abundant
resource at the expense of the scarce one, and on failure pays both costs.

---

## 12. Open items

- Number of selectable knight skins (3 assumed, from the reference sheet).
- Arena tile dimensions — 64×64 assumed, to be confirmed once sprite scale is set.
- Whether the incarnation counter is global across all matches or per-lobby.
- VRF variation table for incarnations: which boss attributes are rolled, and the
  curated value ranges for each.
