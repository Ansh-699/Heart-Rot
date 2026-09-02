"""CSS filter shorthand chain, as color matrices in sRGB (Filter Effects L1).
Validated against a real Chrome render below: predict shipped.png from ungraded.png."""
import numpy as np, math
from PIL import Image
FB='/home/anshtyagi/Documents/pixel-artgame/scripts/spike/framebudget/'
def ld(p): return np.asarray(Image.open(p).convert('RGB')).astype(np.float64)
LUM=np.array([0.2126,0.7152,0.0722])
def m_grayscale(a):
    a=1-a
    return np.array([[0.2126+0.7874*a,0.7152-0.7152*a,0.0722-0.0722*a],
                     [0.2126-0.2126*a,0.7152+0.2848*a,0.0722-0.0722*a],
                     [0.2126-0.2126*a,0.7152-0.7152*a,0.0722+0.9278*a]])
def m_sepia(a):
    a=1-a
    return np.array([[0.393+0.607*a,0.769-0.769*a,0.189-0.189*a],
                     [0.349-0.349*a,0.686+0.314*a,0.168-0.168*a],
                     [0.272-0.272*a,0.534-0.534*a,0.131+0.869*a]])
def m_saturate(s):
    return np.array([[0.213+0.787*s,0.715-0.715*s,0.072-0.072*s],
                     [0.213-0.213*s,0.715+0.285*s,0.072-0.072*s],
                     [0.213-0.213*s,0.715-0.715*s,0.072+0.928*s]])
def m_hue(deg):
    c,s=math.cos(math.radians(deg)),math.sin(math.radians(deg))
    return np.array([
      [0.213+c*0.787-s*0.213, 0.715-c*0.715-s*0.715, 0.072-c*0.072+s*0.928],
      [0.213-c*0.213+s*0.143, 0.715+c*0.285+s*0.140, 0.072-c*0.072-s*0.283],
      [0.213-c*0.213-s*0.787, 0.715-c*0.715+s*0.715, 0.072+c*0.928+s*0.072]])
def apply_chain(rgb, chain):
    """rgb: (...,3) 0..255. chain: list of (fn, arg)."""
    x=np.clip(rgb/255.0,0,1)
    for fn,arg in chain:
        if fn=='grayscale': x=x@m_grayscale(arg).T
        elif fn=='sepia':   x=x@m_sepia(arg).T
        elif fn=='saturate':x=x@m_saturate(arg).T
        elif fn=='hue-rotate': x=x@m_hue(arg).T
        elif fn=='brightness': x=x*arg
        elif fn=='contrast':   x=x*arg+(0.5-0.5*arg)
        else: raise ValueError(fn)
        x=np.clip(x,0,1)          # every primitive clamps to [0,1]
    return x*255
def parse(s):
    out=[]
    for tok in s.replace(')',') ').split():
        pass
    import re
    for fn,arg in re.findall(r'([a-z-]+)\(([-0-9.]+)(?:deg)?\)',s):
        out.append((fn,float(arg)))
    return out
def relL(x):
    c=np.asarray(x,float)/255.0; c=np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)
    return 0.2126*c[...,0]+0.7152*c[...,1]+0.0722*c[...,2]

if __name__=='__main__':
    nb,ug,sh=ld(FB+'light/noboss.png'),ld(FB+'light/ungraded.png'),ld(FB+'light/shipped.png')
    m=(np.abs(ug-nb).max(axis=2)>6)
    # erode 3 px so antialiased edge pixels (partial alpha) are excluded from validation
    e=m.copy()
    for _ in range(3): e=e&np.roll(e,1,0)&np.roll(e,-1,0)&np.roll(e,1,1)&np.roll(e,-1,1)
    ch=parse('grayscale(0.7) sepia(0.6) hue-rotate(185deg) saturate(1.6) brightness(0.32)')
    print('parsed',ch)
    pred=apply_chain(ug[e],ch); act=sh[e]
    err=np.abs(pred-act)
    print('MODEL VALIDATION on %d interior px: mean |err| %.2f  p95 %.2f  max %.1f (0..255)'%(
        e.sum(),err.mean(),np.percentile(err,95),err.max()))
    print(' predicted L255 p50 %.1f p90 %.1f p99 %.1f'%tuple(np.percentile(relL(pred)*255,[50,90,99])))
    print(' actual    L255 p50 %.1f p90 %.1f p99 %.1f'%tuple(np.percentile(relL(act)*255,[50,90,99])))
