import { createRequire } from 'node:module';
import { QUIET_ARGS } from '../launch.mjs';
const { chromium } = createRequire(process.env.PW_HOME + '/package.json')('playwright');
const b = await chromium.launch({ channel: 'chrome', headless: false, args: [...QUIET_ARGS] });
const pg = await b.newPage();
await pg.goto('data:text/html,<body>a');
await pg.evaluate(`window.__v=[document.visibilityState];document.addEventListener('visibilitychange',()=>window.__v.push(document.visibilityState+'@'+Math.round(performance.now())));window.__f=0;(function l(){window.__f++;requestAnimationFrame(l);})()`);
const cdp = await pg.context().newCDPSession(pg);
try {
  await cdp.send('Emulation.setPageVisibilityOverride', { visible: false });
  await pg.waitForTimeout(300);
  console.log('override ok', await pg.evaluate('window.__v'));
  await cdp.send('Emulation.setPageVisibilityOverride', { visible: true });
} catch (e) { console.log('override unsupported:', String(e).split('\n')[0]); }
const f0 = await pg.evaluate('window.__f');
const { windowId } = await cdp.send('Browser.getWindowForTarget');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
await pg.waitForTimeout(1500);
const mid = await pg.evaluate('({v:window.__v,f:window.__f})');
await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
await pg.waitForTimeout(300);
console.log('minimize:', JSON.stringify({ visLog: mid.v, framesWhileMin: mid.f - f0, after: await pg.evaluate('window.__v') }));
await b.close();
