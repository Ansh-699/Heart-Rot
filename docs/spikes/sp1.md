# SP1 — delegate → ER write → commit → undelegate, on real devnet

**Verdict: PASS.** Program `JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5`, arena_id
1788255048333, validator `devnet-as`. Script `scripts/spike/sp1_roundtrip.ts`, driven
entirely through `packages/client` so a wrong hand-written encoder would have failed here.

| step | keys | latency | signature |
|---|---|---|---|
| init_arena (base) | 6 | 2216 ms | `3KLyytZbbYi5VKKNjLhjxRTWJwZmJ97Afvd9DzzSkwRoUgEtAasDd9gxwRSqzW63pakrR3v4L6Vs34uespVBVtW3` |
| delegate (base) | 17 | 1521 ms | `4kt9X4W23hoKi5nh5838gxcjqJsi9nPgHVEW9PGGBgfW1SofqdTt7P7PCNHCj2HdXWqmmkj2EBGuHHWV9taqkjmC` |
| claim_seat (ER) | 5 | 728 ms | `2S7NoR8YNDEpSs4mkScoPoCJxG5rTq5mYnRVtLvt2FYtyBC5Lzq1PjDXgsnQbzjiHF4mriqsFLbCo5T66CKo1teT` |
| move ×25 (ER) | 4 | p50 405 ms | — |
| start_match (ER) | 6 | 393 ms | `3LeM65vVkhS3SPUvTWDucXpXb8j7fqTcS1tvnQJdPQDcNZCRETxoixmck4Gwm3bh5FWwW4dZjeVdinMr6vuGEa1h` |
| settle (ER) | 9 | 767 ms | `3e27ZCAQnA75dFtibWPqz5AqUupGbWBdqZcxF6ZwLCuFYc834Cux1oapu4PrwewDTYSu2w3hvGTjzMXA4vGNqgtL` |

## What it establishes

**Zero-fee gameplay is real, in the strongest available form.** The session keypair that
claimed the seat and sent all 25 moves held `base=0 er=0` lamports and had no account on
either chain. Spec §8's funding ladder stays deleted.

**Write-to-visible: p50 405 ms, p95 495 ms, max 652 ms over 25 samples.** This is the
number the client is built against, and it is *worse* than the 196 ms raw RTT — a write has
to land, be executed, and be reflected in a subsequent read. Client-side prediction is not
polish; without it the game is unplayable. `10 ms` remains a number that appears nowhere in
reality.

**The crank drives the fight unattended.** `start_match` armed task 1609488144876277437 and
the arena advanced tick 1 → 27 in 10 s, against ~25 expected at 400 ms.

**Delegate → first accepted ER write took 2756 ms**, first attempt. A client that assumes a
delegated account is immediately writable will fail; the match-open path must wait.

**Settle round-trips cleanly.** All three accounts were back on base 1489 ms after settle,
with `phase=3 tick=29` and seat 0 preserved at `pos=(224,832) last_move_seq=25` — ER state
committed intact.

**Every transaction sat far under the account ceiling** — 4 to 17 keys against ~38.

## Corrections to the research

**The ~38-key limit did not fire.** A deliberately-built 40-key transaction was ACCEPTED by
the ER (`SGckitLvGzYTcijbF6ubDYx7LhAFKzA2G7rkB8ZUF9kBEij4uKeumy9CppimvUFTpJFaJdZvQQSNYdxvu7gZTHQ`)
rather than refused. `03-risks-and-build-order.md` calls a ~46-account layout "provably
fatal, rejected at every tick"; that is not what this validator did. Not fully conclusive —
the transaction never confirmed, and it hit the BigInt client defect below rather than
returning a status — so the honest state is *the claim as written is contradicted and needs
one more probe*. It does not change the 4-fat-account design, which stands on delegation
cost and round-trip count, but the stated justification was partly wrong.

**Address lookup tables are genuinely rejected**, confirming that claim: the ER refused the
ALT transaction outright.

## Defect found

`packages/client/src/connection.ts` `confirmSignature` throws
`TypeError: Do not know how to serialize a BigInt` instead of surfacing the on-chain error —
it `JSON.stringify`s a status object that kit fills with bigints. This is the second spike to
hit it. It destroys exactly the diagnostic the `skipPreflight` design depends on recovering,
and it is why the 40-key probe above is inconclusive.
