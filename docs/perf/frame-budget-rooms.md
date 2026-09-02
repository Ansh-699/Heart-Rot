# frame-budget-rooms — the painted rooms, the archer atlas and the charged shot, per frame

Date: 2026-09-03, A10 gate. Instrument: `scripts/spike/framebudget/` (`main3.tsx`, the real
`<Passage>`/`<Arena>`/`<Hud>` tree over a synthetic feed; `drive34.mjs`, fresh browser per
case, `launchQuiet`, `Emulation.setCPUThrottlingRate`), cases `cases-a10.json` and
`cases-a10-iso.json`, raw rows `results-a10.json` / `results-a10-iso.json`. The plan's shape:
**20 archers in 8 facings, 32 live bullets, arrows and damage numbers on, a charged local
shot every 1.4 s** (hit-stop + root-svg shake), 1920×1080, 400 frames per run.
`commit` = `performance.now()` at rAF entry to a MessageChannel task after the commit, so
style + layout + paint-list building on the main thread; this box vsyncs at 144 Hz.

## 1. The number

| case | n | commit p50 | commit p95 (median of runs) | p95 worst run | frames > 16.7 ms | fps |
|---|---|---|---|---|---|---|
| 20 archers · 32 bullets · charged shots, **6× CPU** | 8 | 14.35 ms | **21.25 ms** | 28.6 ms | 20.1 % | 41.2 |
| same, unthrottled | 8 | 2.45 ms | **3.40 ms** | 3.9 ms | 0.0 % | 141.8 |

**The plan's gate (p95 < 16.7 ms at 6×) is not met by this tree — and it was not met by
the tree before it.** There is no HEAD arm in this sitting (no git in the gate), but the
previous round's own alternating A/B on the same harness (`run34-ab.log`, `run34-head.log`,
20 seats, **14** bullets, 50 % archers, cpu 6) recorded control p95 of 27.6–57.2 ms and
candidate p95 of 20.3–67 ms, p50 12–33 ms. With 32 bullets, every seat an archer and a
charged shot every 1.4 s on top, this tree sits at the bottom of that range. Not a
regression by any row on file; the 6× figure on a 144 Hz box has never been under 16.7.

## 2. Where the cost is (6×, 3 runs each, medians)

| case | p50 | p95 | > 16.7 ms | style | script | svg nodes |
|---|---|---|---|---|---|---|
| full (20 archers, 32 bullets, arrows, charged shots) | 14.2 | 20.0 | 16.0 % | 3 ms | 3 ms | 657 |
| no local (charged) shots | 13.8 | 20.3 | 16.3 % | 3 | 3 | 657 |
| no arrows at all | 13.4 | 20.0 | 11.8 % | 3 | 3 | 657 |
| no bullets | 12.7 | 18.0 | 7.5 % | 2 | 3 | 625 |
| frozen (no motion, no pose swaps) | 14.2 | 20.1 | 18.5 % | 3 | 3 | 657 |
| **floor: 1 archer, 0 bullets, no arrows** | **8.8** | **12.3** | 0.5 % | 1 | 2 | 406 |

Style, layout (0 ms throughout) and script together are ~6 ms *per 400 frames*; the frame
is paint. The floor — one seat standing in the painted arena with the HUD — is already
8.8 ms p50 at 6×: that is the two `<image>` paintings and the HUD being re-listed each
frame, which nothing in the scene graph escapes because an SVG subtree paints as one
display list. Twenty archers add ~4 ms p50 (every one is a nested `<svg viewBox>` crop of
one atlas), 32 bullets ~1.5 ms, arrows < 1 ms, the charged shot's hit-stop/shake nothing
measurable, motion nothing measurable (frozen == full).

## 3. What that means for the operator

- The chain constraint is untouched (`chain-cost-charged.md`); this is client paint only.
- Unthrottled the scene is 3.4 ms p95 — a 4.9× margin at 60 Hz. The 6× row models a
  low-end laptop, where the paintings are the cost and the atlases are the next.
- If a playtest on such a machine asks for it, the levers are the ones the floor row
  names: paint the two rooms into a `<canvas>` layer once (an `<image>` inside the SVG is
  re-listed with the scene; a sibling canvas is composited), or `will-change` the room
  `<image>`s off the main display list. Neither is built: the plan skips work no
  playtest asked for.

## 4. Passage proof on the painted rooms (`scripts/spike/passageproof/drive5.mjs`)

Ten passage cases × 3 runs, results in `results5.json` (DEV build, asserts live, cpu 1) and
`results5-cpu6.json` (production build, cpu 6); 6,237 + 6,010 frames sampled.

- **0 page errors in 60 runs** — on the DEV build that includes `Passage.tsx`'s own
  `exactly one #gate-portcullis in room A` and `no CSS animation on it` asserts, which run
  inside every long beat.
- Exactly **one cut** per case, at 477–546 ms under a veil of 0.88–0.97 (long form),
  157–211 ms under 0.70–0.90 (live form), 92–142 ms under 0.36–0.76 (reduced); the
  `zoneback@200` case cuts zero times and ends in the lobby, as designed.
- The local seat is in the document on **every** frame and its transform never changes
  before the cut (`tfChangesBeforeCut` 0 on every non-zoneback run).
- `#gate-portcullis` counts 1 in room A with its LIFT `finished` by 300 ms.
- Frames: cpu 1 mean 6.9 ms, worst gap 16.4 ms across all 30 runs. cpu 6 mean 7.1–7.8 ms;
  the over-budget gaps (1–4 per run, 17–43 ms) fall on the cut frame itself and the
  beat's open/close frames — room B's first paint, under the veil — plus one 42.6 ms
  outlier in `live.phase@60`. The prior proof's samples (`results3.json`, old rooms, a
  driver Chrome was throttling for occlusion) ran 11–39 ms per frame with dozens of
  over-budget gaps per run, so the new rooms are not the reason any gap exists.
- Not re-run: the hidden-document / pause-forever cases. Nothing in this round touched
  the hold or its three releases (`cover.finished`, the effect cleanup, `HOLD_CEILING_MS`),
  verified by reading `Passage.tsx`.
