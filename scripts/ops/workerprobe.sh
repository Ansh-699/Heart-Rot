#!/usr/bin/env bash
# Run the Worker's own sessionInit + matchLeave in node with Privy stubbed, counting fetches.
# Cloudflare's free plan caps a request at 50 subrequests; the count printed is the budget.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=${OUT:-/tmp/workerprobe.mjs}
sed -e "s#from './auth'#from './auth.probe'#" -e "s#from './index'#from '../../worker/src/index'#" \
  worker/src/routes.ts > scripts/ops/routes.probe.ts
node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild scripts/ops/workerprobe.ts --bundle --platform=node \
  --format=esm --outfile="$OUT" --log-level=error \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
REPO=$PWD node --import ./scripts/ops/countfetch.mjs "$OUT"
