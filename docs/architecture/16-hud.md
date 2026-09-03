# 16 — HEARTROT HUD: telemetry and chrome for a full-screen game

**Date:** 2026-09-02
**Status:** Specification. Nothing here is implemented.
**Reads:** `app/src/ui/DevPanel.tsx` (297 lines), `app/src/ui/Hud.tsx` (447),
`app/src/App.tsx` (662), `app/src/screens/Lobby.tsx` (65), `app/src/screens/Gate.tsx` (308),
`app/src/net/metrics.ts` (251), `app/src/input/controls.ts` (470),
`app/src/styles.css` (1,159), `app/src/render/Arena.tsx`,
`programs/heartrot/src/handlers/shoot.rs`, `programs/heartrot/src/state.rs`.
**Changes:** `app/src/styles.css`, `app/src/App.tsx`, `app/src/ui/DevPanel.tsx`,
`app/src/ui/Hud.tsx`, `app/src/screens/Lobby.tsx`, one `export` in
`app/src/input/controls.ts`. **Zero chain bytes, zero instructions, zero CU.** Nothing in
this document touches the program, the wire ABI, the ER send path or the frame loop's
transform writers, so the measured 122 ms p50 / 132 ms p95 at twenty seats is untouched by
construction — see §9.

**Every number below was produced this session by a script named beside it.** Where a
number is arithmetic rather than a measurement it says so. Nothing here was measured
against live devnet; the latency and CU figures quoted are the brief's, cited as such.

---

## 0. Six findings, before the design

Read these first. Three of them are defects in the files this document redesigns, and one
of them contradicts the brief.

### 0.1 The HUD's shot cooldown is wrong by 6 ticks, and it lies green

`app/src/ui/Hud.tsx:96`

```ts
const SHOT_COOLDOWN_TICKS = 1;
```

`programs/heartrot/src/handlers/shoot.rs:140`

```rust
const SHOT_COOLDOWN_TICKS: u32 = crate::state::ticks_for(800) - 1;   //  = 7
```

`state.rs:145` has `TICK_MS = 100`, so `ticks_for(800) = 8` and the chain's constant is
**7**. `app/src/input/controls.ts:129` computes it correctly as `800 / TICK_MS - 1`. The
HUD's copy is the 400 ms-era literal (`800 / 400 - 1 = 1`) and nothing fails on it.

Consequence: `Hud.tsx:348`'s `shotReady = tick > slot.lastShotTick + 1` flips the **SHOT
READY** pill green **two ticks (200 ms)** after a shot, while `shoot.rs:374` refuses
everything until **eight ticks (800 ms)**. The pill reads READY for 600 ms of every
cooldown, during which every trigger pull is answered `RateLimited` and dropped invisibly
under `skipPreflight`. This is the same class of defect as the dead spacebar and it is
live today.

**Fix (§8.1):** delete the third copy. `controls.ts:217` already holds the predicate —

```ts
function shotAllowed(tick: number, lastShotTick: number): boolean {
  return tick > lastShotTick + SHOT_COOLDOWN_TICKS;
}
```

— it is simply not exported. Add `export`, import it in `Hud.tsx`, delete lines 88–96.
Seven characters plus a deletion, and `controls.ts`'s existing dev self-check
(`assert((SHOT_COOLDOWN_TICKS + 1) * TICK_MS === 800`, line 440) then covers the HUD too.

### 0.2 `refused` could never have shown the dead spacebar

The brief says `refused` "matters more because the dead spacebar was a refusal nobody could
see". Half right. The row must stay and must get more weight, but it would not have caught
this bug and it cannot catch the next one of its kind.

`metrics.ts:102`:

```ts
export function recordSend(seq?: number): void { … if (seq !== undefined) pending.set(seq, now); }
```

and its own docstring, line 99: *"`seq` is present for `move` only — `shoot` carries no
sequence number, so it counts toward throughput but never toward latency."* `refusedRate`
is computed at `metrics.ts:144` only inside the `lastSeq` reconciliation loop. **Every
number on the Throughput group except `sent` and `session` is move-only.** A shot refused
by `shoot.rs:374` increments `sent` and nothing else, forever.

So the shot-refusal signal is not and cannot be a metrics counter. It is a **pure function
of state the HUD already holds** — exactly the argument `Hud.tsx`'s own module docstring
makes at lines 16–22. The cadence pill is the instrument. Which brings us to:

### 0.3 The cadence pills are not mounted on the screen the bug lived on

`Hud.tsx:113` mounts `<SelfPanel />` — the health meter and the MOVE/SHOT pills — and
`App.tsx:220` mounts `<Hud />` only from `ArenaScreen`. `screenOf` returns `'lobby'` until
your own seat's `zone` flips, and `Lobby.tsx:43` renders a completely different panel:
`GatePrompt`, `Muster`, `MusterCounts`, `Roster`. **There is no cadence pill, no health
meter and no shot indicator anywhere in the waiting area.**

The spacebar has been refused on every press in the waiting area since `SHOT_COOLDOWN_TICKS`
went to 7, and the one widget that would have said so was on the other screen. Mounting the
self cluster on both sides of the gate (§5.3) is a one-line change and is the whole fix for
the *visibility* half of the spacebar report.

### 0.4 Four facts are stored twice, and deleting the header deletes all four

| Fact | Place A | Place B |
|---|---|---|
| your seat | `App.tsx:184` header tag | `DevPanel.tsx:248` Match › your seat |
| tick | `App.tsx:188` header tag | `Hud.tsx:254` Boss › Tick |
| connection status | `App.tsx:189-190` dot + label | `DevPanel.tsx:242` Feed › socket |
| incarnation | `App.tsx:183` header tag | `Lobby.tsx:59` closing paragraph |

The `.header` grid row is 48 px measured (script `run3.mjs`). Removing it on the two stage
screens costs nothing in information and buys 48 px of arena — see §1.2 for what that is
worth in pixels.

### 0.5 `--dim` cannot survive translucency; `--muted` can, down to α = 0.88

Computed, `contrast.py` (WCAG 2.x relative luminance, `--panel #121b27` alpha-composited
over backdrop, then contrast against the text colour). Backdrops are the p50/p99/p99.9 and
max luminance pixels sampled from the two reference PNGs (`lum.py`, 1122×785 and 1122×612,
every pixel).

Worst case is the boss's cyan orb, `rgb(161,252,243)` — the brightest large feature in
`actual_boss_arena.png` and the one a dragged panel will end up over.

| text token | α 1.00 | 0.92 | 0.90 | **0.88** | 0.86 | 0.85 |
|---|---|---|---|---|---|---|
| `--dim #74889f` | 4.76 | 3.88 | 3.66 | **3.45** | 3.24 | 3.14 |
| `--muted #8c9db4` | 6.27 | 5.12 | 4.83 | **4.54** | 4.27 | 4.13 |
| `--ink #dde7f2` | 13.85 | 11.31 | 10.66 | **10.04** | 9.43 | 9.14 |
| `--ok #62c39a` | — | — | 6.22 | **5.85** | 5.50 | — |
| `--torch #e0a94a` | — | — | 6.32 | **5.95** | 5.59 | — |
| `--ember #ff5a4a` | — | — | 4.33 | **4.07** | 3.83 | — |

Over the arena *floor* (`rgb(25,19,32)`, the median pixel) contrast **improves** with
transparency — 4.76 → 4.87 for `--dim` — because the backdrop is darker than the panel.
Transparency only costs anything over the bright accents.

**α = 0.88 is the floor**, and it is a floor because of `--muted` at 4.54:1. `--dim` is
below AA at every alpha the user would call transparent, and `.dev` currently uses it for
four things: group headings (9.5 px), units (10 px), notes (10 px), the foot (10 px). All
four must become `--muted` (§4.2). `--ember` at 4.07 is AA-large only and is used for
`.pill` warnings; keep it off small text.

### 0.6 A keyboard drag is impossible, so it is not built

`controls.ts:158`'s `KEY_VECTORS` binds `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`
as movement, and `onKeyDown` calls `event.preventDefault()` on every one (line 336) from a
`window` listener. An arrow-key nudge on a focused panel would either move the knight, or
require the panel to swallow the arrow keys — which is precisely the "document listener
that swallows WASD" the brief forbids. There is no free key left: `Space` is fire,
`Backquote` is the telemetry toggle, WASD is movement.

Panel *position* is a cosmetic preference and the panel is fully functional at its default
anchor, so the accessible answer is a **Reset position** item in the panel head (§3.6), not
a keyboard drag. Stated here so nobody adds one later.

---

## 1. The screen

### 1.1 What the play area is today

Measured, `run3.mjs`: the real `app/src/styles.css` applied to the real DOM shape, headless
Chromium 151.0.7922.34, at four viewports.

| viewport | `.header` | `.panel` column | `.stage` | stage share |
|---|---|---|---|---|
| 1920×1080 | 48 px | 320 px = 15.9 % of viewport | 1600×1032 | 79.6 % |
| 1600×900 | 48 | 320 = 18.9 % | 1280×852 | 75.7 % |
| 1440×900 | 48 | 320 = 21.0 % | 1120×852 | 73.6 % |
| 1280×800 | 48 | 320 = 23.5 % | 960×752 | 70.5 % |

`.main:has(> .stage) { grid-template-columns: minmax(0, 1fr) 320px }` — `styles.css:209`.

### 1.2 What it becomes, and the gutter that pays for the HUD

Measured, `run5.mjs`, with the 320 px column removed and the header toggled. The renderer
draws `viewBox="0 0 1024 1024"` (`Arena.tsx:648`) with no `preserveAspectRatio`, so the
default `xMidYMid meet` fits a **centred square** inside the stage box and leaves
transparent gutters left and right showing `.stage`'s own gradient.

| viewport | header | stage box | arena square | share of viewport | gutter per side |
|---|---|---|---|---|---|
| 1920×1080 | on | 1920×1032 | 1032 px | 51 % | **444 px** |
| 1920×1080 | off | 1920×1080 | 1080 px | 56 % | **420 px** |
| 1440×900 | on | 1440×852 | 852 px | 56 % | **294 px** |
| 1440×900 | off | 1440×900 | 900 px | 63 % | **270 px** |
| 1280×800 | on | 1280×752 | 752 px | 55 % | **264 px** |
| 1280×800 | off | 1280×800 | 800 px | 63 % | **240 px** |

**This is the load-bearing fact of the whole document.** A square world in a 16:9 viewport
always leaves 240–444 px of dead space on each side. The 268 px telemetry panel fits inside
the 420 px gutter at 1920×1080 with 152 px to spare, and every HUD cluster fits at every
width tested except the 1280×800 corner.

The consequence is a design rule that needs **no JavaScript, no `ResizeObserver`, no
breakpoint and no measurement at runtime**:

> **Anchor every HUD cluster to a viewport edge or corner. The square is centred, so an
> edge-anchored cluster lands in the gutter for free wherever the gutter is wide enough,
> and overlaps only the outermost stone of the arena when it is not. Translucency (§4)
> covers the overlap case. Do not build gutter detection.**

Removing the header buys 48 px of square: 1032 → 1080 px at 1920×1080, +4.7 % linear and
+9.6 % area. Take it (§0.4), because the header is four facts already shown elsewhere. Do
**not** replace it with a full-width absolutely-positioned bar — that band sits exactly
where the boss stands, and the boss staying top-middle and unoccluded is a stated user
requirement.

### 1.3 The eight anchors

```
┌───────────────────────────────────────────────────────────────────────┐
│ [TL] phase · tick · socket        [TC] boss bar / muster clock        │  ← over the gutter
│                                                                       │     shoulders, never
│                                        ╔═══════════════════╗          │     over the boss
│                                        ║                   ║          │
│  [ML] verdict                          ║   THE  SQUARE     ║   [MR] telemetry
│       (transient)                      ║                   ║          │     [default anchor,
│                                        ║                   ║          │      draggable]
│                                        ╚═══════════════════╝          │
│ [BL] you: hp · MOVE · SHOT         [BC] one line of instruction   [BR] parts
└───────────────────────────────────────────────────────────────────────┘
```

| anchor | contents | mounted on |
|---|---|---|
| TL | phase name, `tick`, connection dot | lobby + arena |
| TC | boss shell + core bar (fighting) — or the muster clock (lobby/mustering) | both, exclusive |
| ML | verdict card, transient | arena |
| MR | telemetry panel, **draggable**, default anchor | both |
| BL | your hp meter, MOVE pill, SHOT pill | **both** — see §0.3 |
| BC | at most one line of instruction (gate prompt) | lobby only |
| BR | the nine part meters, collapsed by default | arena, fighting |

TC sits **above** the square's top edge in the gutter shoulders where the viewport is
taller than wide; where it is not, it is a horizontal bar spanning the square's top 40 px,
which in both reference compositions is wall, banner and chain — never the creature.

---

## 2. Telemetry: the panel keeps every number

Non-negotiable: all 21 rows and all 5 groups survive verbatim. Measured, `run4.mjs`: the
full panel renders 268 × 701 px with the foot paragraph, 268 × 644 px without, 21
`.dev-row` elements, and does not clip at any viewport ≥ 800 px tall.

| group | rows | keep |
|---|---|---|
| Round trip | p50, p95, last | all |
| Throughput | sent, acked, in flight, unacked, **refused**, session | all |
| Feed | tick, feed age, socket | all |
| Match | arena, your seat, roster, validator | all |
| Cost | you pay, treasury, burned, burn rate, per match | all |

Two changes only:

1. **`refused` is promoted.** It moves to the top of the Throughput group and keeps its
   `grade(m.refusedRate, 0.01, 0.05)` thresholds and its `two sends, one ER slot` note
   verbatim. Its note gains a second clause naming its scope, because §0.2 proves the
   current label overclaims: **`moves only — a refused shot is not counted here`**. That
   sentence is the entire fix for the honesty defect, and it is cheaper than building a
   shot counter nothing on the wire can feed.
2. **`--dim` → `--muted`** on `.dev-group h3`, `.dev-unit`, `.dev-note`, `.dev-foot`
   (§0.5). Four declarations.

Layout stays one column at 268 px. A two-column variant was measured (`run5.mjs`) at
352 × 445 px: shorter, but 352 px exceeds the gutter at every viewport below 1920 wide,
where the one-column 268 px still fits. One column wins on the widths that are tight.

`DevPanel`'s 250 ms sampling (`SAMPLE_MS`), its 15 s treasury poll, its backtick toggle and
its `.dev-cue` resting state are all correct as written and are not touched.

---

## 3. Dragging

### 3.1 The handle

`.dev-head` — the existing `<div>` holding the `<h2>Telemetry</h2>` and the close button —
becomes the grip. It is a `<div>`, **not a `<button>`**, and it stays that way:

Measured, `harness.html` + `run.mjs`/`run2.mjs`, headless Chromium 151, with `controls.ts`'s
exact `window` keydown wiring replicated (`preventDefault()` on `Space`):

| test | result |
|---|---|
| `Space` with a `<button>` focused | `controls:space-keydown` fires, **`BUTTON:click` does not** |
| `Space` with a `div[tabindex]` focused | `DIV:keydown-Space` and the shot both fire, no click |
| `Space` with `<body>` focused | shot only (baseline) |
| **`Enter` with a `<button>` focused** | **`BUTTON:click` fires**, no shot |
| `KeyD` with a `<button>` focused | movement only, no button interference |

So: **`Space` is the game's, unconditionally.** A `<button>` in the HUD cannot be activated
by `Space` while controls are attached, because `controls.ts` preventDefaults the keydown
before the browser's activation behaviour runs. `Enter` works. Two rules follow, and they
are the entire keyboard contract for the HUD:

- Every HUD control stays a real `<button>` so `Enter`, focus rings and screen readers
  work. Do not swap in `div[role=button]`.
- **No HUD control may add a `Space` handler**, and none may rely on `Space` to activate.
  If a control's only affordance is `Space`, it is unreachable.

### 3.2 Pointer capture is required, not preferred

Measured, `run2.mjs`, a 10-step drag from the grip across the stage:

| wiring | pointermove events the handle received |
|---|---|
| `setPointerCapture` on the grip | **10 of 10** |
| no capture, listener on the grip | **0 of 10** |

Without capture the panel freezes after the first pixel, because the pointer leaves the
24 px grip immediately. Capture is the mechanism, not a robustness nicety.

### 3.3 Capture is also what keeps the drag out of the game

Measured, `run.mjs`, same 10-step drag while `#stage` carries `controls.ts`'s
`pointerdown`/`pointermove`/`pointerup` listeners:

```
E drag over stage : ["grip:pointerdown","grip:pointermove","grip:pointerup"]   ← stage: nothing
F click panel body: []                                                          ← stage: nothing
```

The stage received **zero** pointer events for the whole drag and zero for a click on the
panel body. Two independent reasons, both worth knowing:

1. `.dev` is `position: fixed` and a **sibling** of `<main>` in `App.tsx`'s tree
   (`App.tsx:147-163`), not a descendant of `#stage`, so nothing on it bubbles to the
   stage's listeners even when it is drawn on top of the arena.
2. Capture retargets every subsequent event to the grip regardless of what is underneath.

**Therefore: no `document` listener, no `window` listener, no global `pointermove`.** All
three handlers bind to the grip element itself. This satisfies the brief's constraint by
construction rather than by a guard.

### 3.4 Move by transform, never by `left`/`top`

Measured, `run2.mjs`, 300 rAF-paced position writes with a forced `getBoundingClientRect`
per step, counted with CDP `Performance.getMetrics`:

| write | LayoutCount | RecalcStyleCount | wall |
|---|---|---|---|
| `style.transform = translate(x,y)` | **+1** | +300 | 5000 ms |
| `style.left` / `style.top` | **+299** | +299 | 4995 ms |

The wall times are identical because both are rAF-bound — the wall clock is not the signal
here, the layout count is. 299 forced layouts land inside a frame loop whose measured
budget at 20 knights under 6× CPU throttle is p50 9.38 ms / p95 14.92 ms of 16.7 ms
(brief's figure). `left`/`top` dragging spends the p95 headroom on nothing.

This is the same rule `Hud.tsx:179` already states for `.meter-fill` (`--fill` and a
composited `scaleX`, never `width`). Same reason, same file, do not diverge.

### 3.5 The drag, exactly

```
state: dragging: { pointerId, grabX, grabY, baseX, baseY } | null   (a ref, not React state)
offset: { x, y }                                                    (a ref; React never re-renders during a drag)

.dev-head  style: touch-action: none; cursor: grab;   (:active → grabbing)

onpointerdown(e):
  if (e.button !== 0) return
  if (e.target.closest('button')) return          // the close button is not a grip
  head.setPointerCapture(e.pointerId)
  dragging = { pointerId: e.pointerId, grabX: e.clientX, grabY: e.clientY, baseX: offset.x, baseY: offset.y }
  e.preventDefault()                              // suppress text selection on the <h2>

onpointermove(e):
  if (!dragging || e.pointerId !== dragging.pointerId) return
  offset = clamp(dragging.baseX + e.clientX - dragging.grabX,
                 dragging.baseY + e.clientY - dragging.grabY)
  el.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`

onpointerup / onpointercancel(e):
  if (!dragging || e.pointerId !== dragging.pointerId) return
  head.releasePointerCapture(e.pointerId)
  dragging = null
  save(offset)                                    // one write per drag, not per move
```

`touch-action: none` on the grip is required, not decorative: without it a touch pointer is
consumed by the browser's pan gesture and `pointermove` is followed by `pointercancel`
mid-drag.

`clamp` is the only arithmetic here and it is what stops a resized window stranding the
panel off screen. The panel is anchored `right: 12px; bottom: 12px` (`styles.css:1031`), so
the offset is negative-left / negative-up from that corner:

```
const MARGIN = 8;          // px of panel that must stay on screen on every edge
clamp(x, y):
  const r = el.getBoundingClientRect();           // the UNTRANSFORMED box is right:12 bottom:12
  const restX = innerWidth  - 12 - r.width;       // left edge of the panel at offset 0
  const restY = innerHeight - 12 - r.height;
  x = min(12 - MARGIN, max(-(restX + r.width - MARGIN), x))
  y = min(12 - MARGIN, max(-(restY + HEAD_H),           y))   // HEAD_H = the grip's height
```

The y-floor uses the grip height, not the panel height: a panel dragged mostly off the
bottom is fine as long as the bar you grab it by is still reachable.

Re-clamp on `window.resize` (one listener, passive, on the panel component — not on the
document) and on read from storage.

### 3.6 Reset

The head gets one more `<button>`, `⤢` / `reset`, `aria-label="Reset telemetry position"`,
which sets `offset = {0,0}`, clears the stored value and clears the inline transform.
`Enter`-activatable per §3.1. This is the accessible substitute for §0.6's impossible
keyboard drag and it is three lines.

---

## 4. Persistence and translucency

### 4.1 `localStorage`, and what it does when it throws

Measured, `run2.mjs`: `localStorage.setItem` in an opaque origin (a `data:` URL page) throws
**`SecurityError`**, it does not return `null`. Chromium 151. Private windows, cleared site
data and "block third-party cookies" configurations reach the same place.

```ts
const KEY = 'heartrot.telemetry';

function load(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { x: 0, y: 0 };
    const v: unknown = JSON.parse(raw);
    if (typeof v !== 'object' || v === null) return { x: 0, y: 0 };
    const { x, y } = v as Record<string, unknown>;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };
    return { x: x as number, y: y as number };          // §3.5 clamp still runs on this
  } catch {
    return { x: 0, y: 0 };                              // throws, absent, or garbage: same answer
  }
}

function save(o: { x: number; y: number }): void {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* a preference, not a fact */ }
}
```

Requirements, each of which the code above satisfies and none of which may be dropped:

- One `try`/`catch` around **both** the read and the write. A throwing `getItem` on a page
  that has not caught it takes the whole panel down at mount.
- A failed read is the default position, never an error state and never a message.
- `JSON.parse` is inside the same `try` — a truncated value is the same failure.
- `Number.isFinite` on both fields. A stored `null`, `"12"` or `NaN` must not reach
  `translate3d`, where it produces an invalid declaration and a silently unmoved panel.
- The clamp of §3.5 runs on the loaded value before it is applied. A value stored on a
  2560-wide monitor must not strand the panel off a 1280-wide laptop.
- Store the **offset from the anchor**, not absolute `left`/`top`. The anchor is a corner,
  so the same offset means the same thing after a resize.
- Do not version the key. A shape change fails the type guards and falls back to default,
  which is the correct behaviour anyway.

Only the position persists. `open` does not: `DevPanel.tsx:78` deliberately reasons that
the panel opens by default because the measurable claim *is* the demo, and that decision is
outside this document's scope.

### 4.2 Translucency

Exactly one declaration changes on `.dev`, plus the four `--dim` promotions from §0.5.

```css
.dev {
  /* was: color-mix(in srgb, var(--panel) 97%, transparent) */
  background: color-mix(in srgb, var(--panel) 88%, transparent);
}
.dev-group h3,
.dev-unit,
.dev-note,
.dev-foot        { color: var(--muted); }   /* was --dim; see §0.5 */
.dev-foot code   { color: var(--ink); }     /* was --muted */
```

88 % is the measured floor, not a taste value: at 86 % `--muted` falls to 4.27:1 over the
boss's cyan orb and stops being AA text. Anyone who wants it more transparent must first
change the text colours, and the table in §0.5 says which ones survive where.

**No `backdrop-filter`.** `styles.css:1042` already gives the reason and it is still true:
the pixels behind the panel change every frame, so a blurred backdrop is a per-frame
readback of a 268 px region inside a 16.7 ms budget. The existing
`box-shadow: 0 10px 34px -8px rgb(0 0 0 / 0.75)` is what separates the panel from the
scene, and it stays.

The 1 px `--line` border stays and matters more at 88 % than at 97 %: it is what keeps the
panel's edge findable over a bright brazier.

---

## 5. The compact HUD

Everything in this section is a **restyle and a remount of components that already exist**.
No new state, no new selectors, no new subscription. `Gate.tsx`'s rule 2 — *select
integers, render seconds* — governs every one of them, because the Magic Router delivers
each notification twice and 68.4 % of `Players` frames carry no position change.

### 5.1 Shared overlay chrome

```css
.hud {                          /* every cluster */
  position: fixed;
  z-index: 30;                  /* under .dev at 40, over the stage */
  pointer-events: none;         /* the arena is underneath and aiming must reach it */
  background: color-mix(in srgb, var(--panel) 88%, transparent);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 8px 10px;
  box-shadow: 0 8px 26px -10px rgb(0 0 0 / 0.75);
}
.hud button, .hud [role='meter'] { pointer-events: auto; }
```

`pointer-events: none` on the cluster with `auto` on its interactive children is the whole
reason a HUD may overlap the square at 1280×800 without stealing aim: `controls.ts`'s
`onPointerDown` fires on `#stage`, and a `pointer-events: none` overlay does not hit-test,
so a click through the corner of the hp cluster still aims and fires. Measured indirectly by
§3.3's F case (a click on an interactive panel reaches the stage: **not at all**) — which is
exactly why the non-interactive clusters must opt out.

### 5.2 TL — phase

Replaces the `.header` row's right group. Three items, one line, ~180 px:

```
LOBBY · tick 0 · ●        MUSTERING · 0:14 · ●        FIGHTING · tick 812 · ●
```

Phase name from `arena.phase`; `tick` and the `.dot dot-{status}` markup lift verbatim from
`App.tsx:186-191`. The wordmark moves to the onboarding and character-select cards, which
are already full-screen `.card` layouts with room for it.

### 5.3 BL — you. **Mounted in the lobby too.**

`SelfPanel` from `Hud.tsx:336`, restyled into a corner cluster:

```
  ▓▓▓▓▓▓▓▓░░  84        ← .meter, tone --ok / --gone, existing markup
  [MOVE READY] [SHOT COOLING]
```

Changes:

- **Mount it from `Lobby.tsx` as well as `ArenaScreen`.** This is §0.3's fix. `SelfPanel`
  already returns `null` when `mySeatSlot` is null, and its `moveReady` line already tests
  `phase !== PHASE_FIGHTING` explicitly (`Hud.tsx:347`), so it is correct in the lobby as
  written and only ever failed to be *there*.
- Take `shotAllowed` from `controls.ts` per §0.1 and delete the local constant.
- The two explanatory `<p className="fine">` paragraphs at `Hud.tsx:376-384` come off the
  play screen. The RateLimited/PlayerDead explanation goes to the onboarding card; the
  `damage dealt · deaths` line moves into the telemetry panel as a sixth group, **You**,
  where the rest of the session numbers live.

The pill pair is the shot-refusal instrument §0.2 says the metrics module cannot be. Once
it is on screen in the lobby, a permanently-grey **SHOT COOLING** in an empty waiting area
is a legible bug report rather than a key that does nothing.

### 5.4 TC — the boss bar, or the muster clock. Never both.

Mutually exclusive on the same anchor, on the same test `Hud.tsx:120` already uses:

```ts
const mustering = phase === PHASE_LOBBY || phase === PHASE_MUSTERING;
```

**Mustering** — `Muster` from `Gate.tsx:125`, unchanged logic: the seconds digits, the
`.meter` with `--fill` driving the composited `scaleX`, and the "{n} in the pit" line. It
belongs directly under the gate sign of `waiting_area_full_vertical.png`, which is where the
eye already is. `MusterCounts` (`Gate.tsx:229`) merges into it — "3 in the pit" already says
half of it, and `seated / MAX_SEATS` is duplicated on the telemetry panel's Match › roster
row.

**Fighting** — a horizontal boss bar, the genre convention, ~520 px:

```
        THE AMALGAM                     [VENT SEALED]  opens below 35% shell
  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░  62%          ← shell, tone --flesh
  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  sealed      ← core,  tone --olive
        0:47 to enrage · 12 alive · hunting you
```

Every value and every tone lifts verbatim from `Vent` (`Hud.tsx:296`) and `BossPanel`'s
`.stats` list. `shellPercent` keeps the program's integer arithmetic and its dev self-check
at `Hud.tsx:396` — the check that stops the bar reading 35 % beside an open vent — moves
with it unchanged.

`Incoming` (the live bullet count) does **not** come to TC. It is a debugging number, not a
raid decision, and the bullets themselves are on screen; it moves to the telemetry panel's
Feed group.

### 5.5 BR — the nine parts, collapsed

The `.parts` list from `Hud.tsx:231` in a corner cluster, **collapsed to a header by
default**, expanded by a `<button>` (Enter-activatable, §3.1). Collapsed it shows one line:

```
  ▸ parts 6/9 standing
```

`PART_NAMES` and its `PART_NAMES.length !== N_PARTS` import-time throw (`Hud.tsx:74`) and
the `MUZZLES[i].part === i` thorn-order self-check (`Hud.tsx:428`) move with the list,
unchanged. Those two checks are the only thing standing between the panel and labelling
every row with the wrong limb, and they are cheap.

Expanded state is **not** persisted. It is one click and the default is right for the 95 %
case; a second `localStorage` key for it is the kind of thing this project's own
`ponytail:` convention exists to refuse.

### 5.6 ML — verdict

`Verdict` (`Hud.tsx:155`) as a centred card over the square, `role="status"` kept. It is
transient, it fires once per match, and it is the one cluster allowed to occlude the boss —
by then the boss is dead or the raid is.

### 5.7 The roster

`Roster` (`Gate.tsx:199`) is twenty two-column rows, which is 320 px-panel furniture. As an
overlay it becomes a strip of twenty 10 px dots at the bottom edge of the TL cluster:

- fill = `SKIN_COLORS[skinId]`, the same colour the knight is drawn in — the existing `Dot`
  component (`Gate.tsx:255`) already does exactly this and is reused as-is;
- empty seat = `--line` outline, no fill;
- in the pit (`zone === ZONE_ARENA`) = `--lobby-green` ring, the one warm colour the
  stylesheet reserves for the gate;
- your seat = `--ink` outline.

`aria`: the strip is an `<ol>` with the existing `aria-current` on your own seat and one
`aria-label` per dot (`seat 03, in the pit`). The counts a screen reader actually needs —
seated and in-pit — are on the telemetry panel's Match group as text.

---

## 6. The waiting-room and muster copy

The room is now the screen, and the room says most of it. `waiting_area_full_vertical.png`
puts a lit portcullis under a **BOSS FIGHT** sign at top centre with braziers either side;
nothing in a panel competes with that. So the copy is cut to what a player cannot see.

| copy, today | where it goes |
|---|---|
| `GatePrompt` — "N tiles to the gate / WASD or the arrow keys" (`Gate.tsx:104`) | **BC, one line**, over the floor, ~2 s fade when it changes. Kept: it is the only thing on screen that answers "what do I do", and it already vanishes on its own when your `zone` flips. |
| `GatePrompt` — "Hold here. The gate is reading you." + the 500 ms-poll paragraph (`Gate.tsx:92-101`) | **BC, two lines**, condensed to `Hold here — the gate is reading you. You can let go of the keys.` The second clause survives because it is the answer to a real confusion produced by a real mechanism (`App.tsx`'s `GATE_RETRY_MS` poll), and a player who keeps mashing keys reads the round trip as a broken game. |
| `Muster` countdown + bar (`Gate.tsx:154`) | **TC**, §5.4. |
| `Muster` — "At zero the thing lowers itself over the rim…" (`Gate.tsx:181`) | **Onboarding card.** It is world-building read once, not a thing you consult mid-wait. |
| `MusterCounts` — Seated / In the pit (`Gate.tsx:229`) | merged into TC's one line and the telemetry Match group. |
| `Roster` (`Gate.tsx:199`) | **TL dot strip**, §5.7. |
| `Lobby.tsx:58` — "Incarnation N. Every raid the boss survives…" | **Onboarding card.** The number itself is already on the telemetry panel's Match group. |
| `Lobby.tsx:44` — `<h3>The lobby</h3>` | Deleted. You are standing in it. |

`Lobby.tsx` ends as roughly ten lines: the BC prompt and nothing else. `screens/Gate.tsx`
keeps every export and every self-check; only its call sites move.

---

## 7. What is deleted

Deletion is most of this document. In diff order:

| delete | why | §|
|---|---|---|
| `.main:has(> .stage)`'s `320px` column | the play area is the screen | 1.1 |
| `.panel` rule (the `<aside>` styling) | nothing renders in that column any more | 1.1 |
| `.header` row on the two stage screens | four facts, all shown elsewhere | 0.4 |
| `Hud.tsx:88-96` `SHOT_COOLDOWN_TICKS` | third copy, and the wrong one | 0.1 |
| `Hud.tsx:376-384` two `.fine` paragraphs | to the onboarding card | 5.3 |
| `Gate.tsx:181-185` the closing muster paragraph | to the onboarding card | 6 |
| `Lobby.tsx:44,55,58-61` heading, heading, paragraph | scene, TL, onboarding | 6 |
| `MusterCounts`'s `<dl>` shell | two numbers, absorbed | 5.4 |
| `BossPanel`'s `Incoming` row | to telemetry Feed | 5.4 |

Nothing is added except: one draggable head (§3.5, ~35 lines), one storage helper (§4.1,
~20 lines), one reset button, and CSS.

---

## 8. The exact changes

### 8.1 `app/src/input/controls.ts` — one word

```diff
-function shotAllowed(tick: number, lastShotTick: number): boolean {
+export function shotAllowed(tick: number, lastShotTick: number): boolean {
```

Everything else in that file is untouched. `MOVE_MS = 50`, `MIN_GAP_MS = 45`,
`PUMP_MS = 50`, the `nextMoveDeadline` grid walk and every self-check stay exactly as they
are — they are the ER cadence and they are not this document's business.

### 8.2 `app/src/ui/Hud.tsx`

Delete the local constant, import the predicate, split the panel into the clusters of §5.
`SelfPanel` gains no logic. `PART_NAMES`, `VERDICTS`, `shellPercent`, `clock`, `Meter` and
the whole `import.meta.env.DEV` block at line 396 move unchanged.

### 8.3 `app/src/ui/DevPanel.tsx`

The head becomes the grip (§3.5), the reset button joins the close button, `refused` moves
to the top of Throughput and gains its scope clause, and a sixth **You** group takes
`damage dealt` and `deaths`. The 250 ms sampler, the treasury poll, the backtick toggle and
all 21 existing rows are untouched.

### 8.4 `app/src/styles.css`

`.dev` background 97 % → 88 %; four `--dim` → `--muted`; the `.hud` cluster rules of §5.1;
delete `.panel` and the 320 px column; keep `.dev-cue`, the scrollbar theming, the
reduced-motion block and the whole scene section verbatim.

### 8.5 `app/src/App.tsx` / `screens/Lobby.tsx`

`Header` renders only on `onboarding` and `select`. `ArenaScreen`'s `<aside className="panel">`
becomes the cluster set. `Lobby` renders the BC prompt. `useMatchLink`, `useGateEntry`,
`useMuster`, the `#stage` ref and the `World` portal are **not touched** — `App.tsx:116-131`
explains at length why the stage node's identity must survive the gate flip, and a
restructure that remounts it costs 46.3 ms of `SCENE` rebuild on the game's most important
transition.

---

## 9. Why none of this can slow the rollup down

The user's hard constraint, stated twice. Point by point:

| the constraint | why this document cannot violate it |
|---|---|
| ER write-to-visible p50 122 ms | Nothing here touches `connection.ts`, its blockhash cache, `instructions.ts`, or the send path. No new transaction, no new account read. |
| `boss_tick` at 24,884 CU of 399,700 | Zero program changes. No new bytes, no new instruction, no `PlayerSlot` field. The free `_pad0` byte is untouched by this document. |
| `move` takes `Arena` read-only, so twenty seats do not serialise | Unchanged; no instruction's account list is edited. |
| Frame budget p50 9.38 / p95 14.92 ms at 20 knights | The drag writes one `transform` per `pointermove` and forces **1** layout per 300 moves (§3.4, measured). The HUD re-renders on notifications, as it does today, and every selector stays a primitive per `Gate.tsx`'s rule 2. No cluster is inside `#stage` and none is written by the rAF loop. |
| One writer per node transform | The HUD is React's, the world is the frame loop's, and they share no node. `predictor.self` and the interpolators are not read here. |
| `MOVE_MS = 50` is the chain's floor | Untouched (§8.1). |
| `layout.ts` mirrors `player.rs` | Untouched. |
| Generated files | Untouched. `map.rs`, `hitboxes.rs` and their TS mirrors are read-only to this document. |

The one thing this document *removes* from the frame's way: `backdrop-filter` is refused
again at 88 % opacity (§4.2), for the reason `styles.css:1042` already gives.

---

## 10. Checks

Two pieces of non-trivial logic land here — the clamp and the storage parse — and both fail
quietly. The clamp fails by stranding the panel where nobody can grab it; the parse fails by
taking the panel down at mount on a browser with storage blocked. One dev-only block, in the
style of `metrics.ts:218` and `controls.ts:420`, in `DevPanel.tsx`:

```ts
if (import.meta.env.DEV) {
  const assert = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`DevPanel self-check: ${what}`);
  };

  // The clamp. Both failures put the grip off screen, where the panel is unrecoverable
  // without clearing site data.
  const box = { width: 268, height: 700 };          // measured, run4.mjs
  const vp = { w: 1280, h: 800 };
  const far = clampOffset({ x: -9999, y: -9999 }, box, vp);
  assert(far.x > -(vp.w), 'a panel dragged past the left edge keeps MARGIN on screen');
  assert(far.y > -(vp.h), 'a panel dragged past the top edge keeps its grip on screen');
  const past = clampOffset({ x: 9999, y: 9999 }, box, vp);
  assert(past.x <= 12 - MARGIN && past.y <= 12 - MARGIN, 'the rest anchor is the far bound');
  // The regression that motivates it: a value stored on a wide monitor, read on a narrow one.
  const stranded = clampOffset({ x: -2000, y: 0 }, box, { w: 1280, h: 800 });
  assert(stranded.x > -1280, 'a position stored at 2560 wide is pulled back onto a 1280 screen');

  // The parse. Each of these is a real value a browser can hand back.
  for (const raw of ['', 'null', '{}', '{"x":null,"y":0}', '{"x":"12","y":0}', '{"x":1e999,"y":0}', '[1,2]']) {
    const v = parseStored(raw);
    assert(Number.isFinite(v.x) && Number.isFinite(v.y), `garbage "${raw}" must fall back to a finite default`);
  }
}
```

`clampOffset` and `parseStored` are therefore pure functions taking their viewport and box
as arguments — that is the only structural requirement this section imposes, and it is what
makes the check runnable without a DOM.

Manual checks, in the order they catch the most:

1. Press `Space` in the waiting area. The **SHOT COOLING** pill must be visible and grey
   (§0.3). Today there is no pill on that screen at all.
2. Fire in a fight and watch the pill. It must stay grey for 8 ticks, not 2 (§0.1).
3. Drag the panel over the boss's chest orb and read the 9.5 px group headings (§0.5).
4. Drag the panel while holding `D`. The knight must keep walking, and the panel must
   follow the pointer past its own edge (§3.2, §3.3).
5. Focus the close button and press `Space`. A shot must fire and the panel must stay open
   (§3.1). Press `Enter`: the panel closes.
6. Reload in a private window. The panel must appear at its default anchor with no error
   (§4.1).
7. Resize from 1920 to 1280 with the panel dragged left. It must not leave the viewport
   (§3.5).

---

## 11. Scripts

All under
`/tmp/claude-1000/-home-anshtyagi/0170737a-3afb-4aa1-86f7-94a879050eb1/scratchpad/bench/`
(session scratch — copy into `tools/` if these need to survive), headless Chromium
151.0.7922.34 via Playwright 1.62.1, viewport sizes as stated in each table.

| script | produces |
|---|---|
| `harness.html` + `run.mjs` | §3.1 rows A–D, §3.3 rows E–F — a replica of `controls.ts`'s window keydown and `#stage` pointer wiring |
| `run2.mjs` | §3.1 `Enter`, §3.2 capture 10/10 vs 0/10, §3.4 CDP `LayoutCount`, §4.1 `SecurityError` |
| `run3.mjs` | §1.1 — the shipped `styles.css` against the shipped DOM shape |
| `run4.mjs` | §2 — the full 21-row panel's rendered box, and the letterbox gutter |
| `run5.mjs` | §1.2 — the gutter table with the column removed and the header toggled |
| `lum.py` | reference-PNG luminance percentiles (every pixel of both images) |
| `contrast.py` | §0.5 — WCAG contrast of each token over each backdrop at each alpha |

**Honest limits.** Every browser number came from one headless Chromium on one machine;
Firefox and WebKit were not measured (no binary installed) and pointer-capture retargeting
is the one behaviour where they have historically differed — if the panel ever fights the
game on Firefox, §3.3 is the section to re-measure first. The `LayoutCount` figures come
from a synthetic page, not from the live arena, so they establish the *mechanism* (transform
does not relayout, `left`/`top` does) and not a frame-budget delta in the real scene. The
gutter table assumes the renderer keeps a square `viewBox`; if the scene rebuild changes it
to match the reference images' 1.43:1 and 1.83:1 aspects, the gutters shrink and the
edge-anchoring rule of §1.2 still holds — it was written not to depend on the number.

---

## 12. Fury on the HUD (added 2026-09-03)

`10-boss.md` §1.2.1 adds an HP-based state, **fury**, distinct from the six-minute enrage
timeout. Three HUD-side changes, all reading `layout.ts`'s `fightHp` / `isFurious` and
never a second formula:

- **The vitals row prints `boss NN%` from `fightHp`, not `shell NN%`.** Shell above the
  vent line never has to come off, so a solo bar read `shell 97%` three hits from a win.
  The percentage is floored (`floorPercent`, the old `shellPercent`), so the number can
  never read 21 % beside ENRAGED; the label is `isFurious`'s, the number is a ceiling.
- **While furious and `FIGHTING` the same span reads `ENRAGED NN%` in `--ember`**
  (`.hud-enraged`, `styles.css`). `--ember` is AA-large only (§0.5); accepted once, for a
  fight-state flag beside a number in `--ink`.
- **`.fury-wash`** — a red edge vignette, an HTML sibling of the `<svg>` in `Arena.tsx`,
  mounted once and toggled by `.is-on`, room B only, opacity-only animation, static at
  0.8 under reduced motion. Same lens-effect rules as `.stage::after`: alpha compositing,
  no blend modes.

The self-check block gains the fury rows (furious flips at exactly `FURY_PCT`, and the
shown percent is `≤ FURY_PCT` whenever furious) and names `VENT_PCT_SOLO` / `VENT_PCT_FULL`
instead of the literal 65 / 35 that had gone stale through two solo retunes.

The boss's open-vent ring — the "flash light" of the player's report — is `Boss.tsx`'s and
is now a hairline at half opacity with a ≤ 8 px glow and a slow opacity breathe; no scale
pulse, static under reduced motion. Not a HUD change, noted here because the HUD's `boss
NN%` and the ring are the two places the vent state reaches the player.
