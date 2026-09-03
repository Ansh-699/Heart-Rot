/**
 * Throwaway (task: looks-right). Screenshots the SHIPPED renderer, both rooms, so the
 * art-direction numbers come off the real pixels rather than off the source.
 *
 * Same mounting trick as scripts/spike/scenemount: the real `app/src/App.tsx` with a
 * stubbed AuthSource and a stubbed `/api/session/init`, so `StoreProvider`, `screenOf`,
 * the `World` portal, `Arena.tsx`, `WaitingRoom`, `BossArena`, `Boss`, `Knight` and every
 * grade in `styles.css` are product code. Only the chain is fake.
 */
import { StrictMode, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import App from '../../../app/src/App';
import { StoreProvider, setAuthSource, useStore } from '../../../app/src/state/store';
import { fireLocal } from '../../../app/src/render/Shot';
import { chargeLocal } from '../../../app/src/render/Knight';
import {
  ARENA, BOSS, BOSS_SPAWN, BULLET, PLAYERS, PLAYER_SLOT, DISC_ARENA, DISC_BOSS, DISC_PLAYERS,
  BEAM_LANE_TICKS, BEAM_PERIOD_TICKS, BEAM_WARN_TICKS,
  LAYOUT_VERSION, MAX_SEATS, N_PARTS, CLASS_MASK,
  PHASE_LOBBY, PHASE_FIGHTING, PHASE_MUSTERING, ZONE_ARENA, ZONE_LOBBY,
  decodeArena, decodeBoss, decodePlayers,
} from '@heartrot/client';

const blank = (size: number, disc: number) => {
  const d = new Uint8Array(size);
  d[0] = disc; d[1] = LAYOUT_VERSION; d[2] = 255;
  return { d, v: new DataView(d.buffer) };
};

function arenaBytes(phase: number, tick: number, bullets: number, outcome = 0, incarnation = 0) {
  const { d, v } = blank(ARENA.size, DISC_ARENA);
  const o = ARENA.offsets;
  v.setUint8(o.phase, phase);
  // results-win: a settled WIN at incarnation N, so the verdict names N + 1.
  v.setUint8(o.outcome, outcome);
  v.setUint16(o.incarnation, incarnation, true);
  v.setUint8(o.raid_size, 1);
  v.setUint32(o.tick, tick, true);
  v.setUint32(o.fight_at_tick, tick + 140, true);
  if (phase === PHASE_FIGHTING) v.setUint32(o.enrage_at_tick, tick + 3480, true);
  v.setBigUint64(o.arena_id, 1n, true);
  for (let i = 0; i < bullets; i++) {
    const b = o.bullets + i * BULLET.size;
    const a = (i / Math.max(1, bullets)) * Math.PI * 2;
    v.setInt16(b + BULLET.offsets.x, Math.round(512 + Math.cos(a) * (90 + i * 7)), true);
    v.setInt16(b + BULLET.offsets.y, Math.round(470 + Math.sin(a) * (40 + i * 3)), true);
    v.setInt8(b + BULLET.offsets.dx, Math.round(Math.cos(a) * 42));
    v.setInt8(b + BULLET.offsets.dy, Math.round(Math.sin(a) * 42));
    v.setUint8(b + BULLET.offsets.active, 1);
  }
  return decodeArena(d);
}

/**
 * `vent`: the shell sits just under the solo threshold (98 %) so the vent is open and the
 * quiet ring shows. `fury`: the same plus a core at 300 of 2,000 — with 90 shell to strip
 * the effective pool is 2,090 and 300 is under 20 % of it, so `isFurious` reads true.
 * `beam`: the same open shell with the core at 1,000 — under half of 2,090 and over a
 * fifth, so `isPhase2` reads true and `isFurious` false: the beam without the fury wash.
 */
function bossBytes(hurt: boolean, vent = false, fury = false, beam = false) {
  const { d, v } = blank(BOSS.size, DISC_BOSS);
  const o = BOSS.offsets;
  v.setInt16(o.x, BOSS_SPAWN[0], true);
  v.setInt16(o.y, BOSS_SPAWN[1], true);
  const open = vent || fury || beam;
  for (let i = 0; i < N_PARTS; i++) {
    v.setUint16(o.parts_max + i * 2, 500, true);
    const hp = (hurt && i === 7) || (fury && (i === 7 || i === 8 || i === 3)) ? 0 : open && i === 0 ? 400 : 500;
    v.setUint16(o.parts + i * 2, hp, true);
  }
  v.setUint8(o.vent_open, open ? 1 : 0);
  v.setUint16(o.core_hp, fury ? 300 : beam ? 1000 : 2000, true);
  v.setUint16(o.core_hp_max, 2000, true);
  return decodeBoss(d);
}

/** 20 seats spread over the room named by `zone`, mixed skins and classes. `damage` is
 *  per seat, for the results panel's placing; the default is a spread nobody ties on. */
function playersBytes(zone: number, tick: number, seats: number, at?: number[][], damage?: number[]) {
  const { d, v } = blank(PLAYERS.size, DISC_PLAYERS);
  if (at) {
    // art-judge: explicit world placements [x, y, skin, isArcher]. Everything else matches
    // the grid path below so the two sets of numbers are comparable.
    at.forEach((p, seat) => {
      const s = PLAYERS.offsets.slots + seat * PLAYER_SLOT.size;
      d[s + PLAYER_SLOT.offsets.session_pubkey] = seat + 1;
      v.setUint8(s + PLAYER_SLOT.offsets.zone, zone);
      v.setUint8(s + PLAYER_SLOT.offsets.skin_id, p[2]);
      v.setUint8(s + PLAYER_SLOT.offsets.facing, 0);
      v.setUint8(s + PLAYER_SLOT.offsets.class_aim, (p[3] ? CLASS_MASK : 0) | 0x18);
      v.setInt16(s + PLAYER_SLOT.offsets.x, p[0], true);
      v.setInt16(s + PLAYER_SLOT.offsets.y, p[1], true);
      v.setUint16(s + PLAYER_SLOT.offsets.hp, 100, true);
      v.setUint16(s + PLAYER_SLOT.offsets.hp_max, 100, true);
      v.setUint32(s + PLAYER_SLOT.offsets.last_shot_tick, 0, true);
      v.setUint32(s + PLAYER_SLOT.offsets.damage_dealt, damage?.[seat] ?? seat * 137, true);
    });
    return decodePlayers(d);
  }
  for (let seat = 0; seat < seats; seat++) {
    const s = PLAYERS.offsets.slots + seat * PLAYER_SLOT.size;
    d[s + PLAYER_SLOT.offsets.session_pubkey] = seat + 1;
    v.setUint8(s + PLAYER_SLOT.offsets.zone, zone);
    v.setUint8(s + PLAYER_SLOT.offsets.skin_id, seat % 3);
    v.setUint8(s + PLAYER_SLOT.offsets.facing, seat % 8);
    v.setUint8(s + PLAYER_SLOT.offsets.class_aim, (seat % 2 ? CLASS_MASK : 0) | 0x18);
    const col = seat % 5, row = (seat / 5) | 0;
    const x = zone === ZONE_ARENA ? 180 + col * 168 + row * 22 : 150 + col * 180 + row * 26;
    const y = zone === ZONE_ARENA ? 430 + row * 44 : 700 + row * 72;
    v.setInt16(s + PLAYER_SLOT.offsets.x, x, true);
    v.setInt16(s + PLAYER_SLOT.offsets.y, y, true);
    v.setUint16(s + PLAYER_SLOT.offsets.hp, seat === 7 ? 34 : 100, true);
    v.setUint16(s + PLAYER_SLOT.offsets.hp_max, 100, true);
    v.setUint32(s + PLAYER_SLOT.offsets.last_shot_tick, tick > 4 ? tick - 1 : 0, true);
    v.setUint32(s + PLAYER_SLOT.offsets.damage_dealt, damage?.[seat] ?? seat * 137, true);
  }
  return decodePlayers(d);
}

setAuthSource(async () => 'stub.jwt.token');
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.includes('/api/session/init')) {
    return new Response(JSON.stringify({
      seat: 0, arenaId: '1', programId: '11111111111111111111111111111111',
      arenaPda: '11111111111111111111111111111111', bossPda: '11111111111111111111111111111111',
      playersPda: '11111111111111111111111111111111',
      validatorIdentity: '11111111111111111111111111111111',
      erEndpoint: 'http://127.0.0.1:1/er', routerEndpoint: 'http://127.0.0.1:1/router',
      tickMs: 100,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

interface SceneOpts {
  hurt?: boolean; vent?: boolean; fury?: boolean; bullets?: number; seats?: number; phase?: number; at?: number[][];
  outcome?: number; incarnation?: number; damage?: number[];
  /** The 50 % phase: drop the boss under half and freeze on a tick in the named stage. */
  beam?: 'warn' | 'sweep';
  /** An explicit tick, over the defaults below — e.g. one tick on from `beam: 'sweep'`. */
  tick?: number;
}

/**
 * The beam is stateless in the tick, so a stage is a tick. Period 12 (tick 960) is one
 * where no slam telegraph overlaps the warning or the sweep, so the shot is the beam
 * alone: 0.7 s into the warning, and one tick into the sweep's second lane.
 */
const BEAM_TICK = {
  warn: 12 * BEAM_PERIOD_TICKS + 7,
  sweep: 12 * BEAM_PERIOD_TICKS + BEAM_WARN_TICKS + BEAM_LANE_TICKS + 1,
};

function Bridge() {
  const store = useStore();
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__store = store;
    w.__scene = (which: 'lobby' | 'arena', opts: SceneOpts = {}) => {
      const arena = which === 'arena';
      const tick = opts.tick ?? (arena ? (opts.beam ? BEAM_TICK[opts.beam] : 900) : 0);
      store.setWorld({
        arena: arenaBytes(opts.phase ?? (arena ? PHASE_FIGHTING : PHASE_LOBBY), tick,
          arena ? (opts.bullets ?? 10) : 0, opts.outcome ?? 0, opts.incarnation ?? 0),
        boss: bossBytes(!!opts.hurt, !!opts.vent, !!opts.fury, !!opts.beam),
        players: playersBytes(arena ? ZONE_ARENA : ZONE_LOBBY, tick, opts.seats ?? MAX_SEATS, opts.at, opts.damage),
      });
    };
    w.__PHASE = { PHASE_LOBBY, PHASE_FIGHTING, PHASE_MUSTERING };
    // The local seat's own feedback, driven directly: a practice loose at any tier and the
    // hold's edge, so the beam and the draw can be photographed without a chain.
    w.__fire = fireLocal;
    w.__charge = chargeLocal;
    w.__ready = true;
  }, [store]);
  return null;
}

createRoot(document.getElementById('root')!).render(
  createElement(StrictMode, null,
    createElement(StoreProvider, {
      children: [createElement(Bridge, { key: 'b' }), createElement(App, { key: 'a' })],
    })),
);
