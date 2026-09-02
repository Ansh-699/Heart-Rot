/**
 * THROWAWAY passage-proof harness. Mounts the REAL shipped `<Passage>` (which is the real
 * `<Arena>` wrapped in the gate beat) against a synthetic feed, and hands the driver
 * imperative control of the exact three values the beat reads — `zone`, `phase`,
 * `feedEpoch` — plus a per-frame sampler.
 *
 * No product file is touched; this file only imports them.
 *
 * Fixture shapes copied from scripts/spike/framebudget/main3.tsx (same throwaway lineage).
 */
import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';

import {
  BOSS_SPAWN,
  BULLET_ACTIVE,
  CLASS_KNIGHT,
  LOBBY_BOT,
  LOBBY_TOP,
  MAP_ENTRANCES,
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
import { roomSeats, seatShown } from '../../../app/src/render/Arena';
import { createPredictor } from '../../../app/src/net/predict';
import '../../../app/src/styles.css';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
const ENTRANCE = MAP_ENTRANCES[0]!;
const PARTS_MAX = [1000, 1000, 1000, 1000, 4000, 2500, 2500, 2500, 2500];

function bullet(i: number, tick: number, active: boolean): Bullet {
  const a = (i * 2.399963) % (Math.PI * 2);
  const life = (tick * 42 + i * 17) % 700;
  return {
    x: Math.round(BOSS_SPAWN[0] + Math.cos(a) * life * 0.5),
    y: Math.round(BOSS_SPAWN[1] + Math.abs(Math.sin(a)) * life * 0.3),
    dx: Math.round(Math.cos(a) * 42),
    dy: Math.round(Math.abs(Math.sin(a)) * 42),
    active: active ? BULLET_ACTIVE : 0,
  };
}

interface Shape {
  knights: number;
  occ: boolean;
  tick: number;
  /** Every remote seat's zone. */
  zone: number;
  /** Seat 0's zone — the value the beat triggers on. */
  localZone: number;
  /** Seat 0's position, so the teleport across the gate is the real one. */
  localAt: { x: number; y: number };
}

function slot(seat: number, sh: Shape): PlayerSlot {
  const zone = seat === 0 ? sh.localZone : sh.zone;
  const table = zone === ZONE_ARENA ? PIT_STANDS : LOBBY_STANDS;
  const idx = (seat * 37 + sh.tick * 2 + ((seat * 13) % 7)) % table.length;
  const at = seat === 0 ? sh.localAt : table[idx]!;
  return {
    seat,
    occupied: seat === 0 ? sh.occ : seat < sh.knights,
    zone,
    facing: (seat + (sh.tick % 8)) % 8,
    classAim: CLASS_KNIGHT === 0 ? 0 : 0,
    skinId: seat % 3,
    x: at.x,
    y: at.y,
    hp: 100,
    hpMax: 100,
    lastMoveSeq: sh.tick & 0xffff,
    deaths: 0,
    respawnAtTick: 0,
    lastShotTick: 0,
    lastMoveTick: sh.tick,
    damageDealt: seat * 137,
    sessionPubkey: new Uint8Array(32).fill(seat + 1),
    identity: new Uint8Array(32).fill(seat + 1),
  };
}

function makeArena(tick: number, phase: number): ArenaAccount {
  const b: Bullet[] = [];
  for (let i = 0; i < MAX_BULLETS; i++) b.push(bullet(i, tick, i < 24));
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
    affixSeed: new Uint8Array(32),
    bullets: b,
    rollRequestedTick: 0,
    fightAtTick: phase === PHASE_MUSTERING ? tick + 100 : 0,
    nextAffixSeed: new Uint8Array(32),
  };
}

function makeBoss(tick: number): BossAccount {
  const wear = Math.min(1, tick / 900);
  const parts = PARTS_MAX.map((m, i) => Math.round(m * Math.max(0, 1 - wear * (1 + (i % 3) * 0.45))));
  return {
    bump: 0,
    ventOpen: 0,
    attackTimer: 32 - (tick % 33),
    targetSeat: NO_TARGET,
    x: BOSS_SPAWN[0],
    y: BOSS_SPAWN[1],
    coreHp: 2000,
    coreHpMax: 2000,
    parts,
    partsMax: PARTS_MAX,
  };
}

function makePlayers(sh: Shape): PlayersAccount {
  const slots: PlayerSlot[] = [];
  for (let s = 0; s < MAX_SEATS; s++) slots.push(slot(s, sh));
  return { bump: 0, slots };
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

interface Ctl {
  tick: number;
  zone: number;
  phase: number;
  epoch: number;
  /** `passage` mounts the real beat; `arena` mounts `Arena` alone with an explicit room. */
  mode: 'passage' | 'arena' | 'none';
  /** `arena` mode only — the pre-fix composition and the isolated hold ceiling. */
  room: 'lobby' | 'arena';
  hold: boolean;
  /** Seat 0 occupied. `false` is the sampler's own falsification case. */
  occ: boolean;
}

const INIT: Ctl = { tick: 0, zone: ZONE_LOBBY, phase: PHASE_MUSTERING, epoch: 0, mode: 'passage', room: 'lobby', hold: false, occ: true };

const predictor = createPredictor();
let apply: ((p: Partial<Ctl>) => void) | null = null;

/** Where seat 0 stands. Lobby: on the gate tile band. Arena: `entrance_for(seat)`. */
const LOBBY_AT = LOBBY_STANDS[Math.floor(LOBBY_STANDS.length / 2)]!;
const ARENA_AT = { x: ENTRANCE[0], y: ENTRANCE[1] };

function Root() {
  const [c, setC] = useState<Ctl>(INIT);
  apply = (p) => setC((s) => ({ ...s, ...p }));

  const arena = useMemo(() => makeArena(c.tick, c.phase), [c.tick, c.phase]);
  const boss = useMemo(() => makeBoss(c.tick), [c.tick]);
  const players = useMemo(
    () =>
      makePlayers({
        knights: 8,
        occ: c.occ,
        tick: c.tick,
        zone: ZONE_LOBBY,
        localZone: c.zone,
        localAt: c.zone === ZONE_ARENA ? ARENA_AT : LOBBY_AT,
      }),
    [c.tick, c.zone, c.occ],
  );

  useEffect(() => {
    predictor.reconcile(players.slots[0]!);
  }, [players]);

  if (c.mode === 'none') return null;
  const common = {
    arena,
    boss,
    players,
    localSeat: 0,
    predictor,
    tickMs: TICK_MS,
  };
  return c.mode === 'passage' ? (
    <Passage {...common} feedEpoch={c.epoch} />
  ) : (
    <Arena {...common} feedEpoch={c.epoch} room={c.room} hold={c.hold} />
  );
}

const shell = document.getElementById('root')!;
shell.className = 'shell';
shell.innerHTML = '<header class="header"></header><main class="main"><div id="stage" class="stage" role="presentation"></div></main>';
const box = document.createElement('div');
box.setAttribute('style', 'position:absolute;inset:0;display:grid');
document.getElementById('stage')!.appendChild(box);
const root = createRoot(box);

// ---------------------------------------------------------------------------
// The sampler
// ---------------------------------------------------------------------------

/** The local knight's own chevron — `Knight.tsx`'s `mine &&` marker, and nothing else has it. */
const CHEVRON = 'path[d="M-8,-36 L8,-36 L0,-24 Z"]';

interface Sample {
  t: number;
  /** Is the LOCAL seat's node in the document at all? */
  self: boolean;
  /** Its inline transform — the frame loop's, frozen under the hold. */
  tf: string | null;
  /** Which room the viewBox is framing. */
  room: string | null;
  /** The passage veils' live computed opacity. */
  flat: number;
  mouthA: number;
  /** Every knight node on screen. */
  seats: number;
}

/**
 * The passage veil root, anchored on the one id only `Passage` defines. `shape-rendering`
 * alone is ambiguous — `Arena`, `BossArena` and `Spawn` all carry it, and which one
 * `querySelector` reaches CHANGES at the cut.
 */
function veilGroup(): Element | null {
  return document.querySelector('#heartrot-passage-mouth-a')?.closest('g') ?? null;
}

function op(el: Element | null | undefined): number {
  if (el == null) return 0;
  return +getComputedStyle(el).opacity || 0;
}

function sample(t0: number): Sample {
  const chev = document.querySelector(CHEVRON);
  const g = chev?.closest('g[style]') ?? null;
  const svg = document.querySelector('#stage svg');
  const vb = svg?.getAttribute('viewBox') ?? null;
  const y = vb === null ? NaN : +vb.split(' ')[1]!;
  const veils = veilGroup()?.querySelectorAll(':scope > rect') ?? [];
  return {
    t: +(performance.now() - t0).toFixed(1),
    self: chev !== null,
    tf: g === null ? null : (g as SVGGElement).style.transform || null,
    // The two rooms' fitted boxes differ by exactly CAMERA_LIFT = 480 in y. Lobby is the
    // lower band, so the larger y.
    room: Number.isNaN(y) ? null : y > 200 ? 'lobby' : 'arena',
    flat: +op(veils[1]).toFixed(3),
    mouthA: +op(veils[0]).toFixed(3),
    seats: document.querySelectorAll('#stage g[style*="will-change"]').length,
  };
}

// ---------------------------------------------------------------------------
// The driver API
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __ready: boolean;
    __hr: {
      set(p: Partial<Ctl>): void;
      /** Apply synchronously and sample the resulting COMMIT — the one-frame defect. */
      setSync(p: Partial<Ctl>): Sample;
      sample(): Sample;
      /** Sample every frame for `ms`, optionally applying `at` mid-flight. */
      run(ms: number, script?: Array<{ at: number; p: Partial<Ctl> }>): Promise<Sample[]>;
      anims(): number;
      /** The pure R3 filter, so the PRE-FIX behaviour can be shown against the same slots. */
      prefix(): { withHold: boolean; withoutHold: boolean; drawnWithout: number; drawnWith: number };
      holdNow(): number;
      /** Pause/resume every live animation — the state a HIDDEN document puts WAAPI in. */
      pauseAnims(): number;
      resumeAnims(): number;
      remount(): void;
      push(dir: number): void;
    };
  }
}

window.__hr = {
  set: (p) => apply?.(p),
  setSync: (p) => {
    const t0 = performance.now();
    flushSync(() => apply?.(p));
    return sample(t0);
  },
  sample: () => sample(performance.now()),
  run: (ms, script = []) =>
    new Promise((res) => {
      const t0 = performance.now();
      const out: Sample[] = [];
      const todo = [...script].sort((a, b) => a.at - b.at);
      const frame = (): void => {
        const t = performance.now() - t0;
        while (todo.length > 0 && todo[0]!.at <= t) flushSync(() => apply?.(todo.shift()!.p));
        out.push(sample(t0));
        if (t >= ms) return res(out);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }),
  anims: () => document.getAnimations().length,
  prefix: () => {
    const slots = makePlayers({ knights: 8, occ: true, tick: 0, zone: ZONE_LOBBY, localZone: ZONE_ARENA, localAt: ARENA_AT }).slots;
    return {
      // What `Arena` does today for the seat crossing the gate, and what it did before.
      withHold: seatShown(slots[0]!, 'lobby', 0),
      withoutHold: seatShown(slots[0]!, 'lobby'),
      drawnWith: roomSeats(slots, 'lobby', 0).filter((s) => s.seat === 0).length,
      drawnWithout: roomSeats(slots, 'lobby').filter((s) => s.seat === 0).length,
    };
  },
  pauseAnims: () => { const a = document.getAnimations(); for (const x of a) x.pause(); return a.length; },
  resumeAnims: () => { const a = document.getAnimations(); for (const x of a) x.play(); return a.length; },
  holdNow: () => { const t = performance.now(); apply?.({ mode: 'arena', room: 'arena', zone: ZONE_ARENA, hold: true }); return t; },
  remount: () => root.render(<Root />),
  push: (d) => predictor.push(d),
};

// Visibility + frame instrumentation, so the hidden-document cases can PROVE the document
// went hidden and that rAF stopped while it was.
const vis: Array<{ s: string; t: number }> = [{ s: document.visibilityState, t: 0 }];
document.addEventListener('visibilitychange', () => vis.push({ s: document.visibilityState, t: +performance.now().toFixed(1) }));
let frames = 0;
const beat = (): void => { frames++; requestAnimationFrame(beat); };
requestAnimationFrame(beat);
(window as unknown as { __vis: typeof vis; __frames: () => number }).__vis = vis;
(window as unknown as { __frames: () => number }).__frames = () => frames;

root.render(<Root />);
requestAnimationFrame(() => requestAnimationFrame(() => (window.__ready = true)));
