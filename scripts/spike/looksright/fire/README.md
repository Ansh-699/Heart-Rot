# The fire loop (task: fireball shower, Sep 6 2026)

Throwaway harness scripts that judged `Arena.tsx`'s fire against the owner's reference
picture (a ChatGPT paint-over of a screenshot, kept out of the repo). All of them serve the
looksright dist and drive `window.__scene`; `PW_HOME` points at a playwright install.

    cd app && ./node_modules/.bin/vite build --config ../scripts/spike/looksright/vite.config.ts
    DIST=/tmp/looksright-dist OUT=out node shot.mjs              # stills: volley, slam04/09/14, slamhit, beamwarn, beamsweep
    python3 diff.py ref.png out/volley.png out/cmp.png           # the fire signature vs the reference, one score
    DIST=/tmp/looksright-dist node perf.mjs                      # frame cost per feature, CSS toggles
    DIST=/tmp/looksright-dist OUT=vid node video.mjs             # the wind-up in motion, cranked at 10 Hz
    DIST=/tmp/looksright-dist OUT=land node landing.mjs          # the site's landing clip, raw

`diff.py` scores hue/value/saturation histograms of the fire pixels, hot-core fraction,
warm-lit floor, blob elongation and coverage; 100 is the reference. The rework went 41 →
56–59 on the volley; coverage stays under the reference (its fire is 9 % of the frame,
which in a live scene would hide the raiders) and the rest converged.
