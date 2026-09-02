# tools/

Asset pipeline. Every checked-in generated file comes from exactly one script here, run by
hand, outputs committed. Python 3 + Pillow + numpy, nothing else. **Never hand-edit an
output**; every script has `--check`, which regenerates in memory and exits 1 on drift.

```
assets/rooms/{lobby,arena}.png  --gen_rooms.py-->  app/src/render/rooms/*.png, rooms.gen.ts,
                                                   assets/map/arena.json (the grid),
                                                   docs/art/rooms/overlay-*.png
assets/map/arena.json           --gen_map.py---->  programs/heartrot/src/map.rs, packages/client/src/map.ts
assets/rooms/arena.png          --gen_boss.py--->  assets/sprites/boss_parts.png, hitboxes.json, app/src/render/boss.gen.ts
assets/sprites/hitboxes.json    --gen_hitboxes.py-> programs/heartrot/src/hitboxes.rs, packages/client/src/hitboxes.ts
archer_sheet.py (parts)         --gen_knights.py-> app/src/render/archer.png, knights.gen.ts
(procedural)                    --gen_ordnance.py-> app/src/render/ordnance.png, ordnance.gen.ts
programs/heartrot/src/error.rs  --gen_errors.py--> packages/client/src/errors.ts
```

Run order after an art or geometry change: `gen_rooms.py` → `gen_map.py` → `gen_boss.py` →
`gen_hitboxes.py --scale 1`. The rest are independent. Each script's docstring is its
documentation; the one-line summaries:

- `gen_rooms.py` — the two reference paintings become the rooms. Quantises each to 256
  colours, cuts the lobby gate out to `gate.png`, **writes the walkable grid** from the
  painted floor rect / platform ellipse / stairs (walkable == painted floor, by
  construction), and emits the world transforms `rooms.gen.ts` renders with.
- `gen_map.py` — the grid to the chain's bitboard and its client mirror.
- `gen_boss.py` — hand-authored part polygons over the painted demon, cut at
  `rooms.arena.boss_crop_px` (which it derives itself and asserts against). Lossless:
  the recomposed atlas equals the crop inside the body outline.
- `gen_hitboxes.py` — part boxes in arena units at `--scale`, the muzzles, the core circle;
  sweeps every pit stand to prove every part and the vent are reachable on the current map.
- `gen_knights.py` / `archer_sheet.py` — the archer paper-doll: 10 poses × 5 authored
  directions × 3 skins plus silhouette and halo frames, one atlas and a `FRAMES` table.
- `gen_ordnance.py` — the boss's thorn ordnance at 16 velocity sectors, burst and hit splat.
- `gen_errors.py` — `HeartrotError` codes to the client.

Why one script per pair of outputs: the pixels the browser draws and the rectangle the
program raycasts against are the **same partition**. Keeping any of these by hand is what
drifts — someone nudges a limb, the art moves, the hitbox does not, and shots land on
empty air with no error anywhere.
