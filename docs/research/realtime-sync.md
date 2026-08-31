# Real-time state sync from the ER to the browser

**Date:** 2026-08-31
**Topic:** How HEARTROT's browser client subscribes to, decodes, and reconciles on-chain
state living on a MagicBlock Ephemeral Rollup.
**Status:** Research. Every number below is either measured live on 2026-08-31 or read
out of published source. Anything I could not verify is marked explicitly.

> **Measurement geography.** All latency numbers were measured from Ghaziabad, India
> against `devnet-as` (Singapore). Absolute RTTs are therefore *my* network distance, not
> a universal constant. Every *relative* number (router-vs-ER delta, encoding-vs-encoding
> bandwidth, reconnect timing) is location-independent and holds. Where a number is
> geography-bound I say so.

---

## 1. What this is

HEARTROT renders from chain state. There is no server game loop, so the only thing
standing between "the crank moved a bullet" and "the player sees the bullet" is a
WebSocket subscription to an ER validator. This document covers that path end to end:
the subscription API surface, what it actually costs, how to turn account bytes into
game objects, what happens when the socket dies, and why none of it is enough on its own
to make movement feel instant.

Three findings up front, because they change design decisions:

1. **The ER WebSocket API is completely undocumented.** Zero of MagicBlock's 215
   documentation pages mention the word "Subscribe". `accountSubscribe`,
   `programSubscribe`, `logsSubscribe` and `slotSubscribe` all work on ER endpoints — I
   verified each one live — but nothing about them is contractual. Section 3.
2. **The ER emits at most one notification per account per slot**, and its slot time is
   50 ms. That caps per-account bandwidth at ~20 notifications/sec no matter how many
   times the account is written. Section 5.
3. **A dropped socket costs ~1.7 seconds of blind gameplay** with stock `@solana/web3.js`
   settings, and notifications resume only when the account is *next written* — so an
   explicit refetch on reconnect is mandatory, not an optimisation. Section 7.

---

## 2. Exact pinned versions

### npm — verified live against `registry.npmjs.org` on 2026-08-31

| Package | Version | Published | Note |
|---|---|---|---|
| `@magicblock-labs/bolt-sdk` | **0.2.4** | 2025-07-23 | latest. **13 months stale** — see §2.1 |
| `@magicblock-labs/ephemeral-rollups-sdk` | **0.17.0** | 2026-08-26 | latest, actively developed |
| `@solana/web3.js` | **1.98.4** | 2025-07-31 | `latest` tag; `rc` is `3.0.0-rc.2` (2026-06-19) |
| `@solana/kit` | **8.2.0** | 2026-08-29 | the modern successor line |
| `@coral-xyz/anchor` | **0.32.1** | 2025-10-10 | latest |
| `rpc-websockets` | **9.3.9** | — | transitive, drives web3.js reconnect |

### 2.1 The dependency skew you will trip over

`@magicblock-labs/bolt-sdk@0.2.4` declares, verbatim from its published `package.json`:

```json
"dependencies": {
  "@coral-xyz/anchor": "^0.31.1",
  "@metaplex-foundation/beet": "^0.7.1",
  "@metaplex-foundation/beet-solana": "^0.4.0",
  "@magicblock-labs/ephemeral-rollups-sdk": "0.2.1"
}
```

Two problems, both real:

- It pins `ephemeral-rollups-sdk` to **exactly `0.2.1`** (published 2025-01-04). Current is
  **0.17.0**. If HEARTROT also installs `ephemeral-rollups-sdk@0.17.0` directly — and it
  must, for `getBlockhashForAccounts` / `ConnectionMagicRouter` / `Resolver` — npm will
  install **both copies**. `DELEGATION_PROGRAM_ID` is re-exported by bolt-sdk from its own
  0.2.1 copy. Any `PublicKey` identity comparison across the two trees is a coin flip.
  **Import `DELEGATION_PROGRAM_ID` from `ephemeral-rollups-sdk` directly, never from
  `bolt-sdk`**, and pin one version with an npm `overrides` block.
- `^0.31.1` on Anchor resolves to `0.31.x`, **not** the current `0.32.1`. bolt-sdk holds
  the whole project on Anchor 0.31.

I verified the resolved tree locally: installing `@coral-xyz/anchor@0.31.1` alongside
bolt-sdk is what actually works today. Treat Anchor **0.31.1** as HEARTROT's version.

### Live infrastructure — verified via `getRoutes` on 2026-08-31

```
identity                                      fqdn                                    blockTimeMs  country
MEUGGrYPxKk17hCr7wpT6s8dtNokZj5U2L57vjYMS8e   https://devnet-eu.magicblock.app/       50           DEU
MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo   https://devnet-tee.magicblock.app/      50           SGP
MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57   https://devnet-as.magicblock.app/       50           SGP
MUS3hc9TCw4cGC12vHNoYcCGzJG1txjgQLZWVoeNHNd   https://devnet-us.magicblock.app/       50           —
```

**`blockTimeMs: 50` on every ER.** Confirmed empirically: `slotSubscribe` on `devnet-as`
delivered 197 slot notifications in 10 s (19.7/s ≈ 50 ms). This is the real clock the
whole render pipeline hangs off.

---

## 3. The ER WebSocket surface — measured, because it is undocumented

I probed `wss://devnet-as.magicblock.app/` and `wss://devnet-router.magicblock.app/`
directly with raw WebSocket frames.

### 3.1 Which subscriptions exist

| Subscription | ER direct | Router |
|---|---|---|
| `accountSubscribe` | ✅ | ✅ |
| `programSubscribe` | ✅ | ❌ `-32601` |
| `logsSubscribe` | ✅ | ❌ `-32601` |
| `slotSubscribe` | ✅ | ❌ `-32601` |
| `signatureSubscribe` | ✅ | ✅ |

The router carries only what a routing client needs. `programSubscribe` — which §6.2
argues for — **must go direct to an ER endpoint.**

### 3.2 Which `accountSubscribe` config options are honoured

Probed by opening nine subscriptions on one socket and reading back the assigned
subscription ids:

```
plain-base64         OK sub=55453
base64+zstd          OK sub=55454
jsonParsed           OK sub=55455
base58               OK sub=55456
dataSlice            OK sub=55457
commit-processed     OK sub=55453   <-- same id as plain-base64
commit-confirmed     OK sub=55453   <-- same id
commit-finalized     OK sub=55453   <-- same id
no-config            OK sub=55456   <-- same id as base58
```

Two things fall out of the id collisions:

- **Commitment is ignored.** `processed`, `confirmed` and `finalized` collapse onto the
  same subscription as no-commitment-at-all. I re-tested on three *separate* sockets
  against a hot account to rule out per-socket dedup: `processed` → 289 notifications,
  `finalized` → 290, over the identical slot range `563506961..563507249`. There is one
  validator and no consensus, so there is nothing for a commitment level to mean. **Do not
  build any logic that expects `finalized` to lag `processed` on the ER.** Note this is the
  *opposite* of base-layer behaviour, so code that is correct on devnet base is silently
  meaningless on the ER.
- **The default encoding is base58**, not base64 (`no-config` and `base58` share an id).
  base58 is slower to decode and larger. Always pass `encoding: 'base64'` explicitly.

`dataSlice` and `base64+zstd` are both accepted and both genuinely applied (§5.2).

### 3.3 `programSubscribe` filters are real

This one needed care, because a filter that is silently ignored looks identical to a
filter that matches everything. I tested against a program with 59 live 112-byte accounts
on `devnet-as`, using a deliberately impossible value as the control:

```
no filter                notifs= 4893 distinct=39
dataSize 112 (real)      notifs= 4893 distinct=39
dataSize 999999 (imp)    notifs=    0 distinct=0    <-- control: filter IS applied
memcmp real disc         notifs= 4893 distinct=39
memcmp bogus             notifs=    0 distinct=0    <-- control: filter IS applied
```

**ER `programSubscribe` applies `dataSize` and `memcmp` filters correctly.** That makes
"one subscription for all 20 player Position components, filtered by Anchor discriminator"
a real option. Section 6.2 weighs it.

### 3.4 CORS — the browser can talk to the ER directly

The entire architecture depends on this, so I checked rather than assumed:

```
$ curl -i -X OPTIONS https://devnet-as.magicblock.app/ \
    -H 'Origin: https://heartrot.pages.dev' \
    -H 'Access-Control-Request-Method: POST'
HTTP/2 200
access-control-allow-headers: *
access-control-allow-methods: POST, OPTIONS, GET
access-control-allow-origin: *
access-control-max-age: 86400
```

Both the ER and the router send `access-control-allow-origin: *` on preflight and on the
actual POST. **The browser → ER direct path in §9 of the design spec is confirmed viable.**

---

## 4. Measured latency

### 4.1 Router vs ER direct — the router tax is zero

I subscribed to the *same* delegated account on `wss://devnet-as.magicblock.app/` and
`wss://devnet-router.magicblock.app/` from one process, matched notifications by slot
number, and diffed arrival times. 25-second window, 488 matched slots:

| Endpoint | open | first notif | notifications | rate |
|---|---|---|---|---|
| ER direct (`devnet-as`) | 423 ms | 595 ms | 489 | 19.6/s |
| Router | 491 ms | 665 ms | 488 | 19.5/s |

```
matched slots=488  router-minus-ER delta ms: min=-188 p50=-4 p90=0 max=20
```

**The router costs nothing in steady state** — median −4 ms (i.e. noise, occasionally
arriving *first*), p90 exactly 0 ms, worst case 20 ms. First-notification setup costs
~70 ms.

> ⚠ **This contradicts the sibling document.** `docs/research/er-connections.md` §10 reports
> the router costing "~840ms extra on first-notification latency". My measurement puts it at
> ~70 ms, and steady-state throughput identical. Both runs are real; the earlier one likely
> caught subscription setup during a cold route cache. Either way the *conclusion* both
> documents reach is the same and is strengthened, not weakened: **use the router for the
> render subscription.** It follows the account across re-delegation for free.

### 4.2 HTTP round-trip — this is the number that matters for "feels instant"

`getMultipleAccounts` (8 accounts), 6 calls with keep-alive, median of the warm calls:

| Endpoint | warm median | min |
|---|---|---|
| ER `devnet-as` (Singapore) | **196 ms** | 136 ms |
| ER `devnet-us` | 283 ms | 246 ms |
| ER `devnet-eu` (Germany) | 368 ms | 233 ms |
| Router | 303 ms | 288 ms |
| Base devnet | 100 ms | 96 ms |

This is geography-bound — from India to Singapore. A player in Singapore would see tens of
milliseconds. But the structural point is location-independent and important:

**The ER's 50 ms block time is not the latency a player feels.** Perceived
move-to-confirmation latency is `network RTT + up to one block`. From India that is
~150–200 ms. The design spec's framing in §9 — "a single Cloudflare round-trip in the
movement path turns 10 ms into 100 ms+" — is directionally right (don't proxy) but the
"10 ms" is the ER's internal block cadence, not the user's round trip. See §11 for what
this does to build-order step 2.

---

## 5. Bandwidth

### 5.1 Notifications are coalesced per slot

Subscribed to one continuously-written account for 20 s and bucketed notifications by
`context.slot`:

```
notifs=398 distinctSlots=397
notifications-per-slot distribution: {"1":396,"2":1}
slot range 563505608..563506005 span=397 gaps=1
```

396 of 397 slots delivered **exactly one** notification. **Per-account bandwidth is
therefore capped at the slot rate — ~20 notifications/sec — regardless of how many times
per slot the account is written.** This is a genuinely helpful property: a player spamming
move transactions cannot make their own Position component more expensive for the other 19
clients than 20 updates/sec.

### 5.2 Cost per notification, by encoding

Same hot 112-byte account, one socket per encoding, 20 s:

| encoding | notifs | bytes/notif | KB/s |
|---|---|---|---|
| `base64` | 390 | 441 | 8.4 |
| `base64+zstd` | 390 | 370 | 7.0 |
| `base58` | 390 | 442 | 8.4 |
| `jsonParsed` | 390 | 441 | 8.4 |
| `base64` + `dataSlice{0,16}` | 390 | **313** | 6.0 |
| `base64` + `dataSlice{8,32}` | 390 | 333 | 6.3 |

The headline: **the JSON-RPC envelope is ~289 bytes and dominates.** A 112-byte account
costs 441 bytes on the wire; slicing the payload down to 16 bytes only gets you to 313.
`jsonParsed` silently falls back to base64 for non-native programs (identical 441), so it
is a no-op for BOLT components — don't pay for it. `base64+zstd` helps only once payloads
get large; on a 112-byte account it saves 16%.

**Consequence: the number of notifications matters far more than the size of each
component.** Optimising a component from 64 bytes to 32 bytes saves ~43 bytes on a
~330-byte message. Halving how often it is written saves half of everything.

### 5.3 N × `accountSubscribe` vs 1 × `programSubscribe`

The real question for a 20-player raid. 59 live accounts on one program, 20 s, measured
side by side:

| Approach | notifs | total | rate | bytes/notif |
|---|---|---|---|---|
| 59 × `accountSubscribe` | 6402 | 2757 KB | **137.9 KB/s** | 441 |
| 1 × `programSubscribe` | 6381 | 3172 KB | **158.6 KB/s** | 509 |

`programSubscribe` costs **+15% bandwidth** — every `programNotification` carries the
account's 32-byte pubkey as a 44-character base58 string. Notification counts are
essentially identical (6402 vs 6381), which independently re-confirms the one-per-slot
coalescing from §5.1.

So it is a straight trade, and neither side is obviously right:

- `programSubscribe`: 1 subscription instead of ~45. One resubscribe on reconnect instead
  of 45. New player entities appear automatically with no subscription bookkeeping. Costs
  15% more bytes. Cannot use the router (§3.1), so you lose automatic re-routing and must
  resolve the ER fqdn yourself.
- `accountSubscribe`: 15% cheaper, works over the router, but you must add and remove
  subscriptions as players join and leave, and re-establish all of them on every reconnect.

**Recommendation for HEARTROT: start with `accountSubscribe` over the router.** The
entity set is small (~45 accounts) and bounded (20 players is the hard cap), the router's
re-routing is worth more than 15% of bandwidth, and web3.js already re-establishes
subscriptions for you on reconnect. Revisit only if subscription churn during lobby
join/leave turns out to be fiddly.

### 5.4 HEARTROT's projected budget

Derived from the measured 289-byte envelope plus `ceil(bytes/3)*4` base64 expansion.

| What | size | writes/s | bytes/notif | KB/s |
|---|---|---|---|---|
| `Bullets` (128 × 7 B + disc) | 904 B | 2.5 (crank) | ~1497 | 3.7 |
| `ArenaState` | ~48 B | 2.5 (crank) | ~353 | 0.9 |
| Boss `Position`/`Parts`/`Core`/`BossState` | ~16–32 B | 2.5 (crank) | ~330 | 3.3 |
| Player `Position` × 20 @ 10 moves/s | 14 B | 200 | ~310 | **62.0** |
| Player `Health` × 20 | ~16 B | ~2 aggregate | ~330 | 0.7 |
| | | | **total** | **~71 KB/s** |

That is **~570 kbit/s down per client** at a full 20-player raid with 10 Hz movement.
Worst case, if every player's Position saturates the 20/s coalescing cap: ~132 KB/s
(~1.06 Mbit/s).

Levers, cheapest first:

1. **Send move transactions at 5 Hz, not 10 Hz.** Halves the dominant line to 31 KB/s.
   Client-side prediction (§8) means the player cannot feel the difference in their own
   movement; other players are interpolated anyway.
2. **`dataSlice` the Position subscription** past the 8-byte discriminator: ~310 → ~300
   bytes. Marginal — the envelope dominates. Not worth the complexity.
3. Merging all 20 positions into one arena-owned component would collapse 20 notifications
   into 1, but it breaks BOLT's one-component-per-entity model and would make every player
   write contend on one account. Not recommended; noted for completeness.

The honest summary: **bandwidth is not HEARTROT's problem.** ~570 kbit/s is fine on
desktop broadband, which is the only target v1 has (spec §1 excludes mobile). Spend the
effort on §7 and §8 instead.

---

## 6. Decoding BOLT components in the browser

### 6.1 There is no BOLT component decoder — components are plain Anchor accounts

`@magicblock-labs/bolt-sdk@0.2.4` exports account decoders for exactly three types, from
`lib/generated/accounts/index.d.ts`:

```typescript
export declare const accountProviders: {
    Entity: typeof Entity;
    Registry: typeof Registry;
    World: typeof World;
};
```

`World`, `Entity`, `Registry` — the framework's own bookkeeping. **Your components are not
in there and cannot be**; they are user-defined. What bolt-sdk gives you for components is
address derivation only:

```typescript
export declare function FindComponentPda({ componentId, entity, seed, }: {
    componentId: PublicKey;
    entity: PublicKey;
    seed?: string;
}): PublicKey;
```

So: **derive the PDA with `FindComponentPda`, decode the bytes with Anchor.** Each BOLT
component is its own deployed Anchor program with its own on-chain IDL.

### 6.2 The canonical pattern, verbatim

This is the real code from MagicBlock's own React example
(`magicblock-labs/bolt-tic-tac-toe`, `app/react-tic-tac-toe/src/App.tsx`), not a
paraphrase. It is the exact shape HEARTROT needs.

Fetching the IDL from chain and building a client per component:

```typescript
    // Helpers to Dynamically fetch the IDL and initialize the components clients
    const getComponentsClient = useCallback(async (component: PublicKey): Promise<Program> => {
        const idl = await Program.fetchIdl(component, provider.current);
        if (!idl) throw new Error('IDL not found');
        // Initialize the program with the dynamically fetched IDL
        return new Program(idl, provider.current);
    }, [provider]);
```

Decoding a notification:

```typescript
    // Define callbacks function to handle account changes
    const handlePlayersComponentChange = useCallback((accountInfo: AccountInfo<Buffer>) => {
        const parsedData = playersComponentClient.current?.coder.accounts.decode("players", accountInfo.data);
        updatePlayersComponent(parsedData);
    }, [updatePlayersComponent]);
```

Subscribing, unsubscribing, and — note this — seeding state with an immediate fetch:

```typescript
    // Subscribe to the game state
    const subscribeToGame = useCallback(async (): Promise<void> => {
        if (!entityMatch.current) return;
        console.log("Subscribing to game", entityMatch.current.toBase58());

        if (playersComponentSubscriptionId && playersComponentSubscriptionId.current) await connection.removeAccountChangeListener(playersComponentSubscriptionId.current);
        if (gridComponentSubscriptionId && gridComponentSubscriptionId.current) await connection.removeAccountChangeListener(gridComponentSubscriptionId.current);

        // Subscribe to players changes
        const playersComponent = FindComponentPda({ componentId: PLAYERS_COMPONENT, entity: entityMatch.current });
        playersComponentSubscriptionId.current = connection.onAccountChange(playersComponent, handlePlayersComponentChange, 'processed');

        // Subscribe to grid changes
        const gridComponent = FindComponentPda({ componentId: GRID_COMPONENT, entity: entityMatch.current });
        gridComponentSubscriptionId.current = connection.onAccountChange(gridComponent, handleGridComponentChange, 'processed');

        // @ts-ignore
        playersComponentClient.current?.account.players.fetch(playersComponent, "processed").then(updatePlayersComponent);
        // @ts-ignore
        gridComponentClient.current?.account.grid.fetch(gridComponent, "processed").then(updateGridComponent);
    }, [connection, handlePlayersComponentChange, handleGridComponentChange, updatePlayersComponent, updateGridComponent]);
```

The trailing `.fetch(...)` calls are the important detail most people drop: **subscribing
does not give you current state.** A subscription only fires on the *next write*. You must
fetch once to seed. §7 shows why this matters even more on reconnect.

(The `@ts-ignore` comments are theirs. `program.account.<name>` is not statically typed
when the IDL is fetched at runtime rather than generated at build time.)

### 6.3 The account-name casing trap

I verified this end to end against a real deployed BOLT component on devnet
(`9EoKMqQqrgRAxVED34q17e466RKme5sTUkuCqUGH4bij`, the tic-tac-toe grid):

```
Grid discriminator hex = a89a300e52bc9154  base58 = VCeuGcWuqcP
program.account keys: [ 'entity', 'grid' ]
live Grid accounts on devnet base layer: 16
  decode("grid") OK -> {"board":[[{"x":{}},{"o":{}},{"x":{}}],[null,{"o":{}},{"x":{}}],...
  decode("Grid") FAILED: Account not found: Grid
```

The on-chain IDL declares `"name": "Grid"`. The coder demands `"grid"`. The reason, from
`@coral-xyz/anchor@0.31.1` source:

- `program/index.js:104` — `this._idl = convertIdlToCamelCase(idl);` — the `Program`
  constructor rewrites the whole IDL to camelCase.
- `coder/borsh/accounts.js:93` — `accountDiscriminator(name)` then does an **exact**
  match: `this.idl.accounts?.find((acc) => acc.name === name)`.

So the rule is:

| How you built the coder | Name to pass |
|---|---|
| `new anchor.Program(idl, provider)` → `program.coder` | **camelCase** — `"grid"`, `"bullets"`, `"playerMeta"` |
| `new anchor.BorshAccountsCoder(idl)` directly | the IDL's **literal** name — `"Grid"`, `"Bullets"`, `"PlayerMeta"` |

Mixing these up throws `Account not found: X` at runtime, not compile time.

Also note `program.account` contains `entity` as well as `grid` — **BOLT injects its
`Entity` account into every component program's IDL.** Don't be surprised by it.

### 6.4 Discriminators come from the IDL, not from you

The fetched IDL is spec `0.1.0` (the Anchor 0.30+ format), and carries discriminators
explicitly:

```json
{
  "name": "Grid",
  "discriminator": [168, 154, 48, 14, 82, 188, 145, 84]
}
```

Read it from `idl.accounts[].discriminator`. Do not recompute `sha256("account:Grid")[..8]`
by hand — if a component ever sets a custom discriminator, the derived value is wrong and
the IDL's is right. For a `programSubscribe` memcmp filter (§3.3) you need it base58-encoded;
for `Grid` that is `VCeuGcWuqcP`.

### 6.5 Should you hand-roll borsh for the Bullets pool?

I benchmarked a HEARTROT-shaped `Bullets` component — 8-byte discriminator plus 128 ×
`{x:i16, y:i16, dx:i8, dy:i8, active:bool}` = 904 bytes — three ways:

```
Bullets component = 904 bytes, 128 bullets

manual DataView -> 128 objects         1.0 us/decode  ->  983678 decodes/sec
manual DataView -> typed arrays        0.2 us/decode  -> 4380551 decodes/sec
anchor BorshAccountsCoder.decode      14.8 us/decode  ->   67687 decodes/sec
```

Anchor is ~15× slower than a hand-rolled `DataView` loop. **It does not matter.** The
Bullets component updates at the 400 ms crank rate — 2.5 decodes/sec — so Anchor costs
37 microseconds per second. Even decoding all ~45 subscribed accounts at the full 20/s
coalescing cap would be 900 × 14.8 µs ≈ 13 ms/sec, about 1.3% of one core.

**Use Anchor's decoder. Do not hand-roll borsh.** The one caveat worth knowing: Anchor
allocates 128 fresh objects per `Bullets` decode, which is GC pressure inside a 60 fps
render loop. If — and only if — profiling shows GC hitches, replace *that one component's*
decode with the typed-array path, which allocates nothing:

```javascript
const xs = new Int16Array(128), ys = new Int16Array(128), act = new Uint8Array(128);
function decodeBulletsInto(buf) {                     // buf: Buffer/Uint8Array, 904 bytes
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < 128; i++) {
    const o = 8 + i * 7;                              // 8 = Anchor discriminator
    xs[i]  = dv.getInt16(o, true);                    // true = little-endian (borsh)
    ys[i]  = dv.getInt16(o + 2, true);
    act[i] = dv.getUint8(o + 6);
  }
}
```

Borsh is little-endian, and `#[repr(C)]`-style structs in an Anchor account are packed with
no padding, so the offsets are exactly `8 + i * sizeof(Bullet)`.

---

## 7. Reconnect and failure modes

### 7.1 What web3.js actually does — read from source, not docs

From `@solana/web3.js@1.98.4`, `lib/index.cjs.js`. The socket the `Connection` builds:

```javascript
    this._rpcWebSocket = new RpcWebSocketClient(this._rpcWsEndpoint, {
      autoconnect: false,
      max_reconnects: Infinity
    });
```

and the underlying `rpc-websockets` defaults it inherits (line 4284):

```javascript
      const rpc = rpcWebsockets.WebSocket(url, {
        autoconnect: true,
        max_reconnects: 5,
        reconnect: true,
        reconnect_interval: 1000,
        ...options
      });
```

Net: **retry forever, at a fixed 1000 ms interval, with no exponential backoff and no
jitter.**

The heartbeat and the close handler:

```javascript
  _wsOnOpen() {
    this._rpcWebSocketConnected = true;
    this._rpcWebSocketHeartbeat = setInterval(() => {
      // Ping server every 5s to prevent idle timeouts
      (async () => {
        try {
          await this._rpcWebSocket.notify('ping');
          // eslint-disable-next-line no-empty
        } catch {}
      })();
    }, 5000);
    this._updateSubscriptions();
  }
```

```javascript
  _wsOnClose(code) {
    ...
    if (code === 1000) {
      // explicit close, check if any subscriptions have been made since close
      this._updateSubscriptions();
      return;
    }

    // implicit close, prepare subscriptions for auto-reconnect
    this._subscriptionCallbacksByServerSubscriptionId = {};
    Object.entries(this._subscriptionsByHash).forEach(([hash, subscription]) => {
      this._setSubscription(hash, {
        ...subscription,
        state: 'pending'
      });
    });
  }
```

So subscriptions *are* automatically re-established after an abnormal close. Good. But note
the resubscribe error path in `_updateSubscriptions`, verbatim including the comment:

```javascript
            } catch (e) {
              console.error(`Received ${e instanceof Error ? '' : 'JSON-RPC '}error calling \`${method}\``, {
                args,
                error: e
              });
              if (!isCurrentConnectionStillActive()) {
                return;
              }
              // TODO: Maybe add an 'errored' state or a retry limit?
              this._setSubscription(hash, {
                ...subscription,
                state: 'pending'
              });
              await this._updateSubscriptions();
            }
```

If the ER accepts the socket but rejects the `accountSubscribe` call, this sets the state
back to `pending` and **immediately recurses with no delay** — a hot retry loop. The
library authors flagged it themselves and never fixed it.

And one more, easy to miss — when your last subscription is removed, the socket is closed
after a 500 ms grace period:

```javascript
      if (this._rpcWebSocketConnected) {
        this._rpcWebSocketConnected = false;
        this._rpcWebSocketIdleTimeout = setTimeout(() => {
          this._rpcWebSocketIdleTimeout = null;
          try {
            this._rpcWebSocket.close();
```

If HEARTROT tears down all subscriptions between matches, it pays a full reconnect on the
next match. Keep one cheap subscription alive across the lobby transition.

### 7.2 Measured: a dropped socket costs ~1.7 seconds

I subscribed to a continuously-written account through a real `Connection`, then called
`terminate()` on the underlying socket to simulate a network drop:

```
[427ms]  WS OPEN
[8012ms] n=149 -> terminating socket
[8015ms] WS CLOSE code=1006
[9425ms] WS OPEN
[9662ms] FIRST NOTIF AFTER RECONNECT (#150)

lastNotifBeforeClose=7981ms closeEvent=8015ms reopen=9425ms firstNotifAfter=9662ms
OUTAGE (last notif -> first notif) = 1681ms
close->reopen = 1410ms ; reopen->resubscribed notif = 237ms
```

**~1.68 seconds of total blindness**: 1410 ms to reopen (the 1000 ms fixed interval plus
~400 ms of TCP/TLS from India) and a further 237 ms to resubscribe and receive.

At a 400 ms crank that is **four missed boss ticks**. In a bullet-hell fight the player is
very likely dead, and if they were moving they will visibly teleport when state resumes.

Two consequences for HEARTROT:

1. **Refetch on reconnect; do not wait for a notification.** This is the critical one.
   Notifications only fire on the *next write*. A player standing still has an idle
   Position component — after a reconnect they would see a stale world indefinitely. Hook
   the socket's `open` event and immediately `getMultipleAccounts` the whole subscribed set.
   The ER answers 8 accounts in one round trip (2578 bytes, ~196 ms warm from India), so a
   ~45-account snapshot is a handful of batched calls.
2. **Thundering herd.** Twenty clients dropped by the same ER blip all retry at exactly
   1000 ms with no jitter, and hammer the same endpoint in lockstep. web3.js gives you no
   knob for this. If it bites, own the socket lifecycle instead of letting `Connection`
   manage it, and add jitter yourself.

### 7.3 The silent-stall failure, and the free liveness signal

Two ways to be subscribed and receiving nothing, neither of which raises an error:

- **Wrong ER.** Documented thoroughly in `er-connections.md` §10: subscribing to a
  delegated account on the wrong ER yields *zero* notifications, zero errors, and an open
  connection. Indistinguishable from a quiet game.
- **A stalled socket.** I observed this once during the commitment test in §3.2 — one of
  three sockets stopped receiving at slot `563507081` while its two siblings ran on to
  `563507249`, with no close event and no error. One observation, so I won't generalise
  from it, but it is consistent with the failure mode above and worth defending against.

HEARTROT gets a very cheap detector for both, for free:

**`ArenaState` is written by the crank every 400 ms.** That is a guaranteed heartbeat as
long as the match is live and you are talking to the right validator. If no `ArenaState`
notification arrives for, say, 1500 ms (≈4 missed ticks), then one of: the crank died, the
socket silently stalled, or you are subscribed to the wrong ER. All three want the same
response — resnapshot via HTTP, re-verify delegation, show a "reconnecting" overlay. Build
this watchdog in step 3 of the build order, when the crank first exists; it will pay for
itself for the rest of the project.

### 7.4 Idle behaviour

I held sockets open to both the ER and the router for 180 seconds with a subscription to an
idle account and zero traffic:

```
[465ms] OPEN
[588ms] SUBACK 55599
[ROUTER] [975ms] OPEN
[ROUTER] [1266ms] SUBACK 432383835467561
[ROUTER] [180051ms] STILL OPEN after 180s, readyState=1
[180070ms] STILL OPEN after 180s, readyState=1
```

Neither closed. There is no aggressive idle timeout within 3 minutes on either endpoint,
and web3.js's own 5-second `ping` covers longer idles. I did not test beyond 180 s.

---

## 8. Reconciling prediction with authoritative state

This is where HEARTROT's "it feels instant" requirement is actually won or lost, and it is
the part that no amount of ER performance solves for you.

### 8.1 Why prediction is mandatory, not optional

From §4.2: perceived move-to-confirm latency is network RTT plus up to one 50 ms block.
That is ~150–200 ms from India, maybe 40–70 ms in-region. Rendering the player's own
avatar only from confirmed chain state means every keypress visibly lags by that much.
Anything above ~100 ms reads as broken to a player.

So: **render your own avatar from local prediction immediately, and treat incoming chain
state as a correction.** Other players and the boss are rendered from authoritative state
only — you have no basis to predict their input.

### 8.2 The three object classes, each handled differently

**Your own player — predict and reconcile.**
Apply input locally the instant it happens, send the move transaction, and keep the input
in a pending buffer. When authoritative Position arrives, compare it against what you
predicted for that same input. If they agree, drop the buffer entry. If they disagree
(you were knocked back, blocked by geometry, or died), snap to authority and replay any
still-pending inputs on top.

**Other players — interpolate, never predict.**
Buffer incoming positions and render ~1 update behind, interpolating between the last two.
This trades a fixed sliver of latency for perfectly smooth motion, and it is invisible
because the player has no expectation about when someone else moved. Never extrapolate
another player's position from velocity: they stop, you overshoot, you snap back, and
that reads worse than the latency you were hiding.

**Boss bullets — extrapolate exactly, with zero error.**
This one is a genuinely nice property of the design. The `Bullets` pool stores
`{x, y, dx, dy, active}` as integers, and the crank advances each active bullet by
`(dx, dy)` per tick. The client knows `ArenaState.tick`. So between notifications the
client can run *the identical integer step* and land on exactly the value the crank will
produce. Render at 60 fps by interpolating fractionally between tick N and tick N+1, then
snap on each authoritative update — the snap is a no-op because the prediction was exact.

This is what makes a 2.5 Hz update rate produce a smooth bullet-hell. It only holds if the
client replicates the crank's arithmetic exactly: same integer types, same wrapping, same
order of operations. Any floating-point drift on the client reintroduces error. Keep the
client's bullet step in integers.

### 8.3 The design spec is missing the field reconciliation needs

Spec §5 defines:

```
Position { x, y, zone, facing }
```

There is **no sequence number and no tick stamp**. That is a real gap. Without one, an
arriving Position is ambiguous: the client cannot tell whether it reflects its most recent
input or an older one still in flight. The universal symptom is rubber-banding — the
player moves, a stale authoritative position arrives, they snap backwards, the newer
position arrives, they snap forward again.

**Recommended change: add a 2-byte `last_seq: u16` to `Position`** (or a `last_move_tick`
on `Combat`, alongside the existing `last_shot_tick`, if you would rather not touch
Position). The `Move` system writes the sequence number the client sent. The client then:

- keeps a monotonically increasing `seq` per input,
- discards any arriving Position whose `last_seq` is older than one it has already
  reconciled,
- replays only pending inputs with `seq > last_seq`.

Two bytes, and it is the difference between prediction that works and prediction that
rubber-bands. It costs nothing in bandwidth terms (§5.2: the envelope dominates; 2 bytes
is under 1% of a notification) and it is far cheaper to add now, in build-order step 0/2,
than to retrofit once the movement system is written.

`Combat.last_shot_tick` already exists and serves the same purpose for hitscan shots, so
the pattern is consistent with the design rather than foreign to it.

### 8.4 Anchoring to the tick

`ArenaState.tick` is the authoritative clock and arrives every 400 ms. Maintain a local
estimate: on each `ArenaState` notification, record `(tick, Date.now())`. Between
notifications, estimate the current tick as `lastTick + (now - lastTickWallClock) / 400`.
Use the fractional part to drive bullet interpolation. Do not free-run a local tick counter
— it will drift from the crank, and the crank is the thing that decides whether a bullet
hit you.

---

## 9. How this wires into the rest of HEARTROT

```
                    ┌──────────────────────────────────────────────┐
                    │  browser (Next.js on Cloudflare Workers)      │
                    │                                              │
   session key ───▶ │  move / shoot / enter_gate tx                │──┐
                    │                                              │  │  direct, CORS ✅ (§3.4)
                    │  local prediction (§8.2) renders immediately │  │
                    │                                              │  │
                    │  ◀── accountSubscribe ×~45 ────────────────  │◀─┤
                    │      via wss://devnet-router.magicblock.app/ │  │
                    │      (router tax ≈ 0 ms, §4.1)               │  │
                    │                                              │  │
                    │  on WS open ──▶ getMultipleAccounts snapshot │──┤  MANDATORY (§7.2)
                    │  ArenaState watchdog, 1500 ms (§7.3)         │  │
                    └──────────────────────────────────────────────┘  │
                                                                      ▼
                                                          MagicBlock ER (devnet-as)
                                                          50 ms blocks, crank @ 400 ms
```

Concretely, against the design spec's sections:

- **Spec §5 (BOLT entities).** Subscribe to ~45 accounts: `ArenaState`, `Bullets`, the four
  boss components, and `Position` + `Health` for 20 players. Do **not** subscribe to
  `PlayerMeta` (static after join) or `Combat` (only your own matters, and you already know
  your own shots). That is ~71 KB/s (§5.4).
- **Spec §5 (crank).** The 400 ms `BossTick` doubles as the render heartbeat and the
  liveness detector (§7.3). This is free and you should use it.
- **Spec §6 (SVG rig).** One `<g>` per boss part maps 1:1 onto `Parts` fields. A part's HP
  hitting zero in an authoritative update triggers the detach animation. Because `Parts`
  only changes on damage, these notifications are rare and cheap.
- **Spec §9 (what must never touch the backend).** Confirmed viable: the ER sends
  `access-control-allow-origin: *`, so the browser subscribes and submits directly. The
  four cold routes stay cold.
- **Spec §10 (build order).** Step 2 says "Move + hitscan shoot on the ER — done when it
  feels instant". As written that gate cannot be met by the ER alone (§4.2). Either move
  client-side prediction into step 2, or restate the gate as "the round trip confirms in
  under X ms" and defer "feels instant" to a later prediction step. My recommendation is
  the former — prediction is ~50 lines and it is the whole reason the game feels good.
- **Spec §11 (BOLT over Pinocchio).** Nothing in this research disturbs that decision. But
  it does add a constraint for the Pinocchio question the user raised separately: a native
  program writing to a component account **must preserve the 8-byte Anchor discriminator
  and the exact borsh field layout**, or every client's `coder.accounts.decode` throws and
  the renderer goes blank. The client-side contract is the IDL, and the IDL is Anchor's.
  See `bolt-pinocchio-cpi.md` for the program-side analysis.

---

## 10. Gotchas and failure modes — quick table

| # | Gotcha | Consequence | Mitigation |
|---|---|---|---|
| 1 | ER WebSocket API is **entirely undocumented** (0 of 215 doc pages) | No contract; can change without notice | Own an integration smoke test that asserts the subscription surface |
| 2 | ER **ignores commitment** — `processed` ≡ `finalized` | Logic expecting finality gradation is meaningless | Never branch on commitment for ER reads |
| 3 | Default encoding is **base58**, not base64 | Slower decode, larger frames | Always pass `encoding: 'base64'` |
| 4 | Subscribing does **not** deliver current state | Blank/stale world on join and on every reconnect | Always `getMultipleAccounts` to seed, and again on every WS `open` |
| 5 | Reconnect is **1000 ms fixed, no backoff, no jitter** | 20 clients retry in lockstep after an ER blip | Own the socket lifecycle if it bites |
| 6 | Measured **~1.7 s blind window** on a dropped socket | ~4 missed crank ticks; death or teleport | Snapshot on `open`; "reconnecting" overlay |
| 7 | `_updateSubscriptions` retries failed subscribes **with no delay** (upstream `TODO`) | Hot loop burning CPU against a sick ER | Watch for it; cap retries yourself if seen |
| 8 | web3.js closes the socket **500 ms after the last unsubscribe** | Full reconnect cost between matches | Keep one subscription alive across lobby↔arena |
| 9 | Wrong-ER subscription returns **0 notifications, 0 errors** | Player watches a frozen boss, no console error | `ArenaState` watchdog (§7.3) + check `delegationRecord.authority` |
| 10 | `coder.accounts.decode("Grid")` **throws**; `"grid"` works | Runtime `Account not found`, not a compile error | camelCase via `Program`; literal name via bare `BorshAccountsCoder` |
| 11 | bolt-sdk pins `ephemeral-rollups-sdk@0.2.1` vs current `0.17.0` | Two copies installed; `PublicKey` identity mismatches | npm `overrides`; import `DELEGATION_PROGRAM_ID` from the ER SDK only |
| 12 | bolt-sdk pins `@coral-xyz/anchor ^0.31.1` | Cannot use Anchor 0.32.x | Pin Anchor 0.31.1 project-wide |
| 13 | `programSubscribe` is **not available on the router** | Loses automatic re-routing if you use it | Prefer `accountSubscribe` over the router (§5.3) |
| 14 | `jsonParsed` silently falls back to base64 for custom programs | Pays for nothing | Don't use it for components |
| 15 | Anchor decode allocates 128 objects per `Bullets` | GC hitches in a 60 fps loop | Only if profiled: typed-array decode (§6.5) |

---

## 11. Contradictions with the stated design assumptions

1. **"the 10 ms ER latency" (spec §9) conflates block time with round-trip latency.** The
   ER's block time is 50 ms and its internal processing is fast, but what a player feels is
   `network RTT + block`. Measured 136–196 ms from India to `devnet-as`. The spec's
   *conclusion* — never proxy gameplay through the Worker — remains correct and this
   research reinforces it. But "10 ms" should not be used as the latency budget anywhere,
   and build-order step 2's "it feels instant" gate cannot be met without client-side
   prediction (§8.1).

2. **`Position { x, y, zone, facing }` has no sequence number.** Prediction cannot be
   reconciled without one, and the visible failure is rubber-banding. Recommend adding
   `last_seq: u16` (§8.3). This is a change to the frozen spec §5 and I am flagging it as
   such rather than assuming it.

3. **The sibling doc's router latency figure does not reproduce.**
   `er-connections.md` §10 reports "~840ms extra on first-notification latency" for the
   router. I measured ~70 ms setup and a steady-state p50 of −4 ms across 488 matched slots
   (§4.1). Both documents recommend the router regardless, so no decision changes — but the
   840 ms number should not be carried into any latency budget.

4. **Bandwidth is a non-issue, contrary to the emphasis the topic brief places on it.**
   ~570 kbit/s at a full raid (§5.4), with per-account notification rates hard-capped at the
   50 ms slot cadence by server-side coalescing. Reconnect behaviour (§7) and prediction
   (§8) are where the real risk sits. I would not spend engineering time on notification
   size.

5. **BOLT's TypeScript SDK is 13 months stale** (0.2.4, 2025-07-23) while the ER SDK ships
   monthly (0.17.0, 2026-08-26). This does not invalidate spec §11's choice of BOLT — the
   Rust framework is what that decision rested on — but it does mean the client-side BOLT
   tooling is close to unmaintained, and HEARTROT should expect to pin Anchor 0.31.1 and
   work around §2.1 rather than track latest.

---

## 12. Open questions this research could not close

- **In-region latency.** Every RTT here is India→Singapore. I could not measure from a
  Singapore or US host, so I cannot state what a well-placed player actually experiences.
  Worth one `curl` from a VPS in-region before finalising the prediction budget. (The
  Azure box at `20.51.226.176` noted in project memory would answer this in a minute.)
- **True end-to-end write→notify latency.** I only ever observed *other people's* accounts.
  Measuring "my transaction lands → my notification arrives" requires an account I own and
  can write, which means deploying the BOLT program first. Do this in build step 0; it is
  the single most important number for tuning §8.
- **WebSocket idle timeout beyond 180 s.** Not tested. web3.js's 5 s ping probably makes it
  moot.
- **Behaviour during ER re-delegation mid-match.** The router is documented (and measured,
  in the sibling doc) to follow accounts, but I did not observe a live re-delegation, so I
  cannot say whether in-flight subscriptions survive it or silently stall.
- **Whether `base64+zstd` is worth it for `Bullets`.** It saved 16% on a 112-byte account;
  on a 904-byte payload it should do better, but I measured it only on the small account
  and did not verify browser-side zstd decode cost. Low priority given §5.4.
- **The one observed silent socket stall** (§7.3). Single occurrence, no error, no close
  event. Not enough to characterise. The `ArenaState` watchdog defends against it either
  way, which is why I am not chasing it further.

---

## Sources

Every URL below was actually fetched, probed, or executed against during this research on
2026-08-31.

**Live JSON-RPC / WebSocket endpoints probed directly**
- https://devnet-router.magicblock.app/ — `getRoutes`, `getDelegationStatus`, `getAccountInfo`, CORS preflight
- https://devnet-as.magicblock.app/ — `getAccountInfo`, `getMultipleAccounts`, `getProgramAccounts`, `getTransaction`, CORS preflight
- https://devnet-eu.magicblock.app/ — RTT measurement
- https://devnet-us.magicblock.app/ — RTT measurement
- https://devnet-tee.magicblock.app/ — `logsSubscribe` traffic survey
- https://api.devnet.solana.com — base-layer comparison, IDL fetch, `getProgramAccounts`
- wss://devnet-as.magicblock.app/ — `accountSubscribe`, `programSubscribe`, `logsSubscribe`, `slotSubscribe`, encoding matrix, filter matrix, coalescing, idle test
- wss://devnet-router.magicblock.app/ — `accountSubscribe` race, subscription-surface probe, idle test
- wss://api.devnet.solana.com/ — `programSubscribe` filter control

**Official documentation**
- https://docs.magicblock.gg/llms.txt — full 215-page index; searched for "Subscribe" (0 hits)
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/rpc/introduction.md
- https://docs.magicblock.gg/pages/ephemeral-rollups-ers/api-reference/er/introduction.md
- https://docs.magicblock.gg/pages/tools/bolt/getting-started/world-program

**Package registries (version pinning)**
- https://registry.npmjs.org/@magicblock-labs/bolt-sdk
- https://registry.npmjs.org/@magicblock-labs/ephemeral-rollups-sdk
- https://registry.npmjs.org/@solana/web3.js
- https://registry.npmjs.org/@solana/kit
- https://registry.npmjs.org/@coral-xyz/anchor

**Source read directly (published artifacts, installed locally)**
- `@magicblock-labs/bolt-sdk@0.2.4` — `lib/index.d.ts`, `lib/generated/accounts/index.d.ts`, `package.json`
- `@solana/web3.js@1.98.4` — `lib/index.cjs.js`: `RpcWebSocketClient` (4284), `_wsOnOpen`/`_wsOnError`/`_wsOnClose` (8221–8270), `_updateSubscriptions` (8313+)
- `@coral-xyz/anchor@0.31.1` — `dist/cjs/coder/borsh/accounts.js:93` (`accountDiscriminator`), `dist/cjs/program/index.js:104` (`convertIdlToCamelCase`)
- `rpc-websockets@9.3.9` — `dist/index.cjs` reconnect defaults

**Repository source**
- https://raw.githubusercontent.com/magicblock-labs/bolt-tic-tac-toe/main/app/react-tic-tac-toe/src/App.tsx — the verbatim subscribe/decode pattern in §6.2
- https://github.com/magicblock-labs/bolt — `clients/typescript/` tree listing
- https://github.com/magicblock-labs/bolt-tic-tac-toe — file tree

**On-chain artifacts inspected**
- Component program `9EoKMqQqrgRAxVED34q17e466RKme5sTUkuCqUGH4bij` (tic-tac-toe `Grid`) — IDL fetched from devnet, discriminator and decode verified against 16 live accounts
- Program `FMTgsEDaPPfJi1PKD67McLTC5n833T4irbBP53LLxtvj` on `devnet-as` — 59 live delegated 112-byte accounts, used for all bandwidth/latency/filter measurements
- Delegated accounts `37PvXBYWaup4MtYTA3bw57yoJAPHA5gzSCCZ3iSgBfVg`, `83zMFL6cHjgXkQ7KRNcgtHaZ1fhyNgxhM8aMpPpEnMqe` — delegation-status verification

**Sibling research (cross-checked, one contradiction found)**
- `/home/anshtyagi/Documents/pixel-artgame/docs/research/er-connections.md`
