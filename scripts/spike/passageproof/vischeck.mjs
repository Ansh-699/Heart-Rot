import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/package.json')('playwright');
for (const flags of [true, false]) {
  const b = await chromium.launch({ channel: 'chrome', headless: false,
    // Position is off-screen in BOTH arms: this harness A/Bs the THROTTLE flags, and
    // putting the window on a working desktop is not part of that experiment.
    args: ['--window-position=-32000,-32000', ...(flags ? ['--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-features=CalculateNativeWinOcclusion'] : [])] });
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  await pg.goto('data:text/html,<body>a');
  await pg.evaluate(`window.__v=[document.visibilityState];document.addEventListener('visibilitychange',()=>window.__v.push(document.visibilityState));window.__f=0;(function l(){window.__f++;requestAnimationFrame(l);})();window.__t=performance.now()`);
  await pg.bringToFront();
  await pg.waitForTimeout(500);
  const f0 = await pg.evaluate('window.__f');
  const p2 = await ctx.newPage();
  await p2.goto('data:text/html,<body>b');
  await p2.bringToFront();
  await p2.waitForTimeout(1500);
  const mid = await pg.evaluate('({v:window.__v, f:window.__f})');
  await pg.bringToFront();
  await pg.waitForTimeout(200);
  console.log('flags', flags, JSON.stringify({ visLog: mid.v, framesWhileOther: mid.f - f0, after: await pg.evaluate('window.__v') }));
  await b.close();
}
