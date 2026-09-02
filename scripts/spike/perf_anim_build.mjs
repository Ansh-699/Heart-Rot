// Build one self-measuring HTML page per condition, from the REAL repo SVGs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Generated pages live outside the repo; only the harness is committed. */
const DIR = join(tmpdir(), 'heartrot-anim');


const A = new URL('../../assets/sprites/', import.meta.url).pathname;

const OUT = DIR;
mkdirSync(OUT, { recursive: true });

const read = (f) => readFileSync(`${A}/${f}`, 'utf8');
// strip the <svg> wrapper, keep the guts, so it can be pasted into the scene svg
const guts = (s) => s.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const vb = (s) => /viewBox="([^"]*)"/.exec(s)[1].split(/\s+/).map(Number);

const temple = read('temple.svg');
const bossParts = read('parts/boss.svg');
const knights = read('knights.svg');

const [, , tw, th] = vb(temple);
const [, , bw, bh] = vb(bossParts);

const ARENA = 1024;
const BULLETS = 128;
const SEATS = 20;

// One knight out of the three: paths are shared per-colour across all three knights in
// knights.svg, so a single knight cannot be extracted by node. Clip to the left third
// instead, which is what a real seat sprite would do (viewBox on a nested <svg>).
const knightSprite = `<svg viewBox="0 0 72 140" width="40" height="78" x="-20" y="-60" overflow="hidden">${guts(knights)}</svg>`;

function page(cond) {
  const bgInline = `<g id="bg">${guts(temple)}</g>`;
  const bgImage = `<image href="data:image/svg+xml;base64,${Buffer.from(temple).toString('base64')}" x="0" y="0" width="${ARENA}" height="${ARENA}" />`;

  const bg =
    cond === 'bg-image' || cond === 'bg-image-parts'
      ? bgImage
      : cond === 'no-bg'
        ? ''
        : bgInline;

  const bullets = Array.from(
    { length: BULLETS },
    (_, i) => `<rect class="b" x="-4" y="-4" width="8" height="8" fill="#ffb020" style="will-change:transform"/>`,
  ).join('');

  // `seats-use*` reproduce docs/art/knights.md's structure exactly: the knight geometry
  // lives once in <defs> and each seat holds a <use> of it. Everything else inlines a
  // clipped copy per seat, which is the pessimistic bound.
  const useShape = cond.startsWith('seats-use');
  const seatStyle = cond === 'seats-nowc' || cond === 'seats-use-nowc' ? '' : ' style="will-change:transform"';
  const defs = useShape
    ? `<defs><g id="knight">${guts(knights)}</g></defs>`
    : '';
  const inner = useShape
    ? `<svg viewBox="0 0 72 140" width="40" height="78" x="-20" y="-60" overflow="hidden"><use href="#knight"/></svg>`
    : knightSprite;
  const seats = defs + Array.from(
    { length: SEATS },
    () => `<g class="s"${seatStyle}>${inner}</g>`,
  ).join('');

  const bossScale = 1; // sprite pixel == arena unit, per hitboxes.ts
  const boss = `<g id="boss" transform="translate(${512 - bw / 2} ${160})"><g id="bossinner">${guts(bossParts)}</g></g>`;

  const smil = cond.startsWith('smil')
    ? `<script>
        for (const g of document.querySelectorAll('#bossinner > g')) {
          const a = document.createElementNS('http://www.w3.org/2000/svg','animateTransform');
          a.setAttribute('attributeName','transform'); a.setAttribute('type','translate');
          a.setAttribute('values','0 0; 0 -6; 0 0'); a.setAttribute('dur','2.6s');
          a.setAttribute('repeatCount','indefinite'); a.setAttribute('additive','sum');
          g.appendChild(a);
        }
      <\/script>`
    : '';

  const css = cond === 'css'
    ? `<style>#bossinner > g { animation: breathe 2.6s ease-in-out infinite; transform-box: fill-box; }
       @keyframes breathe { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-6px) } }</style>`
    : '';

  const animParts = cond.startsWith('raf-parts') || cond === 'bg-image-parts' || cond === 'layout-probe';
  const wc = cond.endsWith('-wc');
  const probe = cond === 'layout-probe';

  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#0b0a0e;overflow:hidden}svg{display:block;width:1024px;height:1024px}</style>
${css}
<svg viewBox="0 0 ${ARENA} ${ARENA}" shape-rendering="crispEdges">
  <g transform="scale(${ARENA / tw})">${bg}</g>
  ${boss}
  <g id="seats">${seats}</g>
  <g id="bullets">${bullets}</g>
</svg>
${smil}
<script>
const bl = [...document.querySelectorAll('.b')];
const st = [...document.querySelectorAll('.s')];
const parts = [...document.querySelectorAll('#bossinner > g')];
const ANIM_PARTS = ${animParts};
const PROBE = ${probe};
if (${wc}) for (const p of parts) p.style.willChange = 'transform';
let ptop = [];
const gaps = [];
let last = 0, frames = 0, t0 = 0;
function frame(now){
  if (t0 === 0) { t0 = now; last = now; requestAnimationFrame(frame); return; }
  gaps.push(now - last); last = now; frames++;
  // bullet layer: the rAF loop Arena.tsx already owns
  for (let i=0;i<bl.length;i++){
    const a = (now/1000 + i)%1;
    bl[i].style.transform = 'translate(' + (100+a*800) + 'px,' + (900-a*800) + 'px)';
  }
  // seats: 1 predicted + 19 interpolated, all imperative transforms
  for (let i=0;i<st.length;i++){
    const a = (now/2000 + i/st.length)%1;
    st[i].style.transform = 'translate(' + (120+a*780) + 'px,' + (600+Math.sin(a*6.28)*120) + 'px)';
  }
  if (ANIM_PARTS) {
    for (let i=0;i<parts.length;i++){
      const a = Math.sin(now/700 + i);
      parts[i].style.transform = 'translate(0px,' + (a*6) + 'px)';
    }
  }
  if (PROBE && parts[0]) ptop.push(parts[0].getBoundingClientRect().top);
  if (now - t0 < ${'DURATION'}) requestAnimationFrame(frame);
  else finish();
}
function finish(){
  gaps.sort((a,b)=>a-b);
  const q = (p) => gaps[Math.min(gaps.length-1, Math.floor(gaps.length*p))];
  window.__result = { cond: ${JSON.stringify(cond)}, frames, ms: last - t0, boot: +t0.toFixed(0),
    fps: +(frames/((last-t0)/1000)).toFixed(1),
    p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +gaps[gaps.length-1].toFixed(2),
    over20ms: gaps.filter(g=>g>20).length,
    nodes: document.getElementsByTagName('*').length,
    partMoved: ptop.length ? +(Math.max(...ptop) - Math.min(...ptop)).toFixed(2) : -1 };
  document.title = 'DONE';
}
requestAnimationFrame(frame);
<\/script>`;
}

const CONDS = ['no-bg', 'bg-inline', 'bg-image', 'raf-parts', 'raf-parts-wc', 'bg-image-parts', 'css', 'smil', 'smil-wc', 'layout-probe', 'seats-nowc', 'seats-use', 'seats-use-nowc'];
for (const c of CONDS) writeFileSync(`${OUT}/${c}.html`, page(c).replaceAll('DURATION', '5000'));
console.log(CONDS.join(' '));
