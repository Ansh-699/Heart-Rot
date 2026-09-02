/**
 * THROWAWAY frame-budget harness. Mounts the REAL `app/src/render/Arena` — the shipped
 * temple layer, the shipped S=3 boss rig, the shipped Knight/Spawn/telegraph code — and
 * drives it from a synthetic feed that has the same shape as the live one (a new account
 * object per notification, the crank's 100 ms cadence, every notification delivered twice).
 *
 * Nothing in `app/` or `packages/` is modified. This file only imports them.
 *
 * `window.__run(opts)` returns the frame statistics. Frame cost is measured the way
 * docs/perf/render-scale.md measured it: `performance.now()` at rAF entry to
 * `performance.now()` inside a MessageChannel task, which runs after the frame commits, so
 * the number includes style, layout and paint commit. rAF delta is recorded too but is
 * bimodal on this box (Chrome flips 144/60 Hz vsync) and is not the headline.
 */
import { StrictMode as _Strict } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  BULLET_ACTIVE,
  MAP_TILE,
  MAX_BULLETS,
  MAX_SEATS,
  NO_TARGET,
  PHASE_FIGHTING,
  PIT_BOT,
  PIT_TOP,
  TICK_MS,
  ZONE_ARENA,
  type ArenaAccount,
  type BossAccount,
  type Bullet,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

import { Arena } from '../../../app/src/render/Arena';
import { ArenaFixed } from './ArenaFixed';
import { Boss } from '../../../app/src/render/Boss';
import { SCENE } from '../../../app/src/render/Scene';
import { createPredictor } from '../../../app/src/net/predict';
import '../../../app/src/styles.css';

void _Strict;

// ---------------------------------------------------------------------------
// Synthetic chain state — the same fields the decoder produces
// ---------------------------------------------------------------------------

const SEED = new Uint8Array(32);
SEED[0] = 0x5a;
SEED[3] = 0xc3;
SEED[7] = 0x11;

const PARTS_MAX = [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500];

function bullet(i: number, tick: number, active: boolean): Bullet {
  // 42 units/tick (BULLET_UNITS_PER_SEC 420) fanning out of the boss, wrapped into the
  // pit so the pool stays full for the whole run: 128 active is the worst case.
  const a = (i * 2.399963) % (Math.PI * 2);
  const life = (tick * 42 + i * 17) % 700;
  return {
    x: Math.round(587 + Math.cos(a) * life * 0.4),
    y: Math.round(346 + Math.abs(Math.sin(a)) * life * 0.35),
    dx: Math.round(Math.cos(a) * 42),
    dy: Math.round(Math.abs(Math.sin(a)) * 42),
    active: active ? BULLET_ACTIVE : 0,
  };
}

function slot(seat: number, tick: number, occupied: boolean): PlayerSlot {
  // A snake through the pit: every seat steps one whole MAP_TILE per 50 ms, which is the
  // chain's real cadence, so the walk accumulator in Knight.tsx advances exactly as it
  // does in a fight.
  const lane = seat % 10;
  const row = Math.floor(seat / 10);
  const phase = (tick * 2 + seat * 7) % 24;
  const zig = phase < 12 ? phase : 24 - phase;
  const x = 180 + lane * 66 + zig * MAP_TILE;
  const y = PIT_TOP + 40 + row * 90 + ((seat * 13) % 5) * MAP_TILE;
  return {
    seat,
    occupied,
    zone: ZONE_ARENA,
    facing: (seat + (phase < 12 ? 2 : 6)) % 8,
    skinId: seat % 3,
    x: Math.min(1000, x),
    y: Math.min(PIT_BOT - 8, y),
    // One seat in five is damaged so the HP bar path renders, one in ten is dead so the
    // respawn arc renders. Both are real DOM in a real fight.
    hp: seat % 10 === 3 ? 0 : seat % 5 === 1 ? 55 : 100,
    hpMax: 100,
    lastMoveSeq: tick & 0xffff,
    deaths: seat % 10 === 3 ? 1 : 0,
    respawnAtTick: seat % 10 === 3 ? tick + 20 : 0,
    lastShotTick: tick - (seat % 8),
    lastMoveTick: tick,
    damageDealt: seat * 137,
    sessionPubkey: new Uint8Array(32).fill(occupied ? seat + 1 : 0),
    identity: new Uint8Array(32).fill(seat + 1),
  };
}

function makeArena(tick: number, bullets: number): ArenaAccount {
  const b: Bullet[] = [];
  for (let i = 0; i < MAX_BULLETS; i++) b.push(bullet(i, tick, i < bullets));
  return {
    bump: 0,
    phase: PHASE_FIGHTING,
    outcome: 0,
    aliveCount: 20,
    bulletCursor: tick % MAX_BULLETS,
    arenaId: 1n,
    crankTaskId: 1n,
    tick,
    enrageAtTick: tick + 3000,
    seatOccupied: 0xfffff,
    incarnation: 1,
    crankAuthority: new Uint8Array(32),
    validatorIdentity: new Uint8Array(32),
    affixSeed: SEED,
    bullets: b,
    rollRequestedTick: 0,
    fightAtTick: 0,
    nextAffixSeed: new Uint8Array(32),
  };
}

function makeBoss(tick: number): BossAccount {
  // The shell takes damage across the run so the per-part damage flinch and the
  // destruction one-shots actually fire, and the vent opens partway through.
  const wear = Math.min(1, tick / 900);
  const parts = PARTS_MAX.map((m, i) => {
    const k = Math.max(0, 1 - wear * (1 + (i % 3) * 0.45));
    return Math.round(m * k);
  });
  const live = parts.reduce((a, v) => a + v, 0);
  const max = PARTS_MAX.reduce((a, v) => a + v, 0);
  const ventOpen = live * 100 < max * 35 ? 1 : 0;
  return {
    bump: 0,
    ventOpen,
    // Counts down to a volley; inside SLAM_TELEGRAPH_TICKS the aim lines are drawn.
    attackTimer: 32 - (tick % 33),
    targetSeat: tick % 3 === 0 ? NO_TARGET : (tick >> 2) % MAX_SEATS,
    x: 512,
    y: 400,
    coreHp: ventOpen ? Math.max(0, 2000 - (tick - 700) * 2) : 2000,
    coreHpMax: 2000,
    parts,
    partsMax: PARTS_MAX,
  };
}

function makePlayers(tick: number, knights: number): PlayersAccount {
  const slots: PlayerSlot[] = [];
  for (let s = 0; s < MAX_SEATS; s++) slots.push(slot(s, tick, s < knights));
  return { bump: 0, slots };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Opts = {
  knights: number;
  bullets: number;
  frames: number;
  /** Notifications per second pushed into React. 20 = the crank's 10 Hz, delivered twice. */
  feedHz: number;
  /**
   * `full` is the shipped `<Arena>`. `temple` and `boss` mount ONE real layer alone in a
   * bare svg, which is the only way to attribute the fixed cost without editing product
   * code: neither layer can be switched off from Arena's props.
   */
  layer: 'full' | 'temple' | 'boss';
  /** Swap in `ArenaFixed`: the shipped file with the 128 bullet ref closures hoisted. */
  fixedRefs: boolean;
  /**
   * Inject the knight `<defs>` that `tools/gen_knights.py` is SPECIFIED to emit but has
   * not been written yet. Without this the shipped `<use href="#k0-rest">` resolves to
   * nothing and twenty knights draw twenty shadows — see `knightdefs.py`.
   */
  knightArt: boolean;
};

const DEFAULTS: Opts = { knights: 20, bullets: 128, frames: 400, feedHz: 20, layer: 'full', knightArt: false, fixedRefs: false };

import DEFS from './defs.json';

let defsNode: SVGSVGElement | null = null;
function setKnightArt(on: boolean): void {
  if (on === (defsNode !== null)) return;
  if (!on) {
    defsNode?.remove();
    defsNode = null;
    return;
  }
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('width', '0');
  el.setAttribute('height', '0');
  el.setAttribute('aria-hidden', 'true');
  el.style.position = 'absolute';
  el.innerHTML = `<defs>${(DEFS as { defs: string }).defs}</defs>`;
  document.body.appendChild(el);
  defsNode = el;
}

const root = createRoot(document.getElementById('root')!);
const predictor = createPredictor();

let opts: Opts = DEFAULTS;
let tick = 0;
let running = false;
/** Payloads actually pushed into React during the measured window. */
let updates = 0;

/** One render pass, driven exactly as `App.tsx` drives it: fresh account objects. */
let cur = { a: makeArena(0, 128), b: makeBoss(0), p: makePlayers(0, 20) };

/**
 * `subscribe.ts` decodes ONE account kind per message and `store.setWorld` is called with
 * that one; `World` then re-renders and hands `<Arena>` two unchanged references and one
 * fresh object. A harness that rebuilds all three per notification measures up to 3x the
 * React work the game does, so `kind` rotates on the measured mix at 20 seats.
 */
function paint(kind?: 'arena' | 'boss' | 'players'): void {
  if (kind === undefined || kind === 'arena') cur = { ...cur, a: makeArena(tick, opts.bullets) };
  if (kind === undefined || kind === 'boss') cur = { ...cur, b: makeBoss(tick) };
  if (kind === undefined || kind === 'players') cur = { ...cur, p: makePlayers(tick, opts.knights) };
  const a = cur.a;
  const b = cur.b;
  const p = cur.p;
  if (opts.layer !== 'full') {
    root.render(
      <svg viewBox={`0 0 ${1024} ${1024}`} width={1024} height={1024} style={{ display: 'block' }}>
        {opts.layer === 'temple' ? SCENE : <Boss boss={b} arena={a} />}
      </svg>,
    );
    return;
  }
  const A = opts.fixedRefs ? ArenaFixed : Arena;
  root.render(
    <A
      arena={a}
      boss={b}
      players={p}
      localSeat={0}
      predictor={predictor}
      tickMs={TICK_MS}
      className="hr-arena-box"
    />,
  );
  predictor.reconcile(p.slots[0]!);
}

function startFeed(): void {
  stopFeed();
  // NOT setInterval. Nested setInterval clamps to 4 ms in Chrome, so a 714 Hz request
  // delivered 244 Hz on this box and 50 Hz under a 6x throttle — the measurement would
  // have been of the timer, not the renderer. A MessageChannel pump is an unclamped
  // macrotask per message, and one macrotask per notification is exactly the shape a
  // WebSocket delivers: React cannot batch two of them into one render.
  const ch = new MessageChannel();
  const period = 1000 / opts.feedHz;
  let next = performance.now();
  let dup = false;
  running = true;
  ch.port1.onmessage = () => {
    if (!running) return;
    const now = performance.now();
    if (now >= next) {
      next = Math.max(now - period, next + period);
      if (!dup) tick++;
      dup = !dup;
      updates++;
      // 50 / 45 / 5, the measured shape of the 714 notifications/s at 20 seats.
      const r = updates % 20;
      paint(r < 10 ? 'arena' : r < 19 ? 'players' : 'boss');
      // The local seat moves at the ER's 50 ms slot, not the crank's 100 ms.
      predictor.push((tick + (dup ? 0 : 4)) % 8);
    }
    ch.port2.postMessage(0);
  };
  ch.port2.postMessage(0);
}

function stopFeed(): void {
  running = false;
}

declare global {
  interface Window {
    __ready: boolean;
    __run: (o: Partial<Opts>) => Promise<unknown>;
  }
}

window.__run = async (o) => {
  opts = { ...DEFAULTS, ...o };
  setKnightArt(opts.knightArt);
  tick = 0;
  stopFeed();

  const t0 = performance.now();
  flushSync(() => paint());
  const build = performance.now() - t0;

  // First paint: the frame that actually reaches the screen after the mount.
  const firstPaint = await new Promise<number>((res) => {
    const s = performance.now();
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => res(performance.now() - s);
      ch.port2.postMessage(0);
    });
  });

  startFeed();
  // Warm up: 40 frames discarded, exactly as render-scale did.
  await new Promise<void>((res) => {
    let n = 0;
    const w = (): void => {
      if (++n >= 40) return res();
      requestAnimationFrame(w);
    };
    requestAnimationFrame(w);
  });

  updates = 0;
  const wall0 = performance.now();
  const commit: number[] = [];
  const raf: number[] = [];
  await new Promise<void>((res) => {
    let prev = 0;
    const loop = (t: number): void => {
      if (prev !== 0) raf.push(t - prev);
      prev = t;
      const s = performance.now();
      const ch = new MessageChannel();
      ch.port1.onmessage = (): void => {
        commit.push(performance.now() - s);
        if (commit.length >= opts.frames) res();
        else requestAnimationFrame(loop);
      };
      ch.port2.postMessage(0);
    };
    requestAnimationFrame(loop);
  });
  const wallMs = performance.now() - wall0;
  stopFeed();

  const q = (xs: number[], p: number): number => {
    const s = [...xs].sort((a, b) => a - b);
    return +(s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0).toFixed(2);
  };
  const over = commit.filter((v) => v > 16.7).length;
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return {
    knights: opts.knights,
    bullets: opts.bullets,
    feedHz: opts.feedHz,
    commitP50: q(commit, 0.5),
    commitP95: q(commit, 0.95),
    commitMax: +Math.max(...commit).toFixed(2),
    rafP50: q(raf, 0.5),
    rafP95: q(raf, 0.95),
    overCount: over,
    overPct: +((100 * over) / commit.length).toFixed(1),
    frames: commit.length,
    wallMs: +wallMs.toFixed(0),
    // Vsync-independent: what fraction of wall-clock the main thread spent producing
    // frames. p50 per frame is bimodal here because the display flips 144/60 Hz and a
    // 20 Hz feed dirties one frame in seven at 144 and one in three at 60.
    busyPct: +((100 * commit.reduce((a, v) => a + v, 0)) / wallMs).toFixed(1),
    fps: +((1000 * commit.length) / wallMs).toFixed(1),
    feedActualHz: +((1000 * updates) / wallMs).toFixed(0),
    buildMs: +build.toFixed(1),
    firstPaintMs: +firstPaint.toFixed(1),
    nodes: document.getElementsByTagName('*').length,
    svgNodes: document.querySelectorAll('svg *').length,
    knightArt: opts.knightArt,
    layer: opts.layer,
    fixedRefs: opts.fixedRefs,
    jsHeapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
};

// Mount once so the page is interactive before the driver throttles the CPU.
paint();
window.__ready = true;
