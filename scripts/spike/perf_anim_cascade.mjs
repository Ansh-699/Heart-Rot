import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
/** Generated pages live outside the repo; only the harness is committed. */
const DIR = join(tmpdir(), 'heartrot-anim');


const PORT=9336;
const c=spawn('/usr/bin/google-chrome',['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${DIR}/prof3`,'--no-first-run','about:blank'],{stdio:'ignore'});
let v; for(let i=0;i<60;i++){try{v=await(await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();break}catch{await sleep(250)}}
const t=await(await fetch(`http://127.0.0.1:${PORT}/json/new?file:///home/anshtyagi/Documents/pixel-artgame/scripts/spike/perf_anim_cascade.html`,{method:'PUT'})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl); let id=0; const w=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data); const q=w.get(m.id); if(q){w.delete(m.id);q(m.result)}});
await new Promise(r=>ws.addEventListener('open',r));
const send=(method,params={})=>new Promise(r=>{const n=++id;w.set(n,r);ws.send(JSON.stringify({id:n,method,params}))});
for(let i=0;i<40;i++){await sleep(250);
  const r=await send('Runtime.evaluate',{expression:'JSON.stringify(window.__result||null)',returnByValue:true});
  if(r.result.value&&r.result.value!=='null'){console.log(JSON.parse(r.result.value).join('\n'));break}}
c.kill();
