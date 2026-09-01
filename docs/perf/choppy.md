# CHOPPY — the local knight stopped stuttering in a fight

**Standard deviation of per-frame displacement fell from 5.52 to 1.09 units, and the
largest single-frame jump from 15.0 units to 5.33 — which is exactly one ideal frame's
worth of travel, so the sprite never moves further in one frame than it is supposed to.**
On the feed the game actually opens (the Magic Router, which doubles every notification)
the same numbers are **7.54 → 1.09** and **16.0 → 5.33**, and stalled frames go from
**66.7% to 4.3%**.

Measured frame by frame at 60 fps over a 20 s walk, driving the shipped
`createPredictor` and the shipped `chase` in Node. Raw: `docs/perf/choppy-frames.json`,
`docs/perf/choppy-legsweep.json`. Script: `scripts/spike/perf_choppy.ts`.

---

## Cause

Three things stack, and only the first is phase-dependent — which is why the bug appears
exactly when the boss activates and not before.

**1. The local seat was drawn from interpolation, not from prediction.**
`render/Arena.tsx` drew *every* seat, the local one included, through
`useSeatInterpolation`, which lerps between **authoritative** snapshots. `predictor.self`
existed and was read in exactly one place — `App.tsx`'s `aimOrigin`, for pointer aiming —
and never reached the screen. The knight the player drives was therefore drawn from
~127 ms-old chain state (write-to-visible p50, `docs/perf/RESULT.md`).

**2. In a fight that snapshot stream is mostly stalls.** In the lobby the only writes to
`Players` are moves, so notifications track the player's own moves roughly 1:1. Once the
match starts, `boss_tick` runs every 100 ms and rewrites `Players` for bullet collisions
and respawns — and most of those carry **no position change**. Measured on devnet
(`docs/perf/choppy-feed.md`): 68.4% of fight-time `Players` notifications carry no
position change for the local seat, against 49.1% in the lobby. The interpolator got a
stream where `from.pos == to.pos`, lerped P→P for a whole window, and then jumped the
distance it owed when a real move finally landed. Still, still, still, JUMP.

**3. A cadence mismatch on top.** The client sends one move per 50 ms ER slot; the
interpolation window was the 100 ms crank period, re-anchored by any `Players` write. So
`alpha` rarely got past ~0.5 before being reset, and 63% of all travel arrived as 11–13
unit jumps — *even in the lobby*.

The chain is not implicated. The execute hop measures 0 ms, the read hop 16 µs
(`docs/perf/clientside.md`), and `programs/` was not touched.

## Fix

Local player from **prediction**, remote players from **interpolation**. Both machines
already existed in `app/src/net/predict.ts`; they were wired to the wrong consumers.

- `Arena` takes an optional `predictor`. The seat matching `localSeat` is positioned from
  `predictor.self`, driven by input and reconciled on `PlayerSlot.lastMoveSeq`. No chain
  write can re-anchor it, so the crank's position-preserving rewrites are invisible to it.
- Every other seat keeps interpolating, but per seat and per **position change**: a
  snapshot that does not move a seat updates the stored slot and lets the running lerp
  finish undisturbed, and the window is the observed gap between that seat's own last two
  position changes rather than an assumed crank period.
- Prediction alone is *not* smoothness. `self` is a 20 Hz staircase — one whole 16-unit
  tile per accepted input, nothing in between — and drawing it raw is **more** discrete
  than the interpolated seat it replaces (see the middle row of the table below). The
  renderer therefore **chases** it at `MAP_TILE` per 50 ms input period, off real elapsed
  time, snapping when the gap is respawn-sized. That is the line that turns 16 units every
  50 ms into 5.33 units every frame, at the cost of ~32 ms of lag behind the keypress
  against 165 ms for the interpolated seat.

## Method

No network. `scripts/spike/perf_choppy.ts` replays one synthetic feed of the shape a fight
actually delivers and records where the local seat would be drawn on every 16.7 ms frame:

- one `move` every **50 ms** — `input/controls.ts` `MOVE_MS`, which is also the chain's
  floor, since `move_clock` accepts one move per 50 ms ER slot;
- its authoritative echo **127 ms** later (write-to-visible p50);
- a crank snapshot every **100 ms** (`state::TICK_MS`) republishing the position already
  out there — position-preserving by construction, which is defect #2;
- 20 s, 1,199 frame-to-frame deltas after one RTT of warm-up is dropped.

The walk is east for 30 inputs then west for 30, on tile row 4 (open floor for its whole
width), so it stays off walls and no input is rejected.

Two of the three arms are the shipped code, imported directly: `createPredictor` from
`app/src/net/predict.ts`, `chase` and `MOVE_MS` from `app/src/render/Arena.tsx` (exported
for this, which is the only source change this run made). The bundle is built with
`import.meta.env.DEV=true` so both modules run their own dev self-checks on load — a
broken predictor throws here rather than being measured.

**The BEFORE arm is reconstructed, not original source.** The pre-fix hook is gone from
the tree, so its rule is rebuilt from the description recorded while it was live
(`docs/perf/choppy-feed.md` § Method): one global `{previous, next, at}`, re-anchored on
every notification, `lerp(previous, next, clamp((now - at) / 100))`, snapping on a
teleport-sized pair. The reconstruction is corroborated by an independent number: replayed
against the doubled router feed it stalls **66.7%** of frames, and the original hook
replayed over *recorded devnet frames* stalled 65.4% (lobby) / 71.0% (fight). That is
close enough that the reconstruction is behaving like the thing it stands in for.

## Numbers

Ideal is **5.333 units per frame** — one 16-unit tile per 50 ms input period spread over
16.7 ms frames. Perfect motion is that number every frame, standard deviation 0.

### Clean feed (moves at 50 ms + crank at 100 ms)

| arm | static frames | longest static run | max single-frame jump | mean | **std dev** |
|---|---|---|---|---|---|
| **BEFORE** — interpolated local seat | 200 (**16.7%**) | 1 frame | **14.99 u** (2.8× ideal) | 5.34 | **5.52** |
| raw `predictor.self`, no chase | 787 (**65.6%**) | 4 frames | **32.0 u** (6× ideal) | 5.67 | **8.01** |
| **AFTER** — prediction + chase | 52 (**4.3%**) | 2 frames | **5.333 u** (= ideal) | 5.10 | **1.09** |

### Router feed (every notification delivered twice, byte-identical, ~1 ms apart)

| arm | static frames | longest static run | max single-frame jump | mean | **std dev** |
|---|---|---|---|---|---|
| **BEFORE** | 800 (**66.7%**) | 2 frames | **16.0 u** (3× ideal) | 5.32 | **7.54** |
| raw `predictor.self`, no chase | 787 (65.6%) | 4 frames | 32.0 u | 5.67 | 8.01 |
| **AFTER** | 52 (**4.3%**) | 2 frames | **5.333 u** | 5.10 | **1.09** |

AFTER is byte-identical between the two feeds, which is the point: prediction is driven by
input, so doubling the notification stream cannot touch it. BEFORE degrades from 16.7% to
66.7% stalled frames on exactly the same walk, because the twin sets `previous := next` on
a seat that did not move and collapses the lerp to a snap.

The shape is what the report described. BEFORE is runs of zeros punctuated by jumps up to
2.8× the ideal step; its standard deviation is 1.03× its own mean, i.e. the frame-to-frame
variation is as large as the motion itself. AFTER has a standard deviation of 0.21× its
mean and **never exceeds one ideal step in a single frame** — the chase is rate-limited by
construction, so a teleport is not expressible.

### Where AFTER's remaining 4.3% comes from — direction reversals, and nothing else

`docs/perf/choppy-legsweep.json`, varying only how often the walk turns around:

| reversals in 20 s | static frames | max jump | std dev |
|---|---|---|---|
| 40 | 156 | 5.333 | 1.79 |
| 20 | 76 | 5.333 | 1.30 |
| 13 | 52 | 5.333 | 1.09 |
| 10 | 36 | 5.333 | 0.91 |

3.6–4.0 static frames per reversal, zero otherwise: **walking in a straight line produces
no static frames at all.** At a turn the prediction reverses while the drawn point is
still ~10 units behind it in the old direction; the two cross, the chase snaps, and the
sprite holds for at most **2 frames (33 ms)** before resuming. The falling mean across
that table is the same effect — turning around costs travel — not drift.

## Verification this run

| check | result |
|---|---|
| `app` `tsc --noEmit` | 0 |
| `packages/client` `tsc --noEmit` | 0 |
| `worker` `tsc --noEmit` | 0 |
| `cargo check --workspace` | 0 |
| `cargo test -p heartrot` | **59 passed**, 0 failed |
| `vite build` | 0 |
| `wrangler deploy` | version `e4ed0cf1-6b33-4231-96a0-2e45c2e51e5f` |

**Deployed bundle matches the local build, byte for byte.** A previous run served a stale
bundle and nothing said so, so this is checked rather than assumed:

```
live  index.html                     -> src="/assets/index-BytbOc0v.js"
sha256 https://heartrot.ansht.workers.dev/assets/index-BytbOc0v.js
  ad8029c918c0d46249c6170244e0ec0ac8050b83ea94205b53c1a33a12277bb8
sha256 app/dist/assets/index-BytbOc0v.js
  ad8029c918c0d46249c6170244e0ec0ac8050b83ea94205b53c1a33a12277bb8
sha256 index.html, live and local
  2e6db3d9fc18cb6d84fb47667b33db9946defe749814641693f3011d3bf10c59
```

**No visual regression is possible from this run's diff.** The only source file touched is
`app/src/render/Arena.tsx`, and only to add the word `export` to `MOVE_MS` and `chase` plus
one comment saying why. `app/src/styles.css`, `app/src/render/sprites.ts` (which holds
`PAL`), and every layout container are untouched. The deployed page loads with **zero
console errors** and holds a flat 60 fps at idle (rAF interval p50 16.7 ms, p95 16.8 ms,
max 16.8 ms over 179 frames).

## What is left

- **Playwright cannot reach a fight.** The deployed page requires a Solana wallet
  extension — there is no guest sign-in — so the browser arm stops at the connect screen.
  Everything above the "Verification" section is the Node replay, which is the stronger
  evidence anyway because it isolates the renderer from network noise, but a real
  in-browser fight trace is still missing. Recording per-frame `getBoundingClientRect` of
  the local seat during a real raid would close that.
- **The BEFORE arm is a reconstruction** (see § Method). Corroborated against an
  independently recorded number, not against the original source.
- **Remote seats are not measured here.** They still interpolate, which is correct for
  them, and the per-seat/per-position-change `retarget` rule that fixes the crank problem
  for them is covered by the dev self-checks in `net/predict.ts` — but there is no
  frame-level number for a second knight in this document.
- **The router still doubles every notification.** Prediction makes the local seat immune
  and `retarget` makes remote seats ignore the twin, so nothing visible is left — but the
  client still decodes every frame twice. That is 11 µs per duplicate
  (`docs/perf/clientside.md`), so it is not worth a dedupe until something else says
  otherwise.
- **33 ms hold on a direction reversal.** Real, small, and the honest cost of chasing a
  prediction rather than assigning it. Removing it means letting the chase overshoot, which
  trades a 2-frame hold for a snap-back.
