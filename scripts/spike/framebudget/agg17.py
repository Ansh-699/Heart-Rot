#!/usr/bin/env python3
"""Median across reps, with the spread, for the spec-17 frame budget run."""
import json, sys, statistics as st
rows = json.load(open(sys.argv[1] if len(sys.argv) > 1 else 'results17.json'))
by = {}
for r in rows:
    by.setdefault(r['name'], []).append(r)
KEYS = ['commitP50','commitP95','commitP99','commitMax','overPct','fps','feedActualHz',
        'firstPaintMs','nodes','svgNodes','jsHeapMB','stageMpx','busyPct','scriptMs','taskMs']
print(f"{'case':22} {'n':>2} {'p50':>6} {'sd':>5} {'p95':>7} {'sd':>6} {'p99':>7} {'max':>7} "
      f"{'>16.7%':>7} {'fps':>6} {'feedHz':>7} {'Mpx':>5} {'nodes':>6} {'heapMB':>7} {'1stpaint':>8}")
for name, rs in by.items():
    def m(k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return st.median(v) if v else float('nan')
    def sd(k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return st.pstdev(v) if len(v) > 1 else 0.0
    print(f"{name:22} {len(rs):2d} {m('commitP50'):6.2f} {sd('commitP50'):5.2f} "
          f"{m('commitP95'):7.2f} {sd('commitP95'):6.2f} {m('commitP99'):7.2f} {m('commitMax'):7.1f} "
          f"{m('overPct'):7.1f} {m('fps'):6.1f} {m('feedActualHz'):7.0f} {m('stageMpx'):5.2f} "
          f"{m('nodes'):6.0f} {m('jsHeapMB'):7.1f} {m('firstPaintMs'):8.1f}")
