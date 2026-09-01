# research-program-cu — what the on-chain program contributes to write-to-visible

Date: 2026-09-01. Program `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, ER
`https://devnet-as.magicblock.app/` (Singapore), validator
`MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`, client in India.

**Headline: this area is a dead end, and the measurement says so rather than the doc.**
The whole structural lever the brief asks about — split `Players` so a `move` writes a
96-byte seat instead of the 1,924-byte roster — is worth **~1 ms of write-to-visible at
p50**, measured, n=400 paired samples. It is blocked outright at 20 seats by the 1,232-byte
transaction packet limit on `start_match`, and it makes downstream bandwidth **3× worse**
in the twenty-mover case it exists to help. Do not do it.

---

## 1. What the hot path actually touches

Read from `programs/heartrot/src/`.

| instruction | account keys | writes | bytes written | CU (prior, `docs/spikes/sp-load.md`) |
|---|---|---|---|---|
| `move` (tag 6) | 4: `arena`(r), `players`(w), session signer, program | `Players` only | 1,924 | 1,933 p50, 1,936 max |
| `shoot` (tag 7) | 5: `arena`(r), `boss`(w), `players`(w), session signer, program | `Boss` + `Players` | 50 + 1,924 | 3,551 p50, 6,714 max |
| `boss_tick` (tag 8) | 8 observed: `arena`(w), `boss`(w), `players`(w), crank signer, program, Magic noop, Crank program | all three | 3,174 | 28,586 max of 399,700 |

Sizes are compile-time asserted in `state.rs`: `Arena` 1,200 B, `Boss` 50 B,
`PlayerSlot` 96 B, `Players` 4 + 20×96 = 1,924 B.

`move`'s rate limiter is per **ER slot**, not per crank tick — `move_clock` ignores its
`arena` argument entirely and returns `Clock::get()?.slot` (`player.rs:231-253`). `arena`
is loaded solely for `assert_playable(arena.phase)`.

### CU is not on the clock at all

`docs/perf/execute.md` measured the execute hop (`sendTransaction` POST returns → the
transaction's own log notification) at **p50 0 ms, p95 1–2 ms over 780 samples**. There is
no interval for 1,933 CU to live in. For scale, Solana's per-block compute limit is
100M CU since SIMD-0286 (epoch 1009, 29 Jul 2026), so an accepted `move` is 0.002% of one
block's budget — inferred, not measured, but the measured 0 ms is the dispositive number
either way.

The one CU-shaped structural constraint worth naming is the **per-writable-account block
cap of 12M CU**, which SIMD-0286 explicitly left unchanged. Every `move` and `shoot` in
the raid writes the same `Players` account, so they all count against that one cap:
12,000,000 / 1,933 ≈ **6,200 moves per block**, against a raid ceiling of 20 seats × 20 Hz
= 400 moves/s. Not binding, by a factor of ~15 even before the per-slot limiter. (Whether
the MagicBlock ER inherits this Agave cap is unverified.)

---

## 2. The account-size question, measured

An `accountNotification` carries the **full data buffer on every update** — documented
behaviour, open since 2021 (solana-labs/solana#17496). So a 1,924-byte `Players` produces a
2,568-byte base64 payload in every notification, no matter that a `move` changed 14 bytes
of one slot. Measured envelope sizes:

| what | on the wire |
|---|---|
| `getAccountInfo(Players)` full, HTTP body | 2,803 B (2,568 base64 + 235 B envelope) |
| `getAccountInfo(Players)` `dataSlice` 96 B | 363 B |
| `accountNotification` for `Players`, WS frame (`docs/perf/clientside.md`) | 2,854 B |
| a hypothetical per-seat account (4 B header + 96 B slot) | ≈ 422 B |

So the split removes **2,432 bytes** per notification. The only way that becomes
milliseconds is transmission time on the India→Singapore return leg, so I measured that leg
directly.

### Method

`scripts/spike/perf_payload.mjs` (seven-point sweep) and `scripts/spike/perf_payload_pair.mjs` (two-arm). One warm keep-alive TLS socket to
`devnet-as.magicblock.app:443` (15 warm-up requests first, so TCP+TLS is paid once and
never again). Same RPC method, same account, same server-side work; **only the response
body size varies**, dialled with `dataSlice` and with `getMultipleAccounts` repeating one
address. Arms interleaved sample by sample; in the two-arm test the order within each pair
alternates so ordering cannot bias the delta.

### Seven-point size sweep — ms per KiB of response body

n=60 per arm per run, two runs, p50 ms:

| response bytes | run 1 | run 2 |
|---|---|---|
| 235 (`dataSlice` 0) | 126.1 | 122.8 |
| 363 (`dataSlice` 96 — one seat) | 128.8 | 124.1 |
| 1,835 (`dataSlice` 1200 — `Arena`) | 133.7 | 129.7 |
| 2,803 (full `Players` — ships today) | 130.3 | 130.0 |
| 10,998 (4× `Players`) | 130.4 | 129.4 |
| 27,384 (10×) | 137.7 | 138.5 |
| 54,694 (20×) | 135.5 | 130.7 |

Least-squares fit of p50 on bytes: **0.142 and 0.135 ms/KiB**, intercept **129.8 and
127.5 ms**. The intercept is the round trip; a bare TCP+TLS handshake to the same host
measured p50 258.9 / 256.8 ms, which is two of those, so the intercept is the real RTT and
everything above it is transmission.

**A 54 KiB response costs ~8 ms more than a 235-byte one.** The entire `Players` account is
5% of that.

### Two-arm paired test — the exact question

96 B vs 1,924 B of account data, n=200 pairs per run, two runs:

| | run 1 | run 2 |
|---|---|---|
| small arm (363 B body) p50 | 127.5 | 128.6 |
| big arm (2,803 B body) p50 | 125.3 | 129.8 |
| **paired delta (big − small) p50** | **+0.8 ms** | **+1.1 ms** |
| paired delta p90 | +9.9 | +10.5 |
| paired delta mean | −0.39 | +2.06 |
| fraction of pairs where the BIG arm was faster | 0.425 | 0.425 |

Reproducible and tiny. The big arm loses 57.5% of pairs in both runs — the sign is right —
but the magnitude is **~1 ms at p50**, and the mean flips sign between runs. The regression
above independently predicts 2.375 KiB × 0.14 = **0.33 ms**. Take 0.3–1.1 ms as the range.

Why it is so small, structurally: 2,803 B is two TCP segments at a 1,460-byte MSS and
422 B is one. On a socket that has been open for the length of a match the congestion
window is far past two segments, so the extra segment rides the same return flight and
adds serialisation delay only. **The account size never costs a round trip, only its own
transmission time.** That is why no amount of shrinking can buy more than a millisecond.

Against the live panel's 295 ms p50 that is 0.3%. Against the ~130 ms the app will sit at
once the two measured levers from the sibling spikes land (blockhash cache −130 ms,
direct-ER websocket −32 to −40 ms), it is 0.8%.

---

## 3. The split, costed against the ceilings

Read from `settle.rs`, `delegation.rs`, `tick.rs`, plus the documented Solana limits.

### The mover's own transaction does not change

`move` is `[arena(r), seat(w), session signer]` either way — 4 total keys today, 4 total
keys per-seat. The ~38-key ER ceiling is not what stops this.

### `start_match` is what stops it — and it is packet size, not keys

`settle::start_match` freezes the crank's account list into a `ScheduleTask` CPI. Each
`InstructionAccount` meta is 34 B (32 pubkey + writable + signer), and `SCHEDULE_BUF_LEN`
is 256 B sized for exactly four of them. With `s` seat accounts:

- CPI instruction data = `187 + 34s` bytes (`s=1` → 221 B, which is what the docstring
  states, so the formula is calibrated against a real transaction).
- Whole serialized `start_match` transaction ≈ **`457 + 67s` bytes**
  (1 sig-count + 64 sig + 3 header + 1 + 32×(5+s) keys + 32 blockhash + 1 + the
  instruction). At `s=1` that is 524 B, and the observed key count is 6 — matches
  `sp2.md`'s measured `start_match`, 6 keys.

The Solana packet limit is **1,232 bytes** (IPv6 minimum MTU 1,280 minus 48 of headers),
and the ER rejects address lookup tables outright, so there is no escape hatch.

| seats per account | seat accounts `s` | `start_match` tx bytes | fits 1,232 B? |
|---|---|---|---|
| 20 (today) | 1 | 524 | yes |
| 10 | 2 | 591 | yes |
| 5 | 4 | 725 | yes |
| 2 | 10 | 1,127 | yes |
| 1 | **20** | **1,797** | **no — over by 565 B** |

**`s ≤ 11`.** One account per seat cannot be scheduled in a single `start_match`, and
splitting `start_match` across two transactions would mean two `ScheduleTask` CPIs, i.e.
two crank tasks against the same arena — which `PHASE_EDGES` deliberately forbids
(`FIGHTING → FIGHTING` is absent precisely to stop a second crank being armed).

### `delegate` needs four transactions, and partial delegation is unrecoverable

`process_delegate` is 4 fixed accounts + 4 per delegated account (`delegation.rs:78-90`),
which reproduces `sp2.md`'s measured 17 keys for three accounts plus ComputeBudget. With
arena + boss + 20 seats = 22 accounts that is **92 keys** — past the documented 64-account
per-transaction cap and 2,944 bytes of pubkeys alone against a 1,232-byte packet.
Solving the same way gives **6 delegated accounts per transaction**, so 22 accounts is 4
separate `delegate` transactions. The handler's own docstring is explicit that this is the
one thing not to do: *"partial delegation is unrecoverable in practice… One instruction
makes it atomic."*

### Rent roughly triples, and the treasury cannot pay it

Rent-exempt minimum is `(128 + space) × lamports_per_byte`; the repo's measured rates are
6,333 on devnet and 6,960 on the ER.

| | base rent | ER top-up | total |
|---|---|---|---|
| `Players`, 1,924 B | 12,995,316 | 14,281,920 | 27.3M lamports |
| 20 × seat, 100 B | 28,878,480 | 31,737,600 | 60.6M lamports |
| **extra per match** | +15.9M | +17.5M | **+33.4M lamports = 0.0334 SOL** |

The treasury holds **35,182,257 lamports (0.0352 SOL)** as of this run, read live from
devnet. The extra rent for one match is the whole balance.

### It makes the thing it exists to fix worse

The ER coalesces to at most one notification per account per 50 ms slot, and the on-chain
limiter already forbids a second `move` per seat per slot, so a full raid produces
**20 notifications/s of `Players`** no matter how many people are moving:

| scenario | today | per-seat |
|---|---|---|
| 1 mover | 20/s × 2,854 B = 57.1 KB/s | 20/s × 422 B = 8.4 KB/s |
| 20 movers | 20/s × 2,854 B = **57.1 KB/s** | 20 × 20/s × 422 B = **168.8 KB/s** |

Today's single account is a **coalescing point**: twenty players' writes in one slot
collapse into one 2,854-byte frame. Twenty accounts cannot coalesce with each other, so
each carries its own ~286-byte JSON-RPC envelope and the raid ships **3.0× the bytes**. The
`ponytail:` comment already on `Players` reaches the same conclusion from the other
direction and it is right.

### The one real argument for the split, unmeasured

All 20 seats share one write lock on `Players`, so twenty movers' transactions serialise in
the ER's scheduler; per-seat accounts would let them execute in parallel. **Not measured** —
the measured single-player execute hop is 0 ms, which is silent on n=20, and `sp-load.md`
sustained 242 tx/s against the single account without a queue appearing. This would need a
20-client load test to say anything about, and even then it is a throughput property, not
the write-to-visible latency this run is about.

---

## 4. Levers

Ranked by expected milliseconds saved.

1. **Nothing.** Every candidate below is under 1.5 ms.
2. Split `Players` into per-seat accounts — **0.3 to 1.1 ms, measured**, blocked at 20
   seats, 3× worse bandwidth at raid scale, ~0.033 SOL/match more rent, four `delegate`
   transactions against a docstring that says one is required. Rejected.
3. Shard `Players` into two ten-seat accounts (the existing `ponytail:` upgrade path) —
   halves the notification to 962 B, i.e. **~0.14 ms** by the measured slope, and still
   doubles the bandwidth at raid scale because two envelopes replace one. Rejected.
4. Drop the read-only `arena` from `move` (it is loaded only for `assert_playable`) —
   saves 32 bytes of transaction and one account lock, **0 ms**, at the cost of the phase
   gate. Rejected.

---

## 5. Dead ends, recorded

- **Compute units, all three hot instructions.** The execute hop is 0 ms p50 / 1–2 ms p95
  over 780 paired samples (`docs/perf/execute.md`). 1,933 CU has nowhere to hide. `move` is
  already flat — 1,933 p50 against a 1,936 max over the whole of `sp-load`.
- **Crank CU headroom.** 28,586 of 399,700, 92.9% free. Lowering it changes nothing on the
  clock and there is no ceiling to approach.
- **Account write size as a latency term.** ~1 ms for 2,432 bytes, and the extra bytes ride
  the same return flight rather than costing a round trip, because the socket's congestion
  window is far past two segments by the time a match is running. A 54 KiB response — 20×
  the whole roster — costs only ~8 ms more than a 235-byte one.
- **The ~38-key ER ceiling** as the constraint on splitting. It is not: `boss_tick` with 20
  seat accounts is ~26 keys, comfortably under. The binding limit is the 1,232-byte packet
  on `start_match`'s `ScheduleTask` CPI, at `s ≤ 11` seat accounts.
- **The 12M per-writable-account block CU cap** as a reason to split. 6,200 moves per block
  of headroom against a 400 moves/s raid ceiling. Not binding.
- **The 50 ms notification coalescing** as something to dodge by writing less. It is a rate
  cap, not a per-write delay (`docs/perf/notify.md`: executed→visible p50 0 ms on a direct
  ER socket), and for `Players` it is a *benefit* — it is the only reason twenty movers cost
  the same downstream bandwidth as one.
- **Re-measuring CU.** Already in-repo and consistent across two independent spikes
  (`sp2.md`, `sp-load.md`); nothing in the program has changed since.

---

## Sources

- `programs/heartrot/src/state.rs`, `handlers/player.rs`, `handlers/shoot.rs`,
  `handlers/tick.rs`, `handlers/settle.rs`, `handlers/delegation.rs` — this repo.
- `docs/spikes/sp2.md`, `docs/spikes/sp-load.md` — prior CU measurements.
- `docs/perf/execute.md`, `docs/perf/notify.md`, `docs/perf/clientside.md` — prior hop
  measurements this leans on.
- `scripts/spike/perf_payload.mjs` — the size sweep run here.
- Solana docs, Transactions — 1,232-byte packet limit (IPv6 MTU 1,280 − 48), 64 accounts
  per transaction: <https://solana.com/docs/core/transactions>
- solana-labs/solana#17496 — `accountNotification` sends the full account data on every
  update: <https://github.com/solana-labs/solana/issues/17496>
- SIMD-0286, block compute limit 60M → 100M at epoch 1009 (29 Jul 2026), per-writable-
  account cap held at 12M:
  <https://solanacompass.com/news/solana-raises-mainnet-block-compute-limit-66-to-100m-cus-with-simd-0286-at>
  and <https://solana.com/upgrades/100m-cu-blocks>
- MagicBlock ER overview (50 ms target, configurable compute limits; no published account
  or CU ceiling): <https://docs.magicblock.gg/pages/get-started/introduction/ephemeral-rollup>
