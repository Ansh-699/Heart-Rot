/**
 * The ONE place a spike harness launches a browser.
 *
 * Two rules, and the second is why this file exists rather than a flag copied into
 * twenty scripts:
 *
 * 1. NEVER PUT A WINDOW ON THE USER'S DESKTOP. These harnesses run on a live machine
 *    somebody is working on. `headless: false` with no position throws a window over
 *    whatever they are doing, and one harness pinned it to 0,0.
 *
 * 2. OFF-SCREEN IS NOT FREE. Chrome throttles requestAnimationFrame to 50-190 ms per
 *    frame for a window it believes is occluded, backgrounded or minimised. A per-frame
 *    measurement then silently becomes a coarse one — it does not error, it just stops
 *    being able to see the defect it was written to catch. The passage-proof harness hit
 *    exactly this: without these flags its per-frame sampler would have missed a
 *    ~150 ms window entirely and reported a false all-clear.
 *
 * So: place the window far off-screen AND disable every occlusion/backgrounding
 * heuristic. Minimising instead of positioning re-introduces rule 2 and is not allowed.
 */
export const QUIET_ARGS = [
  // Off the visible desktop, not minimised.
  '--window-position=-32000,-32000',
  // The three that keep rAF at full rate once nobody can see the window.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  // A background window must never steal focus back.
  '--no-first-run',
  '--no-default-browser-check',
];

/**
 * Launch Chrome for a harness. `headless` defaults to true — pass `false` ONLY when the
 * measurement genuinely needs real compositing and raster, and it still will not appear
 * on screen.
 */
export async function launchQuiet(chromium, { headless = true, args = [], ...rest } = {}) {
  return chromium.launch({
    channel: 'chrome',
    headless,
    args: [...QUIET_ARGS, ...args],
    ...rest,
  });
}
