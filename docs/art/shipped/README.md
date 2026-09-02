# The shipped frame, judged against the two references

Task `looks-right`. Every number below is read off the pixels of the **real renderer** — the
harness at `scripts/spike/looksright/` mounts `app/src/App.tsx` itself (same trick as
`scripts/spike/scenemount`), so `Arena.tsx`, `WaitingRoom`, `BossArena`, `Boss`, `Knight`,
`Shot` and every grade in `styles.css` are product code and only the chain is faked. The
world→screen mapping comes from `getScreenCTM()` as the browser reported it, not from
re-deriving the fit rule. Luminance method is `docs/art/legibility.py`'s, unchanged, so the
two sets of numbers are directly comparable.

Reproduce:

```
cd scripts/spike/looksright && ../../../app/node_modules/.bin/vite build
PW_HOME=/home/anshtyagi/.npm/_npx/9833c18b2d85bc59 DISPLAY=:0 node scripts/spike/looksright/shoot.mjs
python3 scripts/spike/looksright/measure.py            # writes measurements.txt
```

`plate-*.png` are the measurement plates: each hides exactly one shipped layer (the boss,
the props, the HUD) by injected CSS, so a diff against the full frame is that layer's exact
pixel mask. Nothing product-side is modified to produce them.

One harness correction worth recording: the shell's `ErrorBar` is `null` unless there is an
error, but the harness has no Worker, so it was always up and ate **34.5 px** of stage
height — which pulled the scale to 1.521 px/unit. With it hidden the stage is 1920 × 1032.6
and the scale is **1.57405 px/unit**, matching spec §1.3's predicted 1.573 to four figures.
Every number below is from the corrected run.

---

## The verdict in one line each

**Room A — close.** Composition, props, palette family and the gate all land; it is
recognisably the reference. It is **31 % darker at the floor median and 42 % darker at p95**
than reference A, and the 26 interior pillar blocks read as floor, not as columns.

**Room B — not close.** The framing is right and the boss is top-middle, but the value
structure is **inverted**: the creature is 4.77× brighter than its own floor where the
reference's is 0.58×, the floor rings are invisible (1.0–5.4 L8), and 61.9 % of the left
third of the frame is flat against the reference's 13.3 %.

---

## 1. Framing — the camera is genuinely gone, and this half is done

| | stage | px/unit | knight | room fills | off-room |
|---|---|---|---|---|---|
| 1920×1080 | 1920 × 1032.6 | 1.5740 | 51.9 px wide / 66.1 px tall | 83.9 % of width | 16.1 % |
| 1366×768 | 1366.7 × 720.2 | 1.0978 | 36.2 / 46.1 px | 82.3 % | 17.7 % |

- `#camera` transform is the empty string in all four cases: **nothing pans, ever.**
- `getScreenCTM()` is uniform (`a === d`) in all four; the SVG fills the stage; the room is
  entirely inside the viewBox. The fit rule holds. **No bars, no crop** — confirmed.
- Vertically the room is edge to edge: the viewBox height is exactly 656 in every case.
- 1.008 → 1.574 px/unit is a real 2.4× area gain. "Sharper as bigger" was delivered.

**What still reads as "not full screen":** the 16.1 % of frame width outside the map is
void at Y 0.0056–0.0104 against an in-room floor of Y 0.0181–0.0211 — it is black, and the
eye reads two black bars. Worse, **39.8 % (room A) and 48.9 % (room B) of the whole stage
sits under Y 0.008**, and the first stage row carrying any pixel over Y 0.05 is 7.6 % / 9.2 %
down. Add the HUD, which covers **15.7 % of the stage in the arena and 20.2 % in the lobby**
at 1920, and 20.8 % of the width at 1366 is the telemetry panel alone (which also overflows
the bottom of a 768-tall viewport — see the shot).

---

## 2. Floors and palette

Percentiles p5 / p25 / p50 / p75 / p95 of relative luminance, floor stone only.

| | Y percentiles | mean sRGB | R−B | G−B |
|---|---|---|---|---|
| ref A | 0.0106 0.0176 **0.0231** 0.0335 **0.0468** | (48.5, 39.9, 56.6) | −8.1 | −16.7 |
| **ship A** | 0.0072 0.0096 **0.0160** 0.0227 **0.0272** | (39.1, 30.9, 42.6) | −3.6 | −11.7 |
| ref B | 0.0048 0.0127 **0.0218** 0.0386 **0.0767** | (40.1, 42.8, 53.1) | −13.0 | −10.3 |
| **ship B** | 0.0063 0.0093 **0.0125** 0.0187 **0.0623** | (28.7, 33.7, 42.7) | −14.1 | −9.1 |

- Room A's hue call is **correct**: R above G in both the reference (48.5 > 39.9) and the
  ship (39.1 > 30.9). The violet-mauve grade landed.
- Room A's **value** is wrong: p50 31 % low, p95 42 % low. The room has no bright floor at
  all. Reference A's signature — warm pools of torchlight on cold stone — is not there.
- Wall-vs-floor separation: ref A **1.20:1**, ship A **1.14:1**, and with the sign reversed
  (the shipped wall is brighter than its floor, the reference's is darker at the same crop).
- Room B's hue is on target (R−B −14.1 vs −13.0) and its value is 43 % low at p50.

---

## 3. Knights and archers against the floor they stand on

Body mask = |20-seat frame − 1-seat plate| inside each seat's own screen box; floor sampled
from the plate in a ring around it, so no other knight contaminates.

| room | class | n | body Y | floor Y | body contrast | worst seat | **boundary p50** |
|---|---|---|---|---|---|---|---|
| A | knight | 9 | 0.1140 | 0.0188 | 2.39:1 | 2.15:1 | **1.45:1** |
| A | archer | 10 | 0.1724 | 0.0189 | 3.23:1 | 2.76:1 | **1.38:1** |
| B | knight | 9 | 0.1036 | 0.0171 | 2.29:1 | **1.51:1** | **1.44:1** |
| B | archer | 10 | 0.1354 | 0.0136 | 2.92:1 | **1.54:1** | **1.38:1** |

Per skin, worst is Nocturne: 2.44:1 in room B. Knights standing **on the creature** (5 of 19
in this layout): body 2.17:1, boundary p90 3.10:1.

The body numbers are acceptable. **The boundary numbers are the defect** — 1.38–1.45:1 is
the outline the eye actually uses to separate a knight from the ground, and spec §8.1
solved the rim to 4.5:1.

### Why: the halo was never generated

```
knights.gen.ts carries the dilated halo groups: False
ids present: k0-rest, k0-contactL, k0-contactR, k0-fallen, k0-sil     (no k0-halo)
tools/gen_knights.py:  zero occurrences of "halo"
```

`Knight.tsx:87`'s `HAS_HALO` guard is therefore **false in the shipped build**, and every
knight falls back to `rimPose = 'sil'` offset one unit up-left. Step 6 of spec §12
(`gen_knights.py` re-run) did not happen. Consequences, measured:

- the rim is **1 unit** wide, not 2: **1.57 css px at 1920, 1.10 px at 1366** — one device
  pixel, which spec §1.3's own art constraint ("nothing identity-carrying thinner than
  2 units") forbids by name;
- it exists on the up-left side only, so the down-right half of every knight has no
  boundary contrast at all — which is exactly the 1.06:1/1.28:1 defect §8.1 was written to
  close;
- the `HAS_HALO` branch is a silent fallback. Nothing throws, nothing warns, and the frame
  looks *plausible*. This is the same class of failure as a dangling `<use href>`.

**This is also what gates room A's light.** The legibility cap is `Y_floor ≤ 0.0384` from
Nocturne needing 1.85:1. Shipped lit floor p95 is 0.0272 — 29 % of headroom unused — but
reference A's own floor p95 is **0.0468, above the cap**. The reference brightness is not
reachable until the rim is lifted. Halo first, then torch pools.

---

## 4. Room B: the boss, and the value inversion

> **HISTORICAL — this is the run that FOUND the inversion, not a description of the build.**
> Every number in this section was taken on the `brightness(0.55) contrast(1.6)` grade and on
> the pre-`18-open-arena` bitboard. Both have moved: the grade is now
> `brightness(0.45) contrast(2.0)` and the map rebuild changed the mix of floor and backdrop
> the creature sits on, so the *same* old grade re-measures 0.0564 / 0.0159 / **3.54×** on
> this tree rather than the 0.0597 / 0.0125 / 4.77× below. The finding stands; the figures
> are dated. `Boss.tsx`'s comment above `BOSS_GRADE` holds the current ones.

Boss mask = full arena plate minus a plate with `.hr-boss-breathe` hidden; the orb and its
spill (a disc of `CORE_R × 2.6` at world (587, 346)) excluded, because the creature must
not be measured against its own light source.

| | shipped | reference B |
|---|---|---|
| silhouette | 47.1 % of stage width, 86.0 % of height, 18.8 % of area | 22.3 % / 47.4 % |
| body Y | p5 0.0001 · p50 **0.0597** · p90 0.1231 · p99 0.1984 | p5 0.0031 · p50 **0.0127** · p90 0.0634 · p99 0.1909 |
| p50→p99 spread | 3.3× | **15.1×** |
| body vs the backdrop it covers | 1.77:1 | — |
| clearing 4.5:1 against its backdrop | 0.005 of pixels | 0.025 (spec §2.3's own target) |

> **The inversion.** Reference creature p50 ÷ its floor p50 = **0.58×** — the creature is
> *darker* than the floor it stands on, and the orb is the only bright thing in the room.
> Shipped = **4.77×** — the creature is the brightest large mass in the frame. That is an
> 8.2× reversal of the reference's value structure, and it is what "the boss lighting
> everything is wrong" looks like after the regrade. It is wrong in the opposite direction
> from before, not fixed.

Spec §2.3 predicted 0.111 of pixels clearing 3:1 and 0.027 clearing 4.5:1 against the
reference's 0.123/0.025. The shipped frame measures **0.074 and 0.005** — the tail did not
arrive, and the median went 4.7× too high instead. `brightness(0.55) contrast(1.6)` lifted
the whole body rather than opening the range: the shipped spread is 3.3× against the
reference's 15.1×.

### The orb

- radius 60 units = **94 px**, so the dark well inside the ring is r ≤ 80 px = **9.8 % of
  stage width**; reference B's whole orb is **6.1 %**.
- interior Y 0.0088 — darker than its own floor (0.0125), which is spec-conform (§2.3 item
  3 describes the reference orb as a near-black well) but at 1.6× the reference's relative
  size it reads as a **hole punched through the creature**, not as an orb. The reference's
  well is small enough that the ring dominates it; ours is not.

### The floor rings — the reference's dominant feature, and they are gone

| ring | on-ring L8 | 6 u inside | Δ L8 | contrast |
|---|---|---|---|---|
| k=0.22 | 42.4 | 47.8 | 5.4 | 1.07:1 |
| k=0.44 | 39.9 | 42.2 | 2.3 | 1.04:1 |
| k=0.65 | 41.0 | 42.2 | **1.2** | 1.00:1 |
| k=0.87 | 39.8 | 42.8 | 3.0 | 1.03:1 |
| k=1.00 | 37.3 | 40.1 | 2.8 | 1.03:1 |

Spec §2.2 promised 4.9–13.1 L8 of mortar separation at wash 0.70 and called "inside 1 L8"
invisible. Four of five rings are under 3.0 L8 and k=0.65 — the one carrying the four
medallions — is at 1.2. In reference B the concentric rings are the composition.

### The room is empty

Local 9×9 luminance range over the left third of each frame, clear of the creature:

| | Y p50 | local range p50 | **fraction of pixels in a flat window (range < 0.005)** |
|---|---|---|---|
| ship B | 0.0110 | 0.0032 | **61.9 %** |
| ref B | 0.0082 | 0.0134 | **13.3 %** |

The shipped arena's sides are **4.7× flatter** than the reference's. Reference B fills them
with pillars, hanging chains, demon statues, banners and brazier-topped columns; the ship
has faint banner ghosts and one horizontal cyan rail of evenly-spaced dots at the far rim,
which reads as a handrail rather than as twelve braziers at varying depth.

---

## 5. Decoration over walkable floor — this one is fine

Prop mask = lobby plate minus a plate with the props layer hidden (23 nodes).

- walkable lobby tiles on screen: **1322**
- touched by any prop pixel: **93 (7.0 %)**
- with opaque mass over a quarter of the tile: **15 (1.1 %)**
- prop pixels total 3.89 % of the stage, of which only **0.78 %** is opaque mass — the rest
  is torch light, which is paint, not an object

Spec §8 row 6 ("actors are never occluded by decoration") holds. No action.

### But the 26 pillar blocks have no mass

| | Y |
|---|---|
| block top | 0.0263 |
| floor one tile to its left | 0.0196 |
| the 6 px at the block's own edge | 0.0181 |

Block vs floor **1.10:1**; the edge band where a lit face or a cast shadow would live is
**1.02:1** — there is no depth cue at all. Per-block spread is 0.0249–0.0270, i.e. all 26
are the same flat value. They read as slightly-lighter floor tiles scattered across the
plaza. Reference A has **no interior obstacles whatsoever**, so these are the one element in
room A that reads as a mistake rather than as a difference. They are `#` bitboard tiles and
must stay drawn (R1/R2) — the fix is mass, not deletion.

---

## 6. The archer's kit is eating the archer

| room | class | drawn px per seat | px above Y 0.30 (the cream kit) | share |
|---|---|---|---|---|
| A | knight | 1811 | 319 | 17.6 % |
| A | **archer** | **2555** | **943** | **36.9 %** |
| B | knight | 1897 | 230 | 12.1 % |
| B | **archer** | **2679** | **840** | **31.4 %** |

`KIT_LIGHT #e0d3ae` is Y 0.6549 against a knight body around Y 0.10–0.17. The bow
(`BOW_D`, y −23..13 = 36 units, a 5-unit keyline under a 2.6-unit fill) is taller than the
knight it hangs off, and `KIT_D`'s quiver at x −13..−2 overlaps the sprite's own content,
which starts at x −8. An archer is **41 % more drawn pixels than a knight and a third of
them are the brightest thing on the sprite.** In `zoom-arena-knights.png` ten archers read
as cream planks with a small knight attached, and at 20 seats the frame is a scatter of
cream sticks. The silhouette argument in `Knight.tsx:372` is sound; the *weight* is not.

---

## 7. The local marker — findable, and the one thing that is unambiguously right

| room | marker peak Y | stage p99.9 | pixels in the whole stage at or above the peak |
|---|---|---|---|
| A | 0.9538 | 0.6476 | **160 (0.008 %)** |
| B | 0.9538 | 0.6342 | **160 (0.008 %)** |

`#eafff4` is the brightest value in the frame and only the marker itself carries it. The
chevron is 25 × 19 px at 1920 and the ground ring is unmistakable in a crowd of twenty.
Verified visually in both 20-seat shots. **No action.** Note the archer kit at Y 0.655 is
the nearest competitor and it is a full 1.46× below.

---

## The single highest-value thing still missing

**Room A — run `tools/gen_knights.py` with the halo, and regenerate `knights.gen.ts`.**
It is the shipped boundary contrast (1.38–1.45:1 against a solved 4.5:1), it is the user's
"the player is on top like the game", it is a one-device-pixel rim at 1366, and it is what
raises the legibility cap that currently pins the room 31 %/42 % darker than reference A.
The generator and the sheet both lack the groups; `Knight.tsx`'s `HAS_HALO` fallback hides
that with no error anywhere. Lift the rims first, then raise `POOL_ALPHA` (0.045 today,
29 % of the cap's headroom unused) to put reference A's warm pools on the floor.

~~**Room B — invert the boss's value back.**~~ **DONE — do not action this twice.** The
creature had to be *darker* than its own floor (reference 0.58×) with a p50→p99 spread near
15×, and `brightness(0.45) contrast(2.0)` gets there: **0.57× the floor, spread 15.0×**,
re-measured on the shipped frame and recorded in `Boss.tsx`'s comment above `BOSS_GRADE`
alongside the two chains it replaced. `boss-light.md` §5.1 carries the change and §7.2 the
criterion — which is now the *ratio*, never an absolute median, because an absolute median is
what let the first attempt overshoot.

**Still open from that paragraph: the ring mortar.** Lifting it out of 1.0–5.4 L8 is the
other half of "reference B's signature is hidden", and it belongs to `BossArena.tsx`, not to
`Boss.tsx`. `MORTAR_ALPHA` has since gone 0.60 → 0.92 at `GAIN` 0.92; **the 4.9–13.1 L8 band
quoted above and in `boss-arena.md` §5.5 was measured at `g = 0.46`** and no longer describes
this build — the floor is roughly twice as bright, so gate it on the scale-free
floor:trough ratio instead. With the creature now at 0.57× its floor, the rings are the
brightest thing competing for the eye after the orb, so the same lift reads far harder than
it would have against the old bright body.
