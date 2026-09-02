// Throwaway: does the DEPLOYED bundle boot? bundle.md notes #root stays empty until Privy's
// remote config resolves, so "the page paints" is the thing worth confirming after a deploy.
import { createRequire } from 'node:module';
import { QUIET_ARGS } from '../launch.mjs';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
const b = await chromium.launch({ channel: 'chrome', headless: true, args: [...QUIET_ARGS] });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = [];
pg.on('pageerror', (e) => errs.push(e.message));
await pg.goto('https://heartrot.ansht.workers.dev/', { waitUntil: 'networkidle', timeout: 45000 });
const out = await pg.evaluate(() => ({
  rootChildren: document.getElementById('root')?.childElementCount ?? -1,
  text: (document.body.innerText || '').slice(0, 160).replace(/\s+/g, ' '),
  svgs: document.querySelectorAll('svg').length,
}));
await pg.screenshot({ path: process.env.SHOT || 'live.png' });
console.log(JSON.stringify({ ...out, pageErrors: errs.slice(0, 5) }, null, 2));
await b.close();
