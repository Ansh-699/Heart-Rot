#!/usr/bin/env python3
"""Fire signature diff: how far a shot is from the reference in the things that make
fire read as fire. Usage: diff.py ref.png shot.png [composite.png]"""
import sys, json, numpy as np, cv2

def sig(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    H, S, V = hsv[..., 0].astype(int), hsv[..., 1].astype(int), hsv[..., 2].astype(int)
    fire = ((H <= 25) | (H >= 172)) & (S > 110) & (V > 120)
    hue = np.where(H >= 172, H - 180, H) * 2
    n = max(int(fire.sum()), 1)
    hh = np.histogram(hue[fire], bins=[-10, 0, 10, 20, 30, 40, 52])[0] / n
    vh = np.histogram(V[fire], bins=[120, 178, 217, 242, 256])[0] / n
    sh = np.histogram(S[fire], bins=[110, 153, 204, 256])[0] / n
    core = (fire & (V > 235) & (S < 140)).sum() / n
    b, g, r = img[..., 0].astype(int), img[..., 1].astype(int), img[..., 2].astype(int)
    warm = (~fire) & ((r - b) > 30) & (V > 40)
    cnt, lab, stats, _ = cv2.connectedComponentsWithStats(fire.astype(np.uint8), 8)
    el = []
    for i in range(1, cnt):
        if stats[i, cv2.CC_STAT_AREA] < 150: continue
        ys, xs = np.where(lab == i)
        ev = np.linalg.eigvalsh(np.cov(np.stack([xs, ys], 1).astype(np.float32).T))
        el.append(float(np.sqrt(ev[1] / max(ev[0], 1e-6))))
    return dict(coverage=float(fire.mean()), hue=hh, val=vh, sat=sh, core=float(core),
                warm=float(warm.mean()), blobs=len(el), elong=float(np.median(el)) if el else 0.0,
                mask=fire)

def bhat(a, b):
    return float(cv2.compareHist(a.astype(np.float32), b.astype(np.float32), cv2.HISTCMP_BHATTACHARYYA))

def ssim_gray(a, b):
    a = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.float64); b = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.float64)
    C1, C2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    mu_a, mu_b = cv2.GaussianBlur(a, (11, 11), 1.5), cv2.GaussianBlur(b, (11, 11), 1.5)
    sa = cv2.GaussianBlur(a * a, (11, 11), 1.5) - mu_a ** 2; sb = cv2.GaussianBlur(b * b, (11, 11), 1.5) - mu_b ** 2
    sab = cv2.GaussianBlur(a * b, (11, 11), 1.5) - mu_a * mu_b
    m = ((2 * mu_a * mu_b + C1) * (2 * sab + C2)) / ((mu_a ** 2 + mu_b ** 2 + C1) * (sa + sb + C2))
    return float(m.mean())

ref = cv2.imread(sys.argv[1]); shot = cv2.imread(sys.argv[2])
if shot.shape != ref.shape: shot = cv2.resize(shot, (ref.shape[1], ref.shape[0]), interpolation=cv2.INTER_AREA)
R, S = sig(ref), sig(shot)
d = {
    'coverage': (R['coverage'], S['coverage']),
    'hue_bhat': bhat(R['hue'], S['hue']), 'val_bhat': bhat(R['val'], S['val']), 'sat_bhat': bhat(R['sat'], S['sat']),
    'core': (R['core'], S['core']), 'warm': (R['warm'], S['warm']), 'blobs': (R['blobs'], S['blobs']), 'elong': (R['elong'], S['elong']),
    'ssim': ssim_gray(ref, shot),
}
# One number: 100 = the reference. Each term is a distance in [0,1], weighted by how much it matters to "reads as the picture".
cov = min(1, abs(R['coverage'] - S['coverage']) / max(R['coverage'], 1e-6))
core = min(1, abs(R['core'] - S['core']) / max(R['core'], 1e-6))
warm = min(1, abs(R['warm'] - S['warm']) / max(R['warm'], 1e-6))
elong = min(1, abs(R['elong'] - S['elong']) / max(R['elong'], 1e-6))
score = 100 * (1 - (0.22 * cov + 0.18 * d['hue_bhat'] + 0.15 * d['val_bhat'] + 0.08 * d['sat_bhat'] + 0.10 * core + 0.12 * warm + 0.15 * elong))
d['score'] = round(score, 1)
print(json.dumps({k: (round(v, 3) if isinstance(v, float) else tuple(round(x, 3) for x in v) if isinstance(v, tuple) else v) for k, v in d.items()}))
print('ref hue', np.round(R['hue'], 2), 'shot hue', np.round(S['hue'], 2))
print('ref val', np.round(R['val'], 2), 'shot val', np.round(S['val'], 2))
if len(sys.argv) > 3:
    h, w = ref.shape[:2]; sc = 0.5
    a = cv2.resize(ref, None, fx=sc, fy=sc); b = cv2.resize(shot, None, fx=sc, fy=sc)
    ma = cv2.resize(R['mask'].astype(np.uint8) * 255, None, fx=sc, fy=sc); mb = cv2.resize(S['mask'].astype(np.uint8) * 255, None, fx=sc, fy=sc)
    m = np.zeros_like(a); m[..., 2] = ma; m[..., 1] = mb  # red = ref only, green = shot only, yellow = both
    cv2.imwrite(sys.argv[3], np.vstack([np.hstack([a, b]), np.hstack([m, cv2.absdiff(a, b)])]))
