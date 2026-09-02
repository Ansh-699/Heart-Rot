import json, statistics as st, sys
rows=json.load(open('results3.json'))
by={}
for r in rows: by.setdefault(r['name'],[]).append(r)
hdr=f"{'case':26}{'p50':>6}{'sd':>5}{'p95':>6}{'max':>7}{'>16.7':>7}{'busy%':>7}{'fps':>7}{'feedHz':>7}{'nodes':>6}{'fp':>6}{'styleMs':>8}{'taskMs':>7}"
print(hdr); print('-'*len(hdr))
order=[c['name'] for c in json.load(open('cases3.json'))]
for n in order:
    rs=by.get(n)
    if not rs: continue
    p50=[r['commitP50'] for r in rs]
    m=lambda k,d=2: round(st.mean([r[k] for r in rs]),d)
    print(f"{n:26}{round(st.mean(p50),2):>6}{round(st.pstdev(p50),2):>5}{m('commitP95'):>6}"
          f"{round(max(r['commitMax'] for r in rs),1):>7}{m('overPct',1):>7}{m('busyPct',1):>7}"
          f"{m('fps',1):>7}{m('feedActualHz',0):>7}{rs[0]['nodes']:>6}{m('firstPaintMs',1):>6}"
          f"{m('styleMs'):>8}{m('taskMs'):>7}")
