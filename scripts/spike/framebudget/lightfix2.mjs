// THROWAWAY. Renders candidate boss-lighting builds by injecting CSS + one extra SVG node
// into the live page. No product file is modified.
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.env.PW_HOME + '/x.cjs')('playwright');
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { QUIET_ARGS } from '../launch.mjs';
const DIR=path.resolve('dist'); const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
const srv=http.createServer((q,s)=>{const f=path.join(DIR,q.url==='/'?'index.html':q.url.split('?')[0]);
 if(!f.startsWith(DIR)||!fs.existsSync(f)){s.writeHead(404);return s.end();}
 s.writeHead(200,{'content-type':MIME[path.extname(f)]||'text/plain'});fs.createReadStream(f).pipe(s);});
await new Promise(r=>srv.listen(8766,r));

const TONE='grayscale(0.7) sepia(0.6) hue-rotate(195deg) saturate(0.5) brightness(0.55) contrast(1.6)';
const RIM=(a)=>`drop-shadow(-3px -3px 0 rgb(159 232 255 / ${a}))`;
const orb=(sw,so,bl)=>`
.hr-boss-vent{fill:#04121a!important;fill-opacity:1!important;
 stroke:#9fe8ff!important;stroke-opacity:${so}!important;stroke-width:calc(var(--core-r)*${sw})!important;
 opacity:1!important;filter:drop-shadow(0 0 ${bl[0]}px rgb(111 227 255/${bl[1]}))!important}`;
const V={
 g1:{css:`.hr-boss-grade{filter:${TONE} ${RIM(0.40)}!important}`+orb(0.15,0.85,[14,0.45]),spill:[0.30,0.10]},
 g2:{css:`.hr-boss-grade{filter:${TONE} ${RIM(0.40)}!important}`+orb(0.22,0.55,[12,0.40]),spill:[0.24,0.08]},
 g3:{css:`.hr-boss-grade{filter:${TONE} ${RIM(0.30)}!important}`+orb(0.15,0.75,[16,0.35]),spill:[0.20,0.07]},
 g4:{css:`.hr-boss-grade{filter:${TONE} ${RIM(0.40)}!important}`+orb(0.15,0.85,[14,0.45]),spill:[0.20,0.06]},
};
const OUT=process.env.OUTDIR||'fix2'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch({channel:'chrome',headless:false, args: [...QUIET_ARGS] });
for(const [name,v] of Object.entries(V)){
  const pg=await b.newPage({viewport:{width:1024,height:1024}});
  await pg.goto('http://127.0.0.1:8766/',{waitUntil:'load'});
  await pg.waitForFunction('window.__ready === true');
  await pg.evaluate(o=>window.__run(o),{layer:'full',knights:0,knightArt:false,bullets:0,frames:60,feedHz:0.0001});
  await pg.waitForTimeout(300);
  const geom=await pg.evaluate(([spill,SP0,SP1])=>{
    const vent=document.querySelector('.hr-boss-vent');
    const R=+vent.getAttribute('r'), cx=+vent.getAttribute('cx'), cy=+vent.getAttribute('cy');
    vent.style.setProperty('--core-r', R);
    if(spill){
      const ns='http://www.w3.org/2000/svg';
      const d=document.createElementNS(ns,'defs');
      d.innerHTML=`<radialGradient id="orbspill" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${R*2.6}">
        <stop offset="0" stop-color="#9fe8ff" stop-opacity="${SP0}"/>
        <stop offset="0.4" stop-color="#6fe3ff" stop-opacity="${SP1}"/>
        <stop offset="1" stop-color="#6fe3ff" stop-opacity="0"/></radialGradient>`;
      vent.parentNode.insertBefore(d,vent);
      const c=document.createElementNS(ns,'circle');
      c.setAttribute('cx',cx); c.setAttribute('cy',cy); c.setAttribute('r',R*2.6);
      c.setAttribute('fill','url(#orbspill)'); c.setAttribute('class','hr-boss-spill');
      vent.parentNode.insertBefore(c,vent);
    }
    return {R,cx,cy};
  }, [v.spill?1:0, v.spill?v.spill[0]:0, v.spill?v.spill[1]:0]);
  if(v.css) await pg.addStyleTag({content:v.css});
  await pg.waitForTimeout(250);
  await pg.screenshot({path:path.join(OUT,name+'.png')});
  console.log(name, JSON.stringify(geom));
  await pg.close();
}
await b.close(); srv.close();
