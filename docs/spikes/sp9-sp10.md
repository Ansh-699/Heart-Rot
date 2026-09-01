# SP9 + SP10 — ER fees, and delegation griefing

Run: 2026-09-01, real devnet, real `devnet-as` ER. Script:
`scripts/spike/sp9_fees_sp10_grief.ts`. Nothing here is simulated locally; every number
below came back from an RPC endpoint.

**SP9 verdict: PASS.** ER transaction fees are `0`, and the ER runs no fee-payer
validation — a keypair that does not exist on either chain successfully drove a real
gameplay instruction. The base layer refuses the same instruction from the same key.
Section 8 of the spec stays deleted.

**SP10 verdict: PASS.** An unrelated keypair cannot undelegate a match. Three separate
attack paths were tried on chain and all three were rejected, with a positive control
proving the rejection was specific to the attacker and not to the state of the world.

**Both verdicts were blocked for one round by an unrelated defect that this spike found
and had to fix first — see "The blocker" below. That finding is worth more than either
verdict.**

---

## How it was run

```sh
cd /home/anshtyagi/Documents/pixel-artgame
./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild \
  scripts/spike/sp9_fees_sp10_grief.ts --bundle --platform=node --format=esm \
  --target=node22 \
  --alias:@solana/kit=$PWD/packages/client/node_modules/@solana/kit \
  --banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" \
  --outfile=/tmp/sp9sp10.mjs
node /tmp/sp9sp10.mjs [arenaId]      # default arenaId 990001
```

There is no TS runner in this workspace (no `tsx`, no `ts-node`), and `node
--experimental-strip-types` cannot resolve the client's extensionless relative imports.
esbuild is already installed as a Vite dependency, so bundling is the shortest path. The
`--banner` shim is needed because esbuild resolves `@solana/kit` to its CJS build, which
`require`s `fs/promises`.

The script imports `initArena`, `delegate`, `movePlayer`, `settle`, `sendInstructions`,
`confirmSignature`, `matchPdas`, `getRoutes` and `getDelegationStatus` from
`packages/client` — the encoders under test are the production ones. Only three things
are hand-rolled, and each for a reason stated in the file: `SetComputeUnitLimit` and
`SystemProgram::Transfer` (no client builders, correctly — they are not HEARTROT
instructions), and tag 12 `commit_and_undelegate` (deliberately has no client builder;
an attacker would not use our SDK anyway).

### Fixtures

| | |
|---|---|
| Program | `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5` |
| `arena_id` | 990001 |
| Arena | `7AAMbKv4LpwsaPQiygYbhcaVqxhJT1gvAGvg6yoTmTmA` |
| Boss | `34zDKsLBwXYT64Z5PAA8WM77McUr9YvGf9vimaMiBZZ4` |
| Players | `G46VXKftU12XyNts7djB7UuDEzSxAHXG15cozju6uJgt` |
| Treasury / `crank_authority` | `FbDoanjAUonn5wM4KbRNS3jigHe6zDa4ThoEUKPnS7ka` |
| ER | `https://devnet-as.magicblock.app/`, identity `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57` |

`getRoutes` answered with four validators, all `baseFee: 0`, all `blockTimeMs: 50`.
`devnet-as` is present and its identity matches `DEVNET_AS_IDENTITY` in `pda.ts`.

Real base-layer transactions, all confirmed:

| What | Signature |
|---|---|
| `init_arena` (tag 1) | `5PoHncTBJEis7So4gvYK3Tkt6SQczuvFJ1TPRALJQWbfknGg9K5akEPPGRJuzybgA4mH7oXs9RwPwaW8jUsfZBAt` |
| `delegate` (tag 2, 16 accounts, 1,000,000 CU) | `5JBAioDFm48vP9tRUswmQLQycFbnJBtMF4Bhzs3KoXyNWjVR2dcyGV2ytkBBy3bgSpHsJNJdG9zHwAk3tAKWm4Ne` |
| rent top-up (see below) | `2izHZe2RXVztC9nEtXkJxvDbAz6MQpJhMHaUXpnyCJuBUXtxom63Voc4PqTSwdvtFB5McwU8Tc6mn3mAXoDWHw1U` |

Both client builders worked first time against a real deployment. The delegation records
came back naming the right validator and the right owner program for all three accounts.

---

## The blocker: the ER would not clone our accounts

The first run never reached either question. Every transaction sent to `devnet-as`,
including ones that touched nothing but read-only accounts, came back with:

```json
{"jsonrpc":"2.0","error":{"code":-32003,"message":
"transaction verification error: pending request owner failed for
G46VXKftU12XyNts7djB7UuDEzSxAHXG15cozju6uJgt: Cloner error: Failed to clone regular
account G46VXKftU12XyNts7djB7UuDEzSxAHXG15cozju6uJgt :
TransactionError(InsufficientFundsForRent { account_index: 1 })"},"id":1}
```

Delegation had succeeded. `getDelegationStatus` said `isDelegated: true` with
`authority: MAS1Dt9qre…` for all three accounts. `getAccountInfo` against the ER returned
`null` — the ER had simply never managed to pull them in, and said so only when a
transaction touched them.

Cause, measured:

| account | space | devnet `getMinimumBalanceForRentExemption` | `(128 + space) × 6960` | shortfall |
|---|---|---|---|---|
| Arena | 1160 | 8,156,904 | 8,964,480 | 807,576 |
| Boss | 50 | 1,127,274 | 1,238,880 | 111,606 |
| Players | 1924 | 12,995,316 | 14,281,920 | 1,286,604 |

**Devnet's rent schedule is about 9% cheaper than Solana's default one, and the ER
validator computes rent with the default.** `init::create_pda_account` funds accounts via
`create_account_with_minimum_balance_signed`, which reads the *devnet* Rent sysvar and
therefore funds the exact devnet minimum — which the ER considers not rent-exempt. Every
account this program creates on devnet is unclonable by the ER by construction.

Transferring the shortfall (2,205,786 lamports total, 0.0022 SOL) to the three accounts on
the base layer *after* delegation fixed it immediately: the very next `getAccountInfo`
against the ER returned `owner: JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5` for all
three. No re-delegation was needed; the cloner picks up the live base-layer balance, not
the `delegationRecord.lamports` escrow snapshot.

Consequences for the build:

- **This is a hard prerequisite for every remaining ER spike.** Any spike that delegates
  and then sends will hit the same wall and read as an ER or delegation bug.
- The fix belongs on chain or in the Worker's match-open path, not in a spike script.
  On chain, `create_pda_account` must fund `max(Rent::minimum_balance(space), (128 +
  space) * 6960)` — the sysvar alone is not enough on any cluster whose rent is cheaper
  than the default. In the Worker, one extra `SystemProgram::Transfer` in the same
  transaction as `init_arena` would do it. Cost is ~0.0022 SOL per match either way.
- The exact ER threshold was **not bisected**. What is proven is that devnet's own minimum
  is too low and `(128 + space) × 6960` is enough.
- The failure is loud but misdirected: it names the ER's cloner and an account index in a
  transaction the caller never built. Nothing in it says "your account is 9% under-funded".

---

## SP9 — ER fees

### `getFeeForMessage`

The message is a real tag-6 `move` built by `movePlayer` from `packages/client`, fee payer
a freshly generated session key with a zero balance and no account on either chain
(`getBalance` → 0). Four account keys total.

| endpoint | message version | response |
|---|---|---|
| `devnet-as` | v0 | `{"error":{"code":-32003,"message":"transaction verification error: Address loading from lookup tables is disabled"}}` |
| `devnet-as` | legacy | `{"result":{"context":{"slot":564543337},"value":0}}` |
| `api.devnet.solana.com` | v0 | `{"result":{"context":{…,"slot":491374245},"value":5000}}` |
| `api.devnet.solana.com` | legacy | `{"result":{…,"value":5000}}` |

**ER fee is 0. Base-layer fee is 5000 lamports for the identical instruction.**

The surprise is the first row. The message carries **no address lookup table** — nothing in
this codebase can produce one — yet the ER's `getFeeForMessage` handler rejects any v0
message out of hand with an ALT error. This is specific to that RPC method: the same ER
accepted, executed and finalised v0 *transactions* throughout the rest of this spike
(SP10/D below is a v0 transaction that succeeded). So D18's "no ALTs" rule is not the
issue; the ER's `getFeeForMessage` simply cannot be asked about a v0 message, and any
future fee probe must send a legacy message to get an answer.

### The unfunded fee payer

Same instruction, same zero-lamport session key, signed and submitted with preflight on so
the refusal is visible.

Base layer:

```json
{"code":-32002,"message":"Transaction simulation failed: Attempt to debit an account but
found no record of a prior credit.","data":{"err":"AccountNotFound","unitsConsumed":0,
"logs":[]}}
```

ER (`3oD4kcQrq9krVV2obdmiWx1yt23W6S9S2iiNBQqF1NgFYyfR8NC8LVyF1HRErkSXTUbjSBDgxRrsMBCnXATmuyyV`):

```json
{"code":-32003,"message":"transaction verification error: Error processing Instruction 0:
instruction requires an initialized account"}
```

That ER error is `ProgramError::UninitializedAccount` from
`guards::assert_session_authority` — seat 0's `session_pubkey` is still the all-zero
sentinel, because nothing has claimed a seat in this arena. **The transaction was not
rejected for lack of funds; it was executed, reached the middle of `move_player`, and
failed a game rule.** That is the whole of SP9's second half: the ER performed no
fee-payer validation on an account that does not exist.

Both halves of D6 hold. Session wallets need no SOL.

### Also observed: a base-layer send with `skipPreflight: true` vanishes

The client's `sendInstructions` hardcodes `skipPreflight: true`. The same unfunded
transaction submitted that way returned a *signature*:

```
3iVepBbJgwVeA65WNsKJexubBAjwz1qpA6cn2SgsR4CU7dFeTLPLVPCSYM6wj7S7hEbNfQWHoq3Fii6kj7rP8KXM
```

and then `getSignatureStatuses(…, {searchTransactionHistory: true})` returns `null`
forever. The transaction never lands and never errors. `connection.ts` already documents
this hazard; this is it observed, and it is why every path in this spike that needed to
*see* a refusal built and submitted its own transaction with preflight on.

---

## SP10 — delegation griefing

All four ER attempts were sent with preflight on, from keys funded with nothing, to a
live, delegated, cloned arena.

### A. `settle` (tag 9) from a stranger — REJECTED

Stranger `7VGamWV7y7Q9aqi9EMXP1TMMcTPwUTA4ZMjaJzGfQf2e`, freshly generated, zero balance,
both the instruction's `payer` and the transaction fee payer.

```json
{"code":-32003,"message":"transaction verification error: Error processing Instruction 0:
Incorrect authority provided"}
```

The same transaction sent through the client's own path landed on chain as a failed
transaction, `5gpSDD5XBpfwHrQPYj7W6aT5QgjBXo4sR8CPfudrtsCfuJTx4oPJPuV8toAZJAtLz3V9YJyk6itiHctr1L1L4x52`,
finalised, with:

```json
{"err":{"InstructionError":[0,"IncorrectAuthority"]},"confirmationStatus":"finalized"}
```

Note what that means: the stranger's transaction *was accepted and executed* by the ER for
free — exactly as SP9 predicts — and the only thing between them and ending the raid is
`settle.rs`'s `crank_authority` check. The check is load-bearing and it holds.

### B. `settle` from the real `crank_authority` — different failure (control)

Identical instruction, `payer` = treasury (signing read-only, fee paid by a throwaway
session key):

```json
{"code":-32003,"message":"transaction verification error: Error processing Instruction 0:
custom program error: 0x6"}
```

`0x6` is `HeartrotError::WrongPhase` — the arena is still `Lobby`. The authority check sits
*before* the phase check in `settle`, so the legitimate key gets past the gate the stranger
was stopped at. Without this control, A proves only that something failed.

### C. `commit_and_undelegate` (tag 12) from a stranger — REJECTED

The literal "take these accounts off the ER" instruction, hand-encoded because it has no
client builder:

```json
{"code":-32003,"message":"transaction verification error: Error processing Instruction 0:
Incorrect authority provided"}
```

### D. `commit_and_undelegate` from the real authority — SUCCEEDED (positive control)

`4tq7fYzWvtKEsaSqQCKXUr79ZNCzEvivebAAz4wdi7vcZjb245UBPPvnQYZfM7i2C9jevfmRxNjTz8vzjxdJEFD4`,
`status: {"Ok": null}`, finalised on the ER at slot 564543399. Twelve seconds later, on the
base layer:

```json
{"baseOwnerOfArena":"JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5",
 "delegationStatus":{"isDelegated":false}}
```

The accounts really came home. So A and C were rejected *because of who signed them*, not
because undelegation is broken.

Worth recording separately: the fee payer of this successful commit-and-undelegate was a
zero-lamport throwaway while the treasury signed read-only. The shape `settle.rs`'s
ponytail comment was unsure about — "a throwaway keypair can be the transaction fee payer;
if that shape is rejected on devnet, the fix is a delegated settlement PDA plus its
`magic_fee_vault`" — is confirmed working. No fee vault is needed.

### E. The undelegation callback (base layer) from a stranger — REJECTED

`process_undelegation` is the one entry point in the program with, by design, no authority
check at all: "authentication is structural and lives inside the SDK's `undelegate`". An
unrelated funded key invoked it directly on the base layer with the correct
`EXTERNAL_UNDELEGATE_DISCRIMINATOR` (`[196,28,41,206,48,37,51,167]`), the correct borsh
seed blob for `["arena", 990001u64]`, and a buffer account it controlled and signed with:

```json
{"code":-32002,"message":"Transaction simulation failed: Error processing Instruction 0:
Invalid account owner","data":{"err":{"InstructionError":[0,"InvalidAccountOwner"]},
"unitsConsumed":133,"logs":[
 "Program JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 invoke [1]",
 "Program JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 consumed 133 of 200000 compute units",
 "Program JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5 failed: Invalid account owner"]}}
```

133 CU, refused at the buffer's owner check before touching anything. The structural
defence is real on chain, not just in the SDK's unit tests.

### Not tested

The delegation program's own base-layer `Undelegate` instruction, invoked directly by a
stranger. That is DLP's code, not ours, its discriminator is not vendored in this
workspace, and guessing one would have produced a rejection that proved nothing about the
authority check. Everything a stranger can reach *through HEARTROT* is covered above.

---

## Findings that contradict the code or the docs

1. **`confirmSignature` destroys every on-chain error it is supposed to report.**
   `packages/client/src/connection.ts` throws
   `` `transaction ${signature} failed: ${JSON.stringify(status.err)}` ``. Kit parses the
   status with `bigint`s in it, so `JSON.stringify` throws first and the caller receives
   `TypeError: Do not know how to serialize a BigInt`. Observed on the stranger-settle
   transaction, whose real error was `InstructionError: [0, "IncorrectAuthority"]` — the
   exact diagnostic the whole `skipPreflight` design depends on getting back. It is the
   only failure message a player will ever see from a gameplay transaction, and it is a
   TypeScript type error dressed as a chain error. Fix is one line (a bigint-aware
   replacer), and it should carry a test.

2. **Two rows of `error.rs`'s contract table are wrong about the deployed program**, and
   both were confirmed by chain output rather than by reading:
   - `settle` / `check_commit_accounts` return builtin `IncorrectAuthority` ("Incorrect
     authority provided"), where the table says `HeartrotError::NotArenaAuthority`.
   - `guards::assert_session_authority` returns builtin `UninitializedAccount`
     ("instruction requires an initialized account") for an unclaimed seat, where the table
     says `HeartrotError::SeatUnclaimed`.
   That is direct evidence for L5: `NotArenaAuthority` and `SeatUnclaimed` are among the
   variants with no code site, and the table is the copy that drifted.

3. **The ER's `getFeeForMessage` rejects v0 messages with an ALT error**, while the same
   ER executes v0 transactions normally. Any code that fee-probes the ER must send legacy.

4. **Devnet rent < ER rent** (the blocker above). Not in any research doc.

5. **Undelegation returned more lamports than went in.** After D, each account held its
   topped-up balance *plus its shortfall a second time*: Arena 9,772,056 (= 8,964,480 +
   807,576), Boss 1,350,486, Players 15,568,524. Unexplained, benign here, but a match that
   cycles delegate/undelegate accretes lamports and something in the DLP escrow accounting
   is not what the top-up model assumes. Worth a look before any repeated-incarnation flow
   is built.

## Repo state

Added `scripts/spike/sp9_fees_sp10_grief.ts` and this file. `scripts/` is in no tsconfig
`include`, so the green build is untouched — `packages/client`, `worker` and `app` all
re-verified at `tsc --noEmit` exit 0 after the run. No program, app or client source was
modified. Arena 990001 is spent (settled/undelegated); re-run with a fresh `arenaId`
argument.
