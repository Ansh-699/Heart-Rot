// THROWAWAY. Screenshots the shipped Arena with CSS overrides injected at runtime so the
// boss grade can be measured against the real cavern it is composited over. No product
// file is modified: every variant is a <style> appended to the live document.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const DIR = path.resolve('dist');
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
const srv = http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8762,r));

const GRADE = 'grayscale(0.7) sepia(0.6) hue-rotate(185deg) saturate(1.6) brightness(0.32) drop-shadow(-2px -2px 0 rgb(159 232 255 / 0.25))';
const VARIANTS = {
  shipped:   '',
  noboss:    '.hr-boss{visibility:hidden}',
  ungraded:  '.hr-boss-grade{filter:none!important}',
  rimonly:   `.hr-boss-grade{filter:drop-shadow(-2px -2px 0 rgb(159 232 255 / 0.25))!important}`,
  gradeonly: `.hr-boss-grade{filter:grayscale(0.7) sepia(0.6) hue-rotate(185deg) saturate(1.6) brightness(0.32)!important}`,
  perpart:   `.hr-boss-grade{filter:none!important}.hr-boss-part{filter:${GRADE}}`,
};
const OUTDIR = process.env.OUTDIR || 'light';
fs.mkdirSync(OUTDIR, { recursive: true });

const b = await chromium.launch({ channel:'chrome', headless:false });
for (const [name, css] of Object.entries(VARIANTS)) {
  const pg = await b.newPage({ viewport:{width:1024,height:1024} });
  await pg.goto('http://127.0.0.1:8762/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  if (css) await pg.addStyleTag({ content: css });
  // bullets:0, knights:0 -> nothing but the scene and the boss in the frame, so a diff
  // against `noboss` is the boss silhouette and nothing else. tick is frozen by not
  // starting the feed: __run drives it, so run a short one and shoot after it settles.
  await pg.evaluate(o=>window.__run(o), { layer:'full', knights:0, knightArt:false, bullets:0, frames:60, feedHz:0.0001 });
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: path.join(OUTDIR, name + '.png') });
  // Also record what the browser resolved, so the doc quotes the live value not the source.
  const info = await pg.evaluate(() => {
    const g = document.querySelector('.hr-boss-grade');
    const v = document.querySelector('.hr-boss-vent');
    const svg = document.querySelector('.stage svg') || document.querySelector('svg');
    const r = svg?.getBoundingClientRect();
    return {
      gradeFilter: g ? getComputedStyle(g).filter : null,
      ventOpacity: v ? getComputedStyle(v).opacity : null,
      ventFill: v ? getComputedStyle(v).fill : null,
      ventBBox: v ? (v).getBoundingClientRect() : null,
      svgRect: r ? { w: r.width, h: r.height } : null,
      bossParts: document.querySelectorAll('.hr-boss-part').length,
      paintedNodes: document.querySelectorAll('.hr-boss-grade *').length,
    };
  });
  console.log(name, JSON.stringify(info));
  await pg.close();
}
await b.close(); srv.close();
