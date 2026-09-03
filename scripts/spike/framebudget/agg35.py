#!/usr/bin/env python3
"""Median across reps per (arm:case), plus the ctl -> cand delta, read from a driver LOG so a
partial run still tabulates. Profile lines are skipped; `grep '^  '` the log for those."""
import json, sys, statistics as st

rows = [json.loads(l) for p in sys.argv[1:] for l in open(p) if l.startswith('{')]
by, order = {}, []
for r in rows:
    if r['name'] not in by:
        order.append(r['name'])
    by.setdefault(r['name'], []).append(r)

COLS = [('commitP50', 'p50', 6, 2), ('commitP95', 'p95', 7, 2), ('commitP99', 'p99', 7, 2), ('commitMax', 'max', 7, 1),
        ('overPct', '>16.7%', 7, 1), ('fps', 'fps', 6, 1), ('feedActualHz', 'feedHz', 7, 0), ('longTasks', 'long', 5, 0),
        ('recalcPerFrame', 'rcs/f', 6, 2), ('layoutPerFrame', 'lay/f', 6, 2), ('styleMs', 'style', 6, 0),
        ('scriptMs', 'script', 7, 0), ('heapGrowMB', 'heap+', 6, 1), ('jsHeapMB', 'heapMB', 7, 1), ('nodes', 'nodes', 6, 0)]

def med(rs, k):
    v = [x[k] for x in rs if x.get(k) is not None]
    return st.median(v) if v else float('nan')

print(f"{'case':24} {'n':>2} " + ' '.join(f"{h:>{w}}" for _, h, w, _ in COLS))
for name in order:
    rs = by[name]
    print(f"{name:24} {len(rs):2d} " + ' '.join(f"{med(rs, k):{w}.{d}f}" for k, _, w, d in COLS))

cases = sorted({n.split(':', 1)[1] for n in order})
if any(n.startswith('ctl:') for n in order) and any(n.startswith('cand:') for n in order):
    print()
    print(f"{'delta cand-ctl':24} {'':>2} " + ' '.join(f"{h:>{w}}" for _, h, w, _ in COLS))
    for c in cases:
        a, b = by.get(f'ctl:{c}'), by.get(f'cand:{c}')
        if not a or not b:
            continue
        print(f"{c:24} {min(len(a), len(b)):2d} " + ' '.join(f"{med(b, k) - med(a, k):+{w}.{d}f}" for k, _, w, d in COLS))
