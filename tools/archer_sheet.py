#!/usr/bin/env python3
"""The archer, as palette-indexed ASCII paper-doll parts.

This module is the ART. `gen_knights.py` is the pipeline that turns it into
`app/src/render/archer.png` + `knights.gen.ts`; nothing here writes a file.

One character, five authored directions (`n ne e se s`; W/SW/NW are the renderer's mirror
of E/SE/NE, which is why the canvas is 33 wide -- odd, so a flip is an exact permutation
of columns). Each direction is a set of parts on the 33x42 canvas with its own anchors and
its own z-order: the bow is drawn in FRONT of the body for e/se/s and BEHIND it for n/ne,
because for a figure facing away the bow arm points into the scene.

Every pixel is a palette CHARACTER, not a colour. `1 2 3` are the tunic's base/shade/light
and are swapped per skin from `SKIN_COLORS` (`app/src/screens/CharacterSelect.tsx`, the one
place the three hues are typed); everything else is shared across skins.

Size rule: the body is 22..30 px wide on the canvas because `PLAYER_HIT_RADIUS` is 12 --
the chain tests bullets against a 24-unit circle centred on the seat, and art drawn much
wider than that circle takes visible hits that do not land. Feet sit on row 41, the bottom
row, so every direction stands on the same ground line. `gen_knights.py` asserts both.

Legend (also the palette below):
    .  transparent      K  keyline           s S  skin / skin shadow
    1  tunic base       2  tunic shade       3    tunic light        (per skin)
    h H L  leather mid / shadow / light      b B  cloth dark / mid
    w W    bow wood / light                  t    string
    a A f  arrow shaft / head / fletching    g G  charge glow / glow core
"""

from __future__ import annotations

import colorsys
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIN_COLORS_TS = ROOT / "app" / "src" / "screens" / "CharacterSelect.tsx"
SPRITES_TS = ROOT / "app" / "src" / "render" / "sprites.ts"

# The canvas. Odd width on purpose (see the module docstring); `Knight.tsx` reads both
# from the generated file, never from a second literal.
W, H = 33, 42
FEET_ROW = H - 1

DIRS = ("n", "ne", "e", "se", "s")
POSES = ("walk0", "walk1", "walk2", "walk3", "idle", "draw", "charge0", "charge1", "loose", "fallen")

# Shared palette. The keyline is the old knight sheet's `#1b1029` -- 19% of that art was
# this one colour, and it is what a sprite is legible BY at 1 px/unit.
PALETTE = {
    "K": "#1b1029",
    "s": "#e9b98a",
    "S": "#b97055",
    "h": "#6b4a2c",
    "H": "#3f2a17",
    "L": "#a8814f",
    "b": "#2a2230",
    "B": "#4b4355",
    "w": "#7a4f28",
    "W": "#b8834a",
    "t": "#efe6cc",
    "a": "#e0d3ae",
    "A": "#dcdae0",
    "f": "#f1e8d8",
    "g": "#ffe873",
    "G": "#fff6e0",
}
# Per-skin: filled by `skin_palette` from the tint.
TINT_CHARS = "123"

# The chars an `arm_draw` overlay loses to become the `loose` arm: arrow and bent string
# gone, hand still at the anchor point. One filter instead of a second authored arm.
ARROW_CHARS = "aAft"

# The relative-luminance target the halo (rim) colour is lifted to. Solved in
# `Knight.tsx`'s history as `4.5 x (0.0767 + 0.05) - 0.05` -- 4.5:1 against the brightest
# floor either reference scene samples -- and kept as the one number so all three rims are
# the same brightness in a different hue.
HALO_Y = 0.5202


def _hex(h: str) -> tuple[float, float, float]:
    return tuple(int(h[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def _to_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{max(0, min(255, round(c * 255))):02x}" for c in rgb)


def _luminance(rgb: tuple[float, float, float]) -> float:
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def _with_lightness(h: str, f) -> str:
    hue, l, s = colorsys.rgb_to_hls(*_hex(h))
    return _to_hex(colorsys.hls_to_rgb(hue, f(l), s))


def skin_palette(tint: str) -> dict[str, str]:
    """The tunic ramp for one skin: base, shade, light."""
    return {
        "1": tint,
        "2": _with_lightness(tint, lambda l: l * 0.62),
        "3": _with_lightness(tint, lambda l: l + (1 - l) * 0.38),
    }


def halo_color(tint: str) -> str:
    """The tint lifted (hue and saturation kept) until its luminance reaches `HALO_Y`."""
    hue, l, s = colorsys.rgb_to_hls(*_hex(tint))
    while _luminance(colorsys.hls_to_rgb(hue, l, s)) < HALO_Y and l < 1:
        l = min(1.0, l + 0.005)
    return _to_hex(colorsys.hls_to_rgb(hue, l, s))


def read_skin_colors() -> list[str]:
    """`SKIN_COLORS` out of `CharacterSelect.tsx` -- the three hues are typed there, once."""
    m = re.search(r"SKIN_COLORS\s*=\s*\[([^\]]*)\]", SKIN_COLORS_TS.read_text())
    if m is None:
        raise SystemExit(f"archer_sheet: SKIN_COLORS not found in {SKIN_COLORS_TS}")
    colors = re.findall(r"#[0-9a-fA-F]{6}", m.group(1))
    if not colors:
        raise SystemExit("archer_sheet: SKIN_COLORS carries no hex colours")
    return [c.lower() for c in colors]


def read_self_ring() -> str:
    """`PAL.selfRing` out of `sprites.ts`: the flat silhouette the hit flash is drawn in."""
    m = re.search(r"selfRing:\s*'(#[0-9a-fA-F]{6})'", SPRITES_TS.read_text())
    if m is None:
        raise SystemExit(f"archer_sheet: PAL.selfRing not found in {SPRITES_TS}")
    return m.group(1).lower()


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------


def block(art: str) -> list[str]:
    """A multi-line string to rows; blank lines and indentation dropped, widths padded."""
    rows = [ln.strip() for ln in art.strip("\n").splitlines() if ln.strip()]
    w = max(len(r) for r in rows)
    return [r.ljust(w, ".") for r in rows]


def mirror(rows: list[str]) -> list[str]:
    return [r[::-1] for r in rows]


def strip_chars(rows: list[str], chars: str) -> list[str]:
    return ["".join("." if c in chars else c for c in r) for r in rows]


# The bow, seen from its own side: limbs bulging to the right, string on the left. Grip
# rows carry only the leather so the hand authored on the torso stays visible beside it.
BOW = block(
    """
    KW...
    .KW..
    ..KW.
    ..KW.
    ...KW
    ...KW
    ...KW
    ...KW
    ...KW
    ...KW
    ....h
    ....h
    ....h
    ....h
    ....h
    ...KW
    ...KW
    ...KW
    ...KW
    ...KW
    ...KW
    ..KW.
    ..KW.
    .KW..
    KW...
    """
)
BOW_H = len(BOW)
# The straight string: the bow's left column, tip to tip.
STRING = ["t"] * (BOW_H - 2)


def _lift_leg(stand: list[str], cols: range, dy: int) -> list[str]:
    """A contact frame for a front/back view: one leg's columns moved up `dy` rows."""
    h = len(stand)
    out = [list(r) for r in stand]
    for y in range(h):
        for x in cols:
            out[y][x] = "."
    for y in range(h):
        if 0 <= y - dy < h:
            for x in cols:
                out[y - dy][x] = stand[y][x]
    return ["".join(r) for r in out]


# ---------------------------------------------------------------------------
# South -- facing the camera
# ---------------------------------------------------------------------------

HEAD_S = block(
    """
    .....KKK.....
    ...KK111KK...
    ..K1111111K..
    .K111333111K.
    .K11KKKKK11K.
    K11KsssssK11K
    K1KssKsKssK1K
    K1KsssssssK1K
    K11KsSSSsK11K
    .K11KKKKK11K.
    ..K1121211K..
    ...KKKKKKK...
    """
)

TORSO_S = block(
    """
    ...KK11111KK...
    .KK111111111KK.
    K11K1111111K11K
    K11K1133311K11K
    K11K1113111K11K
    K11K1111111K11K
    K22K1111111K22K
    KssK1111111Kss.
    KSsK2222222KsS.
    .KKKhhhhhhhKKK.
    ...KHhhLhhHK...
    ...K2222222K...
    ...KKKKKKKKK...
    """
)

# Two rows of head-room so a lifted leg has somewhere to go; the torso paints over it.
LEGS_S = block(
    """
    ...........
    ...........
    .KBBBKBBBK.
    .KBBBKBBBK.
    .KBBBKBBBK.
    .KBbBKBbBK.
    .KbbbKbbbK.
    .KbbbKbbbK.
    .KHHHKHHHK.
    .KhhhKhhhK.
    .KhhhKhhhK.
    .KhhhKhhhK.
    KhhhhKhhhhK
    KhhhhKhhhhK
    KHHHHKHHHHK
    KKKKKKKKKKK
    """
)

QUIVER_S = block(
    """
    ..Kf.
    .KffK
    KfaaK
    KaaK.
    .KaK.
    .KhK.
    .KhK.
    """
)

# Drawing hand pulled to the chest; the arrow points at the camera, so all that shows of
# it is the head on the string.
ARM_DRAW_S = block(
    """
    ........
    K11K....
    K111KK..
    .K111sK.
    ..KKssK.
    ....KK..
    """
)
ARROW_S = block(
    """
    AA
    AA
    """
)

# ---------------------------------------------------------------------------
# North -- facing away
# ---------------------------------------------------------------------------

HEAD_N = block(
    """
    .....KKK.....
    ...KK111KK...
    ..K1111111K..
    .K111333111K.
    .K11133111K..
    K1111111111K.
    K1111111111K.
    K11111111111K
    K11111111111K
    .K111111111K.
    ..K1121211K..
    ...KKKKKKK...
    """
)

TORSO_N = block(
    """
    ...KK11111KK...
    .KK111111111KK.
    K11K1111111K11K
    K11K1111111K11K
    K11K1111111K11K
    K11K1111111K11K
    K22K1111111K22K.
    .ssK1111111KsssK
    .SsK2222222KsSK.
    .KKKhhhhhhhKKK..
    ...KHhhhhhHK....
    ...K2222222K....
    ...KKKKKKKKK....
    """
)

# The quiver on the back, slung diagonally, fletchings over the shoulder.
QUIVER_N = block(
    """
    ....Kf.
    ...KffK
    ..KfaaK
    ..KaaK.
    .KhhK..
    .KhhK..
    KhhK...
    KhhK...
    KHHK...
    .KK....
    """
)

# From behind the drawing arm is an elbow out to the side at shoulder height.
ARM_DRAW_N = block(
    """
    ...KK
    ..K11K
    .K111K
    K11KK.
    KK...
    """
)

# ---------------------------------------------------------------------------
# East -- profile, facing +x
# ---------------------------------------------------------------------------

HEAD_E = block(
    """
    ....KKKK....
    ..KK1111KK..
    .K11111111K.
    .K11333111KK
    K1111111KssK
    K111111KsKsK
    K111111KsssK
    K111111KSssK
    .K11111KKKK.
    .K11121K....
    ..KK111K....
    ...KKKK.....
    """
)

# The bow arm extends forward to the grip; the hand is the `sss` at the far end.
TORSO_E = block(
    """
    ..KK1111K..........
    .K111111K..........
    K11111111K.........
    K11333111K.........
    K1131111KKKKKKKK...
    K111111K111111111K.
    K1111111KK11111sssK
    K22111111KKKKKKKKK.
    K2222222K..........
    KhhhhhhhK..........
    KHhhLhhhK..........
    K2222222K..........
    KKKKKKKKK..........
    """
)

LEGS_E_STAND = block(
    """
    .KBBBBBK....
    .KBBBBBK....
    .KBbBBBK....
    .KBbBBBK....
    .KbbbbbK....
    .KbbbbbK....
    .KHHHHHK....
    .KhhhhhK....
    .KhhhhhK....
    .KhhhhhK....
    .KhhhhhKK...
    .KhhhhhhhK..
    .KHHHHHHHK..
    .KKKKKKKKK..
    """
)

LEGS_E_STEP_A = block(
    """
    ............
    ..KBBBBBK...
    ..KBBBBBK...
    .KBBBKBBBK..
    .KBbK.KBBK..
    KbbK...KbbK.
    KbbK...KbbK.
    KHHK...KHHK.
    KhhK...KhhK.
    KhhK...KhhK.
    KhhK...KhhKK
    KhhK...KhhhK
    KHHK...KHHHK
    KKKK...KKKKK
    """
)

LEGS_E_STEP_B = block(
    """
    ............
    ..KBBBBBK...
    ..KBBBBBK...
    .KBBBKBBBK..
    .KBbK.KBbK..
    .KbbK.KbbK..
    .KbbK.KbbK..
    .KHHK.KHHK..
    .KhhK.KhhK..
    .KhhK.KhhK..
    KhhhK.KhhKK.
    KhhhK.KhhhK.
    KHHHK.KHHHK.
    KKKKK.KKKKK.
    """
)

QUIVER_E = block(
    """
    .Kf.
    KffK
    KfaK
    KaaK
    .KaK
    .KhK
    .KhK
    .KhK
    KhhK
    KhhK
    KhhK
    KHHK
    .KK.
    """
)

# The drawing hand at the chest with the arrow along the bow arm, string bent to the nock.
ARM_DRAW_E = block(
    """
    ........t......
    .......t.......
    ......t........
    ......t........
    .....t.........
    .....t.........
    ....t..........
    ....t..........
    ...t...........
    ...t...........
    ..t............
    ..t............
    .t.............
    KKssfaaaaaaaaaa
    K1KsKfaaaaaaaaa
    .t.............
    ..t............
    ..t............
    ...t...........
    ...t...........
    ....t..........
    ....t..........
    .....t.........
    .....t.........
    ......t........
    ......t........
    .......t.......
    ........t......
    """
)
ARROWHEAD_E = block(
    """
    AA.
    AAA
    """
)

# ---------------------------------------------------------------------------
# South-east -- three-quarter, facing the camera and +x
# ---------------------------------------------------------------------------

HEAD_SE = block(
    """
    .....KKK.....
    ...KK111KK...
    ..K1111111K..
    .K111333111K.
    .K111KKKKK1K.
    K111KsssssK1K
    K11KssKsKssK.
    K11KsssssssK.
    K111KSSSssK..
    .K11KKKKKK...
    ..K112121K...
    ...KKKKKKK...
    """
)

TORSO_SE = block(
    """
    ...KK11111KK......
    .KK111111111KK....
    K11K1111111K11K...
    K11K1133311K11KK..
    K11K1113111K1111K.
    K11K1111111K11111K
    K22K1111111KK11ssK
    KssK1111111K.KKKK.
    KSsK2222222K......
    .KKKhhhhhhhK......
    ...KHhhLhhHK......
    ...K2222222K......
    ...KKKKKKKKK......
    """
)

ARM_DRAW_SE = block(
    """
    .......t..
    ......t...
    ......t...
    .....t....
    .....t....
    ....t.....
    ....t.....
    ...t......
    ...t......
    K1KssKfaaa
    .KKssK.aaa
    ...t......
    ...t......
    ....t.....
    ....t.....
    .....t....
    .....t....
    ......t...
    ......t...
    .......t..
    """
)

# ---------------------------------------------------------------------------
# North-east -- three-quarter, facing away and +x
# ---------------------------------------------------------------------------

HEAD_NE = block(
    """
    .....KKK.....
    ...KK111KK...
    ..K1111111K..
    .K111333111K.
    .K11111111KK.
    K1111111111sK
    K1111111111sK
    K1111111111K.
    K11111111111K
    .K111111111K.
    ..K1121211K..
    ...KKKKKKK...
    """
)

TORSO_NE = block(
    """
    ...KK11111KK......
    .KK111111111KK....
    K11K1111111K11K...
    K11K1111111K11KKKK
    K11K1111111K1111ss
    K11K1111111KK111KK
    K22K1111111K.KKK..
    .ssK1111111K......
    .SsK2222222K......
    .KKKhhhhhhhK......
    ...KHhhhhhHK......
    ...K2222222K......
    ...KKKKKKKKK......
    """
)

ARM_DRAW_NE = block(
    """
    ..KK.
    .K11K
    K111K
    K1KK.
    KK...
    """
)


# ---------------------------------------------------------------------------
# The directions
#
# `parts`: name -> (x, y, rows) on the canvas. `legs`: the three leg blocks (stand, contact
# A, contact B) with their anchor. `z`: paint order for a standing frame -- `string` is the
# straight string, replaced by `arm_draw` (which carries the bent one) in the draw poses.
# `glow`: where the charge glow centres, the arrowhead.
# ---------------------------------------------------------------------------

_LEGS_FRONT = (11, 26, [LEGS_S, _lift_leg(LEGS_S, range(0, 5), 2), _lift_leg(LEGS_S, range(6, 11), 2)])

# The back view's legs are the front view's; the boots read the same either way.
_LEGS_BACK = _LEGS_FRONT

_LEGS_SIDE = (10, 28, [LEGS_E_STAND, LEGS_E_STEP_A, LEGS_E_STEP_B])

# Bow anchors put the grip (block rows 10..14) beside the hand of each torso.
DIRECTIONS: dict[str, dict] = {
    "s": dict(
        parts={
            "head": (10, 4, HEAD_S),
            "torso": (9, 15, TORSO_S),
            "quiver": (6, 9, QUIVER_S),
            "bow": (23, 10, BOW),
            "string": (23, 11, STRING),
            "arm_draw": (12, 17, ARM_DRAW_S),
            "arrow": (23, 21, ARROW_S),
        },
        legs=_LEGS_FRONT,
        z=("quiver", "legs", "torso", "head", "bow", "string"),
        z_draw=("quiver", "legs", "torso", "head", "bow", "arm_draw", "arrow"),
        glow=(24, 22),
    ),
    "n": dict(
        parts={
            "head": (10, 4, HEAD_N),
            "torso": (9, 15, TORSO_N),
            "quiver": (14, 12, QUIVER_N),
            "bow": (3, 10, mirror(BOW)),
            "string": (7, 11, STRING),
            "arm_draw": (21, 16, ARM_DRAW_N),
        },
        legs=_LEGS_BACK,
        z=("bow", "string", "legs", "torso", "quiver", "head"),
        z_draw=("bow", "string", "legs", "torso", "quiver", "head", "arm_draw"),
        glow=(4, 22),
    ),
    "e": dict(
        parts={
            "head": (9, 4, HEAD_E),
            "torso": (10, 15, TORSO_E),
            "quiver": (7, 8, QUIVER_E),
            "bow": (23, 8, BOW),
            "string": (23, 9, STRING),
            "arm_draw": (14, 8, ARM_DRAW_E),
            "arrow": (28, 20, ARROWHEAD_E),
        },
        legs=_LEGS_SIDE,
        z=("quiver", "string", "legs", "torso", "head", "bow"),
        z_draw=("quiver", "legs", "torso", "head", "bow", "arm_draw", "arrow"),
        glow=(30, 21),
    ),
    "se": dict(
        parts={
            "head": (10, 4, HEAD_SE),
            "torso": (9, 15, TORSO_SE),
            "quiver": (6, 9, QUIVER_S),
            "bow": (24, 9, BOW),
            "string": (24, 10, STRING),
            "arm_draw": (16, 12, ARM_DRAW_SE),
            "arrow": (27, 21, ARROWHEAD_E),
        },
        legs=_LEGS_FRONT,
        z=("quiver", "string", "legs", "torso", "head", "bow"),
        z_draw=("quiver", "legs", "torso", "head", "bow", "arm_draw", "arrow"),
        glow=(29, 22),
    ),
    "ne": dict(
        parts={
            "head": (10, 4, HEAD_NE),
            "torso": (9, 15, TORSO_NE),
            "quiver": (6, 9, mirror(QUIVER_N)),
            "bow": (23, 6, BOW),
            "string": (23, 7, STRING),
            "arm_draw": (5, 16, ARM_DRAW_NE),
        },
        legs=_LEGS_BACK,
        z=("bow", "string", "legs", "torso", "quiver", "head"),
        z_draw=("bow", "string", "legs", "torso", "quiver", "head", "arm_draw"),
        glow=(27, 18),
    ),
}


# ---------------------------------------------------------------------------
# Composition
# ---------------------------------------------------------------------------

Grid = list[list[str]]


def _paint(canvas: Grid, rows: list[str] | list[list[str]], x0: int, y0: int) -> None:
    for dy, row in enumerate(rows):
        for dx, c in enumerate(row):
            if c == ".":
                continue
            x, y = x0 + dx, y0 + dy
            if not (0 <= x < W and 0 <= y < H):
                raise SystemExit(f"archer_sheet: a part paints off the canvas at ({x},{y})")
            canvas[y][x] = c


def _glow(canvas: Grid, cx: int, cy: int, big: bool) -> None:
    """A diamond of glow at the arrowhead: radius 1 for `charge0`, radius 2 with a hot
    core for `charge1`. Painted last so it sits over the arrow it lights."""
    r = 2 if big else 1
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            d = abs(dx) + abs(dy)
            if d > r:
                continue
            x, y = cx + dx, cy + dy
            if 0 <= x < W and 0 <= y < H:
                canvas[y][x] = "G" if big and d <= 1 else "g"


def _shift_up(canvas: Grid, dy: int) -> Grid:
    return canvas[dy:] + [["."] * W for _ in range(dy)]


def compose(direction: str, pose: str) -> Grid:
    """One 42x33 character grid for a direction and pose (skin-agnostic)."""
    if pose == "fallen":
        # The corpse: south idle, transposed. Lossless, and it lands on a 42x33 canvas.
        idle = compose("s", "idle")
        return [[idle[y][x] for y in range(H)] for x in range(W)]

    spec = DIRECTIONS[direction]
    parts = dict(spec["parts"])
    lx, ly, legs = spec["legs"]
    walk = {"walk0": 1, "walk1": 0, "walk2": 2, "walk3": 0}
    parts["legs"] = (lx, ly, legs[walk.get(pose, 0)])

    drawing = pose in ("draw", "charge0", "charge1")
    order = spec["z_draw"] if drawing or pose == "loose" else spec["z"]
    canvas: Grid = [["."] * W for _ in range(H)]
    for name in order:
        if pose == "loose" and name == "arrow":
            continue
        x, y, rows = parts[name]
        # The loose arm is the draw arm with the arrow and the bent string gone; the
        # straight string then shows again underneath it.
        if pose == "loose" and name == "arm_draw":
            _paint(canvas, parts["string"][2], parts["string"][0], parts["string"][1])
            rows = strip_chars(rows, ARROW_CHARS)
        _paint(canvas, rows, x, y)
    if pose in ("charge0", "charge1"):
        _glow(canvas, *spec["glow"], big=pose == "charge1")
    # The pass frames lift the whole figure one row: the bob the old renderer applied as a
    # translate, baked so no per-frame transform exists.
    if pose in ("walk1", "walk3"):
        canvas = _shift_up(canvas, 1)
    return canvas
