# tools/

Asset pipeline. Two scripts, run by hand, outputs committed. Python 3 + Pillow +
numpy, nothing else.

```
raster art  --px2svg.py-->  assets/sprites/boss.svg  --svg_slice.py-->  parts/boss.svg
                                                                        hitboxes.json
```

## `px2svg.py` — raster → exact pixel-art SVG

Quantise, mode-downsample to the native pixel grid, merge runs into rects, emit
**one `<path>` per colour**. Not owned by this document; see its docstring.

```
python3 tools/px2svg.py in.png out.svg -c 16 -b -s 4
```

## `svg_slice.py` — boss SVG → rig groups + hitboxes

```
python3 tools/svg_slice.py
# -> assets/sprites/parts/boss.svg    one <g id="part-NAME"> per part
# -> assets/sprites/hitboxes.json     bounding box per part, sprite pixels
```

Runs from any directory; the defaults resolve against the repo root.

### Why one script and not two

The `<g>` the browser animates and the rectangle the program raycasts against are
**the same pixels**, produced by one partition. Keeping the hitbox list by hand is
what drifts: someone nudges a horn, the art moves, the hitbox does not, and shots
land on empty air with no error anywhere. If you edit `PARTS`, both outputs move
together or the run fails.

### How the split works

`px2svg.py` gives one path per **colour** spanning the whole creature, which is
useless for a rig. So `svg_slice.py` rasterises that back to a pixel grid and
partitions by **region**: `PARTS` is an ordered list of named boxes, first match
wins, and the last entry (`torso`) has no boxes at all, so it takes every pixel
nobody claimed. That catch-all is what makes the partition lossless by
construction — no pixel can fall out of the bottom.

Two wrinkles the boss forced:

- **Thorns are colour-restricted.** The four olive greens are used by thorn
  sprays, the mace ball and the crown ornaments and by nothing else, so a thorn
  part is "olive pixels inside this box". A plain box takes the shoulder behind
  the spray with it, and the detach animation then tears a hole in the boss.
- **`ground` is colour-only.** The room floor is baked into `boss.svg`. Any box
  around it would have to cross the legs drawn on top of it, so it is matched by
  its one exclusive fill instead. It is a group so the recombination stays
  lossless — the rig should simply not mount it.

`z` on each part is paint order, back to front, and is deliberately **not** the
claim order: claiming runs most-specific-first and ends at a catch-all, while
stacking has to put the torso behind the arms that swing across it. The groups
are written in `z` order, so DOM order is already correct.

### Verification

Every run re-reads the file it just wrote, rasterises it, and compares against
the source pixel for pixel. It prints the count and exits non-zero if it is not
zero. Current output:

```
recombined vs original: 0 differing pixels
```

That number is measured, not asserted — sabotage the emitter and it reports the
damage. There is no separate test; this is the test, and it runs on the real
asset every time.

### `hitboxes.json`

```jsonc
{
  "source": "boss.svg",
  "sprite": { "w": 230, "h": 270 },
  "part_index": ["crown","wolf_l","beast_r","thorn0","thorn1","thorn2","thorn3","mace","claws"],
  "hitboxes": { "crown": { "index": 0, "x": 122, "y": 7, "w": 67, "h": 59, "pixels": 2334 }, ... }
}
```

- `part_index` is index-aligned with `Boss.parts[9]` in
  `programs/heartrot/src/state.rs`. **These two orders must not drift.** The build
  fails if any of the nine indices has no part.
- `"index": null` marks a rig-only group (`ground`, `legs`, `torso`) — animated,
  never shot at. `core` is the exception: it is shot at, but its HP lives in
  `Boss.core_hp` rather than in the parts array, so it has a box and no index.
- Boxes are the **tight** bounds of the pixels a part actually owns, not the
  `PARTS` rectangle, which is deliberately loose. A raycast against the loose box
  would register hits on empty air beside the horn.
- Coordinates are **sprite pixels**, origin top-left, 230×270. Converting to the
  arena's `i16` space (`TILE = 16`, `MAP_MAX_XY = 1023`) is the caller's job —
  the sprite has no idea how big the boss is drawn in the world.

`pixels` is the true painted area and is only a sanity figure: if a part's count
lurches after an art change, its boxes probably need moving.

> `ponytail:` thorn hitboxes are small (`thorn3` is 24×17) because they are the
> honest extent of the sprays. If thorns turn out to be too fiddly to hit, widen
> them in `shoot.rs` balance rather than lying about the art here.

### Changing the split

1. Edit `PARTS` in `svg_slice.py`.
2. Re-run. It fails loudly if a part ends up owning no pixels, if a colour it
   wants is absent, if a chain index is unfilled, or if the result is lossy.
3. Commit `assets/sprites/parts/boss.svg` and `assets/sprites/hitboxes.json`
   together with the change. They are generated, but they are inputs to both the
   frontend rig and the program's balance table, so they are committed.

`PARTS` names use the **on-chain** names (`mace`, `claws`), not the design doc's
prose names (`arm_mace`, `arm_claw`). Same parts; the chain wins, because that is
the name the index has to line up with.
