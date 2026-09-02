# boss-light — the creature is dark, which is right, and unlit, which is the whole defect

**Question.** The boss lighting is wrong. What exactly is wrong with it, and what replaces it?

**Answer, in one line.** `BOSS_GRADE` ends in `brightness(0.32)`, which is a *multiply*: it
scales the creature's whole tonal range toward black, so the lit tail goes with the bulk.
Measured on a real Chrome raster, **8.5 % of the boss's own pixels clear 1.5:1 against the
cavern behind it, and 0.4 % clear 2:1.** The reference reads **53.2 % and 23.2 %**. The
creature is not too dark — its median is 9.3/255 against the reference's 13.0/255, which is
close to right. It has no highlights left at all.

**The rim is not the missing half.** The `drop-shadow(-2px -2px 0 …)` term leaves an exposed
band **0.88 px wide (median 1 px)** at **1.50:1 against the cavern and 1.31:1 against the
body**. Removing it moves the fraction of the creature clearing 1.5:1 by **0.005**. It is a
decoration; it was never going to carry the light.

**The lever that works is the chest orb**, which is currently a dull filled disc at
**1.17:1 against the body around it** — the brief's "a hole, not a coal", confirmed. In the
reference the orb is a near-black well ringed by a bright line and a bloom, and it is the
only thing in the frame lighting the creature. Fixing it, together with a tone curve that
stops crushing the tail, lands the whole distribution on the reference:

| | ≥1.5:1 | ≥2:1 | ≥2.5:1 | ≥3:1 | ≥4:1 | body L255 p50 / p90 / p99 |
|---|---|---|---|---|---|---|
| reference (`actual_boss_arena.png`) | 0.532 | 0.232 | 0.123 | 0.070 | 0.025 | 13.0 / 32.2 / 72.7 |
| **shipped** | **0.085** | **0.004** | **0.003** | **0.003** | **0.003** | **9.3 / 14.3 / 22.8** |
| proposed (`g3` below) | 0.486 | 0.279 | 0.111 | 0.073 | 0.027 | 13.1 / 35.0 / 89.7 |
| ungraded (no `BOSS_GRADE` at all) | 0.951 | 0.773 | 0.729 | 0.704 | 0.507 | 68.1 / 110.6 / 149.6 |

**And the performance hazard the brief names is not the one that exists.** A CSS filter on
an ancestor of the part groups *is* a rasterisation boundary, but at this scale it costs
**+0.10 ms p50 / +0.10 ms p95 under a 6× CPU throttle (n=8)** against run-to-run spread of
±1.5 ms — it is inside noise, and moving the grade per-part is not cheaper. The grade must
nevertheless stay on the ancestor, for a different and decisive reason: **the part groups'
WAAPI keyframes set the `filter` property, which replaces any CSS `filter` on the same node
for the animation's whole duration.** A per-part grade would blink off on every flinch
(180 ms), every break-off (520 ms) and permanently on every dead limb. Proved below.

---

## 1. Method — and how to re-run every number

Nothing here is modelled. Every colour number is read out of a screenshot of the **shipped
renderer**, taken by mounting the real `app/src/render/Arena.tsx` in the existing frame-budget
harness and injecting candidate CSS with `page.addStyleTag`. **No product file was modified.**

```
cd scripts/spike/framebudget
npx vite build
PW_HOME=<dir containing x.cjs and node_modules/playwright> \
  node lightshot.mjs      # light/   shipped, noboss, ungraded, rimonly, gradeonly, perpart
  node gradesearch.mjs    # grade/   candidate tone curves (cand.json)
  node lightfix.mjs       # fix/     f0..f5   coarse builds
  node lightfix2.mjs      # fix2/    g1..g4   tuned builds
  node finalperf.mjs      # fix2/g3norim.png + finalperf.json
  node gradeperf.mjs      # gradeperf.json / gradeperf_boss.json  (ancestor vs per-part)
  node waapi.mjs          # the cascade proof in section 4
python3 bosslight.py      # reproduces every table in this document
```

The harness renders at **1024 × 1024 with `viewBox="0 0 1024 1024"`, so one arena unit is
exactly one CSS px** and every length below can be read as either. In the shipped app the
fit scale is `min(w,h)·dpr/1024` (`Arena.tsx:940`), so a rim quoted at *n* units lands at
*n · fitScale* CSS px — which is why the previous run measured the same 2-unit rim as
"1.37 css px": that was a 0.685 fit, not a different rim.

**The silhouette mask** is `|ungraded − noboss| > 6` per channel. `filter: none` removes the
drop-shadow along with the grade, so the mask is the painted creature and nothing else, and
the rim can be measured separately as the pixels *outside* it that the shadow term adds.

**The local background** is the cavern in the annulus 12–28 px outside the silhouette:
**relL 0.02363 (L255 6.0)**. The reference's wall behind its creature is **relL 0.01586
(L255 4.0)**. Contrast is WCAG `(L₁+0.05)/(L₂+0.05)` throughout.

**The reference creature** is bounded by hand at x 410–700, y 60–345 of
`actual_boss_arena.png` (1122 × 612) and thresholded at relL > 0.028, which is above its
wall. 22,517 px. Its bbox is 289 × 282; the shipped boss's is 576 × 565, hence the **1.875×**
radius scaling used whenever the two orbs are compared.

**One measurement could not be made.** These are still screenshots, not the running game at a
real fit scale on a real display; the rim's *perceptual* thickness at a 0.6 fit is 0.6 × what
is quoted here, and no run in this session drove the shipped app in a browser at its own
viewport. Every ratio is scale-free; every px length is at fit 1.0.

---

## 2. What the grade actually did

`Boss.tsx:177`:

```
grayscale(0.7) sepia(0.6) hue-rotate(185deg) saturate(1.6) brightness(0.32)
  drop-shadow(-2px -2px 0 rgb(159 232 255 / 0.25))
```

`brightness(b)` is `c ↦ b·c` on each sRGB channel. It is a straight multiply, so it maps a
distribution onto a scaled copy of itself. Measured on the same pixels before and after:

| percentile of the creature's own luminance | ungraded L255 | shipped L255 | ratio |
|---|---|---|---|
| p50 | 68.1 | 9.3 | 0.137 |
| p75 | 107.9 | 12.9 | 0.120 |
| p90 | 110.6 | 14.3 | 0.129 |
| p95 | 146.3 | 16.6 | 0.113 |
| p99 | 149.6 | 22.8 | 0.152 |

Every percentile lands on the same ~0.13 factor. That is the definition of a multiply, and it
is the defect: the reference's shape is a **dark bulk with a bright tail** (p50 13.0 →
p99 72.7, a 5.6× spread), and a multiply cannot produce a spread it was not given. The
shipped spread is 9.3 → 22.8, i.e. **2.5×**.

The contrast arithmetic makes it worse than the raw numbers suggest. Against a background at
relL 0.0235, a boss pixel needs relL 0.049 (**L255 15.4**) merely to reach 1.5:1 and relL
0.082 (**L255 20.8**) to reach 2:1. The shipped p95 is 16.6 and the p99 is 22.8, so *the
entire creature above the 91st percentile* is fighting for the first contrast step and
nothing at all clears the second. The `+0.05` term in the WCAG formula dominates once
everything is under relL 0.07; no amount of re-tinting inside that band buys separation.

### 2.1 Why no tone curve alone can finish the job

`assets/sprites/parts/boss.svg` has **13 unique fills across 74 paths**, and **75.3 % of the
creature's pixels sit on just 8 discrete luminance values** (L255 19, 23, 31, 45, 47, 75,
111, 150 — shares 0.109, 0.033, 0.033, 0.138, 0.036, 0.178, 0.182, 0.045). It is flat-shaded
pixel art. A per-pixel transfer function maps 13 values to 13 values; it cannot manufacture
the continuous gradient of light across a form that makes the reference read as lit.

A 23,760-point grid search over `grayscale × sepia × hue-rotate × saturate × brightness ×
contrast`, scored against the reference's contrast ladder and its median hue and saturation
(`scripts/spike/framebudget/` + the offline colour-matrix model in `bosslight_model.py`,
validated against Chrome at **mean |err| 4.65/255 over 120,340 interior px**), tops out at:

```
grayscale(0.8) sepia(0.6) hue-rotate(195deg) saturate(0.5) brightness(0.55) contrast(1.6)
  → 0.535 / 0.310 / 0.059 / 0.058 / 0.001    p50 15.5  p90 31.3  p99 50.5   hue 229  sat 18
reference                     0.532 / 0.232 / 0.123 / 0.070 / 0.025    p50 13.0  p90 32.2  p99 72.7   hue 244  sat 19
```

It nails the first step and the median and **cannot reach the top of the ladder**: 0.001 of
the creature at 4:1 against the reference's 0.025. The missing light has to be *added as a
light*, not squeezed out of thirteen flat fills. That is the finding that decides the shape
of the fix.

> The chain in that fence is the **search's own optimum**, not a shipped one — note the
> `grayscale(0.8)`, which no build has ever carried — and the percentiles beside it are the
> search's output. It is left exactly as measured. What ships is §5.1's
> `brightness(0.45) contrast(2.0)`, which this section's finding is the argument *against*
> trying to beat by re-tuning: the search says a transfer function alone tops out here, and
> the orb and its spill are what actually add the light.

## 3. The three things that are actually broken

### 3.1 The rim is a 1-pixel decoration

`drop-shadow(-2px -2px 0 rgb(159 232 255 / 0.25))` draws the graded silhouette offset 2 units
up-left, behind. Only the sliver not covered by the creature is visible.

| | exposed band | rim L255 | vs cavern | vs the body it edges |
|---|---|---|---|---|
| shipped, 2 units @ α 0.25 | 0.88 px (median 1) over 10,760 px | 16.0 | **1.50:1** | **1.31:1** |
| proposed, 3 units @ α 0.30 | 1.40 px (median 1) over 14,547 px | 22.0 | 1.75:1 | 1.30:1 |

Isolating it (`fix2/g3` vs `fix2/g3norim`, identical but for the shadow term) moves the
fraction of the creature clearing 1.5:1 from **0.481 to 0.486**. Worth keeping — it is free —
but it is not the light, and the reference agrees: its own up-left lit edge is 2 px deep with
mean L255 15.2 against 4.0 just outside, i.e. **1.54:1**. Nobody's rim is doing this work.

Note also that the shipped rim makes up-left edges *worse than the rest of the silhouette*
under the current grade: median edge contrast 1.076:1 on up-left-facing boundary pixels
against 1.223:1 elsewhere, because a 0.25-alpha wash lifts the background more than it
separates from an almost-black body.

### 3.2 The core is a hole

Live computed style, read off the running page: `.hr-boss-vent` resolves to
`opacity: 0.35`, `fill: rgb(42, 127, 150)`, `r = 60` arena units (`CORE.radiusSq = 3600`),
`stroke-width: 3`. (The brief's "opacity 0" is stale — `Boss.tsx:245` already fixed that.)
What it renders as:

- disc mean **rgb(34, 66, 79), L255 12.7**, peak 24.4
- the body immediately around it **L255 10.3**
- **vent vs surrounding body: 1.17:1.** vs the cavern: 1.38:1

A flat dull disc a sixth of a step brighter than the flesh it sits in. The reference's orb,
profiled radially from the centroid of its cyan blob:

| radius (ref px) | mean RGB | mean L255 | p95 L255 |
|---|---|---|---|
| 0–22 | ~(4, 13, 24) | 0.8 → 4.4 | ≤ 11 |
| 24–34 | (13–29, 44–57, 56–66) | 10.0 → 12.4 | 32–46 |
| 36–48 | (32–43, 34–40, 47–51) | 5.7 → 7.9 | 15–24 |

A **near-black well** — 0.8/255 at the centre, *darker than the wall behind the creature* —
ringed by a band at r 24–34 whose brightest pixels hit **L255 113**, decaying back to body
level by r ≈ 40. Outer radius 34 px on a 289-px-wide creature = **0.118 × creature width**.
The shipped vent is r 60 on a 576-px-wide creature = **0.104 ×**. **The circle is already the
right size.** Only its paint is wrong: it wants a dark fill and a bright ring, and it has a
mid fill and a 3-unit hairline.

### 3.3 The orb's own light is painted behind the creature

`Scene.tsx:247–275` defines `scene-core`, a 330-unit `#6ee1ff` radial gradient at
`CORE_WORLD = BOSS_SPAWN + CORE`, and `Scene.tsx:391` paints it as part of `SCENE` — which is
drawn *under* the boss. Its own comment already says the layer "cannot own the lamp"; what it
does not say is that **it also cannot light the lamp's owner**. The one light in this scene
that is anchored to the creature never touches it. In the reference, the tissue for ~1.5
orb-radii around the ring is visibly teal-lit; that is where a large part of the missing 45
points of ladder lives.

The fix is not to brighten `scene-core` (which lights the floor the knights stand on, and
`Scene.tsx:195–232` has already measured that brightening it walks the floor into the
knights). It is a second, small spill **inside `Boss.tsx`, drawn over the graded art**.

## 4. The performance question, answered — and it is not rasterisation

### 4.1 The measurement

Fresh Chrome per case (`drive.mjs`'s own note: reusing a page pins every case after the first
heavy one), 400 measured frames, commit time from rAF entry to a `MessageChannel` task, 6×
CPU throttle, the boss layer mounted alone so the flinch and break-off one-shots dominate.
`gradeperf_boss.json`, n = 8 per variant:

| variant | p50 (min…max) | p95 (min…max) |
|---|---|---|
| `none` — no filter anywhere | **1.90** (1.6…3.5) | **3.20** (2.6…8.1) |
| `anc` — shipped, grade on `.hr-boss-grade` | 2.00 (1.7…3.2) | 3.30 (2.5…5.5) |
| `part` — grade on each `.hr-boss-part` | 2.05 (1.8…3.9) | 3.30 (2.8…8.1) |
| `partwc` — per-part + `will-change: transform` | 2.00 (2.0…4.8) | 3.05 (2.9…9.7) |

The grade costs **+0.10 ms p50 and +0.10 ms p95**; the run-to-run spread is ±1.5 ms, an order
of magnitude wider than the effect. On the full arena at 20 knights the same comparison is
inside noise in both directions (`gradeperf.json`). **The ancestor filter is not costing this
scene anything.** It is a real rasterisation boundary — but the subtree it bounds is 76
painted nodes inside a 195 × 203 sprite box, and Chrome eats it.

That is a negative result, and it is the answer: **do not move the grade for performance.**

### 4.2 The reason it must stay on the ancestor anyway

`waapi.mjs`, a six-line page with a CSS `filter` on a group plus the same WAAPI call
`Boss.tsx` makes:

```
CSS filter at rest       drop-shadow(rgb(255, 0, 0) -3px -3px 0px)
mid-animation            brightness(1.09999)          <- the CSS filter is GONE
with .dead applied       grayscale(1) brightness(0.45) <- and gone again
```

A `filter` keyframe **replaces** the property; it does not compose with the CSS value. So a
per-part grade would be destroyed by three things already in the file:

- `Boss.tsx:370–378` — the damage flinch animates `filter: 'none' → 'brightness(2.2)' →
  'none'` for `FLINCH_MS` = 180 ms on every hit.
- `Boss.tsx:350–357` — the break-off animates `filter: 'brightness(3)' → 'none'` for
  `BREAK_MS` = 520 ms, with `fill` behaviour that leaves the limb sitting at the last frame.
- `Boss.tsx:221` — `.hr-boss-part.hr-dead { filter: grayscale(1) brightness(0.45) }` wins
  permanently for every destroyed limb.

Keeping a per-part grade alive would mean restating it inside all three, which is this
project's one-fact-stored-twice defect in the one place a renumbering already broke a limb.
**The grade and the rim stay on `.hr-boss-grade`.** The `perpart` variant's small measured
gain (ladder 0.122 vs 0.085 at 1.5:1) comes from internal limb-against-limb rims and is not
worth that trade — and note it was measured with the *same* `2px`, which inside the
`scale(BOSS_SCALE)` group is **6 arena units, three times the ancestor's rim**, so even that
gain is not like-for-like.

### 4.3 What the proposal costs

`finalperf.json`, shipped vs the whole proposal (new tone curve, thicker rim, restyled vent
with a blurred drop-shadow, and the extra spill `<circle>`), 6× throttle, n = 8:

| | p50 | p95 | over-budget frames |
|---|---|---|---|
| boss layer alone — shipped | 2.55 | 4.10 | 0.0 % |
| boss layer alone — proposal | 2.70 | 4.30 | 0.0 % |
| full arena, 20 knights — shipped | 8.50 | 14.55 | 1.9 % |
| full arena, 20 knights — proposal | 8.45 | 13.65 | 1.6 % |

**+0.15 ms p50 on the isolated boss, inside noise on the full arena.** One extra SVG node and
one extra blurred shadow on a 60-unit circle. Nothing here goes near the chain, the crank, the
ER slot or the 122 ms write-to-visible path — this is one component's paint.

---

## 5. The specification

Five edits, all inside `app/src/render/Boss.tsx`. No new file, no new dependency, no chain
change, no generated file touched.

### 5.1 The grade — replace the multiply with a tone curve

```
const BOSS_GRADE =
  'grayscale(0.7) sepia(0.6) hue-rotate(195deg) saturate(0.5) ' +
  'brightness(0.45) contrast(2.0) ' +
  'drop-shadow(-3px -3px 0 rgb(159 232 255 / 0.30))';
```

Four terms move and one is added:

| term | was | now | why |
|---|---|---|---|
| `hue-rotate` | 185deg | **195deg** | graded median hue 219° → 229°; the reference's is 244° |
| `saturate` | 1.6 | **0.5** | `contrast()` amplifies chroma. At 1.6 the graded body measures sat 52 %; the reference is **19 %**, and 0.5 lands on 19 % |
| `brightness` | 0.32 | **0.45** | the bulk stays dark because `contrast` pulls it back down, not because `brightness` crushes it |
| `contrast` | — | **2.0** | `c ↦ 2.0c − 0.5`: darks clip toward black, the top of the range survives. This is the term that restores the tail |
| `drop-shadow` | 2px, α 0.25 | **3px, α 0.30** | 0.88 px → 1.40 px exposed, 1.50:1 → 1.75:1 vs the cavern |

**This block first shipped as `brightness(0.55) contrast(1.6)` and that overshot.** Measured
on the shipped frame after it landed: body p50 relL 0.0564 against a floor at 0.0159 —
**3.5× brighter than the floor it stands on**, where reference B's creature is **0.58×**. The
tail did not arrive either (p50→p99 spread 3.5× against the reference's 15×): 0.55 lifted the
whole body rather than opening the range. `0.45 / 2.0` is the same two terms re-solved
against the *ratio* rather than against an absolute median, and it reads 15.0× spread at
**0.57× the floor**. The measured table for both chains lives in `Boss.tsx`'s own comment
above `BOSS_GRADE`, next to the constant, which is where it cannot go stale unread. §7's
acceptance criterion moved with it — see the note there.

`contrast` goes **after** `brightness`; the pair is `c ↦ k·b·c + (1−k)/2` and swapping them
changes the black point. The drop-shadow stays **last** so the grade cannot tint the light it
adds — that part of the existing comment is correct and should survive the edit.

Lengths in this chain are in `.hr-boss-grade`'s own coordinate system, which carries no
transform, so **3px is 3 arena units**. If this ever moves onto a node inside
`scale(BOSS_SCALE)` it becomes 9 units. It must not move; see §4.2.

### 5.2 The core — a well with a burning ring, from the first frame

The `<circle className="hr-boss-vent">` at `Boss.tsx:450` keeps its geometry exactly:
`cx={CORE.x} cy={CORE.y} r={CORE_R}` — that circle is what the chain raycasts and an SVG
stroke is centred on its path, so a thick ring's midline is still the hit circle. Two changes
to the element:

- **delete `strokeWidth={3}`.** Stroke width becomes a CSS value like every other property of
  this node, for the reason already written at `Boss.tsx:446–449`: a presentation attribute
  loses to the class and only survives as a second place to look.
- **publish the radius to CSS** so the ring can be a ratio of it rather than a literal:
  `style={{ '--core-r': CORE_R } as React.CSSProperties}`.

```css
.hr-boss-vent {
  transform-box: fill-box;
  transform-origin: center;
  fill: #04121a;                                    /* the well: darker than the cavern */
  fill-opacity: 1;
  stroke: var(--cyan, #6fe3ff);
  stroke-opacity: 0.75;
  stroke-width: calc(var(--core-r) * 0.15);         /* 9 units at CORE_R 60 */
  opacity: 1;
  filter: drop-shadow(0 0 16px rgb(111 227 255 / 0.35));
  transition: stroke 0.4s ease-out, stroke-opacity 0.4s ease-out, filter 0.4s ease-out;
}
.hr-vent-open .hr-boss-vent {
  stroke: #eafeff;
  stroke-opacity: 1;
  filter: drop-shadow(0 0 26px var(--cyan, #6fe3ff)) drop-shadow(0 0 9px #eafeff);
  animation: hr-boss-vent 1.1s ease-in-out infinite;
}
```

Sealed is a **lit** coal, not a dim one — the reference's orb burns identically whether or not
anything has hit it, and the vent's *state* is carried by the ring going white-hot and
starting to pulse, which is a stronger read than an opacity step and survives
reduced-motion (the pulse is already gated at `Boss.tsx:259`).

`0.15` and the spill's `2.6` below are cosmetic ratios of the generated radius, so they are
named constants beside `FLINCH_PX` with the same "matches no chain fact" comment. `16px` and
`26px` are in the vent's own coordinate system — the vent is a direct child of
`.hr-boss-shell`, which carries no scale, so they are arena units.

The reference's ring is uneven and broken; a stroked `<circle>` cannot be. Do not chase that
with a dash array — measured, the ladder is carried by the ring's *luminance*, not its
texture, and a dashed ring would read as a gear, not a coal.

### 5.3 The spill — the orb lighting the creature it sits in

One `<radialGradient>` in a local `<defs>` and one `<circle>`, inserted **between**
`.hr-boss-grade` and the vent inside `.hr-boss-shell`. Over the graded art, so it is light;
under the vent, so the ring sits on its own glow. Never inside `.hr-boss-grade` — the grade
would tint light that is already the colour it should be, which is the same argument
`Scene.tsx:382–384` makes for the scene's own lighting.

```tsx
<defs>
  <radialGradient id="heartrot-boss-spill" gradientUnits="userSpaceOnUse"
                  cx={CORE.x} cy={CORE.y} r={CORE_R * SPILL_R}>
    <stop offset="0"   stopColor="#9fe8ff" stopOpacity={0.20} />
    <stop offset="0.4" stopColor="#6fe3ff" stopOpacity={0.07} />
    <stop offset="1"   stopColor="#6fe3ff" stopOpacity={0} />
  </radialGradient>
</defs>
<circle cx={CORE.x} cy={CORE.y} r={CORE_R * SPILL_R} fill="url(#heartrot-boss-spill)" />
```

`SPILL_R = 2.6` → 156 units, so the lit pool spans 312 units across a 576-unit-wide creature:
roughly the chest and the inner arms, which is where the reference's teal lands. It is static
— no keyframe, no ref, no snapshot read — so it adds one node to the tree and nothing to the
frame loop.

### 5.4 Delete the dead copies in `styles.css`

`styles.css:328–372` still carries `#boss-breathe`, `.boss-part` and `.boss-eye`, and
`styles.css:930–931` lists two of them under `prefers-reduced-motion`. **Nothing in
`app/src/render/` renders any of those** — the live tree is `.hr-boss-breathe`,
`.hr-boss-part`, `.hr-boss-eye`, all defined in `Boss.tsx`'s injected `<style>`. In
particular `.boss-part { will-change: transform }` promotes a class that does not exist, so
the eleven groups that actually take the WAAPI one-shots are unpromoted and the stylesheet
says otherwise. This is the same defect the file's own comment at `styles.css:358` describes
having already fixed once for `.core-glow`; it was fixed for one class and not its
neighbours. Delete all of it.

### 5.5 Update the arithmetic in the comment at `Boss.tsx:146–176`

That block quotes graded values for the four dominant fills, an internal-contrast ratio of
2.47, and a `brightness(2.2)` flash ceiling of L 80.8, all computed for the old chain. Under
the new one the flash is stronger. Re-derive or delete; leaving stale arithmetic in the one
comment people read before touching this is how it gets re-broken.

**Done, and the file is now the record.** `Boss.tsx`'s comment carries the re-derivation
against the shipped `brightness(0.45) contrast(2.0)`: the flash grades to relL 0.129,
**15.8× the resting body's 0.0082**, where the old chain gave 5.1×. Stated as a ratio to the
body it flashes, for the same reason as §7.2 — an absolute L255 is not scale-free, and this
paragraph's earlier "L255 ≈ 74 against a resting body at 13" was quoting a body median that
has since moved. Read it there, not here.

---

## 6. What NOT to build

**A brazier under-light on the boss.** The brief asks what the cyan braziers cast on the
creature. Measured on the reference: the floor directly under the creature reads **L255 11.9**
against mid-arena floor at **10.6** and the outer ring at **3.5** — a 12 % lift, i.e. nothing.
The braziers are wall furniture; the orb is the creature's key light. Built anyway as variant
`fix/f4_all` (an extra `drop-shadow(0 3px 0 rgb(42 127 150 / 0.45))`), it moved the ladder by
**≤ 0.015 at every step** against `fix/f3` and cost a fourth shadow term on the perimeter.
Skip it.

**A `<use href="#art">` silhouette for the rim.** The existing comment at `Boss.tsx:223–229`
is right and §4.2 now proves the mechanism: a `<use>` shadow tree mirrors attributes but not
`Element.animate()`, and every flinch, break-off and the death sequence are WAAPI.

**Brightening `scene-core`.** `Scene.tsx:195–232` already measured that lifting the pit
lighting walks the floor into the knights (worst-case skin contrast 1.85 at α 0.10, 1.16 at
α 0.20, 1.09 at α 0.35). The boss's light belongs on the boss.

**Moving the grade per-part for performance.** §4.1: +0.10 ms, inside noise. §4.2: it breaks.

---

## 7. Acceptance

Re-run `python3 scripts/spike/framebudget/bosslight.py` after the edit and require, on the
`light/` shot of the changed build:

1. **Ladder within ±0.06 of the reference at every step** — `0.532 / 0.232 / 0.123 / 0.070 /
   0.025`. `g3` measured `0.486 / 0.279 / 0.111 / 0.073 / 0.027`.
2. **Body p50 BELOW the floor's own p50** — reference B's creature is **0.58×** its floor —
   **with a p50→p99 spread near 15×** (reference 15.1×).

   > This criterion used to read "body median L255 in 11…16 (reference 13.0)", and that
   > absolute bar is what let the first attempt at §5.1 overshoot. An L255 median is not
   > scale-free: it moves with the floor under it, and the floor has since moved twice — the
   > map rebuild changed which mix of floor and backdrop the creature sits on, and
   > `BossArena.tsx`'s `GAIN` went to 0.92. A grade tuned to hit "13" against one floor is a
   > **4.6× value inversion** against another, which is exactly what shipped. The ratio and
   > the spread survive both moves; the median does not. Never restate this as an absolute.
3. **Orb ring band, r 50–70 units from `CORE`, mean L255 in 30…70** with the interior
   (r < 40) **under 8**. Shipped reads 17.2 / 10.6 on the ring and 8.2 on the interior — a
   flat disc. `g3` reads 35.7 / 58.5 and 4.7.
4. **The orb ring reaches the eyes' order of magnitude.** Shipped, the boss's brightest pixel
   is an eye at L255 150 while the orb ring peaks at 40.3 — the eyes are 3.7× the lamp.
   `g3` takes the ring peak to **119.4** against eyes at 157, i.e. 0.76×, and the two read as
   one lit creature rather than as two eyes on a dark shape. The eyes are 490 px above
   relL 0.35 in the whole frame; the ring band alone (r 50–70 from `CORE`) is 7,540. Do not
   fix this by dimming the eyes.
5. **Frame cost within +0.5 ms p50 of the pre-change build** at 20 knights under 6× throttle
   (`finalperf.mjs`). Measured: −0.05 ms.
6. `cargo check`, `cargo test -p heartrot` (unit line still 94 passed) and all three `tsc`
   unchanged — this touches no Rust and no type surface.

Screenshots for the eye, all at 1024²: `light/shipped.png` (before), `fix2/g3.png` (after),
`light/ungraded.png` (the pastel sticker the grade exists to prevent).
