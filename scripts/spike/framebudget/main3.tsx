/**
 * THROWAWAY frame-budget harness, spec-17 edition. Mounts the REAL shipped composition —
 * `App.tsx`'s 48 px header, its `.stage` with the `::after` vignette, and `<Passage>`
 * (which IS `<Arena>` wrapped in the gate beat) — against a synthetic feed with the same
 * shape as the live one. No product file is modified; this file only imports them.
 *
 * What changed since docs/perf/frame-budget.md (commit 6fc72d5):
 *  - the camera is gone, the room fills the stage, so the raster area is the WINDOW, not
 *    a 1024x1024 square. Stage size is the driver's viewport minus the 48 px header.
 *  - `tools/gen_knights.py` has landed, so `knights.gen.ts` is real: the `knightArt`
 *    injection is deleted rather than fixed (injecting it now duplicates every id).
 *  - two rooms. `room: 'lobby'` mounts WAITING, `'arena'` mounts BOSS_ARENA, `'passage'`
 *    flips the local seat's zone on a cycle so the gate beat runs inside the window.
 *  - arrows. The local seat fires through `fireLocal` at its class cadence; every remote
 *    seat's `lastShotTick` advances so `Shot`'s value-diff spawns its arrow from account
 *    bytes, exactly as the wire drives it.
 *
 * Metric is unchanged and therefore comparable: `performance.now()` at rAF entry to
 * `performance.now()` in a MessageChannel task that runs after the frame commits.
 */
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  BULLET_ACTIVE,
  CLASS_ARCHER,
  CLASS_KNIGHT,
  CLASS_MASK,
  LOBBY_BOT,
  LOBBY_TOP,
  MAP_TILE,
  MAP_TILES,
  MAX_BULLETS,
  MAX_SEATS,
  NO_TARGET,
  PHASE_FIGHTING,
  PHASE_MUSTERING,
  PIT_BOT,
  PIT_TOP,
  TICK_MS,
  ZONE_ARENA,
  ZONE_LOBBY,
  isWallTile,
  type ArenaAccount,
  type BossAccount,
  type Bullet,
  type PlayerSlot,
  type PlayersAccount,
} from '@heartrot/client';

import { Passage } from '../../../app/src/render/Passage';
import { Arena } from '../../../app/src/render/Arena';
import { WAITING } from '../../../app/src/render/WaitingRoom';
import { BOSS_ARENA } from '../../../app/src/render/BossArena';
import { Boss } from '../../../app/src/render/Boss';
import { fireLocal } from '../../../app/src/render/Shot';
import { createPredictor } from '../../../app/src/net/predict';
import { Hud } from '../../../app/src/ui/Hud';
import DevPanel from '../../../app/src/ui/DevPanel';
import {
  StoreProvider,
  setAuthSource,
  useSelect,
  useStore,
  type MatchInfo,
  type Store,
} from '../../../app/src/state/store';
import '../../../app/src/styles.css';

// ---------------------------------------------------------------------------
// The shipped chrome. `App.tsx:164` mounts `<Hud />` and `:172` mounts `<DevPanel />`
// alongside the stage, both fed by the same store every notification lands in — the one
// thing docs/perf/frame-budget-17.md §7 named as its own largest hole. They are
// `position: fixed`, so mounting them inside this root paints them where App does.
// ---------------------------------------------------------------------------

const FAKE_MATCH: MatchInfo = {
  seat: 0,
  arenaId: '1',
  incarnation: 1,
  arenaPda: 'Arena11111111111111111111111111111111111111',
  bossPda: 'Boss111111111111111111111111111111111111111',
  playersPda: 'Play111111111111111111111111111111111111111',
  programId: 'Prog111111111111111111111111111111111111111',
  erEndpoint: 'https://devnet.magicblock.app',
  routerEndpoint: 'https://devnet-router.magicblock.app',
  validatorIdentity: 'Vali111111111111111111111111111111111111111',
  tickMs: TICK_MS,
};

/** `/api/session/init` and `/api/faucet/status` answered locally: no Worker, real store. */
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.includes('/api/session/init')) {
    return Promise.resolve(new Response(JSON.stringify(FAKE_MATCH), { status: 200 }));
  }
  if (url.includes('/api/faucet/status')) {
    return Promise.resolve(
      new Response(JSON.stringify({ treasuryLamports: '2500000000', estimatedMatches: 100 }), {
        status: 200,
      }),
    );
  }
  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;
setAuthSource(() => Promise.resolve('harness-token'));

let store: Store | null = null;
let storeReady: (() => void) | null = null;

function Grab() {
  const s = useStore();
  useEffect(() => {
    store = s;
    storeReady?.();
    storeReady = null;
  }, [s]);
  return null;
}

/** `full` = the shipped composition. The rest mount one layer alone for attribution. */
type Layer = 'full' | 'waiting' | 'bossarena' | 'boss' | 'noveil';

/**
 * `App.tsx`'s `World`, minus the portal and the transaction wiring: the component that
 * subscribes to all three accounts and is therefore the only part of the tree React
 * rebuilds on every notification. Same five selectors, same props into `Passage`.
 */
function World({ layer }: { layer: Layer }) {
  const arena = useSelect((s) => s.arena);
  const boss = useSelect((s) => s.boss);
  const players = useSelect((s) => s.players);
  const seat = useSelect((s) => s.match?.seat ?? -1);
  const tickMs = useSelect((s) => s.match?.tickMs ?? TICK_MS);
  if (arena === null || boss === null || players === null) return null;

  if (layer !== 'full' && layer !== 'noveil') {
    return (
      <svg viewBox="0 -48 1024 656" style={{ display: 'block', width: '100%', height: '100%' }}>
        {layer === 'waiting' ? WAITING : layer === 'bossarena' ? BOSS_ARENA : <Boss boss={boss} arena={arena} />}
      </svg>
    );
  }
  // `noveil` mounts `Arena` directly — the same scene without `Passage`'s veil nodes, so
  // the beat's cost is a difference and not an assertion.
  const El = layer === 'noveil' ? Arena : Passage;
  return (
    <El
      arena={arena}
      boss={boss}
      players={players}
      localSeat={seat}
      predictor={predictor}
      tickMs={tickMs}
      feedEpoch={0}
    />
  );
}

// ---------------------------------------------------------------------------
// Where a knight may legally stand, read from the generated map rather than typed
// ---------------------------------------------------------------------------

/** Walkable tile origins inside a zone's own y band, in world units. */
function stands(top: number, bot: number): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  for (let ty = 0; ty < MAP_TILES; ty++) {
    const y = ty * MAP_TILE + 8;
    if (y < top || y > bot) continue;
    for (let tx = 0; tx < MAP_TILES; tx++) {
      if (isWallTile(tx, ty)) continue;
      out.push({ x: tx * MAP_TILE + 8, y });
    }
  }
  return out;
}

const PIT_STANDS = stands(PIT_TOP, PIT_BOT);
const LOBBY_STANDS = stands(Math.max(PIT_BOT + 1, LOBBY_TOP), LOBBY_BOT);

const SEED = new Uint8Array(32);
SEED[0] = 0x5a;
SEED[3] = 0xc3;
SEED[7] = 0x11;

const PARTS_MAX = [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500];

function bullet(i: number, tick: number, active: boolean): Bullet {
  const a = (i * 2.399963) % (Math.PI * 2);
  const life = (tick * 42 + i * 17) % 700;
  return {
    x: Math.round(512 + Math.cos(a) * life * 0.5),
    y: Math.round(400 + Math.abs(Math.sin(a)) * life * 0.3),
    dx: Math.round(Math.cos(a) * 42),
    dy: Math.round(Math.abs(Math.sin(a)) * 42),
    active: active ? BULLET_ACTIVE : 0,
  };
}

/** Aim byte: `fire()`'s own encoding, so `decodeAim` reconstructs a real ray. */
function aimByte(cls: number, dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const sector = ((dx < 0 ? 1 : 0) << 2) | ((dy < 0 ? 1 : 0) << 1) | (ay > ax ? 1 : 0);
  const min = Math.min(ax, ay);
  const max = Math.max(ax, ay);
  const t = max === 0 ? 0 : Math.round((min * 15) / max);
  return (cls === CLASS_ARCHER ? CLASS_MASK : 0) | (sector << 4) | t;
}

interface Shape {
  knights: number;
  archerPct: number;
  zone: number;
  localZone: number;
  arrows: boolean;
  damage: boolean;
  remoteArrows: boolean;
  frozen: boolean;
  fullHp: boolean;
  /** Per-seat accepted-move counter. One entry rises per Players write when sparse. */
  seq: Int32Array | null;
}

function slot(seat: number, tick: number, sh: Shape): PlayerSlot {
  const zone = seat === 0 ? sh.localZone : sh.zone;
  const table = zone === ZONE_ARENA ? PIT_STANDS : LOBBY_STANDS;
  // A walk: one whole MAP_TILE per 50 ms is the chain's real cadence, so `Knight.tsx`'s
  // walk accumulator advances exactly as it does in a fight.
  // Sparse mode: only the seat whose counter just rose has a new x/y, which is what one
  // accepted `move` writes into Players. Dense mode keeps the old whole-world advance.
  const walk = sh.seq !== null ? sh.seq[seat]! : sh.frozen ? 0 : tick * 2;
  const idx = (seat * 37 + walk + ((seat * 13) % 7)) % table.length;
  const at = table[idx]!;
  const cls = seat % 100 < sh.archerPct ? CLASS_ARCHER : CLASS_KNIGHT;
  // Every seat fires on its own class cadence, staggered: 8 ticks for a knight, 14 for an
  // archer, which is `(CLASS_COOLDOWN + 1)`. A value diff on this field is what spawns a
  // remote arrow, so this IS the arrow feed.
  const period = cls === CLASS_ARCHER ? 14 : 8;
  const fires = sh.arrows && (sh.remoteArrows || seat === 0);
  const shotTick = fires ? tick - ((tick + seat * 3) % period) : 0;
  const dx = ((seat * 61) % 121) - 60;
  const dy = -20 - ((seat * 29) % 90);
  return {
    seat,
    occupied: seat < sh.knights,
    zone,
    facing: sh.frozen ? seat % 8 : (seat + (tick % 8)) % 8,
    classAim: aimByte(cls, dx, dy),
    skinId: seat % 3,
    x: at.x,
    y: at.y,
    hp: sh.fullHp ? 100 : seat % 10 === 3 ? 0 : seat % 5 === 1 ? 55 : 100,
    hpMax: 100,
    lastMoveSeq: tick & 0xffff,
    deaths: sh.fullHp || seat % 10 !== 3 ? 0 : 1,
    respawnAtTick: sh.fullHp || seat % 10 !== 3 ? 0 : tick + 20,
    lastShotTick: Math.max(0, shotTick),
    lastMoveTick: tick,
    // Advances with `lastShotTick` so the damage number path runs too.
    damageDealt: seat * 137 + (sh.damage ? Math.max(0, shotTick) * 5 : 0),
    sessionPubkey: new Uint8Array(32).fill(seat + 1),
    identity: new Uint8Array(32).fill(seat + 1),
  };
}

function makeArena(tick: number, bullets: number, phase: number): ArenaAccount {
  const b: Bullet[] = [];
  for (let i = 0; i < MAX_BULLETS; i++) b.push(bullet(i, tick, i < bullets));
  return {
    bump: 0,
    phase,
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
    fightAtTick: phase === PHASE_MUSTERING ? tick + 100 : 0,
    nextAffixSeed: new Uint8Array(32),
  };
}

function makeBoss(tick: number): BossAccount {
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

function makePlayers(tick: number, sh: Shape): PlayersAccount {
  const slots: PlayerSlot[] = [];
  for (let s = 0; s < MAX_SEATS; s++) slots.push(slot(s, tick, sh));
  return { bump: 0, slots };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

type Room = 'lobby' | 'arena' | 'passage';

type Opts = {
  knights: number;
  bullets: number;
  frames: number;
  feedHz: number;
  room: Room;
  /** Percent of seats that are archers (arc + 1400 ms cadence). */
  archerPct: number;
  arrows: boolean;
  layer: Layer;
  /** Drop `.stage::after`. Isolates the full-screen vignette repaint. */
  noVignette: boolean;
  /** Freeze `damageDealt` while `lastShotTick` still advances: arrows without numbers. */
  damage: boolean;
  /** Local seat fires through `fireLocal`. */
  localArrows: boolean;
  /** Remote seats' `lastShotTick` advances, which is what spawns their arrows. */
  remoteArrows: boolean;
  /** Extra CSS injected into the page after mount. Kills a filter without editing source. */
  css: string;
  /** Positions and facing held still: isolates movement, pose swaps and interpolation. */
  frozen: boolean;
  /** Every seat at full HP: no HP bar path, no corpse, no respawn arc. */
  fullHp: boolean;
  /** `App.tsx:164`'s `<Hud />` — the eight fixed clusters. */
  hud: boolean;
  /** `App.tsx:172`'s `<DevPanel />`. Closed, it is the `dev-cue` button and two selectors. */
  dev: boolean;
  /** Payloads per `arena.tick` increment. 2 = the old harness; `feedHz/10` = the crank. */
  tickEvery: number;
  /** One seat's x/y advances per Players write, the shape an accepted `move` has on the
   *  wire, instead of all twenty advancing together on a fabricated tick. */
  sparseMoves: boolean;
  /** Seats advanced per Players write. */
  movesPerWrite: number;
  /** Accepted moves per second, paced off the wall clock. 0 = use `movesPerWrite`. */
  movesPerSec: number;
};

const DEFAULTS: Opts = {
  knights: 20,
  bullets: 128,
  frames: 400,
  feedHz: 20,
  room: 'arena',
  archerPct: 50,
  arrows: true,
  layer: 'full',
  noVignette: false,
  damage: true,
  localArrows: true,
  remoteArrows: true,
  css: '',
  frozen: false,
  fullHp: false,
  hud: true,
  dev: true,
  tickEvery: 2,
  sparseMoves: false,
  movesPerWrite: 1,
  movesPerSec: 0,
};

// The shipped DOM: header + stage, and World's absolutely-positioned grid box inside it.
const shell = document.getElementById('root')!;
shell.className = 'shell';
shell.innerHTML =
  '<header class="header"><h1 class="wordmark">HEARTROT</h1></header>' +
  '<main class="main"><div id="stage" class="stage" role="presentation"></div></main>';
const stageEl = document.getElementById('stage')!;
const box = document.createElement('div');
box.setAttribute('style', 'position:absolute;inset:0;display:grid');
stageEl.appendChild(box);

const root = createRoot(box);
const predictor = createPredictor();

/**
 * Build the tree. Called once at boot and once per case — never per notification, which is
 * `App`'s own behaviour: the shell re-renders on `screenOf`, not on a payload.
 */
function mount(): void {
  root.render(
    <StoreProvider>
      <Grab />
      <World layer={opts.layer} />
      {opts.hud ? <Hud /> : null}
      {opts.dev ? <DevPanel /> : null}
    </StoreProvider>,
  );
}

let opts: Opts = DEFAULTS;
let tick = 0;
let running = false;
let updates = 0;
/** Rising every `PASSAGE_EVERY` ticks in `room: 'passage'` — flips the local seat's zone. */
let localZone = ZONE_ARENA;
let passages = 0;
const PASSAGE_EVERY = 18; // ticks -> 1.8 s at the crank's 10 Hz; the long beat is 1.1 s

const seatSeq = new Int32Array(MAX_SEATS);
let seatCursor = 0;
let moveDebt = 0;
let moveAt = 0;

function shape(): Shape {
  const arenaSide = opts.room !== 'lobby';
  return {
    knights: opts.knights,
    archerPct: opts.archerPct,
    zone: arenaSide ? ZONE_ARENA : ZONE_LOBBY,
    localZone: opts.room === 'passage' ? localZone : arenaSide ? ZONE_ARENA : ZONE_LOBBY,
    arrows: opts.arrows,
    damage: opts.damage,
    remoteArrows: opts.remoteArrows,
    frozen: opts.frozen,
    fullHp: opts.fullHp,
    seq: opts.sparseMoves ? seatSeq : null,
  };
}

let cur = {
  a: makeArena(0, 128, PHASE_FIGHTING),
  b: makeBoss(0),
  p: makePlayers(0, {
    knights: DEFAULTS.knights,
    archerPct: DEFAULTS.archerPct,
    zone: ZONE_ARENA,
    localZone: ZONE_ARENA,
    arrows: DEFAULTS.arrows,
    damage: DEFAULTS.damage,
    remoteArrows: DEFAULTS.remoteArrows,
    frozen: DEFAULTS.frozen,
    fullHp: DEFAULTS.fullHp,
    seq: null,
  }),
};

function paint(kind?: 'arena' | 'boss' | 'players'): void {
  const phase = opts.room === 'passage' ? PHASE_MUSTERING : PHASE_FIGHTING;
  if (kind === undefined || kind === 'arena') cur = { ...cur, a: makeArena(tick, opts.bullets, phase) };
  if (kind === undefined || kind === 'boss') cur = { ...cur, b: makeBoss(tick) };
  if (kind === undefined || kind === 'players') cur = { ...cur, p: makePlayers(tick, shape()) };
  const { a, b, p } = cur;

  // The store is the ONLY thing a notification touches, exactly as in the shipped client:
  // `subscribe.ts` -> `store.setWorld` -> `App`'s `World` re-renders off its own selectors
  // and the HUD's clusters off theirs. `App` itself does not re-render (it selects
  // `screenOf`, `phase` and `status` only), so re-rendering the whole root from here would
  // reconcile the HUD twice per payload and price a tree the product never builds.
  store?.setWorld({ arena: a, boss: b, players: p });
  predictor.reconcile(p.slots[0]!);
}

/** The local seat's own trigger, at its class cadence, through the shipped sink. */
let lastLocalShot = 0;
function localFire(now: number): void {
  if (!opts.arrows || !opts.localArrows) return;
  const period = opts.archerPct > 0 ? 800 : 800; // seat 0 is a knight by `seat % 100 < pct`
  if (now - lastLocalShot < period) return;
  lastLocalShot = now;
  const s = cur.p.slots[0]!;
  const a = (now / 900) % (Math.PI * 2);
  fireLocal({
    seat: 0,
    x: s.x,
    y: s.y,
    dx: Math.round(Math.cos(a) * 120),
    dy: Math.round(Math.sin(a) * 120),
  });
}

function startFeed(): void {
  stopFeed();
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
      // `tickEvery` payloads per tick increment. The default 2 is the previous harness's
      // (docs/perf/frame-budget-17.md) and is kept so the two files are comparable — but it
      // advances the chain clock ~357x/s where the crank advances it 10x/s, which inflates
      // every tick-keyed path (the pose fold, the telegraph seek, `metrics.recordWorld`'s
      // tick ring, the aria-label). `tickEvery: 71` at 714 Hz is the live cadence.
      if (updates % opts.tickEvery === 0) tick++;
      dup = !dup;
      updates++;
      if (opts.room === 'passage' && !dup && tick % PASSAGE_EVERY === 0) {
        // LOBBY -> ARENA is the only edge that fires a beat; the return is silent, which
        // is what `passageFires` guarantees, so each cycle is exactly one passage.
        localZone = localZone === ZONE_ARENA ? ZONE_LOBBY : ZONE_ARENA;
        if (localZone === ZONE_ARENA) passages++;
      }
      const r = updates % 20;
      if (opts.sparseMoves && r >= 10 && r < 19 && opts.knights > 0) {
        // Seats advance per Players write. `movesPerSec > 0` paces them off the WALL CLOCK,
        // which is the only way to pin the chain's accepted-move rate: at 6x throttle the
        // client services only ~60-90 payloads/s, so a fixed count per write lands wherever
        // the throttle happens to put it. `movesPerWrite` is the old fixed-count knob.
        let n = opts.movesPerWrite;
        if (opts.movesPerSec > 0) {
          moveDebt += ((now - moveAt) / 1000) * opts.movesPerSec;
          moveAt = now;
          n = Math.floor(moveDebt);
          moveDebt -= n;
        }
        for (let i = 0; i < n; i++) {
          seatSeq[seatCursor % opts.knights]! += 1;
          seatCursor++;
        }
      }
      paint(r < 10 ? 'arena' : r < 19 ? 'players' : 'boss');
      predictor.push((tick + (dup ? 0 : 4)) % 8);
      localFire(now);
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
  document.body.classList.toggle('no-vignette', opts.noVignette);
  // An override sheet, not a source edit: the product file under measurement stays the
  // shipped one and the switch is a cascade win. `.hr-*-grade` and the room floor's inline
  // `filter` both need `!important`, which is exactly why this is a stylesheet and not a
  // DOM walk.
  let sheet = document.getElementById('fb-css');
  if (sheet === null) {
    sheet = document.createElement('style');
    sheet.id = 'fb-css';
    document.head.appendChild(sheet);
  }
  sheet.textContent = opts.css;
  mount();
  tick = 0;
  seatSeq.fill(0);
  seatCursor = 0;
  moveDebt = 0;
  moveAt = performance.now();
  passages = 0;
  localZone = ZONE_ARENA;
  lastLocalShot = 0;
  stopFeed();

  const t0 = performance.now();
  flushSync(() => paint());
  const build = performance.now() - t0;

  const firstPaint = await new Promise<number>((res) => {
    const s = performance.now();
    requestAnimationFrame(() => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => res(performance.now() - s);
      ch.port2.postMessage(0);
    });
  });

  startFeed();
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
  const svg = document.querySelector('#stage svg');
  const r = stageEl.getBoundingClientRect();
  return {
    room: opts.room,
    layer: opts.layer,
    knights: opts.knights,
    bullets: opts.bullets,
    archerPct: opts.archerPct,
    arrows: opts.arrows,
    damage: opts.damage,
    localArrows: opts.localArrows,
    remoteArrows: opts.remoteArrows,
    css: opts.css,
    frozen: opts.frozen,
    fullHp: opts.fullHp,
    noVignette: opts.noVignette,
    feedHz: opts.feedHz,
    hud: opts.hud,
    dev: opts.dev,
    tickEvery: opts.tickEvery,
    sparseMoves: opts.sparseMoves,
    movesPerWrite: opts.movesPerWrite,
    movesPerSec: opts.movesPerSec,
    seatMoves: seatCursor,
    tick,
    // Proof the chrome is actually mounted and seated, not silently absent.
    seat: store?.getState().match?.seat ?? null,
    storeStatus: store?.getState().status ?? null,
    hudNodes: document.querySelectorAll('.hud, .hud *, .dev-cue, .dev-panel, .dev-panel *').length,
    commitP50: q(commit, 0.5),
    commitP95: q(commit, 0.95),
    commitP99: q(commit, 0.99),
    commitMax: +Math.max(...commit).toFixed(2),
    rafP50: q(raf, 0.5),
    rafP95: q(raf, 0.95),
    overCount: over,
    overPct: +((100 * over) / commit.length).toFixed(1),
    frames: commit.length,
    wallMs: +wallMs.toFixed(0),
    busyPct: +((100 * commit.reduce((a, v) => a + v, 0)) / wallMs).toFixed(1),
    fps: +((1000 * commit.length) / wallMs).toFixed(1),
    feedActualHz: +((1000 * updates) / wallMs).toFixed(0),
    passages,
    buildMs: +build.toFixed(1),
    firstPaintMs: +firstPaint.toFixed(1),
    stageW: Math.round(r.width),
    stageH: Math.round(r.height),
    // Rasterised area in CSS px — the +55 % this spec's own risk list calls unmeasured.
    stageMpx: +((r.width * r.height) / 1e6).toFixed(2),
    viewBox: svg?.getAttribute('viewBox') ?? null,
    nodes: document.getElementsByTagName('*').length,
    svgNodes: document.querySelectorAll('svg *').length,
    jsHeapMB: mem ? +(mem.usedJSHeapSize / 1048576).toFixed(1) : null,
  };
};

mount();
// Sign in and take seat 0 so `match` is populated and the HUD's `mySeatSlot`, seat-scoped
// clusters and DevPanel identity rows all render. Both calls hit the stubbed fetch above.
void (async () => {
  await new Promise<void>((res) => {
    if (store) res();
    else storeReady = res;
  });
  await store!.signIn();
  await store!.join();
  paint();
  window.__ready = true;
})();
