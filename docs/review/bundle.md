# bundle: what the inlined SVG art costs to download, and the cheapest fix

## Findings

The art is NOT bad and is not the bundle problem: 77.4 KiB brotli on a cold visit, 11.1% of a 695.3 KiB critical path whose other 617.9 KiB is the Privy/Reown/viem wallet SDK. Do exactly three things, in order.

(1) SHIP OPTION 1 — relative subpath starts. Change `tools/px2svg`'s emitter to write every rect subpath as `m<dx> <dy>h..v..h..z` (relative) instead of `M<abs x> <abs y>…`, and regenerate `assets/sprites/temple.svg`, `parts/boss.svg` and `knights.svg`. Never hand-edit the checked-in `.svg` — that is one fact stored twice. Measured, built, loaded: art cost drops 77.4 → 51.1 KiB brotli (−34%) and 129.9 → 77.4 KiB gzip (−40%); critical path 695.3 → 669.0 KiB br; 3g cold load 3,419 → 3,263 ms (−156). Pixel-identical, asserted in `scripts/spike/art_relpath.py` (`ImageChops.difference(...).getbbox() is None` on both assets). Element count, fills and `<g id="part-*">` nesting are untouched, so `Scene.tsx`'s `TEMPLE_PATHS.length !== 16` assert and `Boss.tsx`'s part groups still match. ZERO product-code change, zero new file, zero new request.

(2) FIX THE THREE LOAD DEFECTS FOUND WHILE MEASURING — each is one line or one file and each is worth more than any art option. (a) The live worker serves `cache-control: public, max-age=0, must-revalidate` on content-hashed assets (Cloudflare's default; immutable is opt-in), so all 45 critical files revalidate on every repeat visit — add `app/public/_headers` with `/assets/*  Cache-Control: public, max-age=31536000, immutable`. (b) `build.sourcemap: true` + `wrangler.jsonc` publishing `../app/dist` wholesale puts 286 `.map` files / 15.9 MiB of original TypeScript on the public origin (`…/index-CnRpS8GP.js.map` → 200, 1,298,666 B) — use `sourcemap: 'hidden'` or `false`. (c) `app/src/styles.css:15` is an `@import` of `fonts.googleapis.com` inside the bundled stylesheet — the latest possible discovery point for a render-blocking resource, three serial round trips (CSS → googleapis → gstatic) after the JS bundle. Hoist to `<link rel="preconnect">` + `<link rel="stylesheet">` in `index.html`, or self-host the ~5 latin subsets (~35 KB) same-origin.

(3) TAKE OPTION 4 WHEN THE BOSS RIG IS BUILT — make `Boss.tsx`'s `parts/boss.svg?raw` a dynamic `import()`. The camera is at k=2 on the lobby through MUSTERING and `MUSTER_TICKS = ticks_for(20_000)` gives the chunk 20 s to land. Built and measured: critical 672.3 KiB br alone, 653.4 with option 1; boss leaves as its own chunk, 16,359 B brotli after option 1. Combined 1+4: art on first load = 35.5 KiB br (temple only) vs 77.4 today, −54%; 3g load 3,129 ms (−290).

DO NOT do external assets (option 2: 693.8 KiB measured vs 693.1 inline — 0.7 KiB, byte-pointless, and it makes the one layer React must never touch asynchronous). DO NOT rasterise (option 3: the biggest saving at −39.0 KiB PNG8/PNG-rig or −54.2 KiB lossless WebP, but it costs a new generator, 14 requests and an `<image>`-per-part rig rework; spec §12.4 already cut `gen_temple.py` on frame-time grounds and nothing measured here overturns it). Do not touch `MAX_BULLETS`, the S=3 scale or anything in `render-scale.md` on bundle grounds — none of those are bundle facts.

## Evidence

CORRECTION TO THE BRIEF: the art is ALREADY inlined. `app/src/render/Scene.tsx:53` imports `temple.svg?raw` and `app/src/render/Boss.tsx:58` imports `parts/boss.svg?raw`; the built entry chunk holds one 332,220-char and one 121,822-char template literal. `sprites.ts`'s "no sprite rig any more" comment is stale. So the cost was measured by REMOVING the art (a `load` hook in `scripts/spike/vite.art.config.ts` swapping each `*.svg?raw` for a same-shape stub), not by adding it. `knights.svg` is imported by nothing and costs 0 today. The LIVE deploy has no art: `heartrot.ansht.workers.dev/assets/index-CnRpS8GP.js` is 269,190 B raw / 85,709 B brotli with zero `<svg` literals — this is a cost about to ship, not one being paid.

BUNDLE (real `vite build`, brotli q11 / gzip -9; sourcemap:false variants; critical = index.html + entry + 42 modulepreload + 1 css = 45 files):
- whole dist, 288 files: 5,459.1 raw / 1,675.0 gzip / 1,410.9 brotli KiB
- critical as shipped: 3,102.4 / 854.1 / 695.3 KiB  (a plain `vite build` with sourcemaps reads 697.2 br; the 1.9 KiB is `//# sourceMappingURL` comments)
- lazy (243 Privy wallet-flow chunks): 2,356.7 / 820.9 / 715.6 KiB
- critical, temple stubbed: 2,778.6 / 782.9 / 641.2
- critical, boss stubbed: 2,866.1 / 796.9 / 672.2
- critical, both stubbed: 2,542.3 / 724.2 / 617.9
=> ART = +560.1 raw / +129.9 gzip / +77.4 brotli KiB. temple +323.8/+71.2/+54.1; parts/boss +236.3/+57.2/+23.1.
Note gzip overstates the boss 2.5x (57.2 KiB in-bundle for a file that gzips to 28.7 standalone) because gzip's 32 KiB window cannot reach across the literal. Cloudflare serves brotli (verified live: `content-encoding: br`, cf-ray SIN), so 77.4 is the real number.

WHAT THE OTHER 88.9% IS (critical chunks by brotli): entry 155.4 (77.4 of it is the art); Privy core 127.8 (`solana` x38, `ethereum` x29); toViemAccount 108.0 (viem/Coinbase/WalletConnect); Privy esm 68.1 (`solana` x39, `ethereum` x28, `bitcoin`); WalletConnect 35.2; storage 31.2; viem ccip 24.2. 617.9 of 695.3 KiB is wallet SDK, much of it Ethereum machinery in a Solana-only game.

COLD-CACHE LOAD (headless Chrome 151 over CDP, `setCacheDisabled(true)` + `no-store`, brotli loopback server, third-party origins blocked, warm-up + 3 kept navigations, medians; 4g = 9 Mbps/85 ms, 3g = 1.6 Mbps/300 ms):
- as shipped: lan 81 ms / 4g 823 / 3g 3,419 / 3g@4xCPU 3,440 — 693.1 KiB wire, 47 reqs
- option 1 (rel): lan 71 / 4g 792 / 3g 3,263 (−156) / 3g@4x 3,261 — 666.8 KiB
- option 1+4: lan 111 / 4g 798 / 3g 3,129 (−290) / 3g@4x 3,139 — 651.3 KiB
- no art at all (floor): lan 53 / 4g 788 / 3g 3,053 (−366) — 615.7 KiB
Deleting ALL the art buys 366 ms at 1.6 Mbps, 35 ms at 9 Mbps, 28 ms on LAN. That is the upper bound; option 1 collects 156 ms of it, option 1+4 collects 290. It is a BANDWIDTH cost, not a parse cost: 4x CPU throttling moves every row by under 21 ms, and 77.4 KiB at 1.6 Mbps predicts 396 ms against 366 measured. The one anomaly, option 1+4 slower on LAN (111 vs 71), is the dynamic import's extra serial round trip with no latency to hide it.

OPTION NUMBERS: relative re-encode — temple 332,218→283,442 raw, 72,377→40,370 gzip, 55,205→36,255 br; boss 121,820→101,729, 28,705→18,198, 23,384→16,315; knights 45,334→41,148, 11,528→8,646, 9,655→7,809. Raster — temple PNG8 18,022 / lossless WebP 15,072; boss rig as 13 cropped part PNGs 21,267 / WebP 8,636 (the rig must stay separable per spec §7.3, so the flattened 17,439 B figure does not apply). External — 55,205+23,384 = 78,589 B br vs 79,258 B inlined.

FCP AND LCP NEVER FIRE, in any row. `#root` is still empty 6 s after `load` with third-party origins blocked: `PrivyProvider` never resolves its remote config. This app's FIRST PAINT IS GATED ON A THIRD-PARTY ORIGIN, not on its own bundle — so no art option moves first paint at all. A static lobby background + spinner in `index.html` would be worth more perceived load time than every option here combined. `longtask` reported nothing in all 15 cells, so TTI-lite collapses onto `load` and carries no information.

HARNESS FAULTS FOUND AND FIXED (three earlier passes of the load table were wrong): (i) a fresh tab, `clearBrowserCache`, `setCacheDisabled(true)` and `no-store` ALL still let later reps answer the entry chunk from Chrome's in-memory cache with `encodedBodySize` 0 — the fix is a per-navigation URL prefix `/r<n>/assets/…`; (ii) the harness's own brotli memo was keyed on `length + first 32 bytes`, so the FIRST build's `index.html` was served for every later build, every missing chunk name fell through an SPA fallback, and the second build read 539.6 KiB instead of 667.8 — one chunk light, exactly the file under test, with no error anywhere. Now keyed on file path, and a missing file 404s. Cross-check that it behaves: 693.1 measured vs 695.3 computed, 666.8 vs 669.0, and the 26.3 KiB delta identical in both.

Full write-up with every table: /home/anshtyagi/Documents/pixel-artgame/docs/perf/bundle.md. Product code untouched; `app`, `packages/client` and `worker` all `tsc --noEmit` exit 0, `vite build` exit 0. `cargo test -p heartrot` was NOT run — no Rust was touched by this task.

## On-chain

NOTHING in this task is on chain, and nothing here may become on chain. This is entirely a client delivery question.

Purely cosmetic / build-time, must not reach the chain:
- The relative-vs-absolute SVG path encoding. It is a compression detail of a file the chain never reads. The chain's boss geometry is `PART_HITBOXES`, `CORE_*`, `MUZZLES` and `ANCHOR_*` in `programs/heartrot/src/hitboxes.rs`, generated by `tools/gen_hitboxes.py` from `assets/sprites/hitboxes.json` — a separate file from `parts/boss.svg`, so re-emitting the drawing changes zero on-chain bytes. Verified pixel-identical, so even the drawn boss and the raycast boss stay in agreement.
- Whether the temple and boss art arrive as a JS string literal, a fetched `.svg`, a PNG or a WebP; whether the boss is statically imported or lazily imported; the cache headers; the sourcemap flag; where the webfont is discovered. All client-local presentation and delivery. A client that rendered none of the art would still be playing the same game on the same tick.

One thing this task must NOT be allowed to imply is on-chain: option 4 (lazy-loading the boss) reads `MUSTER_TICKS = ticks_for(20_000)` as its budget. That constant is a chain fact for the phase machine and must stay derived from `state::ticks_for()`; the client must never hardcode 20000 in a loader timeout, and no animation or loading duration constant may be added to any account. The lazy import needs no timer at all — it is issued at mount and awaited by the render, which is why it costs zero bytes anywhere.

Account budget impact of every recommendation here: zero. `LAYOUT_VERSION` stays 1. No new field, no new instruction, no wire-ABI change.

## Risks

- The relative-path re-encode must land in `tools/px2svg`'s emitter and the assets regenerated from it. If anyone applies it directly to the checked-in `.svg` files instead, the generator and its output disagree — this project's most repeated defect. The pixel-identity assert lives in `scripts/spike/art_relpath.py`, which is a throwaway; the real guard has to move into px2svg.
- Option 1's saving is compressor-dependent, not absolute. It was measured with `zlib` brotli q11; Cloudflare's edge brotli level is not published. The raw-byte saving (−87 KiB of string the parser materialises) is unconditional, but the −26.3 KiB brotli figure could move by a few percent at the edge.
- Every browser number came from one Fedora/X11 box, Chrome 151 headless, dPR 1.0. Firefox, WebKit and mobile were not measured. The link emulation is CDP's: no packet loss, no DNS, no TLS handshake, no HTTP/3, server on loopback — real 3G is worse than the 3g rows.
- FCP/LCP could not be measured at all because the app renders nothing until Privy's remote config resolves, and the harness blocks third-party origins. So no option here has been shown to improve any user-visible paint metric — only DCL/load. If the real question is 'does it feel slow', the answer is in Privy's boot, not in the sprites.
- `longtask` reported zero across all 15 cells even at 4x CPU throttle with 3 MB of JS. Either the work genuinely chunks below 50 ms or headless Chrome under-reports; it was not established. No conclusion rests on TTI, but anyone wanting a real TTI number must re-measure headed.
- Options 2 and 3 have byte numbers but no load cells — option 2's bytes were confirmed in the browser (693.8 KiB, 50 requests), option 3's are arithmetic over measured PNG/WebP file sizes. Neither was timed, because neither is recommended; if someone wants to argue for rasterising, they must time it first.
- Option 4 (lazy boss) adds one serial round trip and is measurably WORSE on a zero-latency link (111 ms vs 71 on LAN). It only pays on real links and only because the 20 s muster hides it. If the muster window is ever shortened or removed, re-check it.
- The three §5 defects are adjacent findings, not the assigned task. In particular the `_headers` fix creates `app/public/`, which does not exist today, and `sourcemap: 'hidden'` changes what a production debugger can symbolicate. Both are one-line changes but both are product-code changes I did not make.
- The measurement was taken against the working tree of this run's spec work, not against commit ce9b743, and the live deploy is older still with no art at all. Re-run `scripts/spike/bundle_size.mjs` before quoting 695.3 against a different tree.
- `scripts/spike/vite.art.config.ts` needs a `node_modules/vite` symlink at the repo root to run (Vite writes its temp config there and resolves bare specifiers from it). I created it, measured, and removed it again; the doc records the one-line prerequisite. Anyone re-running must recreate it, and must delete the `dist-art-*` trees afterwards — `.gitignore` covers `dist/`, not `dist-art-full/`, so 40 MB of build output otherwise shows up untracked.