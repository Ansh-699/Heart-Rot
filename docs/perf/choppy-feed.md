# CHOPPY-FEED — what the feed delivers in a lobby versus in a fight

**The key number, asked for directly.** In a fight, on the feed the game actually opens
(the Magic Router), **68.4%** of `Players` notifications carry **no position change for
the local seat**. In the lobby the same figure is **49.1%**. On a control socket opened
straight at the ER, the split is **39.8%** in a fight and **0.0%** in the lobby.

That ER control is the whole finding, because it separates two defects that the shipping
feed mixes together:

| Where the dead frames come from | Lobby | Fight |
|---|---|---|
| **The crank.** `boss_tick` rewrites `Players` every 100 ms with, for a lone seat, byte-identical content. | none — the crank does not run | **10.0/s, exactly the tick rate** |
| **The router.** Every account notification is delivered **twice**, byte-identical, ~0 ms apart. | 2.0× every frame | 2.0× every frame |

So finding #2 as written is **confirmed and is the primary cause of the phase boundary**:
on a clean feed, walking in the lobby produces a `Players` stream in which *every single
frame* moves the seat, and starting the fight injects ten dead frames a second into it.
Replaying `useSeatInterpolation` over the recorded frames, that one change takes the
rendered sprite from **3.5% stalled frames to 30%**.

And there is a second, previously unrecorded defect sitting on top of it, which is
**phase-independent and larger**: the router doubles every notification, and the twin
arrives a millisecond behind its pair. A twin sets `previous := next` on a seat that did
not move, which collapses the lerp to a snap. On the router the same replay stalls
**65.4%** of frames in the *lobby* and **71.0%** in the fight — the interpolator is
already defeated before the boss ever activates.

Script: `scripts/spike/perf_feedshape.ts`. Raw: `docs/perf/feedshape-run1.jsonl` (router,
60 s + 60 s), `docs/perf/feedshape-er.jsonl` (ER control, 25 s + 25 s).

---

## Method

One real devnet match per run: `init_arena` + ER rent top-up + `delegate` on the base
layer, one seat claimed, `enter_gate`, `start_match`. One socket, three
`accountSubscribe`s on `[arena, boss, players]` with `encoding: 'base64'` and no
commitment — byte-for-byte the subscription `app/src/net/subscribe.ts` opens. One `move`
every 50 ms (`input/controls.ts` `MOVE_MS`, which is also the chain's floor: `move_clock`
accepts one move per 50 ms ER slot in every phase), fired without awaiting the POST, so
the cadence is the client's and not the 130 ms round trip.

Every notification is classified against the **previous notification of the same
account** — the same pair `useSeatInterpolation` lerps between, since its `previous` is
literally the last `PlayersAccount` it was handed.

`render` rows come from replaying that hook's rule at 60 fps over the frames actually
received: `previous <- next` and a re-anchor on every notification, position
`lerp(previous, next, clamp((now - at) / 100))`, snapping when the pair looks like a
teleport. A smooth 16-unit step spread over a 100 ms window is 0.96 units/frame.

The two runs are separate matches minutes apart, not one paired A/B — the router/ER
comparison below is between runs. The effect (2.00× versus 1.00×) is far outside anything
run-to-run noise produces here, but a paired run would be stronger.

---

## What arrives

### Router — `wss://devnet-router.magicblock.app/`, what ships today

| | Lobby (60 s) | Fight (60 s) |
|---|---|---|
| `Players` notifications | 2,246 (**37.4/s**) | 3,252 (**54.2/s**) |
| …carrying no position change for the local seat | 1,102 (**49.1%**) | 2,224 (**68.4%**) |
| …byte-identical to the frame before | 1,102 | 2,192 |
| …identical **and within 10 ms** of its twin | 1,098 | 1,733 |
| …identical and *later* than that (the crank) | 4 | 459 |
| `Players` inter-arrival p50 / p90 | 34 / 57 ms | **1** / 51 ms |
| Gap between frames that actually move the seat, p50 / p95 / max | 50 / 68 / 200 ms | 50 / 85 / **3,231** ms |
| `Arena` notifications (tick changes) | 2,246 (**0**) | 3,252 (600) |
| `Boss` notifications | 2 | 1,200 (20/s) |

`Arena` is notified on **every** `move` even in the lobby, where `move_player` never
writes it: 2,246 arena frames, 2,241 of them byte-identical, zero tick changes. The client
decodes all of them.

### ER control — `wss://devnet-as.magicblock.app/`, same code, same three accounts

| | Lobby (25 s) | Fight (25 s) |
|---|---|---|
| `Players` notifications | 423 (**16.9/s**) | 628 (**25.1/s**) |
| …carrying no position change | **0 (0.0%)** | 250 (**39.8%**) |
| …byte-identical to the frame before | **0** | 238 |
| …identical and within 10 ms of its twin | 0 | 45 |
| `Boss` notifications | 0 | 250 (**10.0/s**, none identical) |
| `Arena` tick changes | 0 | 250 (**10.0/s**, p50 gap 100 ms) |

250 dead `Players` frames in 25 s is 10.0/s, to three digits the crank period. In a fight
the crank contributes **exactly one static `Players` notification per tick**, and for a
single seat with nothing else happening its payload is byte-identical: `boss_tick` borrows
`Players` mutably on every fighting tick (`handlers/tick.rs`, "`Players` are never mapped
on an idle tick" — meaning in the *other* phases), and a writable account is notified
whether or not its bytes moved.

The duplicate is the router's, not the chain's. Identical frames and their gap to the
frame before:

| | identical frames | within 5 ms of the previous frame | p50 gap |
|---|---|---|---|
| Router (both phases) | 3,359 of 5,568 | **2,802** | **0 ms** |
| ER (both phases) | 252 of 1,071 | 30 | 31 ms |

---

## What that does to the sprite

`useSeatInterpolation` replayed at 60 fps over the recorded frames:

| | stalled frames | stall run p90 / max | jump per frame p50 / p90 / max |
|---|---|---|---|
| ER, lobby | **3.5%** | 50 / 217 ms | 2.67 / 10.67 / 20.75 units |
| ER, fight | **30.0%** | 67 / 3,033 ms | 2.67 / 11.63 / 32 units |
| Router, lobby | **65.4%** | 50 / 183 ms | 0 / **16** / 574 units |
| Router, fight | **71.0%** | 50 / 3,200 ms | 0 / **16** / 513 units |

A p90 of 16 units per frame on the router is a whole tile crossed in one 16 ms frame:
motion is not being interpolated at all, it is being snapped. The mechanism is exact — a
move lands, the lerp starts, and one millisecond later the twin arrives and sets
`previous := next` at the destination, so the sprite teleports there and freezes until the
next move. On the router the interpolator does nothing in either phase; what the fight
adds on top is the crank's ten dead frames a second and the long stalls (max stall run
3.2 s, a death and respawn).

Two smaller things fall out of the same data, both consistent with finding #3:

- The 100 ms interpolation window never completes. Real motion arrives every 50 ms
  (p50 50–52 ms in every phase of every run), so `alpha` reaches ~0.5 before the anchor
  resets. Even on the clean ER lobby feed the per-frame jump spreads 2.67 → 10.67 units
  p50 → p90 instead of sitting at the constant 5.33 a uniform 16-unit/50 ms walk would
  give: the sprite renders at a wobbling speed and permanently about half a tile behind.
- Move acceptance drops in the fight — 1,144 accepted of 1,195 sent in the lobby against
  1,028 of 1,197 in the fight, and the gap between real moves grows a tail (p95 68 → 85 ms)
  before the death stall is even counted.

---

## Verdict

**Finding #2 is the primary cause of the lobby↔fight difference.** On a feed with no other
defect, the local seat's `Players` stream is 100% motion in the lobby and 39.8% dead frames
in a fight, all of them the crank's, at exactly 10/s; that alone takes the replayed
renderer from 3.5% to 30% stalled frames. The reported phase boundary is real and this is
what sits on it.

**It is not the largest defect in the path, though.** The router delivers every
notification twice, ~0 ms apart, and each twin snaps the interpolator to its destination.
That costs more than the crank does (65.4% stalled frames in the *lobby*), is present in
both phases, and would still be there after the crank frames were filtered out.

**Neither is a latency problem and neither is on the chain.** The crank behaves exactly as
`handlers/tick.rs` says it does, and the fix for both lives in the client:

1. Render the local seat from `predictor.self` rather than from `useSeatInterpolation` —
   the standard fix, and the one that makes all of the above irrelevant for the seat the
   player is looking at. A crank frame or a duplicate frame then reconciles instead of
   re-anchoring, and reconciliation of an unchanged position is a no-op.
2. Ignore a `Players` notification whose payload is byte-identical to the one before it —
   3,359 of 5,568 frames on the shipping feed, every one of them pure cost. This is what
   keeps *remote* seats smooth, which prediction cannot help with.
