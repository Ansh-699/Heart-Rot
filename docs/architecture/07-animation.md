# HEARTROT — Animation Architecture

**Date:** 2026-09-02
**Status:** Contract. Every animated node in the scene is governed by this document.
**Implemented by:** `app/src/render/Arena.tsx`, `app/src/net/predict.ts`,
`app/src/styles.css`. Companion to `08-gate.md` (§5.5 descent), `09-shooting.md`
(§2.5 aim) and `10-boss.md` (§9.2 hazard telegraphs), each of which specifies *what*
moves; this one specifies *how anything is allowed to move at all*.

---

## 0. How the numbers in this document were produced

Every figure below came out of a harness written for this document, not from memory and
not from the existing docs. The harness is committed, in this repo's own spike convention. It reads the real
`assets/sprites/*.svg` and writes its generated pages to `$TMPDIR/heartrot-anim`, so
nothing it produces lands in the tree:

```
node scripts/spike/perf_anim_build.mjs             # one page per condition
node scripts/spike/perf_anim_frames.mjs  <conds>   # frame cadence, boot time
node scripts/spike/perf_anim_raster.mjs  <conds>   # devtools.timeline trace, summed by event
node scripts/spike/perf_anim_cascade.mjs           # §3.1, two writers on one node
node scripts/spike/perf_anim_origin.mjs            # §3.3, SVG transform-origin
```

Conditions: `no-bg bg-inline bg-image raf-parts raf-parts-wc bg-image-parts css smil
smil-wc seats-nowc seats-use seats-use-nowc layout-probe`.

- **Browser:** Chrome/151.0.7922.137, `--headless=new`, on this dev box.
- **Scene:** the real repo assets, not stand-ins. `assets/sprites/temple.svg` inlined as
  the background (16 paths, 22,195 subpaths), `assets/sprites/parts/boss.svg` inlined as
  the boss (13 `<g id="part-*">` groups, 74 paths, 7,697 subpaths), 20 seat groups each
  holding a clipped `assets/sprites/knights.svg`, and 128 bullet rects. 744 DOM elements,
  which is within a few nodes of what the finished scene will hold.
- **Load:** a rAF loop translating all 128 bullets and all 20 seats every frame, which is
  exactly what `Arena.tsx`'s loop and `useSeatInterpolation` already do. Conditions differ
  only in what is added on top.
- **Metric:** total `RasterTask` wall time from a `disabled-by-default-devtools.timeline`
  trace over a 7.5 s window, normalised below to **milliseconds of raster per animated
  frame**. The rAF conditions animate for 5 s (≈300 frames); the CSS and SMIL conditions
  keep running for the whole 7.5 s (≈450 frames), so the raw totals are *not* comparable
  and the normalised column is the one to read.

**The caveat that matters:** *no condition dropped a frame.* Every run reported 60 fps,
p50 16.7 ms, p95 ≤ 16.8 ms, and at most one frame over 20 ms in a 5 s window. Chrome
rasters off the main thread and this box has cores to spare. The raster figures are
**work performed**, not **jank observed**. They are the right metric anyway: on a
four-core laptop or a phone that work comes out of the same budget as everything else,
and this project already has a measured precedent for exactly that — `styles.css:429`
records the same DOM running at 143 fps on a composited property and 74.8 fps on a
non-composited one.

Asset complexity, measured with `re.findall` over the files themselves:

| file | bytes | gzip | paths | subpaths | path commands |
|---|---|---|---|---|---|
| `temple.svg` | 332,218 | 72,389 | 16 | 22,195 | 110,975 |
| `boss.svg` | 118,187 | 28,402 | 13 | 7,589 | 37,945 |
| `parts/boss.svg` | 121,820 | 28,717 | 74 (in 13 `<g>`) | 7,697 | 38,485 |
| `knights.svg` | 45,334 | 11,540 | 23 | 3,038 | 15,190 |
| `room.svg` | 103,214 | 24,511 | 52 | 6,763 | 33,815 |
| `ref-user-temple.svg` | 836,725 | 91,016 | **25,378** | 25,378 | 126,890 |

Two things fall out of that table immediately. The "measured ceiling of 7,589 rects" this
project has been carrying as folklore is not folklore — it is exactly the subpath count of
`boss.svg`, so that measurement was the boss and nothing else. And every converted file is
**one path per colour**: `temple.svg`'s 16 paths are 16 palette entries, not 16 objects.
Nothing in `temple.svg`, `boss.svg` or `knights.svg` can be animated part-by-part. Only
`assets/sprites/parts/boss.svg`, with its 13 named groups, is riggable, and it is the file
the renderer must load.

---

## 1. The line

### 1.1 The rule, in one sentence

> **Chain state decides where things are and what state they are in. It never decides
> when a frame is drawn, and no frame ever waits for it.**

The corollary is the one that gets broken: a cosmetic animation that cannot start until a
notification arrives is not cosmetic, it is chain-derived with extra steps, and it will
stutter at exactly the measured 68.4 % of `Players` notifications that carry no change.

### 1.2 Three classes, not two

The brief asks for two — derived and cosmetic. Writing the inventory out produces a third,
and it is the one that carries most of this scene:

| class | source of truth | who runs the tween | blocked on a notification? |
|---|---|---|---|
| **DERIVED** | a chain number, per frame | the rAF loop in `Arena.tsx` | no — it extrapolates or predicts between ticks |
| **SEEKED** | a chain number that *is* a clock | a CSS/WAAPI animation whose `currentTime` the chain sets | no — it runs on its own between ticks |
| **COSMETIC** | nothing | a CSS/WAAPI animation, started once | never |

**SEEKED** is the class that makes the rest of this document short. Every wind-up,
telegraph, countdown and bar in this game is a chain value that counts monotonically toward
a deadline: `attack_timer` toward a volley, `fuse` toward a hazard landing
(`10-boss.md` §3.2), `respawn_at_tick` toward a respawn, `tick` toward `enrage_at_tick`,
the muster deadline toward `FIGHTING` (`08-gate.md` §5.5). None of them needs a frame loop.
Build the animation once at its true duration, and on each notification set
`animation.currentTime` to the elapsed time the chain reports. Between notifications it
runs at 60 fps on the compositor, for free; on each notification it corrects by whatever
the jitter was. It is smooth, it is self-healing, it is composited, and it costs no rAF
callback.

That leaves rAF owning exactly what it owns today — bullet extrapolation and the local
seat's chase — and nothing else may be added to it.

### 1.3 The complete inventory

Every moving thing in the finished scene. `class` is from §1.2. "node" names the element
whose transform or opacity the animation writes; §3.2 explains why they are all different
elements.

**Environment**

| thing | class | source | node |
|---|---|---|---|
| temple background | none | — | static `<g>`, built in a `useMemo`, never re-rendered |
| pit rim, foreground occluders | none | — | static |
| cavern darkening during the descent | SEEKED | muster deadline (`08-gate.md` §5.5) | one `opacity` on an overlay above the background |
| ambient dust, torch flicker, rim shimmer | COSMETIC | — | dedicated `<g>`, capped node count |
| parallax depth offset | COSMETIC | — | per-layer `<g>`; the camera does not move, so this is a slow drift, not a follow |

**Boss**

| thing | class | source | node |
|---|---|---|---|
| boss position | DERIVED, but static | `boss.x`, `boss.y` | React-rendered `transform` attribute on the boss root. Fixed at top centre, so this node never changes after spawn and costs nothing |
| descent on spawn | SEEKED | muster deadline | `#boss-descent`, a child of the root |
| idle breathing / sway | COSMETIC | — | `#boss-idle`, a child of the descent node |
| per-part damage recoil | one-shot from an **event** (§4.2) | `parts[i]` decreased | that part's `<g id="part-*">` |
| per-part destruction | one-shot from a **fact** (§4.2) | `parts[i] === 0` | that part's `<g>`, plus a resting `data-dead` attribute |
| part resting appearance | DERIVED, not animated | `parts[i] / partsMax[i]` | React attribute on the part `<g>` |
| vent opening | one-shot from a **fact** | `vent_open` 0→1 | `#part-core` |
| vent idle pulse while open | COSMETIC | — | a child of `#part-core` |
| core hit | one-shot from an **event** | `core_hp` decreased | `#part-core` |
| volley wind-up | SEEKED | `attack_timer` vs `VOLLEY_INTERVAL_TICKS` | the firing thorn's `<g>` |
| hazard telegraph (SLAM/CRUSH/SANCTUARY/RAIN) | SEEKED | `fuse` vs `TELEGRAPH_TICKS` (`10-boss.md` §3.2) | one `<g>` per hazard slot |
| enrage | one-shot from a **fact**, then a resting palette | `tick >= enrage_at_tick` | `#boss-idle` and a root `data-enraged` |
| death | one-shot from a **fact** | `core_hp === 0` | boss root |

**Players**

| thing | class | source | node |
|---|---|---|---|
| local seat position | DERIVED | `predictor.self`, chased at `MOVE_MS` | the seat `<g>` — **owned by the rAF loop, `Arena.tsx:193`** |
| remote seat position | DERIVED | `SeatTrack` interpolation | the seat `<g>` — **owned by `useSeatInterpolation`** |
| walk cycle | COSMETIC | a *client-side* moving/idle boolean | `<g class="gait">`, a child of the seat `<g>` |
| facing / aim pose | DERIVED, not animated | `slot.facing` (or the i8 aim pair of `09-shooting.md` §2.3) | a React attribute on a child of `.gait` |
| hit flash | one-shot from an **event** | `slot.hp` decreased | a child of the seat `<g>` |
| death | one-shot from a **fact** | `slot.deaths` increased | the seat's sprite child |
| respawn countdown | SEEKED | `respawn_at_tick - tick` | a ring, child of the seat `<g>` |
| respawn arrival | one-shot from a **fact** | `hp > 0` at a given `deaths` | the seat's sprite child |
| your own ring | none | `seat === localSeat` | static |
| gate glow underfoot | SEEKED level + COSMETIC pulse | predicted position vs `GATE_MIN`/`GATE_MAX` (`08-gate.md` §5.1) | the gate `<g>` in the map layer |

**Projectiles and screen**

| thing | class | source | node |
|---|---|---|---|
| bullet position | DERIVED | `x + dx·f`, `f = tickAlpha` | the bullet node — **owned by the rAF loop, `Arena.tsx:185`** |
| muzzle flash | one-shot from an **event** | a pool slot went free→active | a separate flash layer, never the bullet node |
| screen shake | COSMETIC | — | a `<div>` **above** the `<svg>`, so it touches nothing the loop owns |
| damage numbers, hit markers | one-shot from **events** | the same events as above | an HTML overlay |
| phase transitions | one-shot from **facts** | `arena.phase` | the screen shell |

### 1.4 What is deliberately not on this list

There is no animation whose trigger does not already exist in the account bytes. That is
the finding of §6, and the inventory above is its proof: nine part HP values, a core HP, a
vent flag, an attack timer, a target seat, twenty seats' hp / deaths / respawn tick /
facing / zone, a phase, a tick, an enrage tick, and 128 bullet slots are enough to drive
every entry. Nothing here asks the chain for a new byte.

---

## 2. SMIL vs CSS vs rAF, measured

### 2.1 The measurement

All figures are `RasterTask` wall time from the trace described in §0, normalised per
animated frame at 60 fps. Three runs of most conditions; the range is given where they
differed materially.

| condition | what it adds to the load | raster ms **per animated frame** |
|---|---|---|
| `no-bg` | nothing (no background at all) | 0.07 |
| `bg-inline` | the 22,195-subpath temple, static | 0.13 – 0.37 |
| `bg-image` | the temple as one rasterised `<image>` | 0.12 |
| `css` | CSS `@keyframes` translating the 13 boss part groups | **0.09 – 0.20** |
| `smil-wc` | SMIL `<animateTransform>` on the same 13 groups, **+`will-change`** | **0.12 – 0.18** |
| `raf-parts-wc` | rAF writing `style.transform` on the same 13, **+`will-change`** | **0.11 – 0.25** |
| `raf-parts` | rAF writing `style.transform` on the same 13, no `will-change` | **5.4 – 9.0** |
| `bg-image-parts` | the same, over a rasterised background instead | 5.0 – 8.5 |
| `smil` | SMIL on the same 13, no `will-change` | **5.6 – 12.5** |
| `seats-use` | 20 seats as `<use>` of one shared `<defs>` knight, promoted | 0.12 – 0.13 |
| `seats-nowc` | **today's `Arena.tsx`**: 20 inlined seat groups moving, no `will-change` | **9.7 – 13.4** |
| `seats-use-nowc` | the same as `<use>` of a shared def, no `will-change` | **9.5 – 11.0** |

### 2.2 What that actually says

**It is not a question of SMIL versus CSS versus rAF.** Every technique is cheap when the
animated node has a composited layer and every technique is catastrophic when it does not.
The spread within a technique is 30–60×; the spread between techniques, holding promotion
constant, is under 2×.

- **Sharing geometry with `<use>` changes nothing about raster cost.** `docs/art/knights.md`
  §8.2 flags this as an explicit unknown — *"I did not measure this. Whether a browser
  rasterises a `<use>`'d `<g>` once and blits it…"* — so the harness reproduces that
  document's exact structure: the knight geometry once in `<defs>`, twenty `<use>`
  references inside the seat groups. Measured against the same scene with the geometry
  inlined per seat: **37/39 ms against 43/41 ms promoted, and 2,853/3,297 ms against
  2,910/2,896 ms unpromoted.** Within run-to-run noise on both sides. Chrome is not
  blitting a shared instance more cheaply, and it is not paying extra for the indirection
  either — **promotion is the only variable, and `<use>` is neutral to it.**

  `<use>` still wins on the things it was chosen for: DOM elements fell from **744 to 329**
  for the identical scene, which is parse time and memory, not frame time. Take it for
  those reasons.
- CSS `@keyframes` on a `transform` is promoted **automatically** — Chrome recognises a
  composited-property animation and gives it a layer with no author intervention. That is
  the whole of why `css` measured 0.09 ms/frame with nothing declared.
- SMIL and rAF are promoted only if you ask, with `will-change: transform`. Ask, and SMIL
  goes from 12.5 to 0.18 (a 69× drop) and rAF from 9.0 to 0.25 (a 36× drop).
- The **background form makes almost no difference**. This was the hypothesis going in and
  it is wrong: inline 22,195-subpath SVG versus a rasterised `<image>` measured 5.0–8.5
  against 5.4–9.0 ms/frame under the same unpromoted animation, a 5–8 % gap, and the two
  orderings swapped between runs. An early single-run reading of 1,433 vs 2,698 ms looked
  like a 47 % win for the raster and did not survive repetition. **Recorded as a negative
  result: rasterising the temple background buys nothing measurable in raster cost.**

  This does not argue against `docs/art/temple-scene.md` §5.1, which rasterises
  `temple.svg` to `app/src/render/temple.png` in `tools/gen_temple.py` in order to remap
  the 16 palette entries into a cold grade at generation time. That is a different and
  sufficient reason, and it stands on its own. The finding here is only that
  **rasterisation must not be justified by frame cost**, because there is none to recover —
  which also means the inline-SVG form stays viable if the grade is ever solved another
  way. Whichever form ships, the background is a static node nothing animates, and §2.3 is
  where the frame budget actually goes.
- The background is also free at boot. Time from navigation to the first rAF callback was
  15–89 ms across every condition including `no-bg`, with no ordering that survived a
  repeat. Parsing 332 KB and 110,975 path commands is inside the noise.

### 2.3 The live defect this uncovered

`app/src/render/Arena.tsx:326`:

```tsx
<g key={slot.seat} ref={predicted ? selfRef : seats.ref(slot.seat)}>
```

The bullet rects three blocks below it carry `willChange: 'transform'`
(`Arena.tsx:398`). **The twenty seat groups carry nothing**, and both the rAF loop
(`Arena.tsx:201`) and `useSeatInterpolation` (`predict.ts:461`) write `style.transform`
to them every single frame.

Today this is nearly free: a seat is a circle, a line and two 4-unit rects over a flat
generated tile path, so the damage rectangle is small and cheap to re-raster. The moment
`knights.svg` goes into that group and `temple.svg` goes underneath it, it becomes the
`seats-nowc` row of the table above: **9.7–13.4 ms of raster per frame, against 0.12–0.37
for the identical scene with the declaration present.**

Reproduced five times across two seat structures, inlined and `<use>`d, over the same
7.5 s window:

| structure | no `will-change` | with `will-change` | ratio |
|---|---|---|---|
| geometry inlined per seat | 4,021 / 3,245 / 3,054 / 2,910 / 2,896 ms | 110 / 53 / 42 / 43 / 41 ms | 36× – 73× |
| `<use>` of a shared `<defs>` | 2,853 / 3,297 ms | 37 / 39 ms | 77× – 85× |

`<use>` does not rescue it; §2.2 explains why.

> **Required change, one line:** the seat `<g>` gets `style={{ willChange: 'transform' }}`,
> for the same reason and in the same words as the bullet rect above it. This is the
> single highest-value line in the whole animation workstream and it is not optional once
> the art lands.

### 2.4 The rules

1. **Any node whose `transform` or `opacity` changes at frame rate must have a composited
   layer.** Declare `will-change: transform` on it, or animate it with CSS/WAAPI, which
   declares it for you.
2. **Animate `transform` and `opacity` and nothing else.** `styles.css:429` already records
   this project measuring 143 fps against 74.8 fps for exactly this choice on this boss.
   `x`, `y`, `width`, `d`, `fill`, `stroke-width`, `filter` are all off the table inside a
   frame; they are fine as one-off React attribute writes at 2.5 Hz.
3. **The layer count is not free either.** 128 bullets + 20 seats + 13 boss parts + a
   handful of effect layers is ~170 promoted layers, which measured fine here. Do not
   promote a node "just in case": an unmeasured `will-change` buys nothing and costs
   texture memory.

   Specifically on the background: promoting it buys **nothing measured**, because the
   `bg-inline` / `bg-image` pair shows the background is not what is being re-rastered
   under an animating sibling — the animating node itself is. The static
   `transform: translateZ(0)` on `.scene-bg` in `docs/art/temple-scene.md` §4 is therefore
   harmless *as one PNG texture* and should stay if that design ships. It would not be
   harmless on a 22,195-subpath inline SVG layer, which is a large texture that never
   changes. Either way it is a promotion hint written once in CSS, and that doc's own
   warning applies unchanged: if idle camera drift is ever added, the drift loop becomes
   that node's sole owner and the CSS `transform` must be deleted in the same commit.

### 2.5 SMIL is forbidden

Not on taste. On three grounds, in order of weight:

1. It is the only technique in the table that is catastrophic **by default** and also
   requires a manual `will-change` to fix — CSS is safe by default, rAF is at least
   explicit about being manual. SMIL is the worst of both.
2. It introduces a second animation timeline that JavaScript cannot seek. §1.2's SEEKED
   class rests entirely on setting `animation.currentTime` from a chain value. SMIL's
   `beginElement()` / `setCurrentTime()` operate on the document timeline, not per element,
   so the one pattern this scene most needs cannot be expressed in it.
3. It puts animation definitions inside the asset files, which are **generated** from
   `tools/px2svg.py` and `tools/svg_slice.py`. Hand-adding `<animateTransform>` to
   `assets/sprites/parts/boss.svg` would be hand-editing a generated file, which this
   project's own README calls its most repeated defect.

The measured `smil-wc` row exists to make the first point honest: SMIL *can* be made fast.
It is still forbidden, for reasons 2 and 3.

---

## 3. Node ownership

### 3.1 One writer per node, and here is what happens when there are two

The existing rule — "never put a transform on a node the frame loop owns, and never let two
writers own one node's transform" — is usually stated as a discipline. It is a hard
mechanical fact, and the failure is silent. Measured with `scripts/spike/perf_anim_cascade.mjs`:

```
ONE-NODE   x=8.0   y=33.0        // inline translate(100px,0) + a WAAPI translateY animation
TWO-NODES  x=108.0 y=33.0        // outer <g> inline translate, inner <g> WAAPI animation
solo inline style still: translate(100px, 0px)
```

On the single node, `style.transform = 'translate(100px, 0px)'` was **discarded entirely**
— `x` stayed at the page origin. The element's inline style still reads back as
`translate(100px, 0px)`; the DOM says one thing and the pixels say another. This is the
CSS cascade working as specified: animation effects apply above the inline-style origin, so
a `transform` animation replaces the whole property, not just the axis it names.

Translated into this codebase: **put a CSS or WAAPI `transform` animation on a seat `<g>`
or a bullet node and that seat stops tracking the chain.** No error, no warning, no
exception. It renders a knight bobbing gently in the corner of the arena forever while the
player presses keys.

On two nested nodes, both writers composed correctly: `x=108` is the outer translate,
`y=33` is the inner animation. Nesting is not a style preference; it is the only
construction that works.

### 3.2 The layer stack

Every animated object is a chain of single-purpose nodes, outermost first. One writer per
line, named.

**A seat** (`Arena.tsx:326`):

```
<g>                      transform  ← rAF loop (local) or useSeatInterpolation (remote). ONLY.
                                      + will-change: transform            (§2.3)
  <g class="gait">       transform  ← CSS @keyframes, walk cycle. Toggled by class.
    <g data-facing=..>   transform  ← React attribute. A pose/flip, never tweened.
      …knight paths…
  <g class="fx">         opacity/transform ← WAAPI one-shots: hit flash, death.
  <g class="respawn">    a SEEKED ring.
```

**The boss** (`Arena.tsx:265`):

```
<g id="boss">            transform  ← React attribute from boss.x/boss.y. Static; no loop.
  <g id="boss-descent">  transform  ← SEEKED from the muster deadline (08-gate §5.5).
    <g id="boss-idle">   transform  ← CSS @keyframes, breathing. Cosmetic.
      <g id="part-crown" data-dead>  transform ← WAAPI one-shots + will-change
        …paths from parts/boss.svg…
      … 12 more part groups …
```

`08-gate.md` §5.5 says "the boss descends by `transform` on the boss group. That group is
the frame loop's, and the frame loop's alone." That is compatible with the stack above and
this document makes it precise: the descent is its own node, `#boss-descent`, and the
descent is SEEKED rather than rAF-driven, so the frame loop never touches the boss at all.

**A bullet** (`Arena.tsx:382`): stays a bare `<rect>` owned outright by the rAF loop. It has
no children and needs none — an 8×8-unit object on a 1024-unit stage does not need a trail.
If a bullet cosmetic is ever genuinely wanted, the node becomes a `<g>` with the loop owning
the `<g>` and the cosmetic living inside it, and `nodes.current` changes from
`Map<number, SVGRectElement>` to `Map<number, SVGGElement>`. Do not do this speculatively.

**Screen shake** lives on the `<div>` at `Arena.tsx:242`, above the `<svg>`. It must never
be a transform on the `<svg>` or on any group inside it, because every node inside is
already spoken for.

### 3.3 `transform-box`, which will bite exactly once

Measured with `scripts/spike/perf_anim_origin.mjs`, on a `<g>` inside a `viewBox="0 0 230 270"` sprite:

```
default transform-box (view-box):   x=-30.0 y=150.0   ← rotated off the canvas
fill-box + transform-origin center: x=165.0 y=45.0    ← rotated in place
computed transform-box on the <g>:    view-box
computed transform-origin on the <g>: 0px 0px
```

An SVG element's default `transform-box` is `view-box` and its resolved `transform-origin`
is `0px 0px` — **the sprite's top-left corner**, which for
`assets/sprites/parts/boss.svg` is 115 units left and 135 units above the boss's own
anchor (`hitboxes.ts:34`). A "the crown shakes" animation written without this lands the
crown somewhere else in the arena.

> Every part-local rotate or scale carries `transform-box: fill-box; transform-origin:
> center` (or an explicit origin). Pure translates are unaffected and need neither.

---

## 4. Chain events into one-shot animations, exactly once

This is the part that is easy to get subtly wrong, so it is specified as mechanism, not as
advice.

### 4.1 What is duplicating

Three independent sources, and a correct design survives all three:

1. **The Magic Router delivers every notification twice.** Measured property of the
   transport (`subscribe.ts` header). Both copies decode to byte-identical payloads.
2. **68.4 % of `Players` notifications during a fight carry no position change at all**
   (`predict.ts:304`). `boss_tick` rewrites the whole account every 100 ms for collisions
   and respawns, and the ER notifies a written account whether or not its bytes changed.
3. **React re-renders on every accepted update.** `store.ts` builds a new state object per
   `setWorld`, so any `useEffect` keyed on the `boss` or `players` object identity runs on
   every notification, duplicates included. React 18 StrictMode adds a fourth in
   development by double-invoking effects on mount.

What is *not* happening, and matters because it narrows the problem: **reordering within a
session.** All three accounts arrive over one ordered WebSocket, and the only other writer
is `snapshot()`, whose `fresh` guard (`subscribe.ts:201`, `:270`) already refuses to let a
snapshot overwrite a kind that has seen a live notification since the socket opened. So
payloads arrive in chain order, possibly twice, possibly unchanged, and after a reconnect
possibly with a gap. Design against those and nothing else.

### 4.2 Facts and events

> **A fact is a state the world stays in. An event is a beat the world passes through.**

They need different machinery and mixing them up is the whole bug.

- **Fact:** part 3 is destroyed. The vent is open. Seat 7 has died four times. The boss is
  enraged. The match is `SETTLING`. These are readable from any single payload, they never
  un-happen within an incarnation, and a client that connects late must still end up in the
  right state.
- **Event:** part 3 took damage. A volley fired. A bullet spawned in slot 12. These leave no
  trace in the next payload; the only evidence they occurred is that two consecutive
  payloads differ. Missing one is invisible, and missing one is *acceptable* — a hit flash
  you did not see is not a wrong world.

### 4.3 Facts: the latch

```ts
// app/src/render/effects.ts
/**
 * Fire `run` at most once per key. The key is a pure function of the authoritative
 * payload, so a duplicate notification produces a key that is already in the set and
 * nothing fires twice.
 */
export function useLatch(incarnation: number) {
  const fired = useRef(new Set<string>());
  const era = useRef(incarnation);
  if (era.current !== incarnation) {
    era.current = incarnation;
    fired.current.clear();
  }
  return useCallback((key: string, run: () => void) => {
    if (fired.current.has(key)) return;
    fired.current.add(key);
    run();
  }, []);
}
```

That is the entire mechanism. Ten lines, no library, no event bus, no reducer. **All of the
difficulty is in choosing the key**, and the key rules are non-negotiable:

1. **The key is a pure function of the payload.** No `Date.now()`, no arrival counter, no
   object identity, no `useRef` sequence number. If two byte-identical payloads can produce
   two different keys, the latch is decoration.
2. **The key changes exactly when the fact changes, and never changes back.** Derive it from
   a monotone field. `deaths` only increases. `parts[i]` only decreases. `vent_open` only
   goes 0→1. `tick` only advances.
3. **The key is namespaced by `arena.incarnation`**, and the set is cleared when that
   number changes (above). This is what bounds the set and what makes a re-fought boss
   re-fire its destruction animations.

Worked keys:

| fact | key | why it is monotone |
|---|---|---|
| part *i* destroyed | `` `part:${inc}:${i}:dead` `` | fires when `parts[i] === 0`; `parts[i]` never rises within an incarnation |
| vent opened | `` `vent:${inc}` `` | `vent_open` is recomputed each tick but only ever crosses 0→1 as the shell drops |
| boss enraged | `` `enrage:${inc}` `` | `tick >= enrage_at_tick`, and `tick` advances |
| boss died | `` `core:${inc}:dead` `` | `core_hp === 0` |
| seat *s* died | `` `death:${inc}:${s}:${slot.deaths}` `` | `deaths` is saturating-increment, one per death (`state.rs:729`) |
| seat *s* respawned | `` `respawn:${inc}:${s}:${slot.deaths}` `` | latched when `hp > 0 && deaths > 0`; the same `deaths` value cannot recur |
| phase entered | `` `phase:${inc}:${arena.phase}` `` | `PHASE_EDGES` (`state.rs:431`) is a DAG within an incarnation |

Set size is bounded by construction: 9 part keys + 1 vent + 1 enrage + 1 core + 6 phases +
one key per seat per death. A 20-player raid that dies 10 times each holds 218 strings.

**The property that makes a latch the right tool and not merely a de-duplicator:** it is
correct across a reconnect. A player who was disconnected for four seconds while parts 3
and 5 were destroyed reconnects, receives a snapshot, and fires both one-shots *late*
rather than never. That is the right failure — the resting state and the animation agree.
A diff-based trigger cannot do this, which is why facts do not use one.

### 4.4 Events: the diff, and the resync gate

Events are diffed against the previous payload the renderer actually consumed:

```ts
const prev = useRef<BossAccount | null>(null);
const synced = useRef(false);        // false until we have two consecutive live payloads
useEffect(() => {
  const before = prev.current;
  prev.current = boss;
  if (!synced.current) { synced.current = health === 'live'; return; }
  if (before === null) return;
  for (let i = 0; i < boss.parts.length; i++) {
    if (boss.parts[i] < before.parts[i]) flashPart(i);   // an event
  }
}, [boss, health]);
```

Three properties, each earned:

- **Duplicate-proof for free.** A duplicate payload is byte-identical, so
  `boss.parts[i] < before.parts[i]` is false and nothing fires. This is the same reasoning
  `predict.ts:360` already relies on for seat tracks, and the same reasoning `10-boss.md`
  §3.3 relies on for `fuse`. It is a general property and it should be stated as one: **a
  diff against the last consumed payload is inherently idempotent under duplicate
  delivery.** The duplicate problem is a red herring for events; the real problems are the
  next two.
- **`synced` is the one that is easy to miss.** After a reconnect or a watchdog
  resnapshot (`subscribe.ts:384`), `prev` is stale by however long the outage was —
  measured at 1,681 ms for a reconnect, four crank ticks. Diffing against it fires a burst
  of flashes for damage that landed while the screen was frozen. The gate suppresses
  exactly one payload: the first one after `health` returns to `live`. Set `synced.current
  = false` from the `onHealth` callback whenever health leaves `'live'`.
- **StrictMode is covered.** A dev remount resets both refs, so the first payload after it
  is suppressed by the same gate. No special case.

### 4.5 Seeked animations: dedupe on value, not on arrival

A SEEKED animation is created once and re-seeked from the chain:

```ts
const applied = useRef(-1);
useEffect(() => {
  if (boss.attackTimer === applied.current) return;   // ← the whole duplicate guard
  applied.current = boss.attackTimer;
  windup.currentTime = (VOLLEY_INTERVAL_TICKS - boss.attackTimer) * TICK_MS;
}, [boss]);
```

The guard is not optional and the reason is specific to this transport. `currentTime` is
derived from the chain value *and* implicitly from the moment of arrival, because the
animation keeps running after you set it. A duplicate arriving 20 ms after the original
carries the same `attack_timer` and would rewind the wind-up by 20 ms — a visible hitch on
a 3.2 s telegraph, arriving twice a second. **Apply a seek only when the value changed.**

For the same reason, never *drive* a SEEKED animation from `arena.tick` alone when a
purpose-built countdown exists. `fuse` (`10-boss.md` §3.2), `attack_timer` and
`respawn_at_tick` are all single fields that carry the whole remaining window, so the
animation cannot be skewed against a separately-delivered clock.

### 4.6 One-shots are played with WAAPI, not with a CSS class

```ts
part.animate(
  [{ transform: 'translate(0,0)' }, { transform: 'translate(6px,-4px)' }, { transform: 'translate(0,0)' }],
  { duration: 180, easing: 'ease-out' },
);
```

`Element.animate()` because it is the lazy correct answer: it is auto-promoted like a CSS
keyframe animation (§2.2), it cleans itself up with no `animationend` listener, it needs no
"remove the class, force a reflow, re-add the class" restart hack, and **simultaneous
one-shots stack on the animation effect stack instead of fighting over one
`style.transform`**. Two bullets hitting the crown in one tick produce two overlapping
recoils, not one that cancels the other.

The one-shot never carries information. The resting appearance of a destroyed part is a
React-rendered attribute driven by `parts[i] === 0`, exactly as `Arena.tsx:279` already
does it. The animation plays the transition; the attribute *is* the state. A player who
reloads mid-fight sees the correct dark part with no animation, and that is correct.

### 4.7 The rule, one line

> **Facts latch on a key derived from the payload. Events diff against the last consumed
> payload behind a resync gate. Continuous chain clocks seek an animation, and seek only
> when the value changed. Nothing anywhere counts notifications.**

---

## 5. `prefers-reduced-motion`

### 5.1 One resolver, two mechanisms

`usePrefersReducedMotion` (`Arena.tsx:453`) stays the **only** place JavaScript reads the
media query, and it is exported so nothing else re-implements it — the reasoning
`predict.ts:427` already gives for passing `reduced` into `useSeatInterpolation` rather than
resolving it twice.

CSS-declared animation gates itself in CSS, with `@media (prefers-reduced-motion: reduce)`
blocks beside the rules they cancel, matching the two blocks `styles.css` already carries
at `:553` and `:764`. The two mechanisms cannot disagree — they read the same OS setting —
and neither needs to know about the other.

**Cancel by not starting.** `animation: none`, or never calling `.animate()`. Never
`animation-duration: 0.01ms`: a running-but-instant animation still costs style recalc and
still holds a composited layer, which is the cost this is supposed to remove.

### 5.2 Per class

| animation | reduced-motion behaviour | why |
|---|---|---|
| bullet extrapolation | already correct: React writes the published position and the loop's bullet half does not run (`Arena.tsx:180`) | unchanged |
| remote seat interpolation | already correct: `alpha` is forced to 1, so each seat snaps to each published position (`predict.ts:451`) | unchanged |
| local seat chase | already correct: the step becomes `Infinity`, which is a snap (`Arena.tsx:200`) | unchanged |
| **screen shake** | **off, unconditionally** | the only genuinely vestibular effect in the scene. No reduced-intensity variant, no opt-in. Off. |
| parallax / camera drift / 3D ambient motion | off; layers hold their resting offsets | large-field motion is the second vestibular trigger |
| boss breathing, idle sway, vent pulse, dust, flicker | off | pure decoration, nothing is lost |
| walk cycle | off; the sprite holds its idle pose. Facing still applies. | facing is information; the gait is not |
| part destruction one-shot | the recoil and fling go. A ≤150 ms `opacity`/`fill` cross-fade to the destroyed appearance stays. | the *information* must survive; opacity and colour are not vestibular. Translate, scale and rotate all go. |
| hit flash, muzzle flash, damage numbers | kept, as opacity only, ≤150 ms, no movement | these are feedback, not decoration; removing them removes the ability to tell you were hit |
| vent opening | instant state change plus the same ≤150 ms fade | as above |
| SEEKED telegraphs: volley wind-up, hazard `fuse`, respawn ring, enrage bar, muster countdown | **kept, and they must be** | a telegraph is the game telling you where the damage lands. Render it as a filling shape or a colour ramp rather than an approaching object, and never as a shape moving toward the player. |
| descent on spawn | reduced to a fade, not a fall | it is cosmetic, but going straight to "boss present" with no transition reads as a bug |
| phase transition wipes | instant | — |

### 5.3 The rule that governs the table

> **No information may exist only in motion.** Anything a player needs — a part is dead, a
> hazard is about to land, you took damage, three seconds until you respawn — has a static
> reading: a colour, an attribute, a filled proportion, a number. Motion is allowed to be
> the *nicest* way to read it and never the only way.

Applied honestly this makes the reduced-motion pass cheap, because it is the same
discipline that makes the scene readable at a glance on a dim laptop screen, which
`sprites.ts:77` already commits to.

---

## 6. What must be on chain, and what must not

### 6.1 The animation workstream adds zero bytes to any account

This is the strongest claim in the document, so here is the field-by-field check. Every
trigger in §1.3, and the field it reads:

| trigger | field | account | exists today? |
|---|---|---|---|
| boss position | `Boss.x`, `Boss.y` | Boss | yes, `state.rs:629` |
| part damage, part destruction, part resting state | `Boss.parts[9]`, `Boss.parts_max[9]` | Boss | yes, `state.rs:638` |
| vent open, vent pulse | `Boss.vent_open` | Boss | yes, `state.rs:624` |
| core hit, boss death | `Boss.core_hp`, `core_hp_max` | Boss | yes, `state.rs:632` |
| volley wind-up | `Boss.attack_timer` vs `VOLLEY_INTERVAL_TICKS` (`tick.rs:155`) | Boss | yes, `state.rs:626` |
| who the boss is looking at | `Boss.target_seat` | Boss | yes, `state.rs:628` |
| player position, walk trigger | `PlayerSlot.x/y` + local prediction | Players | yes |
| facing / aim pose | `PlayerSlot.facing` | Players | yes |
| hit flash, death, dead pose | `PlayerSlot.hp`, `hp_max` | Players | yes |
| death one-shot key | `PlayerSlot.deaths` | Players | yes, `state.rs:729` |
| respawn countdown | `PlayerSlot.respawn_at_tick` vs `Arena.tick` | Players + Arena | yes |
| lobby / arena state, gate crossing | `PlayerSlot.zone` | Players | yes |
| bullet motion, muzzle flash | `Arena.bullets[128]` | Arena | yes |
| hazard telegraphs | `Bullet.active`/`fuse`/`radius8`/`arg` | Arena | `10-boss.md` §3.2, a rename, no growth |
| enrage | `Arena.tick` vs `Arena.enrage_at_tick` (`init.rs:190`) | Arena | yes |
| phase transitions, gate/waiting/spawn | `Arena.phase`, `seat_occupied`, `alive_count` | Arena | yes |
| incarnation reset (§4.3) | `Arena.incarnation` | Arena | yes |
| outcome screen | `Arena.outcome` | Arena | yes |

Nothing is missing. The brief's "add program logic to match" is satisfied by the geometry
and combat changes that `08-gate.md`, `09-shooting.md` and `10-boss.md` already specify;
the animation layer needs none of its own.

### 6.2 What must never go on chain

Stated as prohibitions because the temptation is real and each one is a byte somebody will
try to add:

- **No animation clock, phase, frame index or "is playing" flag.** A twenty-player raid
  does not need to agree on which frame of a breathing loop it is on, and putting one on
  chain would make every client wait 127 ms to breathe.
- **No `is_moving` / `is_walking` flag.** Whether a knight's legs are cycling is derivable
  from a position delta the client already has, on both the predicted and the interpolated
  path. A chain flag would arrive one round trip after the movement it describes.
- **No screen-shake, hit-stop or camera field.** Presentation, per client, per accessibility
  setting.
- **No damage-event log or hit list.** `parts[i]` decreasing already says a hit landed, and
  a log is the same fact stored twice — this project's named recurring defect.
- **No `DESCENT_MS` or any other animation duration.** `08-gate.md` §5.5 already settles
  this: the chain owns *when the fight starts*, and a client that renders no animation at
  all is still correct and still fights the same fight on the same tick.

The line, stated once: **the chain owns facts that must be identical for twenty players.
Everything about how a fact is presented is client-local, and a client rendering none of
it must still be playing the same game.**

### 6.3 Every duration still derives from `ticks_for`

Where an animation's length is meant to match a game duration, it derives from the same
constant the chain does, mirrored through `@heartrot/client` — `VOLLEY_INTERVAL_TICKS`
(`ticks_for(3_200)`, `tick.rs:155`), `RESPAWN_TICKS` (`ticks_for(3_200)`, `tick.rs:152`),
`ENRAGE_AT_TICK` (`ticks_for(360_000)`, `init.rs:190`), `TELEGRAPH_TICKS`
(`10-boss.md` §4.0). A hand-typed `3200` in a keyframe is a wind-up that stops matching
the volley the first time anyone tunes the balance.

Purely cosmetic durations — a 2.6 s breath, a 180 ms recoil — are client constants with no
chain counterpart, and that is correct. They are not game durations and `ticks_for` has
nothing to say about them.

---

## 7. Checks to leave behind

Small, runnable, and each one fails loudly if the corresponding rule is broken. In the
style of the existing dev-only self-checks in `Arena.tsx:475`, `predict.ts:544` and
`sprites.ts:171`.

1. **Every animated node is promoted.** A dev-only assertion after mount: for each element
   this file animates imperatively, `getComputedStyle(el).willChange` includes
   `transform`. Catches §2.3 regressing, which is otherwise invisible until someone
   profiles.
2. **No two writers on one node.** A dev-only assertion in the frame loop: any element the
   loop writes `style.transform` to has `el.getAnimations().length === 0`. This is the §3.1
   failure, and it is silent without a check.
3. **The latch key is pure.** A unit test that feeds the same decoded payload twice and
   asserts the effect callback ran once — and, separately, feeds a payload with one part's
   HP changed and asserts it ran once more. Both cases, not just the first.
4. **The resync gate fires.** A test that drives `health: 'live' → 'stalled' → 'live'` with
   a payload gap across it and asserts zero event one-shots on the payload after recovery.
5. **`ticks_for` durations round-trip.** Assert the CSS/WAAPI duration used for the volley
   wind-up equals `VOLLEY_INTERVAL_TICKS * TICK_MS`, read from the client mirror. Cheap,
   and it is the assertion that catches a hand-typed literal.
6. **`hitboxes.json` and `parts/boss.svg` agree.** Assert every `part_index` entry in
   `assets/sprites/hitboxes.json` has a matching `<g id="part-*">` in the rigged SVG.
   Belongs in `tools/gen_hitboxes.py`, so the generator refuses to emit a rig the renderer
   cannot address.

---

## 8. What was not verified

Stated plainly, because a negative result is a finding and an unmarked assumption is not.

1. **Nothing was measured on a real GPU, a real phone, or under a real network feed.** All
   numbers are headless Chrome 151 on this dev box. No condition dropped a frame in any
   run, so the raster figures are *work performed*, not *jank observed*. The 36–61× ratios
   should hold on weaker hardware — that is where they start to matter — but that is
   inference, not measurement.
2. **The seat measurement used a clipped `knights.svg`, not a per-pose sprite.** All 23
   paths of the three-knight sheet are in each seat's shape, clipped to the left third by a
   nested `<svg>`. A real single-pose knight is roughly a third of that geometry, so the
   `seats-nowc` / `seats-use-nowc` absolutes are pessimistic and the promoted rows are
   unaffected. The ratio is the claim; the absolute is an upper bound. This was measured in
   both structures (inlined and `<use>`) and neither moved it, which is §2.2's point.
3. **Compositing behaviour is Chrome-specific and was checked only in Chrome.** The
   auto-promotion of CSS transform animations (§2.2) and the cascade result (§3.1) are both
   specified behaviour, but the *magnitude* of the promotion win is an implementation
   detail. Firefox and Safari were not tested.
4. **~170 composited layers was not stress-tested for memory.** It rendered fine here; a
   phone with a small GPU memory budget was not tried.
5. **The `seats-nowc` defect is a prediction about the finished scene, not an observation of
   the shipped one.** Today's seats are four primitives over a flat generated tile path and
   are almost certainly fine. The claim is that they stop being fine when `knights.svg` and
   `temple.svg` land, and the harness reproduces that future scene rather than the current
   one.
6. **No 20-player session was observed with any of this running.** The duplicate-delivery
   and 68.4 %-no-change figures are this project's own prior measurements, taken from
   `predict.ts:304` and `subscribe.ts`, not re-run for this document. The mechanisms in §4
   are designed against them; they were not re-validated against live traffic.
7. **`assets/sprites/room.svg` was measured but has no role in this design.** 52 paths,
   6,763 subpaths. `docs/art/temple-scene.md` settles the question in favour of
   `temple.svg`, which is what this harness used. If `room.svg` ever returns, §2's
   conclusions carry over unchanged — it is strictly smaller.

8. **The three art documents were read for conflicts, not audited.** `docs/art/`
   (`temple-scene.md`, `knights.md`, `boss-rig.md`) landed alongside this one. The
   background-rasterisation overlap is reconciled in §2.2 and §2.4; the rest of those
   documents' geometry, palettes and symbol budgets were not checked against the
   measurements here — with one exception: `knights.md` §8.2's flagged `<use>` unknown was
   measured and is answered in §2.2. If that document's per-pose symbol count differs
   materially from the 23-path sheet this harness cloned, §2.1's unpromoted absolutes are
   off; the ratios are not.
