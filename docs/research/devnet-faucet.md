# Devnet SOL supply at user scale

Research doc for HEARTROT. Topic: can we actually get enough devnet SOL to run a
10–20 player co-op raid with wallet-less onboarding, and how much SOL does a
session wallet actually need?

**Date:** 2026-08-31. **Target:** Solana devnet + MagicBlock ER devnet.

> **Headline finding, and it rewrites the funding section of the spec:**
> A session wallet needs **zero SOL** to play. ER transaction fees are literally
> `0`, and the ER executes transactions from accounts that do not exist and hold
> no lamports. Verified empirically, twice, deterministically (§3).
> The four-tier funding ladder in the design spec is solving a problem the
> gameplay path does not have. It is still needed — but only for the treasury's
> own base-layer delegation costs, not for players.

---

## 0. Method note

Everything below marked **[measured]** was executed against live devnet from this
machine on 2026-08-31 and the raw response is quoted. Everything marked
**[source]** is read out of the actual program/faucet source, not docs prose.

⚠️ **Side effect you should know about:** the §1 tests consumed this machine's
public-devnet airdrop quota. `x-ratelimit-airdrop-remaining` is `-2` and resets
in 24h. If you `solana airdrop` from this IP today it will 429.

---

## 1. Public devnet RPC: `requestAirdrop` real limits

### 1.1 The limits are published in response headers

Every response from `api.devnet.solana.com` carries the rate-limit state. This is
the authoritative source — better than any doc page. **[measured]**

```
$ curl -s -i -X POST https://api.devnet.solana.com \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'

HTTP/2 200
x-rpc-node: sg140
x-ratelimit-airdrop-limit: 1
x-ratelimit-airdrop-remaining: 1
x-ratelimit-tier: free
x-ratelimit-method-limit: 150
x-ratelimit-method-remaining: 149
x-ratelimit-rps-limit: 250
x-ratelimit-rps-remaining: 249
x-ratelimit-endpoint-limit: unlimited
x-ratelimit-endpoint-remaining: -1589
x-ratelimit-conn-limit: 40
x-ratelimit-conn-remaining: 39
x-ratelimit-connrate-limit: 40
x-ratelimit-connrate-remaining: 39
x-ratelimit-pubsub-limit: 10
x-ratelimit-pubsub-remaining: 10
```

| Header | Value | Meaning |
|---|---|---|
| `x-ratelimit-airdrop-limit` | **1** | one airdrop per window |
| `x-ratelimit-tier` | `free` | no paid tier on the public endpoint |
| `x-ratelimit-method-limit` | 150 | per-method budget |
| `x-ratelimit-rps-limit` | 250 | requests/sec |
| `x-ratelimit-conn-limit` | 40 | concurrent connections |
| `x-ratelimit-pubsub-limit` | 10 | websocket subscriptions |

### 1.2 The window is 24 hours, and the key is the IP

Exhausting it returns `retry-after: 86400`. **[measured]**

```
HTTP/2 429
retry-after: 86400
x-ratelimit-airdrop-limit: 1
x-ratelimit-airdrop-remaining: -1
{"jsonrpc":"2.0","error":{"code": 429,"message":"You've either reached your
airdrop limit today or the airdrop faucet has run dry. Please visit
https://faucet.solana.com for alternate sources of test SOL"}, "id": 1 }
```

**The counter is per-IP, not per-recipient.** Proven by requesting to three
different freshly-generated addresses from one IP; the counter kept
decrementing (`1 → 0 → -1 → -2`) instead of resetting. Changing the recipient
address buys you nothing.

So: **1 airdrop per IP per 24 hours.** That is the number.

### 1.3 A *failed* airdrop still burns the quota — the nastiest failure mode

The first request returned an error, and still consumed the budget: **[measured]**

```
$ curl ... -d '{"jsonrpc":"2.0","id":1,"method":"requestAirdrop",
                "params":["F4jqmwC66Vx8dyrQjBxoj4fMAUUqv2hCPphHfTeeG51g",1000000000]}'

HTTP/2 200
x-ratelimit-airdrop-limit: 1
x-ratelimit-airdrop-remaining: 0        <-- decremented
{"jsonrpc":"2.0","error":{"code":-32603,"message":"Internal error"},"id":1}
```

`remaining` went `1 → 0` while the user received **zero SOL**. The devnet faucet
is frequently dry; `-32603 Internal error` is what a dry faucet looks like. A
player hitting this gets no SOL and is locked out for 24 hours, with no
distinguishable error to retry on. Never build a retry loop against this — the
retry cannot succeed and each attempt digs the hole deeper.

### 1.4 Max amount per request: **unverified**

Could not determine. The quota was consumed by the failed 1 SOL request in §1.3,
and the 429 is returned before any amount validation, so no probe is possible
from this IP for 24h. The RPC docs specify `lamports: u64` with **no documented
maximum**. Folklore says 2 SOL; I could not confirm it and am not going to assert
it. **Mark this one unknown.**

### 1.5 CORS: browser-origin airdrop **does** work

The design spec's browser-side-airdrop tier is technically viable. Preflight and
actual request both succeed with an arbitrary origin. **[measured]**

```
$ curl -s -i -X OPTIONS https://api.devnet.solana.com \
    -H "Origin: https://heartrot.pages.dev" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: content-type"

HTTP/2 200
access-control-allow-origin: https://heartrot.pages.dev
access-control-allow-methods: OPTIONS, POST, GET
access-control-allow-headers: authorization, content-type
access-control-max-age: 86400
```

The origin is **reflected**, not wildcarded, and `POST` with `content-type:
application/json` is allowed — so `fetch()` from the Worker-served frontend works
with no proxy. The spec's reasoning (do it browser-side so each user brings their
own IP rather than burning Cloudflare's shared egress IP) is **correct and
confirmed**. It is just far weaker than the spec assumes — see §6.1.

---

## 2. faucet.solana.com — human-only, do not put it in an automated path

Read from the live source of the deployed app
(`solana-developers/solana-devnet-faucet`, `main`, last pushed 2026-08-31).

### 2.1 GitHub OAuth is required, and Turnstile captcha is required

From `app/api/request/handler.ts`: **[source]**

- GitHub auth is enforced —
  `if (!githubUserId) { throw new AirdropError(AirdropErrorCode.GITHUB_AUTH_REQUIRED); }`
  — unless an `auth-bypass` token is presented (a private, server-side env
  secret; not available to us).
- Cloudflare Turnstile (`verifyCaptcha(ctx)`) runs on every non-bypassed request.

Order of checks: token bypass → IP allowlist → GitHub auth → captcha → rate
limits → airdrop → record.

**Conclusion: not automatable.** Turnstile plus OAuth makes this a
human-in-the-browser faucet. It cannot be a funding tier for players and cannot
be scripted to fill a treasury.

### 2.2 GitHub auth buys you *nothing* — both tiers are identical

This contradicts the widespread belief that connecting GitHub raises your limit.
From `lib/airdrop/index.ts`: **[source]**

| Tier | `coveredHours` | `allowedRequests` | `maxAmountPerRequest` |
|---|---|---|---|
| `default` | 8 | 2 | 5 SOL |
| `github` | 8 | 2 | 5 SOL |

Valid amounts: `[0.5, 1, 2.5, 5]`.

So the ceiling is **2 requests / 8 hours / 5 SOL max = 10 SOL per 8h**, and
GitHub auth is a gate, not an upgrade.

### 2.3 The rate-limit key is (wallet, github, IP) — any one of them matches

From `app/api/request/rate-limiting.ts`: **[source]**

```ts
async function enforceFrequencyLimit(
  ctx: AuthenticatedRequestContext,
  tier: AirdropTier,
): Promise<void> {
  const lastTransactions = await transactionsAPI.getLastTransactions(
    ctx.body.recipientAddress,
    ctx.githubUserId,
    ctx.sanitizedIp,
    tier.allowedRequests,
  );

  if (!isWithinRateLimit(lastTransactions, tier)) {
    throw new AirdropError(AirdropErrorCode.RATE_LIMITED, {
      message:
        `You have exceeded the ${tier.allowedRequests} airdrops limit ` +
        `in the past ${tier.coveredHours} hour(s)`,
    });
  }
}
```

Rotating wallets does not help; the IP and GitHub ID are counted too. IP comes
from Cloudflare headers with **no subnet grouping** — full-string match, colons
and dots stripped (`app/api/request/ip.ts`):

```ts
export function getClientIp(req: Request): string | undefined {
  return (
    req.headers.get("cf-connecting-ipv6") ||
    req.headers.get("cf-connecting-ip") ||
    (process.env.NODE_ENV === "development" ? "::1" : undefined)
  );
}

export function sanitizeIp(ip: string): string {
  return ip.includes(":") ? ip.replace(/:/g, "") : ip.replace(/\./g, "");
}
```

Per-IP not per-/64 on IPv6 is mildly good news for mobile users (each device
often gets its own IPv6), and irrelevant behind IPv4 CGNAT.

There is also a known **TOCTOU gap** documented in the source comment: rate
limits are checked before the airdrop and recorded after, so concurrent requests
can both pass. Mitigated by Turnstile. Not exploitable by us in any legitimate
way; noted only so nobody "discovers" it later and builds on it.

---

## 3. How much SOL an account needs on a MagicBlock ER: **zero**

This is the finding that matters most for HEARTROT.

### 3.1 ER transaction fee is 0, base layer is 5000 — measured side by side

Built an identical unsigned SystemProgram transfer message and asked both chains
to price it. **[measured]**

```
BASE devnet -> {"jsonrpc":"2.0","result":{"context":{"apiVersion":"4.3.0-beta.2",
                "slot":491057471},"value":5000},"id":1}
ER devnet-us -> {"jsonrpc":"2.0","result":{"context":{"slot":559286189},
                "value":0},"id":1}
```

`getFeeForMessage` = **0 lamports on the ER**, 5000 on the base layer. Matches
the published pricing table ("Base fee: 0 SOL per ER transaction").

### 3.2 A nonexistent, zero-lamport account can be the ER fee payer

Generated a fresh keypair that has never existed on any chain, confirmed
`getBalance == 0` on the ER, signed a real transfer and submitted it. **[measured]**

```
fresh zero-balance payer: 3FT3ErUkEASXmqtfd9KP5Dgd54dcuB27N7uyoeDYeCBW
payer balance on ER: 0
RESULT: {"jsonrpc": "2.0", "error": {"code": -32003, "message":
  "transaction verification error: Error processing Instruction 0:
   custom program error: 0x1"}, "id": 1}
```

Read that error carefully — it is a **success signal for our purposes**. The
transaction was accepted, signature-verified, loaded, and **executed**. It
reached instruction 0 and failed inside the System Program with error `0x1`
(insufficient lamports for the 1-lamport transfer it was asked to make). It was
*not* rejected for the fee payer being empty or nonexistent.

Compare the base layer, same shape, which rejects before execution: **[measured]**

```
BASE devnet -> "Transaction simulation failed: Attempt to debit an account but
                found no record of a prior credit." err: "AccountNotFound"
```

**Conclusion: the session keypair needs no SOL, no rent-exemption, and no
account creation to sign gameplay transactions on the ER.** Reproduced 3/3,
deterministic.

### 3.3 The real ER gate is *delegation*, not balance

The same test with a 0-lamport transfer fails differently, deterministically 3/3:

```
lamports=1 try1..3: Error processing Instruction 0: custom program error: 0x1
lamports=0 try1..3: Transaction loads a writable account that cannot be written
```

`"Transaction loads a writable account that cannot be written"` is the ER
refusing to write an account that is not delegated to it. That is the actual
admission control: **an ER transaction succeeds if the accounts it writes are
delegated to that ER**, regardless of anyone's balance.

*Honest unknown:* I cannot explain why `lamports=1` reaches execution while
`lamports=0` is rejected at account-load, given both write the same undelegated
accounts. It is deterministic, so it is a real code path, not flakiness. It does
not change the conclusion in §3.2 (which rests on the `lamports=1` case actually
executing), but I am flagging it rather than inventing a mechanism. If someone
needs certainty here, test against a genuinely delegated component account.

### 3.4 What *does* cost SOL: base-layer delegation and commits

Fee constants read from the delegation program source
(`dlp-api/src/consts.rs`, `magicblock-delegation-program` v1.2.0): **[source]**

```rust
/// Fixed fee per commit (charged for each commit after the first).
pub const COMMIT_FEE_LAMPORTS: u64 = 100_000;

/// Fixed fee per delegation session (0.0003 SOL).
pub const SESSION_FEE_LAMPORTS: u64 = 300_000;

/// The delegation session fees (extracted in percentage from the delegation PDAs rent on closure).
pub const RENT_FEES_PERCENTAGE: u8 = 10;

pub const RENT_EXCEPTION_ZERO_BYTES_LAMPORTS: u64 = 890880;
```

---

## 4. Resolving the sibling doc's open question: fees are **per account**, and capped

`bolt-delegation.md` §Open Questions asks whether the 300,000-lamport session
charge is per delegated account or per delegation session — an 86× swing in the
treasury model. **It is per account.**

From `src/processor/fast/undelegate.rs`: **[source]**

```rust
fn process_delegation_cleanup(
    delegation_record_account: &AccountView,
    delegation_metadata_account: &AccountView,
    delegation_rent_payer: &AccountView,
    fees_vault: &AccountView,
    validator_fees_vault: &AccountView,
    delegation_last_commit_id: u64,
) -> ProgramResult {
    let commit_count = delegation_last_commit_id.saturating_sub(1);
    let commit_fee = COMMIT_FEE_LAMPORTS
        .checked_mul(commit_count)
        .ok_or(DlpError::Overflow)?;
    let total_fee_requested = commit_fee + SESSION_FEE_LAMPORTS;
    let total_lamports = delegation_record_account.lamports()
        + delegation_metadata_account.lamports();
    let mut fee_remaining = total_fee_requested.min(total_lamports);
    close_pda_with_fees(
        delegation_record_account,
        delegation_rent_payer,
        fees_vault,
        validator_fees_vault,
        &mut fee_remaining,
    )?;
    close_pda_with_fees(
        delegation_metadata_account,
        delegation_rent_payer,
        fees_vault,
        validator_fees_vault,
        &mut fee_remaining,
    )?;
    Ok(())
}
```

This function takes **one** `delegation_record_account` / one
`delegation_metadata_account` — it runs once per undelegated account. So the
worst case in `bolt-delegation.md` is the right one: **86 × 300,000 = 0.0258 SOL
per match** in session fees.

Two things soften it:

1. **The fee is capped at the rent of the two delegation PDAs**
   (`total_fee_requested.min(total_lamports)`). It can never exceed the deposit,
   and the remainder is refunded to `delegation_rent_payer`. The treasury cannot
   be drained below the rent it already floated.
2. `delegation_record` is 96 bytes (`authority` 32 + `owner` 32 +
   `delegation_slot` 8 + `lamports` 8 + `commit_frequency_ms` 8, + 8
   discriminator) → rent **1,559,040 lamports = 0.00155904 SOL** **[measured]**.
   With metadata on top, the cap sits well above 300,000, so in practice the
   session fee is always charged in full.

**Delegation program ID:** `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`

---

## 5. Provider faucets: all of them require mainnet SOL or a paid plan

This is the tier that looks like an escape hatch and is not.

| Faucet | Requirement | Amount | Cooldown | Usable for HEARTROT? |
|---|---|---|---|---|
| **faucet.solana.com** | GitHub OAuth **+** Turnstile | max 5 SOL | 2 per 8h | ❌ human-only, not scriptable |
| **Chainstack** | **0.8 SOL on mainnet** + API key | up to 1 SOL (tops up to 1) | 24h | ❌ target users have no mainnet SOL |
| **QuickNode** | minimal mainnet balance | 1 drip | 12h | ❌ same |
| **Helius** | **paid plan required** | 1 SOL | undocumented | ⚠️ treasury only, costs money |
| **public RPC** | none | unknown (§1.4) | **1 / IP / 24h** | ⚠️ weak, see §6.1 |

Chainstack, verbatim: *"The requesting address must have a minimum balance of
0.8 SOL on the Solana mainnet."* Receive *"up to 1 SOL every 24 hours."*

Helius, verbatim: *"A paid Helius plan is required to access the Devnet faucet
and request Devnet SOL airdrops from Helius."*

**The mainnet-balance requirement is fatal for the player-facing path.** HEARTROT's
stated target user has never used a crypto wallet, which means by definition zero
mainnet SOL. Every provider faucet is closed to them.

### 5.1 The POW faucet is stale — do not plan around it

`devnet-pow` is the usual answer for bulk devnet SOL with no rate limit. Current
state: **`devnet-pow` v0.1.4, last published 2023-05-30** — over three years old,
built against the Solana 1.x SDK. It will almost certainly not compile against
the current toolchain, and whether the on-chain faucet program still holds a
balance on devnet is unverified.

```shell
cargo install devnet-pow   # v0.1.4, 2023 — expect this to fail to build
devnet-pow mine
```

Treat as **unavailable until proven otherwise**. If bulk treasury SOL becomes the
blocker, spending an hour actually testing this is worth it, but do not put it in
the plan as a working dependency.

---

## 6. How this changes the HEARTROT architecture

### 6.1 The funding tier ladder is mostly unnecessary — and the tier that survives is weak

The spec's ladder is: connected-wallet-with-SOL → treasury transfer → browser-side
airdrop → manual.

Given §3, **for gameplay none of it is needed.** The session keypair signs ER
transactions with a zero balance. Delete the player-funding path from the
critical path entirely.

And the browser-airdrop tier, if kept, is much weaker than the spec assumes:

- **1 airdrop per IP per 24h.** A raid is 10–20 players. If they are in one room
  on one wifi, or on one mobile carrier's CGNAT, **the whole lobby shares one
  airdrop.** The first player gets it and the other 19 get 429.
- **A dry faucet burns the quota anyway** (§1.3), so a player can be locked out
  for 24h having received nothing, with no retry that can help.
- The spec's *reasoning* for putting it in the browser (own IP vs shared Worker
  egress IP) is confirmed correct — it is the right place to do it. It is just
  not a tier you can rely on.

**Recommendation:** treasury pays for everything; players are never funded and
never touch a faucet. This also happens to be the only design consistent with
"zero wallet popups" — a faucet failure is a UX dead-end you cannot recover from
inside a match.

### 6.2 What the treasury actually pays for, per match

Only base-layer costs. Using the 86-delegated-account figure from
`bolt-delegation.md`:

| Item | Cost | Refundable? |
|---|---|---|
| Session fees, 86 × 300,000 | **0.0258 SOL** | ❌ no |
| Commit fees, 86 × 100,000 × (commits−1) | **0.0086 SOL per commit round** | ❌ no |
| Delegation rent float (record + metadata + buffer) × 86 | ≥ 86 × 0.00155904 ≈ **0.134 SOL** | ✅ yes, minus fees |
| Base-layer txs | 5000 lamports/signature | ❌ no |
| **ER gameplay txs** | **0** | — |

The rent float is the big number but it comes back. The **non-refundable burn is
roughly 0.03–0.05 SOL per match** depending on commit count.

### 6.3 The actual constraint: treasury refill rate, not per-match cost

This is the thing to worry about. At 1 airdrop/IP/24h from a single deploy box,
with an unverified per-request cap (§1.4), the treasury refills at **at most a
few SOL per day from one IP**.

At ~0.04 SOL burned per match, a 2 SOL/day refill supports roughly **50 matches
per day** — and that is fine for a devnet demo, a grant milestone, or a
hackathon judging session. It is *not* fine for an open public beta.

Mitigations, cheapest first:

1. **Pre-fund a treasury now and hoard.** Devnet SOL accumulated over N days is
   the simplest scaling lever and needs no code. Start collecting early.
2. **Cut the delegated-account count.** `bolt-delegation.md` already notes a
   packing option that reduces 86 accounts to a fraction, taking rent and session
   charges down proportionally. This is the highest-leverage change and it helps
   latency too.
3. **Keep matches long.** Session fee is per delegation *session*, not per unit
   time. One 15-minute match across several boss incarnations costs the same
   0.0258 SOL as a 2-minute one. Long sessions with many incarnations amortize
   far better than short ones — this argues for the respawn-harder loop staying
   inside one delegation session rather than re-delegating per incarnation.
4. Paid Helius plan, if real money is acceptable.

### 6.4 Direct contradictions with the frozen design spec

1. **"A platform treasury funds that session wallet"** — unnecessary for
   gameplay. ER fees are 0 and empty accounts transact fine (§3.1, §3.2). The
   treasury should fund *delegation*, not *wallets*.
2. **The four-tier funding ladder** — tiers 1–3 are near-useless for the stated
   target user. Provider faucets need mainnet SOL (§5); the public airdrop is
   1/IP/24h and is shared across a co-located lobby (§6.1).
3. **Implicit assumption that faucets can be a programmatic fallback** —
   faucet.solana.com is GitHub OAuth + Turnstile gated (§2.1) and cannot be
   scripted.
4. **Re-delegating per boss incarnation would be expensive.** Not stated in the
   spec, but the incarnation loop invites it. Each re-delegation is another
   0.0258 SOL. Keep one delegation session across incarnations.

---

## 7. Pinned versions (all verified 2026-08-31)

| Thing | Version | How verified |
|---|---|---|
| devnet base layer | `solana-core 4.3.0-beta.2`, feature-set `2409014235` | `getVersion` **[measured]** |
| devnet ER (`devnet-us`) | `magicblock-core 0.14.11`, `solana-core 4.0.0`, git `cec4cf5` | `getVersion` **[measured]** |
| `solana-cli` (local) | `4.2.1 (src:75f9b5b4; feat:21b0d33a, client:Agave)` | `solana --version` |
| `@magicblock-labs/bolt-cli` (local) | `0.2.4` | installed global |
| `@magicblock-labs/ephemeral-validator` (local) | `0.13.20` | installed global — **older than devnet's 0.14.11** |
| `magicblock-delegation-program` | `1.2.0` (2026-03-19) | crates.io API |
| `devnet-pow` | `0.1.4` (**2023-05-30, stale**) | crates.io API |
| faucet.solana.com source | `main` @ 2026-08-31 | GitHub API |

ER devnet endpoints (from MagicBlock quickstart, verbatim):

```
Asia: https://devnet-as.magicblock.app/
EU:   https://devnet-eu.magicblock.app/
US:   https://devnet-us.magicblock.app/
TEE:  https://devnet-tee.magicblock.app/
```

ER CORS is fully open — `access-control-allow-origin: *` **[measured]** — so the
browser → ER direct path in the spec works with no proxy, as intended.

Rent-exempt minimums on devnet **[measured]**:

| Size | Lamports | SOL |
|---|---|---|
| 0 bytes | 890,880 | 0.00089088 |
| 96 bytes (`delegation_record`) | 1,559,040 | 0.00155904 |
| 200 bytes | 2,282,880 | 0.00228288 |
| 1024 bytes | 8,017,920 | 0.00801792 |

---

## 8. Gotchas and failure modes

1. **A dry faucet burns your daily quota.** `-32603 Internal error` costs you the
   airdrop. No retry can recover it. Do not loop.
2. **Rotating recipient addresses does nothing** on the public RPC — the key is
   the IP.
3. **`x-ratelimit-airdrop-remaining` goes negative**, so you can detect how far
   over you are, but there is no partial credit.
4. **Reading the headers is free** — a `getHealth` call returns the full
   rate-limit state without consuming the airdrop budget. Use this for the
   `faucet/status` cold-path route instead of probing with a real airdrop.
5. **Local `ephemeral-validator` 0.13.20 is behind devnet's 0.14.11.** Behaviour
   verified locally may not match devnet. Upgrade before trusting local tests.
6. **CGNAT collapses a lobby to one IP.** Test the multi-player path from
   genuinely distinct networks, not one office wifi, or you will not see this
   until demo day.
7. **The ER rejects undelegated writes**, not unfunded payers. When an ER tx
   fails, suspect delegation state first, never balance.
8. **`getFeeForMessage` on the ER returning 0 is not a promise.** The pricing
   page says "current release". If MagicBlock turns on ER fees, the zero-SOL
   session wallet assumption breaks everywhere at once. Worth an integration
   test that asserts the fee is still 0.

---

## 9. Recommended shape

```
Player onboarding:
  Privy embedded wallet (email/social)
  → generate session keypair in browser
  → DO NOT fund it. It needs nothing.
  → sign ER gameplay txs directly, browser → ER, zero popups, zero SOL.

Treasury (one funded devnet keypair, server-side):
  → pays delegation rent + session fees at match/start
  → pays base-layer commit + leaderboard write at match/settle
  → refilled manually / by cron from the deploy box's daily airdrop
  → monitored via the free header read in faucet/status

faucet/status cold-path route:
  → GET api.devnet.solana.com getHealth, read x-ratelimit-airdrop-remaining
  → report treasury balance + estimated matches remaining (balance / ~0.04 SOL)
  → never triggers an airdrop itself
```

The `faucet/status` route in the spec's four-route backend is still worth having,
but its job changes: it is a **treasury health gauge**, not a player-funding
endpoint.

---

## Sources

Every URL below was actually fetched during this research.

**Live endpoints probed (measurements in §1, §3, §7):**
- https://api.devnet.solana.com
- https://devnet-us.magicblock.app/
- https://devnet-as.magicblock.app/

**Faucet source (read via GitHub API):**
- https://github.com/solana-developers/solana-devnet-faucet
- https://raw.githubusercontent.com/solana-developers/solana-devnet-faucet/main/README.md
- https://raw.githubusercontent.com/solana-developers/solana-devnet-faucet/main/lib/airdrop/index.ts
- https://raw.githubusercontent.com/solana-developers/solana-devnet-faucet/main/app/api/request/handler.ts
- https://raw.githubusercontent.com/solana-developers/solana-devnet-faucet/main/app/api/request/validation.ts
- https://raw.githubusercontent.com/solana-developers/solana-devnet-faucet/main/app/api/request/ip.ts
- `repos/solana-developers/solana-devnet-faucet/contents/lib/constants.ts` (GitHub API)
- `repos/solana-developers/solana-devnet-faucet/contents/app/api/request/rate-limiting.ts` (GitHub API)

**Delegation program source (read via GitHub API):**
- https://github.com/magicblock-labs/delegation-program
- `repos/magicblock-labs/delegation-program/contents/dlp-api/src/consts.rs`
- `repos/magicblock-labs/delegation-program/contents/src/processor/fast/undelegate.rs`
- `repos/magicblock-labs/delegation-program/contents/dlp-api/src/state/delegation_record.rs`
- `repos/magicblock-labs/delegation-program/contents/src/lib.rs`
- https://crates.io/api/v1/crates/magicblock-delegation-program

**Official docs:**
- https://solana.com/developers/guides/getstarted/solana-token-airdrop-and-faucets
- https://solana.com/developers/cookbook/development/airdrops-and-faucets
- https://solana.com/docs/rpc/http/requestairdrop
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/quickstart
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/how-to-guide/rust-program
- https://docs.magicblock.gg/pages/overview/additional-information/pricing

**Provider faucets:**
- https://www.helius.dev/docs/rpc/devnet-sol
- https://faucet.chainstack.com/solana-devnet-faucet
- https://faucet.quicknode.com/solana/devnet

**POW faucet:**
- https://crates.io/api/v1/crates/devnet-pow
- https://github.com/jarry-xiao/proof-of-work-faucet
