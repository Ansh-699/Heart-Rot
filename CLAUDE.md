# HEARTROT — working rules

## Browsers never appear on screen

This repo is developed on a machine somebody is using. **No harness, agent or script may put
a browser window on the desktop.** Launch through the one helper:

```js
import { launchQuiet } from '<rel>/scripts/spike/launch.mjs';
const browser = await launchQuiet(chromium);                  // headless
const browser = await launchQuiet(chromium, { headless:false }); // real raster, still invisible
```

`headless: false` is allowed only when the measurement genuinely needs real compositing —
and even then the window goes to `--window-position=-32000,-32000`, never on screen.

**Do not "minimise" instead.** Chrome throttles `requestAnimationFrame` to 50–190 ms per frame
for a window it thinks is occluded, backgrounded or minimised. A per-frame measurement then
silently becomes a coarse one — it does not error, it just stops being able to see what it was
written to catch. The passage-proof harness would have missed a ~150 ms defect window and
reported a false all-clear. That is why `launch.mjs` pairs the off-screen position with
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding` and
`--disable-features=CalculateNativeWinOcclusion`. Never call `page.bringToFront()`.

## Toolchain

- **pnpm@10.24.0, never npm.** `npx tsc` resolves to an unrelated joke package (`tsc@2.0.4`)
  that prints "This is not the tsc command you are looking for" and exits **0**. Always
  `./node_modules/.bin/tsc --noEmit`.
- `cargo test -p heartrot` prints **two** result lines. The unit line is the one that matters;
  the doc-test line reads "0 passed" and has been misread here before:
  `cargo test -p heartrot 2>&1 | grep -E "^test result|running [0-9]+ test"`
- `node_modules` can be wiped by the user's `cleanit` helper. `pnpm install` restores it in
  seconds; Rust is unaffected.

## One fact, one place

Generated files — `programs/heartrot/src/map.rs`, `hitboxes.rs` and their `packages/client`
mirrors — come from `tools/gen_map.py` and `tools/gen_hitboxes.py`. **Never hand-edit generated
output.** Every recurring defect in this project's history has been one fact stored twice:
art disagreeing with hitboxes, a client mirror disagreeing with the chain's movement rule, a
comment asserting a contrast ratio nobody re-measured.

`packages/client/src/layout.ts` mirrors `handlers/player.rs`'s movement rule for prediction.
They move in the same commit — a disagreement there reads as lag, and it has been misdiagnosed
as lag twice.

## Do not regress these — each was earned by a measurement

- Local seat renders from **prediction** (`predictor.self`, chased in the rAF loop); remote seats
  from **interpolation**. Exactly **one writer per node transform**. `predictor.ready` gates the
  local seat. (200 → 52 static frames.)
- The blockhash cache in `packages/client/src/connection.ts`. Re-fetching per send costs two
  round trips to Singapore. (p50 295 → 127 ms.)
- Static scene layers stay out of the per-notification path.
- Every duration derives from `state::ticks_for()`. `MOVE_MS = 50` is one ER slot, the chain's
  floor, not a tunable.
- `PlayerSlot` is 96 bytes; class 0 is the knight. Growing it grows every notification.

## Deploys are paired

A wire-format change makes the program and the client an indivisible deploy — an old client's
join is a clean `InvalidInstructionData` refusal. Deploying one without the other has broken the
live site here. Deploy the program first, the Worker seconds later, and verify both against the
local build by hash.

## Measuring ER latency

Never gate on a single run per arm. Two runs of **identical code** nine minutes apart differ by
+101.5 ms at p95 — a single-run gate reported four false regressions and cost a whole round trip
to disprove. Pool two runs per arm in one sitting: `scripts/spike/er_guard.sh` then
`er_guard_cmp.mjs <base1>,<base2> <cand1>,<cand2>`.
