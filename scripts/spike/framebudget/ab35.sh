#!/bin/sh
# The pass-3 A/B, in one sitting, isolated from every other agent's concurrent edit.
#
# CONTROL is a clean `git archive HEAD` of the repo; CANDIDATE is that same tree with only
# the files named in FILES copied over from the working tree. Both are built with THIS
# directory's harness (main3.tsx, index3.html, vite35.config.ts) so the instrument is
# identical, and both bundles are then driven alternately, REPS times, so the box's own
# drift lands on both arms equally (CLAUDE.md: never gate on a single run per arm).
#
#   FILES="app/src/render/Knight.tsx ..." REPS=3 CASES=$PWD/cases35.json ./ab35.sh
#   PROFILE=1 MINIFY=0 ...                  # attribution build: names survive, profile on
#
# Reads git, never writes it: `git archive` is a read of HEAD into a tarball.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
SCRATCH=${SCRATCH:-/tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad}
TREE=$SCRATCH/head
export PW_HOME=${PW_HOME:-/home/anshtyagi/.npm/_npx/9833c18b2d85bc59}
export VITE_PRIVY_APP_ID=${VITE_PRIVY_APP_ID:-cmtip434r039r0cl4wkja0963}
REPS=${REPS:-3}
CASES=${CASES:-$HERE/cases35.json}
PROFILE=${PROFILE:-0}
MINIFY=${MINIFY:-1}
TAG=${TAG:-ab35}

rm -rf "$TREE" && mkdir -p "$TREE"
(cd "$REPO" && git archive HEAD) | tar -x -C "$TREE"
# The dependency trees, borrowed. Workspace links inside them point back at the repo; the
# harness config aliases `@heartrot/client` to the tree's own copy for exactly that reason.
ln -s "$REPO/node_modules" "$TREE/node_modules"
ln -s "$REPO/app/node_modules" "$TREE/app/node_modules"
ln -s "$REPO/packages/client/node_modules" "$TREE/packages/client/node_modules"
FB="$TREE/scripts/spike/framebudget"
cp "$HERE/main3.tsx" "$HERE/index3.html" "$HERE/vite35.config.ts" "$FB/"

VITE="$REPO/app/node_modules/.bin/vite"
(cd "$FB" && OUT_DIR=dist-ctl MINIFY=$MINIFY "$VITE" build --config vite35.config.ts >/dev/null 2>&1) || { echo "control build FAILED"; (cd "$FB" && OUT_DIR=dist-ctl MINIFY=$MINIFY "$VITE" build --config vite35.config.ts 2>&1 | tail -20); exit 1; }
for f in $FILES; do cp "$REPO/$f" "$TREE/$f"; done
(cd "$FB" && OUT_DIR=dist-cand MINIFY=$MINIFY "$VITE" build --config vite35.config.ts >/dev/null 2>&1) || { echo "candidate build FAILED"; (cd "$FB" && OUT_DIR=dist-cand MINIFY=$MINIFY "$VITE" build --config vite35.config.ts 2>&1 | tail -20); exit 1; }
echo "built ctl=$FB/dist-ctl cand=$FB/dist-cand files=[$FILES]"

LOG="$HERE/run-$TAG.log"
: > "$LOG"
for r in $(seq 1 "$REPS"); do
  uptime | tee -a "$LOG"
  for arm in ctl cand; do
    DIR="$FB/dist-$arm" ARM=$arm REPS=1 CASES="$CASES" OUT=/dev/null PORT=$((8780 + r)) PROFILE=$PROFILE \
      node "$HERE/drive35.mjs" 2>&1 | tee -a "$LOG"
  done
done
python3 "$HERE/agg35.py" "$LOG"
