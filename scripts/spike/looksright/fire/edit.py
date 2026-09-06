#!/usr/bin/env python3
"""Cut a take into the showcase: cards, dissolves, lower thirds, Twitter masters.
   edit.py <take.webm> <beats.json> <typo dir> <out dir>"""
import subprocess, sys, json, os
T, BJ, TY, OUT = sys.argv[1:5]; E = os.path.join(OUT, 'edit'); os.makedirs(E, exist_ok=True)
beats = json.load(open(BJ))
def run(*a): subprocess.run(a, check=True)
FIX = 'crop=1920:979:0:0,pad=1920:1080:0:50,fps=30,format=yuv420p'   # the headed recording pads the bottom 101 rows grey
LL = ['-c:v', 'libx264', '-qp', '0', '-preset', 'ultrafast']
b = beats
segs = [('s0', ('still', f'{TY}/card-open.png', 3.0)), ('s1', (b['lobby'] + 0.5, 5.0)), ('s2', (b['fight'] + 0.2, 6.7)), ('s3', (b['fury'] + 0.1, 6.8)),
        ('s4', (b['super'], 5.1)), ('s5', (b['kill'] + 0.1, 7.2)), ('s6', ('still', f'{TY}/card-end.png', 3.5))]
durs = []
for name, spec in segs:
    if spec[0] == 'still':
        run('ffmpeg', '-v', 'error', '-y', '-loop', '1', '-i', spec[1], '-t', str(spec[2]), '-vf', 'fps=30,format=yuv420p', *LL, f'{E}/{name}.mkv'); durs.append(spec[2])
    else:
        run('ffmpeg', '-v', 'error', '-y', '-ss', f'{spec[0]:.2f}', '-t', str(spec[1]), '-i', T, '-vf', FIX, *LL, f'{E}/{name}.mkv'); durs.append(spec[1])
D = 0.5; n = len(segs); fc = ''; ins = []
for i, (name, _) in enumerate(segs): ins += ['-i', f'{E}/{name}.mkv']; fc += f'[{i}:v]settb=AVTB,fps=30,format=yuv420p,setpts=PTS-STARTPTS[v{i}];'
prev = '[v0]'; acc = durs[0]; starts = [0.0]
for i in range(1, n):
    off = acc - D; starts.append(off); out = f'[x{i}]' if i < n - 1 else '[vout]'
    fc += f'{prev}[v{i}]xfade=transition=fade:duration={D}:offset={off:.3f}{out};'; prev = out; acc = off + durs[i]
run('ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fc.rstrip(';'), '-map', '[vout]', *LL, f'{E}/cut.mkv')
L = [(f'{TY}/lower-3.png', starts[2] + 0.8, 4.0), (f'{TY}/lower-1.png', starts[3] + 0.7, 4.0), (f'{TY}/lower-2.png', starts[4] + 0.5, 3.6), (f'{TY}/lower-4.png', starts[5] + 0.6, 4.0)]
ins = ['-i', f'{E}/cut.mkv']; fc = ''; chain = '[0:v]'
for i, (png, st, du) in enumerate(L):
    ins += ['-loop', '1', '-i', png]
    fc += f'[{i+1}:v]format=rgba,fade=t=in:st={st:.2f}:d=0.4:alpha=1,fade=t=out:st={st+du-0.4:.2f}:d=0.4:alpha=1[o{i}];'
    out = f'[c{i}]'; fc += f"{chain}[o{i}]overlay=0:0:eof_action=pass:enable='between(t,{st:.2f},{st+du:.2f})'{out};"; chain = out
fc += f'{chain}format=yuv420p[v]'
run('ffmpeg', '-v', 'error', '-y', *ins, '-filter_complex', fc, '-map', '[v]', '-shortest', *LL, f'{E}/EDIT.mkv')
PX = 'deblock=-2,-2:aq-mode=3:aq-strength=0.7:psy-rd=1.00,0.15:open-gop=0:colorprim=bt709:transfer=bt709:colormatrix=bt709'
base = ['ffmpeg', '-v', 'error', '-y', '-i', f'{E}/EDIT.mkv', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-shortest',
        '-vf', 'scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p', '-r', '30', '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-preset', 'slow']
tail = ['-x264-params', PX, '-g', '60', '-keyint_min', '30', '-color_range', 'tv', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart']
run(*base, '-crf', '16', *tail, f'{OUT}/HEARTROT_showcase_1080.mp4')
run(*base, '-crf', '20', '-maxrate', '5M', '-bufsize', '10M', *tail, f'{OUT}/HEARTROT_showcase_1080_small.mp4')
print('total', round(acc, 1), 's; masters in', OUT)
