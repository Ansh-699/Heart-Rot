import { createRequire } from 'node:module';
import { QUIET_ARGS } from '../launch.mjs';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
const b=await chromium.launch({channel:'chrome',headless:false, args: [...QUIET_ARGS] });
const pg=await b.newPage();
await pg.setContent(`<style>.p{filter:drop-shadow(-3px -3px 0 red)}
.p.dead{opacity:.34;filter:grayscale(1) brightness(.45)}</style>
<svg width="100" height="100"><g class="p" id="a"><rect width="40" height="40" fill="#888"/></g></svg>`);
const r=await pg.evaluate(async()=>{
  const el=document.getElementById('a');
  const before=getComputedStyle(el).filter;
  const an=el.animate([{filter:'none'},{filter:'brightness(2.2)'},{filter:'none'}],{duration:2000});
  await new Promise(r=>setTimeout(r,300));
  const during=getComputedStyle(el).filter;
  an.cancel();
  el.classList.add('dead');
  const dead=getComputedStyle(el).filter;
  return {before,during,dead};
});
console.log(JSON.stringify(r,null,1));
await b.close();
