#!/usr/bin/env bash
#
# ER-GUARD — the one instrument that decides whether a change degraded MagicBlock ER speed.
#
# It does not measure anything itself. It pins the knobs of `perf_20seats.ts` — the sweep,
# the send period, the block length, the spam switch — so that a BEFORE run and an AFTER
# run months apart are literally the same experiment, and drives it through both modes.
# Getting one of those knobs wrong is the only way to produce two numbers that look
# comparable and are not, which is exactly what happened to `docs/spikes/sp-load.md`.
#
#   scripts/spike/er_guard.sh <label> [programId]
#
#     <label>     names the output directory, docs/perf/er-guard/<label>/
#     [programId] optional; defaults to the live id. Pass a fresh id to measure a
#                 candidate build without upgrading the program the live site uses.
#
# One run, ~8 minutes: twenty seats walked through the gate into ZONE_ARENA with a live
# boss volleying at them for the whole sweep, written to fight.jsonl.
#
# `perf_20seats.ts`'s other mode, `lobby`, is NOT run and cannot be. It arms the match
# with every seat still in ZONE_LOBBY, and the deployed program refuses that: `start_match`
# is `begin_muster`, which calls `guards::assert_any_raider` and returns `NoRaiders` (custom
# 19) over an empty pit. Measured 2026-09-02 05:46 UTC — `start_match ... {"Custom":"19"}`.
# The 2026-09-01 lobby run in docs/perf/twenty-lobby.jsonl predates that guard, so its
# p95 131 ms at twenty seats is not a number this harness can ever reproduce. The fight
# run is the one that matters anyway: it is the one carrying the crank's swept-collision
# loop, which is where added bullets would cost.
#
# The `quiet` block at the head of the run — the crank ticking with nobody sending — is the
# crank-only control, so a no-load floor is still measured.
#
# Compare with:  node scripts/spike/er_guard_cmp.mjs <baselineLabel> <candidateLabel>
#
# If a run aborts, an abandoned crank task keeps ticking for its full 4,500 iterations.
# Cancel it:  node /tmp/er_guard.mjs --settle-only <arenaId>   (arenaId is in the "start" line)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="${1:?usage: er_guard.sh <label> [programId]}"
OUT="$ROOT/docs/perf/er-guard/$LABEL"
ESBUILD="$ROOT/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild"

if [ -n "${2:-}" ]; then export HR_PROGRAM_ID="$2"; fi

# --- the pinned experiment. Changing any of these invalidates every stored baseline. ---
export PS_SWEEP='1,5,10,20,20,10,5,1'  # palindrome: ISP drift cancels at each pair's mean
export PS_SEND_MS=50                   # the app's real cadence (controls.ts MOVE_MS)
export PS_BLOCK_MS=20000
export PS_GAP_MS=6000
export PS_QUIET_MS=20000
export PS_SKIP_SPAM=1                  # spam20 answers a different question; off by default
export PS_PROBE=0
# 0 = no `shoot` traffic, which is what every number banked before 2026-09-02 was measured
# with. Set PS_SHOOT_MS=850 in the environment for the arm that loads the shoot path —
# a run with it set is NOT comparable to one without, and er_guard_cmp.mjs refuses to.
export PS_SHOOT_MS="${PS_SHOOT_MS:-0}"

mkdir -p "$OUT"
cd "$ROOT"

"$ESBUILD" scripts/spike/perf_20seats.ts \
  --bundle --platform=node --format=esm --log-level=warning \
  --alias:@heartrot/client=./packages/client/src/index.ts \
  --banner:js="import{createRequire}from'node:module';const require=createRequire(import.meta.url);" \
  --outfile=/tmp/er_guard.mjs

{
  echo "label=$LABEL"
  echo "programId=${HR_PROGRAM_ID:-JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5}"
  echo "sha256(target/deploy/heartrot.so)=$(sha256sum "$ROOT/target/deploy/heartrot.so" 2>/dev/null | cut -d' ' -f1)"
  echo "node=$(node -v)"
  echo "startedAt=$(date -Is)"
  env | grep '^PS_' | sort
} > "$OUT/env.txt"

rm -f "$OUT/fight.jsonl"
PS_MODE=fight node /tmp/er_guard.mjs --out "$OUT/fight.jsonl"

echo "=== er-guard $LABEL: done -> $OUT ==="
node "$ROOT/scripts/spike/er_guard_cmp.mjs" "$LABEL"
