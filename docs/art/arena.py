import re, sys, json, numpy as np
#!/usr/bin/env python3
"""Reproduces every number in `docs/art/arena.md`.

    python3 docs/art/arena.py            # the whole table: validation, candidates, sweep

Method
------
* The scene is composited in sRGB, layer for layer, out of the shipped sources:
  `assets/sprites/temple.svg`, `assets/sprites/parts/boss.svg`,
  `app/src/render/knights.gen.ts`, `app/src/render/Scene.tsx`'s constants and
  `assets/map/arena.json`. Nothing is redrawn or retyped.
* `sepia`/`hue-rotate`/`saturate`/`brightness` are evaluated as the CSS Filter Effects
  colour matrices in sRGB, which is what the shorthand functions specify.
* WCAG 2.x relative luminance and contrast `(hi+.05)/(lo+.05)`; floor levels are quoted
  as Rec.709 luminance on 8-bit sRGB, written L8.
* A knight's contrast is taken against the MEAN linear luminance of the 33x42 box it
  covers (`SPRITE_W`/`SPRITE_H`/`FEET_Y` from `Knight.tsx`), not the single unit under
  its feet -- that is what the eye integrates.

Validation, three numbers this codebase measured independently:
  1. graded temple over the pit band -> sRGB (41, 50, 65), mean channel 51.9
     (`Scene.tsx` TEMPLE_GRADE doc says exactly that)
  2. skin body relative luminance -> 0.1678 / 0.1136 / 0.1303
     (`Scene.tsx` PIT_POOL_ALPHA doc, same three)
  3. the drawn rig is `parts/boss.svg` minus {ground, legs}, clipped at
     `boss.y + BOSS_HIT_BOT` where BOSS_HIT_BOT = max(r.y + r.h) = 312 over
     `PART_HITBOXES` (`Arena.tsx` derives the clip from that table)

No dependency beyond numpy, already installed for `tools/`. Pillow is not needed.
"""
ROOT=__file__.rsplit('/docs/',1)[0]
SUB=re.compile(r'M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\d+z')
TEMPLE_W,TEMPLE_H=210,238

REL=re.compile(r'm(-?\d+) ?(-?\d+)h(-?\d+)v(-?\d+)h(-?\d+)z')
def rects(d):
    """px2svg emits RELATIVE subpaths: `m dx dy h w v h h-w z`, each `m` relative to the
    previous subpath's start (z restores the current point to it)."""
    cx=cy=0
    for m in REL.finditer(d):
        dx,dy,w,h,_=map(int,m.groups())
        cx+=dx; cy+=dy
        yield cx,cy,w,h
N=1024

def hx(h): return np.array([int(h[1:3],16),int(h[3:5],16),int(h[5:7],16)],float)
def lin(c):
    c=np.asarray(c,float)/255.0
    return np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)
def Y(rgb):
    l=lin(rgb); return 0.2126*l[...,0]+0.7152*l[...,1]+0.0722*l[...,2]
def L8(rgb):  # Rec.709 on 8-bit sRGB, the unit boss-arena.md reports floor levels in
    return 0.2126*rgb[...,0]+0.7152*rgb[...,1]+0.0722*rgb[...,2]

# ---- CSS Filter Effects colour matrices, applied in sRGB (what the shorthands specify)
def m_sepia(a):
    return np.array([[.393+.607*(1-a),.769-.769*(1-a),.189-.189*(1-a)],
                     [.349-.349*(1-a),.686+.314*(1-a),.168-.168*(1-a)],
                     [.272-.272*(1-a),.534-.534*(1-a),.131+.869*(1-a)]])
def m_huerotate(deg):
    r=np.deg2rad(deg); c,s=np.cos(r),np.sin(r)
    return (np.array([[.213,.715,.072]]*3)
            + c*np.array([[.787,-.715,-.072],[-.213,.285,-.072],[-.213,-.715,.928]])
            + s*np.array([[-.213,-.715,.928],[.143,.140,-.283],[-.787,.715,.072]]))
def m_saturate(v):
    return (np.array([[.213,.715,.072]]*3)
            + v*np.array([[.787,-.715,-.072],[-.213,.285,-.072],[-.213,-.715,.928]]))
TEMPLE_GRADE_M = 0.5*(m_saturate(1.39) @ m_huerotate(177) @ m_sepia(1.0))

def grade(rgb):
    return np.clip(rgb @ TEMPLE_GRADE_M.T, 0, 255)

# ---- the temple, rasterised from its own subpaths (px2svg output: axis-aligned rects)
_T=None
def temple_1024():
    global _T
    if _T is not None: return _T.copy()
    src=open(f'{ROOT}/assets/sprites/temple.svg').read()
    img=np.zeros((TEMPLE_H,TEMPLE_W,3),float)
    for fill,d in re.findall(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"',src):
        c=hx(fill)
        for x,y,w,h in rects(d):
            img[y:y+h,x:x+w]=c
    g=grade(img)
    yi=(np.arange(N)*TEMPLE_H//N).clip(0,TEMPLE_H-1)
    xi=(np.arange(N)*TEMPLE_W//N).clip(0,TEMPLE_W-1)
    _T=g[yi][:,xi]
    return _T.copy()

# ---- source-over
def over(dst, col, alpha):
    a=np.asarray(alpha)[...,None] if np.ndim(alpha) else alpha
    return dst*(1-a)+np.asarray(col,float)*a

def selftest():
    t=temple_1024()
    band=t[384:608]
    print('graded temple over pit band  sRGB', tuple(round(v) for v in band.reshape(-1,3).mean(0)),
          ' mean channel %.1f'%band.mean())

# ---------------------------------------------------------------- boss occlusion
BOSS_SCALE, BOSS_ANCHOR_X, BOSS_ANCHOR_Y = 3, -345, -405
HIDDEN={'ground','legs'}
BOSS_HIT_BOT=312   # max(part.y+h) over PART_HITBOXES; Arena.tsx derives the clip from it
def boss_mask(bx, by):
    """The DRAWN rig: parts/boss.svg minus HIDDEN, clipped at boss.y + BOSS_HIT_BOT,
    placed exactly as Boss.tsx places it."""
    src=open(f'{ROOT}/assets/sprites/parts/boss.svg').read()
    m=np.zeros((N,N),bool)
    for g in re.finditer(r'<g id="part-([a-z0-9_]+)">(.*?)</g>', src, re.S):
        if g.group(1) in HIDDEN: continue
        for d in re.findall(r'<path[^>]* d="([^"]*)"', g.group(2)):
            for x,y,w,h in rects(d):
                X0=bx+BOSS_ANCHOR_X+x*BOSS_SCALE; Y0=by+BOSS_ANCHOR_Y+y*BOSS_SCALE
                X1=min(N,X0+w*BOSS_SCALE); Y1=min(N,min(Y0+h*BOSS_SCALE, by+BOSS_HIT_BOT))
                X0=max(0,X0); Y0=max(0,Y0)
                if X1>X0 and Y1>Y0: m[Y0:Y1,X0:X1]=True
    return m

# ---------------------------------------------------------------- the composite
_G=None
def ell(cx,cy,rx,ry):
    global _G
    if _G is None: _G=np.mgrid[0:N,0:N]
    yy,xx=_G
    return np.sqrt(((xx-cx)/rx)**2+((yy-cy)/ry)**2)

REF_COURSE = 56  # image B's own course spacing at our arena's scale; see arena.md 3.2
# BossArena.tsx's own two constants. A course is TWO concentric ellipses -- the mortar joint
# on (rx*k, ry*k), the lit crest KERB units inside it on (rx*k - KERB, ry*k - KERB) -- and
# not a band on one side of a single ellipse, which is what this model used to draw.
KERB = 2.5
MORTAR_ALPHA = 0.92

def ring_ks(rx, ry):
    n = max(4, round((rx * ry) ** 0.5 / REF_COURSE))
    return [ (i + 1) / n for i in range(n) ]

def composite(pit, wash, g, rings=True):
    """pit: dict(mask, top, bot, x0, x1, boss). Returns the sRGB 1024x1024 background."""
    img=np.full((N,N,3),hx('#0c0f13'),float)
    t=temple_1024(); img=t.copy()
    P=pit['mask']; top,bot,x0,x1=pit['top'],pit['bot'],pit['x0'],pit['x1']
    # 3. wash, over the pit region extended 22 units up (one knight above the feet line)
    Wm=P.copy()
    Wm[max(0,top-22):top, x0:x1]=True
    img=np.where(Wm[...,None], over(img,hx('#03070f'),wash), img)
    cx=(x0+x1)/2; cy=(top+bot+1)/2; rx=(x1-x0)/2; ry=(bot+1-top)/2
    if rings:
        r=ell(cx,cy,rx,ry)
        inpit=P
        # 4. dais
        img=np.where((inpit&(r<0.22))[...,None], over(img,hx('#8fb6cf'),0.10*g), img)
        # 5. ring courses, in BossArena.tsx's order: the 2-unit lit crest on the ellipse
        #    KERB units INSIDE the joint, then the 3-unit mortar joint painted over it.
        #    `s` is signed distance from the ring line in units, positive toward the centre,
        #    under the same min(rx,ry) approximation the rest of this model uses.
        #    This used to draw the crest as a band on the `r > k` side of the SAME ellipse
        #    at alpha 0.16*g over a 0.60 joint -- a lit edge OUTSIDE the mortar on geometry
        #    the shipped room does not have, and a joint a third too transparent.
        for k in ring_ks(rx,ry):
            s=(k-r)*min(rx,ry)
            img=np.where((inpit&(np.abs(s-KERB)<1.0))[...,None], over(img,hx('#a8d6f0'),0.16*g), img)
            img=np.where((inpit&(np.abs(s)<1.5))[...,None], over(img,hx('#04070d'),MORTAR_ALPHA), img)
        # 6. medallions: diamonds at the four cardinals of k=0.65
        yy,xx=np.mgrid[0:N,0:N]
        med=np.zeros((N,N),bool)
        MW,MH=26,12
        ks=ring_ks(rx,ry); km=ks[max(0,round(0.66*len(ks))-1)]  # image B's medallion radius
        for mx,my in ((cx,cy-km*ry),(cx,cy+km*ry),(cx-km*rx,cy),(cx+km*rx,cy)):
            med |= (np.abs(xx-mx)/MW + np.abs(yy-my)/MH) <= 1
        img=np.where((inpit&med)[...,None], over(img,hx('#9fc4dc'),0.13*g), img)
    # 7. pool, centred on the boss's x and 0.30 down the band (see spec)
    pcx, pcy = pit['boss'][0], top + 0.30*(bot+1-top)
    prx, pry = rx*1.05, (bot+1-top)*0.67
    a=np.clip(1-ell(pcx,pcy,prx,pry),0,1)*0.14*g
    img=over(img,hx('#96cdeb'),a)
    # 8. core spill
    core=(pit['boss'][0]+75, pit['boss'][1]-54)
    a=np.clip(1-ell(core[0],core[1],330,330),0,1)*0.10*g
    img=over(img,hx('#6ee1ff'),a)
    # 9. ceiling
    yy=np.arange(N)[:,None]
    CE=330.0
    a=np.where(yy<CE, 0.92*(1-yy/CE), 0.0)*np.ones((1,N))
    img=over(img,hx('#050811'),a)
    # 10. rim band  (fade in / peak / fade out)
    r0,r1,r2=pit['rim']
    a=np.zeros((N,1))
    a[r0:r1,0]=np.linspace(0,0.72,max(1,r1-r0))
    a[r1:r2,0]=np.linspace(0.72,0,max(1,r2-r1))
    img=over(img,hx('#03060c'),a*np.ones((1,N)))
    # 11. vignette
    d=ell(N/2,N/2,0.72*N,0.72*N)
    a=np.clip((d-0.52)/(1-0.52),0,1)*0.72
    img=over(img,hx('#000000'),a)
    return np.clip(img,0,255)

def composite_shipped(pit, pool_a=0.10, core_a=0.10, wash=0.45):
    """Scene.tsx exactly as it ships today, layer for layer."""
    img=temple_1024()
    P=pit['mask']; top,bot,x0,x1=pit['top'],pit['bot'],pit['x0'],pit['x1']
    img=np.where(P[...,None], over(img,hx('#03070f'),wash), img)
    m=np.zeros((N,N),bool); m[max(0,top-2):top+1, x0:x1]=True
    img=np.where(m[...,None], over(img,hx('#a8d6f0'),0.42), img)
    m=np.zeros((N,N),bool); m[top+1:top+15, x0:x1]=True
    img=np.where(m[...,None], over(img,hx('#03060c'),0.50), img)
    yy=np.arange(N)[:,None]; CE=330.0
    img=over(img,hx('#050811'),np.where(yy<CE,0.92*(1-yy/CE),0.0)*np.ones((1,N)))
    img=over(img,hx('#96cdeb'),np.clip(1-ell(512,(top+bot)/2,470,215),0,1)*pool_a)
    c=(pit['boss'][0]+75,pit['boss'][1]-54)
    img=over(img,hx('#6ee1ff'),np.clip(1-ell(c[0],c[1],330,330),0,1)*core_a)
    a=np.zeros((N,1)); a[520:600,0]=np.linspace(0,0.72,80); a[600:700,0]=np.linspace(0.72,0,100)
    img=over(img,hx('#03060c'),a*np.ones((1,N)))
    d=ell(N/2,N/2,0.72*N,0.72*N)
    img=over(img,hx('#000000'),np.clip((d-0.52)/(1-0.52),0,1)*0.72)
    return np.clip(img,0,255)


# ================================================== the figures
SKINS=['Cobalt','Nocturne','Argent']
KEY=['#a8c1e0','#dcb7aa','#bebec9']
SUB=re.compile(r'M(-?\d+) (-?\d+)h(\d+)v(\d+)h-\d+z')
W,H=33,42
_d=re.search(r"export const KNIGHT_DEFS = '(.*)';",open(f'{ROOT}/app/src/render/knights.gen.ts').read(),re.S).group(1)
def hx(h): return np.array([int(h[1:3],16),int(h[3:5],16),int(h[5:7],16)],float)
def lin(c):
    c=np.asarray(c,float)/255.0
    return np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)
def Y(rgb):
    l=lin(rgb); return 0.2126*l[...,0]+0.7152*l[...,1]+0.0722*l[...,2]
def grp(i,pose): 
    j=_d.index(f'<g id="k{i}-{pose}">'); return _d[j:_d.index('</g>',j)]
def mask(src):
    m=np.zeros((H,W),bool)
    for s in SUB.finditer(src):
        x,y,w,h=map(int,s.groups()); m[max(0,y):y+h,max(0,x):x+w]=True
    return m
def figure(i):
    g=grp(i,'rest'); body=mask(g)
    counts={}
    for pm in re.finditer(r'<path fill="(#[0-9a-fA-F]{6})" d="([^"]*)"',g):
        n=sum(int(s.group(3))*int(s.group(4)) for s in SUB.finditer(pm.group(2)))
        counts[pm.group(1).lower()]=counts.get(pm.group(1).lower(),0)+n
    tot=sum(counts.values())
    yb=sum(Y(hx(h))*n for h,n in counts.items())/tot
    rim=mask(grp(i,'halo')) & ~body
    nb,nr=body.sum(),rim.sum()
    yk=Y(hx(KEY[i]))
    yf=(yb*nb+yk*nr)/(nb+nr)
    return dict(skin=SKINS[i],body_px=int(nb),Y_body=yb,rim_px=int(nr),Y_key=yk,Y_fig=yf)

# ================================================== the ground
N=1024; TILE=16
SPRITE_W,SPRITE_H,FEET_Y=33,42,20

def pit_from_grid(grid, boss):
    P=np.zeros((N,N),bool); rows=[]
    for ty,row in enumerate(grid):
        for tx,ch in enumerate(row):
            if ch in 'PBE': P[ty*TILE:(ty+1)*TILE, tx*TILE:(tx+1)*TILE]=True
    ys=np.where(P.any(1))[0]; xs=np.where(P.any(0))[0]
    top,bot,x0,x1=int(ys[0]),int(ys[-1]),int(xs[0]),int(xs[-1])+1
    return dict(mask=P,top=top,bot=bot,x0=x0,x1=x1,boss=boss,
                rim=(bot-87,bot-7,bot+93))

def walkable_units(pit, exclude):
    """Feet positions: every unit of every P tile, minus units the boss covers."""
    m = pit['mask'] & ~exclude
    ys,xs=np.where(m)
    return ys,xs

def boxY(img, ys, xs):
    Yl = Y(img)                       # relative luminance per unit
    ii = np.cumsum(np.cumsum(np.pad(Yl,((1,0),(1,0))),0),1)
    def rect(y0,y1,x0,x1):
        y0=np.clip(y0,0,N); y1=np.clip(y1,0,N); x0=np.clip(x0,0,N); x1=np.clip(x1,0,N)
        return (ii[y1,x1]-ii[y0,x1]-ii[y1,x0]+ii[y0,x0])/np.maximum((y1-y0)*(x1-x0),1)
    return rect(ys-(SPRITE_H-FEET_Y-1), ys+FEET_Y+1, xs-SPRITE_W//2, xs+SPRITE_W//2+1)

def K(a,b):
    hi=np.maximum(a,b); lo=np.minimum(a,b); return (hi+0.05)/(lo+0.05)

FIG={f['skin']:f['Y_fig'] for f in (figure(i) for i in range(3))}

def report(name, img, pit, exclude):
    ys,xs=walkable_units(pit,exclude)
    b=boxY(img,ys,xs)
    print(f'-- {name}   units {len(b):,}')
    print(f'   background box Y   p50 {np.percentile(b,50):.4f}  p95 {np.percentile(b,95):.4f}  max {b.max():.4f}')
    out={}
    for s,yf in FIG.items():
        c=K(yf,b)
        out[s]=(c.min(),np.percentile(c,5),np.percentile(c,50),(c<3).mean()*100)
        print(f'   {s:9} worst {c.min():.2f}:1  p5 {np.percentile(c,5):.2f}:1  p50 {np.percentile(c,50):.2f}:1'
              f'   under 3:1 on {(c<3).mean()*100:5.1f} %')
    fl=L8(img)[ys,xs]
    print('   floor L8  p5 %.1f  p50 %.1f  p95 %.1f  max %.1f'%tuple(np.percentile(fl,[5,50,95]).tolist()+[fl.max()]))
    return out

# ================================================== candidates and the sweep
def candidate(T,B,boss_row,door=(30,34),cham=(2,4,7)):
    rows=['#'+'.'*62+'#' for _ in range(64)]
    rows[0]=rows[63]='#'*64
    ins=[0]*(B-T+1-len(cham))+list(cham)
    for ty in range(T,B+1):
        r=['#']*64
        for tx in range(1+ins[ty-T],63-ins[ty-T]): r[tx]='P'
        rows[ty]=''.join(r)
    for ty in (B+1,B+2):
        r=['#']*64
        for tx in range(door[0],door[1]): r[tx]='P'
        rows[ty]=''.join(r)
    rows[boss_row]=rows[boss_row][:32]+'B'+rows[boss_row][33:]
    return rows

BOSS_ROW = 25   # BOSS_SPAWN.y / TILE, from the generated map

def build(key):
    rows = CAND_ROWS[key]
    g = (json.load(open(f'{ROOT}/assets/map/arena.json'))['grid'] if rows is None
         else candidate(rows[0], rows[1], BOSS_ROW))
    return pit_from_grid(g, (512, BOSS_ROW * 16)), boss_mask(512, BOSS_ROW * 16)

def solve(pit,bm,wash,target=3.00):
    lo,hi=0.0,3.0
    for _ in range(12):
        mid=(lo+hi)/2
        img=composite(pit,wash,mid)
        ys,xs=walkable_units(pit,bm); b=boxY(img,ys,xs)
        worst=K(FIG['Nocturne'],b).min()
        if worst>=target: lo=mid
        else: hi=mid
    return lo

# ================================================== the driver
CAND_ROWS = {
    'C0 shipped 24..37': None,
    'C1 24..47': (24, 47),
    'C2 20..47': (20, 47),
    'C3 18..49': (18, 49),
}
WASH, GAIN = 0.70, 0.92


def reach_table():
    g = json.load(open(f'{ROOT}/assets/map/arena.json'))['grid']
    MAX = 64
    reach = MAX * 16 * 894 // 1000
    def worst(core):
        w, arg = 0, None
        for ty in range(64):
            for tx in range(64):
                if g[ty][tx] == '#':
                    continue
                x, y = tx * 16 + 8, ty * 16 + 8
                d = (core[0] - x) ** 2 + (core[1] - y) ** 2
                if d > w:
                    w, arg = d, (tx, ty)
        import math
        return math.isqrt(w), arg
    print(f'MAX_RAY_STEPS 64 -> reach {reach} units (64 * TILE * 894 / 1000, integer)')
    for row in range(18, 26):
        d, arg = worst((512 + 75, row * 16 - 54))
        print(f'  boss anchor row {row} (y {row*16}): farthest floor tile {arg} at {d} units'
              f'  {"OK" if d <= reach else "DIES OF RANGE"}')


def main():
    print('== 1. model validation')
    selftest()
    for i in range(3):
        f = figure(i)
        print(f"   {f['skin']:9} body {f['body_px']:4} Y {f['Y_body']:.4f}"
              f"   halo rim {f['rim_px']:4} Y {f['Y_key']:.4f}   figure Y {f['Y_fig']:.4f}")
    print('\n== 2. ray reach')
    reach_table()
    print(f'\n== 3. the gain sweep -- largest g holding Nocturne at 3.00:1 worst case')
    print('           ' + '  '.join(f'{k:>8}' for k in CAND_ROWS) + '       min')
    for wash in (0.45, 0.70, 0.82):
        gs = [solve(*build(k), wash) for k in CAND_ROWS]
        print(f'  wash {wash:.2f}  ' + '  '.join(f'{g:8.3f}' for g in gs) + f'   {min(gs):8.3f}')

    print(f'\n== 4. the pit family, at wash {WASH} gain {GAIN}')
    for key in CAND_ROWS:
        pit, bm = build(key)
        img = composite(pit, WASH, GAIN)
        print(f"\n### {key}  PIT_TOP {pit['top']} PIT_BOT {pit['bot']}"
              f"  height {pit['bot']+1-pit['top']}  units {int(pit['mask'].sum()):,}"
              f"  boss-covered {100*(bm&pit['mask']).sum()/pit['mask'].sum():.1f} %")
        report(f'wash {WASH}, g {GAIN}', img, pit, bm)


if __name__ == '__main__':
    main()
