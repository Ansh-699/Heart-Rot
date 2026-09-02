// Throwaway: load the app in DEV so every module's `import.meta.env.DEV` self-check runs.
// Production builds strip them, so this is the only pass that executes the watchdogs in
// Knight.tsx, predict.ts, Arena.tsx, Scene.tsx and Boss.tsx.
import { createRequire } from 'node:module';
import { QUIET_ARGS } from '../launch.mjs';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
const b = await chromium.launch({ channel: 'chrome', headless: true, args: [...QUIET_ARGS] });
const pg = await b.newPage({ viewport: { width: 1200, height: 900 } });
const errs = [], warns = [];
pg.on('pageerror', (e) => errs.push(String(e.message)));
pg.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warns.push(`${m.type()}: ${m.text()}`); });
await pg.goto('http://localhost:5211/', { waitUntil: 'load', timeout: 45000 });
await new Promise((r) => setTimeout(r, 6000));
const mods = await pg.evaluate(() => document.querySelectorAll('script[type=module]').length);
console.log(JSON.stringify({

  scripts: mods,
  pageErrors: errs,
  consoleErrors: warns.filter((w) => !/favicon|privy|Failed to load resource|net::/i.test(w)).slice(0, 15),
}, null, 2));
await b.close();
