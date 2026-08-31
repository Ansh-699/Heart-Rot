# SVG sprite rig performance at scale

Research note for HEARTROT. Written 2026-08-31.
Scope: can a `<g>`-per-part SVG rig animate at display refresh with our actual
assets, what makes it fall off the GPU compositor, how to stay pixel-perfect,
and how to cut one px2svg file into per-part groups.

**Bottom line.** Yes, and the reason is narrower than "SVG is fast": a `<g>` with
a CSS `transform` animation gets its **own composited layer**, its paint is
rasterised **once**, and per frame the compositor only re-applies a matrix. Path
complexity inside the group is paid at raster time, not per frame. Our 7 589-rect
boss animates at full refresh. The things that actually break it are a short,
enumerable list from the Blink source, and every one of them is avoidable.

---

## 0. What we are actually rendering

Measured from the repo, not assumed:

| file | bytes | brotli -q11 | `<path>` | subpaths (rects) | viewBox |
|---|---|---|---|---|---|
| `assets/sprites/boss.svg` | 118 187 | **22 768** | 13 | **7 589** | `0 0 230 270` |
| `assets/sprites/knights.svg` | 45 334 | — | 23 | 3 038 | `0 0 216 140` |
| `assets/sprites/room.svg` | 103 214 | — | 52 | 6 763 | `0 0 279 168` |
| `assets/sprites/temple.svg` | 332 218 | — | 16 | 22 195 | `0 0 210 238` |

Every one of the 7 589 subpaths in `boss.svg` matches exactly
`M{x} {y}h{w}v{h}h-{w}z` — verified 7589/7589, zero exceptions. That is
`px2svg.to_svg()`'s output grammar and it is what makes the slicer in §6 exact
rather than heuristic.

`ref-user-temple.svg` is the counter-example: **25 378 `<path>` nodes**, 836 KB.
That is a pre-`to_svg` artefact. Never ship a file shaped like that.

---

## 1. Versions pinned

| thing | version | how verified |
|---|---|---|
| Chrome used for measurements | **151.0.0.0** (Linux x86_64) | `navigator.userAgent` in the test browser |
| Blink source read | `chromium/src` **HEAD**, 2026-08-31 | fetched from chromium.googlesource.com |
| `transform-box` support | Chrome **64+**, Firefox **55+**, Safari **11+**, Edge **79+** | caniuse `mdn-css_properties_transform-box` |
| `transform-box` initial value | **`view-box`** | MDN + CSS Transforms L1 formal definition |
| `shape-rendering` as a CSS property | Baseline widely available since **Jan 2020** | MDN |
| `image-rendering` | Baseline widely available since **Jan 2020** | MDN |
| SVG hardware-accelerated animation | shipped **Chromium 89** | Chrome for Developers blog |
| SMIL in Chrome | deprecation **intent filed then suspended**; still ships | blink-dev intent thread, caniuse #4167 |

No npm dependency is required for any of this. Everything here is platform CSS
plus one build-time Python script that already has `numpy` + `Pillow` from
`px2svg.py`.

---

## 2. Does animating the group transform composite cheaply? (measured)

### 2.1 Method

Four pages, **identical DOM**, generated from the real `boss.svg`: the 7 589
rects redistributed into 8 `<g class="part">` groups (one `<path>` per colour per
group), rendered at 920×1080. Only the animated property differs. Frame intervals
sampled via `requestAnimationFrame` for 3–4 s; display refresh on the test
machine is ~144 Hz, so **the ceiling is ~144 fps / 6.9 ms**, not 60.

### 2.2 Results

| page | animated property | fps | median | p95 | p99 | frames >20 ms |
|---|---|---|---|---|---|---|
| `static.html` | none (baseline) | 142.3 | 6.9 ms | 7.0 | 7.0 | 2 |
| **`group.html`** | **`transform` on 8 `<g>`** | **143.3** | **6.9 ms** | **7.0** | — | **0** |
| `repaint.html` | `fill-opacity` on 8 `<g>` | 74.8 | 13.9 ms | 27.7 | — | 42 |

`transform` on the groups is indistinguishable from a static page. The same DOM,
the same 7 589 rects, animating a **non-composited** property instead, halves the
frame rate and produces a 69 ms worst frame. **The cost is the property, not the
path count.** That is the claim in the brief, confirmed.

### 2.3 Full-scene stress: 201 animated nodes

Realistic entity layer per the spec: 13 boss parts + 20 knights × 3 parts +
128 bullet rects = **201 animated nodes, 678 SVG DOM nodes**, in one 1280×720 SVG.

| variant | animated nodes | fps | median | p95 | p99 | max | frames >20 ms |
|---|---|---|---|---|---|---|---|
| static (no animation) | 0 | 139.8 | 6.9 | 7.0 | 7.1 | 83.3 | 3 |
| **all 201 animating** | 201 | **96.8** | 6.9 | **20.9** | **41.6** | 76.4 | **30** |
| all 201 + `will-change:transform` | 201 | **140.0** | 6.9 | 7.0 | 13.9 | 34.7 | 2 |
| bullets removed | **73** | **141.5** | 6.9 | 7.0 | 13.8 | 34.7 | 1 |

Two readings, both important:

1. **73 composited nodes is free.** The boss rig plus 20 three-part knights costs
   nothing measurable. This is the shape the game should be built in.
2. **201 is not free, and `will-change` fixes it completely.** Going from 73 to
   201 nodes costs p99 13.8 → 41.6 ms. Adding `will-change: transform` to all 201
   restores 140 fps / p99 13.9 ms — identical to dropping the bullets entirely.

### 2.4 The canvas alternative for bullets is worse here

The obvious instinct — draw 128 bullets into one `<canvas>` instead of 128 SVG
nodes — measured *worse*, and the reason is instructive:

| canvas | rects drawn | fps | median |
|---|---|---|---|
| 1280×720 | **0** | 58.1 | 17.3 ms |
| 1280×720 | 128 | 58.2 | 17.2 ms |
| 640×360 | 128 | 58.3 | 17.2 ms |

The JS draw loop itself costs **0.0 ms median, 0.2 ms p99** for 128 `fillRect`s.
The entire penalty is *having a continuously-updating canvas at all* — it is
independent of both backing-store size and draw count. A canvas that changes
every frame forces a texture re-upload per frame; the SVG layers do not.

**Recommendation: keep the bullets as SVG nodes with `will-change: transform`.**
Do not add a canvas overlay. This inverts the intuitive answer, which is why it
was measured.

### 2.5 Caveat you must not skip

The test browser ran with `--enable-unsafe-swiftshader` — **software GL, no
hardware GPU**. Absolute numbers are pessimistic and the canvas result in
particular is expected to improve on real hardware. The *relative ordering*
(composited transform ≫ repainted property; `will-change` recovers layer-count
jank) is a property of the pipeline, not the rasteriser, and holds either way.
**Re-run §2 on the target hardware before freezing the bullet decision.**

---

## 3. Why it composites — from the Blink source

Not folklore. `third_party/blink/renderer/core/paint/compositing/compositing_reason_finder.cc`
@HEAD:

```cpp
CompositingReasons DirectReasonsForSVGChildPaintProperties(
    const LayoutObject& object) {
  DCHECK(object.IsSVGChild());
  if (object.IsText()) {
    return {};
  }

  // Even though SVG doesn't support 3D transforms, it might be the leaf of a 3D
  // scene that contains it.
  auto reasons = CompositingReasonsFor3DSceneLeaf(object);

  const ComputedStyle& style = object.StyleRef();
  reasons.PutAll(
      CompositingReasonFinder::CompositingReasonsForAnimation(object));
  reasons.PutAll(CompositingReasonsForWillChange(style));
  // Exclude will-change for other properties some of which don't apply to SVG
  // children, e.g. 'top'.
  reasons.Remove(CompositingReason::kWillChangeOther);
  ...
}
```

and the gate on which SVG objects qualify:

```cpp
bool ObjectTypeSupportsCompositedTransformAnimation(
    const LayoutObject& object) {
  if (object.IsSVGChild()) {
    // Transforms are not supported on hidden containers, inlines, text, or
    // filter primitives.
    return !object.IsSVGHiddenContainer() && !object.IsLayoutInline() &&
           !object.IsText() && !object.IsSVGFilterPrimitive();
  }
  // Transforms don't apply on non-replaced inline elements.
  return object.IsBox();
}
```

A `<g>` is a `LayoutSVGTransformableContainer`: not hidden, not inline, not text,
not a filter primitive. **It qualifies.** An active `transform` animation on it
puts `CompositingReason::kActiveTransformAnimation` on its transform property
node, `PaintArtifactCompositor` gives it its own `cc::Layer`, and from then on
each frame is a matrix update on the compositor thread.

`CompositingReasonsForAnimation` (same file) lists exactly what earns a layer:

```cpp
  if (style.HasCurrentTransformAnimation() &&
      ObjectTypeSupportsCompositedTransformAnimation(object))
    reasons.Put(CompositingReason::kActiveTransformAnimation);
  ...
  if (style.HasCurrentOpacityAnimation()) { ... kActiveOpacityAnimation ... }
  if (style.HasCurrentFilterAnimation()) { ... kActiveFilterAnimation ... }
```

`transform`, `opacity`, `filter`, `backdrop-filter`. Nothing else. Animating
`fill`, `fill-opacity`, `d`, `x`/`y`, `stroke-width`, `width`/`height` is a
repaint — that is the 74.8 fps row in §2.2.

Step easings are supported on the compositor: `StepsTimingFunction` exists in
`ui/gfx/animation/keyframe/timing_function.h`, so the prototype's
`steps(2, end)` / `steps(3, end)` keep the animation on the fast path. Good — the
stepped look is free.

---

## 4. The five ways a `<g>` silently falls off the compositor

All from `third_party/blink/renderer/core/animation/compositor_animations.cc`
@HEAD. Every one of these is silent: the animation still *runs*, it just runs on
the main thread and janks under load.

### 4.1 Browser zoom ≠ 100 %

```cpp
CompositorAnimations::CheckCanStartTransformAnimationOnCompositorForSVG(
    const SVGElement& svg_element) {
  FailureReasons reasons = kNoFailure;
  if (const auto* layout_object = svg_element.GetLayoutObject()) {
    if (layout_object->StyleRef().EffectiveZoom() != 1) {
      // TODO(crbug.com/1186312): Composited transform animation with non-1
      // effective zoom is incorrectly scaled for now.
      // TODO(crbug.com/1134775): If a foreignObject's effect zoom is not 1,
      // its transform node contains an additional scale which would be removed
      // by composited animation.
      reasons |= kTransformRelatedPropertyCannotBeAcceleratedOnTarget;
    } else if (layout_object->IsSVGTransformableContainer() &&
               To<LayoutSVGTransformableContainer>(layout_object)
                   ->HasAdditionalTransform()) {
      // TODO(crbug.com/1134775): Composited animation would replace the
      // element's CSS transform and drop any extra transform post-multiplied
      // into LocalToSVGParentTransform() (e.g. the additional translation
      // from a <use> element's x/y attributes, or the viewBox/x/y transform
      // on an <svg>/<symbol> viewport container).
      reasons |= kTransformRelatedPropertyCannotBeAcceleratedOnTarget;
    } else if (layout_object->TransformAffectsVectorEffect()) {
      // If the subtree has vector effect, transform affects paint thus
      // animation can not be composited.
      reasons |= kTransformRelatedPropertyCannotBeAcceleratedOnTarget;
    }
  }
  return reasons;
}
```

**A player at 110 % browser zoom loses GPU compositing on the entire boss rig.**
There is no CSS workaround. This is the single largest un-designed-for risk in
the rendering plan and it is invisible in local testing at 100 %.

Mitigations, in order of laziness:
- Detect it: `window.devicePixelRatio / <baseline dpr>` changes on zoom, or
  compare `visualViewport.scale`. Log it; do not fight it.
- Move the per-part animation off SVG entirely: wrap each part's `<svg>` in an
  absolutely-positioned `<div>` and animate the `<div>`. HTML boxes do not go
  through `CheckCanStartTransformAnimationOnCompositorForSVG` at all. Costs one
  `<svg>` element per part instead of one `<g>`, and each `<svg>` re-declares the
  same `viewBox`. Only do this if zoom turns out to matter in practice.

### 4.2 Animating `translate` / `rotate` / `scale` instead of `transform`

```cpp
        // TODO(https://crbug.com/1278452): When we make the transform tree
        // structure for SVG work like everything else, we should instead
        // start compositing animations of transform properties other than
        // transform.
        if (!property.GetCSSProperty().IDEquals(CSSPropertyID::kTransform))
          state.disposition |= kSVGTargetHasIndependentTransformProperty;
```

The individual transform properties (`translate: 4px`, `rotate: 30deg`,
`scale: 1.06`) are **not composited on SVG children**, only the `transform`
shorthand is. Write `transform: translateX(3px)`, never `translate: 3px`.
This one bites hardest because the individual properties are the modern,
recommended style everywhere *except* inside SVG.

### 4.3 Any SMIL on the element

```cpp
CompositorAnimations::CheckCanStartSVGElementOnCompositor(
    const SVGElement& svg_element) {
  FailureReasons reasons = kNoFailure;
  if (svg_element.HasSMILAnimations()) {
    reasons |= kTargetHasIncompatibleAnimations;
  }
  if (const auto* layout_object = svg_element.GetLayoutObject()) {
    if (IsPartOfSVGResource(*layout_object)) {
      // If the element is either a resource container or a descendant of one,
      // we don't paint it directly, and thus animation can not be composited.
      reasons |= kTargetHasInvalidCompositingState;
    }
  }
  return reasons;
}
```

**SMIL is disqualified for this project.** Not because it is deprecated — the
Chrome deprecation was filed and then *suspended*, and `<animate>` still ships in
every current browser — but because a single `<animate>` on an element takes that
element's CSS animations off the compositor too. There is no upside here: SMIL's
one irreplaceable feature is path morphing (`<animateMotion>`, `d` interpolation)
and the rig needs neither.

### 4.4 `vector-effect` anywhere in the part subtree

`TransformAffectsVectorEffect()` above. `vector-effect: non-scaling-stroke` is a
tempting way to keep a 1px outline crisp under scale. It kills compositing for
the whole group. Our sprites are fills-only with baked outlines, so just never
introduce it.

### 4.5 `<use x= y=>` and nested `<svg>`/`<symbol>` viewports

`HasAdditionalTransform()` above. If you build the 20 knights with
`<use href="#knight" x="120" y="300">`, every one of them is off the compositor.
Position knights with a wrapper `<g transform="translate(120,300)">` and put the
animated `<g class="part">` *inside* it. The static outer `translate` is fine —
it is not animated, so it never needs its own layer.

### 4.6 Two more that are not SVG-specific

```cpp
  // TODO(crbug.com/1287221): Add a more specific reason.
  if (target_element.GetDocument().ShouldForceReduceMotion())
    state.disposition |= kAcceleratedAnimationsDisabled;
```

`prefers-reduced-motion` in its forced form disables accelerated animation
globally. The prototype already does the right thing
(`@media (prefers-reduced-motion:reduce){*{animation:none !important}}`), which
sidesteps the question rather than degrading into a main-thread rig.

And `kAffectsImportantProperty` — animating a property that is also declared
`!important` elsewhere is not composited. The prototype has
`.part.destroyed{animation:fall .5s steps(6,end) forwards !important}`. The
`!important` is on the `animation` shorthand, not on `transform`, so this is
currently fine — but do not add `transform: ... !important` anywhere.

---

## 5. Pixel-perfect rendering

### 5.1 `shape-rendering: crispEdges` is the one that matters

MDN, verbatim:

> **`crispEdges`** — This value directs the user agent to emphasize edge contrast
> over geometric precision or rendering speed. The final rendering is likely to
> skip techniques such as anti-aliasing. It may also adjust line positions and
> line widths in order to align edges with device pixels.

Applies to `<circle> <ellipse> <line> <path> <polygon> <polyline> <rect>`.
**Inherited: yes**, initial `auto`. So one declaration on the `<svg>` root covers
every path. `px2svg.to_svg()` already emits it as a presentation attribute; the
prototype also sets it in CSS (`.stage svg{shape-rendering:crispEdges}`), which
wins over the attribute. Both agree, so no conflict — but pick one place.

Second, less obvious benefit: `crispEdges` is the standard **fix** for hairline
seams between abutting fills. `px2svg` emits one `<path>` per colour, so
neighbouring sprite pixels of different colours are in *different* path nodes and
their shared edge gets anti-aliased twice — a faint background-coloured hairline.
Turning off anti-aliasing removes the cause.

### 5.2 `image-rendering: pixelated` does nothing for our paths

MDN, on scope:

> **Scope:** Images, canvas, background images — **not SVG shapes** (though SVG
> has its own `image-rendering` attribute)

`px2svg.to_svg()` emits `image-rendering="pixelated"` on the `<svg>` root. For a
file that contains only `<path>` fills this is **inert**. It is harmless, but it
is misleading in code review — someone will assume it is what keeps the sprite
crisp, and it is not; `shape-rendering` is. Worth deleting from `to_svg()` or
commenting as a no-op kept for the `<image>` case.

It *would* matter if the design spec's §6 "each body part is an `<image>` holding
a small pixel-art raster" route were taken — see §8.

### 5.3 Non-integer devicePixelRatio is the real crispness hazard

The test machine reported **`devicePixelRatio === 1.1875`** (= 19/16). That is not
exotic; it is what a fractional OS display scale gives you, and it is common on
Windows laptops and Linux/Wayland at 125 %.

The arithmetic:

```
boss.svg   viewBox 0 0 230 270,  width="920"   →  4 CSS px per sprite pixel
device scale = 4 × 1.1875 = 4.75 device px per sprite pixel
```

`crispEdges` snaps every rect edge to the device pixel grid, so sprite pixel
widths come out as 5,5,5,4,5,5,5,4,… — the classic uneven-pixel shimmer, and it
*moves* when the sprite translates. Anti-aliasing would have hidden it as blur;
`crispEdges` makes it structural.

**Fix: size the SVG so `cssScale × devicePixelRatio` is an integer.**

```js
// Pick the largest integer device-pixel scale that fits the container,
// then work backwards to the CSS size. Everything lands on the device grid.
function fitPixelPerfect(svgEl, spriteW, spriteH, boxW, boxH) {
  const dpr = window.devicePixelRatio || 1;
  const deviceScale = Math.max(
    1, Math.floor(Math.min(boxW * dpr / spriteW, boxH * dpr / spriteH)));
  svgEl.style.width  = (spriteW * deviceScale / dpr) + 'px';
  svgEl.style.height = (spriteH * deviceScale / dpr) + 'px';
  return deviceScale;                       // integer device px per sprite px
}
```

At dpr 1.1875 and a 1000 px box this gives `deviceScale = 5`, CSS width
`230 × 5 / 1.1875 = 968.42px` — a fractional CSS size that is an *exact* integer
in device pixels. Fractional CSS sizes look wrong and are correct.

Re-run it on `resize` and on the `matchMedia(\`(resolution: ${dpr}dppx)\`)` change
event, which is how you detect a dpr change (window drag to another monitor,
browser zoom).

**Confidence note:** the arithmetic and the `crispEdges` snapping behaviour are
from the spec text; the visual alternation was **not** empirically screenshotted
(the test browser crashed before that run). Treat §5.3 as spec-derived, and
confirm with a screenshot diff on a fractional-dpr machine before shipping.

### 5.4 The raster-scale trap that comes with `will-change`

§2.3 says put `will-change: transform` on the bullets. That has a documented
side effect. Chrome for Developers, on re-rastering:

> `will-change: transform` can be thought of as forcing the content to be
> rastered into a fixed bitmap, which subsequently never changes under transform
> updates.

and

> This behavior applies only to script-driven transform changes, not CSS
> animations or Web Animations.

Chromium issue **40753139** ("Some SVG rendering heavily pixelated in Chrome
89+") is exactly this: the fixed-raster behaviour was extended to SVG in M89, and
`will-change: transform` on SVG produces visibly blurred/pixelated output when
the layer is later drawn at a different scale. Removing `will-change` fixes it in
Chrome but reintroduces blur-on-zoom in Firefox.

For a **CSS animation** the picture is better. `cc/layers/picture_layer_impl.cc`
@HEAD picks the raster scale from the animation's own maximum:

```cpp
  if (was_screen_space_transform_animating_ !=
      draw_properties().screen_space_transform_is_animating) {
    if (draw_properties().screen_space_transform_is_animating) {
      // Entering animation.
      // Skip adjusting raster scale if max animation scale already matches
      // raster scale.
      float maximum_animation_scale =
          layer_tree_impl()->property_trees()->MaximumAnimationToScreenScale(
              transform_tree_index());
      ...
```

So a `@keyframes pulse{50%{transform:scale(1.06)}}` rasters at 1.06× and stays
sharp for the whole animation. The trap is only for **script-driven** scale
changes on a `will-change` layer.

**Practical rules:**
- `will-change: transform` is safe on the bullets: they only translate, never
  scale, so the raster scale never needs to change.
- Do **not** put `will-change: transform` on the boss parts if any part scales.
  §2.3 shows 73 nodes need no help anyway.
- Never drive a scale from `element.style.transform` per frame. Use a CSS
  animation or `element.animate()` so `MaximumAnimationToScreenScale` applies.

MDN's blanket warning still stands and is worth quoting against ourselves:

> Excessive use of `will-change` will result in excessive memory use and will
> cause more complex rendering to occur as the browser attempts to prepare for
> the possible change. This will lead to worse performance.

Our measurement disagrees for this specific shape (201 small SVG nodes on
software GL). Both can be true: `will-change` bought back 44 fps here, and it
would cost real GPU memory on a phone. Re-measure on target (§2.5) and treat the
bullets' `will-change` as the *only* blanket use in the codebase.

---

## 6. Slicing one converted SVG into per-part groups

### 6.1 Why this is easy for our files

`px2svg` emits one `<path>` per colour, and every subpath is a single
axis-aligned integer rect. So the file is losslessly invertible to a
`(h, w)` colour-index grid. Regrouping by *region* instead of by *colour* is then
a mask lookup plus a re-run of `px2svg.merge_rects`. No path parsing library, no
geometry, no new dependency.

The mask is authored the way an artist already works: **repaint the sprite with
one flat colour per part**, same pixel dimensions as the px2svg grid, save as
PNG. That is the whole interface.

### 6.2 `tools/svg_slice.py` — verified working

Reuses `merge_rects` from `px2svg.py` rather than reimplementing run-merging.

```python
#!/usr/bin/env python3
"""Slice one px2svg output into per-part <g> groups using a part-mask PNG.

The mask is the sprite repainted with one flat colour per part, same pixel
dimensions as the px2svg grid. Every sprite pixel is assigned to the part whose
mask colour covers it; rects are re-run-merged INSIDE each part so the output is
still one <path> per colour per part.

Reuses px2svg.merge_rects -- the grouping is the only new logic.
"""
import argparse, collections, json, re, sys
import numpy as np
from PIL import Image

sys.path.insert(0, __file__.rsplit('/', 1)[0])
from px2svg import merge_rects            # noqa: E402

RECT = re.compile(r'M(-?\d+) (-?\d+)h(\d+)v(\d+)h-(\d+)z')
HEAD = re.compile(r'<svg[^>]*viewBox="0 0 (\d+) (\d+)"[^>]*>')
PATH = re.compile(r'<path fill="(#[0-9a-f]{6})" d="([^"]*)"/>')


def load_grid(svg_path):
    """px2svg output -> (colour-index grid, palette). Index 0 is 'empty'."""
    s = open(svg_path).read()
    w, h = map(int, HEAD.search(s).groups())
    grid = np.zeros((h, w), np.int32)
    pal = ['']
    for fill, d in PATH.findall(s):
        pal.append(fill)
        c = len(pal) - 1
        n = 0
        for m in RECT.finditer(d):
            x, y, rw, rh, _ = map(int, m.groups())
            grid[y:y + rh, x:x + rw] = c
            n += 1
        if n == 0:
            raise SystemExit(f'{svg_path}: path for {fill} is not px2svg rect output')
    return grid, pal, w, h


def load_parts(mask_path, w, h, names):
    """Part-mask PNG -> (part-id grid, ordered part names). id 0 = unassigned."""
    m = Image.open(mask_path).convert('RGB')
    if m.size != (w, h):
        raise SystemExit(f'mask is {m.size}, sprite grid is {(w, h)} -- must match')
    a = np.array(m)
    keys = a[:, :, 0].astype(np.int32) << 16 | a[:, :, 1].astype(np.int32) << 8 | a[:, :, 2]
    order = [k for k, _ in collections.Counter(keys.ravel().tolist()).most_common()]
    if len(order) - 1 > len(names):
        raise SystemExit(f'mask has {len(order)} colours, {len(names)} part names given')
    # most common colour is the background -> id 0
    lut = {order[0]: 0}
    for i, k in enumerate(order[1:], 1):
        lut[k] = i
    ids = np.vectorize(lut.get)(keys).astype(np.int32)
    return ids, names[:len(order) - 1]


def slice_svg(svg_path, mask_path, out_path, names, zoom=4):
    grid, pal, w, h = load_grid(svg_path)
    parts, names = load_parts(mask_path, w, h, names)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
           f'width="{w*zoom}" height="{h*zoom}" shape-rendering="crispEdges">']
    stats, boxes = [], {}
    for pid, name in enumerate(names, 1):
        masked = np.where(parts == pid, grid, 0)
        rects = merge_rects(masked, 0)
        if not rects:
            stats.append((name, 0, 0))
            continue
        by = collections.defaultdict(list)
        for x, y, rw, rh, c in rects:
            by[c].append(f'M{x} {y}h{rw}v{rh}h-{rw}z')
        ys, xs = np.nonzero(parts == pid)
        cx, cy = (int(xs.min()) + int(xs.max()) + 1) / 2, (int(ys.min()) + int(ys.max()) + 1) / 2
        # transform-box stays at its default (view-box), so the origin is stated
        # in viewBox units and never drifts when a child animates.
        out.append(f'<g class="part" id="{name}" '
                   f'style="transform-origin:{cx:g}px {cy:g}px">')
        for c, ds in sorted(by.items(), key=lambda kv: -len(kv[1])):
            out.append(f'<path fill="{pal[c]}" d="{"".join(ds)}"/>')
        out.append('</g>')
        ys, xs = np.nonzero(masked != 0)          # painted art, not the mask
        boxes[name] = dict(x=int(xs.min()), y=int(ys.min()),
                           w=int(xs.max() - xs.min() + 1),
                           h=int(ys.max() - ys.min() + 1), px=int((masked != 0).sum()))
        stats.append((name, len(by), len(rects)))
    orphan = int(((parts == 0) & (grid != 0)).sum())
    out.append('</svg>')
    open(out_path, 'w').write(''.join(out))
    open(out_path.rsplit('.', 1)[0] + '.hitboxes.json', 'w').write(
        json.dumps({'w': w, 'h': h, 'parts': boxes}, indent=1))
    for name, cols, n in stats:
        b = boxes[name]
        print(f'  {name:<12} {cols:2d} paths  {n:5d} rects  '
              f'box {b["x"]:3d},{b["y"]:3d} {b["w"]:3d}x{b["h"]:3d}')
    print(f'  {"TOTAL":<12} {sum(s[1] for s in stats):2d} paths  '
          f'{sum(s[2] for s in stats):5d} rects  {len(open(out_path).read())//1024} KB')
    if orphan:
        print(f'  WARNING: {orphan} sprite pixels fall outside every part '
              f'(mask background covers painted art) -- they are DROPPED')
    return stats, orphan


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('svg'); a.add_argument('mask'); a.add_argument('out')
    a.add_argument('-n', '--names', required=True,
                   help='comma-separated part ids, most-pixels-first')
    a.add_argument('-z', '--zoom', type=int, default=4)
    n = a.parse_args()
    slice_svg(n.svg, n.mask, n.out, n.names.split(','), n.zoom)
```

### 6.3 Verified against the real asset

Run against `assets/sprites/boss.svg` with a 6-part mask:

```
  crown        10 paths    673 rects  box   0,230 230x 40
  wolf_l       11 paths   2110 rects  box   0,150 230x 80
  beast_r      12 paths   2129 rects  box  68, 60 160x 50
  torso        10 paths   1471 rects  box  54,110 173x 80
  arm_mace      9 paths    892 rects  box  85,  7 123x 53
  arm_claw      8 paths    379 rects  box  38,110  77x 40
  TOTAL        60 paths   7654 rects  118 KB
```

Round-trip check — rasterise input and output back to RGB grids and diff:

```
differing pixels: 0 / 62100
```

**Pixel-identical.** Costs:
- 13 → 60 `<path>` nodes (one per colour *per part*). Still trivial.
- 7 589 → 7 654 rects (+0.9 %): runs that spanned a part boundary get split.
- 118 187 → 120 644 bytes raw, but **22 768 → 22 761 bytes brotli**. Slicing is
  *free* over the wire. Ship the sliced file, never the monolith.

### 6.4 `transform-origin` and the `transform-box` trap

`transform-box`, from CSS Transforms Level 1 verbatim:

| | |
|---|---|
| Name | `transform-box` |
| Value | `content-box \| border-box \| fill-box \| stroke-box \| view-box` |
| **Initial** | **`view-box`** |
| Applies to | transformable elements |
| **Inherited** | **no** |

and `transform-origin`'s SVG special case, also verbatim:

> the initial used value is 0 0 as if the user agent style sheet contained:
> `*:not(svg), *:not(foreignObject) > svg { transform-origin: 0 0; }`

Two traps:

1. **`transform-box` is not inherited.** Setting it on a wrapper does nothing for
   the parts. `app/rig-prototype.html` correctly puts it on `.part` itself.
2. **`fill-box` drifts when a child animates.** SVG 2 defines a container's
   bounding box as the union over descendants *with their transforms applied*,
   excluding the container's own transform. So `transform-box: fill-box;
   transform-origin: 50% 50%` on a `<g>` whose children animate gives a reference
   box that moves every frame, and the rotation pivot wanders. For a flat rig
   (parts are siblings, nothing nested animates) this is invisible; the moment
   the boss gets an outer knockback `<g>` wrapping animated parts, it is a bug
   that looks like "the crown pivots wrong when the mace swings".

The slicer sidesteps both by **emitting absolute origins in viewBox units** and
leaving `transform-box` at its `view-box` default:

```html
<g class="part" id="crown" style="transform-origin:115px 250px">…</g>
```

`115px 250px` here are viewBox user units, not CSS pixels — under
`transform-box: view-box` the reference box is the viewBox, so `px` in
`transform-origin` means user units. Stable regardless of what any child does,
and computed by the same pass that computes the hitboxes.

If a part needs a pivot that is not its bbox centre (the mace arm should rotate
at the shoulder, not the middle), override it per-part in CSS — but keep it
absolute:

```css
#arm_mace { transform-origin: 190px 22px; }   /* shoulder, viewBox units */
```

---

## 7. How this wires into the rest of HEARTROT

### 7.1 The hitbox JSON is the bridge to the BOLT program

`svg_slice.py` writes `boss_parts.hitboxes.json` alongside the SVG:

```json
{
 "w": 230, "h": 270,
 "parts": {
  "crown":    { "x": 0,  "y": 230, "w": 230, "h": 40, "px": 9200 },
  "arm_mace": { "x": 85, "y": 7,   "w": 123, "h": 53, "px": 2552 }
 }
}
```

The design spec says the rig and the hitbox list are the same structure. This is
how that becomes literally true instead of aspirationally true: the same build
step emits the `<g>` groups the browser animates **and** the integer rectangles
the on-chain hitscan tests. The `Parts { crown, wolf_l, beast_r, thorns[4],
mace, claws }` component's bounds and the `<g id="...">` names come from one
file. Art changes → re-run the slicer → the program constants and the DOM ids
change together, or the build fails on a missing key.

`px` (painted pixel count per part) is also a free, defensible input for the part
HP tiers — a bigger part being tankier falls out of the art rather than a magic
number table.

Do **not** call `getBBox()` in the browser to derive these. It is main-thread
layout-forcing, it returns floats, and it would disagree with the chain by
sub-pixel amounts. Compute at build time from integer rects, ship the numbers.

### 7.2 Why compositing specifically matters for an ER client

The crank ticks the boss at ~400 ms. The client renders at 60–144 Hz. Everything
between two ticks is client-side interpolation, and the main thread is
simultaneously doing the un-cheap part of the ER subscription: websocket frame
decode, Borsh deserialisation of the changed component accounts, React state
updates.

A **composited** animation keeps running on the compositor thread while the main
thread is inside that work. A repainted one does not — it stalls exactly when a
tick lands, which is the worst possible moment because that is also when the
player is watching a bullet volley spawn. This is the concrete reason §3's
"transform/opacity/filter only" rule is a hard rule here and not style advice.

Corollary: the ER subscription callback must never write to `element.style.d`,
`fill`, `x`, `y`, `width`. It writes `transform` and `opacity`, or it sets a class
that starts a CSS animation. Nothing else.

### 7.3 The hit flash in the prototype is a repaint

`app/rig-prototype.html` currently has:

```css
.part.hit rect{fill:#fff !important}
```

That is a fill change on the group's contents — the 74.8 fps row in §2.2, plus
the `!important` interacts badly with `kAffectsImportantProperty` if it ever
moves onto an animated property. It is one frame, so it will probably never be
visible in a profile, but the composited alternative costs nothing:

```html
<g class="part" id="crown" style="transform-origin:115px 250px">
  <path fill="#af8c92" d="…"/>
  …
  <g class="flash" aria-hidden="true"><path fill="#fff" d="…full silhouette…"/></g>
</g>
```
```css
.flash{opacity:0}
.part.hit .flash{animation:flash .1s steps(1,end)}
@keyframes flash{0%{opacity:1}100%{opacity:0}}
```

The silhouette path is the union of the part's rects — the slicer already has it
(`masked != 0`), so emitting a `.flash` child is a five-line addition if the flash
ever shows up as a problem. **Skipped for now**: one repainted frame per hit is
almost certainly fine. Add it when a profile says otherwise.

### 7.4 Next.js on Cloudflare Workers

- The SVG must be **inline in the document**, not `<img src="boss.svg">`. An
  `<img>` gives no `<g>` handles, no CSS animation, no hit targets. Import the
  file as a string at build time and `dangerouslySetInnerHTML` it, or make it a
  server component that reads it. This is not negotiable for the rig.
- 120 644 bytes raw / **22 761 brotli** per boss. Workers brotli-compresses by
  default for `text/html`. That is acceptable inline; the arena (`temple.svg`,
  332 KB raw) is not, and belongs in the static background layer as a single
  pre-rendered raster per the spec's rule 1.
- Sprites are static assets with a content hash. Serve them from Workers static
  assets with a long `Cache-Control`, and inline only the boss.
- None of the four cold-path routes touch any of this. Rendering is entirely a
  client concern; nothing in this document adds a backend hop.

### 7.5 Web Animations API is the same fast path

Driving animations from JS state (part destroyed → detach) does not require
touching CSS classes. `element.animate()` goes through the same `KeyframeEffect`
→ `CompositorAnimations::CheckCanStartAnimationOnCompositor` path as a CSS
`@keyframes` rule, with the same rules from §3 and §4. Prefer it where the
animation is parameterised by game state (knockback direction, detach vector),
and keep CSS `@keyframes` for the idle loops.

```js
part.animate(
  [{ transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
   { transform: `translate(${dx}px,${dy}px) rotate(${rot}deg)`, opacity: 0 }],
  { duration: 500, easing: 'steps(6, end)', fill: 'forwards' });
```

`transform` shorthand, `opacity`, `steps()` easing — all three composited.

---

## 8. Contradictions with the current design spec

These are direct conflicts with
`docs/architecture/00-game-design-spec.md` §6 and should be resolved before
building on either.

### 8.1 "Pixel art is not SVG paths" — the stated reason does not hold

Spec §6, rule 2:

> **Pixel art is not SVG paths.** A 32px arm is ~40 rects after run-merging;
> 20 players × 8 parts × 40 = 6,400 animated nodes. It crawls and it does not
> match the reference art anyway.

The arithmetic conflates two different counts. **The animated node count is the
number of `<g>` groups, not the number of rects.** 20 players × 3 parts = 60
groups; the rects inside them are never animated individually and are rasterised
once. Measured (§2.2): 7 589 rects in 8 groups animate at 143 fps, identical to
static, on a *software* GL rasteriser.

The spec's conclusion — "each body part is an `<image>` holding a small pixel-art
raster" — is therefore not required by performance. It may still be right for
*art* reasons (the spec's "does not match the reference art anyway"), which this
research cannot judge. But the performance argument for it is not supported, and
the brief's pure-SVG rig is viable.

If the `<image>` route is taken anyway, note that `image-rendering: pixelated`
becomes load-bearing (§5.2) *and* every `<image>` is a separate HTTP request or
data URI, which the single sliced SVG avoids.

### 8.2 "≤128 bullets animated via CSS transform" is not free

Spec §6 lists the entity layer as `~60 player nodes + ~10 boss parts + ≤128
bullets, animated via CSS transform (GPU composited)`.

Measured (§2.3): those 128 extra nodes take the scene from 141.5 fps / p99
13.8 ms to 96.8 fps / p99 41.6 ms. They are composited, and they still cost —
201 `cc::Layer`s is layer-tree bookkeeping the compositor pays per frame.
`will-change: transform` on the bullets restores it fully. The spec should say
so explicitly, because "GPU composited" reads as "free" and it is not.

### 8.3 `px2svg` emits an inert attribute

`to_svg()` writes `image-rendering="pixelated"` on the `<svg>` root. Per MDN it
does not apply to SVG shapes (§5.2). Inert for our files. Either drop it or
comment it, so nobody later "fixes" crispness by tuning it.

### 8.4 Browser zoom is un-designed-for

Nothing in the spec addresses `EffectiveZoom() != 1` (§4.1). A player at 110 %
zoom silently gets a main-thread rig. This is the highest-severity item in this
document because it is invisible until a real user reports "it stutters" and it
is not reproducible locally.

---

## 9. Rules to hold, condensed

Animation:
1. Animate **`transform`** (shorthand) and **`opacity`** only. Never `translate`
   / `rotate` / `scale` on SVG. Never `fill`, `d`, `x`, `y`, `width`.
2. One `<g class="part">` per destructible part. Parts are **siblings**, not
   nested inside each other.
3. No SMIL anywhere in the sprite tree.
4. No `vector-effect`. No `<use x= y=>`. No nested `<svg>` for parts.
5. `will-change: transform` **only** on the bullet pool, and only because it was
   measured — not on the boss parts.
6. Keep the `prefers-reduced-motion` reset.

Pixel fidelity:
7. `shape-rendering: crispEdges` once, on the `<svg>` root. It is inherited.
8. Size the SVG so `cssScale × devicePixelRatio` is an integer (§5.3 helper).
9. Movement in whole sprite pixels; the game grid is integer, keep it that way
   through to the transform.

Build:
10. Ship the **sliced** SVG (free after brotli) plus its `.hitboxes.json`.
11. Hitboxes come from the build, never from `getBBox()`.
12. `transform-origin` in absolute viewBox units, `transform-box` left at
    `view-box`.

---

## 10. Open questions

- **§2 on real GPU hardware.** Every number here is from SwiftShader. The
  `will-change` win and the canvas loss both need confirming on a machine with
  hardware GL, and on a mid-range phone, before the bullet decision is frozen.
- **§5.3 visual confirmation.** The fractional-dpr pixel alternation is derived
  from spec text, not screenshotted. Needs a screenshot diff at dpr 1.25/1.5.
- **Firefox and Safari.** All compositing analysis here is Blink-specific. Gecko
  and WebKit have their own SVG compositing rules and neither was examined. The
  `EffectiveZoom` and `IndependentTransformProperty` restrictions are Chromium
  implementation details, not spec — Firefox may differ in both directions.
- **GPU memory at 201 layers on mobile.** Not measured. The `will-change`
  recommendation could invert on a memory-constrained device.
- **Art direction on §8.1.** Whether path-based pixel art reads correctly next to
  the reference art is not a performance question and is unresolved here.

---

## Sources

Fetched and read for this document:

- https://developer.mozilla.org/en-US/docs/Web/CSS/transform-box
- https://developer.mozilla.org/en-US/docs/Web/CSS/shape-rendering
- https://developer.mozilla.org/en-US/docs/Web/CSS/image-rendering
- https://developer.mozilla.org/en-US/docs/Web/CSS/will-change
- https://drafts.csswg.org/css-transforms-1/
- https://www.w3.org/TR/SVG2/coords.html
- https://caniuse.com/mdn-css_properties_transform-box
- https://developer.chrome.com/blog/re-rastering-composite
- https://developer.chrome.com/blog/hardware-accelerated-animations
- https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/animation/compositor_animations.h
- https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/animation/compositor_animations.cc
- https://chromium.googlesource.com/chromium/src/+/HEAD/third_party/blink/renderer/core/paint/compositing/compositing_reason_finder.cc
- https://chromium.googlesource.com/chromium/src/+/HEAD/cc/layers/picture_layer_impl.cc
- https://chromium.googlesource.com/chromium/src/+/HEAD/ui/gfx/animation/keyframe/timing_function.h

Referenced but **not** directly readable (sign-in wall; content known only from
search result snippets, treat with lower confidence):

- https://issues.chromium.org/issues/40753139 — "Some SVG rendering heavily
  pixelated in Chrome 89+"
- https://groups.google.com/a/chromium.org/g/blink-dev/c/5o0yiO440LM — "Intent to
  deprecate: SMIL"
- https://github.com/Fyrd/caniuse/issues/4167 — SMIL deprecation suspended

Local files read:

- `/home/anshtyagi/Documents/pixel-artgame/docs/architecture/00-game-design-spec.md`
- `/home/anshtyagi/Documents/pixel-artgame/tools/px2svg.py`
- `/home/anshtyagi/Documents/pixel-artgame/app/rig-prototype.html`
- `/home/anshtyagi/Documents/pixel-artgame/assets/sprites/*.svg`
