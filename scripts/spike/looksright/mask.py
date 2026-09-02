"""Throwaway (task: art-judge). Shared geometry: the bitboard, the CTM, luminance."""
import json
import re

import numpy as np
from PIL import Image

ROOT = '/home/anshtyagi/Documents/pixel-artgame'
SHOT = f'{ROOT}/docs/art/shipped'
REF_A = '/home/anshtyagi/Downloads/waiting_area_full_vertical.png'
REF_B = '/home/anshtyagi/Downloads/actual_boss_arena.png'

TILE = 16
_src = open(f'{ROOT}/packages/client/src/map.ts').read()
GRID = re.findall(r"'([^']*)'", re.search(r'MAP_GRID[^=]*=\s*\[(.*?)\];', _src, re.S).group(1))
assert len(GRID) == 64 and len(GRID[0]) == 64


def const(name):
    return int(re.search(rf'export const {name}\s*=\s*(-?\d+)', _src).group(1))


PIT_TOP, PIT_BOT = const('PIT_TOP'), const('PIT_BOT')
LOBBY_TOP, LOBBY_BOT = const('LOBBY_TOP'), const('LOBBY_BOT')
GATE_MIN_X, GATE_MAX_X = const('GATE_MIN_X'), const('GATE_MAX_X')
GATE_MIN_Y, GATE_MAX_Y = const('GATE_MIN_Y'), const('GATE_MAX_Y')

WALK = np.array([[GRID[y][x] != '#' for x in range(64)] for y in range(64)])
LOBBY_T = WALK.copy(); LOBBY_T[: LOBBY_TOP // TILE] = False
PIT_T = WALK.copy(); PIT_T[: PIT_TOP // TILE] = False; PIT_T[PIT_BOT // TILE + 1:] = False

GEOM = {g['name']: g for g in json.load(open(f'{SHOT}/geometry.json'))}


def lin(c):
    c = np.asarray(c, float) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def Y(rgb):
    l = lin(rgb)
    return 0.2126 * l[..., 0] + 0.7152 * l[..., 1] + 0.0722 * l[..., 2]


def K(a, b):
    hi, lo = np.maximum(a, b), np.minimum(a, b)
    return (hi + 0.05) / (lo + 0.05)


def img(p):
    return np.asarray(Image.open(p).convert('RGB'), float)


class Cam:
    """world -> full-page screen px, from the CTM the browser reported (a == d)."""

    def __init__(self, name):
        g = GEOM[name]['geom']
        c = g['ctm']
        self.s, self.e, self.f = c['a'], c['e'], c['f']
        st = g['stage']
        self.stage = (st['x'], st['y'], st['w'], st['h'])

    def px(self, x, y):
        return self.s * np.asarray(x, float) + self.e, self.s * np.asarray(y, float) + self.f

    def tile_mask(self, tiles, shape):
        """Rasterise a 64x64 tile mask into a full-page screen boolean of `shape` (h, w)."""
        h, w = shape
        yy, xx = np.mgrid[0:h, 0:w]
        wx = (xx - self.e) / self.s
        wy = (yy - self.f) / self.s
        tx = np.floor(wx / TILE).astype(int)
        ty = np.floor(wy / TILE).astype(int)
        ok = (tx >= 0) & (tx < 64) & (ty >= 0) & (ty < 64)
        out = np.zeros((h, w), bool)
        out[ok] = tiles[ty[ok], tx[ok]]
        return out
