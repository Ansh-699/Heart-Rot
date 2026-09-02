#!/usr/bin/env python3
"""Median across reps, with spread, read from a driver LOG so a partial run still tabulates."""
import json, sys, statistics as st

rows = []
for path in sys.argv[1:]:
    for line in open(path):
        if line.startswith('{'):
            rows.append(json.loads(line))

by = {}
order = []
for r in rows:
    if r['name'] not in by:
        order.append(r['name'])
    by.setdefault(r['name'], []).append(r)

hdr = (f"{'case':20} {'n':>2} {'p50':>6} {'sd':>5} {'p95':>7} {'sd':>6} {'p99':>7} {'max':>7} "
       f"{'>16.7%':>7} {'fps':>6} {'feedHz':>7} {'Mpx':>5} {'nodes':>6} {'heapMB':>7} {'style_ms':>8} {'script_ms':>9}")
print(hdr)
for name in order:
    rs = by[name]
    def m(k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return st.median(v) if v else float('nan')
    def sd(k):
        v = [x[k] for x in rs if x.get(k) is not None]
        return st.pstdev(v) if len(v) > 1 else 0.0
    print(f"{name:20} {len(rs):2d} {m('commitP50'):6.2f} {sd('commitP50'):5.2f} "
          f"{m('commitP95'):7.2f} {sd('commitP95'):6.2f} {m('commitP99'):7.2f} {m('commitMax'):7.1f} "
          f"{m('overPct'):7.1f} {m('fps'):6.1f} {m('feedActualHz'):7.0f} {m('stageMpx'):5.2f} "
          f"{m('nodes'):6.0f} {m('jsHeapMB'):7.1f} {m('styleMs'):8.0f} {m('scriptMs'):9.0f}")
