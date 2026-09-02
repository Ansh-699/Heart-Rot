# bundle — what the art costs to download

> **Re-baselined 2026-09-03 (painted rooms).** Everything below the rule is the
> 2026-09-02 measurement of the *inlined-SVG* art (`temple.svg`, `parts/boss.svg`,
> `knights.svg`), all three of which are gone: the rooms are the two reference paintings
> as `<image>`s, the boss atlas is cut from the arena painting, the archer is a generated
> pixel atlas. Kept as the record of why inlining was rejected. Current numbers, from
> `node scripts/spike/bundle_size.mjs app/dist` on the build in the same tree
> (`vite build`, 294 files):
>
> | set | files | raw KiB | gzip -9 | brotli q11 |
> |---|---|---|---|---|
> | all | 294 | 6,133.6 | 2,757.2 | 2,541.9 |
> | critical (index.html + entry + modulepreload + css) | 45 | 2,576.8 | 737.8 | 629.0 |
> | lazy | 249 | 3,556.9 | 2,019.4 | 1,912.9 |
>
> The art is five hashed PNGs under `/assets/` (served `immutable` by `app/public/_headers`,
> never base64): `lobby` 563,470 B, `arena` 485,360 B, `gate` 15,185 B — the **paintings
> total 1,064,015 B = 1,039 KiB**, above the plan's "two PNGs < 900 KB" figure, kept on
> purpose: the quantisers that meet 900 KB (fast-octree, max-coverage) visibly posterise the
> painted floor (A1's measurement, `tools/gen_rooms.py`). `boss_parts` 146,038 B,
> `archer` 17,231 B. They load from the entry (`rooms.gen.ts` warms both rooms at import)
> and are already compressed, so gzip/brotli buy nothing on them. The app entry
> (`index-*.js`, 329.4 kB raw / 107.3 kB gzip) is **smaller** than the inlined-SVG entry
> this document measured (865,459 B raw / 159,181 B brotli): the literals left the JS.

---


Measured 2026-09-02 against the real `vite build` output, not a model of it. Every number
below is reproducible with the four throwaway harnesses in `scripts/spike/`:

```
# vite.art.config.ts lives outside app/, so Vite writes its temp config to the ROOT
# node_modules and resolves `vite` from there. One symlink, removed again afterwards:
ln -s .pnpm/vite@8.2.2_esbuild@0.28.1/node_modules/vite node_modules/vite

cd app
C=../scripts/spike/vite.art.config.ts
VITE_PRIVY_APP_ID=… npx vite build -c $C                    # -> dist-art-full   (as shipped)
STRIP=temple,boss  VITE_PRIVY_APP_ID=… npx vite build -c $C # -> dist-art-temple-boss (floor)
REL=1              VITE_PRIVY_APP_ID=… npx vite build -c $C # -> dist-art-rel      (option 1)
LAZYBOSS=1 REL=1   VITE_PRIVY_APP_ID=… npx vite build -c $C # -> dist-art-rel-lazyboss (1+4)
cd ..

node scripts/spike/bundle_size.mjs app/dist-art-full   # raw / gzip -9 / brotli q11, per set
REPS=3 node scripts/spike/bundle_load.mjs app/dist-art-full app/dist-art-rel
python3 scripts/spike/art_relpath.py /tmp/art-rel      # option 1; asserts pixel-identical
python3 scripts/spike/art_raster.py                    # option 3
```

The `dist-art-*` trees the harness writes are **not** covered by `.gitignore` (which ignores
`dist/`, not `dist-art-full/`). They were deleted after measuring; delete them again after
any re-run, or the next `git status` has 40 MB of build output in it.

Build block used throughout, from the task brief:

```
cd app && VITE_PRIVY_APP_ID=cmtip434r039r0cl4wkja0963 npx vite build
```

---

## 0. Three corrections to the brief before any number

**The art is already inlined.** The brief says `app/src/render/sprites.ts` line 5 — "There
is no sprite rig any more: no boss.svg, no knights.svg, no slicing" — still describes the
renderer. It does not. `app/src/render/Scene.tsx:53` does
`import templeSvg from '../../../assets/sprites/temple.svg?raw'` and
`app/src/render/Boss.tsx:58` does the same for `assets/sprites/parts/boss.svg`. Both land
in the entry chunk as template literals: the built entry contains one 332,220-character and
one 121,822-character literal, verified by scanning `dist/assets/index-*.js`.

So the art's cost is measured by **removing** it, not by adding it. `scripts/spike/vite.art.config.ts`
is `app/vite.config.ts` plus one `load` hook that swaps the chosen `*.svg?raw` module for a
stub of the same shape (16 `<path>`, 13 `<g id="part-*">`), so Scene.tsx's path-count assert
still passes and rolldown still emits the same module graph.

**`knights.svg` is not imported by anything.** `Knight.tsx` draws from `PAL` and primitives.
It costs zero bytes today. Its numbers appear below only because §8.2 of the spec plans to
add it.

**The live deploy does not have the art yet.** `https://heartrot.ansht.workers.dev/assets/index-CnRpS8GP.js`
is 269,190 B raw / **85,709 B brotli** and contains zero `<svg` literals. The local build's
entry is 865,459 B raw / 159,181 B brotli. Everything in this document is therefore a cost
about to be shipped, not one already being paid.

---

## 1. The measurement

`dist/` splits into two sets that behave completely differently, so totals alone are
misleading:

- **critical** — `index.html`, the entry `<script type="module">`, the 42 `<link rel="modulepreload">`
  and the one stylesheet. 45 files. This is what a cold visit downloads before anything runs.
- **lazy** — the other 243 chunks, reached by `import()` from Privy's wallet flows. A visitor
  who never opens the wallet modal never pays for most of them.

Sourcemaps are excluded from every row (see §5.2 — they are a separate defect). The variant
builds also set `sourcemap: false`, which is worth 1.9 KiB brotli of `//# sourceMappingURL`
comments: a plain `vite build` measures the critical path at 697.2 KiB brotli against the
695.3 quoted throughout. Every comparison below is between builds that agree on that flag.

### 1.1 Today

| set | files | raw KiB | gzip KiB | brotli KiB |
|---|---|---|---|---|
| all | 288 | 5,459.1 | 1,675.0 | 1,410.9 |
| **critical** | 45 | **3,102.4** | **854.1** | **695.3** |
| lazy | 243 | 2,356.7 | 820.9 | 715.6 |

Cloudflare serves brotli — confirmed on the live worker: `content-encoding: br`, `cf-ray … -SIN`.
**695.3 KiB brotli is the real cold-visit number.**

### 1.2 What the art costs

Same build, art stubbed:

| critical path | raw KiB | gzip KiB | brotli KiB |
|---|---|---|---|
| as shipped (temple + boss inline) | 3,102.4 | 854.1 | 695.3 |
| temple stubbed | 2,778.6 | 782.9 | 641.2 |
| boss stubbed | 2,866.1 | 796.9 | 672.2 |
| both stubbed | 2,542.3 | 724.2 | 617.9 |
| **art total** | **+560.1** | **+129.9** | **+77.4** |
| — of which `temple.svg` | +323.8 | +71.2 | +54.1 |
| — of which `parts/boss.svg` | +236.3 | +57.2 | +23.1 |

**The art is 77.4 KiB brotli — 11.1% of the cold-cache critical path.**

Note the gzip/brotli spread on the boss: gzip pays 57.2 KiB for a file that gzips to 28.7 KiB
standalone. gzip's 32 KiB window cannot reach across the literal; brotli's can, which is why
the boss costs 2.5× more over gzip than over brotli. Anyone measuring this over gzip will
overstate the art by 52 KiB.

### 1.3 The other 88.9%

Critical path, biggest chunks by brotli:

| brotli KiB | gzip KiB | raw KiB | chunk | what it is |
|---|---|---|---|---|
| 155.4 | 219.5 | 845.2 | `index-CPzp_TSo.js` | the app — **77.4 of this is the art** |
| 127.8 | 153.0 | 537.8 | `index-BMVqHT_T-…js` | Privy core (`solana` ×38, `ethereum` ×29) |
| 108.0 | 130.8 | 457.8 | `toViemAccount-…js` | viem / Coinbase / WalletConnect |
| 68.1 | 79.6 | 334.3 | `esm-BlVoTxhW.js` | Privy (`solana` ×39, `ethereum` ×28, `bitcoin`) |
| 35.2 | 41.3 | 131.0 | `index.es-CCWQewRV.js` | WalletConnect |
| 31.9 | 37.3 | 124.6 | `_esm-BU9IRd81.js` | — |
| 31.2 | 36.6 | 218.1 | `storage-ClxaIe6D-…js` | — |
| 24.2 | 28.8 | 103.7 | `ccip-DxhF18HF.js` | viem CCIP (Ethereum name resolution) |

**617.9 of the 695.3 KiB is the wallet SDK, and a large part of it is Ethereum machinery in
a Solana-only game.** The art is the small half of the small half. Any argument that starts
"the bundle is too big" has to start here, not at the sprites.

---

## 2. Cold-cache load

`scripts/spike/bundle_load.mjs` serves a `dist` over loopback the way Cloudflare Workers
static assets do — brotli when asked for — then drives headless Chrome 151 over CDP with
`Network.setCacheDisabled(true)` and `cache-control: no-store` (a true first visit, and also
what the live worker sends today, §5.1), an emulated link, one warm-up navigation per cell
and 3 kept navigations. Medians.

Two harness details are load-bearing rather than incidental, and between them they
invalidated three earlier passes of this table.

1. **Every navigation is served under its own URL prefix**, `/r<n>/assets/…`, rewritten into
   `index.html` on the way out. Nothing weaker works: a fresh tab per navigation,
   `Network.clearBrowserCache`, `setCacheDisabled(true)` and `cache-control: no-store` still
   let later reps answer the entry chunk out of Chrome's in-memory cache with
   `encodedBodySize` 0 — and the entry chunk is the only file that differs between the
   builds being compared, so the A/B measured everything except the thing under test.
2. **The harness's own brotli memo was keyed on `length + first 32 bytes`.** Every build's
   `index.html` shares both, so the first build's html was served for every later build:
   the browser was handed the wrong chunk list, each missing name fell through the server's
   SPA fallback to `index.html`, and the second build came back 539.6 KiB instead of 667.8 —
   one chunk light, exactly the file under test, with no error anywhere. The memo is now
   keyed on the file path, and a missing file 404s instead of falling back. That fallback is
   what hid the bug: it turned a harness fault into a plausible number.

Cross-check that it now behaves: the browser's own `encodedBodySize` sum agrees with the
static table in §1 to within about 2 KiB — **693.1 measured against 695.3 computed** for the
shipped build, **666.8 against 669.0** for option 1 — and the *difference between them*,
26.3 KiB, is identical in both. The residual is the blocked Google Fonts request (counted as
0 bytes) and the harness's own `/r<n>/` prefixes inflating `index.html`.

Links: **4g** = 9 Mbps / 85 ms RTT, **3g** = 1.6 Mbps / 300 ms RTT (Chrome's presets).
Third-party origins (Privy, WalletConnect, Reown, Coinbase, Google, Sentry, MoonPay) are
blocked so the number is this bundle and nothing else.

| build | link | CPU | n | DCL / load | TTI | reqs | bytes on the wire | decompressed |
|---|---|---|---|---|---|---|---|---|
| **as shipped** | lan | 1× | 3 | **81 ms** | 81 | 47 | **693.1 KiB** | 3,093.6 KiB |
| | 4g | 1× | 3 | **823 ms** | 823 | 47 | 693.1 | 3,093.6 |
| | 3g | 1× | 3 | **3,419 ms** | 3,419 | 47 | 693.1 | 3,093.7 |
| | 3g | 4× | 3 | 3,440 ms | 3,440 | 47 | 693.1 | 3,093.7 |
| **opt 1: relative paths** | lan | 1× | 3 | 71 ms | 71 | 47 | 666.8 KiB | 3,006.8 KiB |
| | 4g | 1× | 3 | 792 ms | 792 | 47 | 666.8 | 3,006.8 |
| | 3g | 1× | 3 | **3,263 ms** (−156) | 3,263 | 47 | 666.8 | 3,006.8 |
| | 3g | 4× | 3 | 3,261 ms (−179) | 3,261 | 47 | 666.8 | 3,006.8 |
| **opt 1 + opt 4** | lan | 1× | 3 | 111 ms | 111 | 47 | 651.3 KiB | 2,808.7 KiB |
| | 4g | 1× | 3 | 798 ms | 798 | 47 | 651.3 | 2,808.7 |
| | 3g | 1× | 3 | **3,129 ms** (−290) | 3,129 | 47 | 651.3 | 2,808.8 |
| | 3g | 4× | 3 | 3,139 ms (−301) | 3,139 | 47 | 651.3 | 2,808.8 |
| **no art at all** (floor) | lan | 1× | 3 | 53 ms | 53 | 47 | 615.7 KiB | 2,533.6 KiB |
| | 4g | 1× | 3 | 788 ms | 788 | 47 | 615.7 | 2,533.6 |
| | 3g | 1× | 3 | **3,053 ms** (−366) | 3,053 | 47 | 615.7 | 2,533.6 |

`FCP` and `LCP` are omitted because they are 0 in every row — see §2.2. `DCL`, `load` and
`TTI` are within 1 ms of each other in every row, so they are reported as one column; §2.1
says why. The `no art at all` 3 g/4× cell was cut for time, not for taste.

**Deleting all the art buys 366 ms on a 1.6 Mbps link, 35 ms on 9 Mbps, and 28 ms on a
LAN.** That is the entire prize, and it is the *upper bound* — no option in §3 reaches it.
Option 1 collects 156 of those 366 ms for a generator change; option 1 + 4 collects 290.

The 3 g numbers track bytes almost exactly: 77.4 KiB at 1.6 Mbps is 396 ms of predicted
transfer against 366 ms measured, and 26.3 KiB predicts 135 ms against 156 measured. **This
is a bandwidth cost, not a parse cost** — 4× CPU throttling moves every row by under 21 ms,
inside the run-to-run spread. Half a megabyte of SVG string is cheap for V8 to hold and
expensive for a slow link to carry.

One row does not follow bytes: **option 1 + 4 is *slower* than option 1 alone on the LAN**
(111 ms against 71). That is the dynamic import doing exactly what it says — the boss chunk
cannot start until the entry chunk has executed, so it is one extra serial round trip. With
no latency and no bandwidth limit that round trip is all there is, and it costs 40 ms. On
the links that matter it is repaid several times over (3 g: 3,129 against 3,263), and in the
real game the import is issued during a 20-second muster nobody is waiting on.


### 2.1 Why `TTI` carries no information here

**`longMs` is 0 in every row, so TTI collapses onto `load`.** The `longtask`
PerformanceObserver reports nothing across all 15 cells, even at 4× CPU throttle with 3 MB
of JavaScript to parse. So "TTI-lite" — the first 500 ms window after `load` with no long task — degenerates
to `load` itself, and the TTI column carries no information beyond it. Read `DCL`/`load`, not
`TTI`. Whether that means the work is genuinely chunked below 50 ms or that headless Chrome
under-reports long tasks was not established, and no conclusion here rests on it.

### 2.2 FCP and LCP never fire — and that is the finding

Every row reports FCP 0 and LCP 0. `#root` is still empty 6 s after `load`: with the
third-party origins blocked, `PrivyProvider` never resolves its remote config and `App`
renders nothing. **This app's first paint is gated on a third-party origin, not on its own
bundle.** Shaving the art does not move first paint at all; it moves the point at which the
module graph has finished executing (DCL), which is what the table measures.

That is worth knowing before optimising bytes: a `<div>` in `index.html` that paints the
lobby background and a spinner is worth more perceived load time than every option in §3
combined, and costs nothing.

---

## 3. The options, measured

All figures are the cold-cache **critical path in brotli**, the number Cloudflare actually
puts on the wire.

| option | critical br KiB | vs today | 3 g load | extra reqs | work |
|---|---|---|---|---|---|
| **0. ship as-is** | 695.3 | — | 3,419 ms | 0 | none |
| **1. relative subpath starts** | **669.0** | **−26.3** | **3,263 ms (−156)** | 0 | one generator emitter |
| 2. external `.svg`, fetched | 694.6 (**693.8** measured) | −0.7 | not run | +2 | Scene/Boss become async |
| 3a. rasterise → PNG8 / PNG | 656.3 | −39.0 | not run | +14 | new generator + rig rework |
| 3b. rasterise → lossless WebP | 641.1 | −54.2 | not run | +14 | as 3a, plus a WebP fallback |
| 4. lazy-load the boss until the fight | **672.3** | **−23.0** | not run | +1 (deferred) | one `import()` |
| **1 + 4 together** | **653.4** | **−41.9** | **3,129 ms (−290)** | +1 (deferred) | both of the above |
| *(floor: no art at all)* | *617.9* | *−77.4* | *3,053 ms (−366)* | 0 | delete the art |

### 3.1 Option 1 — relative subpath starts. Take this one.

Both assets are px2svg output: one `<path>` per palette colour, every subpath an
axis-aligned rect written `M<abs x> <abs y>h<w>v<h>h-<w>z`. Absolute coordinates spend 4–7
digits per rect and every rect's prefix is unique, which is the worst possible input for a
match-finding compressor. Re-emitting the *same* subpaths with relative starts (`m<dx> <dy>…`)
spends 1–3 digits and makes long runs literally repeat.

| asset | raw → | gzip → | brotli → |
|---|---|---|---|
| `temple.svg` | 332,218 → 283,442 | 72,377 → 40,370 | 55,205 → **36,255** |
| `parts/boss.svg` | 121,820 → 101,729 | 28,705 → 18,198 | 23,384 → **16,315** |
| `knights.svg` (not shipped yet) | 45,334 → 41,148 | 11,528 → 8,646 | 9,655 → **7,809** |

Rebuilt with both relative (`REL=1 npx vite build -c ../scripts/spike/vite.art.config.ts`):

| critical path | raw KiB | gzip KiB | brotli KiB |
|---|---|---|---|
| today | 3,102.4 | 854.1 | 695.3 |
| relative | 3,015.5 | 801.6 | 669.0 |
| **art cost** | **473.2 (−87)** | **77.4 (−52.5)** | **51.1 (−26.3)** |

**−34% of the art's brotli, −40% of its gzip, −87 KiB of string for the parser to
materialise, for zero product-code change.** The element count, the fills, the
`<g id="part-*">` nesting and the render are untouched, so `Scene.tsx`'s 16-path regex and
its `TEMPLE_PATHS.length !== 16` assert, and `Boss.tsx`'s part groups, all still match.

Verified pixel-identical, not assumed: both forms were expanded back onto a bitmap by the
same rect walker and compared with `ImageChops.difference` — `getbbox() is None` for both
files. A byte saving that moves a pixel is not a saving.

The change belongs in `tools/px2svg`'s emitter, and the assets are regenerated from it. It
must not be applied to the checked-in `.svg` by hand — that is one fact stored twice, this
project's most repeated defect.

### 3.2 Option 2 — external assets. Byte-pointless.

Serving `temple.svg` and `parts/boss.svg` as static files and `fetch()`ing them costs
55,205 + 23,384 = 78,589 B brotli, against 79,258 B for the same content inlined. **0.7 KiB.**
Built and loaded to confirm it (a `dist` with the art stubbed out of the bundle, the two
`.svg` preloaded and fetched): 50 requests, **693.8 KiB on the wire**, against 693.1 for the
shipped inline build.
Cloudflare compresses `image/svg+xml` the same way it compresses `text/javascript`; there is
no byte argument here at all.

What it *does* buy, for the record, since it is the option people reach for first:

- the bytes stop being JavaScript, so they are not parsed, not string-materialised, and not
  retained as two ~500 KB strings on the JS heap;
- the art gets its own cache lifetime instead of dying with the entry chunk's hash on every
  deploy.

Both are real, and neither is worth making `Scene.tsx` and `Boss.tsx` asynchronous — which
means a render gate, a loading state, and two more failure modes on the one layer whose
entire design property (§8.1) is that React never touches it. If the heap or the deploy
churn ever becomes the complaint, revisit; do not do it for bytes.

### 3.3 Option 3 — rasterise. The biggest win, and still not worth it.

Both assets are paletted bitmaps in vector clothing (temple: 49,980 painted px on a 49,980
px canvas, 100% coverage, zero overlap), so rasterising is lossless. Expanded and re-encoded:

| | PNG (optimised) | PNG8 (≤256 colours) | WebP (lossless) |
|---|---|---|---|
| `temple.svg` 210×238 | 57,854 | **18,022** | **15,072** |
| `parts/boss.svg` flattened 230×270 | 17,439 | — | 7,350 |
| boss rig, 13 cropped part PNGs | **21,267** | — | **8,636** |

The rig has to stay separable — §7.3 gives each of the 13 part groups its own promoted
layer and its own transform — so the boss's honest raster figure is the 13-file one, not
the flattened one.

Critical path becomes 656.3 KiB br (PNG8 + PNG rig) or 641.1 (WebP), i.e. **−39.0 or −54.2 KiB**.
Those two are arithmetic over measured file sizes — a stubbed bundle plus images that are
already compressed and that brotli cannot shrink further — not a browser run; the raster
`dist` was built but its load cells were cut for time.
That is the largest saving on the table, and it costs: a new generator, 14 more requests, an
`<image>` per part with its own crop offsets, and a WebP fallback path. Spec §12.4 cut
`tools/gen_temple.py` on frame-time grounds (two harnesses measured rasterising buys 0.30 ms,
inside the between-session drift, and the raster path builds 2.7× slower). **Nothing measured
here overturns that.** 54 KiB is not worth a generator plus a rig rework on a critical path
whose other 618 KiB nobody has touched yet.

### 3.4 Option 4 — lazy-load the boss until the fight. Nearly free.

The temple is on screen from the first frame of the lobby. The boss is not: §1.4 puts the
camera at `k=2, (−256,−512)` through LOBBY and MUSTERING, and §6 gives the muster a
`MUSTER_TICKS = ticks_for(20_000)` = 20-second window before FIGHTING. A dynamic `import()`
of the boss art has that entire window to land, over a link that delivers 23 KiB in 21 ms at
9 Mbps and 118 ms at 1.6 Mbps.

Built and measured, not estimated (`LAZYBOSS=1`, which rewrites `Boss.tsx`'s static `?raw`
import to `await import(...)`): the critical path drops to **672.3 KiB br** and the boss
leaves as its own `boss-Ca6eICJN.js`, 121,850 B raw / **23,420 B brotli**. With option 1 as
well: critical **653.4 KiB br**, boss chunk 101,759 B raw / **16,359 B brotli**.

The cost is one `import()` and the loading state to go with it — the same asynchrony §3.2 argues
against, except here it is paid on a layer that is legitimately absent for the first 20
seconds anyway, and the failure mode (art arrives late) is a boss that pops in during a
muster nobody is watching yet.

**Combined with option 1: critical path 653.4 KiB br, and the art on first load is 35.5 KiB
brotli — temple only — against 77.4 today. −54%.**

---

## 4. Verdict

**The art is not the problem, and it is not bad.** 77.4 KiB brotli on a cold visit, against
617.9 KiB of wallet SDK sitting next to it. A 332 KB SVG sounds alarming and compresses to
54 KiB; that is what a 16-colour bitmap costs however it is spelled.

Do, in this order:

1. **Option 1** — relative subpath starts in `tools/px2svg`'s emitter. −26.3 KiB brotli,
   −52.5 KiB gzip, −156 ms on a 1.6 Mbps link, pixel-identical, no product-code change, no
   new file, no new request. This is the only item here that is unambiguously worth doing.
2. **Fix the three defects in §5.** Each is one line or one file, and each is worth more than
   any option in §3: the cache header costs a round trip on *every* repeat visit, the webfont
   `@import` costs three serial round trips on the first one, and the sourcemaps publish the
   whole source tree.
3. **Option 4** when the boss rig is built, because it is one `import()` on a layer that is
   already absent for 20 seconds.

Do not do options 2 or 3. Do not revisit `MAX_BULLETS`, the S=3 scale, or anything in
`render-scale.md` on bundle grounds — none of them are bundle facts.

---

## 5. Three defects found while measuring, each cheaper to fix than the art is to shrink

### 5.1 Hashed assets are served `max-age=0, must-revalidate`

```
$ curl -sSI https://heartrot.ansht.workers.dev/assets/index-CnRpS8GP.js
cache-control: public, max-age=0, must-revalidate
content-encoding: br
```

Cloudflare Workers static assets default to `max-age=0, must-revalidate`; the `immutable`
treatment is opt-in. Every one of the 45 content-hashed critical files is therefore
revalidated on **every** repeat visit, before anything runs — an HTTP/2-multiplexed
revalidation wave, but still a full round trip to the edge, measured 357–439 ms TTFB from
this box (Ghaziabad → `-SIN`) across 5 samples.

Fix: `app/public/_headers`

```
/assets/*
  Cache-Control: public, max-age=31536000, immutable
```

`app/public/` does not exist yet, so this is a new file rather than an edit. Vite copies
`public/` verbatim into `dist/`, and the file names already carry content
hashes, so this is safe by construction. **One file, and it is worth more to a returning
player than every option in §3.**

### 5.2 15.9 MiB of sourcemaps are published, and public

`app/vite.config.ts` sets `build.sourcemap: true`, and `worker/wrangler.jsonc` publishes
`../app/dist` wholesale. So:

```
$ curl -o /dev/null -w '%{http_code} %{size_download}\n' \
    https://heartrot.ansht.workers.dev/assets/index-CnRpS8GP.js.map
200 1298666
```

286 `.map` files, 15.9 MiB, uploaded on every deploy and readable by anyone. Browsers only
fetch them with devtools open, so this is not a load cost — it is 16 MiB of deploy weight
and the complete original TypeScript source served from the game's own origin.

`sourcemap: 'hidden'` keeps the maps on disk for a symbolicator and drops the
`//# sourceMappingURL` comment; `false` drops them entirely. Either is one word.

### 5.3 The webfont is an `@import` inside the app's own stylesheet

`app/src/styles.css:15`

```css
@import url('https://fonts.googleapis.com/css2?family=Silkscreen:wght@400;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
```

An `@import` at the top of a bundled stylesheet is the latest possible place to discover a
render-blocking resource. The browser cannot see it until `index-DcydMkE8.css` has been
downloaded and parsed, and only then opens a connection to `fonts.googleapis.com`, and only
then a second one to `fonts.gstatic.com`. Three serial round trips, two of them to origins
this project does not control, after the bundle.

Measured from this box: the CSS is 749 B and answers in 182–206 ms TTFB; it declares 19
`woff2` subsets of which Chrome fetches the latin ones, 3.3–15.6 KB each. The bytes are
trivial. The **latency chain** is not: on the 3 g link in §2 that is roughly 900 ms of pure
serialised round trip, against 26.3 KiB of art bytes that option 1 removes for free.

Two fixes, either cheap: hoist it to `<link rel="preconnect">` + `<link rel="stylesheet">`
in `index.html` so it is discovered in the first packet, or self-host the five latin subsets
as same-origin assets (~35 KB) and delete the third-party dependency from the render path
entirely.

This was found because the load harness blocks third-party origins and the blocked request
showed up in the resource list. It is not an art finding; it is here because it costs more
than the art does.

---

## 6. Harness notes and limits

- `scripts/spike/bundle_size.mjs` — raw / `gzip -9` / `brotli q11` over a `dist`, split into
  the critical set (parsed out of `index.html`) and the rest. `.map` excluded.
- `scripts/spike/bundle_load.mjs` — the loopback Cloudflare mimic and the CDP driver. Two
  faults in it produced three wrong versions of §2's table before they were found (§2's
  numbered list); both are now documented in the file itself so the next person does not
  re-derive them.
- `scripts/spike/vite.art.config.ts` — `app/vite.config.ts` + one `load` hook. `STRIP=temple,boss`
  stubs the art; `REL=1` swaps in the relative re-encode; `LAZYBOSS=1` rewrites `Boss.tsx`'s
  static `?raw` import to a dynamic one. It never writes to `app/src`.
- `scripts/spike/art_relpath.py`, `scripts/spike/art_raster.py` — options 1 and 3.

Limits, stated so nobody quotes these further than they reach:

1. **One box, one browser.** Chrome 151 headless on Fedora/X11, dPR 1.0. Firefox and WebKit
   were not measured. Brotli here is `zlib`'s q11; Cloudflare's edge brotli level is not
   published and may differ by a few percent.
2. **The link emulation is CDP's, not a real network.** No packet loss, no DNS, no TLS
   handshake, no HTTP/3, and the server is on loopback. Real 3G is worse than the 3g rows.
3. **Third-party origins are blocked**, so these numbers exclude everything Privy fetches at
   runtime — which, per §2.2, is what actually gates first paint.
4. **`REPS=3`, medians.** Enough to separate 695 KiB from 618 KiB; not enough to argue about
   a 20 ms difference between two rows.
5. **Options 2 and 3 have byte numbers but no load cells.** Option 2's bytes were confirmed
   in the browser (693.8 KiB, 50 requests); option 3's are arithmetic over measured PNG and
   WebP file sizes. Neither was timed, because neither is recommended.
6. **The whole `dist` is a moving target.** It was measured at the commit under this run's
   spec work, not at `ce9b743`; the live deploy is older still and has no art at all.
